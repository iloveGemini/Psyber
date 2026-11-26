# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-26（完成最近两轮召回/向量/双链代码的审查缺陷修复与契约同步，补充 4 组回归用例）。

## 1. 当前阶段：Ring 1.5 外部 MCP 桥接、Tier 3 工具集、记忆反思与向量+Decision 召回管线已落地

### 已完成
- **召回/双链/客户端审查缺陷全量修复与契约同步（`docs/` + `server/`，2026-11-26）**：
  - 配置与校验：`config.ts` 新增 `mergeRecallConfig` 深度合并 `multiHop`（`neighborThreshold` 默认按 `Math.max(0.4, rerank.threshold)` 生效）；`admin_routes.ts` 补齐 `PATCH /settings` 对超时/阈值/多跳字段校验与深度合并。
  - 路由与客户端：`llm/decision.ts` 对重复题干去重并动态放大 `maxTokens`；`llm/embedding.ts` / `llm/reranker.ts` / `llm/router.ts` 修复 `openai-compat` 错路、未配 `baseUrl` 默认跳 SiliconFlow、异常响应静默空返回、孤立代理项与非有限向量、预中止 `AbortSignal` 穿透及 `Dynamic*Client` 悬空校验；`recall_eval.ts` / `eval_recall_replay.ts` 补齐虚拟事件 `seq`、并发缓存加载锁、中止重试退避与脚本 `nowMs` 参数。
  - 索引与召回：`memory/index.ts` 用 `task_cursors['index:card_links_v2']` 保障 v1→v2 无遗漏回填且剥离 Frontmatter；`memory/recall.ts` 修复 `rerankerActive` 门控失败回退、0.35 向量兜底门槛、`daily_recent` 截断、单卡缺失容错与 16 卡分块落库、1 跳锚点打分/`<selected_evidence>`/预算早停及正则空节解析；同步更新 `Spec 01`/`Spec 02` 与回归单测。
- **基于 `[[短标题]]` 双链的轻量 1 跳扩展与证据充分性早停（`prompts/` + `docs/` + `server/`，2026-11-26）**：
  - 数据库迁移 v2 新增可重建派生表 `card_links`；`MemoryIndex` 新增 `extractMarkdownLinks`（解析 `[[短标题]]` 与相对 `.md` 链接）与 `findLinkedNeighbors`（双向出/入边查询、多锚点共指优先、兼容 v1 库无损回填）。
  - `prompts/recall-gate.md` 升级至 v3，保留原两节不变以复用首跳缓存，新增 `# evidence_sufficient` 早停与 `# hop_neighbor_relevance` 邻卡双边判据；`memory/recall.ts` 新增 `linked_hop` 轨道（`[关联延伸]`），在首跳未满 5 张且存在邻卡时至多发起 1 次受预算约束的并行判断（`sufficientThreshold=0.75`、`neighborThreshold=0.40`、`maxNeighbors=6`），超时/异常绝不丢弃首跳结果。
- **向量嵌入 + 独立精排客户端与三路线回放盲测（`server/`，2026-11-26）**：
  - 新增 `core/embedding.ts`、`llm/embedding.ts`（Google 原生 `:embedContent`/`:batchEmbedContents` + OpenAI 兼容 `/embeddings` 与 Qwen3 查询指令）、`core/reranker.ts`、`llm/reranker.ts`（标准 `/rerank` HTTP 客户端）；`router.ts` 新增 `embedding`/`reranker` 槽位解析（不回落 `chat`）与连通测试，`index.ts`/`direct.ts` 接入 `DirectEngine`。
  - `memory/recall.ts` 升级批量卡片嵌入、自动分流路由（配置 `slots.embedding` 时默认走纯向量 Top-15 粗筛 + Decision 联合门控精排，`hybridFtsWithEmbedding=false`；未配置时沿用 ≤250 张全卡直扫）及独立 `reranker` 并行门控路径；默认阈值调整为 `gate.threshold=0.35`、`rerank.threshold=0.30`、`candidatePool=15`；同步更新 `docs/MEMORY.md` 与 `docs/spec/02-memory-execution.md` §7。
  - `memory/recall_eval.ts` 与 `scripts/eval_recall_replay.ts` 新增磁盘向量/精排缓存及 `embed_*`/`hybrid_*`/`embed_*rerank` 变体；闲聊回放盲测验证纯向量粗筛（`Qwen3-Embedding-8B` / `gemini-embedding-2`）+ `gemini-decision-1` 联合门控精排显著优于全卡直扫、混合 RRF 与传统 Cross-Encoder `Qwen3-Reranker-8B`。
- **召回门控 `noul` 双边判据（`prompts/` + `docs/` + `server/`，2026-11-26）**：
  - `prompts/recall-gate.md` 升级至 v2，为 `needs_memory` 与 `card_relevance` 新增 `## true` / `## false` 双边判据（明确排除常驻已覆盖、闲聊情绪宣泄、偶然撞词与硬翻旧账）；同步更新 `prompts/README.md` 与 `docs/spec/02-memory-execution.md` §7。
  - `memory/recall.ts` 新增 `parseRecallGatePrompt`（向后兼容旧版无子节提示词）并在全卡直扫与候选池精排统一透传 `criteria: { true_description, false_description }`（含 `{{card_id}}` 替换）；`llm/decision.ts` 对齐 Google `/v1beta/decisions` `NoulCriteria` 字段名并兼容 `true`/`false` 简写映射；补充单测覆盖。
- **Decision 召回门控、全卡目录直扫与闲聊回放评测框架（`docs/` + `prompts/` + `server/`，2026-11-25）**：
  - 契约与提示词：新增 `prompts/recall-gate.md`，更新 `docs/spec/02-memory-execution.md` §7/§9.3 与 `docs/MEMORY.md`；`core/decision.ts` 抽出共享 `DecisionClient` 接口与 `sanitizeUnicode`（修复截断 emoji 导致 Decisions API HTTP 400）；`llm/decision.ts` 与 `router.ts` 修复本地代理（`/v1` → `/v1beta/decisions`）下 `gemini-decision-*` 原生路由。
  - 召回优化：`recall.ts` 接入查询窗口、`<resident_context>`（`core/{open,state,user,self}.md` 精简 ≤1500 字）、活跃卡 ≤250 张单次全卡目录直扫（超上限自动切 FTS+精排）、`rerank_score` 落库与超时降级；默认参数经真实闲聊回放集调优定为 `gate.threshold=0.20`、`rerank.threshold=0.25`、`decisionTimeoutMs=3000`（`gate.enabled=false` 可一键回退）。
  - 闲聊回放评测：新增 `memory/recall_eval.ts`、`scripts/eval_recall_replay.ts`（`bun run eval:recall-replay`）与 `tests/recall_eval.test.ts`，支持按作息逻辑日防穿越 Git 快照、五类时刻分类、分层抽样、人工抽查 `review.md` 回写与本地决策缓存；真实数据评测产物严格隔离于 `<dataDir>/eval/`。
- **记忆卡片规范重设计、睡前整理与日反思合流及 hot-tidy（`prompts/` + `server/` + `app/`，2026-11-25，`392d5c0`）**：
  - `prompts/tidy.md`（v10）与 `prompts/reflect.md`（v2）落地严格「一事一卡」、`[[短标题]]` 站内双链、≤12 字唯一短标题与 `core/state.md` 双区进度看板（短期状态与待办 / 进行中的长线），`core/` 常驻档案设 1,800 字软上限。
  - `tidy.ts` 新增 `hot-tidy` 会话中增量整理、`computeColdTidyBudgetChars` 冷整理预算控制与瞬时错误重试；`circadian.ts` 新增 `bedtimeIdleMin`（30m）与通宵跨睡眠窗 `bedtimeForceAfterSleepEndMin`（240m）截断补跑，并将 `bedtime` 与日反思（`reflect.ts`）合流；`scripts/replay.ts` 支持分批回放。
- **Tier 3 只读记忆历史工具 `memory_history`（`server/`，2026-11-24，`6576bdc`）**：
  - 新增 `server/src/extensions/memory_history.ts` 与 `core/git.ts` `readMemoryGitLog`/`readMemoryGitShow`，注册为 Tier 3 只读工具；严格校验 `memory/` 相对路径（拦截 `.git`/`..`/控制字符）与十六进制/`HEAD~N` 提交引用并支持输出截断。
- **Tier 3 本地执行、文件系统与网页抓取工具（`server/`，2026-11-24，`319129a`）**：
  - 新增 `bash.ts`（`workspace` + 可配置 `allowedDirs` 白名单、受保护路径拦截、超时与输出上限）、`fs_tools.ts`（本地文件读写/检索）与 `web_fetch.ts`（网页抓取）；`admin_routes.ts` 与 `config.ts` 扩展 `/settings` 下发与校验 `bash` 配置。
- **聊天输入框、工具时间线弹窗与消息排版重设计（`app/`，2026-11-23，`1104b64`）**：
  - 重构 `adaptive_composer.dart`（媒体/贴纸按钮、模型与思考深度分段胶囊、主发送/停止按钮）；升级 `turn_journal_card.dart` 为多步时间线节点弹窗（`_JournalDetailContent` / `_TimelineStepRow`）；同步优化 `app_drawers.dart`、`timeline_items.dart` 与 `rich_message_text.dart` 排版。
- **配对安全补强、局域网自动发现、扫码配对、本机免码与多实例去重（`docs/` + `server/` + `app/`，2026-11-23，`8fb7f42` / `7afd01f`）**：
  - 后端：`index.ts` 注入真实客户端 IP、支持 `PSYBER_TLS_CERT`/`PSYBER_TLS_KEY` 原生 HTTPS；`pairing.ts` 常量时间比对；`sse.ts`/`app.ts`/`admin_routes.ts` 绑定 `deviceId` 与同 `clientId` 去重、增加 `Origin` 守卫；新增 `discovery.ts`（UDP `37219`）、`qr.ts`、`POST /api/v1/auth/pair-code` 与 `local-pair`（`0600` `local_pair.json`）。
  - 前端：`lan_discovery.dart`、`qr_code_view.dart` 与 `AppDelegate.swift` 实现桌面端本机免码、局域网点选、iOS 原生扫码自动关闭及 `SessionStorage` 多实例凭证缓存。
- **独立反思管线（Git + Decision 门控）与重放脚本（`prompts/` + `server/` + `app/`，2026-11-23，`b887e3f`）**：
  - 新增 `prompts/reflect.md`、`server/src/engine/reflect.ts`（日/周反思 `rf-*.md` 心路历程与 `core/`/`lessons/`/`threads/`/`entities/` 分流）、`server/src/llm/decision.ts`（`decision` 轻量裁决槽位）及 `server/scripts/replay.ts`；创世页与设置页接入 `decision` 槽位。
- **记忆四分法重构与 `covered_until` 梗概滚动（`docs/` + `prompts/` + `memory_template/` + `server/`，2026-11-23，`d811bf3`）**：
  - 记忆目录重构为 `core/`（含 `self.md`/`user.md`）、`episodes/`、`threads/`、`lessons/`；`gist.ts`、`frontmatter.ts` 与 `tidy.ts` 实现基于 `covered_until` 的日/月/年梗概零重叠拼接与 8,000 字总预算滚动。
- **模型元数据目录（`models.dev`）、设置页重构与截断防护（`docs/spec/` + `server/` + `app/`，2026-11-23，`270b552`）**：
  - 新增 `llm/catalog.ts`（内置快照 + 每日同步 + `modelOverrides`）、`registry.ts` 工具开关（Tier 1 锁定常驻）、`DEFAULT_FALLBACK_MAX_TOKENS=16384` 与 `stopReason=length` 回滚/截断防护；前端设置页拆分为服务商/模型配置/用量/作息/居所/工具与设备/关于与数据 7 个分区。
- **通用纸条/紧急卡片、双向门条与 Bark/ntfy/macOS 通知（`server/` + `app/`，2026-11-22，`4f524b7`）**：
  - `core_tools.ts`/`direct.ts`/`timeline_items.dart` 落地通用纸条与紧急卡片及双向门条交互；`notifications/hub.ts` 接入 Bark/ntfy 推送；前端新增 `local_notifier.dart` 与 `MainFlutterWindow.swift` macOS 后台本地通知。
- **静默整理上下文与身份/同步换段/主题/SSE 稳定性基础（`docs/` + `prompts/` + `server/` + `app/`，2026-11-21–22）**：
  - 完成 `tidy.md` v7 与 `<tidy_context>`、`self.md`/`user.md` 身份简化与全仓去「住户」统一、iOS 沙盒存储适配、同步收尾换段与 `<continuity>`、日夜独立色板与无字纸纹（旧书暖纸/岸线·晨/岸线·夜）、SSE `Last-Event-ID` 500 帧环形缓冲与 `TurnCheckpoint` 断点续跑、Ring 1.5 外部 MCP 桥接与同步审批。

### 下一步
- 按需推进 Ring 1.5 剩余项：多端点竞速、GFS 推送通道、观影伴看（`cinema`）插件、`digest` 附件摘要槽位。

## 2. 验证结果
- **`server/`（2026-11-26）**：`bun run typecheck` 及 `scripts/eval_recall_replay.ts` 严格检查零错误；`PSYBER_DATA_DIR=~/.psyber/test bun test`（22 文件 / 94 用例 / 1304 断言）全部通过。
- **`app/`**：`2026-11-23` `AppDelegate.swift` 已通过 `swiftc -parse`；`1104b64` 与 `392d5c0` 前端改动待宿主机终端复跑 `cd app && flutter analyze && flutter test`。
