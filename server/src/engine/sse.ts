export type Ring1SseEventName =
  | "message.created"
  | "message.updated"
  | "door.updated"
  | "user_status.updated"
  | "share.opened"
  | "turn.start"
  | "turn.thinking"
  | "turn.tool"
  | "turn.rollover"
  | "turn.expression"
  | "turn.text"
  | "turn.done"
  | "turn.error"
  | "turn.silence"
  | "turn.model_switched"
  | "turn.approval_required"
  | "turn.approval_resolved"
  | "sync.reset"
  | "ping";

export type SseEventName = Ring1SseEventName;

export interface SseFrame {
  id?: number;
  event: Ring1SseEventName;
  data: Record<string, unknown>;
}

const MAX_SSE_REPLAY_FRAMES = 500;

type Listener = (frame: SseFrame) => void;

interface SubscriptionMeta {
  listener: Listener;
  foreground: boolean;
}

export interface SseReplayResult {
  resetReason: "buffer_overflow" | "server_restarted" | null;
  latestStreamSeq: number;
  frames: SseFrame[];
}

/**
 * SSE 广播中心：支持实时广播、前后台连接计数，以及 500 帧内存环形缓冲（streamSeq 断线续传 / sync.reset）。
 */
export class SseHub {
  private readonly subscriptions = new Set<SubscriptionMeta>();
  private readonly replayBuffer: Array<SseFrame & { id: number }> = [];
  private nextSeq = 0;

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
    let frame: SseFrame;
    if (event === "ping" || event === "sync.reset") {
      frame = { event, data };
    } else {
      const id = ++this.nextSeq;
      const buffered: SseFrame & { id: number } = { id, event, data };
      this.replayBuffer.push(buffered);
      if (this.replayBuffer.length > MAX_SSE_REPLAY_FRAMES) {
        this.replayBuffer.shift();
      }
      frame = buffered;
    }

    for (const sub of this.subscriptions) {
      try {
        sub.listener(frame);
      } catch {
        // 单个客户端断连不影响其他订阅者
      }
    }
  }

  get latestStreamSeq(): number {
    return this.nextSeq;
  }

  /**
   * 按客户端携带的 Last-Event-ID 计算增量补帧或 sync.reset 兜底（Spec 04 §3）。
   */
  replaySince(lastEventId: number | null): SseReplayResult {
    if (lastEventId === null || !Number.isFinite(lastEventId) || lastEventId < 0) {
      return { resetReason: null, latestStreamSeq: this.nextSeq, frames: [] };
    }
    if (lastEventId > this.nextSeq) {
      return { resetReason: "server_restarted", latestStreamSeq: this.nextSeq, frames: [] };
    }
    if (lastEventId === this.nextSeq) {
      return { resetReason: null, latestStreamSeq: this.nextSeq, frames: [] };
    }
    if (this.replayBuffer.length === 0) {
      return { resetReason: "buffer_overflow", latestStreamSeq: this.nextSeq, frames: [] };
    }
    const oldestId = this.replayBuffer[0]!.id;
    if (lastEventId < oldestId - 1) {
      return { resetReason: "buffer_overflow", latestStreamSeq: this.nextSeq, frames: [] };
    }
    return {
      resetReason: null,
      latestStreamSeq: this.nextSeq,
      frames: this.replayBuffer.filter((f) => f.id > lastEventId),
    };
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
  const idLine = frame.id !== undefined ? `id: ${frame.id}\n` : "";
  return `${idLine}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
