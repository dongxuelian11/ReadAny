// Real pinned-TKG integration test (PR-002 blocking gate).
//
// Exercises the actual chain end to end, with no mocks standing in for our
// own code:
//   pinned TKG source acquisition -> real aiConfig-driven LLM client
//   (createChatModel via a local deterministic OpenAI-compatible endpoint) ->
//   the real Book Skill pipeline writing the real derived file layout ->
//   the upstream TKG lint_chapters.py --strict quality gate on the result.
//
// The ONLY substituted piece is the external LLM endpoint, exactly like the
// PR-001 Read-Box integration harness. The output labels this honestly.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TKG_REF, ensureTkgSource, tkgCheckoutDir } from "../../../../../scripts/tkg-source.mjs";
import type { AIConfig } from "../../types/chat";
import { createBookSkillLlmClient } from "../llm";
import { generateBookSkill } from "../pipeline";
import type { BookSkillFs } from "../types";

let server: ReturnType<typeof createServer> | null = null;
let serverPort = 0;
let skillDir = "";

const RAW_PARAGRAPHS = [
  "Observation begins with counts. A polling station records how many people arrived in each hour of the day, and the resulting table already invites comparison.",
  "Averages hide as much as they reveal. Two streets can share the same mean household income while differing enormously in how that income is distributed.",
  "Variation is the second question of statistics. Once a typical value has been named, the very next question asks how far individual observations stray from it.",
  "Sampling replaces the exhaustive census of a population with a deliberately smaller selection, and the price of that economy is sampling error.",
];

function rawChapterText(seed: string): string {
  return `${seed}\n\n${RAW_PARAGRAPHS.join("\n\n")}\n\nThe exercises at the end of each section ask the reader to compute, to compare, and then to explain the difference in plain language.\n`;
}

const SPINE_REPLY = JSON.stringify({
  thesis:
    "The book argues that statistical thinking is a learnable toolkit: name a typical value, then quantify how far observations stray from it, and always treat sample conclusions with sampling error in mind.",
  domain: "introductory statistics for everyday reasoning",
  vocabulary: ["mean", "variation", "sampling error", "distribution", "outlier"],
  frameworks: [
    {
      name: "Typical Value First",
      summary: "start every description with a summarising average",
      approxChapter: "ch01",
    },
    {
      name: "Sampling Error",
      summary: "the gap between a sample statistic and the population value",
      approxChapter: "ch02",
    },
  ],
});

function toolkitReply(bookNumber: string, title: string): string {
  const frameworks = [
    "- **Typical Value First**: name the mean before the story",
    "  - When to use: whenever a table or a claim presents raw counts",
    "  - How: compute the mean, then ask what it hides",
    "- **Range Before Verdict**: report spread beside every average",
    "  - When to use: before comparing two groups on a single number",
    "  - How: compute the range, then the deviation of the extreme observations",
  ].join("\n");
  const concepts = [
    "- **Mean**: the balance point where total deviation above equals total deviation below",
    "- **Sampling error**: the difference between a sample estimate and the true population value",
    "- **Distribution**: the shape describing how often each value occurs",
    "- **Outlier**: an observation so far from the typical value that it deserves its own explanation",
  ].join("\n");
  const takeaways = [
    "1. An average without a measure of spread is an unfinished sentence.",
    "2. A larger sample shrinks sampling error, but never removes it.",
    "3. Two identical means can describe very different situations.",
    "4. Always ask what question the collected numbers were meant to answer.",
    "5. Report the count of observations beside any summary statistic.",
    "6. An outlier is information until proven otherwise.",
  ].join("\n");
  return [
    `# Chapter ${bookNumber}: ${title}`,
    "",
    "## Core Idea",
    "Statistics begins with a summarising number and immediately asks how much individual observations disagree with it.",
    "",
    "## Frameworks Introduced",
    frameworks,
    "",
    "## Key Concepts",
    concepts,
    "",
    "## Mental Models",
    "Think of a dataset as a crowd: the mean names the meeting point, while the spread describes how widely the crowd wanders away from it.",
    "",
    "## Connects To",
    "- **ch02**: the sampling argument builds directly on the spread described here",
    "",
    "## Key Takeaways",
    takeaways,
    "",
  ].join("\n");
}

const REDUCE_REPLY = JSON.stringify({
  thesis:
    "Statistical reasoning proceeds from a typical value to variation and then to the honesty required by sampling.",
  nodes: [
    { name: "Typical Value First", summary: "start with a summarising average", chapter: "ch01" },
    {
      name: "Range Before Verdict",
      summary: "report spread beside every average",
      chapter: "ch01",
    },
    { name: "Sampling Error", summary: "the gap between sample and population", chapter: "ch02" },
  ],
  edges: [
    { from: "Range Before Verdict", relation: "builds on", to: "Typical Value First" },
    { from: "Sampling Error", relation: "requires", to: "Range Before Verdict" },
  ],
  coreFrameworks: [
    {
      name: "Typical Value First",
      whenToUse: "Use when a claim presents raw counts without a summary.",
      how: "Compute the mean and state what it represents.",
    },
    {
      name: "Sampling Error",
      whenToUse: "Use when a sample stands in for a population.",
      how: "Quantify the spread across repeated samples.",
    },
  ],
  topicIndex: [
    { term: "mean / average", chapters: ["ch01"] },
    { term: "sampling error", chapters: ["ch02", "intro"] },
    { term: "variation", chapters: ["ch01", "ch02"] },
  ],
  triggerPhrases: [
    "summarise a dataset",
    "compare two groups",
    "interpret a poll",
    "explain sampling error",
  ],
  scopeNote: "Covers the content of this book only.",
});

function deterministicReply(system: string, user: string): string {
  if (system.includes("build the spine")) {
    return SPINE_REPLY;
  }
  if (system.includes("extract one chapter")) {
    const match = /Chapter to extract: (\S+) — (.+)/.exec(user);
    const bookNumber = match?.[1] ?? "ch01";
    const title = match?.[2] ?? "Untitled";
    return toolkitReply(bookNumber, title.split("\n")[0]);
  }
  if (system.includes("REDUCE")) {
    return REDUCE_REPLY;
  }
  throw new Error(`Unexpected system prompt received: ${system.slice(0, 80)}`);
}

beforeAll(async () => {
  const source = ensureTkgSource();
  expect(source.exactRef).toBe(TKG_REF);
  expect(source.license).toBe("VERIFIED_MIT");

  server = createServer((request, response) => {
    void (async () => {
      expect(request.url?.endsWith("/chat/completions")).toBe(true);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const system = String(body.messages?.[0]?.content ?? "");
      const user = String(body.messages?.[1]?.content ?? "");
      const reply = deterministicReply(system, user);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "deterministic",
          object: "chat.completion",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: reply } },
          ],
        }),
      );
    })().catch((error) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  if (!server) {
    throw new Error("The deterministic provider server was not started");
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (skillDir) {
    await rm(skillDir, { recursive: true, force: true });
  }
});

function nodeFsAdapter(): BookSkillFs {
  return {
    join: (...parts: string[]) => join(...parts),
    async mkdir(path: string) {
      await mkdir(path, { recursive: true });
    },
    async exists(path: string) {
      try {
        await readFile(path);
        return true;
      } catch {
        return false;
      }
    },
    async readFile(path: string) {
      return readFile(path, "utf8");
    },
    async writeFile(path: string, content: string) {
      await writeFile(path, content, "utf8");
    },
    async remove(path: string) {
      await rm(path, { recursive: true, force: true });
    },
  };
}

function fixtureConfig(): AIConfig {
  return {
    endpoints: [
      {
        id: "tkg-integration",
        name: "Deterministic TKG integration endpoint",
        provider: "openai",
        apiKey: "integration-test-only",
        baseUrl: `http://127.0.0.1:${serverPort}/v1`,
        models: ["deterministic-tkg-test"],
        modelsFetched: true,
      },
    ],
    activeEndpointId: "tkg-integration",
    activeModel: "deterministic-tkg-test",
    temperature: 0.2,
    maxTokens: 4096,
    slidingWindowSize: 8,
  };
}

it("generates the two-tier Book Skill and passes the upstream lint gate", async () => {
  skillDir = join(tmpdir(), `tkg-book-skill-integration-${process.pid}-${Date.now()}`);
  const client = await createBookSkillLlmClient(fixtureConfig());
  const progress: string[] = [];
  const result = await generateBookSkill({
    request: {
      book: { id: "integration-book", title: "Statistics for Everybody", author: "T. Integration" },
      chapters: [
        {
          index: 0,
          title: "Introduction",
          content: rawChapterText("This book teaches everyday statistics."),
        },
        {
          index: 1,
          title: "Chapter 1 — Averages",
          content: rawChapterText("Every description starts somewhere."),
        },
        {
          index: 2,
          title: "Chapter 2 — Variation",
          content: rawChapterText("Averages never tell the whole story."),
        },
      ],
      genre: "textbook",
    },
    client,
    fs: nodeFsAdapter(),
    skillDir,
    concurrency: 3,
    onProgress: (p) => progress.push(p.phase),
  });

  // Derived file layout matches the upstream contract.
  const skillMd = await readFile(join(skillDir, "SKILL.md"), "utf8");
  expect(skillMd).toContain("## Book Thesis");
  expect(skillMd).toContain("## Concept Map");
  expect(skillMd).toContain("## Topic Index");
  for (const bookNumber of ["intro", "ch01", "ch02"]) {
    const chapter = result.manifest.chapters.find((c) => c.book_number === bookNumber);
    expect(chapter?.status).toBe("extracted");
    if (!chapter) {
      throw new Error(`Manifest is missing chapter ${bookNumber}`);
    }
    const toolkit = await readFile(join(skillDir, chapter.file), "utf8");
    expect(toolkit).toContain("## Core Idea");
    expect(toolkit).toContain("## Frameworks Introduced");
    expect(toolkit).toContain("## Key Takeaways");
    expect(
      await readFile(join(skillDir, "raw", "raw_chapters", `${bookNumber}.txt`), "utf8"),
    ).toContain("Observation begins with counts");
  }
  expect(result.manifest.schema_version).toBe(2);
  expect(result.manifest.readany.chapters.map((c) => c.chapterIndex)).toEqual([0, 1, 2]);
  expect(progress[0]).toBe("checking");
  expect(progress.at(-1)).toBe("completed");

  // The REAL upstream quality gate must accept the generated skill.
  const pythonBin = process.env.TKG_PYTHON || "python";
  const lint = spawnSync(pythonBin, [tkgLintPath(), "--strict", skillDir], {
    encoding: "utf8",
    timeout: 120000,
  });
  if (lint.error) {
    throw new Error(
      `Could not run the upstream lint gate with ${pythonBin}: ${lint.error.message}. Set TKG_PYTHON to a Python 3 interpreter.`,
    );
  }
  process.stdout.write(lint.stdout ?? "");
  if (lint.status !== 0) {
    throw new Error(
      `Upstream lint_chapters.py --strict FAILED with exit ${lint.status}:\n${lint.stdout}\n${lint.stderr}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        pinnedRef: TKG_REF,
        pipeline: "PASS",
        upstreamLintGate: "PASS",
        chapters: result.manifest.chapters.map((c) => c.book_number),
        provider: "LOCAL_DETERMINISTIC_OPENAI_COMPATIBLE",
      },
      null,
      2,
    )}\n`,
  );
}, 180000);

function tkgLintPath(): string {
  return join(tkgCheckoutDir, ".claude", "skills", "book-to-skill", "scripts", "lint_chapters.py");
}
