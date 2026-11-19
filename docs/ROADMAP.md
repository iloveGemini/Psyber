# Psyber 规划与分期路线图（ROADMAP）

> **版本**：v0.8（2026-11-19，Spec 01~05 全部定稿）（2026-11-19，对齐 `CAPABILITIES.md` v1.2、`ARCHITECTURE.md` v0.5、`MEMORY.md` v0.5、`API.md` v0.4、`Spec 01` v0.9、`Spec 02` v0.5、`Spec 03` v0.2 与 `Spec 04` v0.1）
> **推进铁律**：**先规划至全局明朗自洽，再写分期落地文档，最后落代码**；每份文档之间零矛盾、零缺口。现有陪伴系统照常运行不断档。

---

## 当前阶段：Phase P · 架构与执行规程规划（不写业务代码）

### P0 · 顶层北极星与四大核心契约（✅ 已完成交叉审阅与对齐）
- [x] `docs/CAPABILITIES.md`（v1.2）— 6 大能力支柱（含 C2.7 记忆对账与写后复核）、7 条明确不做（Non-Goals）、Ring 0/1/2 牵连面分层与架构追溯表
- [x] `docs/ARCHITECTURE.md`（v0.5）— 单进程后端 + C/S 纯窗口、Direct Engine + `pi-ai`、三层工具治理（含 `door` 5 态 Schema 冻结与 Ring 1 guard 边界）、统一权限审批流、具身表达通道、`ActivityPlugin` 与 `MoodProvider` 槽位
- [x] `docs/MEMORY.md`（v0.5）— 双层真相切分、活目录 `activities/` 与 `entities/`、原生 5 工具、`private/` 零入库隔离、任务制写入 + C2.7 冲突对账与旧卡 diff 独立复核、双轨召回与真实评测闭环
- [x] `docs/API.md`（v0.4）— 面向 Flutter 的 29 个核心端点（28 REST + 1 SSE，含媒体上传、远端 OAuth、生成中止、`sync.reset`、`wake` 静默暂缓推流与上锁抽屉接口）

### P1 · 执行细节落地规程（`docs/spec/01`–`05`，待逐份定稿并交叉自检）
- [x] `docs/spec/01-engine-tools-prompts.md`（v0.9）— `pi-ai` OAuth/BYOK 凭证与 5 槽位模型路由/降级、Static Prefix 会话快照与三明治 Cache 精确断点、`CONTEXT_OVERFLOW` 系统级忙态换段、`<door_notes>` 注入与游标推进、主对话 vs 静默整理轮并发锁与 Git 提交隔离、三层工具注册/审批状态机（含 `door` Ring 1 guard）、`wake` `[SILENT]` 暂缓广播与第一人称 Prompt 协议
- [x] `docs/spec/02-memory-execution.md`（v0.5）— 原生 5 工具分区沙箱与自救报错、`private/` 零入库内存解封与游标、`REGISTRY.yaml` 写前校验与衰减驱动、当轮即时写卡与 `MemoryTx` 互斥防竞态、`door_note` 连续整理与进行中活动前沿门禁、增量索引与改进 CJK FTS5、C2.7 冲突对账与旧卡 diff 复核/回滚矩阵、双轨 + `reranker` 召回公式/降级/真实注入样例、`daily/` 过期与复发提醒、`media/` 临时帧清理与 `eval:recall` 口径
- [x] `docs/spec/03-boundaries-expression-activities.md`（v0.2）— 主体性边界三件套（门状态机 5 态、门缝纸条按 `seq ASC` 分批与游标解耦、关门隔门回复、上锁抽屉写先于读、三段式离开与 `DEPARTED.md` 声明）、`express` 单轮节流与双端贴纸同源校验、`NotificationProvider` 4 通道与反骚扰退避、Ring 1 `CircadianMoodProvider`、`ActivityPlugin`（含 `untilEventId` 精确区间）+ `activity_sessions`/`stickers` 迁移与观影扩展（`cinema`）抽帧控量/防误结束、外部 MCP 挂入 Tier 3 桥接
- [x] `docs/spec/04-api-and-flutter.md`（v0.1）— 全部 29 个核心端点 + 3 个观影子路由精确 JSON Schema、配对码与 Token 哈希鉴权、SSE 13 类事件与 `sync.reset` 环形缓冲、`Edit`/`Reroll`/`Version`/`Delete` 状态机与 `turn_id` 游标联动、Flutter 多地址竞速选路、`ExpressionRenderer`、忙态/门缝输入框与评测浮条契约
- [x] `docs/spec/05-testing-and-ops.md`（v0.1）— 虚拟时钟 `Clock` 注入、三时区回归矩阵、100% 离线测试 Mock 体系、12 个刚性契约测试套件、`VACUUM INTO` 自动备份与开源一键启动编排
- [ ] **P1 出口门禁**：全仓文档交叉一致性审阅（确认能力 ↔ 架构 ↔ 记忆 ↔ API ↔ 执行规程零矛盾、零未决接口）

---

## 后续实施阶段（P1 全部签收后才启动代码）

### Ring 0 + Ring 1 · 开源全栈可实测 MVP
1. **后端地基与核心闭环**：`server/`（Bun + Hono + `bun:sqlite` + `pi-ai` Direct Engine + 5 槽位模型路由与降级 + 三层工具与审批状态机 + 具身表达通道 + `NotificationProvider` 桌面/Webhook/Bark/ntfy 推送 + 门状态与上锁抽屉 + 活目录记忆底座 + 观影扩展 + 外部 MCP + 默认作息心跳）
2. **Flutter 全端客户端 MVP**（优先实测 macOS + iOS，全端兼容）：纯 C/S 多地址选路与扫码/配对码鉴权 + 多端实时同步聊天流（流式 thinking 折叠、编辑/重摇、发图/互发表情、基础震动/氛围表达、门状态与门缝留言、上锁抽屉拆封、审批确认卡）+ 可开关召回评测浮条 + 观影伴看卡 + Genesis 初生向导
3. **出口验收**：自动化回归用例全绿（含“崴脚 10 天过期 / 康复 `resolved`”、“睡前故事连载不吃书”、“看片跨活动联想到故事”、“关门仅收门缝纸条”、“抽屉拆封记 `privacy.peeked` 告知 AI”、“工具审批挂起与恢复”），且真机日常实测稳定运行 ≥ 1 周并攒出第一批真实 `recall_feedback` 评测集

### Ring 2 · 独立扩展能力逐个装入（插槽已定，互不牵连）
- **本机与网页能力**：`bash`（带废纸篓/路径守卫与审批卡）、`browser`（自主逛网页/截图）挂入 Tier 3 工具池
- **轻量趣味创作与异步语音**：闹着玩的生图 / 生视频工具（产物进 `media/`，聊天富卡片渲染）+ 异步语音条（STT/TTS，不做实时通话）
- **灵魂深化、离别边界与离线生活**：通过 `MoodProvider` 接入 11 维心境驱力引擎 + 离线独居生活循环 + 原生 APNs/FCM 推送 + 三段式关系离开（解除 Ring 1 `door` guard 限制，开放 `cooling_off` 冷静期时间锁 → `departed` 永久只读归档与 `DEPARTED.md` 诚实声明）
- **丰富活动与感知插件**：音乐同步（`music`）、RP 舞台（`rp`）、异步信箱、时空/天气/忌日守卫、显式授权设备感知
- **记忆星图与历史迁入**：Flutter 记忆星图可视化视图 + 历史陪伴系统数据一键迁移脚本 + 用真实评测集调优双轨与 `reranker` 召回参数
