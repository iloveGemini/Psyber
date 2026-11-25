import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import YAML from "yaml";
import type { Clock } from "../core/clock.ts";
import { vagueWhen } from "../core/clock.ts";
import { DEFAULT_RECALL_CONFIG, type RecallConfig } from "../core/config.ts";
import { sanitizeUnicode, type DecisionClient, type DecisionQuestion } from "../core/decision.ts";
import { readPrompt, stripFrontmatter } from "../core/prompts.ts";
import { effectiveStatus } from "./frontmatter.ts";
import type { CardIndexRow, MemoryIndex } from "./index.ts";

export interface EmbeddingClient {
  readonly modelKey: string;
  embed(text: string, opts?: { signal?: AbortSignal }): Promise<Float32Array>;
}

export type RecallTrack = "same_activity" | "cross_vector" | "daily_recent";

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

const DEFAULT_GATE_NEEDS_MEMORY =
  "判断最后一条用户消息是否需要额外翻查历史卡片才能自然接好（例如：明确回指过去的具体事件/原话/故事细节、延续需要细节支撑的长期线索、或当前情境明显触发过往教训卡片）。注意：<resident_context> 中的内容已经常驻在上下文中；如果仅靠当下对话和 <resident_context> 就足以自然接话，或只是当下闲聊、纯情绪宣泄、客套寒暄、全新话题，返回低概率。";
const DEFAULT_GATE_CARD_RELEVANCE =
  "结合 <resident_context> 与当前对话窗口，判断候选卡片 {{card_id}} 是否能提供常驻记忆之外的实质历史细节、原话、故事或教训支撑、值得在此刻自然想起。仅当卡片内容直接回应回指、续接当前线索或明显补充当下相关背景时返回高概率；若已被 <resident_context> 充分覆盖、只是偶然撞词或硬扯旧事，返回低概率。";

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

async function loadRecallGateInstructions(promptsDir?: string): Promise<{
  needsMemory: string;
  cardRelevance: string;
}> {
  if (!promptsDir) {
    return {
      needsMemory: DEFAULT_GATE_NEEDS_MEMORY,
      cardRelevance: DEFAULT_GATE_CARD_RELEVANCE,
    };
  }
  try {
    const loaded = await readPrompt(promptsDir, "recall-gate.md");
    const needsMatch = /#\s*needs_memory\s*\r?\n([\s\S]*?)(?=\r?\n#\s*card_relevance|\s*$)/.exec(
      loaded.body,
    );
    const cardMatch = /#\s*card_relevance\s*\r?\n([\s\S]*)$/.exec(loaded.body);
    return {
      needsMemory: needsMatch?.[1]?.trim() || DEFAULT_GATE_NEEDS_MEMORY,
      cardRelevance: cardMatch?.[1]?.trim() || DEFAULT_GATE_CARD_RELEVANCE,
    };
  } catch {
    return {
      needsMemory: DEFAULT_GATE_NEEDS_MEMORY,
      cardRelevance: DEFAULT_GATE_CARD_RELEVANCE,
    };
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
  };
  const budget = opts.charBudget ?? cfg.charBudget;
  const dedupWindowMs = cfg.dedupWindowMin * 60_000;
  const recentDailyWindowMs = cfg.recentDailyWindowHours * 3_600_000;
  const embedTimeoutMs = cfg.embedTimeoutMs;
  const gateEnabled = Boolean(cfg.gate?.enabled && opts.decisionClient);
  const gateThreshold = cfg.gate?.threshold ?? 0.2;
  const rerankThreshold = cfg.rerank?.threshold ?? 0.25;
  const decisionTimeoutMs = cfg.decisionTimeoutMs ?? 3000;
  const queryWindowTurns = cfg.queryWindowTurns ?? 4;
  const candidatePoolLimit = cfg.candidatePool ?? 10;
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

  const eligibleForCatalog = allActive.filter((r) => !recentPaths.has(r.path));
  const shouldCatalogScan =
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
        needs_memory: {
          type: "noul",
          instructions: promptInst.needsMemory,
        },
      };
      for (let i = 0; i < eligibleForCatalog.length; i++) {
        const row = eligibleForCatalog[i];
        const hint = row.when_to_recall ? `|${clipForGate(row.when_to_recall, 50)}` : "";
        catalogLines.push(`[c${i}] ${clipForGate(row.title, 36)}${hint}`);
        questions[`c${i}`] = {
          type: "noul",
          instructions: promptInst.cardRelevance.replaceAll("{{card_id}}", `[c${i}]`),
        };
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

    // Step 2: 全局相关性召回（优先 Embedding 余弦，超时/报错/未配置自动降级 FTS5 2-gram）
    const remaining = allActive.filter((r) => !selectedPaths.has(r.path) && !recentPaths.has(r.path));
    let usedEmbedding = false;
    const globalLimit = gateEnabled && !timedOut ? Math.max(6, candidatePoolLimit) : 5;

    if (opts.embedding && remaining.length > 0) {
      try {
        const qVec = await opts.embedding.embed(retrievalQuery, {
          signal: AbortSignal.timeout(embedTimeoutMs),
        });
        const scored: Array<{ row: CardIndexRow; score: number }> = [];
        for (const row of remaining) {
          const cached = db
            .query(
              `SELECT vec, content_hash FROM card_embeddings
               WHERE path = ? AND model_key = ?`,
            )
            .get(row.path, opts.embedding.modelKey) as { vec: Uint8Array; content_hash: string } | null;

          let cVec: Float32Array;
          if (cached && cached.content_hash === row.content_hash) {
            cVec = new Float32Array(
              cached.vec.buffer,
              cached.vec.byteOffset,
              cached.vec.byteLength / 4,
            );
          } else {
            const rawMd = await fs.readFile(path.join(memoryDir, row.path), "utf8");
            const embedText = `${row.title}\n${row.when_to_recall ?? ""}\n${stripFrontmatter(rawMd).slice(0, 1200)}`;
            cVec = await opts.embedding.embed(embedText, {
              signal: AbortSignal.timeout(embedTimeoutMs),
            });
            const blob = new Uint8Array(cVec.buffer, cVec.byteOffset, cVec.byteLength);
            db.query(
              `INSERT INTO card_embeddings (path, model_key, content_hash, dim, vec, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(path, model_key) DO UPDATE SET
                 content_hash = excluded.content_hash,
                 dim = excluded.dim,
                 vec = excluded.vec,
                 updated_at = excluded.updated_at`,
            ).run(row.path, opts.embedding.modelKey, row.content_hash, cVec.length, blob, nowMs);
          }

          const sim = cosineSimilarity(qVec, cVec);
          if (sim >= 0.35) {
            scored.push({ row, score: sim });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        for (const item of scored.slice(0, globalLimit)) {
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
        usedEmbedding = true;
      } catch {
        usedEmbedding = false;
      }
    }

    if (!usedEmbedding) {
      // 同时检索当前句与查询窗口，优先保留当前句直接命中的卡片
      const ftsHits = index.searchFts(query, globalLimit + 4);
      if (retrievalQuery !== query) {
        const seenFts = new Set(ftsHits.map((h) => h.path));
        for (const hit of index.searchFts(retrievalQuery, globalLimit + 4)) {
          if (!seenFts.has(hit.path)) {
            ftsHits.push(hit);
            seenFts.add(hit.path);
          }
        }
      }

      let added = 0;
      for (const hit of ftsHits) {
        if (added >= globalLimit) break;
        if (selectedPaths.has(hit.path) || recentPaths.has(hit.path)) continue;
        const row = index.getRow(hit.path);
        if (!row || row.kind === "reflection") continue;
        const kwScore = Math.min(1, Math.max(0.1, -hit.rank / (-hit.rank + 1.2)));
        candidates.push({
          row,
          track: "cross_vector",
          semScore: 0,
          kwScore,
          rerankScore: null,
          finalScore: kwScore,
        });
        selectedPaths.add(hit.path);
        added++;
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

    // Step 2.5: 候选池精排模式（当活跃卡数超过 catalogScanMaxCards 或显式禁用全卡直扫时）
    if (gateEnabled && !timedOut && opts.decisionClient && candidates.length > 0) {
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
          needs_memory: {
            type: "noul",
            instructions: promptInst.needsMemory,
          },
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
          questions[`c${i}`] = {
            type: "noul",
            instructions: promptInst.cardRelevance.replaceAll("{{card_id}}", `[c${i}]`),
          };
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
