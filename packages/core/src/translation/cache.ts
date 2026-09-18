/**
 * Translation Cache
 * Cross-platform cache for translation results using IPlatformService KV storage.
 *
 * All methods are async to support both Web (localStorage) and RN (AsyncStorage).
 *
 * Cache identity rules:
 *  - The key binds provider + source/target language + variant (model +
 *    endpoint identity + prompt version for "ai"). API keys are NEVER part of
 *    the key or the stored value.
 *  - The stored record carries a strong (SHA-256) fingerprint of the source
 *    text, verified on read — the previous 32-bit rolling hash let crafted
 *    collisions serve one paragraph's translation for a different paragraph.
 *  - Records from the old hash scheme are simply unreachable (different key
 *    space) and expire naturally; user notes and learner state are untouched.
 */

import { getPlatformService } from "../services/platform";
import type { TranslatorName } from "./types";

const CACHE_PREFIX = "readany_translation_cache_";

/** Bump when the AI translation prompt OR cache identity changes in a way that
 * must not reuse previous output. */
export const AI_TRANSLATION_PROMPT_VERSION = 3;

/**
 * Extra key material that invalidates cached translations when the thing that
 * produced them changes. For the "ai" provider this is the model + endpoint
 * identity (hash of the non-secret base URL) + prompt version — switching
 * providers, models, or endpoints must never reuse the previous output as if
 * it were fresh.
 */
export function translationCacheVariant(
  provider: TranslatorName,
  model?: string,
  baseUrl?: string,
): string | undefined {
  if (provider !== "ai") return undefined;
  const endpoint = baseUrl ? `@e${strongSyncFingerprint(baseUrl)}` : "";
  return `m${model || "default"}${endpoint}_p${AI_TRANSLATION_PROMPT_VERSION}`;
}

/**
 * SHA-256 hex digest when WebCrypto is available; a noticeably stronger
 * synchronous fallback (two independent 32-bit mixes over code points) when it
 * is not — either way the old single 32-bit rolling hash is gone.
 */
export async function strongTextFingerprint(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      // fall through to the synchronous fallback
    }
  }
  return `fb$${strongSyncFingerprint(text)}`;
}

function strongSyncFingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c + i, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** Generate cache key */
async function getCacheKey(
  text: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  variant?: string,
): Promise<string> {
  const hash = await strongTextFingerprint(text);
  const suffix = variant ? `_${variant}` : "";
  return `${CACHE_PREFIX}${provider}_${sourceLang}_${targetLang}_${hash}${suffix}`;
}

interface CachedRecord {
  translation: string;
  timestamp: number;
  /** SHA-256 (or fallback fingerprint) of the exact source text — verified on read. */
  src: string;
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
    const key = await getCacheKey(text, sourceLang, targetLang, provider, variant);
    const cached = await platform.kvGetItem(key);
    if (cached) {
      const record = JSON.parse(cached) as Partial<CachedRecord>;
      // Cache expires after 7 days; empty translations are never valid cache;
      // a record whose source fingerprint no longer matches the requested
      // text is a collision/stale entry and is dropped.
      const fingerprint = await strongTextFingerprint(text);
      const translation = typeof record.translation === "string" ? record.translation : "";
      const valid =
        translation.length > 0 &&
        typeof record.timestamp === "number" &&
        Date.now() - record.timestamp < 7 * 24 * 60 * 60 * 1000 &&
        record.src === fingerprint;
      if (valid) return translation;
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
    const key = await getCacheKey(text, sourceLang, targetLang, provider, variant);
    const record: CachedRecord = {
      translation,
      timestamp: Date.now(),
      src: await strongTextFingerprint(text),
    };
    await platform.kvSetItem(key, JSON.stringify(record));
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
