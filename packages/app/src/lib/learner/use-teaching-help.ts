// LEARN-01 — help requests for the current teaching step (讲简单些 / 换个例子 /
// 我卡在这里). The hook owns the request-generation guard so a stale response
// (book switch, step advance, answer, supersede) can never enter the panel,
// and it dispatches only through the dedicated HELP actions, which never touch
// the teaching phase or the learning records — the core guarantees help is
// not evidence.

import { TEACHING_FOCUS_EXCERPT_MAX, currentTeachingStep } from "@readany/core/learner";
import type {
  LearnerHelpPhase,
  LearnerPanelAction,
  LearnerPanelState,
  TeachingHelpKind,
  TeachingHelpVariant,
} from "@readany/core/learner";
import type { Book } from "@readany/core/types";
import { useCallback, useEffect, useRef } from "react";
import { requestTeachingHelpForBook } from "./teaching-trigger";

export function useTeachingHelp(params: {
  book: Book;
  state: LearnerPanelState;
  dispatch: (action: LearnerPanelAction) => void;
  aiConfigured: boolean;
  /** The learner's selected passage in the step's chapter (already chapter-
   * matched by the caller), or null when nothing is selected. */
  getFocusExcerpt: (conceptId: string) => string | null;
}) {
  const depsRef = useRef(params);
  depsRef.current = params;
  // A stale async completion (book switch / step advance / answer racing) may
  // not touch the panel — same guard pattern as the review run.
  const requestGenRef = useRef(0);

  useEffect(() => {
    const gen = requestGenRef;
    return () => {
      gen.current += 1;
    };
  }, []);

  const requestHelp = useCallback(async (kind: TeachingHelpKind, note: string | null) => {
    const { state, aiConfigured, getFocusExcerpt, dispatch, book } = depsRef.current;
    if (!aiConfigured) return;
    const teaching = state.teaching;
    if (!teaching || teaching.status !== "active") return;
    if (state.helpPhase === "loading") return;
    const step = currentTeachingStep(teaching);
    if (!step || !step.content || step.answered) return;
    const requestIndex = teaching.currentIndex;
    const gen = ++requestGenRef.current;
    dispatch({ type: "TEACHING_HELP_REQUEST" });
    try {
      const updated = await requestTeachingHelpForBook(book, teaching, {
        kind,
        note,
        focusExcerpt: getFocusExcerpt(step.conceptId),
      });
      if (gen !== requestGenRef.current) return;
      // The core returns the stored session unchanged when its late-write
      // guard dropped the variant (answered/advanced/superseded meanwhile):
      // drop it on the panel too instead of regressing the view.
      if (updated.currentIndex !== requestIndex || updated.status !== "active") return;
      dispatch({ type: "TEACHING_HELP_DELIVERED", session: updated });
    } catch (error) {
      if (gen !== requestGenRef.current) return;
      dispatch({
        type: "TEACHING_HELP_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const teaching = params.state.teaching;
  const step = teaching ? currentTeachingStep(teaching) : null;
  return {
    requestHelp,
    variants: step?.helpVariants ?? [],
    helpPhase: params.state.helpPhase as LearnerHelpPhase,
    helpError: params.state.helpError,
    aiConfigured: params.aiConfigured,
  };
}

/** The learner's selected text trimmed and bounded for prompt use; empty
 * selections become null. */
export function boundedFocusExcerpt(selectedText: string | undefined | null): string | null {
  const text = (selectedText ?? "").trim();
  return text ? text.slice(0, TEACHING_FOCUS_EXCERPT_MAX) : null;
}

export type TeachingHelpController = ReturnType<typeof useTeachingHelp>;
export type { TeachingHelpVariant };
