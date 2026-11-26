import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { sanitizeUnicode } from "../core/decision.ts";
import type { EmbeddingClient } from "../core/embedding.ts";
import { stripFrontmatter } from "../core/prompts.ts";
import type { CardIndexRow } from "./index.ts";

/** 计算两个同维浮点向量的余弦相似度（裁至 [0, 1] 供记忆相关性排序使用） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  const sim = dot / denom;
  return Number.isFinite(sim) ? Math.max(0, sim) : 0;
}

export function combineTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  if (parent?.aborted) return parent;
  const safeMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : 1_000;
  const timeoutSig = AbortSignal.timeout(safeMs);
  return parent ? AbortSignal.any([parent, timeoutSig]) : timeoutSig;
}

function decodeCachedFloat32(vec: Uint8Array, dim: number): Float32Array | null {
  if (!vec || vec.byteLength <= 0 || vec.byteLength % 4 !== 0) return null;
  if (dim > 0 && vec.byteLength !== dim * 4) return null;
  if (vec.byteOffset % 4 === 0) {
    return new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength / 4);
  }
  const copy = vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength);
  return new Float32Array(copy);
}

export interface EnsureCardEmbeddingsOptions {
  db: Database;
  memoryDir: string;
  rows: readonly CardIndexRow[];
  embedding: EmbeddingClient;
  nowMs: number;
  /** 单批次/单次请求基础超时（毫秒） */
  embedTimeoutMs: number;
  /** 可选整轮总超时上限（毫秒）；未指定时按缺失卡片数动态估算 */
  maxTotalTimeoutMs?: number;
  /** 可选自定义正文读取缓存函数（如召回单轮复用已读正文） */
  readCardBody?: (relPath: string) => Promise<string | null>;
  /** 可选外部输出 Map：即使后续分块中途超时抛错，已命中的缓存与已完成分块向量仍保留在其中 */
  outMap?: Map<string, Float32Array>;
  signal?: AbortSignal;
}

/**
 * 批量读取并按需补算卡片向量缓存（`card_embeddings`）：
 * - 命中 `(path, model_key, content_hash)` 直接复用 SQLite 缓存，0 额外请求；
 * - 缺失卡片按 16 张分块补算并逐块落库检查点，即使中途超时或限流，已算出的向量也不白费；
 * - 由 `memory/recall.ts` 与 `memory/radar.ts` 共同复用，保证单卡向量拼接口径 100% 一致。
 */
export async function ensureCardEmbeddings(
  opts: EnsureCardEmbeddingsOptions,
): Promise<Map<string, Float32Array>> {
  const { db, memoryDir, rows, embedding, nowMs, embedTimeoutMs, signal } = opts;
  const vecByPath = opts.outMap ?? new Map<string, Float32Array>();
  if (rows.length === 0) return vecByPath;

  const modelKey = embedding.modelKey;
  const missingRows: CardIndexRow[] = [];

  const readBody =
    opts.readCardBody ??
    (async (relPath: string): Promise<string | null> => {
      try {
        const raw = await fs.readFile(path.join(memoryDir, relPath), "utf8");
        return stripFrontmatter(raw).trim();
      } catch {
        return null;
      }
    });

  const cachedList = db
    .query(
      `SELECT path, vec, content_hash, dim FROM card_embeddings
       WHERE model_key = ?`,
    )
    .all(modelKey) as Array<{
    path: string;
    vec: Uint8Array;
    content_hash: string;
    dim: number;
  }>;
  const cachedByPath = new Map<string, { vec: Uint8Array; content_hash: string; dim: number }>();
  for (const c of cachedList) {
    cachedByPath.set(c.path, c);
  }

  for (const row of rows) {
    const cached = cachedByPath.get(row.path);
    const decoded =
      cached && cached.content_hash === row.content_hash
        ? decodeCachedFloat32(cached.vec, cached.dim)
        : null;
    if (decoded) {
      vecByPath.set(row.path, decoded);
    } else {
      missingRows.push(row);
    }
  }

  if (missingRows.length === 0) {
    return vecByPath;
  }

  const dynamicTimeout = Math.max(
    embedTimeoutMs,
    Math.min(60_000, embedTimeoutMs * Math.ceil(missingRows.length / 8)),
  );
  const batchTimeout =
    opts.maxTotalTimeoutMs !== undefined
      ? Math.max(200, Math.min(dynamicTimeout, opts.maxTotalTimeoutMs))
      : dynamicTimeout;
  const deadline = Date.now() + batchTimeout;
  const chunkSize = 16;

  const upsert = db.query(
    `INSERT INTO card_embeddings (path, model_key, content_hash, dim, vec, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, model_key) DO UPDATE SET
       content_hash = excluded.content_hash,
       dim = excluded.dim,
       vec = excluded.vec,
       updated_at = excluded.updated_at`,
  );

  for (let offset = 0; offset < missingRows.length; offset += chunkSize) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    }
    const rowSlice = missingRows.slice(offset, offset + chunkSize);
    const loadedChunk = await Promise.all(
      rowSlice.map(async (row) => {
        const body = await readBody(row.path);
        if (body === null) return null;
        const normalizedBody = body.trim();
        const text = sanitizeUnicode(
          `${row.title}\n${row.when_to_recall ?? ""}\n${normalizedBody.slice(0, 1200)}`,
        );
        return { row, text };
      }),
    );
    const chunk = loadedChunk.filter(
      (item): item is { row: CardIndexRow; text: string } => item !== null,
    );
    if (chunk.length === 0) continue;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Embedding batch deadline exceeded after ${offset}/${missingRows.length} cards`);
    }
    const chunkTimeout = Math.max(200, Math.min(embedTimeoutMs * 2, remainingMs));
    let chunkVecs: Float32Array[];
    if (embedding.embedBatch) {
      chunkVecs = await embedding.embedBatch(
        chunk.map((m) => m.text),
        { signal: combineTimeoutSignal(signal, chunkTimeout), taskType: "document" },
      );
    } else {
      chunkVecs = [];
      for (const m of chunk) {
        const itemRemaining = deadline - Date.now();
        if (itemRemaining <= 0) {
          throw new Error("Embedding batch deadline exceeded");
        }
        chunkVecs.push(
          await embedding.embed(m.text, {
            signal: combineTimeoutSignal(signal, Math.min(embedTimeoutMs, itemRemaining)),
            taskType: "document",
          }),
        );
      }
    }
    if (chunkVecs.length !== chunk.length) {
      throw new Error(
        `Embedding client returned ${chunkVecs.length} vectors for ${chunk.length} cards`,
      );
    }
    const tx = db.transaction(() => {
      for (let j = 0; j < chunk.length; j++) {
        const cVec = chunkVecs[j]!;
        const row = chunk[j]!.row;
        vecByPath.set(row.path, cVec);
        const blob = new Uint8Array(cVec.buffer, cVec.byteOffset, cVec.byteLength);
        upsert.run(row.path, modelKey, row.content_hash, cVec.length, blob, nowMs);
      }
    });
    tx();
  }

  return vecByPath;
}
