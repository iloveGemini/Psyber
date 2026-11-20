import type { Hono } from "hono";
import {
  DEFAULT_CIRCADIAN_CONFIG,
  DEFAULT_NOTIFICATIONS_CONFIG,
  DEFAULT_RECALL_CONFIG,
  saveConfig,
  type CircadianConfig,
  type LlmConfig,
  type NotificationsConfig,
  type PsyberConfig,
  type RecallConfig,
} from "../core/config.ts";
import { loadCredentials, saveCredentials, type StoredCredentials } from "../core/credentials.ts";
import { MAX_MEDIA_UPLOAD_BYTES, MediaStore } from "../core/media.ts";
import { applyGenesisMemory, getGenesisNamedStatus } from "../memory/genesis.ts";
import type { AppDeps } from "./app.ts";
import { hashBearerToken } from "./app.ts";

const HH_MM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeSettings(cfg: PsyberConfig, creds: StoredCredentials) {
  const providers: Record<
    string,
    { kind: string; authMode: string; baseUrl?: string; authStatus: "configured" | "unset" }
  > = {};
  if (cfg.llm?.providers) {
    for (const [id, p] of Object.entries(cfg.llm.providers)) {
      providers[id] = {
        kind: p.kind,
        authMode: p.authMode,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        authStatus: creds.apiKeys[id] ? "configured" : "unset",
      };
    }
  }

  return {
    timezone: cfg.timezone,
    llm: {
      providers,
      slots: cfg.llm?.slots ?? {},
      thinking: cfg.llm?.thinking ?? { enabled: true },
    },
    circadian: cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG,
    notifications: cfg.notifications ?? DEFAULT_NOTIFICATIONS_CONFIG,
    recall: cfg.recall ?? DEFAULT_RECALL_CONFIG,
    devices: (cfg.auth?.devices ?? []).map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      platform: d.platform,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
    })),
  };
}

function validateCircadianPatch(patch: Partial<CircadianConfig>): string | null {
  if (patch.sleepStart !== undefined && (typeof patch.sleepStart !== "string" || !HH_MM_RE.test(patch.sleepStart))) {
    return "circadian.sleepStart 须为合法 HH:mm 格式";
  }
  if (patch.sleepEnd !== undefined && (typeof patch.sleepEnd !== "string" || !HH_MM_RE.test(patch.sleepEnd))) {
    return "circadian.sleepEnd 须为合法 HH:mm 格式";
  }
  for (const field of ["heartbeatIntervalMin", "proactiveMinGapMin", "proactiveCooldownMin"] as const) {
    const v = patch[field];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 1440)) {
      return `circadian.${field} 须为 1..1440 之间的数字`;
    }
  }
  if (patch.proactiveEnabled !== undefined && typeof patch.proactiveEnabled !== "boolean") {
    return "circadian.proactiveEnabled 须为布尔值";
  }
  return null;
}

function validateRecallPatch(patch: Partial<RecallConfig>): string | null {
  if (patch.charBudget !== undefined && (typeof patch.charBudget !== "number" || patch.charBudget < 200 || patch.charBudget > 20_000)) {
    return "recall.charBudget 须在 200..20000 之间";
  }
  if (patch.dedupWindowMin !== undefined && (typeof patch.dedupWindowMin !== "number" || patch.dedupWindowMin < 0 || patch.dedupWindowMin > 1440)) {
    return "recall.dedupWindowMin 须在 0..1440 之间";
  }
  if (patch.recentDailyWindowHours !== undefined && (typeof patch.recentDailyWindowHours !== "number" || patch.recentDailyWindowHours < 1 || patch.recentDailyWindowHours > 720)) {
    return "recall.recentDailyWindowHours 须在 1..720 之间";
  }
  if (patch.embedTimeoutMs !== undefined && (typeof patch.embedTimeoutMs !== "number" || patch.embedTimeoutMs < 200 || patch.embedTimeoutMs > 30_000)) {
    return "recall.embedTimeoutMs 须在 200..30000 之间";
  }
  return null;
}

function validateNotificationsPatch(patch: Partial<NotificationsConfig>): string | null {
  if (patch.webhook?.url !== undefined && patch.webhook.url !== "" && !isValidHttpUrl(patch.webhook.url)) {
    return "notifications.webhook.url 必须为合法的 http:// 或 https:// 地址";
  }
  return null;
}

/** 注册配对、创世引导、媒体仓与脱敏设置子路由，避免 app.ts 单文件发散膨胀 */
export function registerAdminRoutes(app: Hono, deps: AppDeps): void {
  // 一次性配对码兑换长期 Bearer Token（免鉴权，默认不信任可伪造的 x-forwarded-for）
  app.post("/api/v1/auth/pair", async (c) => {
    if (!deps.pairing) {
      return c.json({ error: { code: "PAIRING_UNAVAILABLE", message: "当前未启用配对服务" } }, 503);
    }
    let body: { code?: string; deviceName?: string; platform?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    if (!body.code || !body.deviceName || !body.platform) {
      return c.json({ error: { code: "INVALID_PAIR_REQUEST", message: "缺少 code、deviceName 或 platform" } }, 400);
    }

    const clientIp =
      deps.getClientIp?.(c.req.raw) ??
      (deps.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ??
      "direct";
    const res = deps.pairing.verifyAndConsume(body.code, clientIp);
    if (!res.ok) {
      return c.json({ error: { code: res.code, message: res.message } }, res.status);
    }

    const cfg = deps.getConfig();
    const now = deps.clock.now();
    cfg.auth.devices.push({
      deviceId: res.deviceId,
      tokenHash: hashBearerToken(res.token),
      deviceName: body.deviceName.trim(),
      platform: body.platform.trim(),
      createdAt: now,
      lastSeenAt: now,
    });
    if (deps.dataDir) {
      await saveConfig(deps.dataDir, cfg);
    }

    return c.json({
      deviceId: res.deviceId,
      token: res.token,
      instanceId: cfg.instanceId,
      serverVersion: deps.version,
    });
  });

  app.get("/api/v1/genesis", async (c) => {
    const cfg = deps.getConfig();
    const named = deps.dataDir
      ? await getGenesisNamedStatus(deps.dataDir, deps.clock.now(), cfg.timezone)
      : false;
    const creds = deps.dataDir ? await loadCredentials(deps.dataDir) : { apiKeys: {}, channelTokens: {} };
    const chatProvider = cfg.llm?.slots?.chat?.provider;
    const hasChatProvider = Boolean(chatProvider && creds.apiKeys[chatProvider]);
    const circadian = cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG;

    return c.json({
      initialized: Boolean(cfg.genesisCompleted),
      named,
      hasChatProvider,
      timezone: cfg.timezone,
      sleepWindow: { start: circadian.sleepStart, end: circadian.sleepEnd },
    });
  });

  app.post("/api/v1/genesis", async (c) => {
    let body: {
      residentName?: string;
      userName?: string;
      timezone?: string;
      sleepWindow?: { start?: string; end?: string };
      llm?: Partial<LlmConfig>;
      credentials?: Record<string, { apiKey?: string }>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }

    const cfg = deps.getConfig();
    if (typeof body.timezone === "string" && body.timezone.trim()) {
      cfg.timezone = body.timezone.trim();
    }
    const circadian = { ...(cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG) };
    if (typeof body.sleepWindow?.start === "string" && HH_MM_RE.test(body.sleepWindow.start)) {
      circadian.sleepStart = body.sleepWindow.start;
    }
    if (typeof body.sleepWindow?.end === "string" && HH_MM_RE.test(body.sleepWindow.end)) {
      circadian.sleepEnd = body.sleepWindow.end;
    }
    cfg.circadian = circadian;
    if (body.llm && typeof body.llm === "object") {
      cfg.llm = {
        providers: { ...(cfg.llm?.providers ?? {}), ...(body.llm.providers ?? {}) },
        slots: { ...(cfg.llm?.slots ?? {}), ...(body.llm.slots ?? {}) },
        thinking: { ...(cfg.llm?.thinking ?? { enabled: true }), ...(body.llm.thinking ?? {}) },
      };
    }
    cfg.genesisCompleted = true;

    let named = Boolean(typeof body.residentName === "string" && body.residentName.trim());
    if (deps.dataDir) {
      // BYOK API Key 直落 0600 权限的 credentials.json，绝不写入 config.json
      if (body.credentials && typeof body.credentials === "object") {
        const creds = await loadCredentials(deps.dataDir);
        for (const [provider, entry] of Object.entries(body.credentials)) {
          if (entry && typeof entry.apiKey === "string" && entry.apiKey.trim()) {
            creds.apiKeys[provider] = entry.apiKey.trim();
          }
        }
        await saveCredentials(deps.dataDir, creds);
      }

      const memRes = await applyGenesisMemory({
        dataDir: deps.dataDir,
        memoryIndex: deps.memoryIndex,
        residentName: body.residentName,
        userName: body.userName,
      });
      named = memRes.named;
      await saveConfig(deps.dataDir, cfg);
    }

    return c.json({ ok: true, named });
  });

  // 媒体内容寻址上传与不可变 ETag 读取
  app.post("/api/v1/media", async (c) => {
    const mediaStore = deps.media ?? (deps.db && deps.dataDir ? new MediaStore(deps.db, deps.dataDir) : null);
    if (!mediaStore) {
      return c.json({ error: { code: "MEDIA_UNAVAILABLE", message: "媒体仓未就绪" } }, 503);
    }
    const formData = await c.req.formData().catch(() => null);
    const file = formData?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: { code: "MISSING_FILE", message: "缺少 multipart file 字段" } }, 400);
    }
    if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "单文件大小超过 20 MB 上限" } }, 413);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const saved = await mediaStore.save({
        bytes,
        mimeType: file.type || "application/octet-stream",
        origin: "user_upload",
        nowMs: deps.clock.now(),
      });
      return c.json({
        hash: saved.hash,
        url: saved.url,
        mimeType: saved.mimeType,
        size: saved.sizeBytes,
      });
    } catch (err) {
      if ((err as Error).message === "PAYLOAD_TOO_LARGE") {
        return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "单文件大小超过 20 MB 上限" } }, 413);
      }
      throw err;
    }
  });

  app.get("/api/v1/media/:hash", async (c) => {
    const mediaStore = deps.media ?? (deps.db && deps.dataDir ? new MediaStore(deps.db, deps.dataDir) : null);
    if (!mediaStore) {
      return c.json({ error: { code: "MEDIA_UNAVAILABLE", message: "媒体仓未就绪" } }, 503);
    }
    const hash = c.req.param("hash");
    const item = await mediaStore.read(hash);
    if (!item) {
      return c.json({ error: { code: "NOT_FOUND", message: "媒体文件不存在" } }, 404);
    }
    if (item.expired) {
      return c.json({ error: { code: "MEDIA_EXPIRED", message: "该临时帧已过期清理" } }, 410);
    }
    const etag = `"${hash.toLowerCase()}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }
    return new Response(new Uint8Array(item.bytes), {
      status: 200,
      headers: {
        "content-type": item.mimeType,
        etag,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  // 静态贴纸列表（对齐 Spec 04 §2.3）
  app.get("/api/v1/stickers", (c) => {
    const items = deps.events.listStickers(50).map((s) => ({
      id: s.id,
      label: s.label,
      pack: s.pack,
      url: `/api/v1/media/${s.mediaHash}`,
      useCount: s.useCount,
    }));
    return c.json({ items });
  });

  // 脱敏设置读写（绝不返回任何明文令牌或密钥）
  app.get("/api/v1/settings", async (c) => {
    const creds = deps.dataDir ? await loadCredentials(deps.dataDir) : { apiKeys: {}, channelTokens: {} };
    return c.json(sanitizeSettings(deps.getConfig(), creds));
  });

  app.patch("/api/v1/settings", async (c) => {
    let body: {
      timezone?: string;
      circadian?: Partial<CircadianConfig>;
      notifications?: Partial<NotificationsConfig>;
      recall?: Partial<RecallConfig>;
      llm?: Partial<LlmConfig>;
      credentials?: Record<string, { apiKey?: string }>;
      revokeDeviceIds?: string[];
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }

    if (body.circadian && typeof body.circadian === "object") {
      const err = validateCircadianPatch(body.circadian);
      if (err) return c.json({ error: { code: "INVALID_SETTINGS", message: err } }, 400);
    }
    if (body.recall && typeof body.recall === "object") {
      const err = validateRecallPatch(body.recall);
      if (err) return c.json({ error: { code: "INVALID_SETTINGS", message: err } }, 400);
    }
    if (body.notifications && typeof body.notifications === "object") {
      const err = validateNotificationsPatch(body.notifications);
      if (err) return c.json({ error: { code: "INVALID_SETTINGS", message: err } }, 400);
    }

    const cfg = deps.getConfig();
    if (typeof body.timezone === "string" && body.timezone.trim()) {
      cfg.timezone = body.timezone.trim();
    }
    if (body.circadian && typeof body.circadian === "object") {
      cfg.circadian = { ...(cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG), ...body.circadian };
    }
    if (body.notifications && typeof body.notifications === "object") {
      cfg.notifications = { ...(cfg.notifications ?? DEFAULT_NOTIFICATIONS_CONFIG), ...body.notifications };
    }
    if (body.recall && typeof body.recall === "object") {
      cfg.recall = { ...(cfg.recall ?? DEFAULT_RECALL_CONFIG), ...body.recall };
    }
    if (body.llm && typeof body.llm === "object") {
      cfg.llm = {
        providers: { ...(cfg.llm?.providers ?? {}), ...(body.llm.providers ?? {}) },
        slots: { ...(cfg.llm?.slots ?? {}), ...(body.llm.slots ?? {}) },
        thinking: { ...(cfg.llm?.thinking ?? { enabled: true }), ...(body.llm.thinking ?? {}) },
      };
    }
    if (Array.isArray(body.revokeDeviceIds) && body.revokeDeviceIds.length > 0) {
      const toRevoke = new Set(
        body.revokeDeviceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0),
      );
      cfg.auth.devices = (cfg.auth.devices ?? []).filter((d) => !toRevoke.has(d.deviceId));
    }

    let creds: StoredCredentials = { apiKeys: {}, channelTokens: {} };
    if (deps.dataDir) {
      creds = await loadCredentials(deps.dataDir);
      if (body.credentials && typeof body.credentials === "object") {
        for (const [provider, entry] of Object.entries(body.credentials)) {
          if (entry && typeof entry.apiKey === "string" && entry.apiKey.trim()) {
            creds.apiKeys[provider] = entry.apiKey.trim();
          }
        }
        await saveCredentials(deps.dataDir, creds);
      }
      await saveConfig(deps.dataDir, cfg);
    }

    deps.onSettingsUpdated?.();
    return c.json({ ok: true, settings: sanitizeSettings(cfg, creds) });
  });
}
