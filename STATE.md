# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-21（完成 Ring 1.5 模型省钱护栏 [不含 digest]、设置页消耗统计、双人头像与 5 套暖调手账色板；此前完成多版本修对话、上锁抽屉、双向撤回、分享卡与双人状态签）。

## 1. 当前阶段：Ring 1.5 主体体验、护栏与居所氛围板块已落地

### 已完成
- **契约升级（2026-11-21，契约先行）**：全仓顶层契约（`CAPABILITIES.md` v1.4、`ARCHITECTURE.md` v0.8、`MEMORY.md` v0.8、`API.md` v0.8、`ROADMAP.md` v1.2）与执行规程（`Spec 01`–`04`）完成交叉一致性同步。
- **Ring 1.5 模型省钱护栏、消耗统计与居所氛围（2026-11-21，不含 `digest`）**：
  - **主备降级链 + 思考档位 + 双上下文上限 + 模型发现/测连通**：扩展 `LlmConfig`（`slots.fallbacks`、`thinking.level: off/low/medium/high`、`contextLimits.chat/solo`），`DynamicChatModel` 在主模型输出前遇 429/5xx 自动切备模型并触发 `turn.model_switched`；新增 `GET /api/v1/llm/models` 与 `POST /api/v1/llm/test`。
  - **设置页独立消耗统计**：新增 `GET /api/v1/usage/stats`（按 `events.metadata.usage` 汇总今日/累计/按日/按模型费用与 Prompt Cache 命中率）；设置页新增按需拉取的消耗统计卡片（严禁常驻主聊天面）。
  - **双人头像与 5 套暖调手账色板**：新增 `POST /api/v1/avatars/:who`（`user`/`resident`，≤ 5 MB 落盘 `media/` 且 `pinned = 1`，回显于 `/settings` 与左侧栏 `DualStatusCard`）；`PsyberTheme` 扩展 5 套暖调手账色板（暖纸白、曜夜暖黑、暮色晚霞、秋日暖咖、复古庄园 + 跟随系统）。
- **Ring 1.5 对话修整与隐私边界（2026-11-21）**：静默多版本修对话（`Edit`/`Reroll`/`Version`）与 3 秒二次点击防误触删除、双向社交撤回（`retract_message`）、上锁抽屉（`private/*.sealed` + `drawer_read`/`drawer_write` + `/api/v1/drawer` 写先于读 `privacy.peeked`）、主动折叠分享卡（`ShareCard`）、关门一次性紧急通道与左侧栏双人状态签（含勿扰抑制 `wake`）。
- **Ring 1.5 聊天流与输入手感升级（2026-11-21）**：沉默 vs 故障隔离与原地重试、同轮手账折卡、草稿/粘图/短视频抽帧、手动「存记忆换段」与三态输入按钮。

### 下一步
- 在本机终端执行 `cd app && flutter test` 复验新增的设置页护栏/消耗统计/双人头像/5 套色板测试（共 19 组 Widget 用例）。
- 按需继续推进 Ring 1.5 剩余项：`digest` 附件摘要槽位、观影伴看（`cinema`）插件、外部 MCP 桥接或 Flutter 多地址竞速与 SSE `streamSeq` 续传。

## 2. 验证结果
- **`server/`（2026-11-21 终改后实测）**：`bun run typecheck` 零错误；`bun test`（12 文件 / 38 用例 / 463 断言，含新增 `llm_guardrails_usage_avatars.test.ts`）全部通过。
- **`app/`（2026-11-21 终改后实测）**：`dart analyze` 校验全部新增与修改业务文件零语法/类型错误；`flutter test` 待本机终端复跑全部 19 组用例。
