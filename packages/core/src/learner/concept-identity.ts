// Global concept identity seam (PR-015 — review item #2, V1 "seam only" per
// the user decision of 2026-09-05). Today every learner identity is the
// chapter-scoped `readany:book:<bookId>:chapter:<n>` id. This module makes
// that format an explicit, first-class SOURCE-UNIT identity and adds the
// registry tables (concepts, aliases, source-unit bindings, relations) that a
// future global ConceptGraph will populate — without touching any existing
// evidence, mastery, or goal rows.
//
// V1 semantics (identity-preserving): registering a chapter concept binds the
// source unit to a concept whose id IS the source-unit id. All historical rows
// stay valid. V2 can mint canonical concept ids (LLM-extracted, cross-book)
// and REBIND source units/aliases through this registry — evidence rows never
// change.

export interface ConceptRecord {
  conceptId: string;
  displayName: string;
  createdAt: number;
}

export type ConceptRelationKind = "prerequisite" | "related" | "part_of";

export interface ConceptRelation {
  conceptId: string;
  relatedConceptId: string;
  relation: ConceptRelationKind;
  createdAt: number;
}

export interface ConceptIdentityStore {
  /** Idempotent registration: an existing concept keeps its first record. */
  registerConcept(concept: ConceptRecord): Promise<void>;
  /** Bind (or rebind — the V2 migration path) a source unit to a concept. */
  bindSourceUnit(sourceUnitId: string, conceptId: string): Promise<void>;
  /** Bind (or rebind) an alias to a concept. */
  bindAlias(alias: string, conceptId: string): Promise<void>;
  resolveBySourceUnit(sourceUnitId: string): Promise<string | null>;
  resolveByAlias(alias: string): Promise<string | null>;
  /** Schema-seam write; nothing produces relations in V1. */
  bindRelation(relation: Omit<ConceptRelation, "createdAt">, createdAt: number): Promise<void>;
  listRelated(conceptId: string): Promise<ConceptRelation[]>;
  /** V2 (PR-024): N:M participation — one chapter (source unit) can belong to
   * many topic concepts, and one concept spans many chapters/books. Unlike
   * bindSourceUnit (1:1 owner binding), this never overwrites. */
  bindConceptSourceUnit(conceptId: string, sourceUnitId: string): Promise<void>;
  listConceptsForSourceUnit(sourceUnitId: string): Promise<string[]>;
  listConcepts(): Promise<ConceptRecord[]>;
  /** V2 (PR-026): reverse participation — the chapters a concept covers. */
  listSourceUnitsForConcept(conceptId: string): Promise<string[]>;
}

/** The legacy chapter-scoped identity, now explicit as a SOURCE-UNIT id. */
export function sourceUnitId(bookId: string, chapterIndex: number): string {
  return `readany:book:${bookId}:chapter:${chapterIndex}`;
}

/** Parse a chapter source-unit id; null for any other id shape. */
export function parseChapterSourceUnit(
  id: string,
): { bookId: string; chapterIndex: number } | null {
  const match = /^readany:book:(.*):chapter:(\d+)$/.exec(id);
  if (!match) return null;
  return { bookId: match[1], chapterIndex: Number.parseInt(match[2], 10) };
}

/** Lazily register a chapter's concept identity (idempotent). V1 keeps the
 * concept id identical to the source-unit id, so existing consumers see no
 * change; the registry row + binding make the identity migratable in V2. */
export async function ensureChapterConceptIdentity(
  store: ConceptIdentityStore,
  chapter: { bookId: string; chapterIndex: number; title: string },
  now: number,
): Promise<string> {
  const unit = sourceUnitId(chapter.bookId, chapter.chapterIndex);
  const existing = await store.resolveBySourceUnit(unit);
  if (existing) return existing;
  await store.registerConcept({ conceptId: unit, displayName: chapter.title, createdAt: now });
  await store.bindSourceUnit(unit, unit);
  return unit;
}

export function createInMemoryConceptIdentityStore(): ConceptIdentityStore {
  const concepts = new Map<string, ConceptRecord>();
  const sourceUnits = new Map<string, string>();
  const aliases = new Map<string, string>();
  const relations: ConceptRelation[] = [];
  const participations = new Map<string, Set<string>>(); // sourceUnitId -> conceptIds
  return {
    async registerConcept(concept) {
      if (!concepts.has(concept.conceptId)) {
        concepts.set(concept.conceptId, { ...concept });
      }
    },
    async bindSourceUnit(sourceUnitId, conceptId) {
      sourceUnits.set(sourceUnitId, conceptId);
    },
    async bindAlias(alias, conceptId) {
      // Add-only (iter-3, review item G): an alias already owned by a
      // different concept is never silently stolen — first binding wins.
      // Callers that need conflict semantics check resolveByAlias first.
      if (!aliases.has(alias)) aliases.set(alias, conceptId);
    },
    async resolveBySourceUnit(sourceUnitId) {
      return sourceUnits.get(sourceUnitId) ?? null;
    },
    async resolveByAlias(alias) {
      return aliases.get(alias) ?? null;
    },
    async bindRelation(relation, createdAt) {
      const duplicate = relations.some(
        (entry) =>
          entry.conceptId === relation.conceptId &&
          entry.relatedConceptId === relation.relatedConceptId &&
          entry.relation === relation.relation,
      );
      if (!duplicate) relations.push({ ...relation, createdAt });
    },
    async listRelated(conceptId) {
      return relations
        .filter((entry) => entry.conceptId === conceptId)
        .map((entry) => ({ ...entry }));
    },
    async bindConceptSourceUnit(conceptId, sourceUnitId) {
      let set = participations.get(sourceUnitId);
      if (!set) {
        set = new Set();
        participations.set(sourceUnitId, set);
      }
      set.add(conceptId);
    },
    async listConceptsForSourceUnit(sourceUnitId) {
      const set = participations.get(sourceUnitId);
      return set ? [...set].sort() : [];
    },
    async listSourceUnitsForConcept(conceptId) {
      const units: string[] = [];
      for (const [sourceUnitId, conceptIds] of participations) {
        if (conceptIds.has(conceptId)) units.push(sourceUnitId);
      }
      return units.sort();
    },
    async listConcepts() {
      return [...concepts.values()]
        .sort((a, b) => a.createdAt - b.createdAt || a.conceptId.localeCompare(b.conceptId))
        .map((entry) => ({ ...entry }));
    },
  };
}
