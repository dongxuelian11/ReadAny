/**
 * Chapter Translator — core logic for translating entire chapters.
 *
 * Supports progressive translation with chunking, caching, cancellation,
 * and both AI (numbered batch) and DeepL providers.
 */

import type { TranslationConfig } from "../types/translation";
import { getFromCache, storeInCache, translationCacheVariant } from "./cache";
import { aiTranslateBatch } from "./providers";
import { deeplTranslate } from "./providers";
import { microsoftTranslate } from "./providers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChapterParagraph {
  /** Unique id within the chapter, e.g. "para_0" */
  id: string;
  /** Raw text content */
  text: string;
  /** HTML tag name of the source element (p, h1, li, …) */
  tagName: string;
}

export interface ChapterTranslationProgress {
  totalChars: number;
  translatedChars: number;
}

export interface ChapterTranslationResult {
  paragraphId: string;
  originalText: string;
  translatedText: string;
}

export interface TranslateChapterOptions {
  paragraphs: ChapterParagraph[];
  sourceLang: string;
  targetLang: string;
  config: TranslationConfig;
  /** Target characters per API call (default 2000) */
  charsPerChunk?: number;
  /** Max concurrent chunk requests (default 2) */
  concurrency?: number;
  /** Called after each chunk is translated */
  onProgress?: (progress: ChapterTranslationProgress) => void;
  /** Called with results for each completed chunk – enables progressive injection */
  onChunkComplete?: (results: ChapterTranslationResult[]) => void;
  /**
   * Called once after all retries with the paragraphs that still have no
   * translation. Failed chunks never count toward translatedChars progress —
   * blank output must not be reported as success.
   */
  onChunkError?: (info: { paragraphIds: string[]; error: string }) => void;
  /** Abort signal – checked between chunks */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Helper: split paragraphs into chunks by character count
// ---------------------------------------------------------------------------

function splitByCharCount(
  paragraphs: ChapterParagraph[],
  targetChars: number,
): ChapterParagraph[][] {
  const chunks: ChapterParagraph[][] = [];
  let currentChunk: ChapterParagraph[] = [];
  let currentChars = 0;

  for (const para of paragraphs) {
    const paraLen = para.text.length;

    if (currentChunk.length === 0) {
      currentChunk.push(para);
      currentChars = paraLen;
    } else if (currentChars + paraLen <= targetChars) {
      currentChunk.push(para);
      currentChars += paraLen;
    } else {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }
      currentChunk = [para];
      currentChars = paraLen;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function translateChapter(
  options: TranslateChapterOptions,
): Promise<ChapterTranslationResult[]> {
  const {
    paragraphs,
    sourceLang,
    targetLang,
    config,
    charsPerChunk = 2000,
    concurrency = 2,
    onProgress,
    onChunkComplete,
    onChunkError,
    signal,
  } = options;

  const providerId = config.provider.id;
  const cacheVariant = translationCacheVariant(
    providerId,
    config.provider.model,
    config.provider.baseUrl,
  );

  // Calculate total characters for progress
  const totalChars = paragraphs.reduce((sum, p) => sum + p.text.length, 0);

  // 1. Check cache for each paragraph -----------------------------------------
  const allResults: ChapterTranslationResult[] = [];
  const uncachedParas: ChapterParagraph[] = [];

  await Promise.all(
    paragraphs.map(async (p) => {
      const cached = await getFromCache(p.text, sourceLang, targetLang, providerId, cacheVariant);
      if (cached) {
        allResults.push({
          paragraphId: p.id,
          originalText: p.text,
          translatedText: cached,
        });
      } else {
        uncachedParas.push(p);
      }
    }),
  );

  // Emit cached results immediately so the UI can render them
  if (allResults.length > 0) {
    onChunkComplete?.(allResults);
  }

  // Report progress for cached results
  const cachedChars = allResults.reduce((sum, r) => sum + r.originalText.length, 0);
  let translatedChars = cachedChars;
  onProgress?.({ totalChars, translatedChars });

  if (uncachedParas.length === 0) {
    return allResults;
  }

  // 2. Split uncached paragraphs into chunks by character count ---------------
  const chunks = splitByCharCount(uncachedParas, charsPerChunk);

  console.log(
    `[translateChapter] Split ${uncachedParas.length} paragraphs into ${chunks.length} chunks (target: ${charsPerChunk} chars/chunk)`,
  );

  // 3. Process chunks with bounded concurrency ---------------------------------
  // A chunk whose provider call fails is retried once. What still fails keeps
  // its paragraphs untranslated: entries stay in the results map (blank text)
  // but are never injected, cached, or counted as translated progress.
  const newResults = new Map<string, ChapterTranslationResult>();
  const failedChunks: Array<{ paragraphs: ChapterParagraph[]; error: string }> = [];
  let chunkIndex = 0;

  async function translateChunkTexts(texts: string[]): Promise<string[]> {
    if (providerId === "microsoft") {
      return microsoftTranslate(texts, sourceLang, targetLang);
    }
    if (providerId === "ai") {
      return aiTranslateBatch(
        texts,
        sourceLang,
        targetLang,
        config.provider.apiKey || "",
        config.provider.baseUrl || "",
        config.provider.model || "",
        config.provider.useExactRequestUrl || false,
      );
    }
    // DeepL — natively supports batch
    return deeplTranslate(
      texts,
      sourceLang,
      targetLang,
      config.provider.apiKey || "",
      config.provider.baseUrl,
    );
  }

  async function processChunk(chunk: ChapterParagraph[]): Promise<boolean> {
    const texts = chunk.map((p) => p.text);
    let translatedTexts: string[];
    try {
      translatedTexts = await translateChunkTexts(texts);
    } catch (err) {
      console.error("[translateChapter] chunk error:", err);
      return false;
    }
    if (
      !Array.isArray(translatedTexts) ||
      translatedTexts.length !== texts.length ||
      translatedTexts.some((t) => typeof t !== "string" || t.trim().length === 0)
    ) {
      // Provider returned fewer entries, blanks, or whitespace-only filler —
      // treat as a failed chunk so the paragraphs are retried instead of being
      // recorded as (partially) blank successes.
      console.warn(
        `[translateChapter] chunk returned ${Array.isArray(translatedTexts) ? translatedTexts.length : "non-array"} of ${texts.length} usable entries — treating as failed`,
      );
      return false;
    }

    const chunkResults: ChapterTranslationResult[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const result: ChapterTranslationResult = {
        paragraphId: chunk[i].id,
        originalText: chunk[i].text,
        translatedText: translatedTexts[i] || "",
      };
      chunkResults.push(result);
      newResults.set(result.paragraphId, result);
      storeInCache(
        chunk[i].text,
        translatedTexts[i],
        sourceLang,
        targetLang,
        providerId,
        cacheVariant,
      ).catch((err) => console.warn("[Translation] Failed to cache translation result:", err));
    }

    // Only successful chunks advance progress.
    const chunkChars = chunk.reduce((sum, p) => sum + p.text.length, 0);
    translatedChars += chunkChars;
    onProgress?.({ totalChars, translatedChars });
    onChunkComplete?.(chunkResults);
    return true;
  }

  function recordFailure(chunk: ChapterParagraph[], error: string): void {
    for (const p of chunk) {
      newResults.set(p.id, { paragraphId: p.id, originalText: p.text, translatedText: "" });
    }
    failedChunks.push({ paragraphs: chunk, error });
  }

  async function processNextChunk(): Promise<void> {
    while (chunkIndex < chunks.length) {
      if (signal?.aborted) return;
      const chunk = chunks[chunkIndex++];
      const ok = await processChunk(chunk);
      if (!ok) recordFailure(chunk, "chunk failed");
    }
  }

  // Launch `concurrency` workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, chunks.length); i++) {
    workers.push(processNextChunk());
  }
  await Promise.all(workers);

  // 4. One bounded retry pass over failed chunks only (never re-translate what
  // already succeeded — those results are in newResults/cache).
  if (!signal?.aborted && failedChunks.length > 0) {
    console.log(`[translateChapter] retrying ${failedChunks.length} failed chunk(s) once`);
    const stillFailed: Array<{ paragraphs: ChapterParagraph[]; error: string }> = [];
    for (const failed of failedChunks) {
      if (signal?.aborted) {
        stillFailed.push(failed);
        continue;
      }
      const ok = await processChunk(failed.paragraphs);
      if (!ok) stillFailed.push(failed);
    }
    failedChunks.length = 0;
    failedChunks.push(...stillFailed);
  }

  if (failedChunks.length > 0 && !signal?.aborted) {
    onChunkError?.({
      paragraphIds: failedChunks.flatMap((f) => f.paragraphs.map((p) => p.id)),
      error: failedChunks[0]?.error ?? "translation chunk failed",
    });
  }

  return [...allResults, ...newResults.values()];
}
