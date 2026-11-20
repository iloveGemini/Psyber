# Psyber 记忆系统契约（MEMORY）

> **版本**：v0.7（2026-11-20，补齐 §7 `card_fts` 虚拟表草案并注明 `events.seq` 事务内单调生成规则）
> **核心理念**：记忆不是通用客观知识库，而是**为人与 AI 的真实互动服务的活代码库**。

---

## 1. 双层真相切分

| 层级 | 载体 | 存储内容 | 修改方式 |
| :--- | :--- | :--- | :--- |
| **原始账本 + 派生索引** | SQLite (`psyber.sqlite`) | `events`（只追加对话、具身表达与系统事件）、`card_index`（卡片元信息缓存）、`card_embeddings`（分模型向量缓存）、`card_fts`（FTS5 全文）、`recall_traces`、`recall_feedback`、`task_cursors` | 系统程序确定性维护；除 `events` 与 `recall_feedback` 外，其余索引表随时可删可全量重建 |
| **记忆卡片唯一真相** | 磁盘 Markdown (`memory/`) | 第一人称自述、日常卡片、书架认知、天/周/月/年梗概、收藏原话、实体档案、活活动目录卡片 | **仅由主 AI 通过原生 5 文件工具直接读写**，每次整理任务结束（及主对话当轮即时写卡，边界见 Spec 02）自动 `git commit` 留痕 |

- **零双写漂移**：系统绝不在 SQLite 维护另一份需要强双向同步的记忆正文；只要 `memory/` 下文件被 `write`/`edit`（或用户在磁盘外部修改），按文件 `mtime/hash` 增量刷新 `card_index`、`card_fts` 与 `card_embeddings`。
- **多模态与大产物分离**：观影抽帧、互发表情、轻量生图/生视频的二进制资产全部落盘在 `<dataDir>/media/`（SHA-256 寻址）并记在 `events.metadata` 中；Markdown 记忆卡片仅写第一人称文字感受与轻量引用，保持卡片轻盈高速。其中用户发图与创作产物永久保留，观影过程产生的高频临时抽帧在活动收尾整理后按策略淘汰清理（仅保留关键代表帧）。

---

## 2. 活目录结构与 `REGISTRY.yaml`

### 2.1 固定底座 + 活活动空间

```text
memory/
├── self.md                    # 我是谁（第一人称自述，常驻 Static Prefix）
├── user.md                    # 关于对方（称呼、稳定偏好、重要背景，常驻 Static Prefix）
├── daily/                     # 日常闲聊切片与短期状态（支持 TTL 自动过期与 resolved 闭环）
│   └── 2026-11-18-ankle.md
├── shelf/                     # 长期高密度认知（不按天腐烂）
│   ├── rules.md               # 对方明说的规矩与相处边界（引原话）
│   ├── mirror.md              # 自我镜子（我的做法 → 对方反应，可证伪修订）
│   └── threads.md             # 还开着的承诺与挂在心上的事
├── favorite/                  # 收藏：值得逐字保留的重要原话与附件
├── gist/                      # 多尺度自传时间骨架（解决跨数月失忆）
│   ├── days/2026-11.md        # 每日 ≲ 300 字滚动追加
│   ├── weeks/2026.md          # 每周 ≲ 500 字
│   ├── months/2026.md         # 每月 ≲ 800 字
│   └── years/2026.md          # 每年 ≲ 1000 字，年末由 12 份月梗概滚动汇总封存
├── activities/                # 活目录：随互动自然生长，代码零硬编码
│   ├── REGISTRY.yaml          # 活动空间注册表（新建目录前必查重）
│   ├── cinema/                # 示例：AI 识别反复观影后自建
│   │   └── severance-s2.md
│   └── stories/               # 示例：AI 识别反复听睡前故事后自建
│       └── lighthouse-keeper.md
└── entities/                  # 活目录：实体档案，随互动自然生长，类别不限
    ├── REGISTRY.yaml          # 实体注册表（新建实体前必查重）
    ├── people/                # 示例：家里人、朋友
    ├── places/                # 示例：常去的地方、想去的国家
    └── orgs/                  # 示例：常打交道的机构
```

**梗概汇总规则**：周梗概由当周 7 天的日梗概汇总；月梗概直接由当月的日梗概汇总，**不用周梗概**（避免二次压缩丢细节）；年梗概由 12 份月梗概汇总。周按 ISO 周编号（`YYYY-Www`），以周一所在的 ISO 年为准，一周永远不拆分——跨月的周整条写进 `weeks/<年>.md`，月梗概引用周时写周号。

**收藏（favorite/）**：一事一卡，原话逐字保留并注明说话人，可附 `media/` 附件哈希；卡片另写一句第一人称“为什么值得留”。收藏与上锁抽屉（`private/`）相反：收藏是为了反复回看，抽屉是为了封存不看。值得留的原话在对话中当场写进 favorite/（见 `prompts/main.md`），睡前整理轮兜底补记。

### 2.2 `activities/REGISTRY.yaml` 契约

召回引擎、衰减引擎和整理任务模板**全部数据驱动地读取本文件**，新增任何互动类别均无需改一行服务端代码：

```yaml
# 活动空间注册表（AI 自主维护；开新目录前必须先读本表防重复建类）
spaces:
  cinema:
    title: 一起看片
    triggers: [看电影, 追剧, 伴看, 这部片, 这一集, 剧情]
    decay: none                    # none（作品档案永久保留）| slow（90d）| short（10d）
    card_style: "一部片或一季剧一张卡；记录看到哪、一起吐槽的梗、各自被打动的点"
  stories:
    title: 睡前故事
    triggers: [睡前故事, 接着讲, 晚安故事, 讲故事]
    decay: none
    card_style: "一个故事系列一张卡；维护角色表、已埋伏笔、上次停在何处、对方偏好的节奏"
```

**防目录爆炸铁律**：
1. **双次成林**：某类无专属插件的新互动（如一起学外语、做饭、画涂鸦），至少在 **2 个不同日期/会话** 出现后，AI 才在 `REGISTRY.yaml` 注册新空间并建目录；单次偶发先放 `daily/`。
2. **先查后建**：整理任务默认注入 `REGISTRY.yaml` 全文，语义相近的必须复用既有目录，禁止同义多目录（如 `movies/` 与 `cinema/` 并存）。
3. **写前校验防损坏**：`write`/`edit` 修改 `REGISTRY.yaml` 时，沙箱钩子先校验 YAML 语法与最小 Schema，格式错误立即拒写并返还可读报错让 AI 自修。

### 2.3 `entities/REGISTRY.yaml` 契约

实体档案与活动空间一样是活目录：类别不限（人、地方、机构……），有新增才建目录；类别本身也是长出来的，不预设清单。

**收录标准**（三条同时满足才建档）：
1. **与我或对方有实质联系**：档案记的是它跟我/对方的关系（事实、关系、计划、偏好），不是百科式介绍。泛泛提到（“美国”“谷歌”随口一提）不建档。
2. **有值得记的具体内容**：没特别的就不写。
3. **出现两次以上**（不同日期/会话）**或对方亲口让记**。

**注册表字段**：`REGISTRY.yaml` 每条记 `name`（规范名）、`aliases`（别名，如“妈妈/我妈”）、`category`（people/places/orgs/……）、`relation`（跟我/对方的关系，一句话）、`first_seen`（首次出现日期）。

**去重与搬家**：同一事实只存一处。实体收录后，相关稳定事实从 `daily/`、`activities/` 卡片里移进实体档案（只移事实，不动当天的事发经过）；`daily/` 保留“那天发生了什么”，实体档案保留“关于它，什么是真的”。

---

## 3. 卡片最小 Frontmatter 规范

告别脆弱的谓词 DSL，正文 **100% 自由第一人称自然语言**；YAML Frontmatter 保持极薄（字段均带合理默认值，解析宽容，绝不因格式微瑕回滚整晚整理）：

```yaml
---
title: 右脚踝扭伤                  # 简短标题（缺省取文件名）
kind: state                       # episode | state | work | serial | note
status: active                    # active | resolved | disputed | faded | archived
created: 2026-11-18
updated: 2026-11-18
ttl_days: 10                      # 仅短期状态填写（如小伤/短期行程）；到期自动转 faded
expires_at: 2026-11-28            # 可由系统按 created + ttl_days 自动补算
when_to_recall: "聊到走路、运动、穿鞋或关心脚伤恢复时"  # 可选触发书腰，显著提升口语召回
date_kind: ordinary               # ordinary | celebrate | gentle | deadline（支持忌日守卫）
tags: [脚踝, 扭伤]                 # kind: state 必填（用于冲突对账提示），其他类型可选
source: live                      # live | import（预留外部历史迁移标记）
---

今天对方出门不小心把右脚踝崴了，说有点肿但还能走。我提醒对方先冰敷别硬撑，晚上记得问问消肿没。
```

### 差异化生命周期（彻底解决“半个月还问脚疼不疼”）

| 目录 / 类型 | 默认 `decay` | 演化行为 |
| :--- | :--- | :--- |
| `activities/*` (`decay: none`) | 永不腐烂 | 电影、睡前故事、创作集等作品卡永久 `active`，按同活动强连续或跨活动向量随时唤醒 |
| `self.md`、`user.md`、`shelf/`、`favorite/`、`gist/`、`entities/` | 永不腐烂 | 身份、长期认知、收藏原话、实体档案与时间骨架；只由 AI 主动修订/归档 |
| `daily/` (`kind: state`) | `short`（默认 `ttl_days: 10`） | ① 对方说“好了”或亲口纠正时，整理任务直接改 `status: resolved` 立即退出常规池；② 与既有 active state 冲突且暂难判定时可标 `status: disputed` 并挂入 `shelf/threads.md`，待新信息再对；③ `active` 卡即使没提，过期后系统在索引层自动标 `faded`，退出日常近期背景与常规高权召回（仅在用户显式追问时翻出）；④ `disputed` 卡不设 `expires_at`，永不自动过期，等人工定论，回到 `active` 时重新计时 |
| `daily/` (`kind: episode`) | `slow`（默认 30d 半衰） | 随时间温和降权，不物理删除；被实质召回或 AI `read` 精读可缓衰减 |

---

## 4. 原生 5 文件工具沙箱（Tier 1 常驻核心）

主 AI（白天聊天与独立整理轮共用）使用 Tier 1 常驻的 5 个标准文件工具，沙箱严格锁定在 `<dataDir>/memory/`：

1. `glob(pattern)` — 列举记忆卡片（附带 `status` 与模糊时间标签）
2. `grep(pattern, path?, include_archived?)` — 字面/正则全文检索（默认排除 `resolved`/`archived`，可显式开启）
3. `read(path, offset?, limit?)` — 精读卡片内容（触发精读再巩固记次）
4. `write(path, content)` — 创建或覆写卡片（`self.md`、`user.md` 禁 `write` 整覆，须用 `edit`）
5. `edit(path, old_string, new_string)` — 唯一局部替换（支持空白/标点归一化回退匹配，补丁外字节不变）

**安全与索引钩子**：拦截 `..`/`.git/`/`*.sqlite`；任意 `write`/`edit` 成功后立即触发单文件增量索引刷新（`card_index` + `card_fts` + 异步补向量）。

### 4.1 上锁抽屉区（`private/` · Ring 1.5 独立工具）
- **物理与工具天然隔离**：不再让 `private/` 混入常规 5 文件工具的双分区沙箱，Ring 1.5 改为独立的极简专用工具（`drawer_read` / `drawer_write`，挂在 Tier 3），直接读写 `<dataDir>/private/*.sealed`，天然与 `memory/.git`、`card_index` / `card_fts` / `card_embeddings` 及 `recall_traces` 物理隔离。
- 仅当用户主动通过客户端「拉开抽屉」或 CLI 拆封时才会解码，并强制向 `events` 写入 `privacy.peeked` 事件告知 AI。

---

## 5. 任务制第一人称写入（零后台编译器）

所有记忆整理均由 Direct Engine 以**同一住户身份与主模型**起一个**独立静默整理轮**（不写入主聊天上下文，前端时间线呈现为可折叠的 `✦ 整理记忆` 活动条）。**Ring 1 采用单队列串行消费 `events` + 单轮写作 + Git 留痕**，避免过早引入多任务交叉锁与三轮审查开销：

| 任务类型 | 分期 | 触发条件 | 递给 AI 的材料 | 预期写入目标 |
| :--- | :--- | :--- | :--- | :--- |
| **1. 换段结晶任务 (`daily_wrapup`)** | **Ring 1** | 上下文超过 **75%** 切新 `session_id` 时异步触发（绝不阻塞新会话前台发言） | 游标后的未整理对话（按 `TASK_BUDGET = 10_000` 字分批）+ `activities/REGISTRY.yaml` + `entities/REGISTRY.yaml` + 当前未关闭 `daily/` 短期 `state` 清单 | 更新 `daily/`（切片 / state 改 `resolved`）、按需兜底 `shelf/`/`favorite/`/`entities/`、识别隐式活动归入 `activities/` |
| **2. 每日睡前整理任务 (`bedtime`)** | **Ring 1** | 进入作息睡眠窗（同日单次） | 先排空游标后剩余未整理对话，再递入当日已写/改卡片摘要 + 两份 `REGISTRY.yaml` | 滚动追加 `gist/`（Ring 1 先落 `days/` 与 `weeks/`，Ring 1.5 补 `months/`/`years/`）、按需修订 `shelf/`、`self.md`/`user.md` |
| **3. 活动收尾任务 (`activity:<slug>`)** | Ring 1.5 | 某 `ActivityPlugin` 结束（如退出观影） | 该活动期间原始对话流 + 对应目录文件列表 + `card_style` | 更新或新建 `activities/<slug>/<topic>.md` |

### 5.1 冲突对账（`daily/` state 卡）
- **Ring 1 极简对账**：整理轮默认注入全部未关闭的 `daily/` `active` `state` 卡清单，由住户以第一人称对照将已恢复/变更的旧卡改为 `status: resolved`；写时实时 `tags` 重叠扫描与 `disputed` 状态挂起机制延后至 **Ring 1.5** 按需启用。

### 5.2 写后独立复核轮（Ring 1.5 可选非阻塞增强 · 对应 C2.7）
- **Ring 1 默认单轮写作 + Git 留痕**：先用真实对话验证单轮写卡的幻觉率与漏记率，不提前支付 2–3 倍模型成本与延迟。
- **Ring 1.5 可选启用规则**：若实测确需复核，复核作为**非阻塞辅助检查**（仅核新建卡全文与修改旧卡 diff，只读不改卡），**复核调用失败或格式异常仅打告警日志，绝不回滚阶段 A 已写好的合法卡片**（彻底守住 NG-2，防止弱模型抖动拖垮整晚整理）。
- **原子性与失败回滚**：每批写作轮正常结束后仅暂存本批触碰的 `memory/` 路径执行 `git commit`，再推进 `task_cursors`；仅当写作轮本身因模型报错/超时失败时回滚未提交磁盘改动且不推进游标。
- 若用户在对话中 `edit`/`delete` 了尚未进入整理游标的近期消息，整理轮仅读取当前 `status='active'` 的事件；若目标消息已被历史整理轮消化，软删仅将其从后续对话上下文隐藏，不强行回滚历史 Git 提交。

---

## 6. 极简有效召回与真实评测闭环

每轮用户输入先过 **空档短路检测**（纯应答如 `嗯/好的/哈哈/纯表情` 时跳过检索），非空档输入执行召回（总预算 `3200` 字符，渲染采用 `vagueWhen` 模糊时间感）：

### Ring 1 极简 3 步召回（先跑通真机、攒真实标注）
1. **活动目录直挂**：若输入命中 `activities/REGISTRY.yaml` 某空间 `triggers`（或 Ring 1.5 活跃 `ActivityPlugin`），优先挂载该目录下最相关的 Top-3 活跃卡片；
2. **全局相关性召回**：在其余活跃卡片（排除 `resolved`/`archived`/`faded` 与常驻前缀文件）上，若已配置 `embedding` 则按余弦相似度取 Top-5，未配置或超时则平滑降级为 SQLite FTS5 2-gram 检索；非活动闲聊时补近 72h 未过期 `daily/` 最多 2 条；
3. **去重与裁剪**：跳过本会话近 2 小时内已召回的卡片（命中续接触发词豁免），按预算 `3200` 字符截断注入。

### Ring 1.5 数据驱动调优（攒够 ≥ 100 条真实 `recall_feedback` 后按需启用）
- 按真实标注数据再决定是否引入全库 IDF 覆盖率、单字 `LIKE` 兜底、`reranker` 二阶段精排、`access_count` 半衰期延寿与 `eval:recall --baseline` 回归守门。

### 真实召回评测闭环（`recall_traces` + `recall_feedback`）

1. **自动留痕**：每一轮对话的召回结果（`turn_id`、`query`、`activity_hint`、每张命中卡片的 `card_path`、`track`、`sem_score`、`kw_score`、`final_score`）自动写入 `recall_traces`。
2. **前端可开关标注**：客户端默认隐藏保持纯陪伴面；开启「评测模式」后，每条 AI 回复下方显示折叠条（如 `想起 3 张卡`），展开可直接标注 `useful`（准）/ `noisy`（噪声）/ `missed`（漏召回）。
3. **离线回归评测**：CLI 命令 `bun run eval:recall` 直接拿 `recall_feedback` 中的真实历史样本回放当前召回算法，输出 Precision@K / 噪声率 / 漏召率对比报告。

---

## 7. SQLite 核心表草案

```sql
-- 1. 只追加原始事件流（支持消息版本组 edit/reroll/delete、幂等键、具身表达、工具调用回放与外部导入来源）
CREATE TABLE events (
  id                TEXT PRIMARY KEY,          -- ULID
  seq               INTEGER UNIQUE NOT NULL,   -- 全局单调递增序号（事务内单调递增生成，不依赖 SQLite 非主键自增）
  session_id        TEXT NOT NULL,
  turn_id           TEXT,                      -- 所属对话/任务轮 ID（关联 recall_traces / API turns）
  client_message_id TEXT UNIQUE,               -- 客户端幂等键（防多端/弱网重发）
  group_id          TEXT,                      -- 同一轮编辑/重摇共享 group_id
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'active', -- active | candidate | discarded | deleted
  role              TEXT NOT NULL,             -- user | assistant | system | task
  kind              TEXT NOT NULL,             -- chat | door_note | wake | memory_task | activity_event | door.updated | privacy.peeked | relationship.departed
  source            TEXT NOT NULL DEFAULT 'live',   -- live | import
  fonds             TEXT NOT NULL DEFAULT '',  -- 导入前世全宗标识
  activity          TEXT,                      -- 当时所处活动 slug（可选）
  content           TEXT NOT NULL,
  thinking          TEXT,                      -- 扩展思考全量文本（独立列；跨轮拼历史时剥除）
  metadata          TEXT,                      -- JSON（attachments media hash、expressions、可回放 tool_calls/tool_results、aborted 等）
  created_at        INTEGER NOT NULL
);

-- 2. 卡片可重建元索引（由 memory/**/*.md 扫描派生，绝不包含 private/）
CREATE TABLE card_index (
  path           TEXT PRIMARY KEY,        -- 相对 memory/ 路径
  space          TEXT NOT NULL,           -- self | user | daily | shelf | gist | favorite | activity:<slug> | entity:<category>
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,           -- active | resolved | disputed | faded | archived
  tags           TEXT,                    -- JSON 字符串数组（供 C2.7 state 冲突对账扫描）
  when_to_recall TEXT,
  date_kind      TEXT DEFAULT 'ordinary',
  expires_at     INTEGER,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_accessed  INTEGER,
  content_hash   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,        -- 取自 frontmatter created（供 30d 衰减与 72h 近因兜底）
  updated_at     INTEGER NOT NULL
);

-- 2b. CJK 友好 FTS5 全文索引（由 memory/**/*.md 经 TS 2-gram 预处理派生，完整 DDL 见 Spec 02）
CREATE VIRTUAL TABLE card_fts USING fts5(
  path UNINDEXED,
  title_tokens,
  trigger_tokens,
  body_tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 3. 分模型向量缓存（切回旧模型零开销复用）
CREATE TABLE card_embeddings (
  path         TEXT NOT NULL,
  model_key    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,             -- Float32Array
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (path, model_key)
);

-- 4. 召回追踪与真实用户评测标注
CREATE TABLE recall_traces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  query         TEXT NOT NULL,
  activity_hint TEXT,
  card_path     TEXT NOT NULL,
  track         TEXT NOT NULL,            -- same_activity | cross_vector | daily_recent
  sem_score     REAL NOT NULL DEFAULT 0,
  kw_score      REAL NOT NULL DEFAULT 0,
  rerank_score  REAL,
  final_score   REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE recall_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       TEXT NOT NULL,
  card_path     TEXT,
  verdict       TEXT NOT NULL,            -- useful | noisy | missed
  note          TEXT,
  created_at    INTEGER NOT NULL
);

-- 5. 静默任务游标与已消化活动区间（完整 DDL 见 docs/spec/02-memory-execution.md）
CREATE TABLE task_cursors (
  task_key      TEXT PRIMARY KEY,         -- e.g. daily_wrapup | bedtime | activity:cinema
  last_event_id TEXT NOT NULL,
  meta_json     TEXT,
  updated_at    INTEGER NOT NULL
);
```
