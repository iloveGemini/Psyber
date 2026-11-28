export type Ring1SseEventName =
  | "message.created"
  | "message.updated"
  | "door.updated"
  | "door_notes.read"
  | "door_note.opened"
  | "identity.updated"
  | "user_status.updated"
  | "memory_mcp.updated"
  | "activity.updated"
  | "share.opened"
  | "turn.start"
  | "turn.thinking"
  | "turn.tool"
  | "turn.tidy"
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
  deviceId?: string;
  onClose?: () => void;
}

export interface SseReplayResult {
  resetReason: "buffer_overflow" | "server_restarted" | null;
  latestStreamSeq: number;
  frames: SseFrame[];
}

/**
 * SSE 广播中心：支持实时广播、前后台连接计数、按设备吊销即时断流，
 * 以及 500 帧内存环形缓冲（streamSeq 断线续传 / sync.reset）。
 */
export class SseHub {
  private readonly subscriptions = new Set<SubscriptionMeta>();
  private readonly replayBuffer: Array<SseFrame & { id: number }> = [];
  private nextSeq = 0;
  /** 因超过 MAX_SSE_REPLAY_FRAMES 真实淘汰的最大帧 id（与按轮清除敏感流式分片解耦，避免误报 buffer_overflow） */
  private evictedUntilSeq = 0;

  subscribe(
    listener: Listener,
    opts: { foreground?: boolean; deviceId?: string; onClose?: () => void } = {},
  ): () => void {
    const entry: SubscriptionMeta = {
      listener,
      foreground: opts.foreground !== false,
      deviceId: opts.deviceId,
      onClose: opts.onClose,
    };
    this.subscriptions.add(entry);
    return () => {
      this.subscriptions.delete(entry);
    };
  }

  /**
   * 立即断开指定 deviceId 集合的全部活跃 SSE 连接（对齐 Spec 04 §1.1 设备吊销要求）。
   */
  disconnectDevices(deviceIds: Iterable<string>): number {
    const target = new Set(deviceIds);
    if (target.size === 0) return 0;
    const toClose: SubscriptionMeta[] = [];
    for (const sub of this.subscriptions) {
      if (sub.deviceId && target.has(sub.deviceId)) {
        toClose.push(sub);
      }
    }
    for (const sub of toClose) {
      this.subscriptions.delete(sub);
      try {
        sub.onClose?.();
      } catch {
        // 单个连接关闭异常不影响其余设备吊销
      }
    }
    return toClose.length;
  }

  /**
   * 立即断开所有活跃 SSE 连接（用于服务端停机时释放长连接与心跳定时器）。
   */
  disconnectAll(): number {
    const all = Array.from(this.subscriptions);
    this.subscriptions.clear();
    for (const sub of all) {
      try {
        sub.onClose?.();
      } catch {
        // 单个连接关闭异常不影响停机流程
      }
    }
    return all.length;
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
        const dropped = this.replayBuffer.shift();
        if (dropped) {
          this.evictedUntilSeq = Math.max(this.evictedUntilSeq, dropped.id);
        }
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

  /**
   * 仅当某轮对话涉及凭证脱敏时调用：从 500 帧内存重放缓冲清除该轮的流式分片（turn.text / turn.thinking），
   * 避免复读明文滞留在断线续传缓冲中（重连端直接消费已脱敏的 message.created）。
   */
  purgeTurnStreamFrames(turnId: string): number {
    let removed = 0;
    for (let i = this.replayBuffer.length - 1; i >= 0; i--) {
      const f = this.replayBuffer[i]!;
      if (
        (f.event === "turn.text" || f.event === "turn.thinking") &&
        f.data.turnId === turnId
      ) {
        this.replayBuffer.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
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
    if (this.evictedUntilSeq > 0 && lastEventId < this.evictedUntilSeq) {
      return { resetReason: "buffer_overflow", latestStreamSeq: this.nextSeq, frames: [] };
    }
    if (this.replayBuffer.length === 0) {
      return { resetReason: null, latestStreamSeq: this.nextSeq, frames: [] };
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
