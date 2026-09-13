/**
 * Translation Cache
 * Cross-platform cache for translation results using IPlatformService KV storage.
 *
 * All methods are async to support both Web (localStorage) and RN (AsyncStorage).
 */

import { getPlatformService } from "../services/platform";
import type { TranslatorName } from "./types";

const CACHE_PREFIX = "readany_translation_cache_";

/**
 * Extra key material that invalidates cached translations when the thing that
 * produced them changes. For the "ai" provider this is the model + prompt
 * version — switching providers or models must never reuse the previous
 * model's output as if it were fresh.
 */
export function translationCacheVariant(
  provider: TranslatorName,
  model?: string,
): string | undefined {
  if (provider !== "ai") return undefined;
  return `m${model || "default"}_p${AI_TRANSLATION_PROMPT_VERSION}`;
}

/** Bump when the AI translation prompt changes in a way that alters output. */
export const AI_TRANSLATION_PROMPT_VERSION = 2;

/** Generate cache key */
function getCacheKey(
  text: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  variant?: string,
): string {
  const hash = simpleHash(text);
  const suffix = variant ? `_${variant}` : "";
  return `${CACHE_PREFIX}${provider}_${sourceLang}_${targetLang}_${hash}${suffix}`;
}

/** Simple hash function for cache key */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/** Get translation from cache */
export async function getFromCache(
  text: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  variant?: string,
): Promise<string | null> {
  try {
    const platform = getPlatformService();
    const key = getCacheKey(text, sourceLang, targetLang, provider, variant);
    const cached = await platform.kvGetItem(key);
    if (cached) {
      const { translation, timestamp } = JSON.parse(cached);
      // Cache expires after 7 days; empty translations are never valid cache
      if (translation && Date.now() - timestamp < 7 * 24 * 60 * 60 * 1000) {
        return translation;
      }
      await platform.kvRemoveItem(key);
    }
  } catch (err) {
    console.warn("[Translation] Cache read error:", err);
  }
  return null;
}

/** Store translation in cache */
export async function storeInCache(
  text: string,
  translation: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  variant?: string,
): Promise<void> {
  if (!translation) return;
  try {
    const platform = getPlatformService();
    const key = getCacheKey(text, sourceLang, targetLang, provider, variant);
    await platform.kvSetItem(
      key,
      JSON.stringify({
        translation,
        timestamp: Date.now(),
      }),
    );
  } catch (err) {
    console.warn("[Translation] Cache write error:", err);
  }
}

/** Clear all translation cache */
export async function clearTranslationCache(): Promise<void> {
  try {
    const platform = getPlatformService();
    const allKeys = await platform.kvGetAllKeys();
    const keysToRemove = allKeys.filter((key) => key.startsWith(CACHE_PREFIX));
    await Promise.all(keysToRemove.map((key) => platform.kvRemoveItem(key)));
  } catch (err) {
    console.warn("[Translation] Failed to clear translation cache:", err);
  }
}
