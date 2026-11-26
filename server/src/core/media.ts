import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { atomicWriteBytes } from "./config.ts";
import {
  DEFAULT_LLM_IMAGE_HARD_BYTES,
  DEFAULT_LLM_IMAGE_MAX_EDGE,
  DEFAULT_LLM_IMAGE_QUALITY,
  DEFAULT_LLM_IMAGE_SOFT_BYTES,
  prepareImageForLlm,
  type PrepareImageForLlmOptions,
} from "./image_compress.ts";

export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const LLM_IMAGE_CACHE_MAX_ENTRIES = 16;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/octet-stream": "bin",
};

export interface SavedMediaAsset {
  hash: string;
  ext: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export interface LlmMediaAsset {
  bytes: Uint8Array;
  base64: string;
  mimeType: string;
  expired: boolean;
  compressed: boolean;
  originalBytes: number;
}

/**
 * 内容寻址媒体仓（SHA-256 去重落盘至 <dataDir>/media/<hash[0..1]>/<hash>.<ext>），
 * 保证历史消息严禁内联 base64，客户端凭不可变 ETag 缓存读取。
 */
export class MediaStore {
  private readonly llmImageCache = new Map<string, LlmMediaAsset>();
  private readonly llmImageInFlight = new Map<string, Promise<LlmMediaAsset | null>>();

  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
  ) {}

  async save(opts: {
    bytes: Uint8Array;
    mimeType: string;
    origin: "user_upload" | "creative" | "sticker";
    nowMs: number;
  }): Promise<SavedMediaAsset> {
    if (opts.bytes.byteLength > MAX_MEDIA_UPLOAD_BYTES) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }

    const hash = crypto.createHash("sha256").update(opts.bytes).digest("hex");
    const mime = (opts.mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const ext = MIME_TO_EXT[mime] ?? "bin";
    const subDir = path.join(this.dataDir, "media", hash.slice(0, 2));
    const targetPath = path.join(subDir, `${hash}.${ext}`);

    await fs.mkdir(subDir, { recursive: true });
    try {
      await fs.access(targetPath);
    } catch {
      await atomicWriteBytes(this.dataDir, targetPath, opts.bytes);
    }

    this.db
      .query(
        `INSERT INTO media_assets (hash, ext, mime_type, size_bytes, origin, activity_session_id, pinned, expired, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?)
         ON CONFLICT(hash) DO UPDATE SET pinned = 1`,
      )
      .run(hash, ext, mime, opts.bytes.byteLength, opts.origin, opts.nowMs);

    return {
      hash,
      ext,
      mimeType: mime,
      sizeBytes: opts.bytes.byteLength,
      url: `/api/v1/media/${hash}`,
    };
  }

  async read(hash: string): Promise<{ bytes: Uint8Array; mimeType: string; expired: boolean } | null> {
    if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
    const row = this.db
      .query("SELECT ext, mime_type, expired FROM media_assets WHERE hash = ?")
      .get(hash.toLowerCase()) as { ext: string; mime_type: string; expired: number } | null;
    if (!row) return null;
    if (row.expired === 1) {
      return { bytes: new Uint8Array(), mimeType: row.mime_type, expired: true };
    }

    const absPath = path.join(this.dataDir, "media", hash.slice(0, 2), `${hash.toLowerCase()}.${row.ext}`);
    try {
      const bytes = await fs.readFile(absPath);
      return { bytes, mimeType: row.mime_type, expired: false };
    } catch {
      return null;
    }
  }

  /**
   * 读取用于发给视觉模型（主模型 / digest / view_media）的图片版本：
   * - 原盘文件始终保持原图不改写（前端查看依然清晰）；
   * - 对超大分辨率或大体积图片按需缩放为 JPEG，并做内存 LRU 缓存 + 并发去重（主模型与并行 digest 共享同一次压缩）。
   */
  async readForLlm(
    hash: string,
    opts?: Omit<PrepareImageForLlmOptions, "sourcePath">,
  ): Promise<LlmMediaAsset | null> {
    if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
    const lowerHash = hash.toLowerCase();
    const row = this.db
      .query("SELECT ext, mime_type, expired FROM media_assets WHERE hash = ?")
      .get(lowerHash) as { ext: string; mime_type: string; expired: number } | null;
    if (!row) return null;
    if (row.expired === 1) {
      return {
        bytes: new Uint8Array(),
        base64: "",
        mimeType: row.mime_type,
        expired: true,
        compressed: false,
        originalBytes: 0,
      };
    }

    const maxEdge = opts?.maxEdge ?? DEFAULT_LLM_IMAGE_MAX_EDGE;
    const softBytes = opts?.softBytes ?? DEFAULT_LLM_IMAGE_SOFT_BYTES;
    const hardBytes = opts?.hardBytes ?? DEFAULT_LLM_IMAGE_HARD_BYTES;
    const quality = opts?.quality ?? DEFAULT_LLM_IMAGE_QUALITY;
    const cacheKey = `${lowerHash}:${maxEdge}:${softBytes}:${hardBytes}:${quality}`;

    const cached = this.llmImageCache.get(cacheKey);
    if (cached) {
      // 刷新 LRU 顺序
      this.llmImageCache.delete(cacheKey);
      this.llmImageCache.set(cacheKey, cached);
      return cached;
    }

    const inFlight = this.llmImageInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const absPath = path.join(this.dataDir, "media", lowerHash.slice(0, 2), `${lowerHash}.${row.ext}`);
    const job = (async (): Promise<LlmMediaAsset | null> => {
      let rawBytes: Uint8Array;
      try {
        rawBytes = new Uint8Array(await fs.readFile(absPath));
      } catch {
        return null;
      }

      if (!row.mime_type.startsWith("image/")) {
        return {
          bytes: rawBytes,
          base64: Buffer.from(rawBytes).toString("base64"),
          mimeType: row.mime_type,
          expired: false,
          compressed: false,
          originalBytes: rawBytes.byteLength,
        };
      }

      const prepared = await prepareImageForLlm(rawBytes, row.mime_type, {
        maxEdge,
        softBytes,
        hardBytes,
        quality,
        sourcePath: absPath,
      });
      const asset: LlmMediaAsset = {
        bytes: prepared.bytes,
        base64: Buffer.from(prepared.bytes).toString("base64"),
        mimeType: prepared.mimeType,
        expired: false,
        compressed: prepared.compressed,
        originalBytes: prepared.originalBytes,
      };
      this.llmImageCache.set(cacheKey, asset);
      if (this.llmImageCache.size > LLM_IMAGE_CACHE_MAX_ENTRIES) {
        const oldestKey = this.llmImageCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.llmImageCache.delete(oldestKey);
        }
      }
      return asset;
    })().finally(() => {
      this.llmImageInFlight.delete(cacheKey);
    });

    this.llmImageInFlight.set(cacheKey, job);
    return job;
  }
}
