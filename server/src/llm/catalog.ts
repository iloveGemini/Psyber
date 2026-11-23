import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, type ModelMetadataOverride } from "../core/config.ts";

export interface ModelCostSpec {
  /** 每百万输入 Token 价格（USD） */
  input: number;
  /** 每百万输出 Token 价格（USD） */
  output: number;
  /** 每百万缓存读取 Token 价格（USD，可选） */
  cacheRead?: number;
  /** 每百万缓存写入 Token 价格（USD，可选） */
  cacheWrite?: number;
}

export interface ModelMetadata {
  id: string;
  name: string;
  provider?: string;
  contextWindow: number;
  maxTokens: number;
  inputModalities: string[];
  outputModalities: string[];
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput?: boolean;
  cost?: ModelCostSpec;
  source: "override" | "catalog" | "snapshot" | "pi-ai" | "fallback";
}

interface CatalogCacheEntry {
  id: string;
  name: string;
  provider?: string;
  contextWindow: number;
  maxTokens: number;
  inputModalities: string[];
  outputModalities: string[];
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput?: boolean;
  cost?: ModelCostSpec;
}

interface CatalogCacheFile {
  version: 1;
  sourceUrl: string;
  updatedAt: number;
  models: CatalogCacheEntry[];
}

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 离线内置主流模型精简快照：
 * 保证无外网或首次启动时，openai-compat / 中转站模型也能自动匹配合理的上下文、最大输出与多模态能力，
 * 不再退化为硬编码 128k / 16k / 无推理。
 */
const BUILTIN_MODEL_SNAPSHOT: CatalogCacheEntry[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    contextWindow: 128_000,
    maxTokens: 16_384,
    inputModalities: ["text", "image", "audio"],
    outputModalities: ["text"],
    reasoning: false,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 2.5, output: 10, cacheRead: 1.25 },
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    provider: "openai",
    contextWindow: 128_000,
    maxTokens: 16_384,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    reasoning: false,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    contextWindow: 1_047_576,
    maxTokens: 32_768,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    reasoning: false,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 2, output: 8, cacheRead: 0.5 },
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    provider: "openai",
    contextWindow: 400_000,
    maxTokens: 128_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 1.25, output: 10, cacheRead: 0.125 },
  },
  {
    id: "o3",
    name: "o3",
    provider: "openai",
    contextWindow: 200_000,
    maxTokens: 100_000,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxTokens: 64_000,
    inputModalities: ["text", "image", "pdf"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxTokens: 64_000,
    inputModalities: ["text", "image", "pdf"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    provider: "anthropic",
    contextWindow: 200_000,
    maxTokens: 64_000,
    inputModalities: ["text", "image", "pdf"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    contextWindow: 200_000,
    maxTokens: 8_192,
    inputModalities: ["text", "image", "pdf"],
    outputModalities: ["text"],
    reasoning: false,
    toolCall: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    inputModalities: ["text", "image", "audio", "video", "pdf"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 1.25, output: 10, cacheRead: 0.31 },
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    inputModalities: ["text", "image", "audio", "video", "pdf"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375 },
  },
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    provider: "google",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    inputModalities: ["text", "image", "audio", "video", "pdf"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    provider: "google",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    inputModalities: ["text", "image", "audio", "video", "pdf"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
  },
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek",
    contextWindow: 128_000,
    maxTokens: 8_192,
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: false,
    toolCall: true,
    structuredOutput: true,
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07 },
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "deepseek",
    contextWindow: 128_000,
    maxTokens: 64_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    cost: { input: 0.55, output: 2.19, cacheRead: 0.14 },
  },
  {
    id: "qwen3-max",
    name: "Qwen3 Max",
    provider: "alibaba",
    contextWindow: 262_144,
    maxTokens: 32_768,
    inputModalities: ["text"],
    outputModalities: ["text"],
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
  },
];

/**
 * 归一化模型 ID，便于匹配中转站/聚合网关返回的各种前缀或后缀变体：
 * 例如 `custom/openai/gpt-4o-2024-11-20:free` -> `gpt-4o`
 */
export function normalizeModelKey(rawId: string): string {
  let s = rawId.trim().toLowerCase();
  if (!s) return "";
  // 去掉路由后缀（如 :free / :thinking / :exacto / :nitro）
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    s = s.slice(0, colonIdx);
  }
  // 去掉常见网关/厂商前缀（保留最后一段，例如 custom/openai/gpt-4o -> gpt-4o）
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    if (parts.length > 0) {
      s = parts[parts.length - 1]!;
    }
  }
  return s;
}

function stripVersionSuffix(key: string): string {
  return key
    .replace(/-(?:20\d{2}-?\d{2}-?\d{2}|20\d{6}|\d{4})$/, "")
    .replace(/-(?:preview|latest|exp|experimental|search|tts)$/, "");
}

function asStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  const cleaned = raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase());
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : fallback;
}

/**
 * 解析 models.dev/api.json（v1 格式：{ [providerId]: { id, name, models: { [modelId]: {...} } } }）。
 */
export function parseModelsDevPayload(raw: unknown): CatalogCacheEntry[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const entries: CatalogCacheEntry[] = [];
  const providersObj = raw as Record<string, unknown>;

  for (const [providerId, providerVal] of Object.entries(providersObj)) {
    if (!providerVal || typeof providerVal !== "object" || Array.isArray(providerVal)) continue;
    const modelsObj = (providerVal as { models?: unknown }).models;
    if (!modelsObj || typeof modelsObj !== "object" || Array.isArray(modelsObj)) continue;

    for (const [modelKey, modelVal] of Object.entries(modelsObj as Record<string, unknown>)) {
      if (!modelVal || typeof modelVal !== "object" || Array.isArray(modelVal)) continue;
      const m = modelVal as Record<string, unknown>;
      const id = typeof m.id === "string" && m.id.trim() ? m.id.trim() : modelKey;
      const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : id;
      const limit =
        m.limit && typeof m.limit === "object" ? (m.limit as Record<string, unknown>) : {};
      const contextWindow =
        typeof limit.context === "number" && Number.isFinite(limit.context) && limit.context > 0
          ? Math.floor(limit.context)
          : 0;
      const maxTokens =
        typeof limit.output === "number" && Number.isFinite(limit.output) && limit.output > 0
          ? Math.floor(limit.output)
          : 0;
      if (contextWindow === 0 && maxTokens === 0) continue;

      const modalities =
        m.modalities && typeof m.modalities === "object"
          ? (m.modalities as Record<string, unknown>)
          : {};
      const inputModalities = asStringArray(modalities.input, ["text"]);
      const outputModalities = asStringArray(modalities.output, ["text"]);

      const rawCost =
        m.cost && typeof m.cost === "object" ? (m.cost as Record<string, unknown>) : null;
      const cost: ModelCostSpec | undefined =
        rawCost &&
        typeof rawCost.input === "number" &&
        typeof rawCost.output === "number" &&
        Number.isFinite(rawCost.input) &&
        Number.isFinite(rawCost.output)
          ? {
              input: rawCost.input,
              output: rawCost.output,
              ...(typeof rawCost.cache_read === "number" && Number.isFinite(rawCost.cache_read)
                ? { cacheRead: rawCost.cache_read }
                : {}),
              ...(typeof rawCost.cache_write === "number" && Number.isFinite(rawCost.cache_write)
                ? { cacheWrite: rawCost.cache_write }
                : {}),
            }
          : undefined;

      entries.push({
        id,
        name,
        provider: providerId,
        contextWindow: contextWindow || 128_000,
        maxTokens: maxTokens || 16_384,
        inputModalities,
        outputModalities,
        reasoning: m.reasoning === true,
        toolCall: m.tool_call !== false,
        ...(typeof m.structured_output === "boolean"
          ? { structuredOutput: m.structured_output }
          : {}),
        ...(cost ? { cost } : {}),
      });
    }
  }
  return entries;
}

/**
 * 本地优先的模型元数据目录服务：
 * 1. 内置精简快照兜底（零外网即可识别常见模型上限与多模态能力）；
 * 2. 支持从 https://models.dev/api.json 拉取并落盘到 <dataDir>/model_catalog_cache.json；
 * 3. 解析优先级：用户手动覆写 > 缓存目录精确/归一化匹配 > 内置快照匹配 > null（交由调用方回退）。
 */
export class ModelCatalogService {
  private readonly cachePath: string | null;
  private updatedAt = 0;
  private catalogEntries: CatalogCacheEntry[] = [];
  private byExact = new Map<string, { entry: CatalogCacheEntry; source: "catalog" | "snapshot" }>();
  private byNormalized = new Map<
    string,
    { entry: CatalogCacheEntry; source: "catalog" | "snapshot" }
  >();
  private byStripped = new Map<
    string,
    { entry: CatalogCacheEntry; source: "catalog" | "snapshot" }
  >();
  private loaded = false;

  constructor(private readonly dataDir?: string) {
    this.cachePath = dataDir ? path.join(dataDir, "model_catalog_cache.json") : null;
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.byExact.clear();
    this.byNormalized.clear();
    this.byStripped.clear();

    const indexOne = (entry: CatalogCacheEntry, source: "catalog" | "snapshot") => {
      const exactKey = entry.id.trim().toLowerCase();
      if (exactKey) {
        this.byExact.set(exactKey, { entry, source });
        if (entry.provider) {
          this.byExact.set(`${entry.provider.toLowerCase()}/${exactKey}`, { entry, source });
        }
      }
      const norm = normalizeModelKey(entry.id);
      if (norm && !this.byNormalized.has(norm)) {
        this.byNormalized.set(norm, { entry, source });
      }
      const stripped = stripVersionSuffix(norm);
      if (stripped && !this.byStripped.has(stripped)) {
        this.byStripped.set(stripped, { entry, source });
      }
    };

    // 先写入缓存目录（优先级更高），再补入内置快照
    for (const entry of this.catalogEntries) {
      indexOne(entry, "catalog");
    }
    for (const entry of BUILTIN_MODEL_SNAPSHOT) {
      const exactKey = entry.id.trim().toLowerCase();
      if (!this.byExact.has(exactKey)) {
        indexOne(entry, "snapshot");
      }
    }
  }

  async loadFromDisk(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.cachePath) return;
    try {
      const raw = await fs.readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CatalogCacheFile>;
      if (parsed.version === 1 && Array.isArray(parsed.models)) {
        this.catalogEntries = parsed.models;
        this.updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
        this.rebuildIndex();
      }
    } catch {
      // 首次无缓存或文件损坏时静默回落内置快照
    }
  }

  getStatus(): { updatedAt: number; modelCount: number } {
    return {
      updatedAt: this.updatedAt,
      modelCount: this.catalogEntries.length > 0 ? this.catalogEntries.length : BUILTIN_MODEL_SNAPSHOT.length,
    };
  }

  isStale(nowMs = Date.now(), ttlMs = DEFAULT_CACHE_TTL_MS): boolean {
    if (this.updatedAt <= 0) return true;
    return nowMs - this.updatedAt >= ttlMs;
  }

  async syncFromRemote(opts: {
    fetchImpl?: typeof fetch;
    url?: string;
    nowMs?: number;
  } = {}): Promise<{ ok: boolean; count: number; updatedAt: number; error?: string }> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const url = opts.url ?? MODELS_DEV_API_URL;
    const nowMs = opts.nowMs ?? Date.now();
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          count: this.getStatus().modelCount,
          updatedAt: this.updatedAt,
          error: `拉取模型目录失败（HTTP ${res.status}）`,
        };
      }
      const payload = await res.json();
      const entries = parseModelsDevPayload(payload);
      if (entries.length === 0) {
        return {
          ok: false,
          count: this.getStatus().modelCount,
          updatedAt: this.updatedAt,
          error: "模型目录返回为空或格式不兼容",
        };
      }
      this.catalogEntries = entries;
      this.updatedAt = nowMs;
      this.loaded = true;
      this.rebuildIndex();

      if (this.dataDir && this.cachePath) {
        const cacheFile: CatalogCacheFile = {
          version: 1,
          sourceUrl: url,
          updatedAt: nowMs,
          models: entries,
        };
        await atomicWriteFile(this.dataDir, this.cachePath, JSON.stringify(cacheFile));
      }
      return { ok: true, count: entries.length, updatedAt: nowMs };
    } catch (err) {
      return {
        ok: false,
        count: this.getStatus().modelCount,
        updatedAt: this.updatedAt,
        error: err instanceof Error ? err.message : "同步模型目录失败",
      };
    }
  }

  lookup(
    modelId: string,
    opts: { providerHint?: string; override?: ModelMetadataOverride } = {},
  ): ModelMetadata | null {
    const raw = modelId.trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const norm = normalizeModelKey(raw);
    const stripped = stripVersionSuffix(norm);

    let hit =
      (opts.providerHint
        ? this.byExact.get(`${opts.providerHint.trim().toLowerCase()}/${lower}`)
        : undefined) ??
      this.byExact.get(lower) ??
      this.byNormalized.get(norm) ??
      this.byStripped.get(stripped);

    if (!hit && stripped.length >= 4) {
      // 最长前缀兜底匹配（如 gemini-3.8-flash-search -> gemini-3.8-flash）
      let bestKeyLen = 0;
      for (const [k, v] of this.byNormalized.entries()) {
        if (k.length >= 4 && (norm.startsWith(k) || stripped.startsWith(k)) && k.length > bestKeyLen) {
          hit = v;
          bestKeyLen = k.length;
        }
      }
    }

    const ov = opts.override;
    if (!hit && !ov) return null;

    const base = hit?.entry;
    const hasOverride = Boolean(
      ov &&
        (ov.contextWindow !== undefined ||
          ov.maxTokens !== undefined ||
          ov.inputModalities !== undefined ||
          ov.outputModalities !== undefined ||
          ov.reasoning !== undefined ||
          ov.toolCall !== undefined),
    );

    return {
      id: raw,
      name: base?.name ?? raw,
      provider: opts.providerHint ?? base?.provider,
      contextWindow: ov?.contextWindow ?? base?.contextWindow ?? 128_000,
      maxTokens: ov?.maxTokens ?? base?.maxTokens ?? 16_384,
      inputModalities: ov?.inputModalities ?? base?.inputModalities ?? ["text", "image"],
      outputModalities: ov?.outputModalities ?? base?.outputModalities ?? ["text"],
      reasoning: ov?.reasoning ?? base?.reasoning ?? false,
      toolCall: ov?.toolCall ?? base?.toolCall ?? true,
      ...(base?.structuredOutput !== undefined ? { structuredOutput: base.structuredOutput } : {}),
      ...(base?.cost ? { cost: base.cost } : {}),
      source: hasOverride ? "override" : (hit?.source ?? "fallback"),
    };
  }
}
