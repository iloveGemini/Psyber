import {
  normalizeMemoryHistoryPath,
  readMemoryGitLog,
  readMemoryGitShow,
  validateCommitRef,
  validateSinceFilter,
} from "../core/git.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export { normalizeMemoryHistoryPath, validateCommitRef, validateSinceFilter };

export const DEFAULT_MEMORY_HISTORY_LIMIT = 10;
export const MAX_MEMORY_HISTORY_LIMIT = 50;
export const DEFAULT_MEMORY_HISTORY_MAX_CHARS = 8_000;
export const MIN_MEMORY_HISTORY_MAX_CHARS = 500;
export const MAX_MEMORY_HISTORY_MAX_CHARS = 20_000;

function clampMaxChars(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MEMORY_HISTORY_MAX_CHARS;
  return Math.max(
    MIN_MEMORY_HISTORY_MAX_CHARS,
    Math.min(MAX_MEMORY_HISTORY_MAX_CHARS, Math.floor(raw)),
  );
}

function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MEMORY_HISTORY_LIMIT;
  return Math.max(1, Math.min(MAX_MEMORY_HISTORY_LIMIT, Math.floor(raw)));
}

function truncateHistoryOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[记忆历史输出已截断，原始长度 ${text.length} 字符]`;
}

export interface RegisterMemoryHistoryToolDeps {
  dataDir: string;
}

/**
 * 注册 Tier 3 只读记忆历史回溯工具 `memory_history`：
 * - 基于 memory/.git 提供只读 log / show 能力，无需放宽 bash/fs 对 memory/ 的硬拦截；
 * - 固定注册为 Tier 3（security: auto），不污染 Tier 1 Static Prefix Cache；
 * - 严格校验相对路径、commit 引用与输出长度上限。
 */
export function registerMemoryHistoryTool(
  registry: ToolRegistry,
  deps: RegisterMemoryHistoryToolDeps,
): void {
  const { dataDir } = deps;

  registry.register({
    name: "memory_history",
    tier: 3,
    security: "auto",
    description:
      "只读查看自己记忆仓（memory/）的 Git 变更历史：支持列出提交记录（action=log，可按卡片路径或时间筛选）及查看某次提交的具体修改 diff（action=show）。",
    tags: ["memory", "history", "git", "log", "diff", "记忆", "历史", "变更", "版本"],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["log", "show"],
          description: "操作类型：log 查看提交记录列表（默认），show 查看单次提交的具体变更 diff",
        },
        path: {
          type: "string",
          description: "可选：限定查看某个记忆文件或目录的变更（相对于 memory/，如 core/self.md 或 episodes/）",
        },
        commit: {
          type: "string",
          description: "action=show 时必填：提交短哈希或 HEAD / HEAD~1",
        },
        limit: {
          type: "integer",
          description: "可选：action=log 返回的最多提交条数（1–50，默认 10）",
        },
        since: {
          type: "string",
          description: "可选：action=log 起始时间过滤（如 2026-11-01 或 7 days ago）",
        },
        maxChars: {
          type: "integer",
          description: "可选：输出最大字符数（500–20000，默认 8000）",
        },
      },
    },
    guard: async (args) => {
      const action = args.action === undefined ? "log" : String(args.action);
      if (action !== "log" && action !== "show") {
        return { ok: false, reason: `不支持的 action：${action}（仅支持 log 或 show）。` };
      }
      const pathCheck = normalizeMemoryHistoryPath(args.path);
      if (!pathCheck.ok) return pathCheck;
      if (action === "show") {
        const commitCheck = validateCommitRef(args.commit);
        if (!commitCheck.ok) return commitCheck;
      } else {
        const sinceCheck = validateSinceFilter(args.since);
        if (!sinceCheck.ok) return sinceCheck;
      }
      return { ok: true };
    },
    execute: async (args) => {
      const action = args.action === undefined ? "log" : String(args.action);
      const pathCheck = normalizeMemoryHistoryPath(args.path);
      if (!pathCheck.ok) return { ok: false, output: pathCheck.reason };
      const maxChars = clampMaxChars(args.maxChars);

      if (action === "show") {
        const commitCheck = validateCommitRef(args.commit);
        if (!commitCheck.ok) return { ok: false, output: commitCheck.reason };
        const res = await readMemoryGitShow(dataDir, commitCheck.commit, {
          relPath: pathCheck.relPath,
        });
        if (!res.ok) return { ok: false, output: res.error };
        if (!res.stdout) {
          return {
            ok: true,
            output: pathCheck.relPath
              ? `提交 ${commitCheck.commit} 未涉及 ${pathCheck.relPath} 的变更。`
              : `提交 ${commitCheck.commit} 无文本差异。`,
          };
        }
        return { ok: true, output: truncateHistoryOutput(res.stdout, maxChars) };
      }

      const sinceCheck = validateSinceFilter(args.since);
      if (!sinceCheck.ok) return { ok: false, output: sinceCheck.reason };
      const limit = clampLimit(args.limit);
      const res = await readMemoryGitLog(dataDir, {
        relPath: pathCheck.relPath,
        limit,
        since: sinceCheck.since,
      });
      if (!res.ok) return { ok: false, output: res.error };
      if (!res.stdout) {
        return {
          ok: true,
          output: pathCheck.relPath
            ? `未找到 ${pathCheck.relPath} 的历史提交记录。`
            : "记忆仓目前还没有任何历史提交记录。",
        };
      }
      return { ok: true, output: truncateHistoryOutput(res.stdout, maxChars) };
    },
  });
}
