import { describe, expect, it } from "vitest";
import {
  createInMemoryConceptIdentityStore,
  ensureChapterConceptIdentity,
  parseChapterSourceUnit,
  sourceUnitId,
} from "./concept-identity";

const NOW = 1788000000000;

describe("concept identity seam", () => {
  it("round-trips the legacy chapter identity as an explicit source unit", () => {
    const unit = sourceUnitId("book-1", 3);
    expect(unit).toBe("readany:book:book-1:chapter:3");
    expect(parseChapterSourceUnit(unit)).toEqual({ bookId: "book-1", chapterIndex: 3 });
    // Book ids containing separators stay parseable (greedy match).
    expect(parseChapterSourceUnit("readany:book:my:weird:id:chapter:12")).toEqual({
      bookId: "my:weird:id",
      chapterIndex: 12,
    });
    expect(parseChapterSourceUnit("readany:quiz:book-1:ch3:1:abcd")).toBeNull();
    expect(parseChapterSourceUnit("some/other/shape")).toBeNull();
  });

  it("lazily registers a chapter concept and binds the source unit (idempotent)", async () => {
    const store = createInMemoryConceptIdentityStore();
    const first = await ensureChapterConceptIdentity(
      store,
      { bookId: "book-1", chapterIndex: 3, title: "Averages" },
      NOW,
    );
    // V1 identity-preserving seam: the concept id IS the source-unit id, so
    // every existing consumer sees no change.
    expect(first).toBe("readany:book:book-1:chapter:3");
    expect(await store.resolveBySourceUnit("readany:book:book-1:chapter:3")).toBe(first);

    // Re-register with a changed title: id stable, first record kept.
    const again = await ensureChapterConceptIdentity(
      store,
      { bookId: "book-1", chapterIndex: 3, title: "Renamed" },
      NOW + 1,
    );
    expect(again).toBe(first);
  });

  it("rebinding a source unit migrates its identity (the V2 path)", async () => {
    const store = createInMemoryConceptIdentityStore();
    const legacy = await ensureChapterConceptIdentity(
      store,
      { bookId: "book-1", chapterIndex: 3, title: "Averages" },
      NOW,
    );
    await store.registerConcept({
      conceptId: "canonical:mean",
      displayName: "Mean",
      createdAt: NOW,
    });
    await store.bindSourceUnit(sourceUnitId("book-1", 3), "canonical:mean");
    expect(await store.resolveBySourceUnit(sourceUnitId("book-1", 3))).toBe("canonical:mean");
    expect(legacy).toBe("readany:book:book-1:chapter:3");

    await store.bindAlias("均值", "canonical:mean");
    expect(await store.resolveByAlias("均值")).toBe("canonical:mean");
  });

  it("records relations as a schema seam and lists them", async () => {
    const store = createInMemoryConceptIdentityStore();
    await store.bindRelation(
      {
        conceptId: "canonical:variance",
        relatedConceptId: "canonical:mean",
        relation: "prerequisite",
      },
      NOW,
    );
    // Duplicate binding is a no-op.
    await store.bindRelation(
      {
        conceptId: "canonical:variance",
        relatedConceptId: "canonical:mean",
        relation: "prerequisite",
      },
      NOW,
    );
    const related = await store.listRelated("canonical:variance");
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({
      conceptId: "canonical:variance",
      relatedConceptId: "canonical:mean",
      relation: "prerequisite",
    });
  });
});
