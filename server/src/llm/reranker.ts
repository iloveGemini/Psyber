import type { PsyberConfig } from "../core/config.ts";
import { loadCredentials } from "../core/credentials.ts";
import { sanitizeUnicode } from "../core/decision.ts";
import type { RerankerClient, RerankerOptions, RerankItem } from "../core/reranker.ts";
import { resolveByokSlot, type ResolvedByokSlot } from "./router.ts";

export type { RerankerClient, RerankerOptions, RerankItem };

const DEFAULT_RERANK_TIMEOUT_MS = 10_000;

/** 判断模型 ID 是否为精排模型（供设置页连通测试识别） */
export function isRerankerModelId(modelId: string): boolean {
  const s = modelId.trim().toLowerCase();
  return /(?:^|[/:_-])rerank(?:er)?(?:$|[/:_.-])/.test(s);
}

function resolveRerankUrl(baseUrl?: string): string {
  const trimmed = (baseUrl?.trim() || "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
  if (trimmed.endsWith("/rerank")) return trimmed;
  return `${trimmed}/rerank`;
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

export interface HttpRerankerClientOptions {
  apiKey: string;
  modelId: string;
  providerId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 标准 `/rerank` HTTP 客户端（兼容 SiliconFlow `Qwen/Qwen3-Reranker-8B`、Jina、Cohere、vLLM 等）。
 */
export class HttpRerankerClient implements RerankerClient {
  readonly modelKey: string;
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpRerankerClientOptions) {
    this.apiKey = opts.apiKey;
    this.modelId = opts.modelId.trim();
    this.modelKey = `${opts.providerId?.trim() || "reranker"}:${this.modelId}`;
    this.url = resolveRerankUrl(opts.baseUrl);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  }

  async rerank(query: string, documents: string[], opts?: RerankerOptions): Promise<RerankItem[]> {
    if (documents.length === 0) return [];
    const { signal, cleanup } = withTimeoutSignal(opts?.signal, this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: this.modelId,
        query: sanitizeUnicode(query.trim() || " "),
        documents: documents.map((d) => sanitizeUnicode(d.trim() || " ")),
        return_documents: false,
      };
      if (opts?.topN && opts.topN > 0) {
        body.top_n = Math.min(opts.topN, documents.length);
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
          `Rerank API HTTP ${res.status}: ${errText.slice(0, 300) || res.statusText}`,
        );
      }

      const json = (await res.json()) as {
        results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
      };
      const results = json.results;
      if (!Array.isArray(results)) {
        throw new Error("Rerank API returned missing results array");
      }

      const out: RerankItem[] = [];
      for (const item of results) {
        const idx = item?.index;
        const score = item?.relevance_score ?? item?.score;
        if (
          typeof idx === "number" &&
          Number.isInteger(idx) &&
          idx >= 0 &&
          idx < documents.length &&
          typeof score === "number" &&
          Number.isFinite(score)
        ) {
          out.push({ index: idx, relevanceScore: score });
        }
      }
      out.sort((a, b) => b.relevanceScore - a.relevanceScore);
      return out;
    } finally {
      cleanup();
    }
  }
}

export function buildRerankerClient(
  slot: ResolvedByokSlot,
  fetchImpl?: typeof fetch,
): RerankerClient {
  return new HttpRerankerClient({
    apiKey: slot.apiKey,
    modelId: slot.modelId,
    providerId: slot.providerId,
    baseUrl: slot.baseUrl,
    fetchImpl,
  });
}

export interface DynamicRerankerClientDeps {
  dataDir: string;
  getConfig: () => PsyberConfig;
  fetchImpl?: typeof fetch;
}

/**
 * 动态精排客户端：热读取 `llm.slots.reranker`（未配置时 `isConfigured()` 返回 false，绝不回落至 chat）。
 */
export class DynamicRerankerClient implements RerankerClient {
  constructor(private readonly deps: DynamicRerankerClientDeps) {}

  get modelKey(): string {
    const ref = this.deps.getConfig().llm?.slots?.reranker;
    if (!ref?.provider?.trim() || !ref?.model?.trim()) return "unconfigured";
    return `${ref.provider.trim()}:${ref.model.trim()}`;
  }

  isConfigured(): boolean {
    const ref = this.deps.getConfig().llm?.slots?.reranker;
    return Boolean(ref?.provider?.trim() && ref?.model?.trim());
  }

  async rerank(query: string, documents: string[], opts?: RerankerOptions): Promise<RerankItem[]> {
    const config = this.deps.getConfig();
    const creds = await loadCredentials(this.deps.dataDir);
    const resolved = resolveByokSlot(config, creds, "reranker");
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    const client = buildRerankerClient(resolved.slot, this.deps.fetchImpl);
    return client.rerank(query, documents, opts);
  }
}
