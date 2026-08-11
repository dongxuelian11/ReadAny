# PR-001 Read-Box Learning Slice State Ledger

Last updated: 2026-08-11 (Asia/Shanghai)

## Immutable task authority

- Objective: implement only the PR-001 Read-Box learning-agent vertical slice inside the existing ReadAny Reader: current-chapter digest, grounded QA, chapter quiz, and citations back to canonical ReadAny source.
- Authoritative prompt: `C:\Users\Administrator\Downloads\AI_READING_PR001_READBOX_LEARNING_SLICE_CODEX_PROMPT.md` (read fully as UTF-8).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Forbidden product PR target: `https://github.com/codedogQBY/ReadAny`.
- Required branch: `feat/pr001-readbox-learning-slice`.
- Frozen base full SHA: `3f527e89f3904681604d8d403b1d5064f91624d0`.
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- Read-Box repository: `https://github.com/wenhui426/read-box`.
- ReadAny remains book, Reader, source, UI, and AI-configuration Authority. Read-Box state may only be a rebuildable adapter/derived cache.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No PR-002 work.
- No DeepTutor, The Knowledge Guy, Gutendex, OpenTutor, pyBKT, FSRS, Learner Model, Goal Model, Curriculum Agent, Reward Engine, Visual Learning, video, web search, account, or cloud integration.
- No broad product rename, broad UI redesign, ReadAny RAG rewrite, ebook parser rewrite, parallel SQLite book reader, or replacement implementation of Read-Box.
- No cleanup of unrelated upstream lint or CLI debt.

## Git and authority truth

- Initial worktree was clean on `chore/pr000-open-source-baseline` at `ee7f2516fb2b808c21ae3cf0f78f4359c2e490cf`.
- `origin`: `https://github.com/dongxuelian11/ReadAny.git`.
- `upstream`: `https://github.com/codedogQBY/ReadAny.git`.
- Refreshed `origin/main`: `3f527e89f3904681604d8d403b1d5064f91624d0` (exact required PR-000 authority).
- Refreshed `upstream/main`: `3f8826c37391721289f4d6db47bacc0c73788572`.
- Upstream impact determination: `UPSTREAM_ADVANCED = FALSE`. `upstream/main` is an ancestor of `origin/main`; the origin-only commits/files are the accepted PR-000 baseline and do not represent unabsorbed upstream CLI/MCP/Core changes.
- Current branch: `feat/pr001-readbox-learning-slice`, created normally from exact `origin/main`.
- Current HEAD: `3f527e89f3904681604d8d403b1d5064f91624d0`.
- Product PR: `NOT_CREATED`.

## Integration decision and pin

- Read-Box exact full SHA: `15f766f19f1ab204535f1947983fa397540352c8` (current `main` resolved at audit time).
- Read-Box license truth: `BLOCKED/PARTIAL` — README declares MIT, but exact source contains no LICENSE/COPYING/NOTICE and GitHub repository metadata returns `license: null`.
- Chosen integration option: `Option A — native Read-Box API with a rebuildable per-chapter derived cache and canonical ReadAny mapping`.
- Rejected B: upstream agents hard-code their own database context, making an external-context shim more coupled.
- Rejected C: provider injection exists, but digest/QA/quiz still require upstream books/chapters database rows.
- Packaging/pinning mode: reproducible checkout pinned to the full SHA; no floating `main`, no whole-repository copy in the product tree.
- Self-contained Windows installer worker: `NOT_READY` until proven otherwise.

## UI skill truth

- `apple-design`: installed project-locally from `emilkowalski/skills`; full project `SKILL.md` read before UI implementation.
- `emil-design-eng`: installed project-locally from `emilkowalski/skills`; full project `SKILL.md` read before UI implementation.
- `review-animations`: only required if this PR changes motion/animation; no motion change authorized or implemented yet.
- Visual evidence: `NOT_RUN`.

## Changed files

- `.codex/PR001_STATE_LEDGER.md` — created as the mandatory compaction-recovery authority.
- `.agents/skills/apple-design/SKILL.md`, `.agents/skills/emil-design-eng/SKILL.md`, `skills-lock.json` — required project-scoped UI skills installed through the existing skill mechanism.
- `docs/integrations/READ_BOX_PR001.md` — bounded OSS audit and Option A decision.
- `INTEGRATIONS.lock.json` — exact Read-Box ref and honest partial/license state.
- `.gitignore` — excludes the reproducible local checkout and derived worker cache.

## Completed

- PASS — read the complete authoritative PR-001 prompt as UTF-8.
- PASS — read PR-000 project charter, UI/UX governance, and terminal ledger.
- PASS — refreshed and verified origin/upstream refs and identities.
- PASS — verified the initial worktree was clean and explainable.
- PASS — created the required branch from the exact accepted PR-000 main without history rewriting.
- PASS — audited the mandated ReadAny Core/CLI/MCP/Reader/source-navigation/AI-state paths and found reusable canonical access paths.
- PASS — resolved and cloned current Read-Box main at the exact full SHA and audited all mandated agents, routers, provider, database, Tauri lifecycle, packaging, and tests.
- PASS — verified the Read-Box repository lacks a license file and recorded the README-only MIT declaration as unverified rather than claiming a verified license.
- PASS — compared Options A/B/C from exact source and selected native API + rebuildable derived cache.
- PASS — installed and fully read the required project-level `apple-design` and `emil-design-eng` skills before UI implementation.

## Pending

- Implement the bounded vertical slice, tests, visual evidence, documentation, and integration registry update.
- Run real pinned Read-Box integration tests; run real DeepSeek E2E only if a local key exists, without exposing it.
- Run blocking quality and Windows NSIS gates; preserve known baseline debt truth.
- Review, commit, push, create the fork-internal product PR, and inspect exact-head CI.

## Test truth

- PR-001 automated tests: `NOT_RUN`.
- Pinned Read-Box real integration test: `NOT_RUN`.
- Real DeepSeek E2E: `NOT_RUN`.
- Blocking quality gate: `NOT_RUN`.
- Blocking Windows NSIS gate: `NOT_RUN`.

## Blockers / partial truth

- Read-Box license verification is BLOCKED: upstream README says MIT, but no license text/file exists at the pinned ref.
- Passage-level citation navigation: `NOT_RUN`; must remain `PARTIAL/BLOCKED` unless demonstrated.
- System `uv` dependency and worker packaging: `NOT_RUN`; must not be described as self-contained.

## Next exact action

Implement the pinned source acquisition/verification, worker supervisor, typed canonical bridge, native API adapter, and quiet Reader-side learning panel with deterministic tests.

## Recovery protocol

## Post-compaction recovery update — 2026-08-11

- PASS — reread the authoritative prompt, this ledger, `docs/PROJECT_CHARTER.md`, and `docs/UI_UX_GOVERNANCE.md`.
- PASS — reconciled branch/HEAD/log/diff/remotes: branch `feat/pr001-readbox-learning-slice`, pre-commit HEAD and `origin/main` both `3f527e89f3904681604d8d403b1d5064f91624d0`; `upstream/main` remains `3f8826c37391721289f4d6db47bacc0c73788572`.
- PASS — reverified local Read-Box checkout HEAD `15f766f19f1ab204535f1947983fa397540352c8` and live target-repository PR query returned no PR.
- Implemented since the earlier ledger snapshot: exact-pin acquisition scripts, loopback/dynamic-port Rust worker supervisor, canonical learning types/mapping/state tests, ReadAny-source adapter, native Read-Box client, Reader-side digest/QA/quiz/citation panel, full en/zh/zh-TW strings, real-integration test harness, and blocking Read-Box CI job.
- Actual tests: core `PASS` (76 files/571 tests); app production build `PASS`; targeted new-file Biome `PASS`; `cargo check` `PASS`; `cargo test readbox::tests` `PASS` (2); `git diff --check` `PASS`; real pinned Read-Box backend/import/digest/QA-SSE/quiz integration `PASS` with a local deterministic OpenAI-compatible provider.
- Whole-tree `cargo fmt --check` remains `FAIL` only on pre-existing unrelated schema/storage/sync/vector formatting; do not relabel it PASS.
- `REAL_DEEPSEEK_E2E = NOT_RUN` because no local key was present. Full blocking workflow is `PARTIAL`; Windows NSIS is `NOT_RUN`.
- `SELF_CONTAINED_WORKER_IN_INSTALLER = NOT_READY`; system/user `uv` local runtime is proven but is not a zero-dependency installer.
- UI evidence is `IN_PROGRESS` in the real Tauri app with the pinned worker. `apple-design` and `emil-design-eng` were installed/read and materially applied; no motion was added, so `review-animations` is not applicable.
- Temporary evidence-only `.codex/tauri.pr001.visual.json` and runtime logs must not be committed.
- Next exact action: resume the real Tauri local-file import of `scripts/fixtures/readbox-visual-source.txt`, capture truthful normal/loading/error/completed evidence, and verify citation navigation.

After compaction/restart: reread the authoritative prompt, this ledger, and the PR-000 charter/governance; inspect `git status`, branch, HEAD, log, diff, remotes, current Read-Box pin/source, and any existing GitHub PR/check state. Reconcile before continuing and fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.

## Gate and visual update — 2026-08-11

- Real Windows Tauri evidence: `PASS` — ReadAny official EPUB import, existing Reader, pinned Read-Box worker loading/ready, digest, QA SSE, quiz answer/completion, matched passage citation return, and provider-unavailable error with Reader still usable.
- Passage citation: `PASS` for the exact fixture quote; the UI truthfully displayed `返回原文 · 段落定位` and invoked the existing Reader CFI navigation. Generic unmatched evidence remains deliberately chapter-level.
- Runtime bug found/fixed: blocking reqwest startup inside an async Tauri command caused a Tokio runtime-drop panic. Startup/shutdown now run in `spawn_blocking`; `cargo check`, Rust tests, real UI `ready`, explicit `stopped`, and app close were reverified.
- QA error bug found/fixed: Read-Box emits provider failures inside HTTP-200 SSE text. The adapter now rejects this as an error; regression tests cover real answers, upstream failure text, and empty streams. Core truth is now 76 files / 574 tests PASS.
- Expo tests: `PASS` — 2 files / 3 tests.
- App TypeScript/Vite production build: `PASS` after final fixes.
- Targeted Biome for new learning/scripts/docs files: `PASS`. ReaderToolbar whole-file formatting remains a CRLF baseline observation; it was not relabeled as a PR failure.
- JSON/YAML validation: `PASS` for every changed JSON file and `.github/workflows/pr-windows.yml`.
- Rust: targeted `rustfmt --edition 2021 --check src/readbox.rs` PASS; `cargo check` PASS; `cargo test readbox::tests` PASS (2).
- Pinned Read-Box integration rerun: initial sandbox runs failed first because `uv` was not on PATH and then because sandbox denied the user uv cache. The exact test rerun outside the sandbox with explicit system/user uv PASSed health, native import/mapping, digest, QA SSE, and quiz.
- Windows NSIS local gate: first run FAILed before compilation because a non-project pnpm 11 child aborted a non-TTY module purge; second run FAILed on a node_modules file lock. The exact CI build was rerun with restored frozen dependencies and parent/child pnpm 9.15.0, then PASSed release compilation and produced `ReadAny_1.3.5_x64-setup.exe`.
- `SELF_CONTAINED_WORKER_IN_INSTALLER = NOT_READY` remains unchanged: the installer builds, but the Read-Box Python worker/system uv is not bundled.
- Visual evidence index: `docs/evidence/pr001/README.md`; screenshots: `output/playwright/pr001/01...08`.
- Next exact action: remove only task-created temporary `.codex` scripts/config/logs, review the exact diff/security boundary, commit/push to the required branch, create the origin-only PR, and wait for exact-head blocking CI.

## Pre-commit reconciliation update — 2026-08-11

- PASS — after the latest automatic compaction, reread the complete authoritative prompt, this ledger, `docs/PROJECT_CHARTER.md`, and `docs/UI_UX_GOVERNANCE.md`; the initially probed alternate charter/governance paths were absent and were not treated as authority.
- PASS — refreshed both remotes again. `origin/main` remains the frozen base `3f527e89f3904681604d8d403b1d5064f91624d0`; `upstream/main` remains `3f8826c37391721289f4d6db47bacc0c73788572` and is still an ancestor of origin main. `UPSTREAM_ADVANCED = FALSE`.
- PASS — reverified the actual detached checkout at `.readbox/upstream/15f766f19f1ab204535f1947983fa397540352c8`: exact HEAD `15f766f19f1ab204535f1947983fa397540352c8`, clean source, correct upstream URL, README-only MIT declaration, and no license file.
- PASS — live GitHub query found no existing PR for `feat/pr001-readbox-learning-slice`; product PR remains `NOT_CREATED`.
- PASS — removed only task-created visual/build helper scripts, temporary config/shim, and logs. One orphaned PR-001 Read-Box process tree was identified by its exact workspace/pin/port command line; graceful termination failed, so that exact tree was force-stopped and the final locked log removed. No tested PR files or evidence were deleted.
- PASS — reviewed the implementation, integration harness, workflow, docs, screenshots, secret boundary, scope boundary, canonical mapping, and failure handling. No real credential is present; `integration-test-only` is confined to the deterministic integration provider and is redacted from captured worker output.
- Current branch and pre-commit HEAD remain `feat/pr001-readbox-learning-slice` at `3f527e89f3904681604d8d403b1d5064f91624d0`.
- Current truth remains: local Core/Expo/app/Rust/pinned integration/Windows NSIS evidence PASS as recorded above; whole-tree pre-existing Rust formatting debt FAIL; `REAL_DEEPSEEK_E2E = NOT_RUN`; Read-Box license `BLOCKED/PARTIAL`; generic unmatched citations chapter-level `PARTIAL`; self-contained installer worker `NOT_READY`.
- Next exact action: run the final pre-commit reproducible checks, stage only the reviewed PR-001 files, inspect the staged diff, commit normally, push only to origin, create the origin-base PR, and wait for exact-head blocking CI.

### Final pre-commit gate rerun

- PASS — Core: 76 test files, 574 tests.
- PASS — Expo: 2 test files, 3 tests.
- PASS — app TypeScript + Vite production build via project Corepack pnpm 9 direct filter.
- PASS — targeted Biome: 13 PR-001 learning/integration files, no fixes.
- PASS — exact `rustfmt --edition 2021 --check packages/app/src-tauri/src/readbox.rs`, `cargo check`, and `cargo test readbox::tests` (2 tests).
- PASS — `git diff --check`, all 8 changed JSON/YAML files parsed, and pinned source verification returned the exact ref/license truth.
- PASS — final real pinned Read-Box integration rerun: health, native import/mapping, digest, QA SSE, and quiz start/answer/next, using the real pinned FastAPI/router/agent path with a local deterministic OpenAI-compatible provider.
- FAIL (local tooling only, before compilation) — the root `pnpm build` wrapper again resolved non-project pnpm 11 from PATH and aborted its non-TTY module purge. The equivalent direct project-pnpm app build PASSed. Earlier exact CI-mode pnpm 9 Windows NSIS build remains PASS; GitHub uses `pnpm/action-setup` and will be the authoritative blocking result.
- FAIL (known baseline, unchanged) — whole-crate `cargo fmt --check` still reports unrelated pre-existing Rust formatting debt; the exact PR-001 Rust file check PASSed.
- Next exact action: stage the reviewed allowlist, inspect the cached diff, commit normally, push only to origin, create the origin-base PR, and wait for exact-head blocking CI.
