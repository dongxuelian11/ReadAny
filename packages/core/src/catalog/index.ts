export type {
  CatalogAvailability,
  CatalogEdition,
  CatalogEditionRow,
  CatalogQuery,
  CatalogQueryResult,
  CatalogResource,
  CatalogStats,
  CatalogSubjectDef,
} from "./types";
export { CATALOG_SCHEMA_VERSION } from "./schema-version";
export {
  applyCharMap,
  buildCatalogIndexText,
  buildCatalogLikePatterns,
  cjkBigrams,
  cjkRunBigrams,
  containsCjk,
  normalizeCatalogText,
} from "./normalize";
import subjectsJson from "./subjects.json";
import type { CatalogSubjectDef } from "./types";

/** The 16 catalog subject categories, in display order. */
export const CATALOG_SUBJECTS: CatalogSubjectDef[] = subjectsJson as CatalogSubjectDef[];

export const CATALOG_SUBJECT_IDS = new Set(CATALOG_SUBJECTS.map((s) => s.id));

export function getCatalogSubject(id: string): CatalogSubjectDef | undefined {
  return CATALOG_SUBJECTS.find((s) => s.id === id);
}
