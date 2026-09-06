// Iter-1: the learner's vouch for a judged verdict is pure confirmation
// metadata. These tests pin the store contract; the guarantee that confirming
// never moves BKT/FSRS a second time is structural — the app confirm path
// (trigger.confirmQuizEvidence) only records here and never calls
// applyEvidenceEvent, so no second evidence event can exist for one attempt.

import { describe, expect, it } from "vitest";
import { applyEvidenceEvent } from "./engine";
import { createInMemoryLearnerStores } from "./stores";

describe("evidence confirmation metadata (iter-1)", () => {
  it("records one confirmation per evidence id, first write wins", async () => {
    const stores = createInMemoryLearnerStores();
    expect(await stores.confirmations.get("ev-1")).toBeNull();

    await stores.confirmations.record("ev-1", 1000);
    await stores.confirmations.record("ev-1", 2000);
    expect(await stores.confirmations.get("ev-1")).toBe(1000);
    expect(await stores.confirmations.get("ev-2")).toBeNull();
  });

  it("confirming an attempt leaves the ledger, log, and card untouched", async () => {
    const stores = createInMemoryLearnerStores();
    const deps = {
      clock: { now: () => new Date("2026-09-06T00:00:00.000Z") },
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
    };
    await applyEvidenceEvent(deps, {
      id: "attempt-1",
      conceptId: "stats/mean",
      source: "READ_BOX_QUIZ",
      taskType: "quiz",
      result: "correct",
      confidence: 1,
      verification: "llm_judged",
    });
    const masteryBefore = await deps.mastery.get("stats/mean");
    const logsBefore = stores.logs().length;
    const cardBefore = await deps.reviews.getCard("stats/mean");

    // The vouch itself writes NO evidence, NO log, NO card, NO mastery row.
    await stores.confirmations.record("attempt-1", 5000);

    expect(stores.events()).toHaveLength(1);
    expect(stores.logs()).toHaveLength(logsBefore);
    expect(await deps.reviews.getCard("stats/mean")).toEqual(cardBefore);
    expect(await deps.mastery.get("stats/mean")).toEqual(masteryBefore);
    expect(await stores.confirmations.get("attempt-1")).toBe(5000);
  });
});
