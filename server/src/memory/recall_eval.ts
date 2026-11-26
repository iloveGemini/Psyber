import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import YAML from "yaml";
import { addCalendarDays, localDay, VirtualClock } from "../core/clock.ts";
import { DEFAULT_CIRCADIAN_CONFIG, type RecallConfig } from "../core/config.ts";
import { openDatabase, runMigrations } from "../core/db.ts";
import {
  sanitizeUnicode,
  type DecisionClient,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResponse,
} from "../core/decision.ts";
import type { EmbeddingClient, EmbeddingOptions } from "../core/embedding.ts";
import type { RerankerClient, RerankerOptions, RerankItem } from "../core/reranker.ts";
import { stripFrontmatter } from "../core/prompts.ts";
import { effectiveStatus } from "./frontmatter.ts";
import { MemoryIndex, type CardIndexRow } from "./index.ts";
import { recallMemories, type RecallResult } from "./recall.ts";

export type MomentClass = "callback" | "continuation" | "resonance" | "quiet" | "fresh";

export const MOMENT_CLASSES: readonly MomentClass[] = [
  "callback",
  "continuation",
  "resonance",
  "quiet",
  "fresh",
];

export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ReplayTurn {
  turnId: string;
  eventId: string;
  seq: number;
  sessionId: string;
  day: string;
  createdAt: number;
  userText: string;
  recentTurns: TurnMessage[];
  futureTurns: TurnMessage[];
  snapshotCommit: string;
}

export interface ClassifiedMoment extends ReplayTurn {
  momentClass: MomentClass;
  confidence: number;
  probs: Record<string, number>;
  needsMemoryPrior: number;
}

export interface GoldCandidate {
  path: string;
  title: string;
  space: string;
  grade: 0 | 1 | 2;
  /** 模型给出的 2 分概率或期望分，用于挑选临界抽查样本 */
  gradeConfidence: number;
  sources: string[];
  reviewed?: boolean;
}

export interface GoldRecord {
  turnId: string;
  seq: number;
  day: string;
  createdAt: number;
  sessionId: string;
  snapshotCommit: string;
  userText: string;
  recentTurns: TurnMessage[];
  futureTurns: TurnMessage[];
  momentClass: MomentClass;
  momentConfidence: number;
  momentReviewed?: boolean;
  candidates: GoldCandidate[];
  /** callback/continuation 但全池无 >=1 分卡，疑似整理轮未写卡 */
  missingMemorySuspected: boolean;
}

export interface EvalVariantSpec {
  name: string;
  recallConfig?: Partial<RecallConfig>;
  useDecisionClient?: boolean;
  useEmbeddingClient?: boolean;
  useRerankerClient?: boolean;
  /** 若不传则使用默认 recallMemories */
  runner?: (ctx: {
    db: Database;
    dataDir: string;
    index: MemoryIndex;
    clock: VirtualClock;
    record: GoldRecord;
    decisionClient?: DecisionClient;
    embeddingClient?: EmbeddingClient;
    rerankerClient?: RerankerClient;
    promptsDir?: string;
  }) => Promise<RecallResult & { timedOut?: boolean }>;
}

export interface EvalTurnOutcome {
  turnId: string;
  day: string;
  momentClass: MomentClass;
  skipped: boolean;
  timedOut: boolean;
  latencyMs: number;
  recalledPaths: string[];
  injectedChars: number;
  grades: number[];
  maxGoldGrade: number;
  missingMemorySuspected: boolean;
}

export interface EvalReport {
  variant: string;
  generatedAt: string;
  totalTurns: number;
  countsByClass: Record<MomentClass, number>;
  metrics: {
    quietFalseRecallRate: number;
    quietCount: number;
    /** quiet + fresh 合并误召率（两类均为「不该翻旧账」时刻） */
    noRecallFalseRate: number;
    noRecallCount: number;
    callbackContMissRate: number;
    callbackContHitAt5: number;
    callbackContEvaluated: number;
    callbackContMissingMemoryCount: number;
    resonanceNdcgAt5: number;
    resonanceEvaluated: number;
    noiseRate: number;
    totalInjectedCards: number;
    totalNoiseCards: number;
    avgInjectedChars: number;
    latencyP50Ms: number;
    latencyP90Ms: number;
    timeoutFallbacks: number;
  };
  turns: EvalTurnOutcome[];
}

// ---------------------------------------------------------------------------
// 磁盘持久化决策缓存（按 input + questions 的 SHA-256 键缓存，避免重复花额度）
// ---------------------------------------------------------------------------

interface CacheEntry {
  key: string;
  response: DecisionResponse;
  latencyMs: number;
  cachedAt: string;
}

export class CachedDecisionClient implements DecisionClient {
  private readonly cache = new Map<string, CacheEntry>();
  private loaded = false;
  public hits = 0;
  public misses = 0;

  constructor(
    private readonly inner: DecisionClient,
    private readonly cachePath: string,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.cachePath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as CacheEntry;
          if (entry?.key && entry?.response) {
            this.cache.set(entry.key, entry);
          }
        } catch {
          // 忽略损坏行
        }
      }
    } catch {
      // 首次无缓存文件
    }
  }

  private hashRequest(req: DecisionRequest): string {
    const sortedQuestions: Record<string, DecisionQuestion> = {};
    for (const k of Object.keys(req.questions).sort()) {
      sortedQuestions[k] = req.questions[k];
    }
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ input: req.input, questions: sortedQuestions }))
      .digest("hex");
  }

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    await this.ensureLoaded();
    const key = this.hashRequest(req);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      return cached.response;
    }

    this.misses++;
    const t0 = performance.now();
    let response: DecisionResponse | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        response = await this.inner.decide(req);
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // 离线评测批跑遇到 429 限流时自动按提示等待重试
        if (msg.includes("429") || msg.includes("too_many_requests")) {
          const secMatch = /retry in\s+(\d+)\s*s/i.exec(msg);
          const waitMs = (secMatch ? Number(secMatch[1]) + 2 : (attempt + 1) * 15) * 1000;
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw err;
      }
    }
    if (!response) throw lastErr;
    const latencyMs = Math.round(performance.now() - t0);
    const entry: CacheEntry = {
      key,
      response,
      latencyMs,
      cachedAt: new Date().toISOString(),
    };
    this.cache.set(key, entry);
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.appendFile(this.cachePath, JSON.stringify(entry) + "\n", "utf8");
    return response;
  }
}

interface EmbeddingCacheEntry {
  key: string;
  dim: number;
  b64: string;
  cachedAt: string;
}

/**
 * 磁盘持久化向量缓存（按 modelKey + taskType + text 的 SHA-256 键缓存，
 * 避免跨快照/跨阈值重复请求向量模型，自动处理 429/5xx 瞬时退避重试）。
 */
export class CachedEmbeddingClient implements EmbeddingClient {
  private readonly cache = new Map<string, Float32Array>();
  private loadPromise: Promise<void> | null = null;
  public hits = 0;
  public misses = 0;

  constructor(
    private readonly inner: EmbeddingClient,
    private readonly cachePath: string,
  ) {}

  get modelKey(): string {
    return this.inner.modelKey;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured ? this.inner.isConfigured() : true;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.cachePath, "utf8");
          for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line) as EmbeddingCacheEntry;
              if (entry?.key && entry?.b64 && entry?.dim > 0) {
                const buf = Buffer.from(entry.b64, "base64");
                if (buf.byteLength === entry.dim * 4) {
                  const vec = new Float32Array(entry.dim);
                  new Uint8Array(vec.buffer).set(buf);
                  this.cache.set(entry.key, vec);
                }
              }
            } catch {
              // 忽略损坏行
            }
          }
        } catch {
          // 首次无缓存文件
        }
      })();
    }
    return this.loadPromise;
  }

  private hashText(text: string, opts?: EmbeddingOptions): string {
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          modelKey: this.inner.modelKey,
          taskType: opts?.taskType ?? "default",
          text,
        }),
      )
      .digest("hex");
  }

  private async sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Aborted during retry backoff");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted during retry backoff"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async callWithRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal?.aborted) {
        throw lastErr ?? new Error("Aborted");
      }
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("429") ||
          msg.includes("too_many_requests") ||
          msg.includes("HTTP 502") ||
          msg.includes("HTTP 503") ||
          msg.includes("HTTP 504")
        ) {
          const secMatch = /retry in\s+(\d+)\s*s/i.exec(msg);
          const waitMs = (secMatch ? Number(secMatch[1]) + 2 : (attempt + 1) * 8) * 1000;
          await this.sleepAbortable(waitMs, signal);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async embed(text: string, opts?: EmbeddingOptions): Promise<Float32Array> {
    const [vec] = await this.embedBatch([text], opts);
    return vec;
  }

  async embedBatch(texts: string[], opts?: EmbeddingOptions): Promise<Float32Array[]> {
    await this.ensureLoaded();
    const out = new Array<Float32Array>(texts.length);
    const missIndices: number[] = [];
    const missKeys: string[] = [];
    const missTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const key = this.hashText(texts[i], opts);
      const cached = this.cache.get(key);
      if (cached) {
        this.hits++;
        out[i] = cached;
      } else {
        this.misses++;
        missIndices.push(i);
        missKeys.push(key);
        missTexts.push(texts[i]);
      }
    }

    if (missTexts.length > 0) {
      const computed = await this.callWithRetry(async () => {
        if (this.inner.embedBatch) {
          return this.inner.embedBatch(missTexts, opts);
        }
        const res: Float32Array[] = [];
        for (const t of missTexts) {
          res.push(await this.inner.embed(t, opts));
        }
        return res;
      }, opts?.signal);

      if (computed.length !== missIndices.length) {
        throw new Error(
          `Embedding client returned ${computed.length} vectors for ${missIndices.length} inputs`,
        );
      }

      const lines: string[] = [];
      const nowIso = new Date().toISOString();
      for (let j = 0; j < missIndices.length; j++) {
        const vec = computed[j];
        const idx = missIndices[j];
        const key = missKeys[j];
        out[idx] = vec;
        this.cache.set(key, vec);
        const b64 = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
        const entry: EmbeddingCacheEntry = { key, dim: vec.length, b64, cachedAt: nowIso };
        lines.push(JSON.stringify(entry));
      }
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      await fs.appendFile(this.cachePath, lines.join("\n") + "\n", "utf8");
    }

    return out;
  }
}

interface RerankCacheEntry {
  key: string;
  results: RerankItem[];
  cachedAt: string;
}

/**
 * 磁盘持久化精排缓存（按 modelKey + query + documents 的 SHA-256 键缓存，
 * 避免跨阈值扫描重复请求 Reranker API，自动处理 429/5xx 瞬时退避重试）。
 */
export class CachedRerankerClient implements RerankerClient {
  private readonly cache = new Map<string, RerankItem[]>();
  private loadPromise: Promise<void> | null = null;
  public hits = 0;
  public misses = 0;

  constructor(
    private readonly inner: RerankerClient,
    private readonly cachePath: string,
  ) {}

  get modelKey(): string {
    return this.inner.modelKey;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured ? this.inner.isConfigured() : true;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.cachePath, "utf8");
          for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line) as RerankCacheEntry;
              if (entry?.key && Array.isArray(entry.results)) {
                this.cache.set(entry.key, entry.results);
              }
            } catch {
              // 忽略损坏行
            }
          }
        } catch {
          // 首次无缓存文件
        }
      })();
    }
    return this.loadPromise;
  }

  private hashRequest(query: string, documents: string[]): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ modelKey: this.inner.modelKey, query, documents }))
      .digest("hex");
  }

  async rerank(query: string, documents: string[], opts?: RerankerOptions): Promise<RerankItem[]> {
    if (documents.length === 0) return [];
    await this.ensureLoaded();
    const key = this.hashRequest(query, documents);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      return opts?.topN ? cached.slice(0, opts.topN) : cached;
    }

    this.misses++;
    let results: RerankItem[] | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (opts?.signal?.aborted) {
        throw lastErr ?? new Error("Aborted");
      }
      try {
        results = await this.inner.rerank(query, documents, { signal: opts?.signal });
        break;
      } catch (err) {
        lastErr = err;
        if (opts?.signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("429") ||
          msg.includes("too_many_requests") ||
          msg.includes("HTTP 502") ||
          msg.includes("HTTP 503") ||
          msg.includes("HTTP 504")
        ) {
          const secMatch = /retry in\s+(\d+)\s*s/i.exec(msg);
          const waitMs = (secMatch ? Number(secMatch[1]) + 2 : (attempt + 1) * 8) * 1000;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              opts?.signal?.removeEventListener("abort", onAbort);
              resolve();
            }, waitMs);
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error("Aborted during rerank retry backoff"));
            };
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
          });
          continue;
        }
        throw err;
      }
    }
    if (!results) throw lastErr;

    this.cache.set(key, results);
    const entry: RerankCacheEntry = { key, results, cachedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.appendFile(this.cachePath, JSON.stringify(entry) + "\n", "utf8");
    return opts?.topN ? results.slice(0, opts.topN) : results;
  }
}

// ---------------------------------------------------------------------------
// 时间切片快照池（严格只读源库，检出历史 commit 至临时目录并重建临时索引）
// ---------------------------------------------------------------------------

interface GitCommitInfo {
  hash: string;
  epochMs: number;
  subject: string;
}

function runGitReadOnly(memoryDir: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", memoryDir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${err}`);
  }
  return new TextDecoder().decode(proc.stdout);
}

export async function resolveDaySnapshotCommits(dataDir: string): Promise<{
  commits: GitCommitInfo[];
  dayToCommit: Map<string, string>;
}> {
  const memoryDir = path.join(dataDir, "memory");
  const rawLog = runGitReadOnly(memoryDir, ["log", "--reverse", "--format=%H|%ct|%s"]);
  const commits: GitCommitInfo[] = rawLog
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, secStr, ...rest] = line.split("|");
      return {
        hash,
        epochMs: Number(secStr) * 1000,
        subject: rest.join("|"),
      };
    });

  const dayToCommit = new Map<string, string>();
  const statePath = path.join(dataDir, "replay_state.json");
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      results?: Record<string, { importedAt?: string }>;
    };
    if (state?.results && commits.length > 0) {
      for (const [day, info] of Object.entries(state.results)) {
        const importedMs = info?.importedAt ? Date.parse(info.importedAt) : Number.NaN;
        if (!Number.isFinite(importedMs)) continue;
        // 严格取该日导入之前最后一次 commit，杜绝穿越到当日或未来整理结果
        let chosen = commits[0].hash;
        for (const c of commits) {
          if (c.epochMs < importedMs) {
            chosen = c.hash;
          } else {
            break;
          }
        }
        dayToCommit.set(day, chosen);
      }
    }
  } catch {
    // 非 replay 目录无 replay_state.json，后续按事件时间戳回落
  }

  return { commits, dayToCommit };
}

export interface SnapshotContext {
  commit: string;
  tempDataDir: string;
  db: Database;
  clock: VirtualClock;
  index: MemoryIndex;
}

export class SnapshotPool {
  private readonly snapshots = new Map<string, SnapshotContext>();
  private readonly rootTempDir: string;
  private readonly sourceMemoryDir: string;

  constructor(
    private readonly sourceDataDir: string,
    private readonly timeZone: string,
  ) {
    this.sourceMemoryDir = path.join(sourceDataDir, "memory");
    this.rootTempDir = path.join(os.tmpdir(), `psyber-recall-eval-${crypto.randomUUID()}`);
  }

  async getSnapshot(commit: string, atEpochMs: number): Promise<SnapshotContext> {
    const existing = this.snapshots.get(commit);
    if (existing) {
      existing.clock.setTime(atEpochMs);
      return existing;
    }

    const tempDataDir = path.join(this.rootTempDir, commit.slice(0, 12));
    const tempMemDir = path.join(tempDataDir, "memory");
    await fs.mkdir(tempMemDir, { recursive: true });

    // 使用 git archive 导出只读快照，不触碰源 memory/ 工作区
    const tarProc = Bun.spawnSync(["git", "-C", this.sourceMemoryDir, "archive", commit], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tarProc.exitCode !== 0) {
      throw new Error(
        `git archive ${commit} failed: ${new TextDecoder().decode(tarProc.stderr).trim()}`,
      );
    }
    const untar = Bun.spawnSync(["tar", "-x", "-C", tempMemDir], {
      stdin: tarProc.stdout,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (untar.exitCode !== 0) {
      throw new Error(`tar extract failed: ${new TextDecoder().decode(untar.stderr).trim()}`);
    }

    const db = openDatabase(":memory:");
    const clock = new VirtualClock(atEpochMs, this.timeZone);
    runMigrations(db, atEpochMs);
    const index = new MemoryIndex(db, tempDataDir, clock);
    await index.reindexAll();

    const ctx: SnapshotContext = { commit, tempDataDir, db, clock, index };
    this.snapshots.set(commit, ctx);
    return ctx;
  }

  /** 清空快照临时 DB 中的 recall_traces，保证不同变体间去重互不干扰 */
  resetTraces(): void {
    for (const snap of this.snapshots.values()) {
      snap.db.run("DELETE FROM recall_traces");
      snap.db.run("DELETE FROM events");
    }
  }

  async cleanup(): Promise<void> {
    for (const snap of this.snapshots.values()) {
      try {
        snap.db.close();
      } catch {
        // ignore
      }
    }
    this.snapshots.clear();
    await fs.rm(this.rootTempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 通用辅助：读取只读事件、格式化对话窗口、并发池、确定性洗牌
// ---------------------------------------------------------------------------

function clipText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return sanitizeUnicode(trimmed);
  return sanitizeUnicode(trimmed.slice(0, Math.max(20, maxChars - 1)) + "…");
}

export function formatConversationWindow(
  recentTurns: TurnMessage[],
  userText: string,
  maxTurnChars = 240,
): string {
  const lines: string[] = [];
  for (const m of recentTurns) {
    lines.push(`${m.role}: ${clipText(m.content, maxTurnChars)}`);
  }
  lines.push(`user: ${clipText(userText, maxTurnChars * 2)}`);
  return lines.join("\n");
}

function buildWindowFtsQuery(recentTurns: TurnMessage[], userText: string): string {
  const recentUser = recentTurns
    .slice(-2)
    .map((m) => clipText(m.content, 120))
    .join(" ");
  return `${recentUser} ${userText}`.trim();
}

function listRecallableRows(index: MemoryIndex, nowMs: number): CardIndexRow[] {
  return index.listAllRows().filter((r) => {
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
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicShuffle<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

export async function writeJsonl<T>(filePath: string, items: readonly T[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = items.map((x) => JSON.stringify(x)).join("\n") + (items.length > 0 ? "\n" : "");
  await fs.writeFile(filePath, body, "utf8");
}

// ---------------------------------------------------------------------------
// Stage 1: 提取回放轮次并做五类聊天时刻分类（prepare）
// ---------------------------------------------------------------------------

/**
 * 按作息逻辑日（对齐 replay.ts groupByLogicalNight）：
 * 凌晨 00:00 至 sleepEnd（默认 07:30）之间的熬夜对话归入前一逻辑日，
 * 避免评测时误检出当晚整理完成后的未来快照导致「时间穿越卡」泄漏。
 */
export function resolveLogicalNightDay(
  epochMs: number,
  timeZone: string,
  sessionId?: string,
  dayToCommit?: Map<string, string>,
  sleepEnd = DEFAULT_CIRCADIAN_CONFIG.sleepEnd,
): string {
  // 若 sessionId 带有 replay 写入的精确逻辑日后缀（含跨 sleepEnd 连续聊天的顺延），优先采用
  if (sessionId && dayToCommit) {
    const m = /(\d{4}-\d{2}-\d{2})$/.exec(sessionId);
    if (m && dayToCommit.has(m[1])) {
      return m[1];
    }
  }
  const calDay = localDay(epochMs, timeZone);
  const [endH, endM] = sleepEnd.split(":").map((x) => Number(x));
  const cutoffMin = (Number.isFinite(endH) ? endH : 7) * 60 + (Number.isFinite(endM) ? endM : 30);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm < cutoffMin ? addCalendarDays(calDay, -1) : calDay;
}

export async function extractReplayTurns(
  dataDir: string,
  timeZone: string,
  opts: { recentCount?: number; futureCount?: number; sleepEnd?: string } = {},
): Promise<ReplayTurn[]> {
  const recentCount = opts.recentCount ?? 4;
  const futureCount = opts.futureCount ?? 4;
  const sleepEnd = opts.sleepEnd ?? DEFAULT_CIRCADIAN_CONFIG.sleepEnd;
  const { commits, dayToCommit } = await resolveDaySnapshotCommits(dataDir);
  if (commits.length === 0) {
    throw new Error(`No git commits found in ${path.join(dataDir, "memory")}`);
  }

  const dbPath = path.join(dataDir, "psyber.sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT id, seq, session_id, turn_id, role, kind, content, created_at
         FROM events
         WHERE status = 'active' AND kind = 'chat' AND role IN ('user', 'assistant')
         ORDER BY seq ASC`,
      )
      .all() as Array<{
      id: string;
      seq: number;
      session_id: string;
      turn_id: string | null;
      role: "user" | "assistant";
      kind: string;
      content: string;
      created_at: number;
    }>;

    const turns: ReplayTurn[] = [];
    for (let i = 0; i < rows.length; i++) {
      const ev = rows[i];
      if (ev.role !== "user" || !ev.content.trim()) continue;

      const day = resolveLogicalNightDay(ev.created_at, timeZone, ev.session_id, dayToCommit, sleepEnd);
      let snapshotCommit = dayToCommit.get(day);
      if (!snapshotCommit) {
        snapshotCommit = commits[0].hash;
        for (const c of commits) {
          if (c.epochMs <= ev.created_at) {
            snapshotCommit = c.hash;
          } else {
            break;
          }
        }
      }

      const recentTurns: TurnMessage[] = [];
      for (let j = Math.max(0, i - recentCount); j < i; j++) {
        if (rows[j].session_id === ev.session_id) {
          recentTurns.push({ role: rows[j].role, content: rows[j].content });
        }
      }

      const futureTurns: TurnMessage[] = [];
      for (let j = i + 1; j < Math.min(rows.length, i + 1 + futureCount); j++) {
        if (rows[j].session_id === ev.session_id) {
          futureTurns.push({ role: rows[j].role, content: rows[j].content });
        }
      }

      turns.push({
        turnId: ev.turn_id ?? `ev-${ev.id}`,
        eventId: ev.id,
        seq: ev.seq,
        sessionId: ev.session_id,
        day,
        createdAt: ev.created_at,
        userText: ev.content,
        recentTurns,
        futureTurns,
        snapshotCommit,
      });
    }
    return turns;
  } finally {
    db.close();
  }
}

export async function prepareMoments(opts: {
  dataDir: string;
  timeZone: string;
  decisionClient: DecisionClient;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<ClassifiedMoment[]> {
  const allTurns = await extractReplayTurns(opts.dataDir, opts.timeZone);
  const pool = new SnapshotPool(opts.dataDir, opts.timeZone);

  try {
    // 过滤掉快照里尚无任何可召回卡片的轮次（如创世第一天）
    const eligible: ReplayTurn[] = [];
    const cardCountByCommit = new Map<string, number>();
    for (const t of allTurns) {
      let count = cardCountByCommit.get(t.snapshotCommit);
      if (count === undefined) {
        const snap = await pool.getSnapshot(t.snapshotCommit, t.createdAt);
        count = listRecallableRows(snap.index, t.createdAt).length;
        cardCountByCommit.set(t.snapshotCommit, count);
      }
      if (count > 0) {
        eligible.push(t);
      }
    }

    let done = 0;
    const classified = await mapWithConcurrency(
      eligible,
      opts.concurrency ?? 6,
      async (turn): Promise<ClassifiedMoment> => {
        const input = [
          "<conversation>",
          formatConversationWindow(turn.recentTurns.slice(-2), turn.userText, 120),
          "</conversation>",
        ].join("\n");

        const res = await opts.decisionClient.decide({
          input,
          questions: {
            moment_class: {
              type: "choice",
              instructions: "判断最后一条用户消息在长期陪伴聊天中属于哪一类记忆需求时刻？",
              criteria: {
                callback: "明确回指过去聊过的事、人、约定、故事细节或旧问题（例如：还记得、上次那个、之前说的）",
                continuation: "正在延续或切回一个之前进行过的长期线索、共同活动、系列故事或未完话题",
                resonance: "未明说回指，但话题与过往经历、偏好、教训或旧事有潜在关联，想起来能让回复更有深度",
                quiet: "当下闲聊、情绪宣泄、客套寒暄、简短回应或专注眼前的互动，此时翻旧账反而出戏",
                fresh: "开启一个全新话题或具体当下问题，与过往对话无明显关联",
              },
            },
            needs_memory: {
              type: "noul",
              instructions: "要自然接好最后一条用户消息，是否需要参考过往长期记忆？",
            },
          },
        });

        const rawChoice = res.answers.moment_class?.choice ?? "fresh";
        const momentClass: MomentClass = (MOMENT_CLASSES as readonly string[]).includes(rawChoice)
          ? (rawChoice as MomentClass)
          : "fresh";
        const confidence = res.answers.moment_class?.confidence ?? 0.5;
        const probs = res.answers.moment_class?.probabilities ?? {};
        const needsMemoryPrior = res.answers.needs_memory?.noul ?? 0.5;

        done++;
        opts.onProgress?.(done, eligible.length);
        return {
          ...turn,
          momentClass,
          confidence,
          probs,
          needsMemoryPrior,
        };
      },
    );

    const outPath = path.join(opts.dataDir, "eval", "moments.jsonl");
    await writeJsonl(outPath, classified);
    return classified;
  } finally {
    await pool.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Stage 2: 分层抽样 + 多路/全目录候选池 + 事后上下文 0/1/2 打分 + 生成 review.md
// ---------------------------------------------------------------------------

export function stratifiedSampleMoments(
  moments: readonly ClassifiedMoment[],
  sampleSize: number,
  seed = 20261125,
): ClassifiedMoment[] {
  if (moments.length <= sampleSize) return [...moments];

  const byClass = new Map<MomentClass, ClassifiedMoment[]>();
  for (const cls of MOMENT_CLASSES) byClass.set(cls, []);
  for (const m of moments) {
    byClass.get(m.momentClass)?.push(m);
  }
  for (const cls of MOMENT_CLASSES) {
    byClass.set(cls, deterministicShuffle(byClass.get(cls) ?? [], seed + cls.length * 31));
  }

  const picked: ClassifiedMoment[] = [];
  const pickedIds = new Set<string>();
  const baseQuota = Math.floor(sampleSize / MOMENT_CLASSES.length);

  for (const cls of MOMENT_CLASSES) {
    const bucket = byClass.get(cls) ?? [];
    for (const m of bucket.slice(0, baseQuota)) {
      picked.push(m);
      pickedIds.add(m.turnId);
    }
  }

  // 不足部分从剩余样本按轮询补齐
  const leftovers = deterministicShuffle(
    moments.filter((m) => !pickedIds.has(m.turnId)),
    seed + 997,
  );
  for (const m of leftovers) {
    if (picked.length >= sampleSize) break;
    picked.push(m);
    pickedIds.add(m.turnId);
  }

  return picked.sort((a, b) => a.seq - b.seq);
}

async function poolCandidatesForTurn(opts: {
  snap: SnapshotContext;
  turn: ClassifiedMoment;
  decisionClient: DecisionClient;
}): Promise<Map<string, { row: CardIndexRow; sources: Set<string>; catalogScore: number }>> {
  const { snap, turn, decisionClient } = opts;
  const nowMs = turn.createdAt;
  const activeRows = listRecallableRows(snap.index, nowMs);
  const byPath = new Map<string, CardIndexRow>(activeRows.map((r) => [r.path, r]));

  const pool = new Map<string, { row: CardIndexRow; sources: Set<string>; catalogScore: number }>();
  const add = (p: string, source: string, catalogScore = 0) => {
    const row = byPath.get(p);
    if (!row) return;
    const existing = pool.get(p);
    if (existing) {
      existing.sources.add(source);
      existing.catalogScore = Math.max(existing.catalogScore, catalogScore);
    } else {
      pool.set(p, { row, sources: new Set([source]), catalogScore });
    }
  };

  // 1) 当前句 FTS
  for (const h of snap.index.searchFts(turn.userText, 10)) {
    add(h.path, "fts_current");
  }

  // 2) 查询窗口 FTS
  const winQuery = buildWindowFtsQuery(turn.recentTurns, turn.userText);
  if (winQuery !== turn.userText) {
    for (const h of snap.index.searchFts(winQuery, 10)) {
      add(h.path, "fts_window");
    }
  }

  // 3) 线索触发词直挂
  try {
    const regText = await fs.readFile(
      path.join(snap.tempDataDir, "memory", "threads/REGISTRY.yaml"),
      "utf8",
    );
    const parsed = YAML.parse(regText) as { spaces?: Record<string, { triggers?: string[] }> };
    for (const [slug, cfg] of Object.entries(parsed?.spaces ?? {})) {
      const triggers = Array.isArray(cfg?.triggers) ? cfg.triggers.map(String) : [];
      if (triggers.some((t) => t && winQuery.includes(t))) {
        const spaceKey = `thread:${slug}`;
        for (const r of activeRows.filter((x) => x.space === spaceKey).slice(0, 4)) {
          add(r.path, "thread_trigger");
        }
      }
    }
  } catch {
    // 无 REGISTRY.yaml
  }

  // 4) 近 72h 日常
  for (const r of activeRows
    .filter((x) => x.space === "episodes" && x.created_at >= nowMs - 72 * 3_600_000)
    .slice(0, 3)) {
    add(r.path, "daily_recent");
  }

  // 5) 全卡目录扫描（单次并行提问最多 250 张活跃卡的 title + when_to_recall，专兜 FTS 漏召卡）
  const BATCH_SIZE = 250;
  const convBlock = [
    "<conversation>",
    formatConversationWindow(turn.recentTurns.slice(-2), turn.userText, 140),
    "</conversation>",
    turn.futureTurns.length > 0
      ? `<what_happened_next>\n${turn.futureTurns
          .slice(0, 2)
          .map((m) => `${m.role}: ${clipText(m.content, 140)}`)
          .join("\n")}\n</what_happened_next>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const catalogScored: Array<{ path: string; score: number }> = [];
  for (let start = 0; start < activeRows.length; start += BATCH_SIZE) {
    const slice = activeRows.slice(start, start + BATCH_SIZE);
    const lines = slice.map((r, idx) => {
      const cid = `c${idx}`;
      const hint = r.when_to_recall ? `|${clipText(r.when_to_recall, 45)}` : "";
      return `[${cid}] ${clipText(r.title, 32)}${hint}`;
    });
    const questions: Record<string, DecisionQuestion> = {};
    for (let idx = 0; idx < slice.length; idx++) {
      questions[`c${idx}`] = {
        type: "noul",
        instructions: `[c${idx}] 与当前对话有实质关联、值得想起？`,
      };
    }

    const res = await decisionClient.decide({
      input: `${convBlock}\n<memory_catalog>\n${lines.join("\n")}\n</memory_catalog>`,
      questions,
    });

    for (let idx = 0; idx < slice.length; idx++) {
      const prob = res.answers[`c${idx}`]?.noul ?? 0;
      if (prob >= 0.35) {
        catalogScored.push({ path: slice[idx].path, score: prob });
      }
    }
  }

  catalogScored.sort((a, b) => b.score - a.score);
  for (const item of catalogScored.slice(0, 10)) {
    add(item.path, "catalog_scan", item.score);
  }

  return pool;
}

async function gradeCandidatesForTurn(opts: {
  snap: SnapshotContext;
  turn: ClassifiedMoment;
  pool: Map<string, { row: CardIndexRow; sources: Set<string>; catalogScore: number }>;
  decisionClient: DecisionClient;
  maxCandidates?: number;
}): Promise<GoldCandidate[]> {
  const { snap, turn, pool, decisionClient } = opts;
  const maxCandidates = opts.maxCandidates ?? 10;

  // 优先保留目录高分与多路同时命中的卡片
  const entries = Array.from(pool.values())
    .sort((a, b) => {
      const scoreA = a.catalogScore * 2 + a.sources.size * 0.4;
      const scoreB = b.catalogScore * 2 + b.sources.size * 0.4;
      return scoreB - scoreA;
    })
    .slice(0, maxCandidates);

  if (entries.length === 0) return [];

  const convBlock = [
    "<conversation>",
    formatConversationWindow(turn.recentTurns.slice(-2), turn.userText, 160),
    "</conversation>",
    turn.futureTurns.length > 0
      ? `<what_happened_next>\n${turn.futureTurns
          .slice(0, 2)
          .map((m) => `${m.role}: ${clipText(m.content, 160)}`)
          .join("\n")}\n</what_happened_next>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const graded: GoldCandidate[] = [];
  const GRADE_BATCH = 10;

  for (let start = 0; start < entries.length; start += GRADE_BATCH) {
    const slice = entries.slice(start, start + GRADE_BATCH);
    const cardBlocks: string[] = [];
    const questions: Record<string, DecisionQuestion> = {};

    for (let i = 0; i < slice.length; i++) {
      const item = slice[i];
      let body = "";
      try {
        const raw = await fs.readFile(path.join(snap.tempDataDir, "memory", item.row.path), "utf8");
        body = clipText(stripFrontmatter(raw), 360);
      } catch {
        body = "(无法读取正文)";
      }
      cardBlocks.push(
        `[k${i}] ${item.row.path} | 标题：${item.row.title} | 何时想起：${item.row.when_to_recall ?? "无"}\n正文：${body}`,
      );
      questions[`k${i}`] = {
        type: "choice",
        instructions: `只看事实出处与话题关联，判断候选卡片 [k${i}] 对接好最后一条用户消息（结合后续对话佐证）的相关程度：`,
        criteria: {
          "0": "无关：与当前对话无实质关联，塞进去属于噪声或硬翻旧账",
          "1": "有点相关：提供有用的背景、相似主题或值得顺带想到的教训，但非必须",
          "2": "直接相关：直接回应回指、延续同一线索、或对当前话题有核心事实支撑",
        },
      };
    }

    const res = await decisionClient.decide({
      input: `${convBlock}\n<candidate_cards>\n${cardBlocks.join("\n\n")}\n</candidate_cards>`,
      questions,
    });

    for (let i = 0; i < slice.length; i++) {
      const item = slice[i];
      const ans = res.answers[`k${i}`];
      const rawChoice = ans?.choice ?? "0";
      const grade: 0 | 1 | 2 = rawChoice === "2" ? 2 : rawChoice === "1" ? 1 : 0;
      const gradeConfidence = ans?.confidence ?? 0.5;
      graded.push({
        path: item.row.path,
        title: item.row.title,
        space: item.row.space,
        grade,
        gradeConfidence,
        sources: Array.from(item.sources).sort(),
      });
    }
  }

  return graded.sort((a, b) => b.grade - a.grade || b.gradeConfidence - a.gradeConfidence);
}

export async function buildAndGradeGold(opts: {
  dataDir: string;
  timeZone: string;
  decisionClient: DecisionClient;
  sampleSize?: number;
  reviewCount?: number;
  seed?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ gold: GoldRecord[]; reviewPath: string }> {
  const momentsPath = path.join(opts.dataDir, "eval", "moments.jsonl");
  const moments = await readJsonl<ClassifiedMoment>(momentsPath);
  const sampled = stratifiedSampleMoments(moments, opts.sampleSize ?? 180, opts.seed ?? 20261125);

  const pool = new SnapshotPool(opts.dataDir, opts.timeZone);
  try {
    // 预热所有涉及的快照，避免并发提取同一 commit
    const uniqueCommits = new Map<string, number>();
    for (const m of sampled) {
      if (!uniqueCommits.has(m.snapshotCommit)) {
        uniqueCommits.set(m.snapshotCommit, m.createdAt);
      }
    }
    for (const [commit, atMs] of uniqueCommits.entries()) {
      await pool.getSnapshot(commit, atMs);
    }

    let done = 0;
    const gold = await mapWithConcurrency(
      sampled,
      opts.concurrency ?? 4,
      async (turn): Promise<GoldRecord> => {
        const snap = await pool.getSnapshot(turn.snapshotCommit, turn.createdAt);
        const candPool = await poolCandidatesForTurn({
          snap,
          turn,
          decisionClient: opts.decisionClient,
        });
        const candidates = await gradeCandidatesForTurn({
          snap,
          turn,
          pool: candPool,
          decisionClient: opts.decisionClient,
        });
        const maxGrade = candidates.reduce((acc, c) => Math.max(acc, c.grade), 0);
        const missingMemorySuspected =
          (turn.momentClass === "callback" || turn.momentClass === "continuation") && maxGrade === 0;

        done++;
        opts.onProgress?.(done, sampled.length);
        return {
          turnId: turn.turnId,
          seq: turn.seq,
          day: turn.day,
          createdAt: turn.createdAt,
          sessionId: turn.sessionId,
          snapshotCommit: turn.snapshotCommit,
          userText: turn.userText,
          recentTurns: turn.recentTurns,
          futureTurns: turn.futureTurns,
          momentClass: turn.momentClass,
          momentConfidence: turn.confidence,
          candidates,
          missingMemorySuspected,
        };
      },
    );

    gold.sort((a, b) => a.seq - b.seq);
    const goldPath = path.join(opts.dataDir, "eval", "gold.jsonl");
    await writeJsonl(goldPath, gold);

    const reviewPath = path.join(opts.dataDir, "eval", "review.md");
    await writeReviewMarkdown(reviewPath, gold, opts.reviewCount ?? 50);
    return { gold, reviewPath };
  } finally {
    await pool.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 人工抽查清单 review.md 生成与应用
// ---------------------------------------------------------------------------

function reviewPriorityScore(rec: GoldRecord): number {
  const maxGrade = rec.candidates.reduce((m, c) => Math.max(m, c.grade), 0);
  let score = 0;
  // 强烈分歧优先：quiet/fresh 却标出了 2 分卡
  if ((rec.momentClass === "quiet" || rec.momentClass === "fresh") && maxGrade === 2) score += 100;
  // 强烈分歧优先：callback/continuation 却没找到任何相关卡
  if (rec.missingMemorySuspected) score += 90;
  // 分类本身信心低（临界样本）
  score += Math.round((1 - rec.momentConfidence) * 40);
  // 有 1 分卡或低信心判分
  if (rec.candidates.some((c) => c.grade === 1)) score += 15;
  if (rec.candidates.some((c) => c.gradeConfidence < 0.65)) score += 10;
  return score;
}

export async function writeReviewMarkdown(
  reviewPath: string,
  gold: readonly GoldRecord[],
  reviewCount = 50,
): Promise<void> {
  const selected = [...gold]
    .sort((a, b) => reviewPriorityScore(b) - reviewPriorityScore(a))
    .slice(0, reviewCount);

  const lines: string[] = [
    "# 召回评测人工抽查单",
    "",
    "> 用法：直接修改 `[moment: ...]`（可选 `callback | continuation | resonance | quiet | fresh`）",
    "> 或修改每张卡行的 `[grade: 0|1|2]`，保存后运行 `bun run eval:recall-replay --data-dir <dir> apply-review` 写回 `gold.jsonl`。",
    `> 本单共精选 ${selected.length} 条（优先排布分歧样本与临界样本）。`,
    "",
  ];

  for (let i = 0; i < selected.length; i++) {
    const rec = selected[i];
    const flags: string[] = [];
    if (rec.missingMemorySuspected) flags.push("疑似整理轮漏写卡");
    const maxGrade = rec.candidates.reduce((m, c) => Math.max(m, c.grade), 0);
    if ((rec.momentClass === "quiet" || rec.momentClass === "fresh") && maxGrade === 2) {
      flags.push("分类与高分卡冲突");
    }
    const flagStr = flags.length > 0 ? ` — ⚠️ ${flags.join(" / ")}` : "";

    lines.push(`## #${i + 1} [${rec.turnId}] (${rec.day})${flagStr}`);
    lines.push(`[moment: ${rec.momentClass}] (conf=${rec.momentConfidence.toFixed(2)})`);
    if (rec.recentTurns.length > 0) {
      lines.push("**前文**：");
      for (const m of rec.recentTurns.slice(-2)) {
        lines.push(`- ${m.role}: ${clipText(m.content.replace(/\s+/g, " "), 140)}`);
      }
    }
    lines.push(`**本轮用户**：${clipText(rec.userText.replace(/\s+/g, " "), 260)}`);
    if (rec.futureTurns.length > 0) {
      lines.push("**后续佐证**：");
      for (const m of rec.futureTurns.slice(0, 2)) {
        lines.push(`- ${m.role}: ${clipText(m.content.replace(/\s+/g, " "), 140)}`);
      }
    }
    lines.push("**候选卡（改 `[grade: 0|1|2]`）**：");
    const showCards = rec.candidates.filter((c) => c.grade > 0).concat(
      rec.candidates.filter((c) => c.grade === 0).slice(0, 3),
    );
    if (showCards.length === 0) {
      lines.push("- （无候选卡）");
    } else {
      for (const c of showCards) {
        lines.push(
          `- [grade: ${c.grade}] \`${c.path}\` — ${c.title} (src=${c.sources.join("+")}, conf=${c.gradeConfidence.toFixed(2)})`,
        );
      }
    }
    lines.push("");
  }

  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, lines.join("\n"), "utf8");
}

export async function applyReviewMarkdown(
  dataDir: string,
  opts: { timeZone?: string; sleepEnd?: string } = {},
): Promise<{
  updatedTurns: number;
  updatedCards: number;
  addedCards: number;
  fixedSnapshots: number;
}> {
  const goldPath = path.join(dataDir, "eval", "gold.jsonl");
  const reviewPath = path.join(dataDir, "eval", "review.md");
  const gold = await readJsonl<GoldRecord>(goldPath);
  const byTurn = new Map(gold.map((g) => [g.turnId, g]));

  // 同步用逻辑日修正历史 gold.jsonl 中跨午夜轮次的 snapshotCommit，彻底杜绝未来穿越卡
  let fixedSnapshots = 0;
  try {
    const { dayToCommit } = await resolveDaySnapshotCommits(dataDir);
    if (dayToCommit.size > 0) {
      const tz = opts.timeZone ?? "Asia/Shanghai";
      const sleepEnd = opts.sleepEnd ?? DEFAULT_CIRCADIAN_CONFIG.sleepEnd;
      for (const rec of gold) {
        const logicalDay = resolveLogicalNightDay(
          rec.createdAt,
          tz,
          rec.sessionId,
          dayToCommit,
          sleepEnd,
        );
        const expectedCommit = dayToCommit.get(logicalDay);
        if (expectedCommit && (rec.snapshotCommit !== expectedCommit || rec.day !== logicalDay)) {
          rec.day = logicalDay;
          rec.snapshotCommit = expectedCommit;
          fixedSnapshots++;
        }
      }
    }
  } catch {
    // 非 git 目录时忽略
  }

  const md = await fs.readFile(reviewPath, "utf8");
  let currentTurn: GoldRecord | null = null;
  let updatedTurns = 0;
  let updatedCards = 0;
  let addedCards = 0;

  for (const line of md.split(/\r?\n/)) {
    const headMatch = /^##\s+#\d+\s+\[([^\]]+)\]/.exec(line);
    if (headMatch) {
      currentTurn = byTurn.get(headMatch[1]) ?? null;
      continue;
    }
    if (!currentTurn) continue;

    const momentMatch = /^\[moment:\s*([a-z_]+)\]/i.exec(line.trim());
    if (momentMatch) {
      const next = momentMatch[1].toLowerCase() as MomentClass;
      if ((MOMENT_CLASSES as readonly string[]).includes(next)) {
        if (currentTurn.momentClass !== next) {
          currentTurn.momentClass = next;
          updatedTurns++;
        }
        currentTurn.momentReviewed = true;
      }
      continue;
    }

    const cardMatch = /^-\s+\[grade:\s*([012])\]\s+`([^`]+)`(?:\s+[—-]\s+([^\n(]+))?/.exec(
      line.trim(),
    );
    if (cardMatch) {
      const grade = Number(cardMatch[1]) as 0 | 1 | 2;
      const cardPath = cardMatch[2].trim();
      const titleHint = cardMatch[3]?.trim() || cardPath;
      const cand = currentTurn.candidates.find((c) => c.path === cardPath);
      if (cand) {
        if (cand.grade !== grade) {
          cand.grade = grade;
          updatedCards++;
        }
        cand.reviewed = true;
      } else {
        // 支持人工抽查时直接追加漏召卡（原候选池未包含）
        const space = cardPath.split("/")[0] || "unknown";
        currentTurn.candidates.push({
          path: cardPath,
          title: titleHint,
          space,
          grade,
          gradeConfidence: 1.0,
          sources: ["manual_review"],
          reviewed: true,
        });
        addedCards++;
      }
    }
  }

  // 重新计算 missingMemorySuspected
  for (const rec of gold) {
    const maxGrade = rec.candidates.reduce((m, c) => Math.max(m, c.grade), 0);
    rec.missingMemorySuspected =
      (rec.momentClass === "callback" || rec.momentClass === "continuation") && maxGrade === 0;
  }

  await writeJsonl(goldPath, gold);
  return { updatedTurns, updatedCards, addedCards, fixedSnapshots };
}

// ---------------------------------------------------------------------------
// Stage 3: 在时间切片快照上运行召回变体并输出指标报告（run）
// ---------------------------------------------------------------------------

function computeNdcgAtK(grades: number[], idealGrades: number[], k: number): number {
  const dcg = (arr: number[]) =>
    arr.slice(0, k).reduce((sum, rel, i) => sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2), 0);
  const idcg = dcg([...idealGrades].sort((a, b) => b - a));
  if (idcg === 0) return 0;
  return dcg(grades) / idcg;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return Math.round(sorted[idx]);
}

export async function runEvalVariant(opts: {
  dataDir: string;
  timeZone: string;
  variant: EvalVariantSpec;
  gold?: GoldRecord[];
  decisionClient?: DecisionClient;
  embeddingClient?: EmbeddingClient;
  rerankerClient?: RerankerClient;
  promptsDir?: string;
  saveReport?: boolean;
}): Promise<EvalReport> {
  const gold = opts.gold ?? (await readJsonl<GoldRecord>(path.join(opts.dataDir, "eval", "gold.jsonl")));
  const pool = new SnapshotPool(opts.dataDir, opts.timeZone);

  try {
    const outcomes: EvalTurnOutcome[] = [];

    for (const rec of gold) {
      const snap = await pool.getSnapshot(rec.snapshotCommit, rec.createdAt);
      const t0 = performance.now();
      let res: RecallResult & { timedOut?: boolean };
      if (opts.variant.runner) {
        res = await opts.variant.runner({
          db: snap.db,
          dataDir: snap.tempDataDir,
          index: snap.index,
          clock: snap.clock,
          record: rec,
          decisionClient: opts.variant.useDecisionClient ? opts.decisionClient : undefined,
          embeddingClient: opts.variant.useEmbeddingClient ? opts.embeddingClient : undefined,
          rerankerClient: opts.variant.useRerankerClient ? opts.rerankerClient : undefined,
          promptsDir: opts.promptsDir,
        });
      } else {
        res = await recallMemories({
          db: snap.db,
          dataDir: snap.tempDataDir,
          index: snap.index,
          clock: snap.clock,
          sessionId: rec.sessionId,
          turnId: rec.turnId,
          query: rec.userText,
          recentTurns: rec.recentTurns,
          embedding: opts.variant.useEmbeddingClient ? opts.embeddingClient : undefined,
          reranker: opts.variant.useRerankerClient ? opts.rerankerClient : undefined,
          decisionClient: opts.variant.useDecisionClient ? opts.decisionClient : undefined,
          promptsDir: opts.promptsDir,
          recallConfig: opts.variant.recallConfig,
        });
      }
      const latencyMs = performance.now() - t0;

      // 写入虚拟 active 助手事件（带单调递增 seq 满足 NOT NULL 约束）以保持 2h 会话去重与线上一致
      const maxSeqRow = snap.db
        .query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events")
        .get() as { max_seq: number } | null;
      const nextSeq = (maxSeqRow?.max_seq ?? 0) + 1;
      snap.db
        .query(
          `INSERT OR IGNORE INTO events (
            id, seq, session_id, turn_id, role, kind, status, content, created_at
          ) VALUES (?, ?, ?, ?, 'assistant', 'chat', 'active', 'ok', ?)`,
        )
        .run(`eval-ast-${rec.turnId}`, nextSeq, rec.sessionId, rec.turnId, rec.createdAt + 1000);

      const gradeMap = new Map(rec.candidates.map((c) => [c.path, c.grade]));
      const recalledPaths = res.items.map((i) => i.path);
      const grades = recalledPaths.map((p) => gradeMap.get(p) ?? 0);
      const maxGoldGrade = rec.candidates.reduce((m, c) => Math.max(m, c.grade), 0);

      outcomes.push({
        turnId: rec.turnId,
        day: rec.day,
        momentClass: rec.momentClass,
        skipped: res.skipped,
        timedOut: Boolean(res.timedOut),
        latencyMs,
        recalledPaths,
        injectedChars: res.renderedBlock?.length ?? 0,
        grades,
        maxGoldGrade,
        missingMemorySuspected: rec.missingMemorySuspected,
      });
    }

    const countsByClass: Record<MomentClass, number> = {
      callback: 0,
      continuation: 0,
      resonance: 0,
      quiet: 0,
      fresh: 0,
    };
    for (const o of outcomes) countsByClass[o.momentClass]++;

    const quietTurns = outcomes.filter((o) => o.momentClass === "quiet");
    const quietFalseRecalls = quietTurns.filter((o) => o.recalledPaths.length > 0).length;
    const noRecallTurns = outcomes.filter(
      (o) => o.momentClass === "quiet" || o.momentClass === "fresh",
    );
    const noRecallFalse = noRecallTurns.filter((o) => o.recalledPaths.length > 0).length;

    const ccAll = outcomes.filter(
      (o) => o.momentClass === "callback" || o.momentClass === "continuation",
    );
    const ccMissingMem = ccAll.filter((o) => o.missingMemorySuspected).length;
    const ccEval = ccAll.filter((o) => o.maxGoldGrade >= 1);
    const ccHits = ccEval.filter((o) => o.grades.slice(0, 5).some((g) => g >= 1)).length;

    const resEval = outcomes.filter((o) => o.momentClass === "resonance" && o.maxGoldGrade >= 1);
    const goldByTurn = new Map(gold.map((g) => [g.turnId, g]));
    const ndcgSum = resEval.reduce((sum, o) => {
      const ideal = (goldByTurn.get(o.turnId)?.candidates ?? []).map((c) => c.grade);
      return sum + computeNdcgAtK(o.grades, ideal, 5);
    }, 0);

    const totalInjectedCards = outcomes.reduce((s, o) => s + o.recalledPaths.length, 0);
    const totalNoiseCards = outcomes.reduce(
      (s, o) => s + o.grades.filter((g) => g === 0).length,
      0,
    );
    const totalInjectedChars = outcomes.reduce((s, o) => s + o.injectedChars, 0);
    const latencies = outcomes.map((o) => o.latencyMs);

    const report: EvalReport = {
      variant: opts.variant.name,
      generatedAt: new Date().toISOString(),
      totalTurns: outcomes.length,
      countsByClass,
      metrics: {
        quietFalseRecallRate: quietTurns.length > 0 ? quietFalseRecalls / quietTurns.length : 0,
        quietCount: quietTurns.length,
        noRecallFalseRate: noRecallTurns.length > 0 ? noRecallFalse / noRecallTurns.length : 0,
        noRecallCount: noRecallTurns.length,
        callbackContMissRate: ccEval.length > 0 ? 1 - ccHits / ccEval.length : 0,
        callbackContHitAt5: ccEval.length > 0 ? ccHits / ccEval.length : 0,
        callbackContEvaluated: ccEval.length,
        callbackContMissingMemoryCount: ccMissingMem,
        resonanceNdcgAt5: resEval.length > 0 ? ndcgSum / resEval.length : 0,
        resonanceEvaluated: resEval.length,
        noiseRate: totalInjectedCards > 0 ? totalNoiseCards / totalInjectedCards : 0,
        totalInjectedCards,
        totalNoiseCards,
        avgInjectedChars: outcomes.length > 0 ? Math.round(totalInjectedChars / outcomes.length) : 0,
        latencyP50Ms: percentile(latencies, 0.5),
        latencyP90Ms: percentile(latencies, 0.9),
        timeoutFallbacks: outcomes.filter((o) => o.timedOut).length,
      },
      turns: outcomes,
    };

    if (opts.saveReport !== false) {
      const reportPath = path.join(opts.dataDir, "eval", "reports", `${opts.variant.name}.json`);
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    }

    return report;
  } finally {
    await pool.cleanup();
  }
}

export function formatComparisonTable(reports: readonly EvalReport[]): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const headers = [
    "变体",
    "不该召误召↓(Q+F)",
    "CB/Cont Hit@5↑",
    "Res nDCG@5↑",
    "噪声率↓",
    "均字数",
    "p50/p90ms",
    "超时降级",
  ];
  const rows = reports.map((r) => [
    r.variant,
    `${pct(r.metrics.noRecallFalseRate)} (Q=${pct(r.metrics.quietFalseRecallRate)})`,
    `${pct(r.metrics.callbackContHitAt5)} (n=${r.metrics.callbackContEvaluated}, 疑似漏写=${r.metrics.callbackContMissingMemoryCount})`,
    `${r.metrics.resonanceNdcgAt5.toFixed(3)} (n=${r.metrics.resonanceEvaluated})`,
    `${pct(r.metrics.noiseRate)} (${r.metrics.totalNoiseCards}/${r.metrics.totalInjectedCards})`,
    String(r.metrics.avgInjectedChars),
    `${r.metrics.latencyP50Ms}/${r.metrics.latencyP90Ms}`,
    String(r.metrics.timeoutFallbacks),
  ]);

  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}
