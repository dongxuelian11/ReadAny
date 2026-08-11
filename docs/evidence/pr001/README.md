# PR-001 Read-Box visual evidence

These captures come from the Windows Tauri app, not a browser-only replica. The fixture EPUB was imported through ReadAny's existing local-file flow and opened in the existing Reader. The learning panel then started the exact pinned Read-Box backend (`15f766f19f1ab204535f1947983fa397540352c8`) through the Rust supervisor.

The LLM endpoint is the test-only deterministic OpenAI-compatible server in `scripts/readbox-visual-provider.mjs`; it replaces only the external model call. Book import, derived mapping, digest, QA SSE, quiz, and SQLite state execute the real pinned Read-Box routes and agents. These captures are not evidence of a real DeepSeek run.

## State coverage

- [Unavailable without an active ReadAny endpoint](../../../output/playwright/pr001/01-unavailable-no-active-endpoint.png) — the Reader stays visible and usable.
- [Real Worker loading](../../../output/playwright/pr001/02-loading-real.png) — the panel reports that the current chapter is being connected to Read-Box.
- [Normal ready state](../../../output/playwright/pr001/03-ready.png) — the current chapter is synchronized and the Reader remains the visual authority.
- [Digest complete](../../../output/playwright/pr001/04-digest-complete.png) — summary, concepts, exact quote, and passage-return action from the native digest route.
- [Citation returned to Reader](../../../output/playwright/pr001/05-citation-returned.png) — the matched quote uses the canonical ReadAny passage CFI.
- [Grounded QA complete](../../../output/playwright/pr001/06-qa-complete.png) — native Read-Box QA SSE plus a canonical passage citation.
- [Quiz complete](../../../output/playwright/pr001/07-quiz-complete.png) — native start/question/answer/next completion without mastery mutation.
- [Provider unavailable error](../../../output/playwright/pr001/08-error-provider-unavailable.png) — the provider process was deliberately stopped; the adapter rejects Read-Box's HTTP-200 failure text and the Reader remains usable.

## Experience gate

- `apple-design` informed the restrained Reader-side auxiliary hierarchy, focus on content, compact controls, and explicit state communication without copying Apple branding or trade dress.
- `emil-design-eng` informed the single-purpose panel, progressive disclosure across digest/QA/quiz, keyboard/focus labels, and removal of decorative motion.
- This PR adds no motion or animation, so `review-animations` was not required. Existing reduced-motion behavior is unchanged.
