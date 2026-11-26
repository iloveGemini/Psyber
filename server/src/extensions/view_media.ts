import type { MediaStore } from "../core/media.ts";
import type { ToolRegistry } from "../tools/registry.ts";

const HEX64_RE = /^[a-f0-9]{64}$/i;

export function parseMediaIdHash(raw: unknown): { ok: true; hash: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "mediaId 不能为空，请提供形如 media:<64位哈希> 的媒体引用。" };
  }
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("media:") ? trimmed.slice("media:".length).trim() : trimmed;
  if (!HEX64_RE.test(stripped)) {
    return {
      ok: false,
      reason: `非法的 mediaId：${trimmed}（应为 media:<64位十六进制哈希> 或 64 位哈希）。`,
    };
  }
  return { ok: true, hash: stripped.toLowerCase() };
}

export interface RegisterViewMediaToolDeps {
  media: MediaStore;
}

/**
 * 注册 Tier 3 只读图片复看工具 `view_media`：
 * - 配合附件摘要（digest）使用：历史对话中仅保留 media:<hash> 与文字摘要，
 *   当 Psyber 需要核对原图细节时按需调用本工具；
 * - 返回的临时图片块仅在当轮多步工具循环内送给模型，跨轮不落盘 base64、不污染后续 Prompt Cache。
 */
export function registerViewMediaTool(
  registry: ToolRegistry,
  deps: RegisterViewMediaToolDeps,
): void {
  const { media } = deps;

  registry.register({
    name: "view_media",
    tier: 3,
    security: "auto",
    description:
      "按 media:<hash> 媒体引用重新查看历史对话中发送过的原图细节（仅在当轮临时载入图片，下一轮自动回收不占长期上下文）。",
    tags: ["media", "image", "photo", "picture", "view", "图片", "照片", "原图", "重看", "查看"],
    parameters: {
      type: "object",
      properties: {
        mediaId: {
          type: "string",
          description: "历史消息中标注的媒体引用，如 media:<64位哈希> 或 64 位十六进制哈希",
        },
      },
      required: ["mediaId"],
    },
    guard: async (args) => {
      const check = parseMediaIdHash(args.mediaId);
      if (!check.ok) return check;
      return { ok: true };
    },
    execute: async (args) => {
      const check = parseMediaIdHash(args.mediaId);
      if (!check.ok) return { ok: false, output: check.reason };
      const asset = await media.read(check.hash);
      if (!asset) {
        return { ok: false, output: `找不到媒体文件 media:${check.hash}。` };
      }
      if (asset.expired) {
        return { ok: false, output: `媒体文件 media:${check.hash} 已过期清理，无法再查看原图。` };
      }
      if (!asset.mimeType.startsWith("image/")) {
        return {
          ok: false,
          output: `媒体文件 media:${check.hash} 的类型为 ${asset.mimeType}，view_media 仅支持查看图片。`,
        };
      }
      return {
        ok: true,
        output: `已载入原图 media:${check.hash}（${asset.mimeType}，仅本轮可见，下轮将自动回收）。`,
        images: [
          {
            type: "image",
            data: Buffer.from(asset.bytes).toString("base64"),
            mimeType: asset.mimeType,
          },
        ],
      };
    },
  });
}
