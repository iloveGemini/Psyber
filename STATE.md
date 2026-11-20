# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-20（Ring 1 前后端核心功能、BYOK 动态路由、贴纸与发图闭环全部全绿通过）。

## 1. 当前阶段：Ring 1 前后端 MVP 全量闭环并验证通过 → 下一步本机 macOS 实跑联调或进入 Ring 1.5

### 已完成
- **`server/` Ring 1 极简后端全量闭环**：
  - 切片 1–3：`core/`（含 `backup.ts` `VACUUM INTO` 7 份热备）、`store/events.ts`、`memory/`、`expression/`、`tools/`、`llm/`（`client.ts` + `router.ts` 动态 BYOK 路由，支持 `anthropic`/`openai`/`google`/`openai-compat` 无重启热切换）、`engine/`（`direct.ts`、`sse.ts`、`tidy.ts`）、`mood/circadian.ts`、`notifications/hub.ts`、`api/`（含 `/api/v1/stickers` 全部核心端点）。
  - `index.ts`：`bootPsyberRuntime` 串联配对、媒体、离线通知、作息心跳（支持 `/settings` 热重调度）、单队列去重 `tidy`、`bedtime` 后自动热备与优雅停机。
- **`app/` Flutter 薄客户端 MVP（原生 SDK，零第三方 pub 依赖）**：
  - `core/`：`models.dart`、`session_storage.dart`、`api_client.dart`（REST + SSE + 媒体上传 + 贴纸列表）、`media/image_picker.dart`（原生 macOS 选图）、`app_controller.dart`。
  - `expression/expression_renderer.dart`：色温光罩、触觉与气泡微动效。
  - `features/`：`pairing_page.dart`、`genesis_page.dart`、`chat_page.dart`（虚拟化时间线、折叠 `ThinkingCard`、发图上传与待发预览条、贴纸选择面板、门缝纸条输入切换、中止生成、软删、可开关懒加载 `RecallFeedbackBar`）。
  - `test/psyber_app_test.dart`：5 个离线单元与 Widget 用例全部通过。

### 下一步
- 本机 macOS 实跑联调（使用 `PSYBER_DATA_DIR=~/.psyber/test` 试跑后端 + Flutter 客户端配对、初生向导、发图/贴纸与真实 BYOK 首次对话）。
- 或按 `docs/ROADMAP.md` 进入 Ring 1.5（消息 `Edit`/`Reroll`/`Version` 四态版本组、多地址竞速选路、SSE 500 条环形缓冲与 `sync.reset`、C2.7 写后独立复核、观影伴看等）。

## 2. 验证结果（2026-11-20）
- `cd server && bun test`：8 个测试文件、26 个用例、270 项断言全部通过（100% 离线）。
- `cd server && bun run typecheck`：`tsc --noEmit` 零错误通过。
- `cd app && flutter analyze`：No issues found。
- `cd app && flutter test`：5 个用例全部通过（100% 离线）。
