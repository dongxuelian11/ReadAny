// Evidence admission mapping for the existing Read-Box chapter quiz (PR-001).
// Interim concept identity is CHAPTER-SCOPED: the Read-Box quiz judges a whole
// chapter and carries no concept tags, so the learner core accumulates
// chapter-level mastery until the Book Skill / knowledge graph provides real
// concept ids. This is a documented interim, not a hidden conflation — the
// concept-id format makes the scope explicit in every row.
//
// PR-012: quiz evidence carries a DETERMINISTIC id derived from the judged
// question's content, so retries and outbox replays of the same submission
// dedupe against the append-only ledger instead of double-applying BKT.

import type {
  LearningQuizJudgement,
  LearningQuizQuestion,
  LearningSourceRef,
} from "../learning/types";
import type { EvidenceEventInput } from "./engine";

export function chapterConceptId(source: LearningSourceRef): string {
  return `readany:book:${source.readAnyBookId}:chapter:${source.location.chapterIndex}`;
}

/** Stable cross-platform content hash (djb2, hex). Evidence ids must be
 * reproducible for replay dedupe, so no platform crypto API is involved. */
function quizContentHash(question: LearningQuizQuestion): string {
  const seed = `${question.type ?? ""}|${question.question}|${(question.options ?? []).join("||")}`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash * 33) ^ seed.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Deterministic evidence id for one judged quiz answer: stable across retries
 * and replays of the same submission, distinct for distinct question content.
 * Two sessions that generate the identical question text for the same chapter
 * slot are treated as the same evidence (documented dedupe semantics).
 */
export function quizEvidenceId(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
  question: LearningQuizQuestion,
): string {
  return `readany:quiz:${source.readAnyBookId}:ch${source.location.chapterIndex}:${judgement.current}:${quizContentHash(question)}`;
}

/** Map a judged Read-Box quiz answer to a deterministic evidence input. */
export function quizJudgementToEvidence(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
  question: LearningQuizQuestion,
): EvidenceEventInput {
  return {
    id: quizEvidenceId(judgement, source, question),
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
