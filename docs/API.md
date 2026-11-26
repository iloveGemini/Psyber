# Psyber 前后端 API 契约（API）

> **版本**：v0.8（2026-11-21，保持 Ring 1 15 REST + 1 SSE 零破坏；Ring 1.5/2 扩展端点补齐社交撤回、原地无痕重试、手动存记忆换段、主动分享卡拆阅回执、用户双人状态签、双人头像、模型发现与测试、消耗统计、观影四宫格/角色定妆小抄、透明感知账本与异步申请卡契约）
> **原则**：极简、版本化、面向 Flutter 多端（支持本机/局域网/公网选路、断线重连与离线安全降级），严禁泄露底层内部字段。

---

## 1. 通用约定

- **协议**：REST JSON (`/api/v1/*`) + 单一长连接 SSE (`/api/v1/stream`)
- **鉴权**：除 `/api/v1/health` 与 `/api/v1/auth/pair` 外，全部请求携带 `Authorization: Bearer <token>`（SSE `/api/v1/stream` 与媒体 `/api/v1/media/:hash` 额外支持 Query `?token=` 或短期签名参数，以兼容 Web 图片/视频组件）。
- **错误格式**：统一返回 `{ "error": { "code": "STRING_CODE", "message": "可读中文提示" } }`。
- **时间格式**：时间戳统一 Unix 毫秒整数（`epochMs`），客户端按本地时区渲染。

---

## 2. 端点总览（全量 43 个核心端点：42 REST + 1 SSE；**Ring 1 极简 MVP 仅落标 `Ring 1` 的 15 个 REST + 1 个 SSE = 16 个核心端点**）

### 2.1 健康检查、设备配对、OAuth 授权、门状态与初生引导（Onboarding / Genesis）

| 方法与路径 | 分期 | 说明 |
| :--- | :--- | :--- |
| `GET /api/v1/health` | **Ring 1** | 非阻塞探活与服务端版本（要求 `< 20ms`；含可选 `memoryMcpEnabled` 出差状态标识） |
| `POST /api/v1/auth/pair` | **Ring 1** | 新设备使用桌面端/CLI 生成的一次性配对码兑换长期 Bearer Token（按真实客户端 IP 限流 + Origin 防跨站） |
| `POST /api/v1/auth/local-pair` | **Ring 1.5** | 仅限本机桌面端免码配对（严格校验回环 IP、无浏览器 Origin 头及 `0600` `local_pair.json` 启动密钥） |
| `POST /api/v1/auth/pair-code` | **Ring 1.5** | 已配对设备签发 5 分钟一次性配对码与扫码二维码 JSON 载荷 `{ v: 1, urls, code }` |
| `POST /api/v1/auth/oauth/:provider/start` | Ring 1.5 | 发起 `pi-ai` 订阅 OAuth 登录（PKCE 或 Device Code，Ring 1 先用 BYOK / 本机凭证） |
| `POST /api/v1/auth/oauth/:provider/exchange` | Ring 1.5 | 提交回调授权码或轮询 Device Code 完成 OAuth Token 落盘 |
| `GET /api/v1/door` | **Ring 1** | 获取当前门状态（Ring 1 为 `open`/`quiet`/`closed`，Ring 2 扩展后两态）、门牌便签与未读门缝纸条数 |
| `GET /api/v1/genesis` | **Ring 1** | 查询Psyber初始化状态（凭证、基础称呼、作息窗） |
| `POST /api/v1/genesis` | **Ring 1** | 提交初始化配置（支持空白中性开局，前几轮对话自然定名） |

### 2.2 聊天、门缝留言、消息生命周期与工具审批

| 方法与路径 | 分期 | 说明 |
| :--- | :--- | :--- |
| `GET /api/v1/chat/history?before=<id>&limit=50` | **Ring 1** | 分页拉取时间线（含对话、门缝留言、具身表达元数据、可折叠 `✦ 整理记忆` 静默任务卡；媒体仅返回 URL，**严禁内联 base64**；断线重连可直接拉取补齐） |
| `POST /api/v1/chat/messages` | **Ring 1** | 发送用户消息（携带 `clientMessageId` 幂等键防重发，可附 `attachments`、`stickerId`、`videoClip`、`voiceClip: { mediaHash, durationSec, mimeType? }`、Ring 1.5 可选 `urgent: true` 仅于 `closed` 态一次性紧急直达）；门为 `closed` 且非紧急时自动作为「门缝纸条」落盘不唤醒回复；上下文达阈值时先同步整理旧会话再切新会话（期间新消息仍 `202` 排队落盘，切段后自动归属新段） |
| `DELETE /api/v1/chat/messages/:id` | **Ring 1** | 静默软删消息（修对话，标记 `deleted`，绝不告知Psyber，不污染后续记忆整理） |
| `POST /api/v1/turns/:turnId/abort` | **Ring 1** | 主动中止正在生成的对话轮或工具循环（保留已落盘的部分内容） |
| `POST /api/v1/turns/:turnId/retry` | Ring 1.5 | 失败轮次原地无痕重试（不重复插入用户消息，避免聊天流出现重复气泡） |
| `POST /api/v1/chat/messages/:id/edit` | Ring 1.5 | 静默编辑最后一条用户消息并重新生成（`closed`/`cooling_off` 时仅允许编辑 `door_note` 不唤醒） |
| `POST /api/v1/chat/messages/:id/reroll` | Ring 1.5 | 静默重摇助手回复（保留版本组，可切版本，绝不告知Psyber） |
| `POST /api/v1/chat/messages/:id/version` | Ring 1.5 | 切换同一 `group_id` 的历史版本 |
| `POST /api/v1/chat/messages/:id/retract` | Ring 1.5 | 双向社交撤回（用户撤回自己的消息，置 `status='retracted'`，Psyber仅见占位不知原文；与静默 `DELETE` 严格区分） |
| `POST /api/v1/chat/wrap-up` | Ring 1.5 | 用户手动触发「存记忆换段」：先同步完成旧会话 `daily_wrapup` 整理再切新 `session_id`（前端显示「正在收拢这段记忆…」） |
| `POST /api/v1/shares/:id/open` | Ring 1.5 | 用户首次点开Psyber递出的折叠分享卡（`ShareCard`）时上报拆阅回执，写入 `share.opened` 并告知Psyber |
| `POST /api/v1/turns/:turnId/approval` | Ring 2 | 响应同步高风险工具审批（`bash` / `browser` / 外部 MCP 120s 实时确认卡） |
| `GET /api/v1/requests` | Ring 2 | 获取待处理与近期的异步申请卡列表（高敏健康数据、未授权本机目录访问等） |
| `POST /api/v1/requests/:id/decide` | Ring 2 | 响应异步申请卡（`approve` 仅本次 / `allow_today` 今天都允许 / `decline` 不了） |

### 2.3 实时事件流（SSE）

- `GET /api/v1/stream`（**Ring 1** 仅需单连接实时推流，断线重连后由客户端直接拉 `/api/v1/chat/history` 与 `/api/v1/door` 补齐；`streamSeq` 500 条内存环形缓冲与 `sync.reset` 延后至 **Ring 1.5**）：
- **Ring 1 核心事件（8 类 + `ping`）**：
  - `message.created` — 新消息 / 门缝纸条 / 助手落盘同步
  - `door.updated` — 门状态与门牌便签变更
  - `turn.start` — 新一轮开始（`mode: "chat" | "wake" | "memory_task"`；`wake` 模式在前 16 字符确认非 `[SILENT]` 前暂缓广播）
  - `turn.thinking` — 流式思考增量（`wake` 模式下随 `turn.start` 一并暂缓）
  - `turn.expression` — 具身身体语言事件（`haptic` / `atmosphere` / `motion` / `stickerId`）
  - `turn.text` — 流式正文增量（`delta`）
  - `turn.done` — 本轮结束（含 `messageId`、`recallCount`、`aborted?`）
  - `turn.error` — 结构化异常（`AUTH_EXPIRED` / `RATE_LIMITED` / `PROVIDER_ERROR` / `CONTEXT_OVERFLOW`）
  - `ping` — 每 25 秒保活心跳
- **Ring 1.5 / Ring 2 扩展事件**：`message.updated`（版本切换/编辑/软删/社交撤回）、`turn.tool`（同轮手账聚合工具进度）、`turn.rollover`（同步换段收尾中/完成/失败状态提示）、`turn.silence`（独处/唤醒主动沉默极轻痕迹）、`turn.model_switched`（主备模型切换点提示）、`turn.approval_required` / `turn.approval_resolved`、`share.opened`、`user_status.updated`、`memory_mcp.updated`（出差互斥模式开关或读写模式变更）、`request.created` / `request.decided`、`activity.updated`、`sync.reset`。

### 2.4 召回评测与反馈（评测模式专用）

| 方法与路径 | 分期 | 说明 |
| :--- | :--- | :--- |
| `GET /api/v1/turns/:turnId/recall` | **Ring 1** | 获取某轮回复实际命中的常规记忆召回清单，供客户端评测浮条按需展开 |
| `POST /api/v1/recall/feedback` | **Ring 1** | 提交单条标注：`{ turnId, cardPath?, verdict: "useful" \| "noisy" \| "missed", note? }` |
| `GET /api/v1/recall/stats` | Ring 1.5 | 获取累计标注统计与各轨道命中率摘要 |

### 2.5 上锁抽屉（私密空间 · 拆封必留痕 · Ring 1.5）

| 方法与路径 | 分期 | 说明 |
| :--- | :--- | :--- |
| `GET /api/v1/drawer` | Ring 1.5 | 列举抽屉里的封蜡条目清单（不返回正文） |
| `POST /api/v1/drawer/:id/open` | Ring 1.5 | 显式拆封阅读某篇私密内容并强制写入 `privacy.peeked` 事件告知 AI |

### 2.6 活动扩展、媒体、贴纸、模型与用量、用户状态、感知账本与设置

| 方法与路径 | 分期 | 说明 |
| :--- | :--- | :--- |
| `POST /api/v1/media` | **Ring 1** | 上传用户图片/音频/多模态附件（含 `audio/mp4` / `audio/m4a` 等异步语音条音频，SHA-256 去重落盘 `media/`，返回 `{ hash, url, mimeType, size }`） |
| `GET /api/v1/media/:hash` | **Ring 1** | 按 SHA-256 哈希拉取图片、头像与贴纸（带 `ETag` + `Cache-Control: immutable`） |
| `GET /api/v1/settings` | **Ring 1** | 读取脱敏配置快照（模型槽位、召回与只读体检雷达 `recall`/`radar`、对外记忆 MCP `memoryMcp`、作息窗、通知与设备概览，严禁返回明文密钥或哈希） |
| `PATCH /api/v1/settings` | **Ring 1** | 更新模型槽位/新 BYOK `apiKey`（落 `credentials.json`）、`recall`/`radar` 召回与体检参数、`memoryMcp` 开关与权限配置、作息窗与通知配置（Ring 1.5 补 `digest`/主备降级链/思考档位/双上下文上限/`bash`/MCP 与设备吊销） |
| `GET /api/v1/activities` | Ring 1.5 | 列出已加载的 `ActivityPlugin` 当前状态 + `REGISTRY.yaml` 空间概览 |
| `GET /api/v1/stickers` / `POST /api/v1/stickers` | Ring 1.5 | 动态管理/上传互发表情贴纸包（Ring 1 读静态 `stickers/` 目录） |
| `POST /api/v1/devices/push-token` | Ring 1.5 | 注册或更新单设备离线推送令牌（Ring 1 用全局 `desktop` + `webhook`） |
| `GET /api/v1/llm/models` / `POST /api/v1/llm/test` | Ring 1.5 | 按已配置 Provider 自动发现可用模型（含上下文窗口、思考档位能力）并一键测试连通性 |
| `GET /api/v1/usage/stats` | Ring 1.5 | 设置页消耗统计（今日/累计/按日/按模型 Token 消耗、估算费用与 Prompt Cache 命中率；绝不常驻主聊天面） |
| `GET /api/v1/user-status` / `PATCH /api/v1/user-status` | Ring 1.5 | 读取或更新用户侧双人状态签（手动心绪短句 + 勿扰开关，勿扰态抑制非紧急 `wake`） |
| `POST /api/v1/avatars/:who` | Ring 1.5 | 上传用户或Psyber头像（`:who` 为 `user` 或 `resident`，SHA-256 落盘 `media/`） |
| `GET /api/v1/perception/ledger` | Ring 2 | 读取「透明感知账本」（列出Psyber此刻可见的全部感知快照、看屏次数/理由、健康申请历史与双方留意程度） |
| `DELETE /api/v1/perception/ledger/:scope` | Ring 2 | 分项一键彻底擦除感知账本（`screen` / `mobile` / `health` / `all`；擦除权永久归用户） |

---

## 3. 观影扩展子路由（Ring 1.5 首个 `ActivityPlugin`: `cinema`）

挂载于 `/api/v1/activities/cinema/*`，完全隔离在扩展模块内：
- `POST /api/v1/activities/cinema/start` — 开启观影会话（片名/来源/集数），激活 `activityHint: "cinema"`
- `POST /api/v1/activities/cinema/frame` — 上报当前进度、可选字幕、单帧或 **2×2 四宫格分镜图**（存 `media/` 返回 hash）及可选角色定妆小抄同步
- `POST /api/v1/activities/cinema/end` — 结束观影，自动触发 `activities/cinema/` 独立整理任务

---

## 3.5 对外记忆 MCP 服务（Streamable HTTP · 可开关出差模式）

用于向外部第三方客户端（如 Cursor、Claude Code 等）按需暴露记忆检索与受控读写能力。默认关闭且支持零重启热切换：

- **传输端点**：`POST /mcp`（JSON-RPC 2.0，Streamable HTTP，`initialize` 签发 `mcp-session-id`；`notifications/*` 返回 `202`）、`DELETE /mcp`（关闭会话返 `204`）、`GET /mcp`（返回 `405`）。非 `initialize` 请求若携带 `mcp-session-id`，须命中当前令牌对应的活跃会话（已关闭、伪造或跨令牌返回 `404`）；未携带 `mcp-session-id` 时兼容无状态调用。
- **本地 `stdio` 薄代理入口（`bun run mcp:stdio`）**：[server/scripts/mcp_stdio.ts](file:///Users/joy/workspace/Psyber/server/scripts/mcp_stdio.ts) 将标准输入输出 JSON-RPC 2.0 行流透明转发至本机 `/mcp`，不直连 SQLite 或 `memory/.git`；主服务关闭 `memoryMcp` 后立即失效。
- **四道安全防线**：
  1. `memoryMcp.enabled === false` 时统一返回 `404`；
  2. `memoryMcp.allowRemote === false`（默认）仅放行本机回环 IP，非回环返回 `403`；
  3. 携带 `Origin` 头时执行同源 / 白名单防跨站校验，非法返回 `403`；
  4. 仅接受 `Authorization: Bearer <token>` 中的专属 MCP 令牌（`psbm_...`），不接受 Query 参数或设备配对 Token；无效返回 `401`。MCP 令牌亦不可访问 `/api/v1/*`。
- **出差互斥保护**：当 `memoryMcp.enabled = true` 时，内部作息心跳与整理暂停，`POST /api/v1/chat/messages`、`POST /api/v1/chat/wrap-up`、`POST /api/v1/turns/:turnId/retry`、`POST /api/v1/chat/messages/:id/edit`、`POST /api/v1/chat/messages/:id/reroll` 统一返回 `409 MCP_ACTIVE`。
- **令牌管理端点（需设备配对 Bearer Token）**：
  - `POST /api/v1/memory-mcp/tokens` — 签发新外部客户端令牌（`{ name, accessMode? }`，响应一次性返回明文 `token` 与脱敏 `tokenInfo`）
  - `DELETE /api/v1/memory-mcp/tokens/:id` — 立即吊销指定 MCP 令牌
- **暴露工具**：
  - 只读（`read_only` / `read_write`）：`memory_context`、`memory_search`（向量/FTS5 + 1 跳双链邻居，零额外 LLM 成本）、`memory_glob`、`memory_grep`、`memory_read`（`countAccess: false`）、`memory_history`；
  - 写入（仅 `read_write` 且令牌未降权时在 `tools/list` 暴露）：`memory_write`、`memory_edit`（受 `protectCoreFiles` 与 `MemoryTools` 沙箱保护，写后自动提交带来源标记的 Git Commit）。

---

## 4. 客户端断线与性能红线（吸收自过往长连接客户端实战教训）

1. **历史接口绝不内联大图/视频**：媒体资产一律存 `media/` 按哈希 URL 拉取，单页历史响应控制在 `< 200 KB`。
2. **后台静默重连不弹红条**：Flutter 切前后台时自动中止并合并重试 SSE 与拉取，静默忽略预期内的连接取消错误。
3. **非阻塞健康探活**：`/api/v1/health` 不扫磁盘、不调外部进程，保证多地址竞速选路瞬时完成。
