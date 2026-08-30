import { describe, expect, it } from "vitest";
import {
  DEPTH_FLOOR,
  type GoalChapterTarget,
  type GoalSpec,
  buildCurriculum,
  classifyGap,
} from "./goal";
import type { LearnerConceptState } from "./goal";
import { buildGoalParsePrompt, parseGoal, toGoalSpec, validateGoalParse } from "./goal-parse";
import { createInMemoryGoalStore, putGoalWithSupersession } from "./goal-store";

function target(conceptId: string, depth: GoalChapterTarget["depth"]): GoalChapterTarget {
  return { conceptId, title: conceptId, depth };
}

function learner(overrides?: Partial<LearnerConceptState>): LearnerConceptState {
  return {
    mastery: 0.5,
    status: "learning",
    evidenceCount: 2,
    lastVerified: 1,
    ...overrides,
  };
}

function goal(chapters: GoalChapterTarget[]): GoalSpec {
  return {
    goalId: "g1",
    bookId: "b1",
    goalText: "read the statistics book",
    restatedGoal: "work through the statistics book",
    targetCapabilities: ["reason about samples"],
    chapters,
    milestones: [],
    completionCriteria: [],
    createdAt: 1,
    active: true,
  };
}

const CHAPTERS = [
  { conceptId: "readany:book:b1:chapter:0", title: "第1章" },
  { conceptId: "readany:book:b1:chapter:1", title: "第2章" },
  { conceptId: "readany:book:b1:chapter:2", title: "第3章" },
];

describe("knowledge gap classification (deterministic)", () => {
  it("treats missing learner state and placement-only estimates as missing", () => {
    expect(classifyGap(target("c1", "working"), null).kind).toBe("missing");
    expect(
      classifyGap(target("c1", "working"), learner({ evidenceCount: 0, lastVerified: null })).kind,
    ).toBe("missing");
  });

  it("classifies lapsed before depth checks", () => {
    const entry = classifyGap(
      target("c1", "familiar"),
      learner({ status: "needs_review", mastery: 0.9 }),
    );
    expect(entry.kind).toBe("lapsed");
  });

  it("satisfies only stable mastery at or above the depth floor", () => {
    expect(
      classifyGap(target("c1", "working"), learner({ status: "stable", mastery: 0.7 })).kind,
    ).toBe("satisfied");
    expect(
      classifyGap(target("c1", "mastery"), learner({ status: "stable", mastery: 0.7 })).kind,
    ).toBe("partial");
    expect(
      classifyGap(
        target("c1", "familiar"),
        learner({ status: "stable", mastery: DEPTH_FLOOR.familiar }),
      ).kind,
    ).toBe("satisfied");
    // Stable but below floor → partial.
    expect(
      classifyGap(target("c1", "working"), learner({ status: "stable", mastery: 0.5 })).kind,
    ).toBe("partial");
    // Learning with high mastery (never verified stable) → partial.
    expect(
      classifyGap(target("c1", "familiar"), learner({ status: "learning", mastery: 0.95 })).kind,
    ).toBe("partial");
  });

  it("carries the learner mastery into the entry", () => {
    expect(classifyGap(target("c1", "working"), learner({ mastery: 0.42 })).mastery).toBe(0.42);
    expect(classifyGap(target("c1", "working"), null).mastery).toBeNull();
  });
});

describe("personal curriculum builder (deterministic)", () => {
  it("preserves book order, maps kinds to actions, skips satisfied chapters", () => {
    const g = goal([target("c2", "working"), target("c0", "familiar"), target("c1", "mastery")]);
    const entries = [
      classifyGap(g.chapters[0], learner({ mastery: 0.5 })), // c2 partial → learn
      classifyGap(g.chapters[1], learner({ status: "stable", mastery: 0.5 })), // c0 familiar satisfied → skipped
      classifyGap(g.chapters[2], learner({ status: "needs_review", mastery: 0.6 })), // c1 lapsed → review
    ];
    const curriculum = buildCurriculum(g, entries, 100);
    expect(curriculum.steps.map((step) => step.conceptId)).toEqual(["c2", "c1"]);
    expect(curriculum.steps.map((step) => step.action)).toEqual(["learn", "review"]);
    expect(curriculum.steps[0].index).toBe(0);
    expect(curriculum.satisfiedCount).toBe(1);
    expect(curriculum.gapCount).toBe(2);
    expect(curriculum.builtAt).toBe(100);
    expect(curriculum.steps[1].reason).toContain("retention lapsed");
  });

  it("emits an empty curriculum when everything is satisfied", () => {
    const g = goal([target("c0", "familiar")]);
    const entries = [classifyGap(g.chapters[0], learner({ status: "stable", mastery: 0.6 }))];
    const curriculum = buildCurriculum(g, entries, 1);
    expect(curriculum.steps).toHaveLength(0);
    expect(curriculum.satisfiedCount).toBe(1);
  });
});

describe("goal parsing boundary (LLM drafts, code validates)", () => {
  it("builds a prompt with the chapter list and the closed depth vocabulary", () => {
    const prompt = buildGoalParsePrompt({
      goalText: "看懂量化论文",
      bookTitle: "极简统计学",
      chapters: CHAPTERS,
    });
    expect(prompt.system).toContain("Never invent ids");
    expect(prompt.system).toContain("familiar|working|mastery");
    expect(prompt.user).toContain("readany:book:b1:chapter:1 — 第2章");
    expect(prompt.user).toContain("看懂量化论文");
  });

  it("validates, drops unresolvable chapter ids, and preserves book order", () => {
    const draft = validateGoalParse(
      {
        restatedGoal: "理解统计基础",
        targetCapabilities: ["读懂图表", "理解抽样"],
        requiredChapters: [
          { conceptId: "readany:book:b1:chapter:2", depth: "working" },
          { conceptId: "readany:book:b1:chapter:999", depth: "mastery" },
          { conceptId: "readany:book:b1:chapter:0", depth: "familiar" },
        ],
        milestones: ["完成前两章"],
        completionCriteria: ["正确率 >= 80%"],
      },
      CHAPTERS,
    );
    expect(draft.droppedChapterIds).toEqual(["readany:book:b1:chapter:999"]);
    expect(draft.requiredChapters.map((chapter) => chapter.conceptId)).toEqual([
      "readany:book:b1:chapter:0",
      "readany:book:b1:chapter:2",
    ]);
    // Unknown depth falls back to working.
    expect(
      validateGoalParse(
        {
          restatedGoal: "x",
          requiredChapters: [{ conceptId: CHAPTERS[0].conceptId, depth: "expert" }],
        },
        CHAPTERS,
      ).requiredChapters[0].depth,
    ).toBe("working");
  });

  it("fails closed on empty restatement or zero surviving chapters", () => {
    expect(() => validateGoalParse({ restatedGoal: "", requiredChapters: [] }, CHAPTERS)).toThrow();
    expect(() =>
      validateGoalParse(
        { restatedGoal: "x", requiredChapters: [{ conceptId: "bogus", depth: "working" }] },
        CHAPTERS,
      ),
    ).toThrow("zero valid chapters");
  });

  it("retries a malformed model reply once, then fails with the last error", async () => {
    let calls = 0;
    const flaky = {
      async complete() {
        calls += 1;
        if (calls === 1) return "我不是 JSON";
        return JSON.stringify({
          restatedGoal: "r",
          requiredChapters: [{ conceptId: CHAPTERS[0].conceptId, depth: "familiar" }],
        });
      },
    };
    const parsed = await parseGoal({
      goalText: "g",
      bookTitle: "b",
      chapters: CHAPTERS,
      llm: flaky,
    });
    expect(calls).toBe(2);
    expect(parsed.requiredChapters).toHaveLength(1);

    const alwaysBroken = {
      async complete() {
        calls += 1;
        return JSON.stringify({
          restatedGoal: "r",
          requiredChapters: [{ conceptId: "bogus", depth: "working" }],
        });
      },
    };
    await expect(
      parseGoal({ goalText: "g", bookTitle: "b", chapters: CHAPTERS, llm: alwaysBroken }),
    ).rejects.toThrow("zero valid chapters");
  });

  it("assembles a persisted GoalSpec from a validated parse", () => {
    const parse = validateGoalParse(
      {
        restatedGoal: "r",
        targetCapabilities: ["a"],
        requiredChapters: [{ conceptId: CHAPTERS[1].conceptId, depth: "mastery" }],
        milestones: ["m"],
        completionCriteria: ["c"],
      },
      CHAPTERS,
    );
    const spec = toGoalSpec({
      parse,
      goalId: "g9",
      bookId: "b1",
      goalText: "原始目标",
      createdAt: 42,
    });
    expect(spec).toMatchObject({
      goalId: "g9",
      bookId: "b1",
      goalText: "原始目标",
      active: true,
      createdAt: 42,
    });
    expect(spec.chapters[0].title).toBe("第2章");
  });
});

describe("goal store supersession invariant", () => {
  it("deactivates the previous active goal of the same book on activate", async () => {
    const store = createInMemoryGoalStore();
    const first = { ...goal([target("c0", "working")]), goalId: "g1", createdAt: 1 };
    await putGoalWithSupersession(store, first);
    expect((await store.getActive("b1"))?.goalId).toBe("g1");

    const second = { ...goal([target("c1", "working")]), goalId: "g2", createdAt: 2 };
    await putGoalWithSupersession(store, second);
    expect((await store.getActive("b1"))?.goalId).toBe("g2");
    expect((await store.get("g1"))?.active).toBe(false);
    // History retained.
    expect((await store.listByBook("b1")).map((entry) => entry.goalId)).toEqual(["g2", "g1"]);
    // Another book's active goal is untouched.
    const other = { ...goal([target("c0", "working")]), goalId: "g3", bookId: "b2", createdAt: 3 };
    await putGoalWithSupersession(store, other);
    expect((await store.getActive("b1"))?.goalId).toBe("g2");
    expect((await store.getActive("b2"))?.goalId).toBe("g3");
  });
});
