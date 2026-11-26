import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { MediaStore } from "../src/core/media.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import { runMemoryTidyTask } from "../src/engine/tidy.ts";
import { registerViewMediaTool } from "../src/extensions/view_media.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";
import { MemoryTools } from "../src/memory/tools.ts";
import { ToolRegistry, registerCoreTier1Tools } from "../src/tools/registry.ts";
import { createTestContext, type TestContext } from "./helpers.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");
const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

let ctx: TestContext | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("附件并行摘要（digest）、会话前缀锁与 view_media 按需复看", () => {
  test("Turn 1 并行摘要且多步工具不摘原图，Turn 2 历史带 media:<hash> 与摘要", async () => {
    ctx = await createTestContext();
    const media = new MediaStore(ctx.db, ctx.dataDir);
    const saved = await media.save({
      bytes: TINY_PNG,
      mimeType: "image/png",
      origin: "user_upload",
      nowMs: ctx.clock.now(),
    });

    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);
    const registry = new ToolRegistry();
    registerCoreTier1Tools(registry, {
      memoryTools,
      events: ctx.events,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      saveConfig: async () => {},
    });
    registerViewMediaTool(registry, { media });

    const chatModel = new MockChatModel();
    const digestModel = new MockChatModel();

    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel,
      digestModel,
      forceDigestModel: true,
      db: ctx.db,
      media,
      retryDelaysMs: [0, 0],
    });

    // Turn 1：主模型先调一次工具，再回复正文（验证当轮多步循环内不摘原图）
    digestModel.queueStream(() => [
      { type: "text_delta", delta: "一只橘猫正趴在黑色机械键盘上睡觉，旁边有一杯热美式。" },
      { type: "usage", inputTokens: 80, outputTokens: 24, totalTokens: 104 },
    ]);
    chatModel.queueStream(() => [
      { type: "tool_call", id: "tc-1", name: "glob", args: { pattern: "core/*.md" } },
      { type: "usage", inputTokens: 300, outputTokens: 20, totalTokens: 320 },
    ]);
    chatModel.queueStream(() => [
      { type: "text_delta", delta: "哇，这只橘猫睡得也太香了吧！" },
      { type: "usage", inputTokens: 350, outputTokens: 20, totalTokens: 370 },
    ]);

    const { event: userEv1 } = ctx.events.append({
      sessionId: engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "你看它又占我键盘",
      metadata: { attachments: [saved.hash] },
    });

    await engine.runTurn({
      mode: "chat",
      userText: userEv1.content,
      userEventId: userEv1.id,
      attachments: [saved.hash],
    });
    await engine.waitForPendingDigests();

    // 验证当轮 Step 1 与 Step 2 的 user 消息完全一致（包含原图块与 media:<hash> 引用，绝不中途摘图破缓存）
    expect(chatModel.requests.length).toBe(2);
    const step1User = chatModel.requests[0]!.messages.at(-1)!;
    const step2User = chatModel.requests[1]!.messages[0]!;
    expect(Array.isArray(step1User.content)).toBe(true);
    expect(step2User.content).toEqual(step1User.content);
    const step1Text = (step1User.content as Array<{ type: string; text?: string }>)[0]!.text ?? "";
    expect(step1Text).toContain(`[图片引用: media:${saved.hash}]`);

    // 验证 digest 已落库到 events.metadata.attachmentDigest
    expect(digestModel.requests.length).toBe(1);
    const storedAfterDigest = ctx.events.getById(userEv1.id);
    expect(storedAfterDigest?.metadata?.attachmentDigest).toBe(
      "一只橘猫正趴在黑色机械键盘上睡觉，旁边有一杯热美式。",
    );

    // Turn 2：历史消息自动剥掉原图 base64，保留 media:<hash> 与摘要
    chatModel.queueStream(() => [
      { type: "text_delta", delta: "旁边那杯咖啡小心别被它打翻了。" },
      { type: "usage", inputTokens: 200, outputTokens: 20, totalTokens: 220 },
    ]);
    const { event: userEv2 } = ctx.events.append({
      sessionId: engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "我还得赶紧把杯子挪开",
    });
    await engine.runTurn({
      mode: "chat",
      userText: userEv2.content,
      userEventId: userEv2.id,
    });

    const turn2HistoryUser = chatModel.requests[2]!.messages[0]!;
    expect(typeof turn2HistoryUser.content).toBe("string");
    expect(turn2HistoryUser.content as string).toContain(`media:${saved.hash}`);
    expect(turn2HistoryUser.content as string).toContain(
      "一只橘猫正趴在黑色机械键盘上睡觉，旁边有一杯热美式。",
    );
  });

  test("异步 digest 晚于 Turn 2 完成时，会话前缀锁保证 Turn 3 不击穿缓存，且冷写 tidy 仍可见完整摘要", async () => {
    ctx = await createTestContext();
    const media = new MediaStore(ctx.db, ctx.dataDir);
    const saved = await media.save({
      bytes: TINY_PNG,
      mimeType: "image/png",
      origin: "user_upload",
      nowMs: ctx.clock.now(),
    });

    let releaseDigest!: () => void;
    const digestGate = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    const slowDigestModel: ChatModelClient = {
      contextWindow: 128_000,
      modelId: "slow-digest",
      async *stream(_req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        await digestGate;
        yield { type: "text_delta", delta: "一张手写购物清单，写着牛奶、鸡蛋和苹果。" };
        yield { type: "usage", inputTokens: 50, outputTokens: 15, totalTokens: 65 };
      },
    };

    const registry = new ToolRegistry();
    const chatModel = new MockChatModel();
    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel,
      digestModel: slowDigestModel,
      forceDigestModel: true,
      db: ctx.db,
      media,
      retryDelaysMs: [0, 0],
    });

    // Turn 1 发图（slowDigestModel 尚未完成）
    chatModel.queueStream(() => [
      { type: "text_delta", delta: "收到清单啦。" },
      { type: "usage", inputTokens: 200, outputTokens: 10, totalTokens: 210 },
    ]);
    const { event: u1 } = ctx.events.append({
      sessionId: engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "帮我记一下这张清单",
      metadata: { attachments: [saved.hash] },
    });
    await engine.runTurn({
      mode: "chat",
      userText: u1.content,
      userEventId: u1.id,
      attachments: [saved.hash],
    });

    // Turn 2 在 digest 完成之前就发来了 → 首次渲染并锁定历史前缀（不含摘要）
    chatModel.queueStream(() => [
      { type: "text_delta", delta: "好的没问题。" },
      { type: "usage", inputTokens: 220, outputTokens: 10, totalTokens: 230 },
    ]);
    const { event: u2 } = ctx.events.append({
      sessionId: engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "我等下去超市",
    });
    await engine.runTurn({
      mode: "chat",
      userText: u2.content,
      userEventId: u2.id,
    });
    const turn2FrozenU1 = chatModel.requests[1]!.messages[0]!.content as string;
    expect(turn2FrozenU1).toContain(`[图片 media:${saved.hash}]`);
    expect(turn2FrozenU1).not.toContain("摘要：");

    // 放行 slowDigestModel，摘要落库到 SQLite
    releaseDigest();
    await engine.waitForPendingDigests();
    expect(ctx.events.getById(u1.id)?.metadata?.attachmentDigest).toBe(
      "一张手写购物清单，写着牛奶、鸡蛋和苹果。",
    );

    // Turn 3 在同一会话内继续聊 → 历史前缀必须与 Turn 2 逐字节一致，绝不中途改写击穿缓存
    chatModel.queueStream(() => [
      { type: "text_delta", delta: "路上注意安全。" },
      { type: "usage", inputTokens: 240, outputTokens: 10, totalTokens: 250 },
    ]);
    const { event: u3 } = ctx.events.append({
      sessionId: engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "出发啦",
    });
    await engine.runTurn({
      mode: "chat",
      userText: u3.content,
      userEventId: u3.id,
    });
    const turn3FrozenU1 = chatModel.requests[2]!.messages[0]!.content as string;
    expect(turn3FrozenU1).toBe(turn2FrozenU1);

    // 冷写 tidy 整理轮读取 SQLite 时，能完整看到落库的附件摘要
    const tidyModel = new MockChatModel();
    tidyModel.queueStream(() => [
      { type: "text_delta", delta: '{"summary": "记录购物清单对话"}' },
      { type: "usage", inputTokens: 200, outputTokens: 20, totalTokens: 220 },
    ]);
    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);
    const tidyRes = await runMemoryTidyTask(
      {
        db: ctx.db,
        dataDir: ctx.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: ctx.clock,
        events: ctx.events,
        memoryIndex: ctx.index,
        memoryTools,
        chatModel: tidyModel,
        retryDelaysMs: [],
      },
      { taskType: "daily_wrapup" },
    );
    expect(tidyRes.ok).toBe(true);
    const tidyUserMsg = tidyModel.requests[0]!.messages[0]!.content as string;
    expect(tidyUserMsg).toContain("一张手写购物清单，写着牛奶、鸡蛋和苹果。");
  });

  test("view_media 按需复看原图：当轮 toolResult 附带临时图片块，下轮自动回收不污染历史", async () => {
    ctx = await createTestContext();
    const media = new MediaStore(ctx.db, ctx.dataDir);
    const savedImg = await media.save({
      bytes: TINY_PNG,
      mimeType: "image/png",
      origin: "user_upload",
      nowMs: ctx.clock.now(),
    });
    const savedAudio = await media.save({
      bytes: new Uint8Array([0x00, 0x01, 0x02]),
      mimeType: "audio/mp4",
      origin: "user_upload",
      nowMs: ctx.clock.now(),
    });

    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);
    const registry = new ToolRegistry();
    registerCoreTier1Tools(registry, {
      memoryTools,
      events: ctx.events,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      saveConfig: async () => {},
    });
    registerViewMediaTool(registry, { media });

    // 非法 mediaId 与非图片 MIME 均被安全拦截
    const dummyCtx = {
      turnId: "t0",
      sessionId: "s0",
      mode: "chat" as const,
      touchedMemoryPaths: new Set<string>(),
      expressionCount: 0,
      expressions: [],
    };
    const badId = await registry.invoke("view_media", { mediaId: "../secret.png" }, dummyCtx);
    expect(badId.ok).toBe(false);
    const nonImage = await registry.invoke(
      "view_media",
      { mediaId: `media:${savedAudio.hash}` },
      dummyCtx,
    );
    expect(nonImage.ok).toBe(false);
    expect(nonImage.output).toContain("仅支持查看图片");

    // 正常调用 call_tool -> view_media：验证当轮 Step 2 收到 toolResult.images，Turn 2 历史不再带原图
    const chatModel = new MockChatModel();
    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel,
      db: ctx.db,
      media,
      retryDelaysMs: [0, 0],
    });

    chatModel.queueStream(() => [
      {
        type: "tool_call",
        id: "tc-view",
        name: "call_tool",
        args: { name: "view_media", arguments: { mediaId: `media:${savedImg.hash}` } },
      },
      { type: "usage", inputTokens: 150, outputTokens: 25, totalTokens: 175 },
    ]);
    chatModel.queueStream(() => [
      { type: "text_delta", delta: "我重新看了原图，右上角写着 2026。" },
      { type: "usage", inputTokens: 400, outputTokens: 20, totalTokens: 420 },
    ]);

    const { event: u1 } = ctx.events.append({
      sessionId: engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "帮我再看一眼那张图右上角的数字",
    });
    await engine.runTurn({ mode: "chat", userText: u1.content, userEventId: u1.id });

    expect(chatModel.requests.length).toBe(2);
    const toolResultMsg = chatModel.requests[1]!.messages.find((m) => m.role === "toolResult");
    expect(toolResultMsg).toBeDefined();
    if (toolResultMsg?.role === "toolResult") {
      expect(toolResultMsg.images?.length).toBe(1);
      expect(toolResultMsg.images![0]!.mimeType).toBe("image/png");
      expect(toolResultMsg.images![0]!.data).toBe(Buffer.from(TINY_PNG).toString("base64"));
    }

    // 下一轮历史中绝不残留 base64 原图
    chatModel.queueStream(() => [
      { type: "text_delta", delta: "记住了，2026。" },
      { type: "usage", inputTokens: 180, outputTokens: 10, totalTokens: 190 },
    ]);
    const { event: u2 } = ctx.events.append({
      sessionId: engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "对就是这个",
    });
    await engine.runTurn({ mode: "chat", userText: u2.content, userEventId: u2.id });
    const nextTurnMessages = chatModel.requests[2]!.messages;
    expect(nextTurnMessages.every((m) => typeof m.content === "string")).toBe(true);
  });

  test("未配置 llm.slots.digest 且未强制启用时，零额外摘要调用", async () => {
    ctx = await createTestContext();
    const media = new MediaStore(ctx.db, ctx.dataDir);
    const saved = await media.save({
      bytes: TINY_PNG,
      mimeType: "image/png",
      origin: "user_upload",
      nowMs: ctx.clock.now(),
    });

    const registry = new ToolRegistry();
    const chatModel = new MockChatModel();
    const digestModel = new MockChatModel();
    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel,
      digestModel,
      db: ctx.db,
      media,
      retryDelaysMs: [0, 0],
    });

    chatModel.queueStream(() => [
      { type: "text_delta", delta: "好看！" },
      { type: "usage", inputTokens: 150, outputTokens: 10, totalTokens: 160 },
    ]);
    const { event: u1 } = ctx.events.append({
      sessionId: engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "看看新拍的",
      metadata: { attachments: [saved.hash] },
    });
    await engine.runTurn({
      mode: "chat",
      userText: u1.content,
      userEventId: u1.id,
      attachments: [saved.hash],
    });
    await engine.waitForPendingDigests();

    expect(digestModel.requests.length).toBe(0);
    expect(ctx.events.getById(u1.id)?.metadata?.attachmentDigest).toBeUndefined();
  });

  test("摘要失败时标 failed，调用 POST /api/v1/chat/messages/:id/digest 可手动重试并推送 SSE", async () => {
    ctx = await createTestContext();
    const { createApp } = await import("../src/api/app.ts");
    const { SseHub } = await import("../src/engine/sse.ts");
    const media = new MediaStore(ctx.db, ctx.dataDir);
    const saved = await media.save({
      bytes: TINY_PNG,
      mimeType: "image/png",
      origin: "user_upload",
      nowMs: ctx.clock.now(),
    });

    const sse = new SseHub();
    const sseStatuses: string[] = [];
    sse.subscribe((frame) => {
      if (frame.event === "message.updated" && frame.data?.action === "digest") {
        const msg = frame.data.message as { attachmentDigestStatus?: string } | undefined;
        if (msg?.attachmentDigestStatus) sseStatuses.push(msg.attachmentDigestStatus);
      }
    });

    const chatModel = new MockChatModel();
    const digestModel = new MockChatModel();
    const registry = new ToolRegistry();
    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel,
      digestModel,
      forceDigestModel: true,
      onAttachmentDigestUpdated: (ev) => {
        sse.emit("message.updated", {
          action: "digest",
          messageId: ev.id,
          message: {
            ...ev,
            attachmentDigest: ev.metadata?.attachmentDigest,
            attachmentDigestStatus: ev.metadata?.attachmentDigestStatus,
          },
        });
      },
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

    // 首次摘要失败 -> status 标为 failed
    digestModel.queueStream(() => [
      { type: "error", code: "PROVIDER_ERROR", message: "boom", retryable: true },
    ]);
    chatModel.queueStream(() => [{ type: "text_delta", delta: "看到啦" }]);
    const sendRes = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientMessageId: "cm-digest-retry-1",
        content: "看看这张",
        attachments: [saved.hash],
      }),
    });
    expect(sendRes.status).toBe(202);
    const { message } = (await sendRes.json()) as { message: { id: string } };
    await engine.waitForPendingDigests();
    expect(ctx.events.getById(message.id)?.metadata?.attachmentDigestStatus).toBe("failed");

    // 用户点淡灰提醒图标触发重试 -> 成功落库并标 done
    digestModel.queueStream(() => [
      { type: "text_delta", delta: "窗台上摆着一盆绿萝和一只白色马克杯。" },
    ]);
    const retryRes = await app.request(`/api/v1/chat/messages/${message.id}/digest`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.authToken}` },
    });
    expect(retryRes.status).toBe(202);
    await engine.waitForPendingDigests();

    const updated = ctx.events.getById(message.id);
    expect(updated?.metadata?.attachmentDigestStatus).toBe("done");
    expect(updated?.metadata?.attachmentDigest).toBe("窗台上摆着一盆绿萝和一只白色马克杯。");
    expect(sseStatuses).toEqual(["pending", "failed", "pending", "done"]);
  });
});
