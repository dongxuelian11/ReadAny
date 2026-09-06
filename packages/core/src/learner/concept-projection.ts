// Concept-state projection (PR-026) — the learner keeps chapter-scoped
// practice records (evidence and mastery keyed by source-unit ids); this read
// model projects a canonical concept's CURRENT state from its participating
// chapters through the PR-013 read model. Strictly read-only: a projection is
// a view, never a write.

import type { ConceptIdentityStore } from "./concept-identity";
import { type LearnerReadDeps, type LearnerReadOptions, getLearnerStateAt } from "./read-model";
import type { ConceptMastery, MasteryStatus } from "./types";

/** Forgetting anywhere in the concept counts more than stability anywhere. */
const STATUS_SEVERITY: Record<MasteryStatus, number> = {
  unseen: 0,
  stable: 1,
  learning: 2,
  needs_review: 3,
};

export interface ProjectedConceptState {
  conceptId: string;
  /** Evidence-weighted mean of the participating chapters' current mastery;
   * null when no participating chapter has any state. */
  mastery: number | null;
  /** The WORST current status across participating chapters — forgetting in
   * any one chapter means the concept needs review. */
  status: MasteryStatus | null;
  /** Sum of the participating chapters' evidence counts. */
  evidenceCount: number;
  chapters: Array<{ sourceUnitId: string; state: ConceptMastery | null }>;
}

export async function projectConceptState(
  deps: LearnerReadDeps & { identity: ConceptIdentityStore },
  conceptId: string,
  options?: LearnerReadOptions,
): Promise<ProjectedConceptState | null> {
  const units = await deps.identity.listSourceUnitsForConcept(conceptId);
  if (units.length === 0) return null;
  const states = await getLearnerStateAt(deps, units, options);
  const chapters = states.map((entry) => ({
    sourceUnitId: entry.conceptId,
    state: entry.state,
  }));

  const known = chapters.filter(
    (chapter): chapter is { sourceUnitId: string; state: ConceptMastery } =>
      chapter.state !== null && chapter.state.mastery !== null,
  );
  if (known.length === 0) {
    return { conceptId, mastery: null, status: null, evidenceCount: 0, chapters };
  }

  let weightedSum = 0;
  let weight = 0;
  for (const chapter of known) {
    // Placement-written rows carry an estimate with zero practice evidence —
    // they still vote, with the smallest honest weight.
    const weight_unit = Math.max(1, chapter.state.evidenceCount);
    weightedSum += chapter.state.mastery * weight_unit;
    weight += weight_unit;
  }
  const status = known.reduce<MasteryStatus | null>(
    (worst, chapter) =>
      chapter.state.status !== null &&
      (worst === null || STATUS_SEVERITY[chapter.state.status] > STATUS_SEVERITY[worst])
        ? chapter.state.status
        : worst,
    null,
  );
  const evidenceCount = known.reduce((sum, chapter) => sum + chapter.state.evidenceCount, 0);
  return { conceptId, mastery: weightedSum / weight, status, evidenceCount, chapters };
}
