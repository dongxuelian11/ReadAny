// Reducer for the Reader Book Skill panel state machine (book-scoped, unlike
// the chapter-scoped PR-001 learning panel). Every phase must be designed
// (loading / empty / error / active / completed) and the panel renders only
// from this state.

import type { BookSkillCostEstimate } from "./estimate";
import type { BookSkillGenre, BookSkillProgress, BookSkillResult } from "./types";

export type BookSkillPanelPhase =
  | "idle"
  | "unavailable"
  | "estimating"
  | "estimate-ready"
  | "generating"
  | "ready"
  | "error";

export interface BookSkillPanelState {
  phase: BookSkillPanelPhase;
  bookId: string | null;
  genre: BookSkillGenre;
  estimate: BookSkillCostEstimate | null;
  progress: BookSkillProgress | null;
  result: BookSkillResult | null;
  error: string | null;
}

export type BookSkillPanelAction =
  | { type: "BOOK_CHANGED"; bookId: string }
  | { type: "UNAVAILABLE"; error: string }
  | { type: "ESTIMATE_LOADING" }
  | { type: "ESTIMATE_READY"; estimate: BookSkillCostEstimate }
  | { type: "GENRE_SELECTED"; genre: BookSkillGenre }
  | { type: "GENERATE_START" }
  | { type: "PROGRESS"; progress: BookSkillProgress }
  | { type: "COMPLETE"; result: BookSkillResult }
  | { type: "ERROR"; error: string }
  | { type: "REGENERATE" };

export const initialBookSkillPanelState: BookSkillPanelState = {
  phase: "idle",
  bookId: null,
  genre: "general",
  estimate: null,
  progress: null,
  result: null,
  error: null,
};

export function bookSkillPanelReducer(
  state: BookSkillPanelState,
  action: BookSkillPanelAction,
): BookSkillPanelState {
  switch (action.type) {
    case "BOOK_CHANGED":
      if (state.bookId === action.bookId && state.phase !== "idle") return state;
      return { ...initialBookSkillPanelState, bookId: action.bookId, genre: state.genre };
    case "UNAVAILABLE":
      return {
        ...initialBookSkillPanelState,
        bookId: state.bookId,
        genre: state.genre,
        phase: "unavailable",
        error: action.error,
      };
    case "ESTIMATE_LOADING":
      return { ...state, phase: "estimating", error: null, estimate: null };
    case "ESTIMATE_READY":
      return { ...state, phase: "estimate-ready", estimate: action.estimate };
    case "GENRE_SELECTED":
      return { ...state, genre: action.genre };
    case "GENERATE_START":
      return { ...state, phase: "generating", progress: null, error: null, result: null };
    case "PROGRESS":
      return { ...state, phase: "generating", progress: action.progress };
    case "COMPLETE":
      return { ...state, phase: "ready", result: action.result, progress: null, error: null };
    case "ERROR":
      return { ...state, phase: "error", error: action.error };
    case "REGENERATE":
      return {
        ...initialBookSkillPanelState,
        bookId: state.bookId,
        genre: state.genre,
        phase: "estimate-ready",
        estimate: state.estimate,
      };
    default:
      return state;
  }
}
