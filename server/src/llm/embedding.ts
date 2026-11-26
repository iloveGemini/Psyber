import type { PsyberConfig } from "../core/config.ts";
import { loadCredentials } from "../core/credentials.ts";
import { sanitizeUnicode } from "../core/decision.ts";
import type { EmbeddingClient, EmbeddingOptions } from "../core/embedding.ts";
import { resolveByokSlot, type ResolvedByokSlot } from "./router.ts";

export type { EmbeddingClient, EmbeddingOptions };

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_EMBED_TIMEOUT_MS = 15_000;
const QWEN3_DEFAULT_QUERY_INSTRUCT =
  "Given a conversational message in a long-term personal chat, retrieve relevant past memory notes";

/** 判断模型 ID 是否为向量嵌入模型（供设置页连通测试与协议路由识别） */
export function isEmbeddingModelId(modelId: string): boolean {
  const s = modelId.trim().toLowerCase();
  return /(?:^|[/:_-])(?:embedding|embed|bge-m3|bge-large|bge-base|text-embedding)(?:$|[/:_.-])/.test(s);
}

export function isGeminiEmbeddingModel(modelId: string): boolean {
  return /^(?:models\/)?(?:gemini-embedding|text-embedding-004)/i.test(modelId.trim());
}

export function isQwen3EmbeddingModel(modelId: string): boolean {
  return /qwen3-embedding/i.test(modelId.trim());
}

/** 将原始浮点数组归一化为单位 L2 向量（匹配 Spec 02 §4.1 缓存口径） */
export function normalizeL2(values: readonly number[] | Float32Array): Float32Array {
  const vec = values instanceof Float32Array ? new Float32Array(values) : Float32Array.from(values);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0 && Number.isFinite(norm)) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

function resolveGeminiV1BetaBase(baseUrl?: string): string {
  const trimmed = (baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
  if (trimmed.endsWith("/v1beta")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed.slice(0, -3)}/v1beta`;
  return `${trimmed}/v1beta`;
}

function resolveOpenAiEmbeddingsUrl(baseUrl?: string): string {
  const trimmed = (baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  if (trimmed.endsWith("/embeddings")) return trimmed;
  return `${trimmed}/embeddings`;
}

function withTimeoutSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    },
  };
}

export interface GeminiEmbeddingClientOptions {
  apiKey: string;
  modelId: string;
  providerId?: string;
  baseUrl?: string;
  outputDimensionality?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Google 原生 Gemini Embedding API 客户端（支持 gemini-embedding-2 / gemini-embedding-001）：
 * - 单条走 `:embedContent`，批量走 `:batchEmbedContents`（每批最多 32 条）；
 * - 按 `taskType` 映射 `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`。
 */
export class GeminiEmbeddingClient implements EmbeddingClient {
  readonly modelKey: string;
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly baseUrl: string;
  private readonly outputDimensionality?: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GeminiEmbeddingClientOptions) {
    this.apiKey = opts.apiKey;
    const rawId = opts.modelId.trim().replace(/^models\//, "");
    this.modelName = `models/${rawId}`;
    this.modelKey = `${opts.providerId?.trim() || "google"}:${rawId}`;
    this.baseUrl = resolveGeminiV1BetaBase(opts.baseUrl);
    this.outputDimensionality = opts.outputDimensionality;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  }

  private buildRequestItem(text: string, opts?: EmbeddingOptions): Record<string, unknown> {
    const clean = sanitizeUnicode(text.trim() || " ");
    const item: Record<string, unknown> = {
      model: this.modelName,
      content: { parts: [{ text: clean }] },
    };
    if (opts?.taskType === "query") {
      item.taskType = "RETRIEVAL_QUERY";
    } else if (opts?.taskType === "document") {
      item.taskType = "RETRIEVAL_DOCUMENT";
    }
    if (this.outputDimensionality && this.outputDimensionality > 0) {
      item.outputDimensionality = this.outputDimensionality;
    }
    return item;
  }

  async embed(text: string, opts?: EmbeddingOptions): Promise<Float32Array> {
    const url = `${this.baseUrl}/${this.modelName}:embedContent`;
    const { signal, cleanup } = withTimeoutSignal(opts?.signal, this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(this.buildRequestItem(text, opts)),
        signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `Gemini Embedding API HTTP ${res.status}: ${errText.slice(0, 300) || res.statusText}`,
        );
      }
      const json = (await res.json()) as {
        embedding?: { values?: number[] };
      };
      const values = json.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error("Gemini Embedding API returned empty embedding values");
      }
      return normalizeL2(values);
    } finally {
      cleanup();
    }
  }

  async embedBatch(texts: string[], opts?: EmbeddingOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.embed(texts[0], opts)];

    const out: Float32Array[] = [];
    const chunkSize = 32;
    for (let i = 0; i < texts.length; i += chunkSize) {
      const slice = texts.slice(i, i + chunkSize);
      const url = `${this.baseUrl}/${this.modelName}:batchEmbedContents`;
      const { signal, cleanup } = withTimeoutSignal(opts?.signal, this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            requests: slice.map((t) => this.buildRequestItem(t, opts)),
          }),
          signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(
            `Gemini Batch Embedding API HTTP ${res.status}: ${errText.slice(0, 300) || res.statusText}`,
          );
        }
        const json = (await res.json()) as {
          embeddings?: Array<{ values?: number[] }>;
        };
        const list = json.embeddings;
        if (!Array.isArray(list) || list.length !== slice.length) {
          throw new Error(
            `Gemini Batch Embedding API returned ${list?.length ?? 0} embeddings for ${slice.length} inputs`,
          );
        }
        for (const item of list) {
          if (!Array.isArray(item?.values) || item.values.length === 0) {
            throw new Error("Gemini Batch Embedding API returned empty vector element");
          }
          out.push(normalizeL2(item.values));
        }
      } finally {
        cleanup();
      }
    }
    return out;
  }
}

export interface OpenAiEmbeddingClientOptions {
  apiKey: string;
  modelId: string;
  providerId?: string;
  baseUrl?: string;
  dimensions?: number;
  /** 可选查询前缀指令（Qwen3-Embedding 默认自动附加中文陪伴记忆检索指令） */
  queryInstruction?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * OpenAI 兼容 `/embeddings` 客户端（支持 SiliconFlow `Qwen/Qwen3-Embedding-8B`、百炼、OpenAI、Ollama 等）：
 * - 原生批量 `input: string[]`（每批最多 16 条，兼顾上游限额）；
 * - 对 Qwen3-Embedding 查询端自动加 `Instruct: ...\nQuery:` 前缀，文档端传原文。
 */
export class OpenAiEmbeddingClient implements EmbeddingClient {
  readonly modelKey: string;
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly url: string;
  private readonly dimensions?: number;
  private readonly queryInstruction: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenAiEmbeddingClientOptions) {
    this.apiKey = opts.apiKey;
    this.modelId = opts.modelId.trim();
    this.modelKey = `${opts.providerId?.trim() || "openai"}:${this.modelId}`;
    this.url = resolveOpenAiEmbeddingsUrl(opts.baseUrl);
    this.dimensions = opts.dimensions;
    this.queryInstruction =
      opts.queryInstruction !== undefined
        ? opts.queryInstruction
        : isQwen3EmbeddingModel(this.modelId)
          ? QWEN3_DEFAULT_QUERY_INSTRUCT
          : null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  }

  private formatInput(text: string, opts?: EmbeddingOptions): string {
    const clean = sanitizeUnicode(text.trim() || " ");
    if (opts?.taskType === "query" && this.queryInstruction) {
      return `Instruct: ${this.queryInstruction}\nQuery:${clean}`;
    }
    return clean;
  }

  async embed(text: string, opts?: EmbeddingOptions): Promise<Float32Array> {
    const [vec] = await this.embedBatch([text], opts);
    return vec;
  }

  async embedBatch(texts: string[], opts?: EmbeddingOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    const chunkSize = 16;

    for (let i = 0; i < texts.length; i += chunkSize) {
      const slice = texts.slice(i, i + chunkSize).map((t) => this.formatInput(t, opts));
      const { signal, cleanup } = withTimeoutSignal(opts?.signal, this.timeoutMs);
      try {
        const body: Record<string, unknown> = {
          model: this.modelId,
          input: slice.length === 1 ? slice[0] : slice,
          encoding_format: "float",
        };
        if (this.dimensions && this.dimensions > 0) {
          body.dimensions = this.dimensions;
        }
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(
            `OpenAI Embedding API HTTP ${res.status}: ${errText.slice(0, 300) || res.statusText}`,
          );
        }
        const json = (await res.json()) as {
          data?: Array<{ index?: number; embedding?: number[] }>;
        };
        const items = json.data;
        if (!Array.isArray(items) || items.length !== slice.length) {
          throw new Error(
            `OpenAI Embedding API returned ${items?.length ?? 0} embeddings for ${slice.length} inputs`,
          );
        }
        const ordered = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        for (const item of ordered) {
          if (!Array.isArray(item?.embedding) || item.embedding.length === 0) {
            throw new Error("OpenAI Embedding API returned empty embedding vector");
          }
          out.push(normalizeL2(item.embedding));
        }
      } finally {
        cleanup();
      }
    }
    return out;
  }
}

export function buildEmbeddingClient(
  slot: ResolvedByokSlot,
  fetchImpl?: typeof fetch,
): EmbeddingClient {
  if (slot.kind === "google" || isGeminiEmbeddingModel(slot.modelId)) {
    return new GeminiEmbeddingClient({
      apiKey: slot.apiKey,
      modelId: slot.modelId,
      providerId: slot.providerId,
      baseUrl: slot.baseUrl,
      fetchImpl,
    });
  }
  return new OpenAiEmbeddingClient({
    apiKey: slot.apiKey,
    modelId: slot.modelId,
    providerId: slot.providerId,
    baseUrl: slot.baseUrl,
    fetchImpl,
  });
}

export interface DynamicEmbeddingClientDeps {
  dataDir: string;
  getConfig: () => PsyberConfig;
  fetchImpl?: typeof fetch;
}

/**
 * 动态向量客户端：热读取 `llm.slots.embedding`（未配置时 `isConfigured()` 返回 false，绝不回落到 chat 槽位）。
 */
export class DynamicEmbeddingClient implements EmbeddingClient {
  constructor(private readonly deps: DynamicEmbeddingClientDeps) {}

  get modelKey(): string {
    const ref = this.deps.getConfig().llm?.slots?.embedding;
    if (!ref?.provider?.trim() || !ref?.model?.trim()) return "unconfigured";
    return `${ref.provider.trim()}:${ref.model.trim()}`;
  }

  isConfigured(): boolean {
    const ref = this.deps.getConfig().llm?.slots?.embedding;
    return Boolean(ref?.provider?.trim() && ref?.model?.trim());
  }

  private async resolveClient(): Promise<EmbeddingClient> {
    const config = this.deps.getConfig();
    const creds = await loadCredentials(this.deps.dataDir);
    const resolved = resolveByokSlot(config, creds, "embedding");
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    return buildEmbeddingClient(resolved.slot, this.deps.fetchImpl);
  }

  async embed(text: string, opts?: EmbeddingOptions): Promise<Float32Array> {
    const client = await this.resolveClient();
    return client.embed(text, opts);
  }

  async embedBatch(texts: string[], opts?: EmbeddingOptions): Promise<Float32Array[]> {
    const client = await this.resolveClient();
    if (client.embedBatch) return client.embedBatch(texts, opts);
    const out: Float32Array[] = [];
    for (const t of texts) {
      out.push(await client.embed(t, opts));
    }
    return out;
  }
}
