# PR-002 TKG Book Skill State Ledger

Last updated: 2026-08-30 (Asia/Shanghai)

## Immutable task authority

- Objective: implement only the PR-002 The Knowledge Guy Book Skill vertical slice inside the existing ReadAny Reader: generate a two-tier Book Skill (Tier-1 concept map + Tier-2 chapter toolkits + chapters manifest) for the current book from canonical ReadAny chapters, with a minimal Book Skill view whose chapter references navigate back to canonical ReadAny source.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Forbidden product PR target: `https://github.com/codedogQBY/ReadAny`.
- Required branch: `feat/pr002-tkg-book-skill`, created normally from exact `origin/main` `c0199596f6a8767a2f44617f7e399fa7212780c2`.
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- The Knowledge Guy repository: `https://github.com/vitalysim/the-knowledge-guy`.
- ReadAny remains book, Reader, source, UI, and AI-configuration Authority. The generated Book Skill is only a rebuildable derived cache; ReadAny chapter indices and CFIs stay canonical.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No PR-003 work: no cross-book routing / ask / comparison, no walk / course / check modes, no Stage 3 PRACTICE, no nutshell.
- No adoption of the TKG HTML artifact design system (no artifacts/ HTML rendering in this PR).
- No vision / image understanding: text-only pipeline with TKG's honest degradation path ("image could not be read" style notes where figures exist in source text is not required because input is canonical chapter text).
- No web research hatch.
- No DeepTutor, Gutendex, OpenTutor, pyBKT, FSRS, Learner Model, Goal Model, Curriculum Agent, Reward Engine, Visual Learning, video, web search, account, or cloud integration.
- No changes to the PR-001 Read-Box slice (digest / grounded QA / quiz / citation panel / worker runtime).
- No broad product rename, broad UI redesign, ReadAny RAG rewrite, ebook parser rewrite, or parallel SQLite book reader.
- No cleanup of unrelated upstream lint or CLI debt.

## Integration decision and pin

- TKG exact full SHA: `052049f45f7baa57c23f24c6e0ac5aba9f5133bb` (resolved via `git ls-remote`, cloned and verified; local checkout `.tkg/upstream/052049f45f7baa57c23f24c6e0ac5aba9f5133bb`, gitignored).
- TKG license truth: `VERIFIED MIT` — standard MIT LICENSE file present at the pinned ref ("Copyright (c) 2026 Vitaly Simonovich"). GitHub metadata "Other / NOASSERTION" is a misclassification; the file text is verbatim standard MIT. No release-gate block (contrast: Read-Box `BLOCKED_PENDING_LICENSE_CLARIFICATION`).
- Chosen integration option (user-aligned 2026-08-30): `Option A — Orchestrated Pipeline Port`. In-app TypeScript orchestration executes TKG's runbook stages (Pass 0 Spine → Stage 1 MAP → Stage 2 REDUCE) using TKG's prompt contracts, genre profiles, chapter template, and concept-map spec as adapted prompt data; input is canonical ReadAny chapter text (NOT TKG extract.py); LLM calls go through the existing aiConfig OpenAI-compatible provider (DeepSeek-first); output is a rebuildable derived Book Skill stored in the app data dir following TKG's file layout; TKG's `lint_chapters.py` runs as a real CI quality gate on generated fixture output.
- Rejected B (extract.py uv sidecar): adds a Python runtime dependency for marginal benefit on prose books; can be revisited later for figure-heavy / scanned-PDF books.
- Rejected C (external agent-host worker): heavy host-runtime dependency, model-binding risk, violates the model-independent principle.
- Rationale: TKG ships no spawnable service — it is SKILL.md runbooks plus standalone Python scripts; the agent host is the runtime, and in this product our own orchestrator is that host. TKG's prompts / schemas / templates / lint scripts genuinely participate in the chain; registry-only registration is forbidden and avoided.

## User alignment truth

- 2026-08-30: user selected Track B (The Knowledge Guy) as the PR-002 direction.
- 2026-08-30: user approved integration mode A (Orchestrated Pipeline Port) and slice scope A (full book-skill pipeline for the current book: Spine → MAP → REDUCE → manifest + minimal Book Skill view).

## UI skill truth

- `apple-design`: REQUIRED for the user-facing Book Skill panel; full project SKILL.md read on 2026-08-30 before implementation; applied (all panel states designed, restrained auxiliary layer, reading focus preserved).
- `emil-design-eng`: REQUIRED for the user-facing Book Skill panel; full project SKILL.md read on 2026-08-30 before implementation; applied (specific-property transitions, responsive controls, hierarchy via weight/size).
- `review-animations`: not applicable — no motion was added.

## Git and authority truth

- Base: `origin/main` `c0199596f6a8767a2f44617f7e399fa7212780c2` (ordinary merge commit of PR #2, merged 2026-08-30 after R1 governance correction `2718c13e`).
- Branch `feat/pr002-tkg-book-skill` created normally from that exact base; initial HEAD `c0199596f6a8767a2f44617f7e399fa7212780c2`.
- The local clone's `main` branch tracks `upstream/main` and must never be used as a product base or push target.
- Product PR: `NOT_CREATED`.

## Test truth

- PR-002 unit tests: `PASS` — full core suite now 77 files / 596 tests (was 76/574; the +1 file / +22 tests are `src/book-skill/book-skill.test.ts`: book numbering EN+ZH, response boundary, spine/reduce validation, pipeline generate/resume/rebuild/stub, SKILL.md rendering, cost estimate, panel reducer).
- Real pinned TKG integration test: `PASS` locally (2026-08-30) — `vitest.integration.config.ts` → `src/book-skill/integration/tkg-pipeline.int.ts`: pinned source acquired+verified (`052049f4`, `VERIFIED_MIT`, frozen contract files present), real `createBookSkillLlmClient` via the unified gateway against a local deterministic OpenAI-compatible endpoint, real pipeline wrote the upstream layout (SKILL.md, chapters/, chapters_manifest.json, raw/), and the upstream `lint_chapters.py --strict` gate passed with `0 warning(s)`. First run honestly FAILED the lint gate (192-word toolkits below the 200-word band) and was fixed by enriching the deterministic fixture — the gate is real, not decorative.
- Real DeepSeek E2E: `NOT_RUN` (no local key; run only if the user provides one, never persisted or committed).
- Blocking quality gate (CI): `PENDING` — runs on the pushed exact head.
- Blocking Windows NSIS gate (CI): `PENDING`.
- App typecheck `tsc --noEmit`: `PASS`.

## Blockers / partial truth

- None currently. Vision / image understanding intentionally unsupported in this slice (text-only); this is a documented honest limitation, not a hidden gap.

## Implemented so far (2026-08-30)

- Core `@readany/core/book-skill` (exported via `./book-skill`): types, 14 genre profiles, book_number port (EN + Chinese titles) with upstream two-pass algorithm, CJK-aware word/token estimation, response boundary (failure-text rejection, JSON extraction, toolkit validation), prompt contracts for Spine/MAP/REDUCE, deterministic SKILL.md/spine renderers, cost estimate, resumable pipeline with content-version rebuild + honest stubs + manifest validation, panel reducer, aiConfig client factory.
- App: Tauri fs adapter, trigger (canonical chapters via fallbackContentService, skill dir under `<appData>/book-skills/<bookId>/`), persisted `book-skill-registry` store (entries + genre preferences), `BookSkillPanel` (all states, genre select, progress, thesis/frameworks/concept-map/topic-index/chapter-index views with per-chapter "back to source" navigation), toolbar toggle + resizable panel mount in ReaderView, `bookSkill` i18n block in en/zh/zh-TW.
- Scripts/CI: `scripts/tkg-source.mjs` (pinned acquisition + fail-closed verification incl. MIT license truth), `vitest.integration.config.ts`, integration test, `blocking-tkg-integration` CI job, `tkg:source/verify/test:real` npm scripts.
- Governance: `docs/integrations/THE_KNOWLEDGE_GUY_PR002.md`, `INTEGRATIONS.lock.json` TKG entry now `PARTIAL / ORCHESTRATED_PIPELINE_PORT / VERIFIED MIT`, this ledger.

## Next exact action

Map existing code patterns (ai provider client, canonical chapter source, zustand store, Reader panel mounting, CI job and script patterns), then implement the core knowledge module (types, prompts-as-data, pipeline, manifest, response boundary) with deterministic tests.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and `docs/PROJECT_CHARTER.md` / `docs/UI_UX_GOVERNANCE.md`; inspect `git status`, branch, HEAD, log, diff, remotes, the pinned TKG checkout under `.tkg/upstream/`, and any existing GitHub PR/check state. Reconcile before continuing and fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
