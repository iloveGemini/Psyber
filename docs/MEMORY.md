# Psyber 记忆系统契约（MEMORY）

> **版本**：v0.4（2026-11-19，对齐 [`CAPABILITIES.md`](CAPABILITIES.md) v1.2 与 `Spec 01` v0.7：补齐 `favorite/` 生命周期、三类整理游标去重与触发分层、C2.7 旧卡 diff 复核与对账时机，以及 `events`/`card_index` 字段补全）
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

今天她出门不小心把右脚踝崴了，说有点肿但还能走。我提醒她先冰敷别硬撑，晚上记得问问消肿没。
```

### 差异化生命周期（彻底解决“半个月还问脚疼不疼”）

| 目录 / 类型 | 默认 `decay` | 演化行为 |
| :--- | :--- | :--- |
| `activities/*` (`decay: none`) | 永不腐烂 | 电影、睡前故事、创作集等作品卡永久 `active`，按同活动强连续或跨活动向量随时唤醒 |
| `self.md`、`user.md`、`shelf/`、`favorite/`、`gist/`、`entities/` | 永不腐烂 | 身份、长期认知、收藏原话、实体档案与时间骨架；只由 AI 主动修订/归档 |
| `daily/` (`kind: state`) | `short`（默认 `ttl_days: 10`） | ① 对方说“好了”或亲口纠正时，整理任务直接改 `status: resolved` 立即退出常规池；② 与既有 active state 冲突且暂难判定时可标 `status: disputed` 并挂入 `shelf/threads.md`，待新信息再对；③ 即使没提，过期后系统在索引层自动标 `faded`，退出日常近期背景与常规高权召回（仅在用户显式追问时翻出） |
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

### 4.1 上锁抽屉虚拟区（`private/`）
- AI 可通过同样的 5 工具以 `private/<name>.md` 路径读写自己的私密日记，沙箱底层自动将其映射并封装为 `<dataDir>/private/<name>.sealed`（火漆封条防磁盘误瞄，对 AI 读写完全透明）。
- **严格物理与索引隔离**：`private/` 中的文件**绝不进入** `card_index` / `card_fts` / `card_embeddings` 派生索引（防止 SQLite 明文索引击穿火漆封条或混入向量召回），也**永不进入** `recall_traces` 评测浮条与常规公开导出；AI 对 `private/` 的 `glob`/`grep`/`read` 仅在内存中实时解封；仅当用户主动通过客户端「拉开抽屉」或 CLI 拆封时才会解码，并强制向 `events` 写入 `privacy.peeked` 事件告知 AI。

---

## 5. 任务制第一人称写入（零后台编译器）

所有记忆整理均由 Direct Engine 以**同一住户身份与主模型**起一个**独立静默整理轮**（不写入主聊天上下文，前端时间线呈现为可折叠的 `✦ 整理记忆` 活动条）：

| 任务类型 | 触发条件 | 递给 AI 的材料 | 预期写入目标 |
| :--- | :--- | :--- | :--- |
| **1. 活动收尾任务 (`activity:<slug>`)** | 某 `ActivityPlugin` 结束（如退出观影） | 该活动期间 `events.activity = <slug>` 的原始对话流 + 对应目录现有文件列表 + `activities/REGISTRY.yaml` 中该空间的 `card_style` | 更新或新建 `activities/<slug>/<topic>.md`（必要时附收入 `favorite/`） |
| **2. 换段 / 闲置收尾任务 (`daily_wrapup`)** | **重度换段结晶**：闲置 `> 25 分钟` 且本段新增 Token `> 40_000`，或上下文 `> 80%`（完成后换新 `session_id`）；**轻量闲置收尾**：闲置 `≥ 30 分钟` 且存在未整理对话（不关闭当前会话） | 游标后的未整理对话（跳过已由 `activity:<slug>` 整理完的活动段；按 `TASK_BUDGET = 10_000` 字分批、每批独立提交推进游标）+ `activities/REGISTRY.yaml` + `entities/REGISTRY.yaml` + 全部未关闭的 `daily/` 短期 `state` 清单 | 更新 `daily/`（切片 / state 改 `resolved` 或 `disputed`）、按需兜底 `shelf/`/`favorite/`/`entities/`、识别隐式活动归入或新开 `activities/` |
| **3. 每日睡前整理任务 (`bedtime`)** | 进入作息睡眠窗（同日单次） | 先排空游标后剩余未整理对话（对齐 `daily_wrapup` 游标），再递入当日已写/改卡片摘要 + 当日关键双向反馈链（`prev → acts → next`）+ 两份 `REGISTRY.yaml` | 滚动追加 `gist/`（天/周/月/年）、按需修订 `shelf/`（规矩/镜子/承诺）、`self.md`/`user.md` 与兜底 `favorite/`/`entities/` |

### 5.1 冲突对账（`daily/` state 卡 · 对应 C2.7）
- **启动扫描 + 写时即时提醒**：整理轮启动时，系统在内存中对既有全部未关闭的 `daily/` `active` `state` 卡（含主对话当轮顺手写/改的卡）做两两 `tags` 重叠扫描，标出「疑似同一件事的新旧状态」并与全部未关闭 `daily/` state 清单一并递给住户；写作阶段每当 `write`/`edit` 落盘 `daily/` `kind: state` 卡时，沙箱钩子同样即时比对并附带重叠提醒（均仅作临时提示，不入库、不裁决对错）。
- 住户以第一人称自行对账：确认已变化/康复则将旧卡改为 `status: resolved` 并写清原因；若确实存在矛盾且暂无定论，可将涉及卡片标为 `status: disputed` 并挂入 `shelf/threads.md` 等后续新信息再对；用户亲口纠正则直接按用户说法更新，不标冲突。

### 5.2 写后独立复核轮（只读不代笔 · 对应 C2.7）
- 每次整理任务（活动收尾 / 换段闲置 / 睡前）在住户写完卡后、提交 Git 前，自动执行**一轮独立复核**：仅提供本批原始对话段与本次 `memory/` 下变更内容（**新建卡传全文，修改旧卡仅传 diff 区分只读背景与新增/修改行；`private/` 绝不进入复核与 Git**，不带写作轮过程），复核角色**只读不改卡**，按三项清单（① 归属有出处、② 不串味、③ 关键承诺/偏好/决定不漏记）仅对新建内容或 diff 新增/修改片段报出问题；每条问题必须附带对应出处，无出处直接丢弃（格式与状态枚举走沙箱机械校验，不进复核）。
- 复核结果交回住户本人决定：逐条修改或说明理由驳回（只复核一轮，改完不再二次复核），并将「修改/驳回条数」写入本次 `git commit` 说明（如 `memory(<task>): <summary> [review: fixed=2, rejected=1]`）；若复核 0 问题跳过修订轮，使用写作轮输出的摘要（或触碰文件名兜底）；若修订轮已改好卡但末尾摘要 JSON 格式微瑕，降级记录兜底摘要不回滚整轮（NG-2）。
- **原子性与失败回滚**：每批任务正常结束后仅暂存本批触碰的 `memory/` 路径（不含 `private/`）执行 `git commit`，再推进 `task_cursors`；若写作轮、复核轮或修订轮因模型报错、超时、鉴权失效或复核输出不可解析而失败，**必须回滚本批未提交的磁盘改动（含 `private/` 备份）且严禁推进游标**，留待下次触发安全重试。
- 若用户在对话中 `edit`/`delete` 了尚未进入整理游标的近期消息，整理轮仅读取当前 `status='active'` 的事件；若目标消息已被历史整理轮消化，软删仅将其从后续对话上下文隐藏，不强行回滚历史 Git 提交。

---

## 6. 双轨召回与真实评测闭环

每轮用户输入先过 **空档短路检测**（仅精确匹配无信息纯应答如 `嗯/好的/哈哈/纯表情` 时跳过检索；若包含续接触发词如「接着讲」或处于活跃 `ActivityPlugin` 上下文中，不跳过活动上下文注入），非空档输入执行**双轨召回**（预算默认 `3200` 字符，渲染时刻采用 `vagueWhen` 模糊时间感）：

### 轨道 1 · 同活动强连续（Context-Routed Recall）
- **触发来源**：① 当前活跃 `ActivityPlugin` 提供的 `activityHint` + `topicHint`（最高优先）；② 本轮话语命中 `REGISTRY.yaml` 中某空间的 `triggers`（或与空间描述向量高度匹配）。
- **召回内容**：
  - 优先挂载 `topicHint` 精准命中的当前卡片（如正在追的剧/连载的睡前故事），保证绝不断档吃书；
  - 同目录下再按向量/近因补 1–2 张最相关的兄弟卡片（如“类似风格看过的片”）。

### 轨道 2 · 跨活动语义互文（Cross-Activity Vector Resonance）
- 在全部活跃卡片（含 `active` 与 `disputed`，排除轨道 1 已选与 `resolved`/`archived`；命中 `disputed` 卡时附轻量待确认标记）上执行 **向量相似度（正文 + `when_to_recall`）+ 实词 IDF 字面打分** RRF 融合，并支持接入可选 **`reranker` 模型槽位**对候选卡片做二阶段精排；
- **异常降级**：当 `embedding` 或 `reranker` 服务离线或未配置时，自动平滑降级为 SQLite FTS5 + `when_to_recall` + IDF 字面打分，绝不阻塞主对话；
- **跨目录高门槛**：仅当相似度超过高阈值（默认 `cos >= 0.65` 或强专名 IDF 命中）才浮现最多 **1–2 条**跨活动卡片，实现“看电影联想到上次睡前故事或日常对话”的自然互文，同时避免无关串场；
- **日常近因兜底**：非特定活动闲聊时，附带近 72 小时内未过期的 `daily/`（最多 2 条）与会话内 2 小时去重（用户点名“刚才说的/再讲一遍”豁免）。

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
  seq               INTEGER UNIQUE NOT NULL,   -- 全局单调递增序号（供 SSE Last-Event-ID 续传）
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
  strength       REAL NOT NULL DEFAULT 0.75,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_accessed  INTEGER,
  content_hash   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,        -- 取自 frontmatter created（供 30d 衰减与 72h 近因兜底）
  updated_at     INTEGER NOT NULL
);

-- 3. 分模型向量缓存（切回旧模型零开销复用）
CREATE TABLE card_embeddings (
  path         TEXT NOT NULL,
  model_key    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vec          BLOB NOT NULL,             -- Float32Array
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (path, model_key)
);

-- 4. 召回追踪与真实用户评测标注
CREATE TABLE recall_traces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       TEXT NOT NULL,
  query         TEXT NOT NULL,
  activity_hint TEXT,
  card_path     TEXT NOT NULL,
  track         TEXT NOT NULL,            -- same_activity | cross_vector | daily_recent
  sem_score     REAL NOT NULL DEFAULT 0,
  kw_score      REAL NOT NULL DEFAULT 0,
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

-- 5. 静默任务游标
CREATE TABLE task_cursors (
  task_key      TEXT PRIMARY KEY,         -- e.g. daily_wrapup | bedtime | activity:cinema
  last_event_id TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
```
