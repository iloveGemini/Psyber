import path from "node:path";
import YAML from "yaml";
import { addCalendarDays, localDateStartMs, localDay } from "../core/clock.ts";

export type CardKind = "episode" | "reflection" | "lesson" | "state" | "work" | "serial" | "note";
export type CardStatus = "active" | "resolved" | "disputed" | "faded" | "archived";
export type DateKind = "ordinary" | "celebrate" | "gentle" | "deadline";

export const VALID_CARD_KINDS = new Set<CardKind>([
  "episode",
  "reflection",
  "lesson",
  "state",
  "work",
  "serial",
  "note",
]);
export const VALID_CARD_STATUSES = new Set<CardStatus>([
  "active",
  "resolved",
  "disputed",
  "faded",
  "archived",
]);
export const VALID_DATE_KINDS = new Set<DateKind>(["ordinary", "celebrate", "gentle", "deadline"]);

export interface ParsedCard {
  relPath: string;
  space: string;
  title: string;
  kind: CardKind;
  status: CardStatus;
  tags: string[];
  whenToRecall: string | null;
  dateKind: DateKind;
  ttlDays: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  body: string;
  rawFrontmatter: Record<string, unknown>;
}

const EPISODE_INDEX_RE = /^episodes\/\d{4}(?:\/\d{2}(?:\/\d{2})?)?\/index\.md$/;

/** 根据相对路径推导卡片所属空间标识（对顶层目录统一做大小写归一化，防止 macOS 大小写不敏感磁盘绕过分区判定） */
export function inferSpace(relPath: string): string {
  const lowerRel = relPath.toLowerCase();
  if (lowerRel === "core/self.md") return "self";
  if (lowerRel === "core/user.md") return "user";
  if (EPISODE_INDEX_RE.test(lowerRel)) return "episode_index";
  const parts = relPath.split("/");
  const top = (parts[0] ?? "").toLowerCase();
  if (
    top === "core" ||
    top === "episodes" ||
    top === "lessons" ||
    top === "favorite" ||
    top === "sensitive" ||
    top === "private"
  ) {
    return top;
  }
  if (top === "threads" && parts.length >= 3) {
    return `thread:${parts[1]}`;
  }
  if (top === "entities" && parts.length >= 3) {
    return `entity:${parts[1]}`;
  }
  return top;
}

function defaultKindForSpace(space: string, relPath: string): CardKind {
  if (space === "episodes") {
    const base = path.basename(relPath, ".md");
    if (base.startsWith("rf-")) return "reflection";
    return "episode";
  }
  if (space === "lessons") return "lesson";
  if (space.startsWith("thread:")) return "work";
  return "note";
}

function splitFrontmatter(markdown: string): { yamlText: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) {
    return { yamlText: null, body: markdown };
  }
  return {
    yamlText: match[1],
    body: markdown.slice(match[0].length),
  };
}

function extractFirstHeading(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}

function fallbackTitleFromPath(relPath: string): string {
  const base = path.basename(relPath, ".md");
  return base.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/^(?:ep|rf|st)-/, "") || base;
}

function datePrefixFromPath(relPath: string): string | null {
  const epMatch = /^episodes\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(relPath);
  if (epMatch) {
    return `${epMatch[1]}-${epMatch[2]}-${epMatch[3]}`;
  }
  const base = path.basename(relPath, ".md");
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(base);
  return match ? match[1] : null;
}

function normalizeTag(tag: string): string {
  return tag.normalize("NFKC").trim();
}

/**
 * 过滤 core/state.md 中已过期的 `[至 YYYY-MM-DD]` 条目（硬护栏，防止过时短期状态继续注入常驻前缀）。
 * 若过滤后已无有效正文行，返回 null。
 */
export function filterActiveStateMarkdown(markdown: string, today: string): string | null {
  const { body } = splitFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  let hasContentLine = false;

  for (const line of lines) {
    const expMatch = /\[(?:至|until:?)\s*(\d{4}-\d{2}-\d{2})\]/i.exec(line);
    if (expMatch && expMatch[1]! < today) {
      continue;
    }
    kept.push(line);
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      hasContentLine = true;
    }
  }

  if (!hasContentLine) return null;
  return kept.join("\n").trim();
}

/**
 * 宽容解析 Markdown 卡片 Frontmatter（落实 NG-2：不因轻微格式偏差崩溃或回滚）。
 */
export function parseCardMarkdown(
  relPath: string,
  markdown: string,
  fileMtimeMs: number,
  timeZone: string,
  contentChanged = false,
): ParsedCard {
  const space = inferSpace(relPath);
  const { yamlText, body } = splitFrontmatter(markdown);

  let raw: Record<string, unknown> = {};
  if (yamlText !== null) {
    try {
      const parsed = YAML.parse(yamlText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      raw = {};
    }
  }

  const title =
    (typeof raw.title === "string" && raw.title.trim()) ||
    extractFirstHeading(body) ||
    fallbackTitleFromPath(relPath);

  const rawKind = typeof raw.kind === "string" ? (raw.kind.trim() as CardKind) : null;
  const kind: CardKind =
    rawKind && VALID_CARD_KINDS.has(rawKind) ? rawKind : defaultKindForSpace(space, relPath);

  const rawStatus = typeof raw.status === "string" ? (raw.status.trim() as CardStatus) : null;
  const status: CardStatus =
    rawStatus && VALID_CARD_STATUSES.has(rawStatus) ? rawStatus : "active";

  const rawDateKind =
    typeof raw.date_kind === "string" ? (raw.date_kind.trim() as DateKind) : null;
  const dateKind: DateKind =
    rawDateKind && VALID_DATE_KINDS.has(rawDateKind) ? rawDateKind : "ordinary";

  const tags: string[] = [];
  if (Array.isArray(raw.tags)) {
    for (const item of raw.tags) {
      const norm = normalizeTag(String(item));
      if (norm && !tags.includes(norm)) tags.push(norm);
    }
  } else if (typeof raw.tags === "string" && raw.tags.trim()) {
    tags.push(normalizeTag(raw.tags));
  }

  const whenToRecall =
    typeof raw.when_to_recall === "string" && raw.when_to_recall.trim()
      ? raw.when_to_recall.trim()
      : null;

  const mtimeDateStr = localDay(fileMtimeMs, timeZone);

  // created_at：优先 frontmatter created -> 路径/文件名日期 -> fileMtime 本地日期
  const createdDateStr =
    (typeof raw.created === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.created.trim())
      ? raw.created.trim()
      : null) ??
    datePrefixFromPath(relPath) ??
    mtimeDateStr;
  const createdAt = localDateStartMs(createdDateStr, timeZone);

  // updated_at：同日保留精确 mtime，非 import 且内容变化时取 max 防改旧卡忘改日期
  let updatedAt = fileMtimeMs;
  if (typeof raw.updated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.updated.trim())) {
    const updStr = raw.updated.trim();
    const parsedUpd = updStr === mtimeDateStr ? fileMtimeMs : localDateStartMs(updStr, timeZone);
    updatedAt = contentChanged && raw.source !== "import" ? Math.max(parsedUpd, fileMtimeMs) : parsedUpd;
  }

  // 兼容短期 state 卡 TTL 与 expires_at（按日历日加减，免疫夏令时偏移）
  let ttlDays: number | null = null;
  let expiresAt: number | null = null;
  if (kind === "state" && status === "active") {
    const rawTtl = Number(raw.ttl_days);
    ttlDays = Number.isInteger(rawTtl) && rawTtl >= 1 && rawTtl <= 365 ? rawTtl : 10;

    if (typeof raw.expires_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.expires_at.trim())) {
      expiresAt = localDateStartMs(raw.expires_at.trim(), timeZone);
    } else if (typeof raw.expires_at === "number" && Number.isFinite(raw.expires_at)) {
      expiresAt = raw.expires_at;
    } else {
      const expireDateStr = addCalendarDays(createdDateStr, ttlDays);
      expiresAt = localDateStartMs(expireDateStr, timeZone);
    }
  }

  return {
    relPath,
    space,
    title,
    kind,
    status,
    tags,
    whenToRecall,
    dateKind,
    ttlDays,
    expiresAt,
    createdAt,
    updatedAt,
    body,
    rawFrontmatter: raw,
  };
}

/**
 * 计算卡片在给定时刻的有效状态：到期短期 state 卡在索引层自动视为 faded，绝不后台篡改磁盘 Markdown。
 */
export function effectiveStatus(
  row: { space: string; kind: string; status: string; expires_at: number | null },
  nowMs: number,
): CardStatus {
  if (
    row.kind === "state" &&
    row.status === "active" &&
    row.expires_at !== null &&
    row.expires_at <= nowMs
  ) {
    return "faded";
  }
  return row.status as CardStatus;
}
