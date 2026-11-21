# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-21（完成 Ring 1.5 日常聊天流与输入手感 3 项细节升级 [契约条目 4–6]；此前完成全仓契约 v1.4/v0.8/Spec v1.2+ 升级与 Ring 0+1 本机 macOS 实跑联调）。

## 1. 当前阶段：Ring 0 + Ring 1 闭环已实跑通过，Ring 1.5 日常聊天流与输入手感已落地

### 已完成
- **契约升级（2026-11-21，契约先行）**：全仓顶层契约（`CAPABILITIES.md` v1.4、`ARCHITECTURE.md` v0.8、`MEMORY.md` v0.8、`API.md` v0.8、`ROADMAP.md` v1.2）与执行规程（`Spec 01` v1.2、`Spec 02` v0.8、`Spec 03` v0.5、`Spec 04` v0.5）完成交叉一致性同步。
- **Ring 1.5 聊天流与输入手感升级（条目 4–6，2026-11-21）**：
  - **主动沉默 vs 故障中断严格隔离 + 原地重试**：新增 `turn.silence`（仅前台 SSE 发出，`wake` `[SILENT]` 仍抑制离线推送且不落盘）与 `SilenceLine`（极轻斜体短语）；系统故障改渲染内联 `FailureLine`（人话原因、可展开建议、`POST /api/v1/turns/:turnId/retry` 原地无痕重试不重复插入用户消息，支持连续失败后多次重试）。
  - **同轮手账折叠聚合 + 非对称排版 + 模型切换分割线**：新增 `turn.tool` 进度与落盘 `toolSummary`（排除 `express`），同一轮 `thinking` + 非隐私工具收拢为单卡 `TurnJournalCard`，隐私看屏工具 `look_at_screen` 独立展示 `ScreenToolCard`；AI 正文采用衬线体无框直铺，用户侧保留轻气泡；切换模型时在时间线展示 `ModelSwitchDivider`（`turn.model_switched` / `item.model`）。
  - **输入手感、零依赖媒体桥与手动存记忆换段**：本地草稿自动保存/恢复（`client_draft.txt`）；macOS 原生 `MethodChannel`（`MainFlutterWindow.swift` / `desktop_media.dart`）支持 `⌘V` 剪贴板图片/文件粘贴、窗口拖拽投喂与 `AVAssetImageGenerator` 短视频抽帧 + `VideoTile` 轮播预览（无新增第三方 pub 依赖）；桌面端 `Enter`/`⌘Enter` 发送、`Shift+Enter` 换行，移动端 `Enter` 仅换行；左侧栏/抽屉新增 `contextUsage` 上下文轻量进度条与「存记忆换段」按钮（`POST /api/v1/chat/wrap-up`）。
  - **输入台三态按钮与 AI 回复态显式化**：`AdaptiveComposer` 右侧按钮按「AI 回复中 → 停止按钮 / 有待发内容 → 发送箭头 / 空输入 → 语音输入按钮（预留 TTS/ASR 入口）」三态切换，并统一输入行控件 `30×30` 紧凑尺寸与单行文字上下居中对齐；`DoorThresholdBar` 与 `StreamingAssistantBubble` 同步展示「正在回复…」指示。
- **本机 macOS 实跑联调与 Ring 1 闭环**：`server/`（切片 1–3、`POST /chat/messages` 图片与贴纸接入、`index.ts` 启动与 `VACUUM INTO` 7 份热备）与 `app/`（「静室信笺」主题 + 融合标题栏 + 贴纸输入台预览）已全量闭环。

### 下一步
- 按条目优先级继续落地剩余 Ring 1.5 项（静默修/抽回重播、`Edit`/`Reroll`/`Version` 多版本切换、`/api/v1/drawer` 上锁抽屉、`cinema` 观影四宫格与活动浮条、附件 `digest` 摘要等）或补充真机实测新加的拖拽/短视频抽帧流程。
- 按需补齐 `Spec 05` §5.3 CLI 脚本（`eval:recall`、`memory:reindex`、`backup`、`restore`）。

## 2. 验证结果
- **`server/`（2026-11-21 终改后实测）**：`bun test`（9 文件 / 29 用例 / 312 断言，含 `chat_ux_and_retry.test.ts`）全部通过；`bun run typecheck` 零错误。
- **`app/`（2026-11-21 终改后实测）**：`flutter analyze` 输出 `No issues found!`；`flutter test` 15 个离线单元与 Widget 用例全部通过；`flutter build macos --debug` 编译打包通过（`psyber_app.app`）。
