// FSRS review scheduling via the PR-003 audit-approved dependency ts-fsrs
// (exact pin 5.4.1, MIT). The wrapper keeps the Authority deterministic:
// fuzz is disabled, scheduling is day-granularity (enable_short_term false —
// concepts are reviewed on day boundaries, not minute-level learning steps),
// and only the serializable card/log shapes from types.ts cross the storage
// boundary. Correct→Good(3), incorrect→Again(1) is the OpenTutor tracker
// mapping recorded in the audit.

import {
  type Card,
  type FSRS,
  Rating,
  type RecordLogItem,
  State,
  createEmptyCard,
  fsrs,
  generatorParameters,
} from "ts-fsrs";
import type { LearnerReviewCardData, LearnerReviewLogEntry } from "./types";

export const DEFAULT_REQUEST_RETENTION = 0.9;

export interface LearnerSchedulerOptions {
  /** Desired retention in (0,1); default 0.9 (ts-fsrs default). */
  requestRetention?: number;
}

/** Create the deterministic scheduler. enable_fuzz stays false (its seed is
 * time-coupled — the audit requires determinism for the Authority core). */
export function createLearnerScheduler(options: LearnerSchedulerOptions = {}): FSRS {
  const requestRetention = options.requestRetention ?? DEFAULT_REQUEST_RETENTION;
  if (!Number.isFinite(requestRetention) || requestRetention <= 0 || requestRetention >= 1) {
    throw new Error("Request retention must be strictly inside (0, 1)");
  }
  return fsrs(
    generatorParameters({ enable_fuzz: false, enable_short_term: false, requestRetention }),
  );
}

/** Serialize a ts-fsrs Card into the storage shape (epoch millis, no
 * deprecated fields). */
export function toCardData(conceptId: string, card: Card): LearnerReviewCardData {
  return {
    conceptId,
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as number,
    lastReview: card.last_review ? card.last_review.getTime() : null,
  };
}

/** Rebuild a ts-fsrs Card from storage. */
export function fromCardData(data: LearnerReviewCardData): Card {
  return {
    due: new Date(data.due),
    stability: data.stability,
    difficulty: data.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: data.learningSteps,
    reps: data.reps,
    lapses: data.lapses,
    state: data.state as State,
    last_review: data.lastReview === null ? undefined : new Date(data.lastReview),
  };
}

/** Fresh card for a never-reviewed concept. */
export function newConceptCard(conceptId: string, now: Date): LearnerReviewCardData {
  return toCardData(conceptId, createEmptyCard(now));
}

function toLogEntry(conceptId: string, log: RecordLogItem["log"]): LearnerReviewLogEntry {
  return {
    conceptId,
    rating: log.rating as number,
    state: log.state as number,
    due: log.due.getTime(),
    stability: log.stability,
    difficulty: log.difficulty,
    scheduledDays: log.scheduled_days,
    learningSteps: log.learning_steps,
    review: log.review.getTime(),
  };
}

/**
 * Apply one review to a concept card. Correct evidence maps to Rating.Good,
 * incorrect to Rating.Again (OpenTutor tracker mapping). Returns the updated
 * serializable card plus the append-only log entry.
 */
export function reviewConceptCard(
  scheduler: FSRS,
  data: LearnerReviewCardData,
  now: Date,
  isCorrect: boolean,
): { card: LearnerReviewCardData; log: LearnerReviewLogEntry } {
  const result = scheduler.next(fromCardData(data), now, isCorrect ? Rating.Good : Rating.Again);
  return {
    card: toCardData(data.conceptId, result.card),
    log: toLogEntry(data.conceptId, result.log),
  };
}

/** Retrievability R(t) in [0,1] at the given instant (0 before any review). */
export function retrievabilityOf(
  scheduler: FSRS,
  data: LearnerReviewCardData | null,
  now: Date,
): number | null {
  if (!data || data.state === State.New) return null;
  const value = scheduler.get_retrievability(fromCardData(data), now, false);
  return typeof value === "number" ? value : Number.parseFloat(value);
}
