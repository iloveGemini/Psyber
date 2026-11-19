# Psyber 规划与分期路线图（ROADMAP）

> **版本**：v0.4（2026-11-19，对齐 `CAPABILITIES.md` v1.2、`ARCHITECTURE.md` v0.4、`MEMORY.md` v0.4 与 `Spec 01` v0.7）
> **推进铁律**：**先规划至全局明朗自洽，再写分期落地文档，最后落代码**；每份文档之间零矛盾、零缺口。现有陪伴系统照常运行不断档。

---

## 当前阶段：Phase P · 架构与执行规程规划（不写业务代码）

### P0 · 顶层北极星与四大核心契约（✅ 已完成交叉审阅与对齐）
- [x] `docs/CAPABILITIES.md`（v1.2）— 6 大能力支柱（含 C2.7 记忆对账与写后复核）、7 条明确不做（Non-Goals）、Ring 0/1/2 牵连面分层与架构追溯表
- [x] `docs/ARCHITECTURE.md`（v0.4）— 单进程后端 + C/S 纯窗口、Direct Engine + `pi-ai`、三层工具治理（含 `door` 归属与安全分级）、统一权限审批流、具身表达通道、`ActivityPlugin` 与 `MoodProvider` 槽位
- [x] `docs/MEMORY.md`（v0.4）— 双层真相切分、活目录 `activities/` 与 `entities/`、原生 5 工具、`private/` 零入库隔离、任务制写入 + C2.7 冲突对账与旧卡 diff 独立复核、双轨召回与真实评测闭环
- [x] `docs/API.md`（v0.3）— 面向 Flutter 的 29 个核心端点（28 REST + 1 SSE，含媒体上传、远端 OAuth、生成中止、`sync.reset` 与上锁抽屉接口）

### P1 · 执行细节落地规程（`docs/spec/01`–`05`，待逐份定稿并交叉自检）
- [x] `docs/spec/01-engine-tools-prompts.md`（v0.7）— `pi-ai` OAuth/BYOK 凭证与 5 槽位模型路由/降级、Static Prefix 会话快照与三明治 Cache 精确断点、主对话 vs 静默整理轮并发锁与 Git 提交隔离、三层工具注册/审批状态机、全套第一人称 Prompt 原文与模式协议
- [ ] `docs/spec/02-memory-execution.md` — 原生 5 工具精确 Schema 与自救报错、`private/` 零入库内存解封、`REGISTRY.yaml` 写前校验、增量索引触发机制、C2.7 冲突对账与写后独立复核/失败回滚协议、双轨 + `reranker` 召回公式/降级策略/真实注入样例、`daily/` 过期状态机、`media/` 临时帧清理与 `eval:recall` 口径
- [ ] `docs/spec/03-boundaries-expression-activities.md` — 主体性边界三件套（门状态与门缝留言、上锁抽屉火漆封条与 `privacy.peeked` 告知、三段式离开与 `DEPARTED.md` 声明）、`express` 原语与贴纸规范、`NotificationProvider` 离线推送策略、`ActivityPlugin` 生命周期与首个观影扩展（`cinema`）防误结束/抽帧控量细节、外部 MCP 挂入 Tier 3 细节
- [ ] `docs/spec/04-api-and-flutter.md` — 全部 REST/SSE 精确 JSON Schema、多端同步事件与 `clientMessageId` 幂等、设备扫码/配对码鉴权流、消息 Edit/Reroll/Delete 与记忆游标联动、Flutter 状态管理/多地址选路状态机/Expression Renderer/召回评测浮条交互
- [ ] `docs/spec/05-testing-and-ops.md` — 虚拟时钟 `Clock` 注入、三时区回归、Git 自动提交边界、`VACUUM INTO` 自动备份与开源一键启动约定
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
- **灵魂深化、离别边界与离线生活**：通过 `MoodProvider` 接入 11 维心境驱力引擎 + 离线独居生活循环 + 原生 APNs/FCM 推送 + 三段式关系离开（`cooling_off` → `departed` 永久只读归档与 `DEPARTED.md` 诚实声明）
- **丰富活动与感知插件**：音乐同步（`music`）、RP 舞台（`rp`）、异步信箱、时空/天气/忌日守卫、显式授权设备感知
- **记忆星图与历史迁入**：Flutter 记忆星图可视化视图 + 历史陪伴系统数据一键迁移脚本 + 用真实评测集调优双轨与 `reranker` 召回参数
