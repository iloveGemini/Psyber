# Psyber 前后端 API 契约（API）

> **版本**：v0.7（2026-11-20，统一 Ring 1 精确端点与 SSE 计数：15 个 REST + 1 个 SSE = 16 个核心端点，8 类 SSE 事件 + `ping`，拆分合并行）
> **原则**：极简、版本化、面向 Flutter 多端（支持本机/局域网/公网选路、断线重连与离线安全降级），严禁泄露底层内部字段。

---

## 1. 通用约定

- **协议**：REST JSON (`/api/v1/*`) + 单一长连接 SSE (`/api/v1/stream`)
- **鉴权**：除 `/api/v1/health` 与 `/api/v1/auth/pair` 外，全部请求携带 `Authorization: Bearer <token>`（SSE `/api/v1/stream` 与媒体 `/api/v1/media/:hash` 额外支持 Query `?token=` 或短期签名参数，以兼容 Web 图片/视频组件）。
- **错误格式**：统一返回 `{ "error": { "code": "STRING_CODE", "message": "可读中文提示" } }`。
- **时间格式**：时间戳统一 Unix 毫秒整数（`epochMs`），客户端按本地时区渲染。

---

## 2. 端点总览（全量 29 个核心端点；**Ring 1 极简 MVP 仅落标 `Ring 1` 的 15 个 REST + 1 个 SSE = 16 个核心端点**）

### 2.1 健康检查、设备配对、OAuth 授权、门状态与初生引导（Onboarding / Genesis）

| 方法与路径 | 分期 | 说明 |
| :--- | :--- | :--- |
| `GET /api/v1/health` | **Ring 1** | 非阻塞探活与服务端版本（要求 `< 20ms`） |
| `POST /api/v1/auth/pair` | **Ring 1** | 新设备使用桌面端/CLI 生成的一次性配对码兑换长期 Bearer Token |
| `POST /api/v1/auth/oauth/:provider/start` | Ring 1.5 | 发起 `pi-ai` 订阅 OAuth 登录（PKCE 或 Device Code，Ring 1 先用 BYOK / 本机凭证） |
| `POST /api/v1/auth/oauth/:provider/exchange` | Ring 1.5 | 提交回调授权码或轮询 Device Code 完成 OAuth Token 落盘 |
| `GET /api/v1/door` | **Ring 1** | 获取当前门状态（Ring 1 为 `open`/`quiet`/`closed`，Ring 2 扩展后两态）、门牌便签与未读门缝纸条数 |
| `GET /api/v1/genesis` | **Ring 1** | 查询住户初始化状态（凭证、基础称呼、作息窗） |
| `POST /api/v1/genesis` | **Ring 1** | 提交初始化配置（支持空白中性开局，前几轮对话自然定名） |

### 2.2 聊天、门缝留言、消息生命周期与工具审批

| 方法与路径 | 分期 | 说明 |
| :--- | :--- | :--- |
| `GET /api/v1/chat/history?before=<id>&limit=50` | **Ring 1** | 分页拉取时间线（含对话、门缝留言、具身表达元数据、可折叠 `✦ 整理记忆` 静默任务卡；媒体仅返回 URL，**严禁内联 base64**；断线重连可直接拉取补齐） |
| `POST /api/v1/chat/messages` | **Ring 1** | 发送用户消息（携带 `clientMessageId` 幂等键防重发，可附 `attachments`、`stickerId`）；门为 `closed` 时自动作为「门缝纸条」落盘不唤醒回复；上下文达阈值时直接切新会话并后台异步整理，不阻塞前台发消息 |
| `DELETE /api/v1/chat/messages/:id` | **Ring 1** | 软删消息（标记 `deleted`，不污染后续记忆整理） |
| `POST /api/v1/turns/:turnId/abort` | **Ring 1** | 主动中止正在生成的对话轮或工具循环（保留已落盘的部分内容） |
| `POST /api/v1/chat/messages/:id/edit` | Ring 1.5 | 编辑最后一条用户消息并重新生成（`closed`/`cooling_off` 时仅允许编辑 `door_note` 不唤醒） |
| `POST /api/v1/chat/messages/:id/reroll` | Ring 1.5 | 重摇助手回复（保留版本组，可切版本） |
| `POST /api/v1/chat/messages/:id/version` | Ring 1.5 | 切换同一 `group_id` 的历史版本 |
| `POST /api/v1/turns/:turnId/approval` | Ring 2 | 响应高风险工具审批（`bash` / `browser` / 外部 MCP 确认卡） |

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
- **Ring 1.5 / Ring 2 扩展事件**：`message.updated`（版本切换/编辑）、`turn.tool`（折叠工具进度）、`turn.approval_required` / `turn.approval_resolved`、`activity.updated`、`sync.reset`。

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

### 2.6 活动扩展、媒体、表情包、推送与设置

| 方法与路径 | 分期 | 说明 |
| :--- | :--- | :--- |
| `POST /api/v1/media` | **Ring 1** | 上传用户图片/多模态附件（SHA-256 去重落盘 `media/`，返回 `{ hash, url, mimeType, size }`） |
| `GET /api/v1/media/:hash` | **Ring 1** | 按 SHA-256 哈希拉取图片与贴纸（带 `ETag` + `Cache-Control: immutable`） |
| `GET /api/v1/settings` | **Ring 1** | 读取脱敏配置快照（模型槽位、作息窗、通知与设备概览，严禁返回明文密钥） |
| `PATCH /api/v1/settings` | **Ring 1** | 更新模型槽位/新 BYOK `apiKey`（落 `credentials.json`）、作息窗与通知配置（Ring 1.5 补 MCP 与设备吊销） |
| `GET /api/v1/activities` | Ring 1.5 | 列出已加载的 `ActivityPlugin` 当前状态 + `REGISTRY.yaml` 空间概览 |
| `GET /api/v1/stickers` / `POST /api/v1/stickers` | Ring 1.5 | 动态管理/上传互发表情贴纸包（Ring 1 读静态 `stickers/` 目录） |
| `POST /api/v1/devices/push-token` | Ring 1.5 | 注册或更新单设备离线推送令牌（Ring 1 用全局 `desktop` + `webhook`） |

---

## 3. 观影扩展子路由（Ring 1.5 首个 `ActivityPlugin`: `cinema`）

挂载于 `/api/v1/activities/cinema/*`，完全隔离在扩展模块内：
- `POST /api/v1/activities/cinema/start` — 开启观影会话（片名/来源/集数），激活 `activityHint: "cinema"`
- `POST /api/v1/activities/cinema/frame` — 上报当前进度与可选抽帧画面（存 `media/` 返回 hash）
- `POST /api/v1/activities/cinema/end` — 结束观影，自动触发 `activities/cinema/` 独立整理任务

---

## 4. 客户端断线与性能红线（吸收自过往长连接客户端实战教训）

1. **历史接口绝不内联大图/视频**：媒体资产一律存 `media/` 按哈希 URL 拉取，单页历史响应控制在 `< 200 KB`。
2. **后台静默重连不弹红条**：Flutter 切前后台时自动中止并合并重试 SSE 与拉取，静默忽略预期内的连接取消错误。
3. **非阻塞健康探活**：`/api/v1/health` 不扫磁盘、不调外部进程，保证多地址竞速选路瞬时完成。
