// Concept graph trigger (PR-024/026) — folds every generated Book Skill's
// Tier-1 data into the shared concept registry (deterministic, zero LLM
// calls) and returns the shelf summary the panel renders: total concepts plus
// the cross-book concepts, each projected to its CURRENT learner state
// (evidence-weighted mastery, worst status) through the PR-013 read model.

import { loadExistingBookSkill } from "@/lib/book-skill/trigger";
import { useLibraryStore } from "@/stores/library-store";
import { buildConceptGraph, crossBookConcepts } from "@readany/core/book-skill";
import type { ConceptGraphSkillInput, ProjectedCrossBookConcept } from "@readany/core/book-skill";
import { createSqliteLearnerStores, projectConceptState } from "@readany/core/learner";

export interface ShelfConceptGraph {
  totalConcepts: number;
  crossBook: ProjectedCrossBookConcept[];
  warnings: string[];
}

export async function buildConceptGraphForShelf(): Promise<ShelfConceptGraph> {
  const books = useLibraryStore.getState().books;
  const stores = createSqliteLearnerStores();
  const store = stores.identity;
  const inputs: ConceptGraphSkillInput[] = [];
  for (const book of books) {
    try {
      const skill = await loadExistingBookSkill(book);
      if (!skill) continue;
      inputs.push({
        bookId: book.id,
        tier1: skill.tier1,
        readanyChapters: skill.manifest.readany.chapters.map((chapter) => ({
          book_number: chapter.book_number,
          chapterIndex: chapter.chapterIndex,
        })),
      });
    } catch {
      // A book whose skill cannot be read is skipped, not fatal.
    }
  }
  const summary = await buildConceptGraph(inputs, store, Date.now());
  const crossBookBase = await crossBookConcepts(inputs, store);
  const readDeps = {
    clock: { now: (): Date => new Date() },
    mastery: stores.mastery,
    reviews: stores.reviews,
    identity: store,
  };
  const crossBook: ProjectedCrossBookConcept[] = [];
  for (const concept of crossBookBase) {
    // PR-026: each cross-book concept carries its current projected learner
    // state; a projection failure degrades to mastery/status null.
    try {
      const projection = await projectConceptState(readDeps, concept.conceptId);
      crossBook.push({
        ...concept,
        projectedMastery: projection?.mastery ?? null,
        projectedStatus: projection?.status ?? null,
      });
    } catch {
      crossBook.push({ ...concept, projectedMastery: null, projectedStatus: null });
    }
  }
  const totalConcepts = (await store.listConcepts()).length;
  return { totalConcepts, crossBook, warnings: summary.warnings };
}
