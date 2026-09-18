/**
 * Catalog search normalization.
 *
 * ZERO-DEPENDENCY on purpose: this module is imported by the runtime
 * (@readany/core) and executed directly by the build scripts through
 * Node's type stripping. Do not add imports here.
 *
 * Chinese retrieval uses build-time bigram indexing: CJK runs are expanded
 * into overlapping two-character tokens both when indexing (build scripts)
 * and when querying (repository). An optional traditional→simplified char
 * map (generated at build time from OpenCC) is applied symmetrically to
 * indexed text and queries.
 */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

export function containsCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/** NFKC + lowercase + strip punctuation/symbols + collapse whitespace. */
export function normalizeCatalogText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Expand one CJK run into overlapping bigrams ("线性代数" → "线性 性代 代数"). */
export function cjkRunBigrams(run: string): string[] {
  if (run.length <= 1) return [run];
  const grams: string[] = [];
  for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
  return grams;
}

/** All bigram tokens of every CJK run in a normalized text. */
export function cjkBigrams(text: string): string[] {
  const grams: string[] = [];
  for (const match of text.match(CJK_RUN) ?? []) grams.push(...cjkRunBigrams(match));
  return grams;
}

/**
 * Build the indexed search text for one catalog row:
 * normalized fields, then a bigram expansion of all CJK runs appended.
 * English matches as substrings; multi-char Chinese queries match via bigrams.
 */
export function buildCatalogIndexText(fields: Array<string | null | undefined>): string {
  const normalized = fields
    .filter((f): f is string => !!f && f.trim().length > 0)
    .map((f) => normalizeCatalogText(f))
    .join(" ");
  const grams = cjkBigrams(normalized);
  return grams.length > 0 ? `${normalized} ${grams.join(" ")}` : normalized;
}

/**
 * Build AND-ed LIKE patterns for a user query.
 * - English/other tokens: `%token%`
 * - CJK runs: one pattern per bigram (`线性代数` → `%线性%`,`%性代%`,`%代数%`)
 * Returns an empty array when nothing searchable remains (match-all).
 */
export function buildCatalogLikePatterns(query: string): string[] {
  const normalized = normalizeCatalogText(query);
  if (!normalized) return [];
  const patterns: string[] = [];
  const zhEscapes = new Set<string>();
  for (const token of normalized.split(" ")) {
    if (!token) continue;
    if (containsCjk(token)) {
      for (const gram of cjkRunBigrams(token)) {
        if (!zhEscapes.has(gram)) {
          zhEscapes.add(gram);
          patterns.push(`%${gram}%`);
        }
      }
    } else {
      patterns.push(`%${token}%`);
    }
  }
  return patterns;
}

/**
 * Apply a traditional→simplified char map symmetrically (build side indexes
 * t2s text, query side converts the query through the same map).
 * Chars missing from the map are kept unchanged.
 */
export function applyCharMap(text: string, map: Record<string, string>): string {
  if (!map || Object.keys(map).length === 0) return text;
  let out = "";
  for (const ch of text) out += map[ch] ?? ch;
  return out;
}
