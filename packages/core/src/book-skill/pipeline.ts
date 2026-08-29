// Stage orchestration for the Book Skill pipeline (PR-002, The Knowledge Guy
// orchestrated pipeline port). Deterministic, resumable, provider-agnostic:
// - Pass 0 Spine  -> raw/spine.{json,md}      (LLM, retried once, then fatal)
// - Stage 1 MAP   -> chapters/<book_number>-<slug>.md  (LLM per chapter,
//                   batched concurrency, retried once, then honest stub)
// - Stage 2 REDUCE-> raw/tier1.json + SKILL.md + chapters_manifest.json
// Resume is filesystem-driven (upstream rule): a chapter file that exists, is
// >500 bytes and has no "extraction failed" marker is done. A content-version
// mismatch triggers a full rebuild. ReadAny stays the source Authority.

import { assignBookNumbers, chapterSlug } from "./book-number";
import { buildChapterPrompt, buildReducePrompt, buildSpinePrompt } from "./prompts";
import {
  BookSkillResponseError,
  assertChapterToolkit,
  countWords,
  estimateTokens,
  parseJsonResponse,
} from "./response";
import { renderSkillMd, renderSpineMd } from "./skill-md";
import { TKG_UPSTREAM_REF } from "./types";
import type {
  BookSkillChapterLint,
  BookSkillConceptMapEdge,
  BookSkillEdgeRelation,
  BookSkillFs,
  BookSkillLlmClient,
  BookSkillManifest,
  BookSkillManifestChapter,
  BookSkillProgress,
  BookSkillRequest,
  BookSkillResult,
  BookSkillSpine,
  BookSkillTier1,
} from "./types";

const STUB_MARKER = "extraction failed";
const MIN_RAW_CHARS = 300;
const RESUME_MIN_BYTES = 500;
const EDGE_RELATIONS: BookSkillEdgeRelation[] = [
  "builds on",
  "requires",
  "instance of",
  "failure mode of",
  "trades off against",
  "contradicts",
  "refines",
];

export interface GenerateBookSkillOptions {
  request: BookSkillRequest;
  client: BookSkillLlmClient;
  fs: BookSkillFs;
  skillDir: string;
  /** Parallel chapter extractions; upstream batches 5-8, default 4. */
  concurrency?: number;
  onProgress?: (progress: BookSkillProgress) => void;
}

interface ChapterEntry {
  input: BookSkillRequest["chapters"][number];
  index: number;
  book_number: string;
  slug: string;
  file: string;
  rawFile: string;
}

export async function computeBookSkillContentVersion(request: BookSkillRequest): Promise<string> {
  const payload = [
    TKG_UPSTREAM_REF,
    request.book.id,
    request.book.title,
    request.book.author ?? "",
    request.genre,
    ...request.chapters.map((c) => `${c.index}\u0000${c.title}\u0000${c.content}`),
  ].join("\u0001");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateBookSkill(
  options: GenerateBookSkillOptions,
): Promise<BookSkillResult> {
  const { request, client, fs, skillDir } = options;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const onProgress = options.onProgress ?? (() => undefined);
  const warnings: string[] = [];

  if (request.chapters.length === 0) {
    throw new Error("Book Skill generation requires at least one chapter");
  }

  const bookNumbers = assignBookNumbers(request.chapters.map((c) => c.title));
  const entries: ChapterEntry[] = request.chapters.map((input, i) => ({
    input,
    index: i + 1,
    book_number: bookNumbers[i],
    slug: chapterSlug(input.title),
    file: `chapters/${bookNumbers[i]}-${chapterSlug(input.title)}.md`,
    rawFile: `raw/raw_chapters/${bookNumbers[i]}.txt`,
  }));
  const contentVersion = await computeBookSkillContentVersion(request);
  const skillSlug = chapterSlug(request.book.title, 64);

  const chaptersDir = fs.join(skillDir, "chapters");
  const rawDir = fs.join(skillDir, "raw");
  const rawChaptersDir = fs.join(rawDir, "raw_chapters");
  const metadataPath = fs.join(rawDir, "metadata.json");
  const spineJsonPath = fs.join(rawDir, "spine.json");
  const spineMdPath = fs.join(rawDir, "spine.md");
  const tier1JsonPath = fs.join(rawDir, "tier1.json");
  const manifestPath = fs.join(skillDir, "chapters_manifest.json");
  const skillMdPath = fs.join(skillDir, "SKILL.md");

  onProgress({ phase: "checking", totalChapters: entries.length, completedChapters: 0 });

  let existingVersion: string | null = null;
  if (await fs.exists(metadataPath)) {
    try {
      existingVersion =
        parseJsonResponse<{ content_version?: string }>(await fs.readFile(metadataPath))
          .content_version ?? null;
    } catch {
      existingVersion = null;
    }
  }

  if (existingVersion !== null && existingVersion !== contentVersion) {
    await fs.remove(chaptersDir);
    await fs.remove(rawDir);
    await fs.remove(manifestPath);
    await fs.remove(skillMdPath);
    existingVersion = null;
  }

  if (
    existingVersion === contentVersion &&
    (await fs.exists(manifestPath)) &&
    (await fs.exists(skillMdPath)) &&
    (await fs.exists(tier1JsonPath))
  ) {
    const result = await loadBookSkill(fs, skillDir);
    if (result) {
      onProgress({
        phase: "completed",
        totalChapters: entries.length,
        completedChapters: entries.length,
      });
      return { ...result, regenerated: false };
    }
  }

  await fs.mkdir(chaptersDir);
  await fs.mkdir(rawChaptersDir);
  for (const entry of entries) {
    await fs.writeFile(fs.join(skillDir, entry.rawFile), entry.input.content);
  }
  await fs.writeFile(
    metadataPath,
    JSON.stringify(
      {
        source: "readany-book-skill",
        tkg_ref: TKG_UPSTREAM_REF,
        content_version: contentVersion,
        genre: request.genre,
        book: {
          id: request.book.id,
          title: request.book.title,
          author: request.book.author ?? null,
        },
        chapters: entries.map((e) => ({
          index: e.index,
          book_number: e.book_number,
          title: e.input.title,
          slug: e.slug,
          readany_chapter_index: e.input.index,
          est_tokens: estimateTokens(e.input.content),
        })),
      },
      null,
      2,
    ),
  );

  // ---- Pass 0: spine ------------------------------------------------------
  let spine: BookSkillSpine;
  if ((await fs.exists(spineJsonPath)) && existingVersion === contentVersion) {
    spine = parseJsonResponse<BookSkillSpine>(await fs.readFile(spineJsonPath));
  } else {
    onProgress({ phase: "spine", totalChapters: entries.length, completedChapters: 0 });
    spine = await callWithRetry(async () => {
      const prompt = buildSpinePrompt(
        request,
        entries.map((e) => ({
          book_number: e.book_number,
          title: e.input.title,
          content: e.input.content,
        })),
      );
      return parseSpineResponse(await client.complete(prompt.system, prompt.user));
    });
    await fs.writeFile(spineJsonPath, JSON.stringify(spine, null, 2));
    await fs.writeFile(spineMdPath, renderSpineMd(spine, request.book.title, request.book.author));
  }

  // ---- Stage 1: MAP (per chapter, resumable, batched) ---------------------
  const todo: ChapterEntry[] = [];
  let completed = 0;
  for (const entry of entries) {
    const chapterPath = fs.join(skillDir, entry.file);
    if (await fs.exists(chapterPath)) {
      const existing = await fs.readFile(chapterPath);
      if (existing.length > RESUME_MIN_BYTES && !existing.toLowerCase().includes(STUB_MARKER)) {
        completed += 1;
        continue;
      }
    }
    todo.push(entry);
  }
  onProgress({ phase: "mapping", totalChapters: entries.length, completedChapters: completed });

  const llmTodo: ChapterEntry[] = [];
  for (const entry of todo) {
    if (entry.input.content.trim().length < MIN_RAW_CHARS) {
      await fs.writeFile(fs.join(skillDir, entry.file), stubContent(entry));
      completed += 1;
    } else {
      llmTodo.push(entry);
    }
  }
  onProgress({ phase: "mapping", totalChapters: entries.length, completedChapters: completed });

  for (let i = 0; i < llmTodo.length; i += concurrency) {
    const batch = llmTodo.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (entry) => {
        const chapterPath = fs.join(skillDir, entry.file);
        try {
          const toolkit = await callWithRetry(async () => {
            const prompt = buildChapterPrompt({
              bookTitle: request.book.title,
              author: request.book.author,
              genre: request.genre,
              spine,
              chapter: {
                book_number: entry.book_number,
                title: entry.input.title,
                content: entry.input.content,
              },
            });
            return assertChapterToolkit(
              await client.complete(prompt.system, prompt.user),
              entry.book_number,
            );
          });
          await fs.writeFile(chapterPath, toolkit);
        } catch (error) {
          warnings.push(`Chapter ${entry.book_number} extraction failed: ${errorMessage(error)}`);
          await fs.writeFile(chapterPath, stubContent(entry));
        }
      }),
    );
    completed += batch.length;
    onProgress({ phase: "mapping", totalChapters: entries.length, completedChapters: completed });
  }

  // ---- Stage 2: REDUCE ----------------------------------------------------
  onProgress({
    phase: "reducing",
    totalChapters: entries.length,
    completedChapters: entries.length,
  });
  const toolkits: Array<{ book_number: string; title: string; toolkit: string }> = [];
  const chapterLint: BookSkillChapterLint[] = [];
  for (const entry of entries) {
    const text = await fs.readFile(fs.join(skillDir, entry.file));
    toolkits.push({ book_number: entry.book_number, title: entry.input.title, toolkit: text });
    chapterLint.push(lintChapterToolkit(entry.book_number, text));
  }

  const validBookNumbers = new Set(entries.map((e) => e.book_number));
  const tier1 = await callWithRetry(async () => {
    const prompt = buildReducePrompt({
      bookTitle: request.book.title,
      author: request.book.author,
      genre: request.genre,
      spine,
      toolkits,
    });
    return parseTier1Response(
      await client.complete(prompt.system, prompt.user),
      validBookNumbers,
      warnings,
    );
  });

  const manifestChapters: BookSkillManifestChapter[] = entries.map((entry, i) => ({
    index: entry.index,
    book_number: entry.book_number,
    title: entry.input.title,
    slug: entry.slug,
    file: entry.file,
    word_count: countWords(toolkits[i].toolkit),
    token_estimate: estimateTokens(toolkits[i].toolkit),
    status: chapterLint[i].stub ? "failed" : "extracted",
  }));
  const builtAt = new Date().toISOString();
  const manifest: BookSkillManifest = {
    schema_version: 2,
    skill_slug: skillSlug,
    built_at: builtAt,
    generator: { source: "readany-book-skill", tkg_ref: TKG_UPSTREAM_REF },
    chapters: manifestChapters,
    readany: {
      bookId: request.book.id,
      bookTitle: request.book.title,
      author: request.book.author,
      genre: request.genre,
      content_version: contentVersion,
      chapters: entries.map((e) => ({
        book_number: e.book_number,
        chapterIndex: e.input.index,
        title: e.input.title,
      })),
    },
  };

  // Upstream Step 10 validation: every manifest entry has a book_number and a
  // chapter file that actually exists on disk.
  for (const chapter of manifestChapters) {
    if (!chapter.book_number) {
      throw new Error(`Manifest chapter "${chapter.title}" is missing its book_number`);
    }
    if (!(await fs.exists(fs.join(skillDir, chapter.file)))) {
      throw new Error(
        `Manifest entry ${chapter.book_number} points at a missing file: ${chapter.file}`,
      );
    }
  }

  await fs.writeFile(
    skillMdPath,
    renderSkillMd({ tier1, manifest, bookTitle: request.book.title, author: request.book.author }),
  );
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await fs.writeFile(tier1JsonPath, JSON.stringify(tier1, null, 2));
  await fs.writeFile(
    fs.join(rawDir, "progress.json"),
    JSON.stringify({ completed_at: builtAt, content_version: contentVersion }, null, 2),
  );

  onProgress({
    phase: "completed",
    totalChapters: entries.length,
    completedChapters: entries.length,
  });
  return { skillDir, regenerated: true, manifest, tier1, spine, chapterLint, warnings };
}

/** Load an existing generated skill without any LLM calls; null when absent. */
export async function loadBookSkill(
  fs: BookSkillFs,
  skillDir: string,
): Promise<BookSkillResult | null> {
  const manifestPath = fs.join(skillDir, "chapters_manifest.json");
  const tier1Path = fs.join(skillDir, "raw", "tier1.json");
  const spinePath = fs.join(skillDir, "raw", "spine.json");
  if (
    !(await fs.exists(manifestPath)) ||
    !(await fs.exists(tier1Path)) ||
    !(await fs.exists(spinePath))
  ) {
    return null;
  }
  const manifest = parseJsonResponse<BookSkillManifest>(await fs.readFile(manifestPath));
  const tier1 = parseJsonResponse<BookSkillTier1>(await fs.readFile(tier1Path));
  const spine = parseJsonResponse<BookSkillSpine>(await fs.readFile(spinePath));
  const chapterLint: BookSkillChapterLint[] = [];
  for (const chapter of manifest.chapters) {
    const path = fs.join(skillDir, chapter.file);
    chapterLint.push(
      (await fs.exists(path))
        ? lintChapterToolkit(chapter.book_number, await fs.readFile(path))
        : {
            book_number: chapter.book_number,
            words: 0,
            missingHeadings: ["file missing"],
            stub: true,
          },
    );
  }
  return { skillDir, regenerated: true, manifest, tier1, spine, chapterLint, warnings: [] };
}

function stubContent(entry: ChapterEntry): string {
  return [
    `# ${entry.book_number} — ${STUB_MARKER}`,
    `Raw source is ${entry.input.content.length} chars / appears unusable.`,
    `Inspect raw/${entry.rawFile} and re-extract if needed.`,
    "",
  ].join("\n");
}

export function lintChapterToolkit(bookNumber: string, text: string): BookSkillChapterLint {
  const lower = text.toLowerCase();
  const missingHeadings: string[] = [];
  if (!lower.includes("## core idea")) missingHeadings.push("Core Idea");
  if (!lower.includes("frameworks") && !lower.includes("key takeaways")) {
    missingHeadings.push("Frameworks / Key Takeaways");
  }
  return {
    book_number: bookNumber,
    words: countWords(text),
    missingHeadings,
    stub: lower.includes(STUB_MARKER),
  };
}

export function parseSpineResponse(raw: string): BookSkillSpine {
  const parsed = parseJsonResponse<Partial<BookSkillSpine>>(raw);
  if (typeof parsed.thesis !== "string" || !parsed.thesis.trim()) {
    throw new BookSkillResponseError("Spine reply is missing its thesis");
  }
  return {
    thesis: parsed.thesis.trim(),
    domain: typeof parsed.domain === "string" ? parsed.domain : "",
    vocabulary: Array.isArray(parsed.vocabulary)
      ? parsed.vocabulary.filter((t): t is string => typeof t === "string")
      : [],
    frameworks: Array.isArray(parsed.frameworks)
      ? parsed.frameworks.filter((f) => f && typeof f.name === "string")
      : [],
  };
}

export function parseTier1Response(
  raw: string,
  validBookNumbers: Set<string>,
  warnings: string[],
): BookSkillTier1 {
  const parsed = parseJsonResponse<Partial<BookSkillTier1>>(raw);
  if (typeof parsed.thesis !== "string" || !parsed.thesis.trim()) {
    throw new BookSkillResponseError("Reduce reply is missing its thesis");
  }
  const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).filter(
    (n) => n && typeof n.name === "string" && typeof n.summary === "string",
  );
  const nodeNames = new Set(nodes.map((n) => n.name));
  const edges: BookSkillConceptMapEdge[] = [];
  for (const edge of Array.isArray(parsed.edges) ? parsed.edges : []) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    if (!EDGE_RELATIONS.includes(edge.relation as BookSkillEdgeRelation)) {
      warnings.push(`Dropped edge with unknown relation "${String(edge.relation)}"`);
      continue;
    }
    if (!nodeNames.has(edge.from) || !nodeNames.has(edge.to)) {
      warnings.push(`Dropped edge referencing a non-node framework: ${edge.from} → ${edge.to}`);
      continue;
    }
    edges.push({ from: edge.from, relation: edge.relation, to: edge.to });
  }
  const topicIndex: BookSkillTier1["topicIndex"] = [];
  for (const entry of Array.isArray(parsed.topicIndex) ? parsed.topicIndex : []) {
    if (!entry || typeof entry.term !== "string") continue;
    const chapters = Array.isArray(entry.chapters)
      ? entry.chapters.filter((c): c is string => typeof c === "string" && validBookNumbers.has(c))
      : [];
    if (chapters.length === 0) {
      warnings.push(
        `Dropped topic-index entry with no valid chapter pointer: ${String(entry.term)}`,
      );
      continue;
    }
    topicIndex.push({ term: entry.term, chapters });
  }
  return {
    thesis: parsed.thesis.trim(),
    nodes,
    edges,
    coreFrameworks: (Array.isArray(parsed.coreFrameworks) ? parsed.coreFrameworks : []).filter(
      (f) => f && typeof f.name === "string",
    ),
    topicIndex,
    triggerPhrases: (Array.isArray(parsed.triggerPhrases) ? parsed.triggerPhrases : []).filter(
      (p): p is string => typeof p === "string",
    ),
    scopeNote: typeof parsed.scopeNote === "string" ? parsed.scopeNote : undefined,
  };
}

async function callWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
