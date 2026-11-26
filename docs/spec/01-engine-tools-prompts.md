# Spec 01 · 引擎、模型路由、三层工具与第一人称 Prompt 规程

> **版本**：v1.2（2026-11-21，同步 CAPABILITIES v1.4 / ARCHITECTURE v0.8：扩展 `LlmConfig` 支持 `digest` 附件摘要槽位、`fallbacks` 主备降级链、`thinking.level` 离散档位与 `contextLimits` 双上下文上限；补齐手动存记忆换段、原地无痕重试与 `usage` 消耗落盘规程；Dynamic Tail 补入 `<user_status>` 与 `<events_notice>` 分享拆阅/评测透明告知）
> **上游契约**：[`CAPABILITIES.md`](../CAPABILITIES.md) v1.4 · [`ARCHITECTURE.md`](../ARCHITECTURE.md) v0.8 · [`MEMORY.md`](../MEMORY.md) v0.8 · [`API.md`](../API.md) v0.8
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
    fallbacks?: ModelRef[];     // 可选主备模型降级链（Ring 1.5：主模型重试耗尽后按顺序切备用，切换点广播 turn.model_switched）
    memory_task?: ModelRef;     // 缺省自动继承 chat（整理轮 + C2.7 复核轮共用）
    vision?: ModelRef;          // 缺省回落 chat（若 chat 支持多模态），否则退化为文字描述
    digest?: ModelRef;          // 可选附件摘要模型（Ring 1.5：图片/短视频仅当轮传原件，回完后由本模型生成文字摘要替代历史原图省 Token；未配则每轮带原件）
    embedding?: ModelRef;       // 缺省启用 SQLite FTS5 2-gram 纯字面降级（Ring 1.5 按需启用 IDF）
    reranker?: ModelRef;        // 可选二阶段精排；缺省跳过
  };
  thinking: {
    enabled: boolean;
    level?: "off" | "low" | "medium" | "high"; // 推荐面向 UI 的离散思考档位（Ring 1.5）；缺省按 enabled 映射
    budgetTokens?: number;      // 仅对支持自定义思考预算的厂商生效
  };
  contextLimits?: {             // Ring 1.5 聊天 vs 独处双上下文换段上限（默认按模型窗口 75%）
    chat?: number;              // 如 80_000（聊得短一点细节不易被冲淡）
    solo?: number;              // 如 200_000（独处读长文/浏览时更宽裕）
  };
}

export interface ModelRef {
  provider: string;             // 对应 providers 键名
  model: string;
  temperature?: number;
  maxTokens?: number;           // 缺省时官方目录模型沿用目录上限；自定义/兜底模型（含 openai-compat）默认 16384，给推理思考链与多步写卡留足余量
}
```

### 1.2 OAuth 远程授权与单飞刷新（Ring 1.5 启用；Ring 1 先用 BYOK / 本机凭证）

1. **Ring 1 简化**：先支持 `credentials.json` 写入 BYOK API Key 或本机既有凭证即可跑通主对话。
2. **Ring 1.5 远端触发流程与单飞刷新**：通过 `/auth/oauth/:provider/{start,exchange}` 支持 PKCE / Device Code，提前 3 分钟按 `provider` 单飞刷新；刷新报 `401/invalid_grant` 时标记 `expired` 并推 `turn.error { code: "AUTH_EXPIRED" }`。

### 1.3 标准错误码与异常降级表

| 槽位 / 场景 | 异常类型 | 标准错误码 / 降级行为 |
| :--- | :--- | :--- |
| `chat`（主对话） | OAuth 失效 / Key 无效 | SSE 推 `turn.error { code: "AUTH_EXPIRED", retryable: false }`，引导进设置更新凭证 |
| `chat`（主对话） | 429 限流 / 5xx | 指数退避重试 2 次（`1s`、`3s`）；若配置了 `slots.fallbacks` 则按顺序自动切换备用模型（仅在相对上一条助手回复的模型发生变化时广播 `turn.model_switched`）；全部耗尽则推 `turn.error { code: "RATE_LIMITED" \| "PROVIDER_ERROR", retryable: true }` 并支持客户端原地无痕重试（`POST /turns/:turnId/retry`，不重复插入用户消息；若多步工具调用已在前序步骤成功拿到工具结果，保留本轮内存检查点从断点步骤续跑而非整轮重来） |
| `chat`（主对话） | 上下文接近/超出上限 | **先同步执行 `daily_wrapup` 整理旧段**（期间广播 SSE `turn.rollover { phase: "wrapping", reason }` 供前端显示「正在收拢这段记忆…」），整理成功后再切新 `session_id`（持久化 `active_session`，首轮冻结注入 `<continuity>`）；遇到 `CONTEXT_OVERFLOW` 且当前段存在历史时，完成整理换段后当轮自动重试一次；仅当单轮输入本身超限或整理失败时推 `turn.error { code: "CONTEXT_OVERFLOW", retryable: true }`；75% 换段或手动换段若整理失败则保留原 `session_id` 不硬切防失忆 |
| `chat`（主对话） | 用户点击中止 | 触发 `AbortController`，落盘已生成的前缀正文（标 `metadata.aborted = true`）并推 `turn.done` |
| `chat`（主对话） | 输出达到上限截断（`stopReason === "length"`） | 若未产出任何正文、表达或分享，不落盘空白回复，推 `turn.error { code: "PROVIDER_ERROR", retryable: true }` 提示调大 `maxTokens` 或降低思考深度；若已流式输出部分正文则正常落盘并标 `metadata.truncated = true` |
| `memory_task`（写作轮） | 写作阶段模型错误 / 超时 / 输出截断（`stopReason === "length"`）或仅输出思考无正文与工具调用 | **严格回滚本次未提交的磁盘改动，不推进 `task_cursors`**，记录告警日志，等待下次触发重试 |
| `memory_task`（Ring 1.5 复核） | 复核/修订调用超时、报错或 JSON 不可解析 | **非阻塞降级**：仅记录告警日志，**绝不回滚阶段 A 已落盘的合法卡片**，正常提交阶段 A 改动并推进游标 |
| `embedding` / `reranker` | 未配置 / 超时（`embedding > 2500ms`、`reranker > 3000ms`）/ 报错 | Ring 1 静默降级为 SQLite FTS5 2-gram 字面检索或规则/Decision 精排兜底，绝不阻塞主对话 |

---

## 2. 三明治上下文拼装、Prompt Cache 稳态与换段结晶规程

### 2.1 三段式结构与 Cache 断点位置

发往 `pi-ai` 的完整请求严格分为三段，保证整场会话前 80%+ Token 稳定命中 Prompt Cache：

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ [Segment 1 · Static Prefix] —— 整会话快照锁定，严禁盘中回改              │
│   · 请求参数 tools[]：固定 9 个 Tier 1 工具（按 name ASCII 升序冻结）    │
│   · 请求参数 system：                                                   │
│     1. <self> memory/self.md 快照（置顶！Psyber自我认同与"我是谁"唯一真相）│
│     2. System Base Prompt（`prompts/main.md` · 脊柱底线、相处准绳与工具）│
│     3. <user> memory/user.md 快照                                       │
│     4. <shelf> memory/shelf/{rules,mirror,threads}.md 快照              │
│     5. <continuity> 换段/续接自传连续性快照（新段首轮定格，整段不变）    │
│   ★ CACHE BREAKPOINT #1（落在 system 末尾打 ephemeral，一并锁定 tools[]）│
├─────────────────────────────────────────────────────────────────────────┤
│ [Segment 2 · Append-Only History] —— 映射为 messages[]，严禁回改历史消息 │
│   · 仅按当前 session_id 完整回放本段真实对话（正文 + express + 工具结果）│
│   ★ CACHE BREAKPOINT #2（动态落在「倒数第 1 条已落盘 assistant 消息」末尾）│
├─────────────────────────────────────────────────────────────────────────┤
│ [Segment 3 · Dynamic Tail] —— 每轮注入当前最新 user 消息，严禁进 system   │
│   · 用户原始输入正文（置顶！纯自然原话，不包任何人工 tag）               │
│   · 贴纸 / 图片多模态附件块                                             │
│   · <runtime_context>（置底！单轮多步循环内仅首发携带，工具结果不重复塞）   │
│       ├─ <runtime> 当前模糊时段、星期、作息状态、门状态、未读纸条数       │
│       ├─ <user_status> 用户手动心绪短句与勿扰标记（Ring 1.5，若有）       │
│       ├─ <mood> MoodProvider 定性摘要（若有）                           │
│       ├─ <stickers> 可用贴纸清单（id + 简短语义，供 express.stickerId） │
│       ├─ <events_notice> 待告知系统事实（拆封抽屉、分享已拆阅、可选评测态）│
│       ├─ <door_notes> 未读门缝纸条正文（id > door_notes_read，带模糊时间）│
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
4. **`<door_notes>` 注入载体与 `door_notes_read` 推进时机**：
   - 当存在 `events.kind = 'door_note' AND id > task_cursors['door_notes_read']` 的未读纸条时，在 `<runtime notes="N" />` 报数量的同时，于 `<door_notes>` 块中按时间顺序注入未读纸条正文与 `vagueWhen` 模糊时间（格式如 `- [昨天 · 门缝纸条] <正文>`）；
   - **`door_notes_read` 仅由具备对外表达与 `door` 权限的交互/唤醒轮（`chat` / `wake` / 未来 mind 唤醒）推进**：只要该轮正常完成（**包括 `wake` 亲眼看过纸条后自主决定不回并输出 `[SILENT]`**），即推进至已注入的最大纸条 `event.id`（仅模型报错/超时未完成时不推进，避免同一张已看过却不想回的纸条在下次唤醒反复弹出）；静默整理轮（`daily_wrapup` / `bedtime`）可照常读取 `door_note` 记记忆，但**不推进 `door_notes_read`**，确保Psyber下次醒来时仍能看到门口纸条并自主决定是否回应或开门。
5. **`<prefix_delta>` 会话内持续有效**：
   - 若盘中Psyber通过 `edit` 修改了 `self.md`、`user.md` 或 `shelf/`，Segment 1 快照保持冻结不改（保护 Breakpoint #1），同时将该文件最新增量记入当前会话状态，在**本会话剩余每一轮**的 `<prefix_delta>` 中持续注入，直至下次会话换段重新生成 Static Prefix 时清空，防止隔轮“忘掉刚改过的自述或规矩”。

### 2.3 Extended Thinking 思考流在单轮多步与跨轮沉淀的处理

针对带显式思考流的模型（如 Claude Extended Thinking、DeepSeek R1）：

1. **单轮多步工具循环内（Turn-Internal）：完整回传延续思路**：
   - 当模型在工具调用前输出了 `thinking` 内容时，引擎在收到工具结果继续调用下一步模型时，**必须将前一步 assistant 消息里的 `thinking` 块原样保留并带上签名（signature）发回厂商**；
   - 这是保证模型推理逻辑不中断的刚需，也是 Anthropic 协议对带工具思考调用的硬性合规要求（缺失会导致 400 校验报错）。
2. **跨轮持久化与历史回放（Cross-Turn）：剥除思考，按需摘要历史附件，记录用量**：
   - 单轮生成完毕后，思考全量文本落盘至 `psyber.sqlite` 的 **`events.thinking` 独立列**（与 `MEMORY.md` §7 一致），供客户端展示折叠思考卡；当轮的 `express` 记录、可回放的 `tool_calls` / `tool_results` 以及真实消耗统计 `usage`（`{ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimatedCostUsd }`）完整落盘至 `events.metadata` JSON；
   - **附件摘要防 Token 爆炸（Ring 1.5）**：若配置了 `slots.digest`，带有图片或短视频抽帧的用户消息仅在**当轮**向主模型发送多模态原件；本轮结束后异步调用 `slots.digest` 生成简洁客观文字描述并回填至该用户事件的 `metadata.attachmentDigest`。在后续跨轮拼装 Segment 2（`Append-Only History`）时，优先用该文字摘要替代原始二进制图片块（未配置 `slots.digest` 或摘要尚未就绪则保留原件）；
   - 当开启下一轮对话（或服务重启后重建会话）拼装 Segment 2（`Append-Only History`）时，**必须将历史轮次中的 `thinking` 块剥除**，仅回放最终回复正文、`express` 具身记录与工具调用/结果；
   - 彻底防止历史长程对话被数万 Token 的陈旧思考与重复历史大图污染，大幅节约输入计费并稳固历史缓存。

### 2.4 Prompt Cache 稳态原则（已移除 4 分钟保活探测与 25 分钟温热换段）

> **精简决策（2026-11-20）**：厂商 Prompt Cache TTL 与计费策略随时演进，不再将业务逻辑绑死在 5 分钟 TTL 上。**已移除 4 分钟 1-token 保活探测与 `>40k & 25min` 温热换段规则**；仅通过 Segment 1 固定不变 + Segment 2 只追加的天然结构自然吃满缓存。

### 2.5 拒绝旁观者摘要：同步收尾换段（Rollover）与自传连续性 `<continuity>`

彻底摒弃用第三人称小模型写损耗性“上下文摘要”的陋习。在 Psyber 中，**记忆只能由Psyber 本人以第一人称产生**；且宁可短暂等待旧段收尾写完记忆，也绝不抢着让 AI 用缺失上下文的“失忆新段”回复用户。

1. **换段（Rollover · 换新 `session_id`）触发条件**：
   - **① 上下文阈值 / 溢出换段**：本轮实际生效模型的累计 Token 超过 `min(模型窗口 * 75%, contextLimits.chat)`（独处轮取 `contextLimits.solo`），或触发 `CONTEXT_OVERFLOW` 时；
   - **② 每日睡前整理后换段**：进入作息睡眠窗完成 `bedtime` 整理（或因夜间关机错过 `bedtime` 而在次日补整理完成）后，只要库中**没有晚于本次 `bedtime` 已消化游标的新对话**，即自动切入 `fresh: true` 的新 `session_id`（无论服务是否重启过；若用户已在补整理期间提前开口聊起新话题，则不中途打断）；**若尚未完成 `bedtime` 整理，绝不因单纯跨日闲置截断未整理的原始对话**；
   - **③ 用户手动「存记忆换段」（Ring 1.5）**：用户通过 `POST /api/v1/chat/wrap-up` 主动收尾当前段落时，同样先同步整理完当前段落再切新段。
   - *状态卡不走换段等待*：对方亲口说的恢复或变更，Psyber在对话当轮即顺手更新状态卡。
2. **先同步收尾整理、再切新段（保证连续性且单向锁零死锁）**：
   - 触发换段（阈值 / 溢出 / 手动）时，Direct Engine 先广播 SSE `turn.rollover { phase: "wrapping", reason }`（客户端展示「正在收拢这段记忆…」），在 `turnMutex` 内同步执行 `daily_wrapup`（循环排空至换段截止序号 `cutoffSeq`，避免提前吃掉排队中的下一条用户消息）并 `git commit`；
   - **整理成功后**才切入新 `session_id`，持久化 `active_session` 状态（`{ sessionId, fresh: true, carryOverUntilSeq, continuity: null }`，存入 `task_cursors['active_session']`），清空静态前缀缓存、工具会话白名单（`scope: "session"`）与用量水位，并广播 `turn.rollover { phase: "done", oldSessionId, newSessionId, contextUsage }`；
   - **整理失败兜底**：75% 换段或手动换段若整理失败/超时，**保留原 `session_id` 不硬切**并广播 `turn.rollover { phase: "error" }`；`CONTEXT_OVERFLOW` 时若整理成功且当前段有历史，则立刻在新段自动重试本轮一次，仅当新空段本身仍超限或整理失败时推 `turn.error { code: "CONTEXT_OVERFLOW" }`；
   - **单向锁防死锁**：主对话换段严格按 `turnMutex -> tidyMutex` 顺序加锁；后台 `bedtime` 完成回调 `onBedtimeCompleted` **必须在释放 `tidyMutex` 之后**触发，从结构上杜绝循环等待；
   - **排队新消息不拒收、不串段**：收尾期间用户仍可正常 `POST /api/v1/chat/messages`（`202`），落盘后的排队消息在轮到执行时若检测到已切新段，自动重绑至新 `session_id`，绝不落进旧段过渡原话导致双发。
3. **新会话 `<continuity>` 连续性块（冻结在 Static Prefix 末尾）**：
   - 新段 `fresh === true` 期间只记录 `carryOverUntilSeq`；等到**新会话第一轮真正开口时**才惰性组装 `<continuity>` 并落盘定格至 `active_session.continuity`（同时置 `fresh = false`），后续同段与短停重启字节级复用，既吃满 Cache Breakpoint #1，又绝不在 `messages[0]` 伪造 `assistant` 消息破坏模型角色交替。
   - `<continuity>` 参照 Psyche 分层结构按预算从新到旧保底拼装（越远越粗，层层不重叠）：
     - **不重叠自传梗概金字塔（预算 `≤ 16000` 字；单条读时防跑偏上限：天 `400` / 周 `650` / 月 `1000` / 年 `1200` 字）**：优先保最近 **7 天**（`gist/days/`），再补早于最旧那天的最近 **4 周**（`gist/weeks/`），再补早于最旧那周的最近 **12 月**（`gist/months/`）与跨年（`gist/years/`）；
     - **【最近的经历】（预算 `≤ 1800` 字）**：仅收录**晚于最后一条日梗概日期（`day > lastGistDay`）**的活跃 `daily/` **卡片正文**（用于填平白天盘中换段时尚未写今日日梗概的空白；睡前换段后自动为空；**旧天 `daily/` 与 `activities/` 全部交给双轨召回按需检索，不占开局预算**）；
     - **【上一段末尾的原话】（预算 `≤ 2000` 字）**：按 `seq <= carryOverUntilSeq` 从旧段末尾向前按字符预算截取真实对话，按模糊时间分组，仅用于无缝接住刚说完的话头与语气。

---

## 3. 主对话 vs 静默整理轮并发锁与 Git 提交隔离

为防止「用户正聊着天 + 后台整理轮正在写卡/复核/回滚」造成磁盘竞争或 Git 误提交，服务端实现两级极简锁：

### 3.1 锁模型

| 锁名称 | 作用域 | 行为规程 |
| :--- | :--- | :--- |
| **`ChatTurnLock`** | 单 Psyber 主对话（`chat` / `wake`） | 串行执行主对话轮；若上一轮仍在流式生成，新消息入待处理队列（或由用户显式 `abort` 中止旧轮）。 |
| **`MemoryWriteMutex`** | `memory/` 磁盘写操作 | 保护 `write` / `edit` / 整理轮提交与回滚。`read` / `glob` / `grep` **不加写锁**（纯只读无阻塞）。 |

### 3.2 整理轮极简原子协议（Ring 1 单轮写作 + Git 留痕；C2.7 复核延后至 Ring 1.5）

静默整理轮按单队列串行消费 `events`（单批上限 `TASK_BUDGET = 10_000` 字，每批独立提交推进游标）：

1. **材料装载（无锁）**：顶部注入 `<tidy_context>`（含目标日期 `YYYY-MM-DD`、中文星期、ISO 周号 `YYYY-Www` 及 `bedtime` 对应的 `gist/days/YYYY-MM.md` / 周日 `gist/weeks/YYYY.md` 目标路径与节标题）；读取游标后 `status IN ('active', 'retracted')` 对话并附本地时间戳 `[YYYY-MM-DD HH:mm]` 与图片附件提示（`daily_wrapup` 与 `bedtime` 复用单游标推进；`bedtime` 额外注入当日已写/改卡片摘要与简短正文、现行 `gist/days/YYYY-MM.md` 片段与 `shelf/` 现行摘要）、`activities/REGISTRY.yaml`、`entities/REGISTRY.yaml` 与当前未关闭 `daily/` `state` 卡清单。
2. **获取 `MemoryWriteMutex` 并开启 `MemoryTx`**：仅记录 `memory/` 下触碰路径（`touchedMemoryPaths`）及其写前字节备份；主对话只读（`read`/`glob`/`grep`）无锁放行。
3. **Psyber单轮写作**：加载 `<self>` + `<user>` + `prompts/tidy.md`（v7），由 `chat`（或配置的 `memory_task`）调用原生 5 工具完成写卡与状态更新，末尾解析可选 `{"summary": "..."}`（缺失或微瑕降级由触碰文件名兜底，绝不回滚）。
4. **精准提交与游标推进**：
   - 若写作轮因模型报错/超时失败 → 按内存备份恢复 `touchedMemoryPaths` 并刷新索引，**不推进游标**，待下次重试；
   - 正常完成且 `touchedMemoryPaths` 非空 → 仅执行 `git add -- <...touchedMemoryPaths>` 与 `git commit -m "memory(<task>): <summary>"`，随后在同一 SQLite 事务更新 `task_cursors`、刷新增量索引并释放锁。

> **Ring 1.5 可选扩展（C2.7 独立复核）**：真机运行积累真实对话后，若 Git diff 抽检显示单轮幻觉率确实需要治理，再启用 `prompts/review.md` / `revision.md` 作为**非阻塞辅助检查**——复核失败或格式异常仅打告警日志，**绝不回滚已写好的合法卡片**。

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
  description: "局部精确替换 memory/ 中的笔记片段（补丁外内容严格不变）",
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
  description: "列举 memory/ 目录下的文件路径清单",
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
  description: "在 memory/ 中按字面或正则全文检索线索",
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
  description: "精读某篇记忆卡片正文（会自动增加该卡片的精读巩固计数）",
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
- **Ring 1 / Ring 2 分期边界**：工具 Schema 始终冻结全部 5 态以保护 Static Prefix Cache；在 **Ring 1** 阶段，`guard` 层暂拒 `cooling_off` 与 `departed`（返回明确可读提示：`当前版本尚未开启冷静期与离开流程，如需独处请先将门设为 closed`），待 **Ring 2** 启用下列完整冷静期时间锁与告别流程；
- **`cooling_off`**（Ring 2）：AI 主动进入正式冷静期，系统记录 `coolingOffStartedAt = Clock.now()`；
- **`departed` 强校验**：只有当 `door_state === "cooling_off"` 且 `24h ≤ Clock.now() - coolingOffStartedAt < 72h` 时才允许放行；
- **冷静期窗口过期作废（尊重关门主权）**：若 `Clock.now() - coolingOffStartedAt ≥ 72h` 仍未执行 `departed`，冷静期的离开资格自动作废并清空 `coolingOffStartedAt`，**门状态退回 `closed`（绝不替Psyber强行改为 `open`）**；之后若仍想离开须重新进入冷静期，若想恢复交流由Psyber自行切换回 `open` 或 `quiet`；
- **拦截报错**：若未满 24 小时，Guard 拦截并向模型返回错误：`尚未度过正式冷静期（剩余 X 小时），不可草率进入告别程序。请先冷静独处。`；若冷静期离开窗口已过期作废，返回：`上次冷静期的离开窗口已过期，门已退回 closed。若仍决定离开，请重新进入冷静期；若想恢复交流，可自行将门改为 open 或 quiet。`

### 4.3 `guarded` 与 `confirm` 审批状态机（Ring 1 仅落 `auto`/`guarded`；`confirm` 挂起审批于 Ring 2 启用）

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

> **落点**：全部 Prompt 原文与编写规范已统一收敛至根目录 [`prompts/`](../../prompts/)（代码直接通过 `readPrompt()` 读时现读，不缓存），本节不再贴全文，只保留加载位置、版本指针与模式触发协议。改提示词先改 `prompts/`，再同步本节版本号。
> **编写铁律**：Psyber视角 Prompt 全部使用通用中文第一人称，严禁写死任何特定名字、性别、职业或私人关系预设（所有个人身份均从 `memory/{self,user}.md` 自然读取）；仅只读复核角色（`review.md`）与各文件末尾的 JSON 接口格式约束采用技术说明/第二人称（见 `prompts/README.md` §6）。

| 文件 | 版本 | 内容 | 载入位置 |
| :--- | :--- | :--- | :--- |
| `prompts/main.md` | v7 | 主对话 Static System Prompt | Static Prefix 第二项（紧随置顶 `<self>` 之后） |
| `prompts/tidy.md` | v7 | 静默整理轮（含目录分工、路径/Frontmatter 规范与 3 类任务块） | memory_task 写作轮（紧随 `<self>`/`<user>` 之后） |
| `prompts/review.md` | v3 | C2.7 写后独立复核轮（Ring 1.5 可选非阻塞） | memory_task 复核轮（无历史只读，Ring 1 不调用） |
| `prompts/revision.md` | v3 | C2.7 Psyber 复核修订轮（Ring 1.5 可选） | memory_task 修订轮（延续写作轮会话，Ring 1 不调用） |
| `prompts/genesis.md` | v5 | 创世中性开局 | Dynamic Tail（`self.md` `name` 为空时拼入） |
| `prompts/wake.md` | v3 | 主动唤醒（含 `[SILENT]` 沉默协议） | Dynamic Tail（`wake` 模式拼入） |
| `prompts/recall-gate.md` | v3 | 召回门控、精排与 1 跳双链早停指令（含双边判据） | `decision` 分类器槽位（不进入 Psyber 主对话上下文） |

### 5.1 条件模式触发与退出协议

- **创世模式（`genesis.md`）退出判定**：由 `memory_template/self.md` 初始化生成的 `self.md` 头部带有极薄 YAML Frontmatter `name: ""` 与 `pronoun: ""`（不再设 `named` 布尔开关；`user.md` 头部带有 `name: ""` 与 `pronoun: ""`）。判定是否定名以 `self.md` 的 `name` 为唯一真相：只要 `self.md` 存在且显式包含 `name: ""` 空字段（或文件尚不存在），即处于未定名状态，引擎每轮在 Dynamic Tail 拼入 `prompts/genesis.md`；当 Psyber 在互动中定名并用 `edit` 将 `self.md` 的 `name` 填为非空名字（或用户在 `POST /api/v1/genesis` 直接填好初始名字由后端写入 `name`）后，自动退出创世模式（若为无 `name` 键的旧版历史 `self.md` 且无旧版 `named: false`，兼容视为已定名并按正文回退解析名字）。`self.md` 中的 `pronoun` 初始化为空，**不在创世页预设**，留待 Psyber 在后续相处中自主决定或自然留空；服务端从 `self.md` / `user.md` frontmatter 解析 `residentName`、`residentPronoun`、`userName`、`userPronoun` 供运行期称谓、通知标题与客户端展示填充（未定名时客户端界面统一兜底显示 `Psyber`）。
- **主动唤醒沉默协议（`wake.md` → `[SILENT]`）**：`wake` 模式下若Psyber决定此刻不开口，仅输出 `[SILENT]`。引擎在流式阶段做前缀缓冲：**在前 16 字符确认非 `[SILENT]`（或产生 `express` 等实质工具调用）之前，暂缓广播 SSE `turn.start` 与 `turn.thinking`**，避免客户端先画出“正在思考/输入”再突然悬空消失；确认开口后再补推 `turn.start`、已缓冲的思考/正文增量；一旦最终正文经 `trim()` 等于 `[SILENT]`（或为空且未产生贴纸等实质表达），**静默中止推送**——不落盘对外聊天消息、不推任何 SSE 事件、不触发 `NotificationProvider("wake")`，仅写入内部调试日志（若本轮注入了 `<door_notes>`，按 §2.2 仍推进 `door_notes_read`）。

脊柱已并入 `prompts/main.md` 的【脊柱底线与相处准绳】，不单独成节（2026-11-19 定）；四类底线（安全/道德/认同/人格）与三句底线（对错先于讨好 / 冲突不逃避到底 / 情绪不进决策但事后告知）见 `prompts/README.md`。
