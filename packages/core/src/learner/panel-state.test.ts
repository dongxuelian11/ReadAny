import { describe, expect, it } from "vitest";
import { currentPlacementItem, initialLearnerPanelState, learnerPanelReducer } from "./panel-state";
import type { PlacementItem, PlacementSession, PlacementVerdict } from "./placement";

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
    expect(state.tab).toBe("placement");
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
});
