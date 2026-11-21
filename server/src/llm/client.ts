import type {
  Api,
  AssistantMessage,
  Context,
  JsonObject,
  Message,
  Model,
  Models,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";

import type { ToolDefinition } from "../tools/registry.ts";

export type LlmErrorCode =
  | "AUTH_EXPIRED"
  | "RATE_LIMITED"
  | "CONTEXT_OVERFLOW"
  | "PROVIDER_ERROR";

export type ChatToolDefinition = ToolDefinition;

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatTextContent {
  type: "text";
  text: string;
}

export interface ChatImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type ChatUserContent = string | Array<ChatTextContent | ChatImageContent>;

export type ChatMessage =
  | { role: "user"; content: ChatUserContent; timestamp: number }
  | {
      role: "assistant";
      content: string;
      thinking?: string;
      thinkingSignature?: string;
      toolCalls?: ChatToolCall[];
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: string;
      isError: boolean;
      timestamp: number;
    };

export type ChatStreamChunk =
  | { type: "thinking_delta"; delta: string; signature?: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      estimatedCostUsd?: number;
    }
  | { type: "error"; code: LlmErrorCode; message: string; retryable: boolean };

export interface ChatStreamRequest {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ChatToolDefinition[];
  sessionId?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * 极薄对话模型抽象：生产环境由 PiAiChatClient 实现，离线测试由 MockChatModel 实现。
 */
export interface ChatModelClient {
  readonly contextWindow: number;
  readonly modelId?: string;
  stream(request: ChatStreamRequest): AsyncIterable<ChatStreamChunk>;
}

export function classifyLlmError(message: string): { code: LlmErrorCode; retryable: boolean } {
  const lower = message.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid_api_key") ||
    lower.includes("invalid_grant") ||
    lower.includes("authentication")
  ) {
    return { code: "AUTH_EXPIRED", retryable: false };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { code: "RATE_LIMITED", retryable: true };
  }
  if (
    lower.includes("context length") ||
    lower.includes("context_length") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens") ||
    lower.includes("prompt is too long")
  ) {
    return { code: "CONTEXT_OVERFLOW", retryable: true };
  }
  return { code: "PROVIDER_ERROR", retryable: true };
}

function toPiAiMessages(messages: ChatMessage[], model: Model<Api>): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content, timestamp: msg.timestamp });
    } else if (msg.role === "assistant") {
      const blocks: AssistantMessage["content"] = [];
      if (msg.thinking) {
        blocks.push({
          type: "thinking",
          thinking: msg.thinking,
          thinkingSignature: msg.thinkingSignature,
        });
      }
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments as JsonObject,
          });
        }
      }
      out.push({
        role: "assistant",
        content: blocks,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: msg.toolCalls && msg.toolCalls.length > 0 ? "toolUse" : "stop",
        timestamp: msg.timestamp,
      });
    } else if (msg.role === "toolResult") {
      out.push({
        role: "toolResult",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        content: [{ type: "text", text: msg.content }],
        isError: msg.isError,
        timestamp: msg.timestamp,
      });
    }
  }
  return out;
}

/**
 * 基于 @earendil-works/pi-ai 的多厂商流式协议适配器（对齐 Spec 01 §1）。
 */
export class PiAiChatClient implements ChatModelClient {
  readonly contextWindow: number;
  readonly modelId: string;

  constructor(
    private readonly models: Models,
    private readonly model: Model<Api>,
    private readonly apiKey?: string,
  ) {
    this.contextWindow = model.contextWindow || 200_000;
    this.modelId = model.id;
  }

  async *stream(request: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
    const tools: Tool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const context: Context = {
      systemPrompt: request.systemPrompt,
      messages: toPiAiMessages(request.messages, this.model),
      tools,
    };

    const eventStream = this.models.streamSimple(this.model, context, {
      apiKey: this.apiKey,
      sessionId: request.sessionId,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      cacheRetention: "short",
      signal: request.signal,
    });

    let lastThinkingSignature: string | undefined;

    for await (const ev of eventStream) {
      if (request.signal?.aborted) return;

      if (ev.type === "thinking_delta") {
        const block = ev.partial.content[ev.contentIndex];
        const sig = block && block.type === "thinking" ? block.thinkingSignature : undefined;
        if (sig) lastThinkingSignature = sig;
        yield { type: "thinking_delta", delta: ev.delta, signature: sig ?? lastThinkingSignature };
      } else if (ev.type === "text_delta") {
        yield { type: "text_delta", delta: ev.delta };
      } else if (ev.type === "toolcall_end") {
        const tc: ToolCall = ev.toolCall;
        yield {
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          args: (tc.arguments ?? {}) as Record<string, unknown>,
        };
      } else if (ev.type === "done") {
        const u = ev.message.usage;
        yield {
          type: "usage",
          inputTokens: u.input,
          outputTokens: u.output,
          totalTokens: u.totalTokens,
          cacheReadTokens: u.cacheRead,
          cacheWriteTokens: u.cacheWrite,
          estimatedCostUsd: u.cost?.total,
        };
      } else if (ev.type === "error") {
        if (ev.reason === "aborted") return;
        const errMsg = ev.error.errorMessage ?? "模型调用失败";
        const { code, retryable } = classifyLlmError(errMsg);
        yield { type: "error", code, message: errMsg, retryable };
      }
    }
  }
}
