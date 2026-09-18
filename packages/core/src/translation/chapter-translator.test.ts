import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cache from "./cache";
import type { ChapterParagraph, TranslateChapterOptions } from "./chapter-translator";
import { translateChapter } from "./chapter-translator";

// Mock the platform KV used by the translation cache.
vi.mock("../services/platform", () => ({
  getPlatformService: () => ({
    kvGetItem: vi.fn(async () => null),
    kvSetItem: vi.fn(async () => {}),
    kvRemoveItem: vi.fn(async () => {}),
    kvGetAllKeys: vi.fn(async () => []),
  }),
}));

// Mock providers: the ai provider fails for chunks containing "boom".
vi.mock("./providers", () => ({
  aiTranslateBatch: vi.fn(async (texts: string[]) => {
    if (texts.some((t) => t.includes("boom"))) throw new Error("provider down");
    return texts.map((t) => `译:${t}`);
  }),
  deeplTranslate: vi.fn(async (texts: string[]) => texts.map((t) => `译:${t}`)),
  microsoftTranslate: vi.fn(async (texts: string[]) => texts.map((t) => `译:${t}`)),
}));

function paras(...texts: string[]): ChapterParagraph[] {
  return texts.map((t, i) => ({ id: `p${i}`, text: t, tagName: "p" }));
}

function baseOptions(paragraphs: ChapterParagraph[]): TranslateChapterOptions {
  return {
    paragraphs,
    sourceLang: "AUTO",
    targetLang: "zh-CN",
    config: {
      provider: {
        id: "ai",
        name: "AI",
        model: "test-model",
      },
    } as unknown as TranslateChapterOptions["config"],
    charsPerChunk: 100,
    concurrency: 1,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("translateChapter failure semantics", () => {
  it("does not count failed chunks as translated progress", async () => {
    const paragraphs = paras("hello world", "boom text", "more text here");
    const progressUpdates: Array<{ totalChars: number; translatedChars: number }> = [];
    const errors: Array<{ paragraphIds: string[] }> = [];

    // Force every attempt to fail for the "boom" paragraph.
    const { aiTranslateBatch } = await import("./providers");
    vi.mocked(aiTranslateBatch).mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.includes("boom"))) throw new Error("provider down");
      return texts.map((t) => `译:${t}`);
    });

    const results = await translateChapter({
      ...baseOptions(paragraphs),
      charsPerChunk: 10,
      onProgress: (p) => progressUpdates.push(p),
      onChunkError: (info) => errors.push(info),
    });

    const final = progressUpdates[progressUpdates.length - 1];
    expect(final.translatedChars).toBeLessThan(final.totalChars);
    expect(errors).toHaveLength(1);
    expect(errors[0].paragraphIds).toEqual(["p1"]);
    const failed = results.find((r) => r.paragraphId === "p1");
    expect(failed?.translatedText).toBe("");
  });

  it("retries a transient failure once and succeeds", async () => {
    const paragraphs = paras("steady text", "boom once");
    const { aiTranslateBatch } = await import("./providers");
    let boomAttempts = 0;
    vi.mocked(aiTranslateBatch).mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.includes("boom once"))) {
        boomAttempts += 1;
        if (boomAttempts === 1) throw new Error("transient");
      }
      return texts.map((t) => `译:${t}`);
    });

    const progressUpdates: Array<{ translatedChars: number; totalChars: number }> = [];
    const errors: unknown[] = [];
    const results = await translateChapter({
      ...baseOptions(paragraphs),
      onProgress: (p) => progressUpdates.push(p),
      onChunkError: (info) => errors.push(info),
    });

    expect(boomAttempts).toBe(2);
    expect(errors).toHaveLength(0);
    const final = progressUpdates[progressUpdates.length - 1];
    expect(final.translatedChars).toBe(final.totalChars);
    expect(results.find((r) => r.paragraphId === "p1")?.translatedText).toContain("boom once");
  });

  it("cache variant changes with the configured model", async () => {
    const kv = new Map<string, string>();
    const storeSpy = vi
      .spyOn(cache, "storeInCache")
      .mockImplementation(async (text, translation, _source, _target, provider, variant) => {
        const hash = text.slice(0, 8);
        kv.set(`${provider}_${variant}_${hash}`, translation);
      });

    await translateChapter(baseOptions(paras("variant text one")));
    const keys = [...kv.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("ai_mtest-model_p3");
    expect(storeSpy).toHaveBeenCalled();
  });

  it("rejects a provider batch that is shorter than the request (no blank successes)", async () => {
    const paragraphs = paras("alpha text", "beta text", "gamma text");
    const { aiTranslateBatch } = await import("./providers");
    vi.mocked(aiTranslateBatch).mockImplementation(async (texts: string[]) =>
      // provider silently drops the last entry — previously the missing tail
      // was stored as "" and counted as translated progress
      texts
        .slice(0, texts.length - 1)
        .map((t) => `译:${t}`),
    );
    const progressUpdates: Array<{ translatedChars: number; totalChars: number }> = [];
    const errors: Array<{ paragraphIds: string[] }> = [];

    const results = await translateChapter({
      ...baseOptions(paragraphs),
      charsPerChunk: 1000,
      onProgress: (p) => progressUpdates.push(p),
      onChunkError: (info) => errors.push(info),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].paragraphIds).toEqual(["p0", "p1", "p2"]);
    const final = progressUpdates[progressUpdates.length - 1];
    expect(final.translatedChars).toBe(0);
    expect(results.every((r) => r.translatedText === "")).toBe(true);
  });

  it("rejects whitespace-only provider entries as failed chunks", async () => {
    const paragraphs = paras("delta text");
    const { aiTranslateBatch } = await import("./providers");
    vi.mocked(aiTranslateBatch).mockImplementation(async (texts: string[]) =>
      texts.map(() => "   "),
    );
    const errors: Array<{ paragraphIds: string[] }> = [];
    const results = await translateChapter({
      ...baseOptions(paragraphs),
      charsPerChunk: 1000,
      onChunkError: (info) => errors.push(info),
    });
    expect(errors).toHaveLength(1);
    expect(results.every((r) => r.translatedText === "")).toBe(true);
  });
});
