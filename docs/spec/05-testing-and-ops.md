# Spec 05 · 测试矩阵、虚拟时钟、SQLite 灾备与运维编排规程

> **版本**：v0.1（2026-11-19，初稿定稿，覆盖虚拟时钟 `Clock` 注入、三时区回归矩阵、100% 离线测试 Mock 体系、Git 精准提交边界测试、SQLite `VACUUM INTO` 灾备轮转与单进程一键启动编排）
> **上游契约**：[`CAPABILITIES.md`](../CAPABILITIES.md) v1.2 · [`ARCHITECTURE.md`](../ARCHITECTURE.md) v0.5 · [`MEMORY.md`](../MEMORY.md) v0.5 · [`API.md`](../API.md) v0.4 · [`01-engine-tools-prompts.md`](01-engine-tools-prompts.md) v0.9 · [`02-memory-execution.md`](02-memory-execution.md) v0.5 · [`03-boundaries-expression-activities.md`](03-boundaries-expression-activities.md) v0.2 · [`04-api-and-flutter.md`](04-api-and-flutter.md) v0.1
> **负责模块**：`server/src/core/`（`clock.ts`, `backup.ts`）、`server/tests/`、`server/src/cli/`

---

## 0. 测试与运维四条铁律

1. **测试 100% 离线，零外部 API 依赖（遵守 `AGENTS.md` 红线）**：
   - 自动化单测、集成测试与 CI 流程**严禁发起任何外部网络请求**（包括 OpenAI、Anthropic、Google、Embedding 服务或外部 Webhook）；
   - 所有模型交互均通过确定性内存 Mock 驱动，确保毫秒级极速执行与零 Token 成本，任何网络波动不得造成测试挂起或误报。
2. **时间判定必须可注入、可快进（时间确定性）**：
   - 全库严禁直接调用 `Date.now()`、`new Date()` 获取未注入的系统时间；
   - 所有生命周期（作息、到期、冷静期、Token 刷新、心跳）必须通过 `Clock.now()` 驱动，保证能在单测中以微秒级“快进 10 天”或“跨越夏令时”验证演化逻辑。
3. **数据目录单点闭环，随拷随走（本地优先零外部状态）**：
   - 单住户实例的一切状态（SQLite、Git、封条日记、媒体、凭证）严格收敛于 `<dataDir>` 内部；
   - 绝不依赖系统全局注册表、外部数据库或隐藏后台服务；迁移或灾备只需对 `<dataDir>` 做一致性归档。
4. **备份绝不锁表，提交绝不误伤（稳态生产准绳）**：
   - 数据库热备份强制采用 SQLite 原生 `VACUUM INTO`，与前台读写事务完全无锁并发；
   - Git 自动化提交严格限定在 `MemoryTx` 显式记录的白名单路径，严禁 `git add -A`，严禁 `git reset --hard`。

---

## 1. 虚拟时钟 `Clock` 注入与三时区确定性测试矩阵

### 1.1 `Clock` 接口与运行时实现（`server/src/core/clock.ts`）

```ts
export interface Clock {
  /** 当前 Unix 毫秒时间戳 */
  now(): number;
  /** 当前配置的 IANA 时区（如 "Asia/Shanghai"） */
  readonly timeZone: string;
}

/** 生产环境系统时钟 */
export class SystemClock implements Clock {
  constructor(public readonly timeZone: string) {}
  now(): number {
    return Date.now();
  }
}

/** 测试环境可快进虚拟时钟 */
export class VirtualClock implements Clock {
  private currentMs: number;

  constructor(initialMs: number, public timeZone: string) {
    this.currentMs = initialMs;
  }

  now(): number {
    return this.currentMs;
  }

  /** 手动设定时间 */
  setTime(ms: number): void {
    this.currentMs = ms;
  }

  /** 快进指定毫秒（如 advance(10 * 86_400_000) 快进 10 天） */
  advance(ms: number): void {
    this.currentMs += ms;
  }

  /** 跳转至特定墙上时间（如 2026-11-20 23:35:00） */
  jumpToWallClock(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): void {
    this.currentMs = fromWallClock(this.timeZone, year, month, day, hour, minute, second);
  }
}
```

### 1.2 三时区回归测试矩阵（DST 与跨年边界）

时钟计算逻辑（`localDay`, `wallClock`, `vagueWhen`, `addCalendarDays`）必须在自动化测试中对以下三类代表性时区进行全覆盖回归：

| 时区标识 | 代表特征 | 关键攻防测试点 |
| :--- | :--- | :--- |
| **`Asia/Shanghai`** (UTC+8) | 恒定固定偏移、无夏令时（典型东八区基准） | 跨午夜零点切日、月末 28/29/30/31 天递进、元旦跨年 |
| **`America/New_York`** (UTC-5 / UTC-4) | 存在夏令时（DST）、春季 23 小时日、秋季 25 小时日 | 春季跳时（02:00 跳 03:00）作息窗判定、秋季回拨（01:00 重复两次）`daily/` 状态卡 `expires_at` 日历日加减不产生 1 小时漂移 |
| **`Europe/London`** (UTC+0 / UTC+1) | 格林威治标准时间与英夏令时切换、零时区对齐 | `vagueWhen` 判定、ISO 周（周一跨月/跨年）计算 |

#### 必须通过的确定性测试断言：
1. **夏令时 23h/25h 免疫**：在 `America/New_York` 时区下，于秋季回拨日前一天创建 `ttl_days: 10` 的短期状态卡，其 `expires_at` 解析出的本地时间必须严格等于第 10 天的 `00:00:00`，绝不因 25 小时日产生 `23:00:00` 的偏差；
2. **跨午夜睡前整理不跑重**：在 `sleepStart: "23:30"`, `sleepEnd: "07:30"` 配置下，时钟在 `23:45` 触发了一次 `bedtime`，时钟步进至次日 `00:15`（仍在睡眠窗内），心跳判定必须返回 `{ action: "idle" }`，**严禁同一夜晚重复触发两次 `bedtime`**；
3. **ISO 周跨年不拆分**：遇到 12 月 31 日是周四的情形，该整周统一归入当年的 ISO 周编号，`gist/weeks/` 跨月周整条写进当年度文件。

---

## 2. 100% 离线测试架构与 Mock 体系

### 2.1 极薄分层 Mock 接口（`server/tests/mocks/`）

```ts
// 1. MockChatModel（主对话与整理轮测试）
export class MockChatModel {
  private cannedResponses: Array<(messages: unknown[]) => string | { text?: string; toolCalls?: Array<{ name: string; args: unknown }> }> = [];

  queueResponse(fn: (messages: unknown[]) => string | { text?: string; toolCalls?: Array<{ name: string; args: unknown }> }): void {
    this.cannedResponses.push(fn);
  }

  async invoke(messages: unknown[]): Promise<ModelOutput> {
    const handler = this.cannedResponses.shift();
    if (!handler) throw new Error("MockChatModel: unexpected call with no queued response");
    const result = handler(messages);
    if (typeof result === "string") return { text: result, toolCalls: [] };
    return { text: result.text ?? "", toolCalls: result.toolCalls ?? [] };
  }
}

// 2. MockEmbeddingModel（确定性可预测向量）
export class MockEmbeddingModel implements EmbeddingClient {
  readonly dim = 64;

  /** 基于文本 SHA-256 哈希与字符词袋生成确定性 L2 归一化 Float32Array */
  async embed(text: string): Promise<Float32Array> {
    return deterministicBagOfWordsVector(text, this.dim);
  }
}

// 3. MockNotificationProvider（通知留痕）
export class MockNotificationProvider implements NotificationProvider {
  readonly channel = "mock";
  public readonly sent: Array<{ kind: string; title: string; body: string }> = [];

  async notify(payload: { kind: string; title: string; body: string }): Promise<void> {
    this.sent.push(payload);
  }
}
```

### 2.2 隔离测试环境工厂（`createTestContext`）

每个测试用例独占一个完全沙箱化的临时目录，支持内存 SQLite 与物理目录隔离：

```ts
export interface TestContext {
  dataDir: string;
  db: Database;
  clock: VirtualClock;
  mockChat: MockChatModel;
  mockEmbedding: MockEmbeddingModel;
  mockNotify: MockNotificationProvider;
  cleanup: () => Promise<void>;
}

export async function createTestContext(opts: { timeZone?: string; initialTimeMs?: number } = {}): Promise<TestContext> {
  const uuid = crypto.randomUUID();
  const dataDir = path.join(os.tmpdir(), `psyber-test-${uuid}`);
  await fs.mkdir(dataDir, { recursive: true });

  const clock = new VirtualClock(opts.initialTimeMs ?? 1795046400000, opts.timeZone ?? "Asia/Shanghai");
  // 初始化目录骨架、SQLite 迁移与 git repo
  await initDataDirectoryStructure(dataDir);
  const db = openDatabase(path.join(dataDir, "psyber.sqlite"));
  await runMigrations(db);
  await initMemoryGitRepo(dataDir);

  return {
    dataDir,
    db,
    clock,
    mockChat: new MockChatModel(),
    mockEmbedding: new MockEmbeddingModel(),
    mockNotify: new MockNotificationProvider(),
    cleanup: async () => {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}
```

---

## 3. 核心契约自动化回归用例清单（12 个刚性测试套件）

为保证任何后续重构不破坏架构承诺，以下 12 个测试套件作为 CI 的必须守门项：

| 编号 | 测试套件文件 | 覆盖的核心契约与断言目标 |
| :--- | :--- | :--- |
| **T01** | `tests/sandbox_paths.test.ts` | 5 文件工具沙箱边界：`..` 与绝对路径拦截、`private/` 隔离绝不跌落 `memory/`、`gist/(days\|weeks\|months\|years)/*.md` 正确放行、孤儿目录与无 `.md` 后缀拦截。 |
| **T02** | `tests/edit_diff.test.ts` | `edit` 两阶段唯一匹配算法：单次精确命中零字节漂移、中英文标点/空白折叠归一化回退命中、多重命中与零命中自救报错。 |
| **T03** | `tests/c27_review.test.ts` | C2.7 独立复核协议：新建卡全审、旧卡 diff 审、归一化出处强过滤（剔除假阳性）、阶段 B 报错触发 `MemoryTx` 内存还原与索引刷新、阶段 C 摘要微瑕降级提交。 |
| **T04** | `tests/fts5_cjk.test.ts` | 纯 TS `tokenizeForFts` 预处理：连续汉字 2-gram 切分、虚词过滤、`"token" OR "token"` 语法安全拼接、单字 `LIKE` 兜底合并。 |
| **T05** | `tests/recall_pipeline.test.ts` | 双轨召回管线：轨道 1 `activityHint` 命中锁定、轨道 2 向量与 FTS5 RRF 融合、`embedding` 宕机 2.5s 超时平滑降级 FTS5、2 小时已作废轮次去重排除。 |
| **T06** | `tests/state_lifecycle.test.ts` | `daily/` 状态机生命周期：到期仅索引标 `faded` 绝不后台篡改 Markdown、康复标 `resolved` 退出常规池、分歧标 `disputed` 永不过期、复发提示与 tag 重叠报警。 |
| **T07** | `tests/door_state.test.ts` | 一扇门 5 态状态机：`closed` 下发消息仅存 `door_note` 不唤醒、两游标解耦（整理轮连续整理、未读游标独立消费）、冷静期 24h 时间锁拦截、72h 超时自然回退且清空时间戳、AI 盘中改状态超时守卫失效。 |
| **T08** | `tests/sealed_drawer.test.ts` | 上锁抽屉：`.sealed` 封装防明文搜索、三道零入库红线（SQLite 零记录）、`POST /drawer/:id/open` 必须**先**写入不可篡改 `privacy.peeked` 事件**再**返回明文。 |
| **T09** | `tests/concurrency_locks.test.ts` | 并发锁隔离：后台 `MemoryTx` 持锁期间，前台普通聊天（`turnTouchedMemoryPaths.size === 0`）**零延迟放行推 `turn.done`**；当轮写卡才短持 `MemoryWriteMutex` 提交。 |
| **T10** | `tests/cinema_frames.test.ts` | 观影生命周期与临时帧淘汰：15s 抽帧节流、单帧 ≤ 512KB、`cinema.bookmark` 钉帧免清理、观影结束满 24 小时后睡前任务等距保留 3 张代表帧，其余物理删除并置 `410 GONE`。 |
| **T11** | `tests/api_messages.test.ts` | 消息操作状态机：`Edit`/`Reroll`/`Version`/`Delete` 严格追加不覆写旧行、每次生成新 `turn_id`、`clientMessageId` 幂等重试、`closed` 下拒 `reroll`、`departed` 下全写接口返 `410`。 |
| **T12** | `tests/cache_rollover.test.ts` | 缓存保活与切会话：>40k tokens 且闲置 25 分钟触发结晶换段、≤40k 或无缓存闲置不收不切、`CONTEXT_OVERFLOW` 忙态不卡死排队回复。 |

---

## 4. SQLite 在线备份（`VACUUM INTO`）、保留轮转与灾难恢复

### 4.1 在线零阻塞备份（`server/src/core/backup.ts`）

SQLite 原生 `VACUUM INTO` 命令可以在后端正常服务、并发读写不断档的情况下，生成一个具有事务级一致性、已清理碎片且体积最紧凑的备份副本：

```ts
export async function performSqliteBackup(db: Database, dataDir: string, now: Date): Promise<string> {
  const backupsDir = path.join(dataDir, "backups");
  await fs.mkdir(backupsDir, { recursive: true });

  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const targetFile = path.join(backupsDir, `psyber-${dateStr}.sqlite`);

  // 若今日已存在同名备份文件先清理，保证幂等
  try { await fs.unlink(targetFile); } catch {}

  // 严格参数化执行 VACUUM INTO，耗时通常 < 150ms（对 100MB 库）
  db.run(`VACUUM INTO ?`, [targetFile]);

  // 执行保留轮转清理
  await rotateBackups(backupsDir, now);

  return targetFile;
}
```

### 4.2 备份保留与轮转策略（Grandfather-Father-Son 轮转）

为防止单机磁盘被每日备份堆满，备份轮转器按以下策略清理历史文件：

1. **保留最近 7 天的每日备份**：保证过去一周内任一天的状态均可无损还原；
2. **保留最近 4 周的周日备份**：按周维度保留一个月内的周快照；
3. **保留最近 12 个月的月末备份**：年维度归档；
4. 其余过期的 `.sqlite` 备份文件自动物理删除。

### 4.3 灾难恢复与换机迁移（CLI）

- **全量无损导出**：
  ```bash
  psyber export --data-dir ~/.psyber/default --output ~/psyber-backup-20261120.tar.gz
  ```
  该命令先触发一次 `VACUUM INTO`，再将生成的备份 sqlite、`memory/`（含 `.git`）、`private/`、`media/`、`stickers/` 与脱敏配置打包为单一 `.tar.gz` 文件；若带 `--include-private` 则如实向日志记账。
- **冷备替换还原**：
  若数据库意外损坏或断电导致只读，管理员只需：
  ```bash
  # 停止 server
  psyber stop
  # 恢复最新备份
  cp ~/.psyber/default/backups/psyber-latest.sqlite ~/.psyber/default/psyber.sqlite
  # 启动并触发索引校验
  psyber start
  ```

---

## 5. 服务端启动编排、自愈与 CLI 运维命令集

### 5.1 服务端启动生命周期（`server/src/core/boot.ts`）

服务单进程启动时严格按顺序执行下列 8 个阶段，任意强前置条件失败则打印结构化错误并安全退出：

```text
[Stage 1: Config & Credential] ──► 加载 config.json，权限检查 credentials.json (0600)
       │
[Stage 2: Storage Init] ─────────► 创建目录骨架 (media, stickers, private, memory, backups)
       │
[Stage 3: SQLite & Migrations] ──► 打开 psyber.sqlite (WAL 模式)，顺序执行 migrations/
       │
[Stage 4: Git Sandbox Init] ─────► 检查 memory/.git (无则 git init 并配置 local user)
       │
[Stage 5: Crash Recovery] ───────► 清理 .tmp/，检查并释放 index.lock，兜底提交上次崩溃残留卡片
       │
[Stage 6: Index Reconciliation] ─► 扫描 memory/ 增量刷新 card_index/card_fts，异步排队补齐向量
       │
[Stage 7: Extension Async Boot] ──► 异步连接启用的外部 MCP 服务（单服 10s 超时，失败不阻塞）
       │
[Stage 8: Engine & HTTP Start] ──► 启动 Circadian 心跳定时器，绑定 Hono 端口，触发开局静默预热
```

### 5.2 崩溃自愈守卫（Crash Recovery Guard）

针对电脑突发断电、`kill -9` 强杀导致的环境脏状态：
1. **清理孤儿锁**：检查 `<dataDir>/memory/.git/index.lock`，确认当前系统中无正在运行的 `git` 子进程后，安全删除该锁文件；
2. **清理半死临时文件**：清空 `<dataDir>/.tmp/` 下遗留的 `.tmp` 碎片；
3. **未提交卡片兜底认领**：若 `git status --porcelain` 检出上次修改未被提交，且受影响文件全在白名单常规区内，执行一次兜底提交：
   `git commit -m "recovery(memory): preserve uncommitted changes from crash"`
   并立即重新刷新索引，保证住户写好的记忆永不因断电丢失。

### 5.3 CLI 运维命令速查表（`psyber`）

```bash
# 1. 服务控制
psyber start [--port 3721] [--data-dir ~/.psyber/default] [--daemon] # 启动单进程后端
psyber stop                                                        # 优雅停止常驻服务 (SIGTERM)
psyber status                                                      # 查看运行状态、门状态、未读纸条与会话 Token
psyber pair                                                        # 生成一次性 8 位配对码与终端二维码

# 2. 记忆与索引维护
psyber reindex [--force]                                           # 全量重建 FTS5 全文索引与卡片元信息缓存
psyber eval:recall --offline [--top-k 5]                           # 运行真实召回质量回归测试套件

# 3. 灾备与迁移
psyber backup                                                      # 立即触发一次 VACUUM INTO 在线热备
psyber export [--output backup.tar.gz] [--include-private]         # 导出可迁移数据包
psyber import --input backup.tar.gz [--data-dir ~/.psyber/new]     # 导入数据包至新实例
```

---

## 6. Spec 05 出口验收清单（供 Ring 0/1 编码与测试对照）

- [ ] 虚拟时钟 `VirtualClock` 实现完成，支持 `advance()` 与 `jumpToWallClock()`，全库无未受控的裸 `Date.now()`；
- [ ] 三时区矩阵自动化回归通过：`Asia/Shanghai` 跨日、`America/New_York` 夏令时 23h/25h 免疫、`Europe/London` ISO 周判定全绿；
- [ ] 离线测试 Mock 体系全绿：`MockChatModel` 确定性应答、`MockEmbeddingModel` 64 维确定性向量、单测执行 100% 离线；
- [ ] 12 个核心契约测试套件全部建立，CI 脚本 `bun test` 全量通过；
- [ ] 启动阶段 8 步编排严密、崩溃残留 `index.lock` 自动清理、上次崩溃卡片自动兜底恢复并提交；
- [ ] SQLite `VACUUM INTO` 在线热备份验证通过，备份文件生成无锁、Grandfather-Father-Son 轮转清理有效；
- [ ] CLI 常用命令（`start`, `stop`, `status`, `pair`, `reindex`, `backup`, `export`）全量贯通。