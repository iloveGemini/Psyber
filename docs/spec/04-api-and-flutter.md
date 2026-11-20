# Spec 04 · REST/SSE 精确契约、多端同步、消息版本状态机与 Flutter 客户端架构规程

> **版本**：v0.4（2026-11-20，彻底移除已砍掉的 `systemBusy` 前台忙态与 `409 SYSTEM_BUSY`、补齐 `POST /genesis` 一步传入 BYOK `apiKey`、统一 Ring 1 15 REST + 1 SSE 与 8 类 SSE 事件计数并拆分 §6 验收清单）
> **上游契约**：[`CAPABILITIES.md`](../CAPABILITIES.md) v1.3 · [`ARCHITECTURE.md`](../ARCHITECTURE.md) v0.7 · [`MEMORY.md`](../MEMORY.md) v0.7 · [`API.md`](../API.md) v0.7 · [`01-engine-tools-prompts.md`](01-engine-tools-prompts.md) v1.1 · [`02-memory-execution.md`](02-memory-execution.md) v0.7 · [`03-boundaries-expression-activities.md`](03-boundaries-expression-activities.md) v0.4
> **负责模块**：`server/src/api/`、`server/src/store/`、`app/lib/`

---

## 0. 模块依赖与前后端边界护栏

- **服务端（`server/src/api/`）**：Hono 路由层只负责参数校验、Bearer Token 鉴权、SSE 广播封装与 HTTP 错误码映射，**严禁在路由层直接拼接 Prompt、直写 `memory/` 磁盘或复制召回/锁逻辑**；全部业务经由 `engine/`、`store/`、`memory/`、`expression/`、`extensions/` 导出方法调用。
- **客户端（`app/lib/`）**：严格遵守「窗不跑生活」（C6.1），Flutter 客户端只管展示、输入、多地址选路、断线续传与具身渲染，**绝不在 Dart 侧复制召回打分、游标判定、冷静期计时或权限校验逻辑**。
- **通用响应约定**：
  - 所有时间戳为 Unix 毫秒整数（`epochMs: number`）；
  - 所有错误统一返回 `{ "error": { "code": string, "message": string, "details"?: unknown } }`；
  - 所有媒体资产均返回相对路径 `/api/v1/media/<sha256>`，**历史接口严禁内联 base64**（单页响应 `< 200 KB`）；
  - **两套序号严格隔离**：`eventSeq` 为 SQLite `events.seq`（持久事件表序号）；`streamSeq` 为 SSE 内存环形缓冲序号（含 `turn.text` 等瞬态流帧），两者绝不混用。

---

## 1. 设备配对、鉴权与令牌安全规程

### 1.1 一次性配对码与长期 Bearer Token

1. **配对码生成（服务端本机 / CLI）**：
   - 启动 `server/` 首次无设备时，或在终端运行 `psyber pair`（等同 `bun run pair`，桌面端设置页也可触发），服务端在内存中生成一次性配对载荷：`code`（8 位 Crockford Base32，如 `K7M9-P2XQ`）、`expiresAt = Clock.now() + 300_000`（5 分钟有效）、`singleUse = true`；
   - 二维码内容为轻量 JSON：`{ "v": 1, "urls": ["http://192.168.x.x:3721", ...], "code": "K7M9-P2XQ" }`（仅在扫描后由客户端调用配对接口兑换 Token，二维码本身不含长期密钥）。
2. **兑换令牌（`POST /api/v1/auth/pair`）**：
   - 请求体：`{ "code": string, "deviceName": string, "platform": "macos" | "ios" | "android" | "windows" | "web" }`；
   - 校验通过后立即销毁一次性 `code`，生成 32 字节加密随机 `token`（前缀 `psb_`），**仅将 `SHA-256(token)`** 与 `{ deviceId, deviceName, platform, createdAt, lastSeenAt }` 存入 `<dataDir>/config.json` 的 `auth.devices[]`（绝不明文落盘 Token）；
   - 响应 `200 OK`：`{ "deviceId": string, "token": string, "instanceId": string, "serverVersion": string }`（同步返回 `instanceId` 供客户端持久化用于后续多地址防串连校验）；
   - 失败错误码：`401 PAIR_CODE_INVALID` / `410 PAIR_CODE_EXPIRED` / `429 PAIR_RATE_LIMITED`（单 IP 5 分钟内失败 5 次锁定 10 分钟）。
3. **请求鉴权与设备吊销**：
   - 常规 REST：请求头 `Authorization: Bearer <token>`；
   - SSE `/api/v1/stream` 与媒体 `/api/v1/media/:hash`（兼容 Web `EventSource` / `<img>` 无法带自定义 Header 的场景）：优先读 `Authorization` 头，其次允许 Query `?token=<token>`（服务端访问日志必须自动脱敏 `token=` 参数，绝不打印明文）；
   - **设备吊销**：通过 `PATCH /api/v1/settings` 提交 `revokeDeviceIds: string[]`，服务端立即从 `auth.devices[]` 移除对应设备、删除 `credentials.json` 中的 `pushTokens[deviceId]`，并主动关闭该设备的全部活跃 SSE 连接。
4. **错误码**：缺失、无效或已吊销令牌统一返回 `401 UNAUTHORIZED`。

---

## 2. 全部 REST 端点精确 JSON Schema（全量 28+3 路由；**Ring 1 仅落 `API.md` 标注的 15 个 REST + 1 个 SSE = 16 个核心端点**，其余按 Ring 1.5 / Ring 2 分期启用）

### 2.1 健康检查、配对、OAuth、门状态与初生引导（7 端点）

| 端点 | 请求载荷 / Query | 响应 `200 OK` 精确结构 |
| :--- | :--- | :--- |
| `GET /api/v1/health` | 无（免鉴权，硬性 `< 20ms`，不扫磁盘/不调外网） | `{ "ok": true, "version": string, "instanceId": string, "serverTimeMs": number }` |
| `POST /api/v1/auth/pair` | `{ "code": string, "deviceName": string, "platform": string }` | `{ "deviceId": string, "token": string, "instanceId": string, "serverVersion": string }` |
| `POST /api/v1/auth/oauth/:provider/start` | `{ "redirectUri"?: string }` | `{ "flow": "pkce" \| "device_code", "authorizeUrl": string, "userCode"?: string, "verificationUri"?: string, "state": string, "expiresAt": number }` |
| `POST /api/v1/auth/oauth/:provider/exchange` | `{ "state": string, "code"?: string }` | `{ "ok": true, "provider": string, "expiresAt": number }` |
| `GET /api/v1/door` | 无 | `{ "state": "open"\|"quiet"\|"closed"\|"cooling_off"\|"departed", "note": string \| null, "updatedAt": number, "unreadDoorNotes": number, "coolingOffStartedAt"?: number, "departedAt"?: number, "farewell"?: string }` |
| `GET /api/v1/genesis` | 无 | `{ "initialized": boolean, "named": boolean, "hasChatProvider": boolean, "timezone": string, "sleepWindow": { "start": string, "end": string } }` |
| `POST /api/v1/genesis` | `{ "residentName"?: string, "userName"?: string, "timezone": string, "sleepWindow"?: { "start": string, "end": string }, "llm"?: Partial<LlmConfig>, "credentials"?: Record<string, { "apiKey": string }> }` | `{ "ok": true, "named": boolean }`（`credentials` 中的 BYOK `apiKey` 直落 `credentials.json` 0600，绝不写入 `config.json`；若填 `residentName`，后端将 `self.md` `named` 置为 `true`，留空保持 `named: false` 进入中性初生） |

### 2.2 聊天、门缝留言、版本控制与审批（8 端点）

```ts
// 统一时间线条目视图（供 /chat/history 与 message.created / message.updated 共用）
// ExpressionPayload 定义见 ARCHITECTURE.md §5.1
export interface TimelineItem {
  id: string;                            // ULID (events.id)
  seq: number;                           // 全局单调事件序号 (events.seq)
  sessionId: string;
  turnId: string | null;
  clientMessageId: string | null;
  groupId: string | null;                // edit/reroll 版本组 ID
  version: number;                       // 当前版本号（1-based）
  versionCount: number;                  // 同 groupId 下可切换版本总数（candidate + active）
  role: "user" | "assistant" | "system" | "task";
  kind: "chat" | "door_note" | "wake" | "memory_task" | "activity_event" | "door.updated" | "privacy.peeked" | "relationship.departed";
  activity: string | null;
  content: string;
  thinking?: string | null;              // 仅 assistant 折叠展示
  attachments?: Array<{ hash: string; url: string; mimeType: string }>;
  sticker?: { id: string; label: string; url: string } | null;
  expressions?: ExpressionPayload[];     // 历史具身表达记录
  toolSummary?: Array<{ name: string; label: string; ok: boolean }>;
  recallCount?: number;                  // 仅 assistant；供评测模式浮条显示
  aborted?: boolean;
  createdAt: number;
}
```

| 端点 | 请求载荷 / Query | 响应结构与关键状态码 |
| :--- | :--- | :--- |
| `GET /api/v1/chat/history` | `?before=<eventId>&limit=50`（`limit` 夹逼 `1..100`） | `200`: `{ "items": TimelineItem[], "hasMore": boolean, "nextBefore": string \| null, "latestEventSeq": number }`（仅返回 `status = 'active'` 项；按 `seq DESC` 截取 `limit` 条后翻转为 `seq ASC` 旧→新返回） |
| `POST /api/v1/chat/messages` | `{ "clientMessageId": string, "content": string, "activityHint"?: string, "attachments"?: string[], "stickerId"?: string }`（`attachments` 为已上传的 media hash 数组；纯图/纯贴纸允许 `content` 为 `""`，但 `content.trim()`、`attachments`、`stickerId` 至少一项非空） | `202 Accepted`: `{ "message": TimelineItem, "deliveredAs": "chat" \| "door_note", "turnId": string \| null }`；重复 `clientMessageId` 幂等返回原记录；落盘新消息时立即重置 `consecutiveUnansweredWakes = 0`；上下文达 75% 时直接切新 `session_id` 并后台异步整理，绝不阻塞发消息；三者皆空返 `400 EMPTY_MESSAGE`；无效 `stickerId` 返 `400 INVALID_STICKER`；`departed` 返 `410 GONE` |
| `POST /api/v1/chat/messages/:id/edit` | `{ "content": string, "clientMessageId"?: string }` | `202`: `{ "message": TimelineItem, "turnId": string \| null }`（见 §4 状态机）；非末条活跃用户消息返 `409 NOT_LATEST_USER_MESSAGE`；关门态编辑 `chat` 返 `409 DOOR_CLOSED`；`departed` 返 `410 GONE` |
| `POST /api/v1/chat/messages/:id/reroll` | `{}` | `202`: `{ "turnId": string, "groupId": string, "nextVersion": number }`；`closed`/`cooling_off` 返 `409 DOOR_CLOSED`；当前有进行中流式生成返 `409 TURN_IN_PROGRESS`；`departed` 返 `410 GONE` |
| `POST /api/v1/chat/messages/:id/version` | `{ "version": number }` | `200`: `{ "activated": TimelineItem, "groupId": string }`（仅允许在 `candidate` 助手版本组间切换并广播 `message.updated`）；目标非 `candidate` 返 `409 INVALID_VERSION_TARGET`；流式生成中返 `409 TURN_IN_PROGRESS` |
| `DELETE /api/v1/chat/messages/:id` | 无 | `200`: `{ "deletedId": string, "eventSeq": number }`（软删置 `status = 'deleted'`，广播 `message.updated`）；`departed` 返 `410 GONE` |
| `POST /api/v1/turns/:turnId/abort` | 无 | `200`: `{ "ok": true, "turnId": string, "aborted": boolean }`（幂等；已结束轮返回 `aborted: false`） |
| `POST /api/v1/turns/:turnId/approval` | `{ "approvalId": string, "decision": "allow" \| "deny", "scope"?: "once" \| "session" }` | `200`: `{ "ok": true, "approvalId": string, "decision": "allow" \| "deny" }`；已超时或已被他端处理返 `409 APPROVAL_ALREADY_RESOLVED` |

### 2.3 召回评测、上锁抽屉、活动、媒体、贴纸、推送与设置（13 端点）

```ts
// 活跃活动视图（供 /activities、/activities/cinema/* 与 activity.updated 共用）
export interface ActivitySessionView {
  id: string;                            // ULID (activity_sessions.id)
  slug: string;                          // 如 "cinema"
  title: string;
  topicHint: string;
  status: "active" | "stale" | "ended";
  startedAt: number;
  endedAt: number | null;
  lastHeartbeatAt: number;
  metadata: Record<string, unknown>;     // 如 cinema 的 source/season/episode/positionSec/playbackState/latestFrameUrl
}

// 脱敏设置快照（严禁返回任何 API Key / OAuth Token / Push Token 明文）
export interface SanitizedSettings {
  timezone: string;
  llm: {
    providers: Record<string, { kind: string; authMode: "oauth" | "api_key"; baseUrl?: string; authStatus: "configured" | "expired" | "unset" }>;
    slots: LlmConfig["slots"];
    thinking: LlmConfig["thinking"];
  };
  circadian: { sleepStart: string; sleepEnd: string; heartbeatIntervalMin: number; proactiveEnabled: boolean; proactiveMinGapMin: number; proactiveCooldownMin: number };
  notifications: { channels: Record<string, { enabled: boolean; configured: boolean; summary?: string }> };
  tools: { defaultConfirmTimeoutSec: number; sessionAllowEnabled: boolean };
  mcpServers: Array<{ id: string; enabled: boolean; transport: "stdio" | "streamable_http"; trustLevel: "confirm" | "auto"; status: "connected" | "degraded" | "disabled" }>;
  devices: Array<{ deviceId: string; deviceName: string; platform: string; createdAt: number; lastSeenAt: number; hasPushToken: boolean }>;
}
```

| 端点 | 请求载荷 | 响应 `200 OK` 精确结构与关键错误码 |
| :--- | :--- | :--- |
| `GET /api/v1/turns/:turnId/recall` | 无 | `{ "turnId": string, "items": Array<{ "cardPath": string, "title": string, "track": "same_activity"\|"cross_vector"\|"daily_recent", "semScore": number, "kwScore": number, "rerankScore": number \| null, "finalScore": number, "feedback"?: "useful"\|"noisy"\|"missed" }> }`（**严禁包含 `private/`**） |
| `POST /api/v1/recall/feedback` | `{ "turnId": string, "cardPath"?: string, "verdict": "useful"\|"noisy"\|"missed", "note"?: string }` | `{ "id": number, "ok": true }`（`useful`/`noisy` 必填 `cardPath`） |
| `GET /api/v1/recall/stats` | 无 | `{ "total": number, "useful": number, "noisy": number, "missed": number, "precision": number \| null, "byTrack": Record<string, { "hits": number, "useful": number, "noisy": number }> }` |
| `GET /api/v1/drawer` | 无 | `{ "items": Array<{ "id": string, "title": string, "createdAt": number, "updatedAt": number, "peeked": boolean, "lastPeekedAt"?: number }> }`（**绝不返回正文**） |
| `POST /api/v1/drawer/:id/open` | `{ "confirmed": true }`（防误触显式确认字段） | `{ "id": string, "title": string, "content": string, "createdAt": number, "updatedAt": number, "peekedEventId": string }`（严格写 `privacy.peeked` 先于返回） |
| `GET /api/v1/activities` | 无 | `{ "activeSession": ActivitySessionView \| null, "spaces": Array<{ "slug": string, "title": string, "decay": string, "cardCount": number }> }` |
| `POST /api/v1/media` | `multipart/form-data`（字段 `file`，上限 `20 MB`） | `{ "hash": string, "url": string, "mimeType": string, "size": number }`；超 `20 MB` 返 `413 PAYLOAD_TOO_LARGE` |
| `GET /api/v1/media/:hash` | 无（支持 `If-None-Match`） | 二进制流 + `ETag` + `Cache-Control: public, max-age=31536000, immutable`；已淘汰临时观影帧返 `410 GONE` |
| `GET /api/v1/stickers` | 无 | `{ "items": Array<{ "id": string, "label": string, "pack": string, "url": string, "useCount": number }> }` |
| `POST /api/v1/stickers` | `multipart/form-data`（`file`、`id`、`label`、`pack?`，上限 `2 MB`） | `{ "id": string, "label": string, "pack": string, "url": string }`；超 `2 MB` 返 `413 PAYLOAD_TOO_LARGE` |
| `POST /api/v1/devices/push-token` | `{ "provider": "bark"\|"ntfy"\|"webhook"\|"apns"\|"fcm", "token": string, "endpoint"?: string }` | `{ "ok": true, "deviceId": string }`（敏感令牌写入 `credentials.json` 的 `pushTokens[deviceId] = { provider, token, endpoint, updatedAt }`，由 `NotificationHub` 与 `config.json` 全局 `notifications.channels` 合并扇出；设备吊销时自动清除对应项） |
| `GET /api/v1/settings` | 无 | `SanitizedSettings`（**严禁返回任何 API Key / OAuth Token / Push Token 明文**） |
| `PATCH /api/v1/settings` | 局部配置补丁（支持更新 `llm` / 新 `apiKey`（写入 `credentials.json`）、`circadian`、`notifications`、`tools`、`mcpServers`、`timezone` 及 `revokeDeviceIds?: string[]`） | `{ "ok": true, "settings": SanitizedSettings }`（热更新 `mcpServers` 与 `circadian` 定时器，立即吊销指定设备并断其 SSE） |

### 2.4 观影扩展子路由（3 端点，对齐 `Spec 03` §4.3）

- `POST /api/v1/activities/cinema/start`：`{ "title": string, "source"?: string, "season"?: number, "episode"?: number, "durationSec"?: number, "topicHint"?: string }` → `200`: `{ "session": ActivitySessionView }`（已有活跃活动返 `409 ACTIVITY_ALREADY_ACTIVE`；`departed` 返 `410 GONE`）
- `POST /api/v1/activities/cinema/frame`：`{ "sessionId"?: string, "positionSec": number, "playbackState": "playing"\|"paused", "frameBase64"?: string, "mediaHash"?: string, "subtitle"?: string }` → `200`: `{ "accepted": true, "frameSaved": boolean, "mediaHash"?: string, "sessionStatus": "active" }`（单帧解码超 `512 KB` 返 `413 PAYLOAD_TOO_LARGE`；`departed` 返 `410 GONE`）
- `POST /api/v1/activities/cinema/end`：`{ "sessionId"?: string, "reason"?: "user_ended"\|"finished" }` → `200`: `{ "ok": true, "sessionId": string, "endedAt": number }`（`departed` 返 `410 GONE`）

---

## 3. SSE 实时事件流精确载荷与多端同步协议

> **Ring 1 极简版**：仅推送 **8 类核心事件**（`message.created`、`door.updated`、`turn.start`、`turn.thinking`、`turn.expression`、`turn.text`、`turn.done`、`turn.error` + `ping`），**断线重连后由客户端直接拉 `/api/v1/chat/history` 与 `/api/v1/door` 补齐**；下文 500 条内存环形缓冲、`streamSeq` 续传与 `sync.reset` 于 **Ring 1.5** 启用。

连接地址：`GET /api/v1/stream?lastEventId=<streamSeq>&foreground=<true|false>`（支持标准请求头 `Last-Event-ID`，Query 优先）。服务端维护内存环形事件缓冲（默认保留最近 **`500` 条**事件，覆盖短时切后台/弱网断连）。

### 3.1 14 类实时事件 + `ping` 心跳精确 JSON 载荷

每条非心跳 SSE 帧均携带内存流全局单调整数 `id: <streamSeq>`（与 SQLite `events.seq` 独立，服务重启后从 1 重新递增并向携带旧 `lastEventId` 的客户端下发 `sync.reset`）、`event: <name>` 与 `data: <json>`（`ping` 不递增 `streamSeq`）：

| `event` 名称 | `data` JSON 结构 | 备注 |
| :--- | :--- | :--- |
| `message.created` | `{ "message": TimelineItem }` | 任一端发消息、塞纸条或助手落盘时广播给全部在线端 |
| `message.updated` | `{ "action": "edit"\|"version"\|"delete", "message"?: TimelineItem, "deletedId"?: string, "groupId"?: string }` | 多端同步版本切换、编辑与软删 |
| `door.updated` | `{ "state": string, "note": string \| null, "updatedAt": number }` | 门状态或门牌便签变更时广播 |
| `turn.start` | `{ "turnId": string, "mode": "chat"\|"wake"\|"memory_task"\|"solitary", "label"?: string }` | **`wake` 模式在前 16 字符确认非 `[SILENT]`（或产生实质工具调用）前暂缓广播** |
| `turn.thinking` | `{ "turnId": string, "delta": string }` | `wake` 模式下随 `turn.start` 一并暂缓 |
| `turn.expression` | `{ "turnId": string, "haptic"?: string, "atmosphere"?: object, "motion"?: string, "sticker"?: { "id": string, "label": string, "url": string } }` | 客户端 Expression Renderer 实时消费 |
| `turn.tool` | `{ "turnId": string, "callId": string, "name": string, "label": string, "status": "running"\|"done"\|"error" }` | 前端折叠工具进度条（不泄露内部参数密钥） |
| `turn.approval_required` | `{ "approvalId": string, "turnId": string, "toolName": string, "summary": string, "arguments": object, "expiresAt": number }` | 高风险工具挂起审批卡 |
| `turn.approval_resolved` | `{ "approvalId": string, "turnId": string, "decision": "allow"\|"deny", "scope"?: "once"\|"session", "reason"?: string, "resolvedByDevice"?: string }` | 多端同步自动销除待审批弹窗 |
| `turn.text` | `{ "turnId": string, "delta": string }` | 流式回复增量 |
| `turn.error` | `{ "turnId": string \| null, "code": "AUTH_EXPIRED"\|"RATE_LIMITED"\|"PROVIDER_ERROR"\|"CONTEXT_OVERFLOW", "message": string, "retryable": boolean }` | 结构化错误提示 |
| `turn.done` | `{ "turnId": string, "mode": string, "messageId"?: string, "recallCount"?: number, "aborted"?: boolean, "media"?: Array<{ "hash": string, "url": string }> }` | 本轮结束；`memory_task` 结束时附简短折叠摘要 |
| `activity.updated` | `{ "session": ActivitySessionView \| null }` | 观影开始、进度/帧刷新、`stale` 提醒或结束 |
| `sync.reset` | `{ "reason": "buffer_overflow"\|"server_restarted", "latestStreamSeq": number }` | 客户端收到后记录 `latestStreamSeq` 作为新游标，并全量重拉 `/chat/history`、`/door`、`/activities` |
| `ping` | `{ "ts": number }` | 每 `25s` 发送一次保活心跳（不递增 `streamSeq`） |

### 3.2 多端幂等与前后台状态同步

1. **发送幂等**：客户端发消息前在本地生成 ULID 作为 `clientMessageId`；弱网重试时携带相同 `clientMessageId`，服务端凭 `events.client_message_id UNIQUE` 约束直接返回已落盘记录，绝不重复入库或触发双倍回复。
2. **前后台声明**：Flutter 切前后台时通过轻量重连或 `foreground=true/false` 参数更新连接标记，供 `Spec 03` §3.1 `NotificationHub` 做前台活跃抑制。

---

## 4. 消息 `Edit` / `Reroll` / `Version` / `Delete` 状态机与游标联动（Ring 1 仅落发消息 + 软删 + 中止；四态版本组于 Ring 1.5 启用）

所有消息修改严格遵守 SQLite `events` 只追加原则（`group_id`、`version`、`status ∈ {'active', 'candidate', 'discarded', 'deleted'}`），**严禁覆盖旧行正文**，并严格维持 **`Spec 02` §7.5 前提：每次 `edit` 与 `reroll` 必须生成全新 `turn_id`**（使 2 小时召回去重 `EXISTS (SELECT 1 FROM events e WHERE e.turn_id = r.turn_id AND e.role = 'assistant' AND e.status = 'active')` 自动失效弃用轮）。

| 操作 | 合法前置条件 | 数据库状态流转 | 与记忆整理游标（`daily_wrapup`）联动 |
| :--- | :--- | :--- | :--- |
| **`Edit`**（编辑用户消息） | 目标行须为当前会话**最后一条 `role = 'user' AND status = 'active'`**（否则返 `409 NOT_LATEST_USER_MESSAGE`）；若当前 `door.state ∈ {'closed', 'cooling_off'}`，**仅允许编辑 `kind === 'door_note'`**（编辑 `kind === 'chat'` 返回 `409 DOOR_CLOSED` 防止绕过关门唤醒）；若正在流式生成，服务端先自动 `abort` 旧轮 | ① 原用户行置 `status = 'discarded'`，紧随其后的原助手回复（若有）置 `status = 'discarded'`；② 复用/新建 `group_id`，写入 `version = maxVersion + 1, status = 'active'` 的新用户行（带新 `turn_id`）；③ 若为 `chat`（此时门必为 `open`/`quiet`），立即用新 `turn_id` 重新触发回复；若为 `door_note` 仅广播 `message.updated` 不唤醒 | 若原用户行 `id > daily_wrapup` 游标（尚未被整理），旧行已标 `discarded`，整理轮只看新 `active` 行；若已被历史整理轮消化，**不强行回滚历史 Git 提交**，仅更新后续对话上下文 |
| **`Reroll`**（重摇助手回复） | 目标行须为 `role = 'assistant' AND status = 'active'`，`door.state ∈ {'open', 'quiet'}`（否则返 `409 DOOR_CLOSED`），且当前无进行中的流式生成（否则返 `409 TURN_IN_PROGRESS`） | ① 原助手行置 `status = 'candidate'`（保留在版本组中供切回）；② 复用/新建 `group_id`，分配**全新 `turn_id`** 重新生成 `version = maxVersion + 1, status = 'active'` 的新助手行 | 新版本落盘为 `active`、旧版本为 `candidate`；若尚未进 `daily_wrapup` 游标，整理轮仅消费当前 `active` 版本 |
| **`Version`**（切换历史版本） | 目标 `group_id` 下存在指定 `version` 且 **`status === 'candidate'`**（仅限 `Reroll` 产生的助手版本组；`Edit` 弃用的 `discarded` 行与 `deleted` 行一律返 `409 INVALID_VERSION_TARGET`，防止时间线用户/助手错位） | 单事务内将该组原 `active` 行置 `candidate`，将目标 `version` 置 `active`，广播 `message.updated` | 仅切换后续上下文与未整理区间的可见版本，不改写已提交的记忆卡片 |
| **`Delete`**（软删） | 目标行 `status = 'active'` 且 `door.state != 'departed'` | 将目标行置 `status = 'deleted'`（若删的是同轮用户消息，不强制连删助手行，由用户自主决定），广播 `message.updated` | 未进游标则整理轮直接忽略；已进游标则仅从后续聊天历史隐藏，不回滚历史 Git |

---

## 5. Flutter 全端客户端架构与核心状态机（`app/lib/`）

### 5.1 目录职责与状态管理约束

- **目录划分**（严格对齐 `ARCHITECTURE.md` §2）：
  - `core/network/`：多地址竞速选路器（`EndpointSelector`）、REST 客户端（`ApiClient`）、SSE 断线续传管理器（`SseClient`）、Token 安全存储（`flutter_secure_storage`）；
  - `expression/`：`ExpressionRenderer`（消费 `turn.expression` 映射平台原生触觉、界面光温色罩、微动效与贴纸气泡）；
  - `features/chat/`：主时间线、流式 `thinking` 折叠卡、审批确认卡、编辑/重摇版本切换器、门状态顶栏与门缝纸条输入框、可开关召回评测浮条；
  - `features/activities/`：活动渲染槽与 Ring 1.5 观影伴看卡（`CinemaCard`）；
  - `features/genesis/`：扫码/配对码引导、OAuth 浏览器拉起与回调提交、初生配置；
  - `features/settings/`：主题、评测模式开关、多地址配置、已配对设备管理/吊销、贴纸包上传、上锁抽屉入口（含二次确认弹窗）。
- **状态管理**：采用轻量不可变状态 + 依赖注入（如 Riverpod），按连接态、时间线、门状态、活跃活动与表达式 5 个独立状态域隔离，避免流式 `turn.text` 高频刷新触发整页重绘。

### 5.2 多地址竞速选路状态机（Ring 1.5；Ring 1 先落单配置地址 + 切后台静默重连）

支持用户为同一台后端配置多个候选地址（典型顺序：`本机 loopback` → `局域网 LAN` → `公网/Tailscale`）：

```text
[Disconnected]
   │ 并发向全部候选地址发 GET /api/v1/health（单请求超时 1500ms）
   ▼
[Probing] ──► 取首个返回 200 且 instanceId 匹配的最快地址（优先同级局域网）
   │                                       │ 全部失败
   ▼                                       ▼
[Connected(activeBaseUrl)]          [OfflineBackoff]（指数退避 2s→5s→15s→30s，
   │ 连续 2 次请求失败或 SSE 断开           App 切回前台时立即重置退避重探）
   └───────────────────────────────────────┘
```

- **实例防串连校验**：首次配对时从 `POST /api/v1/auth/pair` 响应直接记住后端 `instanceId`，后续多地址探活必须校验 `/health` 返回的 `instanceId` 一致，防止换 Wi-Fi 后误连到局域网内其他同端口服务。
- **静默重连红线（对齐 `API.md` §4）**：App 切后台主动中止 SSE 与进行中拉取，切回前台合并为单次重连（带 `lastEventId=<streamSeq>`）；**所有预期内的连接取消（`CanceledException`）绝不弹出红色错误条**，仅在持续离线超过 5 秒时在顶栏显示温和的「正在重新连接…」微提示。

### 5.3 具身表达渲染器（`ExpressionRenderer`）与界面克制规范

| `ExpressionPayload` 字段 | 移动端（iOS / Android）渲染 | 桌面端 / Web 渲染 |
| :--- | :--- | :--- |
| `haptic` | `light` → `HapticFeedback.lightImpact()`；`medium` → `mediumImpact()`；`double` → 两次间隔 `90ms` 轻震；`heartbeat` → `0ms/140ms` 双拍轻重震 | 映射为当前气泡或输入框边框一次极轻微的 `180ms` 弹性微抖动 |
| `atmosphere` | 聊天背景纸感画布叠一层极低不透明度（`subtle: 0.06` / `noticeable: 0.14`）的色温渐变层，按 `durationSec` 缓入缓出 | 同移动端，缓入 `600ms`、到期缓出 `1200ms` |
| `motion` | 对应当轮助手气泡执行单次克制微动效（`shake`/`breathe`/`hesitate`/`nod`，时长 `≤ 600ms`） | 同移动端；系统开启「减少动态效果」时自动降级为静态淡入 |
| `sticker` | 独立贴纸气泡渲染 `/api/v1/media/<hash>`（带本地磁盘缓存） | 同移动端 |

### 5.4 核心交互组件契约

1. **门状态与输入框切换**：
   - `door.state === "open"` / `"quiet"`：正常聊天输入框（`quiet` 顶栏显示柔和便签提示）；
   - `door.state ∈ {"closed", "cooling_off"}`：输入框切换为「门缝塞纸条」纸感样式，发送按钮改为「塞纸条」，明确不展示“对方正在输入”；
   - `door.state === "departed"`：隐藏输入框，底部展示只读纪念条与查看告别信入口。
2. **可开关召回评测浮条（默认关闭 · NG-4）**：
   - 仅当用户在设置页开启「召回评测模式」后，在 `recallCount > 0` 的助手气泡下方渲染单行折叠胶囊 `想起 N 张卡`；点击才懒加载 `GET /api/v1/turns/:turnId/recall`，支持单点标 `准 / 噪声` 及补充 `漏召` 备注。
3. **高风险审批确认卡（Ring 2）**：收到 `turn.approval_required` 时在聊天流底部固定浮现审批卡（带倒计时与工具摘要），提供「仅本次允许」「本会话允许」「拒绝」三个按钮；收到他端广播的 `turn.approval_resolved` 时立即静默收起。
4. **纸感手账视觉与性能红线**：
   - 聊天时间线列表使用 `ListView.builder` 虚拟化与分页预取，单页 50 条响应严格 `< 200 KB`；
   - 扩展思考卡（`thinking`）默认折叠为一行「思考过程」，流式阶段支持展开实时滚动，结束后自动收起不占主阅读流。

---

## 6. Spec 04 出口验收清单（按 Ring 1 / Ring 1.5+ 分期对照）

### Ring 1 必过验收
- [ ] Ring 1 核心 15 个 REST + 1 个 SSE（共 16 端点）的请求/响应 JSON Schema、错误码与鉴权脱敏全绿；`POST /genesis` 支持一步传入 BYOK `apiKey` 直落 `credentials.json`，`GET /settings` 零密钥泄露；
- [ ] 配对码 5 分钟过期、一次性销毁、防爆破限流、`instanceId` 随配对返回、`SHA-256(token)` 落盘；
- [ ] SSE 8 类核心事件 + `ping` 心跳、`wake` `[SILENT]` 暂缓推 `turn.start`/`turn.thinking`、`clientMessageId` 多端幂等、软删与中止生成全绿；
- [ ] Flutter 单地址配置、切后台静默重连不弹红条（断线后直接拉 `/chat/history` 与 `/door` 补齐）、`ExpressionRenderer`、门缝纸条输入框与懒加载评测浮条全绿。

### Ring 1.5 / Ring 2 扩展验收
- [ ] （Ring 1.5）全量 29+3 端点、远端 OAuth、`revokeDeviceIds` 即时吊销断流、`streamSeq` 500 条环形缓冲与 `sync.reset`、`Edit`/`Reroll`/`Version` 四态版本组（`409 TURN_IN_PROGRESS`）与 Flutter 多地址竞速选路全绿；
- [ ] （Ring 2）`turn.approval_required`/`resolved` 审批卡多端同步销除、`departed` 全写接口返 `410 GONE` 全绿。
