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

import type { PsyberConfig } from "../core/config.ts";
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

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

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
    input: ["text"],
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

export interface DynamicChatModelDeps {
  dataDir: string;
  getConfig: () => PsyberConfig;
  slot?: LlmSlotName;
  /** 可注入客户端构造工厂，供离线测试验证动态热更新而零外网调用 */
  clientFactory?: (resolved: ResolvedByokSlot) => ChatModelClient;
}

/**
 * 动态 BYOK 模型路由器：
 * - 每次发轮前热读取 config.json + credentials.json，配置完 Genesis 或 PATCH /settings 后无需重启立即可用；
 * - 未配置凭证时以标准 AUTH_EXPIRED 报错引导用户，绝不崩溃；
 * - 按配置签名缓存底层 PiAiChatClient，配置不变时零重复构建开销。
 */
export class DynamicChatModel implements ChatModelClient {
  private readonly slot: LlmSlotName;
  private readonly clientFactory: (resolved: ResolvedByokSlot) => ChatModelClient;
  private cached: { signature: string; client: ChatModelClient } | null = null;

  constructor(private readonly deps: DynamicChatModelDeps) {
    this.slot = deps.slot ?? "chat";
    this.clientFactory = deps.clientFactory ?? buildPiAiChatClient;
  }

  get contextWindow(): number {
    return this.cached?.client.contextWindow ?? 200_000;
  }

  async *stream(request: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
    const creds = await loadCredentials(this.deps.dataDir);
    const resolved = resolveByokSlot(this.deps.getConfig(), creds, this.slot);
    if (!resolved.ok) {
      yield {
        type: "error",
        code: "AUTH_EXPIRED",
        message: resolved.reason,
        retryable: false,
      };
      return;
    }

    const s = resolved.slot;
    const signature = [
      s.providerId,
      s.kind,
      s.baseUrl ?? "",
      s.modelId,
      s.apiKey,
      String(s.maxTokens ?? ""),
    ].join("|");

    if (!this.cached || this.cached.signature !== signature) {
      this.cached = {
        signature,
        client: this.clientFactory(s),
      };
    }

    yield* this.cached.client.stream({
      ...request,
      temperature: request.temperature ?? s.temperature,
      maxTokens: request.maxTokens ?? s.maxTokens,
    });
  }
}
