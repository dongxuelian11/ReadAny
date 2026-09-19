import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { useLibraryStore } from "@/stores/library-store";
import { useVectorModelStore } from "@/stores/vector-model-store";
/**
 * Vectorize Trigger — app-layer adapter that bridges platform-specific
 * concerns (Zustand stores, book file extraction) with the core vectorization pipeline.
 *
 * Re-exports the core types for convenience.
 */
import {
  type VectorizeStatusCallback,
  type VectorizeTriggerConfig,
  triggerVectorizeBook as coreTriggerVectorizeBook,
} from "@readany/core/rag";
import { extractBookChapters } from "./book-extractor";

export type { VectorizeStatusCallback };

/**
 * App-level wrapper: reads store state, extracts chapters from the book file,
 * then delegates to the core pipeline.
 */
export async function triggerVectorizeBook(
  bookId: string,
  filePath: string,
  onProgress?: VectorizeStatusCallback,
): Promise<void> {
  // Resolve managed relative paths (e.g., "books/{id}.epub") to the active desktop library root.
  const resolvedPath = await resolveDesktopDataPath(filePath);

  const vmState = useVectorModelStore.getState();

  // Build platform-agnostic config from Zustand store
  const config: VectorizeTriggerConfig = {
    vectorModelEnabled: vmState.vectorModelEnabled,
    vectorModelMode: vmState.vectorModelMode,
    selectedBuiltinModelId: vmState.selectedBuiltinModelId,
    remoteModel: (() => {
      const selected = vmState.getSelectedVectorModel();
      if (!selected) return null;
      return {
        url: selected.url,
        apiKey: selected.apiKey,
        modelId: selected.modelId,
      };
    })(),
  };

  // Build callbacks that write back to Zustand store
  const callbacks = {
    onBookUpdate: useLibraryStore.getState().updateBook,
  };

  // KB-01/F03: surface indexing state honestly — starting clears any stale
  // failure; a real failure is persisted on the book (readability is NOT
  // affected; the card can show "准备失败" with retry instead of silent
  // console-only warnings).
  await useLibraryStore.getState().updateBook(bookId, { vectorizeError: undefined });

  try {
    // Extract chapters from the book file (platform-specific: Tauri + foliate-js)
    const chapters = await extractBookChapters(resolvedPath);
    // Delegate to core
    await coreTriggerVectorizeBook(bookId, chapters, config, callbacks, onProgress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await useLibraryStore
      .getState()
      .updateBook(bookId, { vectorizeError: message.slice(0, 500) })
      .catch(() => {});
    throw err;
  }
}
