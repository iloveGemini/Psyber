import crypto from "node:crypto";
import type { Clock } from "../core/clock.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_TTL_MS = 5 * 60_000;
const RATE_WINDOW_MS = 5 * 60_000;
const LOCK_DURATION_MS = 10 * 60_000;
const MAX_FAILS_BEFORE_LOCK = 5;

export interface ActivePairCode {
  code: string;
  expiresAt: number;
}

interface FailureTracker {
  failures: number[];
  lockedUntil: number;
}

function generateCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += CROCKFORD[bytes[i] % CROCKFORD.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * 一次性配对码管理器（对齐 Spec 04 §1.1）：
 * 8 位 Crockford Base32、5 分钟有效、单次兑换销毁、单 IP 5 分钟内失败 5 次锁定 10 分钟。
 */
export class PairingManager {
  private active: ActivePairCode | null = null;
  private readonly ipFailures = new Map<string, FailureTracker>();

  constructor(private readonly clock: Clock) {}

  issueCode(): ActivePairCode {
    this.active = {
      code: generateCode(),
      expiresAt: this.clock.now() + CODE_TTL_MS,
    };
    return { ...this.active };
  }

  getActiveCode(): ActivePairCode | null {
    return this.active ? { ...this.active } : null;
  }

  verifyAndConsume(
    submittedCode: string,
    clientIp: string,
  ):
    | { ok: true; token: string; deviceId: string }
    | { ok: false; status: 401 | 410 | 429; code: string; message: string } {
    const now = this.clock.now();
    const tracker = this.ipFailures.get(clientIp) ?? { failures: [], lockedUntil: 0 };

    if (tracker.lockedUntil > now) {
      return {
        ok: false,
        status: 429,
        code: "PAIR_RATE_LIMITED",
        message: "配对失败次数过多，请稍后再试",
      };
    }

    const recordFailure = () => {
      tracker.failures = tracker.failures.filter((t) => now - t < RATE_WINDOW_MS);
      tracker.failures.push(now);
      if (tracker.failures.length >= MAX_FAILS_BEFORE_LOCK) {
        tracker.lockedUntil = now + LOCK_DURATION_MS;
        tracker.failures = [];
      }
      this.ipFailures.set(clientIp, tracker);
    };

    if (!this.active) {
      recordFailure();
      return { ok: false, status: 401, code: "PAIR_CODE_INVALID", message: "配对码无效或已使用" };
    }

    const normalized = submittedCode.trim().toUpperCase();
    if (normalized !== this.active.code) {
      recordFailure();
      return { ok: false, status: 401, code: "PAIR_CODE_INVALID", message: "配对码错误" };
    }

    if (now > this.active.expiresAt) {
      this.active = null;
      return { ok: false, status: 410, code: "PAIR_CODE_EXPIRED", message: "配对码已过期，请重新生成" };
    }

    // 校验通过立即销毁一次性配对码
    this.active = null;
    this.ipFailures.delete(clientIp);
    const token = `psb_${crypto.randomBytes(32).toString("hex")}`;
    const deviceId = `dev_${crypto.randomUUID().slice(0, 12)}`;
    return { ok: true, token, deviceId };
  }
}
