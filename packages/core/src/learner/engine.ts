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
import { DuplicateEvidenceIdError } from "./stores";
import type {
  ConceptMastery,
  EvidenceEvent,
  EvidenceVerification,
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

export type EvidenceEventInput = Omit<EvidenceEvent, "id" | "timestamp"> & {
  id?: string;
  /** Optional pinned answer time (iter-1): a caller that stamps this (outbox
   * enqueue pins it at judgement time) keeps the original time across
   * retries/replays; the engine clock is used only when absent. */
  timestamp?: number;
};

/** Rejected by the evidence admission gate (PR-014): `LLM_OBSERVATION`
 * events are candidates only and must carry an explicit verification. */
export class EvidenceNotAdmittedError extends Error {
  constructor(conceptId: string) {
    super(`LLM_OBSERVATION evidence for ${conceptId} was not admitted through a verification gate`);
    this.name = "EvidenceNotAdmittedError";
  }
}

/** A caller re-submitted an evidence id with different content than the row
 * already in the ledger. A replay of the SAME attempt must resume; a
 * different attempt reusing the same id is a caller bug, never silently
 * merged into the recorded event. */
export class EvidenceConflictError extends Error {
  constructor(id: string) {
    super(`Evidence event id ${id} already exists with different content`);
    this.name = "EvidenceConflictError";
  }
}

/**
 * Admission authority (PR-014, graded trust): how much of a BKT update an
 * evidence event carries, as the probability the evidence is genuine.
 * `user_confirmed` = the learner vouched for the result; `deterministic_keyed`
 * = graded by code against a key (the key itself may be LLM-authored — medium
 * trust); `llm_judged` = an LLM graded free-form output (low trust);
 * `placement_inferred` = CAT estimate rather than practice. Absent
 * verification = legacy unclassified evidence at full weight (transitional;
 * all current producers now stamp a verification).
 */
export const ADMISSION_WEIGHTS: Record<EvidenceVerification, number> = {
  user_confirmed: 1,
  deterministic_keyed: 0.6,
  llm_judged: 0.4,
  placement_inferred: 0.5,
};

export function admissionWeight(
  event: Pick<EvidenceEvent, "conceptId" | "source" | "verification">,
): number {
  if (event.source === "LLM_OBSERVATION" && !event.verification) {
    throw new EvidenceNotAdmittedError(event.conceptId);
  }
  if (!event.verification) return 1;
  return ADMISSION_WEIGHTS[event.verification];
}

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
 * Apply one evidence event deterministically — and RESUMABLY (iter-1).
 *
 * The apply used to be a bare sequence of store writes; a crash after the
 * ledger append left mastery/card/log stale, and the outbox then read the
 * duplicate id as "already applied". There is no cross-statement transaction
 * on the platform adapters, so each step carries its own idempotency marker
 * instead: the review card and the mastery row remember the id of the last
 * event they already reflect, and the review log is keyed by event id. Every
 * step is a single atomic statement, and re-running the sequence after any
 * crash continues from the first unapplied step — never double-applying BKT
 * or FSRS, and never losing an event.
 *
 * Order of operations (all fail-closed):
 *  1. Admission gate — an unadmitted candidate leaves no ledger row behind.
 *  2. Append the event to the ledger (duplicate id: resume if the stored row
 *     matches, else `EvidenceConflictError`) — the conflict check runs BEFORE
 *     any marker short-circuit, so a conflicting re-submission is never
 *     masked by an already-applied state.
 *  3. FSRS review guarded by the card's marker; the review log is written
 *     (idempotently per event id) BEFORE the card marker, so a crash between
 *     the two writes replays deterministically: the log is deduped and the
 *     card write completes.
 *  4. BKT/mastery guarded by the row marker — the commit point written last;
 *     its presence implies everything before it is done.
 *
 * The event's own timestamp drives every computation, so a replay produces
 * byte-identical card/log/mastery outcomes — the original answer time is
 * preserved instead of silently moving to the retry instant.
 */
export interface EvidenceApplyResult {
  mastery: ConceptMastery;
  /** True when the event was already fully applied before this call. */
  alreadyApplied: boolean;
}

async function applyEvidenceEventLocked(
  deps: LearnerEngineDeps,
  input: EvidenceEventInput,
): Promise<EvidenceApplyResult> {
  const now = deps.clock.now();
  const event: EvidenceEvent = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    // A pinned/replayed event keeps its original answer time (iter-1); only a
    // caller that never stamped one gets the current instant.
    timestamp: input.timestamp ?? now.getTime(),
  };
  const weight = admissionWeight(event);
  const reviewInstant = new Date(event.timestamp);

  // Step: ledger append, idempotent by primary key. A duplicate id for the
  // SAME concept+result is a resume of a partially applied attempt; a
  // duplicate id with different content is a caller bug, never a replay.
  try {
    await deps.evidence.append(event);
  } catch (error) {
    if (!(error instanceof DuplicateEvidenceIdError)) throw error;
    const stored = await deps.evidence.getById(event.id);
    if (!stored || stored.conceptId !== event.conceptId || stored.result !== event.result) {
      throw new EvidenceConflictError(event.id);
    }
  }

  // Step: FSRS review, guarded by the card's applied-event marker. The log
  // write lands before the card marker and is idempotent per event id, so a
  // crash anywhere between the two writes repairs on the next apply without
  // double-applying FSRS (the recomputation is deterministic from the card).
  const scheduler = createLearnerScheduler({ requestRetention: deps.requestRetention });
  const existingCard = await deps.reviews.getCard(event.conceptId);
  const cardBefore = existingCard ?? newConceptCard(event.conceptId, reviewInstant);
  let currentCard = cardBefore;
  if (cardBefore.lastEventId !== event.id) {
    const { card, log } = reviewConceptCard(
      scheduler,
      cardBefore,
      reviewInstant,
      event.result === "correct",
    );
    currentCard = card;
    await deps.reviews.appendLog({ ...log, eventId: event.id });
    await deps.reviews.putCard({ ...card, lastEventId: event.id });
  }

  // Step: BKT + mastery, guarded by the row marker (the commit point).
  const prior = await deps.mastery.get(event.conceptId);
  if (prior?.lastEventId !== event.id) {
    const params = deps.bkt ?? DEFAULT_BKT_PARAMS;
    const priorMastery = prior?.mastery ?? params.pKnow;
    const admitted = updateMastery(
      params,
      priorMastery,
      event.result === "correct",
      event.questionType,
    );
    // Graded-trust mixture (PR-014): the admission weight λ is the probability
    // the evidence is genuine, so the posterior is λ·BKT(prior) + (1−λ)·prior.
    // λ=1 (verified or legacy) reproduces the ported math exactly.
    const mastery = weight * admitted + (1 - weight) * priorMastery;

    const evidenceCount = await deps.evidence.countByConcept(event.conceptId);
    const retention = retrievabilityOf(scheduler, currentCard, reviewInstant);
    const masteryRow: ConceptMastery = {
      conceptId: event.conceptId,
      mastery,
      confidence: Math.min(1, evidenceCount / CONFIDENCE_SATURATION_OBSERVATIONS),
      retention,
      transfer: null,
      lastVerified: event.timestamp,
      nextReview: currentCard.due,
      status: deriveMasteryStatus({
        evidenceCount,
        mastery,
        retention,
        lastVerified: event.timestamp,
        requestRetention: deps.requestRetention,
      }),
      evidenceCount,
      updatedAt: event.timestamp,
      lastEventId: event.id,
    };
    await deps.mastery.put(masteryRow);
    return { mastery: masteryRow, alreadyApplied: false };
  }

  // The mastery marker matched: everything before it (ledger, log, card) is
  // done — this call was a pure replay of a fully applied event.
  return { mastery: prior, alreadyApplied: true };
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
  return applyEvidenceEventResult(deps, input).then((result) => result.mastery);
}

/** Same as applyEvidenceEvent, but reports whether this call actually applied
 * the event or found it already fully applied (outbox drain reporting). */
export function applyEvidenceEventResult(
  deps: LearnerEngineDeps,
  input: EvidenceEventInput,
): Promise<EvidenceApplyResult> {
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
