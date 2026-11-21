# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-21（完成 Ring 1.5 双向社交撤回、主动折叠分享卡 + 关门一次性紧急通道、双人状态签 + 勿扰抑制与评测透明化；此前完成聊天流/输入手感升级与 Ring 0+1 本机联调）。

## 1. 当前阶段：Ring 0 + Ring 1 闭环已实跑通过，Ring 1.5 日常互动与状态体验升级已落地

### 已完成
- **契约升级（2026-11-21，契约先行）**：全仓顶层契约（`CAPABILITIES.md` v1.4、`ARCHITECTURE.md` v0.8、`MEMORY.md` v0.8、`API.md` v0.8、`ROADMAP.md` v1.2）与执行规程（`Spec 01` v1.2、`Spec 02` v0.8、`Spec 03` v0.5、`Spec 04` v0.5）完成交叉一致性同步。
- **Ring 1.5 社交撤回、分享卡、紧急通道与双人状态签（2026-11-21）**：
  - **静默修对话 vs 双向社交撤回**：保持 `DELETE` 静默不告知住户，前端悬停删除改为「3 秒二次点击确认（再点删除）」无弹窗防误触；新增 `POST /api/v1/chat/messages/:id/retract` 与 Tier 3 `retract_message(quote)`（强制精准引文防幻觉乱撤），落实天然不对称可见性（用户撤回对住户上下文与整理转录替换为`（对方撤回了一条消息）`，住户撤回在界面渲染居中占位并隐藏正文/思考，自身上下文与记忆整理保留原话）。
  - **主动折叠分享卡（`ShareCard`）+ 关门态一次性紧急通道**：新增 Tier 3 `share(title, content)` 工具、`POST /api/v1/shares/:id/open` 首次拆阅幂等回执（广播 `share.opened` 并在下轮 `<runtime_context>` 客观告知住户）与暖黄折叠 `ShareCard`；在 `closed` 态门缝输入台旁新增需二次确认的「有急事（仅此一条）」紧急直达开关（`urgent: true`，发完自动复位，`cooling_off` / `departed` 仍严禁打扰）。
  - **左侧栏双人状态卡 + 勿扰抑制 + 评测透明化**：新增 `GET/PATCH /api/v1/user-status`（广播 `user_status.updated`）与左侧栏顶部 `DualStatusCard`（住户门牌心绪 + 用户快捷心绪短句 + 一键勿扰开关，勿扰开启时在 `evaluateHeartbeat` 中自动抑制非紧急主动 `wake`）；设置页召回评测模式下补齐可选「评测检视对住户透明」开关（`recallEvalNoticeResident`）。
- **Ring 1.5 聊天流与输入手感升级（条目 4–6，2026-11-21）**：主动沉默 vs 故障中断隔离与原地重试（`POST /api/v1/turns/:turnId/retry`）、同轮手账折叠聚合（`TurnJournalCard` / `ScreenToolCard` / `ModelSwitchDivider`）、本地草稿/剪贴板粘图/拖拽/短视频抽帧（`VideoTile`）、上下文进度条与「存记忆换段」（`POST /api/v1/chat/wrap-up`）、输入台三态按钮与 AI 回复态指示。
- **本机 macOS 实跑联调与 Ring 1 闭环**：`server/` 与 `app/`（「静室信笺」主题 + 融合标题栏 + 贴纸输入台预览）已全量闭环。

### 下一步
- 在本机终端执行 `cd app && flutter analyze && flutter test` 复验新增 3 组 Flutter Widget 测试（本轮沙箱环境限制写入 Homebrew Flutter SDK `lockfile` 与读取用户 `~/.pub-cache`）。
- 按条目优先级继续落地剩余 Ring 1.5 项（`Edit`/`Reroll`/`Version` 多版本切换、`/api/v1/drawer` 上锁抽屉、`cinema` 观影四宫格与活动浮条、附件 `digest` 摘要等）。

## 2. 验证结果
- **`server/`（2026-11-21 终改后实测）**：`bun run typecheck` 零错误；`bun test`（10 文件 / 32 用例 / 372 断言，含新增 `retract_share_urgent_status.test.ts`）全部通过。
- **`app/`（2026-11-21 终改后实测）**：`dart analyze` 校验全部新增与修改的 `lib/` 业务代码零语法/类型错误；`flutter test` 待本机终端复跑全部 18 个 Widget 用例（含新增 3 组撤回/分享卡/紧急通道/双人状态卡测试）。
