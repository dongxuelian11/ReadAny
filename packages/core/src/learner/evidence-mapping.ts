// Evidence admission mapping for the existing Read-Box chapter quiz (PR-001).
// Interim concept identity is CHAPTER-SCOPED: the Read-Box quiz judges a whole
// chapter and carries no concept tags, so the learner core accumulates
// chapter-level mastery until the Book Skill / knowledge graph provides real
// concept ids. This is a documented interim, not a hidden conflation — the
// concept-id format makes the scope explicit in every row.

import type { LearningQuizJudgement, LearningSourceRef } from "../learning/types";
import type { EvidenceEventInput } from "./engine";

export function chapterConceptId(source: LearningSourceRef): string {
  return `readany:book:${source.readAnyBookId}:chapter:${source.location.chapterIndex}`;
}

/** Map a judged Read-Box quiz answer to a deterministic evidence input. */
export function quizJudgementToEvidence(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
): EvidenceEventInput {
  return {
    conceptId: chapterConceptId(source),
    source: "READ_BOX_QUIZ",
    taskType: "quiz",
    result: judgement.correct ? "correct" : "incorrect",
    confidence: 1,
    sourceLocator: {
      bookId: source.readAnyBookId,
      chapterIndex: source.location.chapterIndex,
      cfi: source.location.cfi,
    },
  };
}
