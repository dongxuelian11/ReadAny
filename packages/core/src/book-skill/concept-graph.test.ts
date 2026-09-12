import { describe, expect, it } from "vitest";
import { createInMemoryConceptIdentityStore } from "../learner/concept-identity";
import {
  buildConceptGraph,
  crossBookConcepts,
  frameworkConceptId,
  normalizeConceptName,
  topicConceptId,
} from "./concept-graph";
import type { ConceptGraphSkillInput } from "./concept-graph";
import type { BookSkillTier1 } from "./types";

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
  chapters: Array<{ book_number: string; chapterIndex: number }> = [
    { book_number: "ch01", chapterIndex: 0 },
    { book_number: "ch02", chapterIndex: 1 },
  ],
): ConceptGraphSkillInput {
  return { bookId, tier1: tier1(tier1Data), readanyChapters: chapters };
}

describe("concept graph V2", () => {
  it("normalizes names and derives stable ids per kind", () => {
    expect(normalizeConceptName("  费用   FEES ")).toBe("费用 fees");
    expect(topicConceptId("Fees")).toBe(topicConceptId(" fees "));
    expect(topicConceptId("fees")).not.toBe(frameworkConceptId("fees"));
    expect(topicConceptId("fees")).toMatch(/^readany:concept:t:[0-9a-f]{8}$/);
    expect(frameworkConceptId("Fees")).toMatch(/^readany:concept:f:[0-9a-f]{8}$/);
  });

  it("registers topic concepts and binds chapters N:M (one chapter, many concepts)", async () => {
    const store = createInMemoryConceptIdentityStore();
    const skill = skillInput("book-1", {
      topicIndex: [
        { term: "费用 fees", chapters: ["ch01", "ch02"] },
        { term: "资产配置 allocation", chapters: ["ch02"] },
      ],
    });
    const summary = await buildConceptGraph([skill], store, NOW);

    expect(summary.topicConcepts).toBe(2);
    expect(summary.sourceUnitBindings).toBe(3);
    expect(summary.warnings).toEqual([]);

    // ch01 participates only in fees; ch02 in both.
    expect(await store.listConceptsForSourceUnit("readany:book:book-1:chapter:0")).toEqual([
      topicConceptId("费用 fees"),
    ]);
    expect(await store.listConceptsForSourceUnit("readany:book:book-1:chapter:1")).toEqual(
      [topicConceptId("资产配置 allocation"), topicConceptId("费用 fees")].sort(),
    );
  });

  it("merges the same normalized term across books into ONE concept (first name wins)", async () => {
    const store = createInMemoryConceptIdentityStore();
    const skills = [
      skillInput("book-1", { topicIndex: [{ term: "费用 fees", chapters: ["ch01"] }] }),
      skillInput("book-2", { topicIndex: [{ term: "费用 FEES", chapters: ["ch01"] }] }, [
        { book_number: "ch01", chapterIndex: 0 },
      ]),
    ];
    await buildConceptGraph(skills, store, NOW);

    // Same normalized term → same concept id, bound to BOTH books' chapters.
    const conceptId = topicConceptId("费用 fees");
    expect(await store.listConceptsForSourceUnit("readany:book:book-1:chapter:0")).toContain(
      conceptId,
    );
    expect(await store.listConceptsForSourceUnit("readany:book:book-2:chapter:0")).toContain(
      conceptId,
    );
    const concepts = await store.listConcepts();
    expect(concepts.filter((concept) => concept.conceptId === conceptId)).toHaveLength(1);
    expect(concepts.find((concept) => concept.conceptId === conceptId)?.displayName).toBe(
      "费用 fees",
    );

    const cross = await crossBookConcepts(skills, store);
    expect(cross).toHaveLength(1);
    expect(cross[0].books).toEqual(["book-1", "book-2"]);
  });

  it("merges across languages via derived aliases: 「费用 fees」 folds in FEES and 费用 (PR-026)", async () => {
    const store = createInMemoryConceptIdentityStore();
    const skills = [
      skillInput("book-1", { topicIndex: [{ term: "费用 fees", chapters: ["ch01"] }] }),
      skillInput("book-2", { topicIndex: [{ term: "FEES", chapters: ["ch01"] }] }, [
        { book_number: "ch01", chapterIndex: 0 },
      ]),
      skillInput("book-3", { topicIndex: [{ term: "费用", chapters: ["ch01"] }] }, [
        { book_number: "ch01", chapterIndex: 0 },
      ]),
    ];
    await buildConceptGraph(skills, store, NOW);

    // All three terms fold into ONE concept: the bilingual term's derived
    // aliases 「费用」/fees answer the later books.
    const topicConcepts = await store
      .listConcepts()
      .then((all) => all.filter((concept) => concept.conceptId.includes(":t:")));
    expect(topicConcepts).toHaveLength(1);
    expect(topicConcepts[0].displayName).toBe("费用 fees");

    const cross = await crossBookConcepts(skills, store);
    expect(cross).toHaveLength(1);
    expect(cross[0].books).toEqual(["book-1", "book-2", "book-3"]);
    expect(await store.resolveByAlias("fees")).toBe(topicConcepts[0].conceptId);
    expect(await store.resolveByAlias("费用")).toBe(topicConcepts[0].conceptId);
  });

  it("maps concept-map edges to relations and drops unregistered endpoints", async () => {
    const store = createInMemoryConceptIdentityStore();
    const skill = skillInput("book-1", {
      nodes: [
        { name: "Costs Matter", summary: "s", chapter: "ch01" },
        { name: "Compounding", summary: "s", chapter: "ch02" },
      ],
      edges: [
        { from: "Compounding", relation: "builds on", to: "Costs Matter" },
        { from: "Compounding", relation: "instance of", to: "Costs Matter" },
        { from: "Ghost", relation: "requires", to: "Costs Matter" },
      ],
    });
    const summary = await buildConceptGraph([skill], store, NOW);

    expect(summary.frameworkConcepts).toBe(2);
    expect(summary.relations).toBe(2);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain("unregistered endpoint");

    const related = await store.listRelated(frameworkConceptId("Compounding"));
    const toCosts = related.filter(
      (entry) => entry.relatedConceptId === frameworkConceptId("Costs Matter"),
    );
    // Both edges land on the same pair with different kinds — both kept.
    expect(toCosts.map((entry) => entry.relation).sort()).toEqual(["prerequisite", "related"]);
    expect(related).toHaveLength(2);
  });

  it("warns on unknown book numbers and skips the binding, not the concept", async () => {
    const store = createInMemoryConceptIdentityStore();
    const skill = skillInput("book-1", {
      topicIndex: [{ term: "费用 fees", chapters: ["ch01", "ch99"] }],
    });
    const summary = await buildConceptGraph([skill], store, NOW);
    expect(summary.sourceUnitBindings).toBe(1);
    expect(summary.warnings).toHaveLength(1);
    expect(await store.listConceptsForSourceUnit("readany:book:book-1:chapter:0")).toHaveLength(1);
  });

  it("is idempotent: rebuilding the same shelf changes nothing", async () => {
    const store = createInMemoryConceptIdentityStore();
    const skills = [
      skillInput("book-1", {
        topicIndex: [{ term: "费用 fees", chapters: ["ch01"] }],
        nodes: [{ name: "Costs Matter", summary: "s", chapter: "ch01" }],
        edges: [{ from: "Costs Matter", relation: "requires", to: "Costs Matter" }],
      }),
    ];
    await buildConceptGraph(skills, store, NOW);
    const conceptsBefore = await store.listConcepts();
    const relationsBefore = await store.listRelated(frameworkConceptId("Costs Matter"));
    const summary = await buildConceptGraph(skills, store, NOW + 1);

    expect(await store.listConcepts()).toEqual(conceptsBefore);
    expect(await store.listRelated(frameworkConceptId("Costs Matter"))).toEqual(relationsBefore);
    expect(summary.topicConcepts).toBe(1);
  });

  it("never steals an alias owned by a different concept; the conflict is warned (iter-3 G)", async () => {
    const store = createInMemoryConceptIdentityStore();
    // book-1: "费用 fees" derives the "fees" alias for its concept.
    await buildConceptGraph(
      [skillInput("book-1", { topicIndex: [{ term: "费用 fees", chapters: ["ch01"] }] })],
      store,
      NOW,
    );
    const feesConcept = await store.resolveByAlias("fees");
    expect(feesConcept).not.toBeNull();

    // book-2 uses a DIFFERENT term that normalizes differently, so it mints
    // its own concept — and would have stolen the "fees" alias under the old
    // INSERT OR REPLACE binding.
    const summary = await buildConceptGraph(
      [skillInput("book-2", { topicIndex: [{ term: "价格 fees", chapters: ["ch01"] }] })],
      store,
      NOW + 1,
    );

    // The alias still resolves to its FIRST owner, and the conflict is warned.
    expect(await store.resolveByAlias("fees")).toBe(feesConcept);
    expect(
      summary.warnings.some((warning) => warning.includes('"fees"') && warning.includes("rebound")),
    ).toBe(true);
  });

  it("single-script terms derive NO word-level aliases (no 'machine learning' → 'learning' merge)", async () => {
    const store = createInMemoryConceptIdentityStore();
    await buildConceptGraph(
      [skillInput("book-1", { topicIndex: [{ term: "machine learning", chapters: ["ch01"] }] })],
      store,
      NOW,
    );
    expect(await store.resolveByAlias("machine learning")).not.toBeNull();
    // The word split is gone: no alias exists for the bare word.
    expect(await store.resolveByAlias("learning")).toBeNull();
    expect(await store.resolveByAlias("machine")).toBeNull();
  });
});
