import { describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import {
  DEFAULT_LLM_IMAGE_MAX_EDGE,
  prepareImageForLlm,
  probeImageDimensions,
} from "../src/core/image_compress.ts";
import { MediaStore } from "../src/core/media.ts";
import { createTestContext } from "./helpers.ts";

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return out;
}

/** 构造合法的真 PNG 字节（用于验证尺寸解析与 macOS sips 真实缩放） */
function buildSolidPng(width: number, height: number): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行 1 字节 filter + width * 3 字节 RGB（带轻微渐变，防止压缩极端退化）
  const rowLen = 1 + width * 3;
  const raw = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y++) {
    const base = y * rowLen;
    raw[base] = 0;
    for (let x = 0; x < width; x++) {
      raw[base + 1 + x * 3] = (x + y) & 0xff;
      raw[base + 2 + x * 3] = (x * 3) & 0xff;
      raw[base + 3 + x * 3] = (y * 5) & 0xff;
    }
  }
  const compressed = new Uint8Array(zlib.deflateSync(raw));

  const chunks = [
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

describe("image_compress & MediaStore.readForLlm", () => {
  test("probeImageDimensions 准确识别 PNG 宽高并忽略非图片占位字节", () => {
    const smallPng = buildSolidPng(64, 48);
    expect(probeImageDimensions(smallPng)).toEqual({ width: 64, height: 48 });
    expect(probeImageDimensions(new TextEncoder().encode("not-an-image"))).toBeNull();
  });

  test("小尺寸标准格式 PNG 直接零开销跳过压缩", async () => {
    const smallPng = buildSolidPng(320, 240);
    const prepared = await prepareImageForLlm(smallPng, "image/png");
    expect(prepared.compressed).toBe(false);
    expect(prepared.mimeType).toBe("image/png");
    expect(prepared.bytes.byteLength).toBe(smallPng.byteLength);
    expect(prepared.width).toBe(320);
    expect(prepared.height).toBe(240);
  });

  test("超分辨率大图送模型前缩放至长边 <= 1568px 并转为 JPEG，同时媒体仓原盘文件保持原图不变", async () => {
    const ctx = await createTestContext();
    try {
      const media = new MediaStore(ctx.db, ctx.dataDir);
      const largePng = buildSolidPng(2400, 1600);
      const saved = await media.save({
        bytes: largePng,
        mimeType: "image/png",
        origin: "user_upload",
        nowMs: ctx.clock.now(),
      });

      // 并发调用（模拟主模型 + 并行 digest 同时读取同一张图）
      const [a, b] = await Promise.all([
        media.readForLlm(saved.hash),
        media.readForLlm(saved.hash),
      ]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      // 共享同一次内存结果
      expect(a).toBe(b);

      if (process.platform === "darwin") {
        expect(a!.compressed).toBe(true);
        expect(a!.mimeType).toBe("image/jpeg");
        const outDims = probeImageDimensions(a!.bytes);
        expect(outDims).not.toBeNull();
        expect(Math.max(outDims!.width, outDims!.height)).toBeLessThanOrEqual(
          DEFAULT_LLM_IMAGE_MAX_EDGE,
        );
        expect(outDims!.width).toBe(1568);
        expect(outDims!.height).toBe(1045);
      }

      // 原盘文件必须完好无损，客户端仍可查看原始 2400x1600 PNG
      const orig = await media.read(saved.hash);
      expect(orig).not.toBeNull();
      expect(orig!.mimeType).toBe("image/png");
      expect(orig!.bytes.byteLength).toBe(largePng.byteLength);
      expect(probeImageDimensions(orig!.bytes)).toEqual({ width: 2400, height: 1600 });
    } finally {
      await ctx.cleanup();
    }
  });

  test("损坏或占位字节在触发压缩路径时静默回退原字节不抛错", async () => {
    const fakeBytes = new Uint8Array(200);
    fakeBytes.fill(0x41);
    const prepared = await prepareImageForLlm(fakeBytes, "image/heic");
    expect(prepared.compressed).toBe(false);
    expect(prepared.bytes.byteLength).toBe(fakeBytes.byteLength);
  });
});
