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
        wrapped: boolean;
      };
      expect(wrapBody.oldSessionId).toBe(oldSession);
      expect(wrapBody.newSessionId).not.toBe(oldSession);
      expect(wrapBody.queued).toBe(false);
      expect(wrapBody.wrapped).toBe(true);
      expect(runtime.engine.getContextUsage().usedTokens).toBe(0);
      // 同步收尾应在接口返回前已广播 turn.rollover wrapping -> done 且推进游标
      expect(frames.some((f) => f.event === "turn.rollover" && f.data.phase === "wrapping")).toBe(true);
      expect(frames.some((f) => f.event === "turn.rollover" && f.data.phase === "done")).toBe(true);
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

  test("SSE streamSeq 500 帧环形缓冲续传 + sync.reset + 工具达步数上限兜底收尾与异常告警", async () => {
    ctx = await createTestContext();
    const sse = new SseHub();

    // 1. SseHub 分配单调 streamSeq 并支持 Last-Event-ID 增量补帧与 sync.reset
    sse.emit("turn.start", { turnId: "t_buf", mode: "chat" });
    sse.emit("turn.text", { turnId: "t_buf", delta: "前半段" });
    sse.emit("turn.text", { turnId: "t_buf", delta: "后半段" });
    expect(sse.latestStreamSeq).toBe(3);

    const replayOk = sse.replaySince(1);
    expect(replayOk.resetReason).toBeNull();
    expect(replayOk.frames.map((f) => f.id)).toEqual([2, 3]);
    expect(replayOk.frames.map((f) => f.data.delta)).toEqual(["前半段", "后半段"]);

    const replayRestart = sse.replaySince(99);
    expect(replayRestart.resetReason).toBe("server_restarted");

    for (let i = 0; i < 510; i++) {
      sse.emit("turn.text", { turnId: "t_overflow", delta: `c${i}` });
    }
    const replayOverflow = sse.replaySince(2);
    expect(replayOverflow.resetReason).toBe("buffer_overflow");

    // 2. DirectEngine 连续 12 步工具调用达上限时，补跑一次无工具收尾步并落盘，且广播 message.created
    const mockChat = new MockChatModel();
    const registry = new ToolRegistry();
    registerCoreTier1Tools(registry, {
      memoryTools: ctx.tools,
      events: ctx.events,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      saveConfig: (cfg) => saveConfig(ctx!.dataDir, cfg),
    });

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

    const liveFrames: SseFrame[] = [];
    const unsub = sse.subscribe((f) => liveFrames.push(f));

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

    for (let i = 0; i < 12; i++) {
      mockChat.queueStream(() => [
        { type: "thinking_delta", delta: `第${i + 1}步思考` },
        { type: "tool_call", id: `tc-cap-${i}`, name: "glob", args: { pattern: "*.md" } },
      ]);
    }
    // 第 13 次调用应不传 tools 并收口出最终正文
    mockChat.queueStream(() => [{ type: "text_delta", delta: "十二步工具后终于整理完了。" }]);

    const postRes = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientMessageId: "cm-cap-1", content: "帮我多步查一下" }),
    });
    expect(postRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 80));

    expect(mockChat.requests).toHaveLength(13);
    expect(mockChat.requests[12].tools).toEqual([]);
    const createdAssistantFrames = liveFrames.filter(
      (f) =>
        f.event === "message.created" &&
        (f.data.message as { role?: string } | undefined)?.role === "assistant",
    );
    expect(createdAssistantFrames).toHaveLength(1);
    expect((createdAssistantFrames[0].data.message as { content: string }).content).toBe(
      "十二步工具后终于整理完了。",
    );

    // 3. 若流式模型意外抛错，必须触发 turn.error 而非静默卡死
    mockChat.queueStream(() => {
      throw new Error("unexpected socket reset");
    });
    const rErr = await engine.runTurn({
      mode: "chat",
      userText: "会报错吗",
      callbacks: {
        onTurnError: (e) => sse.emit("turn.error", { ...e }),
      },
    });
    expect(rErr.error?.code).toBe("PROVIDER_ERROR");
    expect(liveFrames.some((f) => f.event === "turn.error" && f.data.message === "unexpected socket reset")).toBe(
      true,
    );

    unsub();
  });

  test("多步工具调用中途失败后，POST /turns/:turnId/retry 支持断点续跑（不重复执行前序工具且支持连续重试）", async () => {
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

    let customToolRuns = 0;
    registry.register({
      name: "demo_counter",
      tier: 3,
      security: "auto",
      description: "测试断点续跑仅执行一次的计数器工具",
      tags: ["demo"],
      parameters: { type: "object", properties: {} },
      execute: async () => {
        customToolRuns += 1;
        return { ok: true, output: `counter=${customToolRuns}` };
      },
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

    // Step 0 成功：thinking + 调用 call_tool(demo_counter) 拿到 counter=1，并写一张笔记
    mockChat.queueStream(() => [
      { type: "thinking_delta", delta: "先调工具记一笔。", signature: "sig-step-0" },
      {
        type: "tool_call",
        id: "tc-resume-1",
        name: "call_tool",
        args: { name: "demo_counter", arguments: {} },
      },
      {
        type: "tool_call",
        id: "tc-resume-2",
        name: "write",
        args: {
          path: "daily/2026-11-21-resume.md",
          content: "---\ntitle: 续跑验证\nkind: episode\ntags: [测试]\n---\n已记录。\n",
        },
      },
    ]);
    // Step 1 失败：先吐半截废话再断掉（不应污染续跑上下文）
    mockChat.queueStream(() => [
      { type: "text_delta", delta: "坏掉的前缀" },
      { type: "error", code: "PROVIDER_ERROR", message: "upstream 502", retryable: true },
    ]);

    const sendRes = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientMessageId: "cm-resume-1", content: "帮我记一下" }),
    });
    expect(sendRes.status).toBe(202);
    const { turnId: turn1 } = (await sendRes.json()) as { turnId: string };
    await new Promise((r) => setTimeout(r, 40));

    expect(customToolRuns).toBe(1);
    expect(mockChat.requests).toHaveLength(2);

    // 第 1 次重试仍然在 Step 1 失败（AUTH_EXPIRED），验证断点会保留给第 2 次重试
    mockChat.queueStream(() => [
      { type: "error", code: "AUTH_EXPIRED", message: "401 expired", retryable: false },
    ]);
    const retry1Res = await app.request(`/api/v1/turns/${turn1}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    expect(retry1Res.status).toBe(202);
    const { turnId: turn2 } = (await retry1Res.json()) as { turnId: string };
    await new Promise((r) => setTimeout(r, 40));

    expect(customToolRuns).toBe(1);
    expect(mockChat.requests).toHaveLength(3);
    // 重试请求必须直接带着 Step 0 的 toolResult（counter=1）续跑
    const retry1ReqMsgs = mockChat.requests[2].messages;
    expect(retry1ReqMsgs.some((m) => m.role === "toolResult" && m.content === "counter=1")).toBe(true);

    // 第 2 次重试在 Step 1 成功收口
    frames.length = 0;
    mockChat.queueStream(() => [
      { type: "thinking_delta", delta: "接上刚才的结果回答。" },
      { type: "text_delta", delta: "已经帮你记好啦（counter=1）。" },
    ]);
    const retry2Res = await app.request(`/api/v1/turns/${turn2}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    expect(retry2Res.status).toBe(202);
    const { turnId: turn3 } = (await retry2Res.json()) as { turnId: string };
    await new Promise((r) => setTimeout(r, 50));

    // Step 0 工具绝未重复执行，且只发了 1 次模型请求就完成收口
    expect(customToolRuns).toBe(1);
    expect(mockChat.requests).toHaveLength(4);

    // 客户端在 turn3 上收到补推的前序思考、前序工具手账与最终正文
    const turn3Thinking = frames
      .filter((f) => f.event === "turn.thinking" && f.data.turnId === turn3)
      .map((f) => String(f.data.delta))
      .join("");
    expect(turn3Thinking).toContain("先调工具记一笔。");
    expect(turn3Thinking).toContain("接上刚才的结果回答。");
    expect(
      frames.some((f) => f.event === "turn.tool" && f.data.turnId === turn3 && f.data.name === "demo_counter"),
    ).toBe(true);

    // 历史记录中保留完整的合并思考、工具摘要与最终正文（不含失败的半截前缀）
    const histRes = await app.request("/api/v1/chat/history", {
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    const histBody = (await histRes.json()) as {
      items: Array<{
        role: string;
        content: string;
        thinking?: string | null;
        toolSummary?: Array<{ name: string; ok: boolean }>;
      }>;
    };
    const asst = histBody.items.find((i) => i.role === "assistant")!;
    expect(asst.content).toBe("已经帮你记好啦（counter=1）。");
    expect(asst.content).not.toContain("坏掉的前缀");
    expect(asst.thinking).toContain("先调工具记一笔。");
    expect(asst.thinking).toContain("接上刚才的结果回答。");
    expect(asst.toolSummary?.map((t) => t.name)).toEqual(["demo_counter", "write"]);

    unsub();
  });
});
