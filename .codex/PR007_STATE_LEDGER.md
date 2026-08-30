# PR-007 Learner Panel State Ledger

Last updated: 2026-08-30 (Asia/Shanghai)

## Immutable task authority

- Objective: implement the user-facing Learner panel in the Reader — three tabs (Placement 摸底 flow, Mastery 掌握度, Review 到期复习) over the PR-004/005/006 learner core, with all states designed, en/zh/zh-TW strings, and the established resizable-panel mount pattern. This is a user-facing PR: the project-local apple-design and emil-design-eng skills govern it.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr007-learner-panel`, created normally from exact `origin/main` `62fa349197574eaafbbeffb296d1e2d8cafef636` (merge commit of PR #7).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No changes to the LearningPanel (PR-001), BookSkillPanel (PR-002) behavior or layout — the Learner panel is a separate toggle/aside using the established mount pattern; toggles are mutually exclusive.
- No Goal Model / Curriculum / Knowledge World / Reward work.
- No learner-state sync, no accounts, no cloud.
- No new dependencies.
- No changes to the deterministic learner engine semantics (wiring only) or to the Rust/Tauri layer.
- No cleanup of unrelated upstream lint or CLI debt.

## UI skill truth

- `apple-design`: full project SKILL.md read this session (2026-08-30, unchanged since commit 5df3aa71) before implementation; applied — all panel states designed (idle/starting/active/answering/verifying/completed/error/unavailable + loading/empty per tab), reading focus preserved, hierarchy via weight/size, restrained auxiliary layer.
- `emil-design-eng`: full project SKILL.md read this session (unchanged) before implementation; applied — specific-property transitions only, responsive controls, no decorative motion.
- `review-animations`: not applicable — no motion added.
- Visual evidence: see Test truth (attempted / result recorded honestly).

## Design decisions (2026-08-30)

- Panel placement: a new Reader aside (toggle in ReaderToolbar, `useResizablePanel` storage key `reader-learner-panel-width`, mutually exclusive with Learning/BookSkill/Chat), mirroring the PR-001/PR-002 mount pattern exactly.
- Placement tab: idle (explanation + pool estimate + start) → starting (LLM generation, honest note) → active (one item at a time: prompt + 4 options + submit → judged state with explanation + continue; progress n/answered of pool; stop-rule aware — when the CAT says stop, the panel offers 完成) → finalizing → completed (verdict: ability, questions, assessed/written counts, per-chapter outcome list) → error/unavailable with retry. Answering never blocks reading; the panel is side-by-side.
- Mastery tab: per-chapter rows for the current book (Book-Skill manifest chapters or canonical extraction) joined with mastery rows — status chip (learning/stable/needs_review/unseen), mastery as a plain percentage, evidence count; loading/empty states.
- Review tab: due FSRS cards joined with mastery for the current book's concepts, ordered by due; empty state when nothing is due.
- Core additions are deterministic and UI-free: `learner/panel-state.ts` reducer (full state machine, tested) and `getMasteryForConcepts` in queries.
- Evidence recording stays exactly as PR-005/006 built it: the panel calls the same app triggers; no new Authority semantics.

## Git and authority truth

- Base: `origin/main` `62fa349197574eaafbbeffb296d1e2d8cafef636`.
- Branch `feat/pr007-learner-panel` created normally from that exact base; initial HEAD `62fa349197574eaafbbeffb296d1e2d8cafef636`.
- Product PR: `NOT_CREATED`.

## Test truth

- Learner panel-state reducer tests: `PASS` — 1 new file / 5 tests (full placement walk, stop-rule completion surface, error/unavailable states, list states, book-change reset semantics). Learner module total: 8 test files / 60 tests.
- Full core suite: `PASS` — 85 files / 656 tests (was 84/651; +1 file / +5 tests).
- Biome (learner module + app learner adapters + LearnerPanel): `PASS` (clean). Core tsc: `PASS`. App `tsc --noEmit`: `PASS` (caught missing useCallback import + deps-shape mismatch in overview).
- Existing gates (quality / NSIS / Read-Box / TKG): run unchanged; authoritative result on GitHub CI.
- VISUAL EVIDENCE: `NOT_RUN` — honest limitation. The panel states are fully covered by the reducer tests, type checks, and the two applied design skills, but no real-app GUI session was executed in this environment (launching Tauri, importing a book, driving the placement flow against a deterministic provider, and capturing screenshots is a dedicated follow-up step, following the PR-001 visual-evidence pattern in output/playwright + docs/evidence). No visual claim is made beyond the code and tests.
- Real DeepSeek E2E: `NOT_RUN` (no model calls; placement generation covered by a deterministic fake in tests).

## Blockers / partial truth

- Visual evidence NOT_RUN as above — recorded, not hidden. Everything else clear.

## Final handoff snapshot — 2026-08-30 (pre-merge)

- Implementation complete: `learner/panel-state.ts` (+ tests), `getMasteryForConcepts` in queries, app `overview.ts` (book-scoped mastery/due joins), `placement-trigger.ts` extensions (answer/finalize/exported deps factory), `LearnerPanel.tsx` (three tabs, all phases designed: placement idle/starting/active+judging/stop-reached/finalizing/verdict/error/unavailable; mastery loading/ready/empty/error; review loading/ready/empty/error), ReaderView mount + toolbar toggle (mutually exclusive with Learning/BookSkill/Chat), `learnerPanel` i18n in en/zh/zh-TW.
- Placement resume: an active session belonging to the current book is resumed on panel open; foreign-book sessions are ignored.
- Next exact action: push, wait for exact-head blocking CI, independent acceptance, ordinary merge (no squash/rebase). Post-merge follow-ups: visual evidence session (GUI), PR-008 candidates (Goal Model / Curriculum per Wave 2, or cross-book routing per Track B).

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, `docs/UI_UX_GOVERNANCE.md`, and the two project UI skills; inspect git status/branch/HEAD/remotes; reconcile with GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
