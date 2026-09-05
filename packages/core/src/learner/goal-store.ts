// Goal store interface + in-memory implementation; the SQLite adapter lives in
// sqlite-stores.ts. One ACTIVE goal per book: saving a goal as active
// supersedes the previous active goal for the same book (history retained).

import type { GoalSpec } from "./goal";
import { withLearnerWriteLock } from "./write-lock";

export interface GoalStore {
  get(goalId: string): Promise<GoalSpec | null>;
  put(goal: GoalSpec): Promise<void>;
  /** All goals for a book, newest first. */
  listByBook(bookId: string): Promise<GoalSpec[]>;
  /** The active goal for a book, if any. */
  getActive(bookId: string): Promise<GoalSpec | null>;
}

export class GoalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalStoreError";
  }
}

/** Persist a goal; when `goal.active` is true, other goals of the same book
 * are deactivated first (in-memory reference implementation of the invariant
 * every adapter must uphold). The deactivate-then-activate sequence is a
 * check-then-act cycle, so it runs under the learner write lock (PR-012):
 * two concurrent activations of the same book could otherwise both observe
 * no active goal and leave two active goals behind. */
export function putGoalWithSupersession(store: GoalStore, goal: GoalSpec): Promise<void> {
  return withLearnerWriteLock(async () => {
    if (goal.active) {
      const active = await store.getActive(goal.bookId);
      if (active && active.goalId !== goal.goalId) {
        await store.put({ ...active, active: false });
      }
    }
    await store.put(goal);
  });
}

export function createInMemoryGoalStore(): GoalStore {
  const goals = new Map<string, GoalSpec>();
  return {
    async get(goalId) {
      const goal = goals.get(goalId);
      return goal ? { ...goal } : null;
    },
    async put(goal) {
      goals.set(goal.goalId, { ...goal });
    },
    async listByBook(bookId) {
      return [...goals.values()]
        .filter((goal) => goal.bookId === bookId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((goal) => ({ ...goal }));
    },
    async getActive(bookId) {
      const active = [...goals.values()]
        .filter((goal) => goal.bookId === bookId && goal.active)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return active ? { ...active } : null;
    },
  };
}
