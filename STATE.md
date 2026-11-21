# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-21（完成本机 macOS 实跑联调；补齐 Ring 1 后端 3 项核心接线：多模态图片附件透传与用户贴纸渲染、Dynamic Tail `<stickers>` 预算注入、`renderCircadianState` 动态接入；修复前端选贴纸后直发问题，改为暂存输入台可继续打字再发送）。

## 1. 当前阶段：Ring 0 + Ring 1 前后端核心闭环完成且本机 macOS 实跑联调通过 → 积累日常评测或进入 Ring 1.5

### 已完成
- **本机 macOS 实跑联调**：已完成真机配对、初生引导与端到端联调验证。
- **`server/` Ring 1 极简后端全量闭环**：
  - 切片 1–3：`core/`（含 `backup.ts` `VACUUM INTO` 7 份热备）、`store/events.ts`、`memory/`、`expression/`、`tools/`、`llm/`（动态 BYOK 路由，支持 4 类接口热切换，含 `openai-compat` 图片模态）、`engine/`（`direct.ts`、`sse.ts`、`tidy.ts`）、`mood/circadian.ts`、`notifications/hub.ts`、`api/`（含 `/api/v1/stickers` 全部核心端点）。
  - 2026-11-21 接线补齐：`POST /chat/messages` → `DirectEngine` → `PiAiChatClient` 贯通用户图片附件（`ImageContent` base64）与贴纸语义（`[贴纸: <label>]`）；`buildDynamicUserMessage` 注入 `<stickers>`（≤ 30 条 / ≤ 500 字）并接入 `renderCircadianState`（`清醒`/`临近睡前`/`夜间静默窗`）。
  - `index.ts`：`bootPsyberRuntime` 串联配对、媒体、离线通知、作息心跳、单队列去重 `tidy`、`bedtime` 后热备与优雅停机；支持 `--pair` / `bun run pair`、终端按 `p` 签发配对码及设备吊销。
- **`app/` Flutter 跨端客户端（「静室信笺」主题 + Ring 1.5 UI 扩展槽；图标改用 `phosphoricons_flutter` Light 细线条，唯一第三方 pub 依赖）**：
  - 桌面端原生体验升级（2026-11-21）：`MainFlutterWindow.swift` 开启透明融合标题栏（默认 `980x700`、`minSize 420x560`）；`DoorThresholdBar` 全宽边缘对齐并避让红黄绿灯；宽屏（`>=920px`）默认展开无遮罩 `LeftArchiveSidebar`（248px）并改右抽屉为 `ActivityPopoverCard`；接入 `⌘,` / `⌘\` / `Esc` 与 `Enter` 发送 / `Shift+Enter` 换行（IME 组合态放行）；选择贴纸改为暂存输入台预览胶囊（`pending_sticker_chip`），支持继续打字或附带图片一并发送。
  - `shared/` / `core/` / `features/` / `test/psyber_app_test.dart`：10 个离线单元与 Widget 用例全部通过（覆盖 `420x560`、`800x600` 与 `1280x800` 响应式场景）。

### 下一步
- 日常使用积累首批真实对话与 `recall_feedback` 评测数据；按需补齐 `Spec 05` §5.3 CLI 脚本（`eval:recall`、`memory:reindex`、`backup`、`restore`）与 `tidy` 写入 `memory_task` 时间线事件。
- 按 `docs/ROADMAP.md` 落地后端 Ring 1.5 端点（`Edit`/`Reroll`/`Version`、`/api/v1/drawer`、`cinema` 观影伴看、SSE 500 条环形缓冲与 `sync.reset` 等），前端槽位已就绪。

## 2. 验证结果
- **`server/`（2026-11-21 本机实测）**：`bun test`（8 文件 / 27 用例 / 288 断言）全部通过；`bun run typecheck` 零错误。
- **`app/`（2026-11-21 本机实测）**：`flutter analyze` 输出 `No issues found!`；`flutter test` 10 个离线单元与 Widget 用例全部通过（含贴纸暂存输入台并发送、`420x560` macOS 窄窗顶栏无溢出与宽屏测试）。
