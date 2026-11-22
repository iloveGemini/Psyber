# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-22（同步收尾换段、`active_session` 持久化、Psyche 风格 `<continuity>` 金字塔与前端「正在收拢这段记忆…」提示落地，全量测试通过）。

## 1. 当前阶段：Ring 1.5 外部 MCP 桥接与主体体验板块已落地（同步换段与连续性重构完成）

### 已完成
- **iOS 客户端骨架、沙盒存储兼容与抽屉底栏适配（`app/`，2026-11-22）**：补齐 `app/ios/` 工程并配置 `NSAppTransportSecurity` / `NSLocalNetworkUsageDescription` 放行本地 HTTP 后端；修复 iOS 无 `HOME` 环境变量导致 `FileSessionStorage` 启动抛错白屏的问题，改由原生 `psyber/storage` MethodChannel 读取沙盒 `Application Support/psyber`，并在 `main.dart` 为 `initialize()` 兜底防白屏；修复 iOS 左抽屉底部 `SafeArea` 露底留缝问题。
- **同步收尾换段、`sessionId` 持久化与 `<continuity>` 升级（`docs/` + `server/` + `app/`，2026-11-22）**：
  - **契约与同步换段**：否掉异步先切段，75% 阈值 / `CONTEXT_OVERFLOW` / 手动 `POST /api/v1/chat/wrap-up` 均先同步排空 `daily_wrapup`（`turnMutex -> tidyMutex` 单向锁、`bedtime` 完成回调挪至释放 `tidyMutex` 后零死锁），成功后再切新 `sessionId`；整理失败保留原段不硬切；`CONTEXT_OVERFLOW` 有历史时换段后当轮自动重试一次；排队消息自动重绑新 `sessionId` 绝不双发。
  - **状态持久化与安全边界**：`task_cursors['active_session']` 持久化 `{ sessionId, fresh, carryOverUntilSeq, continuity }`，彻底修复常驻服务 `bedtime` 不换段、换段未发言重启复活旧段、短停重启丢过渡轮与水位归零；工具 `scope: "session"` 白名单绑定当前 `sessionId` 换段即失效；`edit`/`reroll` 禁止跨段修改；`buildHistoryMessages` 按 `session_id` 完整回放保护缓存；开机补跑 `bedtime` 同步覆盖昨晚手动换段后关机缺日梗概场景。
  - **Psyche 风格 `<continuity>` 与前端提示**：冻结在 Static Prefix 末尾（避免伪造 `messages[0]` 为 `assistant`），按「不重叠 `年→月→周→天` 梗概（≤16000 字，含单条防跑偏上限）+ 仅 `day > lastGistDay` 的 `daily/` 正文（≤1800 字，旧天与 `activities/` 交由召回）+ 上一段末尾原话（≤2000 字）」拼装；新增 SSE `turn.rollover` 与 `/chat/history.rolloverInProgress`，前端聊天页在收尾期间展示「正在收拢这段记忆…」轻提示。
- **重启连续性与错峰补整理修复（`server/`，2026-11-22）**：
  - 保留未整理会话跨日重启不截断、关机错过 `bedtime` 次日后台补跑能力（与上述持久化状态机合流）。
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
- **`server/`（2026-11-22 终改后实测）**：`bun run typecheck` 零错误；`bun test`（14 文件 / 49 用例 / 591 断言）全部通过。
- **`app/`（2026-11-22 终改后实测）**：`flutter analyze` 零问题；`flutter test`（24 用例）全部通过。
