// Read-side queries over the learner stores: due review surfacing. Pure
// aggregation over the store interfaces — no SQL of its own. Status is
// computed through the current-instant read model (PR-013): a due card whose
// retrievability has decayed must surface as needs_review even when the
// persisted mastery row still says stable.

import type { PlacementEngineDeps } from "./placement-engine";
import { currentConceptMastery } from "./read-model";
import type { ConceptMastery, LearnerReviewCardData } from "./types";

export interface DueReviewConcept {
  card: LearnerReviewCardData;
  mastery: ConceptMastery | null;
  status: ConceptMastery["status"] | null;
}

/** Concepts whose FSRS review card is due at or before `timestamp`, ordered by
 * due time; mastery/status joined from the mastery store and recomputed at
 * `timestamp` (null when the concept was never assessed). */
export async function listDueReviewConcepts(
  deps: PlacementEngineDeps,
  timestamp: number,
  limit?: number,
): Promise<DueReviewConcept[]> {
  const cards = await deps.reviews.listCardsDueBefore(timestamp, limit);
  const due: DueReviewConcept[] = [];
  for (const card of cards) {
    const row = await deps.mastery.get(card.conceptId);
    const state = row ? currentConceptMastery({ row, card, now: timestamp }) : null;
    due.push({ card, mastery: state, status: state?.status ?? null });
  }
  return due;
}

/** Mastery rows for an explicit concept list (order preserved; null for
 * concepts the learner state knows nothing about). */
export async function getMasteryForConcepts(
  deps: PlacementEngineDeps,
  conceptIds: string[],
): Promise<Array<{ conceptId: string; mastery: ConceptMastery | null }>> {
  const rows: Array<{ conceptId: string; mastery: ConceptMastery | null }> = [];
  for (const conceptId of conceptIds) {
    rows.push({ conceptId, mastery: await deps.mastery.get(conceptId) });
  }
  return rows;
}
