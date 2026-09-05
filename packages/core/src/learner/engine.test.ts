import { describe, expect, it } from "vitest";
import { MASTERY_THRESHOLD, updateMastery } from "./bkt";
import {
  EvidenceNotAdmittedError,
  applyEvidenceEvent,
  deriveMasteryStatus,
  evaluateConceptMastery,
} from "./engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "./engine";
import { DuplicateEvidenceIdError, createInMemoryLearnerStores } from "./stores";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function fixedClock(at: Date = NOW) {
  return { now: () => at };
}

function createDeps(at?: Date): {
  deps: LearnerEngineDeps;
  stores: ReturnType<typeof createInMemoryLearnerStores>;
} {
  const stores = createInMemoryLearnerStores();
  return {
    stores,
    deps: {
      clock: fixedClock(at),
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
    },
  };
}

function quizInput(overrides?: Partial<EvidenceEventInput>): EvidenceEventInput {
  return {
    conceptId: "stats/mean",
    source: "READ_BOX_QUIZ",
    taskType: "quiz",
    questionType: "mc",
    result: "correct",
    confidence: 1,
    ...overrides,
  };
}

describe("deterministic learner engine", () => {
  it("applies one evidence event end to end: ledger row, BKT update, FSRS card, mastery row", async () => {
    const { deps, stores } = createDeps();
    const result = await applyEvidenceEvent(deps, quizInput());

    expect(stores.events()).toHaveLength(1);
    expect(stores.events()[0].conceptId).toBe("stats/mean");
    expect(stores.events()[0].timestamp).toBe(NOW.getTime());
    expect(stores.events()[0].id).toBeTruthy();
    expect(stores.logs()).toHaveLength(1);
    expect(stores.logs()[0].rating).toBe(3);

    // Cold start: BKT from pKnow=0.3 with the mc guess/slip (0.25/0.10) —
    // identical to calling updateMastery directly.
    expect(result.mastery).toBeCloseTo(
      updateMastery({ pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 }, 0.3, true, "mc"),
      12,
    );
    expect(result.evidenceCount).toBe(1);
    expect(result.confidence).toBeCloseTo(1 / 15, 10);
    expect(result.lastVerified).toBe(NOW.getTime());
    expect(result.nextReview).not.toBeNull();
    expect(result.retention).not.toBeNull();
    // Below threshold → learning.
    expect(result.status).toBe("learning");
    expect(result.transfer).toBeNull();
  });

  it("iterates BKT per evidence event (never aggregates a batch)", async () => {
    const { deps } = createDeps();
    let expected = 0.3;
    const params = { pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 };
    for (let i = 0; i < 5; i += 1) {
      expected = updateMastery(params, expected, true, "mc");
      const row = await applyEvidenceEvent(deps, quizInput({ id: `e${i}` }));
      expect(row.mastery).toBeCloseTo(expected, 12);
    }
    expect(expected).toBeGreaterThan(MASTERY_THRESHOLD);
  });

  it("crosses the threshold and reaches stable status after enough correct evidence", async () => {
    const { deps } = createDeps();
    let row = null as Awaited<ReturnType<typeof applyEvidenceEvent>> | null;
    for (let i = 0; i < 6; i += 1) {
      row = await applyEvidenceEvent(deps, quizInput({ id: `e${i}` }));
    }
    expect(row?.mastery).toBeGreaterThanOrEqual(MASTERY_THRESHOLD);
    // Just reviewed with strong evidence: retention is high → stable.
    expect(row?.status).toBe("stable");
  });

  it("lowers mastery on incorrect evidence and records the Again review", async () => {
    const { deps, stores } = createDeps();
    const before = await applyEvidenceEvent(deps, quizInput());
    const after = await applyEvidenceEvent(deps, quizInput({ id: "e2", result: "incorrect" }));
    expect(after.mastery).toBeLessThan(before.mastery);
    expect(stores.logs()[1].rating).toBe(1);
    expect(after.evidenceCount).toBe(2);
  });

  it("enforces the append-only ledger: duplicate evidence ids are rejected", async () => {
    const { deps, stores } = createDeps();
    await applyEvidenceEvent(deps, quizInput({ id: "same-id" }));
    await expect(applyEvidenceEvent(deps, quizInput({ id: "same-id" }))).rejects.toBeInstanceOf(
      DuplicateEvidenceIdError,
    );
    expect(stores.events()).toHaveLength(1);
    expect(stores.logs()).toHaveLength(1);
  });

  it("keeps concepts isolated from each other", async () => {
    const { deps } = createDeps();
    await applyEvidenceEvent(deps, quizInput({ id: "a1", conceptId: "stats/mean" }));
    await applyEvidenceEvent(deps, quizInput({ id: "a2", conceptId: "stats/mean" }));
    const other = await applyEvidenceEvent(
      deps,
      quizInput({ id: "b1", conceptId: "stats/variance" }),
    );
    expect(other.evidenceCount).toBe(1);
    expect(other.mastery).toBeCloseTo(
      updateMastery({ pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 }, 0.3, true, "mc"),
      12,
    );
    const mean = await deps.mastery.get("stats/mean");
    expect(mean?.evidenceCount).toBe(2);
  });

  it("saturates confidence at the audit's 15-observation gate", async () => {
    const { deps } = createDeps();
    let row = null as Awaited<ReturnType<typeof applyEvidenceEvent>> | null;
    for (let i = 0; i < 20; i += 1) {
      row = await applyEvidenceEvent(deps, quizInput({ id: `e${i}` }));
    }
    expect(row?.confidence).toBe(1);
    expect(row?.evidenceCount).toBe(20);
  });

  it("degrades a stable concept to needs_review as forgetting progresses, then recovers", async () => {
    const { deps } = createDeps();
    // Build mastery above the threshold.
    for (let i = 0; i < 6; i += 1) {
      await applyEvidenceEvent(deps, quizInput({ id: `e${i}` }));
    }
    const stable = await evaluateConceptMastery(deps, "stats/mean");
    expect(stable?.status).toBe("stable");

    // 90 days later: retrievability has decayed below the 0.9 request
    // retention → the handoff §11 Stable → NeedsReview degradation.
    const laterDeps = { ...deps, clock: fixedClock(new Date(NOW.getTime() + 90 * DAY_MS)) };
    const decayed = await evaluateConceptMastery(laterDeps, "stats/mean");
    expect(decayed?.status).toBe("needs_review");
    expect((decayed?.retention ?? 1) < 0.9).toBe(true);
    // History is never deleted: mastery and evidence count persist.
    expect(decayed?.mastery).toBe(stable?.mastery);
    expect(decayed?.evidenceCount).toBe(6);

    // A successful review after the decay restores stable status.
    const recovered = await applyEvidenceEvent(laterDeps, quizInput({ id: "recovery" }));
    expect(recovered.status).toBe("stable");
  });

  it("keeps unseen concepts out of the way", async () => {
    const { deps } = createDeps();
    expect(await evaluateConceptMastery(deps, "never-touched")).toBeNull();
    expect(deriveMasteryStatus({ evidenceCount: 0, mastery: null, retention: null })).toBe(
      "unseen",
    );
  });

  it("serializes concurrent events on the same concept: no lost BKT update (PR-012)", async () => {
    const { deps, stores } = createDeps();
    const params = { pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 };
    let expected = 0.3;
    for (let i = 0; i < 5; i += 1) expected = updateMastery(params, expected, true, "mc");

    // All five events race: without the learner write lock every cycle would
    // read the same prior mastery and four of the five BKT updates would be
    // lost (evidence count 5, mastery after ONE update).
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => applyEvidenceEvent(deps, quizInput({ id: `c${i}` }))),
    );

    expect(stores.events()).toHaveLength(5);
    expect(stores.logs()).toHaveLength(5);
    const final = await deps.mastery.get("stats/mean");
    expect(final?.mastery).toBeCloseTo(expected, 12);
    expect(final?.evidenceCount).toBe(5);
  });

  it("admission weights: llm_judged evidence moves mastery at 0.4 of the BKT step (PR-014)", async () => {
    const { deps } = createDeps();
    const params = { pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 };
    const admitted = updateMastery(params, 0.3, true, "mc");
    const expected = 0.4 * admitted + 0.6 * 0.3;

    const row = await applyEvidenceEvent(deps, quizInput({ id: "w1", verification: "llm_judged" }));
    expect(row.mastery).toBeCloseTo(expected, 12);
    // Less movement than the fully-admitted update, same direction.
    expect(row.mastery).toBeGreaterThan(0.3);
    expect(row.mastery).toBeLessThan(admitted);
  });

  it("admission weights: deterministic_keyed evidence moves mastery at 0.6 of the BKT step", async () => {
    const { deps } = createDeps();
    const params = { pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 };
    const admitted = updateMastery(params, 0.3, true, "mc");
    const expected = 0.6 * admitted + 0.4 * 0.3;

    const row = await applyEvidenceEvent(
      deps,
      quizInput({ id: "w2", verification: "deterministic_keyed" }),
    );
    expect(row.mastery).toBeCloseTo(expected, 12);
  });

  it("admission weights: user_confirmed evidence carries the full BKT step", async () => {
    const { deps } = createDeps();
    const row = await applyEvidenceEvent(
      deps,
      quizInput({ id: "w3", verification: "user_confirmed" }),
    );
    expect(row.mastery).toBeCloseTo(
      updateMastery({ pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 }, 0.3, true, "mc"),
      12,
    );
  });

  it("admission gate: legacy events without verification keep full weight (backcompat)", async () => {
    const { deps } = createDeps();
    const row = await applyEvidenceEvent(deps, quizInput({ id: "legacy" }));
    expect(row.mastery).toBeCloseTo(
      updateMastery({ pKnow: 0.3, pLearn: 0.1, pGuess: 0.2, pSlip: 0.1 }, 0.3, true, "mc"),
      12,
    );
  });

  it("admission gate: LLM_OBSERVATION without verification is rejected, admitted ones pass", async () => {
    const { deps, stores } = createDeps();
    await expect(
      applyEvidenceEvent(deps, quizInput({ id: "obs-1", source: "LLM_OBSERVATION" })),
    ).rejects.toBeInstanceOf(EvidenceNotAdmittedError);
    expect(stores.events()).toHaveLength(0);

    const admitted = await applyEvidenceEvent(
      deps,
      quizInput({ id: "obs-2", source: "LLM_OBSERVATION", verification: "user_confirmed" }),
    );
    expect(admitted.evidenceCount).toBe(1);
  });

  it("propagates the source locator for citation back to the canonical source", async () => {
    const { deps, stores } = createDeps();
    await applyEvidenceEvent(
      deps,
      quizInput({
        sourceLocator: { bookId: "book-1", chapterIndex: 3, cfi: "epubcfi(/6/14)" },
      }),
    );
    expect(stores.events()[0].sourceLocator).toEqual({
      bookId: "book-1",
      chapterIndex: 3,
      cfi: "epubcfi(/6/14)",
    });
  });
});
