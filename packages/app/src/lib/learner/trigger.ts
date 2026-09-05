// Learner trigger — app-layer adapter bridging the deterministic learner core
// (PR-004) with the app's SQLite persistence and the Read-Box quiz flow.
// Mirrors the book-skill trigger pattern.
//
// PR-012: evidence recording is durable-first. The judgement is enqueued to
// the SQLite evidence outbox BEFORE it is applied, so a crash between judging
// and persisting loses nothing — pending rows replay on the next launch. The
// apply itself is still kept off the quiz UX's critical path.

import {
  DuplicateEvidenceIdError,
  applyEvidenceEvent,
  createSqliteEvidenceOutbox,
  createSqliteLearnerStores,
  drainEvidenceOutbox,
  ensureChapterConceptIdentity,
  quizJudgementToEvidence,
} from "@readany/core/learner";
import type {
  ConceptIdentityStore,
  ConceptMastery,
  EvidenceOutboxDrainReport,
  LearnerClock,
  LearnerEngineDeps,
} from "@readany/core/learner";
import type {
  LearningQuizJudgement,
  LearningQuizQuestion,
  LearningSourceRef,
} from "@readany/core/learning";

const realClock: LearnerClock = {
  now: () => new Date(),
};

export async function createLearnerEngineDeps(): Promise<
  LearnerEngineDeps & { identity: ConceptIdentityStore }
> {
  return {
    clock: realClock,
    ...createSqliteLearnerStores(),
  };
}

/** Record one judged Read-Box quiz answer as learner evidence. Durable-first:
 * the deterministic event (id pinned from the question content) is persisted
 * to the outbox, applied through the engine, then marked done. If the event
 * was already applied (retry/replay), the stored mastery row is returned. */
export async function recordQuizEvidence(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
  question: LearningQuizQuestion,
): Promise<ConceptMastery> {
  const deps = await createLearnerEngineDeps();
  const outbox = createSqliteEvidenceOutbox();
  const event = quizJudgementToEvidence(judgement, source, question);
  // PR-015: the chapter concept is registered (idempotently) at its first
  // piece of evidence, so the identity registry stays complete even when the
  // learner quizzes without ever creating a goal or running placement.
  await ensureChapterConceptIdentity(
    deps.identity,
    {
      bookId: source.readAnyBookId,
      chapterIndex: source.location.chapterIndex,
      title: source.title,
    },
    Date.now(),
  );
  const { outboxId, event: pinned } = await outbox.enqueue(event, Date.now());
  try {
    const result = await applyEvidenceEvent(deps, pinned);
    await outbox.markDone(outboxId);
    return result;
  } catch (error) {
    if (error instanceof DuplicateEvidenceIdError) {
      await outbox.markDone(outboxId);
      const existing = await deps.mastery.get(pinned.conceptId);
      if (existing) return existing;
    }
    // Leave the row pending: the next drain (launch or a later quiz answer)
    // retries it. The caller decides how loudly to surface the failure.
    throw error;
  }
}

/** Replays evidence rows that were enqueued but never applied (crash, failed
 * write). Fire-and-forget at startup; failed rows stay pending for the next
 * drain, and one poison row can never wedge the queue (attempt cap). */
export function replayPendingLearnerEvidence(): Promise<EvidenceOutboxDrainReport> {
  return (async () => {
    const deps = await createLearnerEngineDeps();
    return drainEvidenceOutbox(deps, createSqliteEvidenceOutbox());
  })();
}

/** The learner vouches for the quiz verdict (PR-014 tail): records a second,
 * fully-trusted evidence event derived from the same judgement. The original
 * llm_judged event keeps its 0.4 weight — the confirmation adds the missing
 * trust instead of rewriting the append-only ledger. */
export async function confirmQuizEvidence(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
  question: LearningQuizQuestion,
): Promise<ConceptMastery> {
  const deps = await createLearnerEngineDeps();
  const event = quizJudgementToEvidence(judgement, source, question);
  return applyEvidenceEvent(deps, {
    id: `${event.id}:confirmed`,
    conceptId: event.conceptId,
    source: "MANUAL",
    taskType: "quiz",
    questionType: event.questionType,
    result: event.result,
    confidence: 1,
    verification: "user_confirmed",
    sourceLocator: event.sourceLocator,
  });
}
