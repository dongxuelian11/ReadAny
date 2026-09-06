import { describe, expect, it } from "vitest";
import { orderStepsByPrerequisites } from "./goal";
import type { CurriculumStep } from "./goal";

function step(conceptId: string, index: number): CurriculumStep {
  return {
    conceptId,
    title: conceptId,
    depth: "working",
    action: "learn",
    kind: "missing",
    reason: "not started yet",
    index,
  };
}

function chapterConcept(bookId: string, chapterIndex: number): string {
  return `readany:book:${bookId}:chapter:${chapterIndex}`;
}

describe("prerequisite-aware curriculum ordering (PR-026)", () => {
  it("reorders steps so a prerequisite chapter comes first", () => {
    // Book order: ch1, ch0 — but ch1 requires ch0's concept → ch0 first.
    const steps = [step(chapterConcept("b", 1), 0), step(chapterConcept("b", 0), 1)];
    const ordered = orderStepsByPrerequisites(steps, [{ before: 0, after: 1 }]);
    expect(ordered.map((entry) => entry.conceptId)).toEqual([
      chapterConcept("b", 0),
      chapterConcept("b", 1),
    ]);
    // Indexes are reassigned after the reorder.
    expect(ordered.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it("keeps book order when no prerequisite edges apply", () => {
    const steps = [step(chapterConcept("b", 0), 0), step(chapterConcept("b", 1), 1)];
    const ordered = orderStepsByPrerequisites(steps, []);
    expect(ordered.map((entry) => entry.conceptId)).toEqual([
      chapterConcept("b", 0),
      chapterConcept("b", 1),
    ]);
  });

  it("ignores edges that reference chapters outside the curriculum", () => {
    const steps = [step(chapterConcept("b", 1), 0), step(chapterConcept("b", 0), 1)];
    const ordered = orderStepsByPrerequisites(steps, [{ before: 7, after: 1 }]);
    expect(ordered.map((entry) => entry.conceptId)).toEqual([
      chapterConcept("b", 1),
      chapterConcept("b", 0),
    ]);
  });

  it("falls back to book order for cycle members (a curriculum must stay complete)", () => {
    // ch0 requires ch1 AND ch1 requires ch0 — a cycle. Book order wins.
    const steps = [step(chapterConcept("b", 0), 0), step(chapterConcept("b", 1), 1)];
    const ordered = orderStepsByPrerequisites(steps, [
      { before: 1, after: 0 },
      { before: 0, after: 1 },
    ]);
    expect(ordered.map((entry) => entry.conceptId)).toEqual([
      chapterConcept("b", 0),
      chapterConcept("b", 1),
    ]);
  });

  it("chains transitive prerequisites (c needs b needs a → a, b, c)", () => {
    const steps = [
      step(chapterConcept("b", 2), 0),
      step(chapterConcept("b", 1), 1),
      step(chapterConcept("b", 0), 2),
    ];
    const ordered = orderStepsByPrerequisites(steps, [
      { before: 1, after: 2 },
      { before: 0, after: 1 },
    ]);
    expect(ordered.map((entry) => entry.conceptId)).toEqual([
      chapterConcept("b", 0),
      chapterConcept("b", 1),
      chapterConcept("b", 2),
    ]);
  });
});
