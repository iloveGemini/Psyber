import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";
import { localWeekday, vagueTimeOfDay, vagueWhen } from "../core/clock.ts";
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
  ChatToolCall,
  ChatUserContent,
  LlmErrorCode,
} from "../llm/client.ts";
import { resolveEffectiveThinkingLevel } from "../llm/router.ts";
import { parseCardMarkdown } from "../memory/frontmatter.ts";
import { buildGistBlock } from "../memory/gist.ts";
import type { MemoryIndex } from "../memory/index.ts";
import { recallMemories, type EmbeddingClient } from "../memory/recall.ts";
import { renderCircadianState } from "../mood/circadian.ts";
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
const STICKER_INJECT_LIMIT = 30;
const STICKER_INJECT_MAX_CHARS = 500;

export interface ToolProgressEvent {
  turnId: string;
  callId: string;
  name: string;
  label: string;
  kind: "general" | "screen";
  status: "running" | "done" | "error";
}

export interface ContextUsageSnapshot {
  usedTokens: number;
  limitTokens: number;
  ratio: number;
}

export interface TurnStreamCallbacks {
  onTurnStart?: (info: { turnId: string; mode: "chat" | "wake" }) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolProgress?: (info: ToolProgressEvent) => void;
  onTextDelta?: (delta: string) => void;
  onExpression?: (payload: ExpressionPayload) => void;
  onDoorUpdated?: (state: DoorState, note: string | null) => void;
  onMessageRetracted?: (event: StoredEvent) => void;
  onAssistantPersisted?: (event: StoredEvent) => void;
  onModelSwitched?: (info: { turnId: string; model: string; reason?: string }) => void;
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
  drawer_read: "趁你不在，翻看了上锁抽屉",
  drawer_write: "趁你不在，往抽屉里封存了一篇日记",
};

export function formatToolActionLabel(toolName: string, mode: "chat" | "wake"): string {
  const table = mode === "wake" ? WAKE_TOOL_LABELS : CHAT_TOOL_LABELS;
  return table[toolName] ?? toolName;
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
  /** 内容寻址媒体仓（用于将用户上传的图片附件编码为多模态块送入模型） */
  media?: MediaStore;
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
  private lastUsedTokens = 0;
  private lastAssistantModel: string | null = null;

  constructor(private readonly deps: DirectEngineDeps) {
    this.sessionId = ulid(deps.clock.now());
  }

  getActiveSessionId(): string {
    return this.sessionId;
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

  /** 手动「存记忆换段」：在互斥锁保护下切新 session_id 并触发后台异步整理 */
  manualRollover(): Promise<{ oldSessionId: string; newSessionId: string }> {
    return this.turnMutex.runExclusive(async () => {
      const oldSessionId = this.sessionId;
      await this.triggerRollover();
      return { oldSessionId, newSessionId: this.sessionId };
    });
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

  /** 构造 Segment 2：跨轮历史回放（换段首条注入 <gist> + 近 6 轮过渡，剥除历史 thinking） */
  private buildHistoryMessages(excludeEventId?: string, beforeSeq?: number): ChatMessage[] {
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
      if (beforeSeq !== undefined && ev.seq >= beforeSeq) continue;
      if (ev.role === "user" && (ev.kind === "chat" || ev.kind === "door_note")) {
        // 双向社交撤回不对称性：用户撤回后，住户上下文只见占位看不到原文
        const content =
          ev.status === "retracted"
            ? "（对方撤回了一条消息）"
            : this.formatHistoryUserContent(ev);
        history.push({
          role: "user",
          content,
          timestamp: ev.createdAt,
        });
      } else if (ev.role === "assistant" && (ev.kind === "chat" || ev.kind === "wake")) {
        // 跨轮历史严格剥除 thinking；住户自己撤回的消息在自身上下文里保留原话
        const content =
          ev.status === "retracted"
            ? `${ev.content}\n（我后来撤回了这条消息，对方看不到内容）`
            : ev.content;
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
        `<urgent_channel>对方在门关着时开启了「一次性紧急通道」发来这一条消息，发完通道已自动重新关上。</urgent_channel>`,
      );
    }

    const userStatusParts: string[] = [];
    if (cfg.userStatus?.undisturbed) userStatusParts.push("开着勿扰");
    if (cfg.userStatus?.moodText) userStatusParts.push(`心绪「${cfg.userStatus.moodText}」`);
    if (userStatusParts.length > 0) {
      ctxBlocks.push(
        `<user_status>对方主动挂出的状态：${userStatusParts.join("；")}。</user_status>`,
      );
    }

    if (cfg.recallEvalNoticeResident) {
      ctxBlocks.push(
        `<eval_notice>对方当前开启了召回评测检视模式，可能会查看本轮召回的记忆卡片清单并做标注。</eval_notice>`,
      );
    }

    const recentShares = this.deps.events.listRecentShares(nowMs - 7 * 24 * 3600_000, 5);
    if (recentShares.length > 0) {
      const shareParts = recentShares.map((s) => {
        const readStatus = s.openedAt ? `已点开看（${vagueWhen(s.openedAt, nowMs, tz)}）` : "还没打开";
        return `《${s.title}》（${vagueWhen(s.createdAt, nowMs, tz)}分享；${readStatus}）`;
      });
      ctxBlocks.push(`<shared_items>我最近分享给对方的：${shareParts.join("；")}</shared_items>`);
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
          return `- 系统事实：用户在${when}拆封查看了上锁抽屉中的「${title || ev.content}」`;
        }
        if (ev.kind === "share.opened") {
          return `- 系统事实：用户在${when}打开阅读了你分享的「${title || ev.content}」`;
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
          sessionId: this.sessionId,
          turnId: opts.turnId,
          query: recallQuery,
          activityHint: opts.activityHint,
          embedding: this.deps.embedding,
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

  private async triggerRollover(): Promise<void> {
    const oldSessionId = this.sessionId;
    const recentEvents = this.deps.events.listRecentSessionMessages(oldSessionId, 12);
    this.rolloverCarryOver = recentEvents.map((ev) => ({
      role: ev.role === "assistant" ? "assistant" : "user",
      content:
        ev.role === "user"
          ? ev.status === "retracted"
            ? "（对方撤回了一条消息）"
            : this.formatHistoryUserContent(ev)
          : ev.status === "retracted"
            ? `${ev.content}\n（我后来撤回了这条消息，对方看不到内容）`
            : ev.content,
      timestamp: ev.createdAt,
    }));
    this.rolloverGistAnchor = await buildGistBlock(this.deps.dataDir, this.deps.memoryIndex);

    this.sessionId = ulid(this.deps.clock.now());
    this.staticPrefixSnapshot = null;
    this.prefixDelta.clear();
    this.lastUsedTokens = 0;
    this.deps.onRollover?.(oldSessionId, this.sessionId);
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
    signal?: AbortSignal;
    callbacks?: TurnStreamCallbacks;
  }): Promise<RunTurnResult> {
    return this.turnMutex.runExclusive(() => this.executeTurn(opts));
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
    signal?: AbortSignal;
    callbacks?: TurnStreamCallbacks;
  }): Promise<RunTurnResult> {
    const turnId = opts.turnId ?? ulid(this.deps.clock.now());
    const systemPrompt = await this.getOrBuildStaticPrefix();
    const tier1Tools = this.deps.registry.getTier1Definitions();
    const history = this.buildHistoryMessages(opts.userEventId, opts.historyBeforeSeq);
    const {
      content: dynamicUserContent,
      injectedDoorNoteMaxId,
      injectedNoticeMaxId,
      recallCount,
    } = await this.buildDynamicUserMessage({
      mode: opts.mode,
      turnId,
      userText: opts.userText ?? "",
      stickerId: opts.stickerId,
      attachments: opts.attachments,
      videoClip: opts.videoClip,
      urgent: opts.urgent,
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
      shares: [],
      onExpression: (p) => opts.callbacks?.onExpression?.(p),
      onDoorUpdated: (s, n) => opts.callbacks?.onDoorUpdated?.(s, n),
      onMessageRetracted: (ev) => opts.callbacks?.onMessageRetracted?.(ev),
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
    const toolSummary: Array<{
      name: string;
      label: string;
      ok: boolean;
      kind: "general" | "screen";
    }> = [];

    const cfgForTurn = this.deps.getConfig();
    const effectiveThinkingLevel = resolveEffectiveThinkingLevel(cfgForTurn);
    const effectiveThinkingBudget = cfgForTurn.llm?.thinking?.budgetTokens;
    const rolloverLimitTokens = this.computeEffectiveRolloverLimit(opts.mode);
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

    let fullText = "";
    let fullThinking = "";
    let aborted = false;
    let rolledOver = false;
    let lastUsage: {
      model?: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      estimatedCostUsd?: number;
    } | undefined;
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
            this.lastUsedTokens = chunk.totalTokens;
            lastUsage = {
              ...(activeModelId ? { model: activeModelId } : {}),
              inputTokens: chunk.inputTokens,
              outputTokens: chunk.outputTokens,
              ...(chunk.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.cacheReadTokens } : {}),
              ...(chunk.cacheWriteTokens !== undefined ? { cacheWriteTokens: chunk.cacheWriteTokens } : {}),
              ...(chunk.estimatedCostUsd !== undefined ? { estimatedCostUsd: chunk.estimatedCostUsd } : {}),
            };
            if (chunk.totalTokens >= rolloverLimitTokens) {
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
            toolSummary.push({
              name: innerName,
              label: toolLabel,
              ok: result.ok,
              kind: toolKind,
            });
            opts.callbacks?.onToolProgress?.({
              turnId,
              callId: tc.id,
              name: innerName,
              label: toolLabel,
              kind: toolKind,
              status: result.ok ? "done" : "error",
            });
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
    }

    if (isSilent) {
      if (rolledOver) await this.triggerRollover();
      opts.callbacks?.onTurnSilence?.({ turnId, ownTime: opts.mode === "wake" });
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
      (fullText.length > 0 || toolCtx.expressions.length > 0 || shareCount > 0 || aborted)
    ) {
      const metadata: Record<string, unknown> = {};
      if (opts.userEventId) metadata.inReplyTo = opts.userEventId;
      if (toolCtx.expressions.length > 0) metadata.expressions = toolCtx.expressions;
      if (shareCount > 0 && toolCtx.shares) metadata.shares = toolCtx.shares;
      if (recordedToolCalls.length > 0) metadata.toolCalls = recordedToolCalls;
      if (toolSummary.length > 0) metadata.toolSummary = toolSummary;
      if (activeModelId) metadata.model = activeModelId;
      if (lastUsage) metadata.usage = lastUsage;
      if (recallCount > 0) metadata.recallCount = recallCount;
      if (aborted) metadata.aborted = true;
      const { event } = this.deps.events.append({
        sessionId: this.sessionId,
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
        contextUsage: this.getContextUsage(),
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
