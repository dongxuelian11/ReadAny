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

describe("quiz evidence admission mapping", () => {
  it("derives the chapter-scoped interim concept identity", () => {
    expect(chapterConceptId(SOURCE)).toBe("readany:book:book-1:chapter:3");
  });

  it("maps a judged quiz answer to deterministic evidence input", () => {
    expect(quizJudgementToEvidence(CORRECT, SOURCE, QUESTION)).toMatchObject({
      conceptId: "readany:book:book-1:chapter:3",
      source: "READ_BOX_QUIZ",
      taskType: "quiz",
      result: "correct",
      confidence: 1,
      sourceLocator: { bookId: "book-1", chapterIndex: 3, cfi: "epubcfi(/6/14)" },
    });
    expect(quizJudgementToEvidence(INCORRECT, SOURCE, QUESTION).result).toBe("incorrect");
  });

  it("pins a deterministic id: same submission → same id, distinct question → distinct id", () => {
    const first = quizJudgementToEvidence(CORRECT, SOURCE, QUESTION);
    const retry = quizJudgementToEvidence(CORRECT, SOURCE, QUESTION);
    expect(retry.id).toBe(first.id);
    expect(first.id).toBe(quizEvidenceId(CORRECT, SOURCE, QUESTION));

    const otherQuestion = quizJudgementToEvidence(CORRECT, SOURCE, OTHER_QUESTION);
    expect(otherQuestion.id).not.toBe(first.id);

    const otherSlot = quizJudgementToEvidence({ ...CORRECT, current: 2 }, SOURCE, QUESTION);
    expect(otherSlot.id).not.toBe(first.id);

    // The id embeds the chapter-scoped identity so replays stay book-scoped.
    expect(first.id).toContain("readany:quiz:book-1:ch3:1:");
  });

  it("carries the citation back to the canonical source (handoff §9 sourceLocator)", () => {
    const evidence = quizJudgementToEvidence(CORRECT, SOURCE, QUESTION);
    expect(evidence.sourceLocator?.bookId).toBe(SOURCE.readAnyBookId);
    expect(evidence.sourceLocator?.chapterIndex).toBe(SOURCE.location.chapterIndex);
    expect(evidence.sourceLocator?.cfi).toBe(SOURCE.location.cfi);
  });

  it("admits evidence without a timestamp (the engine's injected clock owns time)", () => {
    const evidence = quizJudgementToEvidence(CORRECT, SOURCE, QUESTION) as Record<string, unknown>;
    expect("timestamp" in evidence).toBe(false);
  });
});
