import { describe, expect, it } from "vitest";
import type {
  LearningQuizJudgement,
  LearningQuizQuestion,
  LearningSourceRef,
} from "../learning/types";
import { chapterConceptId, quizEvidenceId, quizJudgementToEvidence } from "./evidence-mapping";

const SOURCE: LearningSourceRef = {
  readAnyBookId: "book-1",
  readAnyChapterId: "3",
  location: { chapterIndex: 3, chapterHref: "ch003.xhtml", cfi: "epubcfi(/6/14)" },
  title: "Averages",
  text: "...",
  passages: [],
};

const QUESTION: LearningQuizQuestion = {
  type: "mc",
  question: "What does the mean measure?",
  options: ["Central tendency", "Spread", "Skew", "Shape"],
};

const OTHER_QUESTION: LearningQuizQuestion = {
  ...QUESTION,
  question: "What does the variance measure?",
};

const CORRECT: LearningQuizJudgement = {
  correct: true,
  explanation: "right",
  current: 1,
  total: 5,
  correctCount: 1,
};

const INCORRECT: LearningQuizJudgement = { ...CORRECT, correct: false };

const ATTEMPT = "attempt-7";

describe("quiz evidence admission mapping", () => {
  it("derives the chapter-scoped interim concept identity", () => {
    expect(chapterConceptId(SOURCE)).toBe("readany:book:book-1:chapter:3");
  });

  it("maps a judged quiz answer to deterministic evidence input", () => {
    expect(quizJudgementToEvidence(CORRECT, SOURCE, QUESTION, ATTEMPT)).toMatchObject({
      conceptId: "readany:book:book-1:chapter:3",
      source: "READ_BOX_QUIZ",
      taskType: "quiz",
      result: "correct",
      confidence: 1,
      verification: "llm_judged",
      sourceLocator: { bookId: "book-1", chapterIndex: 3, cfi: "epubcfi(/6/14)" },
    });
    expect(quizJudgementToEvidence(INCORRECT, SOURCE, QUESTION, ATTEMPT).result).toBe("incorrect");
  });

  it("pins an attempt-scoped id: same attempt → same id, new attempt or question → new id", () => {
    const first = quizJudgementToEvidence(CORRECT, SOURCE, QUESTION, ATTEMPT);
    const retry = quizJudgementToEvidence(CORRECT, SOURCE, QUESTION, ATTEMPT);
    expect(retry.id).toBe(first.id);
    expect(first.id).toBe(quizEvidenceId(SOURCE, QUESTION, ATTEMPT));

    // A NEW attempt at the same question is a distinct answering occurrence:
    // yesterday's wrong answer and today's right one both get recorded.
    const nextAttempt = quizJudgementToEvidence(CORRECT, SOURCE, QUESTION, "attempt-8");
    expect(nextAttempt.id).not.toBe(first.id);

    const otherQuestion = quizJudgementToEvidence(CORRECT, SOURCE, OTHER_QUESTION, ATTEMPT);
    expect(otherQuestion.id).not.toBe(first.id);

    // The chosen answer no longer perturbs the id (the attempt owns identity).
    const otherSlot = quizJudgementToEvidence({ ...CORRECT, current: 2 }, SOURCE, QUESTION, ATTEMPT);
    expect(otherSlot.id).toBe(first.id);

    // The id embeds the chapter-scoped identity and the attempt, so replays
    // stay book-scoped and attempt-scoped.
    expect(first.id).toContain("readany:quiz:book-1:ch3:attempt-7:");
  });

  it("carries the citation back to the canonical source (handoff §9 sourceLocator)", () => {
    const evidence = quizJudgementToEvidence(CORRECT, SOURCE, QUESTION, ATTEMPT);
    expect(evidence.sourceLocator?.bookId).toBe(SOURCE.readAnyBookId);
    expect(evidence.sourceLocator?.chapterIndex).toBe(SOURCE.location.chapterIndex);
    expect(evidence.sourceLocator?.cfi).toBe(SOURCE.location.cfi);
  });

  it("admits evidence without a timestamp (the outbox enqueue pins the answer time)", () => {
    const evidence = quizJudgementToEvidence(
      CORRECT,
      SOURCE,
      QUESTION,
      ATTEMPT,
    ) as Record<string, unknown>;
    expect("timestamp" in evidence).toBe(false);
  });
});
