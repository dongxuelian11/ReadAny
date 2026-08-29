# The Knowledge Guy PR-002 Integration Decision

## Pinned upstream audit

- Repository: `https://github.com/vitalysim/the-knowledge-guy`
- Audited `main`: `052049f45f7baa57c23f24c6e0ac5aba9f5133bb`
- License truth: a standard MIT `LICENSE` file exists at the pinned ref ("Copyright (c) 2026 Vitaly Simonovich"). GitHub's "Other / NOASSERTION" metadata is a misclassification of that file; the license is verified, and unlike Read-Box there is no release-distribution block.
- Upstream form: the repo ships no server, no spawnable worker, and no orchestrator code. It is two Claude Code SKILL.md runbooks (`book-to-skill`, `the-knowledge-guy`) plus standalone cross-platform Python scripts. Its own principle is literal: "plumbing in Python, intelligence in Claude" — every act of understanding is an LLM call described by the runbooks, executed by an agent host.
- Frozen contracts consumed by this integration: the Stage 1 chapter template, the Stage 2 concept-map spec (including `chapters_manifest.json` schema_version 2 and the `book_number` vocabulary), the 14 genre profiles, and `lint_chapters.py` (the upstream post-Stage-1 quality gate).
- Documented minimal-slice deviations from the upstream master SKILL.md template: the "How to Use This Skill" section (upstream slash-command UX, inapplicable in-app) and the "Supporting Files" links (glossary/patterns/cheatsheet are not generated in this slice) are omitted rather than rendered as dangling references; all other template sections are rendered as specified.

## Decision

**Option A — Orchestrated Pipeline Port (user-aligned 2026-08-30).**

The agent host that upstream assumes is, in this product, our own orchestrator. `@readany/core/src/book-skill` executes the runbook stages — Pass 0 Spine, Stage 1 MAP (per-chapter toolkits), Stage 2 REDUCE (Tier-1 concept map + topic index + manifest) — as provider-agnostic prompt contracts (prompts ported faithfully from the runbooks; model replies treated as untrusted data). LLM calls go through the existing unified model gateway (`createChatModel`, non-streaming) so every configured provider works, DeepSeek first; unlike the PR-001 Read-Box worker there is no OpenAI-compatibility restriction. Input is canonical ReadAny chapter text (upstream `extract.py` is NOT used); output is a rebuildable derived skill under `<appData>/book-skills/<bookId>/` following the upstream file layout (SKILL.md, chapters/, chapters_manifest.json, raw/), with an extra namespaced `readany` block in the manifest mapping every `book_number` back to canonical ReadAny chapter indices. A content-version (SHA-256 over pin + book + chapters) triggers full rebuild on change; resume is filesystem-driven exactly as upstream prescribes. `lint_chapters.py --strict` from the pinned source runs as a real quality gate in CI against the generated fixture skill.

Rejected B (extract.py uv sidecar): adds a Python runtime dependency for marginal benefit on prose books; revisitable for figure-heavy/scanned books. Rejected C (external agent-host worker): heavy host-runtime dependency and model-binding risk, contrary to the model-independent principle.

## Authority and honesty boundaries

- ReadAny stays the book/source/citation Authority. The generated Book Skill is a derived cache that can be deleted and rebuilt at any time; no second book reader, no second API key, no persistence of model replies as Authority.
- The manifest `index` (extraction order) is internal only; `book_number` is the sole user-facing chapter label — upstream's hardest-won rule — and every panel "back to source" navigation goes through the namespaced `readany.chapters` mapping to canonical chapter indices.
- Vision/image understanding is intentionally unsupported in this slice (text-only pipeline); `REAL_DEEPSEEK_E2E` remains `NOT_RUN` until a key is provided; cross-book routing, walk/course/practice modes, and the TKG HTML artifact design system are frozen out of PR-002.
- Worker-free by design: no new process, no runtime dependency on the pinned checkout at product runtime — the pin matters for development, CI verification, and auditability.

## Executed evidence

- Local real integration (`pnpm tkg:test:real`, vitest.integration.config.ts): pinned source acquired and verified (`052049f4`, VERIFIED_MIT, frozen contracts present), the real `createBookSkillLlmClient` drove the real pipeline against a local deterministic OpenAI-compatible endpoint, the derived skill was generated with the upstream layout, and the upstream `lint_chapters.py --strict` gate passed with `0 warning(s)` over all generated chapters. Provider labeled `LOCAL_DETERMINISTIC_OPENAI_COMPATIBLE`.
- CI adds a dedicated blocking job (`blocking-tkg-integration`) that repeats this chain on Windows, including Python for the upstream lint gate.
- Required UI skills actually used for the Book Skill panel: project-local `apple-design` and `emil-design-eng` (read fully before implementation; all panel states designed; no motion added, so `review-animations` is not applicable).
- Real DeepSeek credentials were absent; `REAL_DEEPSEEK_E2E = NOT_RUN`.
