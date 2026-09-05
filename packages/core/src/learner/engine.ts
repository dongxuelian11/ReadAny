// Deterministic learner engine: one evidence event → one append-only ledger
// row + one BKT update (per-event iteration, skillcoco invariant) + one FSRS
// review → updated ConceptMastery. No LLM, no I/O beyond the injected stores,
// no hidden state: every value the Authority keeps is either in the evidence
// ledger, the mastery row, or the review card/log.

import {
  CONFIDENCE_SATURATION_OBSERVATIONS,
  DEFAULT_BKT_PARAMS,
  MASTERY_THRESHOLD,
  updateMastery,
} from "./bkt";
import type { BKTParams } from "./bkt";
import {
  createLearnerScheduler,
  newConceptCard,
  retrievabilityOf,
  reviewConceptCard,
} from "./review";
import type {
  ConceptMastery,
  EvidenceEvent,
  LearnerClock,
  LearnerEvidenceStore,
  LearnerMasteryStore,
  LearnerReviewStore,
  MasteryStatus,
} from "./types";
import { withLearnerWriteLock } from "./write-lock";

export interface LearnerEngineOptions {
  bkt?: BKTParams;
  /** Desired retention for scheduling and the NeedsReview degradation rule. */
  requestRetention?: number;
}

export interface LearnerEngineDeps extends LearnerEngineOptions {
  clock: LearnerClock;
  evidence: LearnerEvidenceStore;
  mastery: LearnerMasteryStore;
  reviews: LearnerReviewStore;
}

export type EvidenceEventInput = Omit<EvidenceEvent, "id" | "timestamp"> & { id?: string };

/**
 * Derive the display status for a concept at an instant (handoff §11: mastery
 * may degrade Stable → NeedsReview through forgetting, but history is never
 * deleted). "unseen" means the system knows nothing: no evidence AND no
 * verified estimate (placement-written rows carry lastVerified and derive
 * learning/stable from their mastery).
 */
export function deriveMasteryStatus(params: {
  evidenceCount: number;
  mastery: number | null;
  retention: number | null;
  lastVerified?: number | null;
  requestRetention?: number;
  threshold?: number;
}): MasteryStatus {
  const threshold = params.threshold ?? MASTERY_THRESHOLD;
  const requestRetention = params.requestRetention ?? 0.9;
  if (params.mastery === null) return "unseen";
  if (params.evidenceCount === 0 && (params.lastVerified ?? null) === null) return "unseen";
  if (params.mastery < threshold) return "learning";
  if (params.retention !== null && params.retention < requestRetention) return "needs_review";
  return "stable";
}

/**
 * Apply one evidence event deterministically.
 *
 * Order of operations (all fail-closed):
 *  1. Append the event to the ledger (duplicate ids rejected by the store).
 *  2. Load prior mastery (cold start = pKnow) and apply ONE BKT update using
 *     the event's question-type guess/slip.
 *  3. Load or create the concept's FSRS card and apply one review
 *     (correct→Good, incorrect→Again); persist card + log.
 *  4. Recompute confidence, retention, nextReview, and the derived status.
 */
async function applyEvidenceEventLocked(
  deps: LearnerEngineDeps,
  input: EvidenceEventInput,
): Promise<ConceptMastery> {
  const now = deps.clock.now();
  const timestamp = now.getTime();
  const event: EvidenceEvent = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    timestamp,
  };

  await deps.evidence.append(event);

  const params = deps.bkt ?? DEFAULT_BKT_PARAMS;
  const prior = await deps.mastery.get(event.conceptId);
  const priorMastery = prior?.mastery ?? params.pKnow;
  const mastery = updateMastery(
    params,
    priorMastery,
    event.result === "correct",
    event.questionType,
  );

  const scheduler = createLearnerScheduler({ requestRetention: deps.requestRetention });
  const existingCard = await deps.reviews.getCard(event.conceptId);
  const cardBefore = existingCard ?? newConceptCard(event.conceptId, now);
  const { card, log } = reviewConceptCard(scheduler, cardBefore, now, event.result === "correct");
  await deps.reviews.putCard(card);
  await deps.reviews.appendLog(log);

  const evidenceCount = await deps.evidence.countByConcept(event.conceptId);
  const retention = retrievabilityOf(scheduler, card, now);
  const masteryRow: ConceptMastery = {
    conceptId: event.conceptId,
    mastery,
    confidence: Math.min(1, evidenceCount / CONFIDENCE_SATURATION_OBSERVATIONS),
    retention,
    transfer: null,
    lastVerified: timestamp,
    nextReview: card.due,
    status: deriveMasteryStatus({
      evidenceCount,
      mastery,
      retention,
      lastVerified: timestamp,
      requestRetention: deps.requestRetention,
    }),
    evidenceCount,
    updatedAt: timestamp,
  };
  await deps.mastery.put(masteryRow);
  return masteryRow;
}

/**
 * Apply one evidence event under the learner write lock (PR-012): the
 * read-modify-write cycle above must never interleave with another learner
 * writer's cycle, or a BKT update is silently lost.
 */
export function applyEvidenceEvent(
  deps: LearnerEngineDeps,
  input: EvidenceEventInput,
): Promise<ConceptMastery> {
  return withLearnerWriteLock(() => applyEvidenceEventLocked(deps, input));
}

/**
 * Re-evaluate one concept at the current instant without new evidence — this
 * is where forgetting degrades a previously stable concept to NeedsReview.
 * Also lock-guarded: it rewrites the mastery row and must not interleave with
 * an evidence apply (a stale overwrite would resurrect an old mastery).
 */
export function evaluateConceptMastery(
  deps: LearnerEngineDeps,
  conceptId: string,
): Promise<ConceptMastery | null> {
  return withLearnerWriteLock(() => evaluateConceptMasteryLocked(deps, conceptId));
}

async function evaluateConceptMasteryLocked(
  deps: LearnerEngineDeps,
  conceptId: string,
): Promise<ConceptMastery | null> {
  const masteryRow = await deps.mastery.get(conceptId);
  if (!masteryRow) return null;
  const now = deps.clock.now();
  const scheduler = createLearnerScheduler({ requestRetention: deps.requestRetention });
  const card = await deps.reviews.getCard(conceptId);
  const retention = retrievabilityOf(scheduler, card, now);
  const status = deriveMasteryStatus({
    evidenceCount: masteryRow.evidenceCount,
    mastery: masteryRow.mastery,
    retention,
    lastVerified: masteryRow.lastVerified,
    requestRetention: deps.requestRetention,
  });
  const updated: ConceptMastery = { ...masteryRow, retention, status, updatedAt: now.getTime() };
  await deps.mastery.put(updated);
  return updated;
}
