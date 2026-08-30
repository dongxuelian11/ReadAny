// Learner trigger — app-layer adapter bridging the deterministic learner core
// (PR-004) with the app's SQLite persistence and the Read-Box quiz flow.
// Mirrors the book-skill trigger pattern. Evidence recording is
// fire-and-forget by design: a persistence failure must never disrupt the
// quiz UX (same rule as the Read-Box worker not disabling the Reader).

import {
  applyEvidenceEvent,
  createSqliteLearnerStores,
  quizJudgementToEvidence,
} from "@readany/core/learner";
import type { ConceptMastery, LearnerClock, LearnerEngineDeps } from "@readany/core/learner";
import type { LearningQuizJudgement, LearningSourceRef } from "@readany/core/learning";

const realClock: LearnerClock = {
  now: () => new Date(),
};

export async function createLearnerEngineDeps(): Promise<LearnerEngineDeps> {
  return {
    clock: realClock,
    ...createSqliteLearnerStores(),
  };
}

/** Record one judged Read-Box quiz answer as learner evidence. */
export async function recordQuizEvidence(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
): Promise<ConceptMastery> {
  const deps = await createLearnerEngineDeps();
  return applyEvidenceEvent(deps, quizJudgementToEvidence(judgement, source));
}
