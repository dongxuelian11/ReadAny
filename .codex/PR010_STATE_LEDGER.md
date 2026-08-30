# PR-010 Cross-Book Ask State Ledger

Last updated: 2026-08-31 (Asia/Shanghai)

## Immutable task authority

- Objective: implement the Track B cross-book question backend — given a free-text question and the shelf of generated Book Skills, deterministically route to matching skills (keyword scoring; broadcast-to-all when nothing matches, per the audited TKG design), fan out one grounded per-book answer per match, and synthesize ONE unified essay with inline citations and surfaced tensions. Backend ONLY: no UI.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Governing decision document: `docs/integrations/THE_KNOWLEDGE_GUY_PR002.md` (the Book Skill infrastructure this slice consumes) and the PR-002-era TKG audit (routing = frontmatter vocabulary matching; per-skill fan-out answers 200-400 words or "OUT OF SCOPE"; synthesis braids rather than stacks).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr010-cross-book-ask`, created normally from exact `origin/main` `c1152a0ced59cec0ad692a05dcf310da3673a155` (merge commit of PR #10).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No UI, no i18n (frontend owner later).
- No walk/course/check modes, no nutshell/practice, no TKG HTML artifacts, no artifact persistence layer (cross-book answers are returned, not stored — persistence is a future decision).
- No evidence/mastery writes (cross-book Q&A is informational, not mastery evidence).
- No changes to the PR-004..009 learner semantics, the placement/teaching engines, or the Read-Box slice.
- No new dependencies; LLM calls reuse the structural complete(system, user) client shape.
- No cleanup of unrelated upstream lint or CLI debt.

## Design decisions (2026-08-31)

- Routing is DETERMINISTIC keyword scoring over each skill's title + description + topic-index terms (pure code, no LLM): tokenize the question (latin words + CJK bigrams), score = distinct token hits across the skill's vocabulary; skills with score > 0 are matched; when NO skill scores, the question broadcasts to ALL skills (audited TKG behavior: no-match → broadcast). Rationale: the router must be deterministic Authority-compatible code; semantic routing can be revisited later without changing the interface.
- Per-book answers are grounded in that book's SKILL.md (concept map + core frameworks + topic index) plus the chapter toolkits whose topic-index terms hit the question (bounded to 2 chapters per book per answer); each per-book prompt instructs: answer ONLY from this book, 200-400 words, cite as [slug book_number], or reply exactly "OUT OF SCOPE" when the book does not cover the question.
- Synthesis: ONE LLM call braiding the surviving reports (OUT OF SCOPE reports are dropped and reported) into a unified essay with inline [slug book_number] citations, tensions surfaced rather than smoothed, and a Sources section; the synthesizer must not invent chapters.
- Session/persistence: none in this slice — askAcrossBooks is a pure computation returned to the caller.

## UI skill truth

- Not applicable: no user-facing UI or motion in this PR.

## Git and authority truth

- Base: `origin/main` `c1152a0ced59cec0ad692a05dcf310da3673a155`.
- Branch `feat/pr010-cross-book-ask` created normally from that exact base; initial HEAD `c1152a0ced59cec0ad692a05dcf310da3673a155`.
- Incident recorded: the PR-008 ledger was accidentally overwritten in the working tree by a careless node string-patch while recording PR-009's snapshot; caught immediately by `git status` during the branch checkout and restored from main before any commit. No harm shipped.
- Product PR: `NOT_CREATED`.

## Test truth

- Cross-book tests: `NOT_RUN` at ledger creation.
- Existing gates (quality / NSIS / Read-Box / TKG): run unchanged; authoritative result on GitHub CI.
- Real DeepSeek E2E: `NOT_RUN` (routing is pure; fan-out/synthesis tested against deterministic fakes).

## Blockers / partial truth

- None currently. Deferred by design: answer persistence/history, semantic (embedding or LLM) routing, walk/course modes, UI.

## Next exact action

Implement routing + fan-out + synthesis + app shelf trigger + tests; full verification; commit, push, PR, CI, independent acceptance, ordinary merge.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and `docs/integrations/THE_KNOWLEDGE_GUY_PR002.md`; inspect git status/branch/HEAD/remotes; reconcile with GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
