// PR-009 Teaching engine — the Agent 带读 backend. One curriculum step at a
// time: the LLM writes a chapter-grounded explanation plus ONE comprehension
// MCQ (content co-processor only); grading is deterministic; the answer flows
// through applyEvidenceEvent so teaching moves BKT mastery and FSRS scheduling
// through the exact PR-004/005 path. Sessions are user-initiated and quiet:
// nothing is delivered unless the caller asks for the current step.

import { parseJsonResponse } from "../book-skill/response";
import type { EvidenceEventInput } from "./engine";
import type { LearnerConceptState } from "./goal";

export interface TeachingLlmClient {
  complete(system: string, user: string): Promise<string>;
}

/** Supplies the canonical ReadAny chapter text for a curriculum step's
 * concept (the app adapter maps chapter-scoped concept ids to extracted
 * chapter content). */
export type ChapterTextProvider = (conceptId: string) => Promise<string>;

export const TEACHING_SOURCE_TEXT_CAP = 12000;

export interface TeachingContent {
  explanation: string;
  keyPoints: string[];
  workedExample: string | null;
  check: {
    prompt: string;
    options: string[];
    correctIndex: number;
    explanation: string;
  };
}

export interface TeachingStep {
  conceptId: string;
  title: string;
  action: "learn" | "review";
  content: TeachingContent | null;
  answered: boolean;
  correct: boolean | null;
}

export type TeachingSessionStatus = "active" | "completed" | "abandoned";

export interface TeachingSession {
  id: string;
  goalId: string;
  bookId: string;
  status: TeachingSessionStatus;
  steps: TeachingStep[];
  currentIndex: number;
  startedAt: number;
  completedAt: number | null;
}

export function buildTeachingPrompt(params: {
  bookTitle: string;
  chapterTitle: string;
  chapterText: string;
  action: "learn" | "review";
}): { system: string; user: string } {
  const system = [
    "You are a patient tutor teaching ONE chapter of a book to a single learner.",
    params.action === "review"
      ? "The learner has seen this chapter before but their retention lapsed — refresh it concisely."
      : "Teach the chapter from scratch, assuming no prior knowledge of it.",
    "Ground EVERY claim in the chapter text provided. If the text does not cover something, do not bring it in.",
    "Never copy the chapter text verbatim — extract and explain. Keep the author's exact terminology.",
    "Return STRICT JSON only, no prose, with this shape:",
    "{",
    '  "explanation": "120-350 words teaching the core of the chapter, in the same language as the chapter text",',
    '  "keyPoints": ["2-5 terse takeaways"],',
    '  "workedExample": "one concrete worked example, or null",',
    '  "check": {',
    '    "prompt": "ONE 4-option multiple-choice comprehension question answerable from what you just taught",',
    '    "options": ["A", "B", "C", "D"],',
    '    "correctIndex": 0,',
    '    "explanation": "why the correct option is right and the key distractor is wrong"',
    "  }",
    "}",
  ].join("\n");
  const user = [
    `Book: ${params.bookTitle}`,
    `Chapter: ${params.chapterTitle}`,
    "",
    "Chapter text:",
    params.chapterText.slice(0, TEACHING_SOURCE_TEXT_CAP),
  ].join("\n");
  return { system, user };
}

/** Validate a model teaching draft (fail-closed). */
export function validateTeachingContent(raw: unknown): TeachingContent {
  const d = raw as Partial<TeachingContent>;
  if (typeof d.explanation !== "string" || d.explanation.trim().length < 40) {
    throw new Error("Teaching explanation is missing or too short");
  }
  const keyPoints = (Array.isArray(d.keyPoints) ? d.keyPoints : []).filter(
    (point): point is string => typeof point === "string" && point.trim().length > 0,
  );
  if (keyPoints.length < 2 || keyPoints.length > 5) {
    throw new Error("Teaching must have 2-5 key points");
  }
  const check = d.check as Partial<TeachingContent["check"]> | undefined;
  if (
    !check ||
    typeof check.prompt !== "string" ||
    !check.prompt.trim() ||
    !Array.isArray(check.options) ||
    check.options.length !== 4 ||
    check.options.some((option) => typeof option !== "string" || !option.trim()) ||
    !Number.isInteger(check.correctIndex) ||
    (check.correctIndex as number) < 0 ||
    (check.correctIndex as number) > 3 ||
    typeof check.explanation !== "string" ||
    !check.explanation.trim()
  ) {
    throw new Error("Teaching comprehension check is malformed");
  }
  return {
    explanation: d.explanation.trim(),
    keyPoints: keyPoints.map((point) => point.trim()),
    workedExample:
      typeof d.workedExample === "string" && d.workedExample.trim() ? d.workedExample.trim() : null,
    check: {
      prompt: check.prompt.trim(),
      options: (check.options as string[]).map((option) => option.trim()),
      correctIndex: check.correctIndex as number,
      explanation: check.explanation.trim(),
    },
  };
}

/** Generate teaching content for one step (one LLM call, one retry). */
export async function generateTeachingContent(params: {
  bookTitle: string;
  step: TeachingStep;
  chapterText: string;
  llm: TeachingLlmClient;
}): Promise<TeachingContent> {
  const prompt = buildTeachingPrompt({
    bookTitle: params.bookTitle,
    chapterTitle: params.step.title,
    chapterText: params.chapterText,
    action: params.step.action,
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return validateTeachingContent(
        parseJsonResponse<unknown>(await params.llm.complete(prompt.system, prompt.user)),
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The deterministic evidence input a comprehension answer produces. */
export function teachingEvidence(params: {
  sessionId: string;
  step: TeachingStep;
  correct: boolean;
}): EvidenceEventInput {
  return {
    id: `${params.sessionId}:${params.step.conceptId}`,
    conceptId: params.step.conceptId,
    source: "TEACHING",
    taskType: "quiz",
    questionType: "mc",
    result: params.correct ? "correct" : "incorrect",
    confidence: 1,
    // Admission authority (PR-014): grading is deterministic code, but against
    // an LLM-authored answer key — medium trust.
    verification: "deterministic_keyed",
  };
}

/** Learner-state snapshot used by the engine for honest status checks. */
export type LearnerStateLookup = (conceptId: string) => Promise<LearnerConceptState | null>;

export function sessionIsComplete(session: TeachingSession): boolean {
  return session.currentIndex >= session.steps.length;
}

export function currentTeachingStep(session: TeachingSession): TeachingStep | null {
  if (session.status !== "active") return null;
  return session.steps[session.currentIndex] ?? null;
}
