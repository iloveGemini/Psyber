import os from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { createApp } from "./api/app.ts";
import { PairingManager } from "./api/pairing.ts";
import { performSqliteBackup } from "./core/backup.ts";
import { SystemClock, addCalendarDays, localDay, type Clock } from "./core/clock.ts";
import {
  DEFAULT_CIRCADIAN_CONFIG,
  initDataDir,
  loadOrCreateConfig,
  saveConfig,
  type PsyberConfig,
} from "./core/config.ts";
import { loadCredentials } from "./core/credentials.ts";
import { openDatabase, runMigrations } from "./core/db.ts";
import {
  cleanupTransientLocks,
  initMemoryGitRepo,
  recoverUncommittedTrackedCards,
} from "./core/git.ts";
import { MediaStore } from "./core/media.ts";
import { AsyncMutex } from "./core/mutex.ts";
import { ulid } from "./core/ulid.ts";
import { DirectEngine } from "./engine/direct.ts";
import { SseHub } from "./engine/sse.ts";
import {
  runMemoryTidyTask,
  type TidyTaskOutcome,
  type TidyTaskType,
} from "./engine/tidy.ts";
import { syncStaticStickers } from "./expression/stickers.ts";
import { McpManager, type McpManagerDeps } from "./extensions/mcp.ts";
import type { ChatModelClient } from "./llm/client.ts";
import { DynamicChatModel, type ResolvedByokSlot } from "./llm/router.ts";
import { DrawerStore } from "./memory/drawer.ts";
import { MemoryIndex } from "./memory/index.ts";
import { MemoryTools, isAllowedWritePath } from "./memory/tools.ts";
import {
  evaluateHeartbeat,
  getSleepWindowStatus,
  type HeartbeatDecision,
} from "./mood/circadian.ts";
import {
  NotificationHub,
  type NotificationPayload,
} from "./notifications/hub.ts";
import { EventStore } from "./store/events.ts";
import { ToolRegistry, registerCoreTier1Tools } from "./tools/registry.ts";

export function resolveDataDir(): string {
  const raw = process.env.PSYBER_DATA_DIR || "~/.psyber/default";
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

export { DynamicChatModel } from "./llm/router.ts";

export interface BootOptions {
  dataDir?: string;
  promptsDir?: string;
  version?: string;
  /** 可注入虚拟时钟，供离线测试快进时间 */
  clock?: Clock;
  /** 可注入对话模型客户端，供离线测试阻断外网调用 */
  chatModel?: ChatModelClient;
  /** 可注入桌面通知发送器，供离线测试阻断系统弹窗 */
  desktopSender?: (payload: NotificationPayload) => Promise<void>;
  /** 可注入 fetch 实现，供离线测试阻断外网请求 */
  fetchImpl?: typeof fetch;
  /** 可注入模型探测工厂，供 /api/v1/llm/test 离线测试 */
  llmTestClientFactory?: (resolved: ResolvedByokSlot) => ChatModelClient;
  /** 可注入外部 MCP 客户端工厂与超时配置，供离线单测验证 */
  mcpClientFactory?: McpManagerDeps["clientFactory"];
  mcpHandshakeTimeoutMs?: number;
  mcpReconnectDelaysMs?: number[];
  /** 同步工具审批超时（毫秒，默认 120_000） */
  approvalTimeoutMs?: number;
  /** 是否启动后台定时心跳（生产默认 true，单测可传 false 后手动调用 tickHeartbeat） */
  startHeartbeatTimer?: boolean;
  /** 启动发现昨夜因关机错过 bedtime 时是否自动在后台补跑（默认 true） */
  catchUpMissedBedtime?: boolean;
}

export interface PsyberRuntime {
  app: Hono;
  dataDir: string;
  config: PsyberConfig;
  clock: Clock;
  db: Database;
  events: EventStore;
  memoryIndex: MemoryIndex;
  drawer: DrawerStore;
  media: MediaStore;
  mcp: McpManager;
  pairing: PairingManager;
  sse: SseHub;
  notifications: NotificationHub;
  engine: DirectEngine;
  /** 手动触发一次作息心跳判定（用于测试或 CLI 调试） */
  tickHeartbeat: () => Promise<HeartbeatDecision>;
  /** 将异步记忆整理任务排入单队列（自动去重，不阻塞前台对话） */
  enqueueTidy: (taskType: TidyTaskType, nightDate?: string) => Promise<TidyTaskOutcome | null>;
  /** 手动触发一次 SQLite VACUUM INTO 本地日原子热备 */
  triggerBackup: () => Promise<string | null>;
  /** 等待当前队列中的异步整理与备份任务收尾 */
  waitForIdle: () => Promise<void>;
  /** 优雅停机：停心跳、等后台收尾、关数据库连接 */
  stop: () => Promise<void>;
}

/**
 * 装配并启动单进程 Psyber 运行时（对齐 Spec 05 §5.1 8 步启动编排）：
 * - 数据目录初始化、Git 沙箱与崩溃自愈
 * - SQLite 迁移、记忆索引、静态贴纸同步
 * - PairingManager、MediaStore、NotificationHub、circadian 心跳（支持热更新）、单队列 tidy 与每日 VACUUM INTO 热备
 */
export async function bootPsyberRuntime(opts: BootOptions = {}): Promise<PsyberRuntime> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const promptsDir = opts.promptsDir ?? path.resolve(import.meta.dir, "../../prompts");
  const version = opts.version ?? "0.1.0";

  // Stage 1–5: 目录骨架、崩溃清理、Git 沙箱自愈、配置与 SQLite 迁移
  await initDataDir(dataDir);
  await cleanupTransientLocks(dataDir);
  await initMemoryGitRepo(dataDir);
  await recoverUncommittedTrackedCards(dataDir, isAllowedWritePath);

  const bootClock = opts.clock ?? new SystemClock();
  const config = await loadOrCreateConfig(dataDir, bootClock.now());
  // 未注入测试时钟时使用动态读取 config.timezone 的 SystemClock，避免业务层裸调 Date.now()
  const clock: Clock = opts.clock ?? new SystemClock(() => config.timezone);

  const db = openDatabase(path.join(dataDir, "psyber.sqlite"));
  runMigrations(db, clock.now());

  // Stage 6: 记忆索引与静态贴纸同步
  const memoryIndex = new MemoryIndex(db, dataDir, clock);
  await memoryIndex.reindexAll();
  await syncStaticStickers(db, dataDir, clock);

  // Stage 7: 装配事件仓、媒体仓、配对管理器、记忆工具、SSE 与离线通知中心
  const events = new EventStore(db, clock);
  const media = new MediaStore(db, dataDir);
  const drawer = new DrawerStore(dataDir, () => config.instanceId, clock);
  const pairing = new PairingManager(clock);
  const memoryTools = new MemoryTools(dataDir, memoryIndex, clock);
  const registry = new ToolRegistry();
  registerCoreTier1Tools(registry, {
    memoryTools,
    events,
    clock,
    getConfig: () => config,
    saveConfig: (cfg) => saveConfig(dataDir, cfg),
    drawer,
  });

  // Stage 7b: 异步非阻塞挂载外部 MCP 桥接（强制 Tier 3，单服宕机绝不阻塞启动）
  const mcp = new McpManager({
    registry,
    loadCredentials: () => loadCredentials(dataDir),
    fetchImpl: opts.fetchImpl,
    handshakeTimeoutMs: opts.mcpHandshakeTimeoutMs,
    reconnectDelaysMs: opts.mcpReconnectDelaysMs,
    clientFactory: opts.mcpClientFactory,
  });
  mcp.connectAllAsync(config.mcpServers ?? []);

  const sse = new SseHub();
  const notifications = new NotificationHub({
    clock,
    getConfig: () => config,
    // 对齐 Spec 03 §3.1：仅计 foreground !== false 的活跃前台连接
    hasActiveForegroundClient: () => sse.foregroundSubscriberCount > 0,
    isInSleepWindow: () =>
      getSleepWindowStatus(clock.now(), config.timezone, config.circadian).inSleepWindow,
    getCredential: async (key) => {
      const creds = await loadCredentials(dataDir);
      return creds.channelTokens[key] ?? null;
    },
    desktopSender: opts.desktopSender,
    fetchImpl: opts.fetchImpl,
  });

  const chatModel =
    opts.chatModel ?? new DynamicChatModel({ dataDir, getConfig: () => config, slot: "chat" });
  const tidyModel =
    opts.chatModel ??
    new DynamicChatModel({ dataDir, getConfig: () => config, slot: "memory_task" });

  // 运行时作息与异步队列状态
  let lastBedtimeNightDate = events.getBedtimeNightDate();
  let lastWakeMs = events.getLastWakeMs();
  let consecutiveUnansweredWakes = 0;
  let stopped = false;

  const tidyMutex = new AsyncMutex();
  const pendingPromises = new Set<Promise<unknown>>();
  let dailyWrapupQueued = false;
  let queuedBedtimeNightDate: string | null = null;
  let engineRef: DirectEngine | null = null;

  const trackBackground = <T>(p: Promise<T>): Promise<T> => {
    pendingPromises.add(p);
    p.finally(() => {
      pendingPromises.delete(p);
    });
    return p;
  };

  const triggerBackup = async (): Promise<string | null> => {
    if (stopped) return null;
    try {
      return await performSqliteBackup(db, dataDir, clock);
    } catch (err) {
      console.error("[psyber] SQLite VACUUM INTO backup failed:", err);
      return null;
    }
  };

  const runSyncDailyWrapup = async (
    cutoffSeq: number | null,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (stopped) return { ok: false, error: "服务正在停机" };
    const outcome = await tidyMutex.runExclusive(async () => {
      if (stopped) return null;
      return runMemoryTidyTask(
        {
          db,
          dataDir,
          promptsDir,
          clock,
          events,
          memoryIndex,
          memoryTools,
          chatModel: tidyModel,
        },
        { taskType: "daily_wrapup", maxSeq: cutoffSeq },
      );
    });
    if (!outcome) return { ok: false, error: "服务正在停机" };
    return { ok: outcome.ok, error: outcome.error };
  };

  const enqueueTidy = (
    taskType: TidyTaskType,
    nightDate?: string,
  ): Promise<TidyTaskOutcome | null> => {
    if (stopped) return Promise.resolve(null);
    if (taskType === "daily_wrapup") {
      if (dailyWrapupQueued) return Promise.resolve(null);
      dailyWrapupQueued = true;
    } else if (taskType === "bedtime") {
      const targetNight = nightDate ?? localDay(clock.now(), config.timezone);
      if (lastBedtimeNightDate === targetNight || queuedBedtimeNightDate === targetNight) {
        return Promise.resolve(null);
      }
      queuedBedtimeNightDate = targetNight;
    }

    const job = (async () => {
      let bedtimeDigestedEventId: string | null | undefined;
      let shouldNotifyBedtimeDone = false;

      const outcome = await tidyMutex.runExclusive(async () => {
        try {
          if (stopped) return null;
          const targetNight =
            taskType === "bedtime" ? nightDate ?? localDay(clock.now(), config.timezone) : undefined;
          const res = await runMemoryTidyTask(
            {
              db,
              dataDir,
              promptsDir,
              clock,
              events,
              memoryIndex,
              memoryTools,
              chatModel: tidyModel,
            },
            { taskType, nightDate: targetNight },
          );
          if (taskType === "bedtime" && res.ok && targetNight) {
            lastBedtimeNightDate = targetNight;
            // Spec 05 §4.1：bedtime 睡前整理完成后自动触发一次 VACUUM INTO 本地日原子热备
            await triggerBackup();
            bedtimeDigestedEventId = res.lastProcessedEventId;
            shouldNotifyBedtimeDone = true;
          }
          return res;
        } finally {
          if (taskType === "daily_wrapup") {
            dailyWrapupQueued = false;
          } else {
            queuedBedtimeNightDate = null;
          }
        }
      });

      // 必须在释放 tidyMutex 后再调 onBedtimeCompleted（获取 turnMutex），严守单向锁顺序防死锁
      if (shouldNotifyBedtimeDone && !stopped) {
        await engineRef?.onBedtimeCompleted(bedtimeDigestedEventId);
      }
      return outcome;
    })();

    return trackBackground(job);
  };

  // Stage 8: 装配 DirectEngine（换段前先同步排空 daily_wrapup，期间通过 SSE turn.rollover 通知前端）
  const engine = new DirectEngine({
    dataDir,
    promptsDir,
    clock,
    getConfig: () => config,
    events,
    memoryIndex,
    registry,
    chatModel,
    db,
    media,
    onBeforeRollover: ({ cutoffSeq }) => runSyncDailyWrapup(cutoffSeq),
    onRolloverStatus: (ev) => {
      sse.emit("turn.rollover", { ...ev });
    },
  });
  engineRef = engine;

  let heartbeatInFlight = false;

  const tickHeartbeat = async (): Promise<HeartbeatDecision> => {
    if (stopped || heartbeatInFlight) {
      return { action: "idle" };
    }
    heartbeatInFlight = true;
    try {
      const unreadDoorNotesCount = events.countUnreadDoorNotes();
      const oldestUnreadDoorNoteMs =
        unreadDoorNotesCount > 0 ? events.getOldestUnreadDoorNoteMs() : null;

      const decision = evaluateHeartbeat({
        nowMs: clock.now(),
        timeZone: config.timezone,
        circadian: config.circadian,
        doorState: config.door.state,
        lastBedtimeNightDate,
        lastInteractionMs: events.getLastInteractionMs(),
        lastWakeMs,
        consecutiveUnansweredWakes,
        unreadDoorNotesCount,
        oldestUnreadDoorNoteMs,
        userUndisturbed: Boolean(config.userStatus?.undisturbed),
      });

      if (decision.action === "sleep_tidy") {
        void enqueueTidy("bedtime", decision.nightDate);
      } else if (decision.action === "proactive") {
        lastWakeMs = clock.now();

        const wakeTurnId = ulid(clock.now());
        const wakeRes = await engine.runTurn({
          mode: "wake",
          wakeReason: decision.reason,
          turnId: wakeTurnId,
          callbacks: {
            onTurnStart: (info) => sse.emit("turn.start", info),
            onThinkingDelta: (delta) => sse.emit("turn.thinking", { turnId: wakeTurnId, delta }),
            onToolProgress: (info) => sse.emit("turn.tool", { ...info }),
            onTextDelta: (delta) => sse.emit("turn.text", { turnId: wakeTurnId, delta }),
            onExpression: (payload) => sse.emit("turn.expression", { turnId: wakeTurnId, ...payload }),
            onDoorUpdated: (state, note) => {
              sse.emit("door.updated", { state, note, updatedAt: clock.now() });
              void notifications.notify({
                kind: "door_updated",
                title: "门状态更新",
                body: note ? `门牌：${note}` : `当前门状态：${state}`,
              });
            },
            onTurnSilence: (info) => {
              // 仅当前端正处于前台观看时才推轻呼吸痕，绝不唤醒后台客户端或发推送
              if (sse.foregroundSubscriberCount > 0) {
                sse.emit("turn.silence", info);
              }
            },
            onTurnDone: (info) => sse.emit("turn.done", info),
            onTurnError: (err) => sse.emit("turn.error", err),
          },
        });

        // 对齐 Spec 03 §3.1：仅在真正开口且非 [SILENT]、非报错时才递增 consecutiveUnansweredWakes
        if (!wakeRes.silent && !wakeRes.error && wakeRes.message) {
          consecutiveUnansweredWakes += 1;
          sse.emit("message.created", { message: wakeRes.message });
          await notifications.notify({
            kind: "wake",
            title: "Psyber",
            body: wakeRes.text.trim().slice(0, 140) || "有一条新消息",
            turnId: wakeRes.turnId,
          });
        }
      }

      return decision;
    } finally {
      heartbeatInFlight = false;
    }
  };

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const rescheduleHeartbeatTimer = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (stopped || opts.startHeartbeatTimer === false) return;
    const intervalMin =
      config.circadian?.heartbeatIntervalMin ?? DEFAULT_CIRCADIAN_CONFIG.heartbeatIntervalMin;
    const intervalMs = Math.max(60_000, intervalMin * 60_000);
    heartbeatTimer = setInterval(() => {
      void tickHeartbeat().catch((err) => {
        console.error("[psyber] Heartbeat tick error:", err);
      });
    }, intervalMs);
  };
  rescheduleHeartbeatTimer();

  // 若昨夜关机错过了睡眠窗 bedtime，白天开机时异步补跑昨夜整理（不阻塞前台第一轮对话）
  // 对齐 Psyche pendingGists 思路：不仅看未整理对话，也覆盖昨晚手动换段后关机导致缺日梗概的情况
  if (opts.catchUpMissedBedtime !== false) {
    const sleepStatus = getSleepWindowStatus(clock.now(), config.timezone, config.circadian);
    if (!sleepStatus.inSleepWindow) {
      const today = localDay(clock.now(), config.timezone);
      const yesterdayNight = addCalendarDays(today, -1);
      if (lastBedtimeNightDate === null || lastBedtimeNightDate < yesterdayNight) {
        const oldestPendingMs = events.getOldestPendingWrapupMs();
        const hasPendingBeforeToday =
          oldestPendingMs !== null && localDay(oldestPendingMs, config.timezone) < today;
        const latestChat = events.getLatestChatEvent();
        const latestChatDay = latestChat ? localDay(latestChat.createdAt, config.timezone) : null;
        const hasChatSinceLastBedtime =
          latestChatDay !== null &&
          latestChatDay < today &&
          (lastBedtimeNightDate === null || latestChatDay > lastBedtimeNightDate);
        const hasDailyCardSinceLastBedtime = memoryIndex
          .listAllRows()
          .some((r) => {
            if (r.space !== "daily") return false;
            const d = localDay(Math.max(r.created_at, r.updated_at), config.timezone);
            return d < today && (lastBedtimeNightDate === null || d > lastBedtimeNightDate);
          });

        if (hasPendingBeforeToday || hasChatSinceLastBedtime || hasDailyCardSinceLastBedtime) {
          void enqueueTidy("bedtime", yesterdayNight);
        }
      }
    }
  }

  const app = createApp({
    version,
    clock,
    getConfig: () => config,
    events,
    getActiveSessionId: () => engine.getActiveSessionId(),
    dataDir,
    db,
    memoryIndex,
    drawer,
    sse,
    engine,
    pairing,
    media,
    mcp,
    approvalTimeoutMs: opts.approvalTimeoutMs,
    onUserMessagePersisted: () => {
      consecutiveUnansweredWakes = 0;
    },
    onSettingsUpdated: () => {
      rescheduleHeartbeatTimer();
    },
    fetchImpl: opts.fetchImpl,
    llmTestClientFactory: opts.llmTestClientFactory,
  });

  const waitForIdle = async (): Promise<void> => {
    while (pendingPromises.size > 0) {
      await Promise.allSettled(Array.from(pendingPromises));
    }
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    await mcp.stop();
    await waitForIdle();
    db.close();
  };

  return {
    app,
    dataDir,
    config,
    clock,
    db,
    events,
    memoryIndex,
    drawer,
    media,
    mcp,
    pairing,
    sse,
    notifications,
    engine,
    tickHeartbeat,
    enqueueTidy,
    triggerBackup,
    waitForIdle,
    stop,
  };
}

async function main(): Promise<void> {
  const port = Number(process.env.PSYBER_PORT || 3721);
  // Spec 05 §5.3：默认监听 0.0.0.0 供局域网移动端扫码直连，仅本机使用可设 127.0.0.1
  const host = process.env.PSYBER_HOST || "0.0.0.0";

  const runtime = await bootPsyberRuntime();
  const server = Bun.serve({
    hostname: host,
    port,
    // SSE 长连接心跳间隔 25s，必须禁用 Bun 默认 10s idleTimeout，避免流式生成中途被服务端强行断流
    idleTimeout: 0,
    fetch: runtime.app.fetch,
  });

  console.log(`Psyber server listening on http://${host}:${port} (dataDir=${runtime.dataDir})`);

  const forcePair =
    process.argv.includes("--pair") ||
    process.argv.includes("-p") ||
    process.env.PSYBER_PAIR === "1" ||
    process.env.PSYBER_ISSUE_PAIR === "1";

  // 首次无已配对设备，或启动时带 --pair 选项时，自动打印 8 位一次性配对码
  if (runtime.config.auth.devices.length === 0 || forcePair) {
    const pair = runtime.pairing.issueCode();
    if (runtime.config.auth.devices.length === 0) {
      console.log(`[psyber] 尚未配对任何客户端，一次性配对码（5 分钟有效）：${pair.code}`);
    } else {
      console.log(`[psyber] 已手动请求签发新设备配对码（5 分钟有效）：${pair.code}`);
    }
  } else {
    console.log(
      `[psyber] 当前已有 ${runtime.config.auth.devices.length} 台已配对设备。如需配对新客户端，可在本终端按 p 回车，或带 --pair 选项重启（bun run pair）。`,
    );
  }

  // 交互式终端模式下，支持随时在控制台按 p / pair 回车签发新配对码
  let ttyListener: ((chunk: string) => void) | null = null;
  if (process.stdin.isTTY) {
    process.stdin.setEncoding("utf-8");
    ttyListener = (chunk: string) => {
      const text = chunk.trim().toLowerCase();
      if (text === "p" || text === "pair") {
        const pair = runtime.pairing.issueCode();
        console.log(`[psyber] 控制台交互签发一次性配对码（5 分钟有效）：${pair.code}`);
      }
    };
    process.stdin.on("data", ttyListener);
  }

  const shutdown = async (signal: string) => {
    console.log(`[psyber] 收到 ${signal}，正在等待后台整理收尾并安全停机...`);
    if (ttyListener) {
      process.stdin.off("data", ttyListener);
    }
    server.stop();
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Failed to start Psyber server:", err);
    process.exit(1);
  });
}
