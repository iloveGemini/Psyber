# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-20（完成全仓契约审阅与二次交叉对齐：统一 `private/` 纯独立工具、C2.7 非阻塞复核、移除 `systemBusy` 残留、精确对齐 15 REST + 1 SSE 与 8 类 SSE 事件、补齐 `card_fts`/`events.seq`/`genesis` 密钥与静态贴纸衔接，准备启动 `server/` 最小切片编码）。

## 1. 当前阶段：Ring 1 极简 MVP 契约已终审定稿 → 启动 `server/` 代码落地

### 本次裁剪与审阅对齐决策（2026-11-20）
- **移除过早复杂度**：砍掉 4 分钟 1-token Cache 保活、`>40k & 25min` 温热换段、`CONTEXT_OVERFLOW` 前台 `systemBusy` 忙态（改为 75% 直接切新 `session_id` + 旧会话后台异步整理）。
- **单队列与单轮写作**：Ring 1 记忆整理收敛为单队列串行消费 `events` + 单轮写作 + Git 提交；C2.7 独立复核降级为 Ring 1.5 可选非阻塞项（失败仅打告警，绝不回滚阶段 A 已写卡片）。
- **极简 3 步召回与纯 `memory/` 沙箱**：Ring 1 原生 5 工具仅操作 `memory/`；召回落「活动目录直挂 + Embedding 余弦（降级 FTS5 2-gram）+ 过期/2h 去重」，IDF/单字 `LIKE`/`reranker`/`access_count` 延寿延后至攒够 ≥ 100 条真实 `recall_feedback` 后的 Ring 1.5。
- **独立功能分期至 Ring 1.5 / Ring 2**：上锁抽屉（独立 `drawer_read`/`drawer_write` 工具物理隔离）、观影 `cinema`、外部 MCP、`Edit`/`Reroll`/`Version` 四态版本组、远端 OAuth、多地址竞速、SSE 500 条环形缓冲与 `streamSeq`、Bark/ntfy 独立适配、三时区 DST 矩阵与 GFS 三级备份统一后移；Ring 1 聚焦 **15 个 REST + 1 个 SSE（共 16 个核心端点）+ 8 类 SSE 事件（+ `ping`）+ 5 套核心端到端测试**。

### 已同步定稿文档
- 顶层契约：`docs/CAPABILITIES.md`（v1.3）、`docs/ARCHITECTURE.md`（v0.7）、`docs/MEMORY.md`（v0.7）、`docs/API.md`（v0.7）、`docs/ROADMAP.md`（v1.1）。
- 执行规程：`docs/spec/01`（v1.1）、`02`（v0.7）、`03`（v0.4）、`04`（v0.4）、`05`（v0.4）。
- 提示词：`prompts/main.md`（v5）、`prompts/tidy.md`（v4）、`prompts/README.md`、`prompts/review.md` & `revision.md`（已标 Ring 1.5 可选启用）。

## 2. 下一步行动
1. （可选，公开推送前必做）匿名化当前分支 6 个历史提交的 Git 作者元数据（`AGENTS.md` 开源红线），并提交本轮 Ring 1 契约对齐变更。
2. 启动 `server/` 第一批可运行代码切片：Bun + Hono + `bun:sqlite`（`events` + `card_index` + `card_fts` + `stickers`）+ 纯 `memory/` 5 工具沙箱 + `pi-ai` 基础对话循环 + 首套离线测试。

## 3. 验证结果（2026-11-20）
- 已完成 13 份契约与提示词文档终审对齐（修复 6 项高优冲突、5 项中优残留与 3 项工程边界细节）；当前未落业务代码，无测试套件需运行。
