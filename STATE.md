# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-21（完成 Ring 1.5 多版本修对话 `Edit/Reroll/Version` 与上锁抽屉 `private/*.sealed` + `/api/v1/drawer` 全链路闭环；此前完成双向撤回、分享卡、紧急通道、双人状态签与聊天流升级）。

## 1. 当前阶段：Ring 0 + Ring 1 闭环稳定，Ring 1.5 对话修整与隐私边界板块已全量收口

### 已完成
- **契约升级（2026-11-21，契约先行）**：全仓顶层契约（`CAPABILITIES.md` v1.4、`ARCHITECTURE.md` v0.8、`MEMORY.md` v0.8、`API.md` v0.8、`ROADMAP.md` v1.2）与执行规程（`Spec 01` v1.2、`Spec 02` v0.8、`Spec 03` v0.5、`Spec 04` v0.5）完成交叉一致性同步。
- **Ring 1.5 多版本修对话与上锁抽屉闭环（2026-11-21）**：
  - **静默修对话多版本状态机（`Edit` / `Reroll` / `Version`）**：落地 `POST /api/v1/chat/messages/:id/edit`（仅允许改同会话末条活跃用户消息，弃用旧用户行与尾随助手回复，关门态仅放行 `door_note` 且不唤醒）、`POST /api/v1/chat/messages/:id/reroll`（原助手行置 `candidate`，独立新 `turnId` 共享 `groupId` 重摇，失败自动恢复原版本防丢消息）、`POST /api/v1/chat/messages/:id/version`（仅在 `candidate` 助手版本组间切换并实时统计 `versionCount`，拒切 `discarded`/`deleted`）；同步加固 Flutter 端 `AppController` 跨 ID 版本组原子替换。
  - **上锁抽屉（`private/*.sealed` + `privacy.peeked` 拆封留痕）**：新增 `server/src/memory/drawer.ts`（`PSYBER-SEALED-V1` 封蜡清单 + `instanceId` 派生 SHA-256 流式混淆 + SHA-256 完整性校验，严格执行物理/Git/SQLite 三道零入库隔离）；注册 Tier 3 `drawer_read` / `drawer_write`（Tier 1 维持 9 工具冻结）；挂载 `GET /api/v1/drawer`（绝不解封正文）与 `POST /api/v1/drawer/:id/open`（强制 `confirmed: true`、写 `privacy.peeked` 先于返回明文，经 `events_notice` 游标客观告知住户）。
- **Ring 1.5 社交撤回、分享卡、紧急通道与双人状态签（2026-11-21）**：静默删除（3 秒二步防误触）vs 双向社交撤回（`retract_message`）、主动折叠分享卡（`share` + `/shares/:id/open`）、关门态一次性紧急通道（`urgent: true`）、左侧栏双人状态卡（`/user-status` + 勿扰抑制 `wake`）与召回评测透明告知。
- **Ring 1.5 聊天流与输入手感升级（2026-11-21）**：主动沉默 vs 故障中断隔离与原地重试（`/turns/:turnId/retry`）、同轮手账折卡（`TurnJournalCard`/`ScreenToolCard`/`ModelSwitchDivider`）、本地草稿/粘图/短视频抽帧、手动「存记忆换段」（`/chat/wrap-up`）、三态输入按钮与回复态指示。

### 下一步
- 推进 Ring 1.5 下一板块：**模型省钱护栏与居所氛围**（`digest` 附件摘要槽位、主/备模型降级链、思考深度离散档位、设置页「消耗统计」Tab、双人头像上传与 5 套暖调手账色板），或按需接入观影伴看（`cinema`）/ 外部 MCP 桥接。

## 2. 验证结果
- **`server/`（2026-11-21 终改后实测）**：`bun run typecheck` 零错误；`bun test`（11 文件 / 35 用例 / 430 断言，含新增 `edit_reroll_version_drawer.test.ts`）全部通过。
- **`app/`（2026-11-21 实测）**：`dart analyze` 业务代码零错误；本地终端 `flutter test` 18/18 全部通过（本轮小改 `AppController` 版本组替换后可复跑确认）。
