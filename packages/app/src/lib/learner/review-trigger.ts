// Review trigger — the bounded due-review flow (iter-2). A review walks the
// due list one concept at a time: generate a comprehension check from the
// canonical chapter text (the SAME grounded generation path as teaching, with
// the review prompt variant), grade locally, and record the answer through
// the durable-first resumable evidence path. The queue is deliberately not
// persisted — a crash mid-review just leaves that item due; the evidence
// itself is durable.

import {
  createSqliteEvidenceOutbox,
  applyEvidenceEventResult,
} from "@readany/core/learner";
import type {
  ConceptMastery,
  TeachingContent,
  TeachingStep,
} from "@readany/core/learner";
import { generateTeachingContent } from "@readany/core/learner";
import type { Book } from "@readany/core/types";
import { createLearnerEngineDeps } from "./trigger";
import { createTeachingGenerationDeps } from "./teaching-trigger";

/** Upper bound of one review sitting: the flow is a bounded queue, not a
 * scheduling platform. */
export const REVIEW_QUEUE_LIMIT = 20;

export function boundReviewQueue(dueConceptIds: string[]): string[] {
  return dueConceptIds.slice(0, REVIEW_QUEUE_LIMIT);
}

/** Generate the review content for one due concept. Reuses the teaching
 * generator so pacing, JSON validation, and the one-retry policy stay
 * identical to the goal flow. */
export async function deliverReviewItem(
  book: Book,
  conceptId: string,
  title: string,
): Promise<TeachingContent> {
  const deps = await createTeachingGenerationDeps(book);
  const step: TeachingStep = {
    conceptId,
    title,
    action: "review",
    content: null,
    answered: false,
    correct: null,
  };
  return generateTeachingContent({
    bookTitle: book.meta.title,
    step,
    chapterText: await deps.chapterText(conceptId),
    llm: deps.llm,
  });
}

/** Record one graded review answer as learner evidence. Durable-first and
 * attempt-scoped (iter-1 semantics): the caller mints one attemptId per
 * review answer, retries reuse it, and a new review of the same concept gets
 * a fresh one. The graded-trust level is deterministic_keyed — the grading is
 * deterministic code against an LLM-authored answer key. */
export async function recordReviewEvidence(
  conceptId: string,
  correct: boolean,
  attemptId: string,
): Promise<ConceptMastery> {
  const deps = await createLearnerEngineDeps();
  const outbox = createSqliteEvidenceOutbox();
  const event = {
    id: `readany:review:${conceptId}:${attemptId}`,
    conceptId,
    source: "REVIEW" as const,
    taskType: "review" as const,
    questionType: "mc" as const,
    result: correct ? ("correct" as const) : ("incorrect" as const),
    confidence: 1,
    verification: "deterministic_keyed" as const,
  };
  const { outboxId, event: pinned } = await outbox.enqueue(event, Date.now());
  const result = await applyEvidenceEventResult(deps, pinned);
  await outbox.markDone(outboxId);
  return result.mastery;
}
