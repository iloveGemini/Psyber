export interface ExpressionPayload {
  haptic?: "light" | "medium" | "double" | "heartbeat";
  atmosphere?: {
    tone: "warm" | "cool" | "dim" | "bright" | "neutral";
    intensity: "subtle" | "noticeable";
    durationSec?: number;
  };
  motion?: "shake" | "breathe" | "hesitate" | "nod";
  stickerId?: string;
  sticker?: { id: string; label: string; url: string };
}

const VALID_HAPTICS = new Set(["light", "medium", "double", "heartbeat"]);
const VALID_TONES = new Set(["warm", "cool", "dim", "bright", "neutral"]);
const VALID_INTENSITIES = new Set(["subtle", "noticeable"]);
const VALID_MOTIONS = new Set(["shake", "breathe", "hesitate", "nod"]);

export const MAX_EXPRESSIONS_PER_TURN = 3;

/**
 * 校验并归一化 express 工具载荷，夹逼 durationSec 至 [3, 120] 秒（默认 15s）。
 */
export function normalizeExpressionPayload(
  raw: Record<string, unknown>,
): { ok: true; payload: ExpressionPayload } | { ok: false; error: string } {
  const out: ExpressionPayload = {};

  if (raw.haptic !== undefined) {
    if (typeof raw.haptic !== "string" || !VALID_HAPTICS.has(raw.haptic)) {
      return { ok: false, error: `非法 haptic 值: ${String(raw.haptic)}` };
    }
    out.haptic = raw.haptic as ExpressionPayload["haptic"];
  }

  if (raw.atmosphere !== undefined) {
    if (!raw.atmosphere || typeof raw.atmosphere !== "object" || Array.isArray(raw.atmosphere)) {
      return { ok: false, error: "atmosphere 必须是对象" };
    }
    const atm = raw.atmosphere as Record<string, unknown>;
    if (typeof atm.tone !== "string" || !VALID_TONES.has(atm.tone)) {
      return { ok: false, error: `非法 atmosphere.tone: ${String(atm.tone)}` };
    }
    if (typeof atm.intensity !== "string" || !VALID_INTENSITIES.has(atm.intensity)) {
      return { ok: false, error: `非法 atmosphere.intensity: ${String(atm.intensity)}` };
    }
    const rawSec = typeof atm.durationSec === "number" && Number.isFinite(atm.durationSec) ? atm.durationSec : 15;
    const durationSec = Math.min(120, Math.max(3, Math.round(rawSec)));
    out.atmosphere = {
      tone: atm.tone as NonNullable<ExpressionPayload["atmosphere"]>["tone"],
      intensity: atm.intensity as NonNullable<ExpressionPayload["atmosphere"]>["intensity"],
      durationSec,
    };
  }

  if (raw.motion !== undefined) {
    if (typeof raw.motion !== "string" || !VALID_MOTIONS.has(raw.motion)) {
      return { ok: false, error: `非法 motion 值: ${String(raw.motion)}` };
    }
    out.motion = raw.motion as ExpressionPayload["motion"];
  }

  if (raw.stickerId !== undefined) {
    if (typeof raw.stickerId !== "string" || !raw.stickerId.trim()) {
      return { ok: false, error: "stickerId 必须是非空字符串" };
    }
    out.stickerId = raw.stickerId.trim();
  }

  if (!out.haptic && !out.atmosphere && !out.motion && !out.stickerId) {
    return { ok: false, error: "express 至少需要提供 haptic、atmosphere、motion、stickerId 之一" };
  }

  return { ok: true, payload: out };
}
