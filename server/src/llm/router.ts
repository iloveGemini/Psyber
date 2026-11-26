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

import type {
  ModelMetadataOverride,
  ModelRef,
  PsyberConfig,
  ThinkingLevel,
} from "../core/config.ts";
import { loadCredentials, type StoredCredentials } from "../core/credentials.ts";
import { ModelCatalogService, type ModelCostSpec } from "./catalog.ts";
import {
  PiAiChatClient,
  type ChatModelClient,
  type ChatStreamChunk,
  type ChatStreamRequest,
} from "./client.ts";
import { GeminiDecisionClient, isGeminiDecisionModel } from "./decision.ts";
import { buildEmbeddingClient, isEmbeddingModelId } from "./embedding.ts";
import { buildRerankerClient, isRerankerModelId } from "./reranker.ts";

export type LlmSlotName = "chat" | "memory_task" | "digest" | "decision" | "embedding" | "reranker";

export type ProviderKind = "anthropic" | "openai" | "google" | "openai-compat";

export interface ResolvedByokSlot {
  providerId: string;
  kind: ProviderKind;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  metadataOverride?: ModelMetadataOverride;
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
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  toolCall?: boolean;
  cost?: ModelCostSpec;
  source?: "override" | "catalog" | "snapshot" | "pi-ai" | "fallback";
  thinkingLevels?: ThinkingLevel[];
}

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** 组合外部 AbortSignal 与单次超时，若外部信号已处于 aborted 状态则立刻中止，绝不触发后续请求 */
export function withTimeoutSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }
  const safeMs = Math.max(1, Math.min(600_000, Number.isFinite(timeoutMs) ? timeoutMs : 10_000));
  const timer = setTimeout(() => controller.abort(), safeMs);
  const onAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/** 归一化思考深度档位（兼容旧版 thinking.enabled 布尔字段） */
export function resolveEffectiveThinkingLevel(config: PsyberConfig): ThinkingLevel {
  const level = config.llm?.thinking?.level;
  if (
    level === "auto" ||
    level === "off" ||
    level === "low" ||
    level === "medium" ||
    level === "high"
  ) {
    return level;
  }
  return config.llm?.thinking?.enabled === false ? "off" : "auto";
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

  const trimmedModelId = ref.model.trim();
  return {
    ok: true,
    slot: {
      providerId,
      kind: providerCfg.kind,
      modelId: trimmedModelId,
      apiKey,
      baseUrl,
      temperature: ref.temperature,
      maxTokens: ref.maxTokens,
      metadataOverride: providerCfg.modelOverrides?.[trimmedModelId],
    },
  };
}

/**
 * 按当前配置与 0600 凭证解析目标槽位：
 * - memory_task 缺省共用 chat
 * - digest 缺省回落 memory_task -> chat
 * - decision 缺省回落 digest -> memory_task -> chat
 * - embedding 严格不回落至 chat（未配置即返回 ok: false）
 */
export function resolveByokSlot(
  config: PsyberConfig,
  creds: StoredCredentials,
  slot: LlmSlotName = "chat",
): ResolveSlotResult {
  const slots = config.llm?.slots;
  if (slot === "embedding") {
    if (!slots?.embedding?.provider?.trim() || !slots?.embedding?.model?.trim()) {
      return { ok: false, reason: "尚未配置 embedding 向量模型槽位" };
    }
    return resolveModelRef(config, creds, slots.embedding);
  }
  if (slot === "reranker") {
    if (!slots?.reranker?.provider?.trim() || !slots?.reranker?.model?.trim()) {
      return { ok: false, reason: "尚未配置 reranker 精排模型槽位" };
    }
    return resolveModelRef(config, creds, slots.reranker);
  }
  const ref =
    slot === "decision"
      ? (slots?.decision ?? slots?.digest ?? slots?.memory_task ?? slots?.chat)
      : slot === "digest"
        ? (slots?.digest ?? slots?.memory_task ?? slots?.chat)
        : slot === "memory_task"
          ? (slots?.memory_task ?? slots?.chat)
          : slots?.chat;
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

/**
 * 兜底 / 自定义模型（尤其 openai-compat）的默认单步输出上限（单位：Token）。
 * 带思考链的推理模型会把 thinking tokens 计入 max_completion_tokens / max_tokens；
 * 若给太小（如 4096），模型极易把额度耗尽在思考链里导致 finish_reason=length 无正文/无工具调用。
 * 16384 在主流模型与中转站上限内留足思考与多步写卡空间，且可由 config.json 中槽位的 maxTokens 显式覆盖。
 */
export const DEFAULT_FALLBACK_MAX_TOKENS = 16_384;

const defaultCatalog = new ModelCatalogService();

function toPiAiInputModalities(modalities?: string[]): Array<"text" | "image"> {
  if (!modalities || modalities.length === 0) return ["text", "image"];
  const out: Array<"text" | "image"> = ["text"];
  if (modalities.includes("image")) out.push("image");
  return out;
}

function buildFallbackModel(
  resolved: ResolvedByokSlot,
  catalog: ModelCatalogService = defaultCatalog,
): Model<Api> {
  const meta = catalog.lookup(resolved.modelId, {
    providerHint: resolved.kind === "openai-compat" ? undefined : resolved.kind,
    override: resolved.metadataOverride,
  });
  const defaultMaxTokens =
    resolved.maxTokens ?? meta?.maxTokens ?? DEFAULT_FALLBACK_MAX_TOKENS;
  const resolvedCost = meta?.cost
    ? {
        input: meta.cost.input,
        output: meta.cost.output,
        cacheRead: meta.cost.cacheRead ?? 0,
        cacheWrite: meta.cost.cacheWrite ?? 0,
      }
    : ZERO_COST;
  const resolvedInput = toPiAiInputModalities(meta?.inputModalities);

  if (resolved.kind === "anthropic") {
    return {
      id: resolved.modelId,
      name: meta?.name ?? resolved.modelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: resolved.baseUrl ?? "https://api.anthropic.com",
      reasoning: meta?.reasoning ?? true,
      input: resolvedInput,
      cost: resolvedCost,
      contextWindow: meta?.contextWindow ?? 200_000,
      maxTokens: defaultMaxTokens,
    };
  }
  if (resolved.kind === "openai") {
    return {
      id: resolved.modelId,
      name: meta?.name ?? resolved.modelId,
      api: "openai-responses",
      provider: "openai",
      baseUrl: resolved.baseUrl ?? "https://api.openai.com/v1",
      reasoning: meta?.reasoning ?? true,
      input: resolvedInput,
      cost: resolvedCost,
      contextWindow: meta?.contextWindow ?? 128_000,
      maxTokens: defaultMaxTokens,
    };
  }
  if (resolved.kind === "google") {
    return {
      id: resolved.modelId,
      name: meta?.name ?? resolved.modelId,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: resolved.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
      reasoning: meta?.reasoning ?? true,
      input: resolvedInput,
      cost: resolvedCost,
      contextWindow: meta?.contextWindow ?? 1_000_000,
      maxTokens: defaultMaxTokens,
    };
  }
  return {
    id: resolved.modelId,
    name: meta?.name ?? resolved.modelId,
    api: "openai-completions",
    provider: resolved.providerId,
    baseUrl: resolved.baseUrl ?? "",
    reasoning: meta?.reasoning ?? false,
    input: resolvedInput,
    cost: resolvedCost,
    contextWindow: meta?.contextWindow ?? 128_000,
    maxTokens: defaultMaxTokens,
  };
}

/**
 * 基于 @earendil-works/pi-ai 构建可执行的流式模型客户端（支持 anthropic / openai / google / openai-compat）。
 */
export function buildPiAiChatClient(
  resolved: ResolvedByokSlot,
  catalog: ModelCatalogService = defaultCatalog,
): PiAiChatClient {
  const models = createModels();
  let model: Model<Api>;
  const ov = resolved.metadataOverride;

  const applyOverrides = (base: Model<Api>): Model<Api> => ({
    ...base,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...(ov?.contextWindow ? { contextWindow: ov.contextWindow } : {}),
    ...(ov?.reasoning !== undefined ? { reasoning: ov.reasoning } : {}),
    ...(ov?.inputModalities ? { input: toPiAiInputModalities(ov.inputModalities) } : {}),
    ...(resolved.maxTokens ?? ov?.maxTokens
      ? { maxTokens: resolved.maxTokens ?? ov?.maxTokens }
      : {}),
  });

  if (resolved.kind === "anthropic") {
    models.setProvider(anthropicProvider());
    const builtin = models.getModel("anthropic", resolved.modelId);
    model = builtin ? applyOverrides(builtin) : buildFallbackModel(resolved, catalog);
  } else if (resolved.kind === "openai") {
    models.setProvider(openaiProvider());
    const builtin = models.getModel("openai", resolved.modelId);
    model = builtin ? applyOverrides(builtin) : buildFallbackModel(resolved, catalog);
  } else if (resolved.kind === "google") {
    models.setProvider(googleProvider());
    const builtin = models.getModel("google", resolved.modelId);
    model = builtin ? applyOverrides(builtin) : buildFallbackModel(resolved, catalog);
  } else {
    model = buildFallbackModel(resolved, catalog);
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
  catalog: ModelCatalogService = defaultCatalog,
): Promise<DiscoveredModelInfo[]> {
  const providers = config.llm?.providers ?? {};
  const entries = providerFilter
    ? Object.entries(providers).filter(([id]) => id === providerFilter)
    : Object.entries(providers);

  const results: DiscoveredModelInfo[] = [];
  const seen = new Set<string>();
  const enrich = (
    providerId: string,
    modelId: string,
    base?: Partial<DiscoveredModelInfo>,
  ): DiscoveredModelInfo => {
    const pCfg = providers[providerId];
    const meta = catalog.lookup(modelId, {
      providerHint: pCfg && pCfg.kind !== "openai-compat" ? pCfg.kind : undefined,
      override: pCfg?.modelOverrides?.[modelId],
    });
    const reasoning = meta?.reasoning ?? base?.reasoning ?? false;
    return {
      id: modelId,
      name: base?.name ?? meta?.name ?? modelId,
      provider: providerId,
      contextWindow: meta?.contextWindow ?? base?.contextWindow,
      maxTokens: meta?.maxTokens ?? base?.maxTokens,
      inputModalities: meta?.inputModalities ?? base?.inputModalities ?? ["text"],
      outputModalities: meta?.outputModalities ?? base?.outputModalities ?? ["text"],
      reasoning,
      toolCall: meta?.toolCall ?? base?.toolCall ?? true,
      ...(meta?.cost ? { cost: meta.cost } : {}),
      source: meta?.source ?? base?.source ?? "fallback",
      thinkingLevels: reasoning ? ["auto", "off", "low", "medium", "high"] : ["off"],
    };
  };

  const addUnique = (item: DiscoveredModelInfo) => {
    const key = `${item.provider}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  for (const [providerId, p] of entries) {
    for (const mId of p.models ?? []) {
      if (typeof mId === "string" && mId.trim()) {
        addUnique(enrich(providerId, mId.trim()));
      }
    }
    if (p.kind === "anthropic" || p.kind === "openai" || p.kind === "google") {
      const apiKey = creds.apiKeys[providerId]?.trim() ?? "";
      // 若已配置 API Key，优先拉取官网实时 /models 列表（5s 超时，失败静默回落内置目录）
      if (apiKey) {
        try {
          if (p.kind === "google") {
            const base = (p.baseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
            const url = `${base}/models?pageSize=200`;
            const res = await fetchImpl(url, {
              headers: { "x-goog-api-key": apiKey },
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const json = (await res.json()) as {
                models?: Array<{
                  name?: string;
                  displayName?: string;
                  inputTokenLimit?: number;
                  outputTokenLimit?: number;
                  supportedGenerationMethods?: string[];
                }>;
              };
              if (Array.isArray(json.models)) {
                for (const m of json.models) {
                  const rawName = typeof m?.name === "string" ? m.name.trim() : "";
                  if (!rawName) continue;
                  const id = rawName.replace(/^models\//, "");
                  if (!id) continue;
                  addUnique(
                    enrich(providerId, id, {
                      name: m.displayName?.trim() || id,
                      contextWindow: m.inputTokenLimit,
                      maxTokens: m.outputTokenLimit,
                      source: "catalog",
                    }),
                  );
                }
              }
            }
          } else if (p.kind === "openai") {
            const base = (p.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
            const res = await fetchImpl(`${base}/models`, {
              headers: { authorization: `Bearer ${apiKey}` },
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const json = (await res.json()) as { data?: Array<{ id?: string }> };
              if (Array.isArray(json.data)) {
                for (const item of json.data.slice(0, 150)) {
                  if (typeof item?.id === "string" && item.id.trim()) {
                    addUnique(enrich(providerId, item.id.trim()));
                  }
                }
              }
            }
          } else if (p.kind === "anthropic") {
            const base = (p.baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
            const url = base.endsWith("/v1") ? `${base}/models?limit=100` : `${base}/v1/models?limit=100`;
            const res = await fetchImpl(url, {
              headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
              },
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const json = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
              if (Array.isArray(json.data)) {
                for (const item of json.data) {
                  if (typeof item?.id === "string" && item.id.trim()) {
                    addUnique(
                      enrich(providerId, item.id.trim(), {
                        name: item.display_name?.trim() || item.id.trim(),
                      }),
                    );
                  }
                }
              }
            }
          }
        } catch {
          // 网络受限或网关不支持 /models 时静默回落 pi-ai 内置目录
        }
      }

      const models = createModels();
      if (p.kind === "anthropic") models.setProvider(anthropicProvider());
      else if (p.kind === "openai") models.setProvider(openaiProvider());
      else models.setProvider(googleProvider());

      const list = models.getModels(p.kind);
      for (const m of list) {
        addUnique(
          enrich(providerId, m.id, {
            name: m.name || m.id,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            inputModalities: m.input,
            outputModalities: ["text"],
            reasoning: m.reasoning,
            source: "pi-ai",
          }),
        );
      }
      if (p.kind === "google") {
        addUnique({
          id: "gemini-decision-1",
          name: "Gemini Decision 1 (Decisions API)",
          provider: providerId,
          contextWindow: 262_144,
          maxTokens: 0,
          inputModalities: ["text", "image", "audio", "video"],
          outputModalities: ["decision"],
          reasoning: false,
          toolCall: false,
          cost: { input: 0.1, output: 0 },
          source: "fallback",
          thinkingLevels: ["off"],
        });
      }
    } else if (p.baseUrl) {
      const apiKey = creds.apiKeys[providerId]?.trim() ?? "";
      try {
        const url = `${p.baseUrl.replace(/\/+$/, "")}/models`;
        const headers: Record<string, string> = {};
        if (apiKey) {
          headers.authorization = `Bearer ${apiKey}`;
        }
        const res = await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            data?: Array<{ id?: string; name?: string }>;
            models?: Array<{ id?: string; name?: string; displayName?: string }>;
          };
          if (Array.isArray(json.data)) {
            for (const item of json.data.slice(0, 200)) {
              if (typeof item?.id === "string" && item.id.trim()) {
                addUnique(
                  enrich(providerId, item.id.trim(), {
                    ...(typeof item.name === "string" && item.name.trim()
                      ? { name: item.name.trim() }
                      : {}),
                  }),
                );
              }
            }
          } else if (Array.isArray(json.models)) {
            for (const item of json.models.slice(0, 200)) {
              const rawId =
                (typeof item?.id === "string" && item.id.trim()) ||
                (typeof item?.name === "string" && item.name.trim().replace(/^models\//, "")) ||
                "";
              if (rawId) {
                addUnique(
                  enrich(providerId, rawId, {
                    ...(typeof item.displayName === "string" && item.displayName.trim()
                      ? { name: item.displayName.trim() }
                      : {}),
                  }),
                );
              }
            }
          }
        }
      } catch {
        // 兼容网关不支持 /models 时静默降级至已配置模型
      }
    }
  }

  const slots = config.llm?.slots;
  const configuredRefs: ModelRef[] = [
    ...(slots?.chat ? [slots.chat] : []),
    ...(slots?.fallbacks ?? []),
    ...(slots?.memory_task ? [slots.memory_task] : []),
    ...(slots?.digest ? [slots.digest] : []),
    ...(slots?.decision ? [slots.decision] : []),
    ...(slots?.vision ? [slots.vision] : []),
    ...(slots?.embedding ? [slots.embedding] : []),
    ...(slots?.reranker ? [slots.reranker] : []),
    ...(slots?.image_gen ? [slots.image_gen] : []),
  ];
  for (const ref of configuredRefs) {
    if (providerFilter && ref.provider !== providerFilter) continue;
    if (ref.provider && ref.model) {
      addUnique(enrich(ref.provider, ref.model));
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
  fetchImpl?: typeof fetch;
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
  if (isGeminiDecisionModel(resolved.slot.modelId)) {
    const decisionClient = new GeminiDecisionClient({
      apiKey: resolved.slot.apiKey,
      modelId: resolved.slot.modelId,
      baseUrl: resolved.slot.baseUrl,
      fetchImpl: opts.fetchImpl,
    });
    try {
      await decisionClient.decide({
        input: "ping",
        questions: { ok: { type: "noul", instructions: "Is this a ping message?" } },
      });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : "Decisions API 连通测试失败",
      };
    }
  }
  if (isEmbeddingModelId(resolved.slot.modelId)) {
    const embeddingClient = buildEmbeddingClient(resolved.slot, opts.fetchImpl);
    try {
      const vec = await embeddingClient.embed("ping", { taskType: "query" });
      if (vec.length === 0) {
        return { ok: false, latencyMs: Date.now() - start, error: "Embedding 模型返回空向量" };
      }
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : "Embedding API 连通测试失败",
      };
    }
  }
  if (isRerankerModelId(resolved.slot.modelId)) {
    const rerankerClient = buildRerankerClient(resolved.slot, opts.fetchImpl);
    try {
      const items = await rerankerClient.rerank("ping", ["pong"]);
      if (items.length === 0) {
        return { ok: false, latencyMs: Date.now() - start, error: "Reranker 模型返回空结果" };
      }
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : "Rerank API 连通测试失败",
      };
    }
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
  catalog?: ModelCatalogService;
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
    this.clientFactory =
      deps.clientFactory ?? ((resolved) => buildPiAiChatClient(resolved, deps.catalog));
  }

  get contextWindow(): number {
    return this.activeClient?.contextWindow ?? 200_000;
  }

  get modelId(): string | undefined {
    const slots = this.deps.getConfig().llm?.slots;
    const slotRef =
      this.slot === "digest"
        ? (slots?.digest ?? slots?.memory_task ?? slots?.chat)
        : this.slot === "memory_task"
          ? (slots?.memory_task ?? slots?.chat)
          : slots?.chat;
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
