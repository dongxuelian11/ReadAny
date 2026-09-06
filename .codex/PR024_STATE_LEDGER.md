# PR-024 Concept Graph V2 (Cross-book Concepts) State Ledger

Last updated: 2026-09-06 (Asia/Shanghai)

## Immutable task authority

- Objective: implement concept identity V2 per the approved 2026-09-06 plan —
  fold the Book Skill Tier-1 data (topic-index terms, concept-map framework
  nodes and edges) into the shared concept registry as REAL global concepts,
  with deterministic cross-book text merging, N:M chapter participation, and a
  read-only 跨书概念 panel section. ZERO LLM calls.
- Explicit non-goals (approved in plan, recorded for later): learner-state
  migration (evidence/mastery stay chapter-scoped practice records keyed by
  their source-unit ids — nothing here reads or writes them), semantic /
  cross-language merging, prerequisite-aware curriculum reordering (a future
  graph consumer).
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md`.
- UI skills: `apple-design` + `emil-design-eng` idioms (one read-only
  designed section: title, summary line, sorted list, empty state; no motion).
  VISUAL_EVIDENCE: `NOT_RUN` for this section (same live-capture method as
  PR-023 available for a follow-up).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr024-concept-graph-v2`, created from exact `origin/main` `3b6387ac` (merge commit of PR #23).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No changes to the Tier-1 generation prompts or pipeline; no learner
  engine/store changes; the V1 1:1 `learner_source_units` owner-binding API
  (`ensureChapterConceptIdentity` and friends) is untouched.

## Design decisions (2026-09-06)

- **Deterministic merge (v2.0)**: two names are the same concept iff their
  normalized text matches (trim + lowercase + collapsed whitespace). ids:
  `readany:concept:t:<djb2>` (topic terms) and `readany:concept:f:<djb2>`
  (framework nodes) — separate prefixes so granularities never conflate.
  displayName is first-seen-wins (registry upsert); every original term is
  kept as an alias.
- **N:M participation**: a chapter can belong to many topic concepts and a
  concept spans many chapters/books. New additive table
  `learner_concept_participations (concept_id, source_unit_id)` + store
  methods `bindConceptSourceUnit` (INSERT OR IGNORE — never overwrites,
  unlike the 1:1 owner binding) / `listConceptsForSourceUnit` / `listConcepts`.
  The V1 `learner_source_units` table stays the chapter's owner binding.
- **Relations**: concept-map edges resolve between the SAME book's framework
  concepts; `builds on`/`requires` → `prerequisite`, the other five relations
  → `related`. Unregistered endpoints are dropped with a warning.
- **Trigger/UI**: `buildConceptGraphForShelf()` enumerates the shelf through
  `loadExistingBookSkill` (PR-018 staleness-checked), folds Tier-1 into the
  registry, computes the cross-book list (concepts whose participations span
  ≥2 books), and dispatches `CONCEPT_GRAPH_READY` on panel open. The
  BookSkillPanel renders a read-only 跨书概念 section (total count + cross-book
  list sorted by coverage). Failures degrade silently to "no section".

## UI skill truth

- `apple-design` + `emil-design-eng` idioms (designed empty state, sorted
  list, no motion). VISUAL_EVIDENCE: `NOT_RUN` (live-capture follow-up).

## Git and authority truth

- Base: `origin/main` `3b6387ac`.
- Branch `feat/pr024-concept-graph-v2` created from that exact base; initial HEAD `3b6387ac`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/24 (base origin/main 3b6387ac).

## Test truth

- New `concept-graph.test.ts` (6): id derivation per kind + normalization;
  N:M chapter bindings (one chapter → many concepts); cross-book text merge
  (same id, first-name-wins, both books' bindings, crossBookConcepts output);
  edge→relation mapping incl. unregistered-endpoint drop; unknown
  book_number warning + binding skip (concept still registered); idempotent
  rebuild (concepts and relations byte-identical after a second run).
- Extended: concept-identity tests keep passing (N:M methods added to the
  store; 10 tests across the two files).
- Full core suite: `PASS` — 95 files / 739 tests (was 94/733; +1 file / +6 tests).
- App tsc + vite production build: `PASS` (33.8s).
- Biome on touched files: `PASS`.

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-06 (pre-merge)

- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #24 (no squash/rebase). This completes the
  review's item #2 at the approved V2 scope. Future candidates now live
  entirely in `docs/ROADMAP_PR012_PLUS.md` (learner-state projection onto
  canonical concepts, semantic merging, prerequisite-aware curriculum).
