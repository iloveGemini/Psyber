import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import YAML from "yaml";
import type { Clock } from "../core/clock.ts";
import { vagueWhen } from "../core/clock.ts";
import { DEFAULT_RECALL_CONFIG, type RecallConfig } from "../core/config.ts";
import { stripFrontmatter } from "../core/prompts.ts";
import { effectiveStatus } from "./frontmatter.ts";
import type { CardIndexRow, MemoryIndex } from "./index.ts";

export interface EmbeddingClient {
  readonly modelKey: string;
  embed(text: string, opts?: { signal?: AbortSignal }): Promise<Float32Array>;
}

export type RecallTrack = "same_activity" | "cross_vector" | "daily_recent";

export interface RecalledCard {
  path: string;
  title: string;
  space: string;
  kind: string;
  track: RecallTrack;
  semScore: number;
  kwScore: number;
  finalScore: number;
  updatedAt: number;
  excerpt: string;
}

export interface RecallResult {
  skipped: boolean;
  items: RecalledCard[];
  renderedBlock: string | null;
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

/**
 * Ring 1 极简 3 步召回：
 * 1) 命中 activities/REGISTRY.yaml 触发词则挂该目录 Top-3 活跃卡；
 * 2) 其余活跃卡按 Embedding 余弦（未配置或超时则平滑降级 FTS5 2-gram）取 Top-5，非活动闲聊补近 72h daily/ 最多 2 条；
 * 3) 过滤 2h 本会话已召回卡（仅计关联 active 助手回复的轮次；续接触发词豁免），按字符预算截断并写入 recall_traces。
 */
export async function recallMemories(opts: {
  db: Database;
  dataDir: string;
  index: MemoryIndex;
  clock: Clock;
  sessionId: string;
  turnId: string;
  query: string;
  activityHint?: string;
  embedding?: EmbeddingClient;
  charBudget?: number;
  recallConfig?: Partial<RecallConfig>;
}): Promise<RecallResult> {
  const { db, dataDir, index, clock, sessionId, turnId, query } = opts;
  const nowMs = clock.now();
  const cfg: RecallConfig = {
    ...DEFAULT_RECALL_CONFIG,
    ...(opts.recallConfig ?? {}),
  };
  const budget = opts.charBudget ?? cfg.charBudget;
  const dedupWindowMs = cfg.dedupWindowMin * 60_000;
  const recentDailyWindowMs = cfg.recentDailyWindowHours * 3_600_000;
  const embedTimeoutMs = cfg.embedTimeoutMs;

  if (!opts.activityHint && isBlankTurn(query)) {
    return { skipped: true, items: [], renderedBlock: null };
  }

  index.expireOverdueStateCards();
  const memoryDir = path.join(dataDir, "memory");

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

  const allActive = index
    .listAllRows()
    .filter((r) => {
      if (
        r.space === "self" ||
        r.space === "user" ||
        r.space === "core" ||
        r.space === "episode_index"
      ) {
        return false;
      }
      const st = effectiveStatus(r, nowMs);
      return st === "active" || st === "disputed";
    });

  const selected: Array<{
    row: CardIndexRow;
    track: RecallTrack;
    semScore: number;
    kwScore: number;
    finalScore: number;
  }> = [];
  const selectedPaths = new Set<string>();

  // Step 1: 线索目录直挂（threads/REGISTRY.yaml）
  let matchedActivitySlug = opts.activityHint ?? null;
  if (!matchedActivitySlug) {
    try {
      const regText = await fs.readFile(path.join(memoryDir, "threads/REGISTRY.yaml"), "utf8");
      const spaces = loadActivityTriggers(regText);
      for (const sp of spaces) {
        if (sp.triggers.some((t) => t && query.includes(t))) {
          matchedActivitySlug = sp.slug;
          break;
        }
      }
    } catch {
      // 无 REGISTRY.yaml 时跳过
    }
  }

  if (matchedActivitySlug) {
    const spaceKey = `thread:${matchedActivitySlug}`;
    const activityCards = allActive
      .filter((r) => r.space === spaceKey && !recentPaths.has(r.path))
      .slice(0, 3);
    for (const row of activityCards) {
      selected.push({
        row,
        track: "same_activity",
        semScore: 0,
        kwScore: 1,
        finalScore: 1.0,
      });
      selectedPaths.add(row.path);
    }
  }

  // Step 2: 全局相关性召回（优先 Embedding 余弦，超时/报错/未配置自动降级 FTS5 2-gram）
  const remaining = allActive.filter((r) => !selectedPaths.has(r.path) && !recentPaths.has(r.path));
  let usedEmbedding = false;

  if (opts.embedding && remaining.length > 0) {
    try {
      const qVec = await opts.embedding.embed(query, {
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
      for (const item of scored.slice(0, 5)) {
        selected.push({
          row: item.row,
          track: "cross_vector",
          semScore: item.score,
          kwScore: 0,
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
    const ftsHits = index.searchFts(query, 8);
    let added = 0;
    for (const hit of ftsHits) {
      if (added >= 5) break;
      if (selectedPaths.has(hit.path) || recentPaths.has(hit.path)) continue;
      const row = index.getRow(hit.path);
      if (!row) continue;
      const kwScore = Math.min(1, Math.max(0.1, -hit.rank / (-hit.rank + 1.2)));
      selected.push({
        row,
        track: "cross_vector",
        semScore: 0,
        kwScore,
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
      selected.push({
        row,
        track: "daily_recent",
        semScore: 0,
        kwScore: 0.5,
        finalScore: 0.5,
      });
      selectedPaths.add(row.path);
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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

  return { skipped: false, items: recalled, renderedBlock };
}

export function getTurnRecallTraces(db: Database, turnId: string): Array<{
  cardPath: string;
  title: string;
  track: string;
  semScore: number;
  kwScore: number;
  finalScore: number;
  feedback?: string;
}> {
  const rows = db
    .query(
      `SELECT r.card_path, COALESCE(c.title, r.card_path) AS title,
              r.track, r.sem_score, r.kw_score, r.final_score,
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
    final_score: number;
    feedback: string | null;
  }>;

  return rows.map((r) => ({
    cardPath: r.card_path,
    title: r.title,
    track: r.track,
    semScore: r.sem_score,
    kwScore: r.kw_score,
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
