// Teaching session lifecycle over the deterministic core. Sessions are
// user-initiated and quiet: content is generated only when the caller asks for
// the current step, answers are graded deterministically, and every answer
// becomes evidence through applyEvidenceEvent (BKT + FSRS move through the
// exact PR-004/005 path). Fail-closed throughout: unknown/duplicate answers,
// inactive sessions, and step-generation failures never silently pass.

import { applyEvidenceEvent } from "./engine";
import type { PersonalCurriculum } from "./goal";
import type { LearnerConceptState } from "./goal";
import {
  type ChapterTextProvider,
  type TeachingLlmClient,
  type TeachingSession,
  type TeachingStep,
  currentTeachingStep,
  generateTeachingContent,
  sessionIsComplete,
  teachingEvidence,
} from "./teaching";
import type { TeachingContent } from "./teaching";
import type { TeachingStore } from "./teaching-store";
import type { LearnerClock } from "./types";
import { withLearnerWriteLock } from "./write-lock";

export interface TeachingEngineDeps {
  clock: LearnerClock;
  evidence: import("./types").LearnerEvidenceStore;
  mastery: import("./types").LearnerMasteryStore;
  reviews: import("./types").LearnerReviewStore;
  teachings: TeachingStore;
  llm: TeachingLlmClient;
  chapterText: ChapterTextProvider;
}

export class TeachingStepFailedError extends Error {
  constructor(conceptId: string, detail: string) {
    super(`Teaching content for ${conceptId} could not be generated: ${detail}`);
    this.name = "TeachingStepFailedError";
  }
}

/** Start a teaching session from a curriculum; abandons any previously active
 * session (fail-safe supersession, mirroring placement). The abandon-then-
 * create cycle runs under the learner write lock (PR-012) so two concurrent
 * starts cannot abandon each other and leave two active sessions. */
export async function startTeachingSession(
  deps: TeachingEngineDeps,
  curriculum: PersonalCurriculum,
): Promise<TeachingSession> {
  if (curriculum.steps.length === 0) {
    throw new Error("The curriculum has no steps to teach");
  }
  const now = deps.clock.now();
  return withLearnerWriteLock(async () => {
    const active = await deps.teachings.getActive();
    if (active) {
      await deps.teachings.put({ ...active, status: "abandoned", completedAt: now.getTime() });
    }
    const steps: TeachingStep[] = curriculum.steps.map((step) => ({
      conceptId: step.conceptId,
      title: step.title,
      action: step.action,
      content: null,
      answered: false,
      correct: null,
    }));
    const session: TeachingSession = {
      id: crypto.randomUUID(),
      goalId: curriculum.goalId,
      bookId: curriculum.bookId,
      status: "active",
      steps,
      currentIndex: 0,
      startedAt: now.getTime(),
      completedAt: null,
    };
    await deps.teachings.put(session);
    return session;
  });
}

export async function getTeachingSession(
  deps: TeachingEngineDeps,
  id: string,
): Promise<TeachingSession | null> {
  return deps.teachings.get(id);
}

export async function getActiveTeachingSession(
  deps: TeachingEngineDeps,
): Promise<TeachingSession | null> {
  return deps.teachings.getActive();
}

/** Generate the content for the current step (idempotent: cached content is
 * returned as-is so a re-render never re-bills the model). Fail-closed with an
 * honest per-step error when generation fails after one retry. */
export async function deliverCurrentStep(
  deps: TeachingEngineDeps,
  session: TeachingSession,
  bookTitle: string,
): Promise<TeachingSession> {
  if (session.status !== "active") throw new Error("The teaching session is not active");
  if (sessionIsComplete(session)) throw new Error("The teaching session is already complete");
  const step = currentTeachingStep(session);
  if (!step) throw new Error("The teaching session has no current step");
  if (step.content) return session;

  const chapterText = await deps.chapterText(step.conceptId);
  let content: TeachingContent;
  try {
    content = await generateTeachingContent({
      bookTitle,
      step,
      chapterText,
      llm: deps.llm,
    });
  } catch (error) {
    throw new TeachingStepFailedError(
      step.conceptId,
      error instanceof Error ? error.message : String(error),
    );
  }
  const updated: TeachingSession = {
    ...session,
    steps: session.steps.map((entry) =>
      entry.conceptId === step.conceptId ? { ...entry, content } : entry,
    ),
  };
  await deps.teachings.put(updated);
  return updated;
}

/** Grade the current step's comprehension check deterministically, record the
 * evidence (BKT + FSRS move), and advance. Fail-closed on missing content,
 * duplicate answers, or inactive sessions. */
export async function answerCurrentStep(
  deps: TeachingEngineDeps,
  session: TeachingSession,
  selectedOption: number,
): Promise<TeachingSession> {
  if (session.status !== "active") throw new Error("The teaching session is not active");
  const step = currentTeachingStep(session);
  if (!step) throw new Error("The teaching session has no current step");
  if (step.answered) throw new Error("The current step was already answered");
  const content = step.content;
  if (!content) throw new Error("Deliver the step content before answering");
  if (!Number.isInteger(selectedOption) || selectedOption < 0 || selectedOption > 3) {
    throw new Error("Selected option must be an integer in [0, 3]");
  }
  const correct = selectedOption === content.check.correctIndex;
  const now = deps.clock.now();

  await applyEvidenceEvent(
    {
      clock: deps.clock,
      evidence: deps.evidence,
      mastery: deps.mastery,
      reviews: deps.reviews,
    },
    teachingEvidence({ sessionId: session.id, step, correct }),
  );

  const steps = session.steps.map((entry) =>
    entry.conceptId === step.conceptId ? { ...entry, answered: true, correct } : entry,
  );
  const currentIndex = session.currentIndex + 1;
  const completed = currentIndex >= steps.length;
  const updated: TeachingSession = {
    ...session,
    steps,
    currentIndex,
    status: completed ? "completed" : "active",
    completedAt: completed ? now.getTime() : null,
  };
  await deps.teachings.put(updated);
  return updated;
}

/** Learner-state snapshot for the current step (read-only convenience for the
 * UI owner: shows where mastery stood before this step's evidence). */
export async function getStepLearnerState(
  deps: TeachingEngineDeps,
  conceptId: string,
): Promise<LearnerConceptState | null> {
  const row = await deps.mastery.get(conceptId);
  return row
    ? {
        mastery: row.mastery,
        status: row.status,
        evidenceCount: row.evidenceCount,
        lastVerified: row.lastVerified,
      }
    : null;
}
