import { addCalendarDays, localDay } from "../core/clock.ts";
import {
  DEFAULT_CIRCADIAN_CONFIG,
  type CircadianConfig,
  type DoorState,
} from "../core/config.ts";

export type HeartbeatDecision =
  | { action: "idle" }
  | { action: "sleep_tidy"; nightDate: string }
  | { action: "proactive"; reason: string };

export interface HeartbeatSnapshot {
  nowMs: number;
  timeZone: string;
  circadian?: CircadianConfig;
  doorState: DoorState;
  /** 上次完成 bedtime 睡前整理对应的夜晚日期（YYYY-MM-DD） */
  lastBedtimeNightDate: string | null;
  /** 上次任意有效对话/唤醒时间戳（Unix 毫秒） */
  lastInteractionMs: number | null;
  /** 上次主动唤醒时间戳（Unix 毫秒） */
  lastWakeMs: number | null;
  /** 连续未回的主动唤醒次数（用户发新消息/纸条时重置为 0） */
  consecutiveUnansweredWakes: number;
  /** 未读门缝纸条数量 */
  unreadDoorNotesCount: number;
  /** 最早一条未读门缝纸条的创建时间（Unix 毫秒） */
  oldestUnreadDoorNoteMs: number | null;
}

function parseHhMm(hhmm: string, fallbackMin: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return fallbackMin;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallbackMin;
  return h * 60 + min;
}

function getLocalMinutesOfDay(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * 判断某时刻是否处于睡眠静默窗内，并返回所属“夜晚日期” YYYY-MM-DD：
 * 跨午夜窗口（如 23:30–07:30）下，次日 00:15 归属前一日夜晚，杜绝同一夜跑两次 bedtime。
 */
export function getSleepWindowStatus(
  nowMs: number,
  timeZone: string,
  circadian: CircadianConfig = DEFAULT_CIRCADIAN_CONFIG,
): { inSleepWindow: boolean; nightDate: string } {
  const startMin = parseHhMm(circadian.sleepStart, 23 * 60 + 30);
  const endMin = parseHhMm(circadian.sleepEnd, 7 * 60 + 30);
  const curMin = getLocalMinutesOfDay(nowMs, timeZone);
  const today = localDay(nowMs, timeZone);

  if (startMin > endMin) {
    // 跨午夜窗口（如 23:30 -> 07:30）
    if (curMin >= startMin) {
      return { inSleepWindow: true, nightDate: today };
    }
    if (curMin < endMin) {
      return { inSleepWindow: true, nightDate: addCalendarDays(today, -1) };
    }
    return { inSleepWindow: false, nightDate: today };
  }

  // 同日窗口（如 01:00 -> 08:00）
  const inWin = curMin >= startMin && curMin < endMin;
  return { inSleepWindow: inWin, nightDate: today };
}

/** 输出客观作息状态短语，严禁泄露内部情绪浮点数（NG-4） */
export function renderCircadianState(
  nowMs: number,
  timeZone: string,
  circadian: CircadianConfig = DEFAULT_CIRCADIAN_CONFIG,
): "清醒" | "临近睡前" | "夜间静默窗" {
  const status = getSleepWindowStatus(nowMs, timeZone, circadian);
  if (status.inSleepWindow) return "夜间静默窗";

  const startMin = parseHhMm(circadian.sleepStart, 23 * 60 + 30);
  const curMin = getLocalMinutesOfDay(nowMs, timeZone);
  const diffToSleep = (startMin - curMin + 1440) % 1440;
  if (diffToSleep > 0 && diffToSleep <= 60) {
    return "临近睡前";
  }
  return "清醒";
}

/**
 * Ring 1 扁平作息心跳确定性判定器（对齐 Spec 03 §3.2）：
 * 1) 落入睡眠窗且当夜未跑过 bedtime -> sleep_tidy；
 * 2) 仍在睡眠窗内 -> idle；
 * 3) 清醒期满足冷却、未回上限 < 2，且满足未读纸条 ≥ 30m 或开门闲置 ≥ proactiveMinGapMin -> proactive。
 */
export function evaluateHeartbeat(snap: HeartbeatSnapshot): HeartbeatDecision {
  const cfg = snap.circadian ?? DEFAULT_CIRCADIAN_CONFIG;
  const { inSleepWindow, nightDate } = getSleepWindowStatus(snap.nowMs, snap.timeZone, cfg);

  if (inSleepWindow) {
    if (snap.lastBedtimeNightDate !== nightDate) {
      return { action: "sleep_tidy", nightDate };
    }
    return { action: "idle" };
  }

  if (!cfg.proactiveEnabled) {
    return { action: "idle" };
  }
  if (snap.consecutiveUnansweredWakes >= 2) {
    return { action: "idle" };
  }
  if (
    snap.lastWakeMs !== null &&
    snap.nowMs - snap.lastWakeMs < cfg.proactiveCooldownMin * 60_000
  ) {
    return { action: "idle" };
  }

  // 动因 1：存在未读门缝纸条且最早一条已过 30 分钟
  if (
    snap.unreadDoorNotesCount > 0 &&
    snap.oldestUnreadDoorNoteMs !== null &&
    snap.nowMs - snap.oldestUnreadDoorNoteMs >= 30 * 60_000
  ) {
    return {
      action: "proactive",
      reason: `门缝有 ${snap.unreadDoorNotesCount} 条未读纸条`,
    };
  }

  // 动因 2：门开着且距上次互动已达设定间隔
  if (
    snap.doorState === "open" &&
    snap.lastInteractionMs !== null &&
    snap.nowMs - snap.lastInteractionMs >= cfg.proactiveMinGapMin * 60_000
  ) {
    const hours = Math.max(1, Math.round((snap.nowMs - snap.lastInteractionMs) / 3_600_000));
    return {
      action: "proactive",
      reason: `距上次对话已过约 ${hours} 小时`,
    };
  }

  return { action: "idle" };
}
