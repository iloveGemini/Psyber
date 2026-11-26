import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import YAML from "yaml";
import type { Clock } from "../core/clock.ts";
import { vagueWhen } from "../core/clock.ts";
import { DEFAULT_RECALL_CONFIG, type RecallConfig } from "../core/config.ts";
import { sanitizeUnicode, type DecisionClient, type DecisionQuestion } from "../core/decision.ts";
import type { EmbeddingClient } from "../core/embedding.ts";
import type { RerankerClient } from "../core/reranker.ts";
import { readPrompt, stripFrontmatter } from "../core/prompts.ts";
import { effectiveStatus } from "./frontmatter.ts";
import type { CardIndexRow, MemoryIndex } from "./index.ts";

export type { EmbeddingClient, RerankerClient };

export type RecallTrack = "same_activity" | "cross_vector" | "daily_recent" | "linked_hop";

export interface RecallTurnContext {
  role: "user" | "assistant";
  content: string;
}

export interface RecalledCard {
  path: string;
  title: string;
  space: string;
  kind: string;
  track: RecallTrack;
  semScore: number;
  kwScore: number;
  rerankScore?: number | null;
  finalScore: number;
  updatedAt: number;
  excerpt: string;
}

export interface RecallResult {
  skipped: boolean;
  items: RecalledCard[];
  renderedBlock: string | null;
  /** 决策门控输出的 needs_memory 概率（未使用门控时为 null） */
  gateScore?: number | null;
  /** 是否因决策模型超时/异常而降级到规则召回 */
  timedOut?: boolean;
  /** 本轮是否实际执行了决策门控与精排 */
  usedDecisionGate?: boolean;
  /** 本轮双链 1 跳扩展的跳数（0 或 1） */
  hopCount?: number;
  /** 本轮双链扩展的终止原因（供评测与观测） */
  hopStoppedReason?: string;
  /** 证据充分性早停得分（0..1，未触发早停检查时为 null） */
  sufficiencyScore?: number | null;
}

const CONTINUE_TRIGGERS = /(接着讲|继续讲|接着说|继续|后来呢|然后呢|再讲一遍|刚才说的)/;
const FILLER_EXACT = new Set([
  "嗯",
  "嗯嗯",
  "哦",
  "噢",
  "好",
  "好的",
  "好呀",
  "好哒",
  "哈哈",
  "哈哈哈",
  "哈哈哈哈",
  "行",
  "行吧",
  "收到",
  "知道了",
  "晚安",
  "早安",
  "ok",
  "okay",
  "k",
]);

export interface RecallGateQuestionSpec {
  instructions: string;
  criteria?: Record<string, string>;
}

export interface RecallGatePromptSpec {
  needsMemory: RecallGateQuestionSpec;
  cardRelevance: RecallGateQuestionSpec;
  evidenceSufficient: RecallGateQuestionSpec;
  hopNeighborRelevance: RecallGateQuestionSpec;
}

const DEFAULT_GATE_NEEDS_MEMORY: RecallGateQuestionSpec = {
  instructions:
    "根据 `<conversation>` 中的对话窗口与 `<resident_context>` 常驻记忆，判断最后一条 `user` 消息是否需要额外翻查历史记忆卡片才能自然接好。",
  criteria: {
    true_description:
      "最后一条 `user` 消息明确回指过去的具体事件、原话、约定、人或故事细节；或正在续接需要历史细节支撑的长期线索/共同活动；或当下情境明显触发了过往教训或背景故事，单靠 `<conversation>` 与 `<resident_context>` 无法补全关键细节。",
    false_description:
      "仅凭当前 `<conversation>` 与 `<resident_context>`（称呼、近期状态、未完挂念）就足以自然接话；或只是当下闲聊、情绪宣泄、客套寒暄、简短回应、纯即时操作或全新话题，此时硬翻旧账反而出戏。",
  },
};

const DEFAULT_GATE_CARD_RELEVANCE: RecallGateQuestionSpec = {
  instructions:
    "结合 `<resident_context>` 与 `<conversation>`，判断候选卡片 `{{card_id}}`（来自 `<memory_catalog>` 或 `<candidates>`）是否能提供常驻记忆之外的实质历史细节、原话、故事进度或教训支撑，值得在此刻自然想起。",
  criteria: {
    true_description:
      "卡片 `{{card_id}}` 的主题、经历、原话或触发条件（`when_to_recall`）直接回应最后一条 `user` 消息的回指、续接当前讨论的线索，或为当下话题补充常驻记忆里没有的关键背景与教训。",
    false_description:
      "卡片 `{{card_id}}` 的信息已被 `<resident_context>` 充分覆盖；或只是与对话出现偶然的字面撞词、泛泛话题沾边；或属于无关旧事，强行带入会让回复显得刻意翻旧账。",
  },
};

const DEFAULT_GATE_EVIDENCE_SUFFICIENT: RecallGateQuestionSpec = {
  instructions:
    "结合 `<resident_context>`、`<conversation>` 与首跳已选中的 `<selected_evidence>`，判断现有记忆信息是否已经足以自然且准确地接住最后一条 `user` 消息，无需再顺着双链展开更多关联卡片。",
  criteria: {
    true_description:
      "`<selected_evidence>` 与 `<resident_context>` 已完整覆盖最后一条 `user` 消息回指的事件、人物、原话或线索进度，没有明显缺漏的关键背景，继续补充关联卡片只会增加冗余或喧宾夺主。",
    false_description:
      "`<selected_evidence>` 只给出了线索入口、概述或片段（例如提到了某张专卡、原话、故事或前因但缺少具体内容），或者还缺少回应最后一条 `user` 消息所需的关键细节，顺着双链再翻 1 跳有明显补全价值。",
  },
};

const DEFAULT_GATE_HOP_NEIGHBOR_RELEVANCE: RecallGateQuestionSpec = {
  instructions:
    "结合 `<resident_context>`、`<conversation>` 与首跳已选中的 `<selected_evidence>`，判断经由双链找到的邻接卡片 `{{card_id}}`（来自 `<linked_neighbors>`）是否能补上 `<selected_evidence>` 中缺失的关键细节、原话、前因后果或长期线索，值得追加进本轮参考。",
  criteria: {
    true_description:
      "邻接卡片 `{{card_id}}` 提供了 `<selected_evidence>` 与 `<resident_context>` 里没有的具体细节、逐字原话、故事/项目进展或直接相关的前因教训，能明显帮上最后一条 `user` 消息的回应。",
    false_description:
      "邻接卡片 `{{card_id}}` 的内容与 `<selected_evidence>` 重复、已被 `<resident_context>` 覆盖，或只是因为人物/主题泛泛相连而与当下这句对话无关，强行追加会显得扯远或翻旧账。",
  },
};

/**
 * 读取常驻核心记忆的精简摘要（供 decision 门控理解双方称呼/外号/未完挂念/近期状态，
 * 并避免对已常驻内容重复翻卡）。总预算约 1500 字，缺文件静默跳过。
 */
async function loadResidentContextForGate(memoryDir: string): Promise<string | null> {
  const specs: Array<{ rel: string; label: string; maxChars: number }> = [
    { rel: "core/open.md", label: "未完挂念", maxChars: 450 },
    { rel: "core/state.md", label: "近期状态", maxChars: 400 },
    { rel: "core/user.md", label: "对方档案", maxChars: 400 },
    { rel: "core/self.md", label: "自我档案", maxChars: 250 },
  ];
  const parts: string[] = [];
  for (const sp of specs) {
    try {
      const raw = await fs.readFile(path.join(memoryDir, sp.rel), "utf8");
      const body = stripFrontmatter(raw).trim();
      if (body) {
        parts.push(`[${sp.label}]\n${clipForGate(body, sp.maxChars)}`);
      }
    } catch {
      // 文件不存在时跳过
    }
  }
  return parts.length > 0 ? `<resident_context>\n${parts.join("\n\n")}\n</resident_context>` : null;
}

export function isBlankTurn(query: string): boolean {
  if (CONTINUE_TRIGGERS.test(query)) return false;
  const cleaned = query
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim()
    .toLowerCase();
  if (!cleaned) return true;
  return cleaned.length <= 4 && FILLER_EXACT.has(cleaned);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

function loadActivityTriggers(
  yamlText: string,
): Array<{ slug: string; triggers: string[] }> {
  try {
    const parsed = YAML.parse(yamlText) as { spaces?: Record<string, { triggers?: string[] }> };
    if (!parsed?.spaces || typeof parsed.spaces !== "object") return [];
    const list: Array<{ slug: string; triggers: string[] }> = [];
    for (const [slug, cfg] of Object.entries(parsed.spaces)) {
      if (Array.isArray(cfg?.triggers) && cfg.triggers.length > 0) {
        list.push({ slug, triggers: cfg.triggers.map(String) });
      }
    }
    return list;
  } catch {
    return [];
  }
}

function truncateToBudget(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const ellipsis = "…（正文略，如需细节可 read 全文）";
  const keep = Math.max(40, maxChars - ellipsis.length);
  return body.slice(0, keep) + ellipsis;
}

function clipForGate(text: string, maxChars: number): string {
  const s = text.trim();
  if (s.length <= maxChars) return sanitizeUnicode(s);
  return sanitizeUnicode(s.slice(0, Math.max(20, maxChars - 1)) + "…");
}

function parseQuestionSection(
  rawSection: string | undefined,
  fallback: RecallGateQuestionSpec,
): RecallGateQuestionSpec {
  const section = rawSection?.trim();
  if (!section) return fallback;

  // 支持可选的 `## true` / `## false` 双边判据子节（向后兼容不含子节的旧版单段指令）
  const subHeadingRe = /(?:^|\r?\n)##\s+(true|false)\s*\r?\n/gi;
  const matches: Array<{ key: "true" | "false"; start: number; contentStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = subHeadingRe.exec(section)) !== null) {
    matches.push({
      key: m[1].toLowerCase() as "true" | "false",
      start: m.index,
      contentStart: m.index + m[0].length,
    });
  }

  if (matches.length === 0) {
    return { instructions: section };
  }

  const instructions = section.slice(0, matches[0].start).trim() || fallback.instructions;
  const criteria: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : section.length;
    const text = section.slice(cur.contentStart, nextStart).trim();
    if (!text) continue;
    criteria[cur.key === "true" ? "true_description" : "false_description"] = text;
  }

  return Object.keys(criteria).length > 0 ? { instructions, criteria } : { instructions };
}

export function parseRecallGatePrompt(body: string): RecallGatePromptSpec {
  const topHeadingRe =
    /(?:^|\r?\n)#\s+(needs_memory|card_relevance|evidence_sufficient|hop_neighbor_relevance)\s*\r?\n/g;
  const sections = new Map<string, string>();
  const matches: Array<{ name: string; start: number; contentStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = topHeadingRe.exec(body)) !== null) {
    matches.push({ name: m[1], start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : body.length;
    sections.set(cur.name, body.slice(cur.contentStart, nextStart));
  }

  return {
    needsMemory: parseQuestionSection(sections.get("needs_memory"), DEFAULT_GATE_NEEDS_MEMORY),
    cardRelevance: parseQuestionSection(sections.get("card_relevance"), DEFAULT_GATE_CARD_RELEVANCE),
    evidenceSufficient: parseQuestionSection(
      sections.get("evidence_sufficient"),
      DEFAULT_GATE_EVIDENCE_SUFFICIENT,
    ),
    hopNeighborRelevance: parseQuestionSection(
      sections.get("hop_neighbor_relevance"),
      DEFAULT_GATE_HOP_NEIGHBOR_RELEVANCE,
    ),
  };
}

function buildNoulQuestion(spec: RecallGateQuestionSpec, cardId?: string): DecisionQuestion {
  const render = (s: string) => (cardId ? s.replaceAll("{{card_id}}", cardId) : s);
  const q: DecisionQuestion = {
    type: "noul",
    instructions: render(spec.instructions),
  };
  if (spec.criteria) {
    const renderedCriteria: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.criteria)) {
      if (v.trim()) renderedCriteria[k] = render(v);
    }
    if (Object.keys(renderedCriteria).length > 0) {
      q.criteria = renderedCriteria;
    }
  }
  return q;
}

async function loadRecallGateInstructions(promptsDir?: string): Promise<RecallGatePromptSpec> {
  const defaults: RecallGatePromptSpec = {
    needsMemory: DEFAULT_GATE_NEEDS_MEMORY,
    cardRelevance: DEFAULT_GATE_CARD_RELEVANCE,
    evidenceSufficient: DEFAULT_GATE_EVIDENCE_SUFFICIENT,
    hopNeighborRelevance: DEFAULT_GATE_HOP_NEIGHBOR_RELEVANCE,
  };
  if (!promptsDir) return defaults;
  try {
    const loaded = await readPrompt(promptsDir, "recall-gate.md");
    return parseRecallGatePrompt(loaded.body);
  } catch {
    return defaults;
  }
}

interface CandidateEntry {
  row: CardIndexRow;
  track: RecallTrack;
  semScore: number;
  kwScore: number;
  rerankScore: number | null;
  finalScore: number;
}

/**
 * 召回管线（查询窗口 + 宽召回候选池 + 可选单次 Decision 门控精排 + 规则降级）：
 * 1) 空档短路检测（纯语气词/空白直接跳过）；
 * 2) 拼装查询窗口（当前一句 + 最近 N 条上下文），宽召回线索触发词 + Embedding/FTS5 + 近 72h episodes 候选池；
 * 3) 若开启 recall.gate.enabled 且配置了 decisionClient，以单次并行决策判定整轮 needs_memory 与各候选卡相关性；
 *    未开启、未配置或超时报错时平滑降级为现行规则 + FTS 分数门槛；
 * 4) 按字符预算截断并写入 recall_traces（含 rerank_score）。
 */
export async function recallMemories(opts: {
  db: Database;
  dataDir: string;
  index: MemoryIndex;
  clock: Clock;
  sessionId: string;
  turnId: string;
  query: string;
  recentTurns?: RecallTurnContext[];
  activityHint?: string;
  embedding?: EmbeddingClient;
  reranker?: RerankerClient;
  decisionClient?: DecisionClient;
  promptsDir?: string;
  charBudget?: number;
  recallConfig?: Partial<RecallConfig>;
}): Promise<RecallResult> {
  const { db, dataDir, index, clock, sessionId, turnId, query } = opts;
  const nowMs = clock.now();
  const cfg: RecallConfig = {
    ...DEFAULT_RECALL_CONFIG,
    ...(opts.recallConfig ?? {}),
    gate: {
      ...DEFAULT_RECALL_CONFIG.gate!,
      ...(opts.recallConfig?.gate ?? {}),
    },
    rerank: {
      ...DEFAULT_RECALL_CONFIG.rerank!,
      ...(opts.recallConfig?.rerank ?? {}),
    },
    multiHop: {
      ...DEFAULT_RECALL_CONFIG.multiHop!,
      ...(opts.recallConfig?.multiHop ?? {}),
    },
  };
  const budget = opts.charBudget ?? cfg.charBudget;
  const dedupWindowMs = cfg.dedupWindowMin * 60_000;
  const recentDailyWindowMs = cfg.recentDailyWindowHours * 3_600_000;
  const embedTimeoutMs = cfg.embedTimeoutMs;
  const gateEnabled = Boolean(cfg.gate?.enabled && opts.decisionClient);
  const embeddingActive = Boolean(opts.embedding && opts.embedding.isConfigured?.() !== false);
  const rerankerActive = Boolean(opts.reranker && opts.reranker.isConfigured?.() !== false);
  const gateThreshold = cfg.gate?.threshold ?? 0.35;
  const rerankThreshold = cfg.rerank?.threshold ?? 0.3;
  const decisionTimeoutMs = cfg.decisionTimeoutMs ?? 3000;
  const rerankTimeoutMs = cfg.rerankTimeoutMs ?? decisionTimeoutMs;
  const queryWindowTurns = cfg.queryWindowTurns ?? 4;
  const candidatePoolLimit = cfg.candidatePool ?? 15;
  const catalogScanMaxCards = cfg.catalogScanMaxCards ?? 250;
  const ftsMinScore = cfg.ftsMinScore ?? 0.25;

  if (!opts.activityHint && isBlankTurn(query)) {
    return { skipped: true, items: [], renderedBlock: null, gateScore: null, usedDecisionGate: false };
  }

  index.expireOverdueStateCards();
  const memoryDir = path.join(dataDir, "memory");

  const recentSlice =
    queryWindowTurns > 0 && opts.recentTurns && opts.recentTurns.length > 0
      ? opts.recentTurns.slice(-queryWindowTurns)
      : [];
  const retrievalQuery =
    recentSlice.length > 0
      ? `${recentSlice
          .slice(-2)
          .map((m) => clipForGate(m.content, 120))
          .join(" ")} ${query}`.trim()
      : query;

  const exemptDedup = CONTINUE_TRIGGERS.test(query);
  const recentPaths = new Set<string>();
  if (!exemptDedup) {
    // 对齐 Spec 02 §7.5：仅统计关联助手回复仍处于 active 状态的近期召回，排除已作废/软删轮次
    const rows = db
      .query(
        `SELECT DISTINCT r.card_path FROM recall_traces r
         WHERE r.session_id = ? AND r.created_at >= ?
           AND EXISTS (
             SELECT 1 FROM events e
             WHERE e.turn_id = r.turn_id
               AND e.role = 'assistant'
               AND e.status = 'active'
           )`,
      )
      .all(sessionId, nowMs - dedupWindowMs) as Array<{ card_path: string }>;
    for (const r of rows) recentPaths.add(r.card_path);
  }

  const allActive = index.listAllRows().filter((r) => {
    if (
      r.space === "self" ||
      r.space === "user" ||
      r.space === "core" ||
      r.space === "episode_index" ||
      r.kind === "reflection"
    ) {
      return false;
    }
    const st = effectiveStatus(r, nowMs);
    return st === "active" || st === "disputed";
  });

  // Step 1.5: 全卡目录直扫模式（活跃卡数 <= catalogScanMaxCards 且决策门控可用时，直接全量扫描「标题 + when_to_recall」，彻底绕开 FTS5 字面漏召）
  let matchedActivitySlug = opts.activityHint ?? null;
  if (!matchedActivitySlug) {
    try {
      const regText = await fs.readFile(path.join(memoryDir, "threads/REGISTRY.yaml"), "utf8");
      const spaces = loadActivityTriggers(regText);
      for (const sp of spaces) {
        if (sp.triggers.some((t) => t && retrievalQuery.includes(t))) {
          matchedActivitySlug = sp.slug;
          break;
        }
      }
    } catch {
      // 无 REGISTRY.yaml 时跳过
    }
  }

  let selected: CandidateEntry[] = [];
  let gateScore: number | null = null;
  let timedOut = false;
  let usedDecisionGate = false;
  let hopCount = 0;
  let hopStoppedReason: string | undefined;
  let sufficiencyScore: number | null = null;
  let hopQueryVec: Float32Array | null = null;
  let hopCardVecs: Map<string, Float32Array> | null = null;
  let hop0PoolAnchors: string[] = [];

  const eligibleForCatalog = allActive.filter((r) => !recentPaths.has(r.path));
  // 配置了向量模型时，直接走「纯向量 Top-15（含 1200 字正文语义）+ Decision 联合精排」，不被全卡目录直扫截胡；
  // 未配置向量模型时，活跃卡 <= catalogScanMaxCards 才启用全卡目录直扫绕开 FTS5 字面漏召。
  const shouldCatalogScan =
    !embeddingActive &&
    gateEnabled &&
    opts.decisionClient &&
    catalogScanMaxCards > 0 &&
    eligibleForCatalog.length > 0 &&
    eligibleForCatalog.length <= catalogScanMaxCards;

  if (shouldCatalogScan && opts.decisionClient) {
    try {
      const [promptInst, residentBlock] = await Promise.all([
        loadRecallGateInstructions(opts.promptsDir),
        loadResidentContextForGate(memoryDir),
      ]);
      const convLines = [
        ...recentSlice.map((m) => `${m.role}: ${clipForGate(m.content, 160)}`),
        `user: ${clipForGate(query, 320)}`,
      ];
      const catalogLines: string[] = [];
      const questions: Record<string, DecisionQuestion> = {
        needs_memory: buildNoulQuestion(promptInst.needsMemory),
      };
      for (let i = 0; i < eligibleForCatalog.length; i++) {
        const row = eligibleForCatalog[i];
        const hint = row.when_to_recall ? `|${clipForGate(row.when_to_recall, 50)}` : "";
        catalogLines.push(`[c${i}] ${clipForGate(row.title, 36)}${hint}`);
        questions[`c${i}`] = buildNoulQuestion(promptInst.cardRelevance, `[c${i}]`);
      }

      const input = [
        ...(residentBlock ? [residentBlock] : []),
        "<conversation>",
        convLines.join("\n"),
        "</conversation>",
        "<memory_catalog>",
        catalogLines.join("\n"),
        "</memory_catalog>",
      ].join("\n");

      const res = await opts.decisionClient.decide({
        input,
        questions,
        signal: AbortSignal.timeout(decisionTimeoutMs),
      });

      usedDecisionGate = true;
      gateScore = res.answers.needs_memory?.noul ?? 0.5;
      if (gateScore < gateThreshold) {
        return {
          skipped: true,
          items: [],
          renderedBlock: null,
          gateScore,
          timedOut: false,
          usedDecisionGate: true,
        };
      }

      const spaceKey = matchedActivitySlug ? `thread:${matchedActivitySlug}` : null;
      const passed: CandidateEntry[] = [];
      for (let i = 0; i < eligibleForCatalog.length; i++) {
        const row = eligibleForCatalog[i];
        const score = res.answers[`c${i}`]?.noul ?? 0;
        if (score >= rerankThreshold) {
          passed.push({
            row,
            track: spaceKey && row.space === spaceKey ? "same_activity" : "cross_vector",
            semScore: 0,
            kwScore: 0,
            rerankScore: score,
            finalScore: score,
          });
        }
      }
      passed.sort((a, b) => b.finalScore - a.finalScore);
      selected = passed.slice(0, 5);
    } catch (err) {
      timedOut = true;
      console.warn(
        `[psyber] recall catalog scan failed/timed out, falling back to rules:`,
        (err as Error).message,
      );
    }
  }

  if (!usedDecisionGate) {
    const candidates: CandidateEntry[] = [];
    const selectedPaths = new Set<string>();

    if (matchedActivitySlug) {
      const spaceKey = `thread:${matchedActivitySlug}`;
      const activityCards = allActive
        .filter((r) => r.space === spaceKey && !recentPaths.has(r.path))
        .slice(0, gateEnabled && !timedOut ? 4 : 3);
      for (const row of activityCards) {
        candidates.push({
          row,
          track: "same_activity",
          semScore: 0,
          kwScore: 1,
          rerankScore: null,
          finalScore: 1.0,
        });
        selectedPaths.add(row.path);
      }
    }

    // Step 2: 全局相关性召回（优先 Embedding 余弦 + 可选 FTS5 RRF 混合；超时/报错/未配置自动降级纯 FTS5 2-gram）
    const remaining = allActive.filter((r) => !selectedPaths.has(r.path) && !recentPaths.has(r.path));
    let usedEmbedding = false;
    const hasSecondStage = (gateEnabled && !timedOut) || rerankerActive;
    const globalLimit = hasSecondStage ? Math.max(6, candidatePoolLimit) : 5;
    const embedMinScore =
      cfg.embedMinScore !== undefined ? cfg.embedMinScore : hasSecondStage ? 0.25 : 0.35;
    const hybridFtsWithEmbedding = cfg.hybridFtsWithEmbedding === true;

    const collectFtsHits = () => {
      const ftsHits = index.searchFts(query, globalLimit + 6);
      if (retrievalQuery !== query) {
        const seenFts = new Set(ftsHits.map((h) => h.path));
        for (const hit of index.searchFts(retrievalQuery, globalLimit + 6)) {
          if (!seenFts.has(hit.path)) {
            ftsHits.push(hit);
            seenFts.add(hit.path);
          }
        }
      }
      const list: Array<{ row: CardIndexRow; kwScore: number }> = [];
      for (const hit of ftsHits) {
        if (selectedPaths.has(hit.path) || recentPaths.has(hit.path)) continue;
        const row = index.getRow(hit.path);
        if (!row || row.kind === "reflection") continue;
        const kwScore = Math.min(1, Math.max(0.1, -hit.rank / (-hit.rank + 1.2)));
        list.push({ row, kwScore });
      }
      return list;
    };

    if (embeddingActive && opts.embedding && remaining.length > 0) {
      try {
        const qVec = await opts.embedding.embed(retrievalQuery, {
          signal: AbortSignal.timeout(embedTimeoutMs),
          taskType: "query",
        });

        const vecByPath = new Map<string, Float32Array>();
        hopQueryVec = qVec;
        hopCardVecs = vecByPath;
        const missing: Array<{ row: CardIndexRow; text: string }> = [];
        const modelKey = opts.embedding.modelKey;

        for (const row of remaining) {
          const cached = db
            .query(
              `SELECT vec, content_hash FROM card_embeddings
               WHERE path = ? AND model_key = ?`,
            )
            .get(row.path, modelKey) as { vec: Uint8Array; content_hash: string } | null;

          if (cached && cached.content_hash === row.content_hash) {
            vecByPath.set(
              row.path,
              new Float32Array(
                cached.vec.buffer,
                cached.vec.byteOffset,
                cached.vec.byteLength / 4,
              ),
            );
          } else {
            const rawMd = await fs.readFile(path.join(memoryDir, row.path), "utf8");
            const embedText = `${row.title}\n${row.when_to_recall ?? ""}\n${stripFrontmatter(rawMd).slice(0, 1200)}`;
            missing.push({ row, text: embedText });
          }
        }

        if (missing.length > 0) {
          const batchTimeout = Math.max(embedTimeoutMs, Math.min(60_000, embedTimeoutMs * Math.ceil(missing.length / 8)));
          let newVecs: Float32Array[];
          if (opts.embedding.embedBatch) {
            newVecs = await opts.embedding.embedBatch(
              missing.map((m) => m.text),
              { signal: AbortSignal.timeout(batchTimeout), taskType: "document" },
            );
          } else {
            newVecs = [];
            for (const m of missing) {
              newVecs.push(
                await opts.embedding.embed(m.text, {
                  signal: AbortSignal.timeout(embedTimeoutMs),
                  taskType: "document",
                }),
              );
            }
          }

          const upsert = db.query(
            `INSERT INTO card_embeddings (path, model_key, content_hash, dim, vec, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(path, model_key) DO UPDATE SET
               content_hash = excluded.content_hash,
               dim = excluded.dim,
               vec = excluded.vec,
               updated_at = excluded.updated_at`,
          );
          const tx = db.transaction(() => {
            for (let i = 0; i < missing.length; i++) {
              const cVec = newVecs[i];
              const row = missing[i].row;
              vecByPath.set(row.path, cVec);
              const blob = new Uint8Array(cVec.buffer, cVec.byteOffset, cVec.byteLength);
              upsert.run(row.path, modelKey, row.content_hash, cVec.length, blob, nowMs);
            }
          });
          tx();
        }

        const semScored: Array<{ row: CardIndexRow; score: number }> = [];
        for (const row of remaining) {
          const cVec = vecByPath.get(row.path);
          if (!cVec) continue;
          const sim = cosineSimilarity(qVec, cVec);
          if (sim >= embedMinScore) {
            semScored.push({ row, score: sim });
          }
        }
        semScored.sort((a, b) => b.score - a.score);

        if (hybridFtsWithEmbedding) {
          // 倒排秩融合（RRF）：同时保住向量语义联想与 FTS5 专名/原话精确字面命中
          const ftsList = collectFtsHits();
          const rrfK = 60;
          const fused = new Map<
            string,
            { row: CardIndexRow; semScore: number; kwScore: number; rrf: number }
          >();
          for (let i = 0; i < semScored.length && i < globalLimit * 2; i++) {
            const item = semScored[i];
            fused.set(item.row.path, {
              row: item.row,
              semScore: item.score,
              kwScore: 0,
              // 语义轨道略占优（1.15x），确保纯语义命中优先于泛字面撞词
              rrf: 1.15 / (rrfK + i + 1),
            });
          }
          for (let i = 0; i < ftsList.length && i < globalLimit * 2; i++) {
            const item = ftsList[i];
            const prev = fused.get(item.row.path);
            const boost = 1.0 / (rrfK + i + 1);
            if (prev) {
              prev.kwScore = item.kwScore;
              prev.rrf += boost;
            } else {
              fused.set(item.row.path, {
                row: item.row,
                semScore: 0,
                kwScore: item.kwScore,
                rrf: boost,
              });
            }
          }
          const rankedFused = Array.from(fused.values()).sort(
            (a, b) => b.rrf - a.rrf || b.semScore - a.semScore,
          );
          for (const item of rankedFused.slice(0, globalLimit)) {
            candidates.push({
              row: item.row,
              track: "cross_vector",
              semScore: item.semScore,
              kwScore: item.kwScore,
              rerankScore: null,
              finalScore: item.semScore > 0 ? item.semScore : item.kwScore,
            });
            selectedPaths.add(item.row.path);
          }
        } else {
          for (const item of semScored.slice(0, globalLimit)) {
            candidates.push({
              row: item.row,
              track: "cross_vector",
              semScore: item.score,
              kwScore: 0,
              rerankScore: null,
              finalScore: item.score,
            });
            selectedPaths.add(item.row.path);
          }
        }
        usedEmbedding = true;
      } catch (err) {
        console.warn(
          `[psyber] recall embedding failed/timed out, falling back to FTS5:`,
          (err as Error).message,
        );
        usedEmbedding = false;
      }
    }

    if (!usedEmbedding) {
      const ftsList = collectFtsHits();
      for (const item of ftsList.slice(0, globalLimit)) {
        candidates.push({
          row: item.row,
          track: "cross_vector",
          semScore: 0,
          kwScore: item.kwScore,
          rerankScore: null,
          finalScore: item.kwScore,
        });
        selectedPaths.add(item.row.path);
      }
    }

    // 非特定线索闲聊时，补近 72h 活跃 episodes/ 最多 2 条
    if (!matchedActivitySlug) {
      const recentDaily = allActive
        .filter(
          (r) =>
            r.space === "episodes" &&
            r.created_at >= nowMs - recentDailyWindowMs &&
            !selectedPaths.has(r.path) &&
            !recentPaths.has(r.path),
        )
        .slice(0, 2);
      for (const row of recentDaily) {
        candidates.push({
          row,
          track: "daily_recent",
          semScore: 0,
          kwScore: 0.5,
          rerankScore: null,
          finalScore: 0.5,
        });
        selectedPaths.add(row.path);
      }
    }

    const applyRuleFallback = (pool: CandidateEntry[]): CandidateEntry[] => {
      const out: CandidateEntry[] = [];
      let actCount = 0;
      let vecCount = 0;
      let dailyCount = 0;
      for (const c of pool) {
        if (c.track === "same_activity") {
          if (actCount < 3) {
            out.push(c);
            actCount++;
          }
        } else if (c.track === "cross_vector") {
          // 降级模式对纯字面检索应用分数门槛；小语料（< 10 张卡）BM25 IDF 易塌缩，豁免过滤
          if (c.semScore === 0 && ftsMinScore > 0 && allActive.length >= 10 && c.kwScore < ftsMinScore) {
            continue;
          }
          if (vecCount < 5) {
            out.push(c);
            vecCount++;
          }
        } else {
          if (dailyCount < 2) {
            out.push(c);
            dailyCount++;
          }
        }
      }
      return out;
    };

    // Step 2.5: 候选池二阶段门控与精排
    if (rerankerActive && opts.reranker && candidates.length > 0) {
      const poolSlice = candidates.slice(0, candidatePoolLimit);
      const docTexts: string[] = [];
      for (const c of poolSlice) {
        let body = "";
        try {
          const rawMd = await fs.readFile(path.join(memoryDir, c.row.path), "utf8");
          body = clipForGate(stripFrontmatter(rawMd), 500);
        } catch {
          body = "";
        }
        const hint = c.row.when_to_recall ? `\n何时想起：${clipForGate(c.row.when_to_recall, 100)}` : "";
        docTexts.push(`标题：${c.row.title}${hint}\n正文：${body}`);
      }
      const rerankQuery =
        recentSlice.length > 0
          ? [
              ...recentSlice.slice(-2).map((m) => `${m.role}: ${clipForGate(m.content, 160)}`),
              `user: ${clipForGate(query, 320)}`,
            ].join("\n")
          : clipForGate(query, 400);

      const runGateOnly = async () => {
        if (!(gateEnabled && !timedOut && opts.decisionClient)) return null;
        const [promptInst, residentBlock] = await Promise.all([
          loadRecallGateInstructions(opts.promptsDir),
          loadResidentContextForGate(memoryDir),
        ]);
        const convLines = [
          ...recentSlice.map((m) => `${m.role}: ${clipForGate(m.content, 200)}`),
          `user: ${clipForGate(query, 400)}`,
        ];
        const gateInput = [
          ...(residentBlock ? [residentBlock] : []),
          "<conversation>",
          convLines.join("\n"),
          "</conversation>",
        ].join("\n");
        return opts.decisionClient.decide({
          input: gateInput,
          questions: {
            needs_memory: buildNoulQuestion(promptInst.needsMemory),
          },
          signal: AbortSignal.timeout(decisionTimeoutMs),
        });
      };

      const [gateOutcome, rerankOutcome] = await Promise.allSettled([
        runGateOnly(),
        opts.reranker.rerank(rerankQuery, docTexts, {
          signal: AbortSignal.timeout(rerankTimeoutMs),
        }),
      ]);

      if (gateOutcome.status === "fulfilled" && gateOutcome.value) {
        usedDecisionGate = true;
        gateScore = gateOutcome.value.answers.needs_memory?.noul ?? 0.5;
        if (gateScore < gateThreshold) {
          return {
            skipped: true,
            items: [],
            renderedBlock: null,
            gateScore,
            timedOut: false,
            usedDecisionGate: true,
          };
        }
      } else if (gateOutcome.status === "rejected") {
        timedOut = true;
        console.warn(
          `[psyber] recall needs_memory gate failed/timed out:`,
          (gateOutcome.reason as Error)?.message ?? String(gateOutcome.reason),
        );
      }

      if (rerankOutcome.status === "fulfilled") {
        const passed: CandidateEntry[] = [];
        for (const item of rerankOutcome.value) {
          const c = poolSlice[item.index];
          if (!c) continue;
          if (item.relevanceScore >= rerankThreshold) {
            passed.push({
              ...c,
              rerankScore: item.relevanceScore,
              finalScore: item.relevanceScore,
            });
          }
        }
        passed.sort((a, b) => b.finalScore - a.finalScore);
        selected = passed.slice(0, 5);
      } else {
        timedOut = true;
        console.warn(
          `[psyber] recall reranker failed/timed out, falling back to rules:`,
          (rerankOutcome.reason as Error)?.message ?? String(rerankOutcome.reason),
        );
        selected = applyRuleFallback(candidates);
      }
    } else if (gateEnabled && !timedOut && opts.decisionClient && candidates.length > 0) {
      const poolSlice = candidates.slice(0, candidatePoolLimit);
      try {
        const [promptInst, residentBlock] = await Promise.all([
          loadRecallGateInstructions(opts.promptsDir),
          loadResidentContextForGate(memoryDir),
        ]);
        const convLines = [
          ...recentSlice.map((m) => `${m.role}: ${clipForGate(m.content, 200)}`),
          `user: ${clipForGate(query, 400)}`,
        ];

        const cardSummaries: string[] = [];
        const questions: Record<string, DecisionQuestion> = {
          needs_memory: buildNoulQuestion(promptInst.needsMemory),
        };

        for (let i = 0; i < poolSlice.length; i++) {
          const c = poolSlice[i];
          let body = "";
          try {
            const rawMd = await fs.readFile(path.join(memoryDir, c.row.path), "utf8");
            body = clipForGate(stripFrontmatter(rawMd), 260);
          } catch {
            body = "";
          }
          const hint = c.row.when_to_recall ? ` | 何时想起：${clipForGate(c.row.when_to_recall, 80)}` : "";
          cardSummaries.push(`[c${i}] ${c.row.path} | 标题：${c.row.title}${hint}\n摘要：${body}`);
          questions[`c${i}`] = buildNoulQuestion(promptInst.cardRelevance, `[c${i}]`);
        }

        const input = [
          ...(residentBlock ? [residentBlock] : []),
          "<conversation>",
          convLines.join("\n"),
          "</conversation>",
          "<candidates>",
          cardSummaries.join("\n\n"),
          "</candidates>",
        ].join("\n");

        const res = await opts.decisionClient.decide({
          input,
          questions,
          signal: AbortSignal.timeout(decisionTimeoutMs),
        });

        usedDecisionGate = true;
        gateScore = res.answers.needs_memory?.noul ?? 0.5;

        if (gateScore < gateThreshold) {
          return {
            skipped: true,
            items: [],
            renderedBlock: null,
            gateScore,
            timedOut: false,
            usedDecisionGate: true,
          };
        }

        const passed: CandidateEntry[] = [];
        for (let i = 0; i < poolSlice.length; i++) {
          const c = poolSlice[i];
          const score = res.answers[`c${i}`]?.noul ?? 0;
          if (score >= rerankThreshold) {
            passed.push({
              ...c,
              rerankScore: score,
              finalScore: score,
            });
          }
        }
        passed.sort((a, b) => b.finalScore - a.finalScore);
        selected = passed.slice(0, 5);
        hop0PoolAnchors = poolSlice.slice(0, 2).map((c) => c.row.path);
      } catch (err) {
        timedOut = true;
        console.warn(
          `[psyber] recall decision gate failed/timed out, falling back to rules:`,
          (err as Error).message,
        );
        selected = applyRuleFallback(candidates);
      }
    } else {
      selected = applyRuleFallback(candidates);
    }
  }

  // Step 2.8: 轻量 1 跳双链扩展 + 证据充分性早停（基于 card_links 双向 [[短标题]]/路径邻卡，严格受预算与早停约束，绝不丢弃首跳结果）
  const multiHopCfg = cfg.multiHop ?? DEFAULT_RECALL_CONFIG.multiHop!;
  if (
    multiHopCfg.enabled &&
    usedDecisionGate &&
    !timedOut &&
    opts.decisionClient &&
    gateScore !== null &&
    gateScore >= gateThreshold &&
    selected.length < 5
  ) {
    const anchorPaths =
      selected.length > 0 ? selected.slice(0, 3).map((s) => s.row.path) : hop0PoolAnchors;
    if (anchorPaths.length === 0) {
      hopStoppedReason = "no_anchors";
    } else {
      const excludePaths = new Set<string>(recentPaths);
      for (const s of selected) excludePaths.add(s.row.path);
      const maxNeighbors = Math.max(1, multiHopCfg.maxNeighbors ?? 6);
      const rawNeighbors = index.findLinkedNeighbors(anchorPaths, {
        excludePaths,
        maxResults: maxNeighbors * 4,
      });

      if (rawNeighbors.length === 0) {
        hopStoppedReason = "no_neighbors";
      } else {
        // 若已有查询向量与卡片向量缓存，优先按语义相似度 + 多锚点共指 + 正向边排序挑出最相关邻卡
        const rankedNeighbors = rawNeighbors
          .map((nb) => {
            let sem = 0;
            if (hopQueryVec && hopCardVecs) {
              const nv = hopCardVecs.get(nb.row.path);
              if (nv) sem = cosineSimilarity(hopQueryVec, nv);
            }
            const priority =
              sem +
              0.12 * Math.max(0, nb.anchorHitCount - 1) +
              (nb.direction === "out" ? 0.05 : 0) +
              (nb.row.space !== "episodes" ? 0.03 : 0);
            return { nb, sem, priority };
          })
          .sort((a, b) => b.priority - a.priority || b.nb.row.updated_at - a.nb.row.updated_at)
          .slice(0, maxNeighbors);

        try {
          const [promptInst, residentBlock] = await Promise.all([
            loadRecallGateInstructions(opts.promptsDir),
            loadResidentContextForGate(memoryDir),
          ]);
          const convLines = [
            ...recentSlice.map((m) => `${m.role}: ${clipForGate(m.content, 200)}`),
            `user: ${clipForGate(query, 400)}`,
          ];

          const selectedSummaries: string[] = [];
          for (let i = 0; i < selected.length; i++) {
            const s = selected[i];
            let body = "";
            try {
              const rawMd = await fs.readFile(path.join(memoryDir, s.row.path), "utf8");
              body = clipForGate(stripFrontmatter(rawMd), 260);
            } catch {
              body = "";
            }
            selectedSummaries.push(`[s${i}] ${s.row.path} | 标题：${s.row.title}\n摘要：${body}`);
          }

          const neighborSummaries: string[] = [];
          const questions: Record<string, DecisionQuestion> = {};
          const checkSufficiency = selected.length > 0;
          if (checkSufficiency) {
            questions.evidence_sufficient = buildNoulQuestion(promptInst.evidenceSufficient);
          }

          for (let i = 0; i < rankedNeighbors.length; i++) {
            const { nb } = rankedNeighbors[i];
            let body = "";
            try {
              const rawMd = await fs.readFile(path.join(memoryDir, nb.row.path), "utf8");
              body = clipForGate(stripFrontmatter(rawMd), 260);
            } catch {
              body = "";
            }
            const dirLabel = nb.direction === "out" ? "正文引用自" : "反向关联到";
            const hint = nb.row.when_to_recall
              ? ` | 何时想起：${clipForGate(nb.row.when_to_recall, 80)}`
              : "";
            neighborSummaries.push(
              `[n${i}] ${nb.row.path} | 标题：${nb.row.title}（${dirLabel} [[${nb.viaAnchorTitle}]]）${hint}\n摘要：${body}`,
            );
            questions[`n${i}`] = buildNoulQuestion(promptInst.hopNeighborRelevance, `[n${i}]`);
          }

          const hopInput = [
            ...(residentBlock ? [residentBlock] : []),
            "<conversation>",
            convLines.join("\n"),
            "</conversation>",
            ...(selectedSummaries.length > 0
              ? ["<selected_evidence>", selectedSummaries.join("\n\n"), "</selected_evidence>"]
              : []),
            "<linked_neighbors>",
            neighborSummaries.join("\n\n"),
            "</linked_neighbors>",
          ].join("\n");

          const hopTimeoutMs = multiHopCfg.timeoutMs ?? 2500;
          const hopRes = await opts.decisionClient.decide({
            input: hopInput,
            questions,
            signal: AbortSignal.timeout(hopTimeoutMs),
          });
          hopCount = 1;

          const sufficientThreshold = multiHopCfg.sufficientThreshold ?? 0.75;
          if (checkSufficiency) {
            sufficiencyScore = hopRes.answers.evidence_sufficient?.noul ?? 0.5;
          }

          if (checkSufficiency && sufficiencyScore !== null && sufficiencyScore >= sufficientThreshold) {
            hopStoppedReason = "evidence_sufficient";
          } else {
            const neighborThreshold = multiHopCfg.neighborThreshold ?? Math.max(0.4, rerankThreshold);
            const addedNeighbors: CandidateEntry[] = [];
            for (let i = 0; i < rankedNeighbors.length; i++) {
              const { nb, sem } = rankedNeighbors[i];
              const score = hopRes.answers[`n${i}`]?.noul ?? 0;
              if (score >= neighborThreshold) {
                addedNeighbors.push({
                  row: nb.row,
                  track: "linked_hop",
                  semScore: sem,
                  kwScore: 0,
                  rerankScore: score,
                  finalScore: score,
                });
              }
            }
            addedNeighbors.sort((a, b) => b.finalScore - a.finalScore);
            const slotsLeft = Math.max(0, 5 - selected.length);
            if (addedNeighbors.length > 0 && slotsLeft > 0) {
              selected = [...selected, ...addedNeighbors.slice(0, slotsLeft)];
              hopStoppedReason = "expanded";
            } else {
              hopStoppedReason = "no_new_hits";
            }
          }
        } catch (err) {
          hopStoppedReason = "timeout_or_error";
          console.warn(
            `[psyber] recall 1-hop link expansion failed/timed out, keeping hop-0 results:`,
            (err as Error).message,
          );
        }
      }
    }
  } else if (!multiHopCfg.enabled) {
    hopStoppedReason = "disabled";
  } else if (selected.length >= 5) {
    hopStoppedReason = "full";
  }

  // Step 3: 字符预算裁剪与留痕落库
  const recalled: RecalledCard[] = [];
  const lines: string[] = [];
  let usedChars = 0;

  for (const cand of selected) {
    const remainingBudget = budget - usedChars;
    if (remainingBudget < 160) break;

    let body: string;
    try {
      const rawMd = await fs.readFile(path.join(memoryDir, cand.row.path), "utf8");
      body = stripFrontmatter(rawMd);
    } catch {
      continue;
    }

    const whenLabel = vagueWhen(cand.row.updated_at, nowMs, clock.timeZone);
    const trackLabel =
      cand.track === "same_activity"
        ? "同活动"
        : cand.track === "daily_recent"
          ? "近期日常"
          : cand.track === "linked_hop"
            ? "关联延伸"
            : "相关记忆";
    const statusFlag = cand.row.status === "disputed" ? " · [待确认/有分歧]" : "";
    const dateFlag = cand.row.date_kind === "gentle" ? " · [敏感忌日·轻声对待]" : "";
    const header = `- [${trackLabel}] ${cand.row.path}（${whenLabel} · kind: ${cand.row.kind}${statusFlag}${dateFlag}）\n  标题：${cand.row.title}\n  `;
    const bodyBudget = remainingBudget - header.length - 2;
    if (bodyBudget < 40) break;

    const excerpt = truncateToBudget(body, bodyBudget);
    const entry = `${header}${excerpt}`;
    lines.push(entry);
    usedChars += entry.length + 1;

    recalled.push({
      path: cand.row.path,
      title: cand.row.title,
      space: cand.row.space,
      kind: cand.row.kind,
      track: cand.track,
      semScore: cand.semScore,
      kwScore: cand.kwScore,
      rerankScore: cand.rerankScore,
      finalScore: cand.finalScore,
      updatedAt: cand.row.updated_at,
      excerpt,
    });
  }

  if (recalled.length > 0) {
    const insert = db.query(
      `INSERT INTO recall_traces (
        turn_id, session_id, query, activity_hint, card_path,
        track, sem_score, kw_score, rerank_score, final_score, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (const item of recalled) {
        insert.run(
          turnId,
          sessionId,
          query,
          matchedActivitySlug,
          item.path,
          item.track,
          item.semScore,
          item.kwScore,
          item.rerankScore ?? null,
          item.finalScore,
          nowMs,
        );
      }
    });
    tx();
  }

  const renderedBlock =
    lines.length > 0
      ? `<recalled_memories note="系统按当前话题检索到的历史笔记片段，仅供自然参考，并非必须提及的清单">\n${lines.join("\n")}\n</recalled_memories>`
      : null;

  return {
    skipped: false,
    items: recalled,
    renderedBlock,
    gateScore,
    timedOut,
    usedDecisionGate,
    hopCount,
    hopStoppedReason,
    sufficiencyScore,
  };
}

export function getTurnRecallTraces(db: Database, turnId: string): Array<{
  cardPath: string;
  title: string;
  track: string;
  semScore: number;
  kwScore: number;
  rerankScore: number | null;
  finalScore: number;
  feedback?: string;
}> {
  const rows = db
    .query(
      `SELECT r.card_path, COALESCE(c.title, r.card_path) AS title,
              r.track, r.sem_score, r.kw_score, r.rerank_score, r.final_score,
              (SELECT f.verdict FROM recall_feedback f
               WHERE f.turn_id = r.turn_id AND f.card_path = r.card_path
               ORDER BY f.id DESC LIMIT 1) AS feedback
       FROM recall_traces r
       LEFT JOIN card_index c ON c.path = r.card_path
       WHERE r.turn_id = ?
       ORDER BY r.id ASC`,
    )
    .all(turnId) as Array<{
    card_path: string;
    title: string;
    track: string;
    sem_score: number;
    kw_score: number;
    rerank_score: number | null;
    final_score: number;
    feedback: string | null;
  }>;

  return rows.map((r) => ({
    cardPath: r.card_path,
    title: r.title,
    track: r.track,
    semScore: r.sem_score,
    kwScore: r.kw_score,
    rerankScore: r.rerank_score,
    finalScore: r.final_score,
    ...(r.feedback ? { feedback: r.feedback } : {}),
  }));
}

export function saveRecallFeedback(
  db: Database,
  input: {
    turnId: string;
    cardPath?: string;
    verdict: "useful" | "noisy" | "missed";
    note?: string;
    nowMs: number;
  },
): number {
  const res = db
    .query(
      `INSERT INTO recall_feedback (turn_id, card_path, verdict, note, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.turnId, input.cardPath ?? null, input.verdict, input.note ?? null, input.nowMs);
  return Number(res.lastInsertRowid);
}
