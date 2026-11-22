# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-22（阅读系 5 套色板升级、日间/夜间独立色板持久化、修复助手 express 贴纸历史/流式不渲染及气泡动作在正文出现前提前消耗的缺陷）。

## 1. 当前阶段：Ring 1.5 外部 MCP 桥接与主体体验板块已落地（流式稳定化与阅读主题升级完成）

### 已完成
- **日夜独立主题持久化 + 助手贴纸与气泡动作修复（2026-11-22）**：
  - **日夜色板独立保存（`app/`）**：`SessionStorage` 新增 `client_theme.json`（`ThemePreferences`），分别持久化 `lightPalette`、`darkPalette` 与 `themeMode`，切至「跟随系统」时自动按昼夜切换各自保存的阅读色板。
  - **助手贴纸显示修复（`server/` + `app/`）**：`toTimelineItem` 补充解析 `metadata.expressions` 中的贴纸，`TimelineItem.fromJson` 同步兜底读取 `expressions` 内贴纸，`StreamingAssistantBubble` 实时渲染流式 `latestExpression.sticker`。
  - **气泡动作可见性与切离补播修复（`app/`）**：`MotionBubbleWrapper` 仅在正文/贴纸出现且应用处于前台（`isAppForegroundNotifier`）时才触发（`±9px / 620ms`）；切后台/窗口失焦期间或滚动未见时暂缓消耗，切回前台或滑入视口、以及后台重连拉回的新消息均自动补播一次。
- **阅读系主题色板与无字纸纹质感升级（2026-11-22）**：
  - 保留「暖纸白」「曜夜暖黑」，移除原先较随意的「暮色晚霞」「秋日暖咖」「复古庄园」，新增 **「旧书暖纸（`#EAE4DA` + `#313131` + `#A2644C`）」**、**「岸线·晨（`#E2DDD6` + `#3B4B54` + `#8C9BA5`）」** 与 **「岸线·夜（`#222B33` + `#E2DDD6` + `#8C9BA5`）」**。
  - 新增 `PaperGrainOverlay`（`256×256` 高频单像素均匀微粒 + 中央聊天页边柔光暗角 `pageEdgeTint`），并为阅读系色板启用书页章节时间线、引用摘录底色与门楣印章呼应；全量清理静态 `PsyberTheme.*` 硬编码与开关固定绿/警告固定橙漏色，弹窗/菜单/开关全部跟随当前色板；同步更新 `docs/CAPABILITIES.md` 与 `docs/spec/04-api-and-flutter.md`。
- **SSE 流式显示与工具轮次稳定性修复（2026-11-21）**：
  - **后端**：`Bun.serve` 显式配置 `idleTimeout: 0` 根治 10s 强断长连接；`SseHub` 与 `/api/v1/stream` 落地 `streamSeq` 500 帧环形缓冲（支持 `Last-Event-ID` 补帧与 `sync.reset`）；`dispatchChatTurn` 助手落盘同步广播 `message.created`、`GET /api/v1/chat/history` 返回 `activeTurnId`；`PiAiChatClient` 捕获流异常与 `thinking_end` 签名；`DirectEngine` 为 `MAX_TOOL_STEPS` 达上限补跑无工具收尾步、非静默思考/工具轮次兜底落盘、捕获未预期异常广播 `turn.error`，并支持多步工具调用中途失败后的 `TurnCheckpoint` 断点续跑（`POST /api/v1/turns/:turnId/retry` 不重复执行前序已完成工具）。
  - **前端（`app/`）**：`AppController` 重连保留仍在服务端进行的 `activeTurnNotifier`、对错过 `turn.start` 的增量事件自动恢复流式气泡、`message.created` 无缝衔接落盘；`ChatPage` 在停留在底部附近时随流式输出自动轻滑贴底；修复「编辑并重发」等弹窗在退出动画期提前 `dispose` `TextEditingController` 导致 `_dependents.isEmpty` 红屏断言的缺陷（全部改由独立 `StatefulWidget` 弹窗托管控制器生命周期）。
- **契约升级（2026-11-21，契约先行）**：全仓顶层契约（`CAPABILITIES.md` v1.4、`ARCHITECTURE.md` v0.8、`MEMORY.md` v0.8、`API.md` v0.8、`ROADMAP.md` v1.2）与执行规程（`Spec 01`–`04`）完成交叉一致性同步。
- **Ring 1.5 外部 MCP 桥接与同步审批（2026-11-21）**：
  - **后端（`server/src/extensions/mcp.ts`）**：零新增外部依赖实现 `stdio`（`Bun.spawn`）与 `streamable_http` MCP 客户端与 `McpManager`，全部外部工具强制注册为 Tier 3 `mcp.<serverId>.<toolName>`，敏感密钥经 `${cred:<key>}` 隔离于 `0600` `credentials.json`，同步审批（`POST /api/v1/turns/:turnId/approval`）。
  - **前端（`app/`）**：设置页新增「外部工具扩展（MCP）」分区；聊天流新增同步工具审批确认卡。
- **Ring 1.5 模型省钱护栏、消耗统计、居所氛围与对话修整（2026-11-21）**：主备降级链、`thinking.level`、双上下文上限、`/llm/models` & `/llm/test`、`/usage/stats`、双人头像与 5 套暖调色板、静默多版本修对话、双向撤回、上锁抽屉、分享卡、关门紧急通道、双人状态签与原地重试。

### 下一步
- 按需继续推进 Ring 1.5 剩余项：多端点竞速、Bark/ntfy/GFS 推送通道、观影伴看（`cinema`）插件，或 `digest` 附件摘要槽位。

## 2. 验证结果
- **`server/`（2026-11-22 终改后实测）**：`bun run typecheck` 零错误；`bun test`（13 文件 / 43 用例 / 520 断言）全部通过。
- **`app/`（2026-11-22 终改后实测）**：`flutter analyze` 零问题；`flutter test`（23 用例）全部通过。
