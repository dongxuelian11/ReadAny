import { describe, expect, it } from "vitest";
import {
  PLACEMENT_INITIAL_THETA,
  PLACEMENT_MAX_ITEMS,
  PLACEMENT_MIN_ITEMS,
  PLACEMENT_SE_THRESHOLD,
  bloomToDifficulty,
  placementInferredMastery,
  placementShouldStop,
  placementStandardError,
  placementTestedMastery,
  selectNextPlacementItem,
  updatePlacementTheta,
} from "./placement";
import type { PlacementItem, PlacementResponse, PlacementSession } from "./placement";

// Porting spec: OpenTutor cat_pretest.py (pinned 0307042). Formulas are
// asserted with exact values computed from the audited source.

function item(id: string, difficulty: number): PlacementItem {
  return {
    id,
    conceptId: `concept-${id}`,
    conceptTitle: `Concept ${id}`,
    prompt: "q",
    options: ["a", "b", "c", "d"],
    correctIndex: 0,
    explanation: "e",
    layer: 1,
    bloomLevel: 2,
    difficulty,
  };
}

function sessionWith(
  items: PlacementItem[],
  responses: PlacementResponse[],
  theta = 0.5,
): PlacementSession {
  return {
    id: "s1",
    status: "active",
    theta,
    startedAt: 0,
    finalizedAt: null,
    items,
    responses,
  };
}

describe("placement CAT engine (OpenTutor cat_pretest.py port)", () => {
  it("keeps the audited constants", () => {
    expect(PLACEMENT_MIN_ITEMS).toBe(5);
    expect(PLACEMENT_MAX_ITEMS).toBe(20);
    expect(PLACEMENT_SE_THRESHOLD).toBe(0.15);
    expect(PLACEMENT_INITIAL_THETA).toBe(0.5);
  });

  it("maps Bloom levels to difficulty exactly", () => {
    expect(bloomToDifficulty(1)).toBeCloseTo(0.1, 12);
    expect(bloomToDifficulty(2)).toBeCloseTo(0.2, 12);
    expect(bloomToDifficulty(3)).toBeCloseTo(0.4, 12);
    expect(bloomToDifficulty(5)).toBeCloseTo(0.8, 12);
    expect(bloomToDifficulty(6)).toBeCloseTo(0.9, 12);
    expect(bloomToDifficulty(8)).toBeCloseTo(0.9, 12); // clamped
  });

  it("computes the binomial standard error with the audited clamps", () => {
    expect(placementStandardError([])).toBe(1.0);
    expect(
      placementStandardError([{ itemId: "a", conceptId: "c", correct: true, difficulty: 0.5 }]),
    ).toBe(1.0);
    // 3/5 correct: p = 0.6, SE = sqrt(0.6*0.4/5)
    const five = (correct: boolean): PlacementResponse => ({
      itemId: Math.random().toString(),
      conceptId: "c",
      correct,
      difficulty: 0.5,
    });
    const se = placementStandardError([
      five(true),
      five(true),
      five(true),
      five(false),
      five(false),
    ]);
    expect(se).toBeCloseTo(Math.sqrt((0.6 * 0.4) / 5), 12);
  });

  it("stops exactly per the audited rule (exact-value check)", () => {
    const responses = (n: number, correctCount: number): PlacementResponse[] =>
      Array.from({ length: n }, (_, i) => ({
        itemId: `i${i}`,
        conceptId: `c${i}`,
        correct: i < correctCount,
        difficulty: 0.5,
      }));
    // Below the minimum: never stop.
    expect(placementShouldStop(responses(4, 2))).toBe(false);
    // 5 items, 2 correct: p = 0.4, SE = sqrt(0.4*0.6/5) ≈ 0.2191 ≥ 0.15 → continue.
    expect(placementShouldStop(responses(5, 2))).toBe(false);
    // 9 items, 6 correct: p = 2/3, SE = sqrt(0.6667*0.3333/9) ≈ 0.1571 ≥ 0.15 → continue.
    expect(placementShouldStop(responses(9, 6))).toBe(false);
    // 9 items, 7 correct: p = 7/9, SE = sqrt(0.7778*0.2222/9) ≈ 0.1385 < 0.15 → stop.
    expect(placementShouldStop(responses(9, 7))).toBe(true);
    // Hard stop at the maximum regardless of SE.
    expect(placementShouldStop(responses(PLACEMENT_MAX_ITEMS, 10))).toBe(true);
  });

  it("selects the untested item closest to theta", () => {
    const items = [item("easy", 0.1), item("mid", 0.5), item("hard", 0.9)];
    const s0 = sessionWith(items, []);
    expect(selectNextPlacementItem(s0)?.id).toBe("mid"); // theta 0.5

    const s1 = sessionWith(
      items,
      [{ itemId: "mid", conceptId: "concept-mid", correct: true, difficulty: 0.5 }],
      0.65,
    );
    // |0.9 - 0.65| = 0.25 < |0.1 - 0.65| = 0.55
    expect(selectNextPlacementItem(s1)?.id).toBe("hard");
    // All items asked → null.
    const s2 = sessionWith(items, [
      { itemId: "mid", conceptId: "c-mid", correct: true, difficulty: 0.5 },
      { itemId: "hard", conceptId: "c-hard", correct: true, difficulty: 0.9 },
      { itemId: "easy", conceptId: "c-easy", correct: true, difficulty: 0.1 },
    ]);
    expect(selectNextPlacementItem(s2)).toBeNull();
  });

  it("updates theta per the audited branches (exact values)", () => {
    const hard = item("hard", 0.9);
    const s = sessionWith([hard], []);
    // First response, correct, theta 0.5 < 0.9: step = 0.3/1 = 0.3
    // theta = 0.5 + 0.3 * (0.9 - 0.5 + 0.1) = 0.65
    expect(updatePlacementTheta(s, hard, true)).toBeCloseTo(0.65, 12);

    // First response, incorrect on an easy item, theta 0.5 > 0.1: step = 0.3
    // theta = 0.5 - 0.3 * (0.5 - 0.1 + 0.1) = 0.5 - 0.15 = 0.35
    const easy = item("easy", 0.1);
    expect(updatePlacementTheta(s, easy, false)).toBeCloseTo(0.35, 12);

    // Correct on an easier item (theta >= difficulty): drift up by step*0.2
    const mid = item("mid", 0.4);
    expect(updatePlacementTheta(s, mid, true)).toBeCloseTo(0.5 + 0.3 * 0.2, 12);

    // Incorrect on a harder item (theta <= difficulty): drift down by step*0.2
    expect(updatePlacementTheta(s, hard, false)).toBeCloseTo(0.5 - 0.3 * 0.2, 12);

    // Clamped to [0, 1] across a long run.
    let long = sessionWith([hard], []);
    let theta = long.theta;
    for (let i = 1; i <= 50; i += 1) {
      theta = updatePlacementTheta({ ...long, responses: long.responses }, hard, true);
      long = {
        ...long,
        theta,
        responses: [
          ...long.responses,
          { itemId: `i${i}`, conceptId: "c", correct: true, difficulty: 0.9 },
        ],
      };
      expect(theta).toBeLessThanOrEqual(1.0);
      expect(theta).toBeGreaterThanOrEqual(0.0);
    }
  });

  it("computes tested and inferred mastery with the audited formulas", () => {
    // Tested: correct → min(0.4 + theta*0.4, 0.85); incorrect → max(theta*0.3, 0.05)
    expect(placementTestedMastery(0.65, true)).toBeCloseTo(0.66, 12);
    expect(placementTestedMastery(0.95, true)).toBeCloseTo(0.78, 12); // 0.4+0.38 = 0.78, below the 0.85 cap
    expect(placementTestedMastery(1.0, true)).toBeCloseTo(0.8, 12); // 0.4+0.4 = 0.8; the cap binds only at theta > 1.125
    expect(placementTestedMastery(0.35, false)).toBeCloseTo(0.105, 12);
    // Inferred: theta >= difficulty → min(0.3 + (theta-difficulty)*0.5, 0.7); else max(0.1, theta*0.4)
    expect(placementInferredMastery(0.65, 0.3)).toBeCloseTo(0.475, 12);
    expect(placementInferredMastery(0.9, 0.1)).toBeCloseTo(0.7, 12);
    expect(placementInferredMastery(0.35, 0.9)).toBeCloseTo(0.14, 12);
    expect(placementInferredMastery(0.2, 0.9)).toBeCloseTo(0.1, 12);
  });
});
