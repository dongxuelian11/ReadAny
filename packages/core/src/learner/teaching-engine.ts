// Teaching session lifecycle over the deterministic core. Sessions are
// user-initiated and quiet: content is generated only when the caller asks for
// the current step, answers are graded deterministically, and every answer
// becomes evidence through applyEvidenceEvent (BKT + FSRS move through the
// exact PR-004/005 path). Fail-closed throughout: unknown/duplicate answers,
// inactive sessions, and step-generation failures never silently pass.

import { SessionStaleError, applyEvidenceEventResult } from "./engine";
export { SessionStaleError } from "./engine";
import type { PersonalCurriculum } from "./goal";
import type { LearnerConceptState } from "./goal";
import { getLearnerStateAt } from "./read-model";
import {
  type ChapterTextProvider,
  TEACHING_HELP_VARIANTS_MAX,
  TEACHING_STUCK_NOTE_MAX,
  type TeachingHelpRequest,
  type TeachingLlmClient,
  type TeachingSession,
  type TeachingStep,
  currentTeachingStep,
  describeLearnerBasis,
  generateTeachingContent,
  generateTeachingHelp,
  selectSourceWindow,
  sessionIsComplete,
  teachingEvidence,
} from "./teaching";
import type { SourceWindow, TeachingContent, TeachingHelpVariant } from "./teaching";
import type { TeachingStore } from "./teaching-store";
import type { LearnerClock } from "./types";
import { withLearnerWriteLock } from "./write-lock";

export interface TeachingEngineDeps {
  clock: LearnerClock;
  evidence: import("./types").LearnerEvidenceStore;
  mastery: import("./types").LearnerMasteryStore;
  reviews: import("./types").LearnerReviewStore;
  teachings: TeachingStore;
  /** WP-A: forwarded so the answer commit can carry the completion record and
   * the guarded session advance in one storage transaction. */
  completions?: import("./commit").LearnerEvidenceCompletionStore;
  atomic?: import("./commit").LearnerAtomicCommit;
  llm: TeachingLlmClient;
  chapterText: ChapterTextProvider;
  /** Independent teaching output language (e.g. "zh-CN"); undefined/"auto"
   * follows the chapter text's language. See teaching.ts. */
  learningLanguage?: string;
}

export class TeachingStepFailedError extends Error {
  constructor(conceptId: string, detail: string) {
    super(`Teaching content for ${conceptId} could not be generated: ${detail}`);
    this.name = "TeachingStepFailedError";
  }
}

/** Start a teaching session from a curriculum; abandons the previously active
 * session OF THE SAME BOOK only (WP-A, F05): supersession is book-scoped, so
 * starting book B keeps book A's resumable session intact. The abandon-then-
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
    const active =
      (await deps.teachings.getActiveByBook?.(curriculum.bookId)) ??
      (await deps.teachings.getActive());
    // Only a session of THIS book is superseded; a global active of another
    // book stays resumable.
    const superseded =
      active && active.bookId === curriculum.bookId && active.status === "active" ? active : null;
    if (superseded) {
      await deps.teachings.put({
        ...superseded,
        status: "abandoned",
        completedAt: now.getTime(),
      });
    }
    const steps: TeachingStep[] = curriculum.steps.map((step) => ({
      conceptId: step.conceptId,
      title: step.title,
      action: step.action,
      // LEARN-01: the goal's depth travels with the step so the prompt can
      // pitch to the target instead of defaulting to "from scratch".
      depth: step.depth,
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

/** The active teaching session — scoped to a book when the caller passes one
 * (PR32-followup, F05): the durable store keeps one active session per book,
 * so a resume must read THIS book's row instead of the globally newest one
 * (with A and B both active, the global read returned B and left book A
 * without a resume path). Stores without the by-book read fall back to the
 * global active filtered by bookId. */
export async function getActiveTeachingSession(
  deps: TeachingEngineDeps,
  bookId?: string,
): Promise<TeachingSession | null> {
  if (bookId === undefined) return deps.teachings.getActive();
  const byBook = await deps.teachings.getActiveByBook?.(bookId);
  if (byBook) return byBook;
  const global = await deps.teachings.getActive();
  return global && global.bookId === bookId && global.status === "active" ? global : null;
}

/** The honest learner-context sentence for one step: mastery status, a
 * handful of recent attempts (never the whole history), and the step's target
 * depth. Unknown basis is never asserted as zero basis. Failures degrade to
 * "no context" — context is additive, never load-bearing. */
async function buildLearnerContext(
  deps: TeachingEngineDeps,
  step: TeachingStep,
): Promise<string | undefined> {
  try {
    const [entry] = await getLearnerStateAt(deps, [step.conceptId]);
    let recent: Array<{ result: string }> = [];
    try {
      recent = (await deps.evidence.listByConcept(step.conceptId)).slice(-5);
    } catch {
      // Recent attempts are additive context only.
    }
    return describeLearnerBasis({ state: entry?.state ?? null, recent, depth: step.depth ?? null });
  } catch {
    return undefined;
  }
}

/** Generate the content for the current step (idempotent: cached content is
 * returned as-is so a re-render never re-bills the model). Fail-closed with an
 * honest per-step error when generation fails after one retry. LEARN-01:
 * `focusExcerpt` anchors the source window on the passage the learner is
 * actually looking at, so a long chapter is not always taught from its head;
 * partial coverage is recorded on the content. */
export async function deliverCurrentStep(
  deps: TeachingEngineDeps,
  session: TeachingSession,
  bookTitle: string,
  options?: { focusExcerpt?: string | null },
): Promise<TeachingSession> {
  if (session.status !== "active") throw new Error("The teaching session is not active");
  if (sessionIsComplete(session)) throw new Error("The teaching session is already complete");
  const step = currentTeachingStep(session);
  if (!step) throw new Error("The teaching session has no current step");
  if (step.content) return session;

  const chapterText = await deps.chapterText(step.conceptId);
  const window = selectSourceWindow({ chapterText, focus: options?.focusExcerpt ?? null });
  const learnerContext = await buildLearnerContext(deps, step);
  let content: TeachingContent;
  try {
    content = await generateTeachingContent({
      bookTitle,
      step,
      chapterText,
      llm: deps.llm,
      learningLanguage: deps.learningLanguage,
      learnerContext,
      sourceWindow: window,
    });
  } catch (error) {
    throw new TeachingStepFailedError(
      step.conceptId,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (window.start > 0 || window.end < window.total) {
    content = {
      ...content,
      source: { start: window.start, end: window.end, total: window.total },
    };
  }

  // Late-generation guard (WP-A, F05): the model result must never write an
  // OLD session snapshot over the current state. Re-read the session inside
  // the write lock and patch ONLY the step content when the session is still
  // active and the step is still current — a session abandoned, superseded,
  // completed, or advanced during generation is left exactly as stored, and
  // the stored (non-revived) view is returned.
  return withLearnerWriteLock(async () => {
    const stored = await deps.teachings.get(session.id);
    if (!stored) return { ...session, steps: session.steps };
    if (stored.status !== "active") return stored;
    const target = stored.steps.find((entry) => entry.conceptId === step.conceptId);
    if (!target || target.content) return stored;
    const updated: TeachingSession = {
      ...stored,
      steps: stored.steps.map((entry) =>
        entry.conceptId === step.conceptId ? { ...entry, content } : entry,
      ),
    };
    await deps.teachings.put(updated);
    return updated;
  });
}

/** LEARN-01: ask for help on the CURRENT step — a simpler explanation, a
 * different example, or a re-explanation of the learner's stated sticking
 * point. The response is attached to the step as a bounded help variant:
 *   - the issued check question and its answer key are NEVER sent to the
 *     model and never modified;
 *   - no evidence event is written — help is not a practice record, so BKT/
 *     FSRS/evidence stay untouched;
 *   - the guarded write (same pattern as content delivery) means a response
 *     that arrives after the step was answered, advanced, or superseded is
 *     dropped, never written over the newer state.
 * Returns the stored session unchanged when the late-write guard dropped the
 * variant (the caller compares currentIndex to detect this). */
export async function requestTeachingHelp(
  deps: TeachingEngineDeps,
  params: {
    bookTitle: string;
    session: TeachingSession;
    help: TeachingHelpRequest;
    focusExcerpt?: string | null;
  },
): Promise<TeachingSession> {
  const { session } = params;
  if (session.status !== "active") throw new Error("The teaching session is not active");
  const step = currentTeachingStep(session);
  if (!step) throw new Error("The teaching session has no current step");
  const content = step.content;
  if (!content) throw new Error("Deliver the step content before requesting help");
  if (step.answered) throw new Error("The current step was already answered");
  // Fail fast on a stale snapshot (before any LLM call): the authoritative
  // answered/advanced state lives in the store — never bill a help call the
  // write guard would drop anyway.
  const storedNow = await deps.teachings.get(session.id);
  if (storedNow) {
    if (storedNow.status !== "active" || storedNow.currentIndex !== session.currentIndex) {
      throw new SessionStaleError(session.id);
    }
    const storedStep = storedNow.steps.find((entry) => entry.conceptId === step.conceptId);
    if (storedStep?.answered) throw new Error("The current step was already answered");
  }
  const requestIndex = session.currentIndex;

  const chapterText = await deps.chapterText(step.conceptId);
  const window: SourceWindow = selectSourceWindow({
    chapterText,
    focus: params.focusExcerpt ?? null,
  });
  const learnerContext = await buildLearnerContext(deps, step);
  const draft = await generateTeachingHelp({
    bookTitle: params.bookTitle,
    chapterTitle: step.title,
    chapterText,
    learningLanguage: deps.learningLanguage,
    help: params.help,
    originalExplanation: content.explanation,
    originalExample: content.workedExample,
    learnerContext,
    sourceWindow: window,
    llm: deps.llm,
  });
  const variant: TeachingHelpVariant = {
    id: crypto.randomUUID(),
    kind: params.help.kind,
    note: params.help.note?.trim()
      ? params.help.note.trim().slice(0, TEACHING_STUCK_NOTE_MAX)
      : null,
    text: draft.explanation,
    example: draft.example,
    createdAt: deps.clock.now().getTime(),
    source:
      window.start > 0 || window.end < window.total
        ? { start: window.start, end: window.end, total: window.total }
        : null,
  };

  return withLearnerWriteLock(async () => {
    const stored = await deps.teachings.get(session.id);
    if (!stored || stored.status !== "active") return stored ?? session;
    if (stored.currentIndex !== requestIndex) return stored;
    const target = stored.steps.find((entry) => entry.conceptId === step.conceptId);
    if (!target || target.answered) return stored;
    const variants = [...(target.helpVariants ?? []), variant].slice(-TEACHING_HELP_VARIANTS_MAX);
    const updated: TeachingSession = {
      ...stored,
      steps: stored.steps.map((entry) =>
        entry.conceptId === step.conceptId ? { ...entry, helpVariants: variants } : entry,
      ),
    };
    await deps.teachings.put(updated);
    return updated;
  });
}

/** The deps answerCurrentStep actually uses (iter-2): grading is local — no
 * book extraction, no model client. Hosts pass the narrow object so the
 * answer path can never drag generation machinery along. */
export type TeachingAnswerDeps = Pick<
  TeachingEngineDeps,
  "clock" | "evidence" | "mastery" | "reviews" | "teachings" | "completions" | "atomic"
>;

/** Grade the current step's comprehension check deterministically, record the
 * evidence (BKT + FSRS move), and advance. Fail-closed on missing content,
 * duplicate answers, or inactive sessions. Crash-resumable (iter-1): if the
 * evidence applied but the session write failed, a retry with the same
 * session resumes — the idempotent engine skips the already-applied event and
 * the advance completes. */
export async function answerCurrentStep(
  deps: TeachingAnswerDeps,
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

  // The answer time is stamped ON the evidence (iter-1): a retry after a
  // crash replays with the same pinned timestamp, so the FSRS/BKT outcome is
  // byte-identical instead of silently moving to the retry instant.
  const event = {
    ...teachingEvidence({ sessionId: session.id, step, correct }),
    timestamp: now.getTime(),
  };

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

  const engineDeps = {
    clock: deps.clock,
    evidence: deps.evidence,
    mastery: deps.mastery,
    reviews: deps.reviews,
    completions: deps.completions,
    atomic: deps.atomic,
  };

  if (deps.atomic) {
    // Atomic path (WP-A): evidence + completion record + the guarded session
    // advance land in ONE storage transaction. A session that was abandoned,
    // superseded, or already advanced refuses the whole commit.
    await applyEvidenceEventResult(engineDeps, event, {
      session: {
        expected: {
          id: session.id,
          status: session.status,
          currentIndex: session.currentIndex,
        },
        session: updated,
      },
    });
    return updated;
  }

  await applyEvidenceEventResult(engineDeps, event);

  // Fallback path: guarded session write. Re-read the session and advance only
  // when it is still the same active session at the same step — a retry after
  // a lost write resumes; a superseded session is surfaced, never overwritten.
  return withLearnerWriteLock(async () => {
    const stored = await deps.teachings.get(session.id);
    if (!stored) throw new SessionStaleError(session.id);
    if (
      stored.status !== "active" ||
      stored.currentIndex !== session.currentIndex ||
      stored.steps.find((entry) => entry.conceptId === step.conceptId)?.answered
    ) {
      return stored;
    }
    await deps.teachings.put(updated);
    return updated;
  });
}

/** Learner-state snapshot for the current step (read-only convenience for the
 * UI owner): computed through the current-instant read model (PR-013) so the
 * displayed status reflects forgetting at the read instant, not the stale
 * persisted status. Shows where mastery stands before this step's evidence. */
export async function getStepLearnerState(
  deps: TeachingEngineDeps,
  conceptId: string,
): Promise<LearnerConceptState | null> {
  const [entry] = await getLearnerStateAt(deps, [conceptId]);
  const row = entry?.state ?? null;
  return row
    ? {
        mastery: row.mastery,
        status: row.status,
        evidenceCount: row.evidenceCount,
        lastVerified: row.lastVerified,
      }
    : null;
}
