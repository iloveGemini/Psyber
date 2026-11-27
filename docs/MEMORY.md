# Psyber 记忆系统契约（MEMORY）

> **版本**：v0.9（2026-11-22，记忆目录重构：`core/` 常驻成果含 `boundaries.md` 与 `state.md`、`episodes/YYYY/MM/DD/` 分形情景树合并 `daily/` 与 `gist/` 并移除固定 `week`、`threads/` 替代 `activities/`、新增 `lessons/` 按场景触发经验、全库 Markdown 路径链接去重；明确用户自定义系统提示词注入槽归属配置层）
> **核心理念**：记忆不是通用客观知识库，而是**为人与 AI 的真实互动服务的活代码库**；`memory/` 中的一切皆由 AI 自己记录、双方相处演化而来。

## 1. 双层真相切分与配置层隔离

| 层级 | 载体 | 存储内容 | 修改方式 |
| :--- | :--- | :--- | :--- |
| **原始账本 + 派生索引** | SQLite (`psyber.sqlite`) | `events`（只追加对话、具身表达与系统事件）、`card_index`（卡片元信息缓存）、`card_embeddings`（分模型向量缓存）、`card_fts`（FTS5 全文）、`card_links`（`[[短标题]]` 与相对路径双向链接缓存）、`recall_traces`、`recall_feedback`、`task_cursors` | 系统程序确定性维护；除 `events` 与 `recall_feedback` 外，其余索引表随时可删可全量重建 |
| **记忆卡片唯一真相** | 磁盘 Markdown (`memory/`) | 常驻成果（`core/`）、情景时间树与反思（`episodes/`）、跨天内容线（`threads/`）、有条件经验（`lessons/`）、实体档案（`entities/`）、逐字原话收藏（`favorite/`）、高敏私密记忆隔离区（`sensitive/`） | **仅由主 AI 通过原生 5 文件工具直接读写**，每次整理任务结束及主对话当轮即时写卡自动 `git commit` 留痕 |
| **用户自定义系统提示词（规划）** | 配置文件 (`config.json`) | 用户显式设定的硬规则或系统偏好注入槽（独立于 `memory/`） | 由用户在设置中维护，不混入 AI 自主书写的 `memory/` 记忆库 |

- **零双写漂移**：系统绝不在 SQLite 维护另一份需要强双向同步的记忆正文；只要 `memory/` 下文件被 `write`/`edit`（或用户在磁盘外部修改），按文件 `mtime/hash` 增量刷新 `card_index`、`card_fts` 与 `card_embeddings`。
- **多模态与大产物分离**：观影抽帧、互发表情、轻量生图/生视频的二进制资产全部落盘在 `<dataDir>/media/`（SHA-256 寻址）并记在 `events.metadata` 中；Markdown 记忆卡片仅写第一人称文字感受与 `[照片](media/<hash>)` 引用。
- **源头凭证脱敏与记忆写盘防线（`core/redact.ts`）**：高置信度结构化凭证（厂商前缀 API Key / Token、PEM 私钥块、带账密 URL、JWT、Bearer/Basic 认证头、高熵密钥配置键值）在进入持久化存储前统一拦截处理——① 用户发送/编辑的消息当轮在内存中保留明文给主对话模型（便于即时排障），但写入 `events`、进入召回检索查询（`recall_traces` / 外部向量与决策接口）与附件摘要前立即脱敏；② AI 回复与思考落盘、附件摘要（`digest`）、导入/回放（`replay`）、静默整理喂稿及所有外部读取工具（`bash`、`fs_*`、`web_fetch`、外部 `mcp.*`、`memory_history`）返回结果一律立即替换为可读占位符 `[已隐藏:<类别>]`；③ `memory/` 的 `write`/`edit` 落盘前硬拦截疑似明文凭证并返回可读原因，由 Psyber 以第一人称改写为不含明文的事实描述后再保存（绝不静默篡改其正文）。

## 2. 目录结构、链接引用与 `REGISTRY.yaml`

### 2.1 七大职责单一目录

```text
memory/
├── core/                         # 核心档案区（前 7 项常驻前缀；dates.md 每日动态抽取未来 7 天）
│   ├── self.md                   # 我是谁（frontmatter 含 name / pronoun）
│   ├── user.md                   # 关于她/他（初始化写入 pronoun 与「关于她/他」标题；frontmatter 含 name / pronoun）
│   ├── boundaries.md             # 双方处出来的相处边界（双向、可随磨合调整；高敏雷区只写脱敏提示+短链）
│   ├── mirror.md                 # 极度克制的全局自我提醒（单条 ≤ 80 字 + 挂 rf- 链接）
│   ├── open.md                   # 还开着的承诺、挂念、以及没想完的反思问号（闭环即删）
│   ├── state.md                  # 近期短期状态（每条带 [至 YYYY-MM-DD]，恢复/过期即删）与长线指针
│   ├── glossary.md               # 双方专属暗语、外号、内部梗与小仪式（极薄常驻 ≤ 600 字，每条一行）
│   └── dates.md                  # 周期纪念日、生日、忌日与重大里程碑（不全文常驻；系统每日动态抽取今天+未来7天注入）
├── episodes/                     # 情景记忆时间分形树（合并原 daily/ 与 gist/，移除固定 week）
│   └── 2026/
│       ├── index.md              # 年梗概（≤ 1000 字）
│       └── 10/
│           ├── index.md          # 月梗概（≤ 600 字，按累计条数滚动更新、月末定稿）
│           └── 11/               # 日期两位补零（01..31）；无互动的日子不建目录
│               ├── index.md      # 日梗概（150–250 字，上限 300 字；绝不复述 sensitive/ 细节）
│               ├── ep-myths.md   # 情景片段（一事一卡、约 500–800 字，用链接串专卡）
│               └── rf-rhythm.md  # 当天反思（心路历程：看了哪些片段、为何这么想）
├── threads/                      # 跨天延续的内容线与手账（原 activities/，不常驻；lists/ 豁免双次成林）
│   ├── REGISTRY.yaml             # 内容线注册表（新建前必查重）
│   ├── lists/                    # 个人心愿单、口味忌口与一次性作品随手记（豁免双次成林）
│   └── bedtime-stories/
│       └── greek-myths.md
├── lessons/                      # 有使用条件限制的沉淀经验（按场景触发、不衰减、不常驻）
│   └── late-night-no-guess.md
├── entities/                     # 实体档案（人、地方、机构、反复讨论的项目等）
│   ├── REGISTRY.yaml             # 实体注册表（新建前必查重）
│   └── projects/
│       └── psyche.md
├── favorite/                     # 逐字原话收藏（一事一卡，注明说话人与为什么值得留）
│   └── 2026-10-13-memory-belongs-to-you.md
└── sensitive/                    # 双方共享的高敏私密记忆物理隔离区（亲密、创伤、健康病史、敏感隐痛；单层 .md，必填 when_to_recall）
    └── health-allergies.md
```

### 2.2 存一份、用链接串起来 & 过程与成果分离

- **统一链接格式**：跨文件引用统一使用相对 `memory/` 根目录的标准 Markdown 链接（如 `[希腊神话故事集](threads/bedtime-stories/greek-myths.md)`、`[原话](favorite/2026-10-13-memory-belongs-to-you.md)`、`[Psyche](entities/projects/psyche.md)`、`[照片](media/<hash>)`），AI 看到即可直接 `read(path)` 展开。
- **情景切片瘦身（`ep-*.md`）**：已收进 `threads/`、`favorite/`、`entities/` 的长内容在 `ep-` 中只留一句钩子与链接；无专卡的一次性生活片段与当下感受留在 `ep-` 写具体。
- **反思闭环（`rf-*.md`）**：`rf-` 专门承载心路历程（依据链接、思考过程、观念转变理由），其最终成果按作用范围分流到三处：
  1. **想明白了、全局适用** → 极简结论写入 `core/`（`self.md` / `user.md` / `boundaries.md` / `mirror.md`）并挂 `rf-` 链接；
  2. **想明白了、有使用场景限制** → 写入对应的 `threads/`、`entities/` 或 `lessons/`（必填 `when_to_recall`）并挂 `rf-` 链接；
  3. **还没想完 / 单次苗头待观察** → 挂一行简短问号到 `core/open.md`（附 `rf-` 链接），后续印证或证伪后再迁移/清理。
- **层级时间梗概（`index.md` + `covered_until`）**：移除固定周与硬编码天数窗口，改为按「有内容的日子」建 `DD/index.md`；所有激活态梗概共享 **8,000 字**总预算（80% 即 6,400 字软水位提醒），由 AI 在 `bedtime` 自主决定将较早的日梗概滚入 `MM/index.md`（frontmatter 必填 `covered_until: YYYY-MM-DD`）或将较早的月梗概滚入 `YYYY/index.md`（frontmatter 必填 `covered_until: YYYY-MM`）。`<continuity>` 严格按「`年` + `未滚进年的月` + `未滚进月的天`」拼接，天然零重叠、零断层。

### 2.3 `threads/REGISTRY.yaml` 与 `entities/REGISTRY.yaml` 契约

- **`threads/REGISTRY.yaml`**：召回引擎与整理任务数据驱动读取本文件，遵循「双次成林」「先查后建」「写前 YAML 校验」三条铁律；`card_style` 为一句话写作约定，作品/连载类默认 `decay: none`。
- **`entities/REGISTRY.yaml`**：类别自由生长（`people`/`places`/`orgs`/`projects`……），同时满足「有实质联系、有具体内容、不同日期/会话出现两次以上或被亲口嘱咐记住」才建档。

## 3. 卡片最小 Frontmatter 规范与生命周期

```yaml
---
title: 深夜聊天不瞎猜时间           # 简短标题（缺省取文件名）
kind: lesson                      # episode | reflection | lesson | work | serial | note
status: active                    # active | resolved | disputed | faded | archived
created: 2026-10-12
updated: 2026-10-13
when_to_recall: "半夜聊天、看到日期跳转或想关心对方困不困时"  # lessons/ 必填，其他可选
date_kind: ordinary               # ordinary | celebrate | gentle | deadline
tags: [深夜, 时间]                 # 可选
source: live                      # live | import
---
```

| 目录 / 类型 | 衰减策略 | 消费方式 |
| :--- | :--- | :--- |
| `core/*` | 永不腐烂 | `self`/`user`/`boundaries`/`mirror`/`open`/`state`/`glossary` 常驻系统前缀（`core/state.md` 注入时按 `[至 YYYY-MM-DD]` 自动过滤已过期条目）；`core/dates.md` 不全文常驻，每日动态筛选「今天 + 未来 7 天」注入 `<upcoming_dates>`（区分喜庆 `celebrate` / 敏感忌日 `gentle` / 里程碑 `milestone` / 一次性 `deadline`） |
| `episodes/YYYY/**/index.md` | 永不腐烂 | 专供 `<continuity>` 时间骨架，不进入日常 FTS5/向量检索池 |
| `episodes/YYYY/MM/DD/ep-*.md` | `slow`（默认 30d 半衰） | 参与全局检索与近 72h 闲聊补挂 |
| `episodes/YYYY/MM/DD/rf-*.md` | 慢衰减 / 可追溯 | 不参与自动召回，供长期复盘与追溯心路 |
| `threads/*` · `lessons/*` · `entities/*` · `favorite/*` | 永不腐烂 | 按 `threads/REGISTRY.yaml` 触发词、链接 `read` 或语义/FTS5 检索按需浮现（`threads/lists/` 豁免双次成林） |
| `sensitive/*` | 永不腐烂 | **高敏物理隔离区**：明文 Markdown 存于本机；**对外 `memory_mcp` 全工具默认硬屏蔽（大小写与多级 `./` 规范化防绕过）**；默认不发往外部 Embedding 接口与快脑体检雷达（`recall.sensitive.allowExternalEmbedding = false`），未配 Embedding 走全卡直扫时亦先经本地 FTS5 过滤绝不把未命中高敏卡标题外发给云端决策模型；仅走本地 FTS5 命中 + 高门槛精排（默认 `0.55`）按需浮现，严禁被近 72h 闲聊补挂与 1 跳双链自动带出；召回评测默认排除 |

## 4. 原生 5 文件工具沙箱（Tier 1 常驻核心）

`glob` / `grep` / `read` / `write` / `edit` 严格锁定在 `<dataDir>/memory/`：
- `core/self.md` 与 `core/user.md` 禁止 `write` 整篇覆写，必须 `edit` 局部修订；
- `episodes/` 写路径校验允许 `episodes/YYYY/index.md`、`episodes/YYYY/MM/index.md` 及 `episodes/YYYY/MM/DD/{index,ep-*,rf-*}.md`；
- `threads/REGISTRY.yaml` 与 `entities/REGISTRY.yaml` 写前严格校验 YAML Schema；
- 上锁抽屉（`private/`）继续由独立的 `drawer_read` / `drawer_write` 工具物理隔离。

## 5. 任务制第一人称写入、独立反思门控与极简 3 步召回

1. **高频整理（`daily_wrapup` / `bedtime`，聚焦事实与情景归档）**：
   - **换段结晶（`daily_wrapup`）**：按 10,000 字分批排空未整理对话，只整理事实与归档：`episodes/YYYY/MM/DD/ep-*.md`、`threads/`、`entities/`、`favorite/`、`core/state.md`；本轮不写 `index.md`，也不做深度反思。
   - **每日睡前整理（`bedtime`）**：先排空剩余未整理对话，再写当日 `episodes/YYYY/MM/DD/index.md`；系统在 `<tidy_context>` 报告当前时间梗概水位（8,000 字上限 / 80% 软提醒），由 AI 自主决定是否向上滚动至 `MM/index.md` 或 `YYYY/index.md` 并更新 `covered_until`；同时核对清理 `core/state.md` 过期或已恢复条目。
   - **前置只读体检雷达（`memory/radar.ts`，严守 NG-2 绝不代写）**：在 `bedtime` Step 2 之前与 `reflect_weekly` 启动之前，若 `radar.enabled` 且配置了 `llm.slots.decision`，系统以严格只读方式执行两路低成本扫描：① 把近期新卡摘要对照 `core/state.md` / `core/open.md` 活跃条目，并行判定 `board_obsolete` / `board_contradiction`；② 为新卡通过 `card_embeddings`（降级 FTS5）挑出相似历史旧卡，每对一次并行问 5 个结构化问题（`redundant`、`contradiction`、`obsolete`、`link`、`representation`，其中已有 `card_links` 双向连边自动跳过 `link`，并对历史 `ep-*.md` 屏蔽 `obsolete`/`merge` 护栏）。高置信度线索渲染为客观的 `<memory_radar>` 清单递给 Psyber 自主核实与处置（`bedtime` 含 `link` 补链提示，`reflect_weekly` 聚焦 `promote` / `contradiction` / `redundant` / `obsolete`）；高置信 `contradiction` / `promote` 线索同步作为参考上下文送入日/周反思门控综合判断。超时、异常或未配置时静默跳过，绝不阻塞整理或反思。
2. **独立深度反思（`reflect`，`bedtime` 后按 Git + Decision 门控按需触发）**：
   - **每日门控（`reflect_daily`）**：`bedtime` 完成后，对比 `memory/` 自上次日反思 commit 到 `HEAD` 的 Git 变更（忽略 `index.md`、`rf-*.md`、`core/state.md`）。无实质变更则 0 Token 跳过；有实质变更时交由决策槽位（`llm.slots.decision`，原生支持 Google `gemini-decision-1` 的 `POST /v1beta/decisions`，未配时自动降级至 `digest` / `memory_task` / `chat`）判断是否值得启动反思。
   - **周日门控（`reflect_weekly`）**：仅周日 `bedtime` 后额外对比自上周反思 commit 至今的 Git 变更（连同本周已写过的日反思 `rf-*.md` 摘要一起送入决策模型），若新增内容已被日反思充分吸收且无跨天新规律则直接跳过。
   - **自主探索与分流**：反思一旦启动，AI 自主通过 `glob`/`grep`/`read` 扩大查证范围，心路历程写入 `episodes/YYYY/MM/DD/rf-<slug>.md`，成果按作用范围分流至 `core/{self,user,boundaries,mirror,open}.md`、`lessons/*.md`、`threads/` 或 `entities/`。
3. **极简 3 步召回 + 向量/全卡路由、Decision 联合门控精排与 1 跳双链早停扩展**：
   - ① 过空档短路后，拼装「当前一句 + 最近 N 轮对话」作为查询窗口与 `<resident_context>` 常驻摘要；
   - ② 开启 `recall.gate.enabled` 且 `llm.slots.decision` 可用时：若配置了 `llm.slots.embedding`，优先走**纯向量 Top-15 粗筛（1200 字正文语义，关闭 FTS 混合）+ 单次 `DecisionClient.decide` 联合门控与正文摘要精排**；未配置 `embedding` 且活跃卡 ≤250 张时走全卡目录直扫，超限回落 FTS5 候选池精排；超时或异常平滑降级为规则 + FTS 门槛；
   - ③ **轻量 1 跳双链扩展 + 证据充分性早停**：若门控放行且 Top-5 尚有空位，从派生表 `card_links` 查锚点卡的双向 `[[短标题]]`/相对路径邻卡（无邻卡则 0 额外调用直接结束）；有邻卡时在严格预算内发起至多 1 次并行 `DecisionClient.decide` 判定 `evidence_sufficient`（足够接话则早停）与邻卡增量价值 `hop_neighbor_relevance`，按预算追加 `linked_hop` 轨道卡片；
   - ④ 2h 本会话去重（续接触发词豁免）并按 3200 字符预算截断。
