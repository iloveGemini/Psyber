# Psyber

> **cyber + psyche** — 一个开源、本地优先、全栈可用的数字生命与长期陪伴系统。

Psyber 从「最终需要一个具备哪些能力的 AI Agent」出发反向推导架构，将**常驻单进程后端**、**面向互动生长的代码库式记忆系统**、**分层工具与具身表达通道**以及**跨端 Flutter 客户端**收敛在同一个 Monorepo 中：

- **窗不跑生活（纯 C/S 架构）**：后端单进程常驻（Bun + SQLite + Hono + `@earendil-works/pi-ai` Direct Engine），Flutter 客户端覆盖 macOS / iOS / Android / Windows / Web。
- **代码库式活记忆 + 100% 第一人称主权**：磁盘 Markdown 仓是记忆卡片唯一真相（Git 留痕）；AI 用原生 5 文件工具（`glob`/`grep`/`read`/`write`/`edit`）自主读写，无第三方后台编译器代笔。
- **记忆服务于互动，而非通用知识库**：固定底座（`daily/`、`shelf/`、`favorite/`、`gist/`）+ 活目录（`activities/`、`entities/` 各自配 `REGISTRY.yaml`），实现「同活动强连续」+「跨活动高阈值向量互文」+「短期状态自动过期」。
- **具身表达、主体边界与三层工具治理**：用可调用的震动/光温/微动效/贴纸作为 AI 的身体语言出口；用「一扇可开可关的门 + 拆封必留痕的上锁抽屉 + 三段式离开权」代替无意义的多房间布景；用 `tool_search` + `call_tool` 在不破坏 Prompt Cache 的前提下优雅挂载 `bash`、`browser`、生图/生视频、观影与外部 MCP。
- **内置真实召回评测闭环**：日常纯净陪伴，随时可开启轻量「本轮召回标注」，在真实互动中积累黄金召回数据集。

---

## 文档阅读顺序（先从 0 号能力总纲读起）

0. [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) — **北极星总纲**：6 大能力支柱、7 条明确不做（Non-Goals）与 Ring 0/1/2 牵连面分层
1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 单仓拓扑、Direct Engine + `pi-ai`、三层工具治理、审批流、具身表达与扩展槽位
2. [`docs/MEMORY.md`](docs/MEMORY.md) — 活目录 Markdown 卡片仓、任务制写入、双轨召回与真实评测闭环
3. [`docs/API.md`](docs/API.md) — 面向 Flutter 的精简 REST + SSE 接口契约
4. [`docs/ROADMAP.md`](docs/ROADMAP.md) — 当前规划阶段（P0 → P1 执行规程）与后续 Ring 0/1/2 分期路线
5. [`STATE.md`](STATE.md) — 当前进度与交接备忘
