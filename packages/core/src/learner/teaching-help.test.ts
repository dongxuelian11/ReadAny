// LEARN-01: cognitive-aligned context + askable help flows. The tests pin the
// contract that matters to the learner:
//   - unknown basis is never asserted as zero basis;
//   - the curriculum depth reaches the prompt (old sessions without it stay
//     compatible);
//   - the source window follows the learner's selected passage instead of
//     always slicing the chapter head, and coverage is stated honestly;
//   - help variants are pure explanation rewrites: they never touch the check
//     question, its answer key, or any learning record (BKT/FSRS/evidence).

import { describe, expect, it } from "vitest";
import type { PersonalCurriculum } from "./goal";
import { initialLearnerPanelState, learnerPanelReducer } from "./panel-state";
import { createInMemoryLearnerStores } from "./stores";
import {
  TEACHING_HELP_VARIANTS_MAX,
  buildTeachingHelpPrompt,
  buildTeachingPrompt,
  selectSourceWindow,
  validateTeachingHelpContent,
} from "./teaching";
import type { TeachingContent, TeachingHelpRequest, TeachingLlmClient } from "./teaching";
import { answerCurrentStep, deliverCurrentStep, requestTeachingHelp } from "./teaching-engine";
import type { LearnerClock } from "./types";

const NOW = new Date("2026-09-19T00:00:00.000Z");

function fixedClock(at: Date = NOW): LearnerClock {
  return { now: () => at };
}

function curriculum(depth: "familiar" | "working" | "mastery" = "working"): PersonalCurriculum {
  return {
    goalId: "g1",
    bookId: "b1",
    steps: [
      {
        conceptId: "readany:book:b1:chapter:0",
        title: "第1章 收益与波动",
        depth,
        action: "learn",
        reason: "test",
        kind: "missing",
        index: 0,
      },
    ],
    satisfiedCount: 0,
    gapCount: 1,
    builtAt: 1,
  };
}

const CONTENT: TeachingContent = {
  explanation: "本章讲解收益率与波动率：收益率衡量变化，波动率衡量变化的不确定性。".repeat(2),
  keyPoints: ["收益是变化", "波动是不确定的程度"],
  workedExample: "以 100 元买入，一年后 110 元，收益率 10%。",
  check: {
    prompt: "波动率衡量的是什么？",
    options: ["收益的多少", "变化的不确定性", "本金的规模", "持有时间的长短"],
    correctIndex: 1,
    explanation: "波动率衡量变化的不确定性；其余选项都不是波动率。",
  },
};

interface SpyLlm extends TeachingLlmClient {
  calls: Array<{ system: string; user: string }>;
  /** When set, the pending call resolves only after `release()` is invoked. */
  gate: { promise: Promise<void>; release: () => void } | null;
}

function spyLlm(reply: (system: string) => string): SpyLlm {
  const calls: Array<{ system: string; user: string }> = [];
  let gate: SpyLlm["gate"] = null;
  return {
    calls,
    get gate() {
      return gate;
    },
    set gate(value: SpyLlm["gate"]) {
      gate = value;
    },
    async complete(system: string, user: string) {
      calls.push({ system, user });
      if (gate) await gate.promise;
      return reply(system);
    },
  };
}

/** Reply with teaching content for content calls and help content for help
 * calls (the help system prompt identifies itself as a re-explanation). */
function bothReply(system: string): string {
  return system.includes("re-explaining") ? HELP_REPLY : JSON.stringify(CONTENT);
}

const HELP_REPLY = JSON.stringify({
  explanation:
    "换个说法：波动率就像心电图，起伏越大越不确定。这里起伏指的是每天收益围绕平均值的摆动幅度。",
  example: "日均 1% 的摆动比日均 5% 的摆动平稳，所以后者波动率更高。",
});

function createDeps(llm: TeachingLlmClient) {
  const stores = createInMemoryLearnerStores();
  return {
    stores,
    deps: {
      clock: fixedClock(),
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
      teachings: stores.teachings,
      llm,
      chapterText: async (conceptId: string) => `Base text for ${conceptId}.`,
    },
  };
}

function seedMastery(
  stores: ReturnType<typeof createInMemoryLearnerStores>,
  conceptId: string,
  over: Partial<Parameters<typeof stores.mastery.put>[0]>,
): void {
  void stores.mastery.put({
    conceptId,
    mastery: 0.4,
    confidence: 0.5,
    retention: null,
    transfer: null,
    lastVerified: 1,
    nextReview: null,
    status: "learning",
    evidenceCount: 3,
    updatedAt: 1,
    ...over,
  });
}

async function deliverOnce(deps: Parameters<typeof deliverCurrentStep>[0]) {
  const session = await import("./teaching-engine").then((m) =>
    m.startTeachingSession(deps, curriculum()),
  );
  return deliverCurrentStep(deps, session, "量化入门");
}

describe("LEARN-01 learner context honesty", () => {
  it("starts the session with the curriculum depth copied onto the step", async () => {
    const llm = spyLlm(() => JSON.stringify(CONTENT));
    const { deps } = createDeps(llm);
    const session = await import("./teaching-engine").then((m) =>
      m.startTeachingSession(deps, curriculum("mastery")),
    );
    expect(session.steps[0].depth).toBe("mastery");
  });

  it("never asserts a zero basis when the learner has no evidence", async () => {
    const llm = spyLlm(() => JSON.stringify(CONTENT));
    const { deps } = createDeps(llm);
    await deliverOnce(deps);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toContain("UNKNOWN, not zero");
    expect(llm.calls[0].user).not.toContain("start from zero domain knowledge");
  });

  it("carries mastery, recent wrong attempts, and the target depth into the context", async () => {
    const llm = spyLlm(() => JSON.stringify(CONTENT));
    const { deps, stores } = createDeps(llm);
    const conceptId = "readany:book:b1:chapter:0";
    seedMastery(stores, conceptId, { evidenceCount: 3, mastery: 0.4, status: "learning" });
    await stores.evidence.append({
      id: "e1",
      conceptId,
      source: "TEACHING",
      taskType: "quiz",
      questionType: "mc",
      result: "correct",
      confidence: 1,
      verification: "deterministic_keyed",
      timestamp: 1,
    });
    await stores.evidence.append({
      id: "e2",
      conceptId,
      source: "TEACHING",
      taskType: "quiz",
      questionType: "mc",
      result: "incorrect",
      confidence: 1,
      verification: "deterministic_keyed",
      timestamp: 2,
    });
    await deliverCurrentStep(
      deps,
      await import("./teaching-engine").then((m) =>
        m.startTeachingSession(deps, curriculum("working")),
      ),
      "量化入门",
    );
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toContain("3 prior attempt");
    expect(llm.calls[0].user).toContain("40%");
    expect(llm.calls[0].user).toContain("1 of the last 2");
    expect(llm.calls[0].user).toContain("working");
  });
});

describe("LEARN-01 source window", () => {
  it("keeps a short chapter whole", () => {
    const window = selectSourceWindow({ chapterText: "short", focus: null });
    expect(window).toMatchObject({ start: 0, end: 5, total: 5 });
    expect(window.text).toBe("short");
  });

  it("defaults to the head window and marks it partial for a long chapter", () => {
    const text = "a".repeat(20000);
    const window = selectSourceWindow({ chapterText: text, focus: null, cap: 12000 });
    expect(window.start).toBe(0);
    expect(window.end).toBe(12000);
    expect(window.total).toBe(20000);
    expect(window.text.length).toBe(12000);
  });

  it("anchors the window on the learner's selected passage near the chapter end", () => {
    const head = "h".repeat(15000);
    const focus = "SELECTED-PASSAGE";
    const text = head + focus + "t".repeat(8000);
    const window = selectSourceWindow({ chapterText: text, focus, cap: 12000 });
    expect(window.start).toBeGreaterThan(0);
    expect(window.text).toContain(focus);
    expect(window.end).toBe(text.length);
  });

  it("falls back to the head window when the focus is not part of the chapter", () => {
    const text = "x".repeat(20000);
    const window = selectSourceWindow({ chapterText: text, focus: "not in chapter", cap: 12000 });
    expect(window.start).toBe(0);
    expect(window.end).toBe(12000);
  });

  it("states partial coverage in the prompt and leaves the default path untouched", () => {
    const windowed = buildTeachingPrompt({
      bookTitle: "B",
      chapterTitle: "C",
      chapterText: "a".repeat(20000),
      action: "learn",
      sourceWindow: { text: "z".repeat(4000), start: 16000, end: 20000, total: 20000 },
    });
    expect(windowed.user).toContain("z".repeat(50));
    expect(windowed.user).toContain("NOT included");

    const plain = buildTeachingPrompt({
      bookTitle: "B",
      chapterTitle: "C",
      chapterText: "a".repeat(20000),
      action: "learn",
    });
    expect(plain.user).toContain("a".repeat(50));
    expect(plain.user).not.toContain("NOT included");
  });
});

describe("LEARN-01 teaching help", () => {
  const stuckRequest: TeachingHelpRequest = {
    kind: "stuck",
    note: "不懂回撤为什么按天算",
  };

  it("builds a help prompt without the check question or its answer key", () => {
    const prompt = buildTeachingHelpPrompt({
      bookTitle: "量化入门",
      chapterTitle: "第1章",
      chapterText: "text",
      learningLanguage: "zh-CN",
      help: stuckRequest,
      originalExplanation: CONTENT.explanation,
      originalExample: CONTENT.workedExample,
      learnerContext: "3 prior attempt(s)",
    });
    const whole = `${prompt.system}\n${prompt.user}`;
    expect(prompt.user).toContain(CONTENT.explanation.slice(0, 20));
    expect(prompt.user).toContain("不懂回撤为什么按天算");
    expect(prompt.user).toContain("3 prior attempt(s)");
    expect(prompt.system).toContain("简体中文");
    // The pending check must never reach the help call — the help cannot then
    // leak or replace the answer. (The question text and the JSON key are the
    // distinctive markers; option prose may legitimately overlap explanation
    // wording.)
    expect(whole).not.toContain(CONTENT.check.prompt);
    expect(whole).not.toContain("correctIndex");
  });

  it("validates the help draft fail-closed", () => {
    expect(() => validateTeachingHelpContent({ explanation: "短" })).toThrow();
    expect(
      validateTeachingHelpContent({
        explanation: "这是一段足够长的解释，可以接受为有效的帮助输出。",
        example: " ",
      }),
    ).toEqual({
      explanation: "这是一段足够长的解释，可以接受为有效的帮助输出。",
      example: null,
    });
  });

  it("attaches a bounded variant without touching the check, evidence, mastery, or schedule", async () => {
    const llm = spyLlm(bothReply);
    const { deps, stores } = createDeps(llm);
    const conceptId = "readany:book:b1:chapter:0";
    let session = await deliverOnce(deps);
    const originalCheck = session.steps[0].content?.check;

    session = await requestTeachingHelp(deps, {
      bookTitle: "量化入门",
      session,
      help: { kind: "simpler", note: null },
    });

    const variants = session.steps[0].helpVariants ?? [];
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ kind: "simpler", note: null });
    expect(variants[0].text).toContain("心电图");
    // The issued question and its key are byte-identical.
    expect(session.steps[0].content?.check).toEqual(originalCheck);
    // Help is not a practice record: no evidence, no mastery, no review card.
    expect(stores.events()).toHaveLength(0);
    expect(await deps.mastery.get(conceptId)).toBeNull();
    expect(await deps.reviews.getCard(conceptId)).toBeNull();

    for (let i = 0; i < TEACHING_HELP_VARIANTS_MAX + 1; i += 1) {
      session = await requestTeachingHelp(deps, {
        bookTitle: "量化入门",
        session,
        help: { kind: "example", note: null },
      });
    }
    const bounded = session.steps[0].helpVariants ?? [];
    expect(bounded).toHaveLength(TEACHING_HELP_VARIANTS_MAX);
    expect(bounded[bounded.length - 1].kind).toBe("example");
  });

  it("refuses help before content is delivered and after the step is answered", async () => {
    const llm = spyLlm(bothReply);
    const { deps } = createDeps(llm);
    const session = await import("./teaching-engine").then((m) =>
      m.startTeachingSession(deps, curriculum()),
    );
    await expect(
      requestTeachingHelp(deps, { bookTitle: "B", session, help: stuckRequest }),
    ).rejects.toThrow("Deliver the step content");

    const delivered = await deliverCurrentStep(deps, session, "B");
    await answerCurrentStep(deps, delivered, 1);
    // The snapshot is both answered AND advanced; either refusal message is
    // correct (stale-session refusal takes precedence, before any LLM call).
    await expect(
      requestTeachingHelp(deps, { bookTitle: "B", session: delivered, help: stuckRequest }),
    ).rejects.toThrow(/already answered|no longer current/);
  });

  it("never writes a late help variant over an answered or advanced step", async () => {
    const llm = spyLlm(bothReply);
    const { deps, stores } = createDeps(llm);
    const session = await deliverOnce(deps);
    llm.gate = {
      promise: new Promise<void>((resolve) => {
        (llm as unknown as { __release?: () => void }).__release = resolve;
      }),
      release: () => (llm as unknown as { __release?: () => void }).__release?.(),
    };

    const pending = requestTeachingHelp(deps, {
      bookTitle: "量化入门",
      session,
      help: stuckRequest,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // While the help call is in flight the learner answers the step; the late
    // response must not attach to the answered (or a later) step.
    await answerCurrentStep(deps, session, 1);
    llm.gate.release();
    const returned = await pending;
    expect(returned.steps[0].helpVariants ?? []).toHaveLength(0);
    expect(stores.events()).toHaveLength(1);
  });
});

describe("LEARN-01 panel-state help isolation", () => {
  const answered = {
    session: {
      id: "s1",
      goalId: "g1",
      bookId: "b1",
      status: "active" as const,
      steps: [],
      currentIndex: 1,
      startedAt: 1,
      completedAt: null,
    },
    correct: false,
    explanation: "因为…",
    answeredStep: {
      conceptId: "c0",
      title: "T",
      action: "learn" as const,
      content: CONTENT,
      answered: true,
      correct: false,
    },
    answeredContent: CONTENT,
  };

  it("keeps the teaching view and verdict while help is loading or failing", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, {
      type: "TEACHING_ANSWERED",
      ...answered,
    });
    state = learnerPanelReducer(state, { type: "TEACHING_HELP_REQUEST" });
    expect(state.helpPhase).toBe("loading");
    expect(state.teachingPhase).toBe("active");
    expect(state.lastStepAnswer).toEqual({ correct: false, explanation: "因为…" });

    state = learnerPanelReducer(state, { type: "TEACHING_HELP_FAILED", error: "模型失败" });
    expect(state.helpPhase).toBe("error");
    expect(state.helpError).toBe("模型失败");
    // The teaching content stays readable; the teaching flow was never clobbered.
    expect(state.teachingPhase).toBe("active");
    expect(state.teachingError).toBeNull();
    expect(state.lastStepAnswer).toEqual({ correct: false, explanation: "因为…" });
  });

  it("applies a delivered help variant to the session without touching the flow", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, {
      type: "TEACHING_ANSWERED",
      ...answered,
    });
    const helpedSession = {
      ...answered.session,
      steps: [
        {
          conceptId: "c0",
          title: "T",
          action: "learn" as const,
          content: CONTENT,
          answered: true,
          correct: false,
          helpVariants: [
            {
              id: "v1",
              kind: "simpler" as const,
              note: null,
              text: "更简单",
              example: null,
              createdAt: 1,
              source: null,
            },
          ],
        },
      ],
    };
    state = learnerPanelReducer(state, { type: "TEACHING_HELP_DELIVERED", session: helpedSession });
    expect(state.helpPhase).toBe("idle");
    expect(state.teaching?.steps[0].helpVariants).toHaveLength(1);
    expect(state.teachingPhase).toBe("active");
    expect(state.lastStepAnswer).toEqual({ correct: false, explanation: "因为…" });
  });

  it("resets help state when a new step is delivered or the book changes", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, { type: "TEACHING_HELP_REQUEST" });
    state = learnerPanelReducer(state, { type: "BOOK_CHANGED", bookId: "b2" });
    expect(state.helpPhase).toBe("idle");
    expect(state.helpError).toBeNull();

    state = learnerPanelReducer(initialLearnerPanelState, {
      type: "TEACHING_HELP_FAILED",
      error: "x",
    });
    state = learnerPanelReducer(state, { type: "TEACHING_DELIVERED", session: answered.session });
    expect(state.helpPhase).toBe("idle");
    expect(state.helpError).toBeNull();
  });
});
