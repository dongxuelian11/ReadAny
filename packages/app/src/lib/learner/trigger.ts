// Learner trigger — app-layer adapter bridging the deterministic learner core
// (PR-004) with the app's SQLite persistence and the Read-Box quiz flow.
// Mirrors the book-skill trigger pattern.
//
// PR-012: evidence recording is durable-first. The judgement is enqueued to
// the SQLite evidence outbox BEFORE it is applied, so a crash between judging
// and persisting loses nothing — pending rows replay on the next launch. The
// apply itself is still kept off the quiz UX's critical path.

import {
  applyEvidenceEventResult,
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
  LearnerEvidenceConfirmationStore,
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
  LearnerEngineDeps & {
    identity: ConceptIdentityStore;
    confirmations: LearnerEvidenceConfirmationStore;
  }
> {
  return {
    clock: realClock,
    ...createSqliteLearnerStores(),
  };
}

/** Record one judged Read-Box quiz answer as learner evidence. Durable-first:
 * the deterministic event (id pinned per ATTEMPT, timestamp pinned at
 * judgement time) is persisted to the outbox, applied through the engine,
 * then marked done. The engine apply is resumable: a crash mid-apply replays
 * the remaining steps exactly once on the next drain. The caller mints one
 * attemptId per answering occurrence and keeps it for the confirm step; a
 * NEW attempt at the same question passes a fresh attemptId and counts again,
 * while re-submitting the same attempt returns the stored mastery. */
export async function recordQuizEvidence(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
  question: LearningQuizQuestion,
  attemptId: string,
): Promise<ConceptMastery> {
  const deps = await createLearnerEngineDeps();
  const outbox = createSqliteEvidenceOutbox();
  // The attemptId is persisted via the outbox enqueue, so retries/replays
  // reuse the pinned id and never double-apply.
  const event = quizJudgementToEvidence(judgement, source, question, attemptId);
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
    const result = await applyEvidenceEventResult(deps, pinned);
    await outbox.markDone(outboxId);
    return result.mastery;
  } catch (error) {
    // Any failure here (including a genuine input conflict) leaves the row
    // pending: the next drain (launch or a later quiz answer) retries it. The
    // caller decides how loudly to surface the failure.
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

/** The learner vouches for the quiz verdict (PR-014 tail). Since iter-1 this
 * is pure confirmation metadata: it records that the learner vouched for the
 * verdict WITHOUT a second evidence event, so confirming never moves BKT or
 * FSRS a second time. The vouch time is stored next to the event id. */
export async function confirmQuizEvidence(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
  question: LearningQuizQuestion,
  attemptId: string,
): Promise<void> {
  const deps = await createLearnerEngineDeps();
  const event = quizJudgementToEvidence(judgement, source, question, attemptId);
  await deps.confirmations.record(event.id, Date.now());
}
