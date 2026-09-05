# PR-015 Global Concept Identity Seam (V1) State Ledger

Last updated: 2026-09-05 (Asia/Shanghai)

## Immutable task authority

- Objective: close review item #2 (+ the #6 Goal V2 seam) as a V1 SEAM per the
  user decision of 2026-09-05 — establish the global concept identity registry
  (concepts, aliases, source-unit bindings, relations) and make the legacy
  `readany:book:<bookId>:chapter:<n>` id an explicit SOURCE-UNIT identity, with
  lazy registration at the natural write points. NO cross-book merging, NO LLM
  concept extraction, NO behavior change for existing consumers.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md` (review verdicts +
  locked decisions 2026-09-05).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr015-concept-identity`, created normally from exact `origin/main` `bbbfb1dc` (merge commit of PR #15).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No canonical concept ids minted, no alias producers, no relation producers,
  no cross-book concept merging (all V2; the store APIs exist and are tested).
- No changes to evidence/mastery/goal/teaching/placement row shapes or ids —
  V1 is identity-preserving: a registered chapter concept's id IS its
  source-unit id.
- No UI, no i18n.

## Design decisions (2026-09-05)

- `learner/concept-identity.ts`: `sourceUnitId` / `parseChapterSourceUnit`
  (greedy book-id match), `ConceptIdentityStore` (registerConcept idempotent
  first-record-wins; bindSourceUnit/bindAlias REPLACE = the documented V2
  migration/rebind path; bindRelation/listRelated schema seam), and
  `ensureChapterConceptIdentity` (resolve-or-register, returns the concept id;
  V1 keeps concept id == source-unit id so every existing row stays valid).
- Four additive tables in `db-core.ts`: `learner_concepts`,
  `learner_concept_aliases`, `learner_source_units`,
  `learner_concept_relations` (PK (concept, related, relation)); all CREATE IF
  NOT EXISTS, no migrations needed for existing installs.
- `SqliteConceptIdentityStore` added to `createSqliteLearnerStores` (`.identity`)
  + in-memory reference store for tests.
- Registration wired at the four natural write points (all idempotent, no
  learner write lock needed — independent tables, no read-modify-write):
  quiz evidence recording (`trigger.recordQuizEvidence` — the most common
  path, covers learners who never create goals), goal start
  (`goal-trigger.startGoalForBook`), placement start
  (`placement-trigger.startBookPlacement`, capped pool), and the mastery
  overview (`overview.getBookMasteryOverview`). Local chapter helpers now
  carry `chapterIndex` explicitly instead of re-parsing ids.

## UI skill truth

- Not applicable: no user-facing UI in this PR.

## Git and authority truth

- Base: `origin/main` `bbbfb1dc`.
- Branch `feat/pr015-concept-identity` created normally from that exact base; initial HEAD `bbbfb1dc`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/16 (base origin/main bbbfb1dc).

## Test truth

- New: `concept-identity.test.ts` (4 tests: source-unit round-trip incl.
  greedy book ids with separators + foreign shapes → null; lazy registration
  idempotency with stable id and first-record-wins; source-unit REBIND to a
  canonical id + alias resolution (the V2 migration path); relation seam
  write/list with duplicate no-op).
- Full core suite: `PASS` — 93 files / 718 tests (was 92/714; +1 file / +4 tests).
- App tsc + vite production build: `PASS` (45.0s; includes the widened
  `createLearnerEngineDeps` return type `LearnerEngineDeps & { identity }`).
- Biome on touched files: `PASS` after `biome check --write`.

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-05 (pre-merge)

- Implementation complete; local gates green: core 93/718 PASS, app build
  PASS. Authoritative result is exact-head GitHub CI.
- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #16 (no squash/rebase). Post-merge: PR-016
  Learning Workspace UI (the big feature — start a fresh session and read
  `docs/ROADMAP_PR012_PLUS.md` + this ledger), then PR-017 grounded report
  contract, PR-018 Book Skill cache correctness.
