# Catalog（内置书库）构建说明

LIB-1“打开就有书的内置书库”的数据管线。目录快照与精选完整书全部来自官方来源的真实数据；
脚本不生成任何虚构条目。任何一步验证失败都会让构建整体失败（宁可缺额、不造假）。

## 数据来源（2026-09-13 实测可用）

| 来源 | 接口 | 用途 | 礼貌性约束 |
| --- | --- | --- | --- |
| Gutendex | https://gutendex.com/books/ | 古腾堡公版目录（多学科、多语言，中文 444 条） | 串行请求 + 退避重试，公共演示实例 |
| Open Textbook Library | https://open.umn.edu/opentextbooks/textbooks.json | 2,009 本现代开放教材（官方只读 API） | 串行 + 350ms 间隔 |
| 精选书 | curated-books.json | 12+ 本随安装包发布的完整书（含 4 本中文） | 每本真实下载 + 逐本验证 |

OAPEN/DOAB 是计划的规模扩容来源：旧 REST 接口只返回无元数据存根，留待 LIB-2 接入
（届时按官方 harvesting 文档走 CSV/OAI）。本轮不虚报其条目。

## 构建

```bash
pnpm catalog:build   # 抓取 Gutendex + OTL → packages/app/src-tauri/resources/catalog-seed/catalog.sqlite
pnpm catalog:seed    # 下载精选书 → 验证 → 回填 sha256/toc → books/ + manifest.json + t2s-chars.json
pnpm catalog:stats   # 打印真实统计（学科/语言/获取状态）
```

产物目录 `packages/app/src-tauri/resources/catalog-seed/` 随安装包发布：

- `catalog.sqlite` — 只读目录（meta / subjects / editions 表；editions.search_text 为
  构建期预分词文本：NFKC + 小写 + 去标点 + 中文双字 bigram，另含简体化副本）。
- `books/` — 精选完整书文件（EPUB/PDF），每本均通过格式与正文抽样验证。
- `manifest.json` — 每本书的 sha256、大小、许可、验证日期。
- `t2s-chars.json` — OpenCC 生成的繁→简字符映射（运行时查询侧使用，与构建侧对称）。

## 验证规则（build-seed.mjs）

- EPUB：PK 魔数 + ZIP 可解 + container.xml + OPF + spine 文档存在 + 从正文文档抽取
  ≥200 字符非空文本（拦截“返回 200 但其实是 HTML 错误页”）。
- PDF：`%PDF` 魔数 + 前 4MB 内 `/Type /Page` 对象 ≥ 10 + 最小体积。
- 每本记录 sha256；目录行回填 `verified_at` 与从文件实际提取的目录（toc）。

## 客户端接线

- 首启：`packages/app/src/lib/catalog/seed.ts` 把 catalog.sqlite 从资源目录复制到用户
  数据目录（版本或 builtAt 变化时重拷；books/ 直接从资源目录读，importBooks 时才复制）。
- 查询：`repository.ts` 用 plugin-sql 分页查询，绝不把目录塞进 Zustand books。
- 阅读：`acquire.ts` 走 `libraryStore.importBooks([资源文件])`（hash 去重、托管目录、
  元数据提取全复用），再 `openDesktopBook` 打开原生 Reader。
- “已在书库”状态由 `book.fileHash === edition.resource.sha256` 推导，不新增用户库表。

## 许可纪律

每条 edition 保留 `license_id / license_url / attribution`。hello-algo 与 Happy-LLM 为
CC BY-NC-SA 4.0：界面明示限制，仅用于学习阅读；公版书标注 Public domain (US) 及
Gutenberg 来源。NC 内容不进入“无条件可商用”声明。
