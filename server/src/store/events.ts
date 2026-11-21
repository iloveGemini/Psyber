import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";
import { ulid } from "../core/ulid.ts";

export type EventRole = "user" | "assistant" | "system" | "task";
export type EventKind =
  | "chat"
  | "door_note"
  | "wake"
  | "memory_task"
  | "activity_event"
  | "door.updated"
  | "share.opened";
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
  role: EventRole;
  kind: EventKind;
  activity?: string | null;
  content: string;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
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
          ) VALUES (?, ?, ?, ?, ?, NULL, 1, 'active', ?, ?, 'live', '', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          nextSeq,
          input.sessionId,
          input.turnId ?? null,
          input.clientMessageId ?? null,
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
   * 保留原文在数据库列中以实现不对称可见性（用户撤回对住户隐藏，住户撤回仅对前端隐藏）。
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
   * 按精准原文子串查找住户可撤回的活跃消息（防止模型幻觉乱撤）：
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
         WHERE kind = 'door_note' AND status = 'active' AND id > ?`,
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
         WHERE kind = 'door_note' AND status = 'active' AND id > ?
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

  /** 查询指定会话最近 N 条活跃或已撤回对话消息（按 seq ASC 返回，用于换段保留最近 6 轮过渡） */
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
         WHERE kind = 'door_note' AND status = 'active' AND id > ?
         ORDER BY seq ASC
         LIMIT 1`,
      )
      .get(cursor) as { created_at: number } | null;
    return row ? row.created_at : null;
  }

  /**
   * 标记住户主动分享卡首次被用户点开拆阅（幂等保留首次 openedAt，并写入 share.opened 系统事件）。
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
        content: `对方点开看了你分享的《${result.title}》`,
        metadata: {
          shareId: result.shareId,
          title: result.title,
          openedAt: result.openedAt,
        },
      });
    }
    return result;
  }

  /** 列举近期住户递出的分享卡及拆阅状态（供 <runtime_context> 客观回执给住户） */
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
}
