// Concept graph trigger (PR-024) — folds every generated Book Skill's Tier-1
// data into the shared concept registry (deterministic, zero LLM calls) and
// returns the shelf summary the panel renders: total concepts plus the
// cross-book concepts (same normalized concept spanning ≥2 books).

import { loadExistingBookSkill } from "@/lib/book-skill/trigger";
import { useLibraryStore } from "@/stores/library-store";
import { buildConceptGraph, crossBookConcepts } from "@readany/core/book-skill";
import type { ConceptGraphSkillInput, CrossBookConcept } from "@readany/core/book-skill";
import { createSqliteLearnerStores } from "@readany/core/learner";

export interface ShelfConceptGraph {
  totalConcepts: number;
  crossBook: CrossBookConcept[];
  warnings: string[];
}

export async function buildConceptGraphForShelf(): Promise<ShelfConceptGraph> {
  const books = useLibraryStore.getState().books;
  const store = createSqliteLearnerStores().identity;
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
  const crossBook = await crossBookConcepts(inputs, store);
  const totalConcepts = (await store.listConcepts()).length;
  return { totalConcepts, crossBook, warnings: summary.warnings };
}
