# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-23（落地配对安全补强、局域网 UDP 自动发现、扫码配对与本机桌面端免码连入）。

## 1. 当前阶段：Ring 1.5 外部 MCP 桥接与主体体验板块已落地（配对体验与安全补强完成）

### 已完成
- **配对安全补强、局域网自动发现、扫码配对与本机桌面端免码（`docs/` + `server/` + `app/`，2026-11-23）**：
  - **后端安全补强**：`index.ts` 通过 `Bun.serve` `server.requestIP` 注入真实客户端 IP 解决 `"direct"` 共享限流桶；`pairing.ts` 升级为常量时间比对与先判过期；`sse.ts`/`app.ts`/`admin_routes.ts` 绑定 `deviceId` 实现设备吊销即时断开存量 SSE；`app.ts` 增加跨站 `Origin` 守卫拦截恶意网页；`index.ts` 支持 `PSYBER_TLS_CERT`/`PSYBER_TLS_KEY` 原生 HTTPS 并在局域网明文 HTTP 监听时输出安全提示。
  - **后端发现/二维码/本机免码**：新增 `discovery.ts`（UDP `37219` 局域网发现，仅广播非敏感元信息）、`qr.ts`（零依赖 ISO 18004 二维码与终端紧凑渲染）、`POST /api/v1/auth/pair-code`（已配对端签发扫码载荷 `{ v: 1, urls, code }`）与 `POST /api/v1/auth/local-pair`（仅限回环 IP + 无 `Origin` + `0600` `local_pair.json` 启动密钥，停机自动清理）。
  - **前端客户端**：新增 `lan_discovery.dart`（UDP 发现、二维码解析、本机桌面端 `local_pair.json` 读取与 iOS `AVFoundation` 原生 `psyber/qr` 扫码通道）与 `qr_code_view.dart`（零依赖标准二维码组件）；`PairingPage` 支持桌面端本机免码连入、局域网自动发现点选、扫码/粘贴二维码配对与局域网明文 HTTP 提示；设置页「工具与设备」新增「配对新设备（扫码 / 配对码）」二维码弹窗。
- **模型元数据目录（`models.dev`）与设置页重构（`server/` + `app/`，2026-11-23）**：
  - **后端**：新增 `server/src/llm/catalog.ts`（内置快照 + 每日后台同步 `https://models.dev/api.json` 缓存至 `<dataDir>/model_catalog_cache.json` + 归一化模糊匹配 + 单模型 `modelOverrides` 最高优先级覆盖），并接入 `router.ts` 自动补齐上下文窗口、最大输出与输入/输出模态；`registry.ts` 新增 `listAllTools()` 与 `disabledTools` 持久化开关（Tier 1 核心元工具强制锁定常驻不可关闭）；`events.ts` `getUsageStats` 支持 `?days=` 时间范围筛选；`admin_routes.ts` 扩展 `/settings` 返回 `tools`/`disabledTools`/`system`（版本、配置与记忆路径、目录状态），新增 `POST /api/v1/llm/catalog/sync`，扩展 `slots` 支持 `digest`/`image_gen`、`null` 清除与 `deleteProviderIds`。
  - **前端**：侧栏左下角设置入口精简为独立齿轮图标按钮（`settings_button`）；设置页拆分为 **模型服务商**（服务商池、连通状态灯、Base URL/密钥更新、模型能力标签与手动覆盖弹窗）、**模型配置**（按角色槽位分配 + 主对话内联可折叠参数摘要 + `models.dev` 目录同步）、**用量**（`今天/7天/30天/90天/全部` 分段）、**作息与通知**、**居所与外观**、**工具与设备**（展示 Psyber 全量工具，核心元工具标「核心常驻」锁定不可开关，Tier 2/3 工具可按需开关）与 **关于与数据**（版本、可复制的配置/记忆路径、目录同步）。
- **默认 `maxTokens` 提升与 `stopReason=length` 截断防护（`docs/spec/` + `server/`，2026-11-23）**：`router.ts` 兜底模型（含 `openai-compat`）默认 `maxTokens` 从 `4096`/`8192` 提升至 `16384`（`DEFAULT_FALLBACK_MAX_TOKENS`）并支持目录模型覆盖；`PiAiChatClient` 在 `usage` 块透传 `stopReason`；`tidy.ts` 拦截 `stopReason === "length"` 或仅输出思考链而无正文/工具调用的异常步，严格回滚磁盘且绝不推进游标，并补齐多步工具循环的 `thinking` + `thinkingSignature` 回传与 `thinkingLevel` 透传；`direct.ts` 遇到 `length` 且零正文时推 `turn.error` 不落空白回复，已有部分正文时落盘并标 `metadata.truncated = true`。
- **静默整理轮日期上下文与 `prompts/tidy.md` v7 加固（`prompts/` + `docs/spec/` + `server/`，2026-11-22）**：借鉴 Psyche 热/冷写与梗概设计，在 `tidy.ts` 顶部注入 `<tidy_context>`（目标日、星期、ISO 周号与 `bedtime` 精确 `gist/days/YYYY-MM.md` / 周日 `gist/weeks/YYYY.md` 目标路径与节标题），消息转录附本地 `[YYYY-MM-DD HH:mm]` 与图片附件提示，`bedtime` 补充当日卡片节选、现行 `gist/days/` 尾部与 `shelf/` 摘要防重复写；`prompts/tidy.md` 升至 v7 明确 `daily/` vs `gist/days/` 分工、意外/后果优先、同事实只落一处及最小 Frontmatter 规范。
- **身份简化、可选代词与全仓去「住户」统一（`prompts/` + `docs/` + `server/` + `app/`，2026-11-22）**：移除 `self.md` 冗余 `named` 布尔字段（以 `name` 非空为唯一真相并兼容无 `name` 键旧档案），`self.md` 增加初始为空的可选 `pronoun`（不于创世页预设）；透传 `residentPronoun`；全仓 `docs/`、`prompts/`、`server/` 与 UI 默认兜底统一称 `Psyber`（不再用「住户」或「TA」），保留「我的头像」，`SettingsPanel` 与 `DrawerModal` 实时监听 `identityNotifier`。
- **身份档案、多步日志、消息/门牌时序与顶栏重构（`prompts/` + `docs/` + `server/` + `app/`，2026-11-22）**：`self.md`/`user.md` 引入结构化 Frontmatter（`name`/`pronoun`）与 `identity` 接口、`identity.updated` SSE 及创世页代词选择；对话流按 `step` 拆分多步思考与工具日志（`journalSteps`）；用户贴图/图片独立无气泡渲染；`door` 状态事件延后至助手持久化后落库；移除后台/提示词/UI 中机械服务口吻与多余「对方」；桌面移除顶栏并流式区去重复徽标/停止按钮，手机端改为头像+状态色点+状态词居中胶囊与顶部透明渐隐。
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
- **用户气泡跟随主题强调色 + 消息字号收至 15px（`app/`，2026-11-22）**：旧书暖纸/岸线·晨/岸线·夜 3 套的 `userBubble` 改为该套 `accent`（实心气泡）、`userText` 改为 `onAccent`，不描边；暖纸白/曜夜暖黑 2 套因强调色太强改回原色浅灰气泡并保留细边（浅色气泡无边会糊进背景）；用户气泡文字改用 `userText`；Psyber 消息字号由 15.5px 收至 15px，与用户消息一致。
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
- **`server/`（2026-11-23 配对安全补强、局域网发现、二维码签发、本机免码与 Ctrl+C 优雅停机修复后实测）**：`bun run typecheck` 零错误；`bun test`（16 文件 / 57 用例）全部通过。
- **`app/`（2026-11-23 宿主机终端实测）**：`cd app && flutter analyze && flutter test` 零警告、全量通过。
