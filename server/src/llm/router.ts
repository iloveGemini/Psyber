import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import type { ModelRef, PsyberConfig, ThinkingLevel } from "../core/config.ts";
import { loadCredentials, type StoredCredentials } from "../core/credentials.ts";
import {
  PiAiChatClient,
  type ChatModelClient,
  type ChatStreamChunk,
  type ChatStreamRequest,
} from "./client.ts";

export type LlmSlotName = "chat" | "memory_task";

export type ProviderKind = "anthropic" | "openai" | "google" | "openai-compat";

export interface ResolvedByokSlot {
  providerId: string;
  kind: ProviderKind;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ResolveSlotResult =
  | { ok: true; slot: ResolvedByokSlot }
  | { ok: false; reason: string };

export interface DiscoveredModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevels?: ThinkingLevel[];
}

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** 归一化思考深度档位（兼容旧版 thinking.enabled 布尔字段） */
export function resolveEffectiveThinkingLevel(config: PsyberConfig): ThinkingLevel {
  const level = config.llm?.thinking?.level;
  if (level === "off" || level === "low" || level === "medium" || level === "high") {
    return level;
  }
  return config.llm?.thinking?.enabled === false ? "off" : "medium";
}

function resolveModelRef(
  config: PsyberConfig,
  creds: StoredCredentials,
  ref: ModelRef | undefined,
): ResolveSlotResult {
  if (!ref || !ref.provider?.trim() || !ref.model?.trim()) {
    return {
      ok: false,
      reason: "尚未配置主对话模型槽位，请先完成 Genesis 或在设置中填入模型与 API Key",
    };
  }

  const providerId = ref.provider.trim();
  const providerCfg = config.llm?.providers?.[providerId];
  if (!providerCfg) {
    return {
      ok: false,
      reason: `模型槽位引用了未注册的 Provider: ${providerId}`,
    };
  }

  const apiKey = creds.apiKeys[providerId]?.trim() ?? "";
  if (!apiKey) {
    return {
      ok: false,
      reason: `尚未配置 ${providerId} 的 API Key，请先在 Genesis 或设置中填入凭证`,
    };
  }

  const baseUrl = providerCfg.baseUrl?.trim() || undefined;
  if (providerCfg.kind === "openai-compat" && !baseUrl) {
    return {
      ok: false,
      reason: `openai-compat 类型的 Provider (${providerId}) 必须配置 baseUrl`,
    };
  }

  return {
    ok: true,
    slot: {
      providerId,
      kind: providerCfg.kind,
      modelId: ref.model.trim(),
      apiKey,
      baseUrl,
      temperature: ref.temperature,
      maxTokens: ref.maxTokens,
    },
  };
}

/**
 * 按当前配置与 0600 凭证解析目标槽位（memory_task 缺省自动共用 chat 槽位）。
 */
export function resolveByokSlot(
  config: PsyberConfig,
  creds: StoredCredentials,
  slot: LlmSlotName = "chat",
): ResolveSlotResult {
  const slots = config.llm?.slots;
  const ref = slot === "memory_task" ? (slots?.memory_task ?? slots?.chat) : slots?.chat;
  return resolveModelRef(config, creds, ref);
}

/**
 * 解析主模型 + 有效备用降级链（仅对 chat 槽位启用 fallbacks，跳过未配凭证或重复项）。
 */
export function resolveByokSlotChain(
  config: PsyberConfig,
  creds: StoredCredentials,
  slot: LlmSlotName = "chat",
): { ok: true; chain: ResolvedByokSlot[] } | { ok: false; reason: string } {
  const primary = resolveByokSlot(config, creds, slot);
  if (!primary.ok) return primary;

  const chain: ResolvedByokSlot[] = [primary.slot];
  if (slot === "chat" && Array.isArray(config.llm?.slots?.fallbacks)) {
    const seen = new Set<string>([`${primary.slot.providerId}:${primary.slot.modelId}`]);
    for (const fb of config.llm.slots.fallbacks) {
      const resolved = resolveModelRef(config, creds, fb);
      if (!resolved.ok) continue;
      const key = `${resolved.slot.providerId}:${resolved.slot.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push(resolved.slot);
    }
  }
  return { ok: true, chain };
}

function buildFallbackModel(resolved: ResolvedByokSlot): Model<Api> {
  if (resolved.kind === "anthropic") {
    return {
      id: resolved.modelId,
      name: resolved.modelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: resolved.baseUrl ?? "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 200_000,
      maxTokens: resolved.maxTokens ?? 8192,
    };
  }
  if (resolved.kind === "openai") {
    return {
      id: resolved.modelId,
      name: resolved.modelId,
      api: "openai-responses",
      provider: "openai",
      baseUrl: resolved.baseUrl ?? "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 128_000,
      maxTokens: resolved.maxTokens ?? 4096,
    };
  }
  if (resolved.kind === "google") {
    return {
      id: resolved.modelId,
      name: resolved.modelId,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: resolved.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 1_000_000,
      maxTokens: resolved.maxTokens ?? 8192,
    };
  }
  return {
    id: resolved.modelId,
    name: resolved.modelId,
    api: "openai-completions",
    provider: resolved.providerId,
    baseUrl: resolved.baseUrl ?? "",
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 128_000,
    maxTokens: resolved.maxTokens ?? 4096,
  };
}

/**
 * 基于 @earendil-works/pi-ai 构建可执行的流式模型客户端（支持 anthropic / openai / google / openai-compat）。
 */
export function buildPiAiChatClient(resolved: ResolvedByokSlot): PiAiChatClient {
  const models = createModels();
  let model: Model<Api>;

  if (resolved.kind === "anthropic") {
    models.setProvider(anthropicProvider());
    const catalog = models.getModel("anthropic", resolved.modelId);
    model = catalog
      ? { ...catalog, ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}) }
      : buildFallbackModel(resolved);
  } else if (resolved.kind === "openai") {
    models.setProvider(openaiProvider());
    const catalog = models.getModel("openai", resolved.modelId);
    model = catalog
      ? { ...catalog, ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}) }
      : buildFallbackModel(resolved);
  } else if (resolved.kind === "google") {
    models.setProvider(googleProvider());
    const catalog = models.getModel("google", resolved.modelId);
    model = catalog
      ? { ...catalog, ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}) }
      : buildFallbackModel(resolved);
  } else {
    model = buildFallbackModel(resolved);
    models.setProvider(
      createProvider({
        id: resolved.providerId,
        name: resolved.providerId,
        baseUrl: resolved.baseUrl,
        auth: {
          apiKey: envApiKeyAuth(`${resolved.providerId} API Key`, []),
        },
        models: [model],
        api: openAICompletionsApi(),
      }),
    );
  }

  return new PiAiChatClient(models, model, resolved.apiKey);
}

/**
 * 模型自动发现（GET /api/v1/llm/models）：
 * - 官方提供商直接读取 @earendil-works/pi-ai 内置目录（零外网延迟）；
 * - openai-compat 在有 baseUrl + apiKey 时尝试请求 GET <baseUrl>/models（5s 超时），失败温和回退已配置模型。
 */
export async function discoverProviderModels(
  config: PsyberConfig,
  creds: StoredCredentials,
  providerFilter?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModelInfo[]> {
  const providers = config.llm?.providers ?? {};
  const entries = providerFilter
    ? Object.entries(providers).filter(([id]) => id === providerFilter)
    : Object.entries(providers);

  const results: DiscoveredModelInfo[] = [];
  const seen = new Set<string>();
  const addUnique = (item: DiscoveredModelInfo) => {
    const key = `${item.provider}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  for (const [providerId, p] of entries) {
    if (p.kind === "anthropic" || p.kind === "openai" || p.kind === "google") {
      const models = createModels();
      if (p.kind === "anthropic") models.setProvider(anthropicProvider());
      else if (p.kind === "openai") models.setProvider(openaiProvider());
      else models.setProvider(googleProvider());

      const list = models.getModels(p.kind);
      for (const m of list.slice(0, 40)) {
        addUnique({
          id: m.id,
          name: m.name || m.id,
          provider: providerId,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          thinkingLevels: m.reasoning ? ["off", "low", "medium", "high"] : ["off"],
        });
      }
    } else if (p.kind === "openai-compat" && p.baseUrl) {
      const apiKey = creds.apiKeys[providerId]?.trim() ?? "";
      if (apiKey) {
        try {
          const url = `${p.baseUrl.replace(/\/+$/, "")}/models`;
          const res = await fetchImpl(url, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const json = (await res.json()) as { data?: Array<{ id?: string }> };
            if (Array.isArray(json.data)) {
              for (const item of json.data.slice(0, 60)) {
                if (typeof item?.id === "string" && item.id.trim()) {
                  addUnique({
                    id: item.id.trim(),
                    name: item.id.trim(),
                    provider: providerId,
                    thinkingLevels: ["off", "low", "medium", "high"],
                  });
                }
              }
            }
          }
        } catch {
          // 兼容网关不支持 /models 时静默降级至已配置模型
        }
      }
    }
  }

  // 确保当前已配置的 chat 与 fallbacks 模型总在清单中可见
  const configuredRefs: ModelRef[] = [
    ...(config.llm?.slots?.chat ? [config.llm.slots.chat] : []),
    ...(config.llm?.slots?.fallbacks ?? []),
  ];
  for (const ref of configuredRefs) {
    if (providerFilter && ref.provider !== providerFilter) continue;
    if (ref.provider && ref.model) {
      addUnique({
        id: ref.model,
        name: ref.model,
        provider: ref.provider,
        thinkingLevels: ["off", "low", "medium", "high"],
      });
    }
  }

  return results;
}

/**
 * 一键模型连通测试（POST /api/v1/llm/test）：发极短探测请求并记录耗时。
 */
export async function testModelConnection(opts: {
  config: PsyberConfig;
  creds: StoredCredentials;
  providerId: string;
  modelId: string;
  clientFactory?: (resolved: ResolvedByokSlot) => ChatModelClient;
}): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  const resolved = resolveModelRef(opts.config, opts.creds, {
    provider: opts.providerId,
    model: opts.modelId,
    maxTokens: 16,
  });
  if (!resolved.ok) {
    return { ok: false, latencyMs: Date.now() - start, error: resolved.reason };
  }
  const client = (opts.clientFactory ?? buildPiAiChatClient)(resolved.slot);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    for await (const chunk of client.stream({
      systemPrompt: "Reply with OK.",
      messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
      tools: [],
      maxTokens: 16,
      thinkingLevel: "off",
      signal: ac.signal,
    })) {
      if (chunk.type === "error") {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          error: chunk.message,
        };
      }
      if (chunk.type === "text_delta" && chunk.delta.length > 0) {
        return { ok: true, latencyMs: Date.now() - start };
      }
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "连通测试失败",
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DynamicChatModelDeps {
  dataDir: string;
  getConfig: () => PsyberConfig;
  slot?: LlmSlotName;
  /** 可注入客户端构造工厂，供离线测试验证动态热更新与主备降级链而零外网调用 */
  clientFactory?: (resolved: ResolvedByokSlot) => ChatModelClient;
}

/**
 * 动态 BYOK 模型路由器（Ring 1.5 支持主备模型降级链）：
 * - 每次发轮前热读取 config.json + credentials.json，配置完 Genesis 或 PATCH /settings 后无需重启立即可用；
 * - 主模型在尚未产生输出前遇到 429 / 5xx 可重试错误时，按 slots.fallbacks 顺序自动无缝降级到备用模型；
 * - 按配置签名缓存底层 PiAiChatClient，配置不变时零重复构建开销。
 */
export class DynamicChatModel implements ChatModelClient {
  private readonly slot: LlmSlotName;
  private readonly clientFactory: (resolved: ResolvedByokSlot) => ChatModelClient;
  private readonly clientCache = new Map<string, ChatModelClient>();
  private activeClient: ChatModelClient | null = null;
  private activeModelId: string | undefined;

  constructor(private readonly deps: DynamicChatModelDeps) {
    this.slot = deps.slot ?? "chat";
    this.clientFactory = deps.clientFactory ?? buildPiAiChatClient;
  }

  get contextWindow(): number {
    return this.activeClient?.contextWindow ?? 200_000;
  }

  get modelId(): string | undefined {
    const slotRef =
      this.slot === "memory_task"
        ? (this.deps.getConfig().llm?.slots?.memory_task ?? this.deps.getConfig().llm?.slots?.chat)
        : this.deps.getConfig().llm?.slots?.chat;
    return this.activeModelId ?? this.activeClient?.modelId ?? slotRef?.model;
  }

  private getOrCreateClient(s: ResolvedByokSlot): ChatModelClient {
    const signature = [
      s.providerId,
      s.kind,
      s.baseUrl ?? "",
      s.modelId,
      s.apiKey,
      String(s.maxTokens ?? ""),
    ].join("|");
    let client = this.clientCache.get(signature);
    if (!client) {
      client = this.clientFactory(s);
      if (this.clientCache.size > 16) {
        this.clientCache.clear();
      }
      this.clientCache.set(signature, client);
    }
    return client;
  }

  async *stream(request: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
    const creds = await loadCredentials(this.deps.dataDir);
    const resolved = resolveByokSlotChain(this.deps.getConfig(), creds, this.slot);
    if (!resolved.ok) {
      yield {
        type: "error",
        code: "AUTH_EXPIRED",
        message: resolved.reason,
        retryable: false,
      };
      return;
    }

    const chain = resolved.chain;
    let lastErrorChunk: Extract<ChatStreamChunk, { type: "error" }> | null = null;

    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i]!;
      const client = this.getOrCreateClient(candidate);
      this.activeClient = client;
      this.activeModelId = candidate.modelId;

      let producedOutput = false;
      let retryableFail: Extract<ChatStreamChunk, { type: "error" }> | null = null;

      for await (const chunk of client.stream({
        ...request,
        temperature: request.temperature ?? candidate.temperature,
        maxTokens: request.maxTokens ?? candidate.maxTokens,
      })) {
        if (chunk.type === "error") {
          const canFallback =
            !producedOutput &&
            i < chain.length - 1 &&
            (chunk.code === "RATE_LIMITED" || chunk.code === "PROVIDER_ERROR");
          if (canFallback) {
            retryableFail = chunk;
            break;
          }
          yield chunk;
          return;
        }
        if (
          chunk.type === "text_delta" ||
          chunk.type === "thinking_delta" ||
          chunk.type === "tool_call"
        ) {
          producedOutput = true;
        }
        yield chunk;
      }

      if (retryableFail) {
        lastErrorChunk = retryableFail;
        continue;
      }
      return;
    }

    if (lastErrorChunk) {
      yield lastErrorChunk;
    }
  }
}
