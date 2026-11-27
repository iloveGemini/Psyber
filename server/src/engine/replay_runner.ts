import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { VirtualClock, localDay, weekdayOfDay, type Clock } from "../core/clock.ts";
import { DEFAULT_CIRCADIAN_CONFIG, atomicWriteFile, type PsyberConfig } from "../core/config.ts";
import {
  commitMemoryPaths,
  getMemoryHeadCommit,
  listChangedMemoryPathsSince,
  rollbackMemoryTouchedPaths,
} from "../core/git.ts";
import type { AsyncMutex } from "../core/mutex.ts";
import { readPrompt, stripFrontmatter } from "../core/prompts.ts";
import { filterActiveStateMarkdown } from "../memory/frontmatter.ts";
import { readIdentityProfile } from "../memory/genesis.ts";
import {
  DEFAULT_GIST_CHAR_BUDGET,
  GIST_SOFT_WARN_RATIO,
  selectActiveGistLayers,
} from "../memory/gist.ts";
import type { MemoryIndex } from "../memory/index.ts";
import { groupByLogicalNight } from "../mood/circadian.ts";
import type { EventStore } from "../store/events.ts";
import {
  REFLECT_SCOPE_BLOCKS,
  buildReflectContextBlock,
  isReflectionCardPath,
  isSubstantiveReflectPath,
  isWeeklyReflectDue,
  markReflectCursorCompleted,
  readReflectCursor,
} from "./reflect.ts";
import {
  TASK_SPECIFIC_BLOCKS,
  buildTidyContextBlock,
  clipExcerpt,
  episodeDirForDay,
  formatTidyTranscriptLine,
  tailSlice,
  type GistWatermarkInfo,
  type RawEventRow,
} from "./tidy.ts";

const MCP_REPLAY_CURSOR_KEY = "mcp_replay";
const DEFAULT_MAX_CHARS = 40_000;
const MIN_MAX_CHARS = 4_000;
const MAX_MAX_CHARS = 100_000;
const DEFAULT_MIN_CHARS = 5_000;
const MAX_MIN_CHARS = 40_000;
const MAX_DAYS_PER_PLAN = 365;
const REPLAY_STATE_FILENAME = "replay_state.json";
const ELIGIBLE_CHAT_WHERE =
  "status IN ('active', 'retracted') AND role IN ('user', 'assistant') AND kind IN ('chat', 'wake', 'door_note')";

export type McpReplayPhase = "wrapup" | "bedtime" | "reflect_weekly";

export interface McpReplayTouchedEntry {
  path: string;
  existedBefore: boolean;
}

export interface McpReplayActiveStep {
  stepId: string;
  day: string;
  phase: McpReplayPhase;
  bedtimeAtMs: number;
  startedAtMs: number;
  baseCommit: string | null;
  touchedPaths: McpReplayTouchedEntry[];
  partIndex?: number;
  totalParts?: number;
  startEventId?: string;
  startEventSeq?: number;
  endEventId?: string;
  endEventSeq?: number;
  endEventCreatedAt?: number;
  eventCount?: number;
  charCount?: number;
  dayLastEventId?: string;
  dayLastEventCreatedAt?: number;
  reflectChangedPaths?: string[];
  reflectDailyRefPaths?: string[];
}

export interface McpReplayPlan {
  targetDays: string[];
  completedDays: string[];
  deferredDays: string[];
  maxChars: number;
  minChars: number;
  compactRules?: boolean;
  untilDay?: string | null;
  createdAtMs: number;
}

interface McpReplayState {
  version: 1;
  plan: McpReplayPlan | null;
  activeStep: McpReplayActiveStep | null;
  currentDay: string | null;
  dayPartDone: number;
  dayProcessedEvents: number;
  dayTouchedPaths: string[];
  totalStepsCompleted: number;
  nextStepSeq: number;
}

export interface McpReplayRunnerDeps {
  db: Database;
  dataDir: string;
  promptsDir: string;
  clock: Clock;
  events: EventStore;
  memoryIndex: MemoryIndex;
  gitMutex: AsyncMutex;
  getConfig: () => PsyberConfig;
}

export interface McpReplayExecResult {
  ok: boolean;
  output: string;
}

interface ReplayDayGroup {
  day: string;
  rows: RawEventRow[];
  bedtimeAtMs: number;
  totalChars: number;
  lastEventId: string;
  lastSeq: number;
  lastCreatedAt: number;
}

interface ReplayStateFile {
  version: number;
  sourcePath: string;
  importedDays: string[];
  tidiedDays: string[];
  results: Record<
    string,
    {
      day: string;
      importedAt: string;
      importedEvents: number;
      importedAttachments: number;
      tidiedAt?: string;
      deferredToNext?: boolean;
      processedEvents?: number;
      touchedMemoryPaths?: string[];
      summary?: string;
    }
  >;
}

function defaultState(): McpReplayState {
  return {
    version: 1,
    plan: null,
    activeStep: null,
    currentDay: null,
    dayPartDone: 0,
    dayProcessedEvents: 0,
    dayTouchedPaths: [],
    totalStepsCompleted: 0,
    nextStepSeq: 1,
  };
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function sanitizeCommitPart(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\r\n\0\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function stripPromptCompletionSection(body: string): string {
  return body.replace(/\n*#\s*完成输出格式[\s\S]*$/m, "").trim();
}

async function readOptional(absPath: string): Promise<string | null> {
  try {
    const t = await fs.readFile(absPath, "utf8");
    return t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

function splitRowsIntoTurnChunks(rows: RawEventRow[], maxChars: number): RawEventRow[][] {
  if (rows.length === 0) return [];
  const chunks: RawEventRow[][] = [];
  let cur: RawEventRow[] = [];
  let chars = 0;

  for (let i = 0; i < rows.length; i++) {
    const ev = rows[i]!;
    const evChars = ev.content.length;
    if (
      cur.length > 0 &&
      chars + evChars > maxChars &&
      ev.turn_id !== cur[cur.length - 1]!.turn_id
    ) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(ev);
    chars += evChars;
  }
  if (cur.length > 0) {
    chunks.push(cur);
  }
  return chunks;
}

/**
 * MCP 历史搬家状态机（复用 replay.ts 逻辑作息日切分/低量攒批 + tidy.ts 上下文拼装 + reflect.ts 周反思）：
 * - 状态持久化于 SQLite `task_cursors['mcp_replay']`，断线或跨窗口续跑不丢不跳步；
 * - 步骤内写入按该历史日虚拟时钟校验与索引，并在 `next` 结算时统一单次 Git 提交、同步内部游标与 `replay_state.json`。
 */
export class McpReplayRunner {
  constructor(private readonly deps: McpReplayRunnerDeps) {}

  private loadState(): McpReplayState {
    const row = this.deps.db
      .query("SELECT meta_json FROM task_cursors WHERE task_key = ?")
      .get(MCP_REPLAY_CURSOR_KEY) as { meta_json: string | null } | null;
    if (!row?.meta_json) return defaultState();
    try {
      const parsed = JSON.parse(row.meta_json) as Partial<McpReplayState>;
      if (!parsed || typeof parsed !== "object") return defaultState();
      return {
        version: 1,
        plan: parsed.plan ?? null,
        activeStep: parsed.activeStep ?? null,
        currentDay: typeof parsed.currentDay === "string" ? parsed.currentDay : null,
        dayPartDone: typeof parsed.dayPartDone === "number" ? parsed.dayPartDone : 0,
        dayProcessedEvents:
          typeof parsed.dayProcessedEvents === "number" ? parsed.dayProcessedEvents : 0,
        dayTouchedPaths: Array.isArray(parsed.dayTouchedPaths) ? parsed.dayTouchedPaths : [],
        totalStepsCompleted:
          typeof parsed.totalStepsCompleted === "number" ? parsed.totalStepsCompleted : 0,
        nextStepSeq:
          typeof parsed.nextStepSeq === "number" && parsed.nextStepSeq >= 1
            ? parsed.nextStepSeq
            : 1,
      };
    } catch {
      return defaultState();
    }
  }

  private saveState(state: McpReplayState, lastEventId = ""): void {
    const resolvedId = lastEventId || this.deps.events.getCursor("daily_wrapup") || "";
    this.deps.events.setCursor(
      MCP_REPLAY_CURSOR_KEY,
      resolvedId,
      state as unknown as Record<string, unknown>,
    );
  }

  /** 读取当前在途搬家步骤（供 MCP 写入路径决定时钟、核心保护粒度与延迟提交） */
  getActiveStep(): McpReplayActiveStep | null {
    return this.loadState().activeStep;
  }

  /** 记录本搬家步骤内写入或编辑的记忆卡片路径（去重保留初始存在性供回滚） */
  recordStepWrite(relPath: string, existedBefore: boolean): void {
    const state = this.loadState();
    if (!state.activeStep) return;
    const existing = state.activeStep.touchedPaths.find((item) => item.path === relPath);
    if (!existing) {
      state.activeStep.touchedPaths.push({ path: relPath, existedBefore });
      this.saveState(state);
    }
  }

  private queryAllChatEvents(): RawEventRow[] {
    return this.deps.db
      .query(
        `SELECT id, seq, turn_id, status, role, kind, content, metadata, created_at
         FROM events
         WHERE ${ELIGIBLE_CHAT_WHERE}
         ORDER BY seq ASC`,
      )
      .all() as RawEventRow[];
  }

  private buildLogicalDays(): {
    allEvents: RawEventRow[];
    groups: ReplayDayGroup[];
    byDay: Map<string, ReplayDayGroup>;
  } {
    const cfg = this.deps.getConfig();
    const tz = cfg.timezone || this.deps.clock.timeZone;
    const circadian = cfg.circadian ?? DEFAULT_CIRCADIAN_CONFIG;
    const allEvents = this.queryAllChatEvents();
    const { days, byDay, bedtimeByDay } = groupByLogicalNight(
      allEvents,
      (r) => r.created_at,
      tz,
      circadian,
    );
    const groups: ReplayDayGroup[] = [];
    const groupMap = new Map<string, ReplayDayGroup>();
    for (const day of days) {
      const rows = byDay.get(day)!;
      const last = rows[rows.length - 1]!;
      let totalChars = 0;
      for (const r of rows) totalChars += r.content.length;
      const g: ReplayDayGroup = {
        day,
        rows,
        bedtimeAtMs: bedtimeByDay.get(day)!,
        totalChars,
        lastEventId: last.id,
        lastSeq: last.seq,
        lastCreatedAt: last.created_at,
      };
      groups.push(g);
      groupMap.set(day, g);
    }
    return { allEvents, groups, byDay: groupMap };
  }

  private computePendingDays(groups: ReplayDayGroup[]): ReplayDayGroup[] {
    const wrapupCursor = this.deps.events.getCursor("daily_wrapup") ?? "";
    const bedtimeDate = this.deps.events.getBedtimeNightDate();
    return groups.filter((g) => {
      const hasPendingEvents = g.rows.some((r) => r.id > wrapupCursor);
      return hasPendingEvents || bedtimeDate === null || g.day > bedtimeDate;
    });
  }

  private queryPendingEventsUpToSeq(maxSeq: number): RawEventRow[] {
    const wrapupCursor = this.deps.events.getCursor("daily_wrapup") ?? "";
    return this.deps.db
      .query(
        `SELECT id, seq, turn_id, status, role, kind, content, metadata, created_at
         FROM events
         WHERE ${ELIGIBLE_CHAT_WHERE}
           AND id > ?
           AND seq <= ?
         ORDER BY seq ASC`,
      )
      .all(wrapupCursor, maxSeq) as RawEventRow[];
  }

  private async hasEpisodeCardsForDay(day: string): Promise<boolean> {
    const [y, m, d] = day.split("-");
    if (!y || !m || !d) return false;
    try {
      const entries = await fs.readdir(path.join(this.deps.dataDir, "memory", "episodes", y, m, d));
      return entries.some((name) => name.startsWith("ep-") && name.endsWith(".md"));
    } catch {
      return false;
    }
  }

  private async syncReplayStateFile(
    day: string,
    patch: {
      deferredToNext?: boolean;
      processedEvents?: number;
      touchedMemoryPaths?: string[];
      summary?: string;
    },
  ): Promise<void> {
    const filePath = path.join(this.deps.dataDir, REPLAY_STATE_FILENAME);
    let parsed: ReplayStateFile;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      parsed = JSON.parse(raw) as ReplayStateFile;
      if (!parsed || typeof parsed !== "object") return;
    } catch {
      // 仅当用户通过 replay.ts 初始化过 replay_state.json 时才同步回写，避免污染纯运行实例
      return;
    }
    const tidiedSet = new Set(Array.isArray(parsed.tidiedDays) ? parsed.tidiedDays : []);
    tidiedSet.add(day);
    const importedDays = Array.isArray(parsed.importedDays) ? parsed.importedDays : [];
    parsed.tidiedDays = [
      ...importedDays.filter((d) => tidiedSet.has(d)),
      ...Array.from(tidiedSet).filter((d) => !importedDays.includes(d)).sort(),
    ];
    if (!parsed.results || typeof parsed.results !== "object") {
      parsed.results = {};
    }
    const prev = parsed.results[day] ?? {
      day,
      importedAt: new Date(this.deps.clock.now()).toISOString(),
      importedEvents: 0,
      importedAttachments: 0,
    };
    parsed.results[day] = {
      ...prev,
      ...(patch.deferredToNext ? { deferredToNext: true } : { tidiedAt: new Date(this.deps.clock.now()).toISOString() }),
      ...(patch.processedEvents !== undefined ? { processedEvents: patch.processedEvents } : {}),
      ...(patch.touchedMemoryPaths !== undefined ? { touchedMemoryPaths: patch.touchedMemoryPaths } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    };
    await atomicWriteFile(this.deps.dataDir, filePath, JSON.stringify(parsed, null, 2) + "\n");
  }

  private buildProtectionNotice(phase: McpReplayPhase, protectCoreFiles: boolean): string {
    if (!protectCoreFiles) {
      return "核心保护（protectCoreFiles）：已关闭；可按需使用 memory_edit 局部修订 core/*（禁止整篇覆写 core/self.md 与 core/user.md）。";
    }
    if (phase === "reflect_weekly") {
      return "核心保护（protectCoreFiles）：已开启（周反思期间允许写入/编辑 core/open.md 与 core/state.md，禁止修改 core/self.md、core/user.md、core/boundaries.md、core/mirror.md）。";
    }
    return "核心保护（protectCoreFiles）：已开启（搬家整理期间允许对账更新 core/state.md，禁止修改 core/self.md、core/user.md、core/boundaries.md、core/mirror.md）。";
  }

  private async renderActiveStep(
    state: McpReplayState,
    opts: { protectCoreFiles: boolean; resumed: boolean; compactRules?: boolean },
  ): Promise<McpReplayExecResult> {
    const step = state.activeStep!;
    const plan = state.plan;
    const cfg = this.deps.getConfig();
    const tz = cfg.timezone || this.deps.clock.timeZone;
    const memoryDir = path.join(this.deps.dataDir, "memory");
    const weekday = weekdayOfDay(step.day);
    const stepClock = new VirtualClock(step.bedtimeAtMs, tz);
    const useCompactRules =
      Boolean(opts.compactRules) && !opts.resumed && step.phase !== "reflect_weekly";

    const dayIdx = plan ? plan.targetDays.indexOf(step.day) + 1 : 1;
    const totalDays = plan ? plan.targetDays.length : 1;

    const headerLines = [
      `status: step`,
      `step_id: ${step.stepId}`,
      `phase: ${step.phase}`,
      `day: ${step.day}（${weekday}）`,
      `progress: 第 ${Math.max(1, dayIdx)}/${Math.max(1, totalDays)} 天（计划已完成 ${plan?.completedDays.length ?? 0} 天，低量顺延 ${plan?.deferredDays.length ?? 0} 天）`,
      this.buildProtectionNotice(step.phase, opts.protectCoreFiles),
      `日期填写硬约束：本步写入或编辑的所有卡片，其 frontmatter 的 created / updated 与标题 MM-DD 必须严格使用历史日期 ${step.day}（严禁写现实今天日期）。`,
    ];
    if (useCompactRules) {
      headerLines.push(
        "规则模式：compact_rules（沿用前文 <tidy_rules>、<self>、<user>；周反思与新窗口续接会自动下发完整规则）。",
      );
    }
    if (step.phase === "wrapup" && step.partIndex && step.totalParts) {
      const isFinalPart = step.partIndex >= step.totalParts;
      headerLines.push(
        `wrapup_part: ${step.partIndex}/${step.totalParts}（${isFinalPart ? "本日对话最后一批，下一步将进入 bedtime 写日梗概" : "本批后仍有同日后续对话，本步暂不写 episodes/.../index.md"}）`,
      );
    }
    if (opts.resumed) {
      const touched = step.touchedPaths.map((t) => `- ${t.path}`).join("\n");
      headerLines.push(
        `[续接上次未提交步骤] 本步尚未调用 next 结算，已原样重发任务包。`,
        touched ? `本步此前已写入/编辑过的卡片：\n${touched}` : "本步此前尚未写入任何卡片。",
      );
    }

    const [selfMd, userMd, identity] = await Promise.all([
      useCompactRules ? Promise.resolve(null) : readOptional(path.join(memoryDir, "core", "self.md")),
      useCompactRules ? Promise.resolve(null) : readOptional(path.join(memoryDir, "core", "user.md")),
      readIdentityProfile(this.deps.dataDir, stepClock.now(), tz),
    ]);
    const userLabel = identity.userName ?? identity.userPronoun ?? "TA";

    const sections: string[] = [headerLines.join("\n")];
    if (selfMd) sections.push(`<self>\n${selfMd}\n</self>`);
    if (userMd) sections.push(`<user>\n${userMd}\n</user>`);

    if (step.phase === "wrapup") {
      const [tidyPrompt, stateRaw, threadReg, entReg] = await Promise.all([
        useCompactRules
          ? Promise.resolve(null)
          : readPrompt(this.deps.promptsDir, "tidy.md", {
              TASK_SPECIFIC_BLOCK: TASK_SPECIFIC_BLOCKS.daily_wrapup,
            }),
        readOptional(path.join(memoryDir, "core", "state.md")),
        readOptional(path.join(memoryDir, "threads", "REGISTRY.yaml")),
        readOptional(path.join(memoryDir, "entities", "REGISTRY.yaml")),
      ]);
      if (tidyPrompt) {
        sections.push(`<tidy_rules>\n${stripPromptCompletionSection(tidyPrompt.body)}\n</tidy_rules>`);
      }
      sections.push(buildTidyContextBlock({ taskType: "daily_wrapup", targetDay: step.day }));

      const stateFiltered = stateRaw ? filterActiveStateMarkdown(stateRaw, step.day) : null;
      if (stateFiltered) {
        sections.push(`# 现行 core/state.md（按 ${step.day} 过滤后，供对账）\n${tailSlice(stateFiltered, 1500)}`);
      }
      if (threadReg) sections.push(`# threads/REGISTRY.yaml\n${threadReg}`);
      if (entReg) sections.push(`# entities/REGISTRY.yaml\n${entReg}`);

      const rows = this.loadStepEvents(step);
      const transcript = rows.map((e) =>
        formatTidyTranscriptLine(e, tz, userLabel, { includeMediaHashes: true }),
      );
      sections.push(
        `# 待整理对话（共 ${rows.length} 条，约 ${step.charCount ?? 0} 字）\n${transcript.join("\n") || "（本段无有效文本消息）"}`,
      );
    } else if (step.phase === "bedtime") {
      const [tidyPrompt, stateRaw, layers] = await Promise.all([
        useCompactRules
          ? Promise.resolve(null)
          : readPrompt(this.deps.promptsDir, "tidy.md", {
              TASK_SPECIFIC_BLOCK: TASK_SPECIFIC_BLOCKS.bedtime,
            }),
        readOptional(path.join(memoryDir, "core", "state.md")),
        selectActiveGistLayers(memoryDir, step.day),
      ]);
      const softWarnChars = Math.floor(DEFAULT_GIST_CHAR_BUDGET * GIST_SOFT_WARN_RATIO);
      const gistWatermark: GistWatermarkInfo = {
        totalChars: layers.totalChars,
        budgetChars: DEFAULT_GIST_CHAR_BUDGET,
        softWarnChars,
        nearLimit: layers.totalChars >= softWarnChars,
      };

      if (tidyPrompt) {
        sections.push(`<tidy_rules>\n${stripPromptCompletionSection(tidyPrompt.body)}\n</tidy_rules>`);
      }
      sections.push(
        buildTidyContextBlock({
          taskType: "bedtime",
          targetDay: step.day,
          gistWatermark,
        }),
      );

      // 汇总今日已整理的卡片摘要（由 dayTouchedPaths + 当日目录已有切片组成）
      const dayDir = episodeDirForDay(step.day);
      const todayRows = this.deps.memoryIndex
        .listAllRows()
        .filter(
          (r) =>
            r.kind !== "reflection" &&
            !r.path.endsWith("/index.md") &&
            (state.dayTouchedPaths.includes(r.path) || r.path.startsWith(`${dayDir}/`)),
        );
      if (todayRows.length > 0) {
        const cardLines: string[] = [];
        let excerptBudget = 2400;
        for (const c of todayRows) {
          const header = `- ${c.path}（${c.kind} · ${c.status}）：${c.title}`;
          if (excerptBudget > 60) {
            const raw = await readOptional(path.join(memoryDir, c.path));
            if (raw) {
              const excerpt = clipExcerpt(stripFrontmatter(raw), Math.min(350, excerptBudget));
              if (excerpt) {
                excerptBudget -= excerpt.length;
                cardLines.push(`${header}\n  摘要：${excerpt}`);
                continue;
              }
            }
          }
          cardLines.push(header);
        }
        sections.push(`# 今日已整理卡片摘要（共 ${todayRows.length} 张）\n${cardLines.join("\n")}`);
      }

      if (layers.activeDays.length > 0 || layers.activeMonths.length > 0) {
        const statusLines: string[] = [];
        if (layers.activeMonths.length > 0) {
          statusLines.push(
            `- 未滚入年梗概的月梗概（${layers.activeMonths.length} 份）：${layers.activeMonths.map((m) => `${m.key}(至 ${m.coveredUntil ?? "未知"})`).join("、")}`,
          );
        }
        if (layers.activeDays.length > 0) {
          statusLines.push(
            `- 未滚入月梗概的日梗概（${layers.activeDays.length} 份）：${layers.activeDays.map((d) => d.key).join("、")}`,
          );
        }
        const shouldAttachRollupBody =
          gistWatermark.nearLimit || layers.activeDays.length >= 14;
        if (shouldAttachRollupBody) {
          const rollupSnippets: string[] = [];
          if (layers.activeMonths.length > 0) {
            rollupSnippets.push(
              layers.activeMonths.map((m) => `### ${m.key}\n${m.text}`).join("\n\n"),
            );
          }
          if (layers.activeDays.length > 0) {
            rollupSnippets.push(
              layers.activeDays.map((d) => `### ${d.key}\n${d.text}`).join("\n\n"),
            );
          }
          sections.push(
            `# 当前未滚动的时间梗概清单（已达软水位或积压较多，供向上合并参考）\n${statusLines.join("\n")}\n\n${tailSlice(rollupSnippets.join("\n\n"), 5000)}`,
          );
        } else {
          sections.push(`# 当前未滚动的时间梗概清单\n${statusLines.join("\n")}`);
        }
      }

      const stateFiltered = stateRaw ? filterActiveStateMarkdown(stateRaw, step.day) : null;
      if (stateFiltered) {
        sections.push(`# 现行 core/state.md（按 ${step.day} 过滤后，供睡前对账）\n${tailSlice(stateFiltered, 1500)}`);
      }
    } else {
      const [reflectPrompt, openMd] = await Promise.all([
        useCompactRules
          ? Promise.resolve(null)
          : readPrompt(this.deps.promptsDir, "reflect.md", {
              REFLECT_SCOPE_BLOCK: REFLECT_SCOPE_BLOCKS.weekly,
            }),
        readOptional(path.join(memoryDir, "core", "open.md")),
      ]);
      if (reflectPrompt) {
        sections.push(
          `<reflect_rules>\n${stripPromptCompletionSection(reflectPrompt.body)}\n</reflect_rules>`,
        );
      }
      sections.push(
        buildReflectContextBlock({
          scope: "weekly",
          targetDay: step.day,
          changedPaths: step.reflectChangedPaths ?? [],
          dailyRefPaths: step.reflectDailyRefPaths ?? [],
        }),
      );
      if (openMd) {
        const body = stripFrontmatter(openMd).trim();
        if (body) {
          sections.push(`# 现行 core/open.md（未完挂念与待观察问号）\n${clipExcerpt(body, 1500)}`);
        }
      }
    }

    sections.push(
      `# 交卷方式（必须调用工具，勿只输出纯文本 JSON）\n` +
        `完成本步卡片读写后，请调用：\n` +
        `memory_replay(action="next", step_id="${step.stepId}", summary="15字以内中文摘要")`,
    );

    return {
      ok: true,
      output: sections.join("\n\n"),
    };
  }

  private loadStepEvents(step: McpReplayActiveStep): RawEventRow[] {
    if (
      typeof step.startEventSeq === "number" &&
      typeof step.endEventSeq === "number" &&
      Number.isFinite(step.startEventSeq) &&
      Number.isFinite(step.endEventSeq)
    ) {
      return this.deps.db
        .query(
          `SELECT id, seq, turn_id, status, role, kind, content, metadata, created_at
           FROM events
           WHERE ${ELIGIBLE_CHAT_WHERE}
             AND seq >= ?
             AND seq <= ?
           ORDER BY seq ASC`,
        )
        .all(step.startEventSeq, step.endEventSeq) as RawEventRow[];
    }
    if (!step.startEventId || !step.endEventId) return [];
    return this.deps.db
      .query(
        `SELECT id, seq, turn_id, status, role, kind, content, metadata, created_at
         FROM events
         WHERE ${ELIGIBLE_CHAT_WHERE}
           AND id >= ?
           AND id <= ?
         ORDER BY seq ASC`,
      )
      .all(step.startEventId, step.endEventId) as RawEventRow[];
  }

  private async advanceToNextStep(
    state: McpReplayState,
    byDay: Map<string, ReplayDayGroup>,
    allGroups: ReplayDayGroup[],
    opts: { protectCoreFiles: boolean; compactRules?: boolean },
  ): Promise<McpReplayExecResult> {
    const plan = state.plan;
    if (!plan) {
      return { ok: true, output: "status: idle\n当前没有进行中的搬家计划。" };
    }

    while (true) {
      const doneSet = new Set([...plan.completedDays, ...plan.deferredDays]);
      const nextDay =
        state.currentDay && !doneSet.has(state.currentDay)
          ? state.currentDay
          : plan.targetDays.find((d) => !doneSet.has(d)) ?? null;

      if (!nextDay) {
        // 整个计划收尾：若全库已无剩余待整理日期且尚未建立周反思基准 commit，对齐到最新 HEAD 防回家首次周反思扫全库
        const remaining = this.computePendingDays(allGroups);
        if (remaining.length === 0) {
          const weeklyCursor = readReflectCursor(this.deps.db, "weekly");
          if (!weeklyCursor.last_commit) {
            const head = await getMemoryHeadCommit(this.deps.dataDir);
            const lastCompleted =
              plan.completedDays[plan.completedDays.length - 1] ??
              plan.targetDays[plan.targetDays.length - 1] ??
              localDay(this.deps.clock.now(), this.deps.clock.timeZone);
            if (head) {
              markReflectCursorCompleted(this.deps.db, "weekly", this.deps.clock.now(), {
                targetDay: lastCompleted,
                commitHash: head,
                committed: false,
              });
            }
          }
        }

        const finishedMsg = [
          `status: finished`,
          `已完成本轮搬家计划：共完成 ${plan.completedDays.length} 天（${plan.completedDays.join(", ") || "无"}），低量顺延 ${plan.deferredDays.length} 天（${plan.deferredDays.join(", ") || "无"}）。`,
          `累计完成步骤：${state.totalStepsCompleted} 步。`,
          `全库剩余待整理历史天数：${remaining.length} 天。`,
        ].join("\n");

        state.plan = null;
        state.activeStep = null;
        state.currentDay = null;
        state.dayPartDone = 0;
        state.dayProcessedEvents = 0;
        state.dayTouchedPaths = [];
        this.saveState(state);
        return { ok: true, output: finishedMsg };
      }

      const group = byDay.get(nextDay);
      if (!group) {
        plan.completedDays.push(nextDay);
        state.currentDay = null;
        state.dayPartDone = 0;
        state.dayProcessedEvents = 0;
        state.dayTouchedPaths = [];
        this.saveState(state);
        continue;
      }

      if (state.currentDay !== nextDay) {
        state.currentDay = nextDay;
        state.dayPartDone = 0;
        state.dayProcessedEvents = 0;
        state.dayTouchedPaths = [];
      }

      const pendingRows = this.queryPendingEventsUpToSeq(group.lastSeq);
      const pendingChars = pendingRows.reduce((sum, r) => sum + r.content.length, 0);
      const dayIdx = plan.targetDays.indexOf(nextDay);
      const hasMoreDaysInPlan = dayIdx >= 0 && dayIdx < plan.targetDays.length - 1;
      const allDayIdx = allGroups.findIndex((g) => g.day === nextDay);
      const nextGroupInDb =
        allDayIdx >= 0 && allDayIdx < allGroups.length - 1 ? allGroups[allDayIdx + 1]! : null;
      const canPullNextDayFromDb =
        !hasMoreDaysInPlan &&
        nextGroupInDb !== null &&
        (!plan.untilDay || nextGroupInDb.day <= plan.untilDay);
      const canDefer = hasMoreDaysInPlan || canPullNextDayFromDb;

      // 低量日攒批顺延逻辑：若批次末尾刚好是低量日且库中还有后续日（未受 until 截止限制），自动拉入下一日合并消化
      if (
        state.dayPartDone === 0 &&
        plan.minChars > 0 &&
        pendingRows.length > 0 &&
        pendingChars < plan.minChars &&
        canDefer &&
        !(await this.hasEpisodeCardsForDay(nextDay))
      ) {
        plan.deferredDays.push(nextDay);
        if (canPullNextDayFromDb && nextGroupInDb && !plan.targetDays.includes(nextGroupInDb.day)) {
          plan.targetDays.push(nextGroupInDb.day);
        }
        await this.syncReplayStateFile(nextDay, {
          deferredToNext: true,
          processedEvents: 0,
          touchedMemoryPaths: [],
          summary: `攒批顺延（累计 ${pendingChars} 字 < ${plan.minChars}）`,
        });
        state.currentDay = null;
        state.dayPartDone = 0;
        state.dayProcessedEvents = 0;
        state.dayTouchedPaths = [];
        this.saveState(state);
        continue;
      }

      const baseCommit = await getMemoryHeadCommit(this.deps.dataDir);

      if (pendingRows.length > 0) {
        const stepSeq = state.nextStepSeq++;
        const chunks = splitRowsIntoTurnChunks(pendingRows, plan.maxChars);
        const batch = chunks[0]!;
        const partIndex = state.dayPartDone + 1;
        const totalParts = state.dayPartDone + chunks.length;
        const batchChars = batch.reduce((sum, r) => sum + r.content.length, 0);
        state.activeStep = {
          stepId: `${nextDay}:wrapup:${partIndex}#${stepSeq}`,
          day: nextDay,
          phase: "wrapup",
          bedtimeAtMs: group.bedtimeAtMs,
          startedAtMs: this.deps.clock.now(),
          baseCommit,
          touchedPaths: [],
          partIndex,
          totalParts,
          startEventId: batch[0]!.id,
          startEventSeq: batch[0]!.seq,
          endEventId: batch[batch.length - 1]!.id,
          endEventSeq: batch[batch.length - 1]!.seq,
          endEventCreatedAt: batch[batch.length - 1]!.created_at,
          eventCount: batch.length,
          charCount: batchChars,
          dayLastEventId: group.lastEventId,
          dayLastEventCreatedAt: group.lastCreatedAt,
        };
        this.saveState(state);
        return this.renderActiveStep(state, {
          protectCoreFiles: opts.protectCoreFiles,
          resumed: false,
          compactRules: opts.compactRules,
        });
      }

      // 该日所有对话已 wrapup 完毕，判断是否需要进入 bedtime
      const bedtimeDate = this.deps.events.getBedtimeNightDate();
      if (bedtimeDate === null || nextDay > bedtimeDate) {
        const stepSeq = state.nextStepSeq++;
        state.activeStep = {
          stepId: `${nextDay}:bedtime:1#${stepSeq}`,
          day: nextDay,
          phase: "bedtime",
          bedtimeAtMs: group.bedtimeAtMs,
          startedAtMs: this.deps.clock.now(),
          baseCommit,
          touchedPaths: [],
          dayLastEventId: group.lastEventId,
          dayLastEventCreatedAt: group.lastCreatedAt,
        };
        this.saveState(state);
        return this.renderActiveStep(state, {
          protectCoreFiles: opts.protectCoreFiles,
          resumed: false,
          compactRules: opts.compactRules,
        });
      }

      // 当日 bedtime 已结算，检查是否应触发周反思（复用 reflect.ts isWeeklyReflectDue + Git 实质变更硬闸）
      const tz = this.deps.getConfig().timezone || this.deps.clock.timeZone;
      const weeklyCursor = readReflectCursor(this.deps.db, "weekly");
      if (weeklyCursor.last_day !== nextDay && isWeeklyReflectDue(this.deps.db, nextDay, tz)) {
        const allChanged = await listChangedMemoryPathsSince(
          this.deps.dataDir,
          weeklyCursor.last_commit ?? null,
        );
        const substantive = allChanged.filter(isSubstantiveReflectPath);
        const dailyRefs = allChanged.filter(isReflectionCardPath);
        if (substantive.length > 0) {
          const stepSeq = state.nextStepSeq++;
          state.activeStep = {
            stepId: `${nextDay}:reflect_weekly:1#${stepSeq}`,
            day: nextDay,
            phase: "reflect_weekly",
            bedtimeAtMs: group.bedtimeAtMs,
            startedAtMs: this.deps.clock.now(),
            baseCommit,
            touchedPaths: [],
            reflectChangedPaths: substantive,
            reflectDailyRefPaths: dailyRefs,
          };
          this.saveState(state);
          return this.renderActiveStep(state, {
            protectCoreFiles: opts.protectCoreFiles,
            resumed: false,
            compactRules: opts.compactRules,
          });
        }
        if (baseCommit) {
          markReflectCursorCompleted(this.deps.db, "weekly", this.deps.clock.now(), {
            targetDay: nextDay,
            commitHash: baseCommit,
            committed: false,
          });
        }
      }

      // 该日所有阶段已完成，切入下一天
      plan.completedDays.push(nextDay);
      state.currentDay = null;
      state.dayPartDone = 0;
      state.dayProcessedEvents = 0;
      state.dayTouchedPaths = [];
      this.saveState(state);
    }
  }

  private async settleActiveStep(
    state: McpReplayState,
    summaryInput: unknown,
  ): Promise<void> {
    const step = state.activeStep!;
    const memoryDir = path.join(this.deps.dataDir, "memory");
    const uniquePaths = Array.from(new Set(step.touchedPaths.map((t) => t.path)));
    const existingPaths: string[] = [];
    for (const rel of uniquePaths) {
      try {
        await fs.access(path.join(memoryDir, rel));
        existingPaths.push(rel);
      } catch {
        // 忽略不存在的路径
      }
    }

    const safeSummary =
      sanitizeCommitPart(summaryInput, 60) ||
      (existingPaths.length > 0 ? `update ${existingPaths.slice(0, 3).join(", ")}` : "无新增记忆");

    const commitTag =
      step.phase === "reflect_weekly" ? `import-reflect-${step.day}` : `import-${step.day}`;
    const committed =
      existingPaths.length > 0
        ? await commitMemoryPaths(
            this.deps.dataDir,
            existingPaths,
            `memory(${commitTag}): ${safeSummary}`,
          )
        : false;

    for (const p of existingPaths) {
      if (!state.dayTouchedPaths.includes(p)) {
        state.dayTouchedPaths.push(p);
      }
    }

    if (step.phase === "wrapup") {
      if (step.endEventId) {
        this.deps.events.setCursor("daily_wrapup", step.endEventId);
      }
      state.dayPartDone += 1;
      state.dayProcessedEvents += step.eventCount ?? 0;
    } else if (step.phase === "bedtime") {
      const lastId =
        step.dayLastEventId ?? this.deps.events.getCursor("daily_wrapup") ?? "";
      // 此处刻意取 max(..., clock.now()) 而非历史虚拟时间：
      // 回家后内部 bedtime 通过 Math.min(getBedtimeLastRunAt, localDateStartMs(today)) 扫描今日新卡，
      // 若落历史时间戳会导致回家首晚把数月前的搬家卡全部误捞进今日摘要与体检雷达。
      const lastRunAt = Math.max(step.dayLastEventCreatedAt ?? 0, this.deps.clock.now());
      this.deps.events.setCursor("bedtime", lastId, {
        last_gist_date: step.day,
        last_run_at: lastRunAt,
      });
      const headCommit = await getMemoryHeadCommit(this.deps.dataDir);
      markReflectCursorCompleted(this.deps.db, "daily", this.deps.clock.now(), {
        targetDay: step.day,
        commitHash: headCommit,
        committed,
      });
      await this.syncReplayStateFile(step.day, {
        processedEvents: state.dayProcessedEvents,
        touchedMemoryPaths: state.dayTouchedPaths,
        summary: safeSummary,
      });
    } else if (step.phase === "reflect_weekly") {
      const headCommit = await getMemoryHeadCommit(this.deps.dataDir);
      markReflectCursorCompleted(this.deps.db, "weekly", this.deps.clock.now(), {
        targetDay: step.day,
        commitHash: headCommit,
        committed,
      });
      await this.syncReplayStateFile(step.day, {
        processedEvents: state.dayProcessedEvents,
        touchedMemoryPaths: state.dayTouchedPaths,
      });
    }

    state.activeStep = null;
    state.totalStepsCompleted += 1;
    this.saveState(state);
  }

  /** 执行 memory_replay 工具调用（status / start / next / abort） */
  async execute(
    args: Record<string, unknown>,
    opts: { protectCoreFiles: boolean },
  ): Promise<McpReplayExecResult> {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (
      action !== "status" &&
      action !== "start" &&
      action !== "next" &&
      action !== "abort"
    ) {
      return {
        ok: false,
        output: `memory_replay 缺少或无效的 action（须为 status | start | next | abort），收到: ${String(args.action ?? "")}`,
      };
    }

    if (action === "status") {
      const { allEvents, groups } = this.buildLogicalDays();
      const pendingDays = this.computePendingDays(groups);
      const state = this.loadState();
      const wrapupCursor = this.deps.events.getCursor("daily_wrapup") ?? "";
      const remainingEvents = allEvents.filter((e) => e.id > wrapupCursor);
      const remainingChars = remainingEvents.reduce((s, e) => s + e.content.length, 0);
      const bedtimeDate = this.deps.events.getBedtimeNightDate();
      const firstDay = groups[0]?.day ?? "无";
      const lastDay = groups[groups.length - 1]?.day ?? "无";

      const lines = [
        `status: ${state.activeStep ? "in_step" : state.plan ? "planned" : "idle"}`,
        `已导入对话总计：${allEvents.length} 条（${groups.length} 个逻辑日，范围 ${firstDay} .. ${lastDay}）`,
        `已日结至：${bedtimeDate ?? "尚未开始"} | daily_wrapup 游标：${wrapupCursor || "空"}`,
        `剩余待整理：${pendingDays.length} 天 / ${remainingEvents.length} 条消息（约 ${remainingChars} 字）`,
      ];
      if (pendingDays.length > 0) {
        lines.push(`待整理首尾日：${pendingDays[0]!.day} .. ${pendingDays[pendingDays.length - 1]!.day}`);
      }
      if (state.plan) {
        lines.push(
          `当前计划：目标 ${state.plan.targetDays.length} 天（已完成 ${state.plan.completedDays.length} 天，低量顺延 ${state.plan.deferredDays.length} 天）`,
        );
      }
      if (state.activeStep) {
        lines.push(
          `当前在途步骤：step_id=${state.activeStep.stepId} | day=${state.activeStep.day} | phase=${state.activeStep.phase} | 已写入 ${state.activeStep.touchedPaths.length} 个文件`,
        );
      }
      return { ok: true, output: lines.join("\n") };
    }

    // 所有写状态操作（start / next / abort）整体进入单层 gitMutex，与 memory_write/edit 严格串行，杜绝并发重复结算与重入死锁
    return this.deps.gitMutex.runExclusive(async () => {
      const { groups, byDay } = this.buildLogicalDays();
      const pendingDays = this.computePendingDays(groups);
      const state = this.loadState();

      if (action === "abort") {
        const doRollback = args.rollback === true;
        const cancelPlan = args.cancel_plan !== false;
        if (!state.activeStep && !state.plan) {
          return { ok: true, output: "status: idle\n当前没有在途步骤或搬家计划可中止。" };
        }

        const abortedStep = state.activeStep;
        let rollbackNote = "";
        if (abortedStep && doRollback && abortedStep.touchedPaths.length > 0) {
          const rb = await rollbackMemoryTouchedPaths(
            this.deps.dataDir,
            abortedStep.touchedPaths,
            abortedStep.baseCommit,
          );
          await this.deps.memoryIndex.reindexAll();
          const parts: string[] = [];
          if (rb.deleted.length > 0) parts.push(`删除新建 ${rb.deleted.length} 个`);
          if (rb.restored.length > 0) parts.push(`还原旧卡 ${rb.restored.length} 个`);
          rollbackNote = `\n回滚结果：${parts.join("，") || "无文件变更"}，并已同步重建索引。`;
          if (rb.skipped.length > 0) {
            rollbackNote += `\n[警告] 以下旧文件因仓库尚无基准提交（baseCommit 为空）无法自动还原，请手动核对：${rb.skipped.join(", ")}`;
          }
        }

        state.activeStep = null;
        if (cancelPlan) {
          state.plan = null;
          state.currentDay = null;
          state.dayPartDone = 0;
          state.dayProcessedEvents = 0;
          state.dayTouchedPaths = [];
        }
        this.saveState(state);

        return {
          ok: true,
          output:
            `status: aborted\n` +
            `已中止当前步骤（${abortedStep ? `${abortedStep.stepId} / ${abortedStep.day}` : "无"}），所有未结算游标保持不变。` +
            rollbackNote +
            (cancelPlan
              ? "\n已清除当前计划；下次可通过 action=\"start\" 重新开启。"
              : "\n当前计划仍保留，可调用 action=\"next\" 重试本步。"),
        };
      }

      if (action === "start") {
        // 防跳步保护：若仍有未提交的在途步骤，直接原样续接，绝不重置或跳过
        if (state.activeStep) {
          return this.renderActiveStep(state, {
            protectCoreFiles: opts.protectCoreFiles,
            resumed: true,
          });
        }

        if (pendingDays.length === 0) {
          return {
            ok: true,
            output: `status: finished\n当前没有剩余待整理的历史日期（已导入 ${groups.length} 个逻辑日均已结算）。`,
          };
        }

        const maxChars = clampInt(args.max_chars, MIN_MAX_CHARS, MAX_MAX_CHARS, DEFAULT_MAX_CHARS);
        const minChars = clampInt(args.min_chars, 0, MAX_MIN_CHARS, DEFAULT_MIN_CHARS);
        const compactRules = args.compact_rules === true;
        const runAll = args.all === true;
        const untilRaw = typeof args.until === "string" ? args.until.trim() : "";
        if (untilRaw && !/^\d{4}-\d{2}-\d{2}$/.test(untilRaw)) {
          return { ok: false, output: `until 格式须为 YYYY-MM-DD，收到: ${untilRaw}` };
        }

        let selected = pendingDays;
        if (untilRaw) {
          selected = selected.filter((g) => g.day <= untilRaw);
        } else if (!runAll) {
          const daysCount = clampInt(args.days, 1, MAX_DAYS_PER_PLAN, 1);
          selected = selected.slice(0, daysCount);
        }

        if (selected.length === 0) {
          return {
            ok: true,
            output: `status: finished\n在指定条件（until=${untilRaw || "无"}）下没有待整理的日期。`,
          };
        }

        state.plan = {
          targetDays: selected.map((g) => g.day),
          completedDays: [],
          deferredDays: [],
          maxChars,
          minChars,
          compactRules,
          untilDay: untilRaw || null,
          createdAtMs: this.deps.clock.now(),
        };
        state.currentDay = null;
        state.dayPartDone = 0;
        state.dayProcessedEvents = 0;
        state.dayTouchedPaths = [];
        this.saveState(state);

        // start 首步始终下发完整规则，后续 next 按 compact_rules 生效
        return this.advanceToNextStep(state, byDay, groups, {
          protectCoreFiles: opts.protectCoreFiles,
          compactRules: false,
        });
      }

      // action === "next"
      const nextCompactRules =
        typeof args.compact_rules === "boolean"
          ? args.compact_rules
          : Boolean(state.plan?.compactRules);

      if (state.activeStep) {
        const providedStepId = typeof args.step_id === "string" ? args.step_id.trim() : "";
        if (!providedStepId || providedStepId !== state.activeStep.stepId) {
          // 新窗口或未携带匹配 step_id 时绝不跳过当前步，且强制下发完整规则
          return this.renderActiveStep(state, {
            protectCoreFiles: opts.protectCoreFiles,
            resumed: true,
            compactRules: false,
          });
        }

        await this.settleActiveStep(state, args.summary);
        return this.advanceToNextStep(state, byDay, groups, {
          protectCoreFiles: opts.protectCoreFiles,
          compactRules: nextCompactRules,
        });
      }

      if (state.plan) {
        return this.advanceToNextStep(state, byDay, groups, {
          protectCoreFiles: opts.protectCoreFiles,
          compactRules: nextCompactRules,
        });
      }

      return {
        ok: true,
        output:
          `status: idle\n当前没有进行中的搬家步骤或计划（全库尚余 ${pendingDays.length} 天待整理）。` +
          (pendingDays.length > 0
            ? `\n请先调用 memory_replay(action="start", days=3) 开启任务。`
            : ""),
      };
    });
  }
}
