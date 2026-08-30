// Learner overview — read-side app adapter joining the current book's
// chapter-scoped concepts (interim identity, same as PR-005/006) with the
// learner mastery store and the FSRS due queue for the Learner panel.

import { loadExistingBookSkill } from "@/lib/book-skill/trigger";
import { createPlacementEngineDeps } from "@/lib/learner/placement-trigger";
import { fallbackContentService } from "@readany/core/ai";
import { getMasteryForConcepts, listDueReviewConcepts } from "@readany/core/learner";
import type { LearnerDueRow, LearnerMasteryRow } from "@readany/core/learner";
import type { Book } from "@readany/core/types";

async function bookChapterConcepts(
  book: Book,
): Promise<Array<{ conceptId: string; title: string }>> {
  const skill = await loadExistingBookSkill(book);
  if (skill) {
    return skill.manifest.readany.chapters.map((chapter) => ({
      conceptId: `readany:book:${book.id}:chapter:${chapter.chapterIndex}`,
      title: chapter.title,
    }));
  }
  const chapters = await fallbackContentService.getChapters(book);
  return chapters
    .filter((chapter) => chapter.content.trim().length > 0)
    .map((chapter) => ({
      conceptId: `readany:book:${book.id}:chapter:${chapter.index}`,
      title: chapter.title || `Chapter ${chapter.index + 1}`,
    }));
}

/** Per-chapter mastery rows for the current book (order = book order). */
export async function getBookMasteryOverview(book: Book): Promise<LearnerMasteryRow[]> {
  const concepts = await bookChapterConcepts(book);
  const deps = await createPlacementEngineDeps();
  const rows = await getMasteryForConcepts(
    deps,
    concepts.map((concept) => concept.conceptId),
  );
  return concepts.map((concept, index) => ({
    conceptId: concept.conceptId,
    title: concept.title,
    mastery: rows[index].mastery,
  }));
}

/** Due FSRS review cards scoped to the current book's concepts, ordered by due. */
export async function getBookDueReviews(book: Book): Promise<LearnerDueRow[]> {
  const [concepts, deps] = await Promise.all([
    bookChapterConcepts(book),
    createPlacementEngineDeps(),
  ]);
  const known = new Set(concepts.map((concept) => concept.conceptId));
  const titleByConcept = new Map(concepts.map((concept) => [concept.conceptId, concept.title]));
  const due = await listDueReviewConcepts(deps, Date.now());
  return due
    .filter((entry) => known.has(entry.card.conceptId))
    .map((entry) => ({
      conceptId: entry.card.conceptId,
      due: entry.card.due,
      title: titleByConcept.get(entry.card.conceptId) ?? null,
      mastery: entry.mastery?.mastery ?? null,
      status: entry.status,
    }));
}
