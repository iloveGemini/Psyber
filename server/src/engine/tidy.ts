import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";
import { localDateStartMs, localDateTime, localDay, weekdayOfDay } from "../core/clock.ts";
import { mergeRadarConfig, type PsyberConfig } from "../core/config.ts";
import type { EmbeddingClient } from "../core/embedding.ts";
import { commitMemoryPaths, getMemoryHeadCommit } from "../core/git.ts";
import { readPrompt, stripFrontmatter } from "../core/prompts.ts";
import { redactSecrets } from "../core/redact.ts";
import type {
  ChatMessage,
  ChatModelClient,
  ChatStopReason,
  ChatToolCall,
  ChatToolDefinition,
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
  renderMemoryRadarBlock,
  runMemoryRadar,
  type MemoryRadarResult,
} from "../memory/radar.ts";
import {
  isAllowedWritePath,
  normalizeRelPath,
  type MemoryTools,
} from "../memory/tools.ts";
import type { EventStore } from "../store/events.ts";
import { MEMORY_5_TOOL_DEFINITIONS } from "../tools/core_tools.ts";
import {
  REFLECT_SCOPE_BLOCKS,
  buildReflectContextBlock,
  evaluateReflectGate,
  markReflectCursorCompleted,
  type DecisionClient,
} from "./reflect.ts";

export type TidyTaskType = "daily_wrapup" | "bedtime";

export interface HotTidySessionContext {
  sessionId: string;
  /** 与活跃聊天会话逐字节一致的 Static Prefix（命中 Prompt Cache） */
  systemPrompt: string;
  /** 与活跃聊天会话一致的历史轮次消息 */
  historyMessages: ChatMessage[];
  /** 与活跃聊天会话一致的工具定义（命中 Prompt Cache；整理轮仅执行 5 个记忆工具） */
  tools: ChatToolDefinition[];
  /** 当前会话使用的 chat 模型客户端 */
  chatModel: ChatModelClient;
}

export interface TidyTaskDeps {
  db: Database;
  dataDir: string;
  promptsDir: string;
  clock: Clock;
  events: EventStore;
  memoryIndex: MemoryIndex;
  memoryTools: MemoryTools;
  chatModel: ChatModelClient;
  /** 可选决策客户端：bedtime 排空对话后用于只读体检雷达与日反思门控，通过时直接合并进本轮 bedtime */
  decisionClient?: DecisionClient;
  /** 可选向量客户端：供 bedtime 前置只读体检雷达按余弦相似度匹配历史旧卡（缺失时平滑降级 FTS5） */
  embedding?: EmbeddingClient;
  getConfig?: () => PsyberConfig;
  /** 单步瞬时错误（503/429/网络抖动）退避延迟毫秒数组，默认 [3000, 10000, 25000] */
  retryDelaysMs?: number[];
}

export interface TidyTaskOutcome {
  ok: boolean;
  taskType: TidyTaskType;
  /** 本次整理实际采用的模式（hot=会话尾部热写命中缓存；cold=独立冷写） */
  mode?: "hot" | "cold";
  /** 非强制整理期间用户发来新消息导致主动让路延后 */
  deferred?: boolean;
  processedEvents: number;
  touchedMemoryPaths: string[];
  committed: boolean;
  summary: string;
  /** 本次整理已消化到的最高 event.id（供 bedtime 换段校验期间是否产生未消化新对话） */
  lastProcessedEventId: string | null;
  /** bedtime 合并日反思门控与执行结果（仅传入 decisionClient 时填充） */
  dailyReflect?: {
    triggered: boolean;
    skipReason?: string;
    decisionScores?: Record<string, number>;
  };
  /** bedtime 前置只读体检雷达执行摘要（仅传入 decisionClient 且存在今日卡片时填充） */
  radar?: {
    executed: boolean;
    boardItemsChecked: number;
    pairsEvaluated: number;
    findingsCount: number;
  };
  error?: string;
}

const COLD_TIDY_ROLLOVER_RATIO = 0.75;
const COLD_TIDY_TRANSCRIPT_SHARE = 0.6;
const MIN_COLD_TIDY_BUDGET_CHARS = 4_000;
const MAX_TIDY_STEPS = 20;
const DEFAULT_TIDY_RETRY_DELAYS_MS = [3_000, 10_000, 25_000];

/**
 * 根据模型上下文窗口与用户配置的 llm.contextLimits.chat 计算冷写单批对话字数预算：
 * - 与 DirectEngine 换段上限一致：effectiveTokens = min(contextWindow * 0.75, contextLimits.chat)
 * - 预留 ~40% 给系统提示词、注册表、多步工具读卡与思考，余下 60% 分配给待整理原文
 */
export function computeColdTidyBudgetChars(
  chatModel: Pick<ChatModelClient, "contextWindow">,
  config?: PsyberConfig,
): number {
  const rawWindow = chatModel.contextWindow;
  const modelWindow =
    typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow > 0
      ? rawWindow
      : 128_000;
  const baseTokens = Math.max(1_000, Math.floor(modelWindow * COLD_TIDY_ROLLOVER_RATIO));
  const customChatLimit = config?.llm?.contextLimits?.chat;
  const effectiveTokens =
    typeof customChatLimit === "number" &&
    Number.isFinite(customChatLimit) &&
    customChatLimit >= 1_000
      ? Math.min(baseTokens, Math.floor(customChatLimit))
      : baseTokens;
  return Math.max(
    MIN_COLD_TIDY_BUDGET_CHARS,
    Math.floor(effectiveTokens * COLD_TIDY_TRANSCRIPT_SHARE),
  );
}

function isTransientTidyError(code: string, message: string, retryable?: boolean): boolean {
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

export const STAGE_RULES_BLOCKS: Record<TidyTaskType, string> = {
  daily_wrapup: [
    "# 各归档区写法与篇幅约束",
    "- **情景切片（`episodes/YYYY/MM/DD/ep-<slug>.md`）**：严格**一事一卡（上限 800 字，不设下限）**——一两句话能说清的小事就写一两句，宁短勿水；同一天聊了多个不相关主题时拆成多张卡，同目录本身即表达日期与时序。已有专卡的用一句钩子 + `[[短标题]]` 指过去，无专卡的一次性经历与当下感受写具体。",
    "- **长期线索（`threads/<space-slug>/<topic-slug>.md`）**：同样坚持**一事/一篇一卡（上限 1,000 字，不设下限；双方共创并值得完整留存的原创作品 `kind: work` 可保留完整正文）**；账本或持续演进类单卡把**最新余额/当前状态放在文件最顶部**，早期已结清流水可定期折叠为简短阶段小结。新建目录前先对照 `threads/REGISTRY.yaml`，语义相近直接复用；新活动类别至少在不同日期/会话出现 2 次才注册（**特例豁免**：`threads/lists/` 可直接收纳零碎但长期有用的个人偏好、心愿与随手记）。",
    "- **实体档案（`entities/<category>/<entity-slug>.md`）**：只保留**稳定画像、当前阶段与关键里程碑索引**（单卡软上限 ~2,000 字）；按日过程留在 `episodes/` 并用 `[[MM-DD ...]]` 挂短链。新建前先对照 `entities/REGISTRY.yaml`，须满足「有实质联系、有具体内容、不同日期/会话出现两次以上（或被亲口嘱咐记住）」才建档。",
    "- **逐字收藏（`favorite/`）**：值得以后回头原样重读的原话或附件（如直击关系转折、观念碰撞、彼此坦露心声或共同造词的句子；有这类时刻的日子顺手挑 1–2 句），一事一卡，逐字保留原话并注明说话人（附件记 `[照片](media/<hash>)`），附一句为什么想留着。",
    "- **高敏私密区（`sensitive/<前缀-slug>.md`，单层目录）**：双方共享、需要记住但高度私密的内容（亲密互动与习惯、个人创伤与脆弱经历、身体/心理健康病史、敏感家庭或财务隐痛）统一单独立卡收进 `sensitive/`，推荐按 `health-*`、`trauma-*`、`intimacy-*`、`personal-*` 命名，frontmatter **必填** `when_to_recall`。",
    "- **重要日子与里程碑（`core/dates.md`）**：固定周期的生日、纪念日、忌日以及关系/人生重大节点每条一行，格式为 `- [MM-DD | celebrate] 标题`、`- [MM-DD | gentle] 标题`、`- [YYYY-MM-DD | milestone] 标题` 或 `- [YYYY-MM-DD | deadline] 标题`。",
    "- **专属暗语与内部梗（`core/glossary.md`，总字数 ≤ 600 字）**：双方处出来、外人字面看不懂的专属暗语、外号、内部梗或固定小仪式，每条一行写清“暗语 = 意思（[[出处]]）”。",
    "- **`workspace/` 边界**：大段半成品文档、长篇攻略或排查日志留在 `workspace/`，记忆卡片里只留简短结论与文件指针。",
  ].join("\n"),
  bedtime: [
    "# 层级时间梗概与睡前兜底规则",
    "- **层级时间梗概（`episodes/YYYY/MM/DD/index.md`、`episodes/YYYY/MM/index.md`、`episodes/YYYY/index.md`）**：像一个人睡前用自然第一人称写给自己的日记梗概，供换段醒来直接读；只留当天主线、情绪/关系变化与未完挂念，不写报菜名式流水账，也**不用挂 `[[短标题]]`**（想翻某天细节按日期目录即可找到；单日总字数 **≤ 250 字**，上限 300 字；单月 ≤ 600 字；单年 ≤ 1000 字；`kind` 统一填 `note`）。",
    "- **8,000 字总预算与向上滚动**：所有激活态梗概共享 **8,000 字**总预算（80% 即 6,400 字软提醒），由我按 `<tidy_context>` 中的水位自主决定是否将较早的日梗概滚入 `MM/index.md`（frontmatter 必填 `covered_until: YYYY-MM-DD`），或将较早的月梗概滚入 `YYYY/index.md`（frontmatter 必填 `covered_until: YYYY-MM`），实现零重叠、零断层拼接。",
    "- **睡前兜底补档**：若回看今日摘要发现遗漏了值得逐字留存的原话（`favorite/`）或跨天长线/实体归档（对照 `threads/REGISTRY.yaml`、`entities/REGISTRY.yaml`），顺手补齐并用 `[[短标题]]` 串好。",
  ].join("\n"),
};

export const TASK_SPECIFIC_BLOCKS: Record<TidyTaskType, string> = {
  daily_wrapup:
    "本步聚焦事实整理与归档，**允许改动范围仅限**：`episodes/YYYY/MM/DD/ep-*.md`、`threads/`（含 `threads/lists/` 与 `REGISTRY.yaml`）、`entities/`（含 `REGISTRY.yaml`）、`favorite/`、`sensitive/`、`core/state.md`、`core/dates.md`、`core/glossary.md`。具体执行：① 按一事一卡记录值得留存的情景切片；② 同步刷新 `core/state.md` 短期状态与活跃长线进度；③ 逐字收藏重要原话/附件到 `favorite/`，高敏私密内容单独立卡到 `sensitive/`；④ 对照注册表归档或注册反复出现的跨天长线与实体。",
  bedtime:
    "本步聚焦睡前日梗概与看板对账，**允许改动范围仅限**：`episodes/.../index.md`（日/月/年时间梗概）、`core/state.md`，以及兜底补齐的 `favorite/`、`threads/`、`entities/`。具体执行：① 按 `<tidy_context>` 指定路径直接 write 今日日梗概 `episodes/YYYY/MM/DD/index.md`（纯正文 ≤ 250 字，上限 300 字，`kind: note`），并结合时间梗概水位自主决定是否向上滚动月/年梗概（必填 `covered_until`）；② 对照 `core/state.md` 清理已恢复或过期条目并刷新长线进度；③ 兜底补齐当日遗漏的 `favorite/`、`threads/` 或 `entities/` 归档。",
};

export const BEDTIME_WITH_DAILY_REFLECT_BLOCK =
  "今晚合并执行【深度日反思 + 睡前日梗概】，**允许改动范围为两阶段并集**：`episodes/YYYY/MM/DD/rf-*.md`、`core/`（`self/user/boundaries/mirror/open/state/dates/glossary`）、`lessons/`、`episodes/.../index.md`，以及兜底补齐的 `favorite/`、`threads/`、`entities/`。请按以下两步在同一轮内完成：①【深度日反思】依照下方 `<daily_reflect_guide>` 与 `<reflect_context>`，自主查阅今日变动及相关旧卡；若有真正值得沉淀的情绪变化、观念转折、相处边界磨合、自我觉察或未完挂念，先在今日目录写 `rf-<slug>.md` 记录心路历程，再把清晰成果精炼分流到 `core/`、`lessons/`、`threads/` 或 `entities/`（引用统一用 `[[短标题]]`）；②【睡前日梗概与看板对账】按 `<tidy_context>` 指定路径直接 write 今日日梗概 `episodes/YYYY/MM/DD/index.md`（纯正文 ≤ 250 字，上限 300 字，`kind: note`），按水位自主决定是否向上滚动月/年梗概，并对账清理 `core/state.md` 过期项与长线进度。";

async function readOptional(absPath: string): Promise<string | null> {
  try {
    const t = await fs.readFile(absPath, "utf8");
    return t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

export function formatTidyAttachmentSuffix(
  metadataJson: string | null,
  opts?: { includeMediaHashes?: boolean },
): string {
  if (!metadataJson) return "";
  try {
    const parsed = JSON.parse(metadataJson) as {
      attachments?: unknown;
      videoClip?: { durationSec?: unknown; frameHashes?: unknown };
      attachmentDigest?: unknown;
    };
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    const videoDuration =
      parsed.videoClip &&
      typeof parsed.videoClip.durationSec === "number" &&
      Number.isFinite(parsed.videoClip.durationSec)
        ? Math.max(1, Math.round(parsed.videoClip.durationSec))
        : null;
    const digest =
      typeof parsed.attachmentDigest === "string" && parsed.attachmentDigest.trim().length > 0
        ? redactSecrets(parsed.attachmentDigest.trim()).text
        : null;
    if (attachments.length === 0 && videoDuration === null && !digest) return "";
    const hashHint =
      opts?.includeMediaHashes && attachments.length > 0
        ? ` (${attachments.map((h) => `media/${h}`).join(", ")})`
        : "";
    const label =
      videoDuration !== null
        ? `附带了约 ${videoDuration} 秒短视频`
        : attachments.length > 0
          ? `附带了 ${attachments.length} 张图片${hashHint}`
          : "附带了媒体附件";
    return digest ? ` [${label} · 摘要：${digest}]` : ` [${label}]`;
  } catch {
    return "";
  }
}

export function clipExcerpt(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(20, maxChars - 1))}…`;
}

export function tailSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…（前文略）\n${text.slice(text.length - maxChars)}`;
}

export function episodeDirForDay(dayStr: string): string {
  const [y, m, d] = dayStr.split("-");
  return `episodes/${y}/${m}/${d}`;
}

export interface GistWatermarkInfo {
  totalChars: number;
  budgetChars: number;
  softWarnChars: number;
  nearLimit: boolean;
}

export function buildTidyContextBlock(opts: {
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
    `今日情景目录：${dayDir}/（切片 ep-<slug>.md）`,
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

export interface RawEventRow {
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

/** 将单条事件渲染为第一人称整理话单行（严格遮罩用户撤回消息原文） */
export function formatTidyTranscriptLine(
  e: RawEventRow,
  timeZone: string,
  userLabel: string,
  opts?: { includeMediaHashes?: boolean },
): string {
  const stamp = `[${localDateTime(e.created_at, timeZone)}]`;
  const attSuffix = formatTidyAttachmentSuffix(e.metadata, opts);
  const safeContent = redactSecrets(e.content).text;
  if (e.status === "retracted") {
    if (e.role === "user") {
      return `${stamp} ${userLabel}: （${userLabel}撤回了一条消息）`;
    }
    return `${stamp} 我: ${safeContent}${attSuffix}（已撤回，${userLabel}看不到内容）`;
  }
  if (e.kind === "door_note") {
    return `${stamp} [${userLabel}从门缝塞进来的纸条 · 当时门处于关闭状态] ${safeContent}${attSuffix}`;
  }
  return `${stamp} ${e.role === "user" ? userLabel : "我"}: ${safeContent}${attSuffix}`;
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

/** 读取现行 core/state.md 供高频整理轮进行短期状态对账（采用尾部保留防最新条目被截断） */
async function buildCoreSummaryMaterial(memoryDir: string): Promise<string | null> {
  const raw = await readOptional(path.join(memoryDir, "core/state.md"));
  if (!raw) return null;
  const body = stripFrontmatter(raw).trim();
  if (!body) return null;
  return `# 现行 core/state.md（短期状态对账）\n${tailSlice(body, 1500)}`;
}

/** 执行单批整理写作轮（内部复用，严格校验沙箱路径后再记录内存回滚备份；支持会话尾部热写与独立冷写） */
interface ContinuedTidyConversation {
  systemPrompt: string;
  messages: ChatMessage[];
}

async function executeSingleTidyPass(
  deps: TidyTaskDeps,
  opts: {
    taskType: TidyTaskType;
    batch: RawEventRow[];
    extraMaterials?: string[];
    nightDate?: string;
    gistWatermark?: GistWatermarkInfo;
    hotSession?: HotTidySessionContext | null;
    /** 单批排空后的同会话续接上下文（保持 systemPrompt 与前序消息逐字节不变以命中 KV Cache） */
    continueFrom?: ContinuedTidyConversation | null;
    includeDailyReflect?: boolean;
    signal?: AbortSignal;
  },
): Promise<TidyTaskOutcome & { overflowed?: boolean; conversation?: ContinuedTidyConversation }> {
  const { dataDir, promptsDir, clock, events, memoryIndex, memoryTools, chatModel } = deps;
  const memoryDir = path.join(dataDir, "memory");
  const cursorId = events.getCursor("daily_wrapup") ?? "";
  const hot = opts.hotSession ?? null;
  const cont = opts.continueFrom ?? null;
  const activeModel = hot ? hot.chatModel : chatModel;
  const activeTools = hot ? hot.tools : MEMORY_5_TOOL_DEFINITIONS;
  const taskSpecificBlock =
    opts.taskType === "bedtime" && opts.includeDailyReflect
      ? BEDTIME_WITH_DAILY_REFLECT_BLOCK
      : TASK_SPECIFIC_BLOCKS[opts.taskType];

  const [selfMd, userMd, tidyPrompt, threadReg, entReg, coreMaterial, identity] = await Promise.all([
    hot || cont ? Promise.resolve(null) : readOptional(path.join(memoryDir, "core", "self.md")),
    hot || cont ? Promise.resolve(null) : readOptional(path.join(memoryDir, "core", "user.md")),
    cont
      ? Promise.resolve(null)
      : readPrompt(promptsDir, "tidy.md", {
          STAGE_RULES_BLOCK: STAGE_RULES_BLOCKS[opts.taskType],
          TASK_SPECIFIC_BLOCK: taskSpecificBlock,
        }),
    readOptional(path.join(memoryDir, "threads", "REGISTRY.yaml")),
    readOptional(path.join(memoryDir, "entities", "REGISTRY.yaml")),
    buildCoreSummaryMaterial(memoryDir),
    readIdentityProfile(dataDir, clock.now(), clock.timeZone),
  ]);
  const userLabel = identity.userName ?? identity.userPronoun ?? "TA";

  const targetDay = opts.nightDate ?? localDay(clock.now(), clock.timeZone);
  let systemPrompt: string;
  let messages: ChatMessage[];

  if (cont) {
    // 同会话续接：保持 Step 1 的 systemPrompt 与前序消息逐字节不变，直接复用原话与刚写完的卡片上下文命中 KV Cache
    systemPrompt = cont.systemPrompt;
    const contParts: string[] = [
      `<bedtime_phase>\n上一阶段（事实切片与归档）已完成并提交。现在切换至睡前阶段，请直接结合上方原话与刚写好的卡片完成以下规则与目标（不必重复 read 刚才已写的全文）：\n\n${STAGE_RULES_BLOCKS.bedtime}\n\n${taskSpecificBlock}\n</bedtime_phase>`,
      buildTidyContextBlock({
        taskType: opts.taskType,
        targetDay,
        gistWatermark: opts.gistWatermark,
      }),
    ];
    if (opts.extraMaterials && opts.extraMaterials.length > 0) {
      contParts.push(...opts.extraMaterials);
    }
    if (coreMaterial) contParts.push(coreMaterial);
    messages = [
      ...cont.messages,
      { role: "user", content: contParts.join("\n\n"), timestamp: clock.now() },
    ];
  } else if (hot) {
    // 会话尾部热写：严格保持 Static Prefix 与历史消息前缀逐字节不变以命中 KV Prompt Cache
    systemPrompt = hot.systemPrompt;
    const tailParts: string[] = [
      `<tidy_mode task="${opts.taskType}">\n${tidyPrompt!.body}\n</tidy_mode>`,
      buildTidyContextBlock({
        taskType: opts.taskType,
        targetDay,
        gistWatermark: opts.gistWatermark,
      }),
    ];
    if (opts.batch.length > 0) {
      const firstStamp = localDateTime(opts.batch[0]!.created_at, clock.timeZone);
      const lastStamp = localDateTime(opts.batch[opts.batch.length - 1]!.created_at, clock.timeZone);
      tailParts.push(
        `# 热写说明\n以上对话历史即本次待整理的 ${opts.batch.length} 条记录（${firstStamp} ~ ${lastStamp}）。现在进入静默整理轮，请仅调用记忆工具（glob / grep / read / write / edit）完成归档，最后输出一行纯 JSON 汇总，不要写任何对外回复。`,
      );
    } else {
      tailParts.push(
        `# 热写说明\n请结合刚才的对话与下方今日已整理卡片摘要完成睡前日梗概整理。仅调用记忆工具（glob / grep / read / write / edit），最后输出一行纯 JSON 汇总，不要写任何对外回复。`,
      );
    }
    if (opts.extraMaterials && opts.extraMaterials.length > 0) {
      tailParts.push(...opts.extraMaterials);
    }
    if (coreMaterial) tailParts.push(coreMaterial);
    if (threadReg) tailParts.push(`# threads/REGISTRY.yaml\n${threadReg}`);
    if (entReg) tailParts.push(`# entities/REGISTRY.yaml\n${entReg}`);

    messages = [
      ...hot.historyMessages,
      { role: "user", content: tailParts.join("\n\n"), timestamp: clock.now() },
    ];
  } else {
    const sysSections: string[] = [];
    if (selfMd) sysSections.push(`<self>\n${selfMd}\n</self>`);
    if (userMd) sysSections.push(`<user>\n${userMd}\n</user>`);
    sysSections.push(tidyPrompt!.body);
    systemPrompt = sysSections.join("\n\n");

    const transcriptLines = opts.batch.map((e) =>
      formatTidyTranscriptLine(e, clock.timeZone, userLabel),
    );

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

    messages = [
      { role: "user", content: materialParts.join("\n\n"), timestamp: clock.now() },
    ];
  }

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
  const retryDelays = deps.retryDelaysMs ?? DEFAULT_TIDY_RETRY_DELAYS_MS;

  let finalText = "";
  let failedReason: string | null = null;
  let overflowed = false;
  let deferred = false;

  const maxSteps = opts.includeDailyReflect ? MAX_TIDY_STEPS + 6 : MAX_TIDY_STEPS;

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (opts.signal?.aborted) {
        deferred = true;
        break;
      }
      let stepText = "";
      let stepThinking = "";
      let stepThinkingSig: string | undefined;
      let stepStopReason: ChatStopReason | undefined;
      const stepToolCalls: ChatToolCall[] = [];

      // 单步瞬时错误（503/high demand/429/网络抖动）原地退避重试，保留已完成的工具轮次与工作区文件
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        stepText = "";
        stepThinking = "";
        stepThinkingSig = undefined;
        stepStopReason = undefined;
        stepToolCalls.length = 0;
        let attemptError: { code: string; message: string; retryable?: boolean } | null = null;

        try {
          for await (const chunk of activeModel.stream({
            systemPrompt,
            messages,
            tools: activeTools,
            ...(hot ? { sessionId: hot.sessionId } : {}),
            ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
            ...(effectiveThinkingBudget !== undefined
              ? { thinkingBudgetTokens: effectiveThinkingBudget }
              : {}),
            signal: opts.signal,
          })) {
            if (opts.signal?.aborted) {
              deferred = true;
              break;
            }
            if (chunk.type === "error") {
              if (chunk.code === "CONTEXT_OVERFLOW") {
                overflowed = true;
              }
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
          if (opts.signal?.aborted) {
            deferred = true;
          } else {
            const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
            attemptError = { code: "PROVIDER_ERROR", message: msg, retryable: true };
          }
        }

        if (deferred) break;
        if (!attemptError) {
          finalText += stepText;
          break;
        }

        const canRetry =
          attempt < retryDelays.length &&
          isTransientTidyError(attemptError.code, attemptError.message, attemptError.retryable);
        if (canRetry) {
          const waitMs = retryDelays[attempt]!;
          console.warn(
            `[tidy] step ${step + 1} 遇到瞬时错误 (${attemptError.code}: ${attemptError.message})，${Math.round(waitMs / 1000)}s 后重试 (${attempt + 1}/${retryDelays.length})...`,
          );
          await sleepWithAbort(waitMs, opts.signal);
          if (opts.signal?.aborted) {
            deferred = true;
            break;
          }
          continue;
        }

        failedReason = `${attemptError.code}: ${attemptError.message}`;
        break;
      }

      if (deferred || failedReason) break;
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
      if (stepToolCalls.length === 0) {
        messages.push({
          role: "assistant",
          content: stepText || '{"summary": "完成本轮整理"}',
          thinking: stepThinking || undefined,
          thinkingSignature: stepThinkingSig,
          timestamp: clock.now(),
        });
        break;
      }

      messages.push({
        role: "assistant",
        content: stepText,
        thinking: stepThinking || undefined,
        thinkingSignature: stepThinkingSig,
        toolCalls: stepToolCalls,
        timestamp: clock.now(),
      });

      for (const tc of stepToolCalls) {
        if (opts.signal?.aborted) {
          deferred = true;
          break;
        }
        let res = {
          ok: false,
          output: hot
            ? `整理轮仅允许使用记忆工具（glob/grep/read/write/edit），已忽略 ${tc.name}`
            : `未知工具 ${tc.name}`,
        };
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
      if (deferred) break;
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      deferred = true;
    } else {
      failedReason = (err as Error).message;
    }
  }

  if (deferred || failedReason) {
    await rollback();
    return {
      ok: false,
      taskType: opts.taskType,
      mode: hot ? "hot" : "cold",
      ...(deferred ? { deferred: true } : {}),
      ...(overflowed ? { overflowed: true } : {}),
      processedEvents: 0,
      touchedMemoryPaths: [],
      committed: false,
      summary: "",
      lastProcessedEventId: cursorId || null,
      error: deferred ? "DEFERRED_BY_USER" : (failedReason ?? "整理失败"),
    };
  }

  const touchedList = Array.from(touched);
  const summary = parseOptionalSummary(finalText, touchedList);
  const commitTag = opts.taskType === "bedtime" && opts.includeDailyReflect ? "bedtime+reflect" : opts.taskType;
  const committed =
    touchedList.length > 0
      ? await commitMemoryPaths(dataDir, touchedList, `memory(${commitTag}): ${summary}`)
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
    mode: hot ? "hot" : "cold",
    processedEvents: opts.batch.length,
    touchedMemoryPaths: touchedList,
    committed,
    summary,
    lastProcessedEventId: lastProcessedId || null,
    conversation: { systemPrompt, messages },
  };
}

function queryNextPendingBatch(
  db: Database,
  cursorId: string,
  maxSeq?: number | null,
  budgetChars = MIN_COLD_TIDY_BUDGET_CHARS,
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
    if (batch.length > 0 && nextChars > budgetChars && ev.turn_id !== batch[batch.length - 1].turn_id) {
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
function queryAllPendingEvents(
  db: Database,
  cursorId: string,
  maxSeq?: number | null,
): RawEventRow[] {
  return (
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
}

export async function runMemoryTidyTask(
  deps: TidyTaskDeps,
  opts: {
    taskType: TidyTaskType;
    nightDate?: string;
    maxSeq?: number | null;
    hotSession?: HotTidySessionContext | null;
    signal?: AbortSignal;
  },
): Promise<TidyTaskOutcome> {
  let activeHotSession = opts.hotSession ?? null;

  if (opts.taskType === "daily_wrapup") {
    let totalDrained = 0;
    const allTouched = new Set<string>();
    let anyCommitted = false;
    let lastSummary = "无新增记忆";
    let lastProcessedEventId = deps.events.getCursor("daily_wrapup");

    // 优先尝试会话尾部热写（吃满 KV Cache）；仅在 CONTEXT_OVERFLOW 时自动降级回 10k 分批冷写
    if (activeHotSession) {
      const cursorId = deps.events.getCursor("daily_wrapup") ?? "";
      const allPending = queryAllPendingEvents(deps.db, cursorId, opts.maxSeq);
      if (allPending.length === 0) {
        return {
          ok: true,
          taskType: "daily_wrapup",
          mode: "hot",
          processedEvents: 0,
          touchedMemoryPaths: [],
          committed: false,
          summary: "无新增记忆",
          lastProcessedEventId,
        };
      }
      const hotRes = await executeSingleTidyPass(deps, {
        taskType: "daily_wrapup",
        batch: allPending,
        nightDate: opts.nightDate,
        hotSession: activeHotSession,
        signal: opts.signal,
      });
      if (hotRes.ok) {
        return {
          ok: true,
          taskType: "daily_wrapup",
          mode: "hot",
          processedEvents: hotRes.processedEvents,
          touchedMemoryPaths: hotRes.touchedMemoryPaths,
          committed: hotRes.committed,
          summary: hotRes.summary,
          lastProcessedEventId: hotRes.lastProcessedEventId,
        };
      }
      if (hotRes.deferred || !hotRes.overflowed) {
        return {
          ...hotRes,
          processedEvents: 0,
          touchedMemoryPaths: [],
          committed: false,
          lastProcessedEventId,
        };
      }
      // 热写遭遇 CONTEXT_OVERFLOW：降级回分批冷写兜底
      activeHotSession = null;
    }

    let coldBudgetChars = computeColdTidyBudgetChars(deps.chatModel, deps.getConfig?.());
    while (true) {
      const cursorId = deps.events.getCursor("daily_wrapup") ?? "";
      const batch = queryNextPendingBatch(deps.db, cursorId, opts.maxSeq, coldBudgetChars);
      if (batch.length === 0) break;
      const passRes = await executeSingleTidyPass(deps, {
        taskType: "daily_wrapup",
        batch,
        nightDate: opts.nightDate,
        signal: opts.signal,
      });
      if (!passRes.ok) {
        if (
          passRes.overflowed &&
          batch.length > 1 &&
          coldBudgetChars > MIN_COLD_TIDY_BUDGET_CHARS
        ) {
          coldBudgetChars = Math.max(
            MIN_COLD_TIDY_BUDGET_CHARS,
            Math.floor(coldBudgetChars / 2),
          );
          continue;
        }
        return {
          ...passRes,
          mode: "cold",
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
      mode: "cold",
      processedEvents: totalDrained,
      touchedMemoryPaths: Array.from(allTouched),
      committed: anyCommitted,
      summary: lastSummary,
      lastProcessedEventId,
    };
  }

  // bedtime：步骤 1 —— 优先热写排空游标后剩余未整理对话，超容自动降级冷写；单批排空时保留上下文供步骤 2 续接命中缓存
  let totalDrained = 0;
  const allTouched = new Set<string>();
  let anyCommitted = false;
  let usedMode: "hot" | "cold" = activeHotSession ? "hot" : "cold";
  let continuedConv: ContinuedTidyConversation | null = null;

  if (activeHotSession) {
    const cursorId = deps.events.getCursor("daily_wrapup") ?? "";
    const allPending = queryAllPendingEvents(deps.db, cursorId, opts.maxSeq);
    if (allPending.length > 0) {
      const hotDrain = await executeSingleTidyPass(deps, {
        taskType: "daily_wrapup",
        batch: allPending,
        nightDate: opts.nightDate,
        hotSession: activeHotSession,
        signal: opts.signal,
      });
      if (hotDrain.ok) {
        totalDrained += hotDrain.processedEvents;
        for (const p of hotDrain.touchedMemoryPaths) allTouched.add(p);
        if (hotDrain.committed) anyCommitted = true;
        continuedConv = hotDrain.conversation ?? null;
      } else if (hotDrain.deferred || !hotDrain.overflowed) {
        return {
          ...hotDrain,
          taskType: "bedtime",
        };
      } else {
        activeHotSession = null;
        usedMode = "cold";
      }
    }
  }

  if (!activeHotSession) {
    let coldBudgetChars = computeColdTidyBudgetChars(deps.chatModel, deps.getConfig?.());
    let coldPassCount = 0;
    while (true) {
      const cursorId = deps.events.getCursor("daily_wrapup") ?? "";
      const batch = queryNextPendingBatch(deps.db, cursorId, opts.maxSeq, coldBudgetChars);
      if (batch.length === 0) break;
      const drainRes = await executeSingleTidyPass(deps, {
        taskType: "daily_wrapup",
        batch,
        nightDate: opts.nightDate,
        signal: opts.signal,
      });
      if (!drainRes.ok) {
        if (
          drainRes.overflowed &&
          batch.length > 1 &&
          coldBudgetChars > MIN_COLD_TIDY_BUDGET_CHARS
        ) {
          coldBudgetChars = Math.max(
            MIN_COLD_TIDY_BUDGET_CHARS,
            Math.floor(coldBudgetChars / 2),
          );
          continue;
        }
        return {
          ...drainRes,
          taskType: "bedtime",
          mode: "cold",
        };
      }
      coldPassCount += 1;
      totalDrained += drainRes.processedEvents;
      for (const p of drainRes.touchedMemoryPaths) allTouched.add(p);
      if (drainRes.committed) anyCommitted = true;
      // 仅当整个待整理队列在单批内一次排空时，保留会话供 bedtime 步骤 2 续接；多批切分则走独立冷写防上下文不全
      continuedConv = coldPassCount === 1 ? (drainRes.conversation ?? null) : null;
    }
  }

  // bedtime：步骤 2 —— 注入今日已整理卡片摘要 + 当前激活态梗概水位 + 日反思门控（通过时同轮合并执行）
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
        r.kind !== "reflection" &&
        (r.updated_at >= sinceMs || allTouched.has(r.path)) &&
        (r.space === "episodes" ||
          r.space.startsWith("thread:") ||
          r.space.startsWith("entity:") ||
          r.space === "favorite" ||
          r.space === "lessons"),
    );

  // 仅当传入 decisionClient 时在 bedtime 前跑只读体检雷达 + 日反思门控，通过则同轮合并写 rf-*.md 与日梗概
  let radarRes: MemoryRadarResult | null = null;
  let radarMeta: TidyTaskOutcome["radar"];
  if (deps.decisionClient && recentCards.length > 0 && !opts.signal?.aborted) {
    radarRes = await runMemoryRadar({
      db: deps.db,
      dataDir: deps.dataDir,
      promptsDir: deps.promptsDir,
      clock: deps.clock,
      memoryIndex: deps.memoryIndex,
      decisionClient: deps.decisionClient,
      embedding: deps.embedding,
      scope: "bedtime",
      targetDay,
      newCardPaths: recentCards.map((c) => c.path),
      radarConfig: deps.getConfig?.()?.radar,
      episodeFadeDays: deps.getConfig?.()?.recall?.episodeFadeDays,
      includeOpenBoardInBlock: false,
      signal: opts.signal,
    });
    radarMeta = {
      executed: radarRes.executed,
      boardItemsChecked: radarRes.boardItemsChecked,
      pairsEvaluated: radarRes.pairsEvaluated,
      findingsCount: radarRes.findings.filter(
        (f) => !(f.source === "board" && f.targetPath === "core/open.md"),
      ).length,
    };
  }

  let dailyReflectMeta: TidyTaskOutcome["dailyReflect"];
  let mergedDailyReflect = false;
  let dailyReflectHeadBefore: string | null = null;
  if (deps.decisionClient && !opts.signal?.aborted) {
    const gate = await evaluateReflectGate(
      {
        db: deps.db,
        dataDir: deps.dataDir,
        clock: deps.clock,
        decisionClient: deps.decisionClient,
      },
      {
        scope: "daily",
        targetDay,
        radarHint: radarRes?.reflectGateHint ?? null,
        signal: opts.signal,
      },
    );
    dailyReflectHeadBefore = gate.headCommit;
    dailyReflectMeta = {
      triggered: gate.shouldReflect,
      ...(gate.skipReason ? { skipReason: gate.skipReason } : {}),
      ...(gate.decisionScores ? { decisionScores: gate.decisionScores } : {}),
    };
    if (gate.shouldReflect) {
      mergedDailyReflect = true;
      if (radarRes && radarMeta) {
        radarMeta.findingsCount = radarRes.findings.length;
      }
      const [reflectPrompt, openMd] = await Promise.all([
        readPrompt(deps.promptsDir, "reflect.md", {
          SHARED_SCHEMA_BLOCK: "",
          REFLECT_SCOPE_BLOCK: REFLECT_SCOPE_BLOCKS.daily,
        }),
        readOptional(path.join(memoryDir, "core", "open.md")),
      ]);
      extraMaterials.push(`<daily_reflect_guide>\n${reflectPrompt.body}\n</daily_reflect_guide>`);
      extraMaterials.push(
        buildReflectContextBlock({
          scope: "daily",
          targetDay,
          changedPaths: gate.changedPaths,
          dailyRefPaths: gate.dailyRefPaths,
        }),
      );
      if (openMd) {
        const openBody = stripFrontmatter(openMd).trim();
        if (openBody) {
          extraMaterials.push(`# 现行 core/open.md（未完挂念与待观察问号）\n${tailSlice(openBody, 1500)}`);
        }
      }
    }
  }

  if (radarRes && radarRes.findings.length > 0 && !opts.signal?.aborted) {
    const radarBlock = mergedDailyReflect
      ? renderMemoryRadarBlock(radarRes.findings, {
          scope: "bedtime",
          includeOpenBoard: true,
          maxItems: mergeRadarConfig(deps.getConfig?.()?.radar).maxFindingsDaily,
        })
      : radarRes.renderedBlock;
    if (radarBlock) {
      extraMaterials.push(radarBlock);
    }
  }

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

  let bedtimeRes = await executeSingleTidyPass(deps, {
    taskType: "bedtime",
    batch: [],
    extraMaterials,
    nightDate: targetDay,
    gistWatermark,
    hotSession: activeHotSession,
    continueFrom: continuedConv,
    includeDailyReflect: mergedDailyReflect,
    signal: opts.signal,
  });
  if (!bedtimeRes.ok && bedtimeRes.overflowed && (continuedConv || activeHotSession)) {
    // 同会话续接或热写超容 -> 降级独立冷写兜底（Step 1 已提交推进游标，零损失）
    usedMode = "cold";
    bedtimeRes = await executeSingleTidyPass(deps, {
      taskType: "bedtime",
      batch: [],
      extraMaterials,
      nightDate: targetDay,
      gistWatermark,
      includeDailyReflect: mergedDailyReflect,
      signal: opts.signal,
    });
  }

  if (!bedtimeRes.ok) {
    return {
      ...bedtimeRes,
      mode: usedMode,
      ...(dailyReflectMeta ? { dailyReflect: dailyReflectMeta } : {}),
      ...(radarMeta ? { radar: radarMeta } : {}),
    };
  }
  for (const p of bedtimeRes.touchedMemoryPaths) allTouched.add(p);

  if (mergedDailyReflect) {
    const newHead = (await getMemoryHeadCommit(deps.dataDir)) ?? dailyReflectHeadBefore;
    markReflectCursorCompleted(deps.db, "daily", deps.clock.now(), {
      targetDay,
      commitHash: newHead,
      committed: bedtimeRes.committed,
    });
  }

  return {
    ...bedtimeRes,
    mode: usedMode,
    processedEvents: totalDrained,
    touchedMemoryPaths: Array.from(allTouched),
    committed: anyCommitted || bedtimeRes.committed,
    ...(dailyReflectMeta ? { dailyReflect: dailyReflectMeta } : {}),
    ...(radarMeta ? { radar: radarMeta } : {}),
  };
}
