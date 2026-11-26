import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";
import { localDay, weekdayOfDay } from "../core/clock.ts";
import type { PsyberConfig } from "../core/config.ts";
import type { EmbeddingClient } from "../core/embedding.ts";
import {
  commitMemoryPaths,
  getMemoryHeadCommit,
  listChangedMemoryPathsSince,
} from "../core/git.ts";
import { readPrompt, stripFrontmatter } from "../core/prompts.ts";
import type {
  ChatMessage,
  ChatModelClient,
  ChatStopReason,
  ChatToolCall,
} from "../llm/client.ts";
import { resolveEffectiveThinkingLevel } from "../llm/router.ts";
import type { MemoryIndex } from "../memory/index.ts";
import { runMemoryRadar, type MemoryRadarResult } from "../memory/radar.ts";
import {
  isAllowedWritePath,
  normalizeRelPath,
  type MemoryTools,
} from "../memory/tools.ts";
import { MEMORY_5_TOOL_DEFINITIONS } from "../tools/core_tools.ts";

export type ReflectScope = "daily" | "weekly";

import type {
  DecisionAnswer,
  DecisionClient,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
} from "../core/decision.ts";

export type {
  DecisionAnswer,
  DecisionClient,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
};

export interface ReflectTaskDeps {
  db: Database;
  dataDir: string;
  promptsDir: string;
  clock: Clock;
  memoryIndex: MemoryIndex;
  memoryTools: MemoryTools;
  chatModel: ChatModelClient;
  decisionClient?: DecisionClient;
  embedding?: EmbeddingClient;
  getConfig?: () => PsyberConfig;
  /** 单步瞬时错误（503/429/网络抖动）退避延迟毫秒数组，默认 [3000, 10000, 25000] */
  retryDelaysMs?: number[];
}

export interface ReflectTaskOutcome {
  ok: boolean;
  scope: ReflectScope;
  triggered: boolean;
  skipReason?: string;
  changedPaths: string[];
  decisionScores?: Record<string, number>;
  /** 可选前置只读体检雷达摘要（仅当周反思启用雷达并执行时填充） */
  radar?: {
    executed: boolean;
    boardItemsChecked: number;
    pairsEvaluated: number;
    findingsCount: number;
  };
  touchedMemoryPaths: string[];
  committed: boolean;
  summary: string;
  error?: string;
}

export interface PostBedtimeReflectResult {
  daily: ReflectTaskOutcome;
  weekly: ReflectTaskOutcome | null;
}

const MAX_REFLECT_STEPS = 18;
const DEFAULT_REFLECT_RETRY_DELAYS_MS = [3_000, 10_000, 25_000];

function isTransientReflectError(code: string, message: string, retryable?: boolean): boolean {
  if (code === "CONTEXT_OVERFLOW" || code === "AUTH_EXPIRED") return false;
  if (/usage limit|quota|insufficient_quota|billing|payment required|credit balance/i.test(message)) {
    return false;
  }
  if (code === "RATE_LIMITED") return true;
  return retryable !== false;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
const DAILY_SHIFT_THRESHOLD = 0.55;
const DAILY_OPEN_THRESHOLD = 0.60;
const WEEKLY_UNABSORBED_THRESHOLD = 0.55;
const WEEKLY_PATTERN_THRESHOLD = 0.55;

export const REFLECT_SCOPE_BLOCKS: Record<ReflectScope, string> = {
  daily:
    "这是一次【日反思】。结合今日新增或更新的记忆线索，我自主查阅相关的 episodes/、threads/、entities/、lessons/ 与 core/ 文件，思考今天有没有值得沉淀的情绪变化、观念转折、相处边界磨合、自我觉察或未完挂念。若有，先在今日目录写 rf-<slug>.md 记录心路历程，再把清晰成果按作用范围分流到 core/、lessons/、threads/ 或 entities/；若今天只是平淡日常、没有真正值得落笔的洞察，可以不写任何文件直接结束。",
  weekly:
    "这是一次【周日回顾反思】。我跳出单日视角，自主查阅本周新增的 episodes/ 切片、已写过的日反思 rf-*.md、以及 core/、threads/、entities/、lessons/。重点看两件事：① 本周是否还有重要变化或边界信号尚未被日反思充分吸收；② 把多天放在一起看，有没有浮现出跨天的规律、反复出现的情绪/主题、或该更新的长期认知与未完挂念（core/open.md 顺手清理已闭环项）。有真正洞察再落笔 rf-<slug>.md 并分流成果，切忌重复日反思已经写过的结论。",
};

interface ReflectCursorMeta {
  last_commit?: string | null;
  last_day?: string | null;
  last_run_at?: number;
  last_decision?: string;
}

function cursorKeyForScope(scope: ReflectScope): string {
  return scope === "daily" ? "reflect_daily" : "reflect_weekly";
}

export function readReflectCursor(db: Database, scope: ReflectScope): ReflectCursorMeta {
  const row = db
    .query("SELECT meta_json FROM task_cursors WHERE task_key = ?")
    .get(cursorKeyForScope(scope)) as { meta_json: string | null } | null;
  if (!row?.meta_json) return {};
  try {
    return JSON.parse(row.meta_json) as ReflectCursorMeta;
  } catch {
    return {};
  }
}

function writeReflectCursor(
  db: Database,
  scope: ReflectScope,
  nowMs: number,
  meta: ReflectCursorMeta,
): void {
  const key = cursorKeyForScope(scope);
  db.query(
    `INSERT INTO task_cursors (task_key, last_event_id, meta_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_key) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       meta_json = excluded.meta_json,
       updated_at = excluded.updated_at`,
  ).run(key, meta.last_commit ?? "", JSON.stringify(meta), nowMs);
}

/** 判断 YYYY-MM-DD 是否为周日（不依赖运行机时区） */
export function isSundayDay(dayStr: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayStr);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return d.getUTCDay() === 0;
}

/** 返回不晚于 dayStr 的最近一个周日（YYYY-MM-DD；若 dayStr 本身是周日则返回自身） */
export function mostRecentSundayOnOrBefore(dayStr: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayStr);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/**
 * 判断 targetDay 是否应检查周反思：
 * 1. 当天本身是周日 -> true；
 * 2. 若周日因低量攒批顺延或关机错过：
 *    - 已有 reflect_weekly 游标：cursor.last_day < 最近一个周日 -> true（跨周日补触发）；
 *    - 尚无 reflect_weekly 游标：首条活跃对话或情景切片早于/等于最近一个周日 -> true（避免首周非周日误触发）。
 */
export function isWeeklyReflectDue(db: Database, targetDay: string, timeZone: string): boolean {
  if (isSundayDay(targetDay)) return true;
  const lastSunday = mostRecentSundayOnOrBefore(targetDay);
  if (!lastSunday) return false;

  const cursor = readReflectCursor(db, "weekly");
  if (cursor.last_day) {
    return cursor.last_day < lastSunday;
  }

  const evRow = db
    .query(
      `SELECT MIN(created_at) AS min_at FROM events
       WHERE status IN ('active', 'retracted') AND role IN ('user', 'assistant')`,
    )
    .get() as { min_at: number | null } | null;
  if (evRow?.min_at != null && localDay(evRow.min_at, timeZone) <= lastSunday) {
    return true;
  }

  const epRow = db
    .query(
      `SELECT MIN(path) AS min_path FROM card_index
       WHERE space = 'episodes' AND path GLOB 'episodes/[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]/*'`,
    )
    .get() as { min_path: string | null } | null;
  if (epRow?.min_path) {
    const m = /^episodes\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(epRow.min_path);
    if (m && `${m[1]}-${m[2]}-${m[3]}` <= lastSunday) {
      return true;
    }
  }

  return false;
}

/** 是否为反思卡片（episodes/YYYY/MM/DD/rf-*.md） */
export function isReflectionCardPath(relPath: string): boolean {
  return /^episodes\/\d{4}\/\d{2}\/\d{2}\/rf-[^/]+\.md$/.test(relPath);
}

/**
 * 是否属于值得触发反思判断的实质变更路径：
 * - 排除时间骨架 index.md、反思输出 rf-*.md、短期状态 core/state.md 与注册表文件
 * - 包含情景切片 ep-*.md、threads/、entities/、favorite/、lessons/ 与 core/{self,user,boundaries,mirror,open}.md
 */
export function isSubstantiveReflectPath(relPath: string): boolean {
  if (!relPath.endsWith(".md")) return false;
  if (/^episodes\/.*\/index\.md$/.test(relPath)) return false;
  if (isReflectionCardPath(relPath)) return false;
  if (relPath === "core/state.md") return false;
  return (
    relPath.startsWith("episodes/") ||
    relPath.startsWith("threads/") ||
    relPath.startsWith("entities/") ||
    relPath.startsWith("favorite/") ||
    relPath.startsWith("lessons/") ||
    relPath.startsWith("core/")
  );
}

async function readOptional(absPath: string): Promise<string | null> {
  try {
    const t = await fs.readFile(absPath, "utf8");
    return t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

function clipExcerpt(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(20, maxChars - 1))}…`;
}

function episodeDirForDay(dayStr: string): string {
  const [y, m, d] = dayStr.split("-");
  return `episodes/${y}/${m}/${d}`;
}

function parseOptionalSummary(text: string, touched: string[]): string {
  const match = /\{[\s\S]*"summary"\s*:\s*"([^"]+)"[\s\S]*\}/.exec(text);
  if (match && match[1].trim()) {
    return match[1].trim().slice(0, 60);
  }
  return touched.length > 0 ? `reflect ${touched.join(", ")}` : "无新增反思";
}

async function buildFileExcerpts(
  memoryDir: string,
  relPaths: string[],
  maxTotalChars: number,
  perFileMaxChars = 320,
): Promise<string> {
  const lines: string[] = [];
  let remaining = maxTotalChars;
  for (const rel of relPaths) {
    if (remaining <= 60) {
      lines.push(`- ${rel}（其余略）`);
      continue;
    }
    const raw = await readOptional(path.join(memoryDir, rel));
    if (!raw) {
      lines.push(`- ${rel}（已删除或为空）`);
      continue;
    }
    const body = stripFrontmatter(raw).trim();
    const snippet = clipExcerpt(body, Math.min(perFileMaxChars, remaining));
    remaining -= snippet.length;
    lines.push(`- ${rel}: ${snippet}`);
  }
  return lines.join("\n");
}

export function buildReflectContextBlock(opts: {
  scope: ReflectScope;
  targetDay: string;
  changedPaths: string[];
  dailyRefPaths: string[];
}): string {
  const weekday = weekdayOfDay(opts.targetDay);
  const dayDir = episodeDirForDay(opts.targetDay);
  const lines = [
    "<reflect_context>",
    `当前日期：${opts.targetDay}（${weekday}）`,
    `反思类型：${opts.scope === "daily" ? "日反思（daily）" : "周反思（weekly）"}`,
    `反思卡片目录：${dayDir}/rf-<简短英文slug>.md`,
    `近期实质变动文件线索（共 ${opts.changedPaths.length} 个，仅供起步参考，可自行 glob/grep/read 扩大范围）：`,
    ...opts.changedPaths.map((p) => `  - ${p}`),
  ];
  if (opts.scope === "weekly" && opts.dailyRefPaths.length > 0) {
    lines.push(`本周已写过的日反思卡片（共 ${opts.dailyRefPaths.length} 个，注意勿重复已吸收结论）：`);
    for (const p of opts.dailyRefPaths) {
      lines.push(`  - ${p}`);
    }
  }
  lines.push("</reflect_context>");
  return lines.join("\n");
}

/**
 * 执行一轮独立深度反思（由 AI 自主使用 5 工具检索并落盘 rf-*.md / core/ / lessons/）。
 * 失败或截断时自动回滚本轮所有未提交改动。
 */
export async function runMemoryReflectTask(
  deps: ReflectTaskDeps,
  opts: {
    scope: ReflectScope;
    targetDay?: string;
    changedPaths: string[];
    dailyRefPaths?: string[];
    decisionScores?: Record<string, number>;
    radarBlock?: string | null;
    signal?: AbortSignal;
  },
): Promise<ReflectTaskOutcome> {
  const { dataDir, promptsDir, clock, memoryIndex, memoryTools, chatModel } = deps;
  const memoryDir = path.join(dataDir, "memory");
  const targetDay = opts.targetDay ?? localDay(clock.now(), clock.timeZone);

  const [selfMd, userMd, reflectPrompt, openMd] = await Promise.all([
    readOptional(path.join(memoryDir, "core", "self.md")),
    readOptional(path.join(memoryDir, "core", "user.md")),
    readPrompt(promptsDir, "reflect.md", {
      REFLECT_SCOPE_BLOCK: REFLECT_SCOPE_BLOCKS[opts.scope],
    }),
    readOptional(path.join(memoryDir, "core", "open.md")),
  ]);

  const sysSections: string[] = [];
  if (selfMd) sysSections.push(`<self>\n${selfMd}\n</self>`);
  if (userMd) sysSections.push(`<user>\n${userMd}\n</user>`);
  sysSections.push(reflectPrompt.body);
  const systemPrompt = sysSections.join("\n\n");

  const materialParts: string[] = [
    buildReflectContextBlock({
      scope: opts.scope,
      targetDay,
      changedPaths: opts.changedPaths,
      dailyRefPaths: opts.dailyRefPaths ?? [],
    }),
  ];
  if (openMd) {
    const body = stripFrontmatter(openMd).trim();
    if (body) {
      materialParts.push(`# 现行 core/open.md（未完挂念与待观察问号）\n${clipExcerpt(body, 1500)}`);
    }
  }
  if (opts.radarBlock) {
    materialParts.push(opts.radarBlock);
  }

  const messages: ChatMessage[] = [
    { role: "user", content: materialParts.join("\n\n"), timestamp: clock.now() },
  ];

  const backups = new Map<string, Uint8Array | null>();
  const touched = new Set<string>();

  const recordBackupIfSafe = async (rawPath: string): Promise<string | null> => {
    const norm = normalizeRelPath(rawPath);
    if (!norm.ok || !norm.rel || !isAllowedWritePath(norm.rel)) {
      return null;
    }
    const rel = norm.rel;
    if (!backups.has(rel)) {
      const abs = path.join(memoryDir, rel);
      try {
        const bytes = await fs.readFile(abs);
        backups.set(rel, bytes);
      } catch {
        backups.set(rel, null);
      }
    }
    return rel;
  };

  const rollback = async (): Promise<void> => {
    for (const [rel, before] of backups.entries()) {
      const abs = path.join(memoryDir, rel);
      if (before === null) {
        await fs.rm(abs, { force: true });
        memoryIndex.removeFromIndex(rel);
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, before);
        await memoryIndex.reindexFile(rel);
      }
    }
  };

  const cfg = deps.getConfig?.();
  const effectiveThinkingLevel = cfg ? resolveEffectiveThinkingLevel(cfg) : undefined;
  const effectiveThinkingBudget = cfg?.llm?.thinking?.budgetTokens;
  const retryDelays = deps.retryDelaysMs ?? DEFAULT_REFLECT_RETRY_DELAYS_MS;

  let finalText = "";
  let failedReason: string | null = null;

  try {
    for (let step = 0; step < MAX_REFLECT_STEPS; step++) {
      let stepText = "";
      let stepThinking = "";
      let stepThinkingSig: string | undefined;
      let stepStopReason: ChatStopReason | undefined;
      const stepToolCalls: ChatToolCall[] = [];

      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        stepText = "";
        stepThinking = "";
        stepThinkingSig = undefined;
        stepStopReason = undefined;
        stepToolCalls.length = 0;
        let attemptError: { code: string; message: string; retryable?: boolean } | null = null;

        try {
          for await (const chunk of chatModel.stream({
            systemPrompt,
            messages,
            tools: MEMORY_5_TOOL_DEFINITIONS,
            ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
            ...(effectiveThinkingBudget !== undefined
              ? { thinkingBudgetTokens: effectiveThinkingBudget }
              : {}),
            signal: opts.signal,
          })) {
            if (chunk.type === "error") {
              attemptError = { code: chunk.code, message: chunk.message, retryable: chunk.retryable };
              break;
            }
            if (chunk.type === "thinking_delta") {
              if (chunk.delta.length > 0) stepThinking += chunk.delta;
              if (chunk.signature) stepThinkingSig = chunk.signature;
            } else if (chunk.type === "text_delta") {
              stepText += chunk.delta;
            } else if (chunk.type === "tool_call") {
              stepToolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.args });
            } else if (chunk.type === "usage") {
              if (chunk.stopReason) stepStopReason = chunk.stopReason;
            }
          }
        } catch (streamErr) {
          const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          attemptError = { code: "PROVIDER_ERROR", message: msg, retryable: true };
        }

        if (!attemptError) {
          finalText += stepText;
          break;
        }

        const canRetry =
          attempt < retryDelays.length &&
          !opts.signal?.aborted &&
          isTransientReflectError(attemptError.code, attemptError.message, attemptError.retryable);
        if (canRetry) {
          const waitMs = retryDelays[attempt]!;
          console.warn(
            `[reflect] step ${step + 1} 遇到瞬时错误 (${attemptError.code}: ${attemptError.message})，${Math.round(waitMs / 1000)}s 后重试 (${attempt + 1}/${retryDelays.length})...`,
          );
          await sleepWithAbort(waitMs, opts.signal);
          continue;
        }

        failedReason = `${attemptError.code}: ${attemptError.message}`;
        break;
      }

      if (failedReason) break;
      if (stepStopReason === "length") {
        failedReason = "OUTPUT_TRUNCATED: 反思轮输出达到上限（length）被截断，已回滚本次改动";
        break;
      }
      if (
        stepToolCalls.length === 0 &&
        stepText.trim().length === 0 &&
        stepThinking.trim().length > 0
      ) {
        failedReason = "EMPTY_OUTPUT: 反思轮仅输出思考过程、未产出正文或工具调用，已回滚本次改动";
        break;
      }
      if (stepToolCalls.length === 0) break;

      messages.push({
        role: "assistant",
        content: stepText,
        thinking: stepThinking || undefined,
        thinkingSignature: stepThinkingSig,
        toolCalls: stepToolCalls,
        timestamp: clock.now(),
      });

      for (const tc of stepToolCalls) {
        let res = { ok: false, output: `未知工具 ${tc.name}` };
        const p = String(tc.arguments.path ?? "");
        if (tc.name === "glob") {
          res = await memoryTools.glob(String(tc.arguments.pattern ?? ""));
        } else if (tc.name === "grep") {
          res = await memoryTools.grep(
            String(tc.arguments.pattern ?? ""),
            typeof tc.arguments.path === "string" ? tc.arguments.path : undefined,
            Boolean(tc.arguments.include_archived),
          );
        } else if (tc.name === "read") {
          res = await memoryTools.read(p, { countAccess: false });
        } else if (tc.name === "write") {
          const safeRel = await recordBackupIfSafe(p);
          res = await memoryTools.write(p, String(tc.arguments.content ?? ""));
          if (res.ok && safeRel) touched.add(safeRel);
        } else if (tc.name === "edit") {
          const safeRel = await recordBackupIfSafe(p);
          res = await memoryTools.edit(
            p,
            String(tc.arguments.old_string ?? ""),
            String(tc.arguments.new_string ?? ""),
          );
          if (res.ok && safeRel) touched.add(safeRel);
        }

        messages.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: res.output,
          isError: !res.ok,
          timestamp: clock.now(),
        });
      }
    }
  } catch (err) {
    failedReason = (err as Error).message;
  }

  if (failedReason) {
    await rollback();
    return {
      ok: false,
      scope: opts.scope,
      triggered: true,
      changedPaths: opts.changedPaths,
      decisionScores: opts.decisionScores,
      touchedMemoryPaths: [],
      committed: false,
      summary: "",
      error: failedReason,
    };
  }

  const touchedList = Array.from(touched);
  const summary = parseOptionalSummary(finalText, touchedList);
  const committed =
    touchedList.length > 0
      ? await commitMemoryPaths(dataDir, touchedList, `memory(reflect-${opts.scope}): ${summary}`)
      : false;

  return {
    ok: true,
    scope: opts.scope,
    triggered: true,
    changedPaths: opts.changedPaths,
    decisionScores: opts.decisionScores,
    touchedMemoryPaths: touchedList,
    committed,
    summary,
  };
}

export interface ReflectGateResult {
  shouldReflect: boolean;
  skipReason?: string;
  summary?: string;
  headCommit: string | null;
  changedPaths: string[];
  dailyRefPaths: string[];
  decisionScores?: Record<string, number>;
}

/**
 * 仅执行反思门控判定（Git 硬闸 + Decision 软闸），供独立反思轮与合并后的 bedtime 复用：
 * - 若因无实质变更或未达决策阈值跳过，立即推进对应游标；
 * - 若判定需要反思（shouldReflect=true），游标留待实际写入提交成功后再推进。
 */
export async function evaluateReflectGate(
  deps: Pick<ReflectTaskDeps, "db" | "dataDir" | "clock" | "decisionClient">,
  opts: {
    scope: ReflectScope;
    targetDay?: string;
    /** 可选只读体检雷达高置信摘要（仅作门控综合参考，不强制触发反思） */
    radarHint?: string | null;
    /** 若未直接传 radarHint，可在确认存在实质变更后懒执行只读体检雷达以提供门控参考 */
    prepareRadarHint?: (changedPaths: string[]) => Promise<string | null>;
    signal?: AbortSignal;
  },
): Promise<ReflectGateResult> {
  const { db, dataDir, clock, decisionClient } = deps;
  const targetDay = opts.targetDay ?? localDay(clock.now(), clock.timeZone);
  const memoryDir = path.join(dataDir, "memory");
  const cursor = readReflectCursor(db, opts.scope);

  if (cursor.last_day === targetDay) {
    return {
      shouldReflect: false,
      skipReason: "already_checked_today",
      summary: "今日已检查过反思门控",
      headCommit: cursor.last_commit ?? null,
      changedPaths: [],
      dailyRefPaths: [],
    };
  }

  const headCommit = await getMemoryHeadCommit(dataDir);
  if (!headCommit) {
    return {
      shouldReflect: false,
      skipReason: "no_git_commits",
      summary: "尚无记忆提交",
      headCommit: null,
      changedPaths: [],
      dailyRefPaths: [],
    };
  }

  const allChanged = await listChangedMemoryPathsSince(dataDir, cursor.last_commit ?? null);
  const substantivePaths = allChanged.filter(isSubstantiveReflectPath);
  const dailyRefPaths = allChanged.filter(isReflectionCardPath);

  if (opts.signal?.aborted) {
    return {
      shouldReflect: false,
      skipReason: "aborted",
      summary: "反思门控已中止",
      headCommit,
      changedPaths: [],
      dailyRefPaths,
    };
  }

  if (substantivePaths.length === 0) {
    writeReflectCursor(db, opts.scope, clock.now(), {
      last_commit: headCommit,
      last_day: targetDay,
      last_run_at: clock.now(),
      last_decision: "skipped_no_changes",
    });
    return {
      shouldReflect: false,
      skipReason: "no_substantive_changes",
      summary: "无实质变更，跳过反思",
      headCommit,
      changedPaths: [],
      dailyRefPaths,
    };
  }

  let decisionScores: Record<string, number> | undefined;
  if (decisionClient) {
    const sections: string[] = [
      `反思周期：${opts.scope === "daily" ? "日反思（对比昨日提交）" : "周日回顾反思（对比上周提交）"}`,
      `当前日期：${targetDay}（${weekdayOfDay(targetDay)}）`,
      `新增或修改的记忆文件（共 ${substantivePaths.length} 个）：\n${await buildFileExcerpts(memoryDir, substantivePaths, 2800)}`,
    ];

    if (opts.scope === "daily") {
      const openMd = await readOptional(path.join(memoryDir, "core", "open.md"));
      if (openMd) {
        const openBody = stripFrontmatter(openMd).trim();
        if (openBody) {
          sections.push(`当前未完挂念（core/open.md）：\n${clipExcerpt(openBody, 600)}`);
        }
      }
    } else if (dailyRefPaths.length > 0) {
      sections.push(
        `本周已完成的日反思卡片（共 ${dailyRefPaths.length} 个）：\n${await buildFileExcerpts(memoryDir, dailyRefPaths, 1600)}`,
      );
    } else {
      sections.push("本周尚未写过任何日反思卡片（rf-*.md）。");
    }

    const effectiveRadarHint =
      opts.radarHint !== undefined
        ? opts.radarHint
        : opts.prepareRadarHint
          ? await opts.prepareRadarHint(substantivePaths).catch((err) => {
              console.warn(`[psyber] reflect(${opts.scope}) radar pre-scan failed, continuing gate:`, err);
              return null;
            })
          : null;
    if (effectiveRadarHint) {
      sections.push(effectiveRadarHint);
    }

    const questions: Record<string, DecisionQuestion> =
      opts.scope === "daily"
        ? {
            has_notable_shift: {
              type: "noul",
              instructions:
                "今天的记忆变更中，是否包含值得静下心做一次深度反思的情绪波动、观念变化、相处边界磨合、自我觉察或重要决定（而不仅仅是平淡日常流水）？",
            },
            touches_open_thread: {
              type: "noul",
              instructions:
                "今天的记忆变更是否回应、推进或明显触动了现有未完挂念（core/open.md）或某段重要关系议题？",
            },
          }
        : {
            has_unabsorbed_changes: {
              type: "noul",
              instructions:
                "本周新增或修改的记忆内容中，是否仍有重要变化、情绪转折或相处边界信号尚未被本周已有的日反思（rf-*.md）充分吸收消化？",
            },
            has_cross_day_pattern: {
              type: "noul",
              instructions:
                "把本周多天的记录合起来看，是否出现了单日视角容易忽略的跨天规律、反复出现的主题或值得沉淀的长期认知？",
            },
          };

    try {
      const decisionRes = await decisionClient.decide({
        input: sections.join("\n\n"),
        questions,
        signal: opts.signal,
      });

      decisionScores = {};
      for (const [k, ans] of Object.entries(decisionRes.answers)) {
        if (typeof ans.noul === "number" && Number.isFinite(ans.noul)) {
          decisionScores[k] = ans.noul;
        }
      }

      const shouldReflect =
        opts.scope === "daily"
          ? (decisionScores.has_notable_shift ?? 0) >= DAILY_SHIFT_THRESHOLD ||
            (decisionScores.touches_open_thread ?? 0) >= DAILY_OPEN_THRESHOLD
          : (decisionScores.has_unabsorbed_changes ?? 0) >= WEEKLY_UNABSORBED_THRESHOLD ||
            (decisionScores.has_cross_day_pattern ?? 0) >= WEEKLY_PATTERN_THRESHOLD;

      if (!shouldReflect) {
        writeReflectCursor(db, opts.scope, clock.now(), {
          last_commit: headCommit,
          last_day: targetDay,
          last_run_at: clock.now(),
          last_decision: "skipped_by_decision",
        });
        return {
          shouldReflect: false,
          skipReason: "decision_below_threshold",
          summary: "决策模型判定无需反思",
          headCommit,
          changedPaths: substantivePaths,
          dailyRefPaths,
          decisionScores,
        };
      }
    } catch (err) {
      console.warn(`[psyber] reflect(${opts.scope}) decision gate failed, skipping reflect:`, err);
      return {
        shouldReflect: false,
        skipReason: `decision_error: ${(err as Error).message}`,
        summary: "决策门控异常，本次跳过反思",
        headCommit,
        changedPaths: substantivePaths,
        dailyRefPaths,
      };
    }
  }

  return {
    shouldReflect: true,
    headCommit,
    changedPaths: substantivePaths,
    dailyRefPaths,
    decisionScores,
  };
}

/** 反思（或合并了日反思的 bedtime）成功落盘后推进对应反思游标 */
export function markReflectCursorCompleted(
  db: Database,
  scope: ReflectScope,
  nowMs: number,
  opts: { targetDay: string; commitHash: string | null; committed: boolean },
): void {
  writeReflectCursor(db, scope, nowMs, {
    last_commit: opts.commitHash,
    last_day: opts.targetDay,
    last_run_at: nowMs,
    last_decision: opts.committed ? "reflected_committed" : "reflected_noop",
  });
}

/**
 * 评估单种周期（daily / weekly）是否需要启动深度反思：
 * 1. Git 硬闸：对比上次 reflect 游标 commit 到 HEAD 的实质文件变更，无实质变更直接 0 token 跳过；
 * 2. Decision 软闸：若注入了 DecisionClient，由决策模型判定是否值得启动反思；
 * 3. 启动 runMemoryReflectTask，完成后将游标推进到最新 HEAD commit。
 */
export async function evaluateAndRunReflect(
  deps: ReflectTaskDeps,
  opts: {
    scope: ReflectScope;
    targetDay?: string;
    signal?: AbortSignal;
  },
): Promise<ReflectTaskOutcome> {
  const { db, dataDir, clock } = deps;
  const targetDay = opts.targetDay ?? localDay(clock.now(), clock.timeZone);
  let weeklyRadarRes: MemoryRadarResult | null = null;
  const gate = await evaluateReflectGate(deps, {
    scope: opts.scope,
    targetDay,
    ...(opts.scope === "weekly" && deps.decisionClient
      ? {
          prepareRadarHint: async (changedPaths: string[]) => {
            weeklyRadarRes = await runMemoryRadar({
              db,
              dataDir,
              promptsDir: deps.promptsDir,
              clock,
              memoryIndex: deps.memoryIndex,
              decisionClient: deps.decisionClient,
              embedding: deps.embedding,
              scope: "weekly",
              targetDay,
              newCardPaths: changedPaths,
              radarConfig: deps.getConfig?.()?.radar,
              includeOpenBoardInBlock: true,
              signal: opts.signal,
            });
            return weeklyRadarRes.reflectGateHint;
          },
        }
      : {}),
    signal: opts.signal,
  });

  const radarSummary = weeklyRadarRes
    ? {
        executed: (weeklyRadarRes as MemoryRadarResult).executed,
        boardItemsChecked: (weeklyRadarRes as MemoryRadarResult).boardItemsChecked,
        pairsEvaluated: (weeklyRadarRes as MemoryRadarResult).pairsEvaluated,
        findingsCount: (weeklyRadarRes as MemoryRadarResult).findings.length,
      }
    : undefined;

  if (!gate.shouldReflect) {
    return {
      ok: true,
      scope: opts.scope,
      triggered: false,
      skipReason: gate.skipReason,
      changedPaths: gate.changedPaths,
      decisionScores: gate.decisionScores,
      ...(radarSummary ? { radar: radarSummary } : {}),
      touchedMemoryPaths: [],
      committed: false,
      summary: gate.summary ?? "跳过反思",
    };
  }

  const outcome = await runMemoryReflectTask(deps, {
    scope: opts.scope,
    targetDay,
    changedPaths: gate.changedPaths,
    dailyRefPaths: gate.dailyRefPaths,
    decisionScores: gate.decisionScores,
    radarBlock: (weeklyRadarRes as MemoryRadarResult | null)?.renderedBlock ?? null,
    signal: opts.signal,
  });

  if (outcome.ok) {
    const newHead = (await getMemoryHeadCommit(dataDir)) ?? gate.headCommit;
    markReflectCursorCompleted(db, opts.scope, clock.now(), {
      targetDay,
      commitHash: newHead,
      committed: outcome.committed,
    });
  }

  return {
    ...outcome,
    ...(radarSummary ? { radar: radarSummary } : {}),
  };
}

/**
 * 睡前整理（bedtime）完成后依次执行：
 * 1. 日反思门控（每日 bedtime 后对比上次日反思 commit）
 * 2. 周反思门控（周日或跨过周日补触发，对比上周周反思 commit，若新增已被日反思吸收则跳过）
 */
export async function maybeRunReflectAfterBedtime(
  deps: ReflectTaskDeps,
  opts: { targetDay?: string; signal?: AbortSignal } = {},
): Promise<PostBedtimeReflectResult> {
  const targetDay = opts.targetDay ?? localDay(deps.clock.now(), deps.clock.timeZone);
  const daily = await evaluateAndRunReflect(deps, {
    scope: "daily",
    targetDay,
    signal: opts.signal,
  });

  let weekly: ReflectTaskOutcome | null = null;
  if (isWeeklyReflectDue(deps.db, targetDay, deps.clock.timeZone)) {
    weekly = await evaluateAndRunReflect(deps, {
      scope: "weekly",
      targetDay,
      signal: opts.signal,
    });
  }

  return { daily, weekly };
}
