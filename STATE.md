# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-28（落地双层记忆淡出机制与 MCP replay 质量对齐；前期已完成观影伴看 `cinema`、外部 MCP 图片透传、P0 源头凭证过滤与 P1 高敏隔离区）。

## 1. 当前阶段：Ring 1.5 外部 MCP 桥接、对外记忆 MCP 工具层（第一、二阶段）、双层记忆淡出、源头凭证过滤（P0）、高敏隔离区与记忆补齐（P1）、Tier 3 工具集、记忆反思、向量+Decision 召回/体检、双端异步语音条与附件并行摘要已落地

### 已完成
- **双层记忆淡出机制（`docs/` + `prompts/` + `server/`，2026-11-28）**：
  - `episodes/` 索引层软淡出：数据库迁移 v4 为 `card_index` 增加 `pinned` 列；`config.ts` / `admin_routes.ts` 新增 `recall.episodeFadeDays`（默认 90 天，`0` 禁用，范围 `0..3650`）；`MemoryIndex.computeSoftFadedEpisodePaths` 对超期、未 `pinned` 且无 `core/`/`favorite/`/`lessons/` 有效入链的 `ep-*.md` 在索引层自动软淡出，退出主召回（含 1 跳扩展）、对外 `memory_search`（含 1 跳邻居）与体检雷达，绝不改盘且 `read` 可直接读回；`recallMemories` 确认命中落库 `recall_traces` 时同步刷新 `access_count` / `last_accessed` 实现召回保活；`MemoryTools.read` 按 `kind === 'state'` 区分「已过短期 TTL」与「已自然淡出」文案。
  - `threads/` 周反思久未更新只读雷达：`memory/radar.ts` 新增 0-LLM 本地扫描 `scanStaleThreadFindings`（按 `threads/REGISTRY.yaml` `decay` 阈值 `short` ≥ 30d / `slow` ≥ 90d，豁免 `decay: none`/`thread:lists`/`kind: work`，活跃度取 `max(updated_at, last_accessed, 最新入链 updated_at)`，单次上限 5 条）并渲染至 `<memory_radar>` 的 `[久未更新 / 可考虑淡出]`；`runMemoryRadar` 在 `weekly` 模式下兼容无 `decisionClient` 与无新卡场景，`reflect.ts`/`replay_runner.ts`/`tidy.ts` 统一透传 `episodeFadeDays`；同步更新 `prompts/_memory-schema.md`、`prompts/reflect.md`、`docs/MEMORY.md` 并新增 `tests/memory_fading.test.ts`。
- **内置观影伴看插件（`cinema` · 本地 HTTP `/pull` 桥接，`docs/` + `server/` + `app/`，2026-11-28）**：
  - 契约、配置与存储：更新 [docs/spec/03-boundaries-expression-activities.md](docs/spec/03-boundaries-expression-activities.md) §4.3 与 [docs/API.md](docs/API.md) §3；`core/config.ts` 新增 `cinema` 配置（`bridgeUrl` 默认 `http://127.0.0.1:18765`、`timeoutMs=2500`、`syncPauseResume=true`）与 `/settings` 校验；`core/db.ts` 新增迁移 v3 `activity_sessions` 表；`core/media.ts` 扩展 `cinema_frame` 来源与 `pinned` 控制；`engine/sse.ts` 新增 `activity.updated` 事件类型。
  - 插件、工具与零延迟注入：新增 `server/src/extensions/cinema.ts`（`CinemaActivityPlugin`），负责单活跃会话持久化、开/关联动采集源 `/resume` & `/pause`、心跳 30m `stale`/4h 软结束防误结束巡检，并注册 6 个 Tier 2 观影工具（`cinema.status` / `save_character` / `rename_character` / `get_frame_at` 临时带图 / `switch_window` / `set_mode`，不污染 Tier 1 Static Prefix）；`engine/direct.ts` 接入 `activityProvider`，聊天前自动拉取 `/pull?clear=1` 与 `/api/grid.jpg` 注入 Dynamic Tail `<active_activity>` 与当轮临时四宫格图（跨轮不落盘 base64，采集离线自动降级）；`api/app.ts` 挂载 `/api/v1/activities*` 路由与 `/cinema/grid` 鉴权代理并自动标记消息 `activity='cinema'`；新增 `server/tests/cinema_activity.test.ts`（2 组全离线集成用例）。
  - Flutter 伴看交互：`models.dart` / `api_client.dart` / `app_controller.dart` 新增 `CinemaBridgeInfo` / `CinemaWindowItem` 与启停/选窗口/切模式接口；`app_drawers.dart`（`ActivityCardBody`）补齐采集探测状态、一键「开始一起看」、选窗口弹窗与影视/综艺切换；`activity_banner_slot.dart` 兼容 `progress` 文本、暂停态与采集掉线提示。
- **外部 MCP 图片块透传（`docs/spec/` + `server/`，2026-11-28）**：
  - `extensions/mcp.ts` 升级 `formatMcpCallResult` 支持标准 `image` 内容块与 `resource` 嵌入图片 blob（支持 JPEG/PNG/WebP/GIF、`image/jpg` 与 `data:` URI 归一、单次上限 4 张与 3.5 MB 单图拦截、音频/非图二进制占位防 base64 泄漏进文本），经 `tools/registry.ts` 透传为当轮临时 `ToolResult.images` 送入模型，跨轮自动回收不落盘 SQLite；同步更新 `docs/spec/03-boundaries-expression-activities.md` §5.2 与 `tests/mcp_bridge.test.ts`（新增单测 + 端到端集成用例）。
- **P1 高敏私密隔离区与记忆补齐（`docs/` + `prompts/` + `server/`，2026-11-27）**：
  - 契约与提示词：更新 [docs/MEMORY.md](docs/MEMORY.md)（升级为七大目录）、[docs/spec/01-engine-tools-prompts.md](docs/spec/01-engine-tools-prompts.md) §5 与 [docs/spec/02-memory-execution.md](docs/spec/02-memory-execution.md) §1.1；升级 `prompts/main.md`（v10）、`prompts/tidy.md`（v13）与 `prompts/reflect.md`（v4），补齐 `sensitive/` 留白约定、`core/dates.md`、`core/glossary.md`、`threads/lists/` 免“双次成林”与 `workspace/` 边界。
  - `memory/sensitive/` 物理隔离与高门槛召回：`frontmatter.ts` 与 `memory/tools.ts` 大小写归一化识别 `sensitive`/`private` 分区并支持 `excludeSpaces` 防 macOS APFS 大小写与多级 `./` 绕过；`core/config.ts` 与 `api/admin_routes.ts` 新增 `recall.sensitive` 配置（`allowExternalEmbedding=false`、`rerankThreshold=0.55`、`ftsMinScore=0.45`）；`memory/recall.ts` 默认不外发 `sensitive/` 到外部 Embedding、未配 Embedding 全卡直扫亦先经本地 FTS5 过滤绝不把未命中高敏卡标题外发给云端决策模型，统一小语料库（`<10` 卡）混合/纯向量 FTS 豁免，高门槛精排并标注 `[敏感记录·按需轻声对待]`、严禁 1 跳双链带出；`memory/radar.ts` 与 `memory/recall_eval.ts` 默认排除 `sensitive/`；`api/memory_mcp.ts` 与 `core/git.ts`（`excludePaths`）在全部对外 MCP 工具中硬屏蔽 `sensitive/`，并在 `memory_replay` 搬家步骤放行 `core/{dates,glossary}.md`。
  - 周期日子与专属暗语：新增 `server/src/memory/dates.ts`（宽容解析 `MM-DD`/`YYYY-MM-DD` 与 `celebrate`/`gentle`/`milestone`/`deadline`，支持跨年 7 天窗口、闰日折算与周年计算）；`engine/direct.ts` 与 `api/memory_mcp.ts` 将 `core/glossary.md` 纳入常驻前缀/上下文，并每日动态抽取 `core/dates.md` 7 天内命中条目注入 `<upcoming_dates>`；新增 `server/tests/memory_p1_zones.test.ts`（4 组全离线集成用例，97 断言）。
- **P0 源头隐私与凭证过滤（`docs/` + `prompts/` + `server/`，2026-11-27，`eafe7d7`）**：
  - 契约与提示词：更新 [docs/MEMORY.md](docs/MEMORY.md)、[docs/spec/01-engine-tools-prompts.md](docs/spec/01-engine-tools-prompts.md) §1.1/§5 与 [docs/spec/02-memory-execution.md](docs/spec/02-memory-execution.md) §1.2；升级 `prompts/main.md`（v9）与 `prompts/tidy.md`（v12）补齐软凭证（密码/密钥/验证码/证件与银行卡号）禁记条款。
  - 脱敏引擎与全链路护栏：新增 `server/src/core/redact.ts`（高置信度结构化凭证识别与幂等占位符 `[已隐藏:<类别>]`，支持带逗号/分号引号密码与通用 `*_token` 键名，规避普通聊天、哈希、分页/用量词与占位符误杀）；`store/events.ts` 在 `append`/`editLatestUserMessage`/`setAttachmentDigestState` 源头落库脱敏（覆盖正文、思考与嵌套 `metadata`）；`api/app.ts`、`engine/direct.ts` 与 `engine/sse.ts` 保留用户当轮内存明文给主对话模型但对 `recall_traces`/外部向量与决策查询/`digest` 附言、`TurnCheckpoint` 断点快照即时脱敏，并在命中脱敏的轮次结束时清除 `SseHub` 500 帧重放缓冲中的流式分片；`tools/registry.ts` 与 `api/memory_mcp.ts` 对非 Tier 1 记忆工具及对外 `memory_history` 输出即时脱敏；`memory/tools.ts` 在 `write`/`edit` 写盘前硬拦截疑似明文凭证（不静默篡改，保留第一人称改写权）；`engine/digest.ts`、`engine/tidy.ts` 与 `scripts/replay.ts` 补齐摘要禁抄、话单兜底与导入脱敏。
  - 只读体检与回归测试：新增 `server/scripts/audit_secrets.ts`（`bun run audit:secrets`，只读扫描 `memory/` 与 `events`，支持单行+多行 PEM 同文件无漏报与 `metadata` JSON 递归审计，绝不回显明文）与 `server/tests/redact.test.ts`（9 组全离线用例）。
- **对外记忆 MCP 工具层 · 第二阶段（`docs/` + `server/`，2026-11-26）**：
  - 契约与开关：更新 [docs/API.md](docs/API.md) §3.5 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；`core/config.ts` 新增 `memoryMcp.replayToolsEnabled`（默认 `false`），`admin_routes.ts` 补齐 `/settings` 校验与下发；仅 `enabled && read_write && replayToolsEnabled` 三重门控全开时暴露 `memory_replay`。
  - 共享主链路与搬家状态机：逻辑作息日分组 `groupByLogicalNight` 下沉至 `mood/circadian.ts` 与 `scripts/replay.ts` 共用；`engine/tidy.ts` 导出上下文拼装与 `formatTidyTranscriptLine`；新增 `engine/replay_runner.ts`（状态存于 `task_cursors['mcp_replay']`，支持 `start`/`next`/`status`/`abort`、低量日顺延、按 `turn_id` 拆批并豁免全局 `maxOutputChars` 截断、步骤内按历史虚拟时钟写盘暂存、带匹配 `step_id` 调 `next` 统一单次 Git 提交并同步 `daily_wrapup`/`bedtime`/`reflect_daily`/`reflect_weekly` 与 `replay_state.json`，无 `step_id` 重连原样续接防跳步）；`core/git.ts` 新增精准回滚 `rollbackMemoryTouchedPaths`（绝不误删未跟踪杂文件）。
  - 路由与 CLI 闭环：`api/memory_mcp.ts` 挂载 `memory_replay`（全锁串行防并发竞态、完全豁免全局截断）并在搬家步骤内放行 `core/state.md`（周反思放行 `core/open.md`）；`index.ts` 回家关闭 MCP 时同步刷新内存 `lastBedtimeNightDate`；`scripts/memory_mcp.ts` 新增 `--replay`/`--no-replay` 与未收尾步骤关闭提醒；新增面向用户的 [docs/howto/memory-migration.md](docs/howto/memory-migration.md) 与 `tests/replay_mcp.test.ts`（6 组全离线用例）。
- **对外可开关记忆 MCP 工具层 · 第一阶段（`docs/` + `server/`，2026-11-26）**：
  - 契约与配置：更新 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/API.md](docs/API.md)；`core/config.ts` 新增 `memoryMcp` 配置与 `mergeMemoryMcpConfig`（`enabled`、`accessMode: read_only|read_write`、`allowRemote`、`protectCoreFiles`、`maxOutputChars`、`disabledTools`、仅存 `SHA-256` 哈希的专属 `tokens`）。
  - Streamable HTTP 服务端与工具：`api/memory_mcp.ts` 落地 `POST/DELETE /mcp`（开关关闭 `404` + 回环 IP 守卫 + `Origin` 防跨站 + 专属令牌鉴权）；暴露 `memory_context`、`memory_search`（向量/FTS5 + 1 跳双链邻居，零 LLM 费用）、`memory_glob`、`memory_grep`、`memory_read`（`countAccess: false`）、`memory_history`，以及 `read_write` 下受 `protectCoreFiles` 与共享 `memoryGitMutex` 保护的 `memory_write`/`memory_edit`（自动提交 `memory(mcp:<name>): ...`）；严禁触碰 `private/` 与 `events` 原始聊天库。
  - 出差互斥与 CLI 启停：`app.ts`/`admin_routes.ts`/`index.ts`/`engine/direct.ts` 实现开启 `memoryMcp` 后内部心跳与整理休眠、内部聊天写接口返 `409 MCP_ACTIVE`，关闭回家时自动 `reindexAll()` 并失效旧静态前缀；新增 `POST/DELETE /api/v1/memory-mcp/tokens`、`bun run start --mcp-only`（`PSYBER_MEMORY_MCP=1`）、`SIGUSR2` 热重载、CLI `server/scripts/memory_mcp.ts`（`bun run mcp`，支持 `--save-stdio` 写入 `0600` 令牌）与 `stdio` 转发桥 `server/scripts/mcp_stdio.ts`（`bun run mcp:stdio`）；补充 `tests/memory_mcp.test.ts`（6 组用例）。
- **附件并行摘要槽位（`digest`）、会话前缀锁与 `view_media` 按需复看（`docs/` + `server/` + `app/`，2026-11-26）**：
  - 并行摘要与防缓存击穿：新增 `engine/digest.ts`（显式配置 `llm.slots.digest` 时生效，不隐式回落主模型）与 `EventStore.setAttachmentDigestState`/`setAttachmentDigest`；`POST /api/v1/chat/messages` 与 `DirectEngine.executeTurn` 在发图/短视频瞬间与主模型并行起跑摘要（零首字延迟），并实时持久化 `pending` / `done` / `failed` 状态广播 SSE `message.updated`；新增 `POST /api/v1/chat/messages/:id/digest` 支持失败点击重试或手动重生成；`DirectEngine.buildHistoryMessages` 剥除历史 base64 改以 `[图片 media:<hash> · 摘要：...]` 呈现，并加会话级 `historyUserContentCache` 前缀锁杜绝异步晚到击穿 Prompt Cache；`engine/tidy.ts` 冷写整理同步注入 `attachmentDigest`。
  - 按需复看原图与前端微标：扩展 `ToolResult` 与 `llm/client.ts` `toolResult` 支持临时图片块；新增 Tier 3 只读工具 `extensions/view_media.ts`（`view_media(mediaId)`，仅在当轮工具结果载入原图，跨轮不落盘 base64 自动回收）；客户端时间线附件旁新增淡灰色三态微标（转圈中 / 淡灰勾点击看原文 / 淡灰提醒点击重试），同步更新 `docs/spec/01-engine-tools-prompts.md` §2.3、`app/` 设置页 `digest` 槽位说明与 `tests/attachment_digest.test.ts`（5 组用例）。
- **异步语音条与 Apple 原生实时识别（适配不方便打字场景，`docs/` + `server/` + `app/`，2026-11-26）**：
  - 契约与后端：更新 `docs/API.md`；`core/media.ts` 新增 `m4a`/`aac`/`wav` 音频映射；`api/app.ts` 与 `engine/direct.ts` 支持 `voiceClip: { mediaHash, durationSec, mimeType }` 校验、落盘、历史透出、重试/编辑/重摇透传及 `[语音 X秒]` 上下文标注（无转写文本亦允许发纯语音条）；新增 `tests/voice_clip.test.ts`。
  - iOS & macOS 原生桥接：`AppDelegate.swift` 与 `MainFlutterWindow.swift` 新增 `psyber/voice` 通道（`AVAudioEngine` 同步录 AAC `.m4a` + `SFSpeechRecognizer` 实时流式识别与长停顿无缝续接 + `AVAudioPlayer` 本地缓存回放）；补齐双端 `Info.plist` 麦克风/语音识别权限说明与 macOS `com.apple.security.device.audio-input` 沙盒权限。
  - 客户端交互：`core/media/voice_bridge.dart`、`voice_tile.dart`、`adaptive_composer.dart`、`timeline_items.dart` 与 `chat_page.dart` 落地「按住说松手直发（左滑取消 / 上滑锁定免提）」「轻点进入免提录音（可停顿思考、实时看转写、一键转文字编辑或直发）」「macOS `⌘⇧M` 快捷切换 + `Enter` 发 / `Esc` 取消」及气泡内原声语音条回放；补充 `psyber_app_test.dart` 语音条单测。
- **快脑只读体检雷达（Memory Radar · 严守 NG-2 只读不代写，`docs/` + `prompts/` + `server/`，2026-11-26）**：
  - 契约与提示词：更新 `docs/MEMORY.md`、`docs/API.md`、`docs/spec/01-engine-tools-prompts.md`、`docs/spec/02-memory-execution.md` §6.1 与 `docs/spec/04-api-and-flutter.md`；新增 `prompts/memory-radar.md`（v2，`slot: decision`，`contradiction`/独立 `promote`/`obsolete`/`link`/`redundant`/`representation` + `core/{state,open}.md` 看板巡检双边判据），同步更新 `prompts/tidy.md`（v11）、`prompts/reflect.md`（v3）与 `prompts/README.md`。
  - 共享向量与只读引擎：抽出 `memory/embeddings.ts`（单次批量加载 `card_embeddings` 缓存、对齐解码与分块保留部分向量）；新增 `memory/radar.ts`（两路扫描：双看板各保底 6 条配额巡检 + 向量/FTS5 配对受控并发体检，`card_links` 内存邻接表短路 `link` 且跳过「新持久专卡 ↔ 已互链旧 `ep-*`」溯源对，历史 `ep-*.md` 屏蔽 `obsolete`/`merge`、仅持久专卡互比问 `redundant`/`representation`，`weekly` 支持同周跨日新卡互配，修复占位词正则误伤、FTS 跳过预算计数、`ob_b0`/`ct_b0` 模板去重与 `AbortSignal` 即时中止）。
  - 管线接入与配置：`config.ts` / `admin_routes.ts` 新增 `radar` 独立配置（防 `undefined`/`null`/数组污染）与 `/settings` 校验合并；接入 `engine/tidy.ts`（`bedtime` Step 2，非反思轮隔离 `lessons/`/`core/` 提炼引导）与 `engine/reflect.ts`（`reflect_weekly` 及日/周反思门控 `reflectGateHint`）；同步 `index.ts`、`scripts/replay.ts`，新增 `scripts/dryrun_radar.ts`（`bun run radar:dryrun`，带 `~/` 展开与正式库拦截）与 `tests/memory_radar.test.ts`（7 组单测）。
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
- 随内置 `browser`（Ring 2）一起落地安全凭证储存库（复用 `0600` `credentials.json`，域名强绑定 + 盲填工具，AI 读不到密码但能用）。
- 按需拓展：Flutter 设置页补齐 `memoryMcp` 开关与令牌管理 UI；如需全自动挂机批量搬家，可在 `memory_replay` 之上薄包一层 CLI 循环驱动脚本。
- 语音下一期：不看屏幕 / 戴耳机场景下的「回复自动朗读（TTS / 系统语音）」开关与可选云端 STT 槽位。
- 按需推进 Ring 1.5 剩余项：多端点竞速、GFS 三级备份与 `export`/`restore` CLI、观影结束自动派发 `activity:cinema` 专题整理轮。

## 2. 验证结果
- **`server/`（2026-11-28）**：`bun run typecheck` 零错误；`bun test`（32 文件 / 148 用例 / 2191 断言，含 `tests/memory_fading.test.ts` 3 用例）全部通过。
- **`app/`（2026-11-28）**：`flutter analyze` 零问题；`flutter test`（31 用例）全部通过。
