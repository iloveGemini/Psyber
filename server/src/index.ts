import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { createApp } from "./api/app.ts";
import {
  DEFAULT_DISCOVERY_PORT,
  getLanUrls,
  startLanDiscoveryResponder,
  type LanDiscoveryResponder,
} from "./api/discovery.ts";
import { PairingManager, buildPairQrPayload, isLoopbackIp } from "./api/pairing.ts";
import { renderTerminalQr } from "./api/qr.ts";
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
import {
  evaluateAndRunReflect,
  maybeRunReflectAfterBedtime,
  type DecisionClient,
  type ReflectScope,
  type ReflectTaskOutcome,
} from "./engine/reflect.ts";
import { SseHub } from "./engine/sse.ts";
import {
  runMemoryTidyTask,
  type TidyTaskOutcome,
  type TidyTaskType,
} from "./engine/tidy.ts";
import { syncStaticStickers } from "./expression/stickers.ts";
import { registerBashTool } from "./extensions/bash.ts";
import { registerFsTools } from "./extensions/fs_tools.ts";
import { registerWebFetchTool } from "./extensions/web_fetch.ts";
import { McpManager, type McpManagerDeps } from "./extensions/mcp.ts";
import { ModelCatalogService } from "./llm/catalog.ts";
import type { ChatModelClient } from "./llm/client.ts";
import { DynamicDecisionClient, LlmFallbackDecisionClient } from "./llm/decision.ts";
import { DynamicChatModel, type ResolvedByokSlot } from "./llm/router.ts";
import { DrawerStore } from "./memory/drawer.ts";
import { readIdentityProfile } from "./memory/genesis.ts";
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
  /** 可注入决策模型客户端（供离线测试验证反思门控） */
  decisionClient?: DecisionClient;
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
  /** 可注入 bash 内置 trash 废纸篓目录，供离线测试隔离避免触碰真实废纸篓 */ 
  bashTrashDir?: string;
  /** 是否启动后台定时心跳（生产默认 true，单测可传 false 后手动调用 tickHeartbeat） */
  startHeartbeatTimer?: boolean;
  /** 启动发现昨夜因关机错过 bedtime 时是否自动在后台补跑（默认 true） */
  catchUpMissedBedtime?: boolean;
  /** 自定义客户端真实 IP 解析器（生产环境由 Bun.serve server.requestIP 注入） */
  getClientIp?: (req: Request) => string;
  /** 返回扫码二维码所需的候选局域网 URL 列表 */
  getPairUrls?: () => string[];
  /** 显式放行的浏览器 Origin 白名单 */
  allowedOrigins?: string[];
  /** HTTP 服务端口（用于写入 0600 local_pair.json） */
  httpPort?: number;
  /** 传输协议（http 或 https） */
  protocol?: "http" | "https";
  /** 是否写入 0600 local_pair.json 供本机桌面端免码配对（生产启动默认 true，单测默认 false） */
  writeLocalPairFile?: boolean;
  /** 可选：额外写入用户级活跃实例指针（如 ~/.psyber/active_local_pair.json），供自定义 PSYBER_DATA_DIR 切换实例时本机桌面端自动识别 */
  activeLocalPairPath?: string;
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
  /** 手动触发一次日/周深度反思门控与执行（用于测试或 CLI 调试） */
  triggerReflect: (scope: ReflectScope, targetDay?: string) => Promise<ReflectTaskOutcome>;
  /** 手动触发一次 SQLite VACUUM INTO 本地日原子热备 */
  triggerBackup: () => Promise<string | null>;
  /** 等待当前队列中的异步整理与备份任务收尾（可选超时毫秒，避免停机无限阻塞） */
  waitForIdle: (timeoutMs?: number) => Promise<boolean>;
  /** 优雅停机：停心跳、断 SSE、删本机凭证、等后台收尾、关数据库连接 */
  stop: (opts?: { waitTimeoutMs?: number }) => Promise<void>;
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
  const localSecret = pairing.issueLocalSecret();
  const localPairPath = path.join(dataDir, "local_pair.json");
  const activeLocalPairPath = opts.activeLocalPairPath;
  const writePrivateJson = async (targetPath: string, content: string) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmpPath, content, { mode: 0o600 });
    await fs.chmod(tmpPath, 0o600).catch(() => {});
    await fs.rename(tmpPath, targetPath);
    await fs.chmod(targetPath, 0o600).catch(() => {});
  };
  if (opts.writeLocalPairFile) {
    const payload = JSON.stringify(
      {
        secret: localSecret,
        port: opts.httpPort ?? 3721,
        host: "127.0.0.1",
        protocol: opts.protocol ?? "http",
        instanceId: config.instanceId,
        pid: process.pid,
        updatedAt: clock.now(),
      },
      null,
      2,
    );
    await writePrivateJson(localPairPath, payload);
    if (activeLocalPairPath && path.resolve(activeLocalPairPath) !== path.resolve(localPairPath)) {
      await writePrivateJson(activeLocalPairPath, payload).catch(() => {});
    }
  }
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
  registerBashTool(registry, {
    dataDir,
    getConfig: () => config,
    trashDir: opts.bashTrashDir,
  });
  registerFsTools(registry, {
    dataDir,
    getConfig: () => config,
  });
  registerWebFetchTool(registry, {
    fetchImpl: opts.fetchImpl,
  });
  registry.setDisabledTools(config.disabledTools ?? []);

  const modelCatalog = new ModelCatalogService(dataDir);
  await modelCatalog.loadFromDisk();
  // 仅在常规运行模式且缓存过期时异步静默刷新 models.dev 目录（单测关闭心跳时零外网请求）
  if (opts.startHeartbeatTimer !== false && modelCatalog.isStale(clock.now())) {
    void modelCatalog.syncFromRemote({ fetchImpl: opts.fetchImpl, nowMs: clock.now() });
  }

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
    opts.chatModel ??
    new DynamicChatModel({ dataDir, getConfig: () => config, slot: "chat", catalog: modelCatalog });
  const tidyModel =
    opts.chatModel ??
    new DynamicChatModel({
      dataDir,
      getConfig: () => config,
      slot: "memory_task",
      catalog: modelCatalog,
    });
  const decisionClient: DecisionClient =
    opts.decisionClient ??
    (opts.chatModel
      ? new LlmFallbackDecisionClient(opts.chatModel, "injected-chat-model")
      : new DynamicDecisionClient({
          dataDir,
          getConfig: () => config,
          catalog: modelCatalog,
          fetchImpl: opts.fetchImpl,
        }));

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
          getConfig: () => config,
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
              getConfig: () => config,
            },
            { taskType, nightDate: targetNight },
          );
          if (
            res.ok &&
            (res.touchedMemoryPaths.includes("core/self.md") ||
              res.touchedMemoryPaths.includes("core/user.md"))
          ) {
            const identity = await readIdentityProfile(dataDir, clock.now(), config.timezone);
            sse.emit("identity.updated", { ...identity });
          }
          if (taskType === "bedtime" && res.ok && targetNight) {
            lastBedtimeNightDate = targetNight;
            // 睡前整理完成后按 Git 变更 + Decision 门控自动评估日反思与周日回顾反思
            const reflectRes = await maybeRunReflectAfterBedtime(
              {
                db,
                dataDir,
                promptsDir,
                clock,
                memoryIndex,
                memoryTools,
                chatModel: tidyModel,
                decisionClient,
                getConfig: () => config,
              },
              { targetDay: targetNight },
            );
            const reflectTouched = [
              ...reflectRes.daily.touchedMemoryPaths,
              ...(reflectRes.weekly?.touchedMemoryPaths ?? []),
            ];
            if (
              reflectTouched.includes("core/self.md") ||
              reflectTouched.includes("core/user.md")
            ) {
              const identity = await readIdentityProfile(dataDir, clock.now(), config.timezone);
              sse.emit("identity.updated", { ...identity });
            }
            // Spec 05 §4.1：bedtime 睡前整理与反思完成后自动触发一次 VACUUM INTO 本地日原子热备
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
            onThinkingDelta: (delta, step) =>
              sse.emit("turn.thinking", {
                turnId: wakeTurnId,
                delta,
                ...(step !== undefined ? { step } : {}),
              }),
            onToolProgress: (info) => sse.emit("turn.tool", { ...info }),
            onTextDelta: (delta) => sse.emit("turn.text", { turnId: wakeTurnId, delta }),
            onExpression: (payload) => sse.emit("turn.expression", { turnId: wakeTurnId, ...payload }),
            onSystemNoticePersisted: (ev) => sse.emit("message.created", { message: ev }),
            onIdentityUpdated: (identity) => sse.emit("identity.updated", { ...identity }),
            onDoorUpdated: (state, note) => {
              sse.emit("door.updated", { state, note, updatedAt: clock.now() });
              void notifications.notify({
                kind: "door_updated",
                title: "门状态更新",
                body: note ? `门牌：${note}` : `当前门状态：${state}`,
              });
            },
            onDoorNotePersisted: (ev) => {
              sse.emit("message.created", { message: ev });
            },
            onDoorNotesRead: (upToId) => {
              sse.emit("door_notes.read", { upToId });
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
          const identity = await readIdentityProfile(dataDir, clock.now(), config.timezone);
          await notifications.notify({
            kind: "wake",
            title: identity.residentName || "Psyber",
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
            if (r.space !== "episodes") return false;
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
    toolRegistry: registry,
    modelCatalog,
    notifications,
    approvalTimeoutMs: opts.approvalTimeoutMs,
    onUserMessagePersisted: () => {
      consecutiveUnansweredWakes = 0;
    },
    onSettingsUpdated: () => {
      rescheduleHeartbeatTimer();
    },
    getClientIp: opts.getClientIp,
    getPairUrls: opts.getPairUrls,
    allowedOrigins: opts.allowedOrigins,
    fetchImpl: opts.fetchImpl,
    llmTestClientFactory: opts.llmTestClientFactory,
  });

  const waitForIdle = async (timeoutMs?: number): Promise<boolean> => {
    if (pendingPromises.size === 0) return true;
    const drain = (async () => {
      while (pendingPromises.size > 0) {
        await Promise.allSettled(Array.from(pendingPromises));
      }
      return true;
    })();
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return drain;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const finished = await Promise.race([drain, timedOut]);
    if (timer !== null) clearTimeout(timer);
    return finished;
  };

  const stop = async (stopOpts?: { waitTimeoutMs?: number }): Promise<void> => {
    stopped = true;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    sse.disconnectAll();
    if (opts.writeLocalPairFile) {
      await fs.rm(localPairPath, { force: true }).catch(() => {});
      if (activeLocalPairPath) {
        try {
          const raw = await fs.readFile(activeLocalPairPath, "utf-8");
          const parsed = JSON.parse(raw) as { pid?: unknown };
          if (parsed?.pid === process.pid) {
            await fs.rm(activeLocalPairPath, { force: true }).catch(() => {});
          }
        } catch {
          // 文件不存在或已由其他实例覆盖，静默忽略
        }
      }
    }
    await mcp.stop().catch(() => {});
    const idle = await waitForIdle(stopOpts?.waitTimeoutMs);
    if (!idle) {
      console.warn("[psyber] 后台整理任务收尾超时，已跳过等待并继续停机。");
    }
    try {
      db.close();
    } catch {
      // 避免停机阶段因数据库句柄状态异常阻断进程退出
    }
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
    triggerReflect: (scope: ReflectScope, targetDay?: string) =>
      tidyMutex.runExclusive(() =>
        evaluateAndRunReflect(
          {
            db,
            dataDir,
            promptsDir,
            clock,
            memoryIndex,
            memoryTools,
            chatModel: tidyModel,
            decisionClient,
            getConfig: () => config,
          },
          { scope, targetDay },
        ),
      ),
    triggerBackup,
    waitForIdle,
    stop,
  };
}

async function main(): Promise<void> {
  const port = Number(process.env.PSYBER_PORT || 3721);
  // Spec 05 §5.3：默认监听 0.0.0.0 供局域网移动端扫码直连，仅本机使用可设 127.0.0.1
  const host = process.env.PSYBER_HOST || "0.0.0.0";
  const tlsCertPath = process.env.PSYBER_TLS_CERT?.trim();
  const tlsKeyPath = process.env.PSYBER_TLS_KEY?.trim();
  const protocol: "http" | "https" = tlsCertPath && tlsKeyPath ? "https" : "http";
  const allowedOrigins = (process.env.PSYBER_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const requestIps = new WeakMap<Request, string>();
  const resolvePairUrls = () => {
    const lan = getLanUrls(port, protocol);
    return lan.length > 0 ? lan : [`${protocol}://127.0.0.1:${port}`];
  };

  const runtime = await bootPsyberRuntime({
    httpPort: port,
    protocol,
    writeLocalPairFile: true,
    activeLocalPairPath: path.join(os.homedir(), ".psyber", "active_local_pair.json"),
    allowedOrigins,
    getClientIp: (req) => requestIps.get(req) ?? "unknown",
    getPairUrls: resolvePairUrls,
  });

  const server = Bun.serve({
    hostname: host,
    port,
    // SSE 长连接心跳间隔 25s，必须禁用 Bun 默认 10s idleTimeout，避免流式生成中途被服务端强行断流
    idleTimeout: 0,
    ...(tlsCertPath && tlsKeyPath
      ? { tls: { cert: Bun.file(tlsCertPath), key: Bun.file(tlsKeyPath) } }
      : {}),
    fetch(req, srv) {
      const ip = srv.requestIP(req)?.address;
      if (ip) {
        requestIps.set(req, ip);
      }
      return runtime.app.fetch(req);
    },
  });

  console.log(`Psyber server listening on ${protocol}://${host}:${port} (dataDir=${runtime.dataDir})`);
  if (protocol === "http" && !isLoopbackIp(host)) {
    console.log(
      "[psyber] 安全提示：当前局域网以明文 HTTP 监听，请仅在可信 Wi-Fi 或 Tailscale 下配对；如需加密可配置 PSYBER_TLS_CERT 与 PSYBER_TLS_KEY。",
    );
  }

  let discovery: LanDiscoveryResponder | null = null;
  if (!isLoopbackIp(host) && process.env.PSYBER_DISCOVERY !== "0") {
    const discoveryPort = Number(process.env.PSYBER_DISCOVERY_PORT || DEFAULT_DISCOVERY_PORT);
    let cachedResidentName: string | null = null;
    void readIdentityProfile(runtime.dataDir, runtime.clock.now(), runtime.config.timezone)
      .then((id) => {
        cachedResidentName = id.residentName;
      })
      .catch(() => {});
    try {
      discovery = await startLanDiscoveryResponder({
        port: discoveryPort,
        httpPort: port,
        protocol,
        version: "0.1.0",
        getInstanceId: () => runtime.config.instanceId,
        getResidentName: () => cachedResidentName,
        getUrls: resolvePairUrls,
      });
      console.log(`[psyber] 局域网自动发现已启用（UDP ${discovery.port}，仅广播发现信息，不含配对码）`);
    } catch (err) {
      console.warn("[psyber] 局域网自动发现启动失败（不影响主服务）：", err);
    }
  }

  const printPairCodeWithQr = (prefix: string) => {
    const pair = runtime.pairing.issueCode();
    const urls = resolvePairUrls();
    const qrPayload = buildPairQrPayload(urls, pair.code);
    console.log(`${prefix}（5 分钟有效）：${pair.code}`);
    console.log(`[psyber] 候选连接地址：${urls.join(" , ")}`);
    try {
      console.log(renderTerminalQr(qrPayload));
    } catch {
      // 载荷过长或终端不支持时回退文本提示
    }
  };

  const forcePair =
    process.argv.includes("--pair") ||
    process.argv.includes("-p") ||
    process.env.PSYBER_PAIR === "1" ||
    process.env.PSYBER_ISSUE_PAIR === "1";

  // 首次无已配对设备，或启动时带 --pair 选项时，自动打印 8 位一次性配对码与终端二维码
  if (runtime.config.auth.devices.length === 0 || forcePair) {
    printPairCodeWithQr(
      runtime.config.auth.devices.length === 0
        ? "[psyber] 尚未配对任何客户端，一次性配对码"
        : "[psyber] 已手动请求签发新设备配对码",
    );
  } else {
    console.log(
      `[psyber] 当前已有 ${runtime.config.auth.devices.length} 台已配对设备。如需配对新客户端，可在本终端按 p 回车，或在桌面端设置「工具与设备」生成扫码二维码。`,
    );
  }

  // 交互式终端模式下，支持随时在控制台按 p / pair 回车签发新配对码
  let ttyListener: ((chunk: string) => void) | null = null;
  if (process.stdin.isTTY) {
    process.stdin.setEncoding("utf-8");
    ttyListener = (chunk: string) => {
      const text = chunk.trim().toLowerCase();
      if (text === "p" || text === "pair") {
        printPairCodeWithQr("[psyber] 控制台交互签发一次性配对码");
      }
    };
    process.stdin.on("data", ttyListener);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`[psyber] 再次收到 ${signal}，立即强制退出。`);
      process.exit(130);
      return;
    }
    shuttingDown = true;
    console.log(
      `[psyber] 收到 ${signal}，正在等待后台整理收尾并安全停机（再次按 Ctrl+C 可立即退出）...`,
    );
    if (ttyListener) {
      process.stdin.off("data", ttyListener);
      process.stdin.pause();
      (process.stdin as { unref?: () => void }).unref?.();
    }

    const hardExitTimer = setTimeout(() => {
      console.warn("[psyber] 停机收尾超过 5 秒，已自动退出。");
      process.exit(0);
    }, 5_000);
    hardExitTimer.unref?.();

    try {
      runtime.sse.disconnectAll();
      void server.stop(true);
      await discovery?.close();
      await runtime.stop({ waitTimeoutMs: 4_000 });
    } catch (err) {
      console.error("[psyber] 停机过程中出现异常：", err);
    } finally {
      clearTimeout(hardExitTimer);
      process.exit(0);
    }
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
