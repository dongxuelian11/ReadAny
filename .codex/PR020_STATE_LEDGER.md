# PR-020 Cross-book Ask Persistence & History State Ledger

Last updated: 2026-09-06 (Asia/Shanghai)

## Immutable task authority

- Objective: implement the recorded PR-011/017 post-merge candidate "answer
  persistence/history" — a shelf ask costs several LLM calls and produces a
  verified claim report, but the result used to vanish on a panel reset. The
  full CrossBookAnswer is now persisted and reopenable with its exact
  verified/unverified claim badges.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md`.
- UI skills: `apple-design` + `emil-design-eng` idioms applied (history is a
  plain designed list — click to reopen; no new motion; existing patterns
  reused). VISUAL_EVIDENCE: `NOT_RUN` (carried forward).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr020-ask-history`, created from exact `origin/main` `ab035a70` (merge commit of PR #19).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No changes to the ask engine/routing/verification (PR-017 contract untouched);
  no answer editing or re-run-on-click (reopen only — a "re-run" affordance is
  a separate candidate); no history search/filter UI.

## Design decisions (2026-09-06)

- New `book_skill_ask_history` table (id PK, question, answer_json, created_at)
  + index; `book-skill/ask-history.ts` provides `AskHistoryStore`
  (in-memory reference + `SqliteAskHistoryStore` over the shared IDatabase,
  runWithDbRetry-guarded).
- Retention: keep the newest `ASK_HISTORY_RETENTION` (50) rows — the trim runs
  inside `save` on BOTH adapters (in-memory initially lacked it; caught by the
  retention test before merge).
- App wiring: `askTheShelfAndSave` persists the answer and returns the
  refreshed history; `getAskHistory(limit)` reads newest-first. The panel
  loads history on mount (it is shelf-wide, reloaded after every BOOK_CHANGED
  reset), and `ASK_HISTORY_READY` fills the reducer. A history row click
  dispatches ASK_READY with the stored answer — the UI re-renders the exact
  verified/unverified badges. Re-saving replaces by explicit id (idempotent).
- i18n: `bookSkill.ask.history` (en/zh/zh-TW).

## UI skill truth

- `apple-design` + `emil-design-eng` idioms; VISUAL_EVIDENCE: `NOT_RUN`
  (carried forward).

## Git and authority truth

- Base: `origin/main` `ab035a70`.
- Branch `feat/pr020-ask-history` created from that exact base; initial HEAD `ab035a70`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/20 (base origin/main ab035a70).

## Test truth

- New `ask-history.test.ts` (4): newest-first ordering + limit; idempotent
  re-save by id; retention trim keeps newest (in-memory — caught the missing
  trim); sqlite adapter round-trip with binding verification (INSERT params +
  ORDER BY check).
- Reducer: ASK_HISTORY_READY fill + BOOK_CHANGED reset (extended ask walk test).
- Full core suite: `PASS` — 94 files / 733 tests (was 93/729; +1 file / +4 tests).
- App tsc + vite production build: `PASS` (33.4s).
- Biome on touched files: `PASS`.

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-06 (pre-merge)

- Implementation complete; local gates green: core 94/733 PASS, app build
  PASS. Authoritative result is exact-head GitHub CI.
- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #20 (no squash/rebase). Remaining recorded
  candidates: VISUAL_EVIDENCE pass, curriculum reason localization,
  concept-identity V2, ask re-run affordance.
