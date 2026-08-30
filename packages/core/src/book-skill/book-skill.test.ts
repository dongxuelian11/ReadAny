import { describe, expect, it } from "vitest";
import {
  assertChapterToolkit,
  assignBookNumbers,
  bookSkillPanelReducer,
  chapterSlug,
  countWords,
  estimateBookSkillCost,
  estimateTokens,
  generateBookSkill,
  initialBookSkillPanelState,
  lintChapterToolkit,
  loadBookSkill,
  looksLikeFailureText,
  parseJsonResponse,
  parseSpineResponse,
  parseTier1Response,
} from "./index";
import type { BookSkillFs, BookSkillLlmClient, BookSkillRequest, BookSkillTier1 } from "./types";

function createMemoryFs() {
  const files = new Map<string, string>();
  const normalize = (p: string) => p.replace(/\\/g, "/");
  const fs: BookSkillFs = {
    join: (...parts: string[]) => parts.join("/"),
    async mkdir() {
      // directories are implicit in the memory fs
    },
    async exists(path: string) {
      return files.has(normalize(path));
    },
    async readFile(path: string) {
      const file = files.get(normalize(path));
      if (file === undefined) throw new Error(`ENOENT: ${path}`);
      return file;
    },
    async writeFile(path: string, content: string) {
      files.set(normalize(path), content);
    },
    async remove(path: string) {
      const target = normalize(path);
      for (const key of [...files.keys()]) {
        if (key === target || key.startsWith(`${target}/`)) files.delete(key);
      }
    },
  };
  return { fs, files };
}

const LONG_CONTENT = Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i}: the framework explains sampling error and bias in measurement.`,
).join("\n\n");

function fixtureRequest(overrides?: Partial<BookSkillRequest>): BookSkillRequest {
  return {
    book: { id: "book-1", title: "Minimal Statistics", author: "A. Author" },
    chapters: [
      { index: 0, title: "Introduction", content: LONG_CONTENT },
      { index: 1, title: "Chapter 1 — Averages", content: LONG_CONTENT },
      { index: 2, title: "Chapter 2 — Variation", content: LONG_CONTENT },
    ],
    genre: "textbook",
    ...overrides,
  };
}

const SPINE_FIXTURE = {
  thesis: "The book teaches statistics as a toolkit for reasoning under uncertainty.",
  domain: "introductory statistics",
  vocabulary: ["mean", "variance", "sampling"],
  frameworks: [
    {
      name: "Sampling Error",
      summary: "error introduced by observing a sample",
      approxChapter: "ch02",
    },
  ],
};

const TIER1_FIXTURE: BookSkillTier1 = {
  thesis: "Statistics is a toolkit for reasoning under uncertainty.",
  nodes: [
    { name: "Averages", summary: "summarise a distribution with one number", chapter: "ch01" },
    { name: "Variation", summary: "how spread out the values are", chapter: "ch02" },
  ],
  edges: [{ from: "Averages", relation: "builds on", to: "Variation" }],
  coreFrameworks: [
    {
      name: "Averages",
      whenToUse: "Use when you need one summary number.",
      how: "Sum and divide by count.",
    },
  ],
  topicIndex: [
    { term: "mean", chapters: ["ch01"] },
    { term: "variance", chapters: ["ch01", "ch02"] },
  ],
  triggerPhrases: ["summarise data", "measure spread"],
  scopeNote: "Covers the book content only.",
};

function chapterToolkitMarkdown(bookNumber: string, title: string): string {
  return [
    `# Chapter ${bookNumber}: ${title}`,
    "",
    "## Core Idea",
    "Measurements vary; statistics reasons about that variation.",
    "",
    "## Frameworks Introduced",
    "- **Sampling Error**: the gap between a sample statistic and the population value",
    "  - When to use: whenever a sample stands in for a whole population",
    "  - How: quantify the spread across repeated samples",
    "",
    "## Key Concepts",
    "- **Mean**: the balance point of a distribution",
    "",
    "## Key Takeaways",
    "1. Always report variation next to an average.",
    "",
  ].join("\n");
}

function createFakeClient() {
  const calls: Array<{ system: string; user: string }> = [];
  const client: BookSkillLlmClient = {
    async complete(system: string, user: string) {
      calls.push({ system, user });
      if (system.includes("build the spine")) {
        return `Here is the spine:\n\`\`\`json\n${JSON.stringify(SPINE_FIXTURE)}\n\`\`\``;
      }
      if (system.includes("extract one chapter")) {
        const bookNumber = /Chapter to extract: (\S+) —/.exec(user)?.[1] ?? "ch01";
        const title = /Chapter to extract: \S+ — (.+)/.exec(user)?.[1] ?? "Untitled";
        return `Sure! Here is the file:\n\n${chapterToolkitMarkdown(bookNumber, title)}`;
      }
      if (system.includes("REDUCE")) {
        return JSON.stringify(TIER1_FIXTURE);
      }
      throw new Error("unexpected prompt");
    },
  };
  return { client, calls };
}

describe("book-native chapter numbering", () => {
  it("assigns English numbered, named, and matter labels", () => {
    expect(
      assignBookNumbers([
        "Praise for the Book",
        "Introduction",
        "Introduction",
        "Chapter 7 — Taxes",
        "Appendix A",
        "Appendices",
        "Part II",
        "Index",
      ]),
    ).toEqual(["fm", "intro", "intro-2", "ch07", "appendix-a", "appendix", "part-2", "bm"]);
  });

  it("sequentially numbers bare chapter titles without colliding with explicit numbers", () => {
    expect(
      assignBookNumbers(["Optimize Your Credit Cards", "Chapter 2 — Mindset", "Build The Budget"]),
    ).toEqual(["ch01", "ch02", "ch03"]);
  });

  it("parses bare numeric titles and roman numerals", () => {
    expect(assignBookNumbers(["7. Replication", "Chapter IV — Consistency"])).toEqual([
      "ch07",
      "ch04",
    ]);
  });

  it("assigns Chinese chapter labels including numerals", () => {
    expect(
      assignBookNumbers([
        "目录",
        "前言",
        "引言",
        "第3章 平均数",
        "第七章 离散程度",
        "第十二章 正态分布",
        "附录B",
        "尾声",
        "参考文献",
        "数据的世界",
      ]),
    ).toEqual([
      "fm",
      "preface",
      "intro",
      "ch03",
      "ch07",
      "ch12",
      "appendix-b",
      "epilogue",
      "bm",
      "ch01",
    ]);
  });

  it("falls back to a visible unclassified label", () => {
    expect(assignBookNumbers(["misc"])).toEqual(["ch01-unclassified"]);
  });

  it("keeps CJK characters in slugs and falls back to section", () => {
    expect(chapterSlug("第3章 平均数")).toBe("第3章-平均数");
    expect(chapterSlug("Chapter 1 — Averages")).toBe("chapter-1-averages");
    expect(chapterSlug("???")).toBe("section");
  });
});

describe("response boundary", () => {
  it("parses fenced, bare, and prose-wrapped JSON", () => {
    expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonResponse('Sure! {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(parseJsonResponse('{"text": "with \\"quotes\\" and {braces}"}')).toEqual({
      text: 'with "quotes" and {braces}',
    });
  });

  it("rejects failure text and unparsable replies", () => {
    expect(() => parseJsonResponse("调用 AI 失败：余额不足")).toThrow();
    expect(() => parseJsonResponse("no json here")).toThrow();
    expect(looksLikeFailureText("rate limit exceeded")).toBe(true);
    expect(looksLikeFailureText("")).toBe(true);
    expect(looksLikeFailureText("# Chapter 1")).toBe(false);
  });

  it("validates chapter toolkits and strips chatty preambles", () => {
    const toolkit = chapterToolkitMarkdown("ch01", "Averages");
    expect(assertChapterToolkit(`Sure! Here you go:\n\n${toolkit}`, "ch01")).toBe(toolkit.trim());
    expect(() =>
      assertChapterToolkit("# Chapter 1\n\n## Frameworks Introduced\n- x", "ch01"),
    ).toThrow();
    expect(() => assertChapterToolkit("# Chapter 1\n\n## Core Idea\n- x", "ch01")).toThrow();
    expect(() => assertChapterToolkit("调用 AI 失败", "ch01")).toThrow();
    expect(() => assertChapterToolkit("plain text without headings", "ch01")).toThrow();
  });

  it("counts words CJK-aware and estimates tokens honestly", () => {
    expect(countWords("hello world 统计学")).toBe(5);
    expect(estimateTokens("aaaa")).toBe(1);
    expect(estimateTokens("统计")).toBe(2);
  });
});

describe("spine and reduce response validation", () => {
  it("validates the spine shape", () => {
    expect(parseSpineResponse(JSON.stringify(SPINE_FIXTURE)).thesis).toContain("uncertainty");
    expect(() => parseSpineResponse(JSON.stringify({ domain: "x" }))).toThrow();
  });

  it("filters invalid edges and topic pointers with warnings", () => {
    const warnings: string[] = [];
    const tier1 = parseTier1Response(
      JSON.stringify({
        ...TIER1_FIXTURE,
        edges: [
          { from: "Averages", relation: "causes", to: "Variation" },
          { from: "Averages", relation: "builds on", to: "Variation" },
          { from: "Ghost", relation: "requires", to: "Variation" },
        ],
        topicIndex: [
          { term: "mean", chapters: ["ch01"] },
          { term: "bad", chapters: ["ch99"] },
          { term: "mixed", chapters: ["ch01", "ch99"] },
        ],
      }),
      new Set(["ch01", "ch02", "intro"]),
      warnings,
    );
    expect(tier1.edges).toEqual([{ from: "Averages", relation: "builds on", to: "Variation" }]);
    expect(tier1.topicIndex).toEqual([
      { term: "mean", chapters: ["ch01"] },
      { term: "mixed", chapters: ["ch01"] },
    ]);
    expect(warnings.length).toBe(3);
  });
});

describe("book skill pipeline", () => {
  it("generates the full two-tier skill from canonical chapters", async () => {
    const { fs, files } = createMemoryFs();
    const { client, calls } = createFakeClient();
    const progress: string[] = [];
    const result = await generateBookSkill({
      request: fixtureRequest(),
      client,
      fs,
      skillDir: "skills/book-1",
      onProgress: (p) => progress.push(p.phase),
    });

    expect(result.regenerated).toBe(true);
    expect(result.manifest.schema_version).toBe(2);
    expect(result.manifest.chapters.map((c) => c.book_number)).toEqual(["intro", "ch01", "ch02"]);
    expect(result.manifest.chapters.every((c) => c.status === "extracted")).toBe(true);
    expect(result.manifest.readany.bookId).toBe("book-1");
    expect(result.manifest.readany.chapters.map((c) => c.chapterIndex)).toEqual([0, 1, 2]);
    expect(result.manifest.readany.content_version).toHaveLength(64);
    expect(result.tier1.nodes.length).toBe(2);

    for (const path of [
      "skills/book-1/SKILL.md",
      "skills/book-1/chapters_manifest.json",
      "skills/book-1/chapters/intro-introduction.md",
      "skills/book-1/chapters/ch01-chapter-1-averages.md",
      "skills/book-1/chapters/ch02-chapter-2-variation.md",
      "skills/book-1/raw/spine.md",
      "skills/book-1/raw/spine.json",
      "skills/book-1/raw/tier1.json",
      "skills/book-1/raw/metadata.json",
      "skills/book-1/raw/raw_chapters/intro.txt",
    ]) {
      expect(files.has(path)).toBe(true);
    }
    expect(calls.length).toBe(5); // 1 spine + 3 chapters + 1 reduce
    expect(progress[0]).toBe("checking");
    expect(progress[progress.length - 1]).toBe("completed");
    expect(progress).toContain("spine");
    expect(progress).toContain("mapping");
    expect(progress).toContain("reducing");
  });

  it("stubs tiny chapters without any LLM call", async () => {
    const { fs } = createMemoryFs();
    const { client, calls } = createFakeClient();
    const result = await generateBookSkill({
      request: fixtureRequest({
        chapters: [
          { index: 0, title: "Introduction", content: LONG_CONTENT },
          { index: 1, title: "Chapter 1 — Averages", content: "too short" },
        ],
      }),
      client,
      fs,
      skillDir: "skills/book-1",
    });
    expect(result.manifest.chapters[1].status).toBe("failed");
    expect(result.chapterLint[1].stub).toBe(true);
    expect(calls.length).toBe(3); // spine + 1 chapter + reduce
  });

  it("resumes a completed skill without LLM calls", async () => {
    const { fs } = createMemoryFs();
    const first = createFakeClient();
    await generateBookSkill({
      request: fixtureRequest(),
      client: first.client,
      fs,
      skillDir: "skills/book-1",
    });
    const second = createFakeClient();
    const result = await generateBookSkill({
      request: fixtureRequest(),
      client: second.client,
      fs,
      skillDir: "skills/book-1",
    });
    expect(result.regenerated).toBe(false);
    expect(second.calls.length).toBe(0);
    expect(result.manifest.chapters.length).toBe(3);
  });

  it("rebuilds in full when the book content changes", async () => {
    const { fs } = createMemoryFs();
    const first = createFakeClient();
    await generateBookSkill({
      request: fixtureRequest(),
      client: first.client,
      fs,
      skillDir: "skills/book-1",
    });
    const second = createFakeClient();
    const changed = fixtureRequest();
    changed.chapters[2] = {
      index: 2,
      title: "Chapter 2 — Variation",
      content: `${LONG_CONTENT}\nNew material.`,
    };
    const result = await generateBookSkill({
      request: changed,
      client: second.client,
      fs,
      skillDir: "skills/book-1",
    });
    expect(result.regenerated).toBe(true);
    expect(second.calls.length).toBe(5);
    const loaded = await loadBookSkill(fs, "skills/book-1");
    expect(loaded?.manifest.readany.content_version).toBe(result.manifest.readany.content_version);
  });

  it("retries a broken chapter toolkit once and then writes an honest stub", async () => {
    const { fs } = createMemoryFs();
    let chapterCalls = 0;
    const client: BookSkillLlmClient = {
      async complete(system: string, user: string) {
        if (system.includes("build the spine")) return JSON.stringify(SPINE_FIXTURE);
        if (system.includes("extract one chapter")) {
          chapterCalls += 1;
          if (user.includes("Chapter 1 — Averages")) return "I could not extract this chapter.";
          const bookNumber = /Chapter to extract: (\S+) —/.exec(user)?.[1] ?? "ch01";
          const title = /Chapter to extract: \S+ — (.+)/.exec(user)?.[1] ?? "Untitled";
          return chapterToolkitMarkdown(bookNumber, title);
        }
        return JSON.stringify(TIER1_FIXTURE);
      },
    };
    const result = await generateBookSkill({
      request: fixtureRequest(),
      client,
      fs,
      skillDir: "skills/book-1",
    });
    expect(chapterCalls).toBe(4); // ch01 tried twice, other two chapters once each
    expect(result.manifest.chapters[1].status).toBe("failed");
    expect(result.warnings.some((w) => w.includes("ch01"))).toBe(true);
  });

  it("exposes per-chapter lint truth", () => {
    const lint = lintChapterToolkit("ch01", chapterToolkitMarkdown("ch01", "Averages"));
    expect(lint.stub).toBe(false);
    expect(lint.missingHeadings).toEqual([]);
    expect(lint.words).toBeGreaterThan(10);
    const stubbed = lintChapterToolkit("ch02", "# ch02 — extraction failed\nRaw source unusable.");
    expect(stubbed.stub).toBe(true);
  });

  it("loads an existing skill without regenerating", async () => {
    const { fs } = createMemoryFs();
    const { client } = createFakeClient();
    await generateBookSkill({ request: fixtureRequest(), client, fs, skillDir: "skills/book-1" });
    const loaded = await loadBookSkill(fs, "skills/book-1");
    expect(loaded?.manifest.schema_version).toBe(2);
    expect(loaded?.tier1.nodes.length).toBe(2);
    expect(await loadBookSkill(fs, "skills/missing")).toBeNull();
  });
});

describe("skill markdown rendering", () => {
  it("renders the upstream master SKILL.md shape", async () => {
    const { fs } = createMemoryFs();
    const { client } = createFakeClient();
    const result = await generateBookSkill({
      request: fixtureRequest(),
      client,
      fs,
      skillDir: "s",
    });
    const skillMd = await fs.readFile("s/SKILL.md");
    expect(skillMd.startsWith("---")).toBe(true);
    expect(skillMd).toContain("name: minimal-statistics");
    expect(skillMd).toContain("## Book Thesis");
    expect(skillMd).toContain("## Concept Map");
    expect(skillMd).toContain("**Averages** → builds on → **Variation**");
    expect(skillMd).toContain("## Topic Index");
    expect(skillMd).toContain("[ch01](chapters/ch01-chapter-1-averages.md)");
    expect(skillMd).toContain("## Scope & Limits");
    expect(result.manifest.skill_slug).toBe("minimal-statistics");
  });
});

describe("cost estimate", () => {
  it("follows the upstream Step 4 formula", () => {
    const estimate = estimateBookSkillCost([{ title: "A", content: "a".repeat(400) }]);
    expect(estimate.chapterCount).toBe(1);
    expect(estimate.estimatedInputTokens).toBe(Math.ceil(100 * 1.4) + 250);
    expect(estimate.estimatedOutputTokens).toBe(1 * 1100 + 9000);
  });
});

describe("book skill panel state", () => {
  it("walks the designed states", () => {
    let state = bookSkillPanelReducer(initialBookSkillPanelState, {
      type: "BOOK_CHANGED",
      bookId: "b1",
    });
    expect(state.phase).toBe("idle");
    state = bookSkillPanelReducer(state, { type: "ESTIMATE_LOADING" });
    expect(state.phase).toBe("estimating");
    state = bookSkillPanelReducer(state, {
      type: "ESTIMATE_READY",
      estimate: { chapterCount: 3, estimatedInputTokens: 10, estimatedOutputTokens: 20 },
    });
    expect(state.phase).toBe("estimate-ready");
    state = bookSkillPanelReducer(state, { type: "GENRE_SELECTED", genre: "financial" });
    expect(state.genre).toBe("financial");
    state = bookSkillPanelReducer(state, { type: "GENERATE_START" });
    expect(state.phase).toBe("generating");
    state = bookSkillPanelReducer(state, {
      type: "PROGRESS",
      progress: { phase: "mapping", totalChapters: 3, completedChapters: 1 },
    });
    expect(state.progress?.completedChapters).toBe(1);
    state = bookSkillPanelReducer(state, { type: "ERROR", error: "boom" });
    expect(state.phase).toBe("error");
    state = bookSkillPanelReducer(state, { type: "REGENERATE" });
    expect(state.phase).toBe("estimate-ready");
    expect(state.genre).toBe("financial");
    state = bookSkillPanelReducer(state, { type: "UNAVAILABLE", error: "no endpoint" });
    expect(state.phase).toBe("unavailable");
    state = bookSkillPanelReducer(state, { type: "BOOK_CHANGED", bookId: "b2" });
    expect(state.phase).toBe("idle");
    expect(state.bookId).toBe("b2");
  });
});
