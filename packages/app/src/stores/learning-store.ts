import { withPersist } from "@/stores/persist";
import type { ReadBoxBinding } from "@readany/core/learning";
import { create } from "zustand";

interface LearningBindingState {
  bindings: Record<string, ReadBoxBinding>;
  _hasHydrated: boolean;
  getBinding: (readAnyBookId: string, readAnyChapterId: string) => ReadBoxBinding | undefined;
  setBinding: (binding: ReadBoxBinding) => void;
  removeBinding: (readAnyBookId: string, readAnyChapterId: string) => void;
}

function bindingKey(readAnyBookId: string, readAnyChapterId: string): string {
  return `${readAnyBookId}:${readAnyChapterId}`;
}

export const useLearningStore = create<LearningBindingState>(
  withPersist("learning-readbox-bindings", (set, get) => ({
    bindings: {},
    _hasHydrated: false,
    getBinding: (bookId, chapterId) => get().bindings[bindingKey(bookId, chapterId)],
    setBinding: (binding) =>
      set((state) => ({
        bindings: {
          ...state.bindings,
          [bindingKey(binding.readAnyBookId, binding.readAnyChapterId)]: binding,
        },
      })),
    removeBinding: (bookId, chapterId) =>
      set((state) => {
        const bindings = { ...state.bindings };
        delete bindings[bindingKey(bookId, chapterId)];
        return { bindings };
      }),
  })),
);
