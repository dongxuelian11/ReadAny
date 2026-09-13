/**
 * Catalog (内置书库) domain types.
 *
 * The catalog is a build-time, read-only snapshot of real book metadata from
 * official public sources (Gutendex/Project Gutenberg, Open Textbook Library).
 * It is separate from the user library: catalog entries describe what EXISTS
 * and how it can be obtained; user `Book` records are only created when the
 * user actually installs a bundled resource through importBooks.
 */

/** How the full text of an edition can be reached right now. */
export type CatalogAvailability =
  /** Complete file ships inside the app resources; offline readable. */
  | "bundled"
  /** Full text is legitimately readable/downloadable online (verified landing/download URL). */
  | "online"
  /** Bibliographic record only; no verified full-text entry point. */
  | "metadata-only";

export interface CatalogSubjectDef {
  id: string;
  zh: string;
  en: string;
  /** Gutendex topic= query keywords (also substring-matched against Gutendex subjects). */
  gutendexTopics: string[];
  /** Substring keywords (en + zh) matched against source subject strings / OTL subject names. */
  keywords: string[];
}

export interface CatalogResource {
  format: string;
  /** Human-facing landing page (publisher, Gutenberg ebook page, official site). */
  landingUrl?: string;
  /** Direct download URL — only recorded when actually fetchable, never invented. */
  downloadUrl?: string;
  availability: CatalogAvailability;
  licenseId: string;
  licenseUrl?: string;
  /** Attribution string required by the license, when applicable. */
  attribution?: string;
  /** SHA-256 of the bundled/verified file, hex lowercase. */
  sha256?: string;
  sizeBytes?: number;
  /** ISO date (YYYY-MM-DD) of the last real verification of this resource. */
  verifiedAt?: string;
}

/** One concrete edition of a work in the catalog. Versions/translations keep separate identity. */
export interface CatalogEdition {
  catalogEditionId: string;
  providerId: string;
  providerRecordId: string;
  /** Optional work grouping key; editions of the same work share it. */
  workKey?: string;
  originalTitle: string;
  /** Chinese display name. `reference` = 参考译名 (not an official Chinese edition title). */
  titleZh?: string;
  titleZhSource?: "original" | "curated" | "reference";
  authors: string[];
  /** ISO 639-1/639-3 code as provided by the source. */
  language: string;
  publisher?: string;
  year?: number;
  /** Subject category ids from CATALOG_SUBJECTS. */
  subjectIds: string[];
  /** Reading level is source-provided or curated; "unknown" is legal and common. */
  level: string;
  /** Hand-written or source-provided Chinese intro. Never fabricated from thin air. */
  descriptionZh?: string;
  /** Table of contents when actually known from the source. */
  toc?: string[];
  /** Source-provided popularity signal (downloads / reviews). */
  popularity?: number;
  resource: CatalogResource;
  /** Resource-relative file name of the bundled full text (bundled editions only). */
  bundledFile?: string;
}

/** Row shape as stored in catalog.sqlite (flat columns; JSON arrays serialized). */
export interface CatalogEditionRow {
  catalog_edition_id: string;
  provider_id: string;
  provider_record_id: string;
  work_key: string | null;
  original_title: string;
  title_zh: string | null;
  title_zh_source: string | null;
  authors: string;
  language: string;
  publisher: string | null;
  year: number | null;
  subject_ids: string;
  level: string;
  description_zh: string | null;
  toc: string | null;
  popularity: number | null;
  resource_format: string;
  resource_landing_url: string | null;
  resource_download_url: string | null;
  availability: string;
  license_id: string;
  license_url: string | null;
  attribution: string | null;
  sha256: string | null;
  size_bytes: number | null;
  verified_at: string | null;
  bundled_file: string | null;
  search_text: string;
}

export interface CatalogQuery {
  /** Free-text query, Chinese (simplified/traditional) or English. */
  q?: string;
  /** Subject category id filter. */
  subjectId?: string;
  language?: string;
  /** Availability filter, e.g. "bundled" for 内置可读. */
  availability?: CatalogAvailability;
  page: number;
  pageSize: number;
}

export interface CatalogQueryResult {
  total: number;
  editions: CatalogEdition[];
}

export interface CatalogStats {
  totalEditions: number;
  byProvider: Record<string, number>;
  byAvailability: Record<CatalogAvailability, number>;
  bySubject: Record<string, number>;
  byLanguage: { language: string; count: number }[];
  bundledCount: number;
  chineseOriginalCount: number;
  builtAt: string;
  schemaVersion: number;
}
