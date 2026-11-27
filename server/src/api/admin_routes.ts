import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import {
  DEFAULT_CIRCADIAN_CONFIG,
  DEFAULT_NOTIFICATIONS_CONFIG,
  DEFAULT_RECALL_CONFIG,
  mergeMemoryMcpConfig,
  mergeRadarConfig,
  mergeRecallConfig,
  saveConfig,
  type BashToolConfig,
  type CircadianConfig,
  type LlmConfig,
  type McpServerConfig,
  type MemoryMcpAccessMode,
  type MemoryMcpConfig,
  type ModelMetadataOverride,
  type NotificationsConfig,
  type PsyberConfig,
  type RadarConfig,
  type RecallConfig,
} from "../core/config.ts";
import { loadCredentials, saveCredentials, type StoredCredentials } from "../core/credentials.ts";
import { MAX_MEDIA_UPLOAD_BYTES, MediaStore } from "../core/media.ts";
import {
  buildBashPolicy,
  DEFAULT_BASH_MAX_OUTPUT_CHARS,
  DEFAULT_BASH_TIMEOUT_MS,
  expandHomePath,
  findProtectedPathHit,
  MAX_BASH_TIMEOUT_MS,
  MIN_BASH_TIMEOUT_MS,
  resolveRealPathSafe,
} from "../extensions/bash.ts";
import { MCP_PRESETS, validateMcpServers } from "../extensions/mcp.ts";
import {
  buildPiAiChatClient,
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
import { buildPairQrPayload, issueMemoryMcpToken, normalizeClientIp } from "./pairing.ts";

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
  deps: AppDeps,
  identity?: IdentityProfile,
) {
  const providers: Record<
    string,
    {
      kind: string;
      authMode: string;
      baseUrl?: string;
      models?: string[];
      modelOverrides?: Record<string, ModelMetadataOverride>;
      authStatus: "configured" | "unset";
    }
  > = {};
  if (cfg.llm?.providers) {
    for (const [id, p] of Object.entries(cfg.llm.providers)) {
      providers[id] = {
        kind: p.kind,
        authMode: p.authMode,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        ...(Array.isArray(p.models) && p.models.length > 0 ? { models: p.models } : {}),
        ...(p.modelOverrides && Object.keys(p.modelOverrides).length > 0
          ? { modelOverrides: p.modelOverrides }
          : {}),
        authStatus: creds.apiKeys[id] ? "configured" : "unset",
      };
    }
  }

  const mcpServers = deps.mcp
    ? deps.mcp.getStatusList()
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

  const catalogStatus = deps.modelCatalog?.getStatus();
  const effectiveLevel = resolveEffectiveThinkingLevel(cfg);
    const rawMemoryMcp = mergeMemoryMcpConfig(cfg.memoryMcp);
    const memoryMcp = {
      enabled: rawMemoryMcp.enabled,
      accessMode: rawMemoryMcp.accessMode,
      allowRemote: rawMemoryMcp.allowRemote,
      protectCoreFiles: rawMemoryMcp.protectCoreFiles,
      maxOutputChars: rawMemoryMcp.maxOutputChars,
      disabledTools: rawMemoryMcp.disabledTools,
      replayToolsEnabled: rawMemoryMcp.replayToolsEnabled,
      tokens: rawMemoryMcp.tokens.map((t) => ({
        id: t.id,
        name: t.name,
        ...(t.accessMode ? { accessMode: t.accessMode } : {}),
        createdAt: t.createdAt,
        ...(t.lastUsedAt !== undefined ? { lastUsedAt: t.lastUsedAt } : {}),
      })),
    };

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
    recall: mergeRecallConfig(cfg.recall),
    radar: mergeRadarConfig(cfg.radar),
    bash: {
      allowedDirs: cfg.bash?.allowedDirs ?? [],
      timeoutMs: cfg.bash?.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
      maxOutputChars: cfg.bash?.maxOutputChars ?? DEFAULT_BASH_MAX_OUTPUT_CHARS,
      ...(deps.dataDir ? { workspaceDir: path.join(deps.dataDir, "workspace") } : {}),
    },
    mcpServers,
    memoryMcp,
    tools: deps.toolRegistry?.listAllTools() ?? [],
    disabledTools: cfg.disabledTools ?? [],
    system: {
      version: deps.version,
      ...(deps.dataDir
        ? {
            dataDir: deps.dataDir,
            configPath: path.join(deps.dataDir, "config.json"),
            memoryDir: path.join(deps.dataDir, "memory"),
          }
        : {}),
      ...(catalogStatus
        ? {
            catalogUpdatedAt: catalogStatus.updatedAt,
            catalogModelCount: catalogStatus.modelCount,
          }
        : {}),
    },
    devices: (cfg.auth?.devices ?? []).map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      platform: d.platform,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
    })),
  };
}

function validateMemoryMcpPatch(patch: Partial<MemoryMcpConfig>): string | null {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    return "memoryMcp.enabled 须为布尔值";
  }
  if (
    patch.accessMode !== undefined &&
    patch.accessMode !== "read_only" &&
    patch.accessMode !== "read_write"
  ) {
    return "memoryMcp.accessMode 须为 read_only 或 read_write";
  }
  if (patch.allowRemote !== undefined && typeof patch.allowRemote !== "boolean") {
    return "memoryMcp.allowRemote 须为布尔值";
  }
  if (patch.protectCoreFiles !== undefined && typeof patch.protectCoreFiles !== "boolean") {
    return "memoryMcp.protectCoreFiles 须为布尔值";
  }
  if (patch.maxOutputChars !== undefined && !isNumInRange(patch.maxOutputChars, 1_000, 50_000)) {
    return "memoryMcp.maxOutputChars 须在 1000..50000 之间";
  }
  if (patch.disabledTools !== undefined) {
    if (!Array.isArray(patch.disabledTools) || patch.disabledTools.some((t) => typeof t !== "string")) {
      return "memoryMcp.disabledTools 须为字符串数组";
    }
  }
  if (patch.replayToolsEnabled !== undefined && typeof patch.replayToolsEnabled !== "boolean") {
    return "memoryMcp.replayToolsEnabled 须为布尔值";
  }
  if ((patch as Record<string, unknown>).tokens !== undefined) {
    return "memoryMcp.tokens 不可通过 /settings 直接覆盖，请使用 /api/v1/memory-mcp/tokens 管理令牌";
  }
  return null;
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

function isNumInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function validateRecallPatch(patch: Partial<RecallConfig>): string | null {
  if (patch.charBudget !== undefined && !isNumInRange(patch.charBudget, 200, 20_000)) {
    return "recall.charBudget 须在 200..20000 之间";
  }
  if (patch.dedupWindowMin !== undefined && !isNumInRange(patch.dedupWindowMin, 0, 1440)) {
    return "recall.dedupWindowMin 须在 0..1440 之间";
  }
  if (patch.recentDailyWindowHours !== undefined && !isNumInRange(patch.recentDailyWindowHours, 1, 720)) {
    return "recall.recentDailyWindowHours 须在 1..720 之间";
  }
  if (patch.embedTimeoutMs !== undefined && !isNumInRange(patch.embedTimeoutMs, 200, 30_000)) {
    return "recall.embedTimeoutMs 须在 200..30000 之间";
  }
  if (patch.decisionTimeoutMs !== undefined && !isNumInRange(patch.decisionTimeoutMs, 200, 60_000)) {
    return "recall.decisionTimeoutMs 须在 200..60000 之间";
  }
  if (patch.rerankTimeoutMs !== undefined && !isNumInRange(patch.rerankTimeoutMs, 200, 60_000)) {
    return "recall.rerankTimeoutMs 须在 200..60000 之间";
  }
  if (patch.queryWindowTurns !== undefined && !isNumInRange(patch.queryWindowTurns, 0, 20)) {
    return "recall.queryWindowTurns 须在 0..20 之间";
  }
  if (patch.candidatePool !== undefined && !isNumInRange(patch.candidatePool, 1, 100)) {
    return "recall.candidatePool 须在 1..100 之间";
  }
  if (patch.catalogScanMaxCards !== undefined && !isNumInRange(patch.catalogScanMaxCards, 0, 1000)) {
    return "recall.catalogScanMaxCards 须在 0..1000 之间";
  }
  for (const scoreField of ["ftsMinScore", "embedMinScore"] as const) {
    if (patch[scoreField] !== undefined && !isNumInRange(patch[scoreField], 0, 1)) {
      return `recall.${scoreField} 须在 0..1 之间`;
    }
  }
  if (patch.hybridFtsWithEmbedding !== undefined && typeof patch.hybridFtsWithEmbedding !== "boolean") {
    return "recall.hybridFtsWithEmbedding 须为布尔值";
  }
  if (patch.gate !== undefined) {
    if (!patch.gate || typeof patch.gate !== "object" || Array.isArray(patch.gate)) {
      return "recall.gate 须为对象";
    }
    if (patch.gate.enabled !== undefined && typeof patch.gate.enabled !== "boolean") {
      return "recall.gate.enabled 须为布尔值";
    }
    if (patch.gate.threshold !== undefined && !isNumInRange(patch.gate.threshold, 0, 1)) {
      return "recall.gate.threshold 须在 0..1 之间";
    }
  }
  if (patch.rerank !== undefined) {
    if (!patch.rerank || typeof patch.rerank !== "object" || Array.isArray(patch.rerank)) {
      return "recall.rerank 须为对象";
    }
    if (patch.rerank.threshold !== undefined && !isNumInRange(patch.rerank.threshold, 0, 1)) {
      return "recall.rerank.threshold 须在 0..1 之间";
    }
  }
  if (patch.multiHop !== undefined) {
    if (!patch.multiHop || typeof patch.multiHop !== "object" || Array.isArray(patch.multiHop)) {
      return "recall.multiHop 须为对象";
    }
    if (patch.multiHop.enabled !== undefined && typeof patch.multiHop.enabled !== "boolean") {
      return "recall.multiHop.enabled 须为布尔值";
    }
    if (patch.multiHop.maxNeighbors !== undefined && !isNumInRange(patch.multiHop.maxNeighbors, 1, 30)) {
      return "recall.multiHop.maxNeighbors 须在 1..30 之间";
    }
    if (patch.multiHop.sufficientThreshold !== undefined && !isNumInRange(patch.multiHop.sufficientThreshold, 0, 1)) {
      return "recall.multiHop.sufficientThreshold 须在 0..1 之间";
    }
    if (patch.multiHop.neighborThreshold !== undefined && !isNumInRange(patch.multiHop.neighborThreshold, 0, 1)) {
      return "recall.multiHop.neighborThreshold 须在 0..1 之间";
    }
    if (patch.multiHop.timeoutMs !== undefined && !isNumInRange(patch.multiHop.timeoutMs, 200, 60_000)) {
      return "recall.multiHop.timeoutMs 须在 200..60000 之间";
    }
  }
  if (patch.sensitive !== undefined) {
    if (!patch.sensitive || typeof patch.sensitive !== "object" || Array.isArray(patch.sensitive)) {
      return "recall.sensitive 须为对象";
    }
    if (
      patch.sensitive.allowExternalEmbedding !== undefined &&
      typeof patch.sensitive.allowExternalEmbedding !== "boolean"
    ) {
      return "recall.sensitive.allowExternalEmbedding 须为布尔值";
    }
    if (
      patch.sensitive.rerankThreshold !== undefined &&
      !isNumInRange(patch.sensitive.rerankThreshold, 0, 1)
    ) {
      return "recall.sensitive.rerankThreshold 须在 0..1 之间";
    }
    if (
      patch.sensitive.ftsMinScore !== undefined &&
      !isNumInRange(patch.sensitive.ftsMinScore, 0, 1)
    ) {
      return "recall.sensitive.ftsMinScore 须在 0..1 之间";
    }
  }
  return null;
}

function validateRadarPatch(patch: Partial<RadarConfig>): string | null {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    return "radar.enabled 须为布尔值";
  }
  const numericBounds: Array<[keyof RadarConfig, number, number]> = [
    ["maxPairsDaily", 1, 100],
    ["maxPairsWeekly", 1, 100],
    ["topKPerCard", 1, 10],
    ["minSimilarity", 0, 1],
    ["concurrency", 1, 16],
    ["timeoutMs", 500, 120_000],
    ["maxFindingsDaily", 1, 20],
    ["maxFindingsWeekly", 1, 30],
  ];
  for (const [field, min, max] of numericBounds) {
    if (patch[field] !== undefined && !isNumInRange(patch[field], min, max)) {
      return `radar.${field} 须在 ${min}..${max} 之间`;
    }
  }
  if (patch.thresholds !== undefined) {
    if (!patch.thresholds || typeof patch.thresholds !== "object" || Array.isArray(patch.thresholds)) {
      return "radar.thresholds 须为对象";
    }
    for (const k of ["redundant", "contradiction", "obsolete", "link", "promote", "merge"] as const) {
      const v = patch.thresholds[k];
      if (v !== undefined && !isNumInRange(v, 0, 1)) {
        return `radar.thresholds.${k} 须在 0..1 之间`;
      }
    }
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

const MIN_BASH_MAX_OUTPUT_CHARS = 256;
const MAX_BASH_MAX_OUTPUT_CHARS = 64_000;
const MAX_BASH_ALLOWED_DIRS = 32;

async function validateBashPatch(
  patch: Partial<BashToolConfig>,
  dataDir?: string,
): Promise<{ ok: true; value: Partial<BashToolConfig> } | { ok: false; error: string }> {
  const out: Partial<BashToolConfig> = {};
  if (patch.timeoutMs !== undefined) {
    if (
      typeof patch.timeoutMs !== "number" ||
      !Number.isFinite(patch.timeoutMs) ||
      patch.timeoutMs < MIN_BASH_TIMEOUT_MS ||
      patch.timeoutMs > MAX_BASH_TIMEOUT_MS
    ) {
      return {
        ok: false,
        error: `bash.timeoutMs 须为 ${MIN_BASH_TIMEOUT_MS}..${MAX_BASH_TIMEOUT_MS} 之间的数字`,
      };
    }
    out.timeoutMs = Math.floor(patch.timeoutMs);
  }
  if (patch.maxOutputChars !== undefined) {
    if (
      typeof patch.maxOutputChars !== "number" ||
      !Number.isFinite(patch.maxOutputChars) ||
      patch.maxOutputChars < MIN_BASH_MAX_OUTPUT_CHARS ||
      patch.maxOutputChars > MAX_BASH_MAX_OUTPUT_CHARS
    ) {
      return {
        ok: false,
        error: `bash.maxOutputChars 须为 ${MIN_BASH_MAX_OUTPUT_CHARS}..${MAX_BASH_MAX_OUTPUT_CHARS} 之间的数字`,
      };
    }
    out.maxOutputChars = Math.floor(patch.maxOutputChars);
  }
  if (patch.allowedDirs !== undefined) {
    if (!Array.isArray(patch.allowedDirs)) {
      return { ok: false, error: "bash.allowedDirs 必须为字符串数组" };
    }
    if (patch.allowedDirs.length > MAX_BASH_ALLOWED_DIRS) {
      return { ok: false, error: `bash.allowedDirs 最多配置 ${MAX_BASH_ALLOWED_DIRS} 个目录` };
    }
    const homeDir = await resolveRealPathSafe(os.homedir());
    const policy = dataDir ? await buildBashPolicy(dataDir) : null;
    const deduped: string[] = [];
    const seenReal = new Set<string>();
    for (const raw of patch.allowedDirs) {
      if (typeof raw !== "string") {
        return { ok: false, error: "bash.allowedDirs 元素必须为字符串" };
      }
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (trimmed.includes("\0")) {
        return { ok: false, error: "bash.allowedDirs 路径包含非法空字符" };
      }
      const expanded = expandHomePath(trimmed);
      if (!path.isAbsolute(expanded)) {
        return { ok: false, error: `bash.allowedDirs 须使用绝对路径或 ~/ 开头：${trimmed}` };
      }
      const realDir = await resolveRealPathSafe(expanded);
      if (realDir === "/" || realDir === homeDir || (policy && realDir === policy.dataDir)) {
        return { ok: false, error: `禁止将根目录、主目录或实例数据根目录加入免审目录：${trimmed}` };
      }
      if (policy) {
        const hit = findProtectedPathHit(realDir, policy);
        if (hit) {
          return { ok: false, error: `禁止将受保护敏感路径（${path.basename(hit)}）加入免审目录：${trimmed}` };
        }
      }
      if (!seenReal.has(realDir)) {
        seenReal.add(realDir);
        deduped.push(trimmed);
      }
    }
    out.allowedDirs = deduped;
  }
  return { ok: true, value: out };
}

/** 注册配对、创世引导、媒体仓与脱敏设置子路由，避免 app.ts 单文件发散膨胀 */
export function registerAdminRoutes(app: Hono, deps: AppDeps): void {
  const resolveClientIp = (req: Request, xff?: string): string =>
    normalizeClientIp(
      deps.getClientIp?.(req) ??
        (deps.trustProxy ? xff?.split(",")[0]?.trim() : undefined) ??
        "direct",
    );

  const normalizeClientId = (raw: unknown): string | undefined => {
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (!/^[A-Za-z0-9._-]{8,64}$/.test(trimmed)) return undefined;
    return trimmed;
  };

  const persistPairedDevice = async (info: {
    deviceId: string;
    token: string;
    deviceName: string;
    platform: string;
    clientId?: string;
  }) => {
    const cfg = deps.getConfig();
    const now = deps.clock.now();
    const cleanName = info.deviceName.trim();
    const cleanPlatform = info.platform.trim();
    const cleanClientId = normalizeClientId(info.clientId);
    const tokenHash = hashBearerToken(info.token);

    const existing = cleanClientId
      ? cfg.auth.devices.find((d) => d.clientId === cleanClientId)
      : undefined;

    let finalDeviceId = info.deviceId;
    if (existing) {
      finalDeviceId = existing.deviceId;
      existing.tokenHash = tokenHash;
      existing.deviceName = cleanName;
      existing.platform = cleanPlatform;
      existing.lastSeenAt = now;
      // 轮换旧 Token 时顺手断开旧 SSE 连接，确保旧会话不会残留
      deps.sse?.disconnectDevices([existing.deviceId]);
    } else {
      cfg.auth.devices.push({
        deviceId: info.deviceId,
        ...(cleanClientId ? { clientId: cleanClientId } : {}),
        tokenHash,
        deviceName: cleanName,
        platform: cleanPlatform,
        createdAt: now,
        lastSeenAt: now,
      });
    }
    if (deps.dataDir) {
      await saveConfig(deps.dataDir, cfg);
    }
    return {
      deviceId: finalDeviceId,
      token: info.token,
      instanceId: cfg.instanceId,
      serverVersion: deps.version,
    };
  };

  // 一次性配对码兑换长期 Bearer Token（免鉴权，默认不信任可伪造的 x-forwarded-for）
  app.post("/api/v1/auth/pair", async (c) => {
    if (!deps.pairing) {
      return c.json({ error: { code: "PAIRING_UNAVAILABLE", message: "当前未启用配对服务" } }, 503);
    }
    let body: { code?: string; deviceName?: string; platform?: string; clientId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    if (!body.code || !body.deviceName || !body.platform) {
      return c.json({ error: { code: "INVALID_PAIR_REQUEST", message: "缺少 code、deviceName 或 platform" } }, 400);
    }

    const clientIp = resolveClientIp(c.req.raw, c.req.header("x-forwarded-for"));
    const res = deps.pairing.verifyAndConsume(body.code, clientIp);
    if (!res.ok) {
      return c.json({ error: { code: res.code, message: res.message } }, res.status);
    }

    return c.json(
      await persistPairedDevice({
        deviceId: res.deviceId,
        token: res.token,
        deviceName: body.deviceName,
        platform: body.platform,
        clientId: body.clientId,
      }),
    );
  });

  // 仅限本机桌面端免码配对：严格要求来源为回环 IP、无浏览器 Origin 头且携带 0600 local_pair.json 中的启动密钥
  app.post("/api/v1/auth/local-pair", async (c) => {
    if (!deps.pairing) {
      return c.json({ error: { code: "PAIRING_UNAVAILABLE", message: "当前未启用配对服务" } }, 503);
    }
    let body: { secret?: string; deviceName?: string; platform?: string; clientId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    if (!body.secret || !body.deviceName || !body.platform) {
      return c.json({ error: { code: "INVALID_PAIR_REQUEST", message: "缺少 secret、deviceName 或 platform" } }, 400);
    }
    const clientIp = resolveClientIp(c.req.raw, c.req.header("x-forwarded-for"));
    const res = deps.pairing.verifyLocalSecret(body.secret, clientIp);
    if (!res.ok) {
      return c.json({ error: { code: res.code, message: res.message } }, res.status);
    }
    return c.json(
      await persistPairedDevice({
        deviceId: res.deviceId,
        token: res.token,
        deviceName: body.deviceName,
        platform: body.platform,
        clientId: body.clientId,
      }),
    );
  });

  // 已配对设备签发新设备一次性配对码与扫码二维码载荷（需 Bearer Token 鉴权）
  app.post("/api/v1/auth/pair-code", (c) => {
    if (!deps.pairing) {
      return c.json({ error: { code: "PAIRING_UNAVAILABLE", message: "当前未启用配对服务" } }, 503);
    }
    const issued = deps.pairing.issueCode();
    const urls = deps.getPairUrls?.() ?? [];
    const qrPayload = buildPairQrPayload(urls, issued.code);
    return c.json({
      code: issued.code,
      expiresAt: issued.expiresAt,
      urls,
      qrPayload,
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
    return c.json(sanitizeSettings(cfg, creds, deps, identity));
  });

  app.patch("/api/v1/settings", async (c) => {
    let body: {
      timezone?: string;
      circadian?: Partial<CircadianConfig>;
      notifications?: Partial<NotificationsConfig>;
      notificationSecrets?: { barkDeviceKey?: string; ntfyToken?: string };
      recall?: Partial<RecallConfig>;
      radar?: Partial<RadarConfig>;
      llm?: Partial<LlmConfig> & {
        deleteProviderIds?: string[];
        apiKeys?: Record<string, string>;
      };
      credentials?: Record<string, { apiKey?: string }>;
      bash?: Partial<BashToolConfig>;
      mcpServers?: McpServerConfig[];
      mcpSecrets?: Record<string, string>;
      memoryMcp?: Partial<MemoryMcpConfig>;
      disabledTools?: string[];
      revokeDeviceIds?: string[];
      recallEvalNoticeResident?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }

    if (body.circadian !== undefined) {
      if (!body.circadian || typeof body.circadian !== "object" || Array.isArray(body.circadian)) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: "circadian 配置必须为对象" } }, 400);
      }
      const err = validateCircadianPatch(body.circadian);
      if (err) return c.json({ error: { code: "INVALID_SETTINGS", message: err } }, 400);
    }
    if (body.recall !== undefined) {
      if (!body.recall || typeof body.recall !== "object" || Array.isArray(body.recall)) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: "recall 配置必须为对象" } }, 400);
      }
      const err = validateRecallPatch(body.recall);
      if (err) return c.json({ error: { code: "INVALID_SETTINGS", message: err } }, 400);
    }
    if (body.radar !== undefined) {
      if (!body.radar || typeof body.radar !== "object" || Array.isArray(body.radar)) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: "radar 配置必须为对象" } }, 400);
      }
      const err = validateRadarPatch(body.radar);
      if (err) return c.json({ error: { code: "INVALID_SETTINGS", message: err } }, 400);
    }
    if (body.notifications !== undefined) {
      if (!body.notifications || typeof body.notifications !== "object" || Array.isArray(body.notifications)) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: "notifications 配置必须为对象" } }, 400);
      }
      const err = validateNotificationsPatch(body.notifications);
      if (err) return c.json({ error: { code: "INVALID_SETTINGS", message: err } }, 400);
    }
    let validatedBash: Partial<BashToolConfig> | null = null;
    if (body.bash !== undefined) {
      if (!body.bash || typeof body.bash !== "object" || Array.isArray(body.bash)) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: "bash 配置必须为对象" } }, 400);
      }
      const checked = await validateBashPatch(body.bash, deps.dataDir);
      if (!checked.ok) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: checked.error } }, 400);
      }
      validatedBash = checked.value;
    }
    let validatedMcpServers: McpServerConfig[] | null = null;
    if (body.mcpServers !== undefined) {
      const checked = validateMcpServers(body.mcpServers);
      if (!checked.ok) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: checked.error } }, 400);
      }
      validatedMcpServers = checked.servers;
    }
    if (body.memoryMcp !== undefined) {
      if (!body.memoryMcp || typeof body.memoryMcp !== "object" || Array.isArray(body.memoryMcp)) {
        return c.json({ error: { code: "INVALID_SETTINGS", message: "memoryMcp 配置必须为对象" } }, 400);
      }
      const err = validateMemoryMcpPatch(body.memoryMcp);
      if (err) return c.json({ error: { code: "INVALID_SETTINGS", message: err } }, 400);
    }

    const cfg = deps.getConfig();
    const prevMemoryMcpEnabled = Boolean(cfg.memoryMcp?.enabled);
    if (typeof body.timezone === "string" && body.timezone.trim()) {
      cfg.timezone = body.timezone.trim();
    }
    if (typeof body.recallEvalNoticeResident === "boolean") {
      cfg.recallEvalNoticeResident = body.recallEvalNoticeResident;
    }
    if (body.circadian && typeof body.circadian === "object" && !Array.isArray(body.circadian)) {
      cfg.circadian = { ...(cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG), ...body.circadian };
    }
    if (body.notifications && typeof body.notifications === "object" && !Array.isArray(body.notifications)) {
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
    if (body.recall && typeof body.recall === "object" && !Array.isArray(body.recall)) {
      cfg.recall = mergeRecallConfig(cfg.recall, body.recall);
    }
    if (body.radar && typeof body.radar === "object" && !Array.isArray(body.radar)) {
      cfg.radar = mergeRadarConfig(cfg.radar, body.radar);
    }
    if (validatedBash !== null) {
      cfg.bash = {
        ...(cfg.bash ?? {}),
        ...(validatedBash.allowedDirs !== undefined ? { allowedDirs: validatedBash.allowedDirs } : {}),
        ...(validatedBash.timeoutMs !== undefined ? { timeoutMs: validatedBash.timeoutMs } : {}),
        ...(validatedBash.maxOutputChars !== undefined ? { maxOutputChars: validatedBash.maxOutputChars } : {}),
      };
    }
    if (body.llm && typeof body.llm === "object") {
      const rawLevel = body.llm.thinking?.level;
      if (
        rawLevel !== undefined &&
        rawLevel !== "auto" &&
        rawLevel !== "off" &&
        rawLevel !== "low" &&
        rawLevel !== "medium" &&
        rawLevel !== "high"
      ) {
        return c.json(
          { error: { code: "INVALID_SETTINGS", message: "llm.thinking.level 须为 auto/off/low/medium/high" } },
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
      const nextProviders = { ...(cfg.llm?.providers ?? {}), ...(body.llm.providers ?? {}) };
      if (Array.isArray(body.llm.deleteProviderIds)) {
        for (const pid of body.llm.deleteProviderIds) {
          if (typeof pid === "string" && pid.trim()) {
            delete nextProviders[pid.trim()];
          }
        }
      }
      const nextSlots: Record<string, unknown> = {
        ...(cfg.llm?.slots ?? {}),
        ...(body.llm.slots ?? {}),
      };
      for (const [k, v] of Object.entries(nextSlots)) {
        if (v === null) {
          delete nextSlots[k];
        }
      }
      cfg.llm = {
        providers: nextProviders,
        slots: nextSlots as LlmConfig["slots"],
        thinking: mergedThinking,
        ...(mergedLimits ? { contextLimits: mergedLimits } : {}),
      };
    }
    if (validatedMcpServers !== null) {
      cfg.mcpServers = validatedMcpServers;
    }
    if (body.memoryMcp && typeof body.memoryMcp === "object" && !Array.isArray(body.memoryMcp)) {
      const { tokens: _ignoredTokens, ...patchWithoutTokens } = body.memoryMcp;
      cfg.memoryMcp = mergeMemoryMcpConfig(cfg.memoryMcp, patchWithoutTokens);
    }
    if (Array.isArray(body.disabledTools)) {
      const sanitizedDisabled = body.disabledTools
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim())
        .filter((t) => {
          const reg = deps.toolRegistry?.get(t);
          return !reg || reg.tier !== 1;
        });
      cfg.disabledTools = Array.from(new Set(sanitizedDisabled));
      deps.toolRegistry?.setDisabledTools(cfg.disabledTools);
    }
    if (Array.isArray(body.revokeDeviceIds) && body.revokeDeviceIds.length > 0) {
      const toRevoke = new Set(
        body.revokeDeviceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0),
      );
      cfg.auth.devices = (cfg.auth.devices ?? []).filter((d) => !toRevoke.has(d.deviceId));
      // 对齐 Spec 04 §1.1：吊销设备后立即踢断其全部活跃 SSE 长连接
      deps.sse?.disconnectDevices(toRevoke);
    }

    let creds: StoredCredentials = { apiKeys: {}, channelTokens: {}, mcpSecrets: {} };
    if (deps.dataDir) {
      creds = await loadCredentials(deps.dataDir);
      let credsChanged = false;
      if (Array.isArray(body.llm?.deleteProviderIds)) {
        for (const pid of body.llm.deleteProviderIds) {
          if (typeof pid === "string" && pid.trim() && creds.apiKeys[pid.trim()]) {
            delete creds.apiKeys[pid.trim()];
            credsChanged = true;
          }
        }
      }
      if (body.credentials && typeof body.credentials === "object") {
        for (const [provider, entry] of Object.entries(body.credentials)) {
          if (entry && typeof entry.apiKey === "string" && entry.apiKey.trim()) {
            creds.apiKeys[provider] = entry.apiKey.trim();
            credsChanged = true;
          }
        }
      }
      // 兼容客户端通过 llm.apiKeys 扁平字典提交的 API Key
      if (body.llm?.apiKeys && typeof body.llm.apiKeys === "object") {
        for (const [provider, rawKey] of Object.entries(body.llm.apiKeys)) {
          if (typeof rawKey === "string" && rawKey.trim()) {
            creds.apiKeys[provider] = rawKey.trim();
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

    const nextMemoryMcpEnabled = Boolean(cfg.memoryMcp?.enabled);
    if (prevMemoryMcpEnabled !== nextMemoryMcpEnabled) {
      await deps.onMemoryMcpTransition?.(prevMemoryMcpEnabled, nextMemoryMcpEnabled);
    }

    deps.onSettingsUpdated?.();
    const identity = deps.dataDir
      ? await readIdentityProfile(deps.dataDir, deps.clock.now(), cfg.timezone)
      : undefined;
    return c.json({ ok: true, settings: sanitizeSettings(cfg, creds, deps, identity) });
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
    const models = await discoverProviderModels(
      deps.getConfig(),
      creds,
      provider,
      deps.fetchImpl,
      deps.modelCatalog,
    );
    return c.json({ models });
  });

  // 手动同步 models.dev 模型元数据目录到本地缓存
  app.post("/api/v1/llm/catalog/sync", async (c) => {
    if (!deps.modelCatalog) {
      return c.json({ error: { code: "CATALOG_UNAVAILABLE", message: "模型目录服务未就绪" } }, 503);
    }
    const res = await deps.modelCatalog.syncFromRemote({
      fetchImpl: deps.fetchImpl,
      nowMs: deps.clock.now(),
    });
    return c.json(res, res.ok ? 200 : 502);
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
      clientFactory:
        deps.llmTestClientFactory ??
        ((resolved) => buildPiAiChatClient(resolved, deps.modelCatalog)),
      fetchImpl: deps.fetchImpl,
    });
    return c.json(result);
  });

  // Ring 1.5 设置页独立消耗统计（支持 ?days=1|7|30|90 范围筛选）
  app.get("/api/v1/usage/stats", (c) => {
    const cfg = deps.getConfig();
    const rawDays = c.req.query("days")?.trim();
    const parsedDays = rawDays && /^\d+$/.test(rawDays) ? Number(rawDays) : undefined;
    return c.json(deps.events.getUsageStats(cfg.timezone, { days: parsedDays }));
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

  // 对外记忆 MCP 专属访问令牌签发与吊销（明文仅创建时返回一次，落盘仅存 SHA-256 哈希）
  app.post("/api/v1/memory-mcp/tokens", async (c) => {
    let body: { name?: unknown; accessMode?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 48) {
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "令牌名称 name 须为 1..48 字符" } },
        400,
      );
    }
    let accessMode: MemoryMcpAccessMode | undefined;
    if (body.accessMode !== undefined) {
      if (body.accessMode !== "read_only" && body.accessMode !== "read_write") {
        return c.json(
          { error: { code: "INVALID_REQUEST", message: "accessMode 须为 read_only 或 read_write" } },
          400,
        );
      }
      accessMode = body.accessMode;
    }

    const createdAt = deps.clock.now();
    const { rawToken, entry: tokenEntry } = issueMemoryMcpToken(name, createdAt, accessMode);

    const cfg = deps.getConfig();
    const current = mergeMemoryMcpConfig(cfg.memoryMcp);
    cfg.memoryMcp = mergeMemoryMcpConfig(current, {
      tokens: [...current.tokens, tokenEntry],
    });
    if (deps.dataDir) {
      await saveConfig(deps.dataDir, cfg);
    }

    return c.json(
      {
        ok: true,
        token: rawToken,
        tokenInfo: {
          id: tokenEntry.id,
          name: tokenEntry.name,
          ...(tokenEntry.accessMode ? { accessMode: tokenEntry.accessMode } : {}),
          createdAt: tokenEntry.createdAt,
        },
        endpoint: "/mcp",
      },
      201,
    );
  });

  app.delete("/api/v1/memory-mcp/tokens/:id", async (c) => {
    const id = c.req.param("id").trim();
    const cfg = deps.getConfig();
    const current = mergeMemoryMcpConfig(cfg.memoryMcp);
    const nextTokens = current.tokens.filter((t) => t.id !== id);
    if (nextTokens.length === current.tokens.length) {
      return c.json({ error: { code: "NOT_FOUND", message: `未找到记忆 MCP 令牌: ${id}` } }, 404);
    }
    cfg.memoryMcp = mergeMemoryMcpConfig(current, { tokens: nextTokens });
    if (deps.dataDir) {
      await saveConfig(deps.dataDir, cfg);
    }
    return c.json({ ok: true, revokedId: id });
  });
}
