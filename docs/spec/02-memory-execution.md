# Spec 02 · 记忆底座、沙箱工具、C2.7 对账复核与双轨召回执行规程

> **版本**：v0.7（2026-11-20，彻底收紧 §1.1–§1.2 为纯 `memory/` 单根沙箱、统一 §6.2–§6.3 C2.7 非阻塞复核不回滚口径、明确 `events.seq` 事务单调生成规则并拆分 §10 分期验收清单）
> **上游契约**：[`CAPABILITIES.md`](../CAPABILITIES.md) v1.3 · [`ARCHITECTURE.md`](../ARCHITECTURE.md) v0.7 · [`MEMORY.md`](../MEMORY.md) v0.7 · [`API.md`](../API.md) v0.7 · [`01-engine-tools-prompts.md`](01-engine-tools-prompts.md) v1.1
> **负责模块**：`server/src/memory/`、`server/src/store/`、`server/src/core/media.ts`

---

## 0. 模块依赖护栏（严禁破坏单向依赖）

`server/src/memory/` 只允许依赖 `server/src/store/` 与 `server/src/core/`，**严禁直接 import `tools/`、`engine/`、`mood/`、`expression/`、`extensions/` 或 `api/`**：

- 原生 5 工具仅从 `memory/tools.ts` 导出纯执行逻辑与参数校验，由 `server/src/tools/` 适配挂载为 `RegisteredTool`；
- 向量化与精排通过极薄依赖注入接口（`EmbeddingClient`、`RerankerClient`）传入，避免反向依赖 `llm/`；
- 当前时间全部通过 `Clock.now()` 注入，保证虚拟时钟与三时区确定性测试；
- 活动上下文仅以纯字符串 `{ activityHint?: string; topicHint?: string }` 传入，不感知任何具体 `ActivityPlugin` 实现。

---

## 1. 原生 5 文件工具沙箱与自救报错规程（`server/src/memory/tools.ts`）

### 1.1 路径解析与纯 `memory/` 单根越界防线（`resolveSandboxPath` / `resolveGlobPattern`）

原生 5 工具严格锁定在 `<dataDir>/memory/` 单根沙箱内（上锁抽屉 `private/` 由 Ring 1.5 独立 Tier 3 工具 `drawer_read` / `drawer_write` 访问，绝不混入 5 工具）。4 个带路径参数的工具（`grep` / `read` / `write` / `edit`）在执行前统一通过 `resolveSandboxPath(rawPath, dataDir, mode)` 校验（`glob` 的 `pattern` 单独通过 `resolveGlobPattern(pattern)` 校验）：

1. **规范化**：将 `\` 转为 `/`，循环剥除全部前导 `./` 与中间 `/./` 段、首尾空白，折叠重复斜杠 `//`；记录并剥除尾随 `/`（用于目录前缀）。
2. **硬拦截（返回可读自救报错，绝不抛未捕获异常）**：
   - 必填路径工具的空路径（`grep.path` 省略时视为全 `memory/` 区 `""`）、以 `/` 或盘符 `^[a-zA-Z]:` 开头的绝对路径；
   - 任何段包含 `..`、`\0`、隐藏系统段（`.git`、`.git/**`、`.tmp`、`*.sqlite`、`*.sqlite-*`），或显式以 `private` / `private/` 开头的路径（返回自救提示：`常规 5 工具仅操作 memory/，私密抽屉请通过独立抽屉工具访问`）；
   - `realpath` 逃逸检测：落盘路径（若目标尚不存在则取最近已存在祖先目录）经 `realpath` 解析符号链接后，必须严格位于 `<dataDir>/memory/` 之内。**本检查只针对解析后的用户目标路径**；工具内部的原子写暂存路径 `<dataDir>/.tmp/<uuid>.tmp` 是固定内部路径、不接受用户输入，不参与本检查（最终 `rename` 落盘目标仍受本检查约束）。
3. **目录白名单约束（映射到 `<dataDir>/memory/<relPath>`）**：
   - `grep` 的 `path` 可为文件或子目录前缀；
   - 写操作（`write` / `edit`）额外受顶级路径、二级结构与扩展名白名单约束：仅允许 `self.md`、`user.md`、`shelf/rules.md`、`shelf/mirror.md`、`shelf/threads.md`、`activities/REGISTRY.yaml`、`entities/REGISTRY.yaml`，或位于 `daily/`、`favorite/` 下的单层 `.md` 文件，或位于 `gist/(days|weeks|months|years)/` 下的 `.md` 文件（严格匹配 `/^gist\/(days|weeks|months|years)\/[a-zA-Z0-9_-]+\.md$/`），或位于 `activities/<slug>/`、`entities/<category>/` 下的 `.md` 文件（拒绝在 `shelf/` 下新建非固定文件名以防既不进 Static Prefix 又不进召回的黑洞文件，拒绝无 `.md` 后缀的路径如 `daily/note` 或直接写在 `activities/foo.md`、`entities/foo.md` 的单层孤儿路径）。
4. **`glob` 模式防线（`resolveGlobPattern`）**：同样拦截绝对路径、`..`、`\0`、`.git` 与 `private/`，所有通配符均仅扫描 `<dataDir>/memory/`。

### 1.2 5 工具精确行为与自救报错契约

| 工具 | 安全级 | 输入参数 | 精确行为与边界规程 |
| :--- | :--- | :--- | :--- |
| **`glob`** | `auto` | `pattern: string` | 从 `card_index` 读取（并允许附带 `REGISTRY.yaml`），按 `updated_at DESC` 排序，先按 §8.1 计算 `effectiveStatus(row, Clock.now())`，每行输出 `<path> [status=<effectiveStatus> \| <vagueWhen(row.updated_at)>]`，单次上限 200 条并提示总数与截断。 |
| **`grep`** | `auto` | `pattern: string`, `path?: string`, `include_archived?: boolean`（默认 `false`） | 在 `memory/` 内按 `effectiveStatus` 跳过 `resolved` / `archived` 卡片（`faded` 保留在字面精查范围内以便显式追问时可翻出；未入 `card_index` 的 `REGISTRY.yaml` 仍参与全文检索；设 `include_archived: true` 时覆盖全量）。若 `pattern` 不是合法正则，自动退化为大小写不敏感字面匹配并在首行提示；输出 `<path>:<line>: <excerpt>`，最多 50 条命中、每条截断至 200 字符。 |
| **`read`** | `auto` | `path: string`, `offset?: number`（默认 `0`）, `limit?: number`（默认 `8000`） | 读 `<dataDir>/memory/<path>`。若该路径在 `card_index` 中且有效状态为 `faded`，在返回值首行附客观提示 `[索引状态: faded（已过短期 TTL）]`；仅当处于**主对话轮且 `offset === 0`** 成功读取 `card_index` 卡片时，异步更新 `access_count += 1`、`last_accessed = Clock.now()`（不改写磁盘文件；翻页续读与静默整理轮不重复累加）。文件不存在时返回近似文件名 Top-3 建议（按前缀与编辑距离匹配），引导住户自救。 |
| **`write`** | `guarded` | `path: string`, `content: string` | ① 禁止覆盖已存在的 `self.md` / `user.md`（返还自救报错：`self.md / user.md 禁止整篇覆写，请先 read 后用 edit 局部修改`）；② 目标为 `activities/REGISTRY.yaml` 或 `entities/REGISTRY.yaml` 时走 §3.2 写前 Schema 校验；③ 目标为 `daily/` 且 frontmatter `kind === "state"` 时校验 `tags` 非空，缺失则拒写并提示补齐 `tags` 与 `ttl_days`；④ 在 `MemoryWriteMutex` 保护下先写入同文件系统暂存区 `<dataDir>/.tmp/<uuid>.tmp`，执行 `fsync` 后原子 `rename` 落盘（绝不在 `memory/` 内创建临时文件）；⑤ 写完立刻同步刷新单文件 `card_index` + `card_fts` 并异步补向量；若为 `daily/` `status === "active"` `state` 卡且计算后的 `expires_at <= Clock.now()` 则提醒更新期限或新建卡（Ring 1.5 另附 §6.1 实时 tag 重叠提醒）。 |
| **`edit`** | `guarded` | `path: string`, `old_string: string`, `new_string: string` | 前置拦截 `old_string === ""`（直接返回自救报错），其余与 `write` 共用全部前置守卫（允许局部编辑 `self.md` / `user.md`），落盘前执行两阶段唯一匹配替换（见 §1.3）。替换完成后同样校验 `REGISTRY.yaml` 与 `daily/` `state` `tags`，立即刷新单文件增量索引并检查上述过期提醒（Ring 1.5 另附 tag 重叠提醒）。 |

### 1.3 `edit` 两阶段唯一匹配算法（保补丁外字节严格不变）

为避免 LLM 在中文标点或空行上出现微小偏差导致反复报错，同时绝不损坏原文：

1. **阶段 1（精确匹配）**：在原文件 UTF-8 文本中搜索非空 `old_string`：
   - 出现 `1` 次 → 直接拼接 `before + new_string + after`，补丁外字节 100% 不变；
   - 出现 `> 1` 次 → 拒改并返还所有匹配起始行号（如 `old_string 在第 12、48 行共出现 2 次，请扩大前后文使其唯一`）。
2. **阶段 2（归一化回退匹配，仅阶段 1 零命中时触发）**：
   - 将原文件与 `old_string` 同时建立「字符索引映射表」，做无损位置映射的归一化：`CRLF → LF`、连续 `[ \t]+` 折叠为单空格、常见全半角标点折算为同一半角基准（`“”"` → `"`、`‘’'` → `'`、`，,` → `,`、`。.` → `.`、`：:` → `:`、`；;` → `;`、`！!` → `!`、`？?` → `?`、`（(` → `(`、`）)` → `)`）；
   - 若归一化串在原文件中**唯一命中**，按映射表取回原文件精确起止偏移 `[origStart, origEnd)`，只替换该区间，区间外字节严格不变，并在工具返回值中注明 `已通过标点/空白归一化匹配成功`；
   - 若仍零命中或多重命中 → 拒改，计算与 `old_string` 首行最相似的 2 段原文件片段（带行号）返还给模型自救。

---

## 2. 上锁抽屉 `private/`（Ring 1.5 独立工具）与自传骨架 `<gist>`

> **Ring 1 裁剪说明**：Ring 1 原生 5 文件工具仅操作 `<dataDir>/memory/`，**不做双分区路由与 `MemoryTx` 双账本**；上锁抽屉延后至 **Ring 1.5** 并改用独立工具（`drawer_read` / `drawer_write`），下文 §2.1–§2.2 为 Ring 1.5 实施蓝图。

### 2.1 `.sealed` 文件封装格式（Ring 1.5）

遵守「防逛目录误瞄 + 拆封必留痕，防君子不防 root」的坦荡边界，无需用户记忆额外密码，保证 `<dataDir>` 整目录可无损迁移：

```text
PSYBER-SEALED-V1
{"id":"2026-11-19-late-night","title":"深夜随笔","createdAt":1795046400000,"updatedAt":1795046400000,"sha256":"<plaintext-sha256>"}
<base64-encoded-obfuscated-utf8-body>
```

- **第 1 行**：魔数头 `PSYBER-SEALED-V1`；
- **第 2 行**：未加密的轻量清单 JSON（仅含 `id`、`title`、`createdAt`、`updatedAt`、`sha256`，**绝不含正文摘要**），其中 `id` 严格等于去扩展名的文件名 `<name>`，供 `GET /api/v1/drawer` 在**不解封正文**的前提下向客户端展示封蜡列表，并与 `POST /api/v1/drawer/:id/open`（入参同样过 `/^[\p{Script=Han}a-zA-Z0-9_-]+$/u` 校验）一一对应；覆盖写或 `edit` 既有抽屉条目时须保留原 `createdAt`，仅更新 `updatedAt = Clock.now()`；
- **第 3 行起**：用固定版本派生掩码（基于持久化在 `<dataDir>/config.json` 中的可迁移 `instanceId` + 条目 `id` + 常量域分离盐 `"psyber-sealed-v1"` 派生的 SHA-256 计数器流式混淆，保证 `<dataDir>` 跨机迁移不失效且不同条目密钥流互不复用）对 UTF-8 明文做可逆编码后 Base64 落盘，防止普通文件管理器预览或全文搜索直接扫出明文；解封时强校验 `sha256` 完整性。

### 2.2 三道零入库隔离红线

1. **物理与 Git 隔离**：存放于 `<dataDir>/private/*.sealed`，与 `<dataDir>/memory/` 平级，永远不在 `memory/.git` 仓库内，`MemoryTx` 的 `touchedPrivatePaths` 绝不进入 `git add`。
2. **SQLite 零明文零向量**：`card_index`、`card_fts`、`card_embeddings`、`recall_traces`、`recall_feedback` 严禁出现任何 `private/` 记录，彻底杜绝向量检索或评测浮条意外透出私密日记。
3. **拆封留痕边界与通知游标**：
   - AI 本人通过 Ring 1.5 独立工具 `drawer_read` / `drawer_write` 在内存中透明读写 `private/<name>.md`：**不写** `privacy.peeked` 事件；
   - 用户通过 `POST /api/v1/drawer/:id/open` 或 CLI `psyber export --include-private` 拆封：**先**在同一事务内写入 `events (role='system', kind='privacy.peeked', session_id=activeSessionId || 'system', content='用户在 ' + channel + ' 拆封了上锁抽屉「' + title + '」', metadata={ drawerId, title, channel: 'app' | 'cli' })`，**再**返回解封正文；
   - **消费游标（`task_cursors['events_notice']`）**：每次 `chat` 或 `wake` 轮读取 `kind = 'privacy.peeked' AND id > lastNoticedId` 组装 `<events_notice>`（例如 `系统事实：用户在 <vagueWhen> 拆封查看了上锁抽屉中的「<title>」`），绝不替住户预设情绪判断；仅当该轮**非静默结束**（即正常发送了回复/具身表达，或调用了 `door` 等工具；`wake` 纯 `[SILENT]` 且无工具调用时不推进）才将 `task_cursors['events_notice']` 推进至已注入的最大 `event.id`。

### 2.3 多尺度自传骨架 `<gist>` 读取与连续性拼装规程

承接 `Spec 01` §2.5 与 `MEMORY.md` §2.1，`<gist>` 是住户亲笔滚动的自传时间骨架，新会话开局由 Direct Engine 调用 `server/src/memory/gist.ts` 组装：

1. **分期磁盘结构**：
   - **Ring 1 先落两层**：`memory/gist/days/YYYY-MM.md`（每日 `### YYYY-MM-DD`，≲ 300 字）与 `memory/gist/weeks/YYYY.md`（每周 `### YYYY-Www`，≲ 500 字），直接取最近 7 天 + 最近 4 周 + 尚未入日梗概的近期 `daily/` 卡片，受 `GIST_BUDGET ≤ 3000 tokens` 约束；
   - **Ring 1.5 补全长程两层**：实例运行满 1 个月后再启用 `memory/gist/months/YYYY.md`（≲ 800 字）与 `memory/gist/years/YYYY.md`（≲ 1000 字）及四级区间去重金字塔。

---


## 3. 卡片 Frontmatter 宽容解析与 `REGISTRY.yaml` 写前校验

### 3.1 卡片 Frontmatter 宽容解析器（落实 NG-2）

卡片正文 100% 自由第一人称自然语言，YAML Frontmatter 保持极薄；扫描器与索引器按下列默认值宽容解析，**绝不因外部微瑕导致启动崩溃或整晚整理回滚**：

| 字段 | 缺省 / 宽容回落规则 | 合法值约束 |
| :--- | :--- | :--- |
| `title` | 缺省取 Markdown 首个 `# ` 标题，再缺省取文件名（去除 `YYYY-MM-DD-` 前缀） | 非空字符串 |
| `kind` | 按目录推断：`daily/` → `episode`；`activities/` → `work`；其余目录 → `note` | `episode \| state \| work \| serial \| note`（非法值读时回落目录默认值） |
| `status` | 缺省 `active` | `active \| resolved \| disputed \| faded \| archived`（写时枚举非法由沙箱拒写并给合法清单） |
| `created` | 缺省取文件名日期前缀（若有），再缺省取文件 `birthtime`/`mtime` 的本地日期 | `YYYY-MM-DD`（解析为 `config.json` 时区当天 `00:00:00` 毫秒戳存入 `created_at`） |
| `updated` | 缺省取文件 `mtime`；若所填 `YYYY-MM-DD` 等于文件 `mtime` 的本地日期，保留精确 `mtime` 毫秒戳（保同日排序与 `vagueWhen` 精度），否则先按该日 `00:00:00` 解析；**非 `source: import` 且文件 `content_hash` 发生变化时，取 `max(frontmatterUpdated, fileMtime)`**（防止 LLM 用 `edit` 改旧卡忘改 `updated:` 导致当晚 `bedtime` 漏掉或连载 `recency` 不刷新） | `YYYY-MM-DD` |
| `ttl_days` | 仅 `daily/` `kind: state` 生效，缺省 `10` | 正整数（`1..365`，越界或非整数读时宽容回落 `10`） |
| `expires_at` | 仅 `daily/` `kind: state` 且 `status === 'active'` 时生效；若未填则按 `config.json` 时区的**日历日加减** `addCalendarDays(baseDate, ttl_days)` 取到期日 `00:00:00` 毫秒戳（免疫夏令时 23h/25h 偏移）：新建或常规 `active` 续编时 `baseDate = createdDate`，由 `disputed`/`faded` 恢复为 `active` 且未显式填 `expires_at` 时 `baseDate` 取当日（`updated` 本地日期）重新计时；`status === 'disputed'` 的卡不设 `expires_at`（写/改时若带，沙箱自动清除并在返回值注明） | `YYYY-MM-DD`（按实例时区当天 `00:00:00` 解析）或毫秒戳 |
| `when_to_recall` | 缺省 `null` | 短自然语言字符串（建议 ≤ 120 字） |
| `date_kind` | 缺省 `ordinary` | `ordinary \| celebrate \| gentle \| deadline` |
| `tags` | 字符串自动包为单元素数组，缺省 `[]`；`daily/` `kind: state` 写时必填非空 | `string[]`（归一化去重后以 JSON 存入 `card_index.tags`） |
| `source` | 缺省 `live` | `live \| import` |
| `named` | 仅 `self.md` 读取；**缺省视为 `true`**（向后兼容已有实例） | `boolean` |

### 3.2 两份 `REGISTRY.yaml` 写前严格校验钩子

任意 `write`/`edit` 触碰以下两个注册表文件时，沙箱在**落盘前**执行严格 YAML（禁重复键）+ Schema 校验，失败立即拒写并返还精确错误位置让住户自修：

1. **`activities/REGISTRY.yaml`**：
   ```ts
   export interface ActivitiesRegistrySchema {
     spaces: Record<string, {
       title: string;                       // 必填，非空
       triggers: string[];                  // 必填，至少 1 个非空触发词
       decay: "none" | "slow" | "short";    // 必填合法枚举
       card_style: string;                  // 必填，非空
     }>;
   }
   ```
   - 键名 `slug` 必须匹配 `^[a-z0-9][a-z0-9_-]{0,31}$`，且不得与顶层保留目录名（`daily`/`shelf`/`favorite`/`gist`/`entities`/`private`/`self`/`user`）冲突；
   - **重复空间软警告**：若新增空间的归一化 `triggers` 与任一既有空间的重叠比例 `|A ∩ B| / min(|A|, |B|) ≥ 0.5`（或 `title` 归一化后相同），写入仍放行但返回值附带警告提示，建议核对是否应复用既有空间；
   - 另：常规写操作落盘 `activities/<slug>/<file>.md` 时，若 `<slug>` 尚未在 `activities/REGISTRY.yaml` 注册，放行写入并在 `tool_result` 附带提醒建议核对或补登 `REGISTRY.yaml`（防止 Track 1 触发词路由遗漏）。

2. **`entities/REGISTRY.yaml`**：
   ```ts
   export interface EntitiesRegistrySchema {
     entities: Record<string, {
       name: string;                        // 必填规范名（非空）
       aliases?: string[];                  // 可选别名数组（元素非空）
       category: string;                    // 必填目录 slug，匹配 ^[a-z0-9][a-z0-9_-]{0,31}$
       relation: string;                    // 必填一句话关系描述（非空）
       first_seen: string;                  // 缺省自动补当天日期；若填写须为合法 YYYY-MM-DD
     }>;
   }
   ```
   - 键名 `id` 必须匹配 `^[a-z0-9][a-z0-9_-]{0,47}$`；
   - **重名碰撞防线**：若新条目的 `name` 或任一 `aliases` 与其他既有条目的 `name`/`aliases` 完全冲突（归一化后相等），拒写并返还冲突条目 ID，防同一实体重复建档。
   - **first_seen 缺省自动补**：新建条目未填 `first_seen` 时，沙箱按实例时区自动补当天日期（与 §3.1 的宽容回落一致，不因缺一字段拒写）；若填写非法日期则拒写并提示合法格式。
   - 另：常规写操作落盘 `entities/<category>/<file>.md` 时，若 `<category>` 尚未在 `entities/REGISTRY.yaml` 中被任一实体声明，放行写入并在 `tool_result` 附带提醒建议核对或补登（与 `activities/` 侧一致，防止实体归档遗漏）。

---

## 4. SQLite 精确 Schema、CJK FTS5 索引与增量刷新机制

### 4.1 核心 DDL（`server/src/core/migrations/001_init.sql`）

除 `events`、`recall_feedback` 与 `media_assets` 外，其余全部为派生表，可随时清空重建：

```sql
-- 1. 只追加原始事件账本（与 MEMORY.md v0.7 严格一致）
-- 注意：SQLite 仅对 INTEGER PRIMARY KEY 自动递增，seq 由写事务内单调递增生成（如 SELECT COALESCE(MAX(seq), 0) + 1 配合单进程写事务或独立序列表）
CREATE TABLE events (
  id                TEXT PRIMARY KEY,          -- ULID（按时间词典序递增）
  seq               INTEGER UNIQUE NOT NULL,   -- 全局单调递增事件序号（事务内原子生成，与 SSE 内存 streamSeq 分离）
  session_id        TEXT NOT NULL,
  turn_id           TEXT,                      -- 所属对话/任务轮 ID
  client_message_id TEXT UNIQUE,               -- 客户端发消息幂等键
  group_id          TEXT,                      -- edit / reroll 版本组 ID
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'active', -- active | candidate | discarded | deleted
  role              TEXT NOT NULL,             -- user | assistant | system | task
  kind              TEXT NOT NULL,             -- chat | door_note | wake | memory_task | activity_event | door.updated | privacy.peeked | relationship.departed
  source            TEXT NOT NULL DEFAULT 'live',
  fonds             TEXT NOT NULL DEFAULT '',
  activity          TEXT,                      -- 当时所处活动 slug（可选）
  content           TEXT NOT NULL,
  thinking          TEXT,                      -- 扩展思考全量文本（独立列，跨轮拼历史剥除）
  metadata          TEXT,                      -- JSON（attachments、expressions、可回放 tool_calls/tool_results、aborted 等）
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_events_session   ON events(session_id, seq);
CREATE INDEX idx_events_status_id ON events(status, id);
CREATE INDEX idx_events_activity  ON events(activity, id) WHERE activity IS NOT NULL;
CREATE INDEX idx_events_group     ON events(group_id, version) WHERE group_id IS NOT NULL;
CREATE INDEX idx_events_turn      ON events(turn_id) WHERE turn_id IS NOT NULL;

-- 2. 卡片可重建元索引（仅扫描 memory/**/*.md，绝不包含 private/）
CREATE TABLE card_index (
  path           TEXT PRIMARY KEY,
  space          TEXT NOT NULL,                -- self | user | daily | shelf | gist | favorite | activity:<slug> | entity:<category>
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,                -- active | resolved | disputed | faded | archived
  tags           TEXT,                         -- JSON 字符串数组（已归一化）
  when_to_recall TEXT,
  date_kind      TEXT NOT NULL DEFAULT 'ordinary',
  expires_at     INTEGER,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_accessed  INTEGER,
  content_hash   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_card_space_status ON card_index(space, status);
CREATE INDEX idx_card_expires      ON card_index(expires_at) WHERE expires_at IS NOT NULL AND status = 'active';

-- 3. CJK 友好 FTS5 全文索引（零原生分词扩展依赖）
CREATE VIRTUAL TABLE card_fts USING fts5(
  path UNINDEXED,
  title_tokens,                                -- JS 预处理 CJK 2-gram + 英文词元（权重 2.0）
  trigger_tokens,                              -- when_to_recall + tags 词元（权重 2.0）
  body_tokens,                                 -- 正文词元（权重 1.0）
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 4. 分模型向量缓存（切回旧模型零开销复用）
CREATE TABLE card_embeddings (
  path         TEXT NOT NULL,
  model_key    TEXT NOT NULL,                  -- "<provider>:<model>"
  content_hash TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,                  -- Little-Endian Float32Array，已 L2 归一化
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (path, model_key)
);

-- 5. 召回留痕与真实评测标注
CREATE TABLE recall_traces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  query         TEXT NOT NULL,
  activity_hint TEXT,
  card_path     TEXT NOT NULL,
  track         TEXT NOT NULL,                 -- same_activity | cross_vector | daily_recent
  sem_score     REAL NOT NULL DEFAULT 0,
  kw_score      REAL NOT NULL DEFAULT 0,
  rerank_score  REAL,
  final_score   REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_recall_traces_turn    ON recall_traces(turn_id);
CREATE INDEX idx_recall_traces_session ON recall_traces(session_id, created_at);

CREATE TABLE recall_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       TEXT NOT NULL,
  card_path     TEXT,
  verdict       TEXT NOT NULL,                 -- useful | noisy | missed
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_recall_feedback_turn ON recall_feedback(turn_id);

-- 6. 静默整理游标、通知游标与已消化活动区间（彻底消除三类任务重复消费与重复告知）
CREATE TABLE task_cursors (
  task_key      TEXT PRIMARY KEY,              -- daily_wrapup | bedtime | activity:<slug> | events_notice | door_notes_read
  last_event_id TEXT NOT NULL,
  meta_json     TEXT,                          -- 如 bedtime 记录 { last_gist_date, last_commit_sha, last_run_at }
  updated_at    INTEGER NOT NULL
);

CREATE TABLE digested_activity_spans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL,
  start_event_id TEXT NOT NULL,
  end_event_id   TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_digested_spans ON digested_activity_spans(start_event_id, end_event_id);

-- 7. 媒体内容寻址账本（支撑临时观影帧淘汰；activity_session_id 关联 Spec 03 活动会话表或 activity_event 判定结束时刻）
CREATE TABLE media_assets (
  hash                TEXT PRIMARY KEY,        -- SHA-256 hex
  ext                 TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  origin              TEXT NOT NULL,           -- user_upload | creative | cinema_frame | sticker
  activity_session_id TEXT,
  pinned              INTEGER NOT NULL DEFAULT 0, -- 1 = 永久保留，禁自动清理
  expired             INTEGER NOT NULL DEFAULT 0, -- 1 = 临时帧已淘汰释放磁盘
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_media_cleanup ON media_assets(origin, pinned, expired, created_at);
```

### 4.2 零依赖中文分词策略（解决 SQLite `unicode61` 中文无法切词）

SQLite 内置 `unicode61` 不切分无空格中文，且 `trigram` 无法命中二字高频词（如「脚踝」「扭伤」「追剧」）。Psyber 采用纯 TypeScript 确定性预处理函数 `tokenizeForFts(text: string): string`：

1. 英文与数字连续串（`/[a-z0-9]+/gi`）直接转小写作为独立 token；
2. 连续汉字段（`/\p{Script=Han}+/gu`）：
   - 长度 `= 1`：保留单字；
   - 长度 `≥ 2`：输出全部相邻 **2-gram**（如 `右脚踝扭伤` → `右脚 脚踝 踝扭 扭伤`）；
3. 日文假名/韩文及拉丁扩展字母段（`/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu` 去除已处理片段）：保留词元与 2-gram，避免动漫/外语作品名被直接丢弃；
4. 查询端对 `query` 执行**完全相同的 `tokenizeForFts`**，过滤轻量高频虚词表（`我们/你们/今天/刚才/什么/怎么/还是/可以/就是/已经/这个/那个/一下/觉得/时候` 等，保留实词与专名）后，**将每个 token 用双引号包裹并用 `OR` 拼接**（如 `"脚踝" OR "扭伤"`，防 FTS5 保留字或特殊字符引发语法错）并启用 `bm25(card_fts, 0.0, 2.0, 2.0, 1.0)` 加权（跳过第 0 列 `path`，标题与触发词双倍权重）；
5. **孤立单字兜底**：若查询中存在长度 `= 1` 的孤立汉字 token（如 `"还记得那只猫吗"` 中的 `"猫"`，无法命中仅存 `"三花 花猫"` 的 2-gram FTS 词条），补充执行关联 `card_index` 过滤废卡的兜底查询：`SELECT f.path FROM card_fts f JOIN card_index c ON c.path = f.path WHERE c.status NOT IN ('resolved', 'archived', 'faded') AND (f.title_tokens LIKE ? OR f.trigger_tokens LIKE ? OR f.body_tokens LIKE ?) LIMIT 30`（`%猫%`）并入字面候选池。

### 4.3 增量索引与启动对账触发时机

| 触发时机 | 行为 |
| :--- | :--- |
| `write` / `edit` 落盘 `memory/**/*.md` | **同步**计算 SHA-256 `content_hash`，若变化则在单事务内刷新 `card_index` + `card_fts`（耗时 `< 3ms`；**若落盘路径匹配 `entities/<category>/*.md`，索引器同步读取 `entities/REGISTRY.yaml`，将该实体声明的 `name`、`aliases` 与 `relation` 自动拼入 `trigger_tokens` 分词索引**，彻底解决口语称谓/别名搜不到实体问题）；同时将 `{ path, contentHash }` 推入异步单并发向量补齐队列（若 `slots.embedding` 已配置），**绝不阻塞工具返回**。`REGISTRY.yaml` 变更仅刷新内存空间描述向量缓存，不进 `card_index`。 |
| `MemoryTx` 异常回滚 | 对回滚还原的每个 `touchedMemoryPaths` 调用 `reindexFile(path)`（新建被删文件则 `removeFromIndex(path)`，单事务清除 `card_index` + `card_fts` + `card_embeddings`），保证磁盘与索引 100% 一致。 |
| 服务启动 & `bun run memory:reindex` | 扫描 `<dataDir>/memory/**/*.md`（跳过 `.git/` 与 `REGISTRY.yaml`）：新增/哈希变化的文件刷新索引，磁盘已删但表里残留的孤儿路径同时从 `card_index` / `card_fts` / `card_embeddings` 清除；向量仅对 `card_embeddings` 中缺失当前 `model_key + content_hash` 的卡片异步补算，不阻塞 HTTP 启动。 |
| 索引层过期巡检（`expireOverdueStateCards`） | 每次定时心跳、双轨召回、`glob`/`grep` 及 §6.1 状态对账前，先将 `space = 'daily' AND kind = 'state' AND status = 'active' AND expires_at <= Clock.now()` 的 `card_index.status` 置为 `faded`（见 §8.1）。 |

---

## 5. 当轮即时写卡 vs 静默整理轮的 Git 提交边界与锁协同

本节闭环 `Spec 01` §3.2 留给 `Spec 02` 的并发与 Git 隔离细则。核心铁律：**任何时刻，只暂存自己亲手触碰的常规路径，绝不 `git add -A`，绝不 `git reset --hard` 误伤外部手动修改或另一路径的合法改动。**

### 5.1 两类写入源的锁与提交边界

| 写入源 | 触发场景 | 锁粒度与互斥防竞态规则 | Git 提交时机与格式 | 是否走 C2.7 复核 |
| :--- | :--- | :--- | :--- | :--- |
| **主对话当轮即时写卡** | 聊天中顺手改 `daily/` `state`、记 `favorite/`、收 `entities/` 或 `edit` `self`/`user`/`shelf` | 在 `ChatTurnLock` 内按需短持 `MemoryWriteMutex` 完成写盘与索引刷新，路径记入本轮 `turnTouchedMemoryPaths`（排除 `private/`） | **若本轮未触碰任何记忆文件（`turnTouchedMemoryPaths.size === 0`，占日常闲聊 95%+），直接推送 `turn.done` 并释放 `ChatTurnLock`，绝对不争抢 `MemoryWriteMutex`，彻底杜绝前台闲聊被后台整理轮（C2.7 复核 15~30s）无故阻塞**；仅当当轮产生了实际写卡（`turnTouchedMemoryPaths.size > 0`）时，才在释放 `ChatTurnLock` 前短持 `MemoryWriteMutex` 执行精准提交 | **否**（不阻塞前台聊天；由后续整理轮做 `state` 对账兜底） |
| **静默整理轮（`MemoryTx`）** | `activity:<slug>` / `daily_wrapup` / `bedtime`（按 `10_000` 字分批） | **仅在 `ChatTurnLock` 空闲时启动批次**（杜绝与进行中主对话的未提交 `turnTouchedMemoryPaths` 交叉改写）；单批持 `MemoryWriteMutex` 完成 A→B→C→commit；多批期间若检测到新主对话排队等锁，当前批提交释放后自动让出一次事件循环给主对话先运行 | 每批正常结束后执行 `git add -- <...touchedMemoryPaths>`；若 `git diff --cached --quiet` 非空则 `git commit -m "memory(<task>): <summary> [review: fixed=<N>, rejected=<M>]"` | **是**（C2.7 单轮只读 diff 复核） |

### 5.2 单队列游标查询（Ring 1 极简版；`digested_activity_spans` 于 Ring 1.5 启用）

- **Ring 1 单队列连续消费**：`daily_wrapup`（75% 异步换段触发）与 `bedtime`（每日睡眠窗触发）共享同一单调游标 `task_cursors['daily_wrapup']`，按 `seq ASC` 连续拉取 `status = 'active'` 的 `chat / wake / door_note`（显式标注门缝纸条且**绝不推进 `door_notes_read`**），按 `TASK_BUDGET = 10_000` 字分批提交推进游标；**Ring 1 暂不建 `digested_activity_spans`、不做进行中活动前沿截断**，待 Ring 1.5 接入 `ActivityPlugin` 时启用下列完整 span 过滤 SQL：
  ```sql
  SELECT * FROM events e
  WHERE e.status = 'active'
    AND e.role IN ('user', 'assistant')
    AND e.kind IN ('chat', 'wake', 'door_note')
    AND e.id > COALESCE((SELECT last_event_id FROM task_cursors WHERE task_key = 'daily_wrapup'), '')
    AND (? IS NULL OR e.id < ?) -- 可选连续前沿上限：min(最早进行中活跃活动 event.id, 忙态待回复首条 event.id)
    AND NOT EXISTS (
      SELECT 1 FROM digested_activity_spans s
      WHERE e.activity = s.slug AND e.id BETWEEN s.start_event_id AND s.end_event_id
    )
  ORDER BY e.seq ASC;
  ```
  - **切批防卡死**：按累计字符数达到 `TASK_BUDGET = 10_000` 字切批，严格不断开同一 `turn_id` 的 user/assistant 对；若首个完整 `turn_id` 即超过 `10_000` 字，仍整轮纳入本批（保证每批至少推进 1 个 `turn_id`）；每批提交后立即将 `task_cursors['daily_wrapup']` 推进至本批末条 `event.id`（ULID 单调递增与 `seq` 同序）；若本批中恰包含已结束但未建 span 的历史残留活动事件，同步补记其 `digested_activity_spans`；
- **`bedtime` 执行顺序**：
  1. 先循环调用 `daily_wrapup` 排空游标之后剩余未整理对话；
  2. 提取**上次 `bedtime` 以来（`updated_at >= meta.last_run_at`，首次取当日零点）**新写/修改的卡片摘要，以及**当日关键双向反馈链（`prev → acts → next`）**：筛选自 `last_run_at` 以来包含 `tool_calls`、`express`、`door` 状态变化或连续多轮呼应的关键 `(user → assistant → next_user)` 片段（每条仅取正文与工具动作摘要，总预算上限 `4000` 字符）；
  3. 若当日恰逢 ISO 周末（周日）、月末或年末，自动一并注入当月 `gist/days/YYYY-MM.md`（或当年 `gist/months/YYYY.md`）供住户滚动汇总；
  4. 成功后将 `task_cursors['bedtime']` 推进至当前最新 `event.id`，并在 `meta_json` 记下 `{ last_gist_date, last_run_at, last_commit_sha }`（保证同日不重复触发且不错过昨日深夜睡前后的新增卡片）。

### 5.3 异常回滚与崩溃自愈

1. **整理轮回滚绝不碰 Git 命令**：`MemoryTx` 仅依靠内存备份 `Map<relPath, Uint8Array | null>` 逐文件删掉新建文件、覆回修改前原始字节（`touchedMemoryPaths` 与 `touchedPrivatePaths` 同步还原），再调用 `reindexFile` / `removeFromIndex` 刷新索引，避免干扰磁盘上用户手工编辑的未跟踪文件。
2. **启动自愈（Crash Recovery）**：
   - `memory/` 首次初始化时执行 `git init` 并设本地仓库作者为 `Psyber Resident <resident@psyber.local>`（遵守开源匿名红线）；
   - 每次服务启动先清理 `<dataDir>/.tmp/*` 残留临时文件，再检查 `<dataDir>/memory/.git/index.lock`（确认无存活 `git` 进程后清理）；若 `git status --porcelain` 检出上次崩溃残留的未提交改动，仅暂存其中已跟踪（排除 `??` 未跟踪）且在 §1.1 写白名单内的记忆卡片路径，执行一次安全兜底提交 `recovery(memory): preserve uncommitted changes on startup` 并触发增量对账，绝不丢弃数据；**未跟踪文件一律不收入提交**（避免误收用户手写杂文件），若只有未跟踪文件则不提交。

---

## 6. C2.7 冲突对账与写后独立复核协议（Ring 1 仅注入未关闭 `state` 清单；下列细则于 Ring 1.5 按实测按需启用）

> **Ring 1 极简边界**：Ring 1 整理轮默认注入全部未关闭的 `daily/` `state` 卡清单供住户第一人称改 `resolved`，**暂不启用写时 tag 重叠拦截与 B/C 复核修订轮**；Ring 1.5 若启用复核，复核异常仅记告警日志，**绝不回滚阶段 A 已落盘的合法卡片**。

### 6.1 `daily/` `state` 冲突对账算法（Ring 1.5）

1. **Tag 归一化**：对每个 tag 执行 `NFKC → trim() → toLowerCase() → 剥离中英文标点与空白`；过滤低区分度泛词停用表（`日常`、`状态`、`今天`、`最近`、`临时`、`提醒`）。
2. **两处机械检测（只报客观重叠，绝不下真伪/心理判断）**：
   - **整理轮启动扫描**：先执行 `expireOverdueStateCards(Clock.now())`，再查询 `card_index WHERE space = 'daily' AND kind = 'state' AND status = 'active' AND (expires_at IS NULL OR expires_at > Clock.now())`，计算所有卡片对 `(A, B)` 的 `overlap = intersect(normTagsA, normTagsB)`；凡 `overlap.length >= 1` 的配对作为「疑似同一件事的新旧状态」清单，与全部未关闭（`status IN ('active', 'disputed')` 且未过期）的 `daily/` `state` 卡摘要一并注入整理轮材料。
   - **写时即时提醒**：无论在整理轮阶段 A/C 还是主对话中，只要 `write`/`edit` 落盘了一张 `daily/` `kind: state` 且 `status === 'active'` 的卡片，沙箱立刻与其余未过期 `active` `state` 卡比对 `tags`；若有重叠，在 `tool_result` 末尾追加客观提示：
     ```text
     [状态标签重叠提示] 与既有未关闭状态卡存在相同标签：
     - daily/2026-11-12-ankle.md（标题：右脚踝扭伤，状态：active，重叠标签：脚踝、扭伤）
     如属同一件事的状态更新，可自行将旧卡改为 resolved；如存在分歧暂难判定，可标 disputed 并记入 shelf/threads.md。
     ```

### 6.2 写后独立复核 Diff 构建与出处过滤算法

1. **复核输入构造（防止修改旧卡爆发假阳性）**：
   - 遍历 `MemoryTx.touchedMemoryPaths`（已天然排除 `private/`）：
     - 若 `beforeBytes === null`（**新建卡**）：输出 `=== [NEW] <path> ===\n<afterText>`，`checkableText = afterText`；
     - 若 `beforeBytes !== null`（**修改旧卡**）：用行级 LCS 计算 `unified diff`（前后附 3 行上下文供理解语境），输出 `=== [MODIFIED] <path> ===\n<unifiedDiff>`；提取全部有效新增/修改行 `+`（自动忽略仅修改 frontmatter `updated:` 时间戳的纯日期行）拼接为 `checkableText`；
   - 若 `touchedMemoryPaths` 为空，传入 `（本轮未新建或修改任何常规记忆卡片，仅核查漏记）`。
2. **引用文本归一化与硬过滤**：
   ```ts
   export function normalizeForQuoteMatch(input: string): string {
     return input
       .normalize("NFKC")
       .toLowerCase()
       .replace(/[\p{P}\p{S}\s]+/gu, "");
   }
   ```
   - 解析 `prompts/review.md`（v3）返回的 JSON（允许剥离外层 ```` ```json ... ``` ```` 代码围栏或简要前导提示，提取最外层 `{ ... }`）；若仍无法解析为合法 `{ issues: ReviewIssue[] }` 数组，判定为**复核调用异常 → 仅记录告警日志并跳过修订，绝不回滚阶段 A 已落盘的合法卡片**；
   - 逐条校验 `issues`（`MIN_QUOTE_LEN = 4`）：
     - **`attribution` / `no_bleed`**：必须满足 ① `cardPath ∈ touchedMemoryPaths`；② `normCardQuote = normalizeForQuoteMatch(cardQuote)` 长度 `≥ 4` 且 `normalizeForQuoteMatch(checkableText[cardPath]).includes(normCardQuote)`；③ 若提供非空可选 `transcriptQuote`，校验其归一化后是否出现在 `normalizedTranscript`——**若未命中，仅剥除该可选 `transcriptQuote` 字段并保留该条问题**（防止无原文对照的纯捏造被误杀）；
     - **`omission`**：`cardPath` 可为 `null` 或建议路径；必须满足 `normTranscriptQuote = normalizeForQuoteMatch(transcriptQuote)` 长度 `≥ 4` 且 `normalizedTranscript.includes(normTranscriptQuote)`；
   - 未通过上述核心校验的单条伪刺直接静默丢弃并写入警告日志（含原因码 `INVALID_PATH` / `QUOTE_NOT_IN_DIFF` / `QUOTE_NOT_IN_TRANSCRIPT` / `QUOTE_TOO_SHORT`）。

### 6.3 整理轮异常与降级矩阵

| 阶段与失败类型 | 磁盘动作 | `task_cursors` 游标 | 备注 |
| :--- | :--- | :--- | :--- |
| 阶段 A 写作轮模型报错 / 超时 / 鉴权失效 | 回滚 `MemoryTx` 并刷新索引 | **不推进** | 下次触发安全重试 |
| 阶段 A 正常结束但末尾 `{"summary"}` 缺失或微瑕 | 保留改动（Ring 1 直接提交；Ring 1.5 进阶段 B） | 正常推进 | 摘要降级为触碰文件名拼接，绝不回滚（NG-2） |
| 阶段 B（Ring 1.5）复核超时 / 报错 / JSON 不可解析 | **不回滚阶段 A**，正常提交阶段 A 改动 | **正常推进** | 非阻塞降级，commit 记 `[review: skipped]` 并打告警日志 |
| 阶段 C（Ring 1.5）修订轮模型报错 / 超时 | 仅回滚阶段 C 增量、保留并提交阶段 A 改动 | **正常推进** | 绝不因复核/修订异常丢弃阶段 A 合法卡片 |
| 阶段 C（Ring 1.5）正常结束、仅末尾 JSON 微瑕 | **正常提交 Git**，commit 记兜底摘要与 `[review: unparsed]` | **正常推进** | 落实 NG-2，绝不因提交摘要格式回滚整晚整理 |

---

## 7. 召回管线（Ring 1 极简 3 步召回；Ring 1.5 按真实标注启用进阶公式）

> **Ring 1 极简实现口径**：先调用 `expireOverdueStateCards(Clock.now())` 过滤到期 `state` 卡，过 §7.1 空档短路后仅执行 3 步：① 命中 `activities/REGISTRY.yaml` 触发词则挂该目录 Top-3 活跃卡；② 其余活跃卡按 `embedding` 余弦相似度（未配置或超时则降级 FTS5 2-gram）取 Top-5，非活动闲聊补近 72h 未过期 `daily/` 最多 2 条；③ 剔除 2h 内本会话已召回卡，按 `3200` 字符截断并写入 `recall_traces`。
> 下文 §7.2–§7.4 中的全库实时 `MATCH` IDF 公式、单字 `LIKE` 兜底、`access_count` 半衰期延寿与 `Reranker` 二阶段精排**延后至 Ring 1.5**，待攒够 ≥ 100 条真实 `recall_feedback` 标注后按数据评估启用。

### 7.1 空档短路检测（Blank-Turn Short-Circuit）

```ts
const CONTINUE_TRIGGERS = /(接着讲|继续讲|接着说|继续|后来呢|然后呢|再讲一遍|刚才说的)/;
const FILLER_EXACT = new Set([
  "嗯", "嗯嗯", "哦", "噢", "好", "好的", "好呀", "好哒", "哈哈", "哈哈哈",
  "哈哈哈哈", "行", "行吧", "收到", "知道了", "晚安", "早安", "ok", "okay", "k",
]);
```

仅当同时满足 ① 无活跃 `ActivityPlugin`；② 未命中 `CONTINUE_TRIGGERS`；③ 剥除标点、空白与纯表情后为空，或长度 `≤ 4` 且 `.toLowerCase()` 后命中 `FILLER_EXACT` 时，跳过双轨召回（返回空块，不写入 `recall_traces`）。

### 7.2 候选过滤、时间衰减与向量拼接口径

- **全局排除集合**：`private/*`（物理不在库）、已常驻静态前缀/历史锚点的文件（`self.md`、`user.md`、`shelf/*`、`gist/*`），以及 `status IN ('resolved', 'archived', 'faded')`（`faded` 仅退出自动召回，用户显式追问时住户仍可通过 `grep`/`read` 翻出）；
- **单卡向量文本拼接口径**（保证 `card_embeddings` 一行一卡）：
  ```text
  标题：<title>
  召回提示：<when_to_recall 或空>
  标签：<tags 空格拼接>
  正文：<剥除 frontmatter 后的前 1200 字符>
  ```
- **时间衰减系数 `decayFactor(card, nowMs, activitiesRegistry)`**：
  - `favorite/*`、`entities/*`、`daily/` `kind: state`（`active` 未过期，或 `disputed`——`disputed` 卡不设 `expires_at`，永不参与过期巡逻）：恒定 `1.0`；
  - `activities/<slug>/*`：数据驱动读取 `activities/REGISTRY.yaml` 中该 `slug` 声明的 `decay`（缺省未注册取 `none`），以 `Δdays = max(0, nowMs - card.updated_at) / 86_400_000` 计算：
    - `none`：`1.0`（永久作品档案）；
    - `slow`：$0.5^{\Delta\text{days} / 90}$（90 天半衰）；
    - `short`：$0.5^{\Delta\text{days} / 10}$（10 天半衰）；
  - `daily/` 其余卡片（`episode`、`note` 等）：以 `Δdays = max(0, nowMs - card.created_at) / 86_400_000` 计算，按 30 天半衰且随精读巩固缓衰：
    $$\text{halfLifeDays} = 30 \times \left(1 + 0.25 \times \min(\text{access\_count}, 8)\right), \quad \text{decay} = 0.5^{\Delta\text{days} / \text{halfLifeDays}}$$

### 7.3 轨道 1 · 同活动强连续（Context-Routed Recall）

1. **活动空间路由优先级**：
   - ① 活跃 `ActivityPlugin` 传入的 `activityHint`（最高优先，附可选 `topicHint`）；
   - ② 本轮用户输入命中 `activities/REGISTRY.yaml` 某空间的 `triggers`（任意子串匹配）；
   - ③（当 `embedding` 可用且 ①② 未命中）查询向量与各空间描述向量（`title + triggers + card_style`，按 `(model_key, hash(activities/REGISTRY.yaml))` 在内存中懒计算缓存）的余弦相似度 `≥ 0.72` 时取最高者。
2. **轨道 1 选卡规则（最多 3 张）**：
   - 若存在 `topicHint` 且在 `activity:<slug>` 下命中目标卡（文件名/标题匹配）→ 锁定为第 1 槽（`track = 'same_activity'`, `final_score = 1.0`），并在其余未排除同空间卡片中按综合分取 **Top-2** 兄弟卡；
   - 若不存在 `topicHint`（经由 `triggers` 或空间向量触发）→ 在 `activity:<slug>` 全部未排除卡片中按综合分直接取 **Top-3**（均受 §7.5 2 小时去重约束，锁定 `topicHint` 主卡豁免）；
   - 同空间综合分计算（`kwNorm` 复用 §7.4 `kw_score`，`recency = exp(-Δdays / 30)` 其中 `Δdays` 取 **`card.updated_at`** 以保跨月连载故事活跃度）：
     - 向量可用：`0.65 * sem + 0.25 * kwNorm + 0.10 * recency`；
     - 向量不可用降级：`0.75 * kwNorm + 0.25 * recency`。

### 7.4 轨道 2 · 跨活动语义互文（Cross-Activity Vector Resonance）

在剩余全部活跃候选卡（含 `active` 与 `disputed`，排除轨道 1 已选）上执行两阶段检索：

1. **一阶段双路融合（RRF）**：
   - 语义路 `sem_score`：L2 归一化向量的点积（即余弦相似度 $\in [-1, 1]$，负值截断为 `0`），按降序取 Top-30 得 `rank_sem`（1-based）；
   - 字面路 `kw_score`：对 FTS5 `bm25(card_fts, 0, 2.0, 2.0, 1.0)` 取负值与全库逆文档频率加权融合（保证在 `< 20` 卡的小语料夹具与大库中均能稳定区分强专名命中）：
     - $\text{bm25Norm}(c) = \frac{-\text{bm25}(c)}{-\text{bm25}(c) + 1.2} \in [0, 1)$；
     - $\text{idfCoverage}(c) = \frac{\sum_{t \in T_Q \cap T_c} \text{idf}(t)}{\sum_{t \in T_Q} \text{idf}(t)}$，其中 $\text{idf}(t) = \ln\left(1 + \frac{N + 1}{\text{df}(t) + 0.5}\right)$；
     - $\text{titleTriggerBonus}(c) = 0.15$（若至少 1 个去停用词查询词元命中 `title_tokens` 或 `trigger_tokens`，否则 `0`）；
     - $\text{kw\_score}(c) = \min\left(1.0,\ 0.60 \times \text{bm25Norm}(c) + 0.40 \times \text{idfCoverage}(c) + \text{titleTriggerBonus}(c)\right)$（单字 `LIKE` 兜底候选命中标题记 `0.60`，命中正文记 `0.45`）；取 Top-30 得 `rank_kw`（1-based）；
     - $N$ 与 $\text{df}(t)$ 的来源（无独立词频表，实时查 FTS5）：$N$ = `SELECT COUNT(*) FROM card_index` 的总行数；$\text{df}(t)$ = `SELECT COUNT(*) FROM card_fts WHERE card_fts MATCH '"t"'` 的命中卡片数，每查询词一次；查询词数少、语料为个人记忆库量级，开销可忽略。单字 `LIKE` 兜底候选不参与 IDF 计算。
   - RRF 融合（$k = 60$，未进入某路 Top-30 的该路贡献项取 `0`）：
     $$\text{rrf}(c) = \left(\frac{w_{\text{sem}}}{60 + \text{rank}_{\text{sem}}(c)} + \frac{w_{\text{kw}}}{60 + \text{rank}_{\text{kw}}(c)}\right) \times \text{decay}(c)$$
     - 正常模式：$w_{\text{sem}} = 0.65,\ w_{\text{kw}} = 0.35$；
     - **离线/超时降级模式**（`embedding` 未配置、报错或超时 `> 2500ms`）：$w_{\text{sem}} = 0,\ w_{\text{kw}} = 1.0$；
   - 取一阶段 Top-12，按当前批最大值归一化为 `rrf_norm ∈ [0, 1]`。
2. **二阶段可选 Reranker 精排**：
   - 若 `slots.reranker` 已配置，以 `2500ms` 超时并发调用 Reranker（输入 `query` + 每张候选卡的 `标题 + 召回提示 + 正文前 600 字`），得 `rerank_score ∈ [0, 1]`，综合分 `final = 0.70 * rerank_score + 0.30 * rrf_norm`；
   - 未配置、报错或超时 → 静默降级 `final = rrf_norm`，绝不阻塞主对话。
3. **跨目录高门槛与去重排序（防无关串场，最多选 2 张）**：
   - 先过滤通过以下任一门槛的候选：① 正常模式 `sem_score >= 0.65`（配置了 Reranker 且可用时亦满足 `rerank_score >= 0.60`）；② 降级模式或强专名命中 `kw_score >= 0.55`；
   - 再过滤掉 §7.5 2 小时会话去重命中的卡片，最后按 `final` 降序取 **Top-2**（`track = 'cross_vector'`）。

### 7.5 日常近因兜底、会话去重与字符预算裁剪

1. **日常近因兜底（`track = 'daily_recent'`）**：仅当轨道 1 未激活时，补取 `created_at >= now - 72h` 且 `space = 'daily'`、`status IN ('active', 'disputed')`（未过期）、未在轨道 2 选中且未被 2 小时去重跳过的最新卡片，按 `updated_at DESC` 最多取 **2 张**。
2. **会话内 2 小时去重（排除已作废轮次）**：查询 `recall_traces r` 中 `r.session_id = ? AND r.created_at >= now - 7_200_000` 且其关联的助手回复仍处于 `active` 状态（即 `EXISTS (SELECT 1 FROM events e WHERE e.turn_id = r.turn_id AND e.role = 'assistant' AND e.status = 'active')`）的卡片，默认跳过；**两类豁免**：① 轨道 1 `topicHint` 锁定主卡；② 用户本轮输入命中 `CONTINUE_TRIGGERS`（如「再讲一遍」「刚才说的」）。（前提：`edit` / `reroll` 产生新 `turn_id`——同一逻辑轮的各版本共享 `group_id`、`turn_id` 各不相同；若复用同一 `turn_id`，本判定失效，须改按 `group_id` + `version` 判定。）
3. **字符预算控制与状态/忌日客观标记（默认 `RECALL_CHAR_BUDGET = 3200` 字符）**：
   - 按固定优先级依次装填：`轨道 1 主卡 > 轨道 1 兄弟卡 > 轨道 2 跨活动互文 > 日常近因兜底`；
   - 单卡完整正文若超出剩余预算（且剩余预算 `≥ 160` 字符），按「保留前 70%（受总剩余预算扣除省略号与末句上限约束）+ 省略号 `…（正文略，如需细节可 read 全文）` + 保留末句」截断，保证拼接后总长严格 `≤` 剩余预算；剩余 `< 160` 字符则停止装填后续卡片；
   - 客观附加标记（不替住户下心理判断）：若卡片 `status === 'disputed'`，标题行附加 `[待确认/有分歧]` 并附一行客观核实提示；若 `date_kind === 'gentle'`，标题行附加 `[敏感忌日·轻声对待]`（严禁自动欢庆）。

### 7.6 真实 Dynamic Tail 注入样例（严守「系统只报事实、不代下心理判断」红线）

> 场景：正在一起看《人生切割术》第二季（`activityHint: "cinema"`, `topicHint: "severance-s2"`），用户说「男主在走廊里迷路那段，莫名让人想起灯塔那晚」，同时跨活动联想命中睡前故事卡，另有一张 `disputed` 冲突状态卡被召回。

```xml
<recalled_memories note="系统按当前话题与活动检索到的历史笔记片段，仅供自然参考，并非本轮必须提及的清单">
- [同活动·当前主题] activities/cinema/severance-s2.md（前几天 · kind: work）
  标题：人生切割术 S2
  上次看到 S2E03 结尾。我们一起吐槽公司走廊像没有出口的迷宫，对方说最被打动的是角色明知会被抹去记忆还是想留下一句真话。
- [跨活动联想] activities/stories/lighthouse-keeper.md（上个月 · kind: serial）
  标题：雾里的守灯人
  连载停在第 4 章：主角在起雾的回廊里听见自己前一天录下的声音。对方喜欢这种克制又带一点悬疑的慢节奏。
- [跨活动联想] daily/2026-11-16-sleep-schedule.md（前几天 · kind: state · [待确认/有分歧]）
  标题：近期作息安排
  系统提示：该状态卡存在待核实分歧，请勿武断当成定论，可在合适时机自然向对方确认。
  上周对方说这周要改早睡，但前天又提到周四晚上想通宵把剧追完。
</recalled_memories>
```

---

## 8. `daily/` 过期状态机、`vagueWhen` 与 `media/` 临时帧清理

### 8.1 `daily/` 短期状态生命周期状态机

```text
                用户说"好了"/亲口纠正（住户改卡）
             ┌───────────────────────────────────────┐
             ▼                                       │
          [resolved] ◄── 后续核实定论 ── [disputed] ◄─┴── 对账发现矛盾（住户标卡+挂 shelf/threads.md）
             ▲                              ▲
             │                              │
        [active] ───────────────────────────┘
             │
             │ 到达 expires_at（系统仅更新索引层 card_index.status，绝不后台代改 Markdown）
             ▼
          [faded] ── 复发/重提时由住户主动延后 expires_at 或新建卡 ──► [active]
             │
             └── 长期封存（住户改卡）──► [archived]
```

- **有效状态函数**：`effectiveStatus(row, nowMs) = (row.space === 'daily' && row.kind === 'state' && row.status === 'active' && row.expires_at !== null && row.expires_at <= nowMs) ? 'faded' : row.status`；
- **不代笔铁律落地**：到达 `expires_at` 后，系统**只将 `card_index.status` 置为 `faded`**，使其立刻退出常规召回与近期背景，**绝不偷偷修改 `<dataDir>/memory/daily/*.md` 的磁盘正文**（保住 C2.1 第一人称主权与零后台代写）；若后续旧伤复发或重提需在原卡续用，`read` 会附带 `[索引状态: faded]` 提示，由住户自行 `edit` 更新 `expires_at`（或 `created` / `ttl_days`）或改建新卡。
- **分歧卡无过期**：`status === 'disputed'` 的卡不设 `expires_at`（见 §3.1，写时自动清除），因此永不参与 `expireOverdueStateCards` 巡逻；由 `disputed` 回到 `active` 时，住户可显式填写 `expires_at`，未填则按 §3.1 以当日（`updated` 本地日期）`+ ttl_days` 重新计时（不沿用旧 `created` 导致立刻过期）。

### 8.2 `vagueWhen(targetMs, nowMs, timeZone)` 确定性渲染规程

按部署者配置的本地时区（`config.json` `timezone`）计算日历日差 $\Delta d = \text{calendarDay}(\text{now}) - \text{calendarDay}(\text{target})$（若 `targetMs > nowMs` 视为时钟微小漂移，统一按 `刚才` 处理）：

| 条件 | 输出中文模糊时间 |
| :--- | :--- |
| $\Delta d \le 0$ 且 `nowMs - targetMs < 1h` | `刚才` |
| $\Delta d = 0$ 且 `nowMs - targetMs ≥ 1h` | `今天早些时候` |
| $\Delta d = 1$ | `昨天` |
| $\Delta d = 2$ | `前天` |
| $3 \le \Delta d \le 6$ | `前几天` |
| $7 \le \Delta d \le 13$ | `上周` |
| $14 \le \Delta d \le 25$ | `半个月前` |
| $26 \le \Delta d \le 45$ | `上个月` |
| $46 \le \Delta d \le 180$ | `几个月前` |
| $181 \le \Delta d \le 400$ | `大半年/去年`（跨日历年输出 `去年`，同年输出 `大半年以前`） |
| $\Delta d > 400$ | `很久以前` |

### 8.3 `media/` 内容寻址仓（Ring 1 仅做 SHA-256 存取；观影临时帧 24h 淘汰于 Ring 1.5 启用）

- **内容寻址落盘**：所有二进制资产按 SHA-256 去重存入 `<dataDir>/media/<hash[0..1]>/<hash>.<ext>`，同步写 `media_assets`。
- **永久保留判定（`pinned = 1`）**：
  - `origin IN ('user_upload', 'creative', 'sticker')` 一律默认 `pinned = 1`；
  - 每次 `memory/**/*.md` 增量索引扫描时，提取正文中引用的 `media/<64-hex>` 或 `/api/v1/media/<64-hex>` 哈希，自动将对应 `media_assets.pinned` 置为 `1`（确保常规记忆或收藏引用的关键画面永不被误删；`private/` 不扫不入库）。
- **高频观影抽帧淘汰任务（每日睡前定时触发）**：
  - 仅扫描 `origin = 'cinema_frame' AND pinned = 0 AND expired = 0` 且通过 `activity_session_id` 关联（`Spec 03` 活动会话表或 `events` 结束标记）已结束超过 **24 小时**的记录；
  - 按每场 `activity_session_id` 保留**最多 3 张代表帧**（等距采样：首帧 + 中段帧 + 末帧，已 `pinned` 的关键帧优先计入配额；新选出的代表帧同步置 `pinned = 1`，避免次日重复扫描历史已清理场次）；
  - 其余冗余临时帧删除磁盘文件并将 `media_assets.expired` 置为 `1`（保留 `events` 历史行，客户端请求已淘汰帧时 `GET /api/v1/media/:hash` 返回 `410 GONE` 供前端优雅渲染占位图）。

---

## 9. 真实召回评测闭环与 `bun run eval:recall` 回归口径

### 9.1 线上留痕与标注契约

1. **自动留痕**：每轮非短路主对话完成双轨召回后，将所有最终入选卡片写入 `recall_traces`（**严禁记录 `private/`**），并在 `turn.done` 中下发 `recallCount`；前端开启「评测模式」后调用 `GET /api/v1/turns/:turnId/recall` 按需展开。
2. **标注三态语义（`POST /api/v1/recall/feedback`）**：
   - `useful`（准）：对本轮回复确有帮助的命中卡（必填 `cardPath`）；
   - `noisy`（噪声）：与当下语境无关或令人出戏的误召卡（必填 `cardPath`）；
   - `missed`（漏召回）：本应想起但未命中的卡片（`cardPath` 填目标卡路径，或用 `note` 描述漏掉的事实供人工补标）。

### 9.2 离线回归命令（`bun run eval:recall`）

```bash
bun run eval:recall --data-dir ~/.psyber/test --offline --top-k 5
```

- **参数说明**：`--top-k <N>`（缺省 `5`）仅设定评测指标 `Precision@K` 的 `K`（取每轮 `final_score` 前 `K` 张卡片计算），不改变召回引擎本身的选卡上限（轨道 1 最多 3 + 轨道 2 最多 2 + 日常近因最多 2）。

- **成本与隔离护栏（遵守 `AGENTS.md` 红线）**：
  - CI 与自动化测试**强制使用 `--offline` 模式**（Ring 1 为纯 FTS5 2-gram + 模拟固定向量夹具，Ring 1.5 按需叠加 IDF/单字 `LIKE`，阻断一切外部 LLM / Embedding 网络调用）且仅读取合成夹具库（`~/.psyber/test`），严禁将真实用户标注库提交进仓库；
  - 开发者手动调优真实效果时，可显式传 `--with-embedding`（优先复用 `card_embeddings` 缓存）或 `--with-reranker`。
- **回放算法与输出指标**：
  - 按时间顺序回放 `recall_feedback` 涉及的每个历史 `turn_id`：优先从 `recall_traces` 取 `query`、`activity_hint`、`session_id`、`created_at`；若该轮当年 0 命中（导致 `recall_traces` 无记录但被标了 `missed`），自动回落查询 `events WHERE turn_id = ? AND role = 'user' AND status = 'active'` 恢复 `content`、`activity`、`session_id` 与 `created_at`（可选从 `events.metadata.topicHint` 恢复活动主题）后重新运行当前召回引擎，对比新旧结果输出 JSON + 终端摘要表：
    - **Precision@K** $= \frac{\text{重放命中的 } useful \text{ 数}}{\text{重放命中的 } (useful + noisy) \text{ 数}}$；
    - **Noise Rate** $= \frac{\text{重放命中的 } noisy \text{ 数}}{\text{重放命中的 } (useful + noisy) \text{ 数}}$；
    - **Miss Recovery Rate** $= \frac{\text{历史标为 } missed \text{ 且新算法成功召回的条数}}{\text{历史带 } cardPath \text{ 的 } missed \text{ 总数}}$；
    - **分轨道贡献占比**：`same_activity` / `cross_vector` / `daily_recent` 各自的命中量与准确率；
    - 可选 `--baseline <report.json>`（Ring 1.5）：对比基线报告，若 Precision 下降 `> 3%` 或 Noise Rate 上升 `> 3%` 返回非零退出码用于回归守门。

---

## 10. Spec 02 出口验收清单（按 Ring 1 / Ring 1.5 分期对照）

### Ring 1 必过验收
- [ ] 纯 `memory/` 5 工具沙箱：覆盖越界逃逸、拦截 `private/` 与无 `.md` 孤儿路径、禁覆写已存在 `self.md`/`user.md`、`edit` 标点归一化回退且补丁外零字节漂移、`<dataDir>/.tmp/` 原子写与 `REGISTRY.yaml` 写前报错自救；
- [ ] 单队列整理与 Git 隔离：主对话当轮写卡轮末精准提交，静默整理轮按 `10_000` 字分批单轮写作与 `git commit`、`daily_wrapup` 连续收录 `door_note`（不推进 `door_notes_read`）、阶段 A 异常回滚绝不误删外部未提交文件；
- [ ] 极简 3 步召回与状态闭环：活动目录触发词直挂 + Embedding 余弦（降级 FTS5 2-gram）+ 2h 会话去重；`daily/` `state` 10 天仅在索引层标 `faded`（不篡改 Markdown）/ 康复 `resolved` 立即退出；`gist/days` 与 `gist/weeks` 组装与 `recall_traces`/`recall_feedback` 落库全绿。

### Ring 1.5 扩展验收
- [ ] `private/` 独立工具（`drawer_read`/`drawer_write`）与 `.sealed` 三道隔离全绿：磁盘无明文中文、SQLite/`memory/.git` 零记录、`drawer/:id/open` 强制先写 `privacy.peeked` 与 `events_notice` 游标；
- [ ] C2.7 冲突对账（启动两两扫描 + 写时 tag 重叠提醒 + `disputed`）与非阻塞独立复核（新建全审/旧卡 diff 审、阶段 B/C 异常绝不回滚阶段 A）全绿；
- [ ] 进阶召回（IDF + 单字 `LIKE` + `access_count` 延寿 + `Reranker` 2.5s 降级）、`digested_activity_spans` 活动前沿门禁、`gist/months` & `years`、观影临时帧 24h 淘汰与 `eval:recall --baseline` 全绿。
