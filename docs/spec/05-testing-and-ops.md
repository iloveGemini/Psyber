# Spec 05 · 测试矩阵、虚拟时钟、SQLite 灾备与运维编排规程

> **版本**：v0.4（2026-11-20，修正 T03/T11/T12 套件断言对齐非阻塞复核与 75% 异步换段、拆分 §6 出口验收清单分期）
> **上游契约**：[`CAPABILITIES.md`](../CAPABILITIES.md) v1.4 · [`ARCHITECTURE.md`](../ARCHITECTURE.md) v0.8 · [`MEMORY.md`](../MEMORY.md) v0.8 · [`API.md`](../API.md) v0.8 · [`01-engine-tools-prompts.md`](01-engine-tools-prompts.md) v1.2 · [`02-memory-execution.md`](02-memory-execution.md) v0.8 · [`03-boundaries-expression-activities.md`](03-boundaries-expression-activities.md) v0.5 · [`04-api-and-flutter.md`](04-api-and-flutter.md) v0.5
> **负责模块**：`server/src/core/`（`clock.ts`, `backup.ts`, `boot.ts`）、`server/tests/`、`server/src/cli/`

---

## 0. 测试与运维四条铁律

1. **测试 100% 离线，零外部 API 依赖（遵守 `AGENTS.md` 红线）**：
   - 自动化单测、集成测试与 CI 流程**严禁发起任何外部网络请求**（包括 OpenAI、Anthropic、Google、Embedding / Reranker 服务或外部 Webhook）；
   - 所有模型交互均通过确定性内存 Mock 驱动，确保毫秒级极速执行与零 Token 成本，任何网络波动不得造成测试挂起或误报；
   - 试跑与手工集成测试一律使用 `PSYBER_DATA_DIR=~/.psyber/test`，严禁读取正式库作为样本。
2. **时间判定必须可注入、可快进（时间确定性）**：
   - 全库严禁直接调用 `Date.now()`、`new Date()` 获取未注入的系统时间；
   - 所有生命周期（作息、到期、冷静期、Token 刷新、心跳、每日热备命名与轮转）必须通过 `Clock.now()` 与 `clock.timeZone` 驱动，保证能在单测中以微秒级“快进 10 天”或“跨越夏令时”验证演化逻辑。
3. **数据目录单点闭环，随拷随走（本地优先零外部状态）**：
   - 单住户实例的一切状态（SQLite、Git、封条日记、媒体、凭证）严格收敛于 `<dataDir>` 内部；
   - 绝不依赖系统全局注册表、外部数据库或隐藏后台服务；迁移或灾备只需对 `<dataDir>` 做一致性归档。
4. **备份不阻塞读写，提交不误伤工作区（稳态生产准绳）**：
   - 数据库热备份强制采用 SQLite 原生 `VACUUM INTO`（先写临时文件再原子 `rename`），单飞串行执行，不阻塞前台读写事务；
   - Git 自动化提交严格限定在 `MemoryTx` 显式记录的白名单路径（崩溃恢复仅限已跟踪白名单文件），严禁 `git add -A`，严禁 `git reset --hard`。

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

### 1.2 三时区回归测试矩阵（Ring 1.5 专项回归；Ring 1 先用标准 `Intl.DateTimeFormat` 保证本地日正确）

时钟计算逻辑（`localDay`, `wallClock`, `vagueWhen`, `addCalendarDays`）必须在自动化测试中对以下三类代表性时区进行全覆盖回归：

| 时区标识 | 代表特征 | 关键攻防测试点 |
| :--- | :--- | :--- |
| **`Asia/Shanghai`** (UTC+8) | 恒定固定偏移、无夏令时（典型东八区基准） | 跨午夜零点切日、月末 28/29/30/31 天递进、元旦跨年、每日热备按本地日命名 |
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
export type MockStreamChunk =
  | { type: "thinking_delta"; delta: string; signature?: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "error"; code: "AUTH_EXPIRED" | "RATE_LIMITED" | "PROVIDER_ERROR" | "CONTEXT_OVERFLOW" };

// 1. MockChatModel（支持流式思考、正文、工具调用、AbortSignal 与结构化错误模拟）
export class MockChatModel {
  private queue: Array<(messages: unknown[], signal?: AbortSignal) => MockStreamChunk[] | AsyncIterable<MockStreamChunk>> = [];

  queueStream(fn: (messages: unknown[], signal?: AbortSignal) => MockStreamChunk[] | AsyncIterable<MockStreamChunk>): void {
    this.queue.push(fn);
  }

  async *stream(messages: unknown[], opts?: { signal?: AbortSignal }): AsyncIterable<MockStreamChunk> {
    const handler = this.queue.shift();
    if (!handler) throw new Error("MockChatModel: unexpected call with no queued response");
    const out = handler(messages, opts?.signal);
    for await (const chunk of out) {
      if (opts?.signal?.aborted) return;
      yield chunk;
    }
  }
}

// 2. MockEmbeddingModel（确定性可预测向量，支持模拟超时/故障降级）
export class MockEmbeddingModel implements EmbeddingClient {
  readonly dim = 64;
  public failWith?: Error;

  /** 基于文本 SHA-256 哈希与字符词袋生成确定性 L2 归一化 Float32Array */
  async embed(text: string): Promise<Float32Array> {
    if (this.failWith) throw this.failWith;
    return deterministicBagOfWordsVector(text, this.dim);
  }
}

// 3. MockRerankerClient（支持确定性打分与 2500ms 超时降级测试）
export class MockRerankerClient implements RerankerClient {
  public failWith?: Error;
  public customScores?: Record<string, number>;

  async rerank(query: string, docs: Array<{ id: string; text: string }>): Promise<Array<{ id: string; score: number }>> {
    if (this.failWith) throw this.failWith;
    return docs.map((d) => ({
      id: d.id,
      score: this.customScores?.[d.id] ?? deterministicOverlapScore(query, d.text),
    }));
  }
}

// 4. MockNotificationProvider（通知留痕）
export class MockNotificationProvider implements NotificationProvider {
  readonly channel = "mock";
  public readonly sent: Array<{ kind: string; title: string; body: string; turnId?: string }> = [];

  async notify(payload: { kind: string; title: string; body: string; turnId?: string }): Promise<void> {
    this.sent.push(payload);
  }
}
```

### 2.2 隔离测试环境工厂（`createTestContext`）

每个测试用例独占一个完全沙箱化的临时目录，支持物理目录与 SQLite 隔离，绝不触碰用户真实目录：

```ts
export interface TestContext {
  dataDir: string;
  db: Database;
  clock: VirtualClock;
  mockChat: MockChatModel;
  mockEmbedding: MockEmbeddingModel;
  mockReranker: MockRerankerClient;
  mockNotify: MockNotificationProvider;
  cleanup: () => Promise<void>;
}

export async function createTestContext(opts: { timeZone?: string; initialTimeMs?: number } = {}): Promise<TestContext> {
  const uuid = crypto.randomUUID();
  const dataDir = path.join(os.tmpdir(), `psyber-test-${uuid}`);
  await fs.mkdir(dataDir, { recursive: true });

  const clock = new VirtualClock(opts.initialTimeMs ?? 1795046400000, opts.timeZone ?? "Asia/Shanghai");
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
    mockReranker: new MockRerankerClient(),
    mockNotify: new MockNotificationProvider(),
    cleanup: async () => {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}
```

---

## 3. 核心契约自动化回归用例清单（Ring 1 先落 5 套主链路；全量 15 套按分期逐步激活）

- **Ring 1 必过 5 套核心主链路**：① 沙箱路径与 `edit` 原子写（对应 T01+T02）；② 主对话 + 75% 异步换段整理 + Git 留痕（对应 T09+T12 精简版）；③ 极简 3 步召回 + `daily/` `state` 10 天 `faded`/`resolved`（对应 T05+T06 精简版）；④ `door` 3 态关门 `door_note` 不唤醒 + `wake` `[SILENT]`（对应 T07 精简版）；⑤ 幂等发消息 + SSE 推流与中止（对应 T11+T13 精简版）。
- 下表为全量 15 套远期蓝图（C2.7、抽屉、观影、MCP、四态版本组等随 Ring 1.5 / Ring 2 功能同步启用）：

| 编号 | 测试套件文件 | 覆盖的核心契约与断言目标 |
| :--- | :--- | :--- |
| **T01** | `tests/sandbox_paths.test.ts` | 5 文件工具沙箱边界：`..` 与绝对路径拦截、`private/` 隔离绝不跌落 `memory/`、`gist/(days\|weeks\|months\|years)/*.md` 正确放行、孤儿目录与无 `.md` 后缀拦截。 |
| **T02** | `tests/edit_diff.test.ts` | `edit` 两阶段唯一匹配算法：单次精确命中零字节漂移、中英文标点/空白折叠归一化回退命中、多重命中与零命中自救报错。 |
| **T03** | `tests/c27_review.test.ts` | C2.7 独立复核协议（Ring 1.5 非阻塞）：新建卡全审、旧卡 diff 审、归一化出处强过滤（剔除假阳性）、阶段 B 报错/不可解析仅打告警且**绝不回滚阶段 A 合法卡片**、阶段 C 摘要微瑕降级提交。 |
| **T04** | `tests/fts5_cjk.test.ts` | 纯 TS `tokenizeForFts` 预处理：连续汉字 2-gram 切分、虚词过滤、`"token" OR "token"` 语法安全拼接、单字 `LIKE` 兜底过滤废卡合并。 |
| **T05** | `tests/recall_pipeline.test.ts` | 双轨召回管线：轨道 1 `activityHint` 命中锁定、轨道 2 向量与 FTS5 RRF 融合、`embedding`/`reranker` 宕机 2.5s 超时平滑降级 FTS5、2 小时已作废轮次去重排除。 |
| **T06** | `tests/state_lifecycle.test.ts` | `daily/` 状态机生命周期：到期仅索引标 `faded` 绝不后台篡改 Markdown、康复标 `resolved` 退出常规池、分歧标 `disputed` 永不过期、复发提示与 tag 重叠报警。 |
| **T07** | `tests/door_state.test.ts` | 一扇门 5 态状态机：`closed` 下发消息仅存 `door_note` 不唤醒、两游标解耦（整理轮连续整理、未读游标独立消费）、冷静期 24h 时间锁拦截、72h 超时自然回退且清空时间戳、冷静期 72h 内 AI 主动切换状态清空 `coolingOffStartedAt` 后 72h 超时守卫不再触发。 |
| **T08** | `tests/sealed_drawer.test.ts` | 上锁抽屉：`.sealed` 封装防明文搜索、三道零入库红线（SQLite 零记录）、`POST /drawer/:id/open` 必须**先**写入不可篡改 `privacy.peeked` 事件**再**返回明文。 |
| **T09** | `tests/concurrency_locks.test.ts` | 并发锁隔离：后台 `MemoryTx` 持锁期间，前台普通聊天（`turnTouchedMemoryPaths.size === 0`）**零延迟放行推 `turn.done`**；当轮写卡才短持 `MemoryWriteMutex` 提交。 |
| **T10** | `tests/cinema_frames.test.ts` | 观影生命周期与临时帧淘汰：15s 抽帧节流、单帧 ≤ 512KB、`cinema.bookmark` 钉帧免清理、观影结束满 24 小时后睡前任务等距保留 3 张代表帧，其余物理删除并置 `410 GONE`。 |
| **T11** | `tests/api_messages.test.ts` | 消息操作状态机：`Edit`/`Reroll`/`Version`/`Delete` 严格追加不覆写旧行、每次生成新 `turn_id`、`clientMessageId` 幂等重试、`closed` 下拒 `reroll` 与编辑 `chat`、仅 `candidate` 允许 `/version`、流式生成中返 `409 TURN_IN_PROGRESS`、`departed` 下全写接口返 `410`。 |
| **T12** | `tests/cache_rollover.test.ts` | 75% 同步收尾换段与 `<continuity>`：上下文超 75% 或 `CONTEXT_OVERFLOW` 时先同步排空 `daily_wrapup`（广播 `turn.rollover`）并 Git 留痕，成功后再切新 `session_id`（首轮冻结 `<continuity>`，含不重叠梗概金字塔 + 未入日梗概 `daily/` 正文 + 2000 字末尾原话）；`CONTEXT_OVERFLOW` 换段后当轮自动重试。 |
| **T13** | `tests/auth_and_sse.test.ts` | 设备配对与 SSE 同步：配对码 5m 过期/一次性/防爆破限流、`SHA-256(token)` 落盘与 `revokeDeviceIds` 即时断流、`streamSeq` 500 条环形缓冲续传与 `sync.reset`、`wake` `[SILENT]` 暂缓广播 `turn.start`/`turn.thinking`。 |
| **T14** | `tests/expression_and_mcp.test.ts` | 具身表达与 MCP 桥接：`express` 单轮 3 次节流与贴纸同源校验、MCP 工具强制 Tier 3 隔离、默认 `confirm` 审批挂起与多端同步销除、单服宕机不阻塞启动与 8000 字输出截断。 |
| **T15** | `tests/clock_backup_recovery.test.ts` | 时钟与灾备自愈：三时区/DST 23h/25h 回归、`VACUUM INTO` 本地日原子热备与 GFS 轮转、`psyber restore` 清理 `-wal`/`-shm` 还原、启动崩溃清理 `index.lock` 且兜底提交排除未跟踪文件。 |

---

## 4. SQLite 在线备份（`VACUUM INTO`）、保留轮转与灾难恢复

### 4.1 在线单飞原子热备份（`server/src/core/backup.ts`）

SQLite 原生 `VACUUM INTO` 在 WAL 模式下持有一个一致性只读快照，**不阻塞前台并发读与常规写入**（仅在快照期间短暂延后 WAL checkpoint 截断），生成一个已清理碎片的事务级一致性备份副本：

- **触发时机**：每次 `bedtime` 睡前整理完成后自动触发一次（若当日未启用 `bedtime` 或处于 `departed` 态，亦可通过 `psyber backup` 手动触发）；内存单飞锁（`backupInFlight`）防止并发重入，备份失败仅记结构化告警日志，绝不中断主服务。
- **本地日命名与原子落盘**（严格走 `Clock`，绝不用 UTC `toISOString()`）：

```ts
export async function performSqliteBackup(db: Database, dataDir: string, clock: Clock): Promise<string> {
  const backupsDir = path.join(dataDir, "backups");
  await fs.mkdir(backupsDir, { recursive: true });

  const dateStr = localDay(clock.now(), clock.timeZone).replace(/-/g, ""); // 按实例本地时区取 YYYYMMDD
  const tmpFile = path.join(backupsDir, `psyber-${dateStr}.sqlite.tmp`);
  const targetFile = path.join(backupsDir, `psyber-${dateStr}.sqlite`);
  const latestLink = path.join(backupsDir, "psyber-latest.sqlite");

  try { await fs.unlink(tmpFile); } catch {}

  // 严格参数化执行 VACUUM INTO 到临时文件，再原子 rename，防断电留下半截备份
  db.run(`VACUUM INTO ?`, [tmpFile]);
  await fs.rename(tmpFile, targetFile);

  // 原子更新 psyber-latest.sqlite 软链指向最新完整备份
  const tmpLink = path.join(backupsDir, `.psyber-latest.${crypto.randomUUID()}.tmp`);
  await fs.symlink(path.basename(targetFile), tmpLink);
  await fs.rename(tmpLink, latestLink);

  // 按本地日历日执行 GFS 保留轮转清理
  await rotateBackups(backupsDir, clock);

  return targetFile;
}
```

### 4.2 备份保留与轮转策略（Ring 1 简单保留最近 7 份每日备份；GFS 三级轮转于 Ring 1.5 启用）

为防止单机磁盘被每日备份堆满，备份轮转器按实例本地日历日执行清理：

1. **保留最近 7 天的每日备份**：保证过去一周内任一天的状态均可无损还原；
2. **保留最近 4 周的周日备份**：按周维度保留一个月内的周快照；
3. **保留最近 12 个月的月末备份**：年维度归档；
4. 其余过期的 `psyber-YYYYMMDD.sqlite` 备份文件自动物理删除（永远不删 `psyber-latest.sqlite` 当前指向的目标文件）。

### 4.3 灾难恢复与换机迁移（CLI）

- **全量无损导出（严格区分默认导出与 `--include-private`）**：
  ```bash
  # 默认导出（不包含 private/ 上锁抽屉）
  psyber export --data-dir ~/.psyber/default --output ~/psyber-backup-20261120.tar.gz

  # 含上锁抽屉的完整换机导出（先留痕再热备打包）
  psyber export --data-dir ~/.psyber/default --output ~/psyber-full-20261120.tar.gz --include-private
  ```
  - **执行顺序与隐私红线**：
    1. 默认导出**绝不包含 `private/`**，仅打包 `VACUUM INTO` 生成的快照 sqlite、`memory/`（含 `.git`）、`media/`、`stickers/`、`DEPARTED.md`（若有）以及**脱敏 `config.json`**（剥离 `auth.devices` 与凭证引用，**必须保留 `instanceId`**，严禁打包 `credentials.json`）；
    2. 仅当显式传入 `--include-private` 时才纳入 `private/`，且严格按 **先向原库 SQLite `events` 写入 `privacy.peeked`（`channel: 'cli'`）→ 再执行 `VACUUM INTO` → 再打包** 的顺序执行（确保导出包内的数据库自身也忠实记录了此次拆封）；由于脱敏 `config.json` 保留了 `instanceId`，换机导入后 `.sealed` 日记可按 `Spec 02` §2.1 无损解封。
- **WAL 安全冷备还原（强制清理 `-wal`/`-shm` 防数据库损坏）**：
  - 推荐使用内置命令一键安全还原（自动检查服务已停止、备份坏库、删除 `-wal`/`-shm` 并拷贝恢复）：
    ```bash
    psyber stop
    psyber restore --input ~/.psyber/default/backups/psyber-latest.sqlite
    psyber start
    ```
  - 若手动命令行还原，**必须在拷贝前删除残留的 WAL 与 SHM 文件**（否则 SQLite 重启时会把旧 WAL 重放到好备份上直接冲坏数据库）：
    ```bash
    psyber stop
    rm -f ~/.psyber/default/psyber.sqlite-wal ~/.psyber/default/psyber.sqlite-shm
    cp ~/.psyber/default/backups/psyber-latest.sqlite ~/.psyber/default/psyber.sqlite
    psyber start
    ```

---

## 5. 服务端启动编排、自愈与 CLI 运维命令集

### 5.1 服务端启动生命周期（`server/src/core/boot.ts`）

服务单进程启动时严格按顺序执行下列 8 个阶段，任意强前置条件失败则打印结构化错误并安全退出：

```text
[Stage 1: Config & Credential] ──► 加载 config.json（首次生成 instanceId），权限检查 credentials.json (0600)
       │
[Stage 2: Storage Init] ─────────► 创建目录骨架 (media, stickers, private, memory, backups, .tmp)
       │
[Stage 3: SQLite & Migrations] ──► 打开 psyber.sqlite (WAL 模式)，顺序执行 migrations/ (001, 002...)
       │
[Stage 4: Git Sandbox Init] ─────► 检查 memory/.git (无则 git init 并配置 Psyber Resident 本地作者)
       │
[Stage 5: Crash Recovery] ───────► 清理 .tmp/，检查并释放 index.lock，仅对已跟踪白名单脏卡片兜底提交
       │
[Stage 6: Index Reconciliation] ─► 扫描 memory/ 增量刷新 card_index/card_fts，异步排队补齐向量
       │
[Stage 7: Extension Async Boot] ──► 异步连接启用的外部 MCP 服务（单服 10s 超时，失败不阻塞）
       │
[Stage 8: Engine & HTTP Start] ──► 绑定 Hono 端口；若非 departed 态启动 Circadian 心跳，若已配 chat Provider 则异步触发开局静默预热
```

> **Stage 8 守卫**：若当前 `door.state === "departed"`（对齐 `Spec 03` §1.3 只读停机），跳过 Circadian 心跳、主动唤醒、静默整理与模型预热，仅提供只读 HTTP 接口；若处于未配置 `slots.chat` 的初生状态，跳过模型预热，等待用户通过 Genesis 向导或 OAuth 完成配置。任何开局静默预热均异步执行，绝不阻塞端口监听。

### 5.2 崩溃自愈守卫（Crash Recovery Guard，与 `Spec 02` §5.3 严格对齐）

针对电脑突发断电、`kill -9` 强杀导致的环境脏状态：
1. **清理孤儿锁**：检查 `<dataDir>/memory/.git/index.lock`，确认当前系统中无正在运行的 `git` 子进程后，安全删除该锁文件；
2. **清理半死临时文件**：清空 `<dataDir>/.tmp/` 下遗留的 `.tmp` 碎片；
3. **已跟踪卡片兜底认领（绝不误收未跟踪杂文件）**：若 `git status --porcelain` 检出上次崩溃残留的未提交改动，**仅暂存其中已跟踪（严格排除 `??` 未跟踪文件）且位于 `Spec 02` §1.1 写白名单内的记忆卡片路径**，执行一次安全兜底提交：
   `git commit -m "recovery(memory): preserve uncommitted changes on startup"`
   并立即刷新增量索引（若仅有未跟踪文件则不提交）；若崩溃恰好发生在 C2.7 复核前，由于 `task_cursors` 尚未推进，下次整理轮会自动幂等重跑对账并收敛，既不丢数据也不跳过游标。

### 5.3 环境变量、开源一键启动与 CLI 运维命令统一映射

#### 环境变量速查表

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PSYBER_DATA_DIR` | `~/.psyber/default` | 单住户数据目录（**开发试跑与自动化测试一律使用 `~/.psyber/test`**，遵守 `AGENTS.md` 隔离红线） |
| `PSYBER_PORT` | `3721` | Hono HTTP / SSE 监听端口 |
| `PSYBER_HOST` | `0.0.0.0` | 监听地址（默认局域网可达供移动端扫码直连，仅本机使用可设为 `127.0.0.1`） |

#### 开源一键启动与 CLI / `bun run` 命令映射表

`server/package.json` 同时暴露 `bin.psyber` 与同名 `scripts`，保证全局安装（`psyber <cmd>`）与仓库内直接运行（`cd server && bun run <cmd>`）完全一致：

```bash
# 开源本地一键启动（克隆仓库后两行命令即可跑起后端并扫码配对）
cd server && bun install
bun run start    # 首次无已配对设备时自动打印 8 位一次性配对码与终端二维码
```

| `psyber` CLI 命令 | `server/` 内等价脚本 | 说明 |
| :--- | :--- | :--- |
| `psyber start [--port 3721] [--data-dir <dir>] [--daemon]` | `bun run start` | 启动单进程后端 |
| `psyber stop` | `bun run stop` | 优雅停止常驻服务（`SIGTERM`，等待进行中 `MemoryTx` 收尾） |
| `psyber status` | `bun run status` | 查看运行状态、门状态、未读纸条数与活跃活动 |
| `psyber pair` | `bun run pair` | 生成一次性 8 位配对码与终端二维码（5 分钟有效） |
| `psyber reindex [--force]` | `bun run memory:reindex` | 全量重建 `card_index` / `card_fts` 派生索引并排队补算向量 |
| `psyber eval:recall --offline [--top-k 5] [--data-dir <dir>]` | `bun run eval:recall` | 运行离线召回质量回归测试套件（对齐 `Spec 02` §9.2） |
| `psyber backup` | `bun run backup` | 立即触发一次 `VACUUM INTO` 本地日原子热备与 GFS 轮转 |
| `psyber restore --input <backup.sqlite>` | `bun run restore` | 校验停服、自动清理 `-wal`/`-shm` 并还原 SQLite 备份 |
| `psyber export [--output <file.tar.gz>] [--include-private]` | `bun run export` | 导出可迁移数据包（默认不含 `private/`；含 `--include-private` 先记 `privacy.peeked` 再热备打包） |
| `psyber import --input <file.tar.gz> [--data-dir <dir>]` | `bun run import` | 导入数据包至新数据目录并校验索引一致性 |

---

## 6. Spec 05 出口验收清单（按 Ring 1 / Ring 1.5 分期对照）

### Ring 1 必过验收
- [ ] 虚拟时钟 `VirtualClock` 实现完成，支持 `advance()` 与 `jumpToWallClock()`，全库（含热备与轮转）无未受控的裸 `Date.now()` / UTC `toISOString()`；
- [ ] 离线测试 Mock 体系全绿：`MockChatModel`（含流式 `thinking_delta` / `AbortSignal` / 错误模拟）、`MockEmbeddingModel`、`MockNotificationProvider` 100% 离线运行；
- [ ] Ring 1 必过 5 套核心主链路离线测试全绿（`cd server && bun test`）；
- [ ] 启动 8 步编排严密（含未配置 `chat` 守卫）、崩溃残留 `index.lock` 自动清理、仅对已跟踪白名单脏卡片兜底提交（排除 `??` 未跟踪文件）；
- [ ] SQLite `VACUUM INTO` 本地日原子热备与保留最近 7 份轮转、环境变量（含 `PSYBER_DATA_DIR=~/.psyber/test`）与基础启动/配对脚本贯通。

### Ring 1.5 扩展验收
- [ ] 三时区矩阵自动化回归通过：`Asia/Shanghai` 跨日、`America/New_York` 夏令时 23h/25h 免疫、`Europe/London` ISO 周判定全绿；
- [ ] 全量 15 套契约测试套件（T01–T15，含 `MockRerankerClient`）全绿；
- [ ] GFS 三级轮转、`psyber restore` 清理 `-wal`/`-shm` 还原与 `psyber export --include-private` 先记 `privacy.peeked` 再热备全绿。
