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
    raw += CROCKFORD[bytes[i]! % CROCKFORD.length]!;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** 常量时间字符串比对，避免长度与字节级时序侧信道泄露 */
function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    // 仍执行一次等长比对保持耗时稳定
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 归一化客户端 IP（剥离 IPv6-mapped IPv4 前缀 ::ffff:） */
export function normalizeClientIp(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "unknown";
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7);
  }
  return trimmed;
}

/** 严格判断来源 IP 是否为本机回环地址（仅用于本机桌面端免码配对守卫） */
export function isLoopbackIp(raw: string | null | undefined): boolean {
  const ip = normalizeClientIp(raw);
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

/** 生成符合 Spec 04 §1.1 的扫码配对 JSON 载荷（绝不含长期 Token） */
export function buildPairQrPayload(urls: string[], code: string): string {
  return JSON.stringify({
    v: 1,
    urls,
    code,
  });
}

/**
 * 一次性配对码与本机桌面端免码密钥管理器（对齐 Spec 04 §1.1）：
 * - 8 位 Crockford Base32、5 分钟有效、单次兑换销毁、单 IP 5 分钟内失败 5 次锁定 10 分钟
 * - 常量时间比对 + 先判过期防泄露
 * - 支持仅限本机回环 + 0600 密钥文件的桌面端免码配对（每次服务启动轮换）
 */
export class PairingManager {
  private active: ActivePairCode | null = null;
  private localSecret: string | null = null;
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

  /** 生成或轮换本机桌面端免码密钥（32 字节高熵随机数，写入 0600 local_pair.json） */
  issueLocalSecret(): string {
    this.localSecret = crypto.randomBytes(32).toString("hex");
    return this.localSecret;
  }

  getLocalSecret(): string | null {
    return this.localSecret;
  }

  private checkRateLimit(clientIp: string, now: number): {
    locked: boolean;
    recordFailure: () => void;
  } {
    const key = normalizeClientIp(clientIp);
    const tracker = this.ipFailures.get(key) ?? { failures: [], lockedUntil: 0 };
    const recordFailure = () => {
      tracker.failures = tracker.failures.filter((t) => now - t < RATE_WINDOW_MS);
      tracker.failures.push(now);
      if (tracker.failures.length >= MAX_FAILS_BEFORE_LOCK) {
        tracker.lockedUntil = now + LOCK_DURATION_MS;
        tracker.failures = [];
      }
      this.ipFailures.set(key, tracker);
    };
    return { locked: tracker.lockedUntil > now, recordFailure };
  }

  verifyAndConsume(
    submittedCode: string,
    clientIp: string,
  ):
    | { ok: true; token: string; deviceId: string }
    | { ok: false; status: 401 | 410 | 429; code: string; message: string } {
    const now = this.clock.now();
    const key = normalizeClientIp(clientIp);
    const { locked, recordFailure } = this.checkRateLimit(key, now);

    if (locked) {
      return {
        ok: false,
        status: 429,
        code: "PAIR_RATE_LIMITED",
        message: "配对失败次数过多，请稍后再试",
      };
    }

    if (!this.active) {
      recordFailure();
      return { ok: false, status: 401, code: "PAIR_CODE_INVALID", message: "配对码无效或已使用" };
    }

    // 先判过期再比对码，避免过期后仍暴露口令是否命中
    if (now > this.active.expiresAt) {
      this.active = null;
      return { ok: false, status: 410, code: "PAIR_CODE_EXPIRED", message: "配对码已过期，请重新生成" };
    }

    const normalized = submittedCode.trim().toUpperCase();
    if (!timingSafeEqualString(normalized, this.active.code)) {
      recordFailure();
      return { ok: false, status: 401, code: "PAIR_CODE_INVALID", message: "配对码错误" };
    }

    // 校验通过立即销毁一次性配对码
    this.active = null;
    this.ipFailures.delete(key);
    const token = `psb_${crypto.randomBytes(32).toString("hex")}`;
    const deviceId = `dev_${crypto.randomUUID().slice(0, 12)}`;
    return { ok: true, token, deviceId };
  }

  /**
   * 仅限本机桌面端免码校验：要求来源 IP 必须为回环地址且提供正确的 0600 本机密钥。
   */
  verifyLocalSecret(
    submittedSecret: string,
    clientIp: string,
  ):
    | { ok: true; token: string; deviceId: string }
    | { ok: false; status: 401 | 403 | 429; code: string; message: string } {
    if (!isLoopbackIp(clientIp)) {
      return {
        ok: false,
        status: 403,
        code: "LOCAL_PAIR_FORBIDDEN",
        message: "本机免码配对仅允许同一设备回环访问",
      };
    }
    const now = this.clock.now();
    const key = normalizeClientIp(clientIp);
    const { locked, recordFailure } = this.checkRateLimit(key, now);
    if (locked) {
      return {
        ok: false,
        status: 429,
        code: "PAIR_RATE_LIMITED",
        message: "配对失败次数过多，请稍后再试",
      };
    }
    if (!this.localSecret || !timingSafeEqualString(submittedSecret.trim(), this.localSecret)) {
      recordFailure();
      return {
        ok: false,
        status: 401,
        code: "LOCAL_SECRET_INVALID",
        message: "本机配对密钥无效，请确认服务端正在运行或改用配对码",
      };
    }
    this.ipFailures.delete(key);
    const token = `psb_${crypto.randomBytes(32).toString("hex")}`;
    const deviceId = `dev_${crypto.randomUUID().slice(0, 12)}`;
    return { ok: true, token, deviceId };
  }
}
