# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-19（完成 Spec 03 前全仓一致性修订：`Spec 01` v0.9、`Spec 02` v0.5、`API` v0.4、`ARCHITECTURE` v0.5、`MEMORY` v0.5、`ROADMAP` v0.5）。

## 1. 当前阶段：Phase P1 执行规程（`Spec 01`、`Spec 02` 已定稿 → 进入 `Spec 03`）

### 已定稿顶层文档与规程
- `docs/CAPABILITIES.md`（v1.2）、`docs/ARCHITECTURE.md`（v0.5）、`docs/MEMORY.md`（v0.5）、`docs/API.md`（v0.4）、`docs/ROADMAP.md`（v0.5）：P0 顶层契约已交叉闭环。
- `prompts/`（`main` v4 / `tidy` v3 / `review` v3 / `revision` v3 / `genesis` v3 / `wake` v2）+ `memory_template/self.md`（`named: false`）：第一人称提示词体系与模式协议已定稿（`review.md` 补齐无原文对照时省略 `transcriptQuote` 约束）。
- `docs/spec/01-engine-tools-prompts.md`（v0.9）：引擎路由、三明治缓存、25m+40k/80% 换段与 `CONTEXT_OVERFLOW` 无死锁忙态先收记忆再换段、`<door_notes>` 注入与 `door_notes_read` 推进时机、整理轮原子协议、三层工具与 `door` Ring 1 guard、`wake` `[SILENT]` 暂缓广播与模式协议已定稿。
- `docs/spec/02-memory-execution.md`（v0.5）：原生 5 工具分区沙箱与 `.tmp/` 原子写、`private/` `.sealed` 迁移密钥与 `events_notice` 游标、Frontmatter 宽容（含旧卡 `updated_at` 取 `max`）/DST 日历日与两份 `REGISTRY.yaml` 校验、完整 DDL + 改进 CJK FTS5（含单字 `LIKE` 过滤废卡）、当轮写卡与 `MemoryTx` 互斥防竞态、`daily_wrapup` 连续收录 `door_note`（不推进 `door_notes_read`）与进行中活动前沿门禁、C2.7 归一化过滤、双轨（含 `REGISTRY.decay`）+ `reranker` 公式、2h 去重 `EXISTS` 与 `eval:recall` 零命中回放口径已闭环。

## 2. 下一步行动
1. 推进 `docs/spec/03-boundaries-expression-activities.md`（边界三件套、`express` 与贴纸、离线通知、`ActivityPlugin` 与观影 `cinema` 含 `activity_sessions` 结束时间戳供 `media/` 清理、外部 MCP 挂入 Tier 3）。
2. 依次完成 `docs/spec/04`–`05` 并执行 P1 出口全仓交叉校验，之后启动 Ring 0 + Ring 1 代码落地。

## 3. 验证结果（2026-11-19）
- 已在分支 `docs/p0-p1-specs` 提交 `ead3d6e`；本轮完成 Spec 03 前全仓逻辑/并发修复与版本对齐（`Spec 01` v0.9、`Spec 02` v0.5、`API` v0.4、`ARCHITECTURE` v0.5、`MEMORY` v0.5、`ROADMAP` v0.5），待提交；当前未落代码，无测试套件需运行。
