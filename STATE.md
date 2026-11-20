# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-20（Ring 1 前后端核心 MVP 均已全绿通过：`server/` 7 套件 24 用例 + `app/` `flutter analyze` 零问题 & `flutter test` 4 用例全绿）。

## 1. 当前阶段：Ring 1 前后端核心 MVP 已全部闭环并验证通过 → 下一步接通生产模型动态路由或启动端到端联调

### 已完成
- **`server/` Ring 1 极简后端全量闭环**：
  - 切片 1–3：`core/`（含 `backup.ts` `VACUUM INTO` 7 份热备）、`store/events.ts`、`memory/`、`expression/`、`tools/`、`llm/client.ts`、`engine/`（`direct.ts`、`sse.ts`、`tidy.ts`）、`mood/circadian.ts`、`notifications/hub.ts`、`api/`（14 个核心端点 + 配对防爆破）。
  - `index.ts`：导出可测的 `bootPsyberRuntime`，串联配对、媒体、离线通知、作息心跳、单队列去重 `tidy` 异步整理、`bedtime` 后自动热备与优雅停机。
- **`app/` Flutter 薄客户端 MVP（原生 SDK，零第三方 pub 依赖）**：
  - `core/`：`models.dart`、`session_storage.dart`、`api_client.dart`（原生 `HttpClient` REST + SSE 解析）、`app_controller.dart`（5 域独立 `ValueNotifier` 隔离刷新 + 切后台静默重连不弹红条）。
  - `expression/expression_renderer.dart`：纸感画布色温光罩（`AtmosphereOverlay`）、原生触觉映射与气泡克制微动效（尊重减少动态效果）。
  - `features/`：`pairing/pairing_page.dart`（单地址 + 一次性配对码绑定）、`chat/chat_page.dart`（虚拟化时间线、折叠 `ThinkingCard`、中止生成、软删、门状态与门缝纸条输入自适应切换、默认关闭且懒加载的 `RecallFeedbackBar`）。
  - `test/psyber_app_test.dart`：100% 离线 Fake API 单元测试与 Widget 测试套件（4 个用例全绿）。

### 未完成（下一阶段）
- 生产模型动态路由接线（`server/src/index.ts` 按 `config.llm.slots.chat` + `credentials.json` 动态实例化 `PiAiChatClient`，实现配置 BYOK 后无需重启直接对话）。
- Flutter 端补齐 Genesis 初生引导页与发图上传（`/api/v1/genesis`、`/api/v1/media`）及本机 macOS 实跑联调。

## 2. 验证结果（2026-11-20）
- `cd server && bun test`：7 个测试文件、24 个用例、250 项断言全部通过（100% 离线）。
- `cd server && bun run typecheck`：`tsc --noEmit` 零错误通过。
- `cd app && flutter analyze`：No issues found。
- `cd app && flutter test`：4 个用例全部通过（100% 离线）。
