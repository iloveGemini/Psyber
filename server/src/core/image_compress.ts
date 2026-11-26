import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LLM_IMAGE_MAX_EDGE = 1568;
export const DEFAULT_LLM_IMAGE_SOFT_BYTES = 1_500_000; // 1.5 MB
export const DEFAULT_LLM_IMAGE_HARD_BYTES = 3_500_000; // 3.5 MB raw ≈ 4.67 MB base64（稳妥低于 Anthropic 5 MB 单图上限）
export const DEFAULT_LLM_IMAGE_QUALITY = 85;
const COMPRESS_TIMEOUT_MS = 10_000;

const LLM_SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface PrepareImageForLlmOptions {
  /** 最大长边像素（默认 1568） */
  maxEdge?: number;
  /** 软体积阈值（超过则触发压缩，默认 1.5 MB） */
  softBytes?: number;
  /** 硬体积上限（超过则降档重试，默认 3.5 MB） */
  hardBytes?: number;
  /** JPEG 压缩质量 1..100（默认 85） */
  quality?: number;
  /** 若源文件已在磁盘上，可直接传入路径避免多写一份临时源文件（只读不改原文件） */
  sourcePath?: string;
}

export interface PreparedLlmImage {
  bytes: Uint8Array;
  mimeType: string;
  compressed: boolean;
  originalBytes: number;
  width?: number;
  height?: number;
}

function normalizeMime(mimeType: string): string {
  const clean = (mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase();
  if (clean === "image/jpg") return "image/jpeg";
  return clean;
}

/**
 * 零依赖轻量解析 PNG / JPEG / GIF / WebP 尺寸，用于快速跳过小图压缩与避免 sips -Z 放大原图。
 */
export function probeImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 8-byte signature + IHDR chunk
  if (
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }

  // GIF87a / GIF89a
  if (
    bytes.byteLength >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }

  // WebP: RIFF....WEBP
  if (
    bytes.byteLength >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (chunk === "VP8X") {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
  }

  // JPEG: SOI (FF D8) + SOF0..SOF15 markers
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.byteLength) {
      while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.byteLength) break;
      const marker = bytes[offset]!;
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone
      if (offset + 2 > bytes.byteLength) break;
      const segmentLen = view.getUint16(offset, false);
      if (segmentLen < 2 || offset + segmentLen > bytes.byteLength) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && segmentLen >= 7) {
        const height = view.getUint16(offset + 3, false);
        const width = view.getUint16(offset + 5, false);
        if (width > 0 && height > 0) return { width, height };
        return null;
      }
      offset += segmentLen;
    }
  }

  return null;
}

export function needsLlmImageCompression(params: {
  bytes: Uint8Array;
  mimeType: string;
  dims: ImageDimensions | null;
  maxEdge: number;
  softBytes: number;
  hardBytes: number;
}): boolean {
  const mime = normalizeMime(params.mimeType);
  if (!LLM_SUPPORTED_IMAGE_MIMES.has(mime)) return true;

  const longestEdge = params.dims ? Math.max(params.dims.width, params.dims.height) : 0;
  // 保留体积和分辨率均在安全线内的 GIF（避免拆掉动图）
  if (mime === "image/gif") {
    return params.bytes.byteLength > params.hardBytes || longestEdge > params.maxEdge;
  }

  if (params.bytes.byteLength > params.softBytes) return true;
  if (longestEdge > params.maxEdge) return true;
  return false;
}

async function runCommand(cmd: string[], timeoutMs = COMPRESS_TIMEOUT_MS): Promise<{
  ok: boolean;
  stdout: string;
}> {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const exited = proc.exited.then((code) => code);
    const race = await Promise.race([exited, timedOut]);
    if (race === "timeout") {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      return { ok: false, stdout: "" };
    }
    const stdout =
      proc.stdout && typeof proc.stdout !== "number"
        ? await new Response(proc.stdout).text()
        : "";
    return { ok: race === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeDimensionsWithSips(filePath: string): Promise<ImageDimensions | null> {
  const res = await runCommand(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", filePath], 4_000);
  if (!res.ok) return null;
  const wMatch = res.stdout.match(/pixelWidth:\s*(\d+)/);
  const hMatch = res.stdout.match(/pixelHeight:\s*(\d+)/);
  if (!wMatch || !hMatch) return null;
  const width = Number(wMatch[1]);
  const height = Number(hMatch[1]);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  return null;
}

async function transcodeOnce(params: {
  inputPath: string;
  outputPath: string;
  dims: ImageDimensions | null;
  maxEdge: number;
  quality: number;
}): Promise<Uint8Array | null> {
  if (process.platform === "darwin") {
    const resolvedDims = params.dims ?? (await probeDimensionsWithSips(params.inputPath));
    const shouldResize = resolvedDims
      ? Math.max(resolvedDims.width, resolvedDims.height) > params.maxEdge
      : false;
    const args = [
      "/usr/bin/sips",
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      String(params.quality),
      ...(shouldResize ? ["-Z", String(params.maxEdge)] : []),
      params.inputPath,
      "--out",
      params.outputPath,
    ];
    const res = await runCommand(args);
    if (!res.ok) return null;
    try {
      const out = await fs.readFile(params.outputPath);
      return out.byteLength > 0 ? new Uint8Array(out) : null;
    } catch {
      return null;
    }
  }

  // 非 macOS 环境：若系统装有 ImageMagick (magick)，走同样只缩不放的 JPEG 压缩
  const magickRes = await runCommand([
    "magick",
    params.inputPath,
    "-auto-orient",
    "-resize",
    `${params.maxEdge}x${params.maxEdge}>`,
    "-quality",
    String(params.quality),
    `jpeg:${params.outputPath}`,
  ]);
  if (!magickRes.ok) return null;
  try {
    const out = await fs.readFile(params.outputPath);
    return out.byteLength > 0 ? new Uint8Array(out) : null;
  } catch {
    return null;
  }
}

/**
 * 在发送给主模型 / digest / view_media 前按需缩放与压缩图片：
 * - 原文件始终保留在媒体仓不被改写；
 * - 小于 1568px 且小于 1.5 MB 的标准格式图片直接零开销跳过；
 * - 超分辨率、超体积或 HEIC/BMP/TIFF 等非常见格式自动转为 JPEG（长边 ≤ 1568px，质量 85%，超 3.5 MB 自动降档）；
 * - 若运行环境缺少图像工具或输入非真实图片（如单测占位字节），静默回退原字节，绝不阻断发送。
 */
export async function prepareImageForLlm(
  bytes: Uint8Array,
  mimeType: string,
  opts: PrepareImageForLlmOptions = {},
): Promise<PreparedLlmImage> {
  const mime = normalizeMime(mimeType);
  const maxEdge = opts.maxEdge ?? DEFAULT_LLM_IMAGE_MAX_EDGE;
  const softBytes = opts.softBytes ?? DEFAULT_LLM_IMAGE_SOFT_BYTES;
  const hardBytes = opts.hardBytes ?? DEFAULT_LLM_IMAGE_HARD_BYTES;
  const quality = opts.quality ?? DEFAULT_LLM_IMAGE_QUALITY;
  const dims = probeImageDimensions(bytes);

  if (
    !needsLlmImageCompression({
      bytes,
      mimeType: mime,
      dims,
      maxEdge,
      softBytes,
      hardBytes,
    })
  ) {
    return {
      bytes,
      mimeType: mime,
      compressed: false,
      originalBytes: bytes.byteLength,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    };
  }

  const tmpId = `psyber-img-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const tmpDir = os.tmpdir();
  let ownedInputPath: string | null = null;
  const outputPath = path.join(tmpDir, `${tmpId}.jpg`);

  try {
    let inputPath = opts.sourcePath;
    if (!inputPath) {
      const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
      ownedInputPath = path.join(tmpDir, `${tmpId}-in.${ext}`);
      await fs.writeFile(ownedInputPath, bytes);
      inputPath = ownedInputPath;
    }

    const passes: Array<{ edge: number; q: number }> = [
      { edge: maxEdge, q: quality },
      { edge: Math.min(maxEdge, 1280), q: Math.min(quality, 72) },
      { edge: Math.min(maxEdge, 1024), q: Math.min(quality, 60) },
    ];

    let best: Uint8Array | null = null;
    for (const pass of passes) {
      const candidate = await transcodeOnce({
        inputPath,
        outputPath,
        dims,
        maxEdge: pass.edge,
        quality: pass.q,
      });
      if (!candidate) break;
      best = candidate;
      if (candidate.byteLength <= hardBytes) break;
    }

    if (!best) {
      return {
        bytes,
        mimeType: mime,
        compressed: false,
        originalBytes: bytes.byteLength,
        ...(dims ? { width: dims.width, height: dims.height } : {}),
      };
    }

    const bestDims = probeImageDimensions(best);
    // 若原图本就是受支持格式、尺寸未超限、且压缩后反而变大（例如极简大尺寸纯色图），保留原图
    const origWithinLimits =
      LLM_SUPPORTED_IMAGE_MIMES.has(mime) &&
      bytes.byteLength <= hardBytes &&
      dims !== null &&
      Math.max(dims.width, dims.height) <= maxEdge;
    if (origWithinLimits && best.byteLength >= bytes.byteLength) {
      return {
        bytes,
        mimeType: mime,
        compressed: false,
        originalBytes: bytes.byteLength,
        width: dims.width,
        height: dims.height,
      };
    }

    return {
      bytes: best,
      mimeType: "image/jpeg",
      compressed: true,
      originalBytes: bytes.byteLength,
      ...(bestDims ? { width: bestDims.width, height: bestDims.height } : {}),
    };
  } finally {
    if (ownedInputPath) {
      await fs.rm(ownedInputPath, { force: true }).catch(() => {});
    }
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}
