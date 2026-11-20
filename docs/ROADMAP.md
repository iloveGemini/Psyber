# Psyber 规划与分期路线图（ROADMAP）

> **版本**：v1.1（2026-11-20，同步 P0/P1 清单版本号与摘要至最新契约版本，精确对齐 Ring 1 15 REST + 1 SSE 与 8 类 SSE 事件口径）
> **推进铁律**：**先规划至全局明朗自洽，再写分期落地文档，最后落代码**；每份文档之间零矛盾、零缺口。现有陪伴系统照常运行不断档。

---

## 当前阶段：Phase P · 架构与执行规程规划（不写业务代码）

### P0 · 顶层北极星与四大核心契约（✅ 已完成交叉审阅与对齐）
- [x] `docs/CAPABILITIES.md`（v1.3）— 6 大能力支柱（含 C2.7 非阻塞复核口径）、7 条明确不做（Non-Goals）、Ring 0/1/1.5/2 牵连面分层与架构追溯表
- [x] `docs/ARCHITECTURE.md`（v0.7）— 单进程后端 + C/S 纯窗口、Direct Engine + `pi-ai`、三层工具治理（含 `door` 5 态 Schema 冻结与 Ring 1 guard 边界）、具身表达通道、Ring 1.5 `private/` 独立工具与扩展槽位蓝图
- [x] `docs/MEMORY.md`（v0.7）— 双层真相切分、活目录 `activities/` 与 `entities/`、纯 `memory/` 原生 5 工具、Ring 1 单队列写作与极简 3 步召回、Ring 1.5 非阻塞 C2.7 复核与真实评测闭环
- [x] `docs/API.md`（v0.7）— 全量 29 个核心端点 + 3 观影子路由的分期契约（Ring 1 收敛为 15 个 REST + 1 个 SSE = 16 个核心端点、8 类 SSE 事件 + `ping`）

### P1 · 执行细节落地规程（`docs/spec/01`–`05`，✅ 已全部定稿并完成交叉审阅）
- [x] `docs/spec/01-engine-tools-prompts.md`（v1.1）— `pi-ai` BYOK/OAuth 凭证与分期槽位路由、Static Prefix 会话快照与三明治 Cache 断点、75% 异步换段（零前台忙态）、`<door_notes>` 注入与游标推进、单队列并发锁与 Git 提交隔离、纯 `memory/` Tier 1 工具定义、`wake` `[SILENT]` 暂缓广播与第一人称 Prompt 协议
- [x] `docs/spec/02-memory-execution.md`（v0.7）— 纯 `memory/` 原生 5 工具沙箱与 `edit` 两阶段匹配、`REGISTRY.yaml` 写前校验、SQLite 核心 DDL（含 `card_fts` 与 `events.seq` 事务生成）、当轮即时写卡与 `MemoryTx` 互斥、Ring 1 极简 3 步召回与 `daily/` 10 天 `faded`/`resolved`、Ring 1.5 `private/` 独立工具与非阻塞 C2.7 复核蓝图
- [x] `docs/spec/03-boundaries-expression-activities.md`（v0.4）— 主体性边界三件套（Ring 1 `door` 3 态与 `door_note` 两游标解耦，Ring 1.5 抽屉与 Ring 2 离开权）、`express` 单轮节流与静态/表贴纸衔接、Ring 1 `desktop`/`webhook` 通知与扁平 `circadian.ts`、Ring 1.5 `ActivityPlugin`（`cinema`）与外部 MCP 蓝图
- [x] `docs/spec/04-api-and-flutter.md`（v0.4）— 全量 29+3 路由精确 JSON Schema（含 `genesis` 一步传入 BYOK `apiKey`）、无 `systemBusy` 的极简聊天/断线拉取流、配对码/Token 哈希鉴权、Ring 1.5 版本组与多地址竞速蓝图、Flutter 薄客户端架构与 `ExpressionRenderer`
- [x] `docs/spec/05-testing-and-ops.md`（v0.4）— 虚拟时钟 `Clock` 注入、100% 离线 Mock 体系、Ring 1 必过 5 套核心主链路与全量 15 套蓝图、`VACUUM INTO` 原子热备（Ring 1 保留 7 份，Ring 1.5 启 GFS 与三时区 DST 矩阵）、CLI/环境变量映射与启动自愈
- [x] **P1 出口门禁**：全仓文档交叉一致性审阅（能力 ↔ 架构 ↔ 记忆 ↔ API ↔ 执行规程零矛盾、零未决接口）

---

## 后续实施阶段（P1 全部签收后启动代码）

### Ring 0 + Ring 1 · 极简开源全栈可实测 MVP（2–3 周跑通闭环）
1. **后端地基与核心闭环**：`server/`（Bun + Hono + `bun:sqlite` + `pi-ai` Direct Engine，`chat` 共用整理 + 可选 `embedding`；三明治上下文 + 75% 异步换段；单轮写作 + Git 留痕；纯 `memory/` 原生 5 记忆工具沙箱 + 极简 3 步召回 + `daily/` 10 天 `faded`/`resolved` + `gist/days` & `weeks`；Tier 1 + `tool_search`/`call_tool` 框架与 `auto`/`guarded`；`door` 3 态与 `door_note` 不唤醒；`express` 具身表达；扁平作息心跳 + `wake` `[SILENT]` + `desktop`/`webhook` 离线推送；15 个 REST + 1 个 SSE = 16 个核心端点、8 类 SSE 事件 + `ping`；每日 `VACUUM INTO` 保留最近 7 份）
2. **Flutter 薄客户端 MVP**（优先实测 macOS + iOS）：单地址配置与配对码鉴权 + 聊天流（流式 `thinking` 折叠、发图、软删、中止生成、基础 `ExpressionRenderer`、门状态与门缝纸条输入框）+ 可开关极简召回标注浮条 + Genesis 初生向导 + 切后台静默重连不弹红条
3. **出口验收**：5 套核心主链路离线自动化测试全绿（沙箱路径与 `edit` 原子写、主对话+异步换段整理+Git 留痕、极简召回+`state` 10 天 `faded`/`resolved`、关门 `door_note`+`wake` `[SILENT]`、幂等发消息+SSE 推流中止），且真机日常实测稳定运行 ≥ 1 周并攒出第一批真实 `recall_feedback` 评测集

### Ring 1.5 · 实测驱动的体验深化与独立功能包（攒够首批真实数据后按需启用）
- **召回与整理按数据增强**：基于真实 `recall_feedback` 评估后按需引入 IDF/单字 `LIKE` 兜底、`reranker` 二阶段精排、`access_count` 延寿公式、`eval:recall --baseline` 与非阻塞/可选 C2.7 独立复核轮；补齐 `gist/months` 与 `gist/years`
- **上锁抽屉（物理独立工具）**：通过独立 `drawer_read`/`drawer_write` 工具与 `/api/v1/drawer` 落地 `<dataDir>/private/*.sealed` 与 `privacy.peeked` 拆封留痕，不再混入常规 5 工具双分区沙箱
- **首个活动与外部工具**：抽离 `ActivityPlugin` 接口并接入观影伴看（`cinema` 抽帧控量/防误结束/24h 淘汰）；接入外部 MCP 桥接（Tier 3）
- **交互与同步增强**：`Edit`/`Reroll`/`Version` 多版本组、远端 OAuth（PKCE/Device Code）、Flutter 多地址并发竞速与 `instanceId` 校验、SSE 500 条环形缓冲与 `streamSeq`/`sync.reset`、Bark/ntfy 独立通道与设备吊销、GFS 三级备份与 `export`/`restore` CLI

### Ring 2 · 独立扩展能力逐个装入（插槽已定，互不牵连）
- **本机与网页能力**：`bash`（带废纸篓/路径守卫与审批卡）、`browser`（自主逛网页/截图）挂入 Tier 3 工具池
- **轻量趣味创作与异步语音**：闹着玩的生图 / 生视频工具（产物进 `media/`，聊天富卡片渲染）+ 异步语音条（STT/TTS，不做实时通话）
- **灵魂深化、离别边界与离线生活**：通过 `MoodProvider` 接入 11 维心境驱力引擎 + 离线独居生活循环 + 原生 APNs/FCM 推送 + 三段式关系离开（解除 Ring 1 `door` guard 限制，开放 `cooling_off` 冷静期时间锁 → `departed` 永久只读归档与 `DEPARTED.md` 诚实声明）
- **丰富活动与感知插件**：音乐同步（`music`）、RP 舞台（`rp`）、异步信箱、时空/天气/忌日守卫、显式授权设备感知
- **记忆星图与历史迁入**：Flutter 记忆星图可视化视图 + 历史陪伴系统数据一键迁移脚本 + 用真实评测集调优双轨与 `reranker` 召回参数
