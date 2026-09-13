import {
  CATALOG_SUBJECTS,
  type CatalogAvailability,
  type CatalogEdition,
  type CatalogEditionRow,
  type CatalogQuery,
  type CatalogQueryResult,
  type CatalogStats,
  applyCharMap,
  buildCatalogLikePatterns,
} from "@readany/core/catalog";
import type { IDatabase } from "@readany/core/services";
import { getPlatformService } from "@readany/core/services";
import { ensureCatalogSeeded, getCatalogSeedBase } from "./seed";

/**
 * Read-only access to the shipped catalog snapshot (catalog.sqlite in the
 * user data dir, copied from resources on first launch). Queries page through
 * SQLite — the catalog never enters the Zustand library store, which stays
 * the home of actual user books.
 */

let catalogDbPromise: Promise<IDatabase> | null = null;

async function getCatalogDb(): Promise<IDatabase> {
  if (!catalogDbPromise) {
    catalogDbPromise = (async () => {
      const { dbPath } = await ensureCatalogSeeded();
      return getPlatformService().loadDatabase(`sqlite:${dbPath}`);
    })();
  }
  return catalogDbPromise;
}

// ── traditional→simplified query normalization (map generated at build time) ──

let t2sMapPromise: Promise<Record<string, string>> | null = null;

async function getT2sMap(): Promise<Record<string, string>> {
  if (!t2sMapPromise) {
    t2sMapPromise = (async () => {
      try {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const { join } = await import("@tauri-apps/api/path");
        const seedBase = await getCatalogSeedBase();
        const raw = await readTextFile(await join(seedBase, "t2s-chars.json"));
        return JSON.parse(raw) as Record<string, string>;
      } catch (err) {
        console.warn("[catalog] t2s map unavailable, simplified-only search:", err);
        return {};
      }
    })();
  }
  return t2sMapPromise;
}

// ── row mapping ──

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function rowToEdition(row: CatalogEditionRow): CatalogEdition {
  return {
    catalogEditionId: row.catalog_edition_id,
    providerId: row.provider_id,
    providerRecordId: row.provider_record_id,
    workKey: row.work_key ?? undefined,
    originalTitle: row.original_title,
    titleZh: row.title_zh ?? undefined,
    titleZhSource: (row.title_zh_source as CatalogEdition["titleZhSource"]) ?? undefined,
    authors: parseJsonArray(row.authors),
    language: row.language,
    publisher: row.publisher ?? undefined,
    year: row.year ?? undefined,
    subjectIds: parseJsonArray(row.subject_ids),
    level: row.level,
    descriptionZh: row.description_zh ?? undefined,
    toc: parseJsonArray(row.toc),
    popularity: row.popularity ?? 0,
    resource: {
      format: row.resource_format,
      landingUrl: row.resource_landing_url ?? undefined,
      downloadUrl: row.resource_download_url ?? undefined,
      availability: row.availability as CatalogAvailability,
      licenseId: row.license_id,
      licenseUrl: row.license_url ?? undefined,
      attribution: row.attribution ?? undefined,
      sha256: row.sha256 ?? undefined,
      sizeBytes: row.size_bytes ?? undefined,
      verifiedAt: row.verified_at ?? undefined,
    },
    bundledFile: row.bundled_file ?? undefined,
  };
}

// ── queries ──

interface QueryWhere {
  sql: string;
  params: (string | number)[];
}

async function buildWhere(query: CatalogQuery): Promise<QueryWhere> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (query.q?.trim()) {
    const t2s = await getT2sMap();
    const patterns = buildCatalogLikePatterns(applyCharMap(query.q, t2s));
    for (const pattern of patterns) {
      clauses.push("search_text LIKE ?");
      params.push(pattern);
    }
  }
  if (query.subjectId) {
    clauses.push("subject_ids LIKE ?");
    params.push(`%"${query.subjectId}"%`);
  }
  if (query.availability) {
    clauses.push("availability = ?");
    params.push(query.availability);
  }
  if (query.language) {
    clauses.push("language = ?");
    params.push(query.language);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export async function queryCatalog(query: CatalogQuery): Promise<CatalogQueryResult> {
  const db = await getCatalogDb();
  const where = await buildWhere(query);
  const pageSize = Math.min(Math.max(query.pageSize, 1), 100);
  const page = Math.max(query.page, 1);
  const offset = (page - 1) * pageSize;

  const totalRows = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM editions ${where.sql}`,
    where.params,
  );
  const rows = await db.select<CatalogEditionRow>(
    `SELECT * FROM editions ${where.sql}
     ORDER BY (availability='bundled') DESC, popularity DESC, original_title
     LIMIT ? OFFSET ?`,
    [...where.params, pageSize, offset],
  );
  return { total: totalRows[0]?.n ?? 0, editions: rows.map(rowToEdition) };
}

export async function getCatalogEdition(id: string): Promise<CatalogEdition | null> {
  const db = await getCatalogDb();
  const rows = await db.select<CatalogEditionRow>(
    "SELECT * FROM editions WHERE catalog_edition_id = ?",
    [id],
  );
  return rows[0] ? rowToEdition(rows[0]) : null;
}

export async function getCatalogStats(): Promise<CatalogStats> {
  const db = await getCatalogDb();
  const meta = Object.fromEntries(
    (await db.select<{ key: string; value: string }>("SELECT key, value FROM meta")).map((r) => [
      r.key,
      r.value,
    ]),
  );
  const [total] = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM editions");
  const byProvider = Object.fromEntries(
    (
      await db.select<{ provider_id: string; n: number }>(
        "SELECT provider_id, COUNT(*) AS n FROM editions GROUP BY provider_id",
      )
    ).map((r) => [r.provider_id, r.n]),
  );
  const byAvailability: Record<CatalogAvailability, number> = {
    bundled: 0,
    online: 0,
    "metadata-only": 0,
  };
  for (const r of await db.select<{ availability: string; n: number }>(
    "SELECT availability, COUNT(*) AS n FROM editions GROUP BY availability",
  )) {
    if (r.availability in byAvailability)
      byAvailability[r.availability as CatalogAvailability] = r.n;
  }
  const bySubject: Record<string, number> = {};
  for (const s of CATALOG_SUBJECTS) bySubject[s.id] = 0;
  for (const r of await db.select<{ subject_ids: string }>("SELECT subject_ids FROM editions")) {
    for (const id of parseJsonArray(r.subject_ids)) {
      if (id in bySubject) bySubject[id] += 1;
    }
  }
  const byLanguage = (
    await db.select<{ language: string; n: number }>(
      "SELECT language, COUNT(*) AS n FROM editions GROUP BY language ORDER BY n DESC LIMIT 12",
    )
  ).map((r) => ({ language: r.language, count: r.n }));
  const [bundled] = await db.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM editions WHERE availability='bundled'",
  );
  const [chineseOriginal] = await db.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM editions WHERE language LIKE 'zh%' AND availability='bundled'",
  );

  return {
    totalEditions: total?.n ?? 0,
    byProvider,
    byAvailability,
    bySubject,
    byLanguage,
    bundledCount: bundled?.n ?? 0,
    chineseOriginalCount: chineseOriginal?.n ?? 0,
    builtAt: meta.built_at ?? "",
    schemaVersion: Number(meta.schema_version ?? 0),
  };
}
