// Bayesian Knowledge Tracing — ported per the PR-003 audit:
// - updateMastery is a faithful port of skillcoco skillcoco-core/src/bkt.rs
//   (pinned 805c6c7) — canonical Corbett & Anderson 4-parameter BKT: Bayes
//   posterior + learn step. Its tests are the porting spec (see bkt.test.ts).
// - The question-type guess/slip table and the defaults are OpenTutor's
//   (pinned 0307042: services/loom_mastery.py guess/slip table, estimate_params
//   free-response guess 0.05).
// Documented upstream nuance, adopted deliberately: the learning step also
// runs after an incorrect answer, so the returned value can exceed the prior
// when pLearn is large (the posterior itself still drops).

import type { EvidenceQuestionType } from "./types";

export interface BKTParams {
  /** P(L0) — prior probability the learner knows the concept. */
  pKnow: number;
  /** P(T) — learning rate per observation. */
  pLearn: number;
  /** P(G) — guess probability. */
  pGuess: number;
  /** P(S) — slip probability. */
  pSlip: number;
}

/** Project defaults (skillcoco bkt.rs Default). */
export const DEFAULT_BKT_PARAMS: BKTParams = {
  pKnow: 0.3,
  pLearn: 0.1,
  pGuess: 0.2,
  pSlip: 0.1,
};

/**
 * Mastery threshold for gating (skillcoco bkt.rs MASTERY_THRESHOLD). A
 * project-level constant by design: changing it requires coordinated
 * migration across stored mastery rows.
 */
export const MASTERY_THRESHOLD = 0.7;

/** Evidence-confidence saturation point: the audit records OpenTutor's rule of
 * upgrading to EM-fitted parameters only at >= 15 observations; confidence
 * grows linearly up to this count. */
export const CONFIDENCE_SATURATION_OBSERVATIONS = 15;

interface GuessSlip {
  guess: number;
  slip: number;
}

/**
 * Question-type-aware guess/slip (OpenTutor loom_mastery.py table, ported
 * verbatim; free_response follows OpenTutor estimate_params' 0.05 guess for
 * constructed responses). Guess is P(correct | not-knowing) for that shape;
 * slip stays at the table's uniform 0.10.
 */
export const QUESTION_TYPE_GUESS_SLIP: Record<EvidenceQuestionType, GuessSlip> = {
  mc: { guess: 0.25, slip: 0.1 },
  tf: { guess: 0.5, slip: 0.1 },
  short_answer: { guess: 0.05, slip: 0.1 },
  fill_blank: { guess: 0.1, slip: 0.1 },
  matching: { guess: 0.15, slip: 0.1 },
  select_all: { guess: 0.1, slip: 0.1 },
  free_response: { guess: 0.05, slip: 0.1 },
};

function assertValidParams(params: BKTParams): void {
  const { pKnow, pLearn, pGuess, pSlip } = params;
  if (![pKnow, pLearn, pGuess, pSlip].every((v) => Number.isFinite(v))) {
    throw new Error("BKT parameters must be finite numbers");
  }
  if (pGuess <= 0 || pGuess >= 1 || pSlip <= 0 || pSlip >= 1) {
    throw new Error("BKT guess and slip must be strictly inside (0, 1)");
  }
  if (pLearn < 0 || pLearn > 1) {
    throw new Error("BKT learn rate must be inside [0, 1]");
  }
}

/** Resolve guess/slip for an observation: the question-type table when the
 * evidence carries a question type, otherwise the parameter defaults. */
export function guessSlipFor(params: BKTParams, questionType?: EvidenceQuestionType): GuessSlip {
  assertValidParams(params);
  if (!questionType) return { guess: params.pGuess, slip: params.pSlip };
  return QUESTION_TYPE_GUESS_SLIP[questionType];
}

/**
 * Update mastery after one observation (skillcoco bkt.rs update_mastery port).
 * Returns the new estimate in [0, 1]: Bayes posterior using the effective
 * guess/slip, then the learn step `posterior + (1 - posterior) * pLearn`.
 */
export function updateMastery(
  params: BKTParams,
  priorMastery: number,
  isCorrect: boolean,
  questionType?: EvidenceQuestionType,
): number {
  assertValidParams(params);
  if (!Number.isFinite(priorMastery) || priorMastery < 0 || priorMastery > 1) {
    throw new Error("Prior mastery must be a number in [0, 1]");
  }
  const { guess, slip } = guessSlipFor(params, questionType);

  // P(correct | known) = 1 - P(S); P(correct | unknown) = P(G)
  const posterior = isCorrect
    ? (priorMastery * (1 - slip)) / (priorMastery * (1 - slip) + (1 - priorMastery) * guess)
    : (priorMastery * slip) / (priorMastery * slip + (1 - priorMastery) * (1 - guess));

  // Learning step: P(known after practice) = P(known | obs) + (1 - P(known | obs)) * P(T)
  return posterior + (1 - posterior) * params.pLearn;
}

/** Adaptation check (skillcoco bkt.rs should_adapt port): strict inequality. */
export function shouldAdapt(
  expectedMastery: number,
  actualMastery: number,
  threshold: number,
): boolean {
  return Math.abs(expectedMastery - actualMastery) > threshold;
}
