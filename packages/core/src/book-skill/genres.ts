// Genre profiles ported from upstream book-to-skill reference/genre-profiles.md
// (MIT). Each profile drives the chapter-template emphasis (Stage 1 MAP) and
// the concept-map emphasis (Stage 2 REDUCE), exactly as upstream defines them.

import type { BookSkillGenre } from "./types";

export interface BookSkillGenreProfile {
  /** The atomic piece of knowledge the map step extracts. */
  unit: string;
  /** How the book chunks for the map step (we keep ReadAny chapters). */
  boundary: string;
  /** Which chapter-template sections carry the weight. */
  mapEmphasis: string;
  /** What the Stage 2 concept map must foreground. */
  reduceEmphasis: string;
}

export const BOOK_SKILL_GENRES: BookSkillGenre[] = [
  "technical",
  "vuln-hunting",
  "financial",
  "scientific",
  "legal",
  "textbook",
  "reference",
  "business",
  "psychology",
  "history",
  "productivity",
  "biography",
  "narrative",
  "general",
];

export const BOOK_SKILL_GENRE_PROFILES: Record<BookSkillGenre, BookSkillGenreProfile> = {
  technical: {
    unit: "a pattern, technique, API, or design decision — each with preconditions, mechanics, and trade-offs",
    boundary: "by chapter",
    mapEmphasis:
      "Frameworks, Code Examples, Reference Tables, Anti-patterns. Preserve exact syntax and exact API names.",
    reduceEmphasis:
      "a dependency graph — which concepts build on which, and which trade-offs recur across chapters",
  },
  "vuln-hunting": {
    unit: "a vulnerability class or technique — precondition → method → detection signal → variants → mitigation",
    boundary:
      "by chapter, but the same bug class may recur — reduce must merge recurrences into one node",
    mapEmphasis:
      "Frameworks (techniques), Anti-patterns (what wastes a hunter's time), Code Examples (payloads/PoC — preserve exactly), Key Takeaways as detection signals",
    reduceEmphasis:
      "a technique catalogue cross-referenced by target surface and by primitive — the highest-value reduce output of any genre",
  },
  financial: {
    unit: "a model, formula, ratio, or decision rule — with its assumptions and the conditions under which it fails",
    boundary: "by chapter",
    mapEmphasis:
      "Frameworks (models), Reference Tables, Key Concepts (define terms precisely — the same word can mean different things), Anti-patterns (when a model misleads)",
    reduceEmphasis:
      "a decision map — which model applies to which situation. Do NOT over-merge: two chapters using the same term may mean subtly different things; keep them distinct nodes",
  },
  scientific: {
    unit: "a concept, mechanism, method, or result — with its evidence basis",
    boundary: "by chapter",
    mapEmphasis: "Key Concepts, Frameworks (methods/mechanisms), Reference Tables, Connects To",
    reduceEmphasis:
      "a concept map proper — nodes and typed edges (causes, requires, contradicts, is-a)",
  },
  legal: {
    unit: "a rule — with its exceptions, jurisdictional scope, citations, and the elements that must be proved",
    boundary: "by rule, not chapter — isolate one rule per chunk where possible",
    mapEmphasis:
      "Frameworks (the rule's elements/tests), Key Concepts (preserve legal definitions verbatim), Anti-patterns (common misapplications), Connects To, Reference Tables",
    reduceEmphasis:
      "a rule index with cross-references — precise wording preserved, exceptions enumerated. Never paraphrase legal definitions; over-merging similar-named doctrines is dangerous",
  },
  textbook: {
    unit: "a concept + worked example + exercise",
    boundary: "by chapter (ReadAny units); note section-level prerequisites inside the chapter",
    mapEmphasis:
      "Core Idea, Frameworks (the formalism/algorithm/theorem), Code Examples or Reference Tables (the worked example — preserve exactly), Key Takeaways, Connects To (explicit prerequisites)",
    reduceEmphasis:
      "a learning DAG — nodes are concepts, edges are prerequisites; capture the path a learner must take",
  },
  reference: {
    unit: "one self-contained recipe / pattern / API entry — inputs, steps, outputs, failure modes, when to use",
    boundary: "by chapter (ReadAny units); treat the chapter as the category tag",
    mapEmphasis:
      "Frameworks (the recipe itself, with explicit when-to-use), Code Examples (preserve exactly), Reference Tables, Anti-patterns (common failure modes)",
    reduceEmphasis:
      "a tagged index, not a dense concept map — group entries by target situation; the topic index is the load-bearing artifact",
  },
  business: {
    unit: "an organisational decision rule or operating principle — who it applies to, the signal that invokes it, the outcome it shapes",
    boundary: "by chapter, but the chunk is the principle, not the anecdote wrapped around it",
    mapEmphasis:
      "Frameworks (the named rule/matrix/model — preserve exact names), Mental Models, Anti-patterns, Reference Tables (decision matrices)",
    reduceEmphasis:
      "a decision map — for each common org-level situation, which frameworks the book recommends. Strip motivational filler aggressively",
  },
  psychology: {
    unit: "a named effect or bias — with its conditions, the experiment that established it, and where it shows up",
    boundary:
      "by chapter, with recurrence handling — the same bias appears across chapters and must merge at reduce time",
    mapEmphasis:
      "Key Concepts (the named effect, exact formulation), Frameworks (the experimental paradigm), Mental Models (how to spot it), Anti-patterns, Connects To",
    reduceEmphasis: "a catalogue of effects cross-referenced by the domain where they bite",
  },
  history: {
    unit: "an event with dated causes, actors, and consequences",
    boundary: "by chapter where chapters map to eras; otherwise note the era arc",
    mapEmphasis:
      "Core Idea, Key Concepts (preserve exact proper nouns, dates, place names), Mental Models, Connects To (cause/effect), Reference Tables (timelines)",
    reduceEmphasis:
      "a timeline + causal graph — events as nodes with typed edges (caused-by, responded-to, prefigured, concluded). Don't merge similar events from different eras",
  },
  productivity: {
    unit: "a framework or principle — usually one core idea elaborated across the book",
    boundary:
      "by chapter (ReadAny units); near-duplicate fragments of one framework should merge at reduce time",
    mapEmphasis:
      "Frameworks, Mental Models, Key Takeaways. Code Examples / Reference Tables are usually absent — omit when truly absent",
    reduceEmphasis:
      "a single clean statement of the core framework and how the sub-ideas hang off it. Strip motivational filler",
  },
  biography: {
    unit: "a turning-point decision, pivot, or formative experience — what was decided, what was at stake, what changed",
    boundary:
      "by chapter (ReadAny units); prefer the life-period arc when several chapters form one period",
    mapEmphasis:
      "Core Idea (the period's stakes), Mental Models (how decisions were made), Key Takeaways, Connects To",
    reduceEmphasis:
      "a timeline + decision catalogue — eras on one axis, load-bearing decisions on the other",
  },
  narrative: {
    unit: "an argument or a transferable lesson drawn from a case",
    boundary: "by chapter (ReadAny units); arguments that span chapters merge at reduce time",
    mapEmphasis:
      "Core Idea, Mental Models, Key Takeaways, Connects To. Capture the lesson, not the anecdote",
    reduceEmphasis: "the book's central thesis and the chain of arguments supporting it",
  },
  general: {
    unit: "whatever carries the chapter's load-bearing content",
    boundary: "by chapter",
    mapEmphasis: "keep whichever template sections have real content; drop the rest",
    reduceEmphasis: "a balanced concept map — nodes and typed edges across chapters",
  },
};
