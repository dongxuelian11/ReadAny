import { describe, expect, it } from "vitest";
import { applyEvidenceEvent } from "./engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "./engine";
import { getLearnerStateAt } from "./read-model";
import type { LearnerReadDeps } from "./read-model";
import { createInMemoryLearnerStores } from "./stores";

const NOW = new Date("2026-09-05T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function buildDeps(at: Date = NOW): {
  deps: LearnerEngineDeps & LearnerReadDeps;
  stores: ReturnType<typeof createInMemoryLearnerStores>;
} {
  const stores = createInMemoryLearnerStores();
  return {
    stores,
    deps: {
      clock: { now: () => at },
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
    },
  };
}

const CORRECT: EvidenceEventInput = {
  conceptId: "stats/mean",
  source: "READ_BOX_QUIZ",
  taskType: "quiz",
  questionType: "mc",
  result: "correct",
  confidence: 1,
};

async function buildStableConcept(deps: LearnerEngineDeps): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await applyEvidenceEvent(deps, { ...CORRECT, id: `e${i}` });
  }
}

describe("current-instant learner read model", () => {
  it("returns null for concepts the learner state knows nothing about", async () => {
    const { deps } = buildDeps();
    const [entry] = await getLearnerStateAt(deps, ["never-touched"]);
    expect(entry.conceptId).toBe("never-touched");
    expect(entry.state).toBeNull();
  });

  it("reports the freshly-practiced concept as stable with high retention", async () => {
    const { deps } = buildDeps();
    await buildStableConcept(deps);
    const [entry] = await getLearnerStateAt(deps, ["stats/mean"]);
    expect(entry.state?.status).toBe("stable");
    expect(entry.state?.retention).not.toBeNull();
    expect(entry.state?.retention ?? 0).toBeGreaterThan(0.9);
    expect(entry.state?.evidenceCount).toBe(6);
  });

  it("surfaces forgetting at read time without rewriting the persisted row", async () => {
    const { deps, stores } = buildDeps();
    await buildStableConcept(deps);

    // 90 days later: retrievability has decayed below the 0.9 request
    // retention — the read model must degrade the status to needs_review.
    const later = buildDeps(new Date(NOW.getTime() + 90 * DAY_MS));
    // Share the stores across clocks: the later read sees the same projection.
    const laterDeps: LearnerReadDeps = { ...deps, clock: later.deps.clock };
    const [entry] = await getLearnerStateAt(laterDeps, ["stats/mean"]);
    expect(entry.state?.status).toBe("needs_review");
    expect((entry.state?.retention ?? 1) < 0.9).toBe(true);

    // Read-only: the persisted projection still says what the last write left.
    const persisted = await deps.mastery.get("stats/mean");
    expect(persisted?.status).toBe("stable");
    expect(persisted?.updatedAt).toBe(NOW.getTime());
  });

  it("derives placement-written rows (no FSRS card) from mastery alone", async () => {
    const { deps } = buildDeps();
    // Placement finalize writes mastery rows directly with no review card.
    await deps.mastery.put({
      conceptId: "stats/variance",
      mastery: 0.75,
      confidence: 1,
      retention: null,
      transfer: null,
      lastVerified: NOW.getTime(),
      nextReview: null,
      status: "stable",
      evidenceCount: 1,
      updatedAt: NOW.getTime(),
    });
    const [entry] = await getLearnerStateAt(deps, ["stats/variance"]);
    expect(entry.state?.status).toBe("stable");
    expect(entry.state?.retention).toBeNull();
  });

  it("preserves the requested concept order", async () => {
    const { deps } = buildDeps();
    await buildStableConcept(deps);
    const entries = await getLearnerStateAt(deps, ["stats/mean", "unknown", "stats/mean"]);
    expect(entries.map((entry) => entry.conceptId)).toEqual([
      "stats/mean",
      "unknown",
      "stats/mean",
    ]);
    expect(entries[2].state?.evidenceCount).toBe(6);
  });
});
