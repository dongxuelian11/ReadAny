// Prerequisite-edge collection (iter-3, review item F): mine the concept
// registry for EXPLICIT prerequisite relations and project them onto the
// goal's chapters through the topic/framework → chapter participation
// bindings. Deliberately narrow: co-occurrence is NOT a prerequisite (the
// PR-026 mistake this replaces) — an edge exists only when the registry holds
// an explicit "prerequisite" relation, and only between chapters of THIS
// goal. Cycle handling and the book-order fallback stay in
// orderStepsByPrerequisites.

import { parseChapterSourceUnit } from "./concept-identity";
import type { ConceptRelation } from "./concept-identity";

/** The slice of the ConceptIdentityStore the edge collector needs; hosts pass
 * the store, tests pass a stub. */
export interface CurriculumPrerequisiteAdapter {
  listConceptsForSourceUnit(sourceUnitId: string): Promise<string[]>;
  listSourceUnitsForConcept(conceptId: string): Promise<string[]>;
  listRelated(conceptId: string): Promise<ConceptRelation[]>;
}

export interface PrerequisiteEdge {
  before: number;
  after: number;
}

/** Collect chapter-ordering edges for one goal's chapters.
 *
 * Direction contract (mirrors concept-graph's PREREQUISITE_RELATIONS):
 * `conceptId --prerequisite--> relatedConceptId` means "understand conceptId
 * BEFORE relatedConceptId". A chapter hosting the prerequisite concept is
 * therefore `before`, a goal chapter hosting the related concept is `after`.
 * Edges are deduped; relations whose related concept has no chapter-shaped
 * participation, or whose chapters fall outside this goal, are ignored. */
export async function collectPrerequisiteEdges(
  identity: CurriculumPrerequisiteAdapter,
  chapterUnits: string[],
): Promise<PrerequisiteEdge[]> {
  const indexByUnit = new Map<string, number>();
  for (const unit of chapterUnits) {
    const parsed = parseChapterSourceUnit(unit);
    if (parsed) indexByUnit.set(unit, parsed.chapterIndex);
  }
  const inGoal = new Set(indexByUnit.values());
  const edges = new Map<string, PrerequisiteEdge>();
  for (const [unit, before] of indexByUnit) {
    for (const conceptId of await identity.listConceptsForSourceUnit(unit)) {
      for (const relation of await identity.listRelated(conceptId)) {
        if (relation.relation !== "prerequisite") continue;
        for (const targetUnit of await identity.listSourceUnitsForConcept(
          relation.relatedConceptId,
        )) {
          const parsed = parseChapterSourceUnit(targetUnit);
          if (!parsed) continue;
          const after = parsed.chapterIndex;
          if (after === before || !inGoal.has(after)) continue;
          edges.set(`${before}->${after}`, { before, after });
        }
      }
    }
  }
  return [...edges.values()];
}
