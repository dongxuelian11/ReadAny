import type {
  LearningCitation,
  LearningDigest,
  LearningQuizJudgement,
  LearningQuizQuestion,
} from "./types";

export type LearningPanelPhase =
  | "idle"
  | "starting"
  | "ready"
  | "unavailable"
  | "digest-loading"
  | "digest-complete"
  | "qa-streaming"
  | "qa-complete"
  | "quiz-loading"
  | "quiz-active"
  | "quiz-complete"
  | "error";

export interface LearningPanelState {
  phase: LearningPanelPhase;
  error?: string;
  digest?: LearningDigest;
  answer: string;
  citations: LearningCitation[];
  quizQuestions: LearningQuizQuestion[];
  quizIndex: number;
  quizJudgement?: LearningQuizJudgement;
}

export type LearningPanelAction =
  | { type: "STARTING" }
  | { type: "READY" }
  | { type: "UNAVAILABLE"; error: string }
  | { type: "DIGEST_LOADING" }
  | { type: "DIGEST_COMPLETE"; digest: LearningDigest }
  | { type: "QA_START" }
  | { type: "QA_CHUNK"; chunk: string }
  | { type: "QA_COMPLETE"; citations: LearningCitation[] }
  | { type: "QUIZ_LOADING" }
  | { type: "QUIZ_ACTIVE"; questions: LearningQuizQuestion[] }
  | { type: "QUIZ_JUDGED"; judgement: LearningQuizJudgement }
  | { type: "QUIZ_NEXT" }
  | { type: "QUIZ_COMPLETE" }
  | { type: "ERROR"; error: string }
  | { type: "RESET_CHAPTER" };

export const initialLearningPanelState: LearningPanelState = {
  phase: "idle",
  answer: "",
  citations: [],
  quizQuestions: [],
  quizIndex: 0,
};

export function learningPanelReducer(
  state: LearningPanelState,
  action: LearningPanelAction,
): LearningPanelState {
  switch (action.type) {
    case "STARTING":
      return { ...state, phase: "starting", error: undefined };
    case "READY":
      return { ...state, phase: "ready", error: undefined };
    case "UNAVAILABLE":
      return { ...state, phase: "unavailable", error: action.error };
    case "DIGEST_LOADING":
      return { ...state, phase: "digest-loading", error: undefined };
    case "DIGEST_COMPLETE":
      return { ...state, phase: "digest-complete", digest: action.digest };
    case "QA_START":
      return { ...state, phase: "qa-streaming", answer: "", citations: [], error: undefined };
    case "QA_CHUNK":
      return { ...state, answer: state.answer + action.chunk };
    case "QA_COMPLETE":
      return { ...state, phase: "qa-complete", citations: action.citations };
    case "QUIZ_LOADING":
      return { ...state, phase: "quiz-loading", quizJudgement: undefined, error: undefined };
    case "QUIZ_ACTIVE":
      return {
        ...state,
        phase: "quiz-active",
        quizQuestions: action.questions,
        quizIndex: 0,
        quizJudgement: undefined,
      };
    case "QUIZ_JUDGED":
      return { ...state, quizJudgement: action.judgement };
    case "QUIZ_NEXT":
      return {
        ...state,
        quizIndex: Math.min(state.quizIndex + 1, state.quizQuestions.length),
        quizJudgement: undefined,
      };
    case "QUIZ_COMPLETE":
      return { ...state, phase: "quiz-complete" };
    case "ERROR":
      return { ...state, phase: "error", error: action.error };
    case "RESET_CHAPTER":
      return { ...initialLearningPanelState };
  }
}
