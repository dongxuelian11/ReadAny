// WP-A commit boundary (2026-09-13 review, F01/F02): the learner commit
// contract. One user attempt = one durable completion record + the full set of
// state writes, committed atomically at the storage boundary (Rust/SQLite on
// desktop, the in-memory stores in tests). The engine computes BKT/FSRS
// outcomes in TypeScript and hands them to the adapter with EXPECTED prior
// state markers; the adapter verifies the markers inside its transaction
// (compare-and-swap), so a computed result is never blindly written over a
// state that moved underneath it.

import type { TeachingSession, TeachingSessionStatus } from "./teaching";
import type {
  ConceptMastery,
  EvidenceEvent,
  LearnerReviewCardData,
  LearnerReviewLogEntry,
} from "./types";

/** The teaching-session write that must land (or be refused) together with the
 * evidence commit. The guard makes a late answer unable to advance a session
 * that was abandoned, superseded, or already advanced. */
export interface TeachingSessionCommit {
  expected: {
    id: string;
    status: TeachingSessionStatus;
    currentIndex: number;
  };
  session: TeachingSession;
}

export interface LearnerAtomicCommitRequest {
  event: EvidenceEvent;
  /** Stable JSON of the event's IMMUTABLE fields. Stored in the completion
   * record; a replay whose payload differs is a conflict, never a silent
   * merge. The timestamp is intentionally excluded — retries adopt the stored
   * answer time instead of the retry instant. */
  payloadJson: string;
  /** Null when the review-log row is already known to be present (or the
   * engine's card marker matched): the adapter skips the insert. */
  log: LearnerReviewLogEntry | null;
  card: LearnerReviewCardData;
  mastery: ConceptMastery;
  expectedCardLastEventId: string | null;
  expectedMasteryLastEventId: string | null;
  session?: TeachingSessionCommit;
}

export type LearnerAtomicCommitResult =
  | { outcome: "applied"; mastery: ConceptMastery | null }
  | { outcome: "alreadyApplied"; mastery: ConceptMastery | null }
  /** The prior-state markers moved since the engine read them: recompute and
   * retry (the adapter rolled everything back). */
  | { outcome: "stale" }
  /** The stored evidence row (or completion record) for this id carries a
   * different immutable payload: the engine raises EvidenceConflictError. */
  | { outcome: "conflict" }
  /** The session guard failed: nothing was committed; the caller must surface
   * the stale session instead of advancing it. */
  | { outcome: "sessionStale" };

export interface LearnerAtomicCommit {
  commit(request: LearnerAtomicCommitRequest): Promise<LearnerAtomicCommitResult>;
}

/** Thrown when an answer raced a session supersession/advance; the evidence
 * was NOT recorded (the whole commit rolled back). */
export class SessionStaleError extends Error {
  constructor(sessionId: string) {
    super(`Teaching session ${sessionId} is no longer current; the answer was not recorded`);
    this.name = "SessionStaleError";
  }
}

/** Durable, per-attempt completion record: once an event id is recorded, a
 * replay NEVER re-enters the FSRS/BKT update branches — even after unrelated
 * events were applied in between (the historical A→B→A case the per-row
 * lastEventId markers cannot cover). */
export interface LearnerEvidenceCompletionStore {
  get(eventId: string): Promise<{ payloadJson: string } | null>;
  record(eventId: string, payloadJson: string): Promise<void>;
}

const PAYLOAD_FIELDS = [
  "conceptId",
  "source",
  "taskType",
  "questionType",
  "difficulty",
  "result",
  "confidence",
  "verification",
] as const;

/** Stable JSON of the event's immutable fields.
 *
 * PR32-followup (F04): the replacer-array form filtered keys at EVERY nesting
 * level, which collapsed a non-empty `sourceLocator` to `{}` and made all
 * locator differences invisible to the conflict check. The payload is now
 * constructed explicitly in a fixed key order (top level AND inside the
 * locator) and serialized without a replacer, so insertion order IS the
 * canonical order. `null` normalization is kept for absent optionals. */
export function evidencePayloadJson(event: EvidenceEvent): string {
  const payload: Record<string, unknown> = {};
  for (const field of PAYLOAD_FIELDS) {
    payload[field] = event[field] ?? null;
  }
  const locator = event.sourceLocator;
  payload.sourceLocator = locator
    ? {
        bookId: locator.bookId ?? null,
        chapterIndex: locator.chapterIndex ?? null,
        cfi: locator.cfi ?? null,
      }
    : null;
  return JSON.stringify(payload);
}

/** True when a stored event matches the replayed one on every immutable
 * field. The timestamp is NOT part of the comparison: a retry adopts the
 * stored answer time (F02), so only genuinely different attempts conflict. */
export function sameImmutablePayload(stored: EvidenceEvent, replay: EvidenceEvent): boolean {
  return evidencePayloadJson(stored) === evidencePayloadJson(replay);
}
