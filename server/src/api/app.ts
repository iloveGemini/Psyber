import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Clock } from "../core/clock.ts";
import type { PsyberConfig } from "../core/config.ts";
import type { MediaStore } from "../core/media.ts";
import { ulid } from "../core/ulid.ts";
import type { DirectEngine, TurnCheckpoint } from "../engine/direct.ts";
import { formatSseFrame, type SseHub } from "../engine/sse.ts";
import type { McpManager } from "../extensions/mcp.ts";
import type { ChatModelClient } from "../llm/client.ts";
import type { ResolvedByokSlot } from "../llm/router.ts";
import { isValidDrawerId, type DrawerStore } from "../memory/drawer.ts";
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
  const meta = ev.metadata ?? {};
  if (ev.status === "retracted") {
    const retractedBy =
      meta.retractedBy === "user" || meta.retractedBy === "resident"
        ? meta.retractedBy
        : ev.role === "user"
          ? "user"
          : "resident";
    return {
      ...ev,
      content: "",
      thinking: null,
      metadata: { retractedBy, retractedAt: meta.retractedAt ?? ev.createdAt },
      versionCount: 1,
      retracted: true,
      retractedBy,
    };
  }

  let stickerId = typeof meta.stickerId === "string" ? meta.stickerId : null;
  let exprSticker: { id: string; label: string; url: string } | null = null;
  if (!stickerId && Array.isArray(meta.expressions)) {
    for (let i = meta.expressions.length - 1; i >= 0; i--) {
      const expr = meta.expressions[i];
      if (!expr || typeof expr !== "object") continue;
      const rec = expr as Record<string, unknown>;
      if (typeof rec.stickerId === "string" && rec.stickerId.trim()) {
        stickerId = rec.stickerId.trim();
      }
      if (rec.sticker && typeof rec.sticker === "object") {
        const st = rec.sticker as Record<string, unknown>;
        if (
          typeof st.id === "string" &&
          typeof st.label === "string" &&
          typeof st.url === "string"
        ) {
          exprSticker = { id: st.id, label: st.label, url: st.url };
        }
      }
      if (stickerId || exprSticker) break;
    }
  }
  const stickerRec = stickerId ? events.getSticker(stickerId) : null;
  const resolvedSticker = stickerRec
    ? {
        id: stickerRec.id,
        label: stickerRec.label,
        url: `/api/v1/media/${stickerRec.mediaHash}`,
      }
    : exprSticker;
  const recallCount = typeof meta.recallCount === "number" ? meta.recallCount : undefined;
  const toolSummary = Array.isArray(meta.toolSummary) ? meta.toolSummary : undefined;
  const model = typeof meta.model === "string" ? meta.model : undefined;
  const usage = meta.usage && typeof meta.usage === "object" ? meta.usage : undefined;
  const videoClip =
    meta.videoClip && typeof meta.videoClip === "object" ? meta.videoClip : undefined;
  const urgent = meta.urgent === true ? true : undefined;
  const shares = Array.isArray(meta.shares) ? meta.shares : undefined;

  const versionCount = ev.role === "assistant" && ev.groupId ? events.countGroupVersions(ev.groupId) : 1;

  return {
    ...ev,
    versionCount,
    ...(recallCount !== undefined ? { recallCount } : {}),
    ...(toolSummary !== undefined ? { toolSummary } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(videoClip !== undefined ? { videoClip } : {}),
    ...(urgent ? { urgent: true } : {}),
    ...(shares !== undefined ? { shares } : {}),
    ...(resolvedSticker ? { sticker: resolvedSticker } : {}),
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
  drawer?: DrawerStore;
  sse?: SseHub;
  engine?: DirectEngine;
  pairing?: PairingManager;
  media?: MediaStore;
  mcp?: McpManager;
  /** 同步高风险工具审批超时（毫秒，默认 120_000） */
  approvalTimeoutMs?: number;
  /** 用户新消息（chat / door_note）落盘时回调，用于立即重置 consecutiveUnansweredWakes = 0 */
  onUserMessagePersisted?: () => void;
  /** 设置变更（PATCH /api/v1/settings）后回调，用于热更新作息心跳定时器 */
  onSettingsUpdated?: () => void;
  /** 仅在明确部署于可信反向代理后时才信任 x-forwarded-for */
  trustProxy?: boolean;
  /** 自定义获取客户端连接 IP（用于 /auth/pair 防爆破限流） */
  getClientIp?: (req: Request) => string;
  /** 可注入 fetch 实现（用于 /llm/models 离线测试） */
  fetchImpl?: typeof fetch;
  /** 可注入 LLM 探测工厂（用于 /llm/test 离线测试） */
  llmTestClientFactory?: (resolved: ResolvedByokSlot) => ChatModelClient;
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
  const retryOrigins = new Map<
    string,
    { userEventId: string; activityHint?: string; checkpoint?: TurnCheckpoint }
  >();
  const sessionApprovedTools = new Set<string>();
  const pendingApprovals = new Map<
    string,
    {
      turnId: string;
      toolName: string;
      resolve: (res: { decision: "allow" | "deny"; scope?: "once" | "session"; reason?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const dispatchChatTurn = (opts: {
    turnId: string;
    userEvent: StoredEvent;
    stickerId?: string;
    attachments?: string[];
    videoClip?: { durationSec: number; frameHashes: string[] };
    urgent?: boolean;
    activityHint?: string;
    groupId?: string;
    version?: number;
    historyBeforeSeq?: number;
    restoreCandidateIdOnFailure?: string;
    resumeCheckpoint?: TurnCheckpoint;
  }) => {
    if (!deps.engine) return;
    const ac = new AbortController();
    const activeTurnId = opts.turnId;
    activeAborts.set(activeTurnId, ac);
    let persistedInTurn = false;
    void deps.engine
      .runTurn({
        mode: "chat",
        userText: opts.userEvent.content,
        userEventId: opts.userEvent.id,
        stickerId: opts.stickerId,
        attachments: opts.attachments,
        videoClip: opts.videoClip,
        urgent: opts.urgent,
        activityHint: opts.activityHint,
        turnId: activeTurnId,
        groupId: opts.groupId,
        version: opts.version,
        historyBeforeSeq: opts.historyBeforeSeq,
        resumeCheckpoint: opts.resumeCheckpoint,
        signal: ac.signal,
        callbacks: {
          onTurnStart: (info) => deps.sse?.emit("turn.start", info),
          onThinkingDelta: (delta) =>
            deps.sse?.emit("turn.thinking", { turnId: activeTurnId, delta }),
          onToolProgress: (info) => deps.sse?.emit("turn.tool", { ...info }),
          onTextDelta: (delta) => deps.sse?.emit("turn.text", { turnId: activeTurnId, delta }),
          onExpression: (payload) =>
            deps.sse?.emit("turn.expression", { turnId: activeTurnId, ...payload }),
          onDoorUpdated: (state, note) =>
            deps.sse?.emit("door.updated", { state, note, updatedAt: deps.clock.now() }),
          onMessageRetracted: (ev) =>
            deps.sse?.emit("message.updated", {
              action: "retract",
              retractedId: ev.id,
              message: toTimelineItem(ev, deps.events),
            }),
          onAssistantPersisted: (ev) => {
            persistedInTurn = true;
            const item = toTimelineItem(ev, deps.events);
            if (opts.groupId) {
              deps.sse?.emit("message.updated", {
                action: "version",
                groupId: opts.groupId,
                message: item,
              });
            } else {
              deps.sse?.emit("message.created", { message: item });
            }
          },
          onModelSwitched: (info) => deps.sse?.emit("turn.model_switched", info),
          onRequestApproval: (req) => {
            if (sessionApprovedTools.has(req.toolName)) {
              return Promise.resolve({ decision: "allow", scope: "session" });
            }
            const approvalId = ulid(deps.clock.now());
            const timeoutMs = deps.approvalTimeoutMs ?? 120_000;
            const expiresAt = deps.clock.now() + timeoutMs;
            return new Promise((resolve) => {
              const finish = (res: {
                decision: "allow" | "deny";
                scope?: "once" | "session";
                reason?: string;
              }) => {
                const entry = pendingApprovals.get(approvalId);
                if (!entry) return;
                clearTimeout(entry.timer);
                pendingApprovals.delete(approvalId);
                resolve(res);
              };
              const timer = setTimeout(() => {
                deps.sse?.emit("turn.approval_resolved", {
                  approvalId,
                  turnId: req.turnId,
                  decision: "deny",
                  reason: "审批超时未响应",
                });
                finish({ decision: "deny", reason: "工具调用审批超时（120s），已自动拒绝" });
              }, timeoutMs);
              pendingApprovals.set(approvalId, {
                turnId: req.turnId,
                toolName: req.toolName,
                resolve: finish,
                timer,
              });
              ac.signal.addEventListener(
                "abort",
                () => {
                  finish({ decision: "deny", reason: "当前轮次已中止" });
                },
                { once: true },
              );
              deps.sse?.emit("turn.approval_required", {
                approvalId,
                turnId: req.turnId,
                toolName: req.toolName,
                summary: req.summary,
                arguments: req.arguments,
                expiresAt,
              });
            });
          },
          onTurnSilence: (info) => deps.sse?.emit("turn.silence", info),
          onTurnDone: (info) => {
            retryOrigins.delete(activeTurnId);
            deps.sse?.emit("turn.done", info);
          },
          onTurnError: (err) => deps.sse?.emit("turn.error", err),
        },
      })
      .then((result) => {
        if (result.error && result.checkpoint) {
          const origin = retryOrigins.get(activeTurnId);
          if (origin) {
            origin.checkpoint = result.checkpoint;
          }
        }
      })
      .catch((err) => {
        console.error("[psyber] Chat turn failed unexpectedly:", err);
        deps.sse?.emit("turn.error", {
          turnId: activeTurnId,
          code: "PROVIDER_ERROR",
          message: err instanceof Error ? err.message || "生成回复时发生意外异常" : "生成回复时发生意外异常",
          retryable: true,
        });
      })
      .finally(() => {
        activeAborts.delete(activeTurnId);
        if (!persistedInTurn && opts.restoreCandidateIdOnFailure) {
          deps.events.restoreAssistantCandidate(opts.restoreCandidateIdOnFailure);
        }
      });
  };

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
    const contextUsage = deps.engine?.getContextUsage();
    const activeTurnId = activeAborts.keys().next().value ?? null;
    return c.json({
      ...page,
      items: page.items.map((ev) => toTimelineItem(ev, deps.events)),
      activeTurnId,
      ...(contextUsage ? { contextUsage } : {}),
    });
  });

  app.post("/api/v1/chat/messages", async (c) => {
    let body: {
      clientMessageId?: string;
      content?: string;
      activityHint?: string;
      attachments?: unknown;
      stickerId?: string;
      videoClip?: unknown;
      urgent?: boolean;
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
    const urgentRequested = body.urgent === true;

    let videoClip: { durationSec: number; frameHashes: string[] } | undefined;
    if (body.videoClip && typeof body.videoClip === "object" && !Array.isArray(body.videoClip)) {
      const vc = body.videoClip as { durationSec?: unknown; frameHashes?: unknown };
      if (
        typeof vc.durationSec === "number" &&
        Number.isFinite(vc.durationSec) &&
        Array.isArray(vc.frameHashes) &&
        vc.frameHashes.every((h) => typeof h === "string" && h.trim().length > 0)
      ) {
        videoClip = {
          durationSec: vc.durationSec,
          frameHashes: vc.frameHashes as string[],
        };
      }
    }

    if (!content.trim() && !hasAttachments && !hasSticker) {
      return c.json(
        { error: { code: "EMPTY_MESSAGE", message: "消息内容、图片或贴纸不能同时为空" } },
        400,
      );
    }

    const cfg = deps.getConfig();
    const doorState = cfg.door.state as string;
    if (doorState === "departed") {
      return c.json(
        { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } },
        410,
      );
    }
    if (doorState === "cooling_off" && urgentRequested) {
      return c.json(
        { error: { code: "DOOR_COOLING_OFF", message: "冷静期期间严禁紧急打扰，请先写门缝纸条" } },
        409,
      );
    }

    if (hasSticker) {
      const sticker = deps.events.getSticker(stickerId);
      if (!sticker) {
        return c.json({ error: { code: "INVALID_STICKER", message: `未知贴纸 ID: ${stickerId}` } }, 400);
      }
      deps.events.incrementStickerUsage(stickerId);
    }

    const isUrgentBypass = doorState === "closed" && urgentRequested;
    const deliverAsDoorNote =
      (doorState === "closed" && !isUrgentBypass) || doorState === "cooling_off";
    const kind = deliverAsDoorNote ? "door_note" : "chat";
    const turnId = deliverAsDoorNote ? null : ulid(deps.clock.now());

    const metadata: Record<string, unknown> = {};
    if (hasAttachments) metadata.attachments = attachments;
    if (hasSticker) metadata.stickerId = stickerId;
    if (videoClip) metadata.videoClip = videoClip;
    if (isUrgentBypass) metadata.urgent = true;

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
      if (!deliverAsDoorNote && deps.engine && event.turnId) {
        for (const entry of retryOrigins.values()) {
          entry.checkpoint = undefined;
        }
        const activityHint = typeof body.activityHint === "string" ? body.activityHint : undefined;
        retryOrigins.set(event.turnId, { userEventId: event.id, activityHint });
        dispatchChatTurn({
          turnId: event.turnId,
          userEvent: event,
          stickerId: hasSticker ? stickerId : undefined,
          attachments: hasAttachments ? attachments : undefined,
          videoClip,
          urgent: isUrgentBypass || undefined,
          activityHint,
        });
      }
    }

    return c.json(
      {
        message: timelineItem,
        deliveredAs: deliverAsDoorNote ? "door_note" : "chat",
        turnId: event.turnId,
      },
      202,
    );
  });

  app.post("/api/v1/chat/wrap-up", async (c) => {
    const cfg = deps.getConfig();
    if ((cfg.door.state as string) === "departed") {
      return c.json(
        { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } },
        410,
      );
    }
    if (!deps.engine) {
      return c.json({ error: { code: "ENGINE_UNAVAILABLE", message: "对话引擎尚未就绪" } }, 503);
    }
    const { oldSessionId, newSessionId } = await deps.engine.manualRollover();
    return c.json({ oldSessionId, newSessionId, queued: true }, 202);
  });

  app.post("/api/v1/turns/:turnId/retry", (c) => {
    const turnId = c.req.param("turnId");
    if (!VALID_ULID_OR_ID_RE.test(turnId)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法 turnId" } }, 400);
    }
    const cfg = deps.getConfig();
    if ((cfg.door.state as string) === "departed") {
      return c.json(
        { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } },
        410,
      );
    }
    if (cfg.door.state === "closed" || (cfg.door.state as string) === "cooling_off") {
      return c.json(
        { error: { code: "DOOR_CLOSED", message: "门正关着，暂不唤醒对方" } },
        409,
      );
    }
    if (activeAborts.has(turnId) || deps.events.hasAssistantReplyForTurn(turnId)) {
      return c.json(
        { error: { code: "TURN_NOT_RETRYABLE", message: "该轮对话已完成或正在生成中" } },
        409,
      );
    }

    const mapped = retryOrigins.get(turnId);
    const origUser = mapped
      ? deps.events.getById(mapped.userEventId)
      : deps.events.findUserEventByTurnId(turnId);
    if (!origUser || origUser.status !== "active" || origUser.role !== "user") {
      return c.json(
        { error: { code: "TURN_NOT_RETRYABLE", message: "找不到可重试的失败轮次" } },
        409,
      );
    }
    if (
      deps.events.hasAssistantReplyForTurn(origUser.turnId ?? turnId, origUser.id)
    ) {
      return c.json(
        { error: { code: "TURN_NOT_RETRYABLE", message: "该轮对话已完成，无需重试" } },
        409,
      );
    }

    const newTurnId = ulid(deps.clock.now());
    const meta = origUser.metadata ?? {};
    const attachments = Array.isArray(meta.attachments)
      ? (meta.attachments.filter((x): x is string => typeof x === "string"))
      : undefined;
    const stickerId = typeof meta.stickerId === "string" ? meta.stickerId : undefined;
    const rawVc = meta.videoClip;
    const videoClip =
      rawVc &&
      typeof rawVc === "object" &&
      !Array.isArray(rawVc) &&
      typeof (rawVc as { durationSec?: unknown }).durationSec === "number" &&
      Array.isArray((rawVc as { frameHashes?: unknown }).frameHashes)
        ? {
            durationSec: (rawVc as { durationSec: number }).durationSec,
            frameHashes: (rawVc as { frameHashes: string[] }).frameHashes,
          }
        : undefined;

    const latestItems = deps.events.listHistory({ limit: 1 }).items;
    const isLatestTimelineEvent =
      latestItems.length > 0 && latestItems[latestItems.length - 1]!.id === origUser.id;
    const resumeCheckpoint = isLatestTimelineEvent ? mapped?.checkpoint : undefined;

    retryOrigins.set(newTurnId, {
      userEventId: origUser.id,
      activityHint: mapped?.activityHint ?? origUser.activity ?? undefined,
    });
    retryOrigins.delete(turnId);

    dispatchChatTurn({
      turnId: newTurnId,
      userEvent: origUser,
      stickerId,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      videoClip,
      activityHint: mapped?.activityHint ?? origUser.activity ?? undefined,
      resumeCheckpoint,
    });

    return c.json({ turnId: newTurnId, retriedFromTurnId: turnId }, 202);
  });

  app.delete("/api/v1/chat/messages/:id", (c) => {
    const id = c.req.param("id");
    if (!VALID_ULID_OR_ID_RE.test(id)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法消息 ID" } }, 400);
    }
    const cfg = deps.getConfig();
    if ((cfg.door.state as string) === "departed") {
      return c.json(
        { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } },
        410,
      );
    }
    const res = deps.events.softDelete(id);
    if (!res.deleted) {
      return c.json({ error: { code: "NOT_FOUND", message: "消息不存在或已删除" } }, 404);
    }
    deps.sse?.emit("message.updated", { action: "delete", deletedId: id });
    return c.json({ deletedId: id, eventSeq: res.eventSeq });
  });

  app.post("/api/v1/chat/messages/:id/retract", (c) => {
    const id = c.req.param("id");
    if (!VALID_ULID_OR_ID_RE.test(id)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法消息 ID" } }, 400);
    }
    const cfg = deps.getConfig();
    if ((cfg.door.state as string) === "departed") {
      return c.json(
        { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } },
        410,
      );
    }
    if (activeAborts.size > 0) {
      return c.json(
        { error: { code: "TURN_IN_PROGRESS", message: "对方正在回复中，稍后再撤回" } },
        409,
      );
    }
    const res = deps.events.retract(id, "user");
    if (!res.ok) {
      const status = res.code === "NOT_FOUND" ? 404 : 409;
      return c.json({ error: { code: res.code, message: res.error } }, status);
    }
    const timelineItem = toTimelineItem(res.event, deps.events);
    deps.sse?.emit("message.updated", {
      action: "retract",
      retractedId: id,
      message: timelineItem,
    });
    return c.json({ retractedId: id, eventSeq: res.event.seq, message: timelineItem });
  });

  app.post("/api/v1/chat/messages/:id/edit", async (c) => {
    const id = c.req.param("id");
    if (!VALID_ULID_OR_ID_RE.test(id)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法消息 ID" } }, 400);
    }
    let body: { content?: string; clientMessageId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      return c.json({ error: { code: "EMPTY_MESSAGE", message: "编辑后的消息内容不能为空" } }, 400);
    }
    const cfg = deps.getConfig();
    const doorState = cfg.door.state as string;
    if (doorState === "departed") {
      return c.json(
        { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } },
        410,
      );
    }
    for (const ac of activeAborts.values()) {
      ac.abort();
    }

    const existing = deps.events.getById(id);
    const isDoorNote = existing?.kind === "door_note";
    const newTurnId = isDoorNote ? null : ulid(deps.clock.now());
    const res = deps.events.editLatestUserMessage(id, content, {
      doorState,
      newTurnId,
      clientMessageId: typeof body.clientMessageId === "string" ? body.clientMessageId : null,
    });
    if (!res.ok) {
      const status = res.code === "NOT_FOUND" ? 404 : 409;
      return c.json({ error: { code: res.code, message: res.error } }, status);
    }

    const timelineItem = toTimelineItem(res.event, deps.events);
    for (const discardedId of res.discardedAssistantIds) {
      deps.sse?.emit("message.updated", { action: "delete", deletedId: discardedId });
    }
    deps.sse?.emit("message.updated", {
      action: "edit",
      groupId: res.groupId,
      message: timelineItem,
    });

    if (res.event.kind === "chat" && deps.engine && res.event.turnId) {
      const meta = res.event.metadata ?? {};
      const attachments = Array.isArray(meta.attachments)
        ? meta.attachments.filter((x): x is string => typeof x === "string")
        : undefined;
      const stickerId = typeof meta.stickerId === "string" ? meta.stickerId : undefined;
      retryOrigins.set(res.event.turnId, {
        userEventId: res.event.id,
        activityHint: res.event.activity ?? undefined,
      });
      dispatchChatTurn({
        turnId: res.event.turnId,
        userEvent: res.event,
        stickerId,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        urgent: meta.urgent === true ? true : undefined,
        activityHint: res.event.activity ?? undefined,
      });
    }

    return c.json({ message: timelineItem, turnId: res.event.turnId }, 202);
  });

  app.post("/api/v1/chat/messages/:id/reroll", (c) => {
    const id = c.req.param("id");
    if (!VALID_ULID_OR_ID_RE.test(id)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法消息 ID" } }, 400);
    }
    const cfg = deps.getConfig();
    const doorState = cfg.door.state as string;
    if (doorState === "departed") {
      return c.json(
        { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } },
        410,
      );
    }
    if (activeAborts.size > 0) {
      return c.json(
        { error: { code: "TURN_IN_PROGRESS", message: "当前已有正在生成的回复，请稍后再试" } },
        409,
      );
    }
    const prep = deps.events.prepareRerollAssistantMessage(id, { doorState });
    if (!prep.ok) {
      const status = prep.code === "NOT_FOUND" ? 404 : 409;
      return c.json({ error: { code: prep.code, message: prep.error } }, status);
    }

    const newTurnId = ulid(deps.clock.now());
    const meta = prep.userEvent.metadata ?? {};
    const attachments = Array.isArray(meta.attachments)
      ? meta.attachments.filter((x): x is string => typeof x === "string")
      : undefined;
    const stickerId = typeof meta.stickerId === "string" ? meta.stickerId : undefined;
    retryOrigins.set(newTurnId, {
      userEventId: prep.userEvent.id,
      activityHint: prep.userEvent.activity ?? undefined,
    });

    dispatchChatTurn({
      turnId: newTurnId,
      userEvent: prep.userEvent,
      stickerId,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      activityHint: prep.userEvent.activity ?? undefined,
      groupId: prep.groupId,
      version: prep.nextVersion,
      historyBeforeSeq: prep.userEvent.seq,
      restoreCandidateIdOnFailure: prep.previousAssistantEvent.id,
    });

    return c.json(
      { turnId: newTurnId, groupId: prep.groupId, nextVersion: prep.nextVersion },
      202,
    );
  });

  app.post("/api/v1/chat/messages/:id/version", async (c) => {
    const id = c.req.param("id");
    if (!VALID_ULID_OR_ID_RE.test(id)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法消息 ID" } }, 400);
    }
    let body: { version?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    const version =
      typeof body.version === "number" && Number.isInteger(body.version) && body.version >= 1
        ? body.version
        : null;
    if (version === null) {
      return c.json({ error: { code: "INVALID_VERSION_TARGET", message: "version 必须为正整数" } }, 400);
    }
    const cfg = deps.getConfig();
    if ((cfg.door.state as string) === "departed") {
      return c.json(
        { error: { code: "RELATIONSHIP_DEPARTED", message: "这位住户已正式告别，本档案已转为只读纪念态。" } },
        410,
      );
    }
    if (activeAborts.size > 0) {
      return c.json(
        { error: { code: "TURN_IN_PROGRESS", message: "当前已有正在生成的回复，请稍后再切换版本" } },
        409,
      );
    }
    const res = deps.events.switchVersion(id, version);
    if (!res.ok) {
      const status = res.code === "NOT_FOUND" ? 404 : 409;
      return c.json({ error: { code: res.code, message: res.error } }, status);
    }
    const activatedItem = toTimelineItem(res.activated, deps.events);
    deps.sse?.emit("message.updated", {
      action: "version",
      groupId: res.groupId,
      message: activatedItem,
    });
    return c.json({ activated: activatedItem, groupId: res.groupId });
  });

  app.post("/api/v1/shares/:id/open", (c) => {
    const id = c.req.param("id");
    if (!VALID_ULID_OR_ID_RE.test(id)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法分享卡 ID" } }, 400);
    }
    const res = deps.events.openShare(id);
    if (!res.ok) {
      return c.json({ error: { code: "NOT_FOUND", message: res.error } }, 404);
    }
    if (res.firstOpen) {
      deps.sse?.emit("share.opened", {
        shareId: res.shareId,
        openedAt: res.openedAt,
      });
    }
    return c.json({
      ok: true,
      shareId: res.shareId,
      openedAt: res.openedAt,
      firstOpen: res.firstOpen,
    });
  });

  app.get("/api/v1/drawer", async (c) => {
    if (!deps.drawer) {
      return c.json({ error: { code: "NOT_ENABLED", message: "上锁抽屉未启用" } }, 404);
    }
    const items = await deps.drawer.listEntries(deps.events);
    return c.json({ items });
  });

  app.post("/api/v1/drawer/:id/open", async (c) => {
    if (!deps.drawer) {
      return c.json({ error: { code: "NOT_ENABLED", message: "上锁抽屉未启用" } }, 404);
    }
    const id = decodeURIComponent(c.req.param("id"));
    if (!isValidDrawerId(id)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法抽屉条目 ID" } }, 400);
    }
    let body: { confirmed?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    if (body.confirmed !== true) {
      return c.json(
        { error: { code: "CONFIRMATION_REQUIRED", message: "拆封上锁抽屉须显式确认 confirmed: true" } },
        400,
      );
    }
    const opened = await deps.drawer.openEntryForUser({
      id,
      events: deps.events,
      sessionId: deps.getActiveSessionId(),
      channel: "app",
    });
    if (!opened) {
      return c.json({ error: { code: "NOT_FOUND", message: "找不到对应的上锁抽屉条目" } }, 404);
    }
    deps.sse?.emit("message.created", {
      message: toTimelineItem(opened.peekedEvent, deps.events),
    });
    return c.json({
      id: opened.id,
      title: opened.title,
      content: opened.content,
      createdAt: opened.createdAt,
      updatedAt: opened.updatedAt,
      peekedEventId: opened.peekedEventId,
    });
  });

  app.post("/api/v1/turns/:turnId/approval", async (c) => {
    const turnId = c.req.param("turnId");
    if (!VALID_ULID_OR_ID_RE.test(turnId)) {
      return c.json({ error: { code: "INVALID_ID", message: "非法 turnId" } }, 400);
    }
    let body: { approvalId?: string; decision?: string; scope?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    const approvalId = typeof body.approvalId === "string" ? body.approvalId.trim() : "";
    const decision = body.decision === "allow" || body.decision === "deny" ? body.decision : null;
    const scope = body.scope === "session" ? "session" : "once";
    if (!approvalId || !decision) {
      return c.json(
        { error: { code: "INVALID_APPROVAL", message: "缺少合法 approvalId 或 decision(allow/deny)" } },
        400,
      );
    }
    const entry = pendingApprovals.get(approvalId);
    if (!entry || entry.turnId !== turnId) {
      return c.json(
        { error: { code: "APPROVAL_ALREADY_RESOLVED", message: "该审批已处理或已超时" } },
        409,
      );
    }
    if (decision === "allow" && scope === "session") {
      sessionApprovedTools.add(entry.toolName);
    }
    deps.sse?.emit("turn.approval_resolved", {
      approvalId,
      turnId,
      decision,
      scope,
    });
    entry.resolve({ decision, scope });
    return c.json({ ok: true, approvalId, decision });
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
    const rawLastEventId = c.req.query("lastEventId") ?? c.req.header("last-event-id") ?? "";
    const parsedLastId = /^\d+$/.test(rawLastEventId.trim()) ? Number(rawLastEventId.trim()) : null;
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
        let replayedMaxId = parsedLastId ?? 0;
        const replay = deps.sse && parsedLastId !== null ? deps.sse.replaySince(parsedLastId) : null;
        if (replay) {
          replayedMaxId = replay.latestStreamSeq;
        }
        // 先建立订阅再同步回放，避免订阅间隙漏帧（超过 replayedMaxId 的新帧才放行）
        const unsubscribe = deps.sse?.subscribe(
          (frame) => {
            if (frame.id !== undefined && frame.id <= replayedMaxId) {
              return;
            }
            send(formatSseFrame(frame));
          },
          { foreground },
        );

        send(formatSseFrame({ event: "ping", data: { ts: deps.clock.now() } }));
        if (replay?.resetReason) {
          send(
            formatSseFrame({
              event: "sync.reset",
              data: {
                reason: replay.resetReason,
                latestStreamSeq: replay.latestStreamSeq,
              },
            }),
          );
        } else if (replay) {
          for (const frame of replay.frames) {
            send(formatSseFrame(frame));
          }
        }

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
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  return app;
}
