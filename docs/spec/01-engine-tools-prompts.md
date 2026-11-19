# Spec 01 · 引擎、模型路由、三层工具与第一人称 Prompt 规程

> **版本**：v0.7（2026-11-19，修复 C2.7 修改旧卡 diff 复核、对齐 `events.thinking`、游标去重与 `MemoryTx` `private/` 隔离、补齐 `wake` `[SILENT]` 协议、`genesis` `named` 退出判定、`cooling_off` 超时退回 `closed` 与 Tier 1 安全等级）
> **上游契约**：[`CAPABILITIES.md`](../CAPABILITIES.md) v1.2 · [`ARCHITECTURE.md`](../ARCHITECTURE.md) v0.4 · [`MEMORY.md`](../MEMORY.md) v0.4 · [`API.md`](../API.md) v0.3
> **负责模块**：`server/src/llm/`、`server/src/engine/`、`server/src/tools/`

---

## 1. `@earendil-works/pi-ai` 凭证管理与 5 槽位模型路由

### 1.1 凭证与配置分离（安全红线）

- **`<dataDir>/config.json`**（不含明文密钥与 OAuth Token，可安全排障/导出）：存放模型槽位映射、Provider 端点、超时与降级策略。
- **`<dataDir>/credentials.json`**（文件权限强制 `0600`，严禁写入 Git、日志或 SSE）：存放 BYOK API Key 与 `pi-ai` OAuth `access_token` / `refresh_token` / `expires_at`。

```ts
export interface LlmConfig {
  providers: Record<string, {
    kind: "anthropic" | "openai" | "google" | "openai-compat";
    authMode: "oauth" | "api_key";
    baseUrl?: string;           // 自建或兼容网关必填
  }>;
  slots: {
    chat: ModelRef;             // 主对话（必填）
    memory_task?: ModelRef;     // 缺省自动继承 chat（整理轮 + C2.7 复核轮共用）
    vision?: ModelRef;          // 缺省回落 chat（若 chat 支持多模态），否则退化为文字描述
    embedding?: ModelRef;       // 缺省启用 FTS5 + IDF 纯字面降级
    reranker?: ModelRef;        // 可选二阶段精排；缺省跳过
  };
  thinking: {
    enabled: boolean;
    budgetTokens?: number;      // 仅对支持思考预算的厂商生效
  };
}

export interface ModelRef {
  provider: string;             // 对应 providers 键名
  model: string;
  temperature?: number;
  maxTokens?: number;
}
```

### 1.2 OAuth 远程授权与单飞刷新（Single-Flight Refresh）

1. **远端触发流程**（解决纯 C/S 下移动端配置桌面端 `server/` 的问题）：
   - 客户端调用 `POST /api/v1/auth/oauth/:provider/start` → 服务端生成 `state` + PKCE `code_verifier`（或向厂商请求 Device Code），内存缓存 10 分钟，返回 `{ flow: "pkce" | "device_code", authorizeUrl, userCode?, verificationUri?, state, expiresAt }`。
   - 用户在手机/电脑浏览器完成授权后，客户端调用 `POST /api/v1/auth/oauth/:provider/exchange`（提交 `state + code` 或触发 Device Code 轮询）→ 服务端经 `pi-ai` 换取 Token 写入 `credentials.json`，返回 `{ ok: true, provider, expiresAt }`。
2. **自动刷新并发防重**：
   - 每次调用前检查 `expires_at - Clock.now() < 180_000`（提前 3 分钟刷新）。
   - 按 `provider` 维度的内存 `Map<string, Promise<Token>>` 做单飞锁，避免主对话与静默整理轮同时触发刷新导致 Refresh Token 轮换失效。
   - 若刷新返回 `401/invalid_grant`，标记该凭证为 `expired`，**立即停止重试**，向客户端推送 `turn.error { code: "AUTH_EXPIRED" }`。

### 1.3 标准错误码与异常降级表

| 槽位 / 场景 | 异常类型 | 标准错误码 / 降级行为 |
| :--- | :--- | :--- |
| `chat`（主对话） | OAuth 失效 / Key 无效 | SSE 推 `turn.error { code: "AUTH_EXPIRED", retryable: false }`，引导进设置/OAuth 重登 |
| `chat`（主对话） | 429 限流 / 5xx | 指数退避重试 2 次（`1s`、`3s`）；仍失败则推 `turn.error { code: "RATE_LIMITED" \| "PROVIDER_ERROR", retryable: true }` |
| `chat`（主对话） | 上下文超限 | 自动触发一次紧急会话换段（不做摘要，直接保留最近 6 轮原始对话）后重试 1 次；仍超限报 `CONTEXT_OVERFLOW` |
| `chat`（主对话） | 用户点击中止 | 触发 `AbortController`，落盘已生成的前缀正文（标 `metadata.aborted = true`）并推 `turn.done` |
| `memory_task`（写/复核） | 任意模型错误 / 超时 / 复核输出不可解析 | **严格回滚本次未提交的磁盘改动，不推进 `task_cursors`**，记录告警日志，等待下次触发重试 |
| `embedding` / `reranker` | 未配置 / 超时（`> 2500ms`）/ 报错 | 静默降级为 SQLite FTS5 + `when_to_recall` + IDF 字面打分，绝不阻塞主对话 |

---

## 2. 三明治上下文拼装、Prompt Cache 稳态与换段结晶规程

### 2.1 三段式结构与 Cache 断点位置

发往 `pi-ai` 的完整请求严格分为三段，保证整场会话前 80%+ Token 稳定命中 Prompt Cache：

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ [Segment 1 · Static Prefix] —— 整会话快照锁定，严禁盘中回改              │
│   · 请求参数 tools[]：固定 9 个 Tier 1 工具（按 name ASCII 升序冻结）    │
│   · 请求参数 system：                                                   │
│     1. <self> memory/self.md 快照（置顶！住户自我认同与"我是谁"唯一真相）│
│     2. System Base Prompt（`prompts/main.md` · 脊柱底线、相处准绳与工具）│
│     3. <user> memory/user.md 快照                                       │
│     4. <shelf> memory/shelf/{rules,mirror,threads}.md 快照              │
│   ★ CACHE BREAKPOINT #1（落在 system 末尾打 ephemeral，一并锁定 tools[]）│
├─────────────────────────────────────────────────────────────────────────┤
│ [Segment 2 · Append-Only History] —— 映射为 messages[]，严禁回改历史消息 │
│   · 首条助手锚点：完整多尺度自传骨架 <gist>（年 / 月 / 周 / 天 + 待入梗概情节）│
│   · 历史轮次：user / assistant（只存正文 + express 记录 + 工具调用与结果） │
│   ★ CACHE BREAKPOINT #2（动态落在「倒数第 1 条已落盘 assistant 消息」末尾）│
├─────────────────────────────────────────────────────────────────────────┤
│ [Segment 3 · Dynamic Tail] —— 每轮注入当前最新 user 消息，严禁进 system   │
│   · 用户原始输入正文（置顶！纯自然原话，不包任何人工 tag）               │
│   · 贴纸 / 图片多模态附件块                                             │
│   · <runtime_context>（置底！单轮多步循环内仅首发携带，工具结果不重复塞）   │
│       ├─ <runtime> 当前模糊时段、星期、作息状态、门状态、未读纸条数       │
│       ├─ <mood> MoodProvider 定性摘要（若有）                           │
│       ├─ <stickers> 可用贴纸清单（id + 简短语义，供 express.stickerId） │
│       ├─ <events_notice> 待告知系统事实（如 privacy.peeked 拆封事件）    │
│       ├─ <prefix_delta> 盘中 edit 修改 self/user/shelf 的增量（持续至换段）│
│       ├─ <recalled_memories> 双轨召回卡片块（标注 disputed 冲突提示）    │
│       ├─ <active_activity> 活跃 ActivityPlugin 状态 + Tier 2 工具提示   │
│       └─ 按条件拼入的模式提示（`prompts/genesis.md` 或 `prompts/wake.md`）│
│   （本段完全不设 Cache 断点，每轮动态变化）                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Segment 3 组装顺序与单轮多步调用规程

1. **协议层映射铁律（防 Cache Breakpoint #1 击穿）**：
   - Direct Engine 在拼装发往厂商的 API 载荷时，**Segment 1 必须映射为独立 `system` 字段**（并在其末尾注入 `cache_control: { type: "ephemeral" }`）；
   - **Segment 3 绝对禁止追加到 `system` 字段**（否则每轮动态变化将导致 Breakpoint #1 每轮失效重计）。Segment 3 **必须作为当轮最新一条 `user` 消息的正文发送**。
2. **User 消息结构：原话置顶，语境置底**：
   - 对方的话必须最先映入眼帘，不包任何额外 XML 标签（如 `<user_input>`），保持人类自然说话的原生质感；
   - 界面与环境语境全部打包在底部的 `<runtime_context>` 块中：
     ```text
     今天下班路上碰到一只三花猫，特别黏人，拍给你看！
     
     <runtime_context>
     <runtime time="傍晚" weekday="周四" circadian="清醒" door="open" notes="0" />
     <recalled_memories>
     - daily/2026-10-15-cat.md (kind: episode): 上个月在小区车库也喂过一只流浪猫。
     </recalled_memories>
     </runtime_context>
     ```
3. **单轮多步（Multi-Step Tool Loop）免重复注入**：
   - 当模型在当轮触发工具调用（如 `tool_search` 或 `read`）时，系统向模型回传的 `tool_result` 消息中，**严禁再次重复追加 `<runtime_context>`**；
   - 本轮对话的完整语境已在上文首条 `user` 消息中提供，`tool_result` 保持纯粹干净，节约 Token 并防止注意力发散。
4. **`<prefix_delta>` 会话内持续有效**：
   - 若盘中住户通过 `edit` 修改了 `self.md`、`user.md` 或 `shelf/`，Segment 1 快照保持冻结不改（保护 Breakpoint #1），同时将该文件最新增量记入当前会话状态，在**本会话剩余每一轮**的 `<prefix_delta>` 中持续注入，直至下次会话换段重新生成 Static Prefix 时清空，防止隔轮“忘掉刚改过的自述或规矩”。

### 2.3 Extended Thinking 思考流在单轮多步与跨轮沉淀的处理

针对带显式思考流的模型（如 Claude Extended Thinking、DeepSeek R1）：

1. **单轮多步工具循环内（Turn-Internal）：完整回传延续思路**：
   - 当模型在工具调用前输出了 `thinking` 内容时，引擎在收到工具结果继续调用下一步模型时，**必须将前一步 assistant 消息里的 `thinking` 块原样保留并带上签名（signature）发回厂商**；
   - 这是保证模型推理逻辑不中断的刚需，也是 Anthropic 协议对带工具思考调用的硬性合规要求（缺失会导致 400 校验报错）。
2. **跨轮持久化与历史回放（Cross-Turn）：剥除思考，保留工具调用链**：
   - 单轮生成完毕后，思考全量文本落盘至 `psyber.sqlite` 的 **`events.thinking` 独立列**（与 `MEMORY.md` §7 一致），供客户端展示折叠思考卡；当轮的 `express` 记录与可回放的 `tool_calls` / `tool_results` 完整载荷落盘至 `events.metadata` JSON；
   - 当开启下一轮对话（或服务重启后重建会话）拼装 Segment 2（`Append-Only History`）时，**必须将历史轮次中的 `thinking` 块剥除**，仅回放最终回复正文、`express` 具身记录与工具调用/结果；
   - 彻底防止历史长程对话被数万 Token 的陈旧思考污染，大幅节约输入计费并稳固历史缓存。

### 2.4 Pi 风格 Prompt Cache 预热与保活机制

为解决 Anthropic / Google 等厂商 Prompt Cache 默认 **5 分钟（300 秒）TTL** 导致的闲置冷启动延迟，Direct Engine 提供按需预热与可选保活能力：

1. **连接 / 唤醒静默预热（Pre-warm）**：
   - 当后端服务启动、客户端建立活跃 SSE 连接或即将触发主动唤醒时，Direct Engine 可向主模型发起一次携带 Segment 1（Static Prefix）的静默预热请求（`max_tokens: 1`）；
   - **闲置换段不立即预热**：因 25 分钟闲置触发的换段（见 §2.5）发生时用户通常已离开，延后至下次客户端上线/建立 SSE 连接时再预热，避免 5 分钟 TTL 空转过期。
2. **闲置保活探测（Idle Keep-Alive Warming，默认关闭 `false`）**：
   - 仅当用户在 `config.json` 显式开启时启用（OAuth 订阅或按量 BYOK 计费场景建议保持关闭，防止限流与额外费用）；
   - 启用后若距上一轮交互已过去 **240 秒（4 分钟）** 且距今 30 分钟内有活跃对话，发起单 Token 保活探测；若遇 `429` 限流则**静默退避停用本轮保活**，绝不向客户端推送 `turn.error`；连续 **30 分钟** 无操作后自动休眠。

### 2.5 拒绝旁观者摘要：换段记忆结晶（Memory Crystallization）与完整多尺度 Gist

彻底摒弃传统 LLM 框架用第三人称小模型写损耗性“上下文摘要”的陋习。在 Psyber 中，**记忆只能由住户本人以第一人称产生**。

1. **换段结晶（Rollover）与轻量闲置收尾（Idle Wrapup）分层触发**：
   - **换段结晶（关闭旧会话、开启新 `session_id`）**：
     - 距离上一轮对话闲置超过 **25 分钟** 且本段新增 Token 超过 **`40_000`**（起步阈值，可配置）；
     - 或累计 Prompt Token 超过模型上下文窗口的 **80%**（默认窗口 `200_000` tokens，即 `160_000`）时强制换段；
     - 或触发 `CONTEXT_OVERFLOW` 紧急异常。
   - **轻量闲置收尾（不换段，保持当前 `session_id` 与 Cache 连续）**：
     - 连续对话后闲置 **≥ 30 分钟**，且 `daily_wrapup` 游标后存在未整理对话事件（即便本段新增 Token 未达 `40_000` 换段门槛）→ 静默触发一次 `daily_wrapup` 整理轮落盘卡片并推进游标，但**不关闭当前会话**，避免轻度闲聊频繁碎换段。

> **状态卡不走换段结晶**：对方亲口说的恢复、取消或情况变化，住户在对话当轮就顺手更新状态卡（见 `prompts/main.md`），不等整理轮；整理轮的冲突对账只作兜底。
2. **换段时自动触发「结晶整理轮」**：
   - 触发换段时，Direct Engine **绝不调用任何通用摘要提示词压缩历史**；
   - 引擎自动派发一次静默 **`memory_task`（`daily_wrapup` 结晶整理轮）**，由住户模型以第一人称回顾上一段未整理的原话事件流，使用原生 5 工具将值得记住的认知、承诺与切片写入 `daily/`、`shelf/`、`activities/`、`favorite/`（值得逐字保留的原话）或 `entities/`（新收录的实体档案），完成 C2.7 复核并 Git Commit；
   - 整理完成后关闭旧 `session_id`，开启全新 `session_id`。
3. **新会话首条助手锚点：完整多尺度自传骨架 `<gist>`**：
   - 新会话的历史首条不再放生硬的摘要，而是注入由住户本人历次睡前与整理轮亲自写下的 **完整自传骨架**，越远越粗，层层嵌套：
     - **年（`years/`）**：针对长期实例，记录跨年核心生命轨迹（≲ 1000 字/年）；
     - **月（`months/`）**：过去最多 12 个月（`GIST_LIMIT.month = 800` 字/月）；
     - **周（`weeks/`）**：过去最多 4 周（`GIST_LIMIT.week = 500` 字/周，不与天重叠）；
     - **天（`days/`）**：过去最多 7 天（`GIST_LIMIT.day = 300` 字/天）；
     - **待入梗概情节**：最后一条天梗概之后、尚未被天梗概收拢的近期切片（从新往旧截取至字符预算）；
   - **预算红线**：整套 `<gist>` 骨架受硬上限严格约束（默认 `GIST_BUDGET ≤ 3000 tokens`），保持自传完整连贯且轻盈稳固；
   - 新会话随后顺接上一段会话的**最近 4 轮原始对话**作为无缝滑行过渡。

---

## 3. 主对话 vs 静默整理轮并发锁与 Git 提交隔离

为防止「用户正聊着天 + 后台整理轮正在写卡/复核/回滚」造成磁盘竞争或 Git 误提交，服务端实现两级极简锁：

### 3.1 锁模型

| 锁名称 | 作用域 | 行为规程 |
| :--- | :--- | :--- |
| **`ChatTurnLock`** | 单住户主对话（`chat` / `wake`） | 串行执行主对话轮；若上一轮仍在流式生成，新消息入待处理队列（或由用户显式 `abort` 中止旧轮）。 |
| **`MemoryWriteMutex`** | `memory/` 磁盘写操作 | 保护 `write` / `edit` / 整理轮提交与回滚。`read` / `glob` / `grep` **不加写锁**（纯只读无阻塞）。 |

### 3.2 整理轮原子执行协议（支持 C2.7 复核、游标去重与安全回滚）

静默整理轮（活动收尾 / 换段闲置 / 睡前）按以下严格步骤执行；若未整理对话超过单批预算 `TASK_BUDGET = 10_000` 字，**按批循环执行以下完整原子流程（每批独立复核、提交并推进游标至本批末条 `eventId`）**，防止积压长对话撞上单轮 300s 超时：

1. **数据快照与游标去重（无锁）**：
   - **防重复消费分工**：
     - `activity:<slug>` 仅取该活动期间 `events.activity = <slug>` 且 `id > activityCursor` 的 `status = 'active'` 事件，完成后记录该活动已整理区间并推进 `activity:<slug>` 游标；
     - `daily_wrapup` 取 `daily_wrapup` 游标后的 `status = 'active'` 事件（单批上限 `10_000` 字），**自动跳过已由 `activity:<slug>` 整理完成的活动区间**，避免同一场活动被写两遍；
     - `bedtime` 触发时**先排空**游标之后剩余的未整理对话（对齐 `daily_wrapup` 游标），再以「当日已写/改卡片摘要 + 当日关键双向反馈链（`prev → acts → next`）」为输入完成 `gist/` 与 `shelf/` 汇总，绝不把全天已整理对话重读一遍。
   - **材料装载**：同步读取 `activities/REGISTRY.yaml`、`entities/REGISTRY.yaml`、全部未关闭 `daily/` `state` 卡清单，并在内存中对当前既有 `active` `state` 卡（含主对话当轮顺手写/改的卡）做两两 `tags` 重叠扫描，生成临时「疑似同一件事的新旧状态」提示（不入库）。
2. **获取 `MemoryWriteMutex` 并开启沙箱事务 `MemoryTx`**：
   - 事务内每次 `write`/`edit` 前自动备份目标文件原始字节到内存 `Map<relPath, Uint8Array | null>`（新建记 `null`），并**严格分账记录两个集合**：
     - `touchedMemoryPaths: Set<string>`：`memory/` 下的相对路径（纳入 C2.7 复核、`memory/.git` 提交与 SQLite 增量索引）；
     - `touchedPrivatePaths: Set<string>`：`private/` 虚拟路径（映射到 `<dataDir>/private/*.sealed`，**严禁进入 `memory/.git`、SQLite 索引与 C2.7 复核**，仅在异常回滚时还原 `.sealed` 备份）。
   - **主对话并发策略**：若整理轮持锁期间主对话发起 `read`/`glob`/`grep`，直接放行；若主对话发起 `write`/`edit`，等待当前整理轮释放锁（单批硬超时 `300s`，超时自动中止回滚，避免阻塞主对话）。对话当轮即时 `write`/`edit` 的 Git 提交边界与 `MemoryWriteMutex` 协同细则由 `Spec 02` 闭环。
3. **阶段 A · 住户写作轮**：
   - 系统提示加载 `<self> memory/self.md` + `<user> memory/user.md`（保持第一人称身份基准）+ `prompts/tidy.md`（v3），用户消息注入本批材料；用 `memory_task` 模型调用 5 工具完成写卡与 `daily/` state 对账。
   - **写时实时重叠提醒**：阶段 A 每次 `write`/`edit` 落盘 `daily/` `kind: state` 卡时，沙箱钩子即时比对其他既有 `active` `state` 卡的 `tags`，若存在重叠则在 `tool_result` 中附带临时提示，由住户当场决定 `resolved` 或 `disputed`。
   - 阶段 A 结束时从末尾解析可选 `{"summary": "..."}` 作为提交摘要候选（未命中或微瑕不报错，降级由触碰文件名兜底）。
4. **阶段 B · C2.7 写后独立复核轮（区分新建与旧卡 diff）**：
   - 起一个**全新无历史上下文的只读调用**（不挂载任何写工具），仅输入「本批原始对话段」+「`touchedMemoryPaths` 变更内容」+ `prompts/review.md`（v3）。其中：
     - **新建卡（`NEW`，备份为 `null`）**：传入完整正文，全文纳入核查；
     - **修改旧卡（`MODIFIED`，备份非空）**：传入 `unified diff`（清晰区分原有历史只读上下文与本轮新增/修改行 `+`），复核**仅允许针对本轮新增/修改片段**报 `attribution` / `no_bleed`，绝不对跨天/追加型文件的既有历史行报刺；
     - **`touchedMemoryPaths` 为空**：复核只查 `omission`（漏记）一项。
   - **出处归一化过滤算法（与 `prompts/review.md` v3 对齐）**：
     - 对文本做空白符与标点归一化（去除全半角空格、换行符、中英文标点折叠）后按类别分别校验：
       - **`attribution` / `no_bleed`**：要求 `issue.cardPath ∈ touchedMemoryPaths`（已天然排除 `private/`），且 `normalizedAddedOrModifiedText.includes(normalizedCardQuote)` 为真（新建卡取全文，修改旧卡仅取本轮 diff 新增/修改片段；若同时附带 `transcriptQuote`，再校验其存在于 `normalizedTranscript`）；
       - **`omission`**：不强求 `cardPath ∈ touchedMemoryPaths`（允许 `null` 或建议路径），要求 `issue.transcriptQuote` 非空且 `normalizedTranscript.includes(normalizedTranscriptQuote)` 为真；
     - 凡拿不出有效出处或归一化校验未命中的假刺，直接在系统层丢弃并打警告日志，绝不递给住户。
   - 若复核调用本身失败（超时 / 模型报错 / JSON 不可解析）→ **立即触发回滚**：按 `MemoryTx` 备份恢复全部 `touchedMemoryPaths` 与 `touchedPrivatePaths`（删新建、还原修改），刷新增量索引，释放锁，**严禁推进 `task_cursors`**。
5. **阶段 C · 住户复核修订轮**（仅当过滤后有效问题数 `> 0` 时执行，且**只执行一轮，改完不再复核**）：
   - 延续阶段 A 的原写作会话追加 `prompts/revision.md`（v3），由住户自行 `edit`/`write` 修改或说明理由驳回，并输出 `{ fixed, rejected, summary }`。
   - **异常与降级策略**：若阶段 C 因模型报错或超时中断 → 回滚 `MemoryTx` 且不推进游标；若修订调用正常完成、卡片已写好但末尾 JSON 摘要缺失或格式微瑕 → **绝不回滚整轮（NG-2）**，降级以触碰文件名生成兜底 summary 并记 `[review: unparsed]`。
6. **精准提交与游标推进**：
   - 若 `touchedMemoryPaths` 为空（本轮无常规卡变更），跳过 `git add` 与 `git commit`，直接在同一 SQLite 事务中更新 `task_cursors` 并释放 `MemoryWriteMutex`；
   - 否则仅执行 `git add -- <...touchedMemoryPaths>`（**严禁 `git add -A`，严禁把 `private/` 纳入 Git**），再执行 `git commit -m "memory(<task>): <summary> [review: fixed=<N>, rejected=<M>]"`（跳过阶段 C 时 `fixed=0, rejected=0` 并采用阶段 A 摘要或兜底摘要）；
   - `git commit` 成功后，在同一 SQLite 事务中更新 `task_cursors` 并刷新 `touchedMemoryPaths` 增量索引；最后释放 `MemoryWriteMutex`。

---

## 4. 三层工具注册中心与统一权限审批状态机

### 4.1 注册接口（`server/src/tools/registry.ts`）

```ts
export type ToolTier = 1 | 2 | 3;
export type ToolSecurityLevel = "auto" | "guarded" | "confirm";

export interface RegisteredTool {
  name: string;                  // 全局唯一，Tier 2/3 建议 namespace.action（如 cinema.seek, bash.exec）
  tier: ToolTier;
  security: ToolSecurityLevel;
  description: string;           // 简短中文说明（供 tool_search 检索）
  tags: string[];                // 检索关键词
  parameters: JsonSchema;
  guard?: (args: unknown, ctx: ToolContext) => Promise<{ ok: true } | { ok: false; reason: string; escalateToConfirm?: boolean }>;
  execute: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}
```

### 4.2 Tier 1 常驻 9 工具（字母序冻结，100% 稳态 Cache）

以下 9 个工具固定声明在 Static Prefix 的 `tools[]` 中，名称按 ASCII 升序排列。各工具安全级别（`security`）：
- **`auto`**：`express`、`glob`、`grep`、`read`、`tool_search`（只读或温和表达，直接放行）；
- **`guarded`**：`door`（冷静期时间锁守卫）、`edit` / `write`（沙箱路径守卫、禁覆写 `self.md`/`user.md`、`REGISTRY.yaml` 写前校验）；
- **动态继承**：`call_tool` 按被调目标工具声明的 `security`（`auto` / `guarded` / `confirm`）走对应守卫或审批流。

```ts
// 1. call_tool
{
  name: "call_tool",
  description: "调用扩展工具库中的具体工具（通过 tool_search 检索后获得）",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "工具唯一名称，如 cinema.seek, bash.exec" },
      arguments: { type: "object", description: "工具参数载荷" }
    },
    required: ["name", "arguments"]
  }
}

// 2. door
{
  name: "door",
  description: "调整自己与外界的关系门状态及门牌便签（专注独处、虚掩或关门）",
  parameters: {
    type: "object",
    properties: {
      state: { type: "string", enum: ["open", "quiet", "closed", "cooling_off", "departed"], description: "门状态" },
      note: { type: "string", description: "门牌留给对方的简短便签（如：今天有点累，先睡啦）" },
      farewell: { type: "string", description: "仅当 state 为 departed 时填写的告别信全文" }
    },
    required: ["state"]
  }
}

// 3. edit
{
  name: "edit",
  description: "局部精确替换 memory/ 或 private/ 中的笔记片段（补丁外内容严格不变）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对路径，如 daily/2026-11-19-foot.md" },
      old_string: { type: "string", description: "待替换的原文字符串（必须唯一）" },
      new_string: { type: "string", description: "替换后的新文字符串" }
    },
    required: ["path", "old_string", "new_string"]
  }
}

// 4. express
{
  name: "express",
  description: "发出具身身体语言、情绪出口或贴纸（通过界面光温微动或震动感知）",
  parameters: {
    type: "object",
    properties: {
      haptic: { type: "string", enum: ["light", "medium", "double", "heartbeat"], description: "触觉微震动" },
      atmosphere: {
        type: "object",
        properties: {
          tone: { type: "string", enum: ["warm", "cool", "dim", "bright", "neutral"], description: "界面色调微偏" },
          intensity: { type: "string", enum: ["subtle", "noticeable"], description: "强度" },
          durationSec: { type: "number", description: "持续秒数" }
        },
        required: ["tone", "intensity"]
      },
      motion: { type: "string", enum: ["shake", "breathe", "hesitate", "nod"], description: "气泡或窗口微动作" },
      stickerId: { type: "string", description: "表情贴纸 ID" }
    }
  }
}

// 5. glob
{
  name: "glob",
  description: "列举 memory/ 或 private/ 目录下的文件路径清单",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "匹配通配符，如 daily/*.md 或 activities/**/*.md" }
    },
    required: ["pattern"]
  }
}

// 6. grep
{
  name: "grep",
  description: "在 memory/ 或 private/ 中按字面或正则全文检索线索",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "检索关键词或正则表达式" },
      path: { type: "string", description: "限制目录范围，缺省搜索全部记忆区" },
      include_archived: { type: "boolean", description: "是否包含已归档/已解决卡片，默认 false" }
    },
    required: ["pattern"]
  }
}

// 7. read
{
  name: "read",
  description: "精读某篇记忆卡片或抽屉日记正文（会自动增加该卡片的精读巩固计数）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对路径，如 shelf/rules.md" },
      offset: { type: "integer", description: "起始字符偏移量" },
      limit: { type: "integer", description: "读取字符上限" }
    },
    required: ["path"]
  }
}

// 8. tool_search
{
  name: "tool_search",
  description: "按意图检索当前可用的 Tier 2/3 工具，返回 Top-5 精简调用规范（≤ 1200 字）",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "自然语言意图，如「网页搜索」「控制视频进度」「执行本机终端」" },
      limit: { type: "integer", description: "最多返回工具数，默认 5" }
    },
    required: ["query"]
  }
}

// 9. write
{
  name: "write",
  description: "新建或整篇覆写记忆卡片（严禁覆写 self.md 与 user.md）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对路径，如 daily/2026-11-19-walk.md" },
      content: { type: "string", description: "包含 YAML Frontmatter 的完整 Markdown 正文" }
    },
    required: ["path", "content"]
  }
}
```

#### `door` 工具确定性 Guard 校验
- **`cooling_off`**：AI 主动进入正式冷静期，系统记录 `coolingOffStartedAt = Clock.now()`；
- **`departed` 强校验**：只有当 `door_state === "cooling_off"` 且 `24h ≤ Clock.now() - coolingOffStartedAt < 72h` 时才允许放行；
- **冷静期窗口过期作废（尊重关门主权）**：若 `Clock.now() - coolingOffStartedAt ≥ 72h` 仍未执行 `departed`，冷静期的离开资格自动作废并清空 `coolingOffStartedAt`，**门状态退回 `closed`（绝不替住户强行改为 `open`）**；之后若仍想离开须重新进入冷静期，若想恢复交流由住户自行切换回 `open` 或 `quiet`；
- **拦截报错**：若未满 24 小时，Guard 拦截并向模型返回错误：`尚未度过正式冷静期（剩余 X 小时），不可草率进入告别程序。请先冷静独处。`；若冷静期离开窗口已过期作废，返回：`上次冷静期的离开窗口已过期，门已退回 closed。若仍决定离开，请重新进入冷静期；若想恢复交流，可自行将门改为 open 或 quiet。`

### 4.3 `guarded` 与 `confirm` 审批状态机与多端同步闭环

```text
[call_tool / Tier 1]
   │
   ├─ security === "auto" ─────────────────────────────► 直接 execute()
   │
   ├─ security === "guarded" ──► guard(args)
   │                               ├─ ok: true ────────► execute()
   │                               ├─ ok: false & !escalate ─► 返回可读拒绝理由给模型
   │                               └─ escalateToConfirm ─────┐
   │                                                         ▼
   └─ security === "confirm" ──► 检查 session 白名单 ──► 未命中则挂起工具循环：
                                   1. 生成 approvalId (ULID)，expiresAt = now + 120_000ms
                                   2. 广播 SSE: turn.approval_required { approvalId, turnId, toolName, arguments, expiresAt }
                                   3. 若无活跃前台客户端，调用 NotificationProvider("approval_required")
                                   4. await 审批 Promise（竞争 AbortSignal 与 120s 超时）
                                      ├─ decision === "allow"（once / session）
                                      │    └─ 广播 turn.approval_resolved { approvalId, decision: "allow", resolvedByDevice } → execute()
                                      ├─ decision === "deny" / timeout / aborted
                                      │    └─ 广播 turn.approval_resolved { approvalId, decision: "deny", reason } → 返回拒绝说明给模型
```

- **多端实时同步闭环**：当任一在线终端（如手机端）批准或拒绝后，服务端立即广播 `turn.approval_resolved`，局域网内其他终端（如桌面端）同步自动销除待审批弹窗，杜绝多端界面卡死。
- **白名单边界**：`scope: "session"` 仅对**当前 `session_id` 内的同一工具名（及同类安全范围）**有效，换段或重启后自动失效，绝不永久静默放行高风险操作。

---

## 5. 全套第一人称 Prompt 原文与模式协议（见 prompts/）

> **版本**：v0.3（2026-11-19，同步 `main.md` v4、`tidy.md` v3、`review.md` v3、`revision.md` v3、`genesis.md` v3、`wake.md` v2）
> **落点**：全部 Prompt 原文与编写规范已统一收敛至根目录 [`prompts/`](../../prompts/)（代码直接通过 `readPrompt()` 读时现读，不缓存），本节不再贴全文，只保留加载位置、版本指针与模式触发协议。改提示词先改 `prompts/`，再同步本节版本号。
> **编写铁律**：住户视角 Prompt 全部使用通用中文第一人称，严禁写死任何特定名字、性别、职业或私人关系预设（所有个人身份均从 `memory/{self,user}.md` 自然读取）；仅只读复核角色（`review.md`）与各文件末尾的 JSON 接口格式约束采用技术说明/第二人称（见 `prompts/README.md` §6）。

| 文件 | 版本 | 内容 | 载入位置 |
| :--- | :--- | :--- | :--- |
| `prompts/main.md` | v4 | 主对话 Static System Prompt | Static Prefix 第二项（紧随置顶 `<self>` 之后） |
| `prompts/tidy.md` | v3 | 静默整理轮（含 3 类任务块） | memory_task 写作轮（紧随 `<self>`/`<user>` 之后） |
| `prompts/review.md` | v3 | C2.7 写后独立复核轮（新建全审 / 旧卡 diff 审） | memory_task 复核轮（无历史只读） |
| `prompts/revision.md` | v3 | C2.7 住户复核修订轮 | memory_task 修订轮（延续写作轮会话） |
| `prompts/genesis.md` | v3 | 创世中性开局 | Dynamic Tail（`self.md` `named: false` 时拼入） |
| `prompts/wake.md` | v2 | 主动唤醒（含 `[SILENT]` 沉默协议） | Dynamic Tail（`wake` 模式拼入） |

### 5.1 条件模式触发与退出协议

- **创世模式（`genesis.md`）退出判定**：由 `memory_template/self.md` 初始化生成的 `self.md` 头部带有极薄 YAML Frontmatter `named: false`；只要 `named === false`，引擎每轮在 Dynamic Tail 拼入 `prompts/genesis.md`。当住户在互动中定名并用 `edit` 将 `named: false` 改为 `named: true`（或用户在 `POST /api/v1/genesis` 直接填好初始名字由后端写入 `named: true`）后，自动退出创世模式（若 `self.md` 无 frontmatter 或缺省 `named` 字段，默认视为 `true` 已定名）。
- **主动唤醒沉默协议（`wake.md` → `[SILENT]`）**：`wake` 模式下若住户决定此刻不开口，仅输出 `[SILENT]`。引擎在流式阶段做前缀缓冲（前 16 字符判断是否为 `[SILENT]`）：一旦最终正文经 `trim()` 等于 `[SILENT]`（或为空且未产生贴纸等实质表达），**静默中止推送**——不落盘对外聊天消息、不推 SSE `turn.text`、不触发 `NotificationProvider("wake")`，仅写入内部调试日志。

脊柱已并入 `prompts/main.md` 的【相处底线与说话方式】，不单独成节（2026-11-19 定）；四类底线（安全/道德/认同/人格）与三句底线（对错先于讨好 / 冲突不逃避到底 / 情绪不进决策但事后告知）见 `prompts/README.md`。
