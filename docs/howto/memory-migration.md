# 记忆搬家指南：把老聊天记录迁入 Psyber

如果你以前在 ChatGPT、Claude、Gemini、SillyTavern 或旧版 Psyche 里和 AI 聊过几周、几个月甚至一整年，希望让 Psyber 带着这段过往记忆继续陪你，可以按本指南完成迁移。

Psyber 提供**两种搬家方式**（底层共用同一套逻辑作息日切分、低量日攒批、双注册表与断点续跑体系）：

| 方式 | 适合谁 | 费用与模型 | 特点 |
| :--- | :--- | :--- | :--- |
| **方式一：内置回放脚本（`bun run replay`）** | 对话量适中（几天～几周）、希望全自动无人值守跑完的用户 | 消耗你在 Psyber `config.json` 里配置的按量付费 API（`memory_task` + 可选 `decision`/`embedding`） | 一条命令从头跑到尾，适合已配好 BYOK API、不想手动开客户端的同学 |
| **方式二：订阅制外部客户端 + MCP（`memory_replay`）** | 聊天记录长达数月～一年、按量 API 太贵，但手头有 **Claude Code / Cursor / Gemini 桌面端 / Codex** 等包月客户端的用户 | **零额外按量 API 费用**（走外部客户端自己的订阅额度） | 先用脚本零成本导入原文，再由外部客户端按步领任务、写卡片、交卷推进；断了重开窗口也能原地续跑 |

> **两种方式进度互通**：底层共用 SQLite 游标（`daily_wrapup` / `bedtime` / `reflect_*`）与 `replay_state.json`。你可以今天用脚本跑 3 天，明天改用 MCP 接着往后跑。

---

## 一、准备工作（两种方式共用）

### 1. 准备标准 JSONL 对话文件

先让任意 AI 助手或小脚本把你导出的历史聊天整理成 **JSONL 格式**（每行一条 JSON 消息；如是从旧版 Psyche `.db`/`.sqlite` 迁移，脚本会按文件后缀自动识别，无需转 JSONL）：

```jsonl
{"at":"2026-06-12T22:34:00+08:00","role":"user","text":"周五下班买了一杯手冲咖啡，边走边听歌。"}
{"at":"2026-06-12T22:34:25+08:00","role":"assistant","text":"听起来这一周收尾得很松弛呀。"}
{"id":"m-3","at":"2026-06-13T00:18:10+08:00","role":"user","text":"你看这张照片","session":"s1","attachments":["./media/coffee.jpg"]}
```

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `at` | 是 | 消息时间：ISO 8601 字符串（建议带时区，如 `+08:00`）或 Unix 毫秒/秒时间戳 |
| `role` | 是 | `"user"`（你）或 `"assistant"`（AI） |
| `text` | 是 | 消息正文（带图片时可为空字符串 `""`） |
| `id` | 否 | 源消息唯一 ID，用于重复导入时幂等去重（省略则按行号与内容自动生成） |
| `session` | 否 | 原会话标识（省略则按「逻辑作息日」自动归组） |
| `attachments` | 否 | 图片路径数组（支持相对 JSONL 所在目录或绝对路径，会自动存入 `media/` 并去重） |
| `source` | 否 | 原平台标记（如 `"chatgpt"` / `"claude"`，默认 `"jsonl"`） |

### 2. 选定数据目录并先看一眼统计

> **安全拦截说明**：为防止手滑把实验数据写进默认正式库，`replay` 脚本**禁止直接指向 `~/.psyber/default`**。  
> 建议新建一个独立目录（例如 `~/.psyber/my-psyber`），搬家完成后直接用 `PSYBER_DATA_DIR=~/.psyber/my-psyber` 启动使用即可；如果一定要使用默认路径名，可等搬家全部结束后再整目录拷贝/改名。

先用 `--status` 预览源文件共有多少天、多少字（不写任何文件、不花钱）：

```bash
cd server
bun run replay -- --source /path/to/history.jsonl --data-dir ~/.psyber/my-psyber --status
```

---

## 二、方式一：使用内置脚本 `bun run replay` 全自动搬家

如果你已经在 `~/.psyber/my-psyber/config.json` 与 `credentials.json` 配好了模型槽位（尤其是 `memory_task`），可以直接按天回放：

```bash
cd server

# 1. 初始化目录、Git 记忆仓与初始身份档案（保留已有 config.json 与密钥）
bun run replay -- --source /path/to/history.jsonl --data-dir ~/.psyber/my-psyber \
  --user-name 小夏 --user-pronoun 她 --init

# 2. 零成本干跑 2 天验证流程是否畅通（使用内置 Mock 模型，不请求真实 API）
bun run replay -- --source /path/to/history.jsonl --data-dir ~/.psyber/my-psyber --mock --days 2

# 3. 如果刚才是 --mock 干跑，正式开跑前先重置回干净初始态（保留 config.json 与 credentials.json）
bun run replay -- --source /path/to/history.jsonl --data-dir ~/.psyber/my-psyber --reset \
  --user-name 小夏 --user-pronoun 她

# 4. 用真实模型推进（三选一，随时可 Ctrl+C 中断，下次原命令继续）
bun run replay -- --source /path/to/history.jsonl --data-dir ~/.psyber/my-psyber --days 3
bun run replay -- --source /path/to/history.jsonl --data-dir ~/.psyber/my-psyber --until 2026-06-30
bun run replay -- --source /path/to/history.jsonl --data-dir ~/.psyber/my-psyber --all
```

常用补充选项：
- `--min-chars <N>`：低量日攒批阈值（默认 `500` 字；聊得很少的平淡日会自动并入下一天一起消化，设 `0` 则每天必跑）。
- `--tz <iana>`：切分作息日的时区（默认 `Asia/Shanghai`）。
- `--resident-name <name>`：可选预设 AI 的名字；留空则保持未定名态，留给你们在后续对话里自然定名。

---

## 三、方式二：使用外部订阅制客户端 + MCP（`memory_replay`）搬家

这套方式把最耗 Token 的「读对话 + 写记忆卡片」交给 **Claude Code / Cursor / Gemini 桌面端** 等订阅制客户端完成，Psyber 服务端只负责**按天派发任务包、保管游标、统一 Git 提交与防回家重跑**。

### 第 1 步：零模型成本导入全部历史原文

> ⚠️ **注意加上 `--all`**：`replay` 脚本默认只推进 `--days 1`（1 天），导入原文务必加上 `--all` 才能把整份文件的全部日期一次导进 SQLite `events` 表和 `media/` 仓！

```bash
cd server
bun run replay -- --source /path/to/history.jsonl --data-dir ~/.psyber/my-psyber \
  --user-name 小夏 --user-pronoun 她 --init --import-only --all
```

完成后可用 `--status` 确认所有日期的「导入」列都已是 `✅`。

### 第 2 步：签发 MCP 令牌并开启搬家开关

Psyber 的外部 MCP 默认完全关闭，且搬家工具 `memory_replay` 需要**三重门控全开**（`enabled` + `read_write` + `--replay`）才会暴露：

```bash
cd server

# 1. 为你的外部客户端签发专属令牌（加 --save-stdio 会把凭证安全存为 0600 文件，方便桌面端 stdio 直连）
bun run mcp -- --data-dir ~/.psyber/my-psyber token create --name claude-code --mode read_write --save-stdio

# 2. 开启对外记忆 MCP 与搬家模式（进入「出差互斥模式」）
bun run mcp -- --data-dir ~/.psyber/my-psyber enable --mode read_write --replay
```

按终端打印的配置示例接入你的客户端（任选一种传输方式）：
- **Streamable HTTP**（适合 Claude Code / Cursor 等支持 HTTP MCP 的客户端）：直接粘贴终端输出的 `url`（默认 `http://127.0.0.1:3721/mcp`）与 `Authorization: Bearer psbm_...` 请求头；
- **本地 `stdio` 转发桥**（适合只支持命令行启动 MCP 的桌面端）：直接把终端打印的那行 `bun run .../mcp_stdio.ts --data-dir ...` 填进客户端「命令」框即可（已在内部转发到本机 `/mcp`，不直连数据库）。

> **关于核心档案保护（`protectCoreFiles`）**：
> - 默认开启（推荐）：搬家期间**允许更新 `core/state.md`（近期状态看板）和周反思期的 `core/open.md`（未完挂念）**，但会继续锁住 `core/self.md`、`core/user.md`、`core/boundaries.md`、`core/mirror.md` 不被外部直接改写。
> - 如果你在搬家时也希望客户端顺手帮你提炼修改 `core/user.md` 等档案，可在 `enable` 时额外加上 `--allow-core`（仍禁止整篇覆写 `core/self.md` 与 `core/user.md`，必须用 `memory_edit` 局部修改）。

### 第 3 步：启动服务端（供客户端连入 `/mcp`）

```bash
cd server
PSYBER_DATA_DIR=~/.psyber/my-psyber bun run start
```

（提示：正常启动后开启 `memoryMcp` 会自动暂停内部作息心跳与自动整理，Flutter 聊天写接口会返回 `409 MCP_ACTIVE` 防止记忆分叉；搬完家执行 `disable` 后无需重启即可热切换恢复正常聊天。如果你只想纯跑 MCP 不监听局域网，也可用 `bun run start --mcp-only`。）

### 第 4 步：在外部客户端里开始整理（可直接复制指令）

连上 `psyber-memory` MCP 后，直接在客户端对话框里这样发指令：

#### ① 开始搬家（建议一次先跑 3～7 天，方便抽查卡片质量）
> 先调用 `memory_context` 了解基础设定，然后调用 `memory_replay(action="start", days=3)`。  
> 每一步请严格以第一人称、按任务包里的规范用 `memory_write` / `memory_edit` / `memory_read` 整理记忆卡片；本步全部写完后，**务必带上该步的 `step_id` 调用 `memory_replay(action="next", step_id=..., summary=...)`** 提交并领取下一步，不要只回复 JSON 文本，直到返回 `status: finished` 为止。

如果要一口气整理到某个日期或全部跑完，把指令里的 `days=3` 换成 `until="2026-07-01"` 或 `all=true` 即可。

#### ② 断线 / 额度用完 / 换了一个新聊天窗口续跑
> 请先调用 `memory_context` 恢复上下文，然后直接调用 `memory_replay(action="next")`（不需要自己猜 `step_id`）继续上次未完成的搬家任务，并按步骤完成到 `status: finished`。

- **防跳步保护**：新窗口不带 `step_id` 调用 `next`（或重调 `start`）时，Psyber 发现有未结算的在途步骤，会**把上次断掉那一步的任务包和已写卡片清单原样发回来**，绝不会跳过未整理完的对话。

#### ③ 查看进度或写歪了想回滚重来
- 查看剩余天数与在途状态：让 AI 调 `memory_replay(action="status")`。
- 某一步写歪了想安全撤回：让 AI 调 `memory_replay(action="abort", rollback=true)`。这只会删除本步新建的草稿、还原被修改的旧卡片并重建索引，**绝不会误删你在 `memory/` 里自己放的杂文件，也不会推进游标**。

### 第 5 步：搬家完成，关闭 MCP 回家聊天

全部整理完后，关闭出差模式并切回正常陪伴：

```bash
cd server

# 查看搬家进度与开关状态
bun run mcp -- --data-dir ~/.psyber/my-psyber status

# 关闭对外记忆 MCP（若还有未结算步骤，终端会打印醒目提醒）
bun run mcp -- --data-dir ~/.psyber/my-psyber disable
```

关闭后：
- 如果服务端正在运行，会自动热重载恢复作息心跳、`memoryIndex.reindexAll()` 全量重建索引并刷新 `DirectEngine` 静态前缀；
- 搬家过程每完成一天都已同步推进 `daily_wrapup`、`bedtime`（`last_gist_date`）以及 `reflect_daily` / `reflect_weekly` 游标——**回家后无论热切换还是重启，Psyber 都不会把几个月前的历史对话再重新整理或全量反思一遍**。
- 之后直接以 `PSYBER_DATA_DIR=~/.psyber/my-psyber bun run start` 启动服务端并配对 Flutter 客户端，就可以带着全部历史记忆继续聊天了！

---

## 四、常见问题排查（FAQ）

1. **为什么运行 `--import-only` 后用 `--status` 看只导入了第 1 天？**  
   `bun run replay` 默认 `--days 1`。导入全部历史原文时请务必加上 `--all`。
2. **为什么开启了 MCP，外部客户端工具列表里还是看不见 `memory_replay`？**  
   请运行 `bun run mcp -- --data-dir <dir> status` 检查三重门控是否同时满足：
   - 服务状态已开启（`enabled = true`）；
   - 全局权限和该令牌权限均为 `read_write`（创建令牌时若带了 `--mode read_only` 会被单令牌降权）；
   - 搬家任务工具已开启（`replayToolsEnabled = true`，即 `enable` 时加了 `--replay`）。
3. **我在搬家时用 `memory_write` 写了卡片，为什么 `git log` 里当时没看到提交？**  
   这是刻意设计的优化：在 `memory_replay` 活跃步骤内，每次写入只先落盘、更新索引并按**该历史日时钟**校准日期；等你调用 `memory_replay(action="next", step_id=..., summary=...)` 交卷时，服务端才会把整步改动合并为一次规范 Git Commit。这样既不会把仓库刷满碎片提交，也让 `abort(rollback=true)` 可以干净撤销整步。
4. **单天聊了上万字，会不会被 MCP 的 `maxOutputChars`（默认 12,000 字）截断导致丢记忆？**  
   不会。超长单日会按 `turn_id` 对话轮次边界自动拆成多批（`wrapup_part: 1/N`），且 `memory_replay` 专门豁免了全局 `maxOutputChars` 截断上限，确保已纳入批次的对话完整送达。
5. **怎样确认正式库没有被测试或误操作污染？**  
   日常测试请始终使用 `PSYBER_DATA_DIR=~/.psyber/test`；正式库请使用独立目录（如 `~/.psyber/my-psyber`）。搬完家后如果不放心，可以用 `bun run mcp -- --data-dir ~/.psyber/my-psyber token list` 或 `disable` 收口权限。
