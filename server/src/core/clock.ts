/**
 * 统一时钟接口：全库禁止在业务逻辑中裸调 Date.now()，确保虚拟时钟与本地日计算确定性。
 */
export interface Clock {
  now(): number;
  readonly timeZone: string;
}

export class SystemClock implements Clock {
  private readonly tzSource: string | (() => string);

  constructor(timeZone: string | (() => string) = "Asia/Shanghai") {
    this.tzSource = timeZone;
  }

  get timeZone(): string {
    return typeof this.tzSource === "function" ? this.tzSource() : this.tzSource;
  }

  now(): number {
    return Date.now();
  }
}

export class VirtualClock implements Clock {
  private currentMs: number;

  constructor(initialMs: number, public readonly timeZone: string = "Asia/Shanghai") {
    this.currentMs = initialMs;
  }

  now(): number {
    return this.currentMs;
  }

  setTime(ms: number): void {
    this.currentMs = ms;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }

  /** 跳转至指定墙上时间（对齐 Spec 05 §1.1） */
  jumpToWallClock(
    year: number,
    month: number,
    day: number,
    hour = 0,
    minute = 0,
    second = 0,
  ): void {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
    const offset1 = getTimeZoneOffsetMs(utcGuess, this.timeZone);
    const candidate = utcGuess - offset1;
    const offset2 = getTimeZoneOffsetMs(candidate, this.timeZone);
    this.currentMs = utcGuess - offset2;
  }
}

/** 按指定 IANA 时区格式化为 YYYY-MM-DD 本地日历日 */
export function localDay(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));

  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/**
 * 将 YYYY-MM-DD 解析为目标时区当天 00:00:00 的 Unix 毫秒时间戳。
 * 通过 Intl 校准时区偏移，避免直接加减 86_400_000 在夏令时切换日产生 1 小时漂移。
 */
export function localDateStartMs(dateStr: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) {
    throw new Error(`Invalid date format (expected YYYY-MM-DD): ${dateStr}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // 先取 UTC 零点作为初值，再通过目标时区 wall-clock 差值反推精确零点
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset1 = getTimeZoneOffsetMs(utcGuess, timeZone);
  const candidate = utcGuess - offset1;
  const offset2 = getTimeZoneOffsetMs(candidate, timeZone);
  return utcGuess - offset2;
}

function getTimeZoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - epochMs;
}

/** 按日历日加减天数并返回目标日 YYYY-MM-DD */
export function addCalendarDays(dateStr: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) {
    throw new Error(`Invalid date format (expected YYYY-MM-DD): ${dateStr}`);
  }
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 计算两个 YYYY-MM-DD 之间的日历日差（toDate - fromDate） */
export function calendarDayDiff(fromDateStr: string, toDateStr: string): number {
  const toUtcDay = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtcDay(toDateStr) - toUtcDay(fromDateStr)) / 86_400_000);
}

/** 渲染自然模糊时间感（对齐 Spec 02 §8.2） */
export function vagueWhen(targetMs: number, nowMs: number, timeZone: string): string {
  if (targetMs >= nowMs) return "刚才";
  const targetDay = localDay(targetMs, timeZone);
  const nowDay = localDay(nowMs, timeZone);
  const deltaDays = calendarDayDiff(targetDay, nowDay);

  if (deltaDays <= 0) {
    return nowMs - targetMs < 3_600_000 ? "刚才" : "今天早些时候";
  }
  if (deltaDays === 1) return "昨天";
  if (deltaDays === 2) return "前天";
  if (deltaDays <= 6) return "前几天";
  if (deltaDays <= 13) return "上周";
  if (deltaDays <= 25) return "半个月前";
  if (deltaDays <= 45) return "上个月";
  if (deltaDays <= 180) return "几个月前";
  if (deltaDays <= 400) {
    return targetDay.slice(0, 4) !== nowDay.slice(0, 4) ? "去年" : "大半年以前";
  }
  return "很久以前";
}

const WEEKDAY_ZH: Record<string, string> = {
  Sun: "周日",
  Mon: "周一",
  Tue: "周二",
  Wed: "周三",
  Thu: "周四",
  Fri: "周五",
  Sat: "周六",
};

/** 按实例时区返回模糊时段短语（供 <runtime time="..." /> 注入） */
export function vagueTimeOfDay(epochMs: number, timeZone: string): string {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
  const hour = Number(hourStr);
  if (hour < 5) return "凌晨";
  if (hour < 8) return "清晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 17) return "下午";
  if (hour < 20) return "傍晚";
  if (hour < 23) return "晚上";
  return "深夜";
}

/** 按实例时区返回中文星期短语（供 <runtime weekday="..." /> 注入） */
export function localWeekday(epochMs: number, timeZone: string): string {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(new Date(epochMs));
  return WEEKDAY_ZH[short] ?? "未知";
}

const UTC_WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 按 YYYY-MM-DD 日历日直接返回中文星期（不受跨午夜时钟影响） */
export function weekdayOfDay(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return "未知";
  const dow = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return UTC_WEEKDAY_ZH[dow] ?? "未知";
}

/** 按指定 IANA 时区格式化为 YYYY-MM-DD HH:mm 本地时间 */
export function localDateTime(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));

  const get = (type: string, fallback: string) => parts.find((p) => p.type === type)?.value ?? fallback;
  return `${get("year", "1970")}-${get("month", "01")}-${get("day", "01")} ${get("hour", "00")}:${get("minute", "00")}`;
}
