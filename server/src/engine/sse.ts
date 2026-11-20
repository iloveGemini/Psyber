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

interface SubscriptionMeta {
  listener: Listener;
  foreground: boolean;
}

/**
 * Ring 1 极简 SSE 广播中心：支持核心事件 + ping，维护各连接前后台标记以支撑离线通知抑制。
 */
export class SseHub {
  private readonly subscriptions = new Set<SubscriptionMeta>();

  subscribe(listener: Listener, opts: { foreground?: boolean } = {}): () => void {
    const entry: SubscriptionMeta = {
      listener,
      foreground: opts.foreground !== false,
    };
    this.subscriptions.add(entry);
    return () => {
      this.subscriptions.delete(entry);
    };
  }

  emit(event: Ring1SseEventName, data: Record<string, unknown>): void {
    const frame: SseFrame = { event, data };
    for (const sub of this.subscriptions) {
      try {
        sub.listener(frame);
      } catch {
        // 单个客户端断连不影响其他订阅者
      }
    }
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /** 当前活跃的前台客户端订阅数（仅计 foreground !== false 的连接，对齐 Spec 03 §3.1） */
  get foregroundSubscriberCount(): number {
    let count = 0;
    for (const sub of this.subscriptions) {
      if (sub.foreground) count += 1;
    }
    return count;
  }
}

export function formatSseFrame(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
