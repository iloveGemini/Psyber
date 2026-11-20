export type Ring1SseEventName =
  | "message.created"
  | "message.updated"
  | "door.updated"
  | "turn.start"
  | "turn.thinking"
  | "turn.expression"
  | "turn.text"
  | "turn.done"
  | "turn.error"
  | "ping";

export interface SseFrame {
  event: Ring1SseEventName;
  data: Record<string, unknown>;
}

type Listener = (frame: SseFrame) => void;

/**
 * Ring 1 极简 SSE 广播中心：支持 7 类核心事件 + ping，单进程内存扇出给全部在线客户端。
 */
export class SseHub {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: Ring1SseEventName, data: Record<string, unknown>): void {
    const frame: SseFrame = { event, data };
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch {
        // 单个客户端断连不影响其他订阅者
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export function formatSseFrame(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
