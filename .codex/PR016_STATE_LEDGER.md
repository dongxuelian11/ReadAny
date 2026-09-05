# PR-016 Learning Workspace UI State Ledger

Last updated: 2026-09-06 (Asia/Shanghai)

## Immutable task authority

- Objective: close review item #7 (product convergence) — wire the complete
  Goal → Curriculum → Teaching → Evidence → Mastery loop into the Reader's
  Learner panel as a unified workspace, and close the PR-014 tail (the user
  confirmation affordance for llm_judged quiz verdicts).
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md` (review verdicts +
  locked decisions). Workflow discipline: superpowers executing-plans +
  verification-before-completion (plugin installed by the user 2026-09-06).
- UI skills used (per `docs/UI_UX_GOVERNANCE.md`): `apple-design` and
  `emil-design-eng` — both SKILL.md files read in full before implementation;
  applied: designed loading/empty/creating/ready/error states for every flow,
  no decorative motion (color/border transitions only, matching the existing
  panel idiom), information density preserved, aria-live phase announcements
  mirroring the PlacementTab pattern, `prefers-reduced-motion` respected (no
  transform motion introduced at all). `review-animations` not applicable (no
  motion added).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr016-learning-workspace`, created from exact `origin/main` `10abeee8` (merge commit of PR #16).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No cross-book ask UI (rides with PR-017, built on the structured report
  contract), no placement/mastery/review tab redesigns, no ReaderView changes
  (the aside's props are unchanged), no new dependencies, no theme/visual
  language changes beyond the new tab.
- Curriculum step `reason` strings are core-generated English and are NOT
  rendered in this PR (localization of core reason text needs a core i18n
  refactor — carried as a non-blocking note; the UI shows title + depth +
  learn/review chips instead).

## Design decisions (2026-09-06)

- **Goal tab first**: `LearnerTab` gains "goal" and becomes the DEFAULT tab —
  the workspace entry point (placement/mastery/review keep their behaviour).
- **Core reducer, not ad-hoc component state** (repo ethos: deterministic
  panel state, testable): `LearnerGoalPhase` (idle/loading/empty/creating/
  ready/error) + `LearnerTeachingPhase` (idle/starting/delivering/active/
  answering/completed/error) with actions GOAL_* / TEACHING_*;
  `currentTeachingStepView` exposes the step awaiting an answer.
  Bug caught during self-review: TEACHING_DELIVERED must clear
  `lastStepAnswer`, otherwise the previous step's verdict overlays the newly
  delivered step (regression-tested).
- **App wiring**: `getGoalWorkspace(book)` composes active goal + curriculum
  (PR-013 read model) + this book's resumable active teaching session;
  `confirmQuizEvidence` appends a `MANUAL`/`user_confirmed` event with
  deterministic id `<quizId>:confirmed` — the original llm_judged event keeps
  its 0.4 weight; confirmation ADDS the missing trust (append-only ledger is
  never rewritten). Both quiz evidence paths keep PR-012 durable-first
  semantics.
- **Teaching flow UX**: session start auto-delivers step 1 (idempotent per
  step — re-renders never re-bill the LLM); after each answer the next step
  is delivered on "next" (deliver is idempotent, safe on retry); a resumed
  session whose current step lacks content shows an explicit "generate"
  button instead of auto-firing (fail-closed, no hidden LLM spend);
  completion offers mastery view + re-teach (supersession is core-guaranteed).
- **Quiz verdict confirmation UI** (LearningPanel): after judging, an outline
  "I confirm this verdict" action records the confirmed evidence; per-judgement
  presentation state, reset on the next answer; failure surfaces inline.
- **i18n**: en/zh/zh-TW carry the new keys (learner string namespace
  convention since PR-001); ja/ko/fr/es reader.json never had
  learning/learnerPanel sections and fall back to `fallbackLng: "en"` —
  consistent with every previous learner PR.

## UI skill truth

- `apple-design`: used (state design, restraint, aria-live, density, reduced
  motion by construction — zero transform motion).
- `emil-design-eng`: used (animation decision framework → no animation for
  frequently-seen phase text; color-only transitions; existing Button press
  feedback reused).
- `review-animations`: not applicable (no motion added).
- VISUAL_EVIDENCE: `NOT_RUN` (real screenshot pass requires a live Tauri
  session with a configured LLM endpoint; recorded honestly per the PR-007
  precedent — non-blocking carry-forward).

## Git and authority truth

- Base: `origin/main` `10abeee8`.
- Branch `feat/pr016-learning-workspace` created from that exact base; first
  commit `cb110e5d` (docs: open slice — ROADMAP merge-truth for PR #16).
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/17 (base origin/main 10abeee8).

## Test truth

- Core: `PASS` — 93 files / 722 tests (+4): goal default tab + book-change
  reset; goal flow empty→creating→created with teaching reset; teaching flow
  start→delivered→answered→next (verdict cleared on re-delivery)→completed
  with no live step view; resume-through-GOAL_READY + teaching-error
  isolation (goal untouched).
- App tsc + vite production build: `PASS` (33.8s).
- Biome on touched files: `PASS` after `biome check --write`.
- Real-LLM goal→teaching E2E: `NOT_RUN` (deterministic reducer tests cover
  state machine; the triggers were already engine-tested in PR-008/009).

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-06 (pre-merge)

- Implementation complete; local gates green: core 93/722 PASS, app build
  PASS. Authoritative result is exact-head GitHub CI.
- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #17 (no squash/rebase). Post-merge: PR-017
  grounded report contract + cross-book ask UI + revive semanticRouting;
  PR-018 Book Skill cache correctness. VISUAL_EVIDENCE pass is a non-blocking
  carry-forward for the next UI-touching PR.
