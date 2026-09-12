// WP-A regression scenarios (2026-09-13 review): historical replay, retry time
// drift, immutable-payload conflicts, per-book teaching sessions, and late
// generation writes. Written against the REAL modules (in-memory durable
// stores + completion records); the SQLite/Rust transaction path is exercised
// separately by the src-tauri test.

import { describe, expect, it } from "vitest";
import {
  EvidenceConflictError,
  applyEvidenceEventResult,
} from "./engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "./engine";
import { SessionStaleError, deliverCurrentStep, startTeachingSession } from "./teaching-engine";
import type { TeachingEngineDeps } from "./teaching-engine";
import { createInMemoryLearnerStores } from "./stores";
import type { PersonalCurriculum } from "./goal";
import type { TeachingContent, TeachingLlmClient, TeachingStep } from "./teaching";
import { teachingEvidence } from "./teaching";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function fixedClock(at: Date = NOW) {
  return { now: () => at };
}

function quizInput(overrides?: Partial<EvidenceEventInput>): EvidenceEventInput {
  return {
    id: "ev-a",
    conceptId: "stats/mean",
    source: "READ_BOX_QUIZ",
    taskType: "quiz",
    questionType: "mc",
    result: "correct",
    confidence: 1,
    verification: "deterministic_keyed",
    timestamp: NOW.getTime(),
    ...overrides,
  };
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
      completions: stores.completions,
    },
  };
}

describe("learner commit scenarios (WP-A)", () => {
  it("A→B→retry A: a historical replay never re-enters the update branches", async () => {
    const { deps, stores } = createDeps();
    const first = await applyEvidenceEventResult(deps, quizInput({ id: "A" }));
    await applyEvidenceEventResult(deps, quizInput({ id: "B", result: "incorrect" }));
    const afterB = await deps.mastery.get("stats/mean");

    // A replays long after B was applied (outbox drain, startup replay, retry).
    const replay = await applyEvidenceEventResult(deps, quizInput({ id: "A" }));
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.mastery.mastery).toBeCloseTo(afterB?.mastery ?? 0, 12);
    // Exactly two evidence rows, two FSRS reviews, two BKT updates.
    expect(stores.events()).toHaveLength(2);
    expect(stores.logs()).toHaveLength(2);
    const card = await deps.reviews.getCard("stats/mean");
    expect(card?.reps).toBe(2);
    expect(card?.lastEventId).toBe("B");
    expect(first.alreadyApplied).toBe(false);
  });

  it("a retry after a partial apply keeps the ORIGINAL answer time (no drift)", async () => {
    const { deps, stores } = createDeps();
    const answerTime = NOW.getTime() - 3 * DAY_MS;
    // Crash window: only the ledger row landed (evidence append succeeded,
    // FSRS/BKT writes never ran).
    await deps.evidence.append({ ...quizInput({ id: "crash" }), timestamp: answerTime });

    // The retry arrives with the retry instant on the clock, NOT the original
    // answer time — the engine must adopt the stored time.
    const retryClock = new Date(NOW.getTime() + 8 * DAY_MS);
    const resumed = await applyEvidenceEventResult(
      { ...deps, clock: fixedClock(retryClock) },
      quizInput({ id: "crash", timestamp: answerTime }),
    );
    void stores;
    expect(resumed.alreadyApplied).toBe(false);
    expect(resumed.mastery.lastVerified).toBe(answerTime);
    expect(resumed.mastery.updatedAt).toBe(answerTime);
    expect(stores.logs()[0].review).toBe(answerTime);
  });

  it("same id with changed immutable metadata is a conflict, never silently adopted", async () => {
    const { deps, stores } = createDeps();
    await applyEvidenceEventResult(deps, quizInput({ id: "same" }));
    await expect(
      applyEvidenceEventResult(deps, quizInput({ id: "same", questionType: "free" })),
    ).rejects.toBeInstanceOf(EvidenceConflictError);
    await expect(
      applyEvidenceEventResult(deps, quizInput({ id: "same", verification: "user_confirmed" })),
    ).rejects.toBeInstanceOf(EvidenceConflictError);
    expect(stores.events()).toHaveLength(1);
    expect(stores.logs()).toHaveLength(1);
  });
});

function curriculumFor(bookId: string, conceptIds: string[]): PersonalCurriculum {
  return {
    goalId: `goal-${bookId}`,
    bookId,
    steps: conceptIds.map((conceptId, index) => ({
      conceptId,
      title: conceptId,
      depth: "working" as const,
      action: "learn" as const,
      reason: "test",
      kind: "gap" as const,
      index,
    })),
    satisfiedCount: 0,
    gapCount: conceptIds.length,
    builtAt: NOW.getTime(),
  };
}

const fakeContent: TeachingContent = {
  explanation:
    "A grounded walkthrough of the chapter that walks the learner through the core ideas, one concrete step at a time, staying inside the provided text.",
  keyPoints: ["k1", "k2"],
  workedExample: null,
  check: {
    prompt: "p",
    options: ["a", "b", "c", "d"],
    correctIndex: 0,
    explanation: "e",
  },
};

function teachingDeps(bookId: string): {
  deps: TeachingEngineDeps;
  stores: ReturnType<typeof createInMemoryLearnerStores>;
  llm: TeachingLlmClient & { calls: number; release?: () => void };
} {
  const stores = createInMemoryLearnerStores();
  const llm: TeachingLlmClient & { calls: number; release?: () => void } = {
    calls: 0,
    async complete() {
      this.calls += 1;
      return JSON.stringify(fakeContent);
    },
  };
  return {
    stores,
    llm,
    deps: {
      clock: fixedClock(),
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
      teachings: stores.teachings,
      completions: stores.completions,
      llm,
      chapterText: async () => "chapter text",
    },
  };
  void bookId;
}

describe("teaching session lifecycle (WP-A)", () => {
  it("starting book B does not abandon book A's resumable session", async () => {
    const { deps } = teachingDeps("book-a");
    const sessionA = await startTeachingSession(deps, curriculumFor("book-a", ["a/ch0"]));
    await startTeachingSession(deps, curriculumFor("book-b", ["b/ch0"]));

    const storedA = await deps.teachings.get(sessionA.id);
    expect(storedA?.status).toBe("active");
    expect(storedA?.bookId).toBe("book-a");
    // Book B still finds exactly one active session of its own.
    const activeB = await deps.teachings.getActiveByBook?.("book-b");
    expect(activeB?.bookId).toBe("book-b");
    const activeA = await deps.teachings.getActiveByBook?.("book-a");
    expect(activeA?.id).toBe(sessionA.id);
  });

  it("late generation cannot revive an abandoned session", async () => {
    const { deps, llm } = teachingDeps("book-a");
    const curriculum = curriculumFor("book-a", ["a/ch0", "a/ch1"]);
    const session = await startTeachingSession(deps, curriculum);

    // Gate the LLM so the session is superseded while generation is in flight.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    llm.complete = async () => {
      llm.calls += 1;
      await gate;
      return JSON.stringify(fakeContent);
    };

    const delivering = deliverCurrentStep(deps, session, "Book A");
    // A second start on the SAME book supersedes the in-flight session.
    await startTeachingSession(deps, curriculumFor("book-a", ["a/ch2"]));
    const storedDuringFlight = await deps.teachings.get(session.id);
    expect(storedDuringFlight?.status).toBe("abandoned");
    release();

    const delivered = await delivering;
    const storedAfter = await deps.teachings.get(session.id);
    expect(storedAfter?.status).toBe("abandoned");
    expect(storedAfter?.steps[0].content).toBeNull();
    // The returned view reflects the stored (non-revived) session.
    expect(delivered.status).toBe("abandoned");
  });

  it("answerCurrentStep commits evidence and session advance through the atomic commit", async () => {
    const stores = createInMemoryLearnerStores();
    const commits: unknown[] = [];
    const deps: TeachingEngineDeps & { atomic: unknown } = {
      clock: fixedClock(),
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
      teachings: stores.teachings,
      completions: stores.completions,
      llm: { async complete() { return JSON.stringify(fakeContent); } },
      chapterText: async () => "chapter text",
      // Fake atomic adapter mirroring the Rust contract: applied on first
      // commit, alreadyApplied on replay.
      atomic: {
        async commit(request: { event: { id: string }; session?: unknown }) {
          const prior = commits.find(
            (entry) => (entry as { event: { id: string } }).event.id === request.event.id,
          );
          if (prior) {
            return { outcome: "alreadyApplied", mastery: null };
          }
          commits.push(request);
          await stores.evidence.append(request.event as never);
          return { outcome: "applied", mastery: null };
        },
      },
    };

    const curriculum = curriculumFor("book-a", ["a/ch0"]);
    const session = await startTeachingSession(deps, curriculum);
    const delivered = await deliverCurrentStep(deps, session, "Book A");
    const answered = await answerStep(deps, delivered);

    expect(commits).toHaveLength(1);
    const commit = commits[0] as { session?: { expected: unknown; session: unknown } };
    expect(commit.session).toBeDefined();
    expect(
      (commit.session as { session: { currentIndex: number } }).session.currentIndex,
    ).toBe(1);
    expect(answered.currentIndex).toBe(1);
    void teachingEvidence;
  });

  it("answerCurrentStep surfaces SessionStaleError when the session moved under the answer", async () => {
    const stores = createInMemoryLearnerStores();
    const deps: TeachingEngineDeps = {
      clock: fixedClock(),
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
      teachings: stores.teachings,
      completions: stores.completions,
      llm: { async complete() { return JSON.stringify(fakeContent); } },
      chapterText: async () => "chapter text",
      atomic: {
        async commit() {
          return { outcome: "sessionStale" };
        },
      },
    };

    const curriculum = curriculumFor("book-a", ["a/ch0"]);
    const session = await startTeachingSession(deps, curriculum);
    const delivered = await deliverCurrentStep(deps, session, "Book A");
    await expect(answerStep(deps, delivered)).rejects.toBeInstanceOf(SessionStaleError);
  });
});

async function answerStep(
  deps: TeachingEngineDeps,
  session: Awaited<ReturnType<typeof deliverCurrentStep>>,
) {
  const { answerCurrentStep } = await import("./teaching-engine");
  return answerCurrentStep(deps, session, 0);
}
