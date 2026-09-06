# PR-022 Ask Re-run Affordance State Ledger

Last updated: 2026-09-06 (Asia/Shanghai)

## Immutable task authority

- Objective: close the recorded carry-forward "ask re-run affordance" — a
  displayed shelf answer (fresh or reopened from history) now offers
  "Ask again", re-running the same question through the normal flow (fresh
  routing, fresh verification, NEW history row — the old report is never
  overwritten).
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md`.
- UI skills: `apple-design` + `emil-design-eng` idioms (one outline button on
  an existing designed surface; no motion). VISUAL_EVIDENCE: `NOT_RUN`
  (carried forward).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr022-ask-rerun`, created from exact `origin/main` `4b1e0ad0` (merge commit of PR #21).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No engine/routing/verification changes; no history deletion UI; the re-run
  goes through the exact production path (askTheShelfAndSave) — no shortcut.

## Design decisions (2026-09-06)

- One outline button under the ready answer: `onAsk(state.askAnswer.question)`
  → the normal ASK_START → askTheShelfAndSave → ASK_READY + ASK_HISTORY_READY
  flow. The previous report is replaced in the display but preserved in
  history (append-only by construction).
- i18n: `bookSkill.ask.rerun` (en "Ask again" / zh "重新问一次" / zh-TW
  "重新問一次").

## UI skill truth

- `apple-design` + `emil-design-eng` idioms; VISUAL_EVIDENCE: `NOT_RUN`
  (carried forward).

## Git and authority truth

- Base: `origin/main` `4b1e0ad0`.
- Branch `feat/pr022-ask-rerun` created from that exact base; initial HEAD `4b1e0ad0`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/22 (base origin/main 4b1e0ad0).

## Test truth

- App tsc + vite production build: `PASS` (33.6s). No core changes (i18n JSON
  + one guarded JSX handler). Biome on the touched file reports only the
  documented local CRLF worktree artifact (autocrlf=true checkout); git
  normalizes on commit and CI is unaffected.
- Authoritative gates: exact-head GitHub CI (four required blocking checks).

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-06 (pre-merge)

- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #22 (no squash/rebase). Remaining recorded
  candidates: VISUAL_EVIDENCE pass (live app required), concept-identity V2.
