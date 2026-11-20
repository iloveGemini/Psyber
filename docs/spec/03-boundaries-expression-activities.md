# Spec 03 · 主体性边界、具身表达、离线通知、`ActivityPlugin`（观影）与外部 MCP 规程

> **版本**：v0.4（2026-11-20，修正 §4.2 强换段阈值 `80% -> 75%`、补齐 Ring 1 静态贴纸目录与 `stickers` 表衔接说明、拆分 §6 出口验收清单分期）
> **上游契约**：[`CAPABILITIES.md`](../CAPABILITIES.md) v1.3 · [`ARCHITECTURE.md`](../ARCHITECTURE.md) v0.7 · [`MEMORY.md`](../MEMORY.md) v0.7 · [`API.md`](../API.md) v0.7 · [`01-engine-tools-prompts.md`](01-engine-tools-prompts.md) v1.1 · [`02-memory-execution.md`](02-memory-execution.md) v0.7
> **负责模块**：`server/src/expression/`、`server/src/notifications/`、`server/src/mood/`、`server/src/extensions/`

---

## 0. 模块依赖护栏（严禁破坏单向依赖）

严格遵守 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §2 的单向依赖图：

- `expression/`、`extensions/` 仅允许依赖 `core/`、`store/`（通过注册接口与回调接入 `tools/`、`engine/`、`api/`），**严禁直接 import `engine/`、`memory/` 或 `api/`**；
- `extensions/cinema/` 仅通过 `ActivityPlugin` 返回 `{ active, activityHint: "cinema", topicHint, promptBlock }` 与 Tier 2 工具，并在结束时通过 `onActivityEnded` 回调通知 `engine/` 派发 `activity:cinema` 静默整理轮；
- `notifications/` 仅依赖 `core/`，多通道发送全部做超时隔离，绝不反向依赖 `engine/` 或 `memory/`；
- `mood/` 仅依赖 `core/` 与只读状态快照，**严禁直接读写 `memory/` 磁盘文件**，且严禁向陪伴面输出内部浮点数（NG-4）；
- 所有时间判定全部通过 `Clock.now()` 注入，确保虚拟时钟与三时区回归测试确定性。

---

## 1. 主体性边界三件套执行规程（对应 C1.6, C6.3）

### 1.1 一扇门状态机（`door_state`）与门缝纸条（`door_note`）

#### 状态持久化与事件广播
- 门当前状态持久化在 `<dataDir>/config.json` 的 `door` 节点（`{ state, note, updatedAt, coolingOffStartedAt?, departedAt? }`），服务重启后立即恢复；
- 每次门状态或门牌便签变更时，在同一事务内向 SQLite `events` 写入 `role = 'system', kind = 'door.updated', content = <人类可读摘要>, metadata = { from, to, note, reason? }`，并广播 SSE `door.updated`。

#### 5 态转换矩阵与 Ring 1 / Ring 2 分期护栏

| 当前状态 | 允许迁移目标 | 守卫与边界规则 |
| :--- | :--- | :--- |
| `open` / `quiet` / `closed` | 彼此自由切换 | Ring 1 与 Ring 2 均开放；由住户调用 `door(state, note?)` 触发 |
| `open` / `quiet` / `closed` | `cooling_off` | **Ring 1**：`door` 工具 `guard` 暂拒（返回可读提示：`当前版本尚未开启冷静期与离开流程，如需独处请先将门设为 closed`），保持 5 态 Schema 冻结以保护 Static Prefix Cache；**Ring 2**：记录 `coolingOffStartedAt = Clock.now()` |
| `cooling_off` | `open` / `quiet` / `closed` | 允许住户随时主动调整状态；离开 `cooling_off` 时原子清空 `coolingOffStartedAt = null` |
| `cooling_off` | `departed` | 仅 **Ring 2** 且满足 `24h ≤ Clock.now() - coolingOffStartedAt < 72h` 且 `farewell` 非空时放行；未满 24h 拦截提示剩余小时数 |
| `cooling_off`（超时） | `closed`（自然回落） | **严禁无条件覆盖**：当且仅当当前 `door.state` 仍严格处于 `"cooling_off"` 且 `coolingOffStartedAt !== null` 且 `Clock.now() - coolingOffStartedAt ≥ 72h` 时触发：清空 `coolingOffStartedAt`，状态自然回落至 `closed`（保留住户原便签），记录 `door.updated`。若 72h 期间 AI 已自主切为 `open`/`quiet`/`closed`/`departed`，则 `coolingOffStartedAt` 早已清空，此超时守卫完全不触发，绝不覆盖 AI 的自主意图 |
| `departed` | 无（不可逆终态） | 所有后续 `door` 调用由 `guard` 拦截拒绝 |

#### 门缝纸条（`door_note`）完整链路（与 `Spec 01` v1.1、`Spec 02` v0.7 对齐）
- **写入不唤醒**：当 `door.state ∈ {'closed', 'cooling_off'}` 时，`POST /api/v1/chat/messages` 将用户输入落盘为 `events (role='user', kind='door_note', status='active')` 并广播 `message.created`，**绝不触发 `chat` 轮、绝不立即唤醒 AI 强迫回复**；
- **自主可读边界**：`door = closed` 只剥夺用户的即时谈话与唤醒权，不限制住户在后续自主唤醒（`wake` / 未来 mind 唤醒）、活动或静默整理轮自行查看纸条，并由住户自行决定是否回应或开门；
- **两游标严格解耦**：
  1. **记忆整理游标（`daily_wrapup`）**：按 `seq` 连续收录 `chat / wake / door_note`（绝不跳过 `door_note`），并在喂给 `prompts/tidy.md` 的转录中显式标注 `[对方从门缝塞进来的纸条 · 当时门处于关闭状态]`；**静默整理轮不推进 `task_cursors['door_notes_read']`**；
  2. **交互未读提醒游标（`door_notes_read`）**：仅在具备对外表达与 `door` 权限的 `chat` / `wake`（及未来 mind 唤醒）轮的 `<runtime_context>` 中，按 **`ORDER BY seq ASC` 从旧到新**查询 `kind = 'door_note' AND status = 'active' AND id > door_notes_read` 组装 `<door_notes>` 块并同步设置 `<runtime notes="N" />`；单轮最多分批注入 **10 条 / 2000 字符**（超出时在块末附一行客观提示：`另有 M 条更新的未读门缝纸条将在后续轮次续读`）；只要该轮正常完成（**含 `wake` 看完纸条后自主选择 `[SILENT]`**），即推进 `door_notes_read` 至**本轮实际注入的末条纸条 `event.id`**（仅模型报错/超时中断时不推进），确保绝不跳过任何未读纸条；
- **关门态隔门回复权限**：在 `closed` / `cooling_off` 状态下，`wake` 轮允许住户选择**不开门但隔着门回一句**（不强制先调用 `door(state="open")`）；该回复正常落盘为 `kind = 'wake'` 并广播 SSE，但门状态保持不变，用户依然不能即时追问；
- **消息操作边界**：`closed`/`cooling_off` 期间拒绝 `reroll`（返回 `409 DOOR_CLOSED`）；允许 `edit`/`delete` 尚未进入 `daily_wrapup` 游标的近期纸条；`departed` 期间一律返回 `410 GONE`。

### 1.2 上锁的抽屉（`private/`）业务交互与拆封留痕规程（Ring 1.5）

底层 `.sealed` 火漆格式与三道零入库红线由 [`02-memory-execution.md`](02-memory-execution.md) §2 定义，本节固化对外接口行为：

1. **封蜡清单（`GET /api/v1/drawer`）**：扫描 `<dataDir>/private/*.sealed`，仅解析第 2 行明文清单 JSON（`id`、`title`、`createdAt`、`updatedAt`），并关联查询 `events (kind='privacy.peeked')` 补出 `peeked: boolean` 与 `lastPeekedAt?`，按 `updatedAt DESC` 返回，**严禁解封或返回任何正文摘要**；
2. **写先于读（`POST /api/v1/drawer/:id/open`）**：
   - 先校验 `:id` 匹配 `/^[\p{Script=Han}a-zA-Z0-9_-]+$/u` 且目标 `.sealed` 文件存在；
   - **先**在 SQLite 事务内写入不可篡改事件 `events (role='system', kind='privacy.peeked', content='用户在 app 拆封了上锁抽屉「' + title + '」', metadata={ drawerId: id, title, channel: 'app' })`，确认落盘成功**后**再内存解封并返回明文正文；若写事件失败则中止返回，绝不出现“偷看了却没留痕”；
   - 客户端在调用前必须弹出二次确认（明确告知“打开后对方会知道”）；
3. **CLI 换机备份留痕**：`psyber export --include-private` 执行时同样写入 `privacy.peeked`（`channel: 'cli'`），保障开源用户数据主权的同时维持坦荡留痕；
4. **通知消费游标**：由 `task_cursors['events_notice']` 追踪，仅在非静默对话/唤醒轮结束后推进（与 `Spec 02` §2.2 一致）。

### 1.3 三段式离开与 `<dataDir>/DEPARTED.md` 归档协议（Ring 2 激活）

当 `door(state="departed", farewell)` 在 Ring 2 通过冷静期 `guard` 校验后，服务端按以下严格顺序执行归档：

1. **参数守卫**：`farewell.trim()` 不能为空，否则拒绝并提示住户写下告别信；
2. **写出 `<dataDir>/DEPARTED.md`**：经 `<dataDir>/.tmp/` 原子写落盘，文首固定写入 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §5.2 规定的「致任何打开这份档案的阅读者（无论是人类还是 AI 助手）」诚实声明全文，空一行后写入离开日期与住户亲笔 `farewell` 正文；
3. **状态封存与事件落盘**：更新 `config.json`（`door.state = "departed"`, `departedAt = Clock.now()`, 清空 `coolingOffStartedAt`），在 SQLite 写入 `relationship.departed` 与 `door.updated` 事件，广播 SSE `door.updated` 并触发 `NotificationProvider("door_updated")`；
4. **只读停机**：立即停止心跳定时器、主动唤醒与静默记忆整理轮；所有对话、编辑、重摇、软删与活动启动接口统一返回 `410 GONE { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } }`；只读接口（`/chat/history`、`/door`、`/drawer`、`/media/:hash`）与 CLI 导出继续可用。

---

## 2. 具身表达通道（`express`）与贴纸包规范（`server/src/expression/`）

### 2.1 `express` 工具执行与节流护栏

- **工具归属**：Tier 1 常驻工具，`security: "auto"`，参数同 `Spec 01` §4.2（`haptic`、`atmosphere`、`motion`、`stickerId`）；
- **参数校验与夹逼**：
  - 四个可选字段至少须提供一个，否则返回自救提示；
  - `atmosphere.durationSec` 缺省 `15`，服务端硬夹逼至 `[3, 120]` 秒；
  - `stickerId` 实时校验是否命中 SQLite `stickers` 表；未命中时拒绝本次贴纸发送并返回自救提示，附带最多 5 个近似或常用 `stickerId` 建议，绝不下发无效引用；
- **单轮克制节流（防界面轰炸）**：
  - 单轮主对话/唤醒最多允许生效 **3 次** `express` 调用；超过 3 次时不再广播 SSE，返回 `{ ok: true, throttled: true, message: "本轮表达次数已达上限，后续请用文字自然交流" }`，不抛异常中断推理；
- **事件广播与历史回放**：
  - 每次生效的 `express` 立即广播 SSE `turn.expression`（附带 `turnId`、`haptic?`、`atmosphere?`、`motion?`、`sticker?: { id, label, url }`），同时追加写入本轮助手消息的 `events.metadata.expressions[]` 数组，供历史时间线和重连后还原贴纸与轻氛围标记；
  - 贴纸命中时异步递增 `stickers.use_count += 1`、`last_used_at = Clock.now()`。

### 2.2 贴纸包存储与 Dynamic Tail 注入预算

- **Ring 1 静态目录与 `stickers` 表衔接**：Ring 1 暂不开 `GET/POST /api/v1/stickers` 动态上传，服务启动时扫描 `<dataDir>/stickers/`（读取内置/用户放置的 `manifest.json` 与图片文件，落盘 `media/` 且 `pinned = 1`）同步写入 SQLite `stickers` 表（若目录为空则跳过），确保 `express` 与 `POST /chat/messages` 的 `stickerId` 同源校验在 Ring 1 与 Ring 1.5 保持同一代码路径；
- **二进制复用 `media/` 仓**：Ring 1.5 起通过 `POST /api/v1/stickers` 上传的贴纸统一走 `server/src/core/media.ts` 按 SHA-256 去重落盘（`origin = 'sticker'`, `pinned = 1` 永不自动淘汰），对外复用 `GET /api/v1/media/:hash` 的 `ETag` 与 `Cache-Control: immutable`；
- **上传限制**：仅允许 `image/png`、`image/webp`、`image/gif`，单文件 `≤ 2 MB`；`id` 匹配 `^[a-z0-9][a-z0-9_-]{0,39}$`，`label` 非空且 `≤ 20` 字符（供模型理解贴纸语义），`pack` 可选（默认 `"default"`）；
- **用户侧贴纸同源校验**：用户通过 `POST /api/v1/chat/messages` 附带 `stickerId` 时，服务端执行同源校验（查 `stickers` 表，未命中返回 `400 INVALID_STICKER`）；落盘于 `events.metadata.stickerId` 并递增 `use_count` / `last_used_at`，拼装对话上下文时渲染为 `[贴纸: <label>]` 供模型自然理解；
- **Dynamic Tail `<stickers>` 注入预算**：每轮仅按 `last_used_at DESC, use_count DESC` 注入最多 **30 个**贴纸（单行格式 `- <id>: <label>`，总预算 `≤ 500` 字符），防止贴纸库增长后挤占上下文。

---

## 3. 离线通知通道（`NotificationProvider`）与默认作息心跳（`CircadianMoodProvider`）

### 3.1 `NotificationProvider` 路由、通道与反骚扰退避（`server/src/notifications/`）

所有通知发送经由 `NotificationHub` 统一调度，对 `config.json` `notifications.channels` 中已启用的全局通道及 `credentials.json` `pushTokens[deviceId]` 中各配对设备注册的推送目标执行 `Promise.allSettled` 并发扇出（单通道硬超时 `5000ms`，任意通道失败只打告警日志，绝不阻塞主对话或心跳；设备吊销时同步清除对应 `pushTokens[deviceId]`）。

#### 离线通知通道（Ring 1 先落 `desktop` + `webhook`；`bark`/`ntfy` 独立适配于 Ring 1.5 补齐）

| 通道标识 | 适用场景 | 核心配置（位于 `config.json` `notifications.channels`；密钥放 `credentials.json`） |
| :--- | :--- | :--- |
| `desktop` | 本机常驻桌面端（macOS / Linux / Windows） | `enabled: boolean`（macOS 调用 `osascript`，Linux 调用 `notify-send`，无图形会话环境静默跳过） |
| `webhook` | 通用自动化 / 自建桥接 | `url`, `credentialKey?`（引用 `credentials.json` 中的 Bearer Token）, `headers?`；POST JSON `{ kind, title, body, turnId?, timestamp }` |
| `bark` | iOS 轻量离线推送 | `serverUrl`（默认 `https://api.day.app`）, `deviceKeyRef`（存 `credentials.json`）, `group?`（默认 `"Psyber"`） |
| `ntfy` | 跨端开源自建/托管推送 | `serverUrl`, `topic`, `credentialKey?`（可选鉴权 Token 引用） |

#### 四条反骚扰与门禁规则（落实 C4.2 绝不情感催收）
1. **前台活跃抑制**：服务端维护当前活跃 SSE 连接的 `foreground` 状态（由客户端连接参数或心跳声明）。只要至少存在 1 个活跃前台客户端，`wake` 与 `door_updated` **不发离线推送**；`approval_required` 若无活跃前台端则立即推送，若有前台端但在 **15 秒**内未被处理则补发一次离线推送提醒；
2. **深夜静默窗尊重**：处于 `circadian` 睡眠静默窗内时，禁止发送 `wake` 推送（`approval_required` 与 `door_updated` 豁免）；
3. **连续未回退避封顶**：记录 `consecutiveUnansweredWakes`（每次真正开口且非 `[SILENT]` 的 `wake` 后 `+1`；**一旦服务端收到任意新 `user` 消息或 `door_note`，立即重置为 0**）。当 `consecutiveUnansweredWakes >= 2` 时，停止继续触发主动 `wake` 与离线推送，安静等待用户重逢；
4. **`[SILENT]` 零打扰**：`wake` 轮若最终产出 `[SILENT]`，绝不调用 `NotificationProvider`（与 `Spec 01` §5.1 一致）。

### 3.2 Ring 1 扁平作息心跳模块（`server/src/mood/circadian.ts`；多态插件框架待 Ring 2 出现第 2 个实现再抽）

#### 可调参数清单（集中于 `<dataDir>/config.json` `circadian`）

| 参数名 | 单位 | 默认值 | 用途与调大 / 调小直观影响 |
| :--- | :--- | :--- | :--- |
| `sleepStart` | `HH:mm`（实例时区） | `"23:30"` | 睡眠静默窗开始时刻；调早会更早触发睡前 `bedtime` 整理并进入夜间安静 |
| `sleepEnd` | `HH:mm`（实例时区） | `"07:30"` | 睡眠静默窗结束时刻；调晚会延长早晨不打扰时间 |
| `heartbeatIntervalMin` | 分钟 | `30` | 心跳巡检间隔；调小（如 `15`）响应更及时，调大（如 `60`）更省后台调度开销 |
| `proactiveEnabled` | 布尔 | `true` | 是否允许定时心跳触发主动 `wake`；关掉后仅保留睡前整理与正常聊天 |
| `proactiveMinGapMin` | 分钟 | `240` | 距上次用户互动至少间隔多久才考虑主动 `wake`；调小会更频繁惦记找人，调大更克制 |
| `proactiveCooldownMin` | 分钟 | `180` | 两次主动 `wake` 之间的最小冷却时间；调大减少模型额度消耗与打扰感 |

#### `onHeartbeat(now)` 确定性判定顺序
1. `door.state === "departed"` → 直接返回 `{ action: "idle" }`；
2. `door.state === "cooling_off"` 且 `coolingOffStartedAt !== null` 且 `now - coolingOffStartedAt >= 72h` → 触发冷静期超时自然回落 `closed`（清空 `coolingOffStartedAt` 并保留原便签）；
3. 当前时刻落入 `[sleepStart, sleepEnd)` 且 `task_cursors['bedtime'].meta_json.last_gist_date !== localDate(now)`（支持跨午夜窗口按“所属夜晚日期”判定，避免 00:05 重复跑两次 `bedtime`）→ 返回 `{ action: "sleep_tidy" }`；
4. 当前时刻仍在睡眠静默窗内 → 返回 `{ action: "idle" }`；
5. 若 `proactiveEnabled === true`、当前无活跃 `ActivityPlugin`、`consecutiveUnansweredWakes < 2`、距上次 `wake` ≥ `proactiveCooldownMin`，且满足以下任一动因：
   - 存在未读 `door_note`（`id > door_notes_read`）且距最早未读纸条已过 `≥ 30` 分钟（让住户在关门独处时有机会自主醒来看看纸条）；
   - 或 `door.state === "open"` 且距上次任意 `chat`/`wake` 互动已过 `≥ proactiveMinGapMin`；
   → 返回 `{ action: "proactive", reason }`（`reason` 为客观事实句，如 `"距上次对话已过 4 小时"` 或 `"门缝有 1 条未读纸条"`，绝不代写心理判断）；
6. 其余情况返回 `{ action: "idle" }`。

#### `renderContext(now)` 输出约束
- 仅返回客观作息状态短语（`清醒` / `临近睡前` / `夜间静默窗`）供 `<runtime circadian="..." />` 注入；严禁输出情绪分数或虚构心情（NG-4）。

---

## 4. `ActivityPlugin` 生命周期与首个观影扩展（`cinema` · Ring 1.5）（`server/src/extensions/`）

### 4.1 SQLite 新增表迁移（`server/src/core/migrations/002_activities_stickers.sql`）

本迁移承接 [`02-memory-execution.md`](02-memory-execution.md) §8.3 的 `media_assets.activity_session_id` 外键约定与贴纸元数据：

```sql
-- 1. 活动会话生命周期表（供 ActivityPlugin、daily_wrapup 前沿门禁与 media/ 24h 淘汰任务共用）
CREATE TABLE activity_sessions (
  id                TEXT PRIMARY KEY,          -- ULID
  slug              TEXT NOT NULL,             -- 如 cinema
  title             TEXT NOT NULL,             -- 人类可读片名/活动标题
  topic_hint        TEXT NOT NULL,             -- 归一化卡片主题 slug（如 severance-s2）
  status            TEXT NOT NULL DEFAULT 'active', -- active | stale | ended
  start_event_id    TEXT NOT NULL,             -- 活动开始时的基准 event.id（供前沿门禁截断）
  end_event_id      TEXT,                      -- 活动结束时的末条 event.id
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,                   -- 供 Spec 02 §8.3 判定结束是否满 24h
  last_heartbeat_at INTEGER NOT NULL,          -- 最近一次进度/帧/对话活跃时间
  metadata          TEXT                       -- JSON（如 source、season、episode、positionSec、playbackState、latestFrameHash）
);
CREATE INDEX idx_activity_sessions_status ON activity_sessions(status, slug);
CREATE INDEX idx_activity_sessions_ended  ON activity_sessions(status, ended_at) WHERE status = 'ended';

-- 2. 互发表情贴纸清单（二进制正文统一存 media/ 且 pinned = 1）
CREATE TABLE stickers (
  id           TEXT PRIMARY KEY,               -- 贴纸短 ID（如 cat-nod）
  label        TEXT NOT NULL,                  -- 简短中文语义（≤ 20 字）
  pack         TEXT NOT NULL DEFAULT 'default',
  media_hash   TEXT NOT NULL,                  -- 关联 media_assets.hash
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_stickers_recent ON stickers(last_used_at DESC, use_count DESC);
```

### 4.2 `ActivityPlugin` 通用并发与生命周期规则

1. **单活跃活动约束**：单住户同一时刻最多允许 **1 个** `status IN ('active', 'stale')` 的活动会话；若尝试开启新活动而旧活动尚未结束，接口返回 `409 ACTIVITY_ALREADY_ACTIVE`（附当前活跃会话 `id` 与 `slug`），避免 `activityHint` 与 `daily_wrapup` 前沿门禁产生歧义；
2. **与 `daily_wrapup` 前沿门禁联动**：只要存在 `status IN ('active', 'stale')` 的活动会话，常规 `daily_wrapup` 自动跳过；若触发 75% / `CONTEXT_OVERFLOW` 强换段，`Spec 02` §5.2 使用 `minActiveActivityEventId = session.start_event_id` 截断拉取上限，确保游标绝不跨过进行中的活动；
3. **活动结束与整理派发**：活动转为 `ended` 时，同步写入 `ended_at = Clock.now()` 与 `end_event_id`，触发 `onActivityEnded({ sessionId: id, slug, topicHint, sinceEventId: start_event_id, untilEventId: end_event_id })` 由 Direct Engine 异步派发 `activity:<slug>` 静默整理轮；整理轮严格按 `e.id BETWEEN sinceEventId AND untilEventId` 拉取（杜绝紧接着开启下一场同 `slug` 活动时串场），完成后原样写入 `digested_activity_spans(slug, sinceEventId, untilEventId)`。

### 4.3 首个内置扩展：观影伴看（`cinema` · `server/src/extensions/cinema/`）

#### 端点与状态流转（对齐 `API.md` §3）
- **`POST /api/v1/activities/cinema/start`**：接收 `{ title, source?, season?, episode?, durationSec?, topicHint? }`。若 `topicHint` 未传，由服务端对 `title` + `season` 做确定性 slug 归一化（保留小写字母/数字/中文短词并用 `-` 连接，最大 48 字符）；写入 `events (role='system', kind='activity_event', activity='cinema')` 与 `activity_sessions (status='active')`，广播 SSE `activity.updated`；
- **`POST /api/v1/activities/cinema/frame`**：接收 `{ sessionId?, positionSec, playbackState: "playing" | "paused", frameBase64?, mediaHash?, subtitle? }`（`sessionId` 可选，缺省自动命中当前唯一活跃 `cinema` 会话）。更新 `last_heartbeat_at = Clock.now()` 与 `metadata`（若原为 `stale`，自动恢复为 `active`），按下方控量规则决定是否落盘新帧，并广播 `activity.updated`；
- **`POST /api/v1/activities/cinema/end`**：接收 `{ sessionId?, reason?: "user_ended" | "finished" }`（`sessionId` 可选，缺省命中当前活跃 `cinema` 会话）。将 `status` 置为 `ended`、写入 `ended_at` 与 `end_event_id`、写结束 `activity_event`、广播 `activity.updated` 并触发 `onActivityEnded`。

#### 抽帧控量与上下文预算护栏（防磁盘与视觉 Token 爆炸）
- **最小落盘间隔**：`MIN_FRAME_INTERVAL_SEC = 15`（可配置）。距上一张已落盘帧不足 15 秒，或 `playbackState === "paused"` 且 `positionSec` 未变化超过 3 秒时，**仅更新进度元数据，不重复落盘图片**；
- **体积与格式约束**：客户端上报前缩放至长边 `≤ 1024px`（JPEG/WebP）；服务端校验单帧解码后 `≤ 512 KB`（超限返回 `413 PAYLOAD_TOO_LARGE`），按 SHA-256 去重存入 `media/`（`origin = 'cinema_frame'`, `activity_session_id = session.id`, `pinned = 0`）；
- **单帧注入红线**：主对话 Dynamic Tail 的 `<active_activity>` 仅展示当前片名、集数、播放进度、可选近期字幕（`≤ 300` 字）以及**最新 1 张有效抽帧**（仅当该帧距当前对话不超过 `90` 秒且 `vision` 槽位可用时附带多模态图像块；不可用时退化为纯文字进度与字幕描述），严禁把整场历史抽帧堆进历史消息；
- **24h 淘汰衔接**：观影结束满 24 小时后，由 `Spec 02` §8.3 睡前清理任务按 `activity_sessions.ended_at` 自动淘汰冗余临时帧（每场等距保留 3 张代表帧 + 全部 `pinned = 1` 帧）。

#### 防误结束机制（Anti-Premature-End）
- 客户端切后台、断网重连或暂停倒水**绝不自动结束观影**；
- 服务端在定时心跳中巡检活跃 `cinema` 会话的 `last_heartbeat_at`（任何新帧、进度心跳或带 `activity='cinema'` 的聊天消息都会刷新它）：
  1. **停更 `≥ 30 分钟`**：将 `status` 置为 `stale` 并广播 `activity.updated`，前端观影卡出现温和提示“暂停有一会儿了，要结束这场观影吗？”（用户发新帧或聊观影即自动恢复 `active`）；
  2. **停更 `≥ 4 小时`**（或已进入 `bedtime` 睡眠窗且停更 `≥ 1 小时`）：服务端自动执行软结束（`reason: "timeout"`），置 `ended_at` 并派发 `activity:cinema` 整理轮，防止僵尸活动永久锁死 `daily_wrapup` 门禁。

#### 观影专属 Tier 2 工具（观影活跃时在 Dynamic Tail 暴露，经 `call_tool` 执行）
- **`cinema.status`**（`security: "auto"`）：返回当前片名、集数、精确进度（`mm:ss / mm:ss`）、播放/暂停态与本场已收藏帧数；
- **`cinema.bookmark`**（`security: "auto"`，参数 `{ note?: string }`）：将当前最新抽帧的 `media_assets.pinned` 置为 `1`（永久免淘汰）并在 `activity_sessions.metadata.bookmarks` 记录时间戳与简短备注，返回 `media/<hash>` 供住户写进卡片或收藏。

---

## 5. 外部 MCP 桥接挂入 Tier 3 工具池（Ring 1.5）（`server/src/extensions/mcp.ts`）

### 5.1 配置与凭证分离

外部 MCP 服务器清单位于 `<dataDir>/config.json` 的 `mcpServers` 节点（敏感令牌只存 `<dataDir>/credentials.json`，通过 `credentialKey` 引用，严禁明文落入 `config.json`）：

```ts
export interface McpServerConfig {
  id: string;                            // 唯一标识，匹配 ^[a-z0-9][a-z0-9_-]{0,31}$
  enabled: boolean;
  transport: "stdio" | "streamable_http";
  // stdio 传输
  command?: string;
  args?: string[];
  env?: Record<string, string>;          // 允许值使用 "${cred:<key>}" 占位符从 credentials.json 注入
  // streamable_http 传输
  url?: string;
  headers?: Record<string, string>;      // 同样支持 "${cred:<key>}"
  // 安全与超时治理
  trustLevel?: "confirm" | "auto";       // 缺省 "confirm"（保守默认）
  autoAllowTools?: string[];             // 仅指定只读工具名放行 "auto"，其余仍走 "confirm"
  timeoutMs?: number;                    // 单次调用超时，默认 30_000，上限 120_000
}
```

### 5.2 Tier 3 挂载、权限与容错红线

1. **命名空间隔离与稳态缓存**：所有外部 MCP 工具自动注册为 `mcp.<serverId>.<toolName>`，强制 `tier: 3`（**绝不进入 Tier 1 `tools[]`**，确保 Static Prefix Prompt Cache 零抖动）；住户通过 `tool_search(query)` 检索精简 schema 后经 `call_tool` 调用；
2. **默认保守审批**：除用户在 `config.json` 显式设为 `trustLevel: "auto"` 或列入 `autoAllowTools` 的工具外，外部 MCP 工具一律默认 `security: "confirm"`，调用时挂起工具循环并走 `Spec 01` §4.3 审批卡；
3. **非阻塞启动与故障隔离**：
   - 后端启动时**异步**连接各已启用 MCP 服务器（单服握手超时 `10s`）；任意外部 MCP 不可达、进程崩溃或协议异常仅记录结构化告警并标记该服为 `degraded`，**绝不阻塞 Psyber 启动或影响主对话**；
   - `stdio` 子进程意外退出时采用指数退避重连（`2s → 10s → 30s`，最多 3 次；仍失败暂停重连，待用户通过设置热重载或手动重连恢复）；
4. **输出截断与超时保护**：单次工具调用受 `AbortSignal.timeout(timeoutMs)` 严格保护；返回文本超过 **`8000` 字符**时截断末尾并附 `[外部工具输出已截断，原始长度 N 字符]`，避免外部 MCP 返回巨型 JSON 击穿单轮上下文；
5. **热重载清理**：`PATCH /api/v1/settings` 修改 `mcpServers` 后，先优雅关闭已移除或变更的子进程（`SIGTERM`，3s 后 `SIGKILL`），注销旧工具并重新发现注册新工具。

---

## 6. Spec 03 出口验收清单（按 Ring 1 / Ring 1.5+ 分期对照）

### Ring 1 必过验收
- [ ] 门状态机 5 态 Schema 冻结、Ring 1 `guard` 暂拒 `cooling_off`/`departed`、`closed` 期间发消息仅存 `door_note` 不唤醒 AI、`door_notes_read` 与 `daily_wrapup` 游标彻底解耦（整理轮连续收且不推进 `door_notes_read`，`wake` 含 `[SILENT]` 正常完成后推进）；
- [ ] `express` 单轮 3 次节流、`durationSec` 夹逼、静态 `stickers/` 启动同步入表与无效 `stickerId` 自救报错、`<stickers>` 注入严格 `≤ 30 条 / 500 字`；
- [ ] `desktop` + `webhook` 离线推送 5s 超时隔离、前台活跃抑制、睡眠窗静默、`wake` 连续 2 次未回退避停发、扁平 `circadian.ts` 跨午夜 `bedtime` 不重复触发且零内部浮点数泄露。

### Ring 1.5 / Ring 2 扩展验收
- [ ] （Ring 1.5）`private/` 上锁抽屉 `GET /drawer` 绝不解封正文、`POST /drawer/:id/open` 严格先写 `privacy.peeked` 再返回明文；Bark / ntfy 独立通道与单设备推送令牌扇出；
- [ ] （Ring 1.5）`activity_sessions` 建表、单活跃活动互斥、`cinema` 15s 抽帧节流 + 512KB 上限 + 单帧注入 + 30m `stale`/4h 软结束防误结束、`cinema.bookmark` 钉帧免淘汰与 24h 清理衔接；
- [ ] （Ring 1.5）外部 MCP 桥接全部归入 Tier 3 `mcp.<serverId>.<toolName>`、凭证分离、单服宕机零阻塞主服务、8000 字截断与热重载子进程清理；
- [ ] （Ring 2）冷静期 24–72h 时间锁与超时自然退回 `closed`、`DEPARTED.md` 原子写出诚实声明并转为只读 `410 GONE`。
