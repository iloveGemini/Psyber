import fs from "node:fs/promises";
import path from "node:path";
import type { Clock } from "../core/clock.ts";
import { vagueWhen } from "../core/clock.ts";
import { atomicWriteFile } from "../core/config.ts";
import { AsyncMutex } from "../core/mutex.ts";
import { detectSecrets, formatMemorySecretBlockError } from "../core/redact.ts";
import {
  VALID_CARD_STATUSES,
  effectiveStatus,
  inferSpace,
  parseCardMarkdown,
  type CardStatus,
} from "./frontmatter.ts";
import { MemoryIndex, validateRegistryYaml } from "./index.ts";

export interface ToolResultImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** 可选临时图片块（仅当轮多步工具循环内送给模型，跨轮不落盘 base64） */
  images?: ToolResultImage[];
}

const FIXED_WRITABLE_FILES = new Set([
  "core/self.md",
  "core/user.md",
  "core/boundaries.md",
  "core/mirror.md",
  "core/open.md",
  "core/state.md",
  "core/glossary.md",
  "core/dates.md",
  "threads/REGISTRY.yaml",
  "entities/REGISTRY.yaml",
]);

const SINGLE_LAYER_MD_DIRS = new Set(["favorite", "lessons", "sensitive"]);
const EPISODE_INDEX_PATH_RE = /^episodes\/\d{4}(?:\/\d{2}(?:\/\d{2})?)?\/index\.md$/;
const EPISODE_CARD_PATH_RE = /^episodes\/\d{4}\/\d{2}\/\d{2}\/(?:ep|rf)-[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/;
const LIVING_DIR_PATH_RE = /^(threads|entities)\/[a-z0-9][a-z0-9_-]{0,31}\/[^/]+\.md$/;
const REGISTRY_FILES = ["threads/REGISTRY.yaml", "entities/REGISTRY.yaml"] as const;

/** 规范化相对路径并拦截绝对路径、..、\0、隐藏系统目录与 private/ */
export function normalizeRelPath(rawPath: string): { ok: true; rel: string } | { ok: false; error: string } {
  const trimmed = rawPath.trim().replace(/\\/g, "/");
  if (trimmed.includes("\0")) {
    return { ok: false, error: "路径包含非法空字符" };
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) {
    return { ok: false, error: `禁止使用绝对路径: ${rawPath}（请使用相对 memory/ 的路径）` };
  }

  const collapsed = trimmed.replace(/\/+/g, "/").replace(/\/$/, "");
  const segments = collapsed.split("/").filter((s) => s !== "" && s !== ".");
  for (const seg of segments) {
    if (seg === "..") {
      return { ok: false, error: `禁止路径越界（..）: ${rawPath}` };
    }
    if (seg === ".git" || seg === ".tmp" || seg.endsWith(".sqlite") || seg.includes(".sqlite-")) {
      return { ok: false, error: `禁止访问系统内部文件或目录: ${rawPath}` };
    }
  }
  const rel = segments.join("/");
  const lowerRel = rel.toLowerCase();
  if (lowerRel === "private" || lowerRel.startsWith("private/")) {
    return { ok: false, error: "常规 5 工具仅操作 memory/，私密抽屉请通过独立抽屉工具访问" };
  }
  return { ok: true, rel };
}

export function isAllowedWritePath(rel: string): boolean {
  if (FIXED_WRITABLE_FILES.has(rel)) return true;
  if (EPISODE_INDEX_PATH_RE.test(rel)) return true;
  if (EPISODE_CARD_PATH_RE.test(rel)) return true;
  if (LIVING_DIR_PATH_RE.test(rel)) return true;

  const parts = rel.split("/");
  if (parts.length === 2 && SINGLE_LAYER_MD_DIRS.has(parts[0]) && parts[1].endsWith(".md")) {
    return true;
  }
  return false;
}

/** 校验真实解析后的路径不会通过符号链接逃逸出 <dataDir>/memory/ */
async function assertInsideMemoryRoot(memoryDir: string, absTarget: string): Promise<boolean> {
  const realRoot = await fs.realpath(memoryDir);
  let probe = absTarget;
  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      return realProbe === realRoot || realProbe.startsWith(realRoot + path.sep);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

/** 将简单 glob 通配符转为正则表达式（仅匹配相对路径） */
function globToRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out);
}

const PUNCT_MAP: Record<string, string> = {
  "\u201c": '"',
  "\u201d": '"',
  "\u2018": "'",
  "\u2019": "'",
  "，": ",",
  "。": ".",
  "：": ":",
  "；": ";",
  "！": "!",
  "？": "?",
  "（": "(",
  "）": ")",
};

/**
 * 构建带原始字符偏移映射表的归一化文本，确保标点/空白归一化回退命中时补丁外字节 100% 不变。
 */
function normalizeWithOffsetMap(input: string): { norm: string; origStarts: number[]; origEnds: number[] } {
  let norm = "";
  const origStarts: number[] = [];
  const origEnds: number[] = [];

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\r" && input[i + 1] === "\n") {
      norm += "\n";
      origStarts.push(i);
      origEnds.push(i + 2);
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t") {
      const start = i;
      while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
      norm += " ";
      origStarts.push(start);
      origEnds.push(i);
      continue;
    }
    const mapped = PUNCT_MAP[ch] ?? ch;
    norm += mapped;
    origStarts.push(i);
    origEnds.push(i + 1);
    i++;
  }
  return { norm, origStarts, origEnds };
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    positions.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return positions;
}

function offsetToLineNumber(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** 计算与 old_string 首行最相似的 Top-2 原文件片段（带行号），用于 edit 零命中自救（Spec 02 §1.3） */
function findClosestFragments(original: string, oldString: string): string[] {
  const targetLine = oldString.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? oldString.trim();
  if (!targetLine) return [];
  const targetChars = new Set(Array.from(targetLine.toLowerCase()));
  const lines = original.split(/\r?\n/);

  const scored = lines
    .map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return { idx, line, score: 0 };
      let overlap = 0;
      for (const ch of new Set(Array.from(trimmed.toLowerCase()))) {
        if (targetChars.has(ch)) overlap++;
      }
      const score = overlap / Math.max(targetChars.size, trimmed.length, 1);
      return { idx, line, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return scored.map((s) => {
    const snippet = s.line.length > 120 ? s.line.slice(0, 120) + "…" : s.line;
    return `L${s.idx + 1}: ${snippet}`;
  });
}

/**
 * 原生 5 记忆文件工具（Ring 1 纯 memory/ 单根沙箱，写操作串行互斥 + 原子写 + 即时增量索引）。
 */
export class MemoryTools {
  private readonly writeMutex = new AsyncMutex();

  constructor(
    private readonly dataDir: string,
    private readonly index: MemoryIndex,
    private readonly clock: Clock,
  ) {}

  private get memoryDir(): string {
    return path.join(this.dataDir, "memory");
  }

  /** MemoryWriteMutex：串行化 memory/ 磁盘写操作，read/glob/grep 不加锁 */
  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.writeMutex.runExclusive(fn);
  }

  private validateCardBeforeWrite(
    rel: string,
    content: string,
    clockOverride?: Clock,
  ): { error: string | null; note: string } {
    const secretHits = detectSecrets(content);
    if (secretHits.length > 0) {
      return { error: formatMemorySecretBlockError(secretHits), note: "" };
    }

    if (rel === "threads/REGISTRY.yaml" || rel === "entities/REGISTRY.yaml") {
      const check = validateRegistryYaml(rel, content);
      return { error: check.ok ? null : check.error, note: "" };
    }

    const activeClock = clockOverride ?? this.clock;
    const nowMs = activeClock.now();
    const parsed = parseCardMarkdown(rel, content, nowMs, activeClock.timeZone, true);
    const rawStatus = parsed.rawFrontmatter.status;
    if (typeof rawStatus === "string" && !VALID_CARD_STATUSES.has(rawStatus.trim() as CardStatus)) {
      return {
        error: `非法 status 取值 "${rawStatus}"，合法值为: active | resolved | disputed | faded | archived`,
        note: "",
      };
    }

    const notes: string[] = [];
    if (
      parsed.kind === "state" &&
      parsed.status === "active" &&
      parsed.expiresAt !== null &&
      parsed.expiresAt <= nowMs
    ) {
      notes.push("提醒：该状态卡的 expires_at 已到期，如需延续请更新期限或清理");
    }
    const normTitle = parsed.title.trim().replace(/\s+/g, " ").toLowerCase();
    const isFixedCoreOrIndex =
      rel.startsWith("core/") || EPISODE_INDEX_PATH_RE.test(rel);
    if (normTitle && !isFixedCoreOrIndex) {
      const dup = this.index
        .listAllRows()
        .find(
          (r) =>
            r.path !== rel &&
            r.title.trim().replace(/\s+/g, " ").toLowerCase() === normTitle,
        );
      if (dup) {
        notes.push(
          `提醒：已有同名标题卡片 ${dup.path}，建议给 title 加简短日期或区分词以保证 [[短标题]] 唯一`,
        );
      }
    }
    return { error: null, note: notes.length > 0 ? `（${notes.join("；")}）` : "" };
  }

  private async resolveWritableTarget(
    rawPath: string,
    actionLabel: string,
  ): Promise<{ ok: true; rel: string; abs: string } | { ok: false; output: string }> {
    const norm = normalizeRelPath(rawPath);
    if (!norm.ok) return { ok: false, output: norm.error };
    const rel = norm.rel;
    if (!rel || !isAllowedWritePath(rel)) {
      return {
        ok: false,
        output: `不允许${actionLabel}路径 "${rawPath}"（仅允许 core/{self,user,boundaries,mirror,open,state,glossary,dates}.md、REGISTRY.yaml、episodes/YYYY[/MM[/DD]]/{index,ep-*,rf-*}.md 或 threads/lessons/entities/favorite/sensitive 下的合规 .md 文件）`,
      };
    }
    const abs = path.join(this.memoryDir, rel);
    if (!(await assertInsideMemoryRoot(this.memoryDir, abs))) {
      return { ok: false, output: `路径逃逸拦截: ${rawPath}` };
    }
    return { ok: true, rel, abs };
  }

  async glob(
    pattern: string,
    opts?: { excludeSpaces?: ReadonlySet<string> },
  ): Promise<ToolResult> {
    const norm = normalizeRelPath(pattern);
    if (!norm.ok) return { ok: false, output: norm.error };
    if (!norm.rel) return { ok: false, output: "pattern 不能为空，例如 episodes/**/*.md" };

    const re = globToRegex(norm.rel);
    const nowMs = this.clock.now();
    const rows = this.index.listAllRows();
    const excludeSpaces = opts?.excludeSpaces;
    const matchedLines: string[] = [];

    for (const row of rows) {
      if (excludeSpaces && excludeSpaces.has(row.space)) continue;
      if (re.test(row.path)) {
        const st = effectiveStatus(row, nowMs);
        matchedLines.push(`${row.path} [status=${st} | ${vagueWhen(row.updated_at, nowMs, this.clock.timeZone)}]`);
      }
    }

    for (const reg of REGISTRY_FILES) {
      if (re.test(reg)) {
        try {
          const stat = await fs.stat(path.join(this.memoryDir, reg));
          matchedLines.push(`${reg} [registry | ${vagueWhen(stat.mtimeMs, nowMs, this.clock.timeZone)}]`);
        } catch {
          // 尚不存在时跳过
        }
      }
    }

    if (matchedLines.length === 0) {
      return { ok: true, output: `未找到匹配 "${norm.rel}" 的记忆文件` };
    }
    const capped = matchedLines.slice(0, 200);
    const suffix =
      matchedLines.length > 200 ? `\n（共 ${matchedLines.length} 条，已截断显示前 200 条）` : "";
    return { ok: true, output: capped.join("\n") + suffix };
  }

  async grep(
    pattern: string,
    subPath?: string,
    includeArchived = false,
    opts?: { excludeSpaces?: ReadonlySet<string> },
  ): Promise<ToolResult> {
    if (!pattern) return { ok: false, output: "检索 pattern 不能为空" };
    let prefix = "";
    if (subPath && subPath.trim()) {
      const norm = normalizeRelPath(subPath);
      if (!norm.ok) return { ok: false, output: norm.error };
      prefix = norm.rel;
    }

    let regex: RegExp;
    let fallbackNote = "";
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(escaped, "i");
      fallbackNote = "[提示：pattern 非合法正则，已自动退化为字面不区分大小写匹配]\n";
    }

    const nowMs = this.clock.now();
    const rows = this.index.listAllRows();
    const excludeSpaces = opts?.excludeSpaces;
    const candidatePaths: string[] = [];

    for (const row of rows) {
      if (excludeSpaces && excludeSpaces.has(row.space)) continue;
      if (prefix && row.path !== prefix && !row.path.startsWith(prefix + "/")) continue;
      const st = effectiveStatus(row, nowMs);
      if (!includeArchived && (st === "resolved" || st === "archived")) continue;
      candidatePaths.push(row.path);
    }

    for (const reg of REGISTRY_FILES) {
      if (prefix && reg !== prefix && !reg.startsWith(prefix + "/")) continue;
      try {
        await fs.access(path.join(this.memoryDir, reg));
        candidatePaths.push(reg);
      } catch {
        // 忽略不存在的注册表
      }
    }

    const hits: string[] = [];
    for (const rel of candidatePaths) {
      if (hits.length >= 50) break;
      let content: string;
      try {
        content = await fs.readFile(path.join(this.memoryDir, rel), "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const excerpt = lines[i].length > 200 ? lines[i].slice(0, 200) + "…" : lines[i];
          hits.push(`${rel}:${i + 1}: ${excerpt}`);
          if (hits.length >= 50) break;
        }
      }
    }

    if (hits.length === 0) {
      return { ok: true, output: `${fallbackNote}未找到包含 "${pattern}" 的记忆片段` };
    }
    return { ok: true, output: fallbackNote + hits.join("\n") };
  }

  /** 支持按 [[短标题]] 或纯标题解析到 memory/ 相对路径（先精确匹配，再唯一子串匹配） */
  private resolveTitleToPath(
    rawTitle: string,
    excludeSpaces?: ReadonlySet<string>,
  ): { kind: "exact"; path: string } | { kind: "ambiguous"; candidates: Array<{ path: string; title: string }> } | { kind: "none" } {
    const cleaned = rawTitle
      .trim()
      .replace(/^\[\[/, "")
      .replace(/\]\]$/, "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    if (!cleaned) return { kind: "none" };
    const rows = this.index
      .listAllRows()
      .filter((r) => !(excludeSpaces && excludeSpaces.has(r.space)));

    const exact = rows.filter(
      (r) => r.title.trim().replace(/\s+/g, " ").toLowerCase() === cleaned,
    );
    if (exact.length === 1) return { kind: "exact", path: exact[0]!.path };
    if (exact.length > 1) {
      return {
        kind: "ambiguous",
        candidates: exact.slice(0, 5).map((r) => ({ path: r.path, title: r.title })),
      };
    }

    const partial = rows.filter((r) =>
      r.title.trim().replace(/\s+/g, " ").toLowerCase().includes(cleaned),
    );
    if (partial.length === 1) return { kind: "exact", path: partial[0]!.path };
    if (partial.length > 1) {
      return {
        kind: "ambiguous",
        candidates: partial.slice(0, 5).map((r) => ({ path: r.path, title: r.title })),
      };
    }
    return { kind: "none" };
  }

  async read(
    rawPath: string,
    opts: { offset?: number; limit?: number; countAccess?: boolean; excludeSpaces?: ReadonlySet<string> } = {},
  ): Promise<ToolResult> {
    const trimmedInput = rawPath.trim();
    const isWikilink = /^\[\[.+\]\]$/.test(trimmedInput);
    const norm = isWikilink ? null : normalizeRelPath(trimmedInput);
    if (norm && !norm.ok) return { ok: false, output: norm.error };
    const excludeSpaces = opts.excludeSpaces;

    let resolvedRel = norm?.rel ?? "";
    let resolvedViaTitle = false;

    const tryResolveByTitle = (): ToolResult | null => {
      const matched = this.resolveTitleToPath(trimmedInput, excludeSpaces);
      if (matched.kind === "exact") {
        resolvedRel = matched.path;
        resolvedViaTitle = true;
        return null;
      }
      if (matched.kind === "ambiguous") {
        const list = matched.candidates.map((c) => `- [[${c.title}]] -> ${c.path}`).join("\n");
        return {
          ok: false,
          output: `标题 "${trimmedInput}" 匹配到多张卡片，请改用更精确的标题或相对路径：\n${list}`,
        };
      }
      return null;
    };

    if (isWikilink) {
      const ambigErr = tryResolveByTitle();
      if (ambigErr) return ambigErr;
      if (!resolvedRel) {
        return { ok: false, output: `未找到标题为 ${trimmedInput} 的记忆卡片` };
      }
    } else if (!resolvedRel) {
      return { ok: false, output: "read 需要提供相对路径或 [[短标题]]" };
    }

    if (excludeSpaces && excludeSpaces.has(inferSpace(resolvedRel).toLowerCase())) {
      return { ok: false, output: `当前访问权限禁止读取受保护记忆分区：${resolvedRel}` };
    }

    let abs = path.join(this.memoryDir, resolvedRel);
    if (!(await assertInsideMemoryRoot(this.memoryDir, abs))) {
      return { ok: false, output: `路径逃逸拦截: ${rawPath}` };
    }

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      if (!isWikilink && !resolvedRel.includes("/")) {
        const ambigErr = tryResolveByTitle();
        if (ambigErr) return ambigErr;
        if (resolvedViaTitle) {
          if (excludeSpaces && excludeSpaces.has(inferSpace(resolvedRel).toLowerCase())) {
            return { ok: false, output: `当前访问权限禁止读取受保护记忆分区：${resolvedRel}` };
          }
          abs = path.join(this.memoryDir, resolvedRel);
          if (!(await assertInsideMemoryRoot(this.memoryDir, abs))) {
            return { ok: false, output: `路径逃逸拦截: ${rawPath}` };
          }
          content = await fs.readFile(abs, "utf8");
        } else {
          const suggestions = this.index
            .listAllRows()
            .filter((r) => !(excludeSpaces && excludeSpaces.has(r.space)))
            .map((r) => r.path)
            .filter((p) => p.includes(path.basename(resolvedRel, ".md")))
            .slice(0, 3);
          const hint = suggestions.length > 0 ? `；相近文件：${suggestions.join(", ")}` : "";
          return { ok: false, output: `文件不存在: ${resolvedRel}${hint}` };
        }
      } else {
        const suggestions = this.index
          .listAllRows()
          .filter((r) => !(excludeSpaces && excludeSpaces.has(r.space)))
          .map((r) => r.path)
          .filter((p) => p.includes(path.basename(resolvedRel, ".md")) || p.startsWith(resolvedRel.split("/")[0]))
          .slice(0, 3);
        const hint = suggestions.length > 0 ? `；相近文件：${suggestions.join(", ")}` : "";
        return { ok: false, output: `文件不存在: ${resolvedRel}${hint}` };
      }
    }

    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.max(1, opts.limit ?? 8000);
    const slice = content.slice(offset, offset + limit);

    const row = this.index.getRow(resolvedRel);
    let prefix = resolvedViaTitle ? `[路径: ${resolvedRel}]\n` : "";
    if (row) {
      const st = effectiveStatus(row, this.clock.now());
      if (st === "faded") {
        prefix += "[索引状态: faded（已过短期 TTL）]\n";
      }
      if (opts.countAccess && offset === 0) {
        this.index.incrementAccess(resolvedRel);
      }
    }

    return { ok: true, output: prefix + slice };
  }

  async write(
    rawPath: string,
    content: string,
    opts?: { clockOverride?: Clock; trustFrontmatterDates?: boolean },
  ): Promise<ToolResult> {
    const target = await this.resolveWritableTarget(rawPath, "写入");
    if (!target.ok) return { ok: false, output: target.output };
    const { rel, abs } = target;

    return this.withWriteLock(async () => {
      if (rel === "core/self.md" || rel === "core/user.md") {
        try {
          await fs.access(abs);
          return {
            ok: false,
            output: `${rel} 禁止整篇覆写，请先 read 后使用 edit 进行局部修改`,
          };
        } catch {
          // 首次创建允许
        }
      }

      const { error, note } = this.validateCardBeforeWrite(rel, content, opts?.clockOverride);
      if (error) return { ok: false, output: error };

      await atomicWriteFile(this.dataDir, abs, content);
      await this.index.reindexFile(
        rel,
        opts?.trustFrontmatterDates ? { trustFrontmatterDates: true } : undefined,
      );
      return { ok: true, output: `已写入 ${rel}${note}` };
    });
  }

  async edit(
    rawPath: string,
    oldString: string,
    newString: string,
    opts?: { clockOverride?: Clock; trustFrontmatterDates?: boolean },
  ): Promise<ToolResult> {
    if (!oldString) {
      return { ok: false, output: "old_string 不能为空" };
    }
    const target = await this.resolveWritableTarget(rawPath, "编辑");
    if (!target.ok) return { ok: false, output: target.output };
    const { rel, abs } = target;

    return this.withWriteLock(async () => {
      let original: string;
      try {
        original = await fs.readFile(abs, "utf8");
      } catch {
        return { ok: false, output: `文件不存在，无法 edit: ${rel}` };
      }

      let updated: string;
      let usedNormalizedFallback = false;

      const exactPositions = findAllOccurrences(original, oldString);
      if (exactPositions.length === 1) {
        const start = exactPositions[0];
        updated = original.slice(0, start) + newString + original.slice(start + oldString.length);
      } else if (exactPositions.length > 1) {
        const lines = exactPositions.map((p) => offsetToLineNumber(original, p)).join("、");
        return {
          ok: false,
          output: `old_string 在第 ${lines} 行共出现 ${exactPositions.length} 次，请扩大前后文使其唯一`,
        };
      } else {
        const normOrig = normalizeWithOffsetMap(original);
        const normOld = normalizeWithOffsetMap(oldString);
        const normPositions = findAllOccurrences(normOrig.norm, normOld.norm);

        if (normPositions.length === 1 && normOld.norm.length > 0) {
          const nStart = normPositions[0];
          const nEnd = nStart + normOld.norm.length - 1;
          const origStart = normOrig.origStarts[nStart];
          const origEnd = normOrig.origEnds[nEnd];
          updated = original.slice(0, origStart) + newString + original.slice(origEnd);
          usedNormalizedFallback = true;
        } else if (normPositions.length > 1) {
          return {
            ok: false,
            output: `归一化匹配发现 ${normPositions.length} 处重复片段，请扩大前后文使其唯一`,
          };
        } else {
          const closest = findClosestFragments(original, oldString);
          const hint = closest.length > 0 ? `\n相近原文片段：\n${closest.join("\n")}` : "";
          return {
            ok: false,
            output: `未在 ${rel} 中找到目标片段，请先 read 确认原文后再 edit${hint}`,
          };
        }
      }

      const { error, note } = this.validateCardBeforeWrite(rel, updated, opts?.clockOverride);
      if (error) return { ok: false, output: error };

      await atomicWriteFile(this.dataDir, abs, updated);
      await this.index.reindexFile(
        rel,
        opts?.trustFrontmatterDates ? { trustFrontmatterDates: true } : undefined,
      );
      const fallbackTag = usedNormalizedFallback ? "（已通过标点/空白归一化匹配成功）" : "";
      return { ok: true, output: `已更新 ${rel}${fallbackTag}${note}` };
    });
  }
}
