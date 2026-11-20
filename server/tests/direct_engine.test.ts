import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { saveConfig } from "../src/core/config.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import { ToolRegistry, registerCoreTier1Tools } from "../src/tools/registry.ts";
import { createTestContext, type TestContext } from "./helpers.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

let ctx: TestContext | null = null;

function buildEngine(c: TestContext, mockChat: MockChatModel, onRollover?: (oldId: string, newId: string) => void) {
  const registry = new ToolRegistry();
  registerCoreTier1Tools(registry, {
    memoryTools: c.tools,
    events: c.events,
    clock: c.clock,
    getConfig: () => c.config,
    saveConfig: (cfg) => saveConfig(c.dataDir, cfg),
  });
  return {
    registry,
    engine: new DirectEngine({
      dataDir: c.dataDir,
      promptsDir: PROMPTS_DIR,
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      memoryIndex: c.index,
      registry,
      chatModel: mockChat,
      db: c.db,
      retryDelaysMs: [0, 0],
      onRollover,
    }),
  };
}

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("Direct Engine + Tier 1 工具循环 + 三明治缓存与 wake 沉默协议", () => {
  test("单轮多步工具循环保留本步 thinking+signature，tool_result 绝不重复注入 <runtime_context>，跨轮历史剥除 thinking", async () => {
    ctx = await createTestContext();
    await ctx.tools.write("self.md", "---\ntitle: 关于我\nnamed: false\n---\n# 我是谁\n\n我叫未定名。\n");

    const mockChat = new MockChatModel();
    const { engine, registry } = buildEngine(ctx, mockChat);

    // 验证 Tier 1 固定 9 个工具按 ASCII 升序冻结
    const tier1Names = registry.getTier1Definitions().map((t) => t.name);
    expect(tier1Names).toEqual([
      "call_tool",
      "door",
      "edit",
      "express",
      "glob",
      "grep",
      "read",
      "tool_search",
      "write",
    ]);

    // Turn 1 Step 1：先思考 + 调用 edit 修改 self.md（触发 <prefix_delta> 但不改本会话 Static Prefix 快照）
    mockChat.queueStream(() => [
      { type: "thinking_delta", delta: "对方给了我一个名字，我顺手记进 self.md。", signature: "sig-step-1" },
      {
        type: "tool_call",
        id: "tc-1",
        name: "edit",
        args: { path: "self.md", old_string: "named: false", new_string: "named: true" },
      },
    ]);
    // Turn 1 Step 2：收到 tool_result 后输出最终正文
    mockChat.queueStream(() => [{ type: "text_delta", delta: "好，那以后我就叫这个名字啦。" }]);

    const r1 = await engine.runTurn({ mode: "chat", userText: "以后叫你阿白好不好？" });
    expect(r1.text).toBe("好，那以后我就叫这个名字啦。");
    expect(r1.touchedMemoryPaths).toEqual(["self.md"]);
    expect(r1.message?.thinking).toContain("顺手记进 self.md");

    // 检查 Step 1 请求：原话置顶、<runtime_context> 置底、创世模式已拼入
    const req1 = mockChat.requests[0];
    expect(req1.systemPrompt).toContain("<self>");
    expect(req1.systemPrompt).toContain("named: false");
    const firstUserMsg = req1.messages[req1.messages.length - 1];
    expect(firstUserMsg.role).toBe("user");
    expect(firstUserMsg.content.startsWith("以后叫你阿白好不好？")).toBe(true);
    expect(firstUserMsg.content).toContain("<runtime_context>");
    expect(firstUserMsg.content).toContain('circadian="清醒"');
    expect(firstUserMsg.content).toContain("weekday=");
    expect(firstUserMsg.content).toContain("<genesis_mode>");
    expect(Array.isArray(r1.message?.metadata?.toolCalls)).toBe(true);

    // 检查 Step 2 请求：单轮多步保留 thinking + signature，且 tool_result 不含 <runtime_context>
    const req2 = mockChat.requests[1];
    const assistantStep1 = req2.messages.find((m) => m.role === "assistant");
    expect(assistantStep1 && assistantStep1.role === "assistant" && assistantStep1.thinkingSignature).toBe("sig-step-1");
    const toolResMsg = req2.messages.find((m) => m.role === "toolResult");
    expect(toolResMsg && toolResMsg.role === "toolResult" && toolResMsg.content.includes("<runtime_context>")).toBe(false);

    // Turn 2：验证 Static Prefix 快照保持冻结（仍为 named: false），最新改动通过 <prefix_delta> 注入，且历史轮 thinking 被剥除
    mockChat.queueStream(() => [{ type: "text_delta", delta: "嗯，听着呢。" }]);
    await engine.runTurn({ mode: "chat", userText: "阿白在吗？" });

    const req3 = mockChat.requests[2];
    expect(req3.systemPrompt).toBe(req1.systemPrompt);
    const prevAssistant = req3.messages.find((m) => m.role === "assistant");
    expect(prevAssistant && prevAssistant.role === "assistant" && prevAssistant.thinking).toBeUndefined();
    const userMsg2 = req3.messages[req3.messages.length - 1];
    expect(userMsg2.role === "user" && userMsg2.content).toContain("<prefix_delta>");
    expect(userMsg2.role === "user" && userMsg2.content).toContain("named: true");
  });

  test("door 工具 Ring 1 guard 暂拒 cooling_off/departed，放行 closed 并记录事件", async () => {
    ctx = await createTestContext();
    const mockChat = new MockChatModel();
    const { engine } = buildEngine(ctx, mockChat);

    mockChat.queueStream(() => [
      { type: "tool_call", id: "tc-d1", name: "door", args: { state: "cooling_off" } },
      { type: "tool_call", id: "tc-d2", name: "door", args: { state: "closed", note: "先休息一会儿" } },
    ]);
    mockChat.queueStream(() => [{ type: "text_delta", delta: "我先关门歇会儿。" }]);

    const doorStates: string[] = [];
    await engine.runTurn({
      mode: "chat",
      userText: "想静一静吗",
      callbacks: { onDoorUpdated: (st) => doorStates.push(st) },
    });

    const req2 = mockChat.requests[1];
    const results = req2.messages.filter((m) => m.role === "toolResult");
    expect(results[0].role === "toolResult" && results[0].isError).toBe(true);
    expect(results[0].role === "toolResult" && results[0].content).toContain("当前版本尚未开启冷静期");
    expect(results[1].role === "toolResult" && results[1].isError).toBe(false);
    expect(ctx.config.door.state).toBe("closed");
    expect(doorStates).toEqual(["closed"]);
  });

  test("wake 模式 [SILENT] 静默抑制一切外部回调且不落盘，但仍推进 door_notes_read 游标", async () => {
    ctx = await createTestContext();
    const { event: noteEvent } = ctx.events.append({
      sessionId: "sess-0",
      role: "user",
      kind: "door_note",
      content: "门外放了杯温水",
    });
    expect(ctx.events.countUnreadDoorNotes()).toBe(1);

    const mockChat = new MockChatModel();
    const { engine } = buildEngine(ctx, mockChat);

    mockChat.queueStream(() => [
      { type: "thinking_delta", delta: "看到了纸条，但现在还不想说话。" },
      { type: "text_delta", delta: "[SIL" },
      { type: "text_delta", delta: "ENT]" },
    ]);

    const emitted: string[] = [];
    const res = await engine.runTurn({
      mode: "wake",
      wakeReason: "门缝有 1 条未读纸条",
      callbacks: {
        onTurnStart: () => emitted.push("start"),
        onThinkingDelta: () => emitted.push("thinking"),
        onTextDelta: () => emitted.push("text"),
        onTurnDone: () => emitted.push("done"),
      },
    });

    expect(res.silent).toBe(true);
    expect(res.message).toBeNull();
    expect(emitted).toEqual([]);
    // 门缝纸条游标已推进至 noteEvent.id
    expect(ctx.events.getCursor("door_notes_read")).toBe(noteEvent.id);
    expect(ctx.events.countUnreadDoorNotes()).toBe(0);
  });

  test("75% 上下文上限触发异步换段切新 session_id，AbortController 中止保留已生成前缀", async () => {
    ctx = await createTestContext();
    const mockChat = new MockChatModel(1000); // 75% 阈值 = 750 tokens
    let rolledPair: [string, string] | null = null;
    const { engine } = buildEngine(ctx, mockChat, (o, n) => {
      rolledPair = [o, n];
    });

    const initialSession = engine.getActiveSessionId();
    mockChat.queueStream(() => [
      { type: "text_delta", delta: "这条回复后就会触发换段。" },
      { type: "usage", inputTokens: 600, outputTokens: 200, totalTokens: 800 },
    ]);

    const r1 = await engine.runTurn({ mode: "chat", userText: "聊聊长话题" });
    expect(r1.rolledOver).toBe(true);
    expect(rolledPair).not.toBeNull();
    expect(engine.getActiveSessionId()).not.toBe(initialSession);

    // AbortController 中止生成
    const ac = new AbortController();
    mockChat.queueStream(async function* () {
      yield { type: "text_delta", delta: "前半句" };
      ac.abort();
      yield { type: "text_delta", delta: "不该出现的后半句" };
    });

    const r2 = await engine.runTurn({ mode: "chat", userText: "测试中止", signal: ac.signal });
    expect(r2.aborted).toBe(true);
    expect(r2.text).toBe("前半句");
    expect(r2.message?.metadata?.aborted).toBe(true);
  });

  test("主对话接入 3 步召回写入 recall_traces/recallCount、换段注入 <gist>+过渡上下文、429 退避重试成功", async () => {
    ctx = await createTestContext();
    await ctx.tools.write(
      "daily/2026-11-19-coffee.md",
      "---\ntitle: 巷口手冲咖啡\nkind: episode\ncreated: 2026-11-19\n---\n昨天下午喝了一杯埃塞水洗手冲。\n",
    );
    await ctx.tools.write(
      "gist/days/2026-11.md",
      "---\ntitle: 2026-11 日梗概\n---\n### 2026-11-19\n一起聊了手冲咖啡。\n",
    );

    const mockChat = new MockChatModel(1000);
    const { engine } = buildEngine(ctx, mockChat);

    // 前两次模拟 429 限流，第 3 次成功并触发 75% 换段
    mockChat.queueStream(() => [{ type: "error", code: "RATE_LIMITED", message: "429", retryable: true }]);
    mockChat.queueStream(() => [{ type: "error", code: "RATE_LIMITED", message: "429", retryable: true }]);
    mockChat.queueStream(() => [
      { type: "text_delta", delta: "记得那杯埃塞手冲！" },
      { type: "usage", inputTokens: 600, outputTokens: 200, totalTokens: 800 },
    ]);

    const doneInfos: Array<{ recallCount: number; mode: string }> = [];
    let errCount = 0;
    const r1 = await engine.runTurn({
      mode: "chat",
      userText: "还记得巷口那家手冲咖啡吗",
      callbacks: {
        onTurnDone: (info) => {
          doneInfos.push({ recallCount: info.recallCount, mode: info.mode });
        },
        onTurnError: () => {
          errCount += 1;
        },
      },
    });

    expect(errCount).toBe(0);
    expect(r1.text).toBe("记得那杯埃塞手冲！");
    expect(r1.recallCount).toBeGreaterThan(0);
    expect(doneInfos[0]?.recallCount).toBe(r1.recallCount);
    expect(doneInfos[0]?.mode).toBe("chat");
    expect(r1.rolledOver).toBe(true);

    // 换段后的下一轮应注入 <gist> 与上段对话过渡
    mockChat.queueStream(() => [{ type: "text_delta", delta: "接着聊。" }]);
    await engine.runTurn({ mode: "chat", userText: "新会话测试" });
    const postRolloverReq = mockChat.requests[mockChat.requests.length - 1];
    const assistantMsgs = postRolloverReq.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.some((m) => m.content.includes("<gist>") && m.content.includes("手冲咖啡"))).toBe(true);
    expect(assistantMsgs.some((m) => m.content.includes("记得那杯埃塞手冲！"))).toBe(true);
  });
});
