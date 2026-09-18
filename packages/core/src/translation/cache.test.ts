import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFromCache, storeInCache, translationCacheVariant } from "./cache";

// Mock the platform KV used by the translation cache — an in-memory map.
const kv = new Map<string, string>();
vi.mock("../services/platform", () => ({
  getPlatformService: () => ({
    kvGetItem: vi.fn(async (key: string) => kv.get(key) ?? null),
    kvSetItem: vi.fn(async (key: string, value: string) => {
      kv.set(key, value);
    }),
    kvRemoveItem: vi.fn(async (key: string) => {
      kv.delete(key);
    }),
    kvGetAllKeys: vi.fn(async () => [...kv.keys()]),
  }),
}));

beforeEach(() => {
  kv.clear();
});

describe("translation cache identity", () => {
  // The old 32-bit rolling hash produced the SAME key for these two texts,
  // so "The asset code is BB." was served the translation of "…Aa.".
  const collisionA = "The asset code is Aa.";
  const collisionB = "The asset code is BB.";

  it("gives colliding-under-32bit texts different cache keys", async () => {
    await storeInCache(collisionA, "译文A", "en", "zh-CN", "ai", "mtest_p3");
    const hitForB = await getFromCache(collisionB, "en", "zh-CN", "ai", "mtest_p3");
    expect(hitForB).toBeNull();
    const hitForA = await getFromCache(collisionA, "en", "zh-CN", "ai", "mtest_p3");
    expect(hitForA).toBe("译文A");
  });

  it("does not return a translation whose stored source fingerprint mismatches", async () => {
    await storeInCache("original text", "旧译文", "en", "zh-CN", "microsoft");
    // Tamper: reuse the SAME key with a record whose fingerprint belongs to
    // another source (simulates a stale/corrupted entry).
    const key = [...kv.keys()][0];
    if (!key) throw new Error("cache entry was not stored");
    const record = JSON.parse(kv.get(key) ?? "{}");
    kv.set(key, JSON.stringify({ ...record, src: "deadbeef" }));
    const hit = await getFromCache("original text", "en", "zh-CN", "microsoft");
    expect(hit).toBeNull();
  });

  it("never stores empty translations", async () => {
    await storeInCache("some text", "", "en", "zh-CN", "microsoft");
    expect(kv.size).toBe(0);
  });

  it("binds the ai variant to model, endpoint identity, and prompt version", () => {
    const v1 = translationCacheVariant("ai", "deepseek-chat", "https://api.deepseek.com");
    const v2 = translationCacheVariant("ai", "deepseek-chat", "https://other.example.com");
    const v3 = translationCacheVariant("ai", "another-model", "https://api.deepseek.com");
    expect(v1).not.toBe(v2);
    expect(v1).not.toBe(v3);
    expect(v1).toContain("_p");
    // non-ai providers never had variants and still don't
    expect(translationCacheVariant("microsoft")).toBeUndefined();
  });
});
