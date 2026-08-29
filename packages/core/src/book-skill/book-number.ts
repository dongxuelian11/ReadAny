// Book-native chapter numbering, ported from upstream
// book-to-skill scripts/extract.py (assign_book_numbers / parse_book_number_kind, MIT),
// extended with Chinese title patterns (第N章 / 中文数字 / 附录A / 前言 / 目录 …)
// because ReadAny books are frequently Chinese.
//
// `book_number` is the single canonical user-facing chapter label (ch07, intro,
// appendix-a, fm, bm, …). The manifest `index` (extraction order) is internal
// only — never used in filenames or labels. This is upstream's hardest-won
// architectural rule; do not regress it.

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function romanToInt(input: string): number | null {
  const s = input.toLowerCase();
  if (!s) return null;
  let total = 0;
  let prev = 0;
  for (const ch of [...s].reverse()) {
    const v = ROMAN[ch];
    if (v === undefined) return null;
    total += v < prev ? -v : v;
    prev = v;
  }
  return total > 0 && total < 100 ? total : null;
}

function chineseNumeralToInt(input: string): number | null {
  if (!input) return null;
  let section = 0;
  let lastDigit = 0;
  for (const ch of input) {
    if (ch in CN_DIGITS) {
      lastDigit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      if (lastDigit === 0) lastDigit = 1; // 十X / 百X
      section += lastDigit * CN_UNITS[ch];
      lastDigit = 0;
    } else {
      return null;
    }
  }
  const total = section + lastDigit;
  return total > 0 && total < 1000 ? total : null;
}

type ChapterKind =
  | { kind: "num"; n: number }
  | { kind: "named"; label: string }
  | { kind: "appendix"; letter: string }
  | { kind: "part"; n: number }
  | { kind: "fm" }
  | { kind: "bm" }
  | { kind: "chapter" }
  | null;

const RE_NUM_CHAPTER = /^\s*chapter\s+(\d+)\b/i;
const RE_ROM_CHAPTER = /^\s*chapter\s+([ivxlcdm]+)\b/i;
const RE_ZH_NUM_CHAPTER = /^\s*第\s*(\d+)\s*[章回节]/;
const RE_ZH_ROM_CHAPTER = /^\s*第\s*([一二两三四五六七八九十百千零]+)\s*[章回节]/;
const RE_APPENDIX = /^\s*appendix\s+([a-z])\b/i;
const RE_APPENDICES = /^\s*appendi[cx]es\b/i;
const RE_ZH_APPENDIX = /^\s*附录\s*([A-Za-z])?/;
const RE_PART = /^\s*part\s+(\d+|[ivxlcdm]+)\b/i;
const RE_ZH_PART = /^\s*第\s*(\d+|[一二两三四五六七八九十百千零]+)\s*[部篇]/;
// Upstream requires a trailing [A-Za-z]; we accept any non-space so "7. 平均数"
// is classified as a numbered chapter rather than a bare one.
const RE_BARE_NUM = /^\s*(\d{1,2})\s*[.):、:—–-]\s*\S/;
const RE_FRONT_MATTER =
  /^\s*(?:praise|endorsement|advance\s+praise|title\s*page|half[\s-]?title|cover|frontispiece|copyright|dedication|acknowledg|contents|table\s+of\s+contents|toc|front\s+matter|about\s+the\s+author|author'?s\s+note|note\s+on\s+the|how\s+to\s+use\s+this\s+book|editor'?s\s+note)/i;
const RE_ZH_FRONT_MATTER = /^\s*(?:目录|版权页?|献词|致谢|扉页|封面|作者简介|出版说明)/;
const RE_BACK_MATTER =
  /^\s*(?:index\b|colophon|bibliography|references?\b|note$|notes?\s+\(|endnotes|glossary|further\s+reading|resources|back\s+matter)/i;
const RE_ZH_BACK_MATTER = /^\s*(?:索引|参考文献|参考书目|延伸阅读|术语表|注释|后记篇)/;
const RE_INTRO = /^\s*introduction\b/i;
const RE_ZH_INTRO = /^\s*(?:引言|导论|绪论)/;
const RE_PREFACE = /^\s*preface\b/i;
const RE_ZH_PREFACE = /^\s*(?:前言|序言|自序|序章)/;
const RE_PROLOGUE = /^\s*prologue\b/i;
const RE_POSTSCRIPT = /^\s*post[-\s]?script\b/i;
const RE_EPILOGUE = /^\s*epilogue\b/i;
const RE_ZH_EPILOGUE = /^\s*(?:尾声|后记|结语|结束语)/;
const RE_FOREWORD = /^\s*fore[-\s]?word\b/i;
const RE_AFTERWORD = /^\s*after[-\s]?word\b/i;
const RE_LATIN_CAPITAL = /^\s*[A-Z]/;
const CJK_RE = /[\u4e00-\u9fff]/;

function parseBookNumberKind(title: string): ChapterKind {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;

  let m = t.match(RE_NUM_CHAPTER);
  if (m) return { kind: "num", n: Number(m[1]) };
  m = t.match(RE_ZH_NUM_CHAPTER);
  if (m) return { kind: "num", n: Number(m[1]) };
  m = t.match(RE_ROM_CHAPTER);
  if (m) {
    const n = romanToInt(m[1]);
    return n ? { kind: "num", n } : { kind: "chapter" };
  }
  m = t.match(RE_ZH_ROM_CHAPTER);
  if (m) {
    const n = chineseNumeralToInt(m[1]);
    return n ? { kind: "num", n } : { kind: "chapter" };
  }
  m = t.match(RE_APPENDIX);
  if (m) return { kind: "appendix", letter: m[1].toLowerCase() };
  if (RE_APPENDICES.test(t)) return { kind: "named", label: "appendix" };
  m = t.match(RE_ZH_APPENDIX);
  if (m) {
    return m[1]
      ? { kind: "appendix", letter: m[1].toLowerCase() }
      : { kind: "named", label: "appendix" };
  }
  m = t.match(RE_PART);
  if (m) {
    const g = m[1];
    const n = /^\d+$/.test(g) ? Number(g) : romanToInt(g);
    if (n !== null) return { kind: "part", n };
  }
  m = t.match(RE_ZH_PART);
  if (m) {
    const g = m[1];
    const n = /^\d+$/.test(g) ? Number(g) : chineseNumeralToInt(g);
    if (n !== null) return { kind: "part", n };
  }
  if (RE_INTRO.test(t) || RE_ZH_INTRO.test(t)) return { kind: "named", label: "intro" };
  if (RE_PREFACE.test(t) || RE_ZH_PREFACE.test(t)) return { kind: "named", label: "preface" };
  if (RE_PROLOGUE.test(t)) return { kind: "named", label: "prologue" };
  if (RE_POSTSCRIPT.test(t)) return { kind: "named", label: "postscript" };
  if (RE_EPILOGUE.test(t) || RE_ZH_EPILOGUE.test(t)) return { kind: "named", label: "epilogue" };
  if (RE_FOREWORD.test(t)) return { kind: "named", label: "foreword" };
  if (RE_AFTERWORD.test(t)) return { kind: "named", label: "afterword" };
  if (RE_FRONT_MATTER.test(t) || RE_ZH_FRONT_MATTER.test(t)) return { kind: "fm" };
  if (RE_BACK_MATTER.test(t) || RE_ZH_BACK_MATTER.test(t)) return { kind: "bm" };
  m = t.match(RE_BARE_NUM);
  if (m) return { kind: "num", n: Number(m[1]) };
  // Upstream heuristic: a capitalised title of >= 4 chars is a real chapter.
  // Extended: any CJK title of >= 2 chars is a real chapter.
  if (RE_LATIN_CAPITAL.test(t) && t.length >= 4) return { kind: "chapter" };
  if (CJK_RE.test(t) && t.trim().length >= 2) return { kind: "chapter" };
  return null;
}

function disambiguateNamedDuplicates(labels: Array<string | null>): Array<string | null> {
  const seen = new Map<string, number>();
  const out: Array<string | null> = [];
  for (const label of labels) {
    if (label === null) {
      out.push(null);
      continue;
    }
    const count = seen.get(label);
    if (count === undefined) {
      seen.set(label, 1);
      out.push(label);
    } else {
      seen.set(label, count + 1);
      out.push(`${label}-${count + 1}`);
    }
  }
  return out;
}

/**
 * Assign `book_number` labels for the chapter titles, in order, following
 * upstream's two-pass algorithm: classify every title, then sequentially
 * number bare-titled chapters while respecting numbers already declared
 * explicitly in other titles.
 */
export function assignBookNumbers(titles: string[]): string[] {
  const kinds = titles.map((title) => parseBookNumberKind(title ?? ""));
  const explicitNums = new Set<number>();
  for (const k of kinds) {
    if (k && k.kind === "num") explicitNums.add(k.n);
  }
  let nextN = 1;
  const rawLabels: Array<string | null> = kinds.map((k) => {
    if (k === null) return null;
    switch (k.kind) {
      case "num":
        return `ch${String(k.n).padStart(2, "0")}`;
      case "named":
        return k.label;
      case "appendix":
        return `appendix-${k.letter}`;
      case "part":
        return `part-${k.n}`;
      case "fm":
        return "fm";
      case "bm":
        return "bm";
      case "chapter": {
        while (explicitNums.has(nextN)) nextN += 1;
        const label = `ch${String(nextN).padStart(2, "0")}`;
        nextN += 1;
        return label;
      }
    }
  });
  const labels = disambiguateNamedDuplicates(rawLabels);
  return labels.map((label, i) => label ?? `ch${String(i + 1).padStart(2, "0")}-unclassified`);
}

/** Upstream slugify, extended to keep CJK characters so Chinese titles stay readable. */
export function chapterSlug(title: string, maxlen = 48): string {
  const s = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  const clipped = s.slice(0, maxlen).replace(/-+$/, "");
  return clipped || "section";
}
