import { describe, expect, it } from "vitest";
import type { GoalSpec, PersonalCurriculum } from "./goal";
import {
  currentPlacementItem,
  currentTeachingStepView,
  initialLearnerPanelState,
  learnerPanelReducer,
} from "./panel-state";
import type { PlacementItem, PlacementSession, PlacementVerdict } from "./placement";
import type { TeachingSession } from "./teaching";

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

function session(
  items: PlacementItem[],
  responses: PlacementSession["responses"] = [],
): PlacementSession {
  return {
    id: "s1",
    status: "active",
    theta: 0.5,
    startedAt: 0,
    finalizedAt: null,
    items,
    responses,
  };
}

const verdict: PlacementVerdict = {
  sessionId: "s1",
  questionsAsked: 6,
  correct: 4,
  theta: 0.62,
  standardError: 0.13,
  conceptsAssessed: 9,
  masteryWritten: 9,
  perConcept: [],
};

const goal: GoalSpec = {
  goalId: "g1",
  bookId: "b1",
  goalText: "master the book",
  restatedGoal: "Master the core chapters",
  targetCapabilities: ["apply the mean"],
  chapters: [{ conceptId: "concept-a", title: "Ch1", depth: "working" }],
  milestones: [],
  completionCriteria: [],
  createdAt: 0,
  active: true,
};

const curriculum: PersonalCurriculum = {
  goalId: "g1",
  bookId: "b1",
  steps: [
    {
      conceptId: "concept-a",
      title: "Ch1",
      depth: "working",
      action: "learn",
      reason: "r",
      index: 0,
    },
  ],
  satisfiedCount: 0,
  gapCount: 1,
  builtAt: 0,
};

const teachingContent = {
  explanation: "A grounded explanation of the chapter.",
  keyPoints: ["point one", "point two"],
  workedExample: null,
  check: {
    prompt: "check?",
    options: ["a", "b", "c", "d"],
    correctIndex: 1,
    explanation: "b is right",
  },
};

function activeTeaching(): TeachingSession {
  return {
    id: "t1",
    goalId: "g1",
    bookId: "b1",
    status: "active",
    steps: [
      {
        conceptId: "concept-a",
        title: "Ch1",
        action: "learn",
        content: teachingContent,
        answered: false,
        correct: null,
      },
      {
        conceptId: "concept-b",
        title: "Ch2",
        action: "learn",
        content: null,
        answered: false,
        correct: null,
      },
    ],
    currentIndex: 0,
    startedAt: 0,
    completedAt: null,
  };
}

function advanceTeaching(session: TeachingSession, correct: boolean): TeachingSession {
  const steps = session.steps.map((step, index) =>
    index === session.currentIndex ? { ...step, answered: true, correct } : step,
  );
  const currentIndex = session.currentIndex + 1;
  return {
    ...session,
    steps,
    currentIndex,
    status: currentIndex >= steps.length ? "completed" : "active",
    completedAt: currentIndex >= steps.length ? 1 : null,
  };
}

describe("learner panel state", () => {
  it("resets on book change but keeps the tab", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, {
      type: "TAB_CHANGED",
      tab: "review",
    });
    state = learnerPanelReducer(state, {
      type: "PLACEMENT_SESSION",
      session: session([item("a", 0.4)]),
    });
    state = learnerPanelReducer(state, { type: "BOOK_CHANGED", bookId: "b2" });
    expect(state.bookId).toBe("b2");
    expect(state.tab).toBe("review");
    expect(state.placementPhase).toBe("idle");
    expect(state.session).toBeNull();
    // Same book id → no reset (panel stays put).
    const kept = learnerPanelReducer(state, { type: "BOOK_CHANGED", bookId: "b2" });
    expect(kept).toBe(state);
  });

  it("walks the placement flow: start → session → answer → continue → finalize", () => {
    const items = [item("a", 0.2), item("b", 0.9)];
    let state = learnerPanelReducer(initialLearnerPanelState, { type: "PLACEMENT_START" });
    expect(state.placementPhase).toBe("starting");

    state = learnerPanelReducer(state, { type: "PLACEMENT_SESSION", session: session(items) });
    expect(state.placementPhase).toBe("active");
    expect(currentPlacementItem(state)?.id).toBe("a"); // closest to theta 0.5

    state = learnerPanelReducer(state, {
      type: "PLACEMENT_ANSWERED",
      session: session(items, [
        { itemId: "a", conceptId: "concept-a", correct: true, difficulty: 0.2 },
      ]),
      correct: true,
      explanation: "right",
    });
    expect(state.lastAnswer).toEqual({ correct: true, explanation: "right" });
    // Judged state: the answered item is no longer "next"; next is b.
    expect(currentPlacementItem(state)?.id).toBe("b");

    state = learnerPanelReducer(state, { type: "PLACEMENT_CONTINUE" });
    expect(state.lastAnswer).toBeNull();

    state = learnerPanelReducer(state, { type: "PLACEMENT_FINALIZING" });
    expect(state.placementPhase).toBe("finalizing");
    state = learnerPanelReducer(state, { type: "PLACEMENT_COMPLETED", verdict });
    expect(state.placementPhase).toBe("completed");
    expect(state.verdict?.theta).toBe(0.62);
    expect(state.session).toBeNull();
  });

  it("surfaces stop-rule completion: when the CAT stops, no current item is offered", () => {
    const items = [item("a", 0.2), item("b", 0.9), item("c", 0.2), item("d", 0.9), item("e", 0.2)];
    const answered = items.map((entry, i) => ({
      itemId: entry.id,
      conceptId: entry.conceptId,
      correct: i % 2 === 0,
      difficulty: entry.difficulty,
    }));
    const stopped = session(items, answered);
    let state = learnerPanelReducer(initialLearnerPanelState, {
      type: "PLACEMENT_SESSION",
      session: stopped,
    });
    expect(currentPlacementItem(state)).toBeNull();
    state = learnerPanelReducer(state, { type: "PLACEMENT_FINALIZING" });
    state = learnerPanelReducer(state, { type: "PLACEMENT_COMPLETED", verdict });
    expect(state.placementPhase).toBe("completed");
  });

  it("designs the error and unavailable states without losing the tab", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, {
      type: "PLACEMENT_ERROR",
      error: "boom",
    });
    expect(state.placementPhase).toBe("error");
    expect(state.error).toBe("boom");
    state = learnerPanelReducer(state, { type: "PLACEMENT_UNAVAILABLE", error: "no endpoint" });
    expect(state.placementPhase).toBe("unavailable");
    expect(state.tab).toBe("goal");
  });

  it("designs the mastery and review list states", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, { type: "MASTERY_LOADING" });
    expect(state.masteryPhase).toBe("loading");
    state = learnerPanelReducer(state, {
      type: "MASTERY_READY",
      rows: [{ conceptId: "c1", title: "Ch1", mastery: null }],
    });
    expect(state.masteryPhase).toBe("ready");
    expect(state.masteryRows[0].title).toBe("Ch1");
    state = learnerPanelReducer(state, { type: "MASTERY_ERROR", error: "db" });
    expect(state.masteryPhase).toBe("error");

    state = learnerPanelReducer(state, { type: "REVIEW_LOADING" });
    expect(state.reviewPhase).toBe("loading");
    state = learnerPanelReducer(state, {
      type: "REVIEW_READY",
      rows: [{ conceptId: "c1", due: 1, title: "Ch1", mastery: 0.7, status: "stable" }],
    });
    expect(state.reviewPhase).toBe("ready");
    expect(state.dueRows).toHaveLength(1);
  });

  it("defaults to the goal tab (the workspace entry) and keeps it across resets", () => {
    expect(initialLearnerPanelState.tab).toBe("goal");
    let state = learnerPanelReducer(initialLearnerPanelState, {
      type: "GOAL_READY",
      goal: goal,
      curriculum: curriculum,
      teaching: null,
    });
    state = learnerPanelReducer(state, { type: "BOOK_CHANGED", bookId: "b2" });
    expect(state.tab).toBe("goal");
    expect(state.goalPhase).toBe("idle");
    expect(state.goal).toBeNull();
  });

  it("walks the goal flow: loading → empty → creating → created (teaching reset)", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, { type: "GOAL_LOADING" });
    expect(state.goalPhase).toBe("loading");

    state = learnerPanelReducer(state, { type: "GOAL_EMPTY" });
    expect(state.goalPhase).toBe("empty");
    expect(state.goal).toBeNull();

    state = learnerPanelReducer(state, { type: "TEACHING_DELIVERED", session: activeTeaching() });
    expect(state.teachingPhase).toBe("active");

    state = learnerPanelReducer(state, { type: "GOAL_CREATING" });
    expect(state.goalPhase).toBe("creating");

    state = learnerPanelReducer(state, {
      type: "GOAL_CREATED",
      goal: goal,
      curriculum: curriculum,
    });
    expect(state.goalPhase).toBe("ready");
    expect(state.goal?.goalId).toBe("g1");
    // A new goal supersedes the old session: teaching resets to idle.
    expect(state.teaching).toBeNull();
    expect(state.teachingPhase).toBe("idle");
  });

  it("walks the teaching flow: start → delivered → answered → next → completed", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, {
      type: "GOAL_READY",
      goal: goal,
      curriculum: curriculum,
      teaching: null,
    });
    state = learnerPanelReducer(state, { type: "TEACHING_STARTING" });
    expect(state.teachingPhase).toBe("starting");

    state = learnerPanelReducer(state, { type: "TEACHING_DELIVERING" });
    expect(state.teachingPhase).toBe("delivering");

    state = learnerPanelReducer(state, { type: "TEACHING_DELIVERED", session: activeTeaching() });
    expect(state.teachingPhase).toBe("active");
    const view = currentTeachingStepView(state);
    expect(view?.step.conceptId).toBe("concept-a");
    expect(view?.content.check.prompt).toBe("check?");

    state = learnerPanelReducer(state, { type: "TEACHING_ANSWERING" });
    expect(state.teachingPhase).toBe("answering");

    const advanced = advanceTeaching(activeTeaching(), false);
    state = learnerPanelReducer(state, {
      type: "TEACHING_ANSWERED",
      session: advanced,
      correct: false,
      explanation: "why not",
    });
    expect(state.teachingPhase).toBe("active");
    expect(state.lastStepAnswer).toEqual({ correct: false, explanation: "why not" });
    expect(state.teaching?.currentIndex).toBe(1);

    // Delivering the next step dismisses the previous verdict.
    state = learnerPanelReducer(state, { type: "TEACHING_DELIVERING" });
    state = learnerPanelReducer(state, { type: "TEACHING_DELIVERED", session: advanced });
    expect(state.teachingPhase).toBe("active");
    expect(state.lastStepAnswer).toBeNull();

    const completed = advanceTeaching(advanced, true);
    state = learnerPanelReducer(state, {
      type: "TEACHING_ANSWERED",
      session: completed,
      correct: true,
      explanation: "why",
    });
    expect(state.teachingPhase).toBe("completed");
    expect(state.teaching?.status).toBe("completed");
    // A completed session offers no live step view.
    expect(currentTeachingStepView(state)).toBeNull();
  });

  it("resumes an active teaching session through GOAL_READY and isolates teaching errors", () => {
    let state = learnerPanelReducer(initialLearnerPanelState, {
      type: "GOAL_READY",
      goal: goal,
      curriculum: curriculum,
      teaching: activeTeaching(),
    });
    expect(state.goalPhase).toBe("ready");
    expect(state.teachingPhase).toBe("active");
    expect(currentTeachingStepView(state)?.content.check.prompt).toBe("check?");

    state = learnerPanelReducer(state, { type: "TEACHING_FAILED", error: "model down" });
    expect(state.teachingPhase).toBe("error");
    expect(state.teachingError).toBe("model down");
    // The goal itself is untouched by a teaching failure.
    expect(state.goalPhase).toBe("ready");
    expect(state.goal?.goalId).toBe("g1");
  });
});
