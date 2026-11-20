import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../../src/llm/client.ts";

export type MockStreamHandler = (
  request: ChatStreamRequest,
) => ChatStreamChunk[] | AsyncIterable<ChatStreamChunk>;

/**
 * 100% 离线确定性 MockChatModel（对齐 Spec 05 §2.1）：
 * 记录每次发往模型的完整请求载荷（便于断言 Static Prefix 冻结、thinking 剥除与 tool_result 干净），零外网调用。
 */
export class MockChatModel implements ChatModelClient {
  public readonly requests: ChatStreamRequest[] = [];
  private readonly queue: MockStreamHandler[] = [];

  constructor(public readonly contextWindow: number = 200_000) {}

  queueStream(handler: MockStreamHandler): void {
    this.queue.push(handler);
  }

  async *stream(request: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
    // 深拷贝当前 messages 快照，防止后续引擎 push 改变已记录请求
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    });

    const handler = this.queue.shift();
    if (!handler) {
      throw new Error("MockChatModel: unexpected call with no queued response");
    }

    const out = handler(request);
    for await (const chunk of out) {
      if (request.signal?.aborted) return;
      yield chunk;
    }
  }
}
