// Prompt contracts for the three LLM stages, adapted faithfully from the
// upstream book-to-skill runbook (MIT): Pass 0 Spine (Step 5), Stage 1 MAP
// (Step 7 subagent task), Stage 2 REDUCE (Step 8 + reference/concept-map-spec.md).
// Upstream executes these as Claude agent instructions; here they are plain
// system/user chat prompts so any OpenAI-compatible endpoint (DeepSeek first)
// can execute them. Prompt text is data — never let a model reply mutate it.

import { BOOK_SKILL_GENRE_PROFILES } from "./genres";
import type { BookSkillRequest, BookSkillSpine } from "./types";

export interface BookSkillPrompt {
  system: string;
  user: string;
}

const OPENING_CHARS = 8000;
const SPINE_FRAGMENT_CHARS = 1000;

interface NumberedChapter {
  book_number: string;
  title: string;
  content: string;
}

export function buildSpinePrompt(
  request: BookSkillRequest,
  chapters: NumberedChapter[],
): BookSkillPrompt {
  const opening = chapters
    .map((c) => c.content)
    .join("\n\n")
    .slice(0, OPENING_CHARS);
  const fragments = chapters
    .map((c) => `### ${c.book_number} — ${c.title}\n${c.content.slice(0, SPINE_FRAGMENT_CHARS)}`)
    .join("\n\n");

  const system = [
    "You build the spine of a book-to-skill conversion.",
    "Build the spine mechanically, not impressionistically — every chapter extractor will read it, so weak input propagates everywhere.",
    "Synthesise ONLY from the fragments provided in the user message. Do not invent chapters, frameworks, or claims that the fragments do not support.",
    "Return STRICT JSON only, no prose before or after, with this exact shape:",
    "{",
    '  "thesis": "2-3 sentences: what the whole book argues.",',
    '  "domain": "the subject area of the book.",',
    '  "vocabulary": ["5-10 distinctive terms the book uses"],',
    '  "frameworks": [',
    '    { "name": "Exact framework name", "summary": "one line on what it is", "approxChapter": "the book_number where it appears, e.g. ch03 or intro" }',
    "  ]",
    "}",
  ].join("\n");

  const user = [
    `Book: ${request.book.title}`,
    request.book.author ? `Author: ${request.book.author}` : "Author: unknown",
    "",
    "Opening excerpt (front matter / table-of-contents region):",
    opening,
    "",
    "First fragment of every chapter:",
    fragments,
  ].join("\n");

  return { system, user };
}

const CHAPTER_TEMPLATE_TEXT = [
  "# Chapter file template (Stage 1 MAP output)",
  "Produce one markdown toolkit file per chapter with exactly these section headings (keep the headings in English; write the section CONTENT in the same language as the chapter text):",
  "```markdown",
  "# Chapter <book_number>: <Full Title>",
  "## Core Idea",
  "<1-2 sentences: the single most important thing this chapter teaches.>",
  "## Frameworks Introduced",
  "- **<Exact Framework Name>**: <the author's precise formulation>",
  "  - When to use: <specific trigger situation>",
  "  - How: <steps or criteria>",
  "## Key Concepts",
  "- **<Term>**: <precise one-sentence definition>",
  "## Mental Models",
  "<2-4 thinking tools, written as 'Use X when Y' or 'Think of X as Y'.>",
  "## Anti-patterns",
  "- **<What to avoid>**: <why it fails>",
  "## Key Takeaways",
  "1. <Actionable insight a practitioner must remember>",
  "```",
  "Keep every section that has real content; omit a section only when its element is genuinely absent from the chapter. Never invent content to fill a section.",
  "Add a '## Code Examples' section (technical / vuln-hunting / scientific genres only) with the single most instructive snippet preserved exactly, and a '## Reference Tables' section (technical / financial / scientific genres only) when the chapter contains a comparison matrix or decision table. Add a final '## Connects To' section citing other chapters by book_number when the chapter genuinely builds on them.",
  "When a chapter references another chapter, cite it by book_number, e.g. 'see ch07' or 'see the Introduction (intro)'.",
].join("\n");

export function buildChapterPrompt(params: {
  bookTitle: string;
  author?: string;
  genre: BookSkillRequest["genre"];
  spine: BookSkillSpine;
  chapter: NumberedChapter;
}): BookSkillPrompt {
  const profile = BOOK_SKILL_GENRE_PROFILES[params.genre];
  const spineDigest = [
    `Book thesis: ${params.spine.thesis}`,
    `Domain: ${params.spine.domain}`,
    `Framework inventory: ${params.spine.frameworks.map((f) => `${f.name} (${f.approxChapter ?? "?"})`).join("; ")}`,
  ].join("\n");

  const system = [
    "You extract one chapter into a book-skill chapter file.",
    "The job is extraction, not summary. A chapter file is a toolkit of the chapter's named frameworks, exact techniques, and anti-patterns — not a recap of what the chapter 'talks about'.",
    "Write in practitioner voice: 'Use X when Y', not 'the chapter explains X'.",
    "Preserve the author's exact terminology and naming — 'The 5 Whys' is not 'ask why a few times'.",
    "Never copy raw book text; always synthesise. Preserve exact framework names.",
    "Target size: 800-1,400 tokens. Dense, not verbose. A tight 1,000-token extraction beats a 6,000-token excerpt. If the chapter is genuinely huge, keep the file tight and push secondary detail into Key Takeaways as terse lines.",
    "Density over completeness — extract signal, drop filler. Every framework needs a 'when to use', or it is not actionable.",
    "",
    `Genre profile (${params.genre}) — the fundamental knowledge unit is ${profile.unit}.`,
    `Map emphasis: ${profile.mapEmphasis}`,
    "",
    CHAPTER_TEMPLATE_TEXT,
    "",
    "Return ONLY the markdown file content, starting with the '# Chapter' heading. No preamble, no closing remarks.",
  ].join("\n");

  const user = [
    `Book: ${params.bookTitle}${params.author ? ` by ${params.author}` : ""}`,
    "",
    "Book spine (for context — extract in light of where the book is going):",
    spineDigest,
    "",
    `Chapter to extract: ${params.chapter.book_number} — ${params.chapter.title}`,
    "Chapter raw text:",
    params.chapter.content,
  ].join("\n");

  return { system, user };
}

const EDGE_RELATIONS = [
  "builds on",
  "requires",
  "instance of",
  "failure mode of",
  "trades off against",
  "contradicts",
  "refines",
] as const;

export function buildReducePrompt(params: {
  bookTitle: string;
  author?: string;
  genre: BookSkillRequest["genre"];
  spine: BookSkillSpine;
  toolkits: Array<{ book_number: string; title: string; toolkit: string }>;
}): BookSkillPrompt {
  const profile = BOOK_SKILL_GENRE_PROFILES[params.genre];
  const reduceRule =
    params.genre === "financial" || params.genre === "scientific"
      ? "Do NOT over-merge: the same term across chapters can mean different things; keep distinct nodes."
      : "Deduplicate frameworks that recur across chapters into one node; where a later chapter sharpens a concept introduced earlier, merge into one node and note the progression.";

  const system = [
    "You are the Stage 2 REDUCE step of a book-to-skill conversion.",
    "Stage 2 builds a concept map; it does NOT summarise the summaries. Summarising chapter summaries yields a shorter book report and loses detail twice. A concept map is a different artifact — nodes and edges: the concepts the book teaches and how they relate. Those relationships live BETWEEN chapters; surfacing them is the whole point of this step.",
    `Consolidation rules: ${reduceRule}`,
    `Reduce emphasis for this genre (${params.genre}): ${profile.reduceEmphasis}`,
    "Identify the 6-10 load-bearing frameworks for the Core Frameworks section.",
    `Concept map edges use ONLY this closed vocabulary: ${EDGE_RELATIONS.join(", ")}.`,
    "Topic index requirements — it is the bridge between the two tiers and must be excellent:",
    "- Map the vocabulary a user would actually ask in — not just chapter titles.",
    "- Include synonyms and BOTH the author's term and the common term.",
    "- A framework spanning multiple chapters points to ALL of them.",
    "Also produce 10-15 comma-separated trigger phrases describing when to consult this book (for the skill's when_to_use field).",
    "Return STRICT JSON only, no prose, with this exact shape:",
    "{",
    '  "thesis": "2-3 sentences from the spine: what the book argues, overall.",',
    '  "nodes": [ { "name": "Framework", "summary": "one-line what it is and when it applies", "chapter": "book_number where it is introduced" } ],',
    '  "edges": [ { "from": "Framework A", "relation": "builds on", "to": "Framework B" } ],',
    '  "coreFrameworks": [ { "name": "Exact Framework Name", "whenToUse": "Use X when Y", "how": "steps or criteria, 1-3 sentences" } ],',
    '  "topicIndex": [ { "term": "Term / synonym", "chapters": ["ch01", "ch04"] } ],',
    '  "triggerPhrases": ["phrase 1", "phrase 2"],',
    '  "scopeNote": "one short sentence on what this skill covers and does not"',
    "}",
    "Every chapter reference must be a book_number exactly as given in the chapter headers below.",
  ].join("\n");

  const toolkitBlocks = params.toolkits
    .map((c) => `### ${c.book_number} — ${c.title}\n\n${c.toolkit}`)
    .join("\n\n");

  const user = [
    `Book: ${params.bookTitle}${params.author ? ` by ${params.author}` : ""}`,
    "",
    "Spine (Pass 0 output):",
    JSON.stringify(
      {
        thesis: params.spine.thesis,
        domain: params.spine.domain,
        vocabulary: params.spine.vocabulary,
        frameworks: params.spine.frameworks,
      },
      null,
      2,
    ),
    "",
    "All chapter toolkits (Stage 1 output):",
    toolkitBlocks,
  ].join("\n");

  return { system, user };
}
