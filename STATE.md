# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-21（UI 美化：全 App 图标换 Phosphor Light 1.5px 细线条，去掉图标方盒底托与列表尖括号，标题字重降档，回到底部胶囊改小圆角；待本机 `flutter analyze` + `flutter test` 复核）。

## 1. 当前阶段：Ring 1 前后端 MVP + 前端全新双抽屉视觉就绪 → 下一步本机 macOS 实跑联调或进入 Ring 1.5

### 已完成
- **`server/` Ring 1 极简后端全量闭环**：
  - 切片 1–3：`core/`（含 `backup.ts` `VACUUM INTO` 7 份热备）、`store/events.ts`、`memory/`、`expression/`、`tools/`、`llm/`（动态 BYOK 路由，支持 4 类接口热切换）、`engine/`（`direct.ts`、`sse.ts`、`tidy.ts`）、`mood/circadian.ts`、`notifications/hub.ts`、`api/`（含 `/api/v1/stickers` 全部核心端点）。
  - `index.ts`：`bootPsyberRuntime` 串联配对、媒体、离线通知、作息心跳、单队列去重 `tidy`、`bedtime` 后热备与优雅停机；支持 `--pair` / `bun run pair`、终端按 `p` 签发配对码及设备吊销。
- **`app/` Flutter 跨端客户端（「静室信笺」主题 + Ring 1.5 UI 扩展槽；图标改用 `phosphoricons_flutter` Light 细线条，唯一第三方 pub 依赖）**：
  - UI 美化（2026-11-21）：67 处默认 Material 图标全换 `PhosphorIconsLight`（1.5px 细线条）；抽屉 leading 图标去掉彩色方盒底托；抽屉/设置列表右侧尖括号删除（版本切换器保留）；「Psyber」标题与抽屉/设置标题字重 w600→w500；回到底部胶囊圆角 18→9；门态说明行高 1.45→1.6。
  - `shared/`：`theme.dart`（矿物白画布/松石绿/门阈值琥珀配色与排版 Token）、`rich_message_text.dart`（代码块一键复制/引用/加粗斜体与可选中文本）。
  - `core/`：`models.dart`、`session_storage.dart`、`api_client.dart`、`app_controller.dart`（含 `abortActiveTurn` 乐观收起与快照刷新、重连流式槽清理、`SettingsSnapshot`、`ActivitySessionView`、Ring 1.5 版本组/抽屉/活动接口与 `streamSeq`/`sync.reset` 处理）。
  - `features/`：`pairing_page.dart`、`genesis_page.dart`、`chat_page.dart`（门楣展开卡 `DoorThresholdBar`、居中 `680px` 阅读列、真图贴纸网格 `StickerPickerDialog`、缩略图预览与折痕纸感门缝输入框 `AdaptiveComposer`、图片灯箱、悬停/菜单操作、Ring 1.5 `ActivityBannerSlot` 与版本切换器）、`settings/settings_panel.dart` & `drawer_modal.dart`（宽屏右侧栏/窄屏独立页，接通 `GET/PATCH /settings`、设备吊销、贴纸上传与抽屉拆封二次确认）。
  - `test/psyber_app_test.dart`：9 个离线单元与 Widget 用例全部通过（覆盖 `800x600` 与 `1280x800` 响应式场景）。

### 下一步
- 本机 macOS 实跑联调（`PSYBER_DATA_DIR=~/.psyber/test bun run start` + `flutter run -d macos` 实测配对、初生向导、发图/贴纸与真实 BYOK 对话）。
- 按 `docs/ROADMAP.md` 落地后端 Ring 1.5 端点（`Edit`/`Reroll`/`Version`、`/api/v1/drawer`、`cinema` 观影伴看、SSE 500 条环形缓冲与 `sync.reset` 等），前端槽位已就绪。

## 2. 验证结果（2026-11-20）
- `cd server && bun test`：8 个测试文件、26 个用例、274 项断言全部通过（100% 离线）。
- `cd server && bun run typecheck`：`tsc --noEmit` 零错误通过。
- `cd app && flutter analyze`：No issues found。
- `cd app && flutter test`：9 个用例全部通过（100% 离线）。
- UI 美化改动（2026-11-21）：云端无 Flutter，未跑 `flutter analyze` / `flutter test`；需在本机 Mac 上复核通过后再确认。
