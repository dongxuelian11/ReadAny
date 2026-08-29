// PR-002 Book Skill — The Knowledge Guy orchestrated pipeline port.
// Upstream: https://github.com/vitalysim/the-knowledge-guy (verified MIT at pin).
// The pipeline follows upstream's book-to-skill runbook stages:
// Pass 0 Spine -> Stage 1 MAP (per-chapter toolkits) -> Stage 2 REDUCE (Tier-1
// concept map) -> chapters_manifest.json. ReadAny canonical chapters are the
// only source; the generated skill is a rebuildable derived cache.

export const TKG_UPSTREAM_REF = "052049f45f7baa57c23f24c6e0ac5aba9f5133bb";

export type BookSkillGenre =
  | "technical"
  | "vuln-hunting"
  | "financial"
  | "scientific"
  | "legal"
  | "textbook"
  | "reference"
  | "business"
  | "psychology"
  | "history"
  | "productivity"
  | "biography"
  | "narrative"
  | "general";

export interface BookSkillChapterInput {
  /** ReadAny canonical chapter index, preserved verbatim. */
  index: number;
  title: string;
  content: string;
}

export interface BookSkillRequest {
  book: { id: string; title: string; author?: string };
  chapters: BookSkillChapterInput[];
  genre: BookSkillGenre;
}

/** Pass 0 output — the book-level context every chapter extractor reads. */
export interface BookSkillSpine {
  thesis: string;
  domain: string;
  vocabulary: string[];
  frameworks: Array<{ name: string; summary: string; approxChapter?: string }>;
}

export type BookSkillEdgeRelation =
  | "builds on"
  | "requires"
  | "instance of"
  | "failure mode of"
  | "trades off against"
  | "contradicts"
  | "refines";

export interface BookSkillConceptMapNode {
  name: string;
  summary: string;
  /** book_number of the chapter that introduces the framework. */
  chapter: string;
}

export interface BookSkillConceptMapEdge {
  from: string;
  relation: BookSkillEdgeRelation;
  to: string;
}

export interface BookSkillCoreFramework {
  name: string;
  whenToUse: string;
  how: string;
}

export interface BookSkillTopicIndexEntry {
  term: string;
  /** book_numbers of every chapter the term appears in. */
  chapters: string[];
}

/** Stage 2 structured output; SKILL.md is rendered deterministically from it. */
export interface BookSkillTier1 {
  thesis: string;
  nodes: BookSkillConceptMapNode[];
  edges: BookSkillConceptMapEdge[];
  coreFrameworks: BookSkillCoreFramework[];
  topicIndex: BookSkillTopicIndexEntry[];
  triggerPhrases: string[];
  scopeNote?: string;
}

export interface BookSkillManifestChapter {
  /** Extraction order, 1..N — internal only, never user-facing (upstream rule). */
  index: number;
  /** Book-native label: ch07, intro, appendix-a, fm, bm, … (upstream vocabulary). */
  book_number: string;
  title: string;
  slug: string;
  file: string;
  word_count: number;
  token_estimate: number;
  status: "extracted" | "failed";
}

export interface BookSkillManifest {
  schema_version: 2;
  skill_slug: string;
  built_at: string;
  generator: { source: "readany-book-skill"; tkg_ref: string };
  chapters: BookSkillManifestChapter[];
  /** ReadAny canonical mapping — extra namespaced block, ignored by upstream scripts. */
  readany: {
    bookId: string;
    bookTitle: string;
    author?: string;
    genre: BookSkillGenre;
    content_version: string;
    chapters: Array<{ book_number: string; chapterIndex: number; title: string }>;
  };
}

/** Provider-agnostic one-shot completion surface; the app wires it to aiConfig. */
export interface BookSkillLlmClient {
  complete(system: string, user: string): Promise<string>;
}

/** Minimal filesystem surface so the pipeline stays platform-agnostic. */
export interface BookSkillFs {
  /** Join path segments with the platform separator. */
  join(...parts: string[]): string;
  /** Recursive mkdir; must not fail when the directory already exists. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** UTF-8 read; must throw when the path is missing. */
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Remove a file or a directory tree. */
  remove(path: string): Promise<void>;
}

export type BookSkillPhase = "checking" | "spine" | "mapping" | "reducing" | "completed";

export interface BookSkillProgress {
  phase: BookSkillPhase;
  totalChapters: number;
  completedChapters: number;
  currentChapter?: string;
  warning?: string;
}

export interface BookSkillChapterLint {
  book_number: string;
  /** CJK-aware word estimate: latin whitespace words + CJK characters. */
  words: number;
  missingHeadings: string[];
  stub: boolean;
}

export interface BookSkillResult {
  skillDir: string;
  /** False when an up-to-date skill already existed and was reused verbatim. */
  regenerated: boolean;
  manifest: BookSkillManifest;
  tier1: BookSkillTier1;
  spine: BookSkillSpine;
  chapterLint: BookSkillChapterLint[];
  warnings: string[];
}
