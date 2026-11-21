import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { createApp } from "../src/api/app.ts";
import { saveConfig } from "../src/core/config.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import { SseHub, type SseFrame } from "../src/engine/sse.ts";
import { bootPsyberRuntime } from "../src/index.ts";
import { ToolRegistry, registerCoreTier1Tools } from "../src/tools/registry.ts";
import { createTestContext, type TestContext } from "./helpers.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

describe("Ring 1.5 聊天流升级：原地重试、手动存记忆换段、工具手账与沉默/切模事件", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  test("POST /turns/:turnId/retry 原地无痕重试不重复插入用户消息，支持连续失败后多次重试，成功后返 409", async () => {
    ctx = await createTestContext();
    const mockChat = new MockChatModel();
    const registry = new ToolRegistry();
    registerCoreTier1Tools(registry, {
      memoryTools: ctx.tools,
      events: ctx.events,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      saveConfig: (cfg) => saveConfig(ctx!.dataDir, cfg),
    });

    const sse = new SseHub();
    const frames: SseFrame[] = [];
    const unsub = sse.subscribe((f) => frames.push(f));

    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: path.resolve(import.meta.dir, "../../prompts"),
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel: mockChat,
      db: ctx.db,
      retryDelaysMs: [0, 0],
    });

    const app = createApp({
      version: "0.1.0",
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      getActiveSessionId: () => engine.getActiveSessionId(),
      db: ctx.db,
      sse,
      engine,
    });

    // 1. 首轮调用直接因 AUTH_EXPIRED 失败
    mockChat.queueStream(() => [
      { type: "error", code: "AUTH_EXPIRED", message: "401 invalid key", retryable: false },
    ]);

    const sendRes = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientMessageId: "cm-retry-1", content: "今天天气真好" }),
    });
    expect(sendRes.status).toBe(202);
    const sendBody = (await sendRes.json()) as { turnId: string };
    await new Promise((r) => setTimeout(r, 30));

    const errFrames1 = frames.filter((f) => f.event === "turn.error");
    expect(errFrames1).toHaveLength(1);
    expect(errFrames1[0].data.turnId).toBe(sendBody.turnId);

    // 2. 第 1 次原地重试仍遇到限流耗尽
    mockChat.queueStream(() => [
      { type: "error", code: "RATE_LIMITED", message: "429", retryable: true },
    ]);
    mockChat.queueStream(() => [
      { type: "error", code: "RATE_LIMITED", message: "429", retryable: true },
    ]);
    mockChat.queueStream(() => [
      { type: "error", code: "RATE_LIMITED", message: "429", retryable: true },
    ]);

    const retry1Res = await app.request(`/api/v1/turns/${sendBody.turnId}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    expect(retry1Res.status).toBe(202);
    const retry1Body = (await retry1Res.json()) as { turnId: string; retriedFromTurnId: string };
    expect(retry1Body.retriedFromTurnId).toBe(sendBody.turnId);
    expect(retry1Body.turnId).not.toBe(sendBody.turnId);
    await new Promise((r) => setTimeout(r, 40));

    // 3. 第 2 次原地重试成功，且工具进度与 toolSummary 同步落盘
    mockChat.queueStream(() => [
      { type: "thinking_delta", delta: "先看看记忆目录" },
      { type: "tool_call", id: "tc-1", name: "glob", args: { pattern: "*.md" } },
    ]);
    mockChat.queueStream(() => [
      { type: "text_delta", delta: "嗯，阳光确实不错。" },
      { type: "usage", inputTokens: 120, outputTokens: 20, totalTokens: 140 },
    ]);

    const retry2Res = await app.request(`/api/v1/turns/${retry1Body.turnId}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    expect(retry2Res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 40));

    // 验证用户消息只有 1 条，没有重复气泡
    const historyRes = await app.request("/api/v1/chat/history", {
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    expect(historyRes.status).toBe(200);
    const historyBody = (await historyRes.json()) as {
      items: Array<{
        role: string;
        content: string;
        toolSummary?: Array<{ name: string; label: string; ok: boolean; kind?: string }>;
      }>;
      contextUsage?: { usedTokens: number; limitTokens: number; ratio: number };
    };
    const userMsgs = historyBody.items.filter((i) => i.role === "user");
    const asstMsgs = historyBody.items.filter((i) => i.role === "assistant");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe("今天天气真好");
    expect(asstMsgs).toHaveLength(1);
    expect(asstMsgs[0].content).toBe("嗯，阳光确实不错。");
    expect(asstMsgs[0].toolSummary).toEqual([
      { name: "glob", label: "翻了翻记忆目录", ok: true, kind: "general" },
    ]);
    expect(historyBody.contextUsage?.usedTokens).toBe(140);

    // 验证 turn.tool 事件已推送
    const toolFrames = frames.filter((f) => f.event === "turn.tool");
    expect(toolFrames.some((f) => f.data.status === "running" && f.data.label === "翻了翻记忆目录")).toBe(
      true,
    );
    expect(toolFrames.some((f) => f.data.status === "done" && f.data.name === "glob")).toBe(true);

    // 4. 已经成功后的轮次再次重试返 409 TURN_NOT_RETRYABLE
    const retryAfterDone = await app.request(`/api/v1/turns/${sendBody.turnId}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    expect(retryAfterDone.status).toBe(409);

    unsub();
  });

  test("POST /chat/wrap-up 手动存记忆换段并触发异步整理，foreground 收到 turn.silence", async () => {
    ctx = await createTestContext();
    const mockChat = new MockChatModel(1000);
    const runtime = await bootPsyberRuntime({
      dataDir: ctx.dataDir,
      promptsDir: path.resolve(import.meta.dir, "../../prompts"),
      clock: ctx.clock,
      chatModel: mockChat,
      startHeartbeatTimer: false,
    });

    try {
      const frames: SseFrame[] = [];
      const unsub = runtime.sse.subscribe((f) => frames.push(f), { foreground: true });

      // 跑一轮普通对话建立初始上下文用量
      mockChat.queueStream(() => [
        { type: "text_delta", delta: "聊完了这件事。" },
        { type: "usage", inputTokens: 300, outputTokens: 100, totalTokens: 400 },
      ]);
      await runtime.engine.runTurn({ mode: "chat", userText: "这件事就这么定了" });
      expect(runtime.engine.getContextUsage().usedTokens).toBe(400);

      // 触发手动存记忆换段，后台 tidy 轮会消费对话
      mockChat.queueStream(() => [
        { type: "text_delta", delta: '{"summary": "手动换段完成"}' },
      ]);
      const oldSession = runtime.engine.getActiveSessionId();
      const wrapRes = await runtime.app.request("/api/v1/chat/wrap-up", {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.authToken}` },
      });
      expect(wrapRes.status).toBe(202);
      const wrapBody = (await wrapRes.json()) as {
        oldSessionId: string;
        newSessionId: string;
        queued: boolean;
      };
      expect(wrapBody.oldSessionId).toBe(oldSession);
      expect(wrapBody.newSessionId).not.toBe(oldSession);
      expect(wrapBody.queued).toBe(true);
      expect(runtime.engine.getContextUsage().usedTokens).toBe(0);
      await runtime.waitForIdle();

      // 前台订阅时，wake [SILENT] 仅发送轻量 turn.silence，不落盘聊天消息
      ctx.clock.advance(5 * 3600_000);
      mockChat.queueStream(() => [{ type: "text_delta", delta: "[SILENT]" }]);
      await runtime.tickHeartbeat();
      expect(frames.some((f) => f.event === "turn.silence" && f.data.ownTime === true)).toBe(true);

      unsub();
    } finally {
      await runtime.stop();
    }
  });
});
