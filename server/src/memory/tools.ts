import fs from "node:fs/promises";
import path from "node:path";
import type { Clock } from "../core/clock.ts";
import { vagueWhen } from "../core/clock.ts";
import { atomicWriteFile } from "../core/config.ts";
import { AsyncMutex } from "../core/mutex.ts";
import {
  VALID_CARD_STATUSES,
  effectiveStatus,
  parseCardMarkdown,
  type CardStatus,
} from "./frontmatter.ts";
import { MemoryIndex, validateRegistryYaml } from "./index.ts";

export interface ToolResult {
  ok: boolean;
  output: string;
}

const FIXED_WRITABLE_FILES = new Set([
  "self.md",
  "user.md",
  "shelf/rules.md",
  "shelf/mirror.md",
  "shelf/threads.md",
  "activities/REGISTRY.yaml",
  "entities/REGISTRY.yaml",
]);

const SINGLE_LAYER_MD_DIRS = new Set(["daily", "favorite"]);
const GIST_PATH_RE = /^gist\/(days|weeks|months|years)\/[a-zA-Z0-9_-]+\.md$/;
const LIVING_DIR_PATH_RE = /^(activities|entities)\/[a-z0-9][a-z0-9_-]{0,31}\/[^/]+\.md$/;
const REGISTRY_FILES = ["activities/REGISTRY.yaml", "entities/REGISTRY.yaml"] as const;

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
  if (rel === "private" || rel.startsWith("private/")) {
    return { ok: false, error: "常规 5 工具仅操作 memory/，私密抽屉请通过独立抽屉工具访问" };
  }
  return { ok: true, rel };
}

export function isAllowedWritePath(rel: string): boolean {
  if (FIXED_WRITABLE_FILES.has(rel)) return true;
  if (GIST_PATH_RE.test(rel)) return true;
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

  private validateCardBeforeWrite(rel: string, content: string): { error: string | null; note: string } {
    if (rel === "activities/REGISTRY.yaml" || rel === "entities/REGISTRY.yaml") {
      const check = validateRegistryYaml(rel, content);
      return { error: check.ok ? null : check.error, note: "" };
    }

    const nowMs = this.clock.now();
    const parsed = parseCardMarkdown(rel, content, nowMs, this.clock.timeZone, true);
    const rawStatus = parsed.rawFrontmatter.status;
    if (typeof rawStatus === "string" && !VALID_CARD_STATUSES.has(rawStatus.trim() as CardStatus)) {
      return {
        error: `非法 status 取值 "${rawStatus}"，合法值为: active | resolved | disputed | faded | archived`,
        note: "",
      };
    }

    if (parsed.space === "daily" && parsed.kind === "state" && parsed.tags.length === 0) {
      return {
        error: "daily/ 下的短期状态卡（kind: state）必须填写非空 tags（建议同时填写 ttl_days）",
        note: "",
      };
    }

    let note = "";
    if (
      parsed.space === "daily" &&
      parsed.kind === "state" &&
      parsed.status === "active" &&
      parsed.expiresAt !== null &&
      parsed.expiresAt <= nowMs
    ) {
      note = "（提醒：该状态卡的 expires_at 已到期，如需延续请更新期限或新建状态卡）";
    }
    return { error: null, note };
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
        output: `不允许${actionLabel}路径 "${rawPath}"（仅允许 self.md、user.md、shelf/{rules,mirror,threads}.md、REGISTRY.yaml 或 daily/favorite/gist/activities/entities 下的合规 .md 文件）`,
      };
    }
    const abs = path.join(this.memoryDir, rel);
    if (!(await assertInsideMemoryRoot(this.memoryDir, abs))) {
      return { ok: false, output: `路径逃逸拦截: ${rawPath}` };
    }
    return { ok: true, rel, abs };
  }

  async glob(pattern: string): Promise<ToolResult> {
    const norm = normalizeRelPath(pattern);
    if (!norm.ok) return { ok: false, output: norm.error };
    if (!norm.rel) return { ok: false, output: "pattern 不能为空，例如 daily/*.md" };

    const re = globToRegex(norm.rel);
    const nowMs = this.clock.now();
    const rows = this.index.listAllRows();
    const matchedLines: string[] = [];

    for (const row of rows) {
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

  async grep(pattern: string, subPath?: string, includeArchived = false): Promise<ToolResult> {
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
    const candidatePaths: string[] = [];

    for (const row of rows) {
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

  async read(
    rawPath: string,
    opts: { offset?: number; limit?: number; countAccess?: boolean } = {},
  ): Promise<ToolResult> {
    const norm = normalizeRelPath(rawPath);
    if (!norm.ok) return { ok: false, output: norm.error };
    if (!norm.rel) return { ok: false, output: "read 需要提供相对路径" };

    const abs = path.join(this.memoryDir, norm.rel);
    if (!(await assertInsideMemoryRoot(this.memoryDir, abs))) {
      return { ok: false, output: `路径逃逸拦截: ${rawPath}` };
    }

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      const suggestions = this.index
        .listAllRows()
        .map((r) => r.path)
        .filter((p) => p.includes(path.basename(norm.rel, ".md")) || p.startsWith(norm.rel.split("/")[0]))
        .slice(0, 3);
      const hint = suggestions.length > 0 ? `；相近文件：${suggestions.join(", ")}` : "";
      return { ok: false, output: `文件不存在: ${norm.rel}${hint}` };
    }

    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.max(1, opts.limit ?? 8000);
    const slice = content.slice(offset, offset + limit);

    const row = this.index.getRow(norm.rel);
    let prefix = "";
    if (row) {
      const st = effectiveStatus(row, this.clock.now());
      if (st === "faded") {
        prefix = "[索引状态: faded（已过短期 TTL）]\n";
      }
      if (opts.countAccess && offset === 0) {
        this.index.incrementAccess(norm.rel);
      }
    }

    return { ok: true, output: prefix + slice };
  }

  async write(rawPath: string, content: string): Promise<ToolResult> {
    const target = await this.resolveWritableTarget(rawPath, "写入");
    if (!target.ok) return { ok: false, output: target.output };
    const { rel, abs } = target;

    return this.withWriteLock(async () => {
      if (rel === "self.md" || rel === "user.md") {
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

      const { error, note } = this.validateCardBeforeWrite(rel, content);
      if (error) return { ok: false, output: error };

      await atomicWriteFile(this.dataDir, abs, content);
      await this.index.reindexFile(rel);
      return { ok: true, output: `已写入 ${rel}${note}` };
    });
  }

  async edit(rawPath: string, oldString: string, newString: string): Promise<ToolResult> {
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

      const { error, note } = this.validateCardBeforeWrite(rel, updated);
      if (error) return { ok: false, output: error };

      await atomicWriteFile(this.dataDir, abs, updated);
      await this.index.reindexFile(rel);
      const fallbackTag = usedNormalizedFallback ? "（已通过标点/空白归一化匹配成功）" : "";
      return { ok: true, output: `已更新 ${rel}${fallbackTag}${note}` };
    });
  }
}
