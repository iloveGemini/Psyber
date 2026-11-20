import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Clock } from "../core/clock.ts";
import type { PsyberConfig } from "../core/config.ts";
import type { MediaStore } from "../core/media.ts";
import { ulid } from "../core/ulid.ts";
import type { DirectEngine } from "../engine/direct.ts";
import { formatSseFrame, type SseHub } from "../engine/sse.ts";
import type { MemoryIndex } from "../memory/index.ts";
import { getTurnRecallTraces, saveRecallFeedback } from "../memory/recall.ts";
import type { EventStore, StoredEvent } from "../store/events.ts";
import { registerAdminRoutes } from "./admin_routes.ts";
import type { PairingManager } from "./pairing.ts";

const VALID_ULID_OR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 对 Bearer Token 做 SHA-256 哈希，确保 config.json 绝不存明文令牌 */
export function hashBearerToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function toTimelineItem(ev: StoredEvent, events: EventStore) {
  const stickerId =
    ev.metadata && typeof ev.metadata.stickerId === "string" ? ev.metadata.stickerId : null;
  const stickerRec = stickerId ? events.getSticker(stickerId) : null;
  const recallCount =
    ev.metadata && typeof ev.metadata.recallCount === "number" ? ev.metadata.recallCount : undefined;

  return {
    ...ev,
    versionCount: 1,
    ...(recallCount !== undefined ? { recallCount } : {}),
    ...(stickerRec
      ? {
          sticker: {
            id: stickerRec.id,
            label: stickerRec.label,
            url: `/api/v1/media/${stickerRec.mediaHash}`,
          },
        }
      : {}),
  };
}

export interface AppDeps {
  version: string;
  clock: Clock;
  getConfig: () => PsyberConfig;
  events: EventStore;
  getActiveSessionId: () => string;
  dataDir?: string;
  db?: Database;
  memoryIndex?: MemoryIndex;
  sse?: SseHub;
  engine?: DirectEngine;
  pairing?: PairingManager;
  media?: MediaStore;
  /** 用户新消息（chat / door_note）落盘时回调，用于立即重置 consecutiveUnansweredWakes = 0 */
  onUserMessagePersisted?: () => void;
  /** 设置变更（PATCH /api/v1/settings）后回调，用于热更新作息心跳定时器 */
  onSettingsUpdated?: () => void;
  /** 仅在明确部署于可信反向代理后时才信任 x-forwarded-for */
  trustProxy?: boolean;
  /** 自定义获取客户端连接 IP（用于 /auth/pair 防爆破限流） */
  getClientIp?: (req: Request) => string;
}

/**
 * 创建 Ring 1 极简 Hono HTTP + SSE 应用：
 * - /api/v1/health 免鉴权非阻塞探活
 * - 其余业务端点统一校验 Bearer Token 哈希（SSE / media 兼容 ?token=）
 * - 聊天、门状态、召回评测与 SSE 路由在本文件注册；配对、创世、媒体与设置委托给 admin_routes.ts
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const activeAborts = new Map<string, AbortController>();

  // 非阻塞探活（免鉴权、不扫磁盘、不调外部网络）
  app.get("/api/v1/health", (c) => {
    const cfg = deps.getConfig();
    return c.json({
      ok: true,
      version: deps.version,
      instanceId: cfg.instanceId,
      serverTimeMs: deps.clock.now(),
    });
  });

  // 业务路由统一 Bearer Token 鉴权中间件
  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/health" || c.req.path === "/api/v1/auth/pair") {
      return next();
    }
    const authHeader = c.req.header("authorization") ?? "";
    let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token && (c.req.path === "/api/v1/stream" || c.req.path.startsWith("/api/v1/media/"))) {
      token = c.req.query("token") ?? "";
    }
    if (!token) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "缺少访问令牌" } }, 401);
    }

    const tokenHash = hashBearerToken(token);
    const devices = deps.getConfig().auth?.devices ?? [];
    const matched = devices.find((d) => d.tokenHash === tokenHash);
    if (!matched) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "访问令牌无效或已吊销" } }, 401);
    }
    matched.lastSeenAt = deps.clock.now();
    return next();
  });

  registerAdminRoutes(app, deps);

  app.get("/api/v1/door", (c) => {
    const cfg = deps.getConfig();
    const unreadDoorNotes = deps.events.countUnreadDoorNotes();
    return c.json({
      state: cfg.door.state,
      note: cfg.door.note,
      updatedAt: cfg.door.updatedAt,
      unreadDoorNotes,
    });
  });

  app.get("/api/v1/chat/history", (c) => {
    const beforeId = c.req.query("before") ?? undefined;
    const rawLimit = c.req.query("limit");
    const limit = rawLimit ? Number(rawLimit) : 50;
    const page = deps.events.listHistory({
      beforeId,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({
      ...page,
      items: page.items.map((ev) => toTimelineItem(ev, deps.events)),
    });
  });

  app.post("/api/v1/chat/messages", async (c) => {
    let body: {
      clientMessageId?: string;
      content?: string;
      activityHint?: string;
      attachments?: unknown;
      stickerId?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }

    const content = typeof body.content === "string" ? body.content : "";
    if (
      body.attachments !== undefined &&
      (!Array.isArray(body.attachments) ||
        body.attachments.some((a) => typeof a !== "string" || !a.trim()))
    ) {
      return c.json(
        { error: { code: "INVALID_ATTACHMENTS", message: "attachments 必须为非空字符串数组" } },
        400,
      );
    }
    const attachments = Array.isArray(body.attachments) ? (body.attachments as string[]) : [];
    const hasAttachments = attachments.length > 0;
    const stickerId = typeof body.stickerId === "string" ? body.stickerId.trim() : "";
    const hasSticker = stickerId.length > 0;

    if (!content.trim() && !hasAttachments && !hasSticker) {
      return c.json(
        { error: { code: "EMPTY_MESSAGE", message: "消息内容、图片或贴纸不能同时为空" } },
        400,
      );
    }

    if (hasSticker) {
      const sticker = deps.events.getSticker(stickerId);
      if (!sticker) {
        return c.json({ error: { code: "INVALID_STICKER", message: `未知贴纸 ID: ${stickerId}` } }, 400);
      }
      deps.events.incrementStickerUsage(stickerId);
    }

    const cfg = deps.getConfig();
    const isClosed = cfg.door.state === "closed";
    const kind = isClosed ? "door_note" : "chat";
    const turnId = isClosed ? null : ulid(deps.clock.now());

    const metadata: Record<string, unknown> = {};
    if (hasAttachments) metadata.attachments = attachments;
    if (hasSticker) metadata.stickerId = stickerId;

    const { event, deduplicated } = deps.events.append({
      sessionId: deps.getActiveSessionId(),
      turnId,
      clientMessageId: body.clientMessageId ?? null,
      role: "user",
      kind,
      content,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    });

    const timelineItem = toTimelineItem(event, deps.events);

    if (!deduplicated) {
      // 对齐 Spec 04 §2.2：新消息（含门缝纸条）落盘时立即重置连续未回唤醒计数
      deps.onUserMessagePersisted?.();
      deps.sse?.emit("message.created", { message: timelineItem });
      if (!isClosed && deps.engine && event.turnId) {
        const ac = new AbortController();
        const activeTurnId = event.turnId;
        activeAborts.set(activeTurnId, ac);
        void deps.engine
          .runTurn({
            mode: "chat",
            userText: event.content,
            userEventId: event.id,
            activityHint: typeof body.activityHint === "string" ? body.activityHint : undefined,
            turnId: activeTurnId,
            signal: ac.signal,
            callbacks: {
              onTurnStart: (info) => deps.sse?.emit("turn.start", info),
              onThinkingDelta: (delta) => deps.sse?.emit("turn.thinking", { turnId: activeTurnId, delta }),
              onTextDelta: (delta) => deps.sse?.emit("turn.text", { turnId: activeTurnId, delta }),
              onExpression: (payload) => deps.sse?.emit("turn.expression", { turnId: activeTurnId, ...payload }),
              onDoorUpdated: (state, note) =>
                deps.sse?.emit("door.updated", { state, note, updatedAt: deps.clock.now() }),
              onTurnDone: (info) => deps.sse?.emit("turn.done", info),
              onTurnError: (err) => deps.sse?.emit("turn.error", err),
            },
          })
          .finally(() => {
            activeAborts.delete(activeTurnId);
          });
      }
    }

    return c.json(
      {
        message: timelineItem,
        deliveredAs: isClosed ? "door_note" : "chat",
        turnId: event.turnId,
      },
      202,
    );
  });

  app.delete("/api/v1/chat/messages/:id", (c) => {
    const id = c.req.param("id");
    if (!VALID_ULID_OR_ID_RE.test(id)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法消息 ID" } }, 400);
    }
    const res = deps.events.softDelete(id);
    if (!res.deleted) {
      return c.json({ error: { code: "NOT_FOUND", message: "消息不存在或已删除" } }, 404);
    }
    deps.sse?.emit("message.updated", { action: "delete", deletedId: id });
    return c.json({ deletedId: id, eventSeq: res.eventSeq });
  });

  app.post("/api/v1/turns/:turnId/abort", (c) => {
    const turnId = c.req.param("turnId");
    if (!VALID_ULID_OR_ID_RE.test(turnId)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法 turnId" } }, 400);
    }
    const ac = activeAborts.get(turnId);
    if (ac) {
      ac.abort();
      return c.json({ ok: true, turnId, aborted: true });
    }
    return c.json({ ok: true, turnId, aborted: false });
  });

  app.get("/api/v1/turns/:turnId/recall", (c) => {
    const turnId = c.req.param("turnId");
    if (!VALID_ULID_OR_ID_RE.test(turnId)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法 turnId" } }, 400);
    }
    if (!deps.db) {
      return c.json({ turnId, items: [] });
    }
    return c.json({
      turnId,
      items: getTurnRecallTraces(deps.db, turnId),
    });
  });

  app.post("/api/v1/recall/feedback", async (c) => {
    if (!deps.db) {
      return c.json({ error: { code: "NOT_READY", message: "数据库未就绪" } }, 503);
    }
    let body: { turnId?: string; cardPath?: string; verdict?: string; note?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    if (!body.turnId || !body.verdict || !["useful", "noisy", "missed"].includes(body.verdict)) {
      return c.json({ error: { code: "INVALID_FEEDBACK", message: "缺少合法 turnId 或 verdict" } }, 400);
    }
    if ((body.verdict === "useful" || body.verdict === "noisy") && !body.cardPath) {
      return c.json({ error: { code: "MISSING_CARD_PATH", message: "useful/noisy 标注必填 cardPath" } }, 400);
    }
    const id = saveRecallFeedback(deps.db, {
      turnId: body.turnId,
      cardPath: body.cardPath,
      verdict: body.verdict as "useful" | "noisy" | "missed",
      note: body.note,
      nowMs: deps.clock.now(),
    });
    return c.json({ id, ok: true });
  });

  app.get("/api/v1/stream", (c) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // 连接已关闭
          }
        };

        const foreground = c.req.query("foreground") !== "false";
        send(formatSseFrame({ event: "ping", data: { ts: deps.clock.now() } }));
        const unsubscribe = deps.sse?.subscribe(
          (frame) => {
            send(formatSseFrame(frame));
          },
          { foreground },
        );
        const timer = setInterval(() => {
          send(formatSseFrame({ event: "ping", data: { ts: deps.clock.now() } }));
        }, 25_000);

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(timer);
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            // 已关闭
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  return app;
}
