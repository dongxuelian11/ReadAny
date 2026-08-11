# Read-Box PR-001 Integration Decision

## Pinned upstream audit

- Repository: `https://github.com/wenhui426/read-box`
- Audited `main`: `15f766f19f1ab204535f1947983fa397540352c8`
- License truth: both READMEs declare MIT, but the exact ref has no `LICENSE`, `COPYING`, or `NOTICE` file and GitHub reports `license: null`. The integration therefore remains `PARTIAL` pending an upstream license-text correction; this PR does not describe the license as verified.
- Native runtime: FastAPI/SQLite launched by the upstream Tauri shell with system `uv run uvicorn`, loopback host, dynamic port, health polling, and child cleanup.
- Native contracts used: `/api/books/import`, `/api/books/{id}/chapters`, chapter digest, SSE QA, and chapter quiz start/answer/next.
- Upstream tests cover parsers, provider configuration, and context state, but do not cover the digest/QA/quiz routers end to end.

## ReadAny reuse audit

- `@readany/cli` and MCP already expose `books.list/get`, `chapters.list/get`, `context.get`, notes/highlights, and `rag.search`.
- Core already owns canonical `Book`, current `ReadingContext`, original chapter extraction, indexed chunks, CFI-bearing segments, and fallback extraction without a second SQLite reader.
- The desktop Reader already owns current chapter/location state and `goToCFI` / chapter-index citation navigation.
- Existing `aiConfig` remains the only user model configuration. PR-001 passes the active compatible endpoint to the worker at runtime and does not create a Read-Box settings page or persist a second API key.

## Decision

**Option A — native Read-Box API with a rebuildable derived chapter cache.**

For each active ReadAny chapter, the adapter extracts canonical text and CFI-bearing segments through existing Core/app services, normalizes that chapter into a single derived TXT payload, imports it through Read-Box's native books API, and stores only a ReadAny-to-Read-Box binding plus a content-version identity. ReadAny IDs and locations remain canonical; Read-Box integer IDs can be discarded and rebuilt.

Option B was rejected because the upstream agents hard-code their own database queries, so an external-context shim would couple to internal database behavior. Option C was rejected because provider injection exists but does not inject book/chapter context; digest, QA, and quiz still require Read-Box database rows. Option A is the smallest path that exercises the real upstream routers and agents without forking or copying their implementation.

## Packaging and citation truth

- Source acquisition is a reproducible checkout pinned to the full SHA; floating `main` is forbidden.
- PR-001 development/runtime uses system `uv` and a configured pinned source directory. `SELF_CONTAINED_WORKER_IN_INSTALLER = NOT_READY`.
- Read-Box citations are mapped back to the active canonical ReadAny chapter. Exact CFI is attached only when an excerpt can be matched to a canonical source segment. Otherwise the citation is deliberately chapter-level and remains `PARTIAL`, never falsely passage-level.
- Worker failure does not disable Reader content or navigation.

## Executed evidence

- The reproducible integration harness starts the pinned FastAPI backend and verifies health, native TXT import/chapter mapping, digest, QA SSE, and quiz start/answer/next with a local deterministic OpenAI-compatible provider.
- The Windows Tauri flow additionally imports a real EPUB through ReadAny, starts the worker on a dynamic loopback port, and completes digest, grounded QA, quiz, and passage-level return for an exact matched quote. Screenshots and exact state coverage are indexed in `docs/evidence/pr001/README.md`.
- Read-Box emits provider failures as HTTP-200 QA SSE text. The adapter explicitly rejects those upstream failure strings, and the visual error test proves that the Reader remains usable.
- Required UI skills actually used: project-local `apple-design` and `emil-design-eng`. No motion was added, so `review-animations` was not applicable.
- Real DeepSeek credentials were absent; `REAL_DEEPSEEK_E2E = NOT_RUN`.
