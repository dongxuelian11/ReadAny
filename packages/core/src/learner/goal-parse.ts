// Goal parsing — the LLM drafts a structured GoalSpec from free text + the
// book's chapter list; every output field is validated deterministically and
// chapter references must resolve against the real book list (gen-mentor
// refiner+mapper boundary, fail-closed, per the PR-003 audit).

import { parseJsonResponse } from "../book-skill/response";
import type { GoalChapterTarget, GoalSpec, TargetDepth } from "./goal";

export interface GoalLlmClient {
  complete(system: string, user: string): Promise<string>;
}

export interface GoalChapterListEntry {
  conceptId: string;
  title: string;
}

const DEPTHS: TargetDepth[] = ["familiar", "working", "mastery"];

export function buildGoalParsePrompt(params: {
  goalText: string;
  bookTitle: string;
  chapters: GoalChapterListEntry[];
}): { system: string; user: string } {
  const chapterList = params.chapters
    .map((chapter) => `- ${chapter.conceptId} — ${chapter.title}`)
    .join("\n");
  const system = [
    "You translate a learner's free-text study goal into a structured plan against ONE book's chapter list.",
    "Rules:",
    "- requiredChapterIds may ONLY contain ids from the provided chapter list. Never invent ids.",
    "- Choose the SMALLEST set of chapters that genuinely serves the goal; do not include the whole book by default.",
    "- For every required chapter assign a targetDepth: familiar (awareness), working (can apply), or mastery (can teach / exam-ready).",
    "- targetCapabilities: 2-6 concrete abilities the learner will gain. milestones: 2-4 checkpoints. completionCriteria: 1-3 measurable criteria.",
    "- restatedGoal: one sentence restating the goal in measurable terms.",
    "Return STRICT JSON only, no prose, with this shape:",
    "{",
    '  "restatedGoal": "...",',
    '  "targetCapabilities": ["..."],',
    '  "requiredChapters": [ { "conceptId": "<id from the list>", "depth": "familiar|working|mastery" } ],',
    '  "milestones": ["..."],',
    '  "completionCriteria": ["..."]',
    "}",
  ].join("\n");
  const user = [
    `Book: ${params.bookTitle}`,
    `Learner's goal: ${params.goalText}`,
    "",
    "Chapter list:",
    chapterList,
  ].join("\n");
  return { system, user };
}

export interface ParsedGoalDraft {
  restatedGoal: string;
  targetCapabilities: string[];
  requiredChapters: GoalChapterTarget[];
  milestones: string[];
  completionCriteria: string[];
  droppedChapterIds: string[];
}

/** Validate a model parse against the real chapter list. Chapter ids that do
 * not resolve are dropped and reported; a parse with zero surviving chapters
 * fails closed. */
export function validateGoalParse(raw: unknown, chapters: GoalChapterListEntry[]): ParsedGoalDraft {
  const d = raw as Partial<ParsedGoalDraft>;
  if (typeof d.restatedGoal !== "string" || !d.restatedGoal.trim()) {
    throw new Error("Goal parse is missing restatedGoal");
  }
  const validIds = new Set(chapters.map((chapter) => chapter.conceptId));
  const byId = new Map(chapters.map((chapter) => [chapter.conceptId, chapter]));
  const requiredChapters: GoalChapterTarget[] = [];
  const droppedChapterIds: string[] = [];
  for (const entry of Array.isArray(d.requiredChapters) ? d.requiredChapters : []) {
    const candidate = entry as { conceptId?: unknown; depth?: unknown };
    if (typeof candidate.conceptId !== "string") continue;
    if (!validIds.has(candidate.conceptId)) {
      droppedChapterIds.push(candidate.conceptId);
      continue;
    }
    const depth = DEPTHS.includes(candidate.depth as TargetDepth)
      ? (candidate.depth as TargetDepth)
      : "working";
    const chapter = byId.get(candidate.conceptId);
    if (!chapter) continue;
    requiredChapters.push({
      conceptId: chapter.conceptId,
      title: chapter.title,
      depth,
    });
  }
  if (requiredChapters.length === 0) {
    throw new Error("Goal parse resolved to zero valid chapters — refusing to build a goal");
  }
  const strings = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  const targetCapabilities = strings(d.targetCapabilities).slice(0, 6);
  const milestones = strings(d.milestones).slice(0, 4);
  const completionCriteria = strings(d.completionCriteria).slice(0, 3);
  // Preserve book order for the required chapters.
  requiredChapters.sort(
    (a, b) =>
      chapters.findIndex((chapter) => chapter.conceptId === a.conceptId) -
      chapters.findIndex((chapter) => chapter.conceptId === b.conceptId),
  );
  return {
    restatedGoal: d.restatedGoal.trim(),
    targetCapabilities,
    requiredChapters,
    milestones,
    completionCriteria,
    droppedChapterIds,
  };
}

/** Parse a free-text goal against the book's chapters (one LLM call, one
 * deterministic retry). */
export async function parseGoal(params: {
  goalText: string;
  bookTitle: string;
  chapters: GoalChapterListEntry[];
  llm: GoalLlmClient;
}): Promise<ParsedGoalDraft> {
  const prompt = buildGoalParsePrompt({
    goalText: params.goalText,
    bookTitle: params.bookTitle,
    chapters: params.chapters,
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return validateGoalParse(
        parseJsonResponse<unknown>(await params.llm.complete(prompt.system, prompt.user)),
        params.chapters,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Assemble the persisted GoalSpec from a validated parse. */
export function toGoalSpec(params: {
  parse: ParsedGoalDraft;
  goalId: string;
  bookId: string;
  goalText: string;
  createdAt: number;
}): GoalSpec {
  return {
    goalId: params.goalId,
    bookId: params.bookId,
    goalText: params.goalText,
    restatedGoal: params.parse.restatedGoal,
    targetCapabilities: params.parse.targetCapabilities,
    chapters: params.parse.requiredChapters,
    milestones: params.parse.milestones,
    completionCriteria: params.parse.completionCriteria,
    createdAt: params.createdAt,
    active: true,
  };
}
