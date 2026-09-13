// WP-A regression scenarios (2026-09-13 review): historical replay, retry time
// drift, immutable-payload conflicts, per-book teaching sessions, and late
// generation writes. Written against the REAL modules (in-memory durable
// stores + completion records); the SQLite/Rust transaction path is exercised
// separately by the src-tauri test.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EvidenceConflictError, applyEvidenceEventResult } from "./engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "./engine";
import type { PersonalCurriculum } from "./goal";
import { createLearnerScheduler, newConceptCard, reviewConceptCard } from "./review";
import { createInMemoryLearnerStores } from "./stores";
import type { TeachingContent, TeachingLlmClient } from "./teaching";
import { SessionStaleError, deliverCurrentStep, startTeachingSession } from "./teaching-engine";
import type { TeachingEngineDeps } from "./teaching-engine";

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
  it("A鈫払鈫抮etry A: a historical replay never re-enters the update branches", async () => {
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
    // answer time 鈥?the engine must adopt the stored time.
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

function teachingDeps(_bookId: string): {
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
      llm: {
        async complete() {
          return JSON.stringify(fakeContent);
        },
      },
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
    expect((commit.session as { session: { currentIndex: number } }).session.currentIndex).toBe(1);
    expect(answered.currentIndex).toBe(1);
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
      llm: {
        async complete() {
          return JSON.stringify(fakeContent);
        },
      },
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

/** PR32-followup atomic fixture mirroring the Rust contract: the engine's
 * derived request is verified (payload-gated), the event inserted BY the
 * commit, and a completion recorded inside the same boundary. */
function createAtomicDeps(at?: Date): {
  deps: LearnerEngineDeps;
  stores: ReturnType<typeof createInMemoryLearnerStores>;
  requests: Array<Record<string, unknown>>;
} {
  const stores = createInMemoryLearnerStores();
  const requests: Array<Record<string, unknown>> = [];
  const deps: LearnerEngineDeps = {
    clock: fixedClock(at),
    evidence: stores.evidence,
    mastery: stores.mastery,
    reviews: stores.reviews,
    completions: stores.completions,
    atomic: {
      async commit(request: {
        event: { id: string };
        payloadJson: string;
        mastery: unknown;
      }) {
        const recorded = await stores.completions.get(request.event.id);
        if (recorded) {
          if (recorded.payloadJson !== request.payloadJson) return { outcome: "conflict" as const };
          return { outcome: "alreadyApplied" as const, mastery: null };
        }
        requests.push(request as unknown as Record<string, unknown>);
        await stores.evidence.append(request.event as never);
        await stores.completions.record(request.event.id, request.payloadJson);
        return { outcome: "applied" as const, mastery: null };
      },
    },
  };
  return { deps, stores, requests };
}

describe("PR32 follow-up: first-answer counting and source-locator identity", () => {
  it("F01: the FIRST answer through the atomic path counts itself (evidenceCount 1, confidence > 0)", async () => {
    const { deps, stores, requests } = createAtomicDeps();
    const first = await applyEvidenceEventResult(deps, quizInput({ id: "ev-1" }));

    // The engine counts the event set the transaction WILL have — the current
    // event is inserted by this very commit, so the first answer is 1, not 0.
    const request = requests[0] as { mastery: { evidenceCount: number; confidence: number } };
    expect(request.mastery.evidenceCount).toBe(1);
    expect(request.mastery.confidence).toBeGreaterThan(0);
    expect(first.mastery.evidenceCount).toBe(1);

    // The second answer counts itself too: 0 → 1 → 2.
    const second = await applyEvidenceEventResult(deps, quizInput({ id: "ev-2" }));
    expect((requests[1] as { mastery: { evidenceCount: number } }).mastery.evidenceCount).toBe(2);
    expect(second.mastery.evidenceCount).toBe(2);
    expect(stores.events()).toHaveLength(2);
  });

  it("F01: a replay through the atomic path never bumps the count again", async () => {
    const { deps, requests } = createAtomicDeps();
    await applyEvidenceEventResult(deps, quizInput({ id: "ev-1" }));
    await applyEvidenceEventResult(deps, quizInput({ id: "ev-2" }));
    const replay = await applyEvidenceEventResult(deps, quizInput({ id: "ev-1" }));
    expect(replay.alreadyApplied).toBe(true);
    expect(requests).toHaveLength(2);
    expect(replay.mastery.evidenceCount).toBe(2);
  });

  it("F04: a retry that only changes sourceLocator.cfi is a conflict, not the same payload", async () => {
    const { deps } = createAtomicDeps();
    await applyEvidenceEventResult(
      deps,
      quizInput({ id: "loc-1", sourceLocator: { bookId: "b", chapterIndex: 0, cfi: "epubcfi(/4)" } }),
    );
    await expect(
      applyEvidenceEventResult(
        deps,
        quizInput({ id: "loc-1", sourceLocator: { bookId: "b", chapterIndex: 0, cfi: "epubcfi(/6)" } }),
      ),
    ).rejects.toBeInstanceOf(EvidenceConflictError);
  });

  it("F04: a legacy completion fingerprint (locator collapsed to {}) upgrades on replay instead of conflicting", async () => {
    const { deps, stores } = createAtomicDeps();
    // Record the event the way the PRE-FIX engine did: nested locator keys
    // were filtered away, so the stored fingerprint has sourceLocator: {}.
    await applyEvidenceEventResult(
      deps,
      quizInput({ id: "legacy-1", sourceLocator: { bookId: "b", chapterIndex: 0, cfi: "epubcfi(/4)" } }),
    );
    const legacy = stores.completions as unknown as {
      record(eventId: string, payloadJson: string): Promise<void>;
    };
    const storedEvent = await deps.evidence.getById("legacy-1");
    expect(storedEvent).not.toBeNull();
    await legacy.record("legacy-1", JSON.stringify({
      conceptId: storedEvent!.conceptId,
      source: storedEvent!.source,
      taskType: storedEvent!.taskType,
      questionType: storedEvent!.questionType ?? null,
      difficulty: storedEvent!.difficulty ?? null,
      result: storedEvent!.result,
      confidence: storedEvent!.confidence,
      verification: storedEvent!.verification ?? null,
      sourceLocator: {},
    }));

    // The replay must verify against the STORED EVENT (which matches) and
    // upgrade the fingerprint — not raise a spurious conflict.
    const replay = await applyEvidenceEventResult(
      deps,
      quizInput({ id: "legacy-1", sourceLocator: { bookId: "b", chapterIndex: 0, cfi: "epubcfi(/4)" } }),
    );
    expect(replay.alreadyApplied).toBe(true);
    const upgraded = await deps.completions?.get("legacy-1");
    expect(upgraded?.payloadJson).toContain('"cfi":"epubcfi(/4)"');
  });

  it("F05: getActiveTeachingSession by book returns THIS book's session even when another book's is newer", async () => {
    const { deps } = teachingDeps("book-a");
    const sessionA = await startTeachingSession(deps, curriculumFor("book-a", ["a/ch0"]));
    await startTeachingSession(deps, curriculumFor("book-b", ["b/ch0"]));

    const { getActiveTeachingSession } = await import("./teaching-engine");
    const resumedA = await getActiveTeachingSession(deps, "book-a");
    expect(resumedA?.id).toBe(sessionA.id);
    expect(resumedA?.status).toBe("active");
    const noneC = await getActiveTeachingSession(deps, "book-c");
    expect(noneC).toBeNull();
  });

  it("L01: a legacy markers-only event is backfilled with its completion and never re-applies", async () => {
    // Pre-completion legacy state: evidence + review log + card/mastery whose
    // markers all equal A, but NO completion record (databases written by the
    // pre-WP-A versions can legitimately look like this).
    const { deps, stores } = createDeps();
    const legacyEvent = { ...quizInput({ id: "legacy-A" }) };
    await deps.evidence.append(legacyEvent);
    const scheduler = createLearnerScheduler({});
    const cardBefore = newConceptCard(legacyEvent.conceptId, new Date(legacyEvent.timestamp));
    const reviewed = reviewConceptCard(scheduler, cardBefore, new Date(legacyEvent.timestamp), true);
    await deps.reviews.appendLog({ ...reviewed.log, eventId: "legacy-A" });
    await deps.reviews.putCard({ ...reviewed.card, lastEventId: "legacy-A" });
    await deps.mastery.put({
      conceptId: legacyEvent.conceptId,
      mastery: 0.4,
      confidence: 0.5,
      retention: 0.9,
      transfer: null,
      lastVerified: legacyEvent.timestamp,
      nextReview: reviewed.card.due,
      status: "learning",
      evidenceCount: 1,
      updatedAt: legacyEvent.timestamp,
      lastEventId: "legacy-A",
    });
    expect(await deps.completions?.get("legacy-A")).toBeNull();

    // First replay of the upgrade: already-applied AND the completion record
    // is backfilled, so no later event can un-protect this attempt.
    const replay = await applyEvidenceEventResult(deps, { ...quizInput({ id: "legacy-A" }) });
    expect(replay.alreadyApplied).toBe(true);
    expect(await deps.completions?.get("legacy-A")).not.toBeNull();
    expect(stores.logs()).toHaveLength(1);

    // A new event B updates the markers; the historical A replay must STILL be
    // a no-op (this is the documented L01 double-apply regression).
    await applyEvidenceEventResult(deps, quizInput({ id: "B", result: "incorrect" }));
    const afterB = await deps.mastery.get("stats/mean");
    const replayAgain = await applyEvidenceEventResult(deps, { ...quizInput({ id: "legacy-A" }) });
    expect(replayAgain.alreadyApplied).toBe(true);
    expect(replayAgain.mastery.mastery).toBeCloseTo(afterB?.mastery ?? 0, 12);
    expect(stores.events()).toHaveLength(2);
    expect(stores.logs()).toHaveLength(2);
  });

  it("L01: a superseded markers-only event without a completion fails SAFE (no re-apply)", async () => {
    // Degenerate upgrade state: A's evidence and review log exist but A never
    // got a completion, and B (a newer event) already moved the markers. From
    // the live state it cannot be proven whether A's BKT step ever ran —
    // re-applying would double-count, so the replay must change nothing and
    // backfill nothing.
    const { deps, stores } = createDeps();
    // Reconstruct the legacy rows for A (pre-completion era): ledger + log only.
    const legacyA = { ...quizInput({ id: "A" }) };
    await deps.evidence.append(legacyA);
    await deps.reviews.appendLog({
      conceptId: legacyA.conceptId,
      rating: 3,
      state: 0,
      due: legacyA.timestamp + DAY_MS,
      stability: 1,
      difficulty: 5,
      scheduledDays: 1,
      learningSteps: 0,
      review: legacyA.timestamp,
      eventId: "A",
    });
    // B is applied by the CURRENT engine: markers move to B, completion B exists.
    await applyEvidenceEventResult(deps, quizInput({ id: "B", result: "incorrect" }));
    const afterB = await deps.mastery.get("stats/mean");
    expect(await deps.completions?.get("A")).toBeNull();

    const replay = await applyEvidenceEventResult(deps, { ...quizInput({ id: "A" }) });
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.mastery.mastery).toBeCloseTo(afterB?.mastery ?? 0, 12);
    expect(stores.events()).toHaveLength(2);
    expect(stores.logs()).toHaveLength(2);
    // The ambiguous row is left un-backfilled on purpose: it needs review.
    expect(await deps.completions?.get("A")).toBeNull();
  });

  it("L01: a genuine partial apply (log written, mastery marker absent) still resumes", async () => {
    const { deps, stores } = createDeps();
    const answerTime = NOW.getTime() - DAY_MS;
    // Crash window: ledger + review log landed, the card/mastery writes did not.
    await deps.evidence.append({ ...quizInput({ id: "half" }), timestamp: answerTime });
    const cardBefore = newConceptCard("stats/mean", new Date(answerTime));
    const reviewed = reviewConceptCard(
      createLearnerScheduler({}),
      cardBefore,
      new Date(answerTime),
      true,
    );
    await deps.reviews.appendLog({ ...reviewed.log, eventId: "half" });

    const resumed = await applyEvidenceEventResult(
      deps,
      { ...quizInput({ id: "half" }), timestamp: answerTime },
    );
    expect(resumed.alreadyApplied).toBe(false);
    expect(resumed.mastery.lastEventId).toBe("half");
    expect(resumed.mastery.lastVerified).toBe(answerTime);
    expect(stores.logs()).toHaveLength(1, "the log stays deduplicated");
    expect(await deps.completions?.get("half")).not.toBeNull();
  });

  it("the committed real-engine request fixture stays in sync with the engine output", async () => {
    // Mirrors scripts/capture-engine-request.ts byte for byte: the Rust test
    // learner_commit::real_engine_first_answer_request_commits_to_sqlite
    // replays this fixture through the REAL commit against real SQLite. If the
    // engine's request shape drifts, this test fails and the fixture must be
    // regenerated with `npx tsx scripts/capture-engine-request.ts`.
    const { deps, requests } = createAtomicDeps(new Date("2026-08-30T00:00:00.000Z"));
    await applyEvidenceEventResult(
      deps,
      quizInput({
        id: "fixture-first-answer",
        sourceLocator: { bookId: "fixture-book", chapterIndex: 0, cfi: "epubcfi(/4/2)" },
      }),
    );
    const fixturePath = resolve(
      __dirname,
      "../../../app/src-tauri/tests/fixtures/learner_commit/engine-first-answer-request.json",
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(requests[0]).toEqual(fixture);
  });
});
