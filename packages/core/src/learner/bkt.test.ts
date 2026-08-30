import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_SATURATION_OBSERVATIONS,
  DEFAULT_BKT_PARAMS,
  MASTERY_THRESHOLD,
  QUESTION_TYPE_GUESS_SLIP,
  guessSlipFor,
  shouldAdapt,
  updateMastery,
} from "./bkt";

// Porting spec: skillcoco skillcoco-core/src/bkt.rs test set (pinned 805c6c7),
// with the OpenTutor question-type guess/slip table from the PR-003 audit.

describe("BKT port (skillcoco bkt.rs spec)", () => {
  it("keeps the canonical defaults and threshold", () => {
    expect(DEFAULT_BKT_PARAMS).toEqual({ pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 });
    expect(MASTERY_THRESHOLD).toBe(0.7);
    expect(CONFIDENCE_SATURATION_OBSERVATIONS).toBe(15);
  });

  it("increases mastery on a correct answer", () => {
    const updated = updateMastery(DEFAULT_BKT_PARAMS, 0.3, true);
    expect(updated).toBeGreaterThan(0.3);
    expect(updated).toBeLessThanOrEqual(1);
  });

  it("computes the exact first-update value from the ported recurrence", () => {
    // posterior = 0.3*0.9 / (0.3*0.9 + 0.7*0.2) = 0.6585365853...
    // updated = posterior + (1 - posterior) * 0.1 = 0.6926829268...
    expect(updateMastery(DEFAULT_BKT_PARAMS, 0.3, true)).toBeCloseTo(0.6926829, 5);
  });

  it("drops the posterior on an incorrect answer (learning step still applies)", () => {
    const posteriorOnly =
      (0.7 * DEFAULT_BKT_PARAMS.pSlip) /
      (0.7 * DEFAULT_BKT_PARAMS.pSlip + 0.3 * (1 - DEFAULT_BKT_PARAMS.pGuess));
    const updated = updateMastery(DEFAULT_BKT_PARAMS, 0.7, false);
    expect(posteriorOnly).toBeLessThan(0.7);
    expect(updated).toBeGreaterThanOrEqual(posteriorOnly);
    expect(updated).toBeLessThanOrEqual(1);
  });

  it("stays bounded in [0, 1] over long correct sequences", () => {
    let mastery = 0.3;
    for (let i = 0; i < 100; i += 1) {
      mastery = updateMastery(DEFAULT_BKT_PARAMS, mastery, true);
      expect(mastery).toBeLessThanOrEqual(1);
      expect(mastery).toBeGreaterThan(0);
    }
  });

  it("converges near 1.0 after many correct answers", () => {
    let mastery = 0.3;
    for (let i = 0; i < 50; i += 1) {
      mastery = updateMastery(DEFAULT_BKT_PARAMS, mastery, true);
    }
    expect(mastery).toBeGreaterThan(0.95);
  });

  it("honours custom parameters", () => {
    const params = { pKnow: 0.5, pLearn: 0.2, pGuess: 0.1, pSlip: 0.05 };
    expect(updateMastery(params, 0.5, true)).toBeGreaterThan(0.5);
  });

  it("rejects invalid parameters and priors (fail closed)", () => {
    expect(() => updateMastery({ ...DEFAULT_BKT_PARAMS, pGuess: 0 }, 0.3, true)).toThrow();
    expect(() => updateMastery({ ...DEFAULT_BKT_PARAMS, pSlip: 1 }, 0.3, true)).toThrow();
    expect(() => updateMastery({ ...DEFAULT_BKT_PARAMS, pLearn: 1.5 }, 0.3, true)).toThrow();
    expect(() => updateMastery(DEFAULT_BKT_PARAMS, 1.2, true)).toThrow();
    expect(() => updateMastery(DEFAULT_BKT_PARAMS, Number.NaN, true)).toThrow();
  });

  it("applies the OpenTutor question-type guess/slip table verbatim", () => {
    expect(QUESTION_TYPE_GUESS_SLIP.mc).toEqual({ guess: 0.25, slip: 0.1 });
    expect(QUESTION_TYPE_GUESS_SLIP.tf).toEqual({ guess: 0.5, slip: 0.1 });
    expect(QUESTION_TYPE_GUESS_SLIP.short_answer).toEqual({ guess: 0.05, slip: 0.1 });
    expect(QUESTION_TYPE_GUESS_SLIP.fill_blank).toEqual({ guess: 0.1, slip: 0.1 });
    expect(QUESTION_TYPE_GUESS_SLIP.matching).toEqual({ guess: 0.15, slip: 0.1 });
    expect(QUESTION_TYPE_GUESS_SLIP.select_all).toEqual({ guess: 0.1, slip: 0.1 });
    expect(QUESTION_TYPE_GUESS_SLIP.free_response).toEqual({ guess: 0.05, slip: 0.1 });
  });

  it("uses the question-type table when present and parameter defaults otherwise", () => {
    expect(guessSlipFor(DEFAULT_BKT_PARAMS, "tf")).toEqual({ guess: 0.5, slip: 0.1 });
    expect(guessSlipFor(DEFAULT_BKT_PARAMS)).toEqual({ guess: 0.2, slip: 0.1 });
  });

  it("makes true-false correct answers worth less than short-answer correct answers", () => {
    // A tf correct answer is weak evidence (guess 0.5); a short_answer correct
    // answer is strong evidence (guess 0.05).
    const afterTf = updateMastery(DEFAULT_BKT_PARAMS, 0.3, true, "tf");
    const afterShortAnswer = updateMastery(DEFAULT_BKT_PARAMS, 0.3, true, "short_answer");
    expect(afterShortAnswer).toBeGreaterThan(afterTf);
    // And an incorrect tf answer barely moves mastery down, while an incorrect
    // short_answer answer is damning.
    const afterTfWrong = updateMastery(DEFAULT_BKT_PARAMS, 0.6, false, "tf");
    const afterShortAnswerWrong = updateMastery(DEFAULT_BKT_PARAMS, 0.6, false, "short_answer");
    expect(afterShortAnswerWrong).toBeLessThan(afterTfWrong);
  });

  it("ports shouldAdapt with the strict inequality", () => {
    expect(shouldAdapt(0.5, 0.48, 0.1)).toBe(false);
    expect(shouldAdapt(0.8, 0.5, 0.1)).toBe(true);
    expect(shouldAdapt(0.5, 0.4, 0.1)).toBe(false);
  });
});
