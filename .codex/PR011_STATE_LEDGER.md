# PR-011 Semantic Routing State Ledger

Last updated: 2026-08-31 (Asia/Shanghai)

## Immutable task authority

- Objective: upgrade cross-book routing to match the TKG upstream behaviour — ONE LLM call reads each skill's frontmatter (name/description/when_to_use ONLY, never the domain SKILL.md body) alongside the question and selects the relevant slugs; validated fail-closed against the real slug list with keyword-scoring broadcast as the fallback. Backend ONLY: no UI.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GML53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Governing decision document: `docs/integrations/THE_KNOWLEDGE_GUY_PR002.md` (upstream routing: "Never read a domain SKILL.md yourself… only frontmatter ≤ 40 lines"; "No matches → route to all registered domain skills").
- Role boundary (user directive 2026-08-30): backend-only.
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr011-semantic-routing`, created normally from exact `origin/main` `e17938610c4826327826a6b567c135f27ac95465` (merge commit of PR #11).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No UI, no i18n, no answer persistence, no walk/course modes, no evidence writes, no new dependencies.
- No changes to the deterministic keyword router (routeSkills stays as-is — it is the fallback); no changes to buildBookAnswerPrompt/buildSynthesisPrompt/teaching/placement/goal modules.
- No changes to the Rust/Tauri layer, CI workflows, or the Read-Box slice.

## Design decisions (2026-08-31)

- `routeSkillsSemantic(skills, question, llm)`: ONE LLM call receives the question + each skill's `slug: title — description | when_to_use` frontmatter line and returns `["slug1", "slug2"]`. Validation: only real slugs survive (invented slugs dropped and reported); zero surviving → the deterministic keyword router takes over (including its broadcast-on-zero-hits behaviour); parse failure after one retry → keyword router fallback. The upstream frontmatter-only principle is honoured: the prompt sees ONLY `name`, `description`, and `when_to_use` lines — never the SKILL.md body or topic index.
- `askAcrossBooks` integration: new optional field `semanticRouting?: boolean` on AskAcrossBooksOptions (default false = keyword-only, backwards compatible with all existing callers/tests). When true, semantic routing runs first; its result (matched set + broadcast flag) feeds the existing fan-out unchanged.

## UI skill truth

- Not applicable: no user-facing UI or motion in this PR.

## Git and authority truth

- Base: `origin/main` `e17938610c4826327826a6b567c135f27ac95465`.
- Branch `feat/pr011-semantic-routing` created normally from that exact base; initial HEAD `e17938610c4826327826a6b567c135f27ac95465`.
- Product PR: `NOT_CREATED`.

## Test truth

- Semantic routing tests: `PASS` — 1 new file / 7 tests (LLM happy path with call-count verification; invented slug drop; parse-failure→keyword fallback; zero-surviving→keyword matched; zero-surviving+zero-keyword→broadcast; backwards compatibility without flag; frontmatter-only prompt body exposure). Book-skill module total: 4 test files / 45 tests.
- Full core suite: `PASS` — 89 files / 691 tests (was 88/684; +1 file / +7 tests).
- Core tsc: `PASS`. Biome: `PASS` (clean).
- Existing gates: run unchanged; authoritative result on GitHub CI.
- Real DeepSeek E2E: `NOT_RUN` (deterministic fake only).
- BUG found and fixed during this slice: `parseJsonResponse` only extracts `{…}` objects — the routing reply is a JSON ARRAY `["slug1","slug2"]`, so `extractBalancedJsonObject` returned null and every parse failed silently. Fixed by replacing `parseJsonResponse` with direct `JSON.parse` (we control the format).

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-08-31 (pre-merge)

- Implementation complete: `book-skill/semantic-routing.ts` (buildSemanticRoutingPrompt + routeSkillsSemantic), `askAcrossBooks` integration via optional `semanticRouting?: boolean`, additive exports. Existing keyword router (`routeSkills`) unchanged as fallback.
- Next exact action: push, wait for exact-head blocking CI, independent acceptance, ordinary merge (no squash/rebase). Post-merge: remaining backend candidates are answer persistence/history and the concept graph for prerequisite-aware reordering.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and the cross-book module; inspect git status/branch/HEAD/remotes; reconcile with GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
