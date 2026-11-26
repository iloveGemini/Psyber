import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../src/api/app.ts";
import { loadOrCreateConfig, saveConfig } from "../src/core/config.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import { SseHub, type SseFrame } from "../src/engine/sse.ts";
import { extractMarkdownLinks } from "../src/memory/index.ts";
import {
  parseRecallGatePrompt,
  recallMemories,
  type EmbeddingClient,
} from "../src/memory/recall.ts";
import type { DecisionQuestion } from "../src/core/decision.ts";
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
          "threads/REGISTRY.yaml",
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
          "threads/stories/lighthouse.md",
          "---\ntitle: 雾里的守灯人\nkind: serial\n---\n连载停在第 4 章：主角在灯塔回廊听见昨天的录音。\n",
        )
      ).ok,
    ).toBe(true);

    expect(
      (
        await ctx.tools.write(
          "episodes/2026/11/19/ep-cat.md",
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

    // 2. 命中线索触发词 -> Track 1 直挂睡前故事卡
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
      actHit.items.some((i) => i.path === "threads/stories/lighthouse.md" && i.track === "same_activity"),
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
    expect(deduped.items.some((i) => i.path === "threads/stories/lighthouse.md")).toBe(false);

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
    expect(afterDelete.items.some((i) => i.path === "threads/stories/lighthouse.md")).toBe(true);

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
    expect(continued.items.some((i) => i.path === "threads/stories/lighthouse.md")).toBe(true);

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
    expect(fallback.items.some((i) => i.path === "episodes/2026/11/19/ep-cat.md")).toBe(true);

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
        cardPath: "episodes/2026/11/19/ep-cat.md",
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
    expect(traceJson.items[0].cardPath).toBe("episodes/2026/11/19/ep-cat.md");
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
    await ctx.tools.write("episodes/2026/11/20/ep-read.md", "---\ntitle: 测试精读\n---\n正文\n");
    await registry.invoke("read", { path: "episodes/2026/11/20/ep-read.md" }, { ...toolCtx, mode: "wake" });
    expect(ctx.index.getRow("episodes/2026/11/20/ep-read.md")?.access_count).toBe(0);
    await registry.invoke("read", { path: "episodes/2026/11/20/ep-read.md" }, { ...toolCtx, mode: "chat" });
    expect(ctx.index.getRow("episodes/2026/11/20/ep-read.md")?.access_count).toBe(1);

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

  test("[[短标题]] 直读、同名标题写入提醒与自动召回默认排除 rf-*.md 反思卡", async () => {
    ctx = await createTestContext();

    // 1. 写入普通长线卡与反思卡
    const w1 = await ctx.tools.write(
      "threads/bedtime-stories/bug-points-ledger.md",
      "---\ntitle: 抓bug积分账本\nkind: note\n---\nJoy 17 分 / 我 4 分。\n",
    );
    expect(w1.ok).toBe(true);

    const wRf = await ctx.tools.write(
      "episodes/2026/11/20/rf-jealousy-and-anchor.md",
      "---\ntitle: 11-20 反思·讨好与锚\nkind: reflection\ncreated: 2026-11-20\n---\n独一无二的心路历程关键词：翡翠灯塔拆穿吃醋。\n",
    );
    expect(wRf.ok).toBe(true);

    // 2. read 原生支持 [[短标题]] 和纯标题直读，并附带真实路径前缀
    const rWiki = await ctx.tools.read("[[抓bug积分账本]]");
    expect(rWiki.ok).toBe(true);
    expect(rWiki.output).toContain("[路径: threads/bedtime-stories/bug-points-ledger.md]");
    expect(rWiki.output).toContain("Joy 17 分");

    const rPlain = await ctx.tools.read("11-20 反思·讨好与锚");
    expect(rPlain.ok).toBe(true);
    expect(rPlain.output).toContain("[路径: episodes/2026/11/20/rf-jealousy-and-anchor.md]");
    expect(rPlain.output).toContain("翡翠灯塔拆穿吃醋");

    // 3. 写入重名标题卡片时给出非阻断提醒，且模糊/重名 [[短标题]] 返回候选清单
    const wDup = await ctx.tools.write(
      "episodes/2026/11/20/ep-dup-ledger.md",
      "---\ntitle: 抓bug积分账本\nkind: episode\n---\n另一份记录。\n",
    );
    expect(wDup.ok).toBe(true);
    expect(wDup.output).toContain("已有同名标题卡片");

    const rAmbig = await ctx.tools.read("[[抓bug积分账本]]");
    expect(rAmbig.ok).toBe(false);
    expect(rAmbig.output).toContain("匹配到多张卡片");
    expect(rAmbig.output).toContain("threads/bedtime-stories/bug-points-ledger.md");
    expect(rAmbig.output).toContain("episodes/2026/11/20/ep-dup-ledger.md");

    // 4. 自动召回默认排除 rf-*.md（无论 FTS5 还是近期 72h 兜底均不拉入反思卡）
    const recallFts = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-rf-1",
      turnId: "t-rf-1",
      query: "翡翠灯塔拆穿吃醋",
    });
    expect(recallFts.items.some((i) => i.path === "episodes/2026/11/20/rf-jealousy-and-anchor.md")).toBe(false);
  });

  test("Decision 门控与精排：拦截闲聊噪声、精准过滤候选卡、写入 rerank_score、超时平滑降级与开关回退", async () => {
    ctx = await createTestContext();
    await ctx.tools.write(
      "threads/myth/king.md",
      "---\ntitle: 吃掉自己的国王\nkind: work\nwhen_to_recall: 提到国王或饥饿故事时\n---\n色萨利国王砍倒圣林的老橡树，受到饥饿惩罚。\n",
    );
    await ctx.tools.write(
      "episodes/2026/11/19/ep-noise.md",
      "---\ntitle: 买菜清单\nkind: episode\ncreated: 2026-11-19\n---\n昨天买了苹果和牛奶，随便聊聊国王水果。\n",
    );

    const fakeDecision = {
      calls: 0,
      mode: "normal" as "normal" | "block" | "timeout",
      async decide(req: { input: string; questions: Record<string, unknown>; signal?: AbortSignal }) {
        this.calls++;
        if (this.mode === "timeout") {
          throw new Error("AbortError: The operation timed out");
        }
        const answers: Record<string, { noul: number }> = {
          needs_memory: { noul: this.mode === "block" ? 0.12 : 0.91 },
        };
        for (const k of Object.keys(req.questions)) {
          if (k === "needs_memory") continue;
          const line = req.input.split("\n").find((l) => l.startsWith(`[${k}] `));
          answers[k] = {
            noul: line && (line.includes("king.md") || line.includes("吃掉自己的国王")) ? 0.93 : 0.08,
          };
        }
        return { answers, backend: "mock-gate" };
      },
    };

    // 1) 门控拦截（needs_memory < threshold）-> 直接跳过，不写 recall_traces
    fakeDecision.mode = "block";
    const blocked = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-gate",
      turnId: "t-gate-block",
      query: "今天好累，随便说点什么",
      decisionClient: fakeDecision,
      promptsDir: PROMPTS_DIR,
    });
    expect(blocked.skipped).toBe(true);
    expect(blocked.items.length).toBe(0);
    expect(blocked.gateScore).toBeCloseTo(0.12, 2);
    expect(blocked.usedDecisionGate).toBe(true);

    // 2) 门控通过 + 精排过滤：只保留 king.md，剔除噪声卡 ep-noise.md，并落库 rerank_score
    fakeDecision.mode = "normal";
    const passed = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-gate",
      turnId: "t-gate-pass",
      query: "那个国王后来怎么样了",
      recentTurns: [{ role: "user", content: "上次你给我讲了个希腊神话" }],
      decisionClient: fakeDecision,
      promptsDir: PROMPTS_DIR,
    });
    expect(passed.skipped).toBe(false);
    expect(passed.items.map((i) => i.path)).toEqual(["threads/myth/king.md"]);
    expect(passed.items[0]?.rerankScore).toBeCloseTo(0.93, 2);
    const traceRow = ctx.db
      .query("SELECT rerank_score FROM recall_traces WHERE turn_id = ?")
      .get("t-gate-pass") as { rerank_score: number | null };
    expect(traceRow.rerank_score).toBeCloseTo(0.93, 2);

    // 3) 超时平滑降级：不抛错，标记 timedOut=true，退回规则召回
    fakeDecision.mode = "timeout";
    const fallback = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-gate-2",
      turnId: "t-gate-timeout",
      query: "吃掉自己的国王",
      decisionClient: fakeDecision,
      promptsDir: PROMPTS_DIR,
    });
    expect(fallback.timedOut).toBe(true);
    expect(fallback.items.some((i) => i.path === "threads/myth/king.md")).toBe(true);

    // 4) gate.enabled = false 一键回退，零调用 decisionClient
    const callsBeforeOff = fakeDecision.calls;
    const offRes = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-gate-3",
      turnId: "t-gate-off",
      query: "吃掉自己的国王",
      decisionClient: fakeDecision,
      promptsDir: PROMPTS_DIR,
      recallConfig: { gate: { enabled: false, threshold: 0.55 } },
    });
    expect(fakeDecision.calls).toBe(callsBeforeOff);
    expect(offRes.usedDecisionGate).toBe(false);
    // 5) 全卡目录直扫模式：即使查询与卡片零字面重叠（FTS5 完全漏召），单次决策仍能召回，且自动注入 <resident_context>
    await ctx.tools.write(
      "core/open.md",
      "---\ntitle: 未完挂念\n---\n约好周末一起复盘希腊神话积分账本。\n",
    );
    let capturedInput = "";
    let capturedQuestions: Record<string, DecisionQuestion> = {};
    const capturingDecision = {
      async decide(req: {
        input: string;
        questions: Record<string, DecisionQuestion>;
        signal?: AbortSignal;
      }) {
        capturedInput = req.input;
        capturedQuestions = req.questions;
        return fakeDecision.decide(req);
      },
    };
    fakeDecision.mode = "normal";
    const catalogHit = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-gate-4",
      turnId: "t-catalog-zero-overlap",
      query: "完全不撞词的间接回指",
      decisionClient: capturingDecision,
      promptsDir: PROMPTS_DIR,
      recallConfig: { catalogScanMaxCards: 250 },
    });
    expect(catalogHit.usedDecisionGate).toBe(true);
    expect(capturedInput).toContain("<resident_context>");
    expect(capturedInput).toContain("希腊神话积分账本");
    expect(catalogHit.items.map((i) => i.path)).toEqual(["threads/myth/king.md"]);

    // 校验 recall-gate.md v2 的 true_description / false_description 双边判据及 {{card_id}} 替换
    expect(capturedQuestions.needs_memory?.criteria?.true_description).toContain("回指");
    expect(capturedQuestions.needs_memory?.criteria?.false_description).toContain("闲聊");
    expect(capturedQuestions.c0?.instructions).toContain("[c0]");
    expect(capturedQuestions.c0?.criteria?.true_description).toContain("[c0]");
    expect(capturedQuestions.c0?.criteria?.false_description).toContain("[c0]");
    expect(capturedQuestions.c0?.criteria?.true_description).not.toContain("{{card_id}}");

    // 校验 parseRecallGatePrompt 向后兼容无 ## true / ## false 的旧版单段提示词
    const legacyParsed = parseRecallGatePrompt(
      "# needs_memory\n旧版单段门控指令。\n\n# card_relevance\n旧版单段卡片 {{card_id}} 指令。",
    );
    expect(legacyParsed.needsMemory.instructions).toBe("旧版单段门控指令。");
    expect(legacyParsed.needsMemory.criteria).toBeUndefined();
    expect(legacyParsed.cardRelevance.instructions).toBe("旧版单段卡片 {{card_id}} 指令。");
    expect(legacyParsed.cardRelevance.criteria).toBeUndefined();

    // 6) 批量向量嵌入 + RRF 混合粗筛（纯语义零字面重叠卡与 FTS 字面卡同时进入候选池）
    await ctx.tools.write(
      "episodes/2026/11/19/ep-semantic.md",
      "---\ntitle: 深夜情绪记录\nkind: episode\ncreated: 2026-11-19\n---\n那天加班到凌晨两点，整个人特别崩溃。\n",
    );
    let batchCalls = 0;
    const semanticEmbed: EmbeddingClient = {
      modelKey: "mock:semantic-2d",
      async embed(text) {
        if (text.includes("撑不住") || text.includes("崩溃")) return new Float32Array([1, 0]);
        return new Float32Array([0, 1]);
      },
      async embedBatch(texts) {
        batchCalls++;
        return texts.map((t) => (t.includes("崩溃") ? new Float32Array([1, 0]) : new Float32Array([0, 1])));
      },
    };
    const hybridRes = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-hybrid",
      turnId: "t-hybrid-1",
      query: "最近加班快撑不住了",
      embedding: semanticEmbed,
      recallConfig: {
        gate: { enabled: false, threshold: 0.5 },
        catalogScanMaxCards: 0,
        embedMinScore: 0.35,
        hybridFtsWithEmbedding: true,
      },
    });
    expect(batchCalls).toBe(1);
    expect(hybridRes.items.some((i) => i.path === "episodes/2026/11/19/ep-semantic.md")).toBe(true);

    // 7) 独立 Reranker 与 Decision needs_memory 门控并行：门控只发 needs_memory 一题，Reranker 精准打分过滤
    let gateQuestionKeys: string[] = [];
    const gateOnlyDecision = {
      async decide(req: { input: string; questions: Record<string, DecisionQuestion> }) {
        gateQuestionKeys = Object.keys(req.questions);
        return { answers: { needs_memory: { noul: 0.88 } }, backend: "mock-gate" };
      },
    };
    const mockReranker = {
      modelKey: "mock:qwen3-reranker",
      async rerank(_q: string, docs: string[]) {
        return docs.map((d, index) => ({
          index,
          relevanceScore: d.includes("深夜情绪记录") ? 0.94 : 0.05,
        }));
      },
    };
    const rerankedRes = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-rerank-parallel",
      turnId: "t-rerank-1",
      query: "最近加班快撑不住了",
      embedding: semanticEmbed,
      reranker: mockReranker,
      decisionClient: gateOnlyDecision,
      promptsDir: PROMPTS_DIR,
      recallConfig: {
        gate: { enabled: true, threshold: 0.3 },
        rerank: { threshold: 0.4 },
        catalogScanMaxCards: 0,
        embedMinScore: 0.25,
        hybridFtsWithEmbedding: false,
      },
    });
    expect(gateQuestionKeys).toEqual(["needs_memory"]);
    expect(rerankedRes.usedDecisionGate).toBe(true);
    expect(rerankedRes.items.map((i) => i.path)).toEqual(["episodes/2026/11/19/ep-semantic.md"]);
    expect(rerankedRes.items[0]?.rerankScore).toBeCloseTo(0.94, 4);

    // 8) 配置了 embedding 时，即使 catalogScanMaxCards=250 也自动走「纯向量粗筛 + <candidates> 正文摘要联合精排」而非全卡目录直扫
    let vectorGateInput = "";
    const vectorGateDecision = {
      async decide(req: { input: string; questions: Record<string, DecisionQuestion> }) {
        vectorGateInput = req.input;
        const answers: Record<string, { noul: number }> = { needs_memory: { noul: 0.85 } };
        for (const k of Object.keys(req.questions)) {
          if (k === "needs_memory") continue;
          const block = req.input.split("\n\n").find((b) => b.includes(`[${k}]`));
          answers[k] = { noul: block?.includes("ep-semantic.md") ? 0.92 : 0.05 };
        }
        return { answers, backend: "mock-vector-gate" };
      },
    };
    const autoVecRes = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-auto-vec",
      turnId: "t-auto-vec-1",
      query: "最近加班快撑不住了",
      embedding: semanticEmbed,
      decisionClient: vectorGateDecision,
      promptsDir: PROMPTS_DIR,
      recallConfig: { catalogScanMaxCards: 250 },
    });
    expect(vectorGateInput).toContain("<candidates>");
    expect(vectorGateInput).not.toContain("<memory_catalog>");
    expect(vectorGateInput).toContain("凌晨两点");
    expect(autoVecRes.items.map((i) => i.path)).toEqual(["episodes/2026/11/19/ep-semantic.md"]);
  });

  test("[[短标题]] 双链派生索引（card_links）与轻量 1 跳扩展 + 证据充分性早停", async () => {
    ctx = await createTestContext();

    // 1) 提取 [[短标题]]（含别名）与相对 .md 链接，忽略外链与 media/
    const extracted = extractMarkdownLinks(
      "提到 [[抓bug积分账本]] 和 [[雾里灯塔|灯塔故事]]，以及 [原话](favorite/quote.md) 与 ![图](media/abc.png) 与 [外链](https://example.com)。",
      "episodes/2026/11/20/ep-src.md",
    );
    expect(extracted).toEqual([
      { linkKind: "wiki", targetRef: "抓bug积分账本" },
      { linkKind: "wiki", targetRef: "雾里灯塔" },
      { linkKind: "path", targetRef: "favorite/quote.md" },
    ]);

    // 2) 构造互链卡片：ep-anchor --[[原话收藏]]--> favorite/quote.md，且 ep-backlink --[[深夜复盘]]--> ep-anchor
    await ctx.tools.write(
      "episodes/2026/11/20/ep-anchor.md",
      "---\ntitle: 深夜复盘\nkind: episode\ncreated: 2026-11-20\n---\n那天聊起承诺，具体原话收在 [[约定原话]]。\n",
    );
    await ctx.tools.write(
      "favorite/2026-11-20-promise.md",
      "---\ntitle: 约定原话\nkind: note\n---\n原话：「不管过多久，重要的事我们都当面说清。」\n",
    );
    await ctx.tools.write(
      "episodes/2026/11/21/ep-backlink.md",
      "---\ntitle: 次日跟进\nkind: episode\ncreated: 2026-11-21\n---\n顺着 [[深夜复盘]] 的话题继续把约定写进了清单。\n",
    );
    await ctx.tools.write(
      "episodes/2026/11/20/rf-hidden.md",
      "---\ntitle: 反思不该被跳入\nkind: reflection\n---\n反思引用了 [[深夜复盘]]。\n",
    );

    const neighbors = ctx.index.findLinkedNeighbors(["episodes/2026/11/20/ep-anchor.md"]);
    expect(neighbors.map((n) => n.row.path)).toEqual([
      "favorite/2026-11-20-promise.md",
      "episodes/2026/11/21/ep-backlink.md",
    ]);
    expect(neighbors[0]?.direction).toBe("out");
    expect(neighbors[1]?.direction).toBe("in");

    // 仅 ep-anchor 与查询向量高度相似，favorite/quote 向量正交（首跳搜不到，只能靠 1 跳双链翻出）
    const hopEmbed: EmbeddingClient = {
      modelKey: "mock:hop-2d",
      async embed(text) {
        if (text.includes("复盘") || text.includes("承诺")) return new Float32Array([1, 0]);
        return new Float32Array([0, 1]);
      },
      async embedBatch(texts) {
        return texts.map((t) =>
          t.includes("深夜复盘") ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
        );
      },
    };

    // 3) 场景 A：证据不充分（evidence_sufficient=0.22 < 0.75）-> 触发 1 跳补入 favorite/2026-11-20-promise.md
    let hopMode: "expand" | "sufficient" | "timeout" = "expand";
    let decCalls = 0;
    const hopDecision = {
      async decide(req: { input: string; questions: Record<string, DecisionQuestion> }) {
        decCalls++;
        if ("needs_memory" in req.questions) {
          const answers: Record<string, { noul: number }> = { needs_memory: { noul: 0.9 } };
          for (const k of Object.keys(req.questions)) {
            if (k === "needs_memory") continue;
            const block = req.input.split("\n\n").find((b) => b.includes(`[${k}]`));
            answers[k] = { noul: block?.includes("ep-anchor.md") ? 0.88 : 0.05 };
          }
          return { answers, backend: "mock-hop0" };
        }
        // Hop 1 请求
        if (hopMode === "timeout") {
          throw new Error("AbortError: hop1 timed out");
        }
        expect(req.input).toContain("<selected_evidence>");
        expect(req.input).toContain("<linked_neighbors>");
        expect(req.questions.evidence_sufficient?.criteria?.true_description).toBeTruthy();
        const answers: Record<string, { noul: number }> = {
          evidence_sufficient: { noul: hopMode === "sufficient" ? 0.91 : 0.22 },
        };
        for (const k of Object.keys(req.questions)) {
          if (k === "evidence_sufficient") continue;
          const block = req.input.split("\n\n").find((b) => b.includes(`[${k}]`));
          answers[k] = { noul: block?.includes("2026-11-20-promise.md") ? 0.93 : 0.08 };
        }
        return { answers, backend: "mock-hop1" };
      },
    };

    const expanded = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-hop-a",
      turnId: "t-hop-expand",
      query: "我们深夜复盘时立的承诺原话是什么来着",
      embedding: hopEmbed,
      decisionClient: hopDecision,
      promptsDir: PROMPTS_DIR,
    });
    expect(decCalls).toBe(2);
    expect(expanded.hopCount).toBe(1);
    expect(expanded.hopStoppedReason).toBe("expanded");
    expect(expanded.sufficiencyScore).toBeCloseTo(0.22, 2);
    expect(expanded.items.map((i) => i.path)).toEqual([
      "episodes/2026/11/20/ep-anchor.md",
      "favorite/2026-11-20-promise.md",
    ]);
    expect(expanded.items[1]?.track).toBe("linked_hop");
    expect(expanded.renderedBlock).toContain("[关联延伸]");

    // 4) 场景 B：证据已充分（evidence_sufficient=0.91 >= 0.75）-> 早停不补邻卡
    hopMode = "sufficient";
    const stopped = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-hop-b",
      turnId: "t-hop-stop",
      query: "我们深夜复盘那件事",
      embedding: hopEmbed,
      decisionClient: hopDecision,
      promptsDir: PROMPTS_DIR,
    });
    expect(stopped.hopCount).toBe(1);
    expect(stopped.hopStoppedReason).toBe("evidence_sufficient");
    expect(stopped.items.map((i) => i.path)).toEqual(["episodes/2026/11/20/ep-anchor.md"]);

    // 5) 场景 C：1 跳超时降级 -> 绝不丢弃首跳结果
    hopMode = "timeout";
    const safeFallback = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-hop-c",
      turnId: "t-hop-timeout",
      query: "我们深夜复盘那件事",
      embedding: hopEmbed,
      decisionClient: hopDecision,
      promptsDir: PROMPTS_DIR,
    });
    expect(safeFallback.hopStoppedReason).toBe("timeout_or_error");
    expect(safeFallback.items.map((i) => i.path)).toEqual(["episodes/2026/11/20/ep-anchor.md"]);
  });

  test("审查缺陷回归：配置合并与校验、card_links v1->v2 回填一致性、召回路由/降级/锚点与预算防护", async () => {
    ctx = await createTestContext();

    // 1) partial multiHop 深度合并 & PATCH /api/v1/settings 校验超时字段
    ctx.config.recall = {
      charBudget: 3200,
      dedupWindowMin: 120,
      recentDailyWindowHours: 72,
      embedTimeoutMs: 2500,
      multiHop: {
        enabled: true,
        maxNeighbors: 3,
        sufficientThreshold: 0.75,
      },
    };
    await saveConfig(ctx.dataDir, ctx.config);
    const reloaded = await loadOrCreateConfig(ctx.dataDir, ctx.clock.now());
    expect(reloaded.recall?.multiHop?.enabled).toBe(true);
    expect(reloaded.recall?.multiHop?.maxNeighbors).toBe(3);
    expect(reloaded.recall?.multiHop?.timeoutMs).toBe(2500);

    const app = createApp({
      version: "0.1.0",
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      getActiveSessionId: () => "sess-cfg",
      db: ctx.db,
      dataDir: ctx.dataDir,
    });
    const badPatchRes = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${ctx.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ recall: { rerankTimeoutMs: -1 } }),
    });
    expect(badPatchRes.status).toBe(400);

    const okPatchRes = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${ctx.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ recall: { multiHop: { sufficientThreshold: 0.68 } } }),
    });
    expect(okPatchRes.status).toBe(200);
    expect(ctx.config.recall?.multiHop?.maxNeighbors).toBe(3);
    expect(ctx.config.recall?.multiHop?.sufficientThreshold).toBeCloseTo(0.68, 4);

    // 2) parseRecallGatePrompt 支持连续空标题与文末空标题；extractMarkdownLinks 支持 .. 文件名与带标题链接
    const edgeParsed = parseRecallGatePrompt(
      "# needs_memory\n# card_relevance\n检查卡片\n\n## true\n命中\n\n## false\n",
    );
    expect(edgeParsed.cardRelevance.instructions).toBe("检查卡片");
    expect(edgeParsed.cardRelevance.criteria?.true_description).toBe("命中");
    expect(edgeParsed.cardRelevance.criteria?.false_description).toBeUndefined();

    expect(
      extractMarkdownLinks(
        '[版本说明](lessons/notes..v2.md) 与 [引文](favorite/q.md "原话")',
        "episodes/2026/11/20/ep-x.md",
      ),
    ).toEqual([
      { linkKind: "path", targetRef: "lessons/notes..v2.md" },
      { linkKind: "path", targetRef: "favorite/q.md" },
    ]);

    // 3) v1 -> v2 回填：即便已有 1 张新卡先入 card_links，仍会补建其余未变旧卡；且忽略 YAML Frontmatter 里的假链接
    await ctx.tools.write(
      "episodes/2026/11/19/ep-v1-old.md",
      "---\ntitle: 旧日记录\nwhen_to_recall: 不要索引 [[假双链]]\n---\n正文引用了 [[约定原话]]。\n",
    );
    await ctx.tools.write(
      "favorite/2026-11-20-promise.md",
      "---\ntitle: 约定原话\nkind: note\n---\n原话内容。\n",
    );
    // 模拟 v1 数据库（有 card_index 但尚未写过 index:card_links_v2，同时先手动往 card_links 写 1 条记录或改 1 张新卡）
    ctx.db.query("DELETE FROM card_links").run();
    ctx.db.query("DELETE FROM task_cursors WHERE task_key = 'index:card_links_v2'").run();
    await ctx.tools.write(
      "episodes/2026/11/20/ep-new.md",
      "---\ntitle: 新卡\nkind: episode\n---\n提到 [[约定原话]]。\n",
    );
    await ctx.index.reindexAll();
    const oldLinks = ctx.db
      .query("SELECT target_ref FROM card_links WHERE src_path = ?")
      .all("episodes/2026/11/19/ep-v1-old.md") as Array<{ target_ref: string }>;
    expect(oldLinks.map((l) => l.target_ref)).toEqual(["约定原话"]);

    // 4) 未配 embedding 但配了 reranker 且活跃卡 <= 250 时，shouldCatalogScan 不应截胡绕过 reranker
    let rerankCalled = 0;
    const gatePassDecision = {
      async decide(req: { input: string; questions: Record<string, DecisionQuestion> }) {
        const answers: Record<string, { noul: number }> = {};
        if ("needs_memory" in req.questions) answers.needs_memory = { noul: 0.9 };
        for (const k of Object.keys(req.questions)) {
          if (k === "needs_memory") continue;
          answers[k] = { noul: k === "c0" ? 0.25 : 0.1 };
        }
        return { answers, backend: "mock" };
      },
    };
    const rerankerSpy = {
      modelKey: "mock:rr",
      async rerank(_q: string, docs: string[]) {
        rerankCalled++;
        return docs.map((_, index) => ({ index, relevanceScore: index === 0 ? 0.85 : 0.1 }));
      },
    };
    const rerankWithoutEmbed = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-rr-no-emb",
      turnId: "t-rr-no-emb",
      query: "约定原话",
      reranker: rerankerSpy,
      decisionClient: gatePassDecision,
      promptsDir: PROMPTS_DIR,
      recallConfig: { catalogScanMaxCards: 250, multiHop: { enabled: false, maxNeighbors: 6, sufficientThreshold: 0.75 } },
    });
    expect(rerankCalled).toBe(1);
    expect(rerankWithoutEmbed.items.length).toBeGreaterThan(0);

    // 5) embedding 超时时（<= 250 卡 + 健康 decisionClient）优先回落 catalogScan，且缺文件不拖垮其余卡片、分块落库有检查点
    let missingFileHandled = false;
    await ctx.tools.write(
      "episodes/2026/11/20/ep-deleted.md",
      "---\ntitle: 将被删除\nkind: episode\n---\n临时正文。\n",
    );
    await fs.rm(path.join(ctx.dataDir, "memory", "episodes/2026/11/20/ep-deleted.md"));

    // 5a: 向量超时 -> 回落全卡目录直扫命中零字面重叠卡
    const timeoutEmbed: EmbeddingClient = {
      modelKey: "mock:timeout-emb",
      async embed() {
        throw new Error("timeout");
      },
    };
    const catalogFallbackHit = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-emb-timeout",
      turnId: "t-emb-timeout",
      query: "毫无字面重叠的间接询问",
      embedding: timeoutEmbed,
      decisionClient: {
        async decide(req) {
          const answers: Record<string, { noul: number }> = { needs_memory: { noul: 0.9 } };
          for (const k of Object.keys(req.questions)) {
            if (k === "needs_memory") continue;
            const line = req.input.split("\n").find((l) => l.startsWith(`[${k}] `));
            answers[k] = { noul: line?.includes("约定原话") ? 0.91 : 0.05 };
          }
          return { answers, backend: "mock-cat-fb" };
        },
      },
      promptsDir: PROMPTS_DIR,
      recallConfig: { catalogScanMaxCards: 250 },
    });
    expect(catalogFallbackHit.usedDecisionGate).toBe(true);
    expect(catalogFallbackHit.items.some((i) => i.path === "favorite/2026-11-20-promise.md")).toBe(true);

    // 5b: 多分块批量嵌入（>16 张卡）即使第 2 块失败，第 1 块已持久化进 card_embeddings，且磁盘缺失文件不报错
    for (let i = 0; i < 18; i++) {
      await ctx.tools.write(
        `episodes/2026/11/18/ep-batch-${i}.md`,
        `---\ntitle: 批量卡片${i}\nkind: episode\ncreated: 2026-11-18\n---\n内容编号 ${i}。\n`,
      );
    }
    let batchChunkCalls = 0;
    const flakyBatchEmbed: EmbeddingClient = {
      modelKey: "mock:flaky-batch",
      async embed() {
        return new Float32Array([1, 0]);
      },
      async embedBatch(texts) {
        batchChunkCalls++;
        if (batchChunkCalls === 2) {
          throw new Error("chunk 2 rate limited");
        }
        return texts.map(() => new Float32Array([1, 0]));
      },
    };
    await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-batch-ckpt",
      turnId: "t-batch-ckpt",
      query: "批量卡片",
      embedding: flakyBatchEmbed,
    });
    const savedEmbCount = (
      ctx.db
        .query("SELECT COUNT(*) AS cnt FROM card_embeddings WHERE model_key = 'mock:flaky-batch'")
        .get() as { cnt: number }
    ).cnt;
    missingFileHandled = savedEmbCount === 16;
    expect(missingFileHandled).toBe(true);

    // 6) candidatePoolLimit 不得挤掉 daily_recent；且 reranker/gate 失败时 applyRuleFallback 守住 0.35 向量门槛
    const unitEmbed: EmbeddingClient = {
      modelKey: "mock:unit-vec",
      async embed() {
        return new Float32Array([1, 0]);
      },
      async embedBatch(texts) {
        return texts.map((t) =>
          t.includes("弱相关") ? new Float32Array([0.28, Math.sqrt(1 - 0.28 * 0.28)]) : new Float32Array([1, 0]),
        );
      },
    };
    await ctx.tools.write(
      "episodes/2026/11/01/ep-weak-vec.md",
      "---\ntitle: 弱相关卡\nkind: episode\ncreated: 2026-11-01\n---\n这条是弱相关测试内容。\n",
    );
    await ctx.tools.write(
      "episodes/2026/11/20/ep-recent-daily.md",
      "---\ntitle: 今日刚发生\nkind: episode\ncreated: 2026-11-20\n---\n今天刚刚聊过的新鲜日常。\n",
    );
    ctx.clock.setTime(Date.parse("2026-11-20T18:00:00+08:00"));
    let sawRecentDailyInGate = false;
    await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-daily-preserve",
      turnId: "t-daily-preserve",
      query: "随便聊聊",
      embedding: unitEmbed,
      decisionClient: {
        async decide(req) {
          sawRecentDailyInGate = req.input.includes("ep-recent-daily.md");
          return { answers: { needs_memory: { noul: 0.1 } }, backend: "mock" };
        },
      },
      promptsDir: PROMPTS_DIR,
      recallConfig: { candidatePool: 6, recentDailyWindowHours: 72 },
    });
    expect(sawRecentDailyInGate).toBe(true);

    // 7) reranker 门控失败绝不绕过 needs_memory 放行，且降级过滤 0.28 弱向量；reranker 失败则回退到 decisionClient 评分与 1 跳
    const gateRejectFallback = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-gate-fail",
      turnId: "t-gate-fail",
      query: "弱相关测试",
      embedding: unitEmbed,
      reranker: {
        modelKey: "mock:rr-high",
        async rerank(_q, docs) {
          return docs.map((_, index) => ({ index, relevanceScore: 0.99 }));
        },
      },
      decisionClient: {
        async decide() {
          throw new Error("needs_memory gate timed out");
        },
      },
      promptsDir: PROMPTS_DIR,
      recallConfig: { catalogScanMaxCards: 0, candidatePool: 30 },
    });
    expect(gateRejectFallback.timedOut).toBe(true);
    expect(gateRejectFallback.usedDecisionGate).toBe(false);
    expect(gateRejectFallback.items.some((i) => i.path === "episodes/2026/11/01/ep-weak-vec.md")).toBe(
      false,
    );

    let decFallbackSawCardRelevance = false;
    const rerankFailUsesDecision = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-rr-fail",
      turnId: "t-rr-fail",
      query: "旧日记录",
      embedding: unitEmbed,
      reranker: {
        modelKey: "mock:rr-down",
        async rerank() {
          throw new Error("reranker down");
        },
      },
      decisionClient: {
        async decide(req) {
          if (Object.keys(req.questions).some((k) => k.startsWith("c"))) {
            decFallbackSawCardRelevance = true;
          }
          const answers: Record<string, { noul: number }> = { needs_memory: { noul: 0.9 } };
          for (const k of Object.keys(req.questions)) {
            if (k === "needs_memory") continue;
            const block = req.input.split("\n\n").find((b) => b.includes(`[${k}]`));
            answers[k] = { noul: block?.includes("ep-v1-old.md") ? 0.92 : 0.05 };
          }
          return { answers, backend: "mock" };
        },
      },
      promptsDir: PROMPTS_DIR,
      recallConfig: {
        candidatePool: 30,
        multiHop: { enabled: false, maxNeighbors: 6, sufficientThreshold: 0.75 },
      },
    });
    expect(decFallbackSawCardRelevance).toBe(true);
    expect(rerankFailUsesDecision.timedOut).toBe(false);
    expect(rerankFailUsesDecision.items.map((i) => i.path)).toEqual([
      "episodes/2026/11/19/ep-v1-old.md",
    ]);

    // 8) hop0PoolAnchors 按首跳分数选锚点并注入 <selected_evidence>；预算已满时早停跳过 1 跳 LLM 调用
    let anchorSawSelectedEvidence = false;
    let anchorPickedHighScore = false;
    const anchorHopRes = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-anchor-score",
      turnId: "t-anchor-score",
      query: "旧日",
      embedding: unitEmbed,
      decisionClient: {
        async decide(req) {
          if ("needs_memory" in req.questions) {
            const answers: Record<string, { noul: number }> = { needs_memory: { noul: 0.9 } };
            for (const k of Object.keys(req.questions)) {
              if (k === "needs_memory") continue;
              const block = req.input.split("\n\n").find((b) => b.includes(`[${k}]`));
              // ep-v1-old 给 0.29（近阈值但 < 0.30），其余给 0.02
              answers[k] = { noul: block?.includes("ep-v1-old.md") ? 0.29 : 0.02 };
            }
            return { answers, backend: "mock" };
          }
          anchorSawSelectedEvidence = req.input.includes("<selected_evidence>");
          anchorPickedHighScore = req.input.includes("旧日记录");
          const answers: Record<string, { noul: number }> = {};
          for (const k of Object.keys(req.questions)) {
            const block = req.input.split("\n\n").find((b) => b.includes(`[${k}]`));
            answers[k] = { noul: block?.includes("2026-11-20-promise.md") ? 0.95 : 0.05 };
          }
          return { answers, backend: "mock" };
        },
      },
      promptsDir: PROMPTS_DIR,
      recallConfig: { candidatePool: 30 },
    });
    expect(anchorSawSelectedEvidence).toBe(true);
    expect(anchorPickedHighScore).toBe(true);
    expect(anchorHopRes.items.some((i) => i.path === "favorite/2026-11-20-promise.md")).toBe(true);

    // 预算满时跳过 Step 2.8 不发第二跳请求
    await ctx.tools.write(
      "episodes/2026/11/20/ep-long-anchor.md",
      `---\ntitle: 超长锚点\nkind: episode\ncreated: 2026-11-20\n---\n${"很长的故事内容。".repeat(300)}，关联 [[约定原话]]。\n`,
    );
    let hopCallsOnBudgetFull = 0;
    const budgetFullRes = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-budget-full",
      turnId: "t-budget-full",
      query: "超长锚点",
      embedding: unitEmbed,
      decisionClient: {
        async decide(req) {
          if ("needs_memory" in req.questions) {
            const answers: Record<string, { noul: number }> = { needs_memory: { noul: 0.9 } };
            for (const k of Object.keys(req.questions)) {
              if (k === "needs_memory") continue;
              const block = req.input.split("\n\n").find((b) => b.includes(`[${k}]`));
              answers[k] = { noul: block?.includes("ep-long-anchor.md") ? 0.95 : 0.05 };
            }
            return { answers, backend: "mock" };
          }
          hopCallsOnBudgetFull++;
          return { answers: {}, backend: "mock" };
        },
      },
      promptsDir: PROMPTS_DIR,
      charBudget: 400,
      recallConfig: { candidatePool: 30 },
    });
    expect(hopCallsOnBudgetFull).toBe(0);
    expect(budgetFullRes.hopStoppedReason).toBe("budget_full");
  });
});
