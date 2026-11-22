# Psyber 规划与分期路线图（ROADMAP）

> **版本**：v1.2（2026-11-21，同步全套契约升级至 v1.4/v0.8/Spec v1.2+，将前身项目实战沉淀的 12 项高价值能力与体验优化精准归位至 Ring 1.5 与 Ring 2 路线图）
> **推进铁律**：**先规划至全局明朗自洽，再写分期落地文档，最后落代码**；每份文档之间零矛盾、零缺口。现有陪伴系统照常运行不断档。

---

## 当前阶段：Ring 0 + Ring 1 闭环已落地并完成真机联调 → 契约已升级对齐 Ring 1.5 / Ring 2

### P0 · 顶层北极星与四大核心契约（✅ 已完成交叉审阅与 v1.4/v0.8 同步）
- [x] `docs/CAPABILITIES.md`（v1.4）— 6 大能力支柱（含修对话 vs 社交撤回、主动分享卡、三层轻重感知与透明账本、附件摘要与消耗统计、观影四宫格与 RP 同窗舞台）、7 条明确不做（Non-Goals）、Ring 0/1/1.5/2 牵连面分层与架构追溯表
- [x] `docs/ARCHITECTURE.md`（v0.8）— 单进程后端 + C/S 纯窗口、Direct Engine + `pi-ai`（`digest` 槽位/主备降级链/思考档位/双上下文上限）、三层工具治理（Tier 1 9 工具冻结、`bash` 废纸篓可逆守卫、Tier 3 `share`/`retract_message`/`look_at_screen`/`ask_user`）、对称透明边界与扩展槽位蓝图
- [x] `docs/MEMORY.md`（v0.8）— 双层真相切分、活目录 `activities/` 与 `entities/`、纯 `memory/` 原生 5 工具、静默修对话 vs 双向社交撤回（`retracted`）记忆隔离、手动存记忆换段、`usage` 落盘与真实评测闭环
- [x] `docs/API.md`（v0.8）— 全量 43 个核心端点（42 REST + 1 SSE）+ 3 观影子路由的分期契约（Ring 1 严格维持 15 REST + 1 SSE = 16 核心端点、8 类 SSE 事件 + `ping` 不变；Ring 1.5/2 补齐社交撤回、原地重试、手动换段、分享拆阅、双人状态签、双人头像、模型发现/消耗统计、透明感知账本与异步申请卡）

### P1 · 执行细节落地规程（`docs/spec/01`–`05`，✅ 已同步至最新契约版本）
- [x] `docs/spec/01-engine-tools-prompts.md`（v1.2）— `pi-ai` BYOK/OAuth、`digest` 附件摘要槽位/主备降级链/思考深度档位/双上下文上限、`usage` 统计与原地重试、Static Prefix 会话快照与三明治 Cache 断点、75% 自动与手动换段、单队列并发锁、纯 `memory/` Tier 1 9 工具冻结与第一人称 Prompt 协议
- [x] `docs/spec/02-memory-execution.md`（v0.8）— 纯 `memory/` 原生 5 工具沙箱与 `edit` 两阶段匹配、`REGISTRY.yaml` 写前校验、SQLite 核心 DDL（含 `retracted` 状态、`share.opened`/`perception.screen`/`request.decided` 事件与 `metadata.usage`）、当轮即时写卡与 `MemoryTx` 互斥、双轨召回与非阻塞 C2.7 复核蓝图
- [x] `docs/spec/03-boundaries-expression-activities.md`（v0.5）— 主体性边界三件套（含 `closed` 态一次性紧急通道、用户双人状态签与勿扰抑制）、`ShareCard` 折叠分享与拆阅回执、观影 `cinema`（2×2 四宫格分镜 + 角色定妆小抄 + 侧边网页伴看）、外部 MCP（含预设）、`bash` 废纸篓可逆守卫、三层轻重伴生感知与透明账本、RP 同窗舞台蓝图
- [x] `docs/spec/04-api-and-flutter.md`（v0.5）— 全量 42+3 路由精确 JSON Schema、静默修对话（`Edit`/`Reroll`/`Version`/`Delete` 二步防误触）vs 双向社交撤回（`Retract`）状态机、沉默与故障视觉隔离（`SilenceLine`/`FailureLine` 原地重试）、整轮工具手账聚合卡、草稿/粘图/短视频抽帧、双人头像与 5 套暖调手账色板、设置页消耗统计与透明感知账本 UI 规程
- [x] `docs/spec/05-testing-and-ops.md`（v0.4）— 虚拟时钟 `Clock` 注入、100% 离线 Mock 体系、Ring 1 必过 5 套核心主链路与全量 15 套蓝图、`VACUUM INTO` 原子热备（Ring 1 保留 7 份，Ring 1.5 启 GFS 与三时区 DST 矩阵）、CLI/环境变量映射与启动自愈
- [x] **P1 出口门禁**：全仓文档交叉一致性审阅（能力 ↔ 架构 ↔ 记忆 ↔ API ↔ 执行规程零矛盾、零未决接口）

---

## 后续实施阶段（Ring 0 + Ring 1 ✅ 已完成，推进 Ring 1.5 → Ring 2）

### Ring 0 + Ring 1 · 极简开源全栈可实测 MVP（✅ 已跑通本机 macOS 真机闭环，详见 `STATE.md`）
1. **后端地基与核心闭环**：`server/`（Bun + Hono + `bun:sqlite` + `pi-ai` Direct Engine，`chat` 共用整理 + 可选 `embedding`；三明治上下文 + 75% 异步换段；单轮写作 + Git 留痕；纯 `memory/` 原生 5 记忆工具沙箱 + 极简 3 步召回 + `daily/` 10 天 `faded`/`resolved` + `gist/days` & `weeks`；Tier 1 + `tool_search`/`call_tool` 框架与 `auto`/`guarded`；`door` 3 态与 `door_note` 不唤醒；`express` 具身表达；扁平作息心跳 + `wake` `[SILENT]` + `desktop`/`webhook` 离线推送；15 个 REST + 1 个 SSE = 16 个核心端点、8 类 SSE 事件 + `ping`；每日 `VACUUM INTO` 保留最近 7 份）
2. **Flutter 薄客户端 MVP**（优先实测 macOS + iOS）：单地址配置与配对码鉴权 + 聊天流（流式 `thinking` 折叠、发图、贴纸暂存输入台、软删、中止生成、基础 `ExpressionRenderer`、门状态与门缝纸条输入框）+ 可开关极简召回标注浮条 + Genesis 初生向导 + 切后台静默重连不弹红条
3. **出口验收**：核心主链路离线自动化测试全绿且真机日常实测稳定运行，持续攒出真实 `recall_feedback` 评测集

### Ring 1.5 · 实测驱动的体验深化与独立功能包（攒够首批真实数据后按需启用）
- **召回与整理按数据增强**：基于真实 `recall_feedback` 评估后按需引入 IDF/单字 `LIKE` 兜底、`reranker` 二阶段精排、`access_count` 延寿公式、`eval:recall --baseline`、可选评测透明告知与非阻塞 C2.7 独立复核轮；补齐 `gist/months` 与 `gist/years`；支持用户手动触发「存记忆换段」
- **边界、分享与双人状态**：
  - 上锁抽屉独立工具（`drawer_read`/`drawer_write` + `/api/v1/drawer`）与 `privacy.peeked` 拆封留痕；
  - 主动折叠分享卡（`share` 工具 + `ShareCard` + `POST /shares/:id/open` 拆阅回执）；
  - 关门态一次性紧急通道（`urgent: true`）与侧栏顶部「双人状态签（用户心绪 + 勿扰开关）」
- **对话手感与视觉语域升级**：
  - 拆清静默修对话（`Edit`/`Reroll`/`Version` 四态版本组 + 3 秒二步防误触删除）与双向社交撤回（`Retract` + `retract_message`）；
  - 严格隔离Psyber主动沉默（`SilenceLine`）与系统故障中断（`FailureLine` 原地无痕重试），整轮思考与多步工具聚合成单张去技术味手账折卡，切换模型插入 `ModelSwitchDivider`；
  - 输入台草稿本地持久、桌面 `⌘V` 粘图/拖拽、随手短视频前端抽帧提音轨（`VideoTile`）
- **模型省钱护栏、用量统计与居所氛围**：
  - `digest` 附件摘要模型（当轮看原图、历史转文字）、主/备模型降级链、思考深度离散档位（`off`/`low`/`medium`/`high`）、聊天/独处双上下文上限、远端 OAuth 与供应商模型自动发现/连通测试；
  - 设置页独立「消耗统计」Tab（今日/累计/按日/按模型费用与 Prompt Cache 命中率）；
  - 双人头像上传（`media/`）与 5 套克制暖调手账色板
- **首个活动、外部工具与同步运维**：
  - 抽离 `ActivityPlugin` 接口并接入观影伴看（`cinema` 支持 2×2 四宫格分镜、角色定妆小抄、侧边网页伴看栏、15s 控量与 24h 淘汰）；
  - 外部 MCP 桥接（Tier 3，内置常用生态预设）；
  - Flutter 多地址并发竞速与 `instanceId` 校验、SSE 500 条环形缓冲与 `streamSeq`/`sync.reset`、Bark/ntfy 独立通道与设备吊销、GFS 三级备份与 `export`/`restore` CLI

### Ring 2 · 独立扩展能力逐个装入（插槽已定，互不牵连）
- **本机与网页能力**：`bash`（遵循「拦 `rm` 不拦删除」废纸篓可逆免审 + 严禁命令行绕路截屏 + 越界异步申请卡）、`browser`（自主逛网页/截图）挂入 Tier 3 工具池
- **三层轻重伴生感知与透明账本**：余光被动粗粒度感知（地理围栏/粗略睡眠/锁屏空闲/音乐两态）+ 显式工具 `look_at_screen`（默认关、原图即删、独立留账卡片）+ 异步申请卡 `ask_user`（详细睡眠分期/心率与未授权目录，支持同意/今天都允许/不了）+ 设置页「透明感知账本（Psyber只写、用户分项一键擦除）」
- **轻量趣味创作、异步语音与桌面浮窗**：闹着玩的生图 / 生视频工具（产物进 `media/`，聊天富卡片渲染）+ 异步语音条（STT/TTS，不做实时通话）+ 桌面可选轻量置顶浮窗模式（Float）
- **灵魂深化、离别边界与离线生活**：通过 `MoodProvider` 接入 11 维心境驱力引擎 + 离线独居生活循环 + 原生 APNs/FCM 推送 + 三段式关系离开（解除 Ring 1 `door` guard 限制，开放 `cooling_off` 冷静期时间锁 → `departed` 永久只读归档与 `DEPARTED.md` 诚实声明）
- **丰富活动插件**：音乐同步（`music`，两态边沿 + 可拖拽迷你唱片/氛围白噪音胶囊）、RP 同窗舞台（`rp`，平滑覆盖主聊天区 + `(( ))` 双括号戏外吐槽 + 轻量门控叙述者让开直接对戏 + 物理隔离幕后防剧透）、异步信箱、时空/天气/忌日守卫
- **记忆星图与历史迁入**：Flutter 记忆星图可视化视图 + 历史陪伴系统数据一键迁移脚本 + 用真实评测集调优双轨与 `reranker` 召回参数
