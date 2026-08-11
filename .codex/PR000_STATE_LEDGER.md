# PR-000 / R1 State Ledger

Last updated: 2026-08-11 (Asia/Shanghai)

## Immutable task authority

- Task: PR-000 R1 — GitHub-native bounded baseline correction on the existing PR-000 branch; this is not PR-001.
- Objective: retain the qualified PR-000 baseline while making the public fork the product-development repository, moving review/CI into that repository, separating blocking gates from known upstream debt, correcting frozen integration semantics, and preserving all product-scope prohibitions.
- Authoritative prompts: `AI_READING_PR000_OPEN_SOURCE_BASELINE_CODEX_PROMPT(1).md` and `AI_READING_PR000_R1_GITHUB_NATIVE_BASELINE_CORRECTION_CODEX_PROMPT.md`.
- Upstream repository: `https://github.com/codedogQBY/ReadAny`
- Product repository: `https://github.com/dongxuelian11/ReadAny`
- Repository path: `<LOCAL_WORKTREE>`
- Branch: `chore/pr000-open-source-baseline`
- Upstream `main` observed at task start: `3f8826c37391721289f4d6db47bacc0c73788572`
- Base full SHA: `3f8826c37391721289f4d6db47bacc0c73788572`
- Implementation commit before final ledger reconciliation: `1886d9b12a0ffeacae8b795f13db89a5b87edfa1`
- Final branch HEAD: the commit containing the final ledger reconciliation; its exact SHA is verified from Git and GitHub after that commit because a Git commit cannot contain its own SHA.
- R1 starting HEAD, re-verified locally and on GitHub: `434838b36bdb369435018e87faedf997489f1b17`.
- R1 implementation HEAD before final ledger reconciliation: `468941f088f367b00fe0dc68699e50bc1f51e4cb`.

## R1 bounded correction scope

- Keep the existing branch and public commit history; no reset, rebase, force push, or history rewrite.
- Comment on and close mistaken upstream PR #648 without merging it.
- Create the replacement PR inside `dongxuelian11/ReadAny`, base `main`, head `chore/pr000-open-source-baseline`.
- Split CI into real blocking quality/Windows NSIS gates and an explicitly non-gating known-upstream-debt observation for full lint and full CLI tests.
- Correct the five frozen first-release integration decisions and six canonical GitHub watchlist identities without integrating or downloading those projects.
- Remove unnecessary local absolute paths from this public ledger while retaining recovery authority.

## Frozen scope

- Add upstream provenance and synchronization policy.
- Add the frozen OSS integration registry without downloading or integrating additional projects.
- Add the concise project charter.
- Add concise UI/UX/UE design governance for later user-facing PRs.
- Establish and verify the real Windows development/build spine.
- Add or correct minimum real Windows pull-request CI.
- Preserve GPL-3.0-or-later licensing, copyright, and ReadAny attribution.

## Prohibited scope

- No Read-Box, DeepTutor, The Knowledge Guy, or Gutendex integration.
- No Learner Model, Goal Agent, Reward Engine, Visual Learning, account, cloud sync, or learning feature implementation.
- No ReadAny RAG or ebook parser replacement.
- No broad UI redesign, mobile restructuring, final branding, or speculative future abstractions.
- No reset, rebase, force push, destructive branch replacement, or public-history rewrite.

## Git and GitHub state

- `upstream`: `https://github.com/codedogQBY/ReadAny.git`
- `origin`: `https://github.com/dongxuelian11/ReadAny.git`
- GitHub CLI account: `dongxuelian11`; authentication re-verified PASS on 2026-08-11 with `repo` and `workflow` scopes.
- Public fork: PASS — `https://github.com/dongxuelian11/ReadAny` is PUBLIC, `isFork=true`, parent `codedogQBY/ReadAny`, and fork `main` is `3f8826c37391721289f4d6db47bacc0c73788572`.
- R1 recovery verification: PASS — local HEAD, tracked origin branch, and GitHub branch all equal `434838b36bdb369435018e87faedf997489f1b17`; origin/upstream identities match authority; origin/upstream `main` both equal the frozen base.
- Mistaken upstream PR: CLOSED without merge — `https://github.com/codedogQBY/ReadAny/pull/648`; correction comment: `https://github.com/codedogQBY/ReadAny/pull/648#issuecomment-5247941617`.
- Upstream PR CI: BLOCKED (`action_required`) — final observed upstream run for the R1 starting head is `31447755045`; jobs never started because upstream-maintainer approval is required.
- Fork-internal replacement PR: OPEN — `https://github.com/dongxuelian11/ReadAny/pull/1`; base `main` at `3f8826c37391721289f4d6db47bacc0c73788572`, implementation head `468941f088f367b00fe0dc68699e50bc1f51e4cb` before final ledger reconciliation.
- Fork-internal CI run: COMPLETE — `https://github.com/dongxuelian11/ReadAny/actions/runs/31448993167`; workflow conclusion SUCCESS, blocking quality SUCCESS, blocking Windows NSIS SUCCESS, known-upstream-debt observation FAILURE and explicitly non-gating.

## Materially changed files

- `.codex/PR000_STATE_LEDGER.md` — created as the mandatory compaction-recovery authority.
- `.github/workflows/pr-windows.yml` — adds real Windows PR lint, test, typecheck/frontend build, and NSIS production-build jobs.
- `UPSTREAM.md` — records upstream identity, exact baseline, attribution, and non-rewriting sync policy.
- `INTEGRATIONS.lock.json` — records required future integrations and reference watchlist without vendoring or unverified pins/licenses.
- `docs/PROJECT_CHARTER.md` — freezes the concise product principles.
- `docs/UI_UX_GOVERNANCE.md` — freezes required design-skill and interaction-quality governance for later user-facing PRs.
- `packages/app/src-tauri/tauri.ci.conf.json` — limits PR builds to a real NSIS installer and disables release-only updater signing artifacts while preserving normal release configuration.
- R1 changes only `.github/workflows/pr-windows.yml`, `INTEGRATIONS.lock.json`, and this ledger: blocking gates are separated from visible non-gating debt, frozen integration semantics are corrected, canonical watchlist identities are recorded, and local absolute paths are removed.

## Completed

- PASS — read the authoritative execution prompt.
- PASS — observed upstream `main` directly with `git ls-remote`.
- PASS — cloned upstream into the empty workspace.
- PASS — verified cloned HEAD exactly matches the observed upstream SHA.
- PASS — renamed the cloned remote from `origin` to `upstream` after approved Git metadata access.
- PASS — created the required branch from the exact pinned base after approved Git metadata access.
- PASS — inspected repository scripts, existing workflows, GPL-3.0-or-later license/attribution, and Rust/Tauri configuration.
- PASS — added the required provenance, integration registry, project charter, UI/UX governance, PR CI workflow, and bounded Tauri PR-build override locally.
- PASS — completed the baseline install, lint, real test commands, frontend build, and Windows desktop build investigation with failures classified below.
- PASS — recovery on 2026-08-11 reread the authoritative prompt and ledger, then re-verified branch, HEAD, log, remotes, live upstream SHA, GitHub identity, fork absence, PR absence, and material files before continuing.
- PASS — created the real public GitHub fork and configured it as `origin`; preserved `codedogQBY/ReadAny` as `upstream`.
- PASS — completed bounded post-change regression verification: Core 566/566, Expo 3/3, and frontend build passed; lint and CLI reproduced their exact pre-existing Windows baseline failures without new counts or failure classes.
- PASS — committed and pushed the reviewed PR-000 change set to `dongxuelian11/ReadAny:chore/pr000-open-source-baseline` without rewriting history.
- PASS — created upstream pull request `https://github.com/codedogQBY/ReadAny/pull/648` against the exact pinned `main` base.
- BLOCKED — upstream pull-request CI was created but cannot start until an upstream maintainer approves the fork workflow; current run conclusion is `action_required` and the contributor account cannot approve repository Actions policy.
- PASS — R1 recovery fully reread both authoritative prompts and this ledger, then reconciled local Git, remote refs, fork identity, upstream PR #648, its blocked CI, and the absence of a fork-internal PR.
- PASS — R1 CI correction creates two independent blocking jobs for quality and Windows NSIS production build, plus an explicitly non-gating baseline-debt observation whose real failing commands remain visibly failed and are summarized without fragile log parsing.
- PASS — R1 integration-registry correction marks the four non-ReadAny required projects `REQUIRED_FOR_FIRST_RELEASE` and records all six canonical watchlist repository identities without guessing refs or licenses.
- PASS — R1 structural verification parsed both JSON files and workflow YAML, enforced all 11 integration identities/statuses, found no public-ledger local absolute path, and passed `git diff --check`.
- PASS — R1 local blocking-command verification: dependency install completed with repository-pinned pnpm 9.15.0; Core 566/566, Expo 3/3, frontend production build, and Windows Tauri NSIS production build passed.
- FAIL (`BASELINE_FAILURE`) — R1 debt observation reproduced full lint at 1,621 errors/284 warnings and full CLI at 124/135 passing with 11 failures; no product code or baseline-debt source was changed.
- PASS — appended R1 commit `468941f088f367b00fe0dc68699e50bc1f51e4cb` to the existing public branch and pushed normally without rewriting history.
- PASS — left the required correction comment on upstream PR #648 and closed it without merge or branch deletion.
- PASS — created fork-internal PR `https://github.com/dongxuelian11/ReadAny/pull/1` against the exact frozen base.
- PASS — fork-internal blocking quality job `93649215652` completed successfully, including install, patch whitespace, changed JSON/YAML validation, Core, Expo, and frontend production build.
- PASS — fork-internal blocking Windows NSIS job `93649215676` completed successfully; the real Tauri NSIS command ran for the PR head.
- FAIL (`BASELINE_FAILURE`, non-gating) — fork-internal debt job `93649215623` completed as visible FAILURE after running full lint and full CLI tests and writing the step summary; workflow conclusion remained SUCCESS because that job is explicitly non-gating.

## Pending / next action

- PASS — implemented and locally verified the R1 workflow, integration-registry, and public-ledger corrections.
- PASS — committed and pushed R1 on the existing branch without rewriting history.
- PASS — commented on and closed upstream PR #648 without merging it.
- PASS — created the fork-internal replacement PR and inspected its real blocking and baseline-observation CI to completion.
- PASS — refreshed the Git index stat cache; `packages/app/src-tauri/Cargo.toml` is clean and has no staged or unstaged content change.
- PASS — reviewed the complete staged diff and confirmed that it contains only the seven intended PR-000 files.
- PASS — validated both JSON files, parsed the workflow YAML, and passed `git diff --cached --check`.
- Next bounded action: commit and push this final ledger reconciliation, verify the replacement PR head and resulting latest CI, then stop without starting PR-001.

## Test and build truth

| Gate | Status | Evidence |
| --- | --- | --- |
| Upstream SHA observation | PASS | `git ls-remote ... refs/heads/main` returned `3f8826c37391721289f4d6db47bacc0c73788572`. |
| Clone/base match | PASS | `git rev-parse HEAD` matched the observed SHA. |
| Node version | PASS | `node --version` = `v24.16.0`. |
| pnpm version | PASS | Global `11.16.0`; baseline commands use repository-pinned `9.15.0` via Corepack. |
| Rust version | PASS | `rustc 1.96.0 (ac68faa20 2026-05-25)`; `cargo 1.96.0 (30a34c682 2026-05-25)`; `stable-x86_64-pc-windows-msvc`. |
| Dependency installation | PASS | `corepack pnpm install --frozen-lockfile` completed in 50.2s for all 8 workspace projects. Optional `dtrace-provider` native rebuild could not detect VS but its install script intentionally suppressed the error and pnpm exited 0. |
| Lint/typecheck | FAIL | `corepack pnpm lint` exited 1 before PR-000 implementation (`BASELINE_FAILURE`): Biome checked 889 files, reported 1,621 errors and 284 warnings. Visible causes include CRLF formatting differences on the Windows checkout and committed `packages/app/public/vendor/pdfjs/pdf.worker.mjs` exceeding Biome's 1 MiB maximum. No fixes applied. |
| Automated tests | FAIL | Core: PASS, 75 files/566 tests. Expo: PASS, 2 files/3 tests. CLI: `BASELINE_FAILURE`, 5/7 files and 124/135 tests passed; 11 failures remained after an approved unsandboxed rerun and concern Windows Unix/Darwin path simulation plus symlink creation. PR-000 changes no CLI source/tests. |
| Windows desktop production build | PASS | Baseline `pnpm tauri build` compiled Rust release and produced `app.exe`, MSI, and NSIS, then exited 1 because release-only updater signing lacked `TAURI_SIGNING_PRIVATE_KEY` (`BASELINE_FAILURE`). The PR-only NSIS/no-updater-artifact config was then verified with `pnpm --filter app tauri build --config src-tauri/tauri.ci.conf.json --ci`: exit 0 and `ReadAny_1.3.5_x64-setup.exe` produced. |
| Post-change regression verification | FAIL (`BASELINE_FAILURE`) | Re-run on 2026-08-11: lint reproduced 1,621 errors/284 warnings; CLI reproduced 11 failures with 124/135 passing. Core PASS 566/566, Expo PASS 3/3, frontend production build PASS. The bounded PR-only Windows Tauri NSIS build had already passed after the CI override was created. |
| Upstream pull-request CI | BLOCKED (`action_required`) | `Windows PR` run `31447755045` exists for R1 starting head `434838b36bdb369435018e87faedf997489f1b17`, but GitHub requires upstream-maintainer approval before jobs start. No CI job result exists. |
| R1 dependency installation | PASS | CI-mode `corepack pnpm install --frozen-lockfile` completed for all 8 workspace projects with repository-pinned pnpm 9.15.0. An initial Windows file-lock retry and a sandbox network denial were local-environment events; the approved network retry completed successfully. |
| R1 blocking quality commands | PASS | Core 75 files/566 tests; Expo 2 files/3 tests; frontend TypeScript/Vite production build completed. Local root-script wrappers encounter Codex runtime pnpm 11 precedence, so equivalent repository-defined package filters were executed with Corepack pnpm 9.15.0; GitHub Actions installs pnpm 9 before running the root scripts. |
| R1 blocking Windows NSIS command | PASS | `corepack pnpm --filter app tauri build --config src-tauri/tauri.ci.conf.json --ci` exited 0 and produced `ReadAny_1.3.5_x64-setup.exe`. |
| R1 baseline-debt observation | FAIL (`BASELINE_FAILURE`, non-gating by design) | Full lint reproduced 1,621 errors/284 warnings; full CLI tests reproduced 5/7 files and 124/135 tests passing with 11 failures. The workflow runs both commands in full, writes their real outcomes and frozen baseline to the step summary, and leaves the observation visibly failed without gating the two blocking jobs. |
| R1 fork-internal blocking quality CI | PASS | Run `31448993167`, job `93649215652`: dependency install, `git diff --check`, changed JSON/YAML validation, Core, Expo, and frontend production build all completed successfully. |
| R1 fork-internal Windows NSIS CI | PASS | Run `31448993167`, job `93649215676`: dependency/Rust setup and real Tauri NSIS production build completed successfully. |
| R1 fork-internal baseline-debt CI | FAIL (`BASELINE_FAILURE`, non-gating) | Run `31448993167`, job `93649215623`: full lint and CLI commands ran; the summary recorded frozen debt and the final explicit step kept the job visibly failed. Job-level `continue-on-error` made the overall workflow conclusion SUCCESS without misreporting the debt job as PASS. |

## Completion determination

- Original PR-000 fork, commit, push, and upstream PR creation: COMPLETE, but upstream PR target was incorrect and is being corrected by R1.
- R1 implementation, same-branch push, upstream PR correction, fork-internal replacement PR, and blocking CI: COMPLETE.
- Known upstream lint and CLI debt: remains visible FAIL and explicitly non-gating; not classified as PASS and not silently removed.
- PR-001: NOT_STARTED and out of scope.

## Recovery protocol

After compaction/restart: reread the authoritative prompt, reread this ledger, inspect `git status`, branch/HEAD, log/diff, and remotes, then reconcile any PR/check state before continuing. Fail closed on disagreement; never infer success from missing context.
