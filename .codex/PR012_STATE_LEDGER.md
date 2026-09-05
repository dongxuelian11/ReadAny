# PR-012 Learner Transaction & Idempotency State Ledger

Last updated: 2026-09-05 (Asia/Shanghai)

## Immutable task authority

- Objective: close review item #1 (learning transaction / command journal) and
  the durable-queue half of item #8, right-sized for a single-user local-first
  app — make every learner mutation serialized against lost updates, make quiz
  evidence idempotent, and make UI-triggered evidence durable (survive a crash
  between judgement and apply) without introducing event-sourcing machinery.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md` (review verdicts +
  locked decisions 2026-09-05; mainline order = hybrid, decided with the user).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr012-learner-transaction`, created normally from exact `origin/main` `79c9e2a8` (merge commit of PR #12).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.
- Repo authority note: `main` is now protected by ruleset 22335539 (PR + four
  required blocking checks + no force push/deletion, no bypass actors). This
  PR is the first created and merged under that ruleset.

## Frozen prohibited scope

- No UI changes beyond the two wiring lines this slice requires (LearningPanel
  passes the judged question to `recordQuizEvidence`; App.tsx fires the startup
  outbox replay). No new user-facing surfaces, no i18n changes.
- No schema changes to existing tables; only the new `learner_evidence_outbox`
  table (CREATE IF NOT EXISTS, additive).
- No BKT/FSRS math changes, no evidence-trust weighting (that is PR-014), no
  concept identity work (PR-015), no cross-book changes (PR-017).
- No SQLite BEGIN/COMMIT attempts: the `IDatabase` abstraction (plugin-sql /
  expo-sqlite / better-sqlite3) cannot guarantee transaction scope across
  async adapter calls, so atomicity is provided by the in-process write lock +
  evidence-first durable append instead (documented below).

## Design decisions (2026-09-05)

- **Learner write lock** (`learner/write-lock.ts`): one module-global async
  mutex; only leaf mutation entry points take it, and it is not reentrant.
  Holders: `applyEvidenceEvent`, `evaluateConceptMastery`,
  `putGoalWithSupersession`, `startTeachingSession`, `startPlacementSession`,
  `finalizePlacement`. Verified non-nesting: answer flows call
  `applyEvidenceEvent` without holding the lock themselves; finalizePlacement
  appends evidence directly. The db write queue serializes individual
  statements only — the lock is what makes the whole read-modify-write cycle
  atomic in-process, which is a complete mutual-exclusion boundary for a
  single-user local app.
- **Deterministic quiz evidence id** (`evidence-mapping.ts`):
  `readany:quiz:<bookId>:ch<chapter>:<slot>:<djb2(question type|text|options)>`.
  Stable across retries and replays; distinct for distinct question content.
  Documented semantics: two sessions generating the identical question text
  for the same chapter slot are treated as the same evidence. The question
  parameter is REQUIRED (fail-closed) — `recordQuizEvidence` now passes the
  judged question from LearningPanel.
- **Durable evidence outbox** (`learner/outbox.ts` + `learner_evidence_outbox`
  table + `SqliteEvidenceOutboxStore`): enqueue-first (the event JSON is
  persisted with its id already pinned — a replay can never mint a fresh
  random id and double-apply), then apply through the engine, then mark done.
  `drainEvidenceOutbox` treats `DuplicateEvidenceIdError` as already-applied
  (the ledger is authoritative after a crash between apply and mark), records
  attempts for other failures, and skips rows past `MAX_OUTBOX_ATTEMPTS` (8)
  so one poison row cannot wedge the queue. In-memory implementation mirrors
  the reference-store pattern for tests.
- **App wiring**: `recordQuizEvidence` is now durable-first (await the local
  enqueue, then apply; on duplicate return the stored mastery row); App.tsx
  fires a fire-and-forget startup replay of pending rows.
- **Crash-recovery story (journal semantics, no framework)**: the append-only
  evidence ledger is the journal; mastery/card rows are projections. The
  outbox covers the enqueue→apply gap; replay dedupe covers the
  apply→mark-done gap.

## UI skill truth

- Not applicable: no user-facing UI or motion in this PR (two wiring lines
  only, no visual change).

## Git and authority truth

- Base: `origin/main` `79c9e2a8`.
- Branch `feat/pr012-learner-transaction` created normally from that exact base; initial HEAD `79c9e2a8`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/13 (base origin/main 79c9e2a8).
- `main` ruleset 22335539 active: required checks are the four blocking gates
  ("Blocking gate - quality", "Blocking gate - Windows NSIS production build",
  "Blocking gate - pinned Read-Box real integration", "Blocking gate - pinned
  TKG real integration"); the non-gating debt job is intentionally NOT
  required. No squash: ordinary merge commit only.

## Test truth

- New tests: `write-lock.test.ts` (3: serialization order, return value,
  no-wedge-after-failure), `outbox.test.ts` (5: id pinning, drain happy path,
  duplicate-as-applied, failure-then-recovery, poison-row cap with a healthy
  row behind it), `engine.test.ts` +1 (5 concurrent events on one concept →
  evidence count 5 AND mastery after 5 BKT updates — the lost-update
  regression), `goal.test.ts` +1 (concurrent activations → exactly one active
  goal), `evidence-mapping.test.ts` updated for the required question param +
  deterministic id assertions (+1 net), `sqlite-stores.test.ts` +1 (outbox
  adapter binding/round-trip with pinned JSON id).
- Full core suite: `PASS` — 91 files / 703 tests (was 89/691; +2 files / +12 tests).
- Expo suite: `PASS` — 2 files / 3 tests.
- App tsc + vite production build: `PASS` (36.4s; pre-existing chunk warnings only).
- Biome on touched files: `PASS` after `biome check --write` (import ordering).
  Note: Biome flags CRLF on untouched files locally (core.autocrlf=true
  worktree artifact); git normalizes on commit, CI is unaffected.
- Real-device crash-replay E2E: `NOT_RUN` (covered deterministically by the
  outbox duplicate-replay tests instead).

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-05 (pre-merge)

- Implementation complete; local gates green: core 91/703 PASS, expo PASS,
  app build PASS. Authoritative result is exact-head GitHub CI on this PR
  (first PR under the new ruleset: merge stays blocked until all four
  blocking gates pass on the head SHA).
- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #13 (no squash/rebase). Post-merge: PR-013
  current-instant learner read model per `docs/ROADMAP_PR012_PLUS.md`.
