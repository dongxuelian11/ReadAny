# PR-013 Current-Instant Learner Read Model State Ledger

Last updated: 2026-09-05 (Asia/Shanghai)

## Immutable task authority

- Objective: close review item #4 — every Goal/Curriculum/Agent decision and
  every panel display reads learner state AS OF NOW (persisted BKT projection +
  FSRS retrievability recomputed at the read instant), never the stale
  write-time persisted status.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md` (review verdicts +
  locked decisions 2026-09-05).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr013-learner-read-model`, created normally from exact `origin/main` `4e506437` (merge commit of PR #13).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No UI component changes: the LearnerPanel status chips and due list consume
  the same `ConceptMastery` shapes as before; this PR only makes the values
  they receive current. No i18n changes.
- No write-path changes: `evaluateConceptMastery` (persisting recompute) is
  unchanged and still available for explicit write-path use.
- No BKT/FSRS math changes, no evidence-trust weighting (PR-014), no concept
  identity (PR-015), no cross-book changes (PR-017), no Book Skill changes
  (PR-018).

## Design decisions (2026-09-05)

- `learner/read-model.ts`: `currentConceptMastery({row, card, now})` (pure:
  persisted BKT row + FSRS retrievability at `now` → derived status) and
  `getLearnerStateAt(deps, conceptIds)` (bulk; minimal `LearnerReadDeps` =
  clock+mastery+reviews so every engine's deps satisfy it structurally).
  Strictly read-only — reads never rewrite the projection (no updatedAt churn,
  no write-lock contention from read paths).
- Rewired consumers: `queries.listDueReviewConcepts` (due list status now
  computed at the query timestamp), `teaching-engine.getStepLearnerState`,
  app `overview.getBookMasteryOverview` (mastery-tab status chips become live),
  app `goal-trigger.getCurriculumForGoal` (gap classification sees forgetting).
- Rationale for read-only: the stale-status bug is a display/decision bug;
  writing from read paths would churn rows and fight the PR-012 write lock.
  The persisted row keeps its write-time semantics (see read-model test:
  90-day decay reads needs_review while the persisted row still says stable).

## UI skill truth

- Not applicable: no user-facing UI change in this PR (existing chips now
  receive current values; no layout/motion/visual change).

## Git and authority truth

- Base: `origin/main` `4e506437`.
- Branch `feat/pr013-learner-read-model` created normally from that exact base; initial HEAD `4e506437`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/14 (base origin/main 4e506437).

## Test truth

- New: `read-model.test.ts` (5 tests: unseen → null; fresh → stable with high
  retention; 90-day decay → needs_review at read time while the persisted row
  is untouched and still says stable; placement-style row without an FSRS card
  → derived from mastery alone; order preservation with duplicates).
- Full core suite: `PASS` — 92 files / 708 tests (was 91/703; +1 file / +5 tests).
- App tsc + vite production build: `PASS` (32.5s).
- Biome on touched files: `PASS` after `biome check --write`.
- `getMasteryForConcepts` left as the raw store join (mastery numbers do not
  decay); all status consumers now go through the read model.

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-05 (pre-merge)

- Implementation complete; local gates green: core 92/708 PASS, app build
  PASS. Authoritative result is exact-head GitHub CI.
- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #14 (no squash/rebase). Post-merge: PR-014
  evidence admission authority per `docs/ROADMAP_PR012_PLUS.md`.
