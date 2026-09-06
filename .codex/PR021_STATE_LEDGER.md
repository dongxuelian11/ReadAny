# PR-021 Curriculum Reason Localization State Ledger

Last updated: 2026-09-06 (Asia/Shanghai)

## Immutable task authority

- Objective: close the recorded carry-forward "curriculum reason localization"
  (PR-016 non-blocking note) — the curriculum step's WHY (gap kind) is now
  carried structurally and rendered localized in the Learning Workspace, so
  the user sees not just WHAT to learn but WHY in their language.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md`.
- UI skills: `apple-design` + `emil-design-eng` idioms (a text-only change to
  an existing designed list; no motion, no layout change). VISUAL_EVIDENCE:
  `NOT_RUN` (carried forward).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr021-reason-localization`, created from exact `origin/main` `d1ba835c` (merge commit of PR #20).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No changes to gap classification or curriculum ordering (deterministic core
  untouched); `reason` (English reference text) is kept for backcompat — no
  consumer removed; no new locales beyond the established en/zh/zh-TW
  learner-namespace convention.

## Design decisions (2026-09-06)

- `CurriculumStep` gains `kind: GoalGapKind` — the reason text is fully
  determined by the gap kind, so the kind IS the localization key. The legacy
  English `reason` string stays untouched (tests and any future consumers).
- UI: the GoalTab curriculum list now renders
  `t(learnerPanel.goal.reason.<kind>) · t(learnerPanel.goal.depth.<depth>)`
  per step — previously only the depth was shown.
- i18n: `learnerPanel.goal.reason.{missing,partial,lapsed,satisfied}`
  (en/zh/zh-TW; satisfied included for completeness though buildCurriculum
  skips satisfied chapters today).

## UI skill truth

- `apple-design` + `emil-design-eng` idioms; VISUAL_EVIDENCE: `NOT_RUN`
  (carried forward).

## Git and authority truth

- Base: `origin/main` `d1ba835c`.
- Branch `feat/pr021-reason-localization` created from that exact base; initial HEAD `d1ba835c`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/21 (base origin/main d1ba835c).

## Test truth

- goal.test.ts: kind assertions added (["partial", "lapsed"] on the
  book-order test — the first assertion draft wrongly expected "missing";
  corrected against the actual classifyGap semantics before merge).
- Full core suite: `PASS` — 94 files / 733 tests.
- App tsc + vite production build: `PASS` (33.1s).
- Biome on touched files: `PASS`.

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-06 (pre-merge)

- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #21 (no squash/rebase). Remaining recorded
  candidates: VISUAL_EVIDENCE pass, concept-identity V2, ask re-run
  affordance.
