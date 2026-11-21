# Psyber 当前状态

> 开发交接用，不替代 `docs/` 中的架构与契约；全文保持精简（≲ 100 行）。
> 最后更新：2026-11-21（完成 Ring 1.5 外部 MCP 桥接与同步审批闭环；此前完成模型省钱护栏、消耗统计、双人头像、5 套色板、多版本修对话、上锁抽屉、双向撤回、分享卡与双人状态签）。

## 1. 当前阶段：Ring 1.5 外部 MCP 桥接与主体体验板块已落地

### 已完成
- **契约升级（2026-11-21，契约先行）**：全仓顶层契约（`CAPABILITIES.md` v1.4、`ARCHITECTURE.md` v0.8、`MEMORY.md` v0.8、`API.md` v0.8、`ROADMAP.md` v1.2）与执行规程（`Spec 01`–`04`）完成交叉一致性同步。
- **Ring 1.5 外部 MCP 桥接与同步审批（2026-11-21）**：
  - **后端（`server/src/extensions/mcp.ts`）**：零新增外部依赖实现 `stdio`（`Bun.spawn`）与 `streamable_http`（JSON / SSE）MCP 客户端与 `McpManager`；所有外部工具强制注册为 Tier 3 `mcp.<serverId>.<toolName>`（绝不进入 Tier 1 保护 Prompt Cache），敏感密钥经 `${cred:<key>}` 隔离于 `0600` `credentials.json`，异步非阻塞启动（10s 握手超时，单服故障降级 `degraded` 零阻塞），`stdio` 指数退避重连（`2s→10s→30s` 最多 3 次），单次调用超时与 **8000 字截断**，热重载优雅停进程（`SIGTERM → 3s SIGKILL`）；新增 `GET /api/v1/mcp/presets`、`POST /api/v1/mcp/:id/reconnect` 与 `POST /api/v1/turns/:turnId/approval`（默认 `confirm` 审批挂起与多端 SSE 销除）。
  - **前端（`app/`）**：设置页新增「外部工具扩展（MCP）」分区（支持 5 套常用开源生态预设一键填入、自定义添加、状态胶囊、手动重连与移除）；聊天流新增同步工具审批确认卡（仅本次允许 / 本会话允许 / 拒绝）。
- **Ring 1.5 模型省钱护栏、消耗统计与居所氛围（2026-11-21，不含 `digest`）**：主备降级链、`thinking.level`、双上下文上限、`/llm/models` & `/llm/test`、`/usage/stats`、双人头像与 5 套暖调手账色板。
- **Ring 1.5 对话修整、隐私边界与聊天流升级（2026-11-21）**：静默多版本修对话与 3 秒防误触删除、双向社交撤回、上锁抽屉、主动折叠分享卡、关门一次性紧急通道、双人状态签、沉默 vs 故障隔离、原地重试与手动存记忆换段。

### 下一步
- 在本机终端执行 `cd app && flutter test` 复验新增的外部 MCP 与审批卡测试（共 20 组 Widget 用例）。
- 按需继续推进 Ring 1.5 剩余项：多端点竞速 + SSE 500 帧环形缓冲（`streamSeq`/`sync.reset`）与 Bark/ntfy/GFS、观影伴看（`cinema`）插件，或 `digest` 附件摘要槽位。

## 2. 验证结果
- **`server/`（2026-11-21 终改后实测）**：`bun run typecheck` 零错误；`bun test`（13 文件 / 41 用例 / 486 断言，含新增 `mcp_bridge.test.ts`）全部通过。
- **`app/`（2026-11-21 终改后实测）**：`dart analyze` 校验全部修改业务文件零语法/类型错误；`flutter test` 待本机终端复跑全部 20 组用例。
