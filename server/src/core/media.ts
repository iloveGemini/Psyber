import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { atomicWriteBytes } from "./config.ts";

export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
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

/**
 * 内容寻址媒体仓（SHA-256 去重落盘至 <dataDir>/media/<hash[0..1]>/<hash>.<ext>），
 * 保证历史消息严禁内联 base64，客户端凭不可变 ETag 缓存读取。
 */
export class MediaStore {
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
}
