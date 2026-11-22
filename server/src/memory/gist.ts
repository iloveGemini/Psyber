import fs from "node:fs/promises";
import path from "node:path";
import { localDay, vagueWhen } from "../core/clock.ts";
import { stripFrontmatter } from "../core/prompts.ts";
import type { StoredEvent } from "../store/events.ts";
import type { MemoryIndex } from "./index.ts";

export const DEFAULT_GIST_CHAR_BUDGET = 16_000;
export const DEFAULT_DAILY_BODY_CHAR_BUDGET = 1800;
export const DEFAULT_TAIL_CHAR_BUDGET = 2000;

type GistSpan = "day" | "week" | "month" | "year";

/** 单条读时防跑偏上限（略宽于写作目标 300/500/800/1000，仅拦单篇异常超长） */
const GIST_ENTRY_MAX_CHARS: Record<GistSpan, number> = {
  day: 400,
  week: 650,
  month: 1000,
  year: 1200,
};

interface GistEntry {
  span: GistSpan;
  key: string;
  text: string;
}

const HEADING_RE: Record<GistSpan, RegExp> = {
  day: /^#{2,3}\s+(\d{4}-\d{2}-\d{2})\b/,
  week: /^#{2,3}\s+(\d{4}-W\d{2})\b/,
  month: /^#{2,3}\s+(\d{4}-\d{2})\b/,
  year: /^#{2,3}\s+(\d{4})\b/,
};

const FULL_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FULL_WEEK_RE = /^\d{4}-W\d{2}$/;

function clipText(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function charLen(text: string): number {
  return Array.from(text).length;
}

/** ISO 周 YYYY-Www（周一起） */
function weekOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  const thursday = t + (3 - dow) * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  const w = Math.floor((thursday - week1Monday) / (7 * 86_400_000)) + 1;
  return `${year}-W${String(w).padStart(2, "0")}`;
}

/** ISO 周归到它周四所在的 YYYY-MM */
function monthOfWeek(week: string): string {
  const [y, w] = week.split("-W").map(Number);
  const jan4 = Date.UTC(y, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  const thursday = week1Monday + ((w - 1) * 7 + 3) * 86_400_000;
  return new Date(thursday).toISOString().slice(0, 7);
}

/**
 * 宽容读取某层梗概目录：兼容「单月/单年文件内多节 `### YYYY-MM-DD`」与「单篇无标题文件」。
 * 同 key 后写覆盖先写，按 key 升序返回。
 */
async function readGistEntries(dir: string, span: GistSpan): Promise<GistEntry[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }

  const re = HEADING_RE[span];
  const byKey = new Map<string, GistEntry>();

  for (const name of names) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const body = stripFrontmatter(raw).trim();
    if (!body) continue;

    const lines = body.split(/\r?\n/);
    const sections: Array<{ key: string; lines: string[] }> = [];
    let current: { key: string; lines: string[] } | null = null;

    for (const line of lines) {
      const m = re.exec(line.trim());
      if (m) {
        if (current) sections.push(current);
        current = { key: m[1], lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) sections.push(current);

    if (sections.length > 0) {
      for (const sec of sections) {
        const text = sec.lines.join("\n").trim();
        if (text) byKey.set(sec.key, { span, key: sec.key, text });
      }
    } else {
      const fallbackKey = path.basename(name, ".md");
      byKey.set(fallbackKey, { span, key: fallbackKey, text: body });
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function selectWithinBudget(
  entries: GistEntry[],
  remaining: { chars: number },
): GistEntry[] {
  const picked: GistEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (remaining.chars < 60) break;
    const labelLen = e.key.length + 2;
    const maxBody = Math.min(GIST_ENTRY_MAX_CHARS[e.span], remaining.chars - labelLen - 2);
    if (maxBody < 24) break;
    const text = clipText(e.text, maxBody);
    picked.unshift({ ...e, text });
    remaining.chars -= labelLen + charLen(text) + 1;
  }
  return picked;
}

export interface BuildContinuityOptions {
  dataDir: string;
  memoryIndex: MemoryIndex;
  nowMs: number;
  timeZone: string;
  /** 上次完成 bedtime 的夜晚日期 YYYY-MM-DD（用于无节标题的日梗概文件兜底 lastGistDay） */
  lastBedtimeNightDate?: string | null;
  /** 上一段末尾的原始对话事件（应已按 seq <= carryOverUntilSeq 截取） */
  tailEvents?: StoredEvent[];
  /** 将用户事件格式化为自然文本（贴纸/图片标记） */
  formatUserEvent?: (ev: StoredEvent) => string;
  /** 自传梗概金字塔总字符上限（默认 3000） */
  gistCharBudget?: number;
  /** 未入日梗概的近期 daily/ 正文总字符上限（默认 1800） */
  dailyBodyCharBudget?: number;
  /** 上一段末尾原话总字符上限（默认 2000） */
  tailCharBudget?: number;
}

/**
 * 组装 Psyche 风格的新会话 <continuity> 连续性块（对齐 Spec 01 §2.5 & Spec 02 §2.3）：
 * 1. 不重叠多尺度自传金字塔：年 / 月 / 周 / 天（从近到远保底预算，绝不被旧周梗概挤掉近期天梗概）；
 * 2. 【最近的经历】：仅收录晚于 lastGistDay 的活跃 daily/ 卡片正文（填平白天盘中换段空白；旧 daily/ 与 activities/ 交给召回）；
 * 3. 【上一段末尾的原话】：按字符预算（默认 2000 字）从旧段末尾向前截取真实对话，按模糊时间分组。
 */
export async function buildContinuityBlock(opts: BuildContinuityOptions): Promise<string | null> {
  const memoryDir = path.join(opts.dataDir, "memory");
  const gistDir = path.join(memoryDir, "gist");
  const today = localDay(opts.nowMs, opts.timeZone);
  const shortDay = (day: string) => (day.startsWith(today.slice(0, 5)) ? day.slice(5) : day);

  const [allDays, allWeeks, allMonths, allYears] = await Promise.all([
    readGistEntries(path.join(gistDir, "days"), "day"),
    readGistEntries(path.join(gistDir, "weeks"), "week"),
    readGistEntries(path.join(gistDir, "months"), "month"),
    readGistEntries(path.join(gistDir, "years"), "year"),
  ]);

  // 严格不重叠金字塔：天（近 7） -> 周（早于最旧那天，近 4） -> 月（早于最旧那周，近 12） -> 年（早于最旧那月，近 5）
  const candDays = allDays.slice(-7);
  const oldestFullDay = candDays.find((d) => FULL_DAY_RE.test(d.key))?.key;
  const candWeeks = allWeeks
    .filter((w) => !oldestFullDay || !FULL_WEEK_RE.test(w.key) || w.key < weekOf(oldestFullDay))
    .slice(-4);
  const oldestFullWeek = candWeeks.find((w) => FULL_WEEK_RE.test(w.key))?.key;
  const oldestWeekMonth = oldestFullWeek
    ? monthOfWeek(oldestFullWeek)
    : oldestFullDay
      ? oldestFullDay.slice(0, 7)
      : undefined;
  const candMonths = allMonths
    .filter((m) => !oldestWeekMonth || m.key < oldestWeekMonth)
    .slice(-12);
  const oldestMonthYear = candMonths[0]?.key.slice(0, 4) ?? oldestWeekMonth?.slice(0, 4);
  const candYears = allYears
    .filter((y) => !oldestMonthYear || y.key < oldestMonthYear)
    .slice(-5);

  // 预算从近往远保底分配（天 > 周 > 月 > 年），渲染时按时间从远往近（年 -> 月 -> 周 -> 天）
  const gistRemaining = { chars: opts.gistCharBudget ?? DEFAULT_GIST_CHAR_BUDGET };
  const days = selectWithinBudget(candDays, gistRemaining);
  const weeks = selectWithinBudget(candWeeks, gistRemaining);
  const months = selectWithinBudget(candMonths, gistRemaining);
  const years = selectWithinBudget(candYears, gistRemaining);

  // 计算最后一条日梗概覆盖到的日期：用于决定哪些 daily/ 尚未写进日梗概
  let lastGistDay: string | null = null;
  for (let i = allDays.length - 1; i >= 0; i--) {
    if (FULL_DAY_RE.test(allDays[i]!.key)) {
      lastGistDay = allDays[i]!.key;
      break;
    }
  }
  if (
    opts.lastBedtimeNightDate &&
    FULL_DAY_RE.test(opts.lastBedtimeNightDate) &&
    (!lastGistDay || opts.lastBedtimeNightDate > lastGistDay)
  ) {
    lastGistDay = opts.lastBedtimeNightDate;
  }

  // 【最近的经历】：仅取晚于 lastGistDay 的活跃 daily/ 正文（睡前换段后自动为空；旧 daily/ 与 activities/ 交给召回）
  const dailyBudget = opts.dailyBodyCharBudget ?? DEFAULT_DAILY_BODY_CHAR_BUDGET;
  const dailyCandidates = opts.memoryIndex
    .listAllRows()
    .filter((r) => {
      if (r.space !== "daily") return false;
      if (r.status !== "active" && r.status !== "disputed") return false;
      const cardDay = localDay(Math.max(r.created_at, r.updated_at), opts.timeZone);
      return !lastGistDay || cardDay > lastGistDay;
    });

  const dailyKept: Array<{ day: string; body: string }> = [];
  let dailyUsed = 0;
  let dailyLoadedCount = 0;

  for (const row of dailyCandidates) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(memoryDir, row.path), "utf8");
    } catch {
      continue;
    }
    const body = stripFrontmatter(raw).trim();
    if (!body) continue;
    dailyLoadedCount += 1;

    const cardDay = localDay(Math.max(row.created_at, row.updated_at), opts.timeZone);
    const len = charLen(body);
    if (dailyKept.length > 0 && dailyUsed + len > dailyBudget) {
      continue;
    }
    const finalBody = dailyKept.length === 0 && len > dailyBudget ? clipText(body, dailyBudget) : body;
    dailyKept.unshift({ day: cardDay, body: finalBody });
    dailyUsed += charLen(finalBody) + 2;
  }
  const dailyDropped = Math.max(0, dailyLoadedCount - dailyKept.length);

  // 【上一段末尾的原话】：从旧段末尾向前按字符预算截（默认 2000 字），按模糊时间分组
  const tailBudget = opts.tailCharBudget ?? DEFAULT_TAIL_CHAR_BUDGET;
  const tailEvents = opts.tailEvents ?? [];
  const rawTailItems: Array<{ at: number; line: string }> = [];
  for (const ev of tailEvents) {
    if (ev.role === "user") {
      const content =
        ev.status === "retracted"
          ? "（对方撤回了一条消息）"
          : opts.formatUserEvent
            ? opts.formatUserEvent(ev)
            : ev.content;
      const trimmed = content.trim();
      if (!trimmed) continue;
      const prefix = ev.kind === "door_note" ? "对方（门缝纸条）：" : "对方：";
      rawTailItems.push({ at: ev.createdAt, line: `${prefix}${trimmed}` });
    } else if (ev.role === "assistant") {
      const base = ev.content.trim();
      if (!base && ev.status !== "retracted") continue;
      const text =
        ev.status === "retracted"
          ? `${base}（我后来撤回了这条消息，对方看不到内容）`
          : base;
      rawTailItems.push({ at: ev.createdAt, line: `我：${text}` });
    }
  }

  const keptTail: Array<{ at: number; line: string }> = [];
  let tailUsed = 0;
  for (let i = rawTailItems.length - 1; i >= 0; i--) {
    const item = rawTailItems[i]!;
    const len = charLen(item.line);
    if (keptTail.length > 0 && tailUsed + len > tailBudget) break;
    const line = keptTail.length === 0 && len > tailBudget ? clipText(item.line, tailBudget) : item.line;
    keptTail.unshift({ at: item.at, line });
    tailUsed += charLen(line) + 1;
  }

  const tailLines: string[] = [];
  let lastWhenLabel = "";
  for (const item of keptTail) {
    const label = vagueWhen(item.at, opts.nowMs, opts.timeZone);
    if (label && label !== lastWhenLabel) {
      tailLines.push(`（${label}）`);
      lastWhenLabel = label;
    }
    tailLines.push(item.line);
  }

  const sections: string[] = [];
  if (years.length > 0) {
    sections.push(`【年】\n${years.map((g) => `${g.key}：${g.text}`).join("\n")}`);
  }
  if (months.length > 0) {
    sections.push(`【月】\n${months.map((g) => `${g.key}：${g.text}`).join("\n")}`);
  }
  if (weeks.length > 0) {
    sections.push(`【周】\n${weeks.map((g) => `${g.key}：${g.text}`).join("\n")}`);
  }
  if (days.length > 0) {
    sections.push(`【天】\n${days.map((g) => `${shortDay(g.key)}：${g.text}`).join("\n")}`);
  }
  if (dailyKept.length > 0) {
    const dailyLines: string[] = [];
    if (dailyDropped > 0) {
      dailyLines.push(`（更早的 ${dailyDropped} 篇近期日常笔记未展开，需要时用 grep / read 查找）`);
    }
    let lastCardDay = "";
    for (const item of dailyKept) {
      if (item.day !== lastCardDay) {
        dailyLines.push(`${shortDay(item.day)}${item.day === today ? "（今天）" : ""}`);
        lastCardDay = item.day;
      }
      dailyLines.push(item.body);
    }
    sections.push(`【最近的经历】\n${dailyLines.join("\n")}`);
  }
  if (tailLines.length > 0) {
    sections.push(`【上一段末尾的原话】\n${tailLines.join("\n")}`);
  }

  if (sections.length === 0) return null;

  return [
    "<continuity>",
    "接着之前的日子往下过：上一段会话已整理收尾并切入新段。以下是之前留下的梗概、近期日常笔记与上一段末尾的原话，更早的细节在记忆库里，需要时用 grep / read 查找。",
    "",
    ...sections.flatMap((s, idx) => (idx === 0 ? [s] : ["", s])),
    "</continuity>",
  ].join("\n");
}

/** 兼容入口：仅拼装梗概 + 未入日梗概的近期日常笔记 */
export async function buildGistBlock(
  dataDir: string,
  memoryIndex: MemoryIndex,
  charBudget = DEFAULT_GIST_CHAR_BUDGET,
): Promise<string | null> {
  return buildContinuityBlock({
    dataDir,
    memoryIndex,
    nowMs: Date.now(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    gistCharBudget: charBudget,
  });
}
