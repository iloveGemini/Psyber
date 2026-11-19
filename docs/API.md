# Psyber 前后端 API 契约（API）

> **版本**：v0.4（2026-11-19，明确 `wake` `[SILENT]` 延后广播 `turn.start`/`turn.thinking` 与 `CONTEXT_OVERFLOW` 换段整理忙态不改 `door_state`，与 [`CAPABILITIES.md`](CAPABILITIES.md) v1.2 及 [`ARCHITECTURE.md`](ARCHITECTURE.md) v0.5 一致）
> **原则**：极简、版本化、面向 Flutter 多端（支持本机/局域网/公网选路、断线重连与离线安全降级），严禁泄露底层内部字段。

---

## 1. 通用约定

- **协议**：REST JSON (`/api/v1/*`) + 单一长连接 SSE (`/api/v1/stream`)
- **鉴权**：除 `/api/v1/health` 与 `/api/v1/auth/pair` 外，全部请求携带 `Authorization: Bearer <token>`（SSE `/api/v1/stream` 与媒体 `/api/v1/media/:hash` 额外支持 Query `?token=` 或短期签名参数，以兼容 Web 图片/视频组件）。
- **错误格式**：统一返回 `{ "error": { "code": "STRING_CODE", "message": "可读中文提示" } }`。
- **时间格式**：时间戳统一 Unix 毫秒整数（`epochMs`），客户端按本地时区渲染。

---

## 2. 端点总览（共 29 个核心端点：28 REST + 1 SSE）

### 2.1 健康检查、设备配对、OAuth 授权、门状态与初生引导（Onboarding / Genesis）

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/v1/health` | 非阻塞探活与服务端版本（供 Flutter 多地址竞速选路，要求 `< 20ms`） |
| `POST /api/v1/auth/pair` | 新设备使用桌面端/CLI 生成的一次性配对码或二维码载荷兑换长期 Bearer Token |
| `POST /api/v1/auth/oauth/:provider/start` | 发起 `pi-ai` 订阅 OAuth 登录（返回浏览器授权 URL / PKCE 或 Device Code 载荷，支持远端 Flutter 端触发） |
| `POST /api/v1/auth/oauth/:provider/exchange` | 提交回调授权码或轮询 Device Code 完成 OAuth Token 落盘与激活 |
| `GET /api/v1/door` | 获取当前门状态（`open` / `quiet` / `closed` / `cooling_off` / `departed`）、门牌便签、未读门缝纸条数及告别信（仅 `departed`） |
| `GET /api/v1/genesis` | 查询住户初始化状态（OAuth/BYOK 凭证、基础称呼、作息窗） |
| `POST /api/v1/genesis` | 提交初始化配置（支持空白中性开局，前几轮对话自然定名） |

### 2.2 聊天、门缝留言、消息生命周期与工具审批

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/v1/chat/history?before=<id>&limit=50` | 分页拉取时间线（含对话、门缝留言、具身表达元数据、可折叠 `✦ 整理记忆` 静默任务卡、扩展富卡片；媒体仅返回 URL，**严禁内联 base64**） |
| `POST /api/v1/chat/messages` | 发送用户消息（携带 `clientMessageId` 幂等键防重发，可附 `activityHint`、`attachments`、`stickerId`）；门为 `closed`/`cooling_off` 时自动作为「门缝纸条」落盘不唤醒回复；若处于 `CONTEXT_OVERFLOW` 系统级换段整理忙态（不改 `door_state`），消息仍按 `chat` 正常入待回复队列，整理完成后自动回复；`departed` 时返回 `410 GONE` |
| `POST /api/v1/chat/messages/:id/edit` | 编辑最后一条用户消息并重新生成（`closed`/`cooling_off` 时拒绝以防绕过关门强行唤醒，`departed` 时返回 `410 GONE`） |
| `POST /api/v1/chat/messages/:id/reroll` | 重摇助手回复（保留版本组，可切版本；`closed`/`cooling_off` 时拒绝，`departed` 时返回 `410 GONE`） |
| `POST /api/v1/chat/messages/:id/version` | 切换同一 `group_id` 的历史版本 |
| `DELETE /api/v1/chat/messages/:id` | 软删消息（标记 `deleted`，不污染后续记忆整理；`departed` 时返回 `410 GONE`） |
| `POST /api/v1/turns/:turnId/abort` | 主动中止正在生成的对话轮或工具循环（保留已落盘的部分内容或安全回滚待定审批） |
| `POST /api/v1/turns/:turnId/approval` | 响应高风险工具审批（如 `bash` / `browser` 确认卡）：`{ approvalId, decision: "allow" \| "deny", scope?: "once" \| "session" }` |

### 2.3 实时事件流（SSE）

- `GET /api/v1/stream?lastEventId=<seq>`
- 单连接推送全部实时态，支持 `Last-Event-ID` 断线续传：
  - `message.created` / `message.updated` — **多端实时同步事件**（任一客户端发消息、编辑、切换版本或软删时广播给其他在线终端）
  - `door.updated` — **门与关系状态变更**（`open` / `quiet` / `closed` / `cooling_off` / `departed`、门牌便签）
  - `turn.start` — 新一轮开始（`mode: "chat" | "wake" | "memory_task" | "solitary"`, `label?: "整理观影记忆"`；注：`wake` 模式在前 16 字符确认非 `[SILENT]` 或产生实质 `express` 等工具调用前**暂缓广播 `turn.start` 与 `turn.thinking`**，确认开口后再补推）
  - `turn.thinking` — 流式思考增量（`delta`；`wake` 模式下随 `turn.start` 一并暂缓至确认非 `[SILENT]` 后推送）
  - `turn.expression` — **具身身体语言事件**（`haptic` / `atmosphere` / `motion` / `stickerId`，供 Flutter Expression Renderer 实时响应）
  - `turn.tool` — 工具调用折叠摘要（如 `read activities/cinema/xxx.md` 或 `call_tool browser.open`）
  - `turn.approval_required` / `turn.approval_resolved` — 高风险工具审批挂起与多端同步结果（`approvalId`, `decision`, `toolName`, `summary`, `expiresAt`）
  - `turn.text` — 流式正文增量（`delta`）
  - `turn.error` — 结构化异常通知（`AUTH_EXPIRED` / `RATE_LIMITED` / `PROVIDER_ERROR` / `CONTEXT_OVERFLOW`）
  - `turn.done` — 本轮结束（含最终 `messageId`、本轮召回计数 `recallCount`、生成媒体列表）
  - `activity.updated` — 活动扩展状态变更（如观影卡片/进度更新）
  - `sync.reset` — 当客户端断线过久、`lastEventId` 超出服务端内存环形缓冲时下发，引导客户端全量重拉 `/chat/history`、`/door` 与 `/activities`
  - `ping` — 每 25 秒保活心跳

### 2.4 召回评测与反馈（评测模式专用）

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/v1/turns/:turnId/recall` | 获取某轮回复实际命中的常规记忆召回清单（**绝不包含 `private/` 抽屉文件**），供客户端评测浮条按需展开 |
| `POST /api/v1/recall/feedback` | 提交单条标注：`{ turnId, cardPath?, verdict: "useful" \| "noisy" \| "missed", note? }` |
| `GET /api/v1/recall/stats` | 获取累计标注统计与各轨道命中率摘要 |

### 2.5 上锁抽屉（私密空间 · 拆封必留痕）

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/v1/drawer` | 列举抽屉里的封蜡条目清单（仅返回 `id`、标题/时间与封条状态，**不返回正文**） |
| `POST /api/v1/drawer/:id/open` | 显式拆封阅读某篇私密内容（前端须二次确认）；解码返回正文并**强制向 `events` 写入 `privacy.peeked` 事件告知 AI** |

### 2.6 活动扩展、媒体、表情包、推送与设置

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /api/v1/activities` | 列出已加载的 `ActivityPlugin` 当前状态 + `REGISTRY.yaml` 空间概览 |
| `POST /api/v1/media` | 上传用户图片/多模态附件（`multipart/form-data`，按 SHA-256 去重落盘至 `media/` 并返回 `{ hash, url, mimeType, size }` 供发消息引用） |
| `GET /api/v1/media/:hash` | 按 SHA-256 哈希拉取图片、观影帧、轻量生图/生视频产物（带 `ETag` + `Cache-Control: immutable`） |
| `GET /api/v1/stickers` / `POST /api/v1/stickers` | 列出或上传互发表情贴纸包（供用户和 AI 通过 `express.stickerId` 共用） |
| `POST /api/v1/devices/push-token` | 注册或更新设备离线推送目标（Webhook / Bark / ntfy 或 Ring 2 APNs/FCM Token） |
| `GET /api/v1/settings` / `PATCH /api/v1/settings` | 读写 5 槽位模型路由（`chat`/`memory_task`/`vision`/`embedding`/`reranker`）、OAuth/BYOK 状态、作息窗、通知通道、工具权限策略、外部 MCP 列表 |

---

## 3. 观影扩展子路由（Ring 1 首个 `ActivityPlugin`: `cinema`）

挂载于 `/api/v1/activities/cinema/*`，完全隔离在扩展模块内：
- `POST /api/v1/activities/cinema/start` — 开启观影会话（片名/来源/集数），激活 `activityHint: "cinema"`
- `POST /api/v1/activities/cinema/frame` — 上报当前进度与可选抽帧画面（存 `media/` 返回 hash）
- `POST /api/v1/activities/cinema/end` — 结束观影，自动触发 `activities/cinema/` 独立整理任务

---

## 4. 客户端断线与性能红线（吸收自过往长连接客户端实战教训）

1. **历史接口绝不内联大图/视频**：媒体资产一律存 `media/` 按哈希 URL 拉取，单页历史响应控制在 `< 200 KB`。
2. **后台静默重连不弹红条**：Flutter 切前后台时自动中止并合并重试 SSE 与拉取，静默忽略预期内的连接取消错误。
3. **非阻塞健康探活**：`/api/v1/health` 不扫磁盘、不调外部进程，保证多地址竞速选路瞬时完成。
