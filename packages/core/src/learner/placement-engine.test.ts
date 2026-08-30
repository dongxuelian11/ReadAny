import { describe, expect, it } from "vitest";
import type { LearnerEngineDeps } from "./engine";
import type { PlacementConcept, PlacementItem } from "./placement";
import {
  PlacementPoolTooSmallError,
  answerPlacementItem,
  finalizePlacement,
  nextPlacementItem,
  startPlacementSession,
} from "./placement-engine";
import { generatePlacementItems } from "./placement-generation";
import { listDueReviewConcepts } from "./queries";
import { createInMemoryLearnerStores } from "./stores";
import type { LearnerClock } from "./types";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function fixedClock(at: Date = NOW): LearnerClock {
  return { now: () => at };
}

function createDeps(at?: Date): {
  deps: LearnerEngineDeps & {
    placements: ReturnType<typeof createInMemoryLearnerStores>["placements"];
  };
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
      placements: stores.placements,
    },
  };
}

function concept(index: number): PlacementConcept {
  return { conceptId: `readany:book:b1:chapter:${index}`, title: `Chapter ${index + 1}` };
}

/** Deterministic item pool covering the difficulty range. */
function pool(size: number): PlacementItem[] {
  return Array.from({ length: size }, (_, i) => {
    const bloom = [2, 3, 5][i % 3];
    const difficulty = [0.2, 0.4, 0.8][i % 3];
    return {
      id: `s:${i}`,
      conceptId: concept(i).conceptId,
      conceptTitle: concept(i).title,
      prompt: `Q${i}`,
      options: ["a", "b", "c", "d"],
      correctIndex: 1,
      explanation: "e",
      layer: ((i % 3) + 1) as 1 | 2 | 3,
      bloomLevel: bloom,
      difficulty,
    };
  });
}

function fakeLlm(): { complete: (system: string, user: string) => Promise<string>; calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete(system: string) {
      calls += 1;
      if (system.includes("diagnostic multiple-choice")) {
        return JSON.stringify({
          prompt: "Which statement is correct?",
          options: ["A", "B", "C", "D"],
          correctIndex: 1,
          explanation: "B is right.",
        });
      }
      throw new Error("unexpected prompt");
    },
  };
}

describe("placement session lifecycle", () => {
  it("starts a session, abandons any prior active one, and fails closed on a small pool", async () => {
    const { deps } = createDeps();
    const first = await startPlacementSession(deps, pool(8));
    expect(first.status).toBe("active");
    expect(first.theta).toBe(0.5);
    expect(first.items).toHaveLength(8);

    const second = await startPlacementSession(deps, pool(8));
    const rereadFirst = await deps.placements.get(first.id);
    expect(rereadFirst?.status).toBe("abandoned");
    expect((await deps.placements.getActive())?.id).toBe(second.id);

    await expect(startPlacementSession(deps, pool(4))).rejects.toBeInstanceOf(
      PlacementPoolTooSmallError,
    );
  });

  it("answers items with fail-closed validation and persists theta", async () => {
    const { deps } = createDeps();
    const session = await startPlacementSession(deps, pool(8));

    await expect(answerPlacementItem(deps, session, "missing", true)).rejects.toThrow(
      "Unknown placement item",
    );
    const once = await answerPlacementItem(deps, session, "s:0", true);
    await expect(answerPlacementItem(deps, once, "s:0", false)).rejects.toThrow("already answered");
    expect(once.responses).toHaveLength(1);
    // theta 0.5 >= difficulty 0.2 → audited drift branch: 0.5 + step*0.2 = 0.56
    expect(once.theta).toBeCloseTo(0.56, 12);

    const reread = await deps.placements.get(session.id);
    expect(reread?.responses).toHaveLength(1);
    expect(reread?.theta).toBeCloseTo(0.56, 12);
  });

  it("stops per the CAT rules and surfaces no item afterwards", async () => {
    const { deps } = createDeps();
    // 9 easy items, all correct: after 5 answers SE = 0 → stop.
    const items = pool(9).map((item) => ({ ...item, difficulty: 0.2 }));
    let session = await startPlacementSession(deps, items);
    for (let i = 0; i < 4; i += 1) {
      session = await answerPlacementItem(deps, session, `s:${i}`, true);
      expect(nextPlacementItem(session)).not.toBeNull();
    }
    session = await answerPlacementItem(deps, session, "s:4", true);
    expect(session.responses).toHaveLength(5);
    expect(nextPlacementItem(session)).toBeNull(); // p=1 clamped 0.99 → SE≈0.0447 < 0.15
  });

  it("finalizes with audited formulas, the overwrite guard, and answer-only evidence", async () => {
    const { deps, stores } = createDeps();
    // Give chapter 1 real practice evidence — the guard must protect it.
    await deps.mastery.put({
      conceptId: concept(1).conceptId,
      mastery: 0.9,
      confidence: 1,
      retention: null,
      transfer: null,
      lastVerified: NOW.getTime() - DAY_MS,
      nextReview: null,
      status: "stable",
      evidenceCount: 3,
      updatedAt: NOW.getTime() - DAY_MS,
    });

    const items = pool(9); // difficulty cycle 0.2/0.4/0.8; chapters 0..8
    let session = await startPlacementSession(deps, items);
    // Answer the first five items alternating correct/incorrect.
    for (let i = 0; i < 5; i += 1) {
      session = await answerPlacementItem(deps, session, `s:${i}`, i % 2 === 0);
    }
    const verdict = await finalizePlacement(deps, session);

    expect(verdict.questionsAsked).toBe(5);
    expect(verdict.conceptsAssessed).toBe(9);
    expect(verdict.masteryWritten).toBe(8); // chapter 1 protected by the guard
    expect(verdict.perConcept.find((c) => c.conceptId === concept(1).conceptId)?.mastery).toBe(0.9);

    // Tested concepts: chapters 0 (correct), 1 (incorrect, guarded), 2 (correct), 3 (incorrect), 4 (correct).
    const chapter0 = await deps.mastery.get(concept(0).conceptId);
    expect(chapter0?.mastery).toBeCloseTo(Math.min(0.4 + session.theta * 0.4, 0.85), 12);
    expect(chapter0?.evidenceCount).toBe(1);
    expect(chapter0?.confidence).toBe(1);
    const chapter3 = await deps.mastery.get(concept(3).conceptId);
    expect(chapter3?.mastery).toBeCloseTo(Math.max(session.theta * 0.3, 0.05), 12);
    // Untested inferred concepts (5..8) — capped at 0.7, no synthetic evidence.
    const chapter7 = await deps.mastery.get(concept(7).conceptId);
    expect(chapter7?.mastery).toBeLessThanOrEqual(0.7);
    expect(chapter7?.evidenceCount).toBe(0);
    expect(chapter7?.status === "learning" || chapter7?.status === "stable").toBe(true);

    // Evidence ledger: exactly one event per answered item, deterministic ids.
    expect(stores.events().length).toBe(5);
    expect(
      stores
        .events()
        .every((event) => event.source === "PLACEMENT" && event.taskType === "placement"),
    ).toBe(true);
    expect(stores.events()[0].id).toBe(`${session.id}:s:0`);

    // Session completed; re-finalize and re-answer fail closed.
    const done = await deps.placements.get(session.id);
    expect(done?.status).toBe("completed");
    if (!done) throw new Error("session missing after finalize");
    await expect(finalizePlacement(deps, done)).rejects.toThrow("not active");
    await expect(answerPlacementItem(deps, done, "s:5", true)).rejects.toThrow("not active");
  });
});

describe("placement item generation (LLM as content co-processor)", () => {
  it("generates one validated item per concept with deterministic layer rotation", async () => {
    const llm = fakeLlm();
    const items = await generatePlacementItems({
      bookTitle: "Minimal Statistics",
      concepts: [concept(0), concept(1), concept(2), concept(3)],
      llm,
      idPrefix: "placement:b1",
    });
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.layer)).toEqual([1, 2, 3, 1]);
    expect(items.map((item) => item.bloomLevel)).toEqual([2, 3, 5, 2]);
    expect(items.map((item) => item.difficulty)).toEqual([0.2, 0.4, 0.8, 0.2]);
    expect(items[0].id).toBe("placement:b1:0");
    expect(items[0].prompt).toBe("Which statement is correct?");
    expect(items[0].options).toHaveLength(4);
  });

  it("retries a malformed draft once and skips the concept, shrinking the pool", async () => {
    let attempts = 0;
    const flaky = {
      async complete() {
        attempts += 1;
        if (attempts <= 2) return "not json at all";
        return JSON.stringify({
          prompt: "ok?",
          options: ["a", "b", "c", "d"],
          correctIndex: 0,
          explanation: "x",
        });
      },
    };
    const items = await generatePlacementItems({
      bookTitle: "B",
      concepts: [concept(0), concept(1), concept(2)],
      llm: flaky,
      idPrefix: "p",
    });
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(items).toHaveLength(2); // concept 0 skipped after one retry
    expect(items[0].conceptId).toBe(concept(1).conceptId);
  });
});

describe("due review queries", () => {
  it("lists due cards ordered by due time with joined mastery", async () => {
    const { deps } = createDeps();
    await deps.reviews.putCard({
      conceptId: "c-late",
      due: NOW.getTime() + 2 * DAY_MS,
      stability: 1,
      difficulty: 5,
      learningSteps: 0,
      reps: 1,
      lapses: 0,
      state: 2,
      lastReview: NOW.getTime(),
    });
    await deps.reviews.putCard({
      conceptId: "c-due-2",
      due: NOW.getTime() + DAY_MS,
      stability: 1,
      difficulty: 5,
      learningSteps: 0,
      reps: 1,
      lapses: 0,
      state: 2,
      lastReview: NOW.getTime(),
    });
    await deps.reviews.putCard({
      conceptId: "c-due-1",
      due: NOW.getTime(),
      stability: 1,
      difficulty: 5,
      learningSteps: 0,
      reps: 1,
      lapses: 0,
      state: 2,
      lastReview: NOW.getTime(),
    });
    await deps.mastery.put({
      conceptId: "c-due-1",
      mastery: 0.75,
      confidence: 0.5,
      retention: null,
      transfer: null,
      lastVerified: NOW.getTime(),
      nextReview: NOW.getTime(),
      status: "stable",
      evidenceCount: 2,
      updatedAt: NOW.getTime(),
    });

    const due = await listDueReviewConcepts(deps, NOW.getTime() + DAY_MS);
    expect(due.map((entry) => entry.card.conceptId)).toEqual(["c-due-1", "c-due-2"]);
    expect(due[0].mastery?.mastery).toBe(0.75);
    expect(due[0].status).toBe("stable");
    expect(due[1].mastery).toBeNull();
    expect(due[1].status).toBeNull();
  });
});
