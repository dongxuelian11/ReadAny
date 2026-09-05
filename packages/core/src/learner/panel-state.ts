// Reducer for the Reader Learner panel (PR-007): the placement flow, the
// per-chapter mastery view, and the due-review view. Every phase must be
// designed (loading / empty / error / active / completed) and the panel
// renders only from this state. Deterministic and UI-free — the component
// supplies sessions/verdicts produced by the app triggers over the core
// engine.

import type { GoalSpec, PersonalCurriculum } from "./goal";
import type { PlacementItem, PlacementSession, PlacementVerdict } from "./placement";
import { nextPlacementItem } from "./placement-engine";
import type { TeachingContent, TeachingSession, TeachingStep } from "./teaching";
import { currentTeachingStep } from "./teaching";
import type { ConceptMastery, MasteryStatus } from "./types";

export type LearnerTab = "goal" | "placement" | "mastery" | "review";

export type LearnerPlacementPhase =
  | "idle"
  | "starting"
  | "active"
  | "finalizing"
  | "completed"
  | "error"
  | "unavailable";

export type LearnerListPhase = "idle" | "loading" | "ready" | "error";

/** Goal workspace phases (PR-016): every state is designed; the panel renders
 * only from this state. */
export type LearnerGoalPhase = "idle" | "loading" | "empty" | "creating" | "ready" | "error";

/** Guided-teaching phases within the goal workspace (PR-016). */
export type LearnerTeachingPhase =
  | "idle"
  | "starting"
  | "delivering"
  | "active"
  | "answering"
  | "completed"
  | "error";

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
  // Goal workspace (PR-016)
  goalPhase: LearnerGoalPhase;
  goal: GoalSpec | null;
  curriculum: PersonalCurriculum | null;
  teachingPhase: LearnerTeachingPhase;
  teaching: TeachingSession | null;
  lastStepAnswer: { correct: boolean; explanation: string } | null;
  teachingError: string | null;
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
  | { type: "REVIEW_ERROR"; error: string }
  | { type: "GOAL_LOADING" }
  | { type: "GOAL_EMPTY" }
  | {
      type: "GOAL_READY";
      goal: GoalSpec;
      curriculum: PersonalCurriculum;
      teaching: TeachingSession | null;
    }
  | { type: "GOAL_CREATING" }
  | { type: "GOAL_CREATED"; goal: GoalSpec; curriculum: PersonalCurriculum }
  | { type: "GOAL_ERROR"; error: string }
  | { type: "TEACHING_STARTING" }
  | { type: "TEACHING_DELIVERING" }
  | { type: "TEACHING_DELIVERED"; session: TeachingSession }
  | { type: "TEACHING_ANSWERING" }
  | { type: "TEACHING_ANSWERED"; session: TeachingSession; correct: boolean; explanation: string }
  | { type: "TEACHING_FAILED"; error: string };

export const initialLearnerPanelState: LearnerPanelState = {
  tab: "goal",
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
  goalPhase: "idle",
  goal: null,
  curriculum: null,
  teachingPhase: "idle",
  teaching: null,
  lastStepAnswer: null,
  teachingError: null,
};

/** The item the CAT wants next, or null when the stop rules are satisfied. */
export function currentPlacementItem(state: LearnerPanelState): PlacementItem | null {
  if (state.placementPhase !== "active" || !state.session) return null;
  return nextPlacementItem(state.session);
}

/** The teaching step awaiting the learner's answer, with its delivered
 * content; null while delivering, unanswered-unsupplied, or between steps. */
export function currentTeachingStepView(
  state: LearnerPanelState,
): { step: TeachingStep; content: TeachingContent } | null {
  if (state.teachingPhase !== "active" || !state.teaching) return null;
  const step = currentTeachingStep(state.teaching);
  if (!step || !step.content) return null;
  return { step, content: step.content };
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
    case "GOAL_LOADING":
      return { ...state, goalPhase: "loading", error: null, teachingError: null };
    case "GOAL_EMPTY":
      return { ...state, goalPhase: "empty", goal: null, curriculum: null };
    case "GOAL_READY":
      return {
        ...state,
        goalPhase: "ready",
        goal: action.goal,
        curriculum: action.curriculum,
        teaching: action.teaching,
        teachingPhase: action.teaching?.status === "active" ? "active" : "idle",
        lastStepAnswer: null,
        teachingError: null,
        error: null,
      };
    case "GOAL_CREATING":
      return { ...state, goalPhase: "creating", error: null };
    case "GOAL_CREATED":
      // A new goal supersedes the old one; the old teaching session is gone
      // with it (the core abandoned it at supersession time).
      return {
        ...state,
        goalPhase: "ready",
        goal: action.goal,
        curriculum: action.curriculum,
        teaching: null,
        teachingPhase: "idle",
        lastStepAnswer: null,
        teachingError: null,
      };
    case "GOAL_ERROR":
      return { ...state, goalPhase: "error", error: action.error };
    case "TEACHING_STARTING":
      return {
        ...state,
        teachingPhase: "starting",
        lastStepAnswer: null,
        teachingError: null,
      };
    case "TEACHING_DELIVERING":
      return { ...state, teachingPhase: "delivering", teachingError: null };
    case "TEACHING_DELIVERED":
      return {
        ...state,
        teaching: action.session,
        teachingPhase: action.session.status === "completed" ? "completed" : "active",
        // The previous step's verdict belongs to the previous step; a freshly
        // delivered step must render its own content, not stale feedback.
        lastStepAnswer: null,
      };
    case "TEACHING_ANSWERING":
      return { ...state, teachingPhase: "answering", teachingError: null };
    case "TEACHING_ANSWERED":
      return {
        ...state,
        teaching: action.session,
        teachingPhase: action.session.status === "completed" ? "completed" : "active",
        lastStepAnswer: { correct: action.correct, explanation: action.explanation },
      };
    case "TEACHING_FAILED":
      return { ...state, teachingPhase: "error", teachingError: action.error };
    default:
      return state;
  }
}
