# ReadAny：源码审查与快速可用开发计划

审查日期：2026-09-06  
仓库：dongxuelian11/ReadAny  
审查基线：`e25b7d2f36de6a817d79898f5c25f9a8685dcfc0`（main，合入 PR #26）  
对比基线：`79c9e2a8c541d958cf8a22e09963717c23460de3`

## 结论

这批开发有真实进展：目标—课程—带读已进入 LearnerPanel；增加了写锁、持久化待处理队列、当前时刻学习状态读取、有限并发跨书问答、回答历史和概念注册/投影视图。不能再把它描述为“只有后端、没有目标教学入口、没有任何概念身份”。

但关键调用链仍存在具体错误。最急的不是继续设计全局知识图谱或治理体系，而是把“一次答题完整保存”“失败可重试”“回答后看得见反馈”“明天能开始复习”做到可靠。

保留现有架构。先完成两个小修复迭代并交付可安装试用包；高级图谱功能不作为日用前置条件。

## 审查边界

直接阅读当前基线的 learner engine/outbox/SQLite stores、teaching engine/trigger、goal trigger/store、LearnerPanel/reducer、BookSkillPanel/trigger、concept graph/projection、cross-book 等源码，结合旧基线的改动清单核对。

运行了 6 组从源码摘取关键算法/分支并使用边界桩的独立探针。探针不是仓库原测试，不是 Tauri 实机运行，不调用真实模型，也不证明完整应用行为已验证。未完成全仓编译、桌面安装、真实模型教学质量评测，未修改远程仓库。

## 已落实的改进

- LearnerPanel 已有目标创建、课程展示、带读、答题、会话恢复相关调用；继续在这个入口完善，不另造 Learning OS 外壳。
- getCurriculumForGoal 已调用 getLearnerStateAt，旧版直接相信过期 status 的问题已在这条读取路径改善。
- withLearnerWriteLock 序列化当前 JS 运行环境内的学习写操作；outbox 提供 durable-first 意图与恢复入口。但它们还不等于数据库原子提交。
- 跨书问答默认 topK=4、最大并发=3，能容忍部分书籍调用失败，新增结构化 claims 与回答历史。旧版无限广播/单书失败拖垮整次请求的结论不再适用。
- Book Skill 生成回调增加了书籍身份检查，也增加了文件指纹/genre 失效判断。应保留这些修复，而不是重新从零实现缓存。
- 概念注册、参与关系、跨书投影已有实现；投影没有直接覆盖章节学习记录。这是合理的渐进边界，但具体别名与先修关系接线有问题。

## 需要修复的具体问题

### A. 事件写了一半，outbox 重放却会宣布完成（优先级最高）

位置：`learner/engine.ts`、`learner/outbox.ts`、`learner/sqlite-stores.ts`、app `learner/trigger.ts`。

实际顺序是 evidence.append → mastery.get/计算 → review card → review log → mastery.put。写锁防止部分并发交错，但不会自动回滚已写数据库行。outbox 在 DuplicateEvidenceIdError 时直接 markDone。

因此 append 后任一操作失败，再次重放会遇到重复事件 ID，并被当成完整提交成功。独立探针得到：第一次 failed=1；第二次 alreadyApplied=1；ledgerRows=1、masteryRows=0、outboxStatus=done。

Teaching 又在 applyEvidenceEvent 后单独保存会话进度，因此同样存在“学习记录已经更新，会话仍认为未答”的断点。不要只修 outbox 的 catch，必须修完整提交边界。

现有 outbox.test.ts 覆盖了 append 本身失败，以及整个 apply 成功后、markDone 前失败；没有覆盖 append 成功后的中段故障。

### B. 去重粒度是“题目”，不是“本次答题”

位置：`learner/evidence-mapping.ts::quizEvidenceId`。

ID 由 bookId、chapterIndex、题目位置、题干/选项 hash 构成，没有 attemptId/sessionId。同章相同位置再遇到相同题目，昨天答错和明天答对会得到相同 ID。代码注释明确采用了这个语义，但它不适合复习产品。

另一个问题：app `confirmQuizEvidence` 会再调用 applyEvidenceEvent，把对同一次判分的确认变成第二次练习，导致再次更新 BKT/FSRS。确认判分和再次做题不是同一件事。

### C. 带读有两个正常用户容易遇到的界面断点

位置：`LearnerPanel.tsx`、`learner/panel-state.ts`、`teaching-engine.ts`。

1. 首次 startTeachingForBook 成功后，session 只保存在 handleStartTeaching 的局部变量；第一步内容生成失败前没有把它写入 reducer。错误页的重试按钮调用 handleDeliverStep，而后者看到 state.teaching 为 null 就直接返回，用户点击没有作用。
2. answerCurrentStep 已把 currentIndex 推到下一步；下一步尚无 content。TeachingSection 先执行 `if (!teachingView) return ...`，后面才渲染 lastStepAnswer。结果正常答题后存在反馈数据，但界面先显示下一步生成按钮；最后一题又先进入 completed 分支。答错原因/最后一题反馈因此可能根本不展示。

### D. 换了目标，重开后还会恢复旧目标的教学

位置：`goal-trigger.ts::getGoalWorkspace`、`goal-store.ts`、`panel-state.ts::GOAL_CREATED`。

目标 supersession 只取消旧 Goal 的 active，不修改 TeachingSession；reducer 注释却假定 core 已废弃旧教学。恢复工作区时只检查 teaching.bookId，没有检查 teaching.goalId === goal.goalId。

教学完成后，界面中的 curriculum 也没有自动重算，点击“重新带读”仍可能复用旧计划。课程、复习列表在学习写入后需要局部失效/刷新，不能只刷新 mastery 标签。

### E. 复习页仍然是列表，不是可执行复习流程

位置：`LearnerPanel.tsx::ReviewTab`。

它显示 dueRows、日期和刷新按钮，没有从到期条目进入复习并完成一次记忆更新的操作。已有 FSRS 排程不等于用户已经能完成复习闭环。

### F. PR #26 的先修排序没有真正读取先修关系

位置：`goal-trigger.ts::getCurriculumForGoal`、`book-skill/concept-graph.ts`、`learner/goal.ts::orderStepsByPrerequisites`。

adapter 用 listConceptsForSourceUnit → listSourceUnitsForConcept 构造边，没有读取 listRelated(...).relation === prerequisite。它把共同出现同一概念当成先修关系：两个章节共享概念就可能生成 A→B 和 B→A，最后拓扑排序遇到环回退书序。真正不同概念之间的 prerequisite 反而被忽略。

此外构造边只拿章节索引比对，没有完整书籍身份过滤；framework 节点注册时也没有把 node.chapter 绑定到 source-unit，先修边与教学章节之间缺少接线。

立即处置：先在产品中回退书序，不阻塞日用。修复时只补“读取明确的 prerequisite 边、方向约定、框架节点章节映射、本书范围检查”；不需要新图数据库。

### G. 别名归并依赖构建顺序，还会过度合并

位置：`book-skill/concept-graph.ts::buildConceptGraph/derivedAliases`。

为“费用 fees”写入“费用”和“fees”别名，但挑选 canonical id 时只查完整 term/normalized，没有查 derivedAliases；已有两个单语概念时再导入双语名称，不会合并原有参与关系。探针：双语名称先构建产生 1 个概念；两个单语名称先构建再双语产生 3 个。

英文多词名称又被拆成单词别名，“machine learning”会写入“learning”别名，随后单独的“learning”就被并到机器学习。

立即处置：自动归并仅保留完整名称规范化的精确匹配；停止单词级强制别名覆盖。跨语言关系先保留为候选/导航，不作为已验证掌握度或先修决策依据。

### H. 跨书 verified 只校验“引用存在”，不证明论点得到支持

位置：`book-skill/cross-book.ts::verifyClaims/askAcrossBooks`。

验证收到的是 matched，而不是实际成功、非 OUT OF SCOPE 的来源集合；它检查整本书的章节列表，不限于实际送给模型的章节。failed-book 的一个存在章节，也能让 claim.verified=true。

近期最小修复：改名为 referencesResolved/referenceValid；失败、拒答和未提供的来源不得混入允许引用集合；UI 显示“引用可定位”，而不是“论点已证实”。逐句论点真实性自动证明不作为试用前置。

## 开发迭代 1：学习提交可靠，不丢、不重、不假成功

### 目标

同一次答题只生效一次；一次新的复习能够再次生效；在任何中段写入失败后可恢复，并且会话进度与学习状态一致。

### 修改范围

已有文件：
`packages/core/src/learner/engine.ts`、`outbox.ts`、`sqlite-stores.ts`、`evidence-mapping.ts`、`teaching-engine.ts`；
`packages/core/src/services/platform.ts` 与实际桌面数据库适配边界（实施前定位真实实现）；
`packages/app/src/lib/learner/trigger.ts`、`LearningPanel.tsx` 的 attempt 生命周期。

### 实现约束

1. 增加一个小的学习提交入口，不重写 BKT/FSRS，不引入新 Agent 框架或消息基础设施。
2. 在现有 SQLite 同连接事务/原子批提交内写入事件、review card、review log、mastery、相关 teaching progression，以及可判断完整提交的标记。不要在无法保证同连接的独立 execute 调用外简单拼 BEGIN/COMMIT。
3. 重复 attemptId 仅在完整提交且输入一致时返回已有结果；部分事件行存在不能等同于提交成功。输入冲突需要明确报错。
4. 一次作答开始即生成并持久化 attemptId；重试复用它；重新开始一次复习生成新 attemptId。题目 hash 只作题目身份，不再作为永久作答去重键。保存原始作答时间，恢复时不静默改成当前时间。
5. 用户确认判分不新增第二次练习或第二条 FSRS review。可以记录独立确认元数据；本轮不建立庞大信任模型。
6. 保留现有写锁，但调整锁边界时注意它不支持重入；事务入口不要再嵌套调用另一个取相同锁的函数。
7. 旧数据先备份。不清空整个数据库，不把历史重复 ID 全部当成成功，也不盲目重算全部历史。无法无歧义修复的旧记录标出待核对，不阻断普通阅读。

### 只验证与改动有关的场景

- 在 append 后、putCard 后、appendLog 后、mastery 后、会话提交前逐点故障注入：事务全部回滚，或重试后整次恰好完成一次。
- 连点提交/重复传输：一份 evidence，一次 BKT 更新，一次 FSRS review，一次会话推进。
- 同一题隔天再做：新 attempt 被记录，第一次错误与第二次正确都保留。
- 确认判分不增加 practice/review 次数。
- 在真实桌面数据库适配器上做至少一次中断—重开验证，不只用内存 Map。

## 开发迭代 2：补齐日常使用闭环，并交付试用包

### 目标

用户能“设目标 → 学一节 → 看反馈 → 退出重开 → 从正确进度继续 → 完成到期复习”。完成后交付安装包，不等待高级图谱完成。

### 修改范围

`packages/app/src/components/reader/LearnerPanel.tsx`；
`packages/core/src/learner/panel-state.ts`；
`packages/app/src/lib/learner/goal-trigger.ts`、`teaching-trigger.ts`；
必要的 `teaching-engine.ts`/store 小改动与中文文案。

### 具体开发

1. 会话创建后立即进入 reducer，再生成首步；重试同一 session/step，不重新开课；初次失败也要保留可恢复的 session。
2. 把上一题反馈放到“下一题是否已有内容”的判断之前，最后一题也先显示对错和解析，再进入完成页。可以增加很薄的反馈状态，不重写整个 UI 框架。
3. 恢复同时校验 bookId 和 goalId；目标换新时废弃旧目标的教学，或至少不再恢复它。异步结果携带 bookId/goalId/请求代次，忽略过期响应。
4. 答题或完成教学后刷新课程与到期列表；重新带读前重新计算 curriculum。不要继续使用已过期的内存课程。
5. 复习页增加“开始复习”/单项复习操作；复用现有内容生成、答题和本轮可靠提交路径。用户无需为一次复习重新输入目标。可以先用一个有界的待复习队列，不造完整学习调度平台。
6. 拆开教学生成依赖与纯答题保存依赖：answerTeachingStep 不必重新抽取整本书、创建模型客户端；只有生成新内容时需要模型。缓存命中也不要重复做全书准备工作。
7. 高级先修排序暂回书序；停止高风险别名单词强并。概念投影明确标注“由章节表现估计”，不要冒充直接测量的概念掌握程度。
8. 输出可安装的个人试用包，标明构建 commit。已有根脚本 `pnpm test`、`pnpm build`、`pnpm tauri ...` 可作为入口；构建前以当前 package.json 和平台要求为准，不杜撰成功日志。

### 试用包最低验收

| 场景 | 实际期望 |
|---|---|
| 导入真实 EPUB，设置目标 | 能看到课程并开始第一步 |
| 第一题答错 | 先显示正确答案/解释，再进入下一步 |
| 首次生成失败 | 重试恢复同一 session/step，不是无响应 |
| 答题后关闭重开 | 不重复记账；恢复正确目标和进度 |
| 改目标后关闭重开 | 不恢复上一目标的旧课程 |
| 到期复习与重复点击 | 能完成复习；新作答计入，重复传输不计入 |
| 未配置模型/模型不可用 | 已有阅读与已缓存内容可用，生成操作给清晰错误 |

## 使用中迭代 3：内容可信度与图谱接线

不作为前两轮试用包前置。

- 跨书引用：只允许成功、非拒答且确实提供的来源；“verified”改为引用可定位，保留部分来源失败提示。不要设计全自动事实裁判系统。
- 真先修排序：补 framework→chapter 映射和明确关系方向，调用 listRelated 取 prerequisite；保留书序回退和本书过滤。新增 adapter 到排序的联动测试，而不是只测排序函数。
- 别名：先做到精确匹配与不覆盖冲突；将双语等价候选与已确认映射分开。不要无授权批量迁移已有 mastery。
- 教学质量：用用户真实材料观察“节奏是否合适、错题解释是否有效、长章截断是否漏关键内容”，再决定要不要增加分段教学/检索。新框架不是默认答案。

## 暂不做

全局 GoalGraph 重构、图数据库、完整 Event Sourcing 平台、多代理编排升级、复杂权限/治理流水线、排行榜奖励系统、多端同步完备化、自动逐句事实证明、以最终全局概念替换所有章节学习记录。

每个迭代只保留：一个短任务说明、改动相关测试结果、几个真实桌面操作结果。不要扩充为多层验收台账。上下文压缩后只需恢复本文件基线、当前 diff、已验证场景和未完成项，不重启架构设计。

## 源码索引（均固定到本次审查 commit）

- [packages/core/src/learner/engine.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/engine.ts)

- [packages/core/src/learner/outbox.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/outbox.ts)

- [packages/core/src/learner/outbox.test.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/outbox.test.ts)

- [packages/core/src/learner/write-lock.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/write-lock.ts)

- [packages/core/src/learner/sqlite-stores.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/sqlite-stores.ts)

- [packages/core/src/learner/evidence-mapping.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/evidence-mapping.ts)

- [packages/core/src/learner/teaching-engine.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/teaching-engine.ts)

- [packages/core/src/learner/panel-state.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/panel-state.ts)

- [packages/core/src/learner/goal-store.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/goal-store.ts)

- [packages/core/src/learner/goal.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/goal.ts)

- [packages/core/src/learner/concept-projection.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/learner/concept-projection.ts)

- [packages/core/src/book-skill/concept-graph.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/book-skill/concept-graph.ts)

- [packages/core/src/book-skill/cross-book.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/book-skill/cross-book.ts)

- [packages/core/src/services/platform.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/core/src/services/platform.ts)

- [packages/app/src/lib/learner/trigger.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/app/src/lib/learner/trigger.ts)

- [packages/app/src/lib/learner/goal-trigger.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/app/src/lib/learner/goal-trigger.ts)

- [packages/app/src/lib/learner/teaching-trigger.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/app/src/lib/learner/teaching-trigger.ts)

- [packages/app/src/components/reader/LearnerPanel.tsx](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/app/src/components/reader/LearnerPanel.tsx)

- [packages/app/src/components/reader/BookSkillPanel.tsx](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/app/src/components/reader/BookSkillPanel.tsx)

- [packages/app/src/lib/book-skill/trigger.ts](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/packages/app/src/lib/book-skill/trigger.ts)

- [package.json](https://github.com/dongxuelian11/ReadAny/blob/e25b7d2f36de6a817d79898f5c25f9a8685dcfc0/package.json)

## 参考

SQLite 原子提交说明：https://www.sqlite.org/atomiccommit.html
