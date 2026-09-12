// Iter-3 (review item F): adapter-to-ordering wiring test. Unlike the pure
// orderStepsByPrerequisites tests, this drives collectPrerequisiteEdges
// through a REAL registry — buildConceptGraph over a skill input — so the
// relation direction contract, the framework→chapter bindings, and the
// book-scope filter are all exercised end to end.

import { describe, expect, it } from "vitest";
import {
  type ConceptGraphSkillInput,
  buildConceptGraph,
  frameworkConceptId,
} from "../book-skill/concept-graph";
import type { BookSkillTier1 } from "../book-skill/types";
import { createInMemoryConceptIdentityStore } from "./concept-identity";
import { collectPrerequisiteEdges } from "./curriculum-edges";

const NOW = 1788000000000;

function tier1(partial: Partial<BookSkillTier1>): BookSkillTier1 {
  return {
    thesis: "t",
    nodes: [],
    edges: [],
    coreFrameworks: [],
    topicIndex: [],
    triggerPhrases: [],
    ...partial,
  };
}

function skillInput(
  bookId: string,
  tier1Data: Partial<BookSkillTier1>,
  chapters: Array<{ book_number: string; chapterIndex: number }>,
): ConceptGraphSkillInput {
  return { bookId, tier1: tier1(tier1Data), readanyChapters: chapters };
}

describe("collectPrerequisiteEdges (iter-3 F wiring)", () => {
  it("collects only EXPLICIT prerequisite relations, projected through chapter bindings", async () => {
    const store = createInMemoryConceptIdentityStore();
    // Book with three chapters; the concept map says "Chapter 1's framework"
    // REQUIRES understanding "Chapter 0's framework". A plain "related" edge
    // and a bare co-occurrence (both frameworks in the topic index of ch02)
    // must NOT create ordering edges.
    const skill = skillInput(
      "book-1",
      {
        topicIndex: [{ term: "均值 mean", chapters: ["ch01", "ch02"] }],
        nodes: [
          { name: "First: Mean", summary: "s", chapter: "ch01" },
          { name: "Then: Allocation", summary: "s", chapter: "ch02" },
          { name: "Unrelated Idea", summary: "s", chapter: "ch03" },
        ],
        edges: [
          // Direction contract: from --requires--> to = understand from first.
          { from: "Then: Allocation", relation: "builds on", to: "First: Mean" },
          { from: "Unrelated Idea", relation: "related", to: "First: Mean" },
        ],
      },
      [
        { book_number: "ch01", chapterIndex: 0 },
        { book_number: "ch02", chapterIndex: 1 },
        { book_number: "ch03", chapterIndex: 2 },
      ],
    );
    await buildConceptGraph([skill], store, NOW);

    const edges = await collectPrerequisiteEdges(store, [
      "readany:book:book-1:chapter:0",
      "readany:book:book-1:chapter:1",
      "readany:book:book-1:chapter:2",
    ]);

    // The registry holds the relation on "Then: Allocation" (conceptId) →
    // "First: Mean" (related): understand First (ch0) BEFORE Then (ch1).
    expect(edges).toEqual([{ before: 1, after: 0 }]);
  });

  it("resolves prerequisite chains announced on the PREREQUISITE side of the chapter too", async () => {
    const store = createInMemoryConceptIdentityStore();
    // The relation is registered FROM the prerequisite concept ("First: Mean
    // requires nothing; Then builds on First" vs the mirror phrasing). Also
    // assert the mirror: a relation stored as First --prerequisite--> Then
    // yields the same edge.
    const skill = skillInput(
      "book-1",
      {
        nodes: [
          { name: "First: Mean", summary: "s", chapter: "ch01" },
          { name: "Then: Allocation", summary: "s", chapter: "ch02" },
        ],
        edges: [{ from: "First: Mean", relation: "requires", to: "Then: Allocation" }],
      },
      [
        { book_number: "ch01", chapterIndex: 0 },
        { book_number: "ch02", chapterIndex: 1 },
      ],
    );
    await buildConceptGraph([skill], store, NOW);

    const edges = await collectPrerequisiteEdges(store, [
      "readany:book:book-1:chapter:0",
      "readany:book:book-1:chapter:1",
    ]);
    // First (ch0) is the prerequisite of Then (ch1) → ch0 before ch1.
    expect(edges).toEqual([{ before: 0, after: 1 }]);
  });

  it("keeps edges inside THIS goal's chapters and drops out-of-goal targets", async () => {
    const store = createInMemoryConceptIdentityStore();
    const skill = skillInput(
      "book-1",
      {
        nodes: [
          { name: "First: Mean", summary: "s", chapter: "ch01" },
          { name: "Later: Retirement", summary: "s", chapter: "ch04" },
        ],
        edges: [{ from: "Later: Retirement", relation: "builds on", to: "First: Mean" }],
      },
      [
        { book_number: "ch01", chapterIndex: 0 },
        { book_number: "ch04", chapterIndex: 3 },
      ],
    );
    await buildConceptGraph([skill], store, NOW);

    // The goal only covers chapter 0 — the edge into chapter 3 is out of
    // scope and must not appear.
    const scoped = await collectPrerequisiteEdges(store, ["readany:book:book-1:chapter:0"]);
    expect(scoped).toEqual([]);

    // With both chapters in the goal, the edge appears.
    const full = await collectPrerequisiteEdges(store, [
      "readany:book:book-1:chapter:0",
      "readany:book:book-1:chapter:3",
    ]);
    expect(full).toEqual([{ before: 3, after: 0 }]);
  });

  it("returns no edges when the registry holds only co-occurrence (PR-026 regression)", async () => {
    const store = createInMemoryConceptIdentityStore();
    // Both chapters share a topic concept — under PR-026 this produced
    // mutual "prerequisite" edges; now it must produce none.
    const skill = skillInput(
      "book-1",
      {
        topicIndex: [{ term: "均值 mean", chapters: ["ch01", "ch02"] }],
      },
      [
        { book_number: "ch01", chapterIndex: 0 },
        { book_number: "ch02", chapterIndex: 1 },
      ],
    );
    await buildConceptGraph([skill], store, NOW);

    const edges = await collectPrerequisiteEdges(store, [
      "readany:book:book-1:chapter:0",
      "readany:book:book-1:chapter:1",
    ]);
    expect(edges).toEqual([]);
    // Sanity: the shared concept really is registered and participating.
    expect(await store.resolveByAlias("mean")).toBe((await store.listConcepts())[0].conceptId);
    void frameworkConceptId;
  });

  it("does NOT treat another book's same-numbered chapter as a goal target (F06)", async () => {
    const store = createInMemoryConceptIdentityStore();
    // Goal covers book-1 ch0 + ch1. book-1 ch0's concept has an explicit
    // prerequisite relation whose target concept lives ONLY in book-2 ch1 —
    // the same chapter NUMBER as a goal chapter. The goal membership check
    // must use the full source-unit id, so no edge may be produced.
    await store.registerConcept({ conceptId: "c-base", displayName: "Base", createdAt: NOW });
    await store.bindSourceUnit("readany:book:book-1:chapter:0", "c-base");
    await store.bindConceptSourceUnit("c-base", "readany:book:book-1:chapter:0");
    await store.registerConcept({
      conceptId: "c-foreign",
      displayName: "Foreign",
      createdAt: NOW,
    });
    await store.bindSourceUnit("readany:book:book-2:chapter:1", "c-foreign");
    await store.bindConceptSourceUnit("c-foreign", "readany:book:book-2:chapter:1");
    await store.bindRelation(
      { conceptId: "c-base", relatedConceptId: "c-foreign", relation: "prerequisite" },
      NOW,
    );

    const edges = await collectPrerequisiteEdges(store, [
      "readany:book:book-1:chapter:0",
      "readany:book:book-1:chapter:1",
    ]);
    expect(edges).toEqual([]);
  });
});
