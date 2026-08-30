# PR-005 Learner Persistence & Evidence Wiring State Ledger

Last updated: 2026-08-30 (Asia/Shanghai)

## Immutable task authority

- Objective: wire the PR-004 deterministic learner core into the app's real persistence and the existing quiz flow — SQLite store adapters over the shared IDatabase surface (backend-agnostic: plugin-sql / expo-sqlite / better-sqlite3), learner tables in the shared `initDatabase()`, and the PR-001 Read-Box quiz judgement recorded as learner evidence through a fire-and-forget app adapter. Chapter-scoped interim concept identity, documented.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr005-learner-persistence`, created normally from exact `origin/main` `b92281125049764747f2f9e4d52e44af0c28f181` (merge commit of PR #5).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No new user-facing UI, no i18n changes, no panel layout changes (the LearningPanel change is invisible wiring: quiz UX unchanged; a persistence failure logs and never surfaces into the panel's error state). The mastery/review view and placement CAT are PR-006 under the apple-design / emil-design-eng gate.
- No misconception/transfer logic; no LLM calls; no settings flags.
- No changes to the Read-Box slice behavior (digest/QA/quiz contracts untouched), the Book Skill slice, or the Rust/Tauri layer (schema stays TS-side per the repo's mirrored-ensure convention; Rust never touches learner tables).
- No new dependencies.
- No cleanup of unrelated upstream lint or CLI debt.

## Design decisions (exploration-driven, 2026-08-30)

- Schema: added to `packages/core/src/db/db-core.ts` `initDatabase()` — the operative cross-host creator (desktop/mobile/CLI all share it). The `schema.rs` "stay in sync" note applies to Rust-touched tables only; learner tables are TS-only writes. The dead `schema_migrations` runner in `packages/app/src/lib/db/migrations.ts` was left alone. Learner tables deliberately NOT added to the Migration-7 sync list (learner state is device-local Authority for now; sync is a future decision).
- Adapter: `packages/core/src/learner/sqlite-stores.ts` implements the three PR-004 store interfaces over `getDB()` + `runWithDbRetry`; accepts an optional injected `IDatabase` for tests. Enforced invariants: evidence duplicate ids → `DuplicateEvidenceIdError` via the primary key (UNIQUE-constraint error mapping); `INSERT OR REPLACE` only for mastery rows and review cards (current state), plain INSERT for the two append-only tables; review logs UNIQUE(concept_id, review) for idempotent replays; counts via row length (portable across sqlite backends).
- Evidence mapping: `packages/core/src/learner/evidence-mapping.ts` — `quizJudgementToEvidence(judgement, source)` maps a `LearningQuizJudgement` + `LearningSourceRef` to an evidence input. Interim concept identity: `readany:book:<bookId>:chapter:<chapterIndex>` (chapter-scoped because the Read-Box quiz judges a chapter and carries no concept tags; the format makes the scope explicit in every row until the Book Skill/knowledge graph provides real concept ids). confidence=1 (deterministic Read-Box grading); result from judgement.correct; no timestamp/id in the mapping (the engine's injected clock and store own them).
- Wiring: `packages/app/src/lib/learner/trigger.ts` (`createLearnerEngineDeps` with the real clock + SQLite stores; `recordQuizEvidence`) and one fire-and-forget hook in `LearningPanel.handleAnswerQuiz` right after `QUIZ_JUDGED` — `void recordQuizEvidence(...).catch(console.error)`, following the `reading-session-store.stopSession` precedent; errors never enter the panel's ERROR state.
- Quiz answers without a question type use the BKT parameter defaults (0.2/0.1) — the Read-Box quiz does not expose question shapes; per-type evidence arrives with the placement/practice work.

## UI skill truth

- Not applicable: no user-visible UI or motion changed (invisible wiring only).

## Git and authority truth

- Base: `origin/main` `b92281125049764747f2f9e4d52e44af0c28f181`.
- Branch `feat/pr005-learner-persistence` created normally from that exact base; initial HEAD `b92281125049764747f2f9e4d52e44af0c28f181`.
- Product PR: `NOT_CREATED`.

## Test truth

- Learner module: `PASS` — 5 files / 41 tests (30 from PR-004 + 11 new: evidence mapping incl. interim concept-id format and no-timestamp invariant; SQLite adapter statement/param/row-mapping coverage incl. UNIQUE→DuplicateEvidenceIdError mapping, fail-closed propagation of non-constraint errors, null-preserving mastery round-trip, injected-database path).
- Full core suite: `PASS` — 82 files / 637 tests (was 80/626; +2 files / +11 tests are the new evidence-mapping and sqlite-stores tests).
- Biome (learner module + db-core + LearningPanel + app learner trigger): `PASS` (clean).
- App `tsc --noEmit`: `PASS` — and it caught two latent PR-004 defects that vitest transforms cannot (vitest is not a cross-file typechecker, and PR-004's app typecheck never traversed the new core module because nothing imported it yet): (1) `EvidenceQuestionType` was circularly imported between types.ts and bkt.ts without ever being exported — now defined and exported in types.ts; (2) `createLearnerScheduler` passed camelCase `requestRetention` into ts-fsrs's `generatorParameters`, which expects snake_case `request_retention` — the option was silently ignored and the default 0.9 was always used, so the PR-004 golden values (pinned at 0.9) remain valid; the parameter now actually applies.
- Existing gates (quality / NSIS / Read-Box / TKG): run unchanged; authoritative result on GitHub CI.
- Real DeepSeek E2E: `NOT_RUN` (no model calls in this PR).

## Blockers / partial truth

- None currently. Deferred by design to PR-006: mastery/review UI view (under apple-design / emil-design-eng), placement CAT, due-review surface, misconception/transfer components, learner-state sync decision.

## Final handoff snapshot — 2026-08-30 (pre-merge)

- Wiring complete: quiz judgement → `quizJudgementToEvidence` → `applyEvidenceEvent` → SQLite stores in readany.db; chapter-scoped interim concept identity `readany:book:<bookId>:chapter:<index>` documented in the mapping module and visible in every stored row; fire-and-forget semantics preserve the quiz UX (reading-session precedent).
- Next exact action: push, wait for exact-head blocking CI, independent acceptance, ordinary merge (no squash/rebase). Post-merge alignment: PR-006 scope (mastery/review UI view under the UI-skill gate, placement CAT, due-review surface) with the user before code.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and `docs/integrations/LEARNER_CORE_OSS_AUDIT_PR003.md`; inspect git status/branch/HEAD/remotes; reconcile with the GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
