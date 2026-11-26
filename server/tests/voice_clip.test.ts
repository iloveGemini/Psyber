import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/api/app.ts";
import { MediaStore } from "../src/core/media.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import { SseHub } from "../src/engine/sse.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createTestContext, type TestContext } from "./helpers.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

let ctx: TestContext | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("语音条（voiceClip）端到端契约与上下文注入", () => {
  test("上传 audio/mp4 音频、发送带转写/无转写语音条，历史与 DirectEngine 正确透出", async () => {
    ctx = await createTestContext();
    const media = new MediaStore(ctx.db, ctx.dataDir);
    const sse = new SseHub();
    const registry = new ToolRegistry();
    const mockModel = new MockChatModel();
    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel: mockModel,
      db: ctx.db,
      media,
      retryDelaysMs: [0, 0],
    });
    const app = createApp({
      version: "0.1.0-test",
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      getActiveSessionId: () => engine.getActiveSessionId(),
      dataDir: ctx.dataDir,
      db: ctx.db,
      memoryIndex: ctx.index,
      sse,
      engine,
      media,
    });

    const authHeaders = { authorization: `Bearer ${ctx.authToken}` };

    // 1. 上传 m4a 音频到 /api/v1/media
    const form = new FormData();
    const fakeAudio = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    form.append("file", new File([fakeAudio], "voice.m4a", { type: "audio/mp4" }));
    const uploadRes = await app.request("/api/v1/media", {
      method: "POST",
      headers: authHeaders,
      body: form,
    });
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as {
      hash: string;
      url: string;
      mimeType: string;
      size: number;
    };
    expect(uploaded.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(uploaded.mimeType).toMatch(/^audio\/(mp4|m4a|x-m4a)$/);

    // 验证音频可按 hash 拉取
    const getAudioRes = await app.request(uploaded.url, { headers: authHeaders });
    expect(getAudioRes.status).toBe(200);
    expect(getAudioRes.headers.get("content-type")).toMatch(/^audio\/(mp4|m4a|x-m4a)$/);

    // 2. 发送带转写文字的语音条
    mockModel.queueStream(() => [
      { type: "text_delta", delta: "收到你的语音啦，路上注意安全。" },
      { type: "usage", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    ]);

    const sendRes = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        clientMessageId: "cm-voice-1",
        content: "我在走路不方便打字，等会儿到家聊",
        voiceClip: {
          mediaHash: uploaded.hash,
          durationSec: 6.4,
          mimeType: "audio/mp4",
        },
      }),
    });
    expect(sendRes.status).toBe(202);
    const sentBody = (await sendRes.json()) as {
      message: {
        id: string;
        content: string;
        voiceClip?: { mediaHash: string; durationSec: number; mimeType?: string };
      };
      deliveredAs: string;
    };
    expect(sentBody.deliveredAs).toBe("chat");
    expect(sentBody.message.voiceClip).toEqual({
      mediaHash: uploaded.hash,
      durationSec: 6.4,
      mimeType: "audio/mp4",
    });

    // 等 DirectEngine 异步轮次完成
    await Bun.sleep(40);
    expect(mockModel.requests.length).toBe(1);
    const firstUserMsg = mockModel.requests[0]!.messages.at(-1);
    expect(typeof firstUserMsg?.content).toBe("string");
    expect(firstUserMsg?.content as string).toContain("[语音 6秒] 我在走路不方便打字，等会儿到家聊");

    // 3. 发送纯语音条（识别文本为空也允许落盘和发送）
    mockModel.queueStream(() => [
      { type: "text_delta", delta: "刚刚好像有点吵没转出字来。" },
      { type: "usage", inputTokens: 120, outputTokens: 20, totalTokens: 140 },
    ]);
    const emptyTextRes = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        clientMessageId: "cm-voice-2",
        content: "",
        voiceClip: {
          mediaHash: uploaded.hash,
          durationSec: 2.8,
          mimeType: "audio/mp4",
        },
      }),
    });
    expect(emptyTextRes.status).toBe(202);
    await Bun.sleep(40);
    expect(mockModel.requests.length).toBe(2);
    const secondReqMessages = mockModel.requests[1]!.messages;
    // 历史消息里也保留了第一条的语音标记
    expect(secondReqMessages[0]?.content as string).toContain("[语音 6秒] 我在走路不方便打字，等会儿到家聊");
    // 当前轮无文字语音条给出事实占位说明
    expect(secondReqMessages.at(-1)?.content as string).toContain("[发来一条约 3 秒的语音，未能识别出文字]");

    // 4. 拉取历史接口确认 voiceClip 完整透出
    const histRes = await app.request("/api/v1/chat/history?limit=10", { headers: authHeaders });
    expect(histRes.status).toBe(200);
    const histBody = (await histRes.json()) as {
      items: Array<{ id: string; voiceClip?: { mediaHash: string; durationSec: number } }>;
    };
    const voiceItems = histBody.items.filter((it) => it.voiceClip);
    expect(voiceItems.length).toBe(2);
    expect(voiceItems[0]!.voiceClip?.mediaHash).toBe(uploaded.hash);
  });
});
