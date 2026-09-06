// Concept graph V2 (PR-024) — folds the Book Skill Tier-1 data that already
// exists on disk (topic-index terms, concept-map framework nodes, and their
// edges) into the shared concept registry. ZERO LLM calls: the Tier-1 was
// generated once per book; this builder is deterministic and idempotent.
//
// Merge semantics (v2.0, deterministic): two names denote the SAME concept
// when their normalized text is identical (trim + lowercase + collapsed
// whitespace). Cross-language and semantic merging is explicitly deferred.
//
// Learner state is untouched: evidence and mastery stay chapter-scoped
// practice records keyed by their source-unit ids. This layer is identity +
// navigation + relations only — a later decision may project learner state
// onto canonical concepts, but nothing here reads or writes it.

import { type ConceptIdentityStore, sourceUnitId } from "../learner/concept-identity";
import type { MasteryStatus } from "../learner/types";
import type { BookSkillTier1 } from "./types";

export interface ConceptGraphSkillInput {
  bookId: string;
  tier1: BookSkillTier1;
  /** book_number → canonical ReadAny chapter index (manifest.readany.chapters). */
  readanyChapters: Array<{ book_number: string; chapterIndex: number }>;
}

export interface ConceptGraphSummary {
  /** Distinct topic concepts registered during THIS run (per input terms). */
  topicConcepts: number;
  frameworkConcepts: number;
  sourceUnitBindings: number;
  relations: number;
  warnings: string[];
}

export interface CrossBookConcept {
  conceptId: string;
  displayName: string;
  /** Distinct book ids whose chapters this concept covers. */
  books: string[];
}

/** A cross-book concept enriched with its CURRENT projected learner state
 * (PR-026): the evidence-weighted mastery and worst status across the
 * participating chapters, computed by the caller through the read model. */
export interface ProjectedCrossBookConcept extends CrossBookConcept {
  projectedMastery: number | null;
  projectedStatus: MasteryStatus | null;
}

/** Normalize a concept name for the deterministic text merge: trim, lowercase,
 * collapse inner whitespace. */
export function normalizeConceptName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function hashName(normalized: string): string {
  // Stable cross-platform content hash (djb2) — ids must be reproducible, so
  // no platform crypto API.
  let hash = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash * 33) ^ normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A topic-index term's canonical concept id. Same normalized term across
 * books → the same id (the cross-book merge). */
export function topicConceptId(term: string): string {
  return `readany:concept:t:${hashName(normalizeConceptName(term))}`;
}

/** A concept-map framework node's canonical concept id. Frameworks and topic
 * terms are different granularities — separate prefixes, never conflated. */
export function frameworkConceptId(name: string): string {
  return `readany:concept:f:${hashName(normalizeConceptName(name))}`;
}

/** Edge relations that mean "you should understand `from` before `to`". */
const PREREQUISITE_RELATIONS = new Set(["builds on", "requires"]);

/** Language-variant aliases derived from a bilingual topic term: the latin
 * runs and the CJK runs, lowercased. 「费用 fees」 also answers to 「费用」 and
 * "fees" — how the deterministic merge bridges languages without a model. */
export function derivedAliases(term: string): string[] {
  const variants = new Set<string>();
  for (const run of term.match(/[a-z0-9][a-z0-9'-]+/gi) ?? []) {
    variants.add(run.toLowerCase());
  }
  for (const run of term.match(/[\u4e00-\u9fff]+/g) ?? []) {
    variants.add(run);
  }
  return [...variants].filter((variant) => variant !== normalizeConceptName(term));
}

export async function buildConceptGraph(
  skills: ConceptGraphSkillInput[],
  store: ConceptIdentityStore,
  now: number,
): Promise<ConceptGraphSummary> {
  const summary: ConceptGraphSummary = {
    topicConcepts: 0,
    frameworkConcepts: 0,
    sourceUnitBindings: 0,
    relations: 0,
    warnings: [],
  };

  for (const skill of skills) {
    const chapterIndexByNumber = new Map(
      skill.readanyChapters.map((chapter) => [chapter.book_number, chapter.chapterIndex]),
    );

    // Topic concepts: one per topic-index term, bound to every chapter the
    // term's index line points at (N:M participation). PR-026: the concept id
    // prefers an EXISTING alias hit (normalized text or a derived
    // language-variant), so 「费用 fees」 / 「费用」 / "fees" across books fold
    // into one concept without a model.
    for (const entry of skill.tier1.topicIndex) {
      const term = entry.term.trim();
      if (!term) continue;
      const normalized = normalizeConceptName(term);
      const conceptId =
        (await store.resolveByAlias(normalized)) ??
        (await store.resolveByAlias(term)) ??
        topicConceptId(term);
      await store.registerConcept({ conceptId, displayName: term, createdAt: now });
      summary.topicConcepts += 1;
      await store.bindAlias(term, conceptId);
      await store.bindAlias(normalized, conceptId);
      for (const variant of derivedAliases(term)) {
        await store.bindAlias(variant, conceptId);
      }
      for (const bookNumber of entry.chapters) {
        const chapterIndex = chapterIndexByNumber.get(bookNumber);
        if (chapterIndex === undefined) {
          summary.warnings.push(
            `Topic "${term}" points at unknown book_number "${bookNumber}" in ${skill.bookId}`,
          );
          continue;
        }
        await store.bindConceptSourceUnit(conceptId, sourceUnitId(skill.bookId, chapterIndex));
        summary.sourceUnitBindings += 1;
      }
    }

    // Framework concepts: the concept-map nodes; edges resolve between the
    // framework concepts of the SAME book (names are book-scoped in Tier-1).
    const frameworkIdByName = new Map<string, string>();
    for (const node of skill.tier1.nodes) {
      const name = node.name.trim();
      if (!name) continue;
      const conceptId = frameworkConceptId(name);
      frameworkIdByName.set(node.name, conceptId);
      await store.registerConcept({ conceptId, displayName: name, createdAt: now });
      summary.frameworkConcepts += 1;
    }

    for (const edge of skill.tier1.edges) {
      const from = frameworkIdByName.get(edge.from);
      const to = frameworkIdByName.get(edge.to);
      if (!from || !to) {
        summary.warnings.push(`Dropped edge with unregistered endpoint: ${edge.from} → ${edge.to}`);
        continue;
      }
      const relation = PREREQUISITE_RELATIONS.has(edge.relation) ? "prerequisite" : "related";
      await store.bindRelation({ conceptId: from, relatedConceptId: to, relation }, now);
      summary.relations += 1;
    }
  }

  return summary;
}

/** Concepts whose participating chapters span two or more of the given books
 * — the cross-book reuse the registry exists for. Newest registration wins
 * the display name; the list is sorted by coverage then name. */
export async function crossBookConcepts(
  skills: ConceptGraphSkillInput[],
  store: ConceptIdentityStore,
): Promise<CrossBookConcept[]> {
  const booksByConcept = new Map<string, Set<string>>();
  for (const skill of skills) {
    for (const chapter of skill.readanyChapters) {
      const unit = sourceUnitId(skill.bookId, chapter.chapterIndex);
      for (const conceptId of await store.listConceptsForSourceUnit(unit)) {
        let books = booksByConcept.get(conceptId);
        if (!books) {
          books = new Set();
          booksByConcept.set(conceptId, books);
        }
        books.add(skill.bookId);
      }
    }
  }
  const nameById = new Map(
    (await store.listConcepts()).map((concept) => [concept.conceptId, concept.displayName]),
  );
  return [...booksByConcept.entries()]
    .filter(([, books]) => books.size >= 2)
    .map(([conceptId, books]) => ({
      conceptId,
      displayName: nameById.get(conceptId) ?? conceptId,
      books: [...books].sort(),
    }))
    .sort((a, b) => b.books.length - a.books.length || a.displayName.localeCompare(b.displayName));
}
