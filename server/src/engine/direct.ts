import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";
import { localWeekday, vagueTimeOfDay, vagueWhen } from "../core/clock.ts";
import type { DoorState, PsyberConfig } from "../core/config.ts";
import { commitMemoryPaths } from "../core/git.ts";
import { AsyncMutex } from "../core/mutex.ts";
import { readPrompt } from "../core/prompts.ts";
import { ulid } from "../core/ulid.ts";
import type {
  ChatMessage,
  ChatModelClient,
  ChatToolCall,
  LlmErrorCode,
} from "../llm/client.ts";
import { parseCardMarkdown } from "../memory/frontmatter.ts";
import { buildGistBlock } from "../memory/gist.ts";
import type { MemoryIndex } from "../memory/index.ts";
import { recallMemories, type EmbeddingClient } from "../memory/recall.ts";
import type { EventStore, StoredEvent } from "../store/events.ts";
import type {
  ExpressionPayload,
  ToolExecutionContext,
  ToolRegistry,
} from "../tools/registry.ts";

const STATIC_PREFIX_PATHS = new Set([
  "self.md",
  "user.md",
  "shelf/rules.md",
  "shelf/mirror.md",
  "shelf/threads.md",
]);

const MAX_TOOL_STEPS = 12;
const WAKE_SILENT_PREFIX_BUFFER_LEN = 16;
const ROLLOVER_RATIO = 0.75;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

export interface TurnStreamCallbacks {
  onTurnStart?: (info: { turnId: string; mode: "chat" | "wake" }) => void;
  onThinkingDelta?: (delta: string) => void;
  onTextDelta?: (delta: string) => void;
  onExpression?: (payload: ExpressionPayload) => void;
  onDoorUpdated?: (state: DoorState, note: string | null) => void;
  onTurnDone?: (info: {
    turnId: string;
    mode: "chat" | "wake";
    messageId: string | null;
    recallCount: number;
    aborted: boolean;
    silent: boolean;
    rolledOver: boolean;
  }) => void;
  onTurnError?: (err: { turnId: string; code: LlmErrorCode; message: string; retryable: boolean }) => void;
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
  /** 可选 Embedding 客户端（缺省或超时自动降级 FTS5 2-gram） */
  embedding?: EmbeddingClient;
  /** 429/5xx 指数退避延迟（默认 [1000, 3000] ms，离线测试可传 [0, 0]） */
  retryDelaysMs?: number[];
  /** 75% 换段时由调用方触发后台异步整理旧会话（不阻塞前台） */
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
 * - 三明治上下文：Static Prefix 会话级快照锁死 + Append-Only History（跨轮剥除 thinking，换段注入 <gist> + 近 6 轮过渡）+ Dynamic Tail（原话置顶、语境置底，tool_result 绝不重复注入）
 * - 单轮多步工具循环内保留 thinking + signature，429/5xx 指数退避重试 2 次
 * - 接入 Ring 1 极简 3 步召回（recallMemories）并写入 recall_traces 与 turn.done.recallCount
 * - wake [SILENT] 前 16 字符暂缓推流
 * - 达 75% 上下文上限直接切新 session_id，不阻塞前台
 */
export class DirectEngine {
  private sessionId: string;
  private staticPrefixSnapshot: string | null = null;
  private readonly prefixDelta = new Map<string, string>();
  private readonly turnMutex = new AsyncMutex();
  private rolloverGistAnchor: string | null = null;
  private rolloverCarryOver: ChatMessage[] = [];

  constructor(private readonly deps: DirectEngineDeps) {
    this.sessionId = ulid(deps.clock.now());
  }

  getActiveSessionId(): string {
    return this.sessionId;
  }

  /** 构建或复用当前会话的 Static Prefix 快照（盘中修改不回改，保护 Cache Breakpoint #1） */
  private async getOrBuildStaticPrefix(): Promise<string> {
    if (this.staticPrefixSnapshot !== null) {
      return this.staticPrefixSnapshot;
    }
    const selfMd = (await readOptionalMemoryFile(this.deps.dataDir, "self.md")) ?? "";
    const mainPrompt = await readPrompt(this.deps.promptsDir, "main.md");
    const userMd = await readOptionalMemoryFile(this.deps.dataDir, "user.md");
    const shelfParts: string[] = [];
    for (const f of ["shelf/rules.md", "shelf/mirror.md", "shelf/threads.md"]) {
      const text = await readOptionalMemoryFile(this.deps.dataDir, f);
      if (text) shelfParts.push(`### ${f}\n${text}`);
    }

    const sections: string[] = [];
    if (selfMd) sections.push(`<self>\n${selfMd}\n</self>`);
    sections.push(mainPrompt.body);
    if (userMd) sections.push(`<user>\n${userMd}\n</user>`);
    if (shelfParts.length > 0) {
      sections.push(`<shelf>\n${shelfParts.join("\n\n")}\n</shelf>`);
    }

    this.staticPrefixSnapshot = sections.join("\n\n");
    return this.staticPrefixSnapshot;
  }

  /** 判断是否仍处于创世未定名状态（self.md named: false） */
  private async isGenesisMode(): Promise<boolean> {
    const selfMd = await readOptionalMemoryFile(this.deps.dataDir, "self.md");
    if (!selfMd) return false;
    const parsed = parseCardMarkdown("self.md", selfMd, this.deps.clock.now(), this.deps.clock.timeZone);
    return parsed.rawFrontmatter.named === false;
  }

  /** 构造 Segment 2：跨轮历史回放（换段首条注入 <gist> + 近 6 轮过渡，剥除历史 thinking） */
  private buildHistoryMessages(excludeEventId?: string): ChatMessage[] {
    const history: ChatMessage[] = [];
    if (this.rolloverGistAnchor) {
      history.push({
        role: "assistant",
        content: this.rolloverGistAnchor,
        timestamp: this.deps.clock.now(),
      });
    }
    for (const msg of this.rolloverCarryOver) {
      history.push(msg);
    }

    const page = this.deps.events.listHistory({ limit: 40 });
    for (const ev of page.items) {
      if (ev.sessionId !== this.sessionId) continue;
      if (excludeEventId && ev.id === excludeEventId) continue;
      if (ev.role === "user" && (ev.kind === "chat" || ev.kind === "door_note")) {
        history.push({ role: "user", content: ev.content, timestamp: ev.createdAt });
      } else if (ev.role === "assistant" && (ev.kind === "chat" || ev.kind === "wake")) {
        // 跨轮历史严格剥除 thinking，防止陈旧思考污染后续轮次与缓存
        history.push({ role: "assistant", content: ev.content, timestamp: ev.createdAt });
      }
    }
    return history;
  }

  /** 构造 Segment 3 Dynamic Tail（原话置顶，客观 <runtime_context> 置底） */
  private async buildDynamicUserMessage(opts: {
    mode: "chat" | "wake";
    turnId: string;
    userText: string;
    wakeReason?: string;
    activityHint?: string;
  }): Promise<{ content: string; injectedDoorNoteMaxId: string | null; recallCount: number }> {
    const cfg = this.deps.getConfig();
    const nowMs = this.deps.clock.now();
    const tz = this.deps.clock.timeZone;
    const unreadNotesCount = this.deps.events.countUnreadDoorNotes();

    const ctxBlocks: string[] = [
      `<runtime time="${vagueTimeOfDay(nowMs, tz)}" weekday="${localWeekday(nowMs, tz)}" circadian="清醒" door="${cfg.door.state}" notes="${unreadNotesCount}" />`,
    ];

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

    // Ring 1 极简 3 步召回注入（chat 模式且非空输入）
    let recallCount = 0;
    if (opts.mode === "chat" && opts.userText.trim().length > 0) {
      if (this.deps.db) {
        const recalled = await recallMemories({
          db: this.deps.db,
          dataDir: this.deps.dataDir,
          index: this.deps.memoryIndex,
          clock: this.deps.clock,
          sessionId: this.sessionId,
          turnId: opts.turnId,
          query: opts.userText,
          activityHint: opts.activityHint,
          embedding: this.deps.embedding,
          recallConfig: cfg.recall,
        });
        recallCount = recalled.items.length;
        if (recalled.renderedBlock) {
          ctxBlocks.push(recalled.renderedBlock);
        }
      } else {
        const hits = this.deps.memoryIndex.searchFts(opts.userText, 5);
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

    const runtimeBlock = `<runtime_context>\n${ctxBlocks.join("\n")}\n</runtime_context>`;
    const content = opts.userText ? `${opts.userText}\n\n${runtimeBlock}` : runtimeBlock;
    return { content, injectedDoorNoteMaxId, recallCount };
  }

  private async triggerRollover(): Promise<void> {
    const oldSessionId = this.sessionId;
    const recentEvents = this.deps.events.listRecentSessionMessages(oldSessionId, 12);
    this.rolloverCarryOver = recentEvents.map((ev) => ({
      role: ev.role === "assistant" ? "assistant" : "user",
      content: ev.content,
      timestamp: ev.createdAt,
    }));
    this.rolloverGistAnchor = await buildGistBlock(this.deps.dataDir, this.deps.memoryIndex);

    this.sessionId = ulid(this.deps.clock.now());
    this.staticPrefixSnapshot = null;
    this.prefixDelta.clear();
    this.deps.onRollover?.(oldSessionId, this.sessionId);
  }

  /**
   * 串行执行一轮对话或主动唤醒（ChatTurnLock 保护）。
   */
  runTurn(opts: {
    mode: "chat" | "wake";
    userText?: string;
    userEventId?: string;
    wakeReason?: string;
    activityHint?: string;
    turnId?: string;
    signal?: AbortSignal;
    callbacks?: TurnStreamCallbacks;
  }): Promise<RunTurnResult> {
    return this.turnMutex.runExclusive(() => this.executeTurn(opts));
  }

  private async executeTurn(opts: {
    mode: "chat" | "wake";
    userText?: string;
    userEventId?: string;
    wakeReason?: string;
    activityHint?: string;
    turnId?: string;
    signal?: AbortSignal;
    callbacks?: TurnStreamCallbacks;
  }): Promise<RunTurnResult> {
    const turnId = opts.turnId ?? ulid(this.deps.clock.now());
    const systemPrompt = await this.getOrBuildStaticPrefix();
    const tier1Tools = this.deps.registry.getTier1Definitions();
    const history = this.buildHistoryMessages(opts.userEventId);
    const {
      content: dynamicUserContent,
      injectedDoorNoteMaxId,
      recallCount,
    } = await this.buildDynamicUserMessage({
      mode: opts.mode,
      turnId,
      userText: opts.userText ?? "",
      wakeReason: opts.wakeReason,
      activityHint: opts.activityHint,
    });

    const messages: ChatMessage[] = [
      ...history,
      { role: "user", content: dynamicUserContent, timestamp: this.deps.clock.now() },
    ];

    const toolCtx: ToolExecutionContext = {
      turnId,
      sessionId: this.sessionId,
      mode: opts.mode,
      touchedMemoryPaths: new Set<string>(),
      expressionCount: 0,
      expressions: [],
      onExpression: (p) => opts.callbacks?.onExpression?.(p),
      onDoorUpdated: (s, n) => opts.callbacks?.onDoorUpdated?.(s, n),
    };

    // wake 模式在前 16 字符确认非 [SILENT]（或产生实质工具调用）前暂缓广播
    let streamStarted = opts.mode !== "wake";
    let pendingThinking = "";
    let pendingText = "";
    const flushWakeStart = () => {
      if (streamStarted) return;
      streamStarted = true;
      opts.callbacks?.onTurnStart?.({ turnId, mode: opts.mode });
      if (pendingThinking) {
        opts.callbacks?.onThinkingDelta?.(pendingThinking);
        pendingThinking = "";
      }
      if (pendingText) {
        opts.callbacks?.onTextDelta?.(pendingText);
        pendingText = "";
      }
    };

    if (streamStarted) {
      opts.callbacks?.onTurnStart?.({ turnId, mode: opts.mode });
    }

    const retryDelays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const recordedToolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      ok: boolean;
      output: string;
    }> = [];

    let fullText = "";
    let fullThinking = "";
    let aborted = false;
    let rolledOver = false;
    let lastError: { code: LlmErrorCode; message: string; retryable: boolean } | undefined;

    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }

      let stepText = "";
      let stepThinking = "";
      let stepThinkingSig: string | undefined;
      const stepToolCalls: ChatToolCall[] = [];

      // 对齐 Spec 01 §1.3：429 / 5xx（RATE_LIMITED / PROVIDER_ERROR）在尚未输出内容前指数退避重试 2 次
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        let retryableFailure: { code: LlmErrorCode; message: string; retryable: boolean } | undefined;
        let producedOutputInAttempt = false;

        for await (const chunk of this.deps.chatModel.stream({
          systemPrompt,
          messages,
          tools: tier1Tools,
          sessionId: this.sessionId,
          signal: opts.signal,
        })) {
          if (opts.signal?.aborted) {
            aborted = true;
            break;
          }
          if (chunk.type === "thinking_delta") {
            producedOutputInAttempt = true;
            stepThinking += chunk.delta;
            fullThinking += chunk.delta;
            if (chunk.signature) stepThinkingSig = chunk.signature;
            if (streamStarted) {
              opts.callbacks?.onThinkingDelta?.(chunk.delta);
            } else {
              pendingThinking += chunk.delta;
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
            stepToolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.args });
          } else if (chunk.type === "usage") {
            if (chunk.totalTokens >= this.deps.chatModel.contextWindow * ROLLOVER_RATIO) {
              rolledOver = true;
            }
          } else if (chunk.type === "error") {
            if (chunk.code === "CONTEXT_OVERFLOW") {
              rolledOver = true;
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
        if (retryableFailure) {
          await sleepWithAbort(retryDelays[attempt], opts.signal);
          continue;
        }
        break;
      }

      if (lastError || aborted) break;

      // 单轮多步工具循环：完整保留本步 thinking + signature 发回模型
      if (stepToolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: stepText,
          thinking: stepThinking || undefined,
          thinkingSignature: stepThinkingSig,
          toolCalls: stepToolCalls,
          timestamp: this.deps.clock.now(),
        });

        for (const tc of stepToolCalls) {
          if (tc.name === "express" || tc.name === "door") {
            flushWakeStart();
          }
          const result = await this.deps.registry.invoke(tc.name, tc.arguments, toolCtx);
          recordedToolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            ok: result.ok,
            output: result.output,
          });
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
        continue;
      }

      break;
    }

    // 更新盘中 Static Prefix 文件的 <prefix_delta>（不回改本会话 Static Prefix 快照）
    for (const rel of toolCtx.touchedMemoryPaths) {
      if (STATIC_PREFIX_PATHS.has(rel)) {
        const latest = await readOptionalMemoryFile(this.deps.dataDir, rel);
        if (latest) this.prefixDelta.set(rel, latest);
      }
    }

    // 仅当本轮实际写入 memory/ 时才精准 Git 提交
    const touched = Array.from(toolCtx.touchedMemoryPaths);
    if (touched.length > 0) {
      await commitMemoryPaths(this.deps.dataDir, touched, `memory(turn): ${turnId}`);
    }

    // wake [SILENT] 判定
    const isSilent =
      opts.mode === "wake" &&
      !lastError &&
      !aborted &&
      (fullText.trim() === "[SILENT]" || (fullText.trim() === "" && toolCtx.expressions.length === 0));

    // Spec 01 §2.2：只要交互/唤醒轮正常完成（含 wake [SILENT]），推进 door_notes_read 游标
    if (!lastError && !aborted && injectedDoorNoteMaxId) {
      this.deps.events.setCursor("door_notes_read", injectedDoorNoteMaxId);
    }

    if (isSilent) {
      if (rolledOver) await this.triggerRollover();
      return {
        turnId,
        sessionId: this.sessionId,
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

    if (!lastError && !streamStarted && (fullText.trim().length > 0 || toolCtx.expressions.length > 0)) {
      flushWakeStart();
    }

    let persisted: StoredEvent | null = null;
    if (!lastError && (fullText.length > 0 || toolCtx.expressions.length > 0 || aborted)) {
      const metadata: Record<string, unknown> = {};
      if (toolCtx.expressions.length > 0) metadata.expressions = toolCtx.expressions;
      if (recordedToolCalls.length > 0) metadata.toolCalls = recordedToolCalls;
      if (recallCount > 0) metadata.recallCount = recallCount;
      if (aborted) metadata.aborted = true;
      const { event } = this.deps.events.append({
        sessionId: this.sessionId,
        turnId,
        role: "assistant",
        kind: opts.mode === "wake" ? "wake" : "chat",
        content: fullText,
        thinking: fullThinking || null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      });
      persisted = event;
    }

    if (rolledOver) {
      await this.triggerRollover();
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
      });
    }

    return {
      turnId,
      sessionId: this.sessionId,
      message: persisted,
      text: fullText,
      thinking: fullThinking,
      recallCount,
      aborted,
      silent: false,
      rolledOver,
      touchedMemoryPaths: touched,
      error: lastError,
    };
  }
}
