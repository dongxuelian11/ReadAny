# Visual Evidence — PR-016 … PR-022 (Learning Workspace slices)

Captured 2026-09-06 from a live `tauri dev` session on the developer machine
(Windows, zh UI, the PR-001 fixture book in the library). Screenshots were
taken by driving the real desktop app (accessibility + pointer automation)
and saving the OS window via a Win32 `CopyFromScreen` capture — no mocks, no
mocked data.

## What each screenshot shows

| File | State |
| --- | --- |
| `01-library-home.png` | Library home (书库) with the fixture book card. |
| `02-reader.png` | Reader with the fixture book open (chapter 一). |
| `03-learner-workspace-goal-empty.png` | **PR-016**: the Learner panel's new default **目标** tab in its designed empty state — phase line 「还没有目标」, creation note, placeholder, and the disabled 「设定目标」 button (enables only with input). Tabs 目标/摸底/掌握度/复习 all render localized. |
| `04-bookskill-ask-shelf.png` | **PR-018/022**: the Book Skill panel's estimate flow (章节数/tokens/genre select) plus the **问问书架** section with the mechanical-verification note (「每条论断都会与真实章节引用机械核对——未通过核对的会被标记」), question input, and disabled submit until input. |
| `05-learning-agent.png` | The Read-Box 学习 Agent panel (提炼/问答/小测 tabs) in its 「当前章节已就绪」 state. |
| `06-learner-placement.png` | **PR-013/016**: the 摸底 tab idle state (快速摸底 note + 开始摸底). |
| `07-learner-mastery.png` | **PR-013**: the 掌握度 tab — per-chapter mastery rows from the current-instant read model, status chip 「未接触」 (read-only render of persisted state; forgetting degradation is covered by unit tests). |
| `08-learner-review.png` | The 复习 tab empty state (到期复习 / 当前没有到期的复习 + 刷新). |

## Honest limitations

- The **LLM-driven flows were not exercised** (goal parse → curriculum list,
  guided teaching session, quiz judgement + confirmation, a real shelf ask
  with claim badges): they require a live configured LLM endpoint and would
  have made real calls. Their state machines are covered by the core unit
  suites (733 tests), and every non-LLM state visible above (empty/idle/
  ready/estimate/badges-note surfaces) renders from the shipped components.
- The panels live in the reader's custom title bar, which auto-hides; the
  capture session drove them through the accessibility tree.

## Follow-ups

- A future evidence pass with a configured LLM endpoint should capture:
  a built curriculum with localized reasons (PR-021), a teaching session
  mid-flow, a quiz judgement with the confirmation affordance (PR-014/016),
  and a real ask answer with verified/unverified claim badges (PR-017/020).
