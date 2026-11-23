import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { localDay, vagueWhen } from "../core/clock.ts";
import { stripFrontmatter } from "../core/prompts.ts";
import type { StoredEvent } from "../store/events.ts";
import { readIdentityProfile } from "./genesis.ts";
import type { MemoryIndex } from "./index.ts";

export const DEFAULT_GIST_CHAR_BUDGET = 8_000;
export const GIST_SOFT_WARN_RATIO = 0.8;
export const DEFAULT_DAILY_BODY_CHAR_BUDGET = 1800;
export const DEFAULT_TAIL_CHAR_BUDGET = 2000;

type GistSpan = "day" | "month" | "year";

/** 单条读时防跑偏上限（略宽于写作目标 300/600/1000，仅拦单篇异常超长） */
const GIST_ENTRY_MAX_CHARS: Record<GistSpan, number> = {
  day: 400,
  month: 800,
  year: 1200,
};

export interface GistEntry {
  span: GistSpan;
  key: string;
  text: string;
  /** 仅 month (YYYY-MM-DD) 与 year (YYYY-MM) 有效，表示已滚动覆盖到的截止位置 */
  coveredUntil?: string;
}

export interface ActiveGistLayers {
  years: GistEntry[];
  activeMonths: GistEntry[];
  activeDays: GistEntry[];
  allMonths: GistEntry[];
  allDays: GistEntry[];
  totalChars: number;
}

const FULL_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FULL_MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_DIR_RE = /^\d{4}$/;
const MONTH_OR_DAY_DIR_RE = /^\d{2}$/;

function clipText(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function charLen(text: string): number {
  return Array.from(text).length;
}

function parseIndexFrontmatter(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function resolveCoveredUntil(
  fm: Record<string, unknown>,
  span: "month" | "year",
  key: string,
  today: string,
): string {
  const rawCovered = typeof fm.covered_until === "string" ? fm.covered_until.trim() : "";
  const rawUpdated = typeof fm.updated === "string" ? fm.updated.trim() : "";

  if (span === "month") {
    if (FULL_DAY_RE.test(rawCovered)) return rawCovered;
    if (key < today.slice(0, 7)) return `${key}-31`;
    if (FULL_DAY_RE.test(rawUpdated) && rawUpdated.startsWith(key)) return rawUpdated;
    return `${key}-31`;
  }

  // span === "year"
  if (FULL_MONTH_RE.test(rawCovered)) return rawCovered;
  if (FULL_DAY_RE.test(rawCovered)) return rawCovered.slice(0, 7);
  if (key < today.slice(0, 4)) return `${key}-12`;
  if (FULL_DAY_RE.test(rawUpdated) && rawUpdated.startsWith(key)) return rawUpdated.slice(0, 7);
  if (FULL_MONTH_RE.test(rawUpdated) && rawUpdated.startsWith(key)) return rawUpdated;
  return `${key}-12`;
}

async function readIndexFile(
  absPath: string,
  span: GistSpan,
  key: string,
  today: string,
): Promise<GistEntry | null> {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    const body = stripFrontmatter(raw).trim();
    if (!body) return null;
    if (span === "day") {
      return { span, key, text: body };
    }
    const fm = parseIndexFrontmatter(raw);
    return {
      span,
      key,
      text: body,
      coveredUntil: resolveCoveredUntil(fm, span, key, today),
    };
  } catch {
    return null;
  }
}

/**
 * 扫描分形情景目录 `memory/episodes/` 下的三层 `index.md`：
 * - `episodes/YYYY/index.md` -> year（含 covered_until: YYYY-MM）
 * - `episodes/YYYY/MM/index.md` -> month（含 covered_until: YYYY-MM-DD）
 * - `episodes/YYYY/MM/DD/index.md` -> day
 */
export async function scanEpisodeIndexes(
  memoryDir: string,
  today = new Date().toISOString().slice(0, 10),
): Promise<{
  days: GistEntry[];
  months: GistEntry[];
  years: GistEntry[];
}> {
  const episodesDir = path.join(memoryDir, "episodes");
  const days: GistEntry[] = [];
  const months: GistEntry[] = [];
  const years: GistEntry[] = [];

  let yearEntries;
  try {
    yearEntries = await fs.readdir(episodesDir, { withFileTypes: true });
  } catch {
    return { days, months, years };
  }

  for (const yEnt of yearEntries) {
    if (!yEnt.isDirectory() || !YEAR_DIR_RE.test(yEnt.name)) continue;
    const yearKey = yEnt.name;
    const yearDir = path.join(episodesDir, yearKey);

    const yearEntry = await readIndexFile(path.join(yearDir, "index.md"), "year", yearKey, today);
    if (yearEntry) years.push(yearEntry);

    let monthEntries;
    try {
      monthEntries = await fs.readdir(yearDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const mEnt of monthEntries) {
      if (!mEnt.isDirectory() || !MONTH_OR_DAY_DIR_RE.test(mEnt.name)) continue;
      const monthKey = `${yearKey}-${mEnt.name}`;
      const monthDir = path.join(yearDir, mEnt.name);

      const monthEntry = await readIndexFile(
        path.join(monthDir, "index.md"),
        "month",
        monthKey,
        today,
      );
      if (monthEntry) months.push(monthEntry);

      let dayEntries;
      try {
        dayEntries = await fs.readdir(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const dEnt of dayEntries) {
        if (!dEnt.isDirectory() || !MONTH_OR_DAY_DIR_RE.test(dEnt.name)) continue;
        const dayKey = `${monthKey}-${dEnt.name}`;
        const dayEntry = await readIndexFile(
          path.join(monthDir, dEnt.name, "index.md"),
          "day",
          dayKey,
          today,
        );
        if (dayEntry) days.push(dayEntry);
      }
    }
  }

  days.sort((a, b) => a.key.localeCompare(b.key));
  months.sort((a, b) => a.key.localeCompare(b.key));
  years.sort((a, b) => a.key.localeCompare(b.key));
  return { days, months, years };
}

/**
 * 计算严格零重叠、零断层的激活态三层梗概集合：
 * - 年：全部 `YYYY/index.md`
 * - 没滚进年的月：`YYYY-MM > 该年 covered_until`
 * - 没滚进月的天：所属月未滚进年，且 `YYYY-MM-DD > 该月 covered_until`
 */
export async function selectActiveGistLayers(
  memoryDir: string,
  today: string,
): Promise<ActiveGistLayers> {
  const { days: allDays, months: allMonths, years } = await scanEpisodeIndexes(memoryDir, today);

  const yearCoverage = new Map<string, string>();
  for (const y of years) {
    if (y.coveredUntil) yearCoverage.set(y.key, y.coveredUntil);
  }

  const monthCoverage = new Map<string, string>();
  for (const m of allMonths) {
    if (m.coveredUntil) monthCoverage.set(m.key, m.coveredUntil);
  }

  const activeMonths = allMonths.filter((m) => {
    const yCov = yearCoverage.get(m.key.slice(0, 4));
    return !yCov || m.key > yCov;
  });

  const activeDays = allDays.filter((d) => {
    const yKey = d.key.slice(0, 4);
    const mKey = d.key.slice(0, 7);
    const yCov = yearCoverage.get(yKey);
    if (yCov && mKey <= yCov) return false;
    const mCov = monthCoverage.get(mKey);
    return !mCov || d.key > mCov;
  });

  const entrySize = (e: GistEntry) =>
    e.key.length + 2 + Math.min(GIST_ENTRY_MAX_CHARS[e.span], charLen(e.text)) + 1;
  const totalChars =
    years.reduce((sum, e) => sum + entrySize(e), 0) +
    activeMonths.reduce((sum, e) => sum + entrySize(e), 0) +
    activeDays.reduce((sum, e) => sum + entrySize(e), 0);

  return {
    years,
    activeMonths,
    activeDays,
    allMonths,
    allDays,
    totalChars,
  };
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
  /** 上次完成 bedtime 的夜晚日期 YYYY-MM-DD（用于兜底 lastGistDay） */
  lastBedtimeNightDate?: string | null;
  /** 上一段末尾的原始对话事件（应已按 seq <= carryOverUntilSeq 截取） */
  tailEvents?: StoredEvent[];
  /** 将用户事件格式化为自然文本（贴纸/图片标记） */
  formatUserEvent?: (ev: StoredEvent) => string;
  /** 自传梗概总字符硬上限（默认 8000 字） */
  gistCharBudget?: number;
  /** 未入日梗概的近期 episodes/ 正文总字符上限（默认 1800） */
  dailyBodyCharBudget?: number;
  /** 上一段末尾原话总字符上限（默认 2000） */
  tailCharBudget?: number;
}

/**
 * 组装新会话 <continuity> 连续性块：
 * 1. 基于 covered_until 的零重叠三层自传骨架：年 + 未滚进年的月 + 未滚进月的天（共享 8000 字硬预算，从近往远保底）；
 * 2. 【最近的经历】：仅收录晚于 lastGistDay 的活跃 episodes/ 切片正文（填平盘中换段空白；旧卡交给召回）；
 * 3. 【上一段末尾的原话】：按字符预算（默认 2000 字）从旧段末尾向前截取真实对话，按模糊时间分组。
 */
export async function buildContinuityBlock(opts: BuildContinuityOptions): Promise<string | null> {
  const memoryDir = path.join(opts.dataDir, "memory");
  const today = localDay(opts.nowMs, opts.timeZone);
  const shortDay = (day: string) => (day.startsWith(today.slice(0, 5)) ? day.slice(5) : day);

  const [layers, identity] = await Promise.all([
    selectActiveGistLayers(memoryDir, today),
    readIdentityProfile(opts.dataDir, opts.nowMs, opts.timeZone),
  ]);
  const userLabel = identity.userName ?? identity.userPronoun ?? "TA";

  // 预算从近往远保底分配（天 > 月 > 年），渲染时按时间从远往近（年 -> 月 -> 天）
  const gistRemaining = { chars: opts.gistCharBudget ?? DEFAULT_GIST_CHAR_BUDGET };
  const days = selectWithinBudget(layers.activeDays, gistRemaining);
  const months = selectWithinBudget(layers.activeMonths, gistRemaining);
  const years = selectWithinBudget(layers.years, gistRemaining);

  // 计算最后一条日梗概覆盖到的日期：用于决定哪些 episodes/ 切片尚未写进日梗概
  let lastGistDay: string | null = null;
  for (let i = layers.allDays.length - 1; i >= 0; i--) {
    if (FULL_DAY_RE.test(layers.allDays[i]!.key)) {
      lastGistDay = layers.allDays[i]!.key;
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

  // 【最近的经历】：仅取晚于 lastGistDay 的活跃 episodes/ 切片正文（不含 episode_index）
  const dailyBudget = opts.dailyBodyCharBudget ?? DEFAULT_DAILY_BODY_CHAR_BUDGET;
  const episodeCandidates = opts.memoryIndex
    .listAllRows()
    .filter((r) => {
      if (r.space !== "episodes") return false;
      if (r.status !== "active" && r.status !== "disputed") return false;
      const cardDay = localDay(Math.max(r.created_at, r.updated_at), opts.timeZone);
      return !lastGistDay || cardDay > lastGistDay;
    });

  const dailyKept: Array<{ day: string; body: string }> = [];
  let dailyUsed = 0;
  let dailyLoadedCount = 0;

  for (const row of episodeCandidates) {
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
          ? `（${userLabel}撤回了一条消息）`
          : opts.formatUserEvent
            ? opts.formatUserEvent(ev)
            : ev.content;
      const trimmed = content.trim();
      if (!trimmed) continue;
      const prefix = ev.kind === "door_note" ? `${userLabel}（门缝纸条）：` : `${userLabel}：`;
      rawTailItems.push({ at: ev.createdAt, line: `${prefix}${trimmed}` });
    } else if (ev.role === "assistant") {
      const base = ev.content.trim();
      if (!base && ev.status !== "retracted") continue;
      const text =
        ev.status === "retracted"
          ? `${base}（我后来撤回了这条消息，${userLabel}看不到内容）`
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
  if (days.length > 0) {
    sections.push(`【天】\n${days.map((g) => `${shortDay(g.key)}：${g.text}`).join("\n")}`);
  }
  if (dailyKept.length > 0) {
    const dailyLines: string[] = [];
    if (dailyDropped > 0) {
      dailyLines.push(`（更早的 ${dailyDropped} 篇近期情景笔记未展开，需要时用 grep / read 查找）`);
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
    "接着之前的日子往下过：上一段会话已整理收尾并切入新段。以下是之前留下的梗概、近期情景笔记与上一段末尾的原话，更早的细节在记忆库里，需要时用 grep / read 查找。",
    "",
    ...sections.flatMap((s, idx) => (idx === 0 ? [s] : ["", s])),
    "</continuity>",
  ].join("\n");
}

/** 兼容入口：仅拼装梗概 + 未入日梗概的近期情景笔记 */
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
