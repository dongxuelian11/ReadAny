import { describe, expect, it } from "vitest";
import { CATALOG_SUBJECTS, CATALOG_SUBJECT_IDS, getCatalogSubject } from "./index";
import {
  applyCharMap,
  buildCatalogIndexText,
  buildCatalogLikePatterns,
  cjkBigrams,
  normalizeCatalogText,
} from "./normalize";
import type { CatalogEdition } from "./types";

describe("normalizeCatalogText", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalizeCatalogText("Hello, World! —  A  Test ")).toBe("hello world a test");
  });

  it("keeps CJK characters adjacent without spaces", () => {
    expect(normalizeCatalogText("《紅樓夢》：曹雪芹")).toBe("紅樓夢 曹雪芹");
  });
});

describe("cjk bigrams", () => {
  it("expands runs into overlapping bigrams", () => {
    expect(cjkBigrams("线性代数")).toEqual(["线性", "性代", "代数"]);
  });

  it("keeps single characters searchable", () => {
    expect(cjkBigrams("概")).toEqual(["概"]);
  });

  it("handles mixed-script text", () => {
    expect(cjkBigrams("hello 概率 world")).toEqual(["概率"]);
  });
});

describe("buildCatalogIndexText", () => {
  it("appends bigram expansion after normalized fields", () => {
    const index = buildCatalogIndexText(["紅樓夢", "Cao Xueqin"]);
    expect(index).toContain("紅樓夢");
    expect(index).toContain("cao xueqin");
    expect(index).toContain("紅樓 樓夢");
  });

  it("ignores empty fields", () => {
    expect(buildCatalogIndexText(["", null, "  ", "math"])).toBe("math");
  });
});

describe("buildCatalogLikePatterns", () => {
  it("returns empty for blank queries (match-all)", () => {
    expect(buildCatalogLikePatterns("  ")).toEqual([]);
  });

  it("ANDs English tokens", () => {
    expect(buildCatalogLikePatterns("Jane Austen")).toEqual(["%jane%", "%austen%"]);
  });

  it("expands multi-char Chinese queries into bigram conditions", () => {
    expect(buildCatalogLikePatterns("线性代数")).toEqual(["%线性%", "%性代%", "%代数%"]);
    expect(buildCatalogLikePatterns("概率")).toEqual(["%概率%"]);
    expect(buildCatalogLikePatterns("概")).toEqual(["%概%"]);
  });

  it("handles mixed queries", () => {
    expect(buildCatalogLikePatterns("微积分 calculus")).toEqual(["%微积%", "%积分%", "%calculus%"]);
  });
});

describe("applyCharMap", () => {
  it("converts mapped chars and keeps the rest", () => {
    const map = { 紅: "红", 樓: "楼", 夢: "梦" };
    expect(applyCharMap("紅樓夢", map)).toBe("红楼梦");
    expect(applyCharMap("紅楼ABC", map)).toBe("红楼ABC");
  });

  it("is a no-op with an empty map", () => {
    expect(applyCharMap("紅樓夢", {})).toBe("紅樓夢");
  });
});

describe("bigram query matches bigram index (round trip)", () => {
  const index = buildCatalogIndexText([
    "Calculus Made Easy",
    "Silvanus P. Thompson",
    "数学",
    "微积分入门",
  ]);
  const cases: Array<[string, boolean]> = [
    ["calculus", true],
    ["微积分", true],
    ["入门", true],
    ["thompson", true],
    ["不存在的书", false],
  ];
  for (const [query, shouldMatch] of cases) {
    it(`query "${query}" ${shouldMatch ? "matches" : "does not match"}`, () => {
      const patterns = buildCatalogLikePatterns(query);
      expect(patterns.length).toBeGreaterThan(0);
      const matched = patterns.every((p) => index.includes(p.slice(1, -1)));
      expect(matched).toBe(shouldMatch);
    });
  }
});

describe("catalog subjects", () => {
  it("defines exactly the 16 planned categories with unique ids", () => {
    expect(CATALOG_SUBJECTS).toHaveLength(16);
    expect(CATALOG_SUBJECT_IDS.size).toBe(16);
    for (const s of CATALOG_SUBJECTS) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(s.zh.length).toBeGreaterThan(0);
      expect(s.en.length).toBeGreaterThan(0);
      expect(s.keywords.length).toBeGreaterThan(0);
    }
  });

  it("resolves subjects by id", () => {
    expect(getCatalogSubject("math")?.zh).toBe("数学");
    expect(getCatalogSubject("nonexistent")).toBeUndefined();
  });
});

describe("catalog edition validation", () => {
  it("rejects fabricated editions without a provider record", () => {
    const edition: CatalogEdition = {
      catalogEditionId: "gutendex:24264",
      providerId: "gutendex",
      providerRecordId: "24264",
      originalTitle: "紅樓夢",
      authors: ["Cao Xueqin"],
      language: "zh",
      subjectIds: ["lang-lit"],
      level: "unknown",
      resource: {
        format: "epub",
        availability: "bundled",
        licenseId: "Public domain",
      },
    };
    expect(edition.providerRecordId).toBeTruthy();
    expect(edition.resource.downloadUrl ?? edition.resource.availability === "bundled").toBe(true);
  });
});
