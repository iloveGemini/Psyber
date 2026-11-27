import { stripFrontmatter } from "../core/prompts.ts";

export type CoreDateKind = "celebrate" | "gentle" | "milestone" | "deadline" | "ordinary";

export interface ParsedCoreDateEntry {
  /** 若填写了年份则为 4 位数字（用于计算周年或一次性 deadline），否则为 null（每年循环） */
  year: number | null;
  month: number;
  day: number;
  kind: CoreDateKind;
  text: string;
}

export interface UpcomingCoreDateMatch {
  entry: ParsedCoreDateEntry;
  /** 距离今日的天数（0 = 今天，1 = 明天，...） */
  daysUntil: number;
  /** 本次命中对应的公历日期 YYYY-MM-DD */
  occurrenceDay: string;
  /** 若条目带起始年份且为周期类（非 deadline）且跨年，记录第 N 周年 */
  anniversaryYears: number | null;
}

function normalizeDateKind(raw: string | undefined): CoreDateKind {
  const token = (raw ?? "").trim().toLowerCase();
  if (!token) return "ordinary";
  if (token === "celebrate" || token === "庆祝" || token === "喜庆" || token === "生日") {
    return "celebrate";
  }
  if (token === "gentle" || token === "忌日" || token === "轻声" || token === "哀思") {
    return "gentle";
  }
  if (token === "milestone" || token === "里程碑" || token === "周年") {
    return "milestone";
  }
  if (token === "deadline" || token === "截止" || token === "日程" || token === "倒计时") {
    return "deadline";
  }
  return "ordinary";
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function parseYmd(ymd: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function toUtcDayIndex(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function formatYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 宽容解析 `memory/core/dates.md` 中的周期纪念日、生日、忌日与里程碑条目：
 * 支持格式：
 * - `- [05-12 | celebrate] 生日`
 * - `- [04-03 | gentle] 某位亲人忌日`
 * - `- [2026-10-12 | milestone] 定名日`
 * - `- [2027-01-15 | deadline] 重要截止日`
 * - `- [05-12] 某日`（缺省归为 ordinary）
 */
export function parseCoreDates(markdown: string): ParsedCoreDateEntry[] {
  const body = stripFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  const entries: ParsedCoreDateEntry[] = [];

  const lineRe =
    /^\s*(?:[-*+]\s+)?\[(?:(\d{4})-)?(\d{1,2})-(\d{1,2})(?:\s*[|｜]\s*([^\]]+))?\]\s*(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = lineRe.exec(trimmed);
    if (!m) continue;
    const year = m[1] ? Number(m[1]) : null;
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12) continue;
    // 允许 02-29 写入周期条目（平年自动落在 02-28）
    const maxDay = year !== null ? daysInMonth(year, month) : month === 2 ? 29 : daysInMonth(2024, month);
    if (day < 1 || day > maxDay) continue;
    const kind = normalizeDateKind(m[4]);
    const text = m[5]!.trim();
    if (!text) continue;
    entries.push({ year, month, day, kind, text });
  }

  return entries;
}

/**
 * 筛选出距离 `todayStr`（YYYY-MM-DD）在 `[0, windowDays]` 天内命中的重要日子：
 * - 支持跨年窗口（如 12-28 向后看 7 天覆盖次年 01-01..01-04）；
 * - 闰日 02-29 在平年自动折算为 02-28；
 * - `deadline` 仅在指定年份当次触发，不跨年循环；其余带起始年份的条目自动计算第 N 周年。
 */
export function findUpcomingCoreDates(
  markdown: string,
  todayStr: string,
  windowDays = 7,
): UpcomingCoreDateMatch[] {
  const today = parseYmd(todayStr);
  if (!today) return [];
  const safeWindow = Math.max(0, Math.min(60, Math.floor(windowDays)));
  const todayIdx = toUtcDayIndex(today.year, today.month, today.day);
  const entries = parseCoreDates(markdown);
  const matches: UpcomingCoreDateMatch[] = [];

  for (const entry of entries) {
    if (entry.kind === "deadline" && entry.year !== null) {
      const targetIdx = toUtcDayIndex(entry.year, entry.month, entry.day);
      const diff = targetIdx - todayIdx;
      if (diff >= 0 && diff <= safeWindow) {
        matches.push({
          entry,
          daysUntil: diff,
          occurrenceDay: formatYmd(entry.year, entry.month, entry.day),
          anniversaryYears: null,
        });
      }
      continue;
    }

    // 检查当年与次年（处理跨年 7 天窗口）
    for (const candidateYear of [today.year, today.year + 1]) {
      // 若带起始年份，不在起始年份之前触发
      if (entry.year !== null && candidateYear < entry.year) continue;
      const effDay =
        entry.month === 2 && entry.day === 29 && !isLeapYear(candidateYear) ? 28 : entry.day;
      const targetIdx = toUtcDayIndex(candidateYear, entry.month, effDay);
      const diff = targetIdx - todayIdx;
      if (diff >= 0 && diff <= safeWindow) {
        const anniversaryYears =
          entry.year !== null && candidateYear > entry.year ? candidateYear - entry.year : null;
        matches.push({
          entry,
          daysUntil: diff,
          occurrenceDay: formatYmd(candidateYear, entry.month, effDay),
          anniversaryYears,
        });
        break;
      }
    }
  }

  matches.sort(
    (a, b) =>
      a.daysUntil - b.daysUntil ||
      a.occurrenceDay.localeCompare(b.occurrenceDay) ||
      a.entry.text.localeCompare(b.entry.text),
  );
  return matches;
}

function formatDaysUntilLabel(daysUntil: number): string {
  if (daysUntil === 0) return "今天";
  if (daysUntil === 1) return "明天";
  if (daysUntil === 2) return "后天";
  return `${daysUntil} 天后`;
}

function formatDateKindHint(kind: CoreDateKind): string {
  switch (kind) {
    case "gentle":
      return "敏感忌日·轻声对待，勿自动欢庆";
    case "celebrate":
      return "喜庆纪念日";
    case "milestone":
      return "里程碑";
    case "deadline":
      return "重要日程";
    default:
      return "重要日子";
  }
}

/**
 * 渲染客观结构的 `<upcoming_dates>` 块（严守「判断禁用我」，只报客观日期与分类提示）。
 * 无命中条目时返回 null。
 */
export function renderUpcomingDatesBlock(
  markdown: string,
  todayStr: string,
  windowDays = 7,
): string | null {
  const matches = findUpcomingCoreDates(markdown, todayStr, windowDays);
  if (matches.length === 0) return null;

  const lines = matches.map((m) => {
    const when = formatDaysUntilLabel(m.daysUntil);
    const kindHint = formatDateKindHint(m.entry.kind);
    const anni = m.anniversaryYears !== null ? `（第 ${m.anniversaryYears} 周年）` : "";
    return `- [${when} ${m.occurrenceDay} · ${kindHint}] ${m.entry.text}${anni}`;
  });
  return `<upcoming_dates note="系统按今日日期从 core/dates.md 筛选出的近期重要日子，仅供自然留意">\n${lines.join("\n")}\n</upcoming_dates>`;
}
