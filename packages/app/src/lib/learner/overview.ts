// Learner overview — read-side app adapter joining the current book's
// chapter-scoped concepts (interim identity, same as PR-005/006) with the
// learner mastery store and the FSRS due queue for the Learner panel.

import { loadExistingBookSkill } from "@/lib/book-skill/trigger";
import { createPlacementEngineDeps } from "@/lib/learner/placement-trigger";
import { fallbackContentService } from "@readany/core/ai";
import {
  ensureChapterConceptIdentity,
  getLearnerStateAt,
  listDueReviewConcepts,
} from "@readany/core/learner";
import type { LearnerDueRow, LearnerMasteryRow } from "@readany/core/learner";
import type { Book } from "@readany/core/types";

async function bookChapterConcepts(
  book: Book,
): Promise<Array<{ conceptId: string; chapterIndex: number; title: string }>> {
  const skill = await loadExistingBookSkill(book);
  if (skill) {
    return skill.manifest.readany.chapters.map((chapter) => ({
      conceptId: `readany:book:${book.id}:chapter:${chapter.chapterIndex}`,
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
    }));
  }
  const chapters = await fallbackContentService.getChapters(book);
  return chapters
    .filter((chapter) => chapter.content.trim().length > 0)
    .map((chapter) => ({
      conceptId: `readany:book:${book.id}:chapter:${chapter.index}`,
      chapterIndex: chapter.index,
      title: chapter.title || `Chapter ${chapter.index + 1}`,
    }));
}

/** Per-chapter mastery rows for the current book (order = book order). Rows
 * come from the current-instant read model (PR-013): the status chips in the
 * panel reflect forgetting at read time, not the stale persisted status. The
 * overview is also a concept-identity registration point (PR-015). */
export async function getBookMasteryOverview(book: Book): Promise<LearnerMasteryRow[]> {
  const concepts = await bookChapterConcepts(book);
  const deps = await createPlacementEngineDeps();
  await Promise.all(
    concepts.map((concept) =>
      ensureChapterConceptIdentity(
        deps.identity,
        { bookId: book.id, chapterIndex: concept.chapterIndex, title: concept.title },
        deps.clock.now().getTime(),
      ),
    ),
  );
  const states = await getLearnerStateAt(
    deps,
    concepts.map((concept) => concept.conceptId),
  );
  const stateByConcept = new Map(states.map((entry) => [entry.conceptId, entry.state]));
  return concepts.map((concept) => ({
    conceptId: concept.conceptId,
    title: concept.title,
    mastery: stateByConcept.get(concept.conceptId) ?? null,
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
