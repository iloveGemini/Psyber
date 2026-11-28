import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Clock } from "../core/clock.ts";

interface StickerManifestItem {
  id: string;
  label: string;
  file: string;
  pack?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const STICKER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * 扫描指定贴纸目录下的 manifest.json（对齐 Spec 03 §2.2）：
 * 将静态贴纸文件按 SHA-256 写入 <dataDir>/media/（origin='sticker', pinned=1）并同步写入 stickers 表。
 * 若目录或 manifest.json 不存在则静默跳过。
 */
export async function syncStickersFromDir(
  db: Database,
  dataDir: string,
  stickersDir: string,
  clock: Clock,
): Promise<number> {
  const manifestPath = path.join(stickersDir, "manifest.json");

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }

  const items: StickerManifestItem[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown[] })?.items)
      ? ((parsed as { items: StickerManifestItem[] }).items)
      : [];

  let synced = 0;
  const nowMs = clock.now();

  for (const item of items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !STICKER_ID_RE.test(item.id) ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      typeof item.file !== "string" ||
      !item.file.trim()
    ) {
      continue;
    }

    const absSrc = path.resolve(stickersDir, item.file);
    if (!absSrc.startsWith(path.resolve(stickersDir) + path.sep)) continue;

    const ext = path.extname(absSrc).toLowerCase();
    const mimeType = MIME_BY_EXT[ext];
    if (!mimeType) continue;

    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(absSrc);
    } catch {
      continue;
    }
    if (bytes.byteLength > 2 * 1024 * 1024) continue;

    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const mediaSubdir = path.join(dataDir, "media", hash.slice(0, 2));
    const mediaTarget = path.join(mediaSubdir, `${hash}${ext}`);
    await fs.mkdir(mediaSubdir, { recursive: true });
    try {
      await fs.access(mediaTarget);
    } catch {
      await fs.writeFile(mediaTarget, bytes);
    }

    db.query(
      `INSERT INTO media_assets (hash, ext, mime_type, size_bytes, origin, activity_session_id, pinned, expired, created_at)
       VALUES (?, ?, ?, ?, 'sticker', NULL, 1, 0, ?)
       ON CONFLICT(hash) DO UPDATE SET pinned = 1, expired = 0`,
    ).run(hash, ext.slice(1), mimeType, bytes.byteLength, nowMs);

    db.query(
      `INSERT INTO stickers (id, label, pack, media_hash, use_count, last_used_at, created_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         pack = excluded.pack,
         media_hash = excluded.media_hash`,
    ).run(item.id, item.label.trim().slice(0, 20), item.pack?.trim() || "default", hash, nowMs);

    synced += 1;
  }

  return synced;
}

/**
 * 启动时同步静态贴纸（对齐 Spec 03 §2.2）：
 * 若传入 builtinStickersDir，先同步内置贴纸包，再同步 <dataDir>/stickers/（同名 id 以用户目录为准）。
 */
export async function syncStaticStickers(
  db: Database,
  dataDir: string,
  clock: Clock,
  opts?: { builtinStickersDir?: string },
): Promise<number> {
  let synced = 0;
  if (opts?.builtinStickersDir) {
    synced += await syncStickersFromDir(db, dataDir, opts.builtinStickersDir, clock);
  }
  const userStickersDir = path.join(dataDir, "stickers");
  if (!opts?.builtinStickersDir || path.resolve(opts.builtinStickersDir) !== path.resolve(userStickersDir)) {
    synced += await syncStickersFromDir(db, dataDir, userStickersDir, clock);
  }
  return synced;
}
