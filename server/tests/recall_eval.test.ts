import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { DecisionClient, DecisionRequest, DecisionResponse } from "../src/core/decision.ts";
import { commitMemoryPaths } from "../src/core/git.ts";
import {
  applyReviewMarkdown,
  buildAndGradeGold,
  CachedDecisionClient,
  formatComparisonTable,
  prepareMoments,
  readJsonl,
  runEvalVariant,
  type GoldRecord,
} from "../src/memory/recall_eval.ts";
import { createTestContext, type TestContext } from "./helpers.ts";

class MockEvalDecisionClient implements DecisionClient {
  public calls = 0;

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    this.calls++;
    const answers: DecisionResponse["answers"] = {};
    const convSection = /<conversation>([\s\S]*?)<\/conversation>/.exec(req.input)?.[1] ?? req.input;
    const lastUserLine =
      convSection
        .split("\n")
        .filter((l) => l.startsWith("user: "))
        .pop() ?? convSection;
    for (const [k, q] of Object.entries(req.questions)) {
      if (k === "moment_class") {
        if (lastUserLine.includes("国王")) {
          answers[k] = { choice: "callback", confidence: 0.95, probabilities: { callback: 0.95 } };
        } else if (lastUserLine.includes("好累")) {
          answers[k] = { choice: "quiet", confidence: 0.9, probabilities: { quiet: 0.9 } };
        } else {
          answers[k] = { choice: "resonance", confidence: 0.7, probabilities: { resonance: 0.7 } };
        }
      } else if (k === "needs_memory") {
        answers[k] = { noul: lastUserLine.includes("好累") ? 0.1 : 0.9 };
      } else if (q.type === "noul") {
        // catalog scan: 仅当最后一条用户消息含国王且该条目含国王时给高分
        const idxLine = req.input
          .split("\n")
          .find((l) => l.startsWith(`[${k}] `));
        const match =
          Boolean(idxLine && idxLine.includes("国王") && lastUserLine.includes("国王")) ||
          Boolean(idxLine && idxLine.includes("三花猫") && lastUserLine.includes("猫"));
        answers[k] = { noul: match ? 0.92 : 0.05 };
      } else if (q.type === "choice") {
        const block = req.input
          .split("\n\n")
          .find((b) => b.includes(`[${k}] `));
        const match =
          Boolean(block && block.includes("国王") && lastUserLine.includes("国王")) ||
          Boolean(block && block.includes("三花猫") && lastUserLine.includes("猫"));
        answers[k] = {
          choice: match ? "2" : "0",
          confidence: 0.9,
          probabilities: match ? { "2": 0.9, "0": 0.1 } : { "0": 0.9, "2": 0.1 },
        };
      }
    }
    return { answers, backend: "mock-eval" };
  }
}

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("闲聊回放召回评测框架（离线合成夹具）", () => {
  test("防穿越时间切片、缓存复用、人工抽查回写与指标报告全链路", async () => {
    ctx = await createTestContext({
      initialTimeMs: Date.parse("2026-10-11T22:00:00+08:00"),
    });

    // Day 1 整理完写出一张国王卡片并提交
    await ctx.tools.write(
      "threads/myth/king.md",
      "---\ntitle: 吃掉自己的国王\nkind: work\nwhen_to_recall: 提到国王或饥饿故事时\n---\n色萨利国王砍倒了圣林的老橡树。\n",
    );
    await commitMemoryPaths(ctx.dataDir, ["threads/myth/king.md"], "memory(bedtime): day1");
    const day1CommitAt = new Date().toISOString();

    // 稍等 1.1s 确保 Day 2 commit 秒级时间戳严格晚于 Day 2 importedAt
    await new Promise((r) => setTimeout(r, 1100));
    const day2ImportedAt = new Date().toISOString();

    // 写入 Day 2 事件（1 条回指、1 条该安静）
    ctx.clock.setTime(Date.parse("2026-10-12T21:00:00+08:00"));
    ctx.events.append({
      sessionId: "sess-d2",
      turnId: "t-king",
      role: "user",
      kind: "chat",
      content: "还记得上次聊的那个吃掉自己的国王吗",
    });
    ctx.clock.advance(5000);
    ctx.events.append({
      sessionId: "sess-d2",
      turnId: "t-king",
      role: "assistant",
      kind: "chat",
      content: "记得呀，他砍倒了圣林的橡树。",
    });
    ctx.clock.advance(60_000);
    ctx.events.append({
      sessionId: "sess-d2",
      turnId: "t-tired",
      role: "user",
      kind: "chat",
      content: "今天加班好累啊，不想动脑子了",
    });
    ctx.clock.advance(5000);
    ctx.events.append({
      sessionId: "sess-d2",
      turnId: "t-tired",
      role: "assistant",
      kind: "chat",
      content: "辛苦啦，先歇着。",
    });

    // Day 2 结束时写出"未来卡片"（测试防穿越：评测 Day 2 时绝不能召回这张卡）
    await new Promise((r) => setTimeout(r, 1100));
    await ctx.tools.write(
      "episodes/2026/10/12/ep-future-cat.md",
      "---\ntitle: 未来才出现的三花猫\nkind: episode\n---\n这是一张 Day 2 结束后才整理的卡，评测 Day 2 不应看到它。\n",
    );
    await commitMemoryPaths(ctx.dataDir, ["episodes/2026/10/12/ep-future-cat.md"], "memory(bedtime): day2");

    await fs.writeFile(
      path.join(ctx.dataDir, "replay_state.json"),
      JSON.stringify({
        results: {
          "2026-10-11": { importedAt: new Date(Date.parse(day1CommitAt) - 5000).toISOString() },
          "2026-10-12": { importedAt: day2ImportedAt },
        },
      }),
      "utf8",
    );

    const mock = new MockEvalDecisionClient();
    const cached = new CachedDecisionClient(
      mock,
      path.join(ctx.dataDir, "eval", "decision_cache.jsonl"),
    );

    // 1. prepare
    const moments = await prepareMoments({
      dataDir: ctx.dataDir,
      timeZone: "Asia/Shanghai",
      decisionClient: cached,
    });
    expect(moments.length).toBe(2);
    expect(moments.find((m) => m.turnId === "t-king")?.momentClass).toBe("callback");
    expect(moments.find((m) => m.turnId === "t-tired")?.momentClass).toBe("quiet");

    // 重复调用应命中缓存，零新增底层调用
    const callsAfterPrepare = mock.calls;
    await prepareMoments({
      dataDir: ctx.dataDir,
      timeZone: "Asia/Shanghai",
      decisionClient: cached,
    });
    expect(mock.calls).toBe(callsAfterPrepare);

    // 2. grade & 防穿越断言（未来三花猫卡片绝不可出现在 Day 2 候选中）
    const { gold, reviewPath } = await buildAndGradeGold({
      dataDir: ctx.dataDir,
      timeZone: "Asia/Shanghai",
      decisionClient: cached,
      sampleSize: 10,
      reviewCount: 5,
    });
    expect(gold.length).toBe(2);
    for (const g of gold) {
      expect(g.candidates.some((c) => c.path.includes("ep-future-cat"))).toBe(false);
    }
    const kingGold = gold.find((g) => g.turnId === "t-king")!;
    expect(kingGold.candidates.some((c) => c.path === "threads/myth/king.md" && c.grade === 2)).toBe(
      true,
    );

    // 3. apply-review：修改 review.md 中 t-tired 的 moment 为 fresh 并验证回写
    const reviewMd = await fs.readFile(reviewPath, "utf8");
    const edited = reviewMd.replace("[moment: quiet]", "[moment: fresh]");
    await fs.writeFile(reviewPath, edited, "utf8");
    const applied = await applyReviewMarkdown(ctx.dataDir);
    expect(applied.updatedTurns).toBe(1);
    const updatedGold = await readJsonl<GoldRecord>(path.join(ctx.dataDir, "eval", "gold.jsonl"));
    expect(updatedGold.find((g) => g.turnId === "t-tired")?.momentClass).toBe("fresh");

    // 改回 quiet 测基线报告
    updatedGold.find((g) => g.turnId === "t-tired")!.momentClass = "quiet";

    // 4. runEvalVariant (含 2h 会话去重验证：同 sessionId 连续两轮回指同一张卡时，第 2 轮应命中去重不再重复召回)
    updatedGold.push({
      ...kingGold,
      turnId: "t-king-repeat",
      seq: kingGold.seq + 10,
      createdAt: kingGold.createdAt + 60_000,
    });
    const report = await runEvalVariant({
      dataDir: ctx.dataDir,
      timeZone: "Asia/Shanghai",
      variant: { name: "baseline" },
      gold: updatedGold,
    });
    expect(report.metrics.callbackContHitAt5).toBeCloseTo(0.5, 2);
    expect(report.turns.find((t) => t.turnId === "t-king")?.recalledPaths).toEqual([
      "threads/myth/king.md",
    ]);
    expect(report.turns.find((t) => t.turnId === "t-king-repeat")?.recalledPaths).toEqual([]);
    expect(report.metrics.quietCount).toBe(1);
    const table = formatComparisonTable([report]);
    expect(table).toContain("baseline");
  });
});
