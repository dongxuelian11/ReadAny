import { withPersist } from "@/stores/persist";
import type { BookSkillGenre } from "@readany/core/book-skill";
import { create } from "zustand";

export interface BookSkillRegistryEntry {
  genre: BookSkillGenre;
  builtAt: string;
  contentVersion: string;
  /** ReadAny canonical chapter mapping from the generated manifest. */
  chapters: Array<{ book_number: string; chapterIndex: number; title: string }>;
}

interface BookSkillRegistryState {
  entries: Record<string, BookSkillRegistryEntry>;
  genrePreferences: Record<string, BookSkillGenre>;
  _hasHydrated: boolean;
  getEntry: (bookId: string) => BookSkillRegistryEntry | undefined;
  setEntry: (bookId: string, entry: BookSkillRegistryEntry) => void;
  removeEntry: (bookId: string) => void;
  getGenrePreference: (bookId: string) => BookSkillGenre;
  setGenrePreference: (bookId: string, genre: BookSkillGenre) => void;
}

/**
 * Light registry of generated Book Skills. The skill files themselves are a
 * rebuildable derived cache under the app data dir; this store only remembers
 * what exists, its content version, the user's genre preference, and the
 * ReadAny chapter mapping used for navigation back to the canonical source.
 */
export const useBookSkillStore = create<BookSkillRegistryState>(
  withPersist("book-skill-registry", (set, get) => ({
    entries: {},
    genrePreferences: {},
    _hasHydrated: false,
    getEntry: (bookId) => get().entries[bookId],
    setEntry: (bookId, entry) =>
      set((state) => ({ entries: { ...state.entries, [bookId]: entry } })),
    removeEntry: (bookId) =>
      set((state) => {
        const next = { ...state.entries };
        delete next[bookId];
        return { entries: next };
      }),
    getGenrePreference: (bookId) => get().genrePreferences[bookId] ?? "general",
    setGenrePreference: (bookId, genre) =>
      set((state) =>
        state.genrePreferences[bookId] === genre
          ? state
          : { genrePreferences: { ...state.genrePreferences, [bookId]: genre } },
      ),
  })),
);
