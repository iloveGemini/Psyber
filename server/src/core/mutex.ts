/**
 * 轻量异步互斥锁：供 DirectEngine（ChatTurnLock）与 MemoryTools（MemoryWriteMutex）复用，
 * 避免在多个模块重复手写 Promise 链式队列样板。
 */
export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
