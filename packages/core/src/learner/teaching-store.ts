import type { TeachingSession } from "./teaching";

export interface TeachingStore {
  get(id: string): Promise<TeachingSession | null>;
  put(session: TeachingSession): Promise<void>;
  /** The latest non-completed session, if any. */
  getActive(): Promise<TeachingSession | null>;
}
