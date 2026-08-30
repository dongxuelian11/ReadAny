import { describe, expect, it } from "vitest";
import type { PersonalCurriculum } from "./goal";
import type { LearnerConceptState } from "./goal";
import { createInMemoryLearnerStores } from "./stores";
import { buildTeachingPrompt, validateTeachingContent } from "./teaching";
import type { TeachingContent, TeachingLlmClient } from "./teaching";
import {
  TeachingStepFailedError,
  answerCurrentStep,
  deliverCurrentStep,
  getStepLearnerState,
  startTeachingSession,
} from "./teaching-engine";
import type { LearnerClock } from "./types";

const NOW = new Date("2026-08-30T00:00:00.000Z");

function fixedClock(at: Date = NOW): LearnerClock {
  return { now: () => at };
}

function curriculum(stepCount = 2): PersonalCurriculum {
  const steps = Array.from({ length: stepCount }, (_, i) => ({
    conceptId: `readany:book:b1:chapter:${i}`,
    title: `第${i + 1}章`,
    depth: "working" as const,
    action: (i === 0 ? "review" : "learn") as "review" | "learn",
    reason: "test",
    index: i,
  }));
  return { goalId: "g1", bookId: "b1", steps, satisfiedCount: 0, gapCount: stepCount, builtAt: 1 };
}

const CONTENT: TeachingContent = {
  explanation: "本章讲解抽样：用一小部分观测去估计总体，并承认估计带有误差。".repeat(2),
  keyPoints: ["样本估计总体", "必须报告误差"],
  workedExample: null,
  check: {
    prompt: "抽样推断的核心代价是什么？",
    options: ["没有代价", "估计带有误差", "总体被破坏", "样本必须等于总体"],
    correctIndex: 1,
    explanation: "抽样的代价是估计带有误差；其余选项都是误解。",
  },
};

function fakeLlm(mode: "ok" | "always-broken" = "ok"): TeachingLlmClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete(system: string) {
      calls += 1;
      if (mode === "always-broken") return "不是 JSON";
      void system;
      return JSON.stringify(CONTENT);
    },
  };
}

function createDeps(llmMode: "ok" | "always-broken" = "ok"): {
  deps: Parameters<typeof startTeachingSession>[0];
  stores: ReturnType<typeof createInMemoryLearnerStores>;
  llm: ReturnType<typeof fakeLlm>;
} {
  const stores = createInMemoryLearnerStores();
  const llm = fakeLlm(llmMode);
  return {
    stores,
    llm,
    deps: {
      clock: fixedClock(),
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
      teachings: stores.teachings,
      llm,
      chapterText: async (conceptId) => `Chapter text for ${conceptId}: sampling with error.`,
    },
  };
}

describe("teaching prompt and validation", () => {
  it("builds a grounded prompt with the review variant and text cap", () => {
    const prompt = buildTeachingPrompt({
      bookTitle: "极简统计学",
      chapterTitle: "第1章",
      chapterText: "x".repeat(20000),
      action: "review",
    });
    expect(prompt.system).toContain("retention lapsed");
    expect(prompt.system).toContain("Never copy the chapter text verbatim");
    expect(prompt.user.length).toBeLessThan(20000);
    expect(prompt.user).toContain("Chapter text:");
  });

  it("validates the draft fail-closed", () => {
    expect(() =>
      validateTeachingContent({
        explanation: "too short",
        keyPoints: CONTENT.keyPoints,
        check: CONTENT.check,
      }),
    ).toThrow();
    expect(() => validateTeachingContent({ ...CONTENT, keyPoints: ["only one"] })).toThrow(
      "2-5 key points",
    );
    expect(() =>
      validateTeachingContent({
        ...CONTENT,
        check: { ...CONTENT.check, options: ["a", "b", "c"] },
      }),
    ).toThrow("malformed");
    expect(() =>
      validateTeachingContent({ ...CONTENT, check: { ...CONTENT.check, correctIndex: 4 } }),
    ).toThrow("malformed");
    expect(validateTeachingContent(CONTENT).check.correctIndex).toBe(1);
  });

  it("retries a malformed reply once, then fails with a step error", async () => {
    const { deps } = createDeps("always-broken");
    const session = await startTeachingSession(deps, curriculum(1));
    await expect(deliverCurrentStep(deps, session, "B")).rejects.toBeInstanceOf(
      TeachingStepFailedError,
    );
    expect(llmCalls(deps)).toBe(2); // one retry, then the honest step failure
  });
});

describe("teaching session lifecycle", () => {
  it("starts with curriculum steps, abandons a prior active session, and fails on empty curriculum", async () => {
    const { deps } = createDeps();
    const first = await startTeachingSession(deps, curriculum(2));
    expect(first.status).toBe("active");
    expect(first.steps.map((step) => step.action)).toEqual(["review", "learn"]);

    const second = await startTeachingSession(deps, curriculum(2));
    expect((await deps.teachings.get(first.id))?.status).toBe("abandoned");
    expect((await deps.teachings.getActive())?.id).toBe(second.id);

    await expect(startTeachingSession(deps, curriculum(0))).rejects.toThrow("no steps");
  });

  it("delivers grounded content idempotently, then grades the check through the evidence path", async () => {
    const { deps, stores } = createDeps();
    const goal = curriculum(2);
    let session = await startTeachingSession(deps, goal);

    session = await deliverCurrentStep(deps, session, "B");
    expect(session.steps[0].content?.check.prompt).toBe(CONTENT.check.prompt);
    // Idempotent delivery: no extra LLM call, same content.
    const callsAfterFirst = llmCalls(deps);
    session = await deliverCurrentStep(deps, session, "B");
    expect(llmCalls(deps)).toBe(callsAfterFirst);

    // Answer wrong → evidence recorded with deterministic id, session advances.
    session = await answerCurrentStep(deps, session, 0);
    expect(session.steps[0].answered).toBe(true);
    expect(session.steps[0].correct).toBe(false);
    expect(session.currentIndex).toBe(1);
    expect(stores.events()).toHaveLength(1);
    expect(stores.events()[0]).toMatchObject({
      id: `${session.id}:readany:book:b1:chapter:0`,
      conceptId: "readany:book:b1:chapter:0",
      source: "TEACHING",
      taskType: "quiz",
      questionType: "mc",
      result: "incorrect",
    });
    // BKT + FSRS moved through applyEvidenceEvent: mastery row and review card exist.
    const mastery = await deps.mastery.get("readany:book:b1:chapter:0");
    expect(mastery?.evidenceCount).toBe(1);
    expect(mastery?.status).toBe("learning");
    const card = await deps.reviews.getCard("readany:book:b1:chapter:0");
    expect(card?.reps).toBe(1);

    // Fail-closed guards: answering the NEXT step before delivery fails, and an
    // out-of-range option on a delivered step fails.
    await expect(answerCurrentStep(deps, session, 1)).rejects.toThrow(
      "Deliver the step content before answering",
    );
    session = await deliverCurrentStep(deps, session, "B");
    await expect(answerCurrentStep(deps, session, 9)).rejects.toThrow("Selected option");

    // Second step: deliver + correct answer completes the session.
    session = await deliverCurrentStep(deps, session, "B");
    session = await answerCurrentStep(deps, session, 1);
    expect(session.status).toBe("completed");
    expect(session.completedAt).not.toBeNull();
    expect(currentTeachingStepOf(session)).toBeNull();
    expect(stores.events()).toHaveLength(2);
    expect((await getStepLearnerState(deps, "readany:book:b1:chapter:1"))?.status).toBe("learning");
  });

  it("refuses delivering/answering on completed sessions and persists supersession", async () => {
    const { deps } = createDeps();
    let session = await startTeachingSession(deps, curriculum(1));
    session = await deliverCurrentStep(deps, session, "B");
    session = await answerCurrentStep(deps, session, 1);
    await expect(deliverCurrentStep(deps, session, "B")).rejects.toThrow("not active");
    const done = await deps.teachings.get(session.id);
    if (!done) throw new Error("session missing");
    await expect(answerCurrentStep(deps, done, 1)).rejects.toThrow("not active");
  });
});

function llmCalls(deps: { llm: unknown }): number {
  return (deps.llm as TeachingLlmClient & { calls: number }).calls;
}

function currentTeachingStepOf(session: import("./teaching").TeachingSession) {
  return session.steps[session.currentIndex] ?? null;
}

describe("learner state snapshot helper", () => {
  it("returns null for unknown concepts and the row for known ones", async () => {
    const { deps } = createDeps();
    expect(await getStepLearnerState(deps, "unknown")).toBeNull();
    await deps.mastery.put({
      conceptId: "c1",
      mastery: 0.5,
      confidence: 0.5,
      retention: null,
      transfer: null,
      lastVerified: 1,
      nextReview: null,
      status: "learning",
      evidenceCount: 2,
      updatedAt: 1,
    });
    const state: LearnerConceptState | null = await getStepLearnerState(deps, "c1");
    expect(state?.evidenceCount).toBe(2);
  });
});
