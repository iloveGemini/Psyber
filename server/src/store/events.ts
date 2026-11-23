import type { Database } from "bun:sqlite";
import { localDay, type Clock } from "../core/clock.ts";
import { ulid } from "../core/ulid.ts";

export type EventRole = "user" | "assistant" | "system" | "task";
export type EventKind =
  | "chat"
  | "door_note"
  | "wake"
  | "memory_task"
  | "activity_event"
  | "door.updated"
  | "privacy.peeked"
  | "share.opened"
  | "request.decided";
export type EventStatus = "active" | "candidate" | "discarded" | "deleted" | "retracted";

export interface StoredEvent {
  id: string;
  seq: number;
  sessionId: string;
  turnId: string | null;
  clientMessageId: string | null;
  groupId: string | null;
  version: number;
  status: EventStatus;
  role: EventRole;
  kind: EventKind;
  activity: string | null;
  content: string;
  thinking: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface StickerRecord {
  id: string;
  label: string;
  pack: string;
  mediaHash: string;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface AppendEventInput {
  sessionId: string;
  turnId?: string | null;
  clientMessageId?: string | null;
  groupId?: string | null;
  version?: number;
  role: EventRole;
  kind: EventKind;
  activity?: string | null;
  content: string;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** 持久化的活跃会话指针（存入 task_cursors['active_session']），确保换段未发言重启不复活旧段 */
export interface ActiveSessionRecord {
  sessionId: string;
  /** true 表示已切新段、尚未在本段发出首轮（首轮发送前惰性定格 continuity） */
  fresh: boolean;
  /** 换段截取「上一段末尾原话」时的事件 seq 上限（避免重启丢过渡或误吞新段排队消息） */
  carryOverUntilSeq?: number | null;
  /** 本段首轮定格后的 <continuity> 文本（同段与短停重启字节级复用，保护 Prompt Cache #1） */
  continuity?: string | null;
}

interface EventRow {
  id: string;
  seq: number;
  session_id: string;
  turn_id: string | null;
  client_message_id: string | null;
  group_id: string | null;
  version: number;
  status: EventStatus;
  role: EventRole;
  kind: EventKind;
  activity: string | null;
  content: string;
  thinking: string | null;
  metadata: string | null;
  created_at: number;
}

function mapRow(row: EventRow): StoredEvent {
  return {
    id: row.id,
    seq: row.seq,
    sessionId: row.session_id,
    turnId: row.turn_id,
    clientMessageId: row.client_message_id,
    groupId: row.group_id,
    version: row.version,
    status: row.status,
    role: row.role,
    kind: row.kind,
    activity: row.activity,
    content: row.content,
    thinking: row.thinking,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}

/**
 * 只追加原始事件账本：事务内保证 clientMessageId 幂等与 seq 单调递增，并提供游标与贴纸查询。
 */
export class EventStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  append(input: AppendEventInput): { event: StoredEvent; deduplicated: boolean } {
    const tx = this.db.transaction(() => {
      if (input.clientMessageId) {
        const existing = this.db
          .query("SELECT * FROM events WHERE client_message_id = ?")
          .get(input.clientMessageId) as EventRow | null;
        if (existing) {
          return { row: existing, deduplicated: true };
        }
      }

      const nowMs = this.clock.now();
      const id = ulid(nowMs);
      const maxRow = this.db.query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events").get() as {
        max_seq: number;
      };
      const nextSeq = maxRow.max_seq + 1;
      this.db
        .query(
          `INSERT INTO events (
            id, seq, session_id, turn_id, client_message_id,
            group_id, version, status, role, kind,
            source, fonds, activity, content, thinking, metadata, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 'live', '', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          nextSeq,
          input.sessionId,
          input.turnId ?? null,
          input.clientMessageId ?? null,
          input.groupId ?? null,
          input.version ?? 1,
          input.role,
          input.kind,
          input.activity ?? null,
          input.content,
          input.thinking ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          nowMs,
        );
      const inserted = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as EventRow;
      return { row: inserted, deduplicated: false };
    });

    const result = tx();
    return { event: mapRow(result.row), deduplicated: result.deduplicated };
  }

  getById(id: string): StoredEvent | null {
    const row = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as EventRow | null;
    return row ? mapRow(row) : null;
  }

  /** 查找指定 turnId 对应的活跃用户消息（供原地无痕重试使用） */
  findUserEventByTurnId(turnId: string): StoredEvent | null {
    const row = this.db
      .query(
        `SELECT * FROM events
         WHERE turn_id = ? AND role = 'user' AND status = 'active'
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(turnId) as EventRow | null;
    return row ? mapRow(row) : null;
  }

  /** 判断指定 turnId 或用户消息 ID 是否已经成功落盘过活跃助手回复 */
  hasAssistantReplyForTurn(turnId: string, userEventId?: string): boolean {
    const row = userEventId
      ? this.db
          .query(
            `SELECT 1 FROM events
             WHERE role = 'assistant' AND status = 'active'
               AND (turn_id = ? OR json_extract(metadata, '$.inReplyTo') = ?)
             LIMIT 1`,
          )
          .get(turnId, userEventId)
      : this.db
          .query(
            `SELECT 1 FROM events
             WHERE turn_id = ? AND role = 'assistant' AND status = 'active'
             LIMIT 1`,
          )
          .get(turnId);
    return row !== null;
  }

  /**
   * 按 seq DESC 截取 limit 条活跃事件后翻转为 seq ASC（旧→新）返回，供聊天时间线分页。
   */
  listHistory(opts: { beforeId?: string; limit?: number } = {}): {
    items: StoredEvent[];
    hasMore: boolean;
    nextBefore: string | null;
    latestEventSeq: number;
  } {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    let beforeSeq: number | null = null;
    if (opts.beforeId) {
      const anchor = this.db.query("SELECT seq FROM events WHERE id = ?").get(opts.beforeId) as {
        seq: number;
      } | null;
      if (anchor) beforeSeq = anchor.seq;
    }

    const rows = (
      beforeSeq !== null
        ? this.db
            .query(
              `SELECT * FROM events
               WHERE status IN ('active', 'retracted') AND seq < ?
               ORDER BY seq DESC
               LIMIT ?`,
            )
            .all(beforeSeq, limit + 1)
        : this.db
            .query(
              `SELECT * FROM events
               WHERE status IN ('active', 'retracted')
               ORDER BY seq DESC
               LIMIT ?`,
            )
            .all(limit + 1)
    ) as EventRow[];

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const ordered = sliced.reverse().map(mapRow);

    const latestRow = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events")
      .get() as { max_seq: number };

    return {
      items: ordered,
      hasMore,
      nextBefore: hasMore && ordered.length > 0 ? ordered[0].id : null,
      latestEventSeq: latestRow.max_seq,
    };
  }

  softDelete(id: string): { deleted: boolean; eventSeq: number | null } {
    const tx = this.db.transaction(() => {
      const row = this.db.query("SELECT seq, status FROM events WHERE id = ?").get(id) as {
        seq: number;
        status: EventStatus;
      } | null;
      if (!row || (row.status !== "active" && row.status !== "retracted")) {
        return { deleted: false, eventSeq: null };
      }
      this.db.query("UPDATE events SET status = 'deleted' WHERE id = ?").run(id);
      return { deleted: true, eventSeq: row.seq };
    });
    return tx();
  }

  /**
   * 双向社交撤回（Spec 04 §4）：只允许撤回自己的活跃消息，标记 status = 'retracted'，
   * 保留原文在数据库列中以实现不对称可见性（用户撤回对Psyber隐藏，Psyber撤回仅对前端隐藏）。
   */
  retract(
    id: string,
    by: "user" | "resident",
  ): { ok: true; event: StoredEvent } | { ok: false; code: string; error: string } {
    const tx = this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as EventRow | null;
      if (!row) {
        return { ok: false as const, code: "NOT_FOUND", error: "找不到这条消息" };
      }
      if (row.status === "retracted") {
        return { ok: false as const, code: "ALREADY_RETRACTED", error: "这条消息已经撤回过了" };
      }
      if (row.status !== "active") {
        return { ok: false as const, code: "NOT_RETRACTABLE", error: "只能撤回当前活跃的消息" };
      }
      if (by === "user" && (row.role !== "user" || (row.kind !== "chat" && row.kind !== "door_note"))) {
        return { ok: false as const, code: "FORBIDDEN_RETRACT", error: "只能撤回自己发送的消息" };
      }
      if (by === "resident" && (row.role !== "assistant" || (row.kind !== "chat" && row.kind !== "wake"))) {
        return { ok: false as const, code: "FORBIDDEN_RETRACT", error: "只能撤回自己说过的话" };
      }

      const meta: Record<string, unknown> = row.metadata
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : {};
      meta.retractedBy = by;
      meta.retractedAt = this.clock.now();
      this.db
        .query("UPDATE events SET status = 'retracted', metadata = ? WHERE id = ?")
        .run(JSON.stringify(meta), id);
      const updated = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as EventRow;
      return { ok: true as const, event: mapRow(updated) };
    });
    return tx();
  }

  /**
   * 按精准原文子串查找Psyber可撤回的活跃消息（防止模型幻觉乱撤）：
   * 必须匹配且仅匹配 1 条；0 条或多条均拒绝撤回。
   */
  findRetractableAssistantMessage(
    sessionId: string,
    quote: string,
  ): { event?: StoredEvent; error?: string } {
    const needle = quote.trim();
    if (!needle) {
      return { error: "请精准引用要撤回的那句话中的一段原文，不能留空。" };
    }
    const rows = this.db
      .query(
        `SELECT * FROM events
         WHERE session_id = ? AND role = 'assistant' AND status = 'active'
           AND kind IN ('chat', 'wake')
         ORDER BY seq ASC`,
      )
      .all(sessionId) as EventRow[];
    const matches = rows.filter((r) => r.content.includes(needle));
    if (matches.length === 0) {
      return { error: `我说过的话里没找到「${needle}」（已经撤回的不算）。` };
    }
    if (matches.length > 1) {
      return { error: `「${needle}」匹配到了 ${matches.length} 条回复，请多引用几个字精确定位。` };
    }
    return { event: mapRow(matches[0]) };
  }

  getCursor(taskKey: string): string | null {
    const row = this.db
      .query("SELECT last_event_id FROM task_cursors WHERE task_key = ?")
      .get(taskKey) as { last_event_id: string } | null;
    return row ? row.last_event_id : null;
  }

  setCursor(taskKey: string, lastEventId: string, meta?: Record<string, unknown>): void {
    this.db
      .query(
        `INSERT INTO task_cursors (task_key, last_event_id, meta_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_key) DO UPDATE SET
           last_event_id = excluded.last_event_id,
           meta_json = excluded.meta_json,
           updated_at = excluded.updated_at`,
      )
      .run(taskKey, lastEventId, meta ? JSON.stringify(meta) : null, this.clock.now());
  }

  countUnreadDoorNotes(afterEventId?: string | null): number {
    const cursor = afterEventId === undefined ? this.getCursor("door_notes_read") : afterEventId;
    const row = this.db
      .query(
        `SELECT COUNT(*) AS cnt FROM events
         WHERE role = 'user' AND kind = 'door_note' AND status = 'active' AND id > ?`,
      )
      .get(cursor ?? "") as { cnt: number };
    return row.cnt;
  }

  /**
   * 按 ORDER BY seq ASC 从旧到新查询未读门缝纸条（对齐 Spec 03 §1.1）：
   * 单轮最多分批返回 maxCount 条且总正文 ≤ maxChars 字符，并返回剩余未读条数供附注提示。
   */
  listUnreadDoorNotes(opts: { maxCount?: number; maxChars?: number } = {}): {
    items: StoredEvent[];
    remainingCount: number;
  } {
    const maxCount = Math.max(1, opts.maxCount ?? 10);
    const maxChars = Math.max(100, opts.maxChars ?? 2000);
    const cursor = this.getCursor("door_notes_read") ?? "";

    const rows = this.db
      .query(
        `SELECT * FROM events
         WHERE role = 'user' AND kind = 'door_note' AND status = 'active' AND id > ?
         ORDER BY seq ASC`,
      )
      .all(cursor) as EventRow[];

    const items: StoredEvent[] = [];
    let usedChars = 0;
    for (const row of rows) {
      if (items.length >= maxCount) break;
      const ev = mapRow(row);
      if (items.length > 0 && usedChars + ev.content.length > maxChars) break;
      items.push(ev);
      usedChars += ev.content.length;
    }

    return {
      items,
      remainingCount: Math.max(0, rows.length - items.length),
    };
  }

  /** 读取持久化的活跃会话状态（task_cursors['active_session']） */
  getActiveSessionState(): ActiveSessionRecord | null {
    const row = this.db
      .query("SELECT last_event_id, meta_json FROM task_cursors WHERE task_key = 'active_session'")
      .get() as { last_event_id: string; meta_json: string | null } | null;
    if (!row) return null;
    if (!row.meta_json) {
      return row.last_event_id ? { sessionId: row.last_event_id, fresh: false } : null;
    }
    try {
      const parsed = JSON.parse(row.meta_json) as Partial<ActiveSessionRecord>;
      const sessionId =
        typeof parsed.sessionId === "string" && parsed.sessionId.trim()
          ? parsed.sessionId.trim()
          : row.last_event_id;
      if (!sessionId) return null;
      return {
        sessionId,
        fresh: parsed.fresh === true,
        carryOverUntilSeq:
          typeof parsed.carryOverUntilSeq === "number" && Number.isFinite(parsed.carryOverUntilSeq)
            ? parsed.carryOverUntilSeq
            : null,
        continuity: typeof parsed.continuity === "string" ? parsed.continuity : null,
      };
    } catch {
      return row.last_event_id ? { sessionId: row.last_event_id, fresh: false } : null;
    }
  }

  /** 持久化活跃会话指针与首轮定格的 <continuity>（原子写入 task_cursors） */
  setActiveSessionState(state: ActiveSessionRecord): void {
    this.setCursor("active_session", state.sessionId, {
      sessionId: state.sessionId,
      fresh: state.fresh,
      carryOverUntilSeq: state.carryOverUntilSeq ?? null,
      continuity: state.continuity ?? null,
    });
  }

  /** 完整查询指定会话内的对话消息（按 seq ASC，不再用全局 limit 截断击穿缓存） */
  listSessionMessages(
    sessionId: string,
    opts: { excludeEventId?: string; beforeSeq?: number } = {},
  ): StoredEvent[] {
    const rows = (
      opts.beforeSeq !== undefined
        ? this.db
            .query(
              `SELECT * FROM events
               WHERE session_id = ? AND status IN ('active', 'retracted')
                 AND role IN ('user', 'assistant')
                 AND kind IN ('chat', 'door_note', 'wake')
                 AND seq < ?
               ORDER BY seq ASC`,
            )
            .all(sessionId, opts.beforeSeq)
        : this.db
            .query(
              `SELECT * FROM events
               WHERE session_id = ? AND status IN ('active', 'retracted')
                 AND role IN ('user', 'assistant')
                 AND kind IN ('chat', 'door_note', 'wake')
               ORDER BY seq ASC`,
            )
            .all(sessionId)
    ) as EventRow[];
    const mapped = rows.map(mapRow);
    return opts.excludeEventId ? mapped.filter((e) => e.id !== opts.excludeEventId) : mapped;
  }

  /** 查询指定会话最近 N 条活跃或已撤回对话消息（按 seq ASC 返回） */
  listRecentSessionMessages(sessionId: string, limit = 12): StoredEvent[] {
    const rows = this.db
      .query(
        `SELECT * FROM events
         WHERE session_id = ? AND status IN ('active', 'retracted')
           AND role IN ('user', 'assistant')
           AND kind IN ('chat', 'door_note', 'wake')
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(sessionId, Math.max(1, limit)) as EventRow[];
    return rows.reverse().map(mapRow);
  }

  /** 跨会话取最近 N 条对话（支持 maxSeq 截止点，避免把换段期间排队的新消息算进上一段原话） */
  listRecentMessages(limit = 12, maxSeq?: number | null): StoredEvent[] {
    const rows = (
      typeof maxSeq === "number" && Number.isFinite(maxSeq)
        ? this.db
            .query(
              `SELECT * FROM events
               WHERE status IN ('active', 'retracted')
                 AND role IN ('user', 'assistant')
                 AND kind IN ('chat', 'door_note', 'wake')
                 AND seq <= ?
               ORDER BY seq DESC
               LIMIT ?`,
            )
            .all(maxSeq, Math.max(1, limit))
        : this.db
            .query(
              `SELECT * FROM events
               WHERE status IN ('active', 'retracted')
                 AND role IN ('user', 'assistant')
                 AND kind IN ('chat', 'door_note', 'wake')
               ORDER BY seq DESC
               LIMIT ?`,
            )
            .all(Math.max(1, limit))
    ) as EventRow[];
    return rows.reverse().map(mapRow);
  }

  /** 返回最近一条有效对话的完整定位信息（含 id、seq、sessionId、createdAt） */
  getLatestChatEvent(): { id: string; seq: number; sessionId: string; createdAt: number } | null {
    const row = this.db
      .query(
        `SELECT id, seq, session_id, created_at FROM events
         WHERE status IN ('active', 'retracted')
           AND role IN ('user', 'assistant')
           AND kind IN ('chat', 'door_note', 'wake')
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get() as { id: string; seq: number; session_id: string; created_at: number } | null;
    if (!row) return null;
    return { id: row.id, seq: row.seq, sessionId: row.session_id, createdAt: row.created_at };
  }

  /** 返回最近一条有效对话所属的 sessionId 与时间，供重启恢复连续性 */
  getLatestChatSession(): { sessionId: string; lastMessageAt: number } | null {
    const latest = this.getLatestChatEvent();
    if (!latest) return null;
    return { sessionId: latest.sessionId, lastMessageAt: latest.createdAt };
  }

  hasMessagesInSession(sessionId: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 AS hit FROM events
         WHERE session_id = ? AND status IN ('active', 'retracted')
           AND role IN ('user', 'assistant')
           AND kind IN ('chat', 'door_note', 'wake')
         LIMIT 1`,
      )
      .get(sessionId) as { hit: number } | null;
    return row !== null;
  }

  hasMessagesBeforeSession(sessionId: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 AS hit FROM events
         WHERE session_id != ? AND status IN ('active', 'retracted')
           AND role IN ('user', 'assistant')
           AND kind IN ('chat', 'door_note', 'wake')
         LIMIT 1`,
      )
      .get(sessionId) as { hit: number } | null;
    return row !== null;
  }

  /** 将排队等待换段期间已落盘的用户事件重绑至换段后的新 sessionId，避免跨段错位 */
  rebindEventSessionId(eventId: string, newSessionId: string): void {
    this.db.query("UPDATE events SET session_id = ? WHERE id = ?").run(newSessionId, eventId);
  }

  /** 冷启动续接原会话时恢复最后一次助手回复的上下文总 Token 占用 */
  getLatestSessionUsageTokens(sessionId: string): number {
    const row = this.db
      .query(
        `SELECT metadata FROM events
         WHERE session_id = ? AND role = 'assistant' AND status = 'active'
           AND metadata IS NOT NULL
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(sessionId) as { metadata: string | null } | null;
    if (!row?.metadata) return 0;
    try {
      const meta = JSON.parse(row.metadata) as {
        usage?: {
          totalTokens?: unknown;
          inputTokens?: unknown;
          outputTokens?: unknown;
          cacheReadTokens?: unknown;
          cacheWriteTokens?: unknown;
        };
      };
      const u = meta.usage;
      if (!u) return 0;
      if (typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens > 0) {
        return Math.floor(u.totalTokens);
      }
      const sum =
        (typeof u.inputTokens === "number" ? u.inputTokens : 0) +
        (typeof u.outputTokens === "number" ? u.outputTokens : 0) +
        (typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : 0) +
        (typeof u.cacheWriteTokens === "number" ? u.cacheWriteTokens : 0);
      return Number.isFinite(sum) && sum > 0 ? Math.floor(sum) : 0;
    } catch {
      return 0;
    }
  }

  getSticker(stickerId: string): StickerRecord | null {
    const row = this.db
      .query(
        "SELECT id, label, pack, media_hash, use_count, last_used_at, created_at FROM stickers WHERE id = ?",
      )
      .get(stickerId) as {
      id: string;
      label: string;
      pack: string;
      media_hash: string;
      use_count: number;
      last_used_at: number | null;
      created_at: number;
    } | null;
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      pack: row.pack,
      mediaHash: row.media_hash,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
    };
  }

  listStickers(limit = 30): StickerRecord[] {
    const rows = this.db
      .query(
        `SELECT id, label, pack, media_hash, use_count, last_used_at, created_at
         FROM stickers
         ORDER BY last_used_at DESC, use_count DESC, id ASC
         LIMIT ?`,
      )
      .all(Math.max(1, limit)) as Array<{
      id: string;
      label: string;
      pack: string;
      media_hash: string;
      use_count: number;
      last_used_at: number | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      pack: r.pack,
      mediaHash: r.media_hash,
      useCount: r.use_count,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
    }));
  }

  incrementStickerUsage(stickerId: string): void {
    this.db
      .query("UPDATE stickers SET use_count = use_count + 1, last_used_at = ? WHERE id = ?")
      .run(this.clock.now(), stickerId);
  }

  getBedtimeNightDate(): string | null {
    const row = this.db
      .query("SELECT meta_json FROM task_cursors WHERE task_key = 'bedtime'")
      .get() as { meta_json: string | null } | null;
    if (!row?.meta_json) return null;
    try {
      const parsed = JSON.parse(row.meta_json) as { last_gist_date?: unknown };
      return typeof parsed.last_gist_date === "string" && parsed.last_gist_date
        ? parsed.last_gist_date
        : null;
    } catch {
      return null;
    }
  }

  getBedtimeLastRunAt(): number | null {
    const row = this.db
      .query("SELECT meta_json FROM task_cursors WHERE task_key = 'bedtime'")
      .get() as { meta_json: string | null } | null;
    if (!row?.meta_json) return null;
    try {
      const parsed = JSON.parse(row.meta_json) as { last_run_at?: unknown };
      return typeof parsed.last_run_at === "number" && Number.isFinite(parsed.last_run_at)
        ? parsed.last_run_at
        : null;
    } catch {
      return null;
    }
  }

  getOldestPendingWrapupMs(): number | null {
    const cursor = this.getCursor("daily_wrapup") ?? "";
    const row = this.db
      .query(
        `SELECT created_at FROM events
         WHERE status IN ('active', 'retracted')
           AND role IN ('user', 'assistant')
           AND kind IN ('chat', 'wake', 'door_note')
           AND id > ?
         ORDER BY seq ASC
         LIMIT 1`,
      )
      .get(cursor) as { created_at: number } | null;
    return row ? row.created_at : null;
  }

  getLastInteractionMs(): number | null {
    const row = this.db
      .query(
        `SELECT MAX(created_at) AS ts FROM events
         WHERE status = 'active' AND kind IN ('chat', 'wake', 'door_note')`,
      )
      .get() as { ts: number | null } | null;
    return typeof row?.ts === "number" ? row.ts : null;
  }

  getLastWakeMs(): number | null {
    const row = this.db
      .query(
        `SELECT MAX(created_at) AS ts FROM events
         WHERE status = 'active' AND kind = 'wake'`,
      )
      .get() as { ts: number | null } | null;
    return typeof row?.ts === "number" ? row.ts : null;
  }

  getOldestUnreadDoorNoteMs(): number | null {
    const cursor = this.getCursor("door_notes_read") ?? "";
    const row = this.db
      .query(
        `SELECT created_at FROM events
         WHERE role = 'user' AND kind = 'door_note' AND status = 'active' AND id > ?
         ORDER BY seq ASC
         LIMIT 1`,
      )
      .get(cursor) as { created_at: number } | null;
    return row ? row.created_at : null;
  }

  /**
   * 标记 Psyber 留下的门缝纸条首次被用户点开拆封（幂等保留首次 openedAt）。
   */
  openDoorNote(
    id: string,
  ): { ok: true; id: string; openedAt: number; firstOpen: boolean } | { ok: false; error: string } {
    const tx = this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT * FROM events
           WHERE id = ? AND role = 'assistant' AND kind = 'door_note' AND status = 'active'
           LIMIT 1`,
        )
        .get(id) as EventRow | null;
      if (!row) {
        return { ok: false as const, error: "找不到对应的门缝纸条" };
      }
      let meta: Record<string, unknown> = {};
      if (row.metadata) {
        try {
          meta = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          meta = {};
        }
      }
      if (typeof meta.openedAt === "number") {
        return { ok: true as const, id, openedAt: meta.openedAt, firstOpen: false };
      }
      const nowMs = this.clock.now();
      meta.openedAt = nowMs;
      this.db
        .query("UPDATE events SET metadata = ? WHERE id = ?")
        .run(JSON.stringify(meta), row.id);
      return { ok: true as const, id, openedAt: nowMs, firstOpen: true };
    });
    return tx();
  }

  /**
   * 标记Psyber主动分享卡首次被用户点开拆阅（幂等保留首次 openedAt，并写入 share.opened 系统事件）。
   */
  openShare(
    shareId: string,
  ):
    | { ok: true; shareId: string; title: string; openedAt: number; firstOpen: boolean }
    | { ok: false; error: string } {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .query(
          `SELECT * FROM events
           WHERE role = 'assistant' AND status = 'active'
             AND metadata IS NOT NULL AND metadata LIKE '%"shares"%'
           ORDER BY seq DESC
           LIMIT 200`,
        )
        .all() as EventRow[];

      for (const row of rows) {
        if (!row.metadata) continue;
        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!Array.isArray(meta.shares)) continue;
        const shares = meta.shares as Array<{
          id?: string;
          title?: string;
          content?: string;
          createdAt?: number;
          openedAt?: number;
        }>;
        const target = shares.find((s) => s && s.id === shareId);
        if (!target) continue;

        const title = typeof target.title === "string" ? target.title : "分享";
        if (typeof target.openedAt === "number") {
          return {
            ok: true as const,
            shareId,
            title,
            openedAt: target.openedAt,
            firstOpen: false,
          };
        }

        const nowMs = this.clock.now();
        target.openedAt = nowMs;
        this.db
          .query("UPDATE events SET metadata = ? WHERE id = ?")
          .run(JSON.stringify(meta), row.id);

        return {
          ok: true as const,
          shareId,
          title,
          openedAt: nowMs,
          firstOpen: true,
        };
      }

      return { ok: false as const, error: "找不到对应的分享卡片" };
    });

    const result = tx();
    if (result.ok && result.firstOpen) {
      this.append({
        sessionId: "system",
        role: "system",
        kind: "share.opened",
        content: `点开看了你分享的《${result.title}》`,
        metadata: {
          shareId: result.shareId,
          title: result.title,
          openedAt: result.openedAt,
        },
      });
    }
    return result;
  }

  /** 列举近期Psyber递出的分享卡及拆阅状态（供 <runtime_context> 客观回执给Psyber） */
  listRecentShares(
    sinceMs: number,
    limit = 5,
  ): Array<{ id: string; title: string; createdAt: number; openedAt?: number }> {
    const rows = this.db
      .query(
        `SELECT metadata, created_at FROM events
         WHERE role = 'assistant' AND status = 'active'
           AND created_at >= ?
           AND metadata IS NOT NULL AND metadata LIKE '%"shares"%'
         ORDER BY seq DESC
         LIMIT 50`,
      )
      .all(sinceMs) as Array<{ metadata: string | null; created_at: number }>;

    const items: Array<{ id: string; title: string; createdAt: number; openedAt?: number }> = [];
    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const meta = JSON.parse(row.metadata) as Record<string, unknown>;
        if (!Array.isArray(meta.shares)) continue;
        for (const s of meta.shares) {
          if (!s || typeof s !== "object") continue;
          const item = s as {
            id?: unknown;
            title?: unknown;
            createdAt?: unknown;
            openedAt?: unknown;
          };
          if (typeof item.id !== "string" || typeof item.title !== "string") continue;
          items.push({
            id: item.id,
            title: item.title,
            createdAt: typeof item.createdAt === "number" ? item.createdAt : row.created_at,
            ...(typeof item.openedAt === "number" ? { openedAt: item.openedAt } : {}),
          });
          if (items.length >= limit) return items;
        }
      } catch {
        // 忽略损坏 JSON
      }
    }
    return items;
  }

  /** 统计同一版本组下可切换（active + candidate）的助手版本总数 */
  countGroupVersions(groupId: string | null): number {
    if (!groupId) return 1;
    const row = this.db
      .query(
        `SELECT COUNT(*) AS cnt FROM events
         WHERE group_id = ? AND role = 'assistant' AND status IN ('active', 'candidate')`,
      )
      .get(groupId) as { cnt: number };
    return Math.max(1, row.cnt);
  }

  /**
   * 静默编辑当前会话最后一条活跃用户消息（Spec 04 §4）：
   * - 仅允许编辑同会话最后一条 role='user' AND status='active'；
   * - closed/cooling_off 态仅允许编辑 door_note，禁止编辑 chat；
   * - 弃用原用户行及紧随其后的助手回复（status='discarded'），只追加新版本 active 用户行。
   */
  editLatestUserMessage(
    id: string,
    newContent: string,
    opts: {
      doorState: string;
      newTurnId: string | null;
      clientMessageId?: string | null;
      activeSessionId?: string;
    },
  ):
    | { ok: true; event: StoredEvent; groupId: string; discardedAssistantIds: string[] }
    | { ok: false; code: string; error: string } {
    const tx = this.db.transaction(() => {
      const target = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as EventRow | null;
      if (!target) {
        return { ok: false as const, code: "NOT_FOUND", error: "找不到这条消息" };
      }
      if (opts.activeSessionId && target.session_id !== opts.activeSessionId) {
        return {
          ok: false as const,
          code: "NOT_LATEST_USER_MESSAGE",
          error: "该消息属于已收尾的旧会话，不能再编辑",
        };
      }
      if (target.role !== "user" || target.status !== "active") {
        return {
          ok: false as const,
          code: "NOT_LATEST_USER_MESSAGE",
          error: "仅允许编辑当前会话最后一条活跃的用户消息",
        };
      }
      const latestUser = this.db
        .query(
          `SELECT id FROM events
           WHERE session_id = ? AND role = 'user' AND status = 'active'
           ORDER BY seq DESC
           LIMIT 1`,
        )
        .get(target.session_id) as { id: string } | null;
      if (!latestUser || latestUser.id !== target.id) {
        return {
          ok: false as const,
          code: "NOT_LATEST_USER_MESSAGE",
          error: "仅允许编辑当前会话最后一条活跃的用户消息",
        };
      }
      if (
        (opts.doorState === "closed" || opts.doorState === "cooling_off") &&
        target.kind !== "door_note"
      ) {
        return {
          ok: false as const,
          code: "DOOR_CLOSED",
          error: "门正关着，暂不允许编辑普通对话消息",
        };
      }

      const groupId = target.group_id ?? target.id;
      if (!target.group_id) {
        this.db.query("UPDATE events SET group_id = ? WHERE id = ?").run(groupId, target.id);
      }
      this.db.query("UPDATE events SET status = 'discarded' WHERE id = ?").run(target.id);

      const trailingAssts = this.db
        .query(
          `SELECT id FROM events
           WHERE session_id = ? AND role = 'assistant' AND seq > ?
             AND status IN ('active', 'candidate')`,
        )
        .all(target.session_id, target.seq) as Array<{ id: string }>;
      const discardedAssistantIds = trailingAssts.map((r) => r.id);
      if (discardedAssistantIds.length > 0) {
        this.db
          .query(
            `UPDATE events SET status = 'discarded'
             WHERE session_id = ? AND role = 'assistant' AND seq > ?
               AND status IN ('active', 'candidate')`,
          )
          .run(target.session_id, target.seq);
      }

      const verRow = this.db
        .query("SELECT COALESCE(MAX(version), 0) AS max_ver FROM events WHERE group_id = ?")
        .get(groupId) as { max_ver: number };
      const nextVersion = verRow.max_ver + 1;

      const nowMs = this.clock.now();
      const newId = ulid(nowMs);
      const maxSeqRow = this.db
        .query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events")
        .get() as { max_seq: number };
      const nextSeq = maxSeqRow.max_seq + 1;

      this.db
        .query(
          `INSERT INTO events (
            id, seq, session_id, turn_id, client_message_id,
            group_id, version, status, role, kind,
            source, fonds, activity, content, thinking, metadata, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'user', ?, 'live', '', ?, ?, NULL, ?, ?)`,
        )
        .run(
          newId,
          nextSeq,
          target.session_id,
          opts.newTurnId,
          opts.clientMessageId ?? null,
          groupId,
          nextVersion,
          target.kind,
          target.activity,
          newContent,
          target.metadata,
          nowMs,
        );
      const inserted = this.db.query("SELECT * FROM events WHERE id = ?").get(newId) as EventRow;
      return {
        ok: true as const,
        event: mapRow(inserted),
        groupId,
        discardedAssistantIds,
      };
    });
    return tx();
  }

  /**
   * 静默重摇助手回复（Spec 04 §4）：
   * - 目标须为 role='assistant' AND status='active'，且门处于 open/quiet；
   * - 原助手行置为 status='candidate'，分配/复用 groupId 与 nextVersion，返回对应用户消息供重新生成。
   */
  prepareRerollAssistantMessage(
    id: string,
    opts: { doorState: string; activeSessionId?: string },
  ):
    | {
        ok: true;
        groupId: string;
        nextVersion: number;
        userEvent: StoredEvent;
        previousAssistantEvent: StoredEvent;
      }
    | { ok: false; code: string; error: string } {
    const tx = this.db.transaction(() => {
      const target = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as EventRow | null;
      if (!target) {
        return { ok: false as const, code: "NOT_FOUND", error: "找不到这条消息" };
      }
      if (opts.activeSessionId && target.session_id !== opts.activeSessionId) {
        return {
          ok: false as const,
          code: "INVALID_REROLL_TARGET",
          error: "该回复属于已收尾的旧会话，不能再重摇",
        };
      }
      if (
        target.role !== "assistant" ||
        target.status !== "active" ||
        (target.kind !== "chat" && target.kind !== "wake")
      ) {
        return {
          ok: false as const,
          code: "INVALID_REROLL_TARGET",
          error: "仅允许重摇当前活跃的助手回复",
        };
      }
      if (opts.doorState !== "open" && opts.doorState !== "quiet") {
        return {
          ok: false as const,
          code: "DOOR_CLOSED",
          error: "门正关着，暂不允许重摇回复",
        };
      }

      const meta = target.metadata ? (JSON.parse(target.metadata) as Record<string, unknown>) : {};
      let userRow: EventRow | null = null;
      if (typeof meta.inReplyTo === "string" && meta.inReplyTo) {
        userRow = this.db
          .query("SELECT * FROM events WHERE id = ? AND role = 'user' AND status = 'active'")
          .get(meta.inReplyTo) as EventRow | null;
      }
      if (!userRow) {
        userRow = this.db
          .query(
            `SELECT * FROM events
             WHERE session_id = ? AND role = 'user' AND status = 'active' AND seq < ?
             ORDER BY seq DESC
             LIMIT 1`,
          )
          .get(target.session_id, target.seq) as EventRow | null;
      }
      if (!userRow) {
        return {
          ok: false as const,
          code: "INVALID_REROLL_TARGET",
          error: "找不到对应的上一条用户消息，无法重摇",
        };
      }

      const groupId = target.group_id ?? target.id;
      this.db
        .query("UPDATE events SET group_id = ?, status = 'candidate' WHERE id = ?")
        .run(groupId, target.id);

      const verRow = this.db
        .query("SELECT COALESCE(MAX(version), 0) AS max_ver FROM events WHERE group_id = ?")
        .get(groupId) as { max_ver: number };
      const nextVersion = verRow.max_ver + 1;

      const prevUpdated = this.db
        .query("SELECT * FROM events WHERE id = ?")
        .get(target.id) as EventRow;
      return {
        ok: true as const,
        groupId,
        nextVersion,
        userEvent: mapRow(userRow),
        previousAssistantEvent: mapRow(prevUpdated),
      };
    });
    return tx();
  }

  /** 若 Reroll 生成失败或空中断，将原 candidate 助手回复恢复为 active，避免时间线丢消息 */
  restoreAssistantCandidate(previousId: string): void {
    this.db
      .query("UPDATE events SET status = 'active' WHERE id = ? AND status = 'candidate'")
      .run(previousId);
  }

  /**
   * 切换助手版本组（Spec 04 §4）：
   * 仅允许在同 group_id 的 candidate 助手版本间切换；Edit 弃用的 discarded 与 deleted 一律拒返 409。
   */
  switchVersion(
    messageId: string,
    targetVersion: number,
  ):
    | { ok: true; activated: StoredEvent; groupId: string }
    | { ok: false; code: string; error: string } {
    const tx = this.db.transaction(() => {
      const anchor = this.db
        .query("SELECT * FROM events WHERE id = ?")
        .get(messageId) as EventRow | null;
      if (!anchor) {
        return { ok: false as const, code: "NOT_FOUND", error: "找不到这条消息" };
      }
      if (!anchor.group_id || anchor.role !== "assistant") {
        return {
          ok: false as const,
          code: "INVALID_VERSION_TARGET",
          error: "该消息不存在可切换的历史版本组",
        };
      }

      const target = this.db
        .query(
          `SELECT * FROM events
           WHERE group_id = ? AND version = ? AND role = 'assistant'
           LIMIT 1`,
        )
        .get(anchor.group_id, targetVersion) as EventRow | null;
      if (!target || target.status !== "candidate") {
        return {
          ok: false as const,
          code: "INVALID_VERSION_TARGET",
          error: "目标版本不存在或不允许切换",
        };
      }

      this.db
        .query(
          `UPDATE events SET status = 'candidate'
           WHERE group_id = ? AND role = 'assistant' AND status = 'active'`,
        )
        .run(anchor.group_id);
      this.db.query("UPDATE events SET status = 'active' WHERE id = ?").run(target.id);

      const activated = this.db
        .query("SELECT * FROM events WHERE id = ?")
        .get(target.id) as EventRow;
      return {
        ok: true as const,
        activated: mapRow(activated),
        groupId: anchor.group_id,
      };
    });
    return tx();
  }

  /** 汇总每个上锁抽屉条目的最近拆封时间戳（供 GET /api/v1/drawer 标注 peeked） */
  getDrawerPeekStats(): Map<string, number> {
    const rows = this.db
      .query(
        `SELECT metadata, created_at FROM events
         WHERE kind = 'privacy.peeked' AND metadata IS NOT NULL
         ORDER BY seq ASC`,
      )
      .all() as Array<{ metadata: string | null; created_at: number }>;
    const map = new Map<string, number>();
    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const meta = JSON.parse(row.metadata) as { drawerId?: unknown };
        if (typeof meta.drawerId === "string" && meta.drawerId) {
          map.set(meta.drawerId, row.created_at);
        }
      } catch {
        // 忽略损坏 JSON
      }
    }
    return map;
  }

  /** 查询尚未经 events_notice 游标告知Psyber的系统事实事件（privacy.peeked / share.opened / request.decided） */
  listUnnoticedEvents(limit = 20): StoredEvent[] {
    const cursor = this.getCursor("events_notice") ?? "";
    const rows = this.db
      .query(
        `SELECT * FROM events
         WHERE kind IN ('privacy.peeked', 'share.opened', 'request.decided')
           AND status = 'active'
           AND id > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(cursor, Math.max(1, limit)) as EventRow[];
    return rows.map(mapRow);
  }

  /** 汇总 Token 消耗、Prompt Cache 命中率与预估费用（GET /api/v1/usage/stats，绝不常驻主聊天面） */
  getUsageStats(
    timeZone: string,
    opts?: { days?: number },
  ): {
    today: UsageBucket;
    total: UsageBucket;
    range: UsageBucket;
    rangeDays: number | null;
    daily: Array<{ date: string } & UsageBucket>;
    byModel: Array<{ model: string } & UsageBucket>;
  } {
    const rows = this.db
      .query(
        `SELECT metadata, created_at FROM events
         WHERE role = 'assistant'
           AND metadata IS NOT NULL
           AND metadata LIKE '%"usage"%'
         ORDER BY seq ASC`,
      )
      .all() as Array<{ metadata: string | null; created_at: number }>;

    const nowMs = this.clock.now();
    const todayKey = localDay(nowMs, timeZone);
    const rangeDays =
      opts?.days !== undefined && Number.isFinite(opts.days) && opts.days >= 1
        ? Math.min(365, Math.floor(opts.days))
        : null;
    const cutoffMs =
      rangeDays !== null
        ? rangeDays === 1
          ? null
          : nowMs - (rangeDays - 1) * 24 * 60 * 60 * 1000
        : null;
    const cutoffDayKey =
      rangeDays === 1
        ? todayKey
        : cutoffMs !== null
          ? localDay(cutoffMs, timeZone)
          : null;

    const makeAcc = () => ({
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
    });
    const totalAcc = makeAcc();
    const todayAcc = makeAcc();
    const rangeAcc = makeAcc();
    const dailyMap = new Map<string, ReturnType<typeof makeAcc>>();
    const modelMap = new Map<string, ReturnType<typeof makeAcc>>();

    const addTo = (
      acc: ReturnType<typeof makeAcc>,
      u: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        estimatedCostUsd: number;
      },
    ) => {
      acc.turnCount += 1;
      acc.inputTokens += u.inputTokens;
      acc.outputTokens += u.outputTokens;
      acc.cacheReadTokens += u.cacheReadTokens;
      acc.cacheWriteTokens += u.cacheWriteTokens;
      acc.estimatedCostUsd += u.estimatedCostUsd;
    };

    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const meta = JSON.parse(row.metadata) as {
          model?: unknown;
          usage?: {
            model?: unknown;
            inputTokens?: unknown;
            outputTokens?: unknown;
            cacheReadTokens?: unknown;
            cacheWriteTokens?: unknown;
            estimatedCostUsd?: unknown;
          };
        };
        const u = meta.usage;
        if (!u || typeof u !== "object") continue;
        const parsed = {
          inputTokens:
            typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens) ? u.inputTokens : 0,
          outputTokens:
            typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens)
              ? u.outputTokens
              : 0,
          cacheReadTokens:
            typeof u.cacheReadTokens === "number" && Number.isFinite(u.cacheReadTokens)
              ? u.cacheReadTokens
              : 0,
          cacheWriteTokens:
            typeof u.cacheWriteTokens === "number" && Number.isFinite(u.cacheWriteTokens)
              ? u.cacheWriteTokens
              : 0,
          estimatedCostUsd:
            typeof u.estimatedCostUsd === "number" && Number.isFinite(u.estimatedCostUsd)
              ? u.estimatedCostUsd
              : 0,
        };
        const modelName =
          typeof u.model === "string" && u.model.trim()
            ? u.model.trim()
            : typeof meta.model === "string" && meta.model.trim()
              ? meta.model.trim()
              : "unknown";
        const dayKey = localDay(row.created_at, timeZone);

        addTo(totalAcc, parsed);
        if (dayKey === todayKey) addTo(todayAcc, parsed);

        const inRange = cutoffDayKey === null || dayKey >= cutoffDayKey;
        if (!inRange) continue;

        addTo(rangeAcc, parsed);

        let dAcc = dailyMap.get(dayKey);
        if (!dAcc) {
          dAcc = makeAcc();
          dailyMap.set(dayKey, dAcc);
        }
        addTo(dAcc, parsed);

        let mAcc = modelMap.get(modelName);
        if (!mAcc) {
          mAcc = makeAcc();
          modelMap.set(modelName, mAcc);
        }
        addTo(mAcc, parsed);
      } catch {
        // 忽略损坏 JSON
      }
    }

    const finalize = (acc: ReturnType<typeof makeAcc>): UsageBucket => {
      const denom = acc.inputTokens + acc.cacheReadTokens;
      const cacheHitRate = denom > 0 ? Number((acc.cacheReadTokens / denom).toFixed(4)) : 0;
      return {
        turnCount: acc.turnCount,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens,
        cacheHitRate,
        estimatedCostUsd: Number(acc.estimatedCostUsd.toFixed(6)),
      };
    };

    const dailyLimit = rangeDays !== null ? Math.min(90, rangeDays) : 30;
    const daily = Array.from(dailyMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, dailyLimit)
      .map(([date, acc]) => ({ date, ...finalize(acc) }));

    const byModel = Array.from(modelMap.entries())
      .map(([model, acc]) => ({ model, ...finalize(acc) }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.inputTokens - a.inputTokens);

    return {
      today: finalize(todayAcc),
      total: finalize(totalAcc),
      range: finalize(rangeAcc),
      rangeDays,
      daily,
      byModel,
    };
  }
}

export interface UsageBucket {
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  estimatedCostUsd: number;
}
