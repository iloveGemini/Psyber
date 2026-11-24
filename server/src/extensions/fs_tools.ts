import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PsyberConfig } from "../core/config.ts";
import type { ToolExecutionContext, ToolRegistry } from "../tools/registry.ts";
import {
  buildBashPolicy,
  expandHomePath,
  findProtectedPathHit,
  isInsideAllowedDirs,
  isPathInside,
  resolveRealPathSafe,
  type BashPolicy,
} from "./bash.ts";

export const DEFAULT_FS_READ_LIMIT = 8_000;
export const MAX_FS_READ_LIMIT = 32_000;
export const MAX_FS_READ_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_FS_WRITE_CHARS = 512 * 1024; // 512 KiB

export interface RegisterFsToolsDeps {
  dataDir: string;
  getConfig: () => PsyberConfig;
}

async function resolveTargetPath(
  rawPath: string,
  policy: BashPolicy,
): Promise<{ ok: true; realPath: string } | { ok: false; reason: string }> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, reason: "path 不能为空。" };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, reason: "路径包含非法空字符。" };
  }
  const expanded = expandHomePath(trimmed);
  const absPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(policy.workspaceDir, expanded);
  const realPath = await resolveRealPathSafe(absPath);

  const hit = findProtectedPathHit(realPath, policy);
  if (hit) {
    return {
      ok: false,
      reason: `已拦截对受保护敏感路径的访问（${path.basename(hit)}）。记忆仓请使用原生 5 记忆工具，私密抽屉请使用 drawer_read/drawer_write。`,
    };
  }
  return { ok: true, realPath };
}

async function atomicWriteLocalFile(realTarget: string, content: string): Promise<void> {
  try {
    const existing = await fs.stat(realTarget);
    if (existing.isDirectory()) {
      throw new Error(`目标是文件夹而非文件：${realTarget}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const dir = path.dirname(realTarget);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.psyber-tmp-${crypto.randomUUID()}.tmp`);
  try {
    const fh = await fs.open(tmpPath, "w");
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmpPath, realTarget);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function previewText(text: string, maxChars = 160): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
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
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

async function ensureWriteAllowedTarget(
  rawPath: string,
  policy: BashPolicy,
): Promise<{ ok: true; realPath: string } | { ok: false; reason: string }> {
  const resolved = await resolveTargetPath(rawPath, policy);
  if (!resolved.ok) return resolved;

  const homeDir = await resolveRealPathSafe(os.homedir());
  if (
    resolved.realPath === "/" ||
    resolved.realPath === homeDir ||
    resolved.realPath === policy.dataDir
  ) {
    return { ok: false, reason: `禁止直接覆写根目录、主目录或实例数据目录：${rawPath}` };
  }
  return resolved;
}

async function requestFsApproval(
  ctx: ToolExecutionContext,
  toolName: "fs_read" | "fs_write" | "fs_edit",
  summary: string,
  args: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; output: string }> {
  if (!ctx.requestApproval) {
    return {
      ok: false,
      output: `工具 "${toolName}" 操作超出免审目录需要用户确认审批，当前非交互轮次已保守拦截`,
    };
  }
  const res = await ctx.requestApproval({
    turnId: ctx.turnId,
    toolName,
    summary,
    arguments: args,
  });
  if (res.decision !== "allow") {
    return {
      ok: false,
      output: res.reason || `用户拒绝了本次 ${toolName} 操作`,
    };
  }
  return { ok: true };
}

/**
 * 注册 Tier 3 本机文件读写工具（fs_read / fs_write / fs_edit）：
 * - 与 Tier 1 纯 memory/ 5 工具彻底隔离，不污染 Static Prefix Prompt Cache；
 * - 复用 bash.ts 的 buildBashPolicy（敏感路径与符号链接硬拦截、allowedDirs 目录边界）；
 * - 权限梯度：
 *   1. 受保护敏感路径（memory/、private/、credentials.json、~/.ssh 等）前置硬拦截；
 *   2. 实例专属 workspace/ 内读/写/改全部免审批；
 *   3. 其余 allowedDirs 内 fs_read 免审批，fs_write / fs_edit 走同步审批；
 *   4. allowedDirs 外（非敏感路径）读/写/改统一走同步审批。
 */
export function registerFsTools(registry: ToolRegistry, deps: RegisterFsToolsDeps): void {
  const { dataDir, getConfig } = deps;

  const loadPolicy = async (): Promise<BashPolicy> => {
    const policy = await buildBashPolicy(dataDir, getConfig().bash);
    await fs.mkdir(policy.workspaceDir, { recursive: true });
    return policy;
  };

  registry.register({
    name: "fs_read",
    tier: 3,
    security: "guarded",
    description:
      "读取本机非记忆文本文件（相对路径默认位于实例 workspace/，支持绝对路径与 ~/）。严禁读取 memory/、private/ 及凭据文件；允许目录内免审批，目录外需用户确认。",
    tags: ["system", "fs", "file", "read", "本机", "文件", "读取"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径（支持 ~/ 或相对 workspace/）" },
        offset: { type: "integer", description: "可选：起始字符偏移量（默认 0）" },
        limit: { type: "integer", description: "可选：最多读取字符数（默认 8000，上限 32000）" },
      },
      required: ["path"],
    },
    guard: async (args) => {
      const policy = await loadPolicy();
      const res = await resolveTargetPath(String(args.path ?? ""), policy);
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },
    execute: async (args, ctx) => {
      const policy = await loadPolicy();
      const resolved = await resolveTargetPath(String(args.path ?? ""), policy);
      if (!resolved.ok) return { ok: false, output: resolved.reason };

      if (!isInsideAllowedDirs(resolved.realPath, policy)) {
        const approved = await requestFsApproval(
          ctx,
          "fs_read",
          `读取允许目录外的本机文件：${resolved.realPath}`,
          { path: resolved.realPath },
        );
        if (!approved.ok) return approved;
      }

      let st: Awaited<ReturnType<typeof fs.stat>>;
      try {
        st = await fs.stat(resolved.realPath);
      } catch {
        return { ok: false, output: `文件不存在：${resolved.realPath}` };
      }
      if (!st.isFile()) {
        return { ok: false, output: `目标不是普通文件：${resolved.realPath}` };
      }
      if (st.size > MAX_FS_READ_FILE_BYTES) {
        return {
          ok: false,
          output: `文件过大（${st.size} 字节，上限 ${MAX_FS_READ_FILE_BYTES} 字节），建议改用 bash 的 head/tail 分段查看。`,
        };
      }

      const rawBytes = await fs.readFile(resolved.realPath);
      const probeLen = Math.min(rawBytes.length, 4096);
      for (let i = 0; i < probeLen; i += 1) {
        if (rawBytes[i] === 0) {
          return { ok: false, output: `目标似乎是二进制文件，无法以文本方式读取：${resolved.realPath}` };
        }
      }

      const content = rawBytes.toString("utf8");
      const offset =
        typeof args.offset === "number" && Number.isFinite(args.offset)
          ? Math.max(0, Math.floor(args.offset))
          : 0;
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(MAX_FS_READ_LIMIT, Math.floor(args.limit)))
          : DEFAULT_FS_READ_LIMIT;

      const slice = content.slice(offset, offset + limit);
      const remaining = content.length - (offset + slice.length);
      const suffix =
        remaining > 0 ? `\n[文件后续还有 ${remaining} 字符，可传 offset=${offset + slice.length} 继续读取]` : "";
      return { ok: true, output: slice + suffix };
    },
  });

  registry.register({
    name: "fs_write",
    tier: 3,
    security: "guarded",
    description:
      "新建或覆写本机非记忆文本文件（相对路径默认位于实例 workspace/，支持绝对路径与 ~/）。workspace/ 内免审批，其他目录需用户确认审批；严禁写入 memory/、private/ 与敏感目录。",
    tags: ["system", "fs", "file", "write", "本机", "文件", "写入"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径（支持 ~/ 或相对 workspace/）" },
        content: { type: "string", description: "要写入的完整文本内容" },
      },
      required: ["path", "content"],
    },
    guard: async (args) => {
      const content = typeof args.content === "string" ? args.content : "";
      if (content.length > MAX_FS_WRITE_CHARS) {
        return { ok: false, reason: `写入内容过长（超过 ${MAX_FS_WRITE_CHARS} 字符上限）。` };
      }
      const policy = await loadPolicy();
      const res = await ensureWriteAllowedTarget(String(args.path ?? ""), policy);
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },
    execute: async (args, ctx) => {
      const content = typeof args.content === "string" ? args.content : "";
      const policy = await loadPolicy();
      const resolved = await ensureWriteAllowedTarget(String(args.path ?? ""), policy);
      if (!resolved.ok) return { ok: false, output: resolved.reason };

      // 仅实例专属 workspace/ 内免审批写入，其余目录均走同步确认审批
      if (!isPathInside(resolved.realPath, policy.workspaceDir)) {
        const approved = await requestFsApproval(
          ctx,
          "fs_write",
          `写入本机文件：${resolved.realPath}（${content.length} 字符）`,
          {
            path: resolved.realPath,
            contentLength: content.length,
            contentPreview: previewText(content),
          },
        );
        if (!approved.ok) return approved;
      }

      try {
        await atomicWriteLocalFile(resolved.realPath, content);
        return { ok: true, output: `已写入本机文件：${resolved.realPath}（${content.length} 字符）` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, output: `写入失败：${msg}` };
      }
    },
  });

  registry.register({
    name: "fs_edit",
    tier: 3,
    security: "guarded",
    description:
      "局部精确替换本机非记忆文本文件中的唯一片段（相对路径默认位于实例 workspace/）。workspace/ 内免审批，其他目录需用户确认审批；严禁修改 memory/、private/ 与敏感目录。",
    tags: ["system", "fs", "file", "edit", "本机", "文件", "编辑"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径（支持 ~/ 或相对 workspace/）" },
        old_string: { type: "string", description: "待替换的唯一原文片段" },
        new_string: { type: "string", description: "替换后的新内容" },
      },
      required: ["path", "old_string", "new_string"],
    },
    guard: async (args) => {
      const oldString = typeof args.old_string === "string" ? args.old_string : "";
      if (!oldString) {
        return { ok: false, reason: "old_string 不能为空。" };
      }
      const policy = await loadPolicy();
      const res = await ensureWriteAllowedTarget(String(args.path ?? ""), policy);
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },
    execute: async (args, ctx) => {
      const oldString = String(args.old_string ?? "");
      const newString = String(args.new_string ?? "");
      const policy = await loadPolicy();
      const resolved = await ensureWriteAllowedTarget(String(args.path ?? ""), policy);
      if (!resolved.ok) return { ok: false, output: resolved.reason };

      if (!isPathInside(resolved.realPath, policy.workspaceDir)) {
        const approved = await requestFsApproval(
          ctx,
          "fs_edit",
          `修改本机文件：${resolved.realPath}`,
          {
            path: resolved.realPath,
            oldPreview: previewText(oldString),
            newPreview: previewText(newString),
          },
        );
        if (!approved.ok) return approved;
      }

      let st: Awaited<ReturnType<typeof fs.stat>>;
      try {
        st = await fs.stat(resolved.realPath);
      } catch {
        return { ok: false, output: `文件不存在，无法编辑：${resolved.realPath}` };
      }
      if (!st.isFile()) {
        return { ok: false, output: `目标不是普通文件，无法编辑：${resolved.realPath}` };
      }
      if (st.size > MAX_FS_READ_FILE_BYTES) {
        return {
          ok: false,
          output: `文件过大（${st.size} 字节，上限 ${MAX_FS_READ_FILE_BYTES} 字节），不适合直接局部编辑。`,
        };
      }

      const rawBytes = await fs.readFile(resolved.realPath);
      const probeLen = Math.min(rawBytes.length, 4096);
      for (let i = 0; i < probeLen; i += 1) {
        if (rawBytes[i] === 0) {
          return { ok: false, output: `目标似乎是二进制文件，无法以文本方式编辑：${resolved.realPath}` };
        }
      }
      const original = rawBytes.toString("utf8");

      const positions = findAllOccurrences(original, oldString);
      if (positions.length === 0) {
        return {
          ok: false,
          output: `未在 ${resolved.realPath} 中找到目标片段，请先用 fs_read 确认原文后再编辑。`,
        };
      }
      if (positions.length > 1) {
        const lines = positions.map((p) => offsetToLineNumber(original, p)).join("、");
        return {
          ok: false,
          output: `old_string 在第 ${lines} 行共出现 ${positions.length} 次，请扩大前后文使其唯一。`,
        };
      }

      const start = positions[0]!;
      const updated = original.slice(0, start) + newString + original.slice(start + oldString.length);
      if (updated.length > MAX_FS_WRITE_CHARS) {
        return { ok: false, output: `编辑后文件超过 ${MAX_FS_WRITE_CHARS} 字符上限。` };
      }

      try {
        await atomicWriteLocalFile(resolved.realPath, updated);
        return { ok: true, output: `已更新本机文件：${resolved.realPath}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, output: `保存编辑失败：${msg}` };
      }
    },
  });
}
