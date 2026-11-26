import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";
import { localDay, localWeekday, vagueTimeOfDay, vagueWhen } from "../core/clock.ts";
import type { DoorState, PsyberConfig } from "../core/config.ts";
import { commitMemoryPaths } from "../core/git.ts";
import type { MediaStore } from "../core/media.ts";
import { AsyncMutex } from "../core/mutex.ts";
import { readPrompt } from "../core/prompts.ts";
import { ulid } from "../core/ulid.ts";
import type {
  ChatImageContent,
  ChatMessage,
  ChatModelClient,
  ChatStopReason,
  ChatToolCall,
  ChatUserContent,
  LlmErrorCode,
} from "../llm/client.ts";
import { resolveEffectiveThinkingLevel } from "../llm/router.ts";
import { filterActiveStateMarkdown } from "../memory/frontmatter.ts";
import {
  parseSelfIdentity,
  readIdentityProfile,
  type IdentityProfile,
} from "../memory/genesis.ts";
import { buildContinuityBlock } from "../memory/gist.ts";
import type { MemoryIndex } from "../memory/index.ts";
import type { DecisionClient } from "../core/decision.ts";
import type { RerankerClient } from "../core/reranker.ts";
import { recallMemories, type EmbeddingClient } from "../memory/recall.ts";
import { renderCircadianState } from "../mood/circadian.ts";
import type { ActiveSessionRecord, EventStore, StoredEvent } from "../store/events.ts";
import type {
  ExpressionPayload,
  ShareCardRecord,
  ToolApprovalRequest,
  ToolApprovalResult,
  ToolExecutionContext,
  ToolRegistry,
} from "../tools/registry.ts";
import type { HotTidySessionContext } from "./tidy.ts";

const STATIC_PREFIX_PATHS = new Set([
  "core/self.md",
  "core/user.md",
  "core/boundaries.md",
  "core/mirror.md",
  "core/open.md",
  "core/state.md",
]);

const MAX_TOOL_STEPS = 12;
const WAKE_SILENT_PREFIX_BUFFER_LEN = 16;
const ROLLOVER_RATIO = 0.75;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];
const STICKER_INJECT_LIMIT = 30;
const STICKER_INJECT_MAX_CHARS = 500;

export interface ToolProgressEvent {
  turnId: string;
  callId: string;
  name: string;
  label: string;
  kind: "general" | "screen";
  status: "running" | "done" | "error";
  step?: number;
}

export interface JournalStepTool {
  name: string;
  label: string;
  ok: boolean;
  kind: "general" | "screen";
}

export interface JournalStepRecord {
  step: number;
  thinking?: string;
  tools: JournalStepTool[];
}

export interface ContextUsageSnapshot {
  usedTokens: number;
  limitTokens: number;
  ratio: number;
}

export interface TurnStreamCallbacks {
  onTurnStart?: (info: { turnId: string; mode: "chat" | "wake" }) => void;
  onThinkingDelta?: (delta: string, step?: number) => void;
  onToolProgress?: (info: ToolProgressEvent) => void;
  onTextDelta?: (delta: string) => void;
  onExpression?: (payload: ExpressionPayload) => void;
  onDoorUpdated?: (state: DoorState, note: string | null) => void;
  onDoorNotePersisted?: (event: StoredEvent) => void;
  onDoorNotesRead?: (upToId: string) => void;
  onMessageRetracted?: (event: StoredEvent) => void;
  onAssistantPersisted?: (event: StoredEvent) => void;
  onSystemNoticePersisted?: (event: StoredEvent) => void;
  onIdentityUpdated?: (identity: IdentityProfile) => void;
  onModelSwitched?: (info: { turnId: string; model: string; reason?: string }) => void;
  onRequestApproval?: (req: ToolApprovalRequest) => Promise<ToolApprovalResult>;
  onTurnSilence?: (info: { turnId: string; ownTime: boolean }) => void;
  onTurnDone?: (info: {
    turnId: string;
    mode: "chat" | "wake";
    messageId: string | null;
    recallCount: number;
    aborted: boolean;
    silent: boolean;
    rolledOver: boolean;
    contextUsage?: ContextUsageSnapshot;
  }) => void;
  onTurnError?: (err: { turnId: string; code: LlmErrorCode; message: string; retryable: boolean }) => void;
}

const CHAT_TOOL_LABELS: Record<string, string> = {
  glob: "翻了翻记忆目录",
  grep: "在旧笔记里找线索",
  read: "翻开看了一篇记忆",
  write: "提笔写下一张记忆",
  edit: "修改了记忆片段",
  door: "调整了门锁状态",
  tool_search: "翻找了工具箱",
  call_tool: "取用了扩展工具",
  look_at_screen: "看了一眼你的屏幕",
  retract_message: "撤回了一条消息",
  share: "递出了一张分享卡",
  leave_door_note: "在门缝下留了一张纸条",
  drawer_read: "翻看了上锁抽屉",
  drawer_write: "往抽屉里封存了一篇日记",
};

const WAKE_TOOL_LABELS: Record<string, string> = {
  glob: "趁你不在，翻了翻记忆目录",
  grep: "趁你不在，翻找旧线索",
  read: "趁你不在，翻看了旧笔记",
  write: "趁你不在，写了一笔新笔记",
  edit: "趁你不在，整理修改了笔记",
  door: "调整了门锁状态",
  tool_search: "趁你不在，翻了翻工具箱",
  call_tool: "趁你不在，取用了扩展工具",
  look_at_screen: "看了一眼你的屏幕",
  retract_message: "撤回了一条消息",
  share: "留了一张分享卡",
  leave_door_note: "趁你不在，在门缝下留了一张纸条",
  drawer_read: "趁你不在，翻看了上锁抽屉",
  drawer_write: "趁你不在，往抽屉里封存了一篇日记",
};

export function formatToolActionLabel(toolName: string, mode: "chat" | "wake"): string {
  const table = mode === "wake" ? WAKE_TOOL_LABELS : CHAT_TOOL_LABELS;
  if (table[toolName]) return table[toolName]!;
  if (toolName.startsWith("mcp.")) {
    const parts = toolName.split(".");
    const serverId = parts[1] ?? "mcp";
    const shortName = parts.slice(2).join(".") || toolName;
    return mode === "wake"
      ? `趁你不在，调用了外部工具 ${serverId}/${shortName}`
      : `调用了外部工具 ${serverId}/${shortName}`;
  }
  return toolName;
}

export interface TurnCheckpoint {
  turnId: string;
  sessionId: string;
  mode: "chat" | "wake";
  userEventId?: string;
  systemPrompt: string;
  messages: ChatMessage[];
  fullText: string;
  fullThinking: string;
  recordedToolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    ok: boolean;
    output: string;
  }>;
  toolSummary: Array<{
    name: string;
    label: string;
    ok: boolean;
    kind: "general" | "screen";
  }>;
  toolProgress: ToolProgressEvent[];
  journalSteps?: JournalStepRecord[];
  expressions: ExpressionPayload[];
  shares: ShareCardRecord[];
  touchedMemoryPaths: string[];
  injectedDoorNoteMaxId: string | null;
  injectedNoticeMaxId: string | null;
  recallCount: number;
  completedToolSteps: number;
  rolledOver: boolean;
}

export interface RunTurnResult {
  turnId: string;
  sessionId: string;
  message: StoredEvent | null;
  text: string;
  thinking: string;
  recallCount: number;
  aborted: boolean;
  silent: boolean;
  rolledOver: boolean;
  touchedMemoryPaths: string[];
  error?: { code: LlmErrorCode; message: string; retryable: boolean };
  checkpoint?: TurnCheckpoint;
}

export type RolloverReason = "threshold" | "overflow" | "manual" | "bedtime";

export interface RolloverStatusEvent {
  phase: "wrapping" | "done" | "error";
  reason: RolloverReason;
  oldSessionId?: string;
  newSessionId?: string;
  contextUsage?: ContextUsageSnapshot;
  message?: string;
}

export interface RolloverResult {
  ok: boolean;
  oldSessionId: string;
  newSessionId: string;
  wrapped: boolean;
  error?: string;
}

export interface DirectEngineDeps {
  dataDir: string;
  promptsDir: string;
  clock: Clock;
  getConfig: () => PsyberConfig;
  events: EventStore;
  memoryIndex: MemoryIndex;
  registry: ToolRegistry;
  chatModel: ChatModelClient;
  /** SQLite 连接（用于接入 recallMemories 3 步召回与 recall_traces 留痕） */
  db?: Database;
  /** 内容寻址媒体仓（用于将用户上传的图片附件编码为多模态块送入模型） */
  media?: MediaStore;
  /** 可选 Embedding 客户端（缺省或超时自动降级 FTS5 2-gram） */
  embedding?: EmbeddingClient;
  /** 可选二阶段精排客户端（如 Qwen3-Reranker-8B；缺省或超时平滑降级） */
  reranker?: RerankerClient;
  /** 可选决策模型客户端（用于每轮召回门控与候选精排；缺省或超时平滑降级） */
  decisionClient?: DecisionClient;
  /** 429/5xx 指数退避延迟（默认 [1000, 3000] ms，离线测试可传 [0, 0]） */
  retryDelaysMs?: number[];
  /**
   * 换段前同步收尾回调（在切新 sessionId 之前排空 daily_wrapup，保证新段不失忆；
   * 返回 ok: false 时保留旧 sessionId 不硬切）
   */
  onBeforeRollover?: (ctx: {
    oldSessionId: string;
    reason: RolloverReason;
    cutoffSeq: number | null;
    /** 非溢出换段且当前会话有充足余量时提供，用于会话尾部热写命中 Prompt Cache */
    hotSession?: HotTidySessionContext | null;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** 换段状态通知（供 SSE 广播 turn.rollover，前端显示「正在收拢这段记忆…」） */
  onRolloverStatus?: (event: RolloverStatusEvent) => void;
  /** 切入新 sessionId 后的通知钩子 */
  onRollover?: (oldSessionId: string, newSessionId: string) => void;
}

async function readOptionalMemoryFile(dataDir: string, relPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(dataDir, "memory", relPath), "utf8");
    return content.trim() ? content.trim() : null;
  } catch {
    return null;
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 极薄 Direct Engine（对齐 Spec 01 §2–§5）：
 * - 三明治上下文：Static Prefix（含新段首轮冻结的 <continuity>）会话级锁死 + Append-Only History（按当前 sessionId 完整回放并剥除历史 thinking）+ Dynamic Tail（原话置顶、语境置底，tool_result 绝不重复注入）
 * - 单轮多步工具循环内保留 thinking + signature，429/5xx 指数退避重试 2 次
 * - 接入 Ring 1 极简 3 步召回（recallMemories）并写入 recall_traces 与 turn.done.recallCount
 * - wake [SILENT] 前 16 字符暂缓推流
 * - 达 75% / CONTEXT_OVERFLOW / 手动换段时先同步收尾整理旧段，成功后再切新 session_id 并持久化活跃会话指针
 */
export class DirectEngine {
  private activeState: ActiveSessionRecord;
  private staticPrefixSnapshot: string | null = null;
  private readonly prefixDelta = new Map<string, string>();
  private readonly turnMutex = new AsyncMutex();
  private needsLegacyContinuity = false;
  private rolloverInProgress = false;
  private lastUsedTokens = 0;
  private lastAssistantModel: string | null = null;
  private activeChatWaiters = 0;
  private yieldableTidyAbort: AbortController | null = null;

  constructor(private readonly deps: DirectEngineDeps) {
    const nowMs = deps.clock.now();
    const persisted = deps.events.getActiveSessionState();
    const latest = deps.events.getLatestChatEvent();
    const bedtimeRunAt = deps.events.getBedtimeLastRunAt();

    if (persisted) {
      const bedtimeRanAfterLatest =
        latest !== null && bedtimeRunAt !== null && bedtimeRunAt > latest.createdAt;
      if (bedtimeRanAfterLatest && !persisted.fresh) {
        // 停机前刚跑完 bedtime 但尚未切段：启动时补切 fresh 新段
        this.activeState = {
          sessionId: ulid(nowMs),
          fresh: true,
          carryOverUntilSeq: latest.seq,
          continuity: null,
        };
        deps.events.setActiveSessionState(this.activeState);
      } else {
        // 严格信任持久化状态：哪怕 fresh===true（刚换段尚未发言就重启），也绝不复活已收尾旧段
        this.activeState = persisted;
        if (!persisted.fresh) {
          this.lastUsedTokens = deps.events.getLatestSessionUsageTokens(persisted.sessionId);
        }
      }
      return;
    }

    if (!latest) {
      this.activeState = {
        sessionId: ulid(nowMs),
        fresh: false,
        carryOverUntilSeq: null,
        continuity: null,
      };
      deps.events.setActiveSessionState(this.activeState);
      return;
    }

    const bedtimeRanAfterLastMsg = bedtimeRunAt !== null && bedtimeRunAt > latest.createdAt;
    if (!bedtimeRanAfterLastMsg) {
      // 尚未经过 bedtime 整理消化：续接原 sessionId，保留完整历史并恢复上下文水位
      this.activeState = {
        sessionId: latest.sessionId,
        fresh: false,
        carryOverUntilSeq: null,
        continuity: null,
      };
      this.lastUsedTokens = deps.events.getLatestSessionUsageTokens(latest.sessionId);
      if (deps.events.hasMessagesBeforeSession(latest.sessionId)) {
        this.needsLegacyContinuity = true;
      }
    } else {
      // 昨夜已完成 bedtime：启 fresh 新段，首轮开口前惰性定格 <continuity>
      this.activeState = {
        sessionId: ulid(nowMs),
        fresh: true,
        carryOverUntilSeq: latest.seq,
        continuity: null,
      };
    }
    deps.events.setActiveSessionState(this.activeState);
  }

  /**
   * 晚间或开机补跑的 bedtime 完成后调用（调用方必须在释放 tidyMutex 后调用，保证锁单向零死锁）：
   * - 按数据库真实事件校验：若期间用户已发来晚于本次已消化游标的新对话，不中途打断；
   * - 否则切入 fresh 新段（若已在空新段则刷新过渡截止点与待拼 continuity），常驻运行也能每晚自动换段。
   */
  onBedtimeCompleted(digestedUpToEventId?: string | null): Promise<boolean> {
    return this.turnMutex.runExclusive(async () => {
      const latest = this.deps.events.getLatestChatEvent();
      if (!latest) return false;

      const cutoffId =
        digestedUpToEventId ??
        this.deps.events.getCursor("bedtime") ??
        this.deps.events.getCursor("daily_wrapup");
      if (cutoffId && latest.id > cutoffId) {
        return false;
      }

      if (
        this.activeState.fresh &&
        !this.deps.events.hasMessagesInSession(this.activeState.sessionId)
      ) {
        this.activeState = {
          ...this.activeState,
          carryOverUntilSeq: latest.seq,
          continuity: null,
        };
        this.staticPrefixSnapshot = null;
        this.deps.events.setActiveSessionState(this.activeState);
        return true;
      }

      const res = await this.performRollover({
        reason: "bedtime",
        runWrapup: false,
        cutoffSeq: latest.seq,
      });
      return res.ok;
    });
  }

  /**
   * 构造当前活跃会话的热写上下文（必须在 turnMutex 内调用）：
   * - 复用完全一致的 Static Prefix、工具定义与当前 sessionId 历史消息，命中 KV Prompt Cache；
   * - 仅当当前段非空、剩余窗口充足、且全部未整理事件均归属本会话时才启用，否则返回 null 自动走冷写。
   */
  private async buildHotTidySessionContext(opts?: {
    maxSeq?: number | null;
  }): Promise<HotTidySessionContext | null> {
    if (this.activeState.fresh) return null;
    const sessionId = this.activeState.sessionId;
    if (!this.deps.events.hasMessagesInSession(sessionId)) return null;

    const minHeadroom = Math.min(16_000, Math.floor(this.deps.chatModel.contextWindow * 0.2));
    if (this.deps.chatModel.contextWindow - this.lastUsedTokens < minHeadroom) {
      return null;
    }

    // 若游标之后存在早于本会话的未整理旧事件，必须走冷写分批避免漏整理
    if (this.deps.db) {
      const cursorId = this.deps.events.getCursor("daily_wrapup") ?? "";
      const maxSeq = opts?.maxSeq;
      const foreignRow = (
        typeof maxSeq === "number" && Number.isFinite(maxSeq)
          ? this.deps.db
              .query(
                `SELECT 1 AS hit FROM events
                 WHERE status IN ('active', 'retracted')
                   AND role IN ('user', 'assistant')
                   AND kind IN ('chat', 'wake', 'door_note')
                   AND id > ?
                   AND seq <= ?
                   AND session_id != ?
                 LIMIT 1`,
              )
              .get(cursorId, maxSeq, sessionId)
          : this.deps.db
              .query(
                `SELECT 1 AS hit FROM events
                 WHERE status IN ('active', 'retracted')
                   AND role IN ('user', 'assistant')
                   AND kind IN ('chat', 'wake', 'door_note')
                   AND id > ?
                   AND session_id != ?
                 LIMIT 1`,
              )
              .get(cursorId, sessionId)
      ) as { hit: number } | null;
      if (foreignRow?.hit) return null;
    }

    const identity = await readIdentityProfile(
      this.deps.dataDir,
      this.deps.clock.now(),
      this.deps.clock.timeZone,
    );
    const userLabel = identity.userName ?? identity.userPronoun ?? "TA";
    const beforeSeq =
      typeof opts?.maxSeq === "number" && Number.isFinite(opts.maxSeq)
        ? opts.maxSeq + 1
        : undefined;
    const historyMessages = this.buildHistoryMessages(userLabel, undefined, beforeSeq);
    if (historyMessages.length === 0) return null;

    await this.ensureContinuityFrozen();
    const systemPrompt = await this.getOrBuildStaticPrefix();
    const tools = this.deps.registry.getTier1Definitions();
    return {
      sessionId,
      systemPrompt,
      historyMessages,
      tools,
      chatModel: this.deps.chatModel,
    };
  }

  /**
   * 在 turnMutex 保护下执行可让路的会话尾部整理（如 bedtime）：
   * - 若已有用户聊天在排队或整理途中用户发来新消息，立即 abort 让路且不换段；
   * - 若整理成功且调用方请求换段，在同一把 turnMutex 内原子切入 fresh 新段，防止用户消息插队错位。
   */
  runYieldableSessionTidy<T>(
    opts: { maxSeq?: number | null },
    fn: (ctx: {
      sessionId: string;
      hotSession: HotTidySessionContext | null;
      signal: AbortSignal;
    }) => Promise<{ result: T; shouldRollover: boolean; digestedUpToEventId?: string | null }>,
  ): Promise<
    | { deferred: true; sessionId: string }
    | { deferred: false; sessionId: string; result: T; rolledOver: boolean }
  > {
    if (this.activeChatWaiters > 0) {
      return Promise.resolve({ deferred: true, sessionId: this.activeState.sessionId });
    }
    return this.turnMutex.runExclusive(async () => {
      const sessionId = this.activeState.sessionId;
      if (this.activeChatWaiters > 0) {
        return { deferred: true as const, sessionId };
      }
      const ac = new AbortController();
      this.yieldableTidyAbort = ac;
      try {
        const hotSession = await this.buildHotTidySessionContext({ maxSeq: opts.maxSeq });
        if (ac.signal.aborted || this.activeChatWaiters > 0) {
          return { deferred: true as const, sessionId };
        }
        const out = await fn({ sessionId, hotSession, signal: ac.signal });
        if (ac.signal.aborted) {
          return { deferred: true as const, sessionId };
        }
        let rolledOver = false;
        if (out.shouldRollover) {
          const latest = this.deps.events.getLatestChatEvent();
          const cutoffId =
            out.digestedUpToEventId ??
            this.deps.events.getCursor("bedtime") ??
            this.deps.events.getCursor("daily_wrapup");
          if (latest && (!cutoffId || latest.id <= cutoffId)) {
            if (
              this.activeState.fresh &&
              !this.deps.events.hasMessagesInSession(this.activeState.sessionId)
            ) {
              this.activeState = {
                ...this.activeState,
                carryOverUntilSeq: latest.seq,
                continuity: null,
              };
              this.staticPrefixSnapshot = null;
              this.deps.events.setActiveSessionState(this.activeState);
              rolledOver = true;
            } else {
              const roll = await this.performRollover({
                reason: "bedtime",
                runWrapup: false,
                cutoffSeq: latest.seq,
              });
              rolledOver = roll.ok;
            }
          }
        }
        return { deferred: false as const, sessionId, result: out.result, rolledOver };
      } finally {
        if (this.yieldableTidyAbort === ac) {
          this.yieldableTidyAbort = null;
        }
      }
    });
  }

  private async ensureContinuityFrozen(): Promise<void> {
    if (!this.activeState.fresh && !this.needsLegacyContinuity) return;

    const tailEvents =
      typeof this.activeState.carryOverUntilSeq === "number"
        ? this.deps.events.listRecentMessages(40, this.activeState.carryOverUntilSeq)
        : [];
    const continuity = await buildContinuityBlock({
      dataDir: this.deps.dataDir,
      memoryIndex: this.deps.memoryIndex,
      nowMs: this.deps.clock.now(),
      timeZone: this.deps.clock.timeZone,
      lastBedtimeNightDate: this.deps.events.getBedtimeNightDate(),
      tailEvents,
      formatUserEvent: (ev) => this.formatHistoryUserContent(ev),
    });

    this.activeState = {
      ...this.activeState,
      fresh: false,
      continuity,
    };
    this.needsLegacyContinuity = false;
    this.staticPrefixSnapshot = null;
    this.deps.events.setActiveSessionState(this.activeState);
  }

  getActiveSessionId(): string {
    return this.activeState.sessionId;
  }

  isRolloverInProgress(): boolean {
    return this.rolloverInProgress;
  }

  private computeEffectiveRolloverLimit(mode: "chat" | "wake" = "chat"): number {
    const baseLimit = Math.max(1, Math.floor(this.deps.chatModel.contextWindow * ROLLOVER_RATIO));
    const limits = this.deps.getConfig().llm?.contextLimits;
    const custom = mode === "wake" ? limits?.solo : limits?.chat;
    if (typeof custom === "number" && Number.isFinite(custom) && custom >= 1000) {
      return Math.min(baseLimit, Math.floor(custom));
    }
    return baseLimit;
  }

  getContextUsage(): ContextUsageSnapshot {
    const limitTokens = this.computeEffectiveRolloverLimit("chat");
    const ratio = Math.min(1, Math.max(0, this.lastUsedTokens / limitTokens));
    return {
      usedTokens: this.lastUsedTokens,
      limitTokens,
      ratio,
    };
  }

  /** 手动「存记忆换段」：在互斥锁保护下先同步完成旧段整理，成功后再切新 session_id */
  manualRollover(): Promise<RolloverResult> {
    return this.turnMutex.runExclusive(async () => {
      const latest = this.deps.events.getLatestChatEvent();
      const hasSessionMsgs = this.deps.events.hasMessagesInSession(this.activeState.sessionId);
      const hasPendingWrapup = this.deps.events.getOldestPendingWrapupMs() !== null;
      if (this.activeState.fresh && !hasSessionMsgs && !hasPendingWrapup) {
        return {
          ok: true,
          oldSessionId: this.activeState.sessionId,
          newSessionId: this.activeState.sessionId,
          wrapped: false,
        };
      }
      return this.performRollover({
        reason: "manual",
        runWrapup: true,
        cutoffSeq: latest?.seq ?? null,
      });
    });
  }

  /** 构建或复用当前会话的 Static Prefix 快照（含新段首轮冻结的 <continuity>，盘中修改不回改） */
  private async getOrBuildStaticPrefix(): Promise<string> {
    if (this.staticPrefixSnapshot !== null) {
      return this.staticPrefixSnapshot;
    }
    const today = localDay(this.deps.clock.now(), this.deps.clock.timeZone);
    const selfMd = (await readOptionalMemoryFile(this.deps.dataDir, "core/self.md")) ?? "";
    const mainPrompt = await readPrompt(this.deps.promptsDir, "main.md");
    const userMd = await readOptionalMemoryFile(this.deps.dataDir, "core/user.md");
    const coreParts: string[] = [];
    for (const f of ["core/boundaries.md", "core/mirror.md", "core/open.md", "core/state.md"]) {
      const raw = await readOptionalMemoryFile(this.deps.dataDir, f);
      if (!raw) continue;
      const text = f === "core/state.md" ? filterActiveStateMarkdown(raw, today) : raw;
      if (text) coreParts.push(`### ${f}\n${text}`);
    }

    const sections: string[] = [];
    if (selfMd) sections.push(`<self>\n${selfMd}\n</self>`);
    sections.push(mainPrompt.body);
    if (userMd) sections.push(`<user>\n${userMd}\n</user>`);
    if (coreParts.length > 0) {
      sections.push(`<core>\n${coreParts.join("\n\n")}\n</core>`);
    }
    if (this.activeState.continuity) {
      sections.push(this.activeState.continuity);
    }

    this.staticPrefixSnapshot = sections.join("\n\n");
    return this.staticPrefixSnapshot;
  }

  /** 判断是否仍处于创世未定名状态（core/self.md 显式空 name: "" 或旧版 named: false） */
  private async isGenesisMode(): Promise<boolean> {
    const selfMd = await readOptionalMemoryFile(this.deps.dataDir, "core/self.md");
    if (!selfMd) return false;
    return !parseSelfIdentity(selfMd, this.deps.clock.now(), this.deps.clock.timeZone).named;
  }

  /** 将用户消息与贴纸元数据渲染为自然文本（Spec 03 §2.2：[贴纸: <label>]） */
  private formatUserTextWithSticker(text: string, stickerId?: string | null): string {
    const trimmed = text.trim();
    const sid = typeof stickerId === "string" ? stickerId.trim() : "";
    if (!sid) return text;
    const sticker = this.deps.events.getSticker(sid);
    const marker = `[贴纸: ${sticker?.label ?? sid}]`;
    return trimmed ? `${marker}\n${text}` : marker;
  }

  /** 渲染历史事件中的用户消息（含贴纸与既往图片数量标记，避免重复塞入历史 base64） */
  private formatHistoryUserContent(ev: StoredEvent): string {
    const stickerId =
      ev.metadata && typeof ev.metadata.stickerId === "string" ? ev.metadata.stickerId : null;
    const base = this.formatUserTextWithSticker(ev.content, stickerId);
    const attachments =
      ev.metadata && Array.isArray(ev.metadata.attachments) ? ev.metadata.attachments : [];
    if (attachments.length === 0) return base;
    const note = `[附带了 ${attachments.length} 张图片]`;
    return base.trim() ? `${base}\n${note}` : note;
  }

  /** 按近期使用排序拼装 <stickers> 清单（严格 ≤ 30 条 / ≤ 500 字符） */
  private buildStickersBlock(): string | null {
    const stickers = this.deps.events.listStickers(STICKER_INJECT_LIMIT);
    if (stickers.length === 0) return null;
    const prefix = "<stickers>\n";
    const suffix = "\n</stickers>";
    const maxBodyChars = STICKER_INJECT_MAX_CHARS - prefix.length - suffix.length;
    const lines: string[] = [];
    let bodyLen = 0;
    for (const s of stickers) {
      const line = `- ${s.id}: ${s.label}`;
      const nextLen = lines.length === 0 ? line.length : bodyLen + 1 + line.length;
      if (nextLen > maxBodyChars) break;
      lines.push(line);
      bodyLen = nextLen;
    }
    if (lines.length === 0) return null;
    return `${prefix}${lines.join("\n")}${suffix}`;
  }

  /** 构造 Segment 2：完整回放当前 sessionId 内的历史轮次（剥除历史 thinking；<continuity> 已冻结在 Static Prefix） */
  private buildHistoryMessages(
    userLabel: string,
    excludeEventId?: string,
    beforeSeq?: number,
  ): ChatMessage[] {
    const history: ChatMessage[] = [];
    const sessionEvents = this.deps.events.listSessionMessages(this.activeState.sessionId, {
      excludeEventId,
      beforeSeq,
    });
    for (const ev of sessionEvents) {
      if (ev.role === "user" && (ev.kind === "chat" || ev.kind === "door_note")) {
        // 双向社交撤回不对称性：用户撤回后，Psyber上下文只见占位看不到原文
        const content =
          ev.status === "retracted"
            ? `（${userLabel}撤回了一条消息）`
            : this.formatHistoryUserContent(ev);
        history.push({
          role: "user",
          content,
          timestamp: ev.createdAt,
        });
      } else if (ev.role === "assistant" && (ev.kind === "chat" || ev.kind === "wake" || ev.kind === "door_note")) {
        // 跨轮历史严格剥除 thinking；Psyber自己撤回的消息在自身上下文里保留原话
        const baseContent =
          ev.kind === "door_note" ? `[我留在门缝下的纸条] ${ev.content}` : ev.content;
        const content =
          ev.status === "retracted"
            ? `${baseContent}\n（我后来撤回了这条消息，${userLabel}看不到内容）`
            : baseContent;
        history.push({ role: "assistant", content, timestamp: ev.createdAt });
      }
    }
    return history;
  }

  /** 构造 Segment 3 Dynamic Tail（原话置顶，客观 <runtime_context> 置底，图片作为多模态块附后） */
  private async buildDynamicUserMessage(opts: {
    mode: "chat" | "wake";
    turnId: string;
    userText: string;
    userLabel: string;
    recentTurns?: Array<{ role: "user" | "assistant"; content: string }>;
    stickerId?: string;
    attachments?: string[];
    videoClip?: { durationSec: number; frameHashes: string[] };
    urgent?: boolean;
    wakeReason?: string;
    activityHint?: string;
  }): Promise<{
    content: ChatUserContent;
    injectedDoorNoteMaxId: string | null;
    injectedNoticeMaxId: string | null;
    recallCount: number;
  }> {
    const cfg = this.deps.getConfig();
    const nowMs = this.deps.clock.now();
    const tz = this.deps.clock.timeZone;
    const unreadNotesCount = this.deps.events.countUnreadDoorNotes();
    const circadianLabel = renderCircadianState(nowMs, tz, cfg.circadian);
    const userLabel = opts.userLabel;

    const runtimeAttrs = [
      `time="${vagueTimeOfDay(nowMs, tz)}"`,
      `weekday="${localWeekday(nowMs, tz)}"`,
      `circadian="${circadianLabel}"`,
      `door="${cfg.door.state}"`,
      `notes="${unreadNotesCount}"`,
      ...(opts.urgent ? [`urgent="true"`] : []),
      ...(cfg.userStatus?.undisturbed ? [`user_dnd="true"`] : []),
      ...(cfg.recallEvalNoticeResident ? [`eval_mode="true"`] : []),
    ].join(" ");
    const ctxBlocks: string[] = [`<runtime ${runtimeAttrs} />`];

    if (opts.urgent) {
      ctxBlocks.push(
        `<urgent_channel>${userLabel}在门关着时开启了「一次性紧急通道」发来这一条消息，发完通道已自动重新关上。</urgent_channel>`,
      );
    }

    const userStatusParts: string[] = [];
    if (cfg.userStatus?.undisturbed) userStatusParts.push("开着勿扰");
    if (cfg.userStatus?.moodText) userStatusParts.push(`心绪「${cfg.userStatus.moodText}」`);
    if (userStatusParts.length > 0) {
      ctxBlocks.push(
        `<user_status>${userLabel}主动挂出的状态：${userStatusParts.join("；")}。</user_status>`,
      );
    }

    if (cfg.recallEvalNoticeResident) {
      ctxBlocks.push(
        `<eval_notice>${userLabel}当前开启了召回评测检视模式，可能会查看本轮召回的记忆卡片清单并做标注。</eval_notice>`,
      );
    }

    const recentShares = this.deps.events.listRecentShares(nowMs - 7 * 24 * 3600_000, 5);
    if (recentShares.length > 0) {
      const shareParts = recentShares.map((s) => {
        const readStatus = s.openedAt ? `已点开看（${vagueWhen(s.openedAt, nowMs, tz)}）` : "还没打开";
        return `《${s.title}》（${vagueWhen(s.createdAt, nowMs, tz)}分享；${readStatus}）`;
      });
      ctxBlocks.push(`<shared_items>我最近分享给${userLabel}的：${shareParts.join("；")}</shared_items>`);
    }

    // Spec 02 §2.2：按 events_notice 游标注入未消费的系统事实（privacy.peeked / share.opened / request.decided）
    let injectedNoticeMaxId: string | null = null;
    const unnoticedEvents = this.deps.events.listUnnoticedEvents(20);
    if (unnoticedEvents.length > 0) {
      injectedNoticeMaxId = unnoticedEvents[unnoticedEvents.length - 1]!.id;
      const noticeLines = unnoticedEvents.map((ev) => {
        const when = vagueWhen(ev.createdAt, nowMs, tz);
        const meta = ev.metadata ?? {};
        const title = typeof meta.title === "string" ? meta.title : "";
        if (ev.kind === "privacy.peeked") {
          return `- 系统事实：${userLabel}在${when}拆封查看了上锁抽屉中的「${title || ev.content}」`;
        }
        if (ev.kind === "share.opened") {
          return `- 系统事实：${userLabel}在${when}打开阅读了你分享的「${title || ev.content}」`;
        }
        return `- 系统事实（${when}）：${ev.content}`;
      });
      ctxBlocks.push(`<events_notice>\n${noticeLines.join("\n")}\n</events_notice>`);
    }

    const stickersBlock = this.buildStickersBlock();
    if (stickersBlock) {
      ctxBlocks.push(stickersBlock);
    }

    // 注入未读门缝纸条（按 seq ASC，单轮最多 10 条 / 2000 字符）
    let injectedDoorNoteMaxId: string | null = null;
    if (unreadNotesCount > 0) {
      const { items: unread, remainingCount } = this.deps.events.listUnreadDoorNotes({
        maxCount: 10,
        maxChars: 2000,
      });
      if (unread.length > 0) {
        injectedDoorNoteMaxId = unread[unread.length - 1].id;
        const lines = unread.map(
          (n) => `- [${vagueWhen(n.createdAt, nowMs, tz)} · 门缝纸条] ${n.content}`,
        );
        if (remainingCount > 0) {
          lines.push(`另有 ${remainingCount} 条更新的未读门缝纸条将在后续轮次续读`);
        }
        ctxBlocks.push(`<door_notes>\n${lines.join("\n")}\n</door_notes>`);
      }
    }

    // 盘中修改过 Static Prefix 文件的增量提示（持续有效至下次换段）
    if (this.prefixDelta.size > 0) {
      const deltas = Array.from(this.prefixDelta.entries()).map(
        ([rel, body]) => `### ${rel}\n${body}`,
      );
      ctxBlocks.push(`<prefix_delta>\n${deltas.join("\n\n")}\n</prefix_delta>`);
    }

    // Ring 1 极简 3 步召回注入（chat 模式且非空文本输入）
    const recallQuery = opts.userText.trim();
    let recallCount = 0;
    if (opts.mode === "chat" && recallQuery.length > 0) {
      if (this.deps.db) {
        const recalled = await recallMemories({
          db: this.deps.db,
          dataDir: this.deps.dataDir,
          index: this.deps.memoryIndex,
          clock: this.deps.clock,
          sessionId: this.activeState.sessionId,
          turnId: opts.turnId,
          query: recallQuery,
          recentTurns: opts.recentTurns,
          activityHint: opts.activityHint,
          embedding: this.deps.embedding,
          reranker: this.deps.reranker,
          decisionClient: this.deps.decisionClient,
          promptsDir: this.deps.promptsDir,
          recallConfig: cfg.recall,
        });
        recallCount = recalled.items.length;
        if (recalled.renderedBlock) {
          ctxBlocks.push(recalled.renderedBlock);
        }
      } else {
        const hits = this.deps.memoryIndex.searchFts(recallQuery, 5);
        recallCount = hits.length;
        if (hits.length > 0) {
          const lines = hits.map(
            (h) => `- ${h.path}（${vagueWhen(h.updatedAt, nowMs, tz)} · kind: ${h.kind}）：${h.title}`,
          );
          ctxBlocks.push(
            `<recalled_memories note="系统按当前话题检索到的历史笔记片段，仅供自然参考">\n${lines.join("\n")}\n</recalled_memories>`,
          );
        }
      }
    }

    // 条件模式提示
    if (await this.isGenesisMode()) {
      const genesis = await readPrompt(this.deps.promptsDir, "genesis.md");
      ctxBlocks.push(`<genesis_mode>\n${genesis.body}\n</genesis_mode>`);
    }
    if (opts.mode === "wake") {
      const wake = await readPrompt(this.deps.promptsDir, "wake.md", {
        wakeReason: opts.wakeReason ?? "定时心跳",
      });
      ctxBlocks.push(`<wake_mode>\n${wake.body}\n</wake_mode>`);
    }

    const imageBlocks: ChatImageContent[] = [];
    let unavailableAttachmentCount = 0;
    if (opts.attachments && opts.attachments.length > 0) {
      for (const hash of opts.attachments) {
        if (!this.deps.media) {
          unavailableAttachmentCount += 1;
          continue;
        }
        const asset = await this.deps.media.read(hash);
        if (!asset || asset.expired || !asset.mimeType.startsWith("image/")) {
          unavailableAttachmentCount += 1;
          continue;
        }
        imageBlocks.push({
          type: "image",
          data: Buffer.from(asset.bytes).toString("base64"),
          mimeType: asset.mimeType,
        });
      }
    }

    const displayUserText = this.formatUserTextWithSticker(opts.userText, opts.stickerId);
    const videoNote = opts.videoClip
      ? `[附带了一段约 ${Math.max(1, Math.round(opts.videoClip.durationSec))} 秒的短视频，以下是按时间提取的画面帧]`
      : "";
    const unavailableNote =
      unavailableAttachmentCount > 0 ? `[附带了 ${unavailableAttachmentCount} 张图片，暂无法读取]` : "";
    const topText = [displayUserText, videoNote, unavailableNote]
      .filter((s) => s.trim().length > 0)
      .join("\n");

    const runtimeBlock = `<runtime_context>\n${ctxBlocks.join("\n")}\n</runtime_context>`;
    const fullText = topText ? `${topText}\n\n${runtimeBlock}` : runtimeBlock;
    const content: ChatUserContent =
      imageBlocks.length > 0 ? [{ type: "text", text: fullText }, ...imageBlocks] : fullText;
    return { content, injectedDoorNoteMaxId, injectedNoticeMaxId, recallCount };
  }

  /**
   * 同步收尾并切新 sessionId（必须在 turnMutex 内调用）：
   * - runWrapup=true 时先同步排空旧段 daily_wrapup（广播 wrapping 状态供前端提示「正在收拢这段记忆…」）；
   * - 整理失败时不硬切 sessionId 防失忆；整理成功后持久化 fresh 新段并清空 Static Prefix / 用量水位。
   */
  private async performRollover(opts: {
    reason: RolloverReason;
    runWrapup: boolean;
    cutoffSeq?: number | null;
  }): Promise<RolloverResult> {
    const oldSessionId = this.activeState.sessionId;
    const cutoffSeq =
      opts.cutoffSeq !== undefined
        ? opts.cutoffSeq
        : (this.deps.events.getLatestChatEvent()?.seq ?? null);

    if (opts.runWrapup && this.deps.onBeforeRollover) {
      this.rolloverInProgress = true;
      this.deps.onRolloverStatus?.({
        phase: "wrapping",
        reason: opts.reason,
        oldSessionId,
      });
      try {
        const hotSession =
          opts.reason === "overflow"
            ? null
            : await this.buildHotTidySessionContext({ maxSeq: cutoffSeq });
        const wrapRes = await this.deps.onBeforeRollover({
          oldSessionId,
          reason: opts.reason,
          cutoffSeq,
          hotSession,
        });
        if (!wrapRes.ok) {
          this.rolloverInProgress = false;
          const message = wrapRes.error || "整理记忆失败，暂保留当前对话段";
          this.deps.onRolloverStatus?.({
            phase: "error",
            reason: opts.reason,
            oldSessionId,
            message,
          });
          return {
            ok: false,
            oldSessionId,
            newSessionId: oldSessionId,
            wrapped: false,
            error: message,
          };
        }
      } catch (err) {
        this.rolloverInProgress = false;
        const message = err instanceof Error ? err.message || "整理记忆失败" : "整理记忆失败";
        this.deps.onRolloverStatus?.({
          phase: "error",
          reason: opts.reason,
          oldSessionId,
          message,
        });
        return {
          ok: false,
          oldSessionId,
          newSessionId: oldSessionId,
          wrapped: false,
          error: message,
        };
      }
    }

    const newSessionId = ulid(this.deps.clock.now());
    this.activeState = {
      sessionId: newSessionId,
      fresh: true,
      carryOverUntilSeq: cutoffSeq,
      continuity: null,
    };
    this.deps.events.setActiveSessionState(this.activeState);
    this.staticPrefixSnapshot = null;
    this.prefixDelta.clear();
    this.lastUsedTokens = 0;
    this.needsLegacyContinuity = false;
    this.rolloverInProgress = false;

    this.deps.onRollover?.(oldSessionId, newSessionId);
    this.deps.onRolloverStatus?.({
      phase: "done",
      reason: opts.reason,
      oldSessionId,
      newSessionId,
      contextUsage: this.getContextUsage(),
    });
    return {
      ok: true,
      oldSessionId,
      newSessionId,
      wrapped: opts.runWrapup,
    };
  }

  /**
   * 串行执行一轮对话或主动唤醒（ChatTurnLock 保护）。
   */
  runTurn(opts: {
    mode: "chat" | "wake";
    userText?: string;
    userEventId?: string;
    stickerId?: string;
    attachments?: string[];
    videoClip?: { durationSec: number; frameHashes: string[] };
    urgent?: boolean;
    wakeReason?: string;
    activityHint?: string;
    turnId?: string;
    groupId?: string;
    version?: number;
    historyBeforeSeq?: number;
    resumeCheckpoint?: TurnCheckpoint;
    signal?: AbortSignal;
    callbacks?: TurnStreamCallbacks;
  }): Promise<RunTurnResult> {
    if (opts.mode === "chat") {
      this.activeChatWaiters += 1;
      if (this.yieldableTidyAbort && !this.yieldableTidyAbort.signal.aborted) {
        this.yieldableTidyAbort.abort();
      }
    }
    return this.turnMutex
      .runExclusive(() => this.executeTurn(opts))
      .finally(() => {
        if (opts.mode === "chat") {
          this.activeChatWaiters = Math.max(0, this.activeChatWaiters - 1);
        }
      });
  }

  private async executeTurn(opts: {
    mode: "chat" | "wake";
    userText?: string;
    userEventId?: string;
    stickerId?: string;
    attachments?: string[];
    videoClip?: { durationSec: number; frameHashes: string[] };
    urgent?: boolean;
    wakeReason?: string;
    activityHint?: string;
    turnId?: string;
    groupId?: string;
    version?: number;
    historyBeforeSeq?: number;
    resumeCheckpoint?: TurnCheckpoint;
    signal?: AbortSignal;
    callbacks?: TurnStreamCallbacks;
  }): Promise<RunTurnResult> {
    const turnId = opts.turnId ?? ulid(this.deps.clock.now());

    // 若该用户消息是在上一轮同步换段期间排队落盘的，重绑到换段后的新 sessionId（绝不跨段错位）
    if (opts.userEventId && !opts.groupId) {
      const storedUser = this.deps.events.getById(opts.userEventId);
      if (storedUser && storedUser.sessionId !== this.activeState.sessionId) {
        this.deps.events.rebindEventSessionId(storedUser.id, this.activeState.sessionId);
      }
    }

    let turnSessionId = this.activeState.sessionId;
    const cp =
      opts.resumeCheckpoint && opts.resumeCheckpoint.sessionId === turnSessionId
        ? opts.resumeCheckpoint
        : undefined;
    const tier1Tools = this.deps.registry.getTier1Definitions();

    let systemPrompt: string;
    let messages: ChatMessage[];
    let dynamicUserContent: ChatUserContent | null = null;
    let initialHistoryCount = 0;
    let injectedDoorNoteMaxId: string | null;
    let injectedNoticeMaxId: string | null;
    let recallCount: number;

    const identity = await readIdentityProfile(
      this.deps.dataDir,
      this.deps.clock.now(),
      this.deps.clock.timeZone,
    );
    const userLabel = identity.userName ?? identity.userPronoun ?? "TA";

    if (cp) {
      systemPrompt = cp.systemPrompt;
      messages = [...cp.messages];
      initialHistoryCount = Math.max(0, messages.length - 1);
      injectedDoorNoteMaxId = cp.injectedDoorNoteMaxId;
      injectedNoticeMaxId = cp.injectedNoticeMaxId;
      recallCount = cp.recallCount;
    } else {
      await this.ensureContinuityFrozen();
      systemPrompt = await this.getOrBuildStaticPrefix();
      const history = this.buildHistoryMessages(
        userLabel,
        opts.userEventId,
        opts.historyBeforeSeq,
      );
      initialHistoryCount = history.length;
      const recentTurns = history
        .filter(
          (m): m is { role: "user" | "assistant"; content: string; timestamp: number } =>
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.trim().length > 0,
        )
        .slice(-(this.deps.getConfig().recall?.queryWindowTurns ?? 4))
        .map((m) => ({ role: m.role, content: m.content }));
      const dynamic = await this.buildDynamicUserMessage({
        mode: opts.mode,
        turnId,
        userText: opts.userText ?? "",
        userLabel,
        recentTurns,
        stickerId: opts.stickerId,
        attachments: opts.attachments,
        videoClip: opts.videoClip,
        urgent: opts.urgent,
        wakeReason: opts.wakeReason,
        activityHint: opts.activityHint,
      });
      dynamicUserContent = dynamic.content;
      injectedDoorNoteMaxId = dynamic.injectedDoorNoteMaxId;
      injectedNoticeMaxId = dynamic.injectedNoticeMaxId;
      recallCount = dynamic.recallCount;
      messages = [
        ...history,
        { role: "user", content: dynamic.content, timestamp: this.deps.clock.now() },
      ];
    }

    const toolCtx: ToolExecutionContext = {
      turnId,
      sessionId: turnSessionId,
      mode: opts.mode,
      touchedMemoryPaths: new Set<string>(cp?.touchedMemoryPaths ?? []),
      expressionCount: cp?.expressions.length ?? 0,
      expressions: cp ? [...cp.expressions] : [],
      shares: cp ? [...cp.shares] : [],
      pendingDoorUpdates: [],
      signal: opts.signal,
      onExpression: (p) => opts.callbacks?.onExpression?.(p),
      onDoorUpdated: (s, n) => opts.callbacks?.onDoorUpdated?.(s, n),
      onDoorNotePersisted: (ev) => opts.callbacks?.onDoorNotePersisted?.(ev),
      onMessageRetracted: (ev) => opts.callbacks?.onMessageRetracted?.(ev),
      requestApproval: opts.callbacks?.onRequestApproval,
    };

    // wake 模式在前 16 字符确认非 [SILENT]（或产生实质工具调用）前暂缓广播
    let streamStarted = opts.mode !== "wake" || Boolean(cp);
    const pendingThinkingChunks: Array<{ delta: string; step: number }> = [];
    let pendingText = "";
    const flushWakeStart = () => {
      if (streamStarted) return;
      streamStarted = true;
      opts.callbacks?.onTurnStart?.({ turnId, mode: opts.mode });
      for (const item of pendingThinkingChunks) {
        opts.callbacks?.onThinkingDelta?.(item.delta, item.step);
      }
      pendingThinkingChunks.length = 0;
      if (pendingText) {
        opts.callbacks?.onTextDelta?.(pendingText);
        pendingText = "";
      }
    };

    if (streamStarted) {
      opts.callbacks?.onTurnStart?.({ turnId, mode: opts.mode });
      if (cp) {
        // 断点续跑：先向客户端补推前序已完成步骤的思考链、工具手账进度与前缀正文
        if (cp.journalSteps && cp.journalSteps.length > 0) {
          for (const js of cp.journalSteps) {
            if (js.thinking) {
              opts.callbacks?.onThinkingDelta?.(js.thinking, js.step);
            }
          }
        } else if (cp.fullThinking) {
          opts.callbacks?.onThinkingDelta?.(cp.fullThinking, 0);
        }
        for (const tp of cp.toolProgress) {
          opts.callbacks?.onToolProgress?.({ ...tp, turnId });
        }
        if (cp.fullText) {
          opts.callbacks?.onTextDelta?.(cp.fullText);
        }
      }
    }

    const retryDelays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const recordedToolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      ok: boolean;
      output: string;
    }> = cp ? [...cp.recordedToolCalls] : [];
    const toolSummary: Array<{
      name: string;
      label: string;
      ok: boolean;
      kind: "general" | "screen";
    }> = cp ? [...cp.toolSummary] : [];
    const toolProgress: ToolProgressEvent[] = cp ? [...cp.toolProgress] : [];
    const journalSteps: JournalStepRecord[] = cp?.journalSteps
      ? cp.journalSteps.map((s) => ({
          step: s.step,
          ...(s.thinking ? { thinking: s.thinking } : {}),
          tools: [...s.tools],
        }))
      : [];
    const ensureJournalStep = (stepNum: number): JournalStepRecord => {
      let existing = journalSteps.find((s) => s.step === stepNum);
      if (!existing) {
        existing = { step: stepNum, tools: [] };
        journalSteps.push(existing);
      }
      return existing;
    };

    const cfgForTurn = this.deps.getConfig();
    const effectiveThinkingLevel = resolveEffectiveThinkingLevel(cfgForTurn);
    const effectiveThinkingBudget = cfgForTurn.llm?.thinking?.budgetTokens;
    let activeModelId = this.deps.chatModel.modelId;
    let modelSwitchBroadcasted = false;
    const maybeBroadcastModelSwitch = (modelId: string | undefined, reason?: string) => {
      if (
        modelSwitchBroadcasted ||
        opts.mode !== "chat" ||
        !modelId ||
        !this.lastAssistantModel ||
        this.lastAssistantModel === modelId
      ) {
        return;
      }
      modelSwitchBroadcasted = true;
      opts.callbacks?.onModelSwitched?.({ turnId, model: modelId, reason });
    };
    maybeBroadcastModelSwitch(activeModelId);

    let fullText = cp?.fullText ?? "";
    let fullThinking = cp?.fullThinking ?? "";
    let committedText = fullText;
    let committedThinking = fullThinking;
    let completedToolSteps = cp?.completedToolSteps ?? 0;
    let aborted = false;
    let truncated = false;
    let thresholdReached = cp?.rolledOver ?? false;
    let rolledOver = false;
    let overflowRecovered = false;
    let overflowCheckpointDisabled = false;
    let lastUsage: {
      model?: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      estimatedCostUsd?: number;
    } | undefined;
    let lastError: { code: LlmErrorCode; message: string; retryable: boolean } | undefined;

    const buildCheckpoint = (): TurnCheckpoint | undefined => {
      if (completedToolSteps <= 0 || overflowCheckpointDisabled) return undefined;
      return {
        turnId,
        sessionId: turnSessionId,
        mode: opts.mode,
        userEventId: opts.userEventId,
        systemPrompt,
        messages: [...messages],
        fullText: committedText,
        fullThinking: committedThinking,
        recordedToolCalls: [...recordedToolCalls],
        toolSummary: [...toolSummary],
        toolProgress: [...toolProgress],
        journalSteps: journalSteps.map((s) => ({
          step: s.step,
          ...(s.thinking ? { thinking: s.thinking } : {}),
          tools: [...s.tools],
        })),
        expressions: [...toolCtx.expressions],
        shares: [...(toolCtx.shares ?? [])],
        touchedMemoryPaths: Array.from(toolCtx.touchedMemoryPaths),
        injectedDoorNoteMaxId,
        injectedNoticeMaxId,
        recallCount,
        completedToolSteps,
        rolledOver: thresholdReached,
      };
    };

    try {
      for (let step = completedToolSteps; step <= MAX_TOOL_STEPS; step++) {
        if (opts.signal?.aborted) {
          aborted = true;
          break;
        }

        // 第 MAX_TOOL_STEPS 步为无工具兜底收尾步，确保连续工具调用达上限后仍能吐出最终正文
        const isWrapUpStep = step === MAX_TOOL_STEPS;
        let stepText = "";
        let stepThinking = "";
        let stepThinkingSig: string | undefined;
        let stepStopReason: ChatStopReason | undefined;
        const stepToolCalls: ChatToolCall[] = [];
        let retryStepAfterOverflow = false;

        // 对齐 Spec 01 §1.3：429 / 5xx（RATE_LIMITED / PROVIDER_ERROR）在尚未输出内容前指数退避重试 2 次
        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
          let retryableFailure: { code: LlmErrorCode; message: string; retryable: boolean } | undefined;
          let overflowFailure: { code: LlmErrorCode; message: string; retryable: boolean } | undefined;
          let producedOutputInAttempt = false;
          stepStopReason = undefined;

          for await (const chunk of this.deps.chatModel.stream({
            systemPrompt,
            messages,
            tools: isWrapUpStep ? [] : tier1Tools,
            sessionId: turnSessionId,
            thinkingLevel: effectiveThinkingLevel,
            thinkingBudgetTokens: effectiveThinkingBudget,
            signal: opts.signal,
          })) {
            if (opts.signal?.aborted) {
              aborted = true;
              break;
            }
            const latestModelId = this.deps.chatModel.modelId;
            if (latestModelId && latestModelId !== activeModelId) {
              activeModelId = latestModelId;
              maybeBroadcastModelSwitch(activeModelId, "fallback");
            }
            if (chunk.type === "thinking_delta") {
              if (chunk.delta.length > 0) {
                producedOutputInAttempt = true;
                if (stepThinking.length === 0 && fullThinking.length > 0) {
                  fullThinking += "\n\n";
                }
                stepThinking += chunk.delta;
                fullThinking += chunk.delta;
                const js = ensureJournalStep(step);
                js.thinking = (js.thinking ?? "") + chunk.delta;
              }
              if (chunk.signature) stepThinkingSig = chunk.signature;
              if (chunk.delta.length > 0) {
                if (streamStarted) {
                  opts.callbacks?.onThinkingDelta?.(chunk.delta, step);
                } else {
                  pendingThinkingChunks.push({ delta: chunk.delta, step });
                }
              }
            } else if (chunk.type === "text_delta") {
              producedOutputInAttempt = true;
              stepText += chunk.delta;
              fullText += chunk.delta;
              if (streamStarted) {
                opts.callbacks?.onTextDelta?.(chunk.delta);
              } else {
                pendingText += chunk.delta;
                const trimmed = pendingText.trimStart();
                const couldBeSilent = "[SILENT]".startsWith(trimmed) || trimmed.startsWith("[SILENT]");
                if (!couldBeSilent || pendingText.length >= WAKE_SILENT_PREFIX_BUFFER_LEN) {
                  if (trimmed !== "[SILENT]") {
                    flushWakeStart();
                  }
                }
              }
            } else if (chunk.type === "tool_call") {
              producedOutputInAttempt = true;
              if (!isWrapUpStep) {
                stepToolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.args });
              }
            } else if (chunk.type === "usage") {
              if (chunk.stopReason) stepStopReason = chunk.stopReason;
              this.lastUsedTokens = chunk.totalTokens;
              lastUsage = {
                ...(activeModelId ? { model: activeModelId } : {}),
                inputTokens: chunk.inputTokens,
                outputTokens: chunk.outputTokens,
                totalTokens: chunk.totalTokens,
                ...(chunk.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.cacheReadTokens } : {}),
                ...(chunk.cacheWriteTokens !== undefined ? { cacheWriteTokens: chunk.cacheWriteTokens } : {}),
                ...(chunk.estimatedCostUsd !== undefined ? { estimatedCostUsd: chunk.estimatedCostUsd } : {}),
              };
              // 按当前实际生效模型的窗口实时算阈值（修复 DynamicChatModel 首轮与降级后窗口偏差）
              const effectiveLimit = this.computeEffectiveRolloverLimit(opts.mode);
              if (chunk.totalTokens >= effectiveLimit) {
                thresholdReached = true;
              }
            } else if (chunk.type === "error") {
              if (chunk.code === "CONTEXT_OVERFLOW") {
                overflowFailure = { code: chunk.code, message: chunk.message, retryable: chunk.retryable };
                break;
              }
              const canRetry =
                !producedOutputInAttempt &&
                (chunk.code === "RATE_LIMITED" || chunk.code === "PROVIDER_ERROR") &&
                attempt < retryDelays.length;
              if (canRetry) {
                retryableFailure = { code: chunk.code, message: chunk.message, retryable: chunk.retryable };
              } else {
                lastError = { code: chunk.code, message: chunk.message, retryable: chunk.retryable };
                opts.callbacks?.onTurnError?.({ turnId, ...lastError });
              }
              break;
            }
          }

          if (opts.signal?.aborted) {
            aborted = true;
            break;
          }

          // Spec 01 §1.3 & §2.5：CONTEXT_OVERFLOW 且存在旧历史时，先同步收尾换段并在新段当轮自动重试一次
          if (overflowFailure) {
            const currentUserEv = opts.userEventId
              ? this.deps.events.getById(opts.userEventId)
              : null;
            const cutoffSeq = currentUserEv
              ? Math.max(0, currentUserEv.seq - 1)
              : (this.deps.events.getLatestChatEvent()?.seq ?? null);

            if (
              !overflowRecovered &&
              !producedOutputInAttempt &&
              completedToolSteps === 0 &&
              initialHistoryCount > 0 &&
              dynamicUserContent !== null
            ) {
              const roll = await this.performRollover({
                reason: "overflow",
                runWrapup: true,
                cutoffSeq,
              });
              if (roll.ok) {
                overflowRecovered = true;
                rolledOver = true;
                thresholdReached = false;
                turnSessionId = this.activeState.sessionId;
                toolCtx.sessionId = turnSessionId;
                if (currentUserEv) {
                  this.deps.events.rebindEventSessionId(currentUserEv.id, turnSessionId);
                }
                await this.ensureContinuityFrozen();
                systemPrompt = await this.getOrBuildStaticPrefix();
                messages = [
                  { role: "user", content: dynamicUserContent, timestamp: this.deps.clock.now() },
                ];
                initialHistoryCount = 0;
                retryStepAfterOverflow = true;
                break;
              }
            } else if (completedToolSteps > 0) {
              // 多步工具调用中途溢出：同步换段且禁用溢出检查点，避免重试陷入同载荷死循环
              overflowCheckpointDisabled = true;
              const roll = await this.performRollover({
                reason: "overflow",
                runWrapup: true,
                cutoffSeq,
              });
              if (roll.ok) {
                rolledOver = true;
                if (currentUserEv) {
                  this.deps.events.rebindEventSessionId(currentUserEv.id, this.activeState.sessionId);
                }
              }
            }

            lastError = overflowFailure;
            opts.callbacks?.onTurnError?.({ turnId, ...lastError });
            break;
          }

          if (retryableFailure) {
            await sleepWithAbort(retryDelays[attempt], opts.signal);
            continue;
          }
          break;
        }

        if (retryStepAfterOverflow) {
          step -= 1;
          continue;
        }

        if (lastError || aborted) break;

        if (stepStopReason === "length" && stepToolCalls.length === 0) {
          if (
            fullText.trim().length === 0 &&
            toolCtx.expressions.length === 0 &&
            (toolCtx.shares?.length ?? 0) === 0
          ) {
            lastError = {
              code: "PROVIDER_ERROR",
              message:
                "模型输出达到上限被截断，未能生成回复正文（可在设置中调大该模型的 maxTokens 或降低思考深度）",
              retryable: true,
            };
            opts.callbacks?.onTurnError?.({ turnId, ...lastError });
            break;
          }
          truncated = true;
        }

        // 单轮多步工具循环：完整保留本步 thinking + signature 发回模型
        if (!isWrapUpStep && stepToolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: stepText,
            thinking: stepThinking || undefined,
            thinkingSignature: stepThinkingSig,
            toolCalls: stepToolCalls,
            timestamp: this.deps.clock.now(),
          });

          for (const tc of stepToolCalls) {
            const innerCheck =
              tc.name === "call_tool" && typeof tc.arguments.name === "string"
                ? tc.arguments.name.trim()
                : tc.name;
            if (tc.name === "express" || tc.name === "door" || innerCheck === "share") {
              flushWakeStart();
            }
            const innerName =
              tc.name === "call_tool" && typeof tc.arguments.name === "string"
                ? tc.arguments.name.trim()
                : tc.name;
            const isEmbodiedOnly = tc.name === "express";
            const toolKind: "general" | "screen" =
              innerName === "look_at_screen" ? "screen" : "general";
            const toolLabel = formatToolActionLabel(innerName, opts.mode);
            if (!isEmbodiedOnly) {
              opts.callbacks?.onToolProgress?.({
                turnId,
                callId: tc.id,
                name: innerName,
                label: toolLabel,
                kind: toolKind,
                status: "running",
                step,
              });
            }

            const result = await this.deps.registry.invoke(tc.name, tc.arguments, toolCtx);
            recordedToolCalls.push({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              ok: result.ok,
              output: result.output,
            });
            if (!isEmbodiedOnly) {
              const summaryEntry: JournalStepTool = {
                name: innerName,
                label: toolLabel,
                ok: result.ok,
                kind: toolKind,
              };
              toolSummary.push(summaryEntry);
              ensureJournalStep(step).tools.push(summaryEntry);
              const doneProgress: ToolProgressEvent = {
                turnId,
                callId: tc.id,
                name: innerName,
                label: toolLabel,
                kind: toolKind,
                status: result.ok ? "done" : "error",
                step,
              };
              toolProgress.push(doneProgress);
              opts.callbacks?.onToolProgress?.(doneProgress);
            }
            // Spec 01 §2.2：tool_result 绝不重复追加 <runtime_context>
            messages.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: result.output,
              isError: !result.ok,
              timestamp: this.deps.clock.now(),
            });
          }
          committedText = fullText;
          committedThinking = fullThinking;
          completedToolSteps = step + 1;
          continue;
        }

        break;
      }

      const flushPendingDoorUpdates = () => {
        if (!toolCtx.pendingDoorUpdates || toolCtx.pendingDoorUpdates.length === 0) return;
        for (const upd of toolCtx.pendingDoorUpdates) {
          const { event: doorEv } = this.deps.events.append({
            sessionId: turnSessionId,
            turnId,
            role: "system",
            kind: "door.updated",
            content: upd.content,
            metadata: { from: upd.from, to: upd.to, note: upd.note },
          });
          opts.callbacks?.onSystemNoticePersisted?.(doorEv);
        }
        toolCtx.pendingDoorUpdates.length = 0;
      };

      // 更新盘中 Static Prefix 文件的 <prefix_delta>（不回改本会话 Static Prefix 快照）
      if (!lastError) {
        const today = localDay(this.deps.clock.now(), this.deps.clock.timeZone);
        for (const rel of toolCtx.touchedMemoryPaths) {
          if (STATIC_PREFIX_PATHS.has(rel)) {
            const raw = await readOptionalMemoryFile(this.deps.dataDir, rel);
            const latest =
              raw && rel === "core/state.md" ? filterActiveStateMarkdown(raw, today) : raw;
            if (latest) this.prefixDelta.set(rel, latest);
            else this.prefixDelta.delete(rel);
          }
        }
      }

      // 仅当本轮未报错且实际写入 memory/ 时才精准 Git 提交（报错轮保留触碰记录待断点重试一并提交）
      const touched = Array.from(toolCtx.touchedMemoryPaths);
      if (!lastError && touched.length > 0) {
        await commitMemoryPaths(this.deps.dataDir, touched, `memory(turn): ${turnId}`);
        if (touched.includes("core/self.md") || touched.includes("core/user.md")) {
          const updatedIdentity = await readIdentityProfile(
            this.deps.dataDir,
            this.deps.clock.now(),
            this.deps.clock.timeZone,
          );
          opts.callbacks?.onIdentityUpdated?.(updatedIdentity);
        }
      }

      const shareCount = toolCtx.shares?.length ?? 0;

      // wake [SILENT] 判定
      const isSilent =
        opts.mode === "wake" &&
        !lastError &&
        !aborted &&
        (fullText.trim() === "[SILENT]" ||
          (fullText.trim() === "" && toolCtx.expressions.length === 0 && shareCount === 0));

      // Spec 01 §2.2：只要交互/唤醒轮正常完成（含 wake [SILENT]），推进 door_notes_read 游标
      if (!lastError && !aborted && injectedDoorNoteMaxId) {
        this.deps.events.setCursor("door_notes_read", injectedDoorNoteMaxId);
        opts.callbacks?.onDoorNotesRead?.(injectedDoorNoteMaxId);
      }

      if (isSilent) {
        flushPendingDoorUpdates();
        if (thresholdReached) {
          const roll = await this.performRollover({
            reason: "threshold",
            runWrapup: true,
          });
          if (roll.ok) rolledOver = true;
        }
        opts.callbacks?.onTurnSilence?.({ turnId, ownTime: opts.mode === "wake" });
        return {
          turnId,
          sessionId: turnSessionId,
          message: null,
          text: "",
          thinking: fullThinking,
          recallCount,
          aborted: false,
          silent: true,
          rolledOver,
          touchedMemoryPaths: touched,
        };
      }

      if (
        !lastError &&
        !streamStarted &&
        (fullText.trim().length > 0 || toolCtx.expressions.length > 0 || shareCount > 0)
      ) {
        flushWakeStart();
      }

      // Spec 02 §2.2：仅在非静默完成（产生了回复/表达/分享/工具调用）时推进 events_notice 游标
      if (
        !lastError &&
        !aborted &&
        injectedNoticeMaxId &&
        (fullText.trim().length > 0 ||
          toolCtx.expressions.length > 0 ||
          shareCount > 0 ||
          recordedToolCalls.length > 0)
      ) {
        this.deps.events.setCursor("events_notice", injectedNoticeMaxId);
      }

      let persisted: StoredEvent | null = null;
      if (
        !lastError &&
        (fullText.length > 0 ||
          toolCtx.expressions.length > 0 ||
          shareCount > 0 ||
          recordedToolCalls.length > 0 ||
          fullThinking.length > 0 ||
          aborted)
      ) {
        const nonEmptyJournalSteps = journalSteps.filter(
          (s) => (s.thinking && s.thinking.trim().length > 0) || s.tools.length > 0,
        );
        const metadata: Record<string, unknown> = {};
        if (opts.userEventId) metadata.inReplyTo = opts.userEventId;
        if (toolCtx.expressions.length > 0) metadata.expressions = toolCtx.expressions;
        if (shareCount > 0 && toolCtx.shares) metadata.shares = toolCtx.shares;
        if (recordedToolCalls.length > 0) metadata.toolCalls = recordedToolCalls;
        if (toolSummary.length > 0) metadata.toolSummary = toolSummary;
        if (nonEmptyJournalSteps.length > 0) metadata.journalSteps = nonEmptyJournalSteps;
        if (activeModelId) metadata.model = activeModelId;
        if (lastUsage) metadata.usage = lastUsage;
        if (recallCount > 0) metadata.recallCount = recallCount;
        if (aborted) metadata.aborted = true;
        if (truncated) metadata.truncated = true;
        const { event } = this.deps.events.append({
          sessionId: turnSessionId,
          turnId,
          groupId: opts.groupId ?? null,
          version: opts.version ?? 1,
          role: "assistant",
          kind: opts.mode === "wake" ? "wake" : "chat",
          content: fullText,
          thinking: fullThinking || null,
          metadata: Object.keys(metadata).length > 0 ? metadata : null,
        });
        persisted = event;
        opts.callbacks?.onAssistantPersisted?.(event);
        if (activeModelId) {
          this.lastAssistantModel = activeModelId;
        }
      }

      // 门状态系统提示必须在当轮助手消息落盘之后写入，保证时间线时序为「思考/操作/回复 → 门状态变更」
      flushPendingDoorUpdates();

      if (!lastError && thresholdReached) {
        const cutoffSeq =
          persisted?.seq ??
          (opts.userEventId ? this.deps.events.getById(opts.userEventId)?.seq : null) ??
          this.deps.events.getLatestChatEvent()?.seq ??
          null;
        const roll = await this.performRollover({
          reason: "threshold",
          runWrapup: true,
          cutoffSeq,
        });
        if (roll.ok) rolledOver = true;
      }

      if (!lastError) {
        opts.callbacks?.onTurnDone?.({
          turnId,
          mode: opts.mode,
          messageId: persisted?.id ?? null,
          recallCount,
          aborted,
          silent: false,
          rolledOver,
          contextUsage: this.getContextUsage(),
        });
      }

      return {
        turnId,
        sessionId: turnSessionId,
        message: persisted,
        text: fullText,
        thinking: fullThinking,
        recallCount,
        aborted,
        silent: false,
        rolledOver,
        touchedMemoryPaths: touched,
        error: lastError,
        ...(lastError ? { checkpoint: buildCheckpoint() } : {}),
      };
    } catch (err) {
      if (toolCtx.pendingDoorUpdates && toolCtx.pendingDoorUpdates.length > 0) {
        for (const upd of toolCtx.pendingDoorUpdates) {
          const { event: doorEv } = this.deps.events.append({
            sessionId: turnSessionId,
            turnId,
            role: "system",
            kind: "door.updated",
            content: upd.content,
            metadata: { from: upd.from, to: upd.to, note: upd.note },
          });
          opts.callbacks?.onSystemNoticePersisted?.(doorEv);
        }
        toolCtx.pendingDoorUpdates.length = 0;
      }
      const message = err instanceof Error ? err.message || "生成过程中发生未预期异常" : "生成过程中发生未预期异常";
      lastError = { code: "PROVIDER_ERROR", message, retryable: true };
      opts.callbacks?.onTurnError?.({ turnId, ...lastError });
      return {
        turnId,
        sessionId: turnSessionId,
        message: null,
        text: fullText,
        thinking: fullThinking,
        recallCount,
        aborted,
        silent: false,
        rolledOver,
        touchedMemoryPaths: Array.from(toolCtx.touchedMemoryPaths),
        error: lastError,
        checkpoint: buildCheckpoint(),
      };
    }
  }
}
