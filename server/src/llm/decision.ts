import type { PsyberConfig } from "../core/config.ts";
import { loadCredentials } from "../core/credentials.ts";
import {
  sanitizeUnicode,
  type DecisionAnswer,
  type DecisionClient,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
} from "../core/decision.ts";
import type { ModelCatalogService } from "./catalog.ts";
import type { ChatModelClient } from "./client.ts";
import {
  buildPiAiChatClient,
  resolveByokSlot,
  type ResolvedByokSlot,
} from "./router.ts";

export type {
  DecisionAnswer,
  DecisionClient,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
};

const DEFAULT_GEMINI_DECISIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_DECISION_TIMEOUT_MS = 15_000;

/** 判断模型 ID 是否为 Google Gemini Decision 专用模型（如 gemini-decision-1） */
export function isGeminiDecisionModel(modelId: string): boolean {
  return /^gemini-decision(?:[-@.]|$)/i.test(modelId.trim());
}

function clampProb(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(0.99, Math.max(0.01, value));
}

function normalizeDecisionAnswer(raw: unknown): DecisionAnswer {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const out: DecisionAnswer = {};
  if (typeof obj.noul === "number" && Number.isFinite(obj.noul)) {
    out.noul = clampProb(obj.noul);
  }
  if (typeof obj.choice === "string" && obj.choice.trim()) {
    out.choice = obj.choice.trim();
  }
  if (typeof obj.score === "number" && Number.isFinite(obj.score)) {
    out.score = obj.score;
  }
  if (typeof obj.confidence === "number" && Number.isFinite(obj.confidence)) {
    out.confidence = obj.confidence;
  }
  if (obj.probabilities && typeof obj.probabilities === "object" && !Array.isArray(obj.probabilities)) {
    const probs: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj.probabilities as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        probs[k] = v;
      }
    }
    if (Object.keys(probs).length > 0) {
      out.probabilities = probs;
    }
  }
  return out;
}

export interface GeminiDecisionClientOptions {
  apiKey: string;
  modelId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 原生 Google Gemini Decisions API 客户端（POST /v1beta/decisions）：
 * - 专为 `gemini-decision-1` 设计（0 output tokens、低延迟校准概率、支持单次并行多题）；
 * - 后续也可直接复用于每轮对话的「是否需要召回记忆」门控。
 */
export class GeminiDecisionClient implements DecisionClient {
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GeminiDecisionClientOptions) {
    this.apiKey = opts.apiKey;
    this.modelId = opts.modelId?.trim() || "gemini-decision-1";
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_GEMINI_DECISIONS_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  }

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    // 兼容 OpenAI 代理常见的 `/v1` 结尾（如 http://localhost:7860/v1 -> .../v1beta/decisions）
    // 以及官方 `/v1beta` 或根域名（https://.../v1beta -> .../v1beta/decisions）
    let url: string;
    if (this.baseUrl.endsWith("/decisions")) {
      url = this.baseUrl;
    } else if (this.baseUrl.endsWith("/v1")) {
      url = `${this.baseUrl.slice(0, -3)}/v1beta/decisions`;
    } else if (this.baseUrl.endsWith("/v1beta")) {
      url = `${this.baseUrl}/decisions`;
    } else {
      url = `${this.baseUrl}/v1beta/decisions`;
    }

    const questionsPayload: Record<string, Record<string, unknown>> = {};
    for (const [qId, q] of Object.entries(req.questions)) {
      const payload: Record<string, unknown> = {
        type: q.type,
        instructions: q.instructions,
      };
      if (q.criteria) {
        if (q.type === "noul") {
          // Google Decisions API 的 NoulCriteria 使用 true_description / false_description；
          // 同时兼容简写 true / false，避免误传非法键名导致 HTTP 400
          const trueDesc = (q.criteria.true_description ?? q.criteria.true)?.trim();
          const falseDesc = (q.criteria.false_description ?? q.criteria.false)?.trim();
          const noulCriteria: Record<string, string> = {};
          if (trueDesc) noulCriteria.true_description = trueDesc;
          if (falseDesc) noulCriteria.false_description = falseDesc;
          if (Object.keys(noulCriteria).length > 0) {
            payload.criteria = noulCriteria;
          }
        } else {
          payload.criteria = q.criteria;
        }
      }
      questionsPayload[qId] = payload;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          model: this.modelId,
          // 防止 slice 截断 emoji 产生孤立 UTF-16 代理项导致严格 JSON 解析报 HTTP 400
          input: sanitizeUnicode(req.input),
          questions: questionsPayload,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `Gemini Decisions API HTTP ${res.status}: ${errText.slice(0, 300) || res.statusText}`,
        );
      }

      const json = (await res.json()) as {
        answers?: Record<string, unknown>;
        result?: { answers?: Record<string, unknown> };
      };
      const rawAnswers = json.answers ?? json.result?.answers ?? {};
      const answers: Record<string, DecisionAnswer> = {};
      for (const qId of Object.keys(req.questions)) {
        answers[qId] = normalizeDecisionAnswer(rawAnswers[qId]);
      }
      return {
        answers,
        backend: `gemini-decisions:${this.modelId}`,
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * 通用 LLM 降级决策客户端：
 * 当未配置 `gemini-decision-1` 时，利用普通轻量模型（关闭思考链 + 极短 JSON 输出）
 * 返回同构的 `DecisionResponse`，确保门控逻辑在任意 BYOK 提供商下平滑可用。
 */
export class LlmFallbackDecisionClient implements DecisionClient {
  constructor(
    private readonly chatModel: ChatModelClient,
    private readonly backendLabel = "llm-fallback",
  ) {}

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const questionSpec = JSON.stringify(req.questions, null, 2);
    const systemPrompt = [
      "You are a calibrated decision classifier. Evaluate the input against each question.",
      "Output ONLY a valid JSON object matching this exact schema, with no markdown fences or extra commentary:",
      '{"answers": {"<question_id>": {"noul": 0.01..0.99}}}',
      'For type="choice", return {"choice": "<option_key>"}. For type="score", return {"score": <number>}.',
    ].join("\n");

    const userPrompt = `<input>\n${req.input}\n</input>\n\n<questions>\n${questionSpec}\n</questions>`;

    let text = "";
    for await (const chunk of this.chatModel.stream({
      systemPrompt,
      messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      tools: [],
      temperature: 0,
      maxTokens: 512,
      thinkingLevel: "off",
      signal: req.signal,
    })) {
      if (chunk.type === "error") {
        throw new Error(`Decision fallback LLM error (${chunk.code}): ${chunk.message}`);
      }
      if (chunk.type === "text_delta") {
        text += chunk.delta;
      }
    }

    const jsonMatch = /\{[\s\S]*\}/.exec(text.trim());
    if (!jsonMatch) {
      throw new Error(`Decision fallback LLM returned non-JSON output: ${text.slice(0, 160)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      answers?: Record<string, unknown>;
    } & Record<string, unknown>;
    const rawAnswers =
      parsed.answers && typeof parsed.answers === "object"
        ? (parsed.answers as Record<string, unknown>)
        : parsed;

    const answers: Record<string, DecisionAnswer> = {};
    for (const [qId, q] of Object.entries(req.questions)) {
      const val = rawAnswers[qId];
      if (typeof val === "number" && q.type === "noul") {
        answers[qId] = { noul: clampProb(val) };
      } else if (typeof val === "boolean" && q.type === "noul") {
        answers[qId] = { noul: val ? 0.9 : 0.1 };
      } else {
        answers[qId] = normalizeDecisionAnswer(val);
      }
    }

    return {
      answers,
      backend: this.backendLabel,
    };
  }
}

export interface DynamicDecisionClientDeps {
  dataDir: string;
  getConfig: () => PsyberConfig;
  catalog?: ModelCatalogService;
  fetchImpl?: typeof fetch;
  chatClientFactory?: (resolved: ResolvedByokSlot) => ChatModelClient;
}

/**
 * 动态决策模型客户端：
 * - 热读取 `llm.slots.decision`（若未配则平滑降级至 `digest` → `memory_task` → `chat`）；
 * - 若命中 `google` + `gemini-decision-*`，自动走原生 `GeminiDecisionClient`（`/v1beta/decisions`）；
 * - 否则走 `LlmFallbackDecisionClient`（关闭思考链的极简 JSON 分类）。
 */
export class DynamicDecisionClient implements DecisionClient {
  constructor(private readonly deps: DynamicDecisionClientDeps) {}

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const config = this.deps.getConfig();
    const creds = await loadCredentials(this.deps.dataDir);
    const resolved = resolveByokSlot(config, creds, "decision");
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }

    const slot = resolved.slot;
    // gemini-decision-* 仅支持 /v1beta/decisions 协议（不支持 generateContent），无论挂在官方 google 还是本地代理均走原生客户端
    if (isGeminiDecisionModel(slot.modelId)) {
      const nativeClient = new GeminiDecisionClient({
        apiKey: slot.apiKey,
        modelId: slot.modelId,
        baseUrl: slot.baseUrl,
        fetchImpl: this.deps.fetchImpl,
      });
      return nativeClient.decide(req);
    }

    const chatClient = (
      this.deps.chatClientFactory ?? ((s) => buildPiAiChatClient(s, this.deps.catalog))
    )(slot);
    const fallbackClient = new LlmFallbackDecisionClient(
      chatClient,
      `llm-fallback:${slot.providerId}/${slot.modelId}`,
    );
    return fallbackClient.decide(req);
  }
}
