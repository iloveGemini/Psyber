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

## 状态交接要求

[`STATE.md`](STATE.md) 是项目当前状态的唯一快速交接入口，记事实和决定，不记过程。代码、测试结果与它不一致时，以可复现的代码行为为准，收工时修正它。未更新 `STATE.md` 的开发任务不算完成。

**保持短**：全文 ≲ 100 行。做完的事压成一行或删掉——过程看 `git log`，设计看 `docs/`；冗长的讨论与实验数据另起 `docs/` 文件，`STATE.md` 里只留链接。
