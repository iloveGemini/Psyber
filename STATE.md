# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-20（已完成 `server/` Ring 1 极简 MVP 全部 3 个后端切片：底座沙箱、极简召回 + `DirectEngine` + SSE、作息心跳 + 异步单轮整理 + 离线通知 + 全套 14 个核心端点，6 个离线测试套件 21 个用例全部通过）。

## 1. 当前阶段：Ring 1 极简 MVP 后端核心模块已闭环 → 下一步组装 `index.ts` 启动入口或进入 Flutter 薄客户端

### 已完成（`server/` Ring 1 极简后端全量模块）
- **切片 1（底座与记忆沙箱）**：`core/`（`clock.ts`、`ulid.ts`、`db.ts`、`config.ts`、`credentials.ts`、`git.ts`、`mutex.ts`、`prompts.ts`、`media.ts`）、`store/events.ts`、`memory/`（`frontmatter.ts`、`fts.ts`、`genesis.ts`、`index.ts`、`gist.ts`、`tools.ts`）。
- **切片 2（召回、工具、Direct Engine 与 SSE）**：`memory/recall.ts`（极简 3 步召回 + `recall_traces`/`recall_feedback`）、`expression/`（`express.ts`、`stickers.ts`）、`tools/`（`registry.ts`、`core_tools.ts`）、`llm/client.ts`（`@earendil-works/pi-ai` 流式适配）、`engine/direct.ts`、`engine/sse.ts`。
- **切片 3（作息、异步整理、离线通知与配对/媒体/初生/设置接口）**：
  - `mood/circadian.ts`：扁平作息静默窗与心跳判定器（跨午夜同一夜 `bedtime` 不跑重、连续未回 ≥ 2 退避静默、门缝纸条 ≥ 30m 唤醒、零浮点数输出）。
  - `engine/tidy.ts`：单队列单轮异步记忆整理（`daily_wrapup`/`bedtime` 排空与当日卡片/周日梗概注入、沙箱安全内存回滚不推游标、连续收录 `door_note` 不推 `door_notes_read`）。
  - `notifications/hub.ts`：`desktop` + `webhook`（含 `headers`/`credentialKey`）离线通知、前台活跃抑制、睡眠窗回调静默与 5s 超时隔离（仅依赖 `core/`）。
  - `api/pairing.ts` + `api/admin_routes.ts` + `api/app.ts`：补齐全部 Ring 1 14 个核心端点（`/auth/pair` 防伪造头爆破 429、`/genesis` BYOK `0600` 落盘与防覆写、`/media` SHA-256 原子写与 ETag、`/settings` 参数校验与脱敏读写、发消息触发未回重置）。

### 未完成（下一阶段）
- `server/src/index.ts` 启动串联（接入 `PairingManager`、`NotificationHub`、`circadian` 定时心跳、`tidy` 异步队列与每日 `VACUUM INTO` 7 份热备）。
- Flutter 薄客户端 MVP（`app/`：单地址配对连接、聊天流、折叠 `thinking`、门缝纸条输入、基础 `ExpressionRenderer`、可开关召回标注浮条）。

## 2. 验证结果（2026-11-20）
- `cd server && bun test`：6 个测试文件、21 个用例、219 项断言全部通过（100% 离线）。
- `cd server && bun run typecheck`：`tsc --noEmit` 零错误通过。
