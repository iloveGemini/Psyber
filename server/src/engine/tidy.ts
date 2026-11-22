import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";
import { localDateStartMs, localDateTime, localDay, weekdayOfDay } from "../core/clock.ts";
import { commitMemoryPaths } from "../core/git.ts";
import { readPrompt, stripFrontmatter } from "../core/prompts.ts";
import type { ChatMessage, ChatModelClient, ChatToolCall } from "../llm/client.ts";
import { readIdentityProfile } from "../memory/genesis.ts";
import { weekOf } from "../memory/gist.ts";
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
    "我整理游标后的近期对话：在 daily/YYYY-MM-DD-<slug>.md 记录值得留存的事件切片（kind: episode）或短期状态（kind: state，必填 tags 与 ttl_days），完成旧 state 卡的 resolved/disputed 对账；若聊天中明说了新的规矩、承诺或重要原话，按需同步到 shelf/rules.md、shelf/threads.md 或 favorite/；若识别出反复出现的隐式互动或值得收录的实体，对照 activities/REGISTRY.yaml 与 entities/REGISTRY.yaml 的双次/收录规则归档或注册。本轮不写 gist/ 梗概。",
  bedtime:
    "我回顾今日已整理的卡片摘要、剩余未整理片段与现行书架：① 按 <tidy_context> 指定的路径与 ### YYYY-MM-DD 节标题，在 gist/days/YYYY-MM.md 追加今日梗概（≲ 300 字，只留会影响后续的脉络与挂念；若 <tidy_context> 标明今日为周日，写完今日梗概后同步汇总本周日梗概到 gist/weeks/YYYY.md 的 ### YYYY-Www 节，≲ 500 字）；② 若对话中明说了新的规矩、边界或承诺，局部 edit 到 shelf/rules.md 或 shelf/threads.md（已闭环的线索及时清理）；③ 若经过足够清晰的互动反馈，对我自己的做法或 user.md 里的朋友有了值得沉淀的新认识，克制地 edit 到 shelf/mirror.md、self.md 或 user.md（不与 shelf/rules.md 重复抄写；定名、自定代词或更新称呼/代词时同步更新 frontmatter 的 name / pronoun）；④ 兜底补记值得逐字保留的原话到 favorite/，或按双次规则归档实体到 entities/。",
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

function buildTidyContextBlock(opts: {
  taskType: TidyTaskType;
  targetDay: string;
}): string {
  const weekday = weekdayOfDay(opts.targetDay);
  const isoWeek = weekOf(opts.targetDay);
  const monthKey = opts.targetDay.slice(0, 7);
  const weekYear = isoWeek.slice(0, 4);
  const lines = [
    "<tidy_context>",
    `当前日期：${opts.targetDay}（${weekday} · ISO周 ${isoWeek}）`,
    `任务类型：${opts.taskType}`,
  ];
  if (opts.taskType === "bedtime") {
    lines.push(`日梗概目标：gist/days/${monthKey}.md（节标题 ### ${opts.targetDay}，单日 ≲ 300 字）`);
    if (weekday === "周日") {
      lines.push(
        `周梗概目标：gist/weeks/${weekYear}.md（节标题 ### ${isoWeek}，单周 ≲ 500 字；今日为周日，写完今日日梗概后同步汇总本周）`,
      );
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

/** 执行单批整理写作轮（内部复用，严格校验沙箱路径后再记录内存回滚备份） */
async function executeSingleTidyPass(
  deps: TidyTaskDeps,
  opts: {
    taskType: TidyTaskType;
    batch: RawEventRow[];
    extraMaterials?: string[];
    nightDate?: string;
    signal?: AbortSignal;
  },
): Promise<TidyTaskOutcome> {
  const { dataDir, promptsDir, clock, events, memoryIndex, memoryTools, chatModel } = deps;
  const memoryDir = path.join(dataDir, "memory");
  const cursorId = events.getCursor("daily_wrapup") ?? "";

  const [selfMd, userMd, tidyPrompt, actReg, entReg, identity] = await Promise.all([
    readOptional(path.join(memoryDir, "self.md")),
    readOptional(path.join(memoryDir, "user.md")),
    readPrompt(promptsDir, "tidy.md", {
      TASK_SPECIFIC_BLOCK: TASK_SPECIFIC_BLOCKS[opts.taskType],
    }),
    readOptional(path.join(memoryDir, "activities/REGISTRY.yaml")),
    readOptional(path.join(memoryDir, "entities/REGISTRY.yaml")),
    readIdentityProfile(dataDir, clock.now(), clock.timeZone),
  ]);
  const userLabel = identity.userName ?? identity.userPronoun ?? "TA";

  const sysSections: string[] = [];
  if (selfMd) sysSections.push(`<self>\n${selfMd}\n</self>`);
  if (userMd) sysSections.push(`<user>\n${userMd}\n</user>`);
  sysSections.push(tidyPrompt.body);
  const systemPrompt = sysSections.join("\n\n");

  const openStates = memoryIndex
    .listAllRows()
    .filter((r) => r.space === "daily" && r.kind === "state" && r.status === "active");

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
    buildTidyContextBlock({ taskType: opts.taskType, targetDay }),
    `# 待整理对话（共 ${opts.batch.length} 条）\n${transcriptLines.join("\n") || "（无新增对话，请完成睡前总结）"}`,
  ];
  if (opts.extraMaterials && opts.extraMaterials.length > 0) {
    materialParts.push(...opts.extraMaterials);
  }
  if (openStates.length > 0) {
    materialParts.push(
      `# 当前未关闭的短期状态清单\n${openStates.map((s) => `- ${s.path}（${s.title}）`).join("\n")}`,
    );
  }
  if (actReg) materialParts.push(`# activities/REGISTRY.yaml\n${actReg}`);
  if (entReg) materialParts.push(`# entities/REGISTRY.yaml\n${entReg}`);

  const messages: ChatMessage[] = [
    { role: "user", content: materialParts.join("\n\n"), timestamp: clock.now() },
  ];

  // MemoryTx 内存字节备份：仅允许记录通过 normalizeRelPath + isAllowedWritePath 校验的纯 memory/ 相对路径
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

  let finalText = "";
  let failedReason: string | null = null;

  try {
    for (let step = 0; step < MAX_TIDY_STEPS; step++) {
      let stepText = "";
      const stepToolCalls: ChatToolCall[] = [];

      for await (const chunk of chatModel.stream({
        systemPrompt,
        messages,
        tools: MEMORY_5_TOOL_DEFINITIONS,
        signal: opts.signal,
      })) {
        if (chunk.type === "error") {
          failedReason = `${chunk.code}: ${chunk.message}`;
          break;
        }
        if (chunk.type === "text_delta") {
          stepText += chunk.delta;
          finalText += chunk.delta;
        } else if (chunk.type === "tool_call") {
          stepToolCalls.push({ id: chunk.id, name: chunk.name, arguments: chunk.args });
        }
      }

      if (failedReason) break;
      if (stepToolCalls.length === 0) break;

      messages.push({
        role: "assistant",
        content: stepText,
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

  // 推进游标（绝不推进 door_notes_read）
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
 * - daily_wrapup：按 10_000 字循环切批排空（可选 maxSeq 截断，绝不提前吃掉排队新消息，绝不推进 door_notes_read）
 * - bedtime（对齐 Spec 02 §5.2）：先循环排空剩余未整理对话，再汇总上次 bedtime 以来新写/修改卡片与周日 gist/days 梗概
 * - 任何阶段模型报错均按内存安全备份完整回滚，绝不推进游标，绝不碰沙箱外路径
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

  // bedtime：步骤 2 & 3 —— 注入上次 bedtime 以来新写/修改的卡片摘要与节选、现行日梗概与书架摘要（防重复写）
  const nowMs = deps.clock.now();
  const tz = deps.clock.timeZone;
  const targetDay = opts.nightDate ?? localDay(nowMs, tz);
  const targetWeekday = weekdayOfDay(targetDay);
  const targetWeek = weekOf(targetDay);
  const monthKey = targetDay.slice(0, 7);
  const weekYear = targetWeek.slice(0, 4);
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
        (r.space === "daily" || r.space.startsWith("activity:") || r.space === "favorite"),
    );
  if (recentCards.length > 0) {
    const cardLines: string[] = [];
    let excerptBudget = 2400;
    for (const c of recentCards) {
      const header = `- ${c.path}（${c.kind} · ${c.status}）：${c.title}`;
      if (excerptBudget > 60) {
        const raw = await readOptional(path.join(deps.dataDir, "memory", c.path));
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

  const monthGist = await readOptional(
    path.join(deps.dataDir, "memory", "gist", "days", `${monthKey}.md`),
  );
  if (monthGist) {
    if (targetWeekday === "周日") {
      extraMaterials.push(
        `# 本月日梗概（gist/days/${monthKey}.md；今日周日，写完今日后汇总至 gist/weeks/${weekYear}.md 的 ### ${targetWeek}）\n${tailSlice(monthGist, 4000)}`,
      );
    } else {
      extraMaterials.push(
        `# 现行本月日梗概尾部（gist/days/${monthKey}.md，追加今日 ### ${targetDay} 时保持同格式）\n${tailSlice(monthGist, 2000)}`,
      );
    }
  }

  const shelfFiles = ["shelf/rules.md", "shelf/mirror.md", "shelf/threads.md"] as const;
  const shelfParts: string[] = [];
  let shelfBudget = 1500;
  for (const rel of shelfFiles) {
    if (shelfBudget <= 80) break;
    const raw = await readOptional(path.join(deps.dataDir, "memory", rel));
    if (!raw) continue;
    const body = stripFrontmatter(raw).trim();
    if (!body) continue;
    const snippet = body.length > Math.min(500, shelfBudget)
      ? `${body.slice(0, Math.min(500, shelfBudget))}…`
      : body;
    shelfBudget -= snippet.length;
    shelfParts.push(`## ${rel}\n${snippet}`);
  }
  if (shelfParts.length > 0) {
    extraMaterials.push(`# 现行书架摘要（防重复写入）\n${shelfParts.join("\n\n")}`);
  }

  const bedtimeRes = await executeSingleTidyPass(deps, {
    taskType: "bedtime",
    batch: [],
    extraMaterials,
    nightDate: targetDay,
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
