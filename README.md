# Psyber

> **cyber + psyche** — 一个开源、本地优先、全栈可用的数字生命与长期陪伴系统。

Psyber 从「最终需要一个具备哪些能力的 AI Agent」出发反向推导架构，将**常驻单进程后端**、**面向互动生长的代码库式记忆系统**、**分层工具与具身表达通道**以及**跨端 Flutter 客户端**收敛在同一个 Monorepo 中：

- **窗不跑生活（纯 C/S 架构）**：后端单进程常驻（Bun + SQLite + Hono + `@earendil-works/pi-ai` Direct Engine），Flutter 客户端覆盖 macOS / iOS / Android / Windows / Web。
- **代码库式活记忆 + 100% 第一人称主权**：磁盘 Markdown 仓是记忆卡片唯一真相（Git 留痕）；AI 用原生 5 文件工具（`glob`/`grep`/`read`/`write`/`edit`）自主读写，无第三方后台编译器代笔。
- **记忆服务于互动，而非通用知识库**：六大职责单一目录（`core/` 常驻成果、`episodes/` 年/月/日分形情景树、`threads/` 跨天内容线、`lessons/` 按场景触发经验、`entities/` 实体档案、`favorite/` 逐字原话收藏），以相对路径 Markdown 链接去重，并由 AI 基于 `covered_until` 与共享预算水位自主滚动梗概。
- **具身表达、主体边界与三层工具治理**：用可调用的震动/光温/微动效/贴纸作为 AI 的身体语言出口；用「一扇可开可关的门 + 拆封必留痕的上锁抽屉 + 三段式离开权」代替无意义的多房间布景；用 `tool_search` + `call_tool` 在不破坏 Prompt Cache 的前提下优雅挂载 `bash`、`browser`、生图/生视频、观影与外部 MCP。
- **动态 BYOK 路由与零重启热切换**：原生支持 `openai`、`anthropic`、`google` 与 `openai-compat`（兼容 DeepSeek / Ollama / LocalAI / 自建网关），支持初生引导与运行期动态切换模型槽位。
- **内置真实召回评测闭环**：日常纯净陪伴，随时可开启轻量「本轮召回标注」，在真实互动中积累黄金召回数据集。

---

## 快速开始

### 1. 环境准备

- [Bun](https://bun.sh/)（>= 1.2）
- [Flutter SDK](https://docs.flutter.dev/get-started/install)（>= 3.24）

### 2. 启动常驻服务端

进入 `server/` 目录，安装依赖并启动：

```bash
cd server
bun install

# 试跑或测试推荐使用隔离目录（PSYBER_DATA_DIR=~/.psyber/test）
PSYBER_DATA_DIR=~/.psyber/test bun run start
```

- **首次配对**：控制台会自动输出一组 8 位 Crockford Base32 一次性配对码（如 `K7M9-P2XQ`，5 分钟有效）。
- **配对新设备 / 随时补发配对码**：
  - **交互式控制台**：服务端运行期间，在控制台直接输入 `p` 或 `pair` 并按回车，即可现场签发新配对码；
  - **命令行启动选项**：执行 `bun run pair`（或 `bun run start --pair`），强制生成新配对码。

### 3. 启动 Flutter 客户端

进入 `app/` 目录：

```bash
cd app
flutter pub get

# 启动 macOS 原生桌面端
flutter run -d macos

# 或启动到其他平台（Chrome / 模拟器 / 真机）
# flutter run -d chrome
```

1. **绑定配对**：在配对界面输入后端地址（默认 `http://localhost:3721`）与终端打印的一次性配对码；
2. **初生引导（Genesis）**：按向导设置作息习惯、用户称呼/代词与首选模型凭证（BYOK），保存后即刻开启首段陪伴；
3. **日常互动**：支持消息对话、门缝纸条输入切换、发图上传待发预览条、贴纸面板展开与具身表达渲染。

### 4. 历史对话导入与按天回放（Replay）

仓库内置了按天推进、支持断点续跑的回放脚本 [`server/scripts/replay.ts`](server/scripts/replay.ts)。你可以先让任意 AI 将 ChatGPT / Claude / SillyTavern 等历史记录转换为**标准 JSONL 导入格式**，再用本脚本按自然日导入并运行静默整理（脚本也向下兼容旧 Psyche `.db` 库，按文件后缀自动识别）：

**标准 JSONL 导入格式**（每行一条 JSON，必填 `at` / `role` / `text`，其余可选）：

```jsonl
{"at":"2026-10-11T23:34:00+08:00","role":"user","text":"睡前聊到我睡着，你负责找话题"}
{"at":"2026-10-11T23:34:25+08:00","role":"assistant","text":"好呀，先讲个海獭睡觉的冷知识。"}
{"id":"m-3","at":"2026-10-12T00:18:10+08:00","role":"user","text":"你看这张照片","session":"s1","attachments":["./media/cat.jpg"]}
```

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `at` | 是 | ISO 8601 时间字符串（推荐带时区）或 Unix 毫秒时间戳 |
| `role` | 是 | `"user"` 或 `"assistant"` |
| `text` | 是 | 消息正文（带图片时可为空字符串） |
| `id` | 否 | 源消息唯一 ID，用于幂等去重（省略则自动生成） |
| `session` | 否 | 源会话标识（省略按天归组） |
| `attachments` | 否 | 图片文件路径数组（相对 JSONL 所在目录或绝对路径，自动入库去重） |
| `source` | 否 | 源平台标记（如 `"chatgpt"` / `"claude"`，默认 `"jsonl"`） |

**导入与回放命令**：

```bash
cd server

# 1. 查看源件活跃日统计与当前回放进度
bun run replay -- --source /path/to/import.jsonl --data-dir ~/.psyber/test --status

# 2. 初始化目标目录（写入初始 core/self.md、core/user.md 及注册表，保留已有模型配置与密钥）
bun run replay -- --source /path/to/import.jsonl --data-dir ~/.psyber/test \
  --user-name 小夏 --user-pronoun 她 --init

# 3. 零成本干跑 2 天验证全链路（不调用真实模型）
bun run replay -- --source /path/to/import.jsonl --data-dir ~/.psyber/test --mock --days 2

# 4. 使用真实 memory_task 模型按天推进（支持 --days N / --until YYYY-MM-DD / --all）
bun run replay -- --source /path/to/import.jsonl --data-dir ~/.psyber/test --days 1

# 5. 调整提示词或代码后重置测试库（保留 config.json 与 credentials.json）
bun run replay -- --source /path/to/import.jsonl --data-dir ~/.psyber/test --reset
```

> 安全保护：脚本禁止指向正式目录 `~/.psyber/default`，并会自动记录断点（`replay_state.json`）；任一天整理失败会自动回滚磁盘且不推进游标，直接重跑即可原地续跑。

---

## 项目结构

```text
Psyber/
├── server/               # 常驻单进程后端（Bun + TypeScript ESM + SQLite + Hono）
│   ├── src/
│   │   ├── core/         # 时钟、配置、数据目录、SQLite 迁移与 VACUUM INTO 备份
│   │   ├── store/        # 只追加事件表 events 与状态模型
│   │   ├── memory/       # 5 记忆工具、Markdown 扫描、FTS5/向量索引与双轨召回
│   │   ├── tools/        # 三层工具注册中心、安全守卫与审批状态机
│   │   ├── expression/   # 具身表达工具 express 与贴纸包管理
│   │   ├── llm/          # 动态 BYOK 路由与 4 类模型客户端
│   │   ├── engine/       # Direct Engine 三明治上下文、SSE 推流与后台整理任务
│   │   ├── mood/         # 作息心跳与主动唤醒
│   │   ├── notifications/# 离线通知 Hub（桌面通知与 Webhook）
│   │   └── api/          # Hono REST + SSE 路由、鉴权与配对/媒体/设置端点
│   └── tests/            # 100% 离线测试用例
├── app/                  # 跨端 Flutter 客户端（原生 SDK，零第三方 pub 依赖）
│   ├── lib/
│   │   ├── core/         # 数据模型、网络通信、Session 持久化与状态控制器
│   │   ├── expression/   # 具身表达渲染器（光温遮罩、触觉与微动效）
│   │   ├── features/     # 配对页、创世引导页、时间线与聊天面板
│   │   └── shared/       # 温暖柔和的主题系统与通用组件
│   └── test/             # 离线 Widget 与状态单元测试
├── prompts/              # Psyber第一人称提示词原稿
├── docs/                 # 系统架构、能力总纲、记忆模型与执行契约
│   └── spec/             # Ring 0/1 详细工程执行规程（Spec 01–05）
└── STATE.md              # 进展追踪与开发交接
```

---

## 质量验证

遵循契约先行与可验证原则，前后端均包含完整的离线测试套件：

```bash
# 后端测试与类型检查（26 个测试套件，274 项断言）
cd server
bun test
bun run typecheck

# 客户端测试与静态代码分析
cd app
flutter analyze
flutter test
```

---

## 文档阅读顺序（从 0 号能力总纲读起）

0. [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) — **北极星总纲**：6 大能力支柱、7 条明确不做（Non-Goals）与 Ring 0/1/2 牵连面分层
1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 单仓拓扑、Direct Engine + `pi-ai`、三层工具治理、审批流、具身表达与扩展槽位
2. [`docs/MEMORY.md`](docs/MEMORY.md) — 活目录 Markdown 卡片仓、任务制写入、双轨召回与真实评测闭环
3. [`docs/API.md`](docs/API.md) — 面向 Flutter 的精简 REST + SSE 接口契约
4. [`docs/ROADMAP.md`](docs/ROADMAP.md) — 当前规划阶段（P0 → P1 执行规程）与后续 Ring 0/1/2 分期路线
5. [`STATE.md`](STATE.md) — 当前进度与交接备忘
