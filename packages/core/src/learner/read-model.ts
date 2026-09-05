// Current-instant learner read model (PR-013 — review item #4). Every
// Goal/Curriculum/Agent decision and every panel display must read the learner
// state AS OF NOW: the persisted BKT projection joined with FSRS retrievability
// recomputed at the read instant. The persisted `status`/`retention` columns
// are write-time snapshots and go stale the moment a concept stops being
// practiced — a concept whose retrievability decayed below the request-
// retention must surface as needs_review even if no new evidence has been
// written since. Strictly read-only: unlike evaluateConceptMastery (the
// write-path recompute), reads never rewrite the projection.

import { deriveMasteryStatus } from "./engine";
import { createLearnerScheduler, retrievabilityOf } from "./review";
import type { LearnerClock, LearnerMasteryStore, LearnerReviewStore } from "./types";
import type { ConceptMastery, LearnerReviewCardData } from "./types";

export interface LearnerReadDeps {
  clock: LearnerClock;
  mastery: LearnerMasteryStore;
  reviews: LearnerReviewStore;
}

export interface LearnerReadOptions {
  /** Desired retention for the NeedsReview degradation rule (engine default). */
  requestRetention?: number;
}

/** Current-instant state for one concept: the persisted BKT row with FSRS
 * retrievability and the derived status recomputed at `now`. Pure — no store
 * writes. */
export function currentConceptMastery(params: {
  row: ConceptMastery;
  card: LearnerReviewCardData | null;
  now: number;
  requestRetention?: number;
}): ConceptMastery {
  const scheduler = createLearnerScheduler({ requestRetention: params.requestRetention });
  const retention = retrievabilityOf(scheduler, params.card, new Date(params.now));
  const status = deriveMasteryStatus({
    evidenceCount: params.row.evidenceCount,
    mastery: params.row.mastery,
    retention,
    lastVerified: params.row.lastVerified,
    requestRetention: params.requestRetention,
  });
  return { ...params.row, retention, status };
}

/** Current-instant learner state for an explicit concept list (order
 * preserved; null state for concepts the learner state knows nothing about).
 * This is the ONE sanctioned way to read learner state for decisions and
 * display — direct persisted-row reads are stale by construction. */
export async function getLearnerStateAt(
  deps: LearnerReadDeps,
  conceptIds: string[],
  options?: LearnerReadOptions,
): Promise<Array<{ conceptId: string; state: ConceptMastery | null }>> {
  const now = deps.clock.now().getTime();
  const results: Array<{ conceptId: string; state: ConceptMastery | null }> = [];
  for (const conceptId of conceptIds) {
    const row = await deps.mastery.get(conceptId);
    if (!row) {
      results.push({ conceptId, state: null });
      continue;
    }
    const card = await deps.reviews.getCard(conceptId);
    results.push({
      conceptId,
      state: currentConceptMastery({ row, card, now, requestRetention: options?.requestRetention }),
    });
  }
  return results;
}
