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
  type LearnerAtomicCommit,
  type LearnerAtomicCommitRequest,
  type LearnerEvidenceCompletionStore,
  SessionStaleError,
  evidencePayloadJson,
  sameImmutablePayload,
} from "./commit";
export { SessionStaleError } from "./commit";
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
  LearnerReviewLogEntry,
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
  /** Durable per-attempt completion records (WP-A): once present, a replayed
   * event id never re-enters the update branches — even after unrelated events
   * were applied in between (the historical A→B→A replay). */
  completions?: LearnerEvidenceCompletionStore;
  /** Atomic commit adapter (WP-A): when present, the derived FSRS/BKT writes
   * plus the completion record land in ONE storage transaction with
   * compare-and-swap markers. Hosts without one fall back to the stepwise
   * resumable path below. */
  atomic?: LearnerAtomicCommit;
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

/** Options for applyEvidenceEventResult beyond the event itself. */
export interface EvidenceApplyOptions {
  /** Teaching-session advance that must commit (or be refused) atomically
   * with the evidence (WP-A). Only honored on the atomic path. */
  session?: LearnerAtomicCommitRequest["session"];
}

async function applyEvidenceEventLocked(
  deps: LearnerEngineDeps,
  input: EvidenceEventInput,
  options?: EvidenceApplyOptions,
): Promise<EvidenceApplyResult> {
  const now = deps.clock.now();
  const event: EvidenceEvent = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    // A pinned/replayed event keeps its original answer time (iter-1); only a
    // caller that never stamped one gets the current instant.
    timestamp: input.timestamp ?? now.getTime(),
  };
  const payloadJson = evidencePayloadJson(event);

  // Completion-record gate (WP-A, F01): a replayed attempt that was fully
  // applied is a no-op no matter how many events landed in between — the
  // historical A→B→A case the per-row lastEventId markers cannot cover. A
  // replay whose immutable payload differs from the recorded one is a caller
  // bug, never a silent merge.
  const completed = await deps.completions?.get(event.id);
  if (completed) {
    if (completed.payloadJson !== payloadJson) {
      // PR32-followup (F04): completions recorded by the pre-fix engine carry a
      // fingerprint whose nested sourceLocator collapsed to `{}`
      // (JSON.stringify replacer arrays filter at every depth). A replay of the
      // SAME attempt must verify against the durable event row and UPGRADE the
      // fingerprint instead of raising a spurious conflict; a genuinely
      // different payload still conflicts.
      const stored = await deps.evidence.getById(event.id);
      if (!stored || !sameImmutablePayload(stored, event)) {
        throw new EvidenceConflictError(event.id);
      }
      await deps.completions?.record(event.id, payloadJson);
      const mastery = await deps.mastery.get(event.conceptId);
      if (mastery) return { mastery, alreadyApplied: true };
      // Pathological: completion without a mastery row — fall through to the
      // idempotent repair below instead of inventing a row.
    } else {
      const mastery = await deps.mastery.get(event.conceptId);
      if (mastery) return { mastery, alreadyApplied: true };
      // Pathological: completion without a mastery row — fall through to the
      // idempotent repair below instead of inventing a row.
    }
  }

  // Duplicate gate: an existing ledger row for this id is either a resume of
  // the SAME attempt (adopt the stored answer time for every downstream
  // computation, F02) or a genuine id collision (conflict).
  const storedEvent = await deps.evidence.getById(event.id);
  if (storedEvent) {
    if (!sameImmutablePayload(storedEvent, event)) throw new EvidenceConflictError(event.id);
    event.timestamp = storedEvent.timestamp;

    // PR33 A-line (L01) upgrade boundary for PRE-completion legacy rows — the
    // stored event exists but no completion record was ever written. Three
    // provable states, handled without inventing an event platform:
    //
    // 1. Card AND mastery markers still equal this event id: the event was
    //    fully applied. Backfill the completion so no later marker-changing
    //    event can ever let this replay re-enter the update branches.
    // 2. The markers were already moved by a LATER event and a durable review
    //    log exists for THIS event: the event at least reached its FSRS step,
    //    but whether its BKT step ran can no longer be proven from live state.
    //    Re-applying would double-count (the documented regression) — fail
    //    SAFE: report already-applied, mutate nothing, backfill nothing (the
    //    row stays flagged for review by staying completion-less).
    // 3. Otherwise this is a genuine partial apply (log may exist, but the
    //    markers were never advanced past their default) — fall through to the
    //    resumable paths below, which repair the missing steps exactly once.
    const priorCard = await deps.reviews.getCard(event.conceptId);
    const priorMastery = await deps.mastery.get(event.conceptId);
    if (priorCard?.lastEventId === event.id && priorMastery?.lastEventId === event.id) {
      await deps.completions?.record(event.id, payloadJson);
      return { mastery: priorMastery, alreadyApplied: true };
    }
    // The mastery row is the commit point: if a LATER event already advanced
    // it, this replay can no longer prove whether the legacy event's own BKT
    // step ran. With a durable log for this event, fail safe.
    const markersSuperseded =
      priorMastery != null && priorMastery.lastEventId != null && priorMastery.lastEventId !== event.id;
    if (markersSuperseded && (await deps.reviews.hasLogForEvent?.(event.id)) === true) {
      return { mastery: priorMastery, alreadyApplied: true };
    }
  }
  // Computed only AFTER the (possibly adopted) timestamp is final.
  const reviewInstant = new Date(event.timestamp);
  const weight = admissionWeight(event);

  // Atomic path (WP-A): ledger row, review log, card, mastery, the completion
  // record and — when answering a teaching step — the guarded session advance
  // land in ONE storage transaction. The adapter owns the evidence INSERT and
  // the compare-and-swap checks; a stale CAS recomputes against the current
  // state (bounded), so nothing is ever blindly overwritten.
  if (deps.atomic) {
    const MAX_ATOMIC_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATOMIC_ATTEMPTS; attempt += 1) {
      const scheduler = createLearnerScheduler({ requestRetention: deps.requestRetention });
      const existingCard = await deps.reviews.getCard(event.conceptId);
      const cardBefore = existingCard ?? newConceptCard(event.conceptId, reviewInstant);
      let currentCard = cardBefore;
      let log: LearnerReviewLogEntry | null = null;
      if (cardBefore.lastEventId !== event.id) {
        const reviewed = reviewConceptCard(
          scheduler,
          cardBefore,
          reviewInstant,
          event.result === "correct",
        );
        currentCard = reviewed.card;
        log = { ...reviewed.log, eventId: event.id };
      }
      const prior = await deps.mastery.get(event.conceptId);
      const alreadyRow = cardBefore.lastEventId === event.id && prior?.lastEventId === event.id;
      let request: LearnerAtomicCommitRequest;
      if (!alreadyRow) {
        const params = deps.bkt ?? DEFAULT_BKT_PARAMS;
        const priorMastery = prior?.mastery ?? params.pKnow;
        const admitted = updateMastery(
          params,
          priorMastery,
          event.result === "correct",
          event.questionType,
        );
        // Graded-trust mixture (PR-014): λ is the probability the evidence is
        // genuine; λ=1 reproduces the ported math exactly.
        const masteryValue = weight * admitted + (1 - weight) * priorMastery;
        // PR32-followup (F01): the count must describe the event set AFTER this
        // transaction — and the current event is inserted BY this very commit.
        // The pre-fix code counted the ledger BEFORE the insert, so every
        // atomic-path answer stored the previous answer's count (first answer →
        // evidenceCount 0, confidence 0, classifyGap "missing"). A stored row
        // for this id (resume/replay) is already part of the count.
        const storedBeforeCommit = storedEvent ?? (await deps.evidence.getById(event.id));
        const evidenceCount =
          (await deps.evidence.countByConcept(event.conceptId)) +
          (storedBeforeCommit ? 0 : 1);
        const retention = retrievabilityOf(scheduler, currentCard, reviewInstant);
        const masteryRow: ConceptMastery = {
          conceptId: event.conceptId,
          mastery: masteryValue,
          confidence: Math.min(1, evidenceCount / CONFIDENCE_SATURATION_OBSERVATIONS),
          retention,
          transfer: null,
          lastVerified: event.timestamp,
          nextReview: currentCard.due,
          status: deriveMasteryStatus({
            evidenceCount,
            mastery: masteryValue,
            retention,
            lastVerified: event.timestamp,
            requestRetention: deps.requestRetention,
          }),
          evidenceCount,
          updatedAt: event.timestamp,
          lastEventId: event.id,
        };
        request = {
          event,
          payloadJson,
          log,
          card: { ...currentCard, lastEventId: event.id },
          mastery: masteryRow,
          expectedCardLastEventId: cardBefore.lastEventId ?? null,
          expectedMasteryLastEventId: prior?.lastEventId ?? null,
          session: options?.session,
        };
      } else {
        // Markers already match: a pure replay of a fully applied event. If a
        // session advance was requested (answer retry whose session write was
        // lost), still run the guarded session write through the adapter.
        if (!options?.session) {
          // PR33 A-line (L01): a PRE-completion legacy row lands here on its
          // first replay after upgrade — backfill the completion now so a
          // later marker-changing event can never un-protect this attempt.
          await deps.completions?.record(event.id, payloadJson);
          return { mastery: prior, alreadyApplied: true };
        }
        request = {
          event,
          payloadJson,
          log: null,
          card: { ...cardBefore, lastEventId: event.id },
          mastery: prior as ConceptMastery,
          expectedCardLastEventId: event.id,
          expectedMasteryLastEventId: event.id,
          session: options.session,
        };
      }
      const result = await deps.atomic.commit(request);
      if (result.outcome === "stale") continue; // recompute against current state
      if (result.outcome === "conflict") throw new EvidenceConflictError(event.id);
      if (result.outcome === "sessionStale") {
        throw new SessionStaleError(options?.session?.expected.id ?? event.id);
      }
      if (result.outcome === "applied") {
        await deps.completions?.record(event.id, payloadJson);
        return { mastery: result.mastery ?? request.mastery, alreadyApplied: false };
      }
      // alreadyApplied (the transaction found the completion record): state
      // untouched; report the stored mastery.
      const stored = await deps.mastery.get(event.conceptId);
      return { mastery: stored ?? request.mastery, alreadyApplied: true };
    }
    throw new Error(
      `Atomic learner commit for ${event.id} stayed stale after ${MAX_ATOMIC_ATTEMPTS} recomputes`,
    );
  }

  // Stepwise resumable path (hosts without the atomic adapter): each write
  // carries its own idempotency marker.
  // Step: ledger append, idempotent by primary key.
  if (!storedEvent) {
    try {
      await deps.evidence.append(event);
    } catch (error) {
      if (!(error instanceof DuplicateEvidenceIdError)) throw error;
      const stored = await deps.evidence.getById(event.id);
      if (!stored || !sameImmutablePayload(stored, event)) {
        throw new EvidenceConflictError(event.id);
      }
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
    // Completion record (WP-A): written AFTER the state writes on the stepwise
    // path (best-effort, repaired by the markers on replay) so the historical
    // A→B→A replay stays a no-op even without the atomic adapter.
    await deps.completions?.record(event.id, payloadJson);
    return { mastery: masteryRow, alreadyApplied: false };
  }

  // The mastery marker matched: everything before it (ledger, log, card) is
  // done — this call was a pure replay of a fully applied event.
  await deps.completions?.record(event.id, payloadJson);
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
  options?: EvidenceApplyOptions,
): Promise<EvidenceApplyResult> {
  return withLearnerWriteLock(() => applyEvidenceEventLocked(deps, input, options));
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
