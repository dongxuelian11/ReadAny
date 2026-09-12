import type { TeachingSession } from "./teaching";

export interface TeachingStore {
  get(id: string): Promise<TeachingSession | null>;
  put(session: TeachingSession): Promise<void>;
  /** The latest non-completed session, if any. */
  getActive(): Promise<TeachingSession | null>;
  /** The latest non-completed session OF THIS BOOK (WP-A): supersession is
   * book-scoped, so starting book B must not bury book A's resumable session. */
  getActiveByBook?(bookId: string): Promise<TeachingSession | null>;
}
