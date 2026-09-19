// PR-009 Teaching engine — the Agent 带读 backend. One curriculum step at a
// time: the LLM writes a chapter-grounded explanation plus ONE comprehension
// MCQ (content co-processor only); grading is deterministic; the answer flows
// through applyEvidenceEvent so teaching moves BKT mastery and FSRS scheduling
// through the exact PR-004/005 path. Sessions are user-initiated and quiet:
// nothing is delivered unless the caller asks for the current step.

import { parseJsonResponse } from "../book-skill/response";
import type { EvidenceEventInput } from "./engine";
import type { LearnerConceptState, TargetDepth } from "./goal";

export interface TeachingLlmClient {
  complete(system: string, user: string): Promise<string>;
}

/** Supplies the canonical ReadAny chapter text for a curriculum step's
 * concept (the app adapter maps chapter-scoped concept ids to extracted
 * chapter content). */
export type ChapterTextProvider = (conceptId: string) => Promise<string>;

export const TEACHING_SOURCE_TEXT_CAP = 12000;

/**
 * The language teaching output should be written in — independent of the
 * chapter text's language. "auto" (or undefined) keeps the legacy behavior of
 * following the chapter text; an explicit tag (e.g. "zh-CN") makes the
 * explanation, key points, worked example, question, options, and feedback be
 * written in that language even for English source books.
 */
export type LearningLanguage = string;

const LEARNING_LANGUAGE_NAMES: Record<string, string> = {
  zh: "简体中文",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
};

export function learningLanguageName(tag: LearningLanguage): string {
  return LEARNING_LANGUAGE_NAMES[tag] || tag;
}

/** True when teaching output should follow the chapter text's own language. */
export function followsSourceLanguage(lang: LearningLanguage | undefined): boolean {
  return !lang || lang === "auto";
}

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
  /** LEARN-01: where the explained source window sits inside the extracted
   * chapter, present only when the window is partial (long chapter). Absent
   * or null = the whole chapter was in context. */
  source?: { start: number; end: number; total: number } | null;
}

export interface TeachingStep {
  conceptId: string;
  title: string;
  action: "learn" | "review";
  content: TeachingContent | null;
  answered: boolean;
  correct: boolean | null;
  /** LEARN-01: target depth copied from the curriculum at session start.
   * Absent in sessions started before this field existed (compat: the prompt
   * then simply omits the depth line). */
  depth?: TargetDepth;
  /** LEARN-01: bounded recent explanation rewrites (help variants). Pure
   * explanation content — never the check question or its answer key. */
  helpVariants?: TeachingHelpVariant[];
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

/** LEARN-01: a bounded explanation rewrite the learner asked for. It lives on
 * the step, but only as ADDITIONAL reading — the issued check question and
 * its answer key are never included, and no learning record moves. */
export type TeachingHelpKind = "simpler" | "example" | "stuck";

export interface TeachingHelpVariant {
  id: string;
  kind: TeachingHelpKind;
  /** The learner's one-line note when they said they were stuck. */
  note: string | null;
  /** The rewritten explanation. */
  text: string;
  /** A replacement worked example, when one was requested. */
  example: string | null;
  createdAt: number;
  /** Honest provenance: the covered character range of the extracted chapter
   * (0-based, end-exclusive); null when the whole chapter was in context. */
  source: { start: number; end: number; total: number } | null;
}

export const TEACHING_HELP_VARIANTS_MAX = 3;
export const TEACHING_STUCK_NOTE_MAX = 200;
export const TEACHING_FOCUS_EXCERPT_MAX = 600;

export interface TeachingHelpRequest {
  kind: TeachingHelpKind;
  /** One-line sticking point for kind "stuck" (optional — the learner may
   * just click through). */
  note?: string | null;
}

export interface SourceWindow {
  text: string;
  /** 0-based inclusive start / exclusive end within the full chapter text. */
  start: number;
  end: number;
  total: number;
}

/** LEARN-01: pick the chapter text that enters the prompt. Short chapters go
 * whole; long ones default to the head window, but a learner-selected passage
 * anchors the window instead — a goal or selection near the chapter end must
 * not silently teach only the chapter head. Pure and deterministic. */
export function selectSourceWindow(params: {
  chapterText: string;
  focus?: string | null;
  cap?: number;
}): SourceWindow {
  const cap = params.cap ?? TEACHING_SOURCE_TEXT_CAP;
  const total = params.chapterText.length;
  if (total <= cap) return { text: params.chapterText, start: 0, end: total, total };
  const anchor = params.focus ? params.chapterText.indexOf(params.focus.trim().slice(0, 80)) : -1;
  let start = anchor >= 0 ? Math.max(0, anchor - Math.floor(cap / 4)) : 0;
  const end = Math.min(total, start + cap);
  start = Math.max(0, end - cap);
  return { text: params.chapterText.slice(start, end), start, end, total };
}

const DEPTH_HINTS: Record<TargetDepth, string> = {
  familiar: "understand the core ideas",
  working: "apply the ideas to concrete problems",
  mastery: "derive rigorously and connect concepts",
};

/** Recent-attempt window for the learner context: a handful of the most
 * recent events, never the whole history. */
export const TEACHING_RECENT_ATTEMPTS_WINDOW = 5;

/** LEARN-01: the honest learner-basis sentence for the prompt. An unknown
 * basis is NEVER asserted as zero basis — no evidence means "unknown", and
 * language difficulty must not be read as missing math or finance ability. */
export function describeLearnerBasis(params: {
  state: { evidenceCount: number; mastery: number | null; status: string } | null;
  recent?: Array<{ result: string }>;
  depth?: TargetDepth | null;
}): string {
  const state = params.state;
  if (!state || state.evidenceCount === 0) {
    return (
      "No recorded attempts on this concept — the learner's basis is UNKNOWN, not zero. " +
      "Do not assume total ignorance; the learner may already know related mathematics, " +
      "finance, or programming from elsewhere. Start accessible and let the comprehension " +
      "check reveal real gaps."
    );
  }
  const lines = [
    `${state.evidenceCount} prior attempt(s) on this concept, mastery ${((state.mastery ?? 0) * 100).toFixed(0)}%, status ${state.status} — pitch depth accordingly`,
  ];
  const recent = (params.recent ?? []).slice(-TEACHING_RECENT_ATTEMPTS_WINDOW);
  if (recent.length > 0) {
    const wrong = recent.filter((event) => event.result === "incorrect").length;
    lines.push(
      wrong > 0
        ? `Recent: ${wrong} of the last ${recent.length} attempt(s) wrong.`
        : `Recent: all of the last ${recent.length} attempt(s) correct.`,
    );
  }
  if (params.depth) {
    lines.push(`Target depth for this step: ${params.depth} (${DEPTH_HINTS[params.depth]}).`);
  }
  return lines.join(" ");
}

export function buildTeachingPrompt(params: {
  bookTitle: string;
  chapterTitle: string;
  chapterText: string;
  action: "learn" | "review";
  learningLanguage?: LearningLanguage;
  /** Short honest note about what the learner already knows for this concept
   * (mastery level / prior wrong attempts). Never presented as a diagnosis. */
  learnerContext?: string;
  /** LEARN-01: precomputed source window (selectSourceWindow). When present
   * its text replaces the head slice and partial coverage is stated. */
  sourceWindow?: SourceWindow | null;
}): { system: string; user: string } {
  const system = [
    "You are a patient tutor teaching ONE chapter of a book to a single learner.",
    params.action === "review"
      ? "The learner has seen this chapter before but their retention lapsed — refresh it concisely."
      : "Teach the chapter from scratch, assuming no prior knowledge of it.",
    "Ground EVERY claim in the chapter text provided. If the text does not cover something, do not bring it in.",
    "Never copy the chapter text verbatim — extract and explain. Keep the author's exact terminology.",
    ...(followsSourceLanguage(params.learningLanguage)
      ? []
      : [
          `Teaching output language: ${learningLanguageName(params.learningLanguage as LearningLanguage)} (${params.learningLanguage}).`,
          `Write explanation, keyPoints, workedExample, check.prompt, check.options, and check.explanation in ${learningLanguageName(params.learningLanguage as LearningLanguage)} — regardless of the chapter text's language.`,
          "The learner is NOT assumed to read the chapter text's language; weak English does not mean weak math or programming.",
          "On first use, keep the author's key technical term in its original language in parentheses, e.g. 「均值回归（mean reversion）」; keep formulas, variable names, code identifiers, and units exactly as in the source.",
        ]),
    "Return STRICT JSON only, no prose, with this shape:",
    "{",
    `  "explanation": "120-350 words teaching the core of the chapter${followsSourceLanguage(params.learningLanguage) ? ", in the same language as the chapter text" : `, in ${learningLanguageName(params.learningLanguage as LearningLanguage)}`}",`,
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
  const window = params.sourceWindow ?? null;
  const coverageNote =
    window && (window.start > 0 || window.end < window.total)
      ? `Source coverage: characters ${window.start + 1}-${window.end} of ${window.total} (${Math.round((100 * (window.end - window.start)) / Math.max(window.total, 1))}% of the chapter); the rest of this chapter is NOT included.`
      : null;
  const user = [
    `Book: ${params.bookTitle}`,
    `Chapter: ${params.chapterTitle}`,
    ...(params.learnerContext ? [`Learner context: ${params.learnerContext}`] : []),
    ...(coverageNote ? [coverageNote] : []),
    "",
    "Chapter text:",
    (window?.text ?? params.chapterText).slice(0, TEACHING_SOURCE_TEXT_CAP),
  ].join("\n");
  return { system, user };
}

const HELP_KIND_INSTRUCTIONS: Record<TeachingHelpKind, string> = {
  simpler:
    "The learner asked for a SIMPLER explanation. Rewrite the SAME explanation in plainer language: " +
    "shorter sentences, an everyday framing, small concrete numbers. Keep the author's key technical " +
    "terms (with their original-language form in parentheses on first use) and every formula exact.",
  example:
    "The learner asked for a DIFFERENT example. Produce ONE new worked example with different concrete " +
    "numbers than the original, grounded strictly in the chapter text. Keep units, variable names, and " +
    "terminology exact.",
  stuck:
    "The learner says they are stuck. Re-explain exactly the point they name, in a different way than " +
    "the original explanation. If their difficulty is outside what this chapter text covers, say so " +
    "honestly and explain only what the text supports.",
};

/** LEARN-01: the help prompt. Deliberately EXCLUDES the pending comprehension
 * check — its question and answer key must stay sealed from the help call, so
 * a help response can never leak or replace them. */
export function buildTeachingHelpPrompt(params: {
  bookTitle: string;
  chapterTitle: string;
  chapterText: string;
  learningLanguage?: LearningLanguage;
  help: TeachingHelpRequest;
  originalExplanation: string;
  originalExample?: string | null;
  learnerContext?: string;
  sourceWindow?: SourceWindow | null;
}): { system: string; user: string } {
  const languageLines = followsSourceLanguage(params.learningLanguage)
    ? []
    : [
        `Teaching output language: ${learningLanguageName(params.learningLanguage as LearningLanguage)} (${params.learningLanguage}).`,
        `Write explanation and example in ${learningLanguageName(params.learningLanguage as LearningLanguage)} — regardless of the chapter text's language.`,
        "The learner is NOT assumed to read the chapter text's language; weak English does not mean weak math or programming.",
        "Keep the author's key technical term in its original language in parentheses, e.g. 「均值回归（mean reversion）」; keep formulas, variable names, code identifiers, and units exactly as in the source.",
      ];
  const system = [
    "You are a patient tutor re-explaining ONE chapter of a book to a learner who asked for help.",
    HELP_KIND_INSTRUCTIONS[params.help.kind],
    "Ground EVERY claim in the chapter text provided. If the text does not cover something, do not bring it in.",
    "Never reveal, hint at, or answer any quiz question — the learner's comprehension check stays sealed. This response is an explanation rewrite, not a replacement for the issued question.",
    ...languageLines,
    'Return STRICT JSON only, no prose, with this shape: {"explanation": "the re-explanation", "example": "one concrete example, or null"}',
  ].join("\n");
  const note = params.help.note?.trim().slice(0, TEACHING_STUCK_NOTE_MAX);
  const window = params.sourceWindow ?? null;
  const coverageNote =
    window && (window.start > 0 || window.end < window.total)
      ? `Source coverage: characters ${window.start + 1}-${window.end} of ${window.total}; the rest of this chapter is NOT included.`
      : null;
  const user = [
    `Book: ${params.bookTitle}`,
    `Chapter: ${params.chapterTitle}`,
    ...(params.learnerContext ? [`Learner context: ${params.learnerContext}`] : []),
    "The explanation the learner received:",
    params.originalExplanation,
    `The worked example they saw: ${params.originalExample ?? "(none)"}`,
    params.help.kind === "stuck" && note
      ? `What the learner says they are stuck on: ${note}`
      : `Help request: ${params.help.kind}`,
    ...(coverageNote ? [coverageNote] : []),
    "",
    "Chapter text:",
    (window?.text ?? params.chapterText).slice(0, TEACHING_SOURCE_TEXT_CAP),
  ].join("\n");
  return { system, user };
}

/** Validate a help draft (fail-closed): an explanation is always required; a
 * blank example becomes null. */
export interface TeachingHelpDraft {
  explanation: string;
  example: string | null;
}

export function validateTeachingHelpContent(raw: unknown): TeachingHelpDraft {
  const d = raw as Partial<TeachingHelpDraft>;
  if (typeof d.explanation !== "string" || d.explanation.trim().length < 20) {
    throw new Error("Help explanation is missing or too short");
  }
  return {
    explanation: d.explanation.trim(),
    example: typeof d.example === "string" && d.example.trim() ? d.example.trim() : null,
  };
}

/** Generate one help variant (one LLM call, one retry — same fail-closed
 * pattern as the teaching content). */
export async function generateTeachingHelp(params: {
  bookTitle: string;
  chapterTitle: string;
  chapterText: string;
  learningLanguage?: LearningLanguage;
  help: TeachingHelpRequest;
  originalExplanation: string;
  originalExample?: string | null;
  learnerContext?: string;
  sourceWindow?: SourceWindow | null;
  llm: TeachingLlmClient;
}): Promise<TeachingHelpDraft> {
  const prompt = buildTeachingHelpPrompt(params);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return validateTeachingHelpContent(
        parseJsonResponse<unknown>(await params.llm.complete(prompt.system, prompt.user)),
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  learningLanguage?: LearningLanguage;
  learnerContext?: string;
  sourceWindow?: SourceWindow | null;
}): Promise<TeachingContent> {
  const prompt = buildTeachingPrompt({
    bookTitle: params.bookTitle,
    chapterTitle: params.step.title,
    chapterText: params.chapterText,
    action: params.step.action,
    learningLanguage: params.learningLanguage,
    learnerContext: params.learnerContext,
    sourceWindow: params.sourceWindow,
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
