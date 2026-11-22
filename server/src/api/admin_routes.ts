import type { Hono } from "hono";
import {
  DEFAULT_CIRCADIAN_CONFIG,
  DEFAULT_NOTIFICATIONS_CONFIG,
  DEFAULT_RECALL_CONFIG,
  saveConfig,
  type CircadianConfig,
  type LlmConfig,
  type McpServerConfig,
  type NotificationsConfig,
  type PsyberConfig,
  type RecallConfig,
} from "../core/config.ts";
import { loadCredentials, saveCredentials, type StoredCredentials } from "../core/credentials.ts";
import { MAX_MEDIA_UPLOAD_BYTES, MediaStore } from "../core/media.ts";
import { MCP_PRESETS, validateMcpServers, type McpManager } from "../extensions/mcp.ts";
import {
  discoverProviderModels,
  resolveEffectiveThinkingLevel,
  testModelConnection,
} from "../llm/router.ts";
import {
  applyGenesisMemory,
  readIdentityProfile,
  type IdentityProfile,
} from "../memory/genesis.ts";
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

function sanitizeSettings(
  cfg: PsyberConfig,
  creds: StoredCredentials,
  mcp?: McpManager,
  identity?: IdentityProfile,
) {
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

  const mcpServers = mcp
    ? mcp.getStatusList()
    : (cfg.mcpServers ?? []).map((s) => ({
        id: s.id,
        enabled: s.enabled,
        transport: s.transport,
        ...(s.description ? { description: s.description } : {}),
        ...(s.command ? { command: s.command } : {}),
        ...(s.args ? { args: s.args } : {}),
        ...(s.url ? { url: s.url } : {}),
        trustLevel: s.trustLevel ?? "confirm",
        ...(s.autoAllowTools ? { autoAllowTools: s.autoAllowTools } : {}),
        timeoutMs: s.timeoutMs ?? 30_000,
        status: s.enabled ? "degraded" : "disabled",
        toolCount: 0,
        tools: [],
      }));

  const effectiveLevel = resolveEffectiveThinkingLevel(cfg);
  return {
    timezone: cfg.timezone,
    llm: {
      providers,
      slots: cfg.llm?.slots ?? {},
      thinking: {
        enabled: effectiveLevel !== "off",
        level: effectiveLevel,
        ...(cfg.llm?.thinking?.budgetTokens !== undefined
          ? { budgetTokens: cfg.llm.thinking.budgetTokens }
          : {}),
      },
      ...(cfg.llm?.contextLimits ? { contextLimits: cfg.llm.contextLimits } : {}),
    },
    avatars: {
      ...(cfg.avatars?.userHash ? { userUrl: `/api/v1/media/${cfg.avatars.userHash}` } : {}),
      ...(cfg.avatars?.residentHash
        ? { residentUrl: `/api/v1/media/${cfg.avatars.residentHash}` }
        : {}),
    },
    ...(identity ? { identity } : {}),
    userStatus: {
      moodText: cfg.userStatus?.moodText ?? null,
      undisturbed: cfg.userStatus?.undisturbed === true,
      updatedAt: cfg.userStatus?.updatedAt ?? 0,
    },
    recallEvalNoticeResident: Boolean(cfg.recallEvalNoticeResident),
    circadian: cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG,
    notifications: {
      ...(cfg.notifications ?? DEFAULT_NOTIFICATIONS_CONFIG),
      hasBarkKey: Boolean(
        creds.channelTokens[cfg.notifications?.bark?.deviceKeyRef || "bark_device_key"],
      ),
      hasNtfyToken: Boolean(
        cfg.notifications?.ntfy?.credentialKey &&
          creds.channelTokens[cfg.notifications.ntfy.credentialKey],
      ),
    },
    recall: cfg.recall ?? DEFAULT_RECALL_CONFIG,
    mcpServers,
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
  if (patch.bark?.serverUrl !== undefined && patch.bark.serverUrl !== "" && !isValidHttpUrl(patch.bark.serverUrl)) {
    return "notifications.bark.serverUrl 必须为合法的 http:// 或 https:// 地址";
  }
  if (patch.ntfy?.serverUrl !== undefined && patch.ntfy.serverUrl !== "" && !isValidHttpUrl(patch.ntfy.serverUrl)) {
    return "notifications.ntfy.serverUrl 必须为合法的 http:// 或 https:// 地址";
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
    const identity: IdentityProfile = deps.dataDir
      ? await readIdentityProfile(deps.dataDir, deps.clock.now(), cfg.timezone)
      : {
          residentName: null,
          residentPronoun: null,
          named: false,
          userName: null,
          userPronoun: null,
        };
    const creds: StoredCredentials = deps.dataDir
      ? await loadCredentials(deps.dataDir)
      : { apiKeys: {}, channelTokens: {}, mcpSecrets: {} };
    const chatProvider = cfg.llm?.slots?.chat?.provider;
    const hasChatProvider = Boolean(chatProvider && creds.apiKeys[chatProvider]);
    const circadian = cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG;

    return c.json({
      initialized: Boolean(cfg.genesisCompleted),
      named: identity.named,
      residentName: identity.residentName,
      residentPronoun: identity.residentPronoun,
      userName: identity.userName,
      userPronoun: identity.userPronoun,
      hasChatProvider,
      timezone: cfg.timezone,
      sleepWindow: { start: circadian.sleepStart, end: circadian.sleepEnd },
    });
  });

  app.post("/api/v1/genesis", async (c) => {
    let body: {
      residentName?: string;
      userName?: string;
      userPronoun?: string;
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

    let identity: IdentityProfile = {
      residentName: body.residentName?.trim() || null,
      residentPronoun: null,
      named: Boolean(typeof body.residentName === "string" && body.residentName.trim()),
      userName: body.userName?.trim() || null,
      userPronoun: body.userPronoun?.trim() || null,
    };
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

      await applyGenesisMemory({
        dataDir: deps.dataDir,
        memoryIndex: deps.memoryIndex,
        residentName: body.residentName,
        userName: body.userName,
        userPronoun: body.userPronoun,
      });
      await saveConfig(deps.dataDir, cfg);
      identity = await readIdentityProfile(deps.dataDir, deps.clock.now(), cfg.timezone);
      deps.sse?.emit("identity.updated", { ...identity });
    }

    return c.json({
      ok: true,
      named: identity.named,
      residentName: identity.residentName,
      residentPronoun: identity.residentPronoun,
      userName: identity.userName,
      userPronoun: identity.userPronoun,
    });
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
    const cfg = deps.getConfig();
    const creds = deps.dataDir
      ? await loadCredentials(deps.dataDir)
      : { apiKeys: {}, channelTokens: {}, mcpSecrets: {} };
    const identity = deps.dataDir
      ? await readIdentityProfile(deps.dataDir, deps.clock.now(), cfg.timezone)
      : undefined;
    return c.json(sanitizeSettings(cfg, creds, deps.mcp, identity));
  });

  app.patch("/api/v1/settings", async (c) => {
    let body: {
      timezone?: string;
      circadian?: Partial<CircadianConfig>;
      notifications?: Partial<NotificationsConfig>;
      notificationSecrets?: { barkDeviceKey?: string; ntfyToken?: string };
      recall?: Partial<RecallConfig>;
      llm?: Partial<LlmConfig>;
      credentials?: Record<string, { apiKey?: string }>;
      mcpServers?: McpServerConfig[];
      mcpSecrets?: Record<string, string>;
      revokeDeviceIds?: string[];
      recallEvalNoticeResident?: boolean;
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
    let validatedMcpServers: McpServerConfig[] | null = null;
    if (body.mcpServers !== undefined) {
      const checked = validateMcpServers(body.mcpServers);
      if (!checked.ok) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: checked.error } }, 400);
      }
      validatedMcpServers = checked.servers;
    }

    const cfg = deps.getConfig();
    if (typeof body.timezone === "string" && body.timezone.trim()) {
      cfg.timezone = body.timezone.trim();
    }
    if (typeof body.recallEvalNoticeResident === "boolean") {
      cfg.recallEvalNoticeResident = body.recallEvalNoticeResident;
    }
    if (body.circadian && typeof body.circadian === "object") {
      cfg.circadian = { ...(cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG), ...body.circadian };
    }
    if (body.notifications && typeof body.notifications === "object") {
      const prev = cfg.notifications ?? DEFAULT_NOTIFICATIONS_CONFIG;
      cfg.notifications = {
        ...prev,
        ...body.notifications,
        desktop: {
          ...prev.desktop,
          ...(body.notifications.desktop ?? {}),
        },
        ...(prev.webhook || body.notifications.webhook
          ? {
              webhook: {
                enabled: false,
                url: "",
                ...(prev.webhook ?? {}),
                ...(body.notifications.webhook ?? {}),
              },
            }
          : {}),
        ...(prev.bark || body.notifications.bark
          ? {
              bark: {
                enabled: false,
                ...(prev.bark ?? {}),
                ...(body.notifications.bark ?? {}),
              },
            }
          : {}),
        ...(prev.ntfy || body.notifications.ntfy
          ? {
              ntfy: {
                enabled: false,
                topic: "",
                ...(prev.ntfy ?? {}),
                ...(body.notifications.ntfy ?? {}),
              },
            }
          : {}),
      };
    }
    if (body.recall && typeof body.recall === "object") {
      cfg.recall = { ...(cfg.recall ?? DEFAULT_RECALL_CONFIG), ...body.recall };
    }
    if (body.llm && typeof body.llm === "object") {
      const rawLevel = body.llm.thinking?.level;
      if (
        rawLevel !== undefined &&
        rawLevel !== "off" &&
        rawLevel !== "low" &&
        rawLevel !== "medium" &&
        rawLevel !== "high"
      ) {
        return c.json(
          { error: { code: "INVALID_SETTINGS", message: "llm.thinking.level 须为 off/low/medium/high" } },
          400,
        );
      }
      const mergedThinking = {
        ...(cfg.llm?.thinking ?? { enabled: true }),
        ...(body.llm.thinking ?? {}),
      };
      if (rawLevel !== undefined) {
        mergedThinking.enabled = rawLevel !== "off";
      }
      const mergedLimits = body.llm.contextLimits
        ? { ...(cfg.llm?.contextLimits ?? {}), ...body.llm.contextLimits }
        : cfg.llm?.contextLimits;
      cfg.llm = {
        providers: { ...(cfg.llm?.providers ?? {}), ...(body.llm.providers ?? {}) },
        slots: { ...(cfg.llm?.slots ?? {}), ...(body.llm.slots ?? {}) },
        thinking: mergedThinking,
        ...(mergedLimits ? { contextLimits: mergedLimits } : {}),
      };
    }
    if (validatedMcpServers !== null) {
      cfg.mcpServers = validatedMcpServers;
    }
    if (Array.isArray(body.revokeDeviceIds) && body.revokeDeviceIds.length > 0) {
      const toRevoke = new Set(
        body.revokeDeviceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0),
      );
      cfg.auth.devices = (cfg.auth.devices ?? []).filter((d) => !toRevoke.has(d.deviceId));
    }

    let creds: StoredCredentials = { apiKeys: {}, channelTokens: {}, mcpSecrets: {} };
    if (deps.dataDir) {
      creds = await loadCredentials(deps.dataDir);
      let credsChanged = false;
      if (body.credentials && typeof body.credentials === "object") {
        for (const [provider, entry] of Object.entries(body.credentials)) {
          if (entry && typeof entry.apiKey === "string" && entry.apiKey.trim()) {
            creds.apiKeys[provider] = entry.apiKey.trim();
            credsChanged = true;
          }
        }
      }
      if (body.mcpSecrets && typeof body.mcpSecrets === "object") {
        creds.mcpSecrets ??= {};
        for (const [key, value] of Object.entries(body.mcpSecrets)) {
          if (typeof value === "string" && value.trim()) {
            creds.mcpSecrets[key.trim()] = value.trim();
            credsChanged = true;
          }
        }
      }
      if (body.notificationSecrets && typeof body.notificationSecrets === "object") {
        creds.channelTokens ??= {};
        const { barkDeviceKey, ntfyToken } = body.notificationSecrets;
        if (typeof barkDeviceKey === "string" && barkDeviceKey.trim()) {
          const keyRef = cfg.notifications?.bark?.deviceKeyRef || "bark_device_key";
          creds.channelTokens[keyRef] = barkDeviceKey.trim();
          if (cfg.notifications?.bark) {
            cfg.notifications.bark.deviceKeyRef = keyRef;
          }
          credsChanged = true;
        }
        if (typeof ntfyToken === "string") {
          const keyRef = cfg.notifications?.ntfy?.credentialKey || "ntfy_token";
          if (ntfyToken.trim()) {
            creds.channelTokens[keyRef] = ntfyToken.trim();
            if (cfg.notifications?.ntfy) {
              cfg.notifications.ntfy.credentialKey = keyRef;
            }
          } else {
            delete creds.channelTokens[keyRef];
          }
          credsChanged = true;
        }
      }
      if (credsChanged) {
        await saveCredentials(deps.dataDir, creds);
      }
      await saveConfig(deps.dataDir, cfg);
    }

    if (validatedMcpServers !== null && deps.mcp) {
      await deps.mcp.reload(validatedMcpServers);
    }

    deps.onSettingsUpdated?.();
    const identity = deps.dataDir
      ? await readIdentityProfile(deps.dataDir, deps.clock.now(), cfg.timezone)
      : undefined;
    return c.json({ ok: true, settings: sanitizeSettings(cfg, creds, deps.mcp, identity) });
  });

  // Ring 1.5 离线通知测试（绕过前台/睡眠窗抑制，直接检测所有已启用通道）
  app.post("/api/v1/notifications/test", async (c) => {
    if (!deps.notifications) {
      return c.json({ error: { code: "NOTIFICATIONS_UNAVAILABLE", message: "通知服务未就绪" } }, 503);
    }
    const res = await deps.notifications.notify(
      {
        kind: "test",
        title: "Psyber 测试通知",
        body: "离线触达通道已连通，静默时段不会打扰你。",
      },
      { bypassSuppression: true },
    );
    return c.json({ ok: true, ...res });
  });

  // Ring 1.5 外部 MCP 生态预设与单服手动重连
  app.get("/api/v1/mcp/presets", (c) => {
    return c.json({ presets: MCP_PRESETS });
  });

  app.post("/api/v1/mcp/:id/reconnect", async (c) => {
    const id = c.req.param("id");
    if (!deps.mcp) {
      return c.json({ error: { code: "MCP_UNAVAILABLE", message: "外部 MCP 管理器未就绪" } }, 503);
    }
    const status = await deps.mcp.reconnect(id);
    if (!status) {
      return c.json({ error: { code: "NOT_FOUND", message: `未找到 MCP 服务器: ${id}` } }, 404);
    }
    return c.json({ ok: true, server: status });
  });

  // Ring 1.5 用户双人状态签（手动心绪短句 + 勿扰开关，勿扰开启时抑制非紧急主动 wake）
  app.get("/api/v1/user-status", (c) => {
    const cfg = deps.getConfig();
    return c.json({
      moodText: cfg.userStatus?.moodText ?? null,
      undisturbed: cfg.userStatus?.undisturbed === true,
      updatedAt: cfg.userStatus?.updatedAt ?? 0,
    });
  });

  app.patch("/api/v1/user-status", async (c) => {
    let body: { moodText?: string | null; undisturbed?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    const cfg = deps.getConfig();
    const prev = cfg.userStatus ?? { moodText: null, undisturbed: false, updatedAt: 0 };
    let moodText = prev.moodText;
    if (body.moodText !== undefined) {
      if (body.moodText === null) {
        moodText = null;
      } else if (typeof body.moodText === "string") {
        const trimmed = body.moodText.trim();
        moodText = trimmed ? trimmed.slice(0, 60) : null;
      } else {
        return c.json(
          { error: { code: "INVALID_USER_STATUS", message: "moodText 须为字符串或 null" } },
          400,
        );
      }
    }
    let undisturbed = prev.undisturbed;
    if (body.undisturbed !== undefined) {
      if (typeof body.undisturbed !== "boolean") {
        return c.json(
          { error: { code: "INVALID_USER_STATUS", message: "undisturbed 须为布尔值" } },
          400,
        );
      }
      undisturbed = body.undisturbed;
    }
    const updatedAt = deps.clock.now();
    cfg.userStatus = { moodText, undisturbed, updatedAt };
    if (deps.dataDir) {
      await saveConfig(deps.dataDir, cfg);
    }
    deps.sse?.emit("user_status.updated", { moodText, undisturbed, updatedAt });
    return c.json({ moodText, undisturbed, updatedAt });
  });

  // Ring 1.5 模型自动发现与一键连通测试
  app.get("/api/v1/llm/models", async (c) => {
    const provider = c.req.query("provider")?.trim() || undefined;
    const creds: StoredCredentials = deps.dataDir
      ? await loadCredentials(deps.dataDir)
      : { apiKeys: {}, channelTokens: {}, mcpSecrets: {} };
    const models = await discoverProviderModels(deps.getConfig(), creds, provider, deps.fetchImpl);
    return c.json({ models });
  });

  app.post("/api/v1/llm/test", async (c) => {
    let body: { provider?: string; model?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    const providerId = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.model === "string" ? body.model.trim() : "";
    if (!providerId || !modelId) {
      return c.json({ error: { code: "INVALID_REQUEST", message: "缺少 provider 或 model" } }, 400);
    }
    const creds: StoredCredentials = deps.dataDir
      ? await loadCredentials(deps.dataDir)
      : { apiKeys: {}, channelTokens: {}, mcpSecrets: {} };
    const result = await testModelConnection({
      config: deps.getConfig(),
      creds,
      providerId,
      modelId,
      clientFactory: deps.llmTestClientFactory,
    });
    return c.json(result);
  });

  // Ring 1.5 设置页独立消耗统计（今日/累计/按日/按模型费用与 Prompt Cache 命中率）
  app.get("/api/v1/usage/stats", (c) => {
    const cfg = deps.getConfig();
    return c.json(deps.events.getUsageStats(cfg.timezone));
  });

  // Ring 1.5 双人头像上传（POST /api/v1/avatars/:who，上限 5 MB，落盘 media/ 且 pinned = 1）
  app.post("/api/v1/avatars/:who", async (c) => {
    const who = c.req.param("who");
    if (who !== "user" && who !== "resident") {
      return c.json({ error: { code: "INVALID_AVATAR_TARGET", message: "头像目标仅支持 user 或 resident" } }, 400);
    }
    const mediaStore =
      deps.media ?? (deps.db && deps.dataDir ? new MediaStore(deps.db, deps.dataDir) : null);
    if (!mediaStore) {
      return c.json({ error: { code: "MEDIA_UNAVAILABLE", message: "媒体仓未就绪" } }, 503);
    }
    const formData = await c.req.formData().catch(() => null);
    const file = formData?.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: { code: "MISSING_FILE", message: "缺少 multipart file 字段" } }, 400);
    }
    const maxAvatarBytes = 5 * 1024 * 1024;
    if (file.size > maxAvatarBytes) {
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "头像图片大小超过 5 MB 上限" } }, 413);
    }
    const mimeType = file.type || "image/png";
    if (!mimeType.startsWith("image/")) {
      return c.json({ error: { code: "INVALID_MEDIA_TYPE", message: "头像仅支持图片格式" } }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const saved = await mediaStore.save({
      bytes,
      mimeType,
      origin: "user_upload",
      nowMs: deps.clock.now(),
    });
    const cfg = deps.getConfig();
    cfg.avatars = {
      ...(cfg.avatars ?? {}),
      ...(who === "user" ? { userHash: saved.hash } : { residentHash: saved.hash }),
    };
    if (deps.dataDir) {
      await saveConfig(deps.dataDir, cfg);
    }
    return c.json({
      who,
      hash: saved.hash,
      url: saved.url,
    });
  });
}
