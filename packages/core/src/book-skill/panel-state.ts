// Reducer for the Reader Book Skill panel state machine (book-scoped, unlike
// the chapter-scoped PR-001 learning panel). Every phase must be designed
// (loading / empty / error / active / completed) and the panel renders only
// from this state.
//
// PR-018: the panel also hosts the shelf-wide "ask the shelf" section — its
// state rides in this reducer and resets with BOOK_CHANGED (the ask is bound
// to the panel session, not to any single book).

import type { StoredAskAnswer } from "./ask-history";
import type { CrossBookAnswer } from "./cross-book";
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

export type BookSkillAskPhase = "idle" | "asking" | "ready" | "error";

export interface BookSkillPanelState {
  phase: BookSkillPanelPhase;
  bookId: string | null;
  genre: BookSkillGenre;
  estimate: BookSkillCostEstimate | null;
  progress: BookSkillProgress | null;
  result: BookSkillResult | null;
  error: string | null;
  /** Set when the loaded skill was built from different book content or an
   * older genre than the current preference (PR-018 stale-cache debt). */
  staleReason: "book-file-changed" | "genre-changed" | null;
  // Shelf-wide ask (PR-017 contract consumer)
  askPhase: BookSkillAskPhase;
  askAnswer: CrossBookAnswer | null;
  askError: string | null;
  // Persisted ask history (PR-020), newest first
  askHistory: StoredAskAnswer[];
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
  | { type: "REGENERATE" }
  | { type: "SKILL_STALE"; reason: "book-file-changed" | "genre-changed" }
  | { type: "ASK_START" }
  | { type: "ASK_READY"; answer: CrossBookAnswer }
  | { type: "ASK_ERROR"; error: string }
  | { type: "ASK_HISTORY_READY"; entries: StoredAskAnswer[] };

export const initialBookSkillPanelState: BookSkillPanelState = {
  phase: "idle",
  bookId: null,
  genre: "general",
  estimate: null,
  progress: null,
  result: null,
  error: null,
  staleReason: null,
  askPhase: "idle",
  askAnswer: null,
  askError: null,
  askHistory: [],
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
      return {
        ...state,
        phase: "generating",
        progress: null,
        error: null,
        result: null,
        staleReason: null,
      };
    case "PROGRESS":
      return { ...state, phase: "generating", progress: action.progress };
    case "COMPLETE":
      return {
        ...state,
        phase: "ready",
        result: action.result,
        progress: null,
        error: null,
        staleReason: null,
      };
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
    case "SKILL_STALE":
      // The loaded skill does not match the current book/genre: keep the
      // panel usable (the estimate + regenerate flow takes over) while the
      // banner explains why the old skill is gone.
      return { ...state, staleReason: action.reason };
    case "ASK_START":
      return { ...state, askPhase: "asking", askError: null };
    case "ASK_READY":
      return { ...state, askPhase: "ready", askAnswer: action.answer, askError: null };
    case "ASK_ERROR":
      return { ...state, askPhase: "error", askError: action.error };
    case "ASK_HISTORY_READY":
      return { ...state, askHistory: action.entries };
    default:
      return state;
  }
}
