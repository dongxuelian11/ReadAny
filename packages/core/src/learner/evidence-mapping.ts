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
 * Deterministic evidence id for one judged quiz answer: the QUESTION hash
 * identifies the question, the attemptId identifies THIS answering occurrence.
 * A retry/replay of the same attempt reuses the same id (dedupe against the
 * append-only ledger); re-answering the same question in a later session mints
 * a fresh attemptId, so yesterday's wrong answer and today's right one are
 * both recorded (iter-1: the attempt, not the question, is the dedupe unit).
 * The caller pins the judgement timestamp on the event so replays keep the
 * original answer time.
 */
export function quizEvidenceId(
  source: LearningSourceRef,
  question: LearningQuizQuestion,
  attemptId: string,
): string {
  return `readany:quiz:${source.readAnyBookId}:ch${source.location.chapterIndex}:${attemptId}:${quizContentHash(question)}`;
}

/** Map a judged Read-Box quiz answer to an evidence input. The id requires a
 * caller-supplied attemptId (one per answering occurrence, persisted via the
 * outbox enqueue); the caller also pins the event timestamp. */
export function quizJudgementToEvidence(
  judgement: LearningQuizJudgement,
  source: LearningSourceRef,
  question: LearningQuizQuestion,
  attemptId: string,
): Omit<EvidenceEventInput, "id" | "timestamp"> & { id: string; timestamp?: number } {
  return {
    id: quizEvidenceId(source, question, attemptId),
    conceptId: chapterConceptId(source),
    source: "READ_BOX_QUIZ",
    taskType: "quiz",
    result: judgement.correct ? "correct" : "incorrect",
    confidence: 1,
    // Admission authority (PR-014): the quiz question is LLM-generated and the
    // free-form answer is LLM-judged by the Read-Box sidecar — low trust until
    // the learner confirms it.
    verification: "llm_judged",
    sourceLocator: {
      bookId: source.readAnyBookId,
      chapterIndex: source.location.chapterIndex,
      cfi: source.location.cfi,
    },
  };
}
