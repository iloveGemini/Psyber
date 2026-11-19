# Psyber 开发规范

项目是什么、设计理念与适用人群：见 [`README.md`](README.md)；能力总纲、系统架构、记忆模型与接口契约：见 [`docs/`](docs/)（以 0 号北极星总纲 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) 为原点，详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/MEMORY.md`](docs/MEMORY.md)、[`docs/API.md`](docs/API.md) 与执行规程 [`docs/spec/`](docs/spec/)）。本文件只管怎么干活。

## 工作流程

1. **开发前先读** [`STATE.md`](STATE.md)，再按 [`README.md`](README.md)「文档阅读顺序」读到和这次改动有关的设计（[`docs/CAPABILITIES.md`](docs/CAPABILITIES.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/MEMORY.md`](docs/MEMORY.md) 或 `docs/spec/` 中的规程与契约），确认当前阶段与改动入口。加新功能先对照总纲 §1 能力支柱与 §2 明确不做（Non-Goals，如 NG-1 好感度数值、NG-2 独立后台记忆官、NG-4 上帝视角监控等），按 §3 牵连面分层判断归属（Ring 0 全局地基 / Ring 1 首批闭环 / Ring 2 独立扩展插槽），严格遵守服务端单向依赖，绝不外圈反向污染内圈。
2. **契约先行**：改接口/架构先改 `docs/` 与 `docs/spec/` 中的规程与契约，再改代码。**只要改动住户的提示词或上下文拼装（`prompts/*.md`、`docs/spec/01-engine-tools-prompts.md`、`server/src/engine/`），动笔前必须先读 [`prompts/README.md`](prompts/README.md)「编写铁律与提示词规范」与 Spec 01**。改提示词先改根目录 `prompts/`，再同步 spec 引用。
3. **最小方案与可验证**：用最小方案做出一个可观察的行为；改完跑相关检查（后端 `cd server && bun test`、`bun run typecheck`，客户端 `cd app && flutter test`、`flutter analyze`），非平凡逻辑至少留一个可运行的验证。
4. **开发后必须写回** [`STATE.md`](STATE.md)：阶段、完成、未完成、问题、下一步、验证结果、日期。
5. **提交规范**：一轮功能测过再提交一次；不碎提交，也不在工作区堆积未测试代码。

## 红线

- **开源合规与匿名化**：**开源仓库，任何要上传的文档/代码都不留真实人名**。代码、注释、文档、配置、示例、提交信息（commit message）严禁出现真实人名、私人账号、敏感路径或私人联系方式；统一使用项目角色占位符（如 `Psyber Contributor`、`user`、`self`）。
- **测试隔离**：试跑与自动化测试一律使用专用测试目录 `PSYBER_DATA_DIR=~/.psyber/test`，不算“出生”（Genesis）。正式库由部署者决定创建。
- **隐私与样本隔离**：部署者与用户的真实对话、`<dataDir>/private/*.sealed` 上锁抽屉私密日记、真实召回评测标注（`recall_feedback`）导出数据绝不进仓库；严禁读取任何真实用户的正式库当样本；测试一律使用合成测试夹具（synthetic fixtures）。
- **第一人称主权与零后台器官代笔**（对应 C2.1, C2.7, NG-2，提示词写法细则见 [`prompts/README.md`](prompts/README.md) 与 `docs/spec/01-engine-tools-prompts.md`）：
  - **文风一律不给，只给事实与授权**：用清单不写散文，让记忆和情境定调，提示词绝不定调或下达廉价演出动作脚本（NG-7）；
  - **事实可用「我」，判断禁用「我」**：行为规则、脊柱底线与身份使用通用中文第一人称，严禁写死任何特定名字、性别、职业或私人关系预设（个人身份由 `memory/self.md` 和 `memory/user.md` 自然读取）；系统算出的客观状态与检索结果只报事实与来源，绝不替住户用「我」预先宣布心理判断；
  - **零独立后台“记忆官”代写（NG-2）**：记忆卡片唯一真相在 `memory/` Markdown，全部由住户本人以第一人称在静默整理轮中通过原生 5 工具（`glob`/`grep`/`read`/`write`/`edit`）自主读写，无第三方后台编译器代笔；
  - **C2.7 复核只读不代笔**：写后独立复核轮只对照原文段与新写卡片找事实出处与缺漏，只报问题不改卡；改卡与驳回由住户在修订轮最终决定并留痕 Git Commit；
  - **不搞脆弱谓词 DSL 强机检（NG-2）**：卡片正文 100% 自由第一人称自然语言，YAML Frontmatter 保持极薄，不因格式微瑕回滚整晚整理；
  - **前台上下文与主陪伴面干净（NG-1, NG-4）**：严禁裸露内部情绪浮点数、好感度数值或数据库主键，系统动态注入必须带明确结构标记（Static Prefix / Dynamic Tail）；
  - 改提示词先改根目录 `prompts/` 并同步 spec 规程，考卷与真实召回评测判事实物证不判文风、不给范文。
- **成本与外部调用护栏**：消耗真实额度的模型评测与长流程调用手动执行，不进自动化测试；CI / 自动化测试必须使用 mock / fake 阻断外部 LLM 与网络调用。

## 复杂度分级

先按**影响范围**分级，不按代码行数分级：

- **小功能 / 小 bug**：单文件或单模块（如单个 Hono API 路由修正、某个工具守卫规则微调、前端单个组件样式/交互修正、单条提示词文案优化），不改接口契约和数据库表结构，半天内可完成。流程：读调用链 -> 改根因 -> 跑最小验证 -> 用人话说明结果。
- **中等改动**：涉及多个模块联动（如 SQLite 表结构变更与记忆索引重建联动、服务端新接口与 Flutter 客户端页面联动、活动插件 `ActivityPlugin` 与召回/整理轮联动）。流程：先对齐 [`docs/`](docs/) 与 `docs/spec/` 契约（写清楚目标与不做范围） -> 拆成可运行切片 -> 每片验证 -> 做一次端到端集成验证 -> 更新 [`STATE.md`](STATE.md)。
- **高复杂度**：存储/索引架构调整、Direct Engine 对话循环或并发锁（如 `MemoryTx`）改动、三层工具权限/审批状态机调整、跨端 SSE 断线续传协议升级。流程：先写方案与验收门槛 -> 做最小原型验证关键风险 -> 分阶段实现 -> 保留回退方式（如 SQLite 派生索引支持随时从 `events` 与 `memory/` 重建、Git 留痕可回滚） -> 完成端到端验收后再扩展。

不确定时按较小级别开始；若验证暴露出跨模块风险，再升级流程。

## 取舍规则

- **原生生态优先，不引入重型中间件**：后端优先用 Bun 原生能力、`bun:sqlite`、Hono、`@earendil-works/pi-ai`；客户端优先用 Flutter 原生生态。不为小需求引入 Redis、Kafka、外部消息队列或重型 ORM，单进程内存队列与定时心跳足够。
- **真相源各司其职，派生索引可随时重建**：
  - 原始对话与系统事件以 SQLite `events` 表为准；
  - 已整理记忆卡片的唯一真相在磁盘 `data/memory/` Markdown 仓库（Git 留痕），绝不搞双写冲突；
  - FTS5 全文、向量、过期时间等 SQLite 派生索引必须保证随时可删掉并从 `events` + `memory/` 完整重建。
- **服务端单向依赖与前后端分离**：严格遵守 `api -> engine -> tools -> memory -> store -> core`，绝不外圈反向污染内圈；客户端（`app/`）只管展示与交互，不复制服务端业务逻辑（如召回打分、权限校验）。
- **不做过度设计与过早抽象**：对照 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) §2（Non-Goals）和 Ring 0/1/2 分期，不提前做多租户鉴权中心、商业级分布式集群或未被需求证明的复杂插件框架。每个新增抽象必须能指出当前至少两个真实调用方。
- **输入边界与容错降级**：外部输入做模式校验，模型与网络调用必须带超时控制（`AbortSignal`）与安全降级（如 `embedding`/`reranker` 不可用时自动降级为 FTS5 + 关键词打分；静默整理轮失败时回滚未提交磁盘改动且不推进游标，防止死锁或丢数据）。
- **修顺手 bug 的边界**：看到同一改动范围内的明确 bug，直接修复并补验证；超出范围且文档未定方向的内容，先暂停并给出一条首选建议，不擅自扩写。

## 面向代码小白的说明

- **交流先讲人话和直观效果，再讲代码细节**：
  - 先用一两句大白话说明“改完之后用户或 AI 能感受到什么变化”，再说明涉及哪个模块；
  - 首次提到技术术语（如 `Prompt Cache`、`SSE`、`FTS5`、`Frontmatter`、`Mock`）时，顺手用括号或一句话白话解释它在这里干嘛用，不直接甩一串英文缩写；
  - 汇报问题或报错排查先给结论和实际影响（严不严重、会不会丢数据），文件名、行号、SQL 和原始日志只作补充，不直接整段甩出。
- **可调参数集中管理并写清影响**：
  - 关键参数统一维护在 `<dataDir>/config.json` 与对应配置类型定义中（如模型槽位路由、睡眠静默窗、心跳间隔、召回条数与衰减参数、工具安全策略等）；
  - 新增或修改参数时，写明**用途、单位、默认值**，以及**调大 / 调小会带来什么直观变化**（例如：间隔调小会更频繁整理但也更费额度）。
- **代码注释解释“为什么”**：解释设计考量、踩坑原因与“乱改会有什么后果”，不复述代码语法。

## 代码风格

保持简洁直白的模块化结构，目录职责清晰：

- **后端（`server/src/`，Bun + TypeScript 原生 ESM）**：
  - `core/`：时钟、配置、数据目录、SQLite 连接与迁移、媒体内容仓（`media/`）
  - `store/`：只追加事件表（`events`）、消息版本（edit / reroll / delete）
  - `memory/`：5 记忆工具、Markdown 扫描、SQLite 向量/FTS5/过期索引、双轨召回、评测反馈
  - `tools/`：三层工具注册中心（`Registry`）、`tool_search` / `call_tool`、统一权限守卫与审批状态机
  - `expression/`：具身表达工具（`express`）与贴纸包管理（`stickers`）
  - `llm/`：`@earendil-works/pi-ai` 协议封装、OAuth/BYOK 凭证管理、5 槽位模型路由、Embedding/Reranker 客户端
  - `engine/`：极薄 Direct Engine（三明治上下文、工具循环与审批挂起、主对话/静默整理轮调度）
  - `mood/`：可插拔 `MoodProvider` 接口与默认作息/心跳实现
  - `notifications/`：可插拔 `NotificationProvider` 接口与桌面/Webhook/Bark/ntfy 实现
  - `extensions/`：`ActivityPlugin` 接口、外部 MCP 桥接与内置活动（如 `cinema`）
  - `api/`：Hono HTTP + SSE 路由、Token 鉴权、静态媒体流
- **客户端（`app/lib/`，Flutter / Dart）**：按 `core/`（网络与选路）、`expression/`（具身渲染）、`features/`（业务页面）、`shared/`（通用组件与主题）分层，不放服务端核心逻辑。

发现无用代码优先删除，不留注释掉的僵尸代码。刻意接受的简化用注释写明当前上限和未来升级条件（如对应的 Ring 2 扩展点）。

## 状态交接要求

[`STATE.md`](STATE.md) 是项目当前状态的唯一快速交接入口，记事实和决定，不记过程。代码、测试结果与它不一致时，以可复现的代码行为为准，收工时修正它。未更新 `STATE.md` 的开发任务不算完成。

**保持短**：全文 ≲ 100 行。做完的事压成一行或删掉——过程看 `git log`，设计看 `docs/`；冗长的讨论与实验数据另起 `docs/` 文件，`STATE.md` 里只留链接。
