// Goal trigger — app-layer adapter assembling the engine deps for the Goal
// Model: free-text goal → validated GoalSpec (LLM co-processor) → persisted
// active goal → deterministic Personal Curriculum over the current learner
// state. No UI here; the frontend owner surfaces the results.

import { loadExistingBookSkill } from "@/lib/book-skill/trigger";
import { getActiveTeaching } from "@/lib/learner/teaching-trigger";
import { useSettingsStore } from "@/stores/settings-store";
import { fallbackContentService } from "@readany/core/ai";
import { createBookSkillLlmClient } from "@readany/core/book-skill";
import {
  buildCurriculum,
  classifyGap,
  collectPrerequisiteEdges,
  createSqliteLearnerStores,
  ensureChapterConceptIdentity,
  getLearnerStateAt,
  orderStepsByPrerequisites,
  parseGoal,
  putGoalWithSupersession,
  toGoalSpec,
} from "@readany/core/learner";
import type {
  GoalLlmClient,
  GoalSpec,
  LearnerConceptState,
  PersonalCurriculum,
  TeachingSession,
} from "@readany/core/learner";
import type { Book } from "@readany/core/types";

async function createGoalEngineDeps() {
  return {
    clock: { now: (): Date => new Date() },
    ...createSqliteLearnerStores(),
  };
}

async function bookChapters(book: Book) {
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

/** Parse a free-text goal against the book's chapters, persist it as the
 * book's active goal, and build the current curriculum. Goal start is also a
 * concept-identity registration point (PR-015): every chapter target is
 * lazily registered in the identity registry. */
export async function startGoalForBook(book: Book, goalText: string): Promise<GoalSpec> {
  const deps = await createGoalEngineDeps();
  const chapters = await bookChapters(book);
  await Promise.all(
    chapters.map((chapter) =>
      ensureChapterConceptIdentity(
        deps.identity,
        { bookId: book.id, chapterIndex: chapter.chapterIndex, title: chapter.title },
        deps.clock.now().getTime(),
      ),
    ),
  );
  const aiConfig = useSettingsStore.getState().aiConfig;
  const llm: GoalLlmClient = await createBookSkillLlmClient(aiConfig);
  const parse = await parseGoal({ goalText, bookTitle: book.meta.title, chapters, llm });
  const goal = toGoalSpec({
    parse,
    goalId: crypto.randomUUID(),
    bookId: book.id,
    goalText,
    createdAt: deps.clock.now().getTime(),
  });
  await putGoalWithSupersession(deps.goals, goal);
  return goal;
}

/** The active goal for a book, if any. */
export async function getActiveGoal(book: Book): Promise<GoalSpec | null> {
  const deps = await createGoalEngineDeps();
  return deps.goals.getActive(book.id);
}

/** Rebuild the deterministic curriculum for a goal against the current learner
 * state (pure computation — safe to call any time). The learner state comes
 * from the current-instant read model (PR-013): gap classification must see
 * forgetting at read time, not the stale persisted status.
 *
 * Iter-3 (review item F): prerequisite ordering is back, but only over
 * EXPLICIT relations — collectPrerequisiteEdges reads the registry's
 * "prerequisite" relations (framework/topic → chapter participation bindings
 * decide which chapters an edge connects) restricted to this goal's chapters.
 * Co-occurrence no longer creates edges; orderStepsByPrerequisites keeps the
 * book-order fallback for cycles. */
export async function getCurriculumForGoal(goal: GoalSpec): Promise<PersonalCurriculum> {
  const deps = await createGoalEngineDeps();
  const states = await getLearnerStateAt(
    deps,
    goal.chapters.map((chapter) => chapter.conceptId),
  );
  const stateByConcept = new Map(states.map((entry) => [entry.conceptId, entry.state]));
  const entries = [];
  for (const chapter of goal.chapters) {
    const row = stateByConcept.get(chapter.conceptId) ?? null;
    const learner: LearnerConceptState | null = row
      ? {
          mastery: row.mastery,
          status: row.status,
          evidenceCount: row.evidenceCount,
          lastVerified: row.lastVerified,
        }
      : null;
    entries.push(classifyGap(chapter, learner));
  }
  const curriculum = buildCurriculum(goal, entries, deps.clock.now().getTime());
  const edges = await collectPrerequisiteEdges(
    deps.identity,
    goal.chapters.map((chapter) => chapter.conceptId),
  );
  return { ...curriculum, steps: orderStepsByPrerequisites(curriculum.steps, edges) };
}

export interface GoalWorkspace {
  goal: GoalSpec;
  curriculum: PersonalCurriculum;
  /** This book's active teaching session, if one is in progress. */
  teaching: TeachingSession | null;
}

/** The full goal workspace for a book: active goal + curriculum rebuilt
 * against the current learner state (PR-013 read model) + any resumable
 * teaching session. Null when the book has no active goal.
 *
 * Iter-2: the restored session must belong to THIS goal. Supersession only
 * deactivates the old Goal row — the old TeachingSession row stays "active"
 * in the store, so a bookId-only check used to resurrect a previous goal's
 * stale session (wrong curriculum, wrong progress) after the goal changed. */
export async function getGoalWorkspace(book: Book): Promise<GoalWorkspace | null> {
  const goal = await getActiveGoal(book);
  if (!goal) return null;
  const curriculum = await getCurriculumForGoal(goal);
  const teaching = await getActiveTeaching();
  return {
    goal,
    curriculum,
    teaching:
      teaching &&
      teaching.status === "active" &&
      teaching.bookId === book.id &&
      teaching.goalId === goal.goalId
        ? teaching
        : null,
  };
}
