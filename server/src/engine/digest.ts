import type { PsyberConfig } from "../core/config.ts";
import type { MediaStore } from "../core/media.ts";
import { redactSecrets } from "../core/redact.ts";
import type { ChatImageContent, ChatModelClient } from "../llm/client.ts";
import { withTimeoutSignal } from "../llm/router.ts";
import type { EventStore, StoredEvent } from "../store/events.ts";

export const DEFAULT_DIGEST_TIMEOUT_MS = 15_000;
export const MAX_DIGEST_IMAGES = 6;
export const MAX_DIGEST_CHARS = 360;

const DIGEST_SYSTEM_PROMPT = [
  "你是一个客观简洁的视觉附件摘要器。",
  "请用中文直接概括所附图片或短视频关键帧的核心画面内容，供后续对话与记忆整理回溯。",
  "要求：",
  "1. 只陈述客观可见事实：主体/场景、人物或物品特征、清晰可读的关键文字/数字/界面信息、整体氛围；",
  "2. 不要角色扮演、不要寒暄、不要猜测看不清的细节、不要加 Markdown 标题或多余前缀；",
  "3. 单张图片控制在 1–2 句（≤ 120 字）；多张图片或短视频关键帧按顺序简明串联，总长度不超过 300 字；",
  "4. 严禁抄录图片中的明文密码、API 密钥、Token、私钥、短信验证码、完整银行卡号或证件号，遇到此类信息仅客观说明其类别（如“显示了一段密钥配置”或“包含验证码界面”）。",
].join("\n");

/** 仅当用户在配置中显式设置了 llm.slots.digest 时才自动触发附件摘要（不隐式回落主模型） */
export function isDigestSlotConfigured(config: PsyberConfig): boolean {
  const ref = config.llm?.slots?.digest;
  return Boolean(
    ref &&
      typeof ref.provider === "string" &&
      ref.provider.trim() &&
      typeof ref.model === "string" &&
      ref.model.trim(),
  );
}

export interface GenerateAttachmentDigestOptions {
  digestModel: ChatModelClient;
  media: MediaStore;
  attachments?: string[];
  videoClip?: { durationSec: number; frameHashes: string[] };
  userText?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 调用轻量 digest 视觉模型生成客观文字摘要：
 * - 支持图片附件与短视频抽帧；
 * - 任何超时、缺图或模型异常均静默返回 null，绝不阻塞或影响主对话。
 */
export async function generateAttachmentDigest(
  opts: GenerateAttachmentDigestOptions,
): Promise<string | null> {
  const rawHashes: string[] = [];
  if (Array.isArray(opts.attachments)) {
    for (const h of opts.attachments) {
      if (typeof h === "string" && h.trim()) rawHashes.push(h.trim().toLowerCase());
    }
  }
  if (opts.videoClip && Array.isArray(opts.videoClip.frameHashes)) {
    for (const h of opts.videoClip.frameHashes) {
      if (typeof h === "string" && h.trim()) rawHashes.push(h.trim().toLowerCase());
    }
  }
  const uniqueHashes = Array.from(new Set(rawHashes)).slice(0, MAX_DIGEST_IMAGES);
  if (uniqueHashes.length === 0) return null;

  const images: ChatImageContent[] = [];
  for (const hash of uniqueHashes) {
    const asset = await opts.media.readForLlm(hash);
    if (!asset || asset.expired || !asset.mimeType.startsWith("image/")) continue;
    images.push({
      type: "image",
      data: asset.base64,
      mimeType: asset.mimeType,
    });
  }
  if (images.length === 0) return null;

  const isVideo = Boolean(opts.videoClip && opts.videoClip.frameHashes.length > 0);
  const contextLine = opts.userText?.trim()
    ? `用户附言（仅供参考上下文，不要复述附言本身）：${opts.userText.trim().slice(0, 160)}\n`
    : "";
  const instruction = isVideo
    ? `${contextLine}以下是一段约 ${Math.max(1, Math.round(opts.videoClip!.durationSec))} 秒短视频按时间顺序提取的 ${images.length} 张关键帧，请概括这段视频的画面内容与动作变化。`
    : `${contextLine}请客观概括以下 ${images.length} 张图片的画面内容。`;

  const { signal, cleanup } = withTimeoutSignal(
    opts.signal,
    opts.timeoutMs ?? DEFAULT_DIGEST_TIMEOUT_MS,
  );
  try {
    let text = "";
    for await (const chunk of opts.digestModel.stream({
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: instruction }, ...images],
          timestamp: Date.now(),
        },
      ],
      tools: [],
      maxTokens: 512,
      thinkingLevel: "off",
      signal,
    })) {
      if (signal.aborted) return null;
      if (chunk.type === "error") return null;
      if (chunk.type === "text_delta") {
        text += chunk.delta;
      }
    }
    const cleaned = redactSecrets(text.replace(/\s+/g, " ").trim()).text;
    if (!cleaned) return null;
    return cleaned.length > MAX_DIGEST_CHARS
      ? `${cleaned.slice(0, MAX_DIGEST_CHARS - 1)}…`
      : cleaned;
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

export interface RunEventDigestOptions {
  eventId: string;
  events: EventStore;
  digestModel: ChatModelClient;
  media: MediaStore;
  attachments?: string[];
  videoClip?: { durationSec: number; frameHashes: string[] };
  userText?: string;
  timeoutMs?: number;
  force?: boolean;
  signal?: AbortSignal;
  onStateChanged?: (event: StoredEvent) => void;
}

/**
 * 为已落盘的用户事件并行生成附件摘要并回填至 events.metadata.attachmentDigest：
 * - 实时持久化 pending → done / failed 状态并通过 onStateChanged 推送 SSE，供前端展示极轻微标与重试入口。
 */
export async function digestEventAttachments(
  opts: RunEventDigestOptions,
): Promise<string | null> {
  const existing = opts.events.getById(opts.eventId);
  if (!existing || existing.status === "deleted") return null;
  if (
    !opts.force &&
    existing.metadata &&
    typeof existing.metadata.attachmentDigest === "string" &&
    existing.metadata.attachmentDigest.trim().length > 0
  ) {
    return existing.metadata.attachmentDigest.trim();
  }

  const pendingEv = opts.events.setAttachmentDigestState(opts.eventId, {
    status: "pending",
    ...(opts.force ? { digest: null } : {}),
  });
  if (pendingEv) opts.onStateChanged?.(pendingEv);

  const digest = await generateAttachmentDigest({
    digestModel: opts.digestModel,
    media: opts.media,
    attachments: opts.attachments,
    videoClip: opts.videoClip,
    userText: opts.userText ?? existing.content,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  if (!digest) {
    const failedEv = opts.events.setAttachmentDigestState(opts.eventId, { status: "failed" });
    if (failedEv) opts.onStateChanged?.(failedEv);
    return null;
  }
  const doneEv = opts.events.setAttachmentDigestState(opts.eventId, {
    status: "done",
    digest,
  });
  if (doneEv) opts.onStateChanged?.(doneEv);
  return digest;
}
