# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-19（全仓文档交叉审阅阻塞项已全部修平，准备起草 `docs/spec/02-memory-execution.md`）。

## 1. 当前阶段：Phase P1 执行规程（`docs/spec/01` 已定稿 → 进入 `docs/spec/02`）

### 已定稿顶层文档与规程
- `docs/CAPABILITIES.md`（v1.2）：6 大能力支柱（含 C2.7 记忆对账与旧卡 diff 写后复核、互发表情、轻量生图/生视频、具身 UI/震动身体语言、浏览器、`bash`、分层工具治理与主体性边界三件套）、7 条 Non-Goals、Ring 0/1/2 分层与架构追溯表。
- `docs/ARCHITECTURE.md`（v0.4）：三层工具治理（固定 Core 9 工具含 `door` 与安全分级 + `tool_search`/`call_tool` 保 Prompt Cache 零破坏）、C2.7 复核轮路由与回滚、`credentials.json` (`0600`) 密钥分离、`express`、`door_state`（`cooling_off` 超时退回 `closed`）、上锁抽屉 `<dataDir>/private/*.sealed` 与 `DEPARTED.md`。
- `docs/MEMORY.md`（v0.4）：双层真相切分、活目录 `activities/` 与 `entities/`、永久 `favorite/`、`daily/` 短期状态 TTL/`resolved`/`disputed` 闭环、`private/` 零入库隔离、三类整理游标去重与分层触发、C2.7 启动+写时冲突对账与旧卡 diff 复核、补齐 `events`（`seq`/`turn_id`/`client_message_id`/`thinking`）与 `card_index`（`tags`/`created_at`）。
- `docs/API.md`（v0.3）：29 个核心端点（28 REST + 1 SSE，含 `POST /api/v1/media`、远程 OAuth、`abort`、`CONTEXT_OVERFLOW` 与 `sync.reset`）+ 3 个观影子路由。
- `prompts/`（`main` v4 / `tidy` v3 / `review` v3 / `revision` v3 / `genesis` v3 / `wake` v2）+ `memory_template/self.md`（`named: false`）：补齐 `wake` `[SILENT]` 沉默协议、`genesis` `named` 退出判定、旧卡 diff 复核口径与内联实体收录标准，全住户视角统一第一人称。
- `docs/spec/01-engine-tools-prompts.md`（v0.7）：引擎路由、三明治缓存与 `<prefix_delta>` 持续生效、换段结晶 vs 轻量闲置收尾分层、整理轮游标去重与 `MemoryTx` `private/` 隔离、C2.7 diff 复核出处校验、Tier 1 安全等级与模式协议已全部闭环。
- `docs/ROADMAP.md`（v0.4）：同步 P0 版本号并签收 `Spec 01`。

## 2. 下一步行动
1. 起草 `docs/spec/02-memory-execution.md`（原生 5 工具精确 Schema 与自救报错、`private/` 零入库内存解封、`REGISTRY.yaml` 写前校验、当轮即时写卡的 Git 提交与 `MemoryWriteMutex` 协同边界、C2.7 冲突对账与旧卡 diff 复核精确协议、双轨 + `reranker` 召回公式/降级策略、`daily/` 过期状态机、`media/` 临时帧清理与 `eval:recall` 口径）。
2. 依次推进 `docs/spec/03`–`05` 并做 P1 出口全仓交叉校验，之后启动 Ring 0 + Ring 1 代码落地。

## 3. 验证结果（2026-11-19）
- 全仓文档与 `prompts/` 交叉审计发现的 3 类阻塞项、跨文档字段不一致及 `LICENSE`/`README.md` 漂移已全部修平；当前尚未落代码，无测试套件需运行。
