import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { createApp } from "../src/api/app.ts";
import { saveConfig } from "../src/core/config.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import { SseHub, type SseFrame } from "../src/engine/sse.ts";
import { recallMemories, type EmbeddingClient } from "../src/memory/recall.ts";
import {
  ToolRegistry,
  registerCoreTier1Tools,
  type ExpressionPayload,
  type ToolExecutionContext,
} from "../src/tools/registry.ts";
import { createTestContext, type TestContext } from "./helpers.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

class MockEmbeddingClient implements EmbeddingClient {
  readonly modelKey = "mock:bow-32";
  public failWith?: Error;

  async embed(text: string): Promise<Float32Array> {
    if (this.failWith) throw this.failWith;
    const vec = new Float32Array(32);
    const chars = Array.from(text.normalize("NFKC").toLowerCase());
    for (let i = 0; i < chars.length; i++) {
      vec[chars[i].charCodeAt(0) % 32] += 1;
    }
    return vec;
  }
}

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("Ring 1 切片 2: 极简 3 步召回、三层工具注册中心与 SSE 联调", () => {
  test("极简 3 步召回：空档短路、活动触发直挂、Embedding 故障降级 FTS5、2h 去重与评测接口", async () => {
    ctx = await createTestContext();

    expect(
      (
        await ctx.tools.write(
          "activities/REGISTRY.yaml",
          [
            "spaces:",
            "  stories:",
            "    title: 睡前故事",
            "    triggers: [睡前故事, 接着讲]",
            "    decay: none",
            '    card_style: "一个故事系列一张卡"',
          ].join("\n"),
        )
      ).ok,
    ).toBe(true);

    expect(
      (
        await ctx.tools.write(
          "activities/stories/lighthouse.md",
          "---\ntitle: 雾里的守灯人\nkind: serial\n---\n连载停在第 4 章：主角在灯塔回廊听见昨天的录音。\n",
        )
      ).ok,
    ).toBe(true);

    expect(
      (
        await ctx.tools.write(
          "daily/2026-11-19-cat.md",
          "---\ntitle: 楼下三花猫\nkind: episode\ncreated: 2026-11-19\n---\n昨天傍晚在楼下喂了一只特别黏人的三花猫。\n",
        )
      ).ok,
    ).toBe(true);

    // 1. 空档短路
    const blank = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-1",
      turnId: "t-blank",
      query: "好的",
    });
    expect(blank.skipped).toBe(true);

    // 2. 命中活动触发词 -> Track 1 直挂睡前故事卡
    const actHit = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-1",
      turnId: "t-story",
      query: "今晚想听睡前故事",
    });
    expect(
      actHit.items.some((i) => i.path === "activities/stories/lighthouse.md" && i.track === "same_activity"),
    ).toBe(true);

    // 落盘对应 active 助手回复后，2h 内同一会话重复问才被去重（对齐 Spec 02 §7.5）
    const { event: storyReply } = ctx.events.append({
      sessionId: "sess-1",
      turnId: "t-story",
      role: "assistant",
      kind: "chat",
      content: "好呀，接着听守灯人。",
    });

    // 3. 2h 内同一会话重复问被去重，但“接着讲”豁免
    const deduped = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-1",
      turnId: "t-story-2",
      query: "今晚想听睡前故事",
    });
    expect(deduped.items.some((i) => i.path === "activities/stories/lighthouse.md")).toBe(false);

    // 若原助手回复被软删，则不再阻挡后续召回
    ctx.events.softDelete(storyReply.id);
    const afterDelete = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-1",
      turnId: "t-story-after-del",
      query: "今晚想听睡前故事",
    });
    expect(afterDelete.items.some((i) => i.path === "activities/stories/lighthouse.md")).toBe(true);

    // 重新写入 active 助手回复并验证“接着讲”续接豁免
    ctx.events.append({
      sessionId: "sess-1",
      turnId: "t-story-after-del",
      role: "assistant",
      kind: "chat",
      content: "继续讲。",
    });
    const continued = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-1",
      turnId: "t-story-3",
      query: "接着讲睡前故事吧",
    });
    expect(continued.items.some((i) => i.path === "activities/stories/lighthouse.md")).toBe(true);

    // 4. Embedding 故障平滑降级到 FTS5 2-gram
    const brokenEmbed = new MockEmbeddingClient();
    brokenEmbed.failWith = new Error("embedding timeout");
    const fallback = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-2",
      turnId: "t-cat",
      query: "还记得楼下那只三花猫吗",
      embedding: brokenEmbed,
    });
    expect(fallback.items.some((i) => i.path === "daily/2026-11-19-cat.md")).toBe(true);

    // 5. /turns/:turnId/recall 与 /recall/feedback（带 Bearer 鉴权）
    const app = createApp({
      version: "0.1.0",
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      getActiveSessionId: () => "sess-2",
      db: ctx.db,
    });

    const authHeaders = {
      authorization: `Bearer ${ctx.authToken}`,
      "content-type": "application/json",
    };

    const fbRes = await app.request("/api/v1/recall/feedback", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        turnId: "t-cat",
        cardPath: "daily/2026-11-19-cat.md",
        verdict: "useful",
      }),
    });
    expect(fbRes.status).toBe(200);

    const traceRes = await app.request("/api/v1/turns/t-cat/recall", {
      headers: { authorization: `Bearer ${ctx.authToken}` },
    });
    const traceJson = (await traceRes.json()) as {
      items: Array<{ cardPath: string; feedback?: string }>;
    };
    expect(traceJson.items[0].cardPath).toBe("daily/2026-11-19-cat.md");
    expect(traceJson.items[0].feedback).toBe("useful");
  });

  test("express 单轮 3 次节流 + durationSec 夹逼 + Tier 3 tool_search/call_tool + SSE 7 类推流", async () => {
    ctx = await createTestContext();
    const registry = new ToolRegistry();
    registerCoreTier1Tools(registry, {
      memoryTools: ctx.tools,
      events: ctx.events,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      saveConfig: (cfg) => saveConfig(ctx!.dataDir, cfg),
    });

    registry.register({
      name: "demo.ping",
      tier: 3,
      security: "auto",
      description: "测试用扩展探针工具",
      tags: ["demo", "探针"],
      parameters: { type: "object", properties: { msg: { type: "string" } } },
      execute: async (args) => ({ ok: true, output: `pong:${String(args.msg ?? "")}` }),
    });

    const emittedExpressions: ExpressionPayload[] = [];
    const toolCtx: ToolExecutionContext = {
      turnId: "turn-1",
      sessionId: "sess-1",
      mode: "chat",
      touchedMemoryPaths: new Set(),
      expressionCount: 0,
      expressions: [],
      onExpression: (p) => emittedExpressions.push(p),
    };

    // express 贴纸校验：未知贴纸报错并带建议，合法贴纸附带 sticker 视图并递增 use_count
    ctx.db
      .query("INSERT INTO stickers (id, label, pack, media_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("cat-nod", "小猫点头", "default", "b".repeat(64), ctx.clock.now());
    const badStickerCtx: ToolExecutionContext = {
      ...toolCtx,
      expressionCount: 0,
      expressions: [],
      onExpression: undefined,
    };
    const badSticker = await registry.invoke("express", { stickerId: "missing-id" }, badStickerCtx);
    expect(badSticker.ok).toBe(false);
    expect(badSticker.output).toContain("cat-nod");

    const okSticker = await registry.invoke("express", { stickerId: "cat-nod" }, badStickerCtx);
    expect(okSticker.ok).toBe(true);
    expect(badStickerCtx.expressions[0].sticker?.url).toBe(`/api/v1/media/${"b".repeat(64)}`);
    expect(ctx.events.getSticker("cat-nod")?.useCount).toBe(1);

    // read 仅在主对话（mode="chat"）递增 access_count，wake 模式不累加
    await ctx.tools.write("daily/2026-11-20-read.md", "---\ntitle: 测试精读\n---\n正文\n");
    await registry.invoke("read", { path: "daily/2026-11-20-read.md" }, { ...toolCtx, mode: "wake" });
    expect(ctx.index.getRow("daily/2026-11-20-read.md")?.access_count).toBe(0);
    await registry.invoke("read", { path: "daily/2026-11-20-read.md" }, { ...toolCtx, mode: "chat" });
    expect(ctx.index.getRow("daily/2026-11-20-read.md")?.access_count).toBe(1);

    // express 单轮 3 次节流与 durationSec 夹逼 [3, 120]
    await registry.invoke(
      "express",
      { atmosphere: { tone: "warm", intensity: "subtle", durationSec: 999 } },
      toolCtx,
    );
    await registry.invoke("express", { haptic: "light" }, toolCtx);
    await registry.invoke("express", { motion: "nod" }, toolCtx);
    const fourth = await registry.invoke("express", { haptic: "double" }, toolCtx);
    expect(fourth.ok).toBe(true);
    expect(fourth.output).toContain("throttled");
    expect(emittedExpressions.length).toBe(3);
    expect(emittedExpressions[0].atmosphere?.durationSec).toBe(120);

    // tool_search + call_tool 检索调用 Tier 3
    const searchRes = await registry.invoke("tool_search", { query: "探针" }, toolCtx);
    expect(searchRes.ok).toBe(true);
    expect(searchRes.output).toContain("demo.ping");
    const callRes = await registry.invoke(
      "call_tool",
      { name: "demo.ping", arguments: { msg: "hi" } },
      toolCtx,
    );
    expect(callRes.ok).toBe(true);
    expect(callRes.output).toBe("pong:hi");

    // 端到端 HTTP -> DirectEngine -> SseHub 广播联调
    const sse = new SseHub();
    const frames: SseFrame[] = [];
    sse.subscribe((f) => frames.push(f));

    const mockChat = new MockChatModel();
    mockChat.queueStream(() => [
      { type: "thinking_delta", delta: "打个招呼" },
      { type: "tool_call", id: "tc-e1", name: "express", args: { haptic: "light" } },
    ]);
    mockChat.queueStream(() => [{ type: "text_delta", delta: "我在呢！" }]);

    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel: mockChat,
      db: ctx.db,
      sse: undefined,
    } as ConstructorParameters<typeof DirectEngine>[0]);

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

    const postRes = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientMessageId: "cmsg-sse-1", content: "你在吗" }),
    });
    expect(postRes.status).toBe(202);

    // 等待异步对话轮推送 turn.done
    await new Promise((r) => setTimeout(r, 80));
    const names = frames.map((f) => f.event);
    expect(names).toContain("message.created");
    expect(names).toContain("turn.start");
    expect(names).toContain("turn.thinking");
    expect(names).toContain("turn.expression");
    expect(names).toContain("turn.text");
    expect(names).toContain("turn.done");
  });
});
