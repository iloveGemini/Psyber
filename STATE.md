# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-20（已完成 `server/` Ring 1 切片 1 + 切片 2 落地与双轴审查修复：极简 3 步召回接入主对话与 `recallCount`、换段 `<gist>`+近 6 轮过渡、429/5xx 退避重试、贴纸同步与校验、`index.ts` 全链路装配、单向依赖与共享 `AsyncMutex`，5 个离线测试套件 17 个用例全部通过）。

## 1. 当前阶段：Ring 1 极简 MVP 后端核心闭环已完成（切片 1 + 切片 2 全绿）

### 已完成
- **切片 1（底座与记忆沙箱）**：`core/`（`clock.ts`、`mutex.ts`、`ulid.ts`、`db.ts`、`config.ts` 含设备 Token 哈希、`RecallConfig` 与原子写、`git.ts`、`prompts.ts` 读时现读与共享 `stripFrontmatter`）、`store/events.ts`（只追加 `events`、幂等、未读门缝纸条分页游标与贴纸清单）、`memory/`（`frontmatter.ts`、`fts.ts`、`gist.ts`、`index.ts`、`tools.ts` 原生 5 记忆工具沙箱）。
- **切片 2（召回、工具、Direct Engine 与 SSE）**：
  - `memory/recall.ts`：Ring 1 极简 3 步召回（空档短路、活动 `REGISTRY.yaml` 触发直挂、Embedding 余弦 + 超时降级 FTS5、72h 近期日常、关联 `active` 助手回复的 2h 去重与续接豁免、`recall_traces` / `recall_feedback`）。
  - `expression/{express,stickers}.ts` + `tools/{registry,core_tools}.ts`：Tier 1 固定 9 工具 ASCII 冻结、`door` Ring 1 守卫、`express` 贴纸库校验/计数/时长夹逼与单轮 3 次节流、`read` 仅主对话累加 `access_count`、`tool_search` + `call_tool` 按需调 Tier 3。
  - `llm/client.ts` + `engine/{direct,sse}.ts`：`@earendil-works/pi-ai` 流式适配、三明治上下文（Static Prefix 快照 + `<prefix_delta>` + 跨轮剥除 `thinking` + 单轮多步保留 `thinkingSignature` + 工具调用留痕）、429/5xx 指数退避重试、`wake` `[SILENT]` 前 16 字符暂缓推流、75% 异步换段（注入 `<gist>` + 近 6 轮过渡）与核心 SSE 广播（含软删 `message.updated`）。
  - `api/app.ts` + `index.ts`：Bearer Token 鉴权中间件、`/health`、`/door`、`/chat/history`、`/chat/messages`、`/stream`、`DELETE` 软删广播、`/turns/:turnId/{abort,recall}`、`/recall/feedback` 与启动入口全链路装配（含静态贴纸同步）。

### 未完成（切片 3）
- 扁平作息心跳（`circadian.ts`）、单轮异步整理任务（`daily_wrapup` / `bedtime` + `gist/days` & `weeks`）、`desktop` + `webhook` 离线通知、一次性配对码 `/auth/pair` & `/genesis` & `/media` & `/settings`，以及 Flutter 薄客户端 MVP。

## 2. 验证结果（2026-11-20）
- `cd server && bun test`：5 个测试文件、17 个用例、162 项断言全部通过（100% 离线）。
- `cd server && bun run typecheck`：`tsc --noEmit` 零错误通过。
