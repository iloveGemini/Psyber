import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";
import { localDateStartMs, localDateTime, localDay, weekdayOfDay } from "../core/clock.ts";
import type { PsyberConfig } from "../core/config.ts";
import { commitMemoryPaths } from "../core/git.ts";
import { readPrompt, stripFrontmatter } from "../core/prompts.ts";
import type {
  ChatMessage,
  ChatModelClient,
  ChatStopReason,
  ChatToolCall,
} from "../llm/client.ts";
import { resolveEffectiveThinkingLevel } from "../llm/router.ts";
import { readIdentityProfile } from "../memory/genesis.ts";
import {
  DEFAULT_GIST_CHAR_BUDGET,
  GIST_SOFT_WARN_RATIO,
  selectActiveGistLayers,
} from "../memory/gist.ts";
import type { MemoryIndex } from "../memory/index.ts";
import {
  isAllowedWritePath,
  normalizeRelPath,
  type MemoryTools,
} from "../memory/tools.ts";
import type { EventStore } from "../store/events.ts";
import { MEMORY_5_TOOL_DEFINITIONS } from "../tools/core_tools.ts";

export type TidyTaskType = "daily_wrapup" | "bedtime";

export interface TidyTaskDeps {
  db: Database;
  dataDir: string;
  promptsDir: string;
  clock: Clock;
  events: EventStore;
  memoryIndex: MemoryIndex;
  memoryTools: MemoryTools;
  chatModel: ChatModelClient;
  getConfig?: () => PsyberConfig;
}

export interface TidyTaskOutcome {
  ok: boolean;
  taskType: TidyTaskType;
  processedEvents: number;
  touchedMemoryPaths: string[];
  committed: boolean;
  summary: string;
  /** 本次整理已消化到的最高 event.id（供 bedtime 换段校验期间是否产生未消化新对话） */
  lastProcessedEventId: string | null;
  error?: string;
}

const TASK_BUDGET_CHARS = 10_000;
const MAX_TIDY_STEPS = 12;

const TASK_SPECIFIC_BLOCKS: Record<TidyTaskType, string> = {
  daily_wrapup:
    "我整理游标后的近期对话：在 episodes/YYYY/MM/DD/ep-<slug>.md 记录值得留存的情景切片（一事一卡、500–800 字内；已收进 threads/、favorite/、entities/ 的只留一句钩子 + 链接），若有值得留痕的心路或观念变化，在同目录写 rf-<slug>.md 并按作用范围把成果分流到 core/、threads/、lessons/ 或 core/open.md；若聊天中出现新的短期状态或恢复/变更，同步更新 core/state.md（带 [至 YYYY-MM-DD] 到期日与出处链接）；若明说相处边界、承诺或重要原话，按需更新 core/boundaries.md、core/open.md 或 favorite/；若识别出反复出现的跨天内容线或实体，对照 threads/REGISTRY.yaml 与 entities/REGISTRY.yaml 归档或注册。本轮不写 index.md 梗概。",
  bedtime:
    "我回顾今日已整理的卡片摘要、剩余未整理片段与现行 core/ 文件：① 按 <tidy_context> 指定路径直接 write 今日日梗概 episodes/YYYY/MM/DD/index.md（150–250 字，上限 300 字，只留主题脉络、情绪/关系变化与挂念）；参照 <tidy_context> 中的时间梗概水位，由我自己判断是否需要把较早的日梗概滚入 episodes/YYYY/MM/index.md（≤ 600 字，frontmatter 必填 covered_until: YYYY-MM-DD），或把较早的月梗概滚入 episodes/YYYY/index.md（≤ 1000 字，frontmatter 必填 covered_until: YYYY-MM）；水位接近或达到软提醒线（80%）时优先收拢腾出空间，充裕时想保留最近几天的日梗概可直接留着不滚；② 对照 core/state.md 清理已恢复或 [至 YYYY-MM-DD] 已过期的条目，并清理 core/open.md 中已闭环或久无下文的线索；③ 若今日反思（rf-*.md）或跨天反馈已经沉淀出清晰成果，克制地分流：全局结论局部 edit 到 core/boundaries.md、core/mirror.md（单条 ≤ 80 字 + 挂 rf- 链接）、core/self.md（定名/自定代词同步改 name/pronoun）或 core/user.md（更新称呼同步改 name，对方代词已在初始化时写好无需修改），有场景限制的写进对应 threads/、entities/ 或 lessons/（必填 when_to_recall）；④ 兜底补记值得逐字保留的原话到 favorite/。",
};

async function readOptional(absPath: string): Promise<string | null> {
  try {
    const t = await fs.readFile(absPath, "utf8");
    return t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

function parseAttachmentCount(metadataJson: string | null): number {
  if (!metadataJson) return 0;
  try {
    const parsed = JSON.parse(metadataJson) as { attachments?: unknown };
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}

function clipExcerpt(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(20, maxChars - 1))}…`;
}

function tailSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…（前文略）\n${text.slice(text.length - maxChars)}`;
}

function episodeDirForDay(dayStr: string): string {
  const [y, m, d] = dayStr.split("-");
  return `episodes/${y}/${m}/${d}`;
}

interface GistWatermarkInfo {
  totalChars: number;
  budgetChars: number;
  softWarnChars: number;
  nearLimit: boolean;
}

function buildTidyContextBlock(opts: {
  taskType: TidyTaskType;
  targetDay: string;
  gistWatermark?: GistWatermarkInfo;
}): string {
  const weekday = weekdayOfDay(opts.targetDay);
  const dayDir = episodeDirForDay(opts.targetDay);
  const lines = [
    "<tidy_context>",
    `当前日期：${opts.targetDay}（${weekday}）`,
    `任务类型：${opts.taskType}`,
    `今日情景目录：${dayDir}/（切片 ep-<slug>.md，反思 rf-<slug>.md）`,
  ];
  if (opts.taskType === "bedtime") {
    lines.push(`日梗概目标：${dayDir}/index.md（单日 150–250 字，上限 300 字）`);
    if (opts.gistWatermark) {
      const { totalChars, budgetChars, softWarnChars, nearLimit } = opts.gistWatermark;
      const pct = Math.round((totalChars / budgetChars) * 100);
      if (nearLimit) {
        lines.push(
          `时间梗概水位：${totalChars} / ${budgetChars} 字（已达 ${pct}%，超过 ${softWarnChars} 字软水位；建议将较早的日梗概滚入 episodes/YYYY/MM/index.md 或将较早的月梗概滚入 episodes/YYYY/index.md，并在 frontmatter 标明 covered_until）`,
        );
      } else {
        lines.push(
          `时间梗概水位：${totalChars} / ${budgetChars} 字（${pct}%，水位充裕；可按需自主决定是否将较早的日/月梗概向上滚动合并并标明 covered_until）`,
        );
      }
    }
  }
  lines.push("</tidy_context>");
  return lines.join("\n");
}

function parseOptionalSummary(text: string, touched: string[]): string {
  const match = /\{[\s\S]*"summary"\s*:\s*"([^"]+)"[\s\S]*\}/.exec(text);
  if (match && match[1].trim()) {
    return match[1].trim().slice(0, 60);
  }
  return touched.length > 0 ? `update ${touched.join(", ")}` : "无新增记忆";
}

interface RawEventRow {
  id: string;
  seq: number;
  turn_id: string | null;
  status: string;
  role: string;
  kind: string;
  content: string;
  metadata: string | null;
  created_at: number;
}

function getBedtimeLastRunAt(db: Database, nowMs: number, timeZone: string): number {
  const row = db
    .query("SELECT meta_json FROM task_cursors WHERE task_key = 'bedtime'")
    .get() as { meta_json: string | null } | null;
  if (row?.meta_json) {
    try {
      const parsed = JSON.parse(row.meta_json) as { last_run_at?: number };
      if (typeof parsed.last_run_at === "number" && Number.isFinite(parsed.last_run_at)) {
        return parsed.last_run_at;
      }
    } catch {
      // 忽略损坏的 meta_json
    }
  }
  return localDateStartMs(localDay(nowMs, timeZone), timeZone);
}

/** 读取现行 core/ 四份常驻文件供整理轮防重与状态对账（采用尾部保留防最新条目被截断） */
async function buildCoreSummaryMaterial(memoryDir: string): Promise<string | null> {
  const coreFiles = [
    "core/state.md",
    "core/boundaries.md",
    "core/open.md",
    "core/mirror.md",
  ] as const;
  const parts: string[] = [];
  for (const rel of coreFiles) {
    const raw = await readOptional(path.join(memoryDir, rel));
    if (!raw) continue;
    const body = stripFrontmatter(raw).trim();
    if (!body) continue;
    parts.push(`## ${rel}\n${tailSlice(body, 1500)}`);
  }
  if (parts.length === 0) return null;
  return `# 现行 core/ 常驻记录（防重复写入与状态对账）\n${parts.join("\n\n")}`;
}

/** 执行单批整理写作轮（内部复用，严格校验沙箱路径后再记录内存回滚备份） */
async function executeSingleTidyPass(
  deps: TidyTaskDeps,
  opts: {
    taskType: TidyTaskType;
    batch: RawEventRow[];
    extraMaterials?: string[];
    nightDate?: string;
    gistWatermark?: GistWatermarkInfo;
    signal?: AbortSignal;
  },
): Promise<TidyTaskOutcome> {
  const { dataDir, promptsDir, clock, events, memoryIndex, memoryTools, chatModel } = deps;
  const memoryDir = path.join(dataDir, "memory");
  const cursorId = events.getCursor("daily_wrapup") ?? "";

  const [selfMd, userMd, tidyPrompt, threadReg, entReg, coreMaterial, identity] = await Promise.all([
    readOptional(path.join(memoryDir, "core", "self.md")),
    readOptional(path.join(memoryDir, "core", "user.md")),
    readPrompt(promptsDir, "tidy.md", {
      TASK_SPECIFIC_BLOCK: TASK_SPECIFIC_BLOCKS[opts.taskType],
    }),
    readOptional(path.join(memoryDir, "threads", "REGISTRY.yaml")),
    readOptional(path.join(memoryDir, "entities", "REGISTRY.yaml")),
    buildCoreSummaryMaterial(memoryDir),
    readIdentityProfile(dataDir, clock.now(), clock.timeZone),
  ]);
  const userLabel = identity.userName ?? identity.userPronoun ?? "TA";

  const sysSections: string[] = [];
  if (selfMd) sysSections.push(`<self>\n${selfMd}\n</self>`);
  if (userMd) sysSections.push(`<user>\n${userMd}\n</user>`);
  sysSections.push(tidyPrompt.body);
  const systemPrompt = sysSections.join("\n\n");

  const targetDay = opts.nightDate ?? localDay(clock.now(), clock.timeZone);
  const transcriptLines = opts.batch.map((e) => {
    const stamp = `[${localDateTime(e.created_at, clock.timeZone)}]`;
    const attCount = parseAttachmentCount(e.metadata);
    const attSuffix = attCount > 0 ? ` [附带了 ${attCount} 张图片]` : "";
    if (e.status === "retracted") {
      if (e.role === "user") {
        return `${stamp} ${userLabel}: （${userLabel}撤回了一条消息）`;
      }
      return `${stamp} 我: ${e.content}${attSuffix}（已撤回，${userLabel}看不到内容）`;
    }
    if (e.kind === "door_note") {
      return `${stamp} [${userLabel}从门缝塞进来的纸条 · 当时门处于关闭状态] ${e.content}${attSuffix}`;
    }
    return `${stamp} ${e.role === "user" ? userLabel : "我"}: ${e.content}${attSuffix}`;
  });

  const materialParts: string[] = [
    buildTidyContextBlock({
      taskType: opts.taskType,
      targetDay,
      gistWatermark: opts.gistWatermark,
    }),
    `# 待整理对话（共 ${opts.batch.length} 条）\n${transcriptLines.join("\n") || "（无新增对话，请完成睡前总结）"}`,
  ];
  if (opts.extraMaterials && opts.extraMaterials.length > 0) {
    materialParts.push(...opts.extraMaterials);
  }
  if (coreMaterial) materialParts.push(coreMaterial);
  if (threadReg) materialParts.push(`# threads/REGISTRY.yaml\n${threadReg}`);
  if (entReg) materialParts.push(`# entities/REGISTRY.yaml\n${entReg}`);

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

  const cfgForTidy = deps.getConfig?.();
  const effectiveThinkingLevel = cfgForTidy ? resolveEffectiveThinkingLevel(cfgForTidy) : undefined;
  const effectiveThinkingBudget = cfgForTidy?.llm?.thinking?.budgetTokens;

  let finalText = "";
  let failedReason: string | null = null;

  try {
    for (let step = 0; step < MAX_TIDY_STEPS; step++) {
      let stepText = "";
      let stepThinking = "";
      let stepThinkingSig: string | undefined;
      let stepStopReason: ChatStopReason | undefined;
      const stepToolCalls: ChatToolCall[] = [];

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
          failedReason = `${chunk.code}: ${chunk.message}`;
          break;
        }
        if (chunk.type === "thinking_delta") {
          if (chunk.delta.length > 0) stepThinking += chunk.delta;
          if (chunk.signature) stepThinkingSig = chunk.signature;
        } else if (chunk.type === "text_delta") {
          stepText += chunk.delta;
          finalText += chunk.delta;
        } else if (chunk.type === "tool_call") {
          stepToolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.args });
        } else if (chunk.type === "usage") {
          if (chunk.stopReason) stepStopReason = chunk.stopReason;
        }
      }

      if (failedReason) break;
      if (stepStopReason === "length") {
        failedReason =
          "OUTPUT_TRUNCATED: 模型输出达到上限（length）被截断，已回滚本次整理且未推进游标（可调大该模型的 maxTokens）";
        break;
      }
      if (
        stepToolCalls.length === 0 &&
        stepText.trim().length === 0 &&
        stepThinking.trim().length > 0
      ) {
        failedReason =
          "EMPTY_OUTPUT: 模型仅输出思考过程、未产出正文或工具调用，已回滚本次整理且未推进游标";
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
      taskType: opts.taskType,
      processedEvents: 0,
      touchedMemoryPaths: [],
      committed: false,
      summary: "",
      lastProcessedEventId: cursorId || null,
      error: failedReason,
    };
  }

  const touchedList = Array.from(touched);
  const summary = parseOptionalSummary(finalText, touchedList);
  const committed =
    touchedList.length > 0
      ? await commitMemoryPaths(dataDir, touchedList, `memory(${opts.taskType}): ${summary}`)
      : false;

  const lastProcessedId = opts.batch.length > 0 ? opts.batch[opts.batch.length - 1].id : cursorId;
  if (opts.batch.length > 0) {
    events.setCursor("daily_wrapup", lastProcessedId);
  }
  if (opts.taskType === "bedtime") {
    events.setCursor("bedtime", lastProcessedId, {
      last_gist_date: opts.nightDate ?? null,
      last_run_at: clock.now(),
    });
  }

  return {
    ok: true,
    taskType: opts.taskType,
    processedEvents: opts.batch.length,
    touchedMemoryPaths: touchedList,
    committed,
    summary,
    lastProcessedEventId: lastProcessedId || null,
  };
}

function queryNextPendingBatch(
  db: Database,
  cursorId: string,
  maxSeq?: number | null,
): RawEventRow[] {
  const allPending = (
    typeof maxSeq === "number" && Number.isFinite(maxSeq)
      ? db
          .query(
            `SELECT id, seq, turn_id, status, role, kind, content, metadata, created_at
             FROM events
             WHERE status IN ('active', 'retracted')
               AND role IN ('user', 'assistant')
               AND kind IN ('chat', 'wake', 'door_note')
               AND id > ?
               AND seq <= ?
             ORDER BY seq ASC`,
          )
          .all(cursorId, maxSeq)
      : db
          .query(
            `SELECT id, seq, turn_id, status, role, kind, content, metadata, created_at
             FROM events
             WHERE status IN ('active', 'retracted')
               AND role IN ('user', 'assistant')
               AND kind IN ('chat', 'wake', 'door_note')
               AND id > ?
             ORDER BY seq ASC`,
          )
          .all(cursorId)
  ) as RawEventRow[];

  const batch: RawEventRow[] = [];
  let chars = 0;
  for (let i = 0; i < allPending.length; i++) {
    const ev = allPending[i];
    const nextChars = chars + ev.content.length;
    if (batch.length > 0 && nextChars > TASK_BUDGET_CHARS && ev.turn_id !== batch[batch.length - 1].turn_id) {
      break;
    }
    batch.push(ev);
    chars = nextChars;
  }
  return batch;
}

/**
 * Ring 1 单队列单轮记忆整理任务（daily_wrapup / bedtime）：
 * - daily_wrapup：按 10_000 字循环切批排空（可选 maxSeq 截断）
 * - bedtime：先循环排空剩余未整理对话，再写当日 episodes/YYYY/MM/DD/index.md；
 *   并报告当前激活态梗概水位（共享 8000 字预算、80% 软提醒），由 AI 自主决定是否向上滚动并更新 covered_until。
 */
export async function runMemoryTidyTask(
  deps: TidyTaskDeps,
  opts: { taskType: TidyTaskType; nightDate?: string; maxSeq?: number | null; signal?: AbortSignal },
): Promise<TidyTaskOutcome> {
  if (opts.taskType === "daily_wrapup") {
    let totalDrained = 0;
    const allTouched = new Set<string>();
    let anyCommitted = false;
    let lastSummary = "无新增记忆";
    let lastProcessedEventId = deps.events.getCursor("daily_wrapup");

    while (true) {
      const cursorId = deps.events.getCursor("daily_wrapup") ?? "";
      const batch = queryNextPendingBatch(deps.db, cursorId, opts.maxSeq);
      if (batch.length === 0) break;
      const passRes = await executeSingleTidyPass(deps, {
        taskType: "daily_wrapup",
        batch,
        nightDate: opts.nightDate,
        signal: opts.signal,
      });
      if (!passRes.ok) {
        return {
          ...passRes,
          processedEvents: totalDrained,
          touchedMemoryPaths: Array.from(allTouched),
          committed: anyCommitted,
          lastProcessedEventId,
        };
      }
      totalDrained += passRes.processedEvents;
      for (const p of passRes.touchedMemoryPaths) allTouched.add(p);
      if (passRes.committed) anyCommitted = true;
      lastSummary = passRes.summary;
      lastProcessedEventId = passRes.lastProcessedEventId ?? lastProcessedEventId;
    }

    return {
      ok: true,
      taskType: "daily_wrapup",
      processedEvents: totalDrained,
      touchedMemoryPaths: Array.from(allTouched),
      committed: anyCommitted,
      summary: lastSummary,
      lastProcessedEventId,
    };
  }

  // bedtime：步骤 1 —— 循环排空游标后剩余未整理对话
  let totalDrained = 0;
  const allTouched = new Set<string>();
  let anyCommitted = false;

  while (true) {
    const cursorId = deps.events.getCursor("daily_wrapup") ?? "";
    const batch = queryNextPendingBatch(deps.db, cursorId, opts.maxSeq);
    if (batch.length === 0) break;
    const drainRes = await executeSingleTidyPass(deps, {
      taskType: "daily_wrapup",
      batch,
      nightDate: opts.nightDate,
      signal: opts.signal,
    });
    if (!drainRes.ok) {
      return {
        ...drainRes,
        taskType: "bedtime",
      };
    }
    totalDrained += drainRes.processedEvents;
    for (const p of drainRes.touchedMemoryPaths) allTouched.add(p);
    if (drainRes.committed) anyCommitted = true;
  }

  // bedtime：步骤 2 —— 注入今日已整理卡片摘要 + 当前激活态梗概水位与未滚清单
  const nowMs = deps.clock.now();
  const tz = deps.clock.timeZone;
  const targetDay = opts.nightDate ?? localDay(nowMs, tz);
  const memoryDir = path.join(deps.dataDir, "memory");
  const sinceMs = Math.min(
    getBedtimeLastRunAt(deps.db, nowMs, tz),
    localDateStartMs(targetDay, tz),
  );
  const extraMaterials: string[] = [];

  const recentCards = deps.memoryIndex
    .listAllRows()
    .filter(
      (r) =>
        (r.updated_at >= sinceMs || allTouched.has(r.path)) &&
        (r.space === "episodes" ||
          r.space.startsWith("thread:") ||
          r.space === "lessons" ||
          r.space === "favorite"),
    );
  if (recentCards.length > 0) {
    const cardLines: string[] = [];
    let excerptBudget = 2400;
    for (const c of recentCards) {
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
    extraMaterials.push(`# 今日已整理卡片摘要（共 ${recentCards.length} 张）\n${cardLines.join("\n")}`);
  }

  const layers = await selectActiveGistLayers(memoryDir, targetDay);
  const softWarnChars = Math.floor(DEFAULT_GIST_CHAR_BUDGET * GIST_SOFT_WARN_RATIO);
  const gistWatermark: GistWatermarkInfo = {
    totalChars: layers.totalChars,
    budgetChars: DEFAULT_GIST_CHAR_BUDGET,
    softWarnChars,
    nearLimit: layers.totalChars >= softWarnChars,
  };

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
    if (gistWatermark.nearLimit) {
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
      extraMaterials.push(
        `# 当前未滚动的时间梗概清单（已达软水位，供向上合并参考）\n${statusLines.join("\n")}\n\n${tailSlice(rollupSnippets.join("\n\n"), 4000)}`,
      );
    } else {
      extraMaterials.push(`# 当前未滚动的时间梗概清单\n${statusLines.join("\n")}`);
    }
  }

  const bedtimeRes = await executeSingleTidyPass(deps, {
    taskType: "bedtime",
    batch: [],
    extraMaterials,
    nightDate: targetDay,
    gistWatermark,
    signal: opts.signal,
  });

  if (!bedtimeRes.ok) return bedtimeRes;
  for (const p of bedtimeRes.touchedMemoryPaths) allTouched.add(p);

  return {
    ...bedtimeRes,
    processedEvents: totalDrained,
    touchedMemoryPaths: Array.from(allTouched),
    committed: anyCommitted || bedtimeRes.committed,
  };
}
