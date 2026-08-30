import { describe, expect, it } from "vitest";
import type { LearningQuizJudgement, LearningSourceRef } from "../learning/types";
import { chapterConceptId, quizJudgementToEvidence } from "./evidence-mapping";

const SOURCE: LearningSourceRef = {
  readAnyBookId: "book-1",
  readAnyChapterId: "3",
  location: { chapterIndex: 3, chapterHref: "ch003.xhtml", cfi: "epubcfi(/6/14)" },
  title: "Averages",
  text: "...",
  passages: [],
};

const CORRECT: LearningQuizJudgement = {
  correct: true,
  explanation: "right",
  current: 1,
  total: 5,
  correctCount: 1,
};

const INCORRECT: LearningQuizJudgement = { ...CORRECT, correct: false };

describe("quiz evidence admission mapping", () => {
  it("derives the chapter-scoped interim concept identity", () => {
    expect(chapterConceptId(SOURCE)).toBe("readany:book:book-1:chapter:3");
  });

  it("maps a judged quiz answer to deterministic evidence input", () => {
    expect(quizJudgementToEvidence(CORRECT, SOURCE)).toEqual({
      conceptId: "readany:book:book-1:chapter:3",
      source: "READ_BOX_QUIZ",
      taskType: "quiz",
      result: "correct",
      confidence: 1,
      sourceLocator: { bookId: "book-1", chapterIndex: 3, cfi: "epubcfi(/6/14)" },
    });
    expect(quizJudgementToEvidence(INCORRECT, SOURCE).result).toBe("incorrect");
  });

  it("carries the citation back to the canonical source (handoff §9 sourceLocator)", () => {
    const evidence = quizJudgementToEvidence(CORRECT, SOURCE);
    expect(evidence.sourceLocator?.bookId).toBe(SOURCE.readAnyBookId);
    expect(evidence.sourceLocator?.chapterIndex).toBe(SOURCE.location.chapterIndex);
    expect(evidence.sourceLocator?.cfi).toBe(SOURCE.location.cfi);
  });

  it("admits evidence without a timestamp (the engine's injected clock owns time)", () => {
    const evidence = quizJudgementToEvidence(CORRECT, SOURCE) as Record<string, unknown>;
    expect("timestamp" in evidence).toBe(false);
    expect("id" in evidence).toBe(false);
  });
});
