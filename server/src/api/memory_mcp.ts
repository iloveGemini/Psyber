import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import { VirtualClock, localDay, vagueWhen, type Clock } from "../core/clock.ts";
import {
  mergeMemoryMcpConfig,
  type MemoryMcpAccessMode,
  type MemoryMcpConfig,
  type MemoryMcpToken,
  type PsyberConfig,
} from "../core/config.ts";
import type { EmbeddingClient } from "../core/embedding.ts";
import {
  commitMemoryPaths,
  normalizeMemoryHistoryPath,
  readMemoryGitLog,
  readMemoryGitShow,
  validateCommitRef,
  validateSinceFilter,
} from "../core/git.ts";
import type { AsyncMutex } from "../core/mutex.ts";
import { stripFrontmatter } from "../core/prompts.ts";
import { redactSecrets } from "../core/redact.ts";
import type { McpReplayRunner } from "../engine/replay_runner.ts";
import { cosineSimilarity, ensureCardEmbeddings } from "../memory/embeddings.ts";
import { effectiveStatus, filterActiveStateMarkdown } from "../memory/frontmatter.ts";
import { buildContinuityBlock } from "../memory/gist.ts";
import type { CardIndexRow, MemoryIndex } from "../memory/index.ts";
import { normalizeRelPath, type MemoryTools, type ToolResult } from "../memory/tools.ts";
import { hashBearerToken, isLoopbackIp, timingSafeEqualString } from "./pairing.ts";

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-03-26", "2024-11-05"]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const MAX_MCP_SESSIONS = 128;
const TOKEN_TOUCH_PERSIST_INTERVAL_MS = 60_000;
const SEARCH_EMBED_TIMEOUT_MS = 2_500;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDefinition {
  name: string;
  description: string;
  readOnly: boolean;
  replayOnly?: boolean;
  inputSchema: Record<string, unknown>;
}

const MCP_MEMORY_TOOL_DEFS: McpToolDefinition[] = [
  {
    name: "memory_context",
    readOnly: true,
    description:
      "一键读取 Psyber 常驻核心档案（self/user/boundaries/mirror/open/state，自动过滤过期状态）与可选记忆时间梗概（绝不含私密抽屉或原始聊天流水）。",
    inputSchema: {
      type: "object",
      properties: {
        include_continuity: {
          type: "boolean",
          description: "是否附带年/月/日时间梗概与近期情景摘要（默认 true）",
        },
        max_chars: {
          type: "integer",
          description: "返回最大字符数（默认取服务端 maxOutputChars 上限）",
        },
      },
    },
  },
  {
    name: "memory_search",
    readOnly: true,
    description:
      "按自然语言意图检索 Psyber 记忆库：结合向量语义与本地 FTS5 全文索引返回相关卡片摘要，并附带 1 跳 [[短标题]] 双链邻接卡片线索。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "检索关键词或自然语言问题描述",
        },
        limit: {
          type: "integer",
          description: "返回卡片数量上限（1..20，默认 8）",
        },
        include_links: {
          type: "boolean",
          description: "是否附带命中卡片的 1 跳双链邻接卡片提示（默认 true）",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_glob",
    readOnly: true,
    description: "按通配符列举 memory/ 目录下的记忆文件清单、状态与模糊更新时间。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "相对于 memory/ 的通配符，例如 core/*.md、episodes/**/*.md、threads/**/*.md",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "memory_grep",
    readOnly: true,
    description: "在 memory/ 中按字面或正则全文检索匹配行。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "检索字面文本或正则表达式" },
        path: { type: "string", description: "可选：限定子目录或单文件路径（相对 memory/）" },
        include_archived: {
          type: "boolean",
          description: "是否包含 resolved/archived 状态的历史卡片（默认 false）",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "memory_read",
    readOnly: true,
    description: "精读单张记忆卡片正文（支持相对 memory/ 路径或 [[短标题]]，支持分段读取）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 memory/ 的路径或 [[短标题]]" },
        offset: { type: "integer", description: "可选字符起始偏移（默认 0）" },
        limit: { type: "integer", description: "可选最多读取字符数（默认 8000）" },
      },
      required: ["path"],
    },
  },
  {
    name: "memory_history",
    readOnly: true,
    description: "只读查看 memory/.git 的记忆变更历史（action=log 或 action=show）。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["log", "show"], description: "log 列举提交；show 查看 diff" },
        path: { type: "string", description: "可选：限定某个 memory/ 相对路径" },
        commit: { type: "string", description: "action=show 时必填，提交哈希或 HEAD / HEAD~1" },
        limit: { type: "integer", description: "action=log 最多返回条数（1..50，默认 10）" },
        since: { type: "string", description: "action=log 起始时间（如 2026-11-01 或 7 days ago）" },
        maxChars: { type: "integer", description: "输出最大字符数（500..20000，默认 8000）" },
      },
    },
  },
  {
    name: "memory_write",
    readOnly: false,
    description:
      "在 memory/ 规范目录中新建或整篇写入记忆卡片（受沙箱、Frontmatter/REGISTRY 校验与核心保护约束，写后自动提交 Git 留痕）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 memory/ 的合规目标路径" },
        content: { type: "string", description: "完整 Markdown 或 REGISTRY.yaml 内容" },
        note: { type: "string", description: "可选：写入原因简述（用于 Git 提交说明）" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "memory_edit",
    readOnly: false,
    description:
      "局部精确替换 memory/ 中既有卡片片段（补丁外内容严格不变，编辑后即时刷新索引并自动提交 Git 留痕）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 memory/ 的合规目标路径" },
        old_string: { type: "string", description: "原文中唯一待替换片段" },
        new_string: { type: "string", description: "替换后的新片段" },
        note: { type: "string", description: "可选：编辑原因简述（用于 Git 提交说明）" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "memory_replay",
    readOnly: false,
    replayOnly: true,
    description:
      "按逻辑作息日分批拉取待整理的历史对话任务包，并在写完卡片后结算 Git 提交与游标（仅在 read_write 且开启 replayToolsEnabled 时可用）。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "next", "status", "abort"],
          description: "start 开启或续接计划；next 交卷当前步并取下一步；status 查看进度；abort 中止当前步",
        },
        days: { type: "integer", description: "action=start 时指定整理天数（默认 1，上限 365）" },
        until: { type: "string", description: "action=start 时指定整理截止日期 YYYY-MM-DD" },
        all: { type: "boolean", description: "action=start 时是否整理全部剩余日期" },
        step_id: {
          type: "string",
          description: "action=next 时传入当前步 step_id 确认交卷；新窗口续接可不传",
        },
        summary: { type: "string", description: "action=next 时的 15 字以内中文摘要（用于 Git 提交说明）" },
        max_chars: { type: "integer", description: "单批原始对话字符上限（4000..60000，默认 20000）" },
        min_chars: { type: "integer", description: "低量日攒批顺延阈值（0..20000，默认 500）" },
        rollback: { type: "boolean", description: "action=abort 时是否安全回滚本步修改的卡片（默认 false）" },
        cancel_plan: { type: "boolean", description: "action=abort 时是否同时清除整个计划（默认 true）" },
      },
      required: ["action"],
    },
  },
];

export interface MemoryMcpRouteDeps {
  version: string;
  dataDir: string;
  db: Database;
  clock: Clock;
  getConfig: () => PsyberConfig;
  memoryIndex: MemoryIndex;
  memoryTools: MemoryTools;
  embedding?: EmbeddingClient;
  gitMutex: AsyncMutex;
  replayRunner?: McpReplayRunner;
  getClientIp?: (req: Request) => string;
  allowedOrigins?: string[];
  /** 节流持久化 token.lastUsedAt（由运行期装配传入） */
  onTokenUsed?: (tokenId: string, usedAt: number) => Promise<void> | void;
}

function truncateMcpText(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const body = chars.slice(0, maxChars).join("");
  return `${body}\n[记忆输出已截断，原始长度 ${chars.length} 字符]`;
}

function sanitizeCommitPart(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\r\n\0\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function extractCardExcerpt(rawMarkdown: string, maxChars = 280): string {
  const body = stripFrontmatter(rawMarkdown).trim().replace(/\s+/g, " ");
  const chars = Array.from(body);
  if (chars.length <= maxChars) return body;
  return `${chars.slice(0, maxChars).join("")}…`;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function normalizeRpcId(rawId: unknown): { ok: true; id: string | number | null; isNotification: boolean } | { ok: false } {
  if (rawId === undefined) {
    return { ok: true, id: null, isNotification: true };
  }
  if (rawId === null || typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId))) {
    return { ok: true, id: rawId, isNotification: false };
  }
  return { ok: false };
}

function matchMcpToken(tokens: readonly MemoryMcpToken[], rawBearer: string): MemoryMcpToken | null {
  const incomingHash = hashBearerToken(rawBearer);
  let matched: MemoryMcpToken | null = null;
  for (const t of tokens) {
    if (timingSafeEqualString(incomingHash, t.tokenHash)) {
      matched = t;
    }
  }
  return matched;
}

function resolveEffectiveMode(
  globalMode: MemoryMcpAccessMode,
  tokenMode?: MemoryMcpAccessMode,
): MemoryMcpAccessMode {
  if (globalMode === "read_write" && tokenMode !== "read_only") {
    return "read_write";
  }
  return "read_only";
}

function isOriginAllowed(req: Request, allowedOrigins?: string[]): boolean {
  const origin = req.headers.get("origin")?.trim();
  if (!origin) return true;
  let originHost = "";
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const reqHost = (req.headers.get("host") ?? "").trim().toLowerCase();
  if (originHost && reqHost && originHost === reqHost) {
    return true;
  }
  return Boolean(allowedOrigins && allowedOrigins.includes(origin));
}

/**
 * 注册对外记忆 MCP 服务路由（Streamable HTTP `/mcp`）：
 * - 四道防线：enabled 开关 -> 回环 IP 守卫 -> Origin 防跨站 -> 专属 Bearer Token（SHA-256 常量时间比对）
 * - 零新增外部依赖，严禁暴露 private/ 上锁抽屉或直接裸露 events 原始聊天流水。
 */
export function registerMemoryMcpRoutes(app: Hono, deps: MemoryMcpRouteDeps): void {
  const sessions = new Map<string, { tokenId: string; createdAt: number }>();
  const lastTouchPersistedAt = new Map<string, number>();
  const memoryDir = path.join(deps.dataDir, "memory");

  const runReadContext = async (args: Record<string, unknown>, maxOutputChars: number): Promise<ToolResult> => {
    const includeContinuity = args.include_continuity !== false;
    const requestedMax = clampInt(args.max_chars, 1_000, maxOutputChars, maxOutputChars);
    const nowMs = deps.clock.now();
    const tz = deps.clock.timeZone;
    const today = localDay(nowMs, tz);

    const coreFiles = [
      { rel: "core/self.md", label: "自我档案 (core/self.md)" },
      { rel: "core/user.md", label: "对方档案 (core/user.md)" },
      { rel: "core/boundaries.md", label: "相处边界 (core/boundaries.md)" },
      { rel: "core/mirror.md", label: "全局自省 (core/mirror.md)" },
      { rel: "core/open.md", label: "未完挂念 (core/open.md)" },
      { rel: "core/state.md", label: "近期状态 (core/state.md)" },
    ];

    const sections: string[] = [];
    for (const item of coreFiles) {
      try {
        const raw = await fs.readFile(path.join(memoryDir, item.rel), "utf8");
        const content =
          item.rel === "core/state.md"
            ? filterActiveStateMarkdown(raw, today)
            : raw.trim();
        if (content) {
          sections.push(`## ${item.label}\n${content}`);
        }
      } catch {
        // 文件缺失时跳过
      }
    }

    if (includeContinuity) {
      const continuity = await buildContinuityBlock({
        dataDir: deps.dataDir,
        memoryIndex: deps.memoryIndex,
        nowMs,
        timeZone: tz,
        gistCharBudget: 4_000,
        dailyBodyCharBudget: 1_200,
        tailEvents: [],
      });
      if (continuity) {
        sections.push(continuity);
      }
    }

    if (sections.length === 0) {
      return { ok: true, output: "记忆库当前暂无常驻档案或时间梗概。" };
    }
    return {
      ok: true,
      output: truncateMcpText(sections.join("\n\n"), requestedMax),
    };
  };

  const runSearch = async (args: Record<string, unknown>, maxOutputChars: number): Promise<ToolResult> => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, output: "memory_search 缺少非空检索词 query。" };
    }
    const limit = clampInt(args.limit, 1, 20, 8);
    const includeLinks = args.include_links !== false;
    const nowMs = deps.clock.now();
    const tz = deps.clock.timeZone;

    const allRows = deps.memoryIndex.listAllRows();
    const searchableRows: CardIndexRow[] = [];
    const rowByPath = new Map<string, CardIndexRow>();
    for (const r of allRows) {
      rowByPath.set(r.path, r);
      if (
        r.space === "self" ||
        r.space === "user" ||
        r.space === "core" ||
        r.space === "episode_index"
      ) {
        continue;
      }
      const st = effectiveStatus(r, nowMs);
      if (st === "resolved" || st === "archived" || st === "faded") {
        continue;
      }
      searchableRows.push(r);
    }

    const ftsHits = deps.memoryIndex.searchFts(query, Math.max(limit * 2, 16));
    const kwScoreByPath = new Map<string, number>();
    for (const hit of ftsHits) {
      // sqlite bm25 为负数（越小越相关），转为 (0, 1] 归一化分
      const kw = 1 / (1 + Math.max(0, -hit.rank));
      const normKw = Math.max(0.15, Math.min(1, 1 - kw * 0.5 + (hit.rank < 0 ? 0.35 : 0)));
      kwScoreByPath.set(hit.path, Math.max(kwScoreByPath.get(hit.path) ?? 0, normKw));
    }

    const semScoreByPath = new Map<string, number>();
    let usedEmbedding = false;
    let embeddingFallbackNote = "";

    if (deps.embedding && searchableRows.length > 0) {
      try {
        const [queryVec, cardVecs] = await Promise.all([
          deps.embedding.embed(query, {
            signal: AbortSignal.timeout(SEARCH_EMBED_TIMEOUT_MS),
            taskType: "query",
          }),
          ensureCardEmbeddings({
            db: deps.db,
            memoryDir,
            rows: searchableRows,
            embedding: deps.embedding,
            nowMs,
            embedTimeoutMs: SEARCH_EMBED_TIMEOUT_MS,
            maxTotalTimeoutMs: SEARCH_EMBED_TIMEOUT_MS * 2,
          }),
        ]);
        usedEmbedding = true;
        for (const r of searchableRows) {
          const vec = cardVecs.get(r.path);
          if (!vec) continue;
          const sim = cosineSimilarity(queryVec, vec);
          if (sim > 0) semScoreByPath.set(r.path, sim);
        }
      } catch {
        embeddingFallbackNote = "[提示：向量服务暂不可用，本次已自动降级为本地 FTS5 全文检索]\n";
      }
    }

    const scored: Array<{ row: CardIndexRow; score: number; sem: number; kw: number }> = [];
    for (const r of searchableRows) {
      const sem = semScoreByPath.get(r.path) ?? 0;
      const kw = kwScoreByPath.get(r.path) ?? 0;
      if (usedEmbedding) {
        if (sem < 0.2 && kw <= 0) continue;
        const score = 0.75 * sem + 0.25 * kw;
        scored.push({ row: r, score, sem, kw });
      } else if (kw > 0) {
        scored.push({ row: r, score: kw, sem: 0, kw });
      }
    }

    scored.sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at);
    const top = scored.slice(0, limit);

    if (top.length === 0) {
      return {
        ok: true,
        output: `${embeddingFallbackNote}未检索到与 "${query}" 相关的活跃记忆卡片。`,
      };
    }

    const blocks: string[] = [];
    for (let i = 0; i < top.length; i++) {
      const item = top[i]!;
      let excerpt = "";
      try {
        const raw = await fs.readFile(path.join(memoryDir, item.row.path), "utf8");
        excerpt = extractCardExcerpt(raw, 280);
      } catch {
        excerpt = "（正文读取失败）";
      }
      const when = vagueWhen(item.row.updated_at, nowMs, tz);
      const recallHint = item.row.when_to_recall ? ` | 何时想起：${item.row.when_to_recall}` : "";
      blocks.push(
        `[${i + 1}] [[${item.row.title}]] (${item.row.path})\n` +
          `类型：${item.row.space}/${item.row.kind} | 时间：${when} | 相关分：${item.score.toFixed(2)}${recallHint}\n` +
          `摘要：${excerpt}`,
      );
    }

    if (includeLinks) {
      const anchorPaths = top.map((t) => t.row.path);
      const neighbors = deps.memoryIndex.findLinkedNeighbors(anchorPaths, {
        excludePaths: new Set(anchorPaths),
        maxResults: 6,
      });
      if (neighbors.length > 0) {
        const linkLines = neighbors.map((nb) => {
          const dir = nb.direction === "out" ? "引用自" : "反向关联";
          return `- [[${nb.row.title}]] (${nb.row.path}) — ${dir} [[${nb.viaAnchorTitle}]]`;
        });
        blocks.push(`### 双链关联延伸（1 跳邻居）\n${linkLines.join("\n")}`);
      }
    }

    return {
      ok: true,
      output: truncateMcpText(embeddingFallbackNote + blocks.join("\n\n"), maxOutputChars),
    };
  };

  const runHistory = async (args: Record<string, unknown>, maxOutputChars: number): Promise<ToolResult> => {
    const action = args.action === undefined ? "log" : String(args.action);
    if (action !== "log" && action !== "show") {
      return { ok: false, output: `不支持的 action：${action}（仅支持 log 或 show）。` };
    }
    const pathCheck = normalizeMemoryHistoryPath(args.path);
    if (!pathCheck.ok) return { ok: false, output: pathCheck.reason };
    const maxChars = clampInt(args.maxChars, 500, Math.min(20_000, maxOutputChars), Math.min(8_000, maxOutputChars));

    if (action === "show") {
      const commitCheck = validateCommitRef(args.commit);
      if (!commitCheck.ok) return { ok: false, output: commitCheck.reason };
      const res = await readMemoryGitShow(deps.dataDir, commitCheck.commit, {
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
      return { ok: true, output: truncateMcpText(redactSecrets(res.stdout).text, maxChars) };
    }

    const sinceCheck = validateSinceFilter(args.since);
    if (!sinceCheck.ok) return { ok: false, output: sinceCheck.reason };
    const limit = clampInt(args.limit, 1, 50, 10);
    const res = await readMemoryGitLog(deps.dataDir, {
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
    return { ok: true, output: truncateMcpText(redactSecrets(res.stdout).text, maxChars) };
  };

  const runWriteOrEdit = async (
    kind: "write" | "edit",
    args: Record<string, unknown>,
    clientName: string,
    protectCoreFiles: boolean,
  ): Promise<ToolResult> => {
    const rawPath = typeof args.path === "string" ? args.path : "";
    const norm = normalizeRelPath(rawPath);
    if (!norm.ok) return { ok: false, output: norm.error };
    if (!norm.rel) return { ok: false, output: "path 不能为空。" };

    return deps.gitMutex.runExclusive(async () => {
      // 在 gitMutex 内读取 activeStep 并校验权限，避免与并发 memory_replay(next/abort) 产生竞态
      const activeStep = deps.replayRunner?.getActiveStep() ?? null;
      if (protectCoreFiles && norm.rel.startsWith("core/")) {
        const allowedReplayCore =
          activeStep !== null &&
          (norm.rel === "core/state.md" ||
            (activeStep.phase === "reflect_weekly" && norm.rel === "core/open.md"));
        if (!allowedReplayCore) {
          return {
            ok: false,
            output: `已启用核心档案保护（protectCoreFiles），禁止通过外部 MCP 修改 ${norm.rel}。`,
          };
        }
      }

      let existedBefore = false;
      if (activeStep) {
        try {
          await fs.access(path.join(memoryDir, norm.rel));
          existedBefore = true;
        } catch {
          existedBefore = false;
        }
      }
      const writeOpts = activeStep
        ? {
            clockOverride: new VirtualClock(
              activeStep.bedtimeAtMs,
              deps.getConfig().timezone || deps.clock.timeZone,
            ),
            trustFrontmatterDates: true,
          }
        : undefined;

      const res =
        kind === "write"
          ? await deps.memoryTools.write(rawPath, String(args.content ?? ""), writeOpts)
          : await deps.memoryTools.edit(
              rawPath,
              String(args.old_string ?? ""),
              String(args.new_string ?? ""),
              writeOpts,
            );
      if (!res.ok) return res;

      if (activeStep && deps.replayRunner) {
        deps.replayRunner.recordStepWrite(norm.rel, existedBefore);
        return {
          ok: true,
          output: `${res.output}（已暂存至当前搬家步骤 ${activeStep.stepId}，将在 memory_replay(action="next") 时统一 Git 提交）`,
        };
      }

      const safeClient = sanitizeCommitPart(clientName, 24) || "client";
      const safeNote = sanitizeCommitPart(args.note, 60);
      const commitSummary = safeNote || `${kind} ${norm.rel}`;
      try {
        await commitMemoryPaths(
          deps.dataDir,
          [norm.rel],
          `memory(mcp:${safeClient}): ${commitSummary}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: true,
          output: `${res.output}（警告：磁盘写入与索引已更新，但 Git 提交失败：${msg}）`,
        };
      }
      return { ok: true, output: `${res.output}（已自动 Git 留痕）` };
    });
  };

  const handleSingleRpc = async (
    reqObj: JsonRpcRequest,
    ctx: {
      token: MemoryMcpToken;
      effectiveMode: MemoryMcpAccessMode;
      protectCoreFiles: boolean;
      replayToolsEnabled: boolean;
      maxOutputChars: number;
      disabledSet: Set<string>;
      onNewSession: (sid: string) => void;
    },
  ): Promise<JsonRpcResponse | null> => {
    if (!reqObj || typeof reqObj !== "object" || Array.isArray(reqObj)) {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const idCheck = normalizeRpcId(reqObj.id);
    if (!idCheck.ok) {
      return jsonRpcError(null, -32600, "Invalid Request id");
    }
    if (reqObj.jsonrpc !== "2.0" || typeof reqObj.method !== "string") {
      return idCheck.isNotification ? null : jsonRpcError(idCheck.id, -32600, "Invalid Request");
    }

    const method = reqObj.method;
    const params =
      reqObj.params && typeof reqObj.params === "object" && !Array.isArray(reqObj.params)
        ? (reqObj.params as Record<string, unknown>)
        : {};

    if (idCheck.isNotification) {
      // notifications/initialized 等通知不产生 JSON-RPC 响应体
      return null;
    }

    const rpcId = idCheck.id;
    if (method === "initialize") {
      const requestedVersion =
        typeof params.protocolVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(params.protocolVersion)
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      const sid = `mcps_${crypto.randomUUID()}`;
      if (sessions.size >= MAX_MCP_SESSIONS) {
        const oldestKey = sessions.keys().next().value;
        if (oldestKey) sessions.delete(oldestKey);
      }
      sessions.set(sid, { tokenId: ctx.token.id, createdAt: deps.clock.now() });
      ctx.onNewSession(sid);
      return {
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          protocolVersion: requestedVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: "psyber-memory",
            version: deps.version,
          },
        },
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id: rpcId, result: {} };
    }

    if (method === "tools/list") {
      const tools = MCP_MEMORY_TOOL_DEFS.filter((t) => {
        if (ctx.disabledSet.has(t.name)) return false;
        if (!t.readOnly && ctx.effectiveMode !== "read_write") return false;
        if (t.replayOnly && (!ctx.replayToolsEnabled || !deps.replayRunner)) return false;
        return true;
      }).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return { jsonrpc: "2.0", id: rpcId, result: { tools } };
    }

    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      if (!name) {
        return jsonRpcError(rpcId, -32602, "tools/call 缺少工具名 name");
      }
      const def = MCP_MEMORY_TOOL_DEFS.find((t) => t.name === name);
      if (!def || ctx.disabledSet.has(name)) {
        return jsonRpcError(rpcId, -32602, `未知或已停用的记忆工具: ${name}`);
      }
      if (!def.readOnly && ctx.effectiveMode !== "read_write") {
        return {
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            content: [
              {
                type: "text",
                text: `权限拒绝：当前处于只读模式（read_only），禁止调用写入工具 ${name}。`,
              },
            ],
            isError: true,
          },
        };
      }
      if (def.replayOnly && (!ctx.replayToolsEnabled || !deps.replayRunner)) {
        return {
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            content: [
              {
                type: "text",
                text: "权限拒绝：未开启历史搬家工具开关（memoryMcp.replayToolsEnabled），禁止调用 memory_replay。",
              },
            ],
            isError: true,
          },
        };
      }

      let toolRes: ToolResult;
      try {
        switch (name) {
          case "memory_context":
            toolRes = await runReadContext(args, ctx.maxOutputChars);
            break;
          case "memory_search":
            toolRes = await runSearch(args, ctx.maxOutputChars);
            break;
          case "memory_glob":
            toolRes = await deps.memoryTools.glob(String(args.pattern ?? ""));
            break;
          case "memory_grep":
            toolRes = await deps.memoryTools.grep(
              String(args.pattern ?? ""),
              typeof args.path === "string" ? args.path : undefined,
              Boolean(args.include_archived),
            );
            break;
          case "memory_read":
            toolRes = await deps.memoryTools.read(String(args.path ?? ""), {
              offset: typeof args.offset === "number" ? args.offset : undefined,
              limit: typeof args.limit === "number" ? args.limit : undefined,
              // 外部 MCP 检索/阅读不污染 Psyber 内部卡片访问热度
              countAccess: false,
            });
            break;
          case "memory_history":
            toolRes = await runHistory(args, ctx.maxOutputChars);
            break;
          case "memory_write":
            toolRes = await runWriteOrEdit("write", args, ctx.token.name, ctx.protectCoreFiles);
            break;
          case "memory_edit":
            toolRes = await runWriteOrEdit("edit", args, ctx.token.name, ctx.protectCoreFiles);
            break;
          case "memory_replay": {
            const replayRes = await deps.replayRunner!.execute(args, {
              protectCoreFiles: ctx.protectCoreFiles,
            });
            // memory_replay 原文已按 max_chars 受控切批，完全豁免全局 maxOutputChars 截断以防静默丢失历史对话
            return {
              jsonrpc: "2.0",
              id: rpcId,
              result: {
                content: [
                  {
                    type: "text",
                    text: replayRes.output,
                  },
                ],
                isError: !replayRes.ok,
              },
            };
          }
          default:
            return jsonRpcError(rpcId, -32602, `未实现的记忆工具: ${name}`);
        }
      } catch (err) {
        toolRes = {
          ok: false,
          output: err instanceof Error ? err.message : String(err),
        };
      }

      return {
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          content: [
            {
              type: "text",
              text: truncateMcpText(toolRes.output, ctx.maxOutputChars),
            },
          ],
          isError: !toolRes.ok,
        },
      };
    }

    return jsonRpcError(rpcId, -32601, `Method not found: ${method}`);
  };

  const authenticateMcpRequest = (
    c: Context,
  ):
    | { ok: true; cfg: MemoryMcpConfig; matchedToken: MemoryMcpToken }
    | { ok: false; response: Response } => {
    const cfg = mergeMemoryMcpConfig(deps.getConfig().memoryMcp);
    if (!cfg.enabled) {
      return {
        ok: false,
        response: c.json({ error: { code: "MCP_DISABLED", message: "对外记忆 MCP 服务未开启" } }, 404),
      };
    }
    if (!cfg.allowRemote) {
      const clientIp = deps.getClientIp ? deps.getClientIp(c.req.raw) : "127.0.0.1";
      if (!isLoopbackIp(clientIp)) {
        return {
          ok: false,
          response: c.json(
            { error: { code: "MCP_LOOPBACK_ONLY", message: "当前仅允许本机回环访问记忆 MCP" } },
            403,
          ),
        };
      }
    }
    if (!isOriginAllowed(c.req.raw, deps.allowedOrigins)) {
      return {
        ok: false,
        response: c.json(
          { error: { code: "ORIGIN_FORBIDDEN", message: "已拒绝来自非同源页面的跨站请求" } },
          403,
        ),
      };
    }

    const authHeader = c.req.header("authorization") ?? "";
    const rawBearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const matchedToken = rawBearer ? matchMcpToken(cfg.tokens, rawBearer) : null;
    if (!matchedToken) {
      c.header("WWW-Authenticate", 'Bearer realm="psyber-memory-mcp"');
      return {
        ok: false,
        response: c.json(
          { error: { code: "UNAUTHORIZED", message: "记忆 MCP 访问令牌缺失、无效或已吊销" } },
          401,
        ),
      };
    }
    return { ok: true, cfg, matchedToken };
  };

  app.get("/mcp", (c) => {
    const cfg = mergeMemoryMcpConfig(deps.getConfig().memoryMcp);
    if (!cfg.enabled) {
      return c.json({ error: { code: "MCP_DISABLED", message: "对外记忆 MCP 服务未开启" } }, 404);
    }
    return c.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "请使用 POST /mcp（Streamable HTTP JSON-RPC 2.0）" } },
      405,
    );
  });

  app.delete("/mcp", (c) => {
    const auth = authenticateMcpRequest(c);
    if (!auth.ok) return auth.response;

    const sid = c.req.header("mcp-session-id")?.trim();
    if (sid) {
      const existing = sessions.get(sid);
      if (existing && existing.tokenId === auth.matchedToken.id) {
        sessions.delete(sid);
      }
    }
    return c.body(null, 204);
  });

  app.post("/mcp", async (c) => {
    const auth = authenticateMcpRequest(c);
    if (!auth.ok) return auth.response;
    const { cfg, matchedToken } = auth;

    const nowMs = deps.clock.now();
    matchedToken.lastUsedAt = nowMs;
    const prevTouch = lastTouchPersistedAt.get(matchedToken.id) ?? 0;
    if (deps.onTokenUsed && nowMs - prevTouch >= TOKEN_TOUCH_PERSIST_INTERVAL_MS) {
      lastTouchPersistedAt.set(matchedToken.id, nowMs);
      void Promise.resolve(deps.onTokenUsed(matchedToken.id, nowMs)).catch(() => {});
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(jsonRpcError(null, -32700, "Parse error: 请求体不是合法 JSON"), 200);
    }

    const incomingSessionId = c.req.header("mcp-session-id")?.trim();
    if (incomingSessionId) {
      const items = Array.isArray(payload) ? payload : [payload];
      const requiresActiveSession = items.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          (item as { method?: unknown }).method !== "initialize",
      );
      if (requiresActiveSession) {
        const active = sessions.get(incomingSessionId);
        if (!active || active.tokenId !== matchedToken.id) {
          return c.json(
            {
              error: {
                code: "MCP_SESSION_NOT_FOUND",
                message: "MCP 会话不存在、已关闭或不属于当前令牌，请重新 initialize",
              },
            },
            404,
          );
        }
      }
    }

    const effectiveMode = resolveEffectiveMode(cfg.accessMode, matchedToken.accessMode);
    const disabledSet = new Set(cfg.disabledTools);
    let newSessionId: string | undefined;

    const ctx = {
      token: matchedToken,
      effectiveMode,
      protectCoreFiles: cfg.protectCoreFiles,
      replayToolsEnabled: cfg.replayToolsEnabled,
      maxOutputChars: cfg.maxOutputChars,
      disabledSet,
      onNewSession: (sid: string) => {
        newSessionId = sid;
      },
    };

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        return c.json(jsonRpcError(null, -32600, "Invalid Request: 空批处理数组"), 200);
      }
      const responses: JsonRpcResponse[] = [];
      for (const item of payload) {
        const res = await handleSingleRpc(item as JsonRpcRequest, ctx);
        if (res) responses.push(res);
      }
      if (newSessionId) c.header("mcp-session-id", newSessionId);
      if (responses.length === 0) {
        return c.body(null, 202);
      }
      return c.json(responses, 200);
    }

    const res = await handleSingleRpc(payload as JsonRpcRequest, ctx);
    if (newSessionId) c.header("mcp-session-id", newSessionId);
    if (!res) {
      return c.body(null, 202);
    }
    return c.json(res, 200);
  });
}
