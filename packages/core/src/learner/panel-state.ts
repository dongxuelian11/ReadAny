// Reducer for the Reader Learner panel (PR-007): the placement flow, the
// per-chapter mastery view, and the due-review view. Every phase must be
// designed (loading / empty / error / active / completed) and the panel
// renders only from this state. Deterministic and UI-free — the component
// supplies sessions/verdicts produced by the app triggers over the core
// engine.

import type { PlacementItem, PlacementSession, PlacementVerdict } from "./placement";
import { nextPlacementItem } from "./placement-engine";
import type { ConceptMastery, MasteryStatus } from "./types";

export type LearnerTab = "placement" | "mastery" | "review";

export type LearnerPlacementPhase =
  | "idle"
  | "starting"
  | "active"
  | "finalizing"
  | "completed"
  | "error"
  | "unavailable";

export type LearnerListPhase = "idle" | "loading" | "ready" | "error";

export interface LearnerMasteryRow {
  conceptId: string;
  title: string;
  mastery: ConceptMastery | null;
}

export interface LearnerDueRow {
  conceptId: string;
  due: number;
  title: string | null;
  mastery: number | null;
  status: MasteryStatus | null;
}

export interface LearnerPanelState {
  tab: LearnerTab;
  bookId: string | null;
  // Placement flow
  placementPhase: LearnerPlacementPhase;
  session: PlacementSession | null;
  /** The judgement shown after answering the current item (cleared on continue). */
  lastAnswer: { correct: boolean; explanation: string } | null;
  verdict: PlacementVerdict | null;
  error: string | null;
  // Mastery + review lists
  masteryPhase: LearnerListPhase;
  masteryRows: LearnerMasteryRow[];
  reviewPhase: LearnerListPhase;
  dueRows: LearnerDueRow[];
}

export type LearnerPanelAction =
  | { type: "BOOK_CHANGED"; bookId: string }
  | { type: "TAB_CHANGED"; tab: LearnerTab }
  | { type: "PLACEMENT_START" }
  | { type: "PLACEMENT_SESSION"; session: PlacementSession }
  | { type: "PLACEMENT_ANSWERED"; session: PlacementSession; correct: boolean; explanation: string }
  | { type: "PLACEMENT_CONTINUE" }
  | { type: "PLACEMENT_FINALIZING" }
  | { type: "PLACEMENT_COMPLETED"; verdict: PlacementVerdict }
  | { type: "PLACEMENT_ERROR"; error: string }
  | { type: "PLACEMENT_UNAVAILABLE"; error: string }
  | { type: "MASTERY_LOADING" }
  | { type: "MASTERY_READY"; rows: LearnerMasteryRow[] }
  | { type: "MASTERY_ERROR"; error: string }
  | { type: "REVIEW_LOADING" }
  | { type: "REVIEW_READY"; rows: LearnerDueRow[] }
  | { type: "REVIEW_ERROR"; error: string };

export const initialLearnerPanelState: LearnerPanelState = {
  tab: "placement",
  bookId: null,
  placementPhase: "idle",
  session: null,
  lastAnswer: null,
  verdict: null,
  error: null,
  masteryPhase: "idle",
  masteryRows: [],
  reviewPhase: "idle",
  dueRows: [],
};

/** The item the CAT wants next, or null when the stop rules are satisfied. */
export function currentPlacementItem(state: LearnerPanelState): PlacementItem | null {
  if (state.placementPhase !== "active" || !state.session) return null;
  return nextPlacementItem(state.session);
}

export function learnerPanelReducer(
  state: LearnerPanelState,
  action: LearnerPanelAction,
): LearnerPanelState {
  switch (action.type) {
    case "BOOK_CHANGED":
      if (state.bookId === action.bookId) return state;
      return { ...initialLearnerPanelState, bookId: action.bookId, tab: state.tab };
    case "TAB_CHANGED":
      return { ...state, tab: action.tab };
    case "PLACEMENT_START":
      return {
        ...state,
        placementPhase: "starting",
        session: null,
        lastAnswer: null,
        verdict: null,
        error: null,
      };
    case "PLACEMENT_SESSION":
      return {
        ...state,
        placementPhase: "active",
        session: action.session,
        lastAnswer: null,
        verdict: null,
      };
    case "PLACEMENT_ANSWERED":
      return {
        ...state,
        placementPhase: "active",
        session: action.session,
        lastAnswer: { correct: action.correct, explanation: action.explanation },
      };
    case "PLACEMENT_CONTINUE":
      return { ...state, lastAnswer: null };
    case "PLACEMENT_FINALIZING":
      return { ...state, placementPhase: "finalizing", lastAnswer: null };
    case "PLACEMENT_COMPLETED":
      return {
        ...state,
        placementPhase: "completed",
        verdict: action.verdict,
        session: null,
        lastAnswer: null,
      };
    case "PLACEMENT_ERROR":
      return { ...state, placementPhase: "error", error: action.error };
    case "PLACEMENT_UNAVAILABLE":
      return { ...state, placementPhase: "unavailable", error: action.error };
    case "MASTERY_LOADING":
      return { ...state, masteryPhase: "loading", error: null };
    case "MASTERY_READY":
      return { ...state, masteryPhase: "ready", masteryRows: action.rows };
    case "MASTERY_ERROR":
      return { ...state, masteryPhase: "error", error: action.error };
    case "REVIEW_LOADING":
      return { ...state, reviewPhase: "loading", error: null };
    case "REVIEW_READY":
      return { ...state, reviewPhase: "ready", dueRows: action.rows };
    case "REVIEW_ERROR":
      return { ...state, reviewPhase: "error", error: action.error };
    default:
      return state;
  }
}
