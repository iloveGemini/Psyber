# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-19（已提交 `f47ebec` 定稿 `Spec 03` v0.2，并完成 `docs/spec/04-api-and-flutter.md` v0.1 初稿）。

## 1. 当前阶段：Phase P1 执行规程（`Spec 01`–`04` 已起草 → 进入 `Spec 05`）

### 已定稿顶层文档与规程
- `docs/CAPABILITIES.md`（v1.2）、`docs/ARCHITECTURE.md`（v0.5）、`docs/MEMORY.md`（v0.5）、`docs/API.md`（v0.4）、`docs/ROADMAP.md`（v0.7）：P0 顶层契约已交叉闭环。
- `prompts/`（`main` v4 / `tidy` v3 / `review` v3 / `revision` v3 / `genesis` v3 / `wake` v3）+ `memory_template/self.md`（`named: false`）：第一人称提示词体系与模式协议已定稿。
- `docs/spec/01-engine-tools-prompts.md`（v0.9）：引擎路由、三明治缓存、25m+40k/80% 换段与 `CONTEXT_OVERFLOW` 无死锁忙态先收记忆再换段、`<door_notes>` 注入与 `door_notes_read` 推进时机、整理轮原子协议、三层工具与 `door` Ring 1 guard、`wake` `[SILENT]` 暂缓广播与模式协议已定稿。
- `docs/spec/02-memory-execution.md`（v0.5）：原生 5 工具分区沙箱与 `.tmp/` 原子写、`private/` `.sealed` 迁移密钥与 `events_notice` 游标、Frontmatter 宽容（含旧卡 `updated_at` 取 `max`）/DST 日历日与两份 `REGISTRY.yaml` 校验、完整 DDL + 改进 CJK FTS5（含单字 `LIKE` 过滤废卡）、当轮写卡与 `MemoryTx` 互斥防竞态、`daily_wrapup` 连续收录 `door_note`（不推进 `door_notes_read`）与进行中活动前沿门禁、C2.7 归一化过滤、双轨（含 `REGISTRY.decay`）+ `reranker` 公式、2h 去重 `EXISTS` 与 `eval:recall` 零命中回放口径已闭环。
- `docs/spec/03-boundaries-expression-activities.md`（v0.2）：主体性边界三件套（门状态机 5 态、`door_note` 按 `seq ASC` 分批消费与游标解耦、关门隔门回复、上锁抽屉写先于读、Ring 2 `DEPARTED.md` 归档）、`express` 单轮 3 次节流与双端贴纸复用 `media/`、`NotificationProvider` 4 通道与反骚扰退避、Ring 1 `CircadianMoodProvider`、`002_activities_stickers.sql` 迁移（`activity_sessions` / `stickers`）、`onActivityEnded` 精确区间与观影扩展（`cinema` 15s 抽帧控量、30m `stale`/4h 软结束防误结束、`cinema.bookmark` 钉帧）、外部 MCP 挂入 Tier 3 桥接与容错护栏已定稿。
- `docs/spec/04-api-and-flutter.md`（v0.1）：29 核心端点 + 3 观影子路由精确 JSON Schema、配对码与 Token 哈希鉴权、SSE 13 类事件与 500 条环形缓冲/`sync.reset`、`Edit`/`Reroll`/`Version`/`Delete` 状态机与 `turn_id`/游标联动、Flutter 多地址竞速选路（`instanceId` 校验）、`ExpressionRenderer`、忙态/门缝输入框与懒加载评测浮条契约已起草。

## 2. 下一步行动
1. 审阅 `Spec 04`（v0.1）并提交，随后起草最后一份执行规程 `docs/spec/05-testing-and-ops.md`（虚拟时钟、三时区回归、Git 提交边界、`VACUUM INTO` 自动备份与开源一键启动）。
2. 执行 P1 出口全仓交叉一致性校验，之后启动 Ring 0 + Ring 1 代码落地。

## 3. 验证结果（2026-11-19）
- 已在分支 `docs/p0-p1-specs` 提交 `f47ebec`（`Spec 03` v0.2 + `wake` v3 + `ActivityPlugin` 签名同步）；当前工作区新增 `Spec 04`（v0.1）并同步 `ROADMAP.md`（v0.7）与 `STATE.md`，待审阅后提交；当前未落代码，无测试套件需运行。
