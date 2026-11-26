import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { initDataDir, loadOrCreateConfig, mergeRadarConfig } from "../src/core/config.ts";
import { openDatabase, runMigrations } from "../src/core/db.ts";
import type {
  DecisionClient,
  DecisionRequest,
  DecisionResponse,
} from "../src/core/decision.ts";
import type { EmbeddingClient } from "../src/core/embedding.ts";
import { commitMemoryPaths, getMemoryHeadCommit, initMemoryGitRepo } from "../src/core/git.ts";
import { readPrompt } from "../src/core/prompts.ts";
import { evaluateAndRunReflect, markReflectCursorCompleted } from "../src/engine/reflect.ts";
import { runMemoryTidyTask } from "../src/engine/tidy.ts";
import type { ChatModelClient, ChatStreamChunk } from "../src/llm/client.ts";
import { LlmFallbackDecisionClient } from "../src/llm/decision.ts";
import { MemoryIndex } from "../src/memory/index.ts";
import {
  extractBoardItems,
  parseMemoryRadarPrompt,
  renderMemoryRadarBlock,
  runMemoryRadar,
} from "../src/memory/radar.ts";
import { MemoryTools } from "../src/memory/tools.ts";
import { EventStore } from "../src/store/events.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

async function setupEnv(isoTime = "2026-11-26T23:45:00+08:00") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "psyber-radar-test-"));
  await initDataDir(dataDir);
  await initMemoryGitRepo(dataDir);
  const clock = new VirtualClock(Date.parse(isoTime), "Asia/Shanghai");
  const config = await loadOrCreateConfig(dataDir, clock.now(), clock.timeZone);
  const db = openDatabase(path.join(dataDir, "psyber.sqlite"));
  runMigrations(db, clock.now());
  const memoryIndex = new MemoryIndex(db, dataDir, clock);
  const memoryTools = new MemoryTools(dataDir, memoryIndex, clock);
  const events = new EventStore(db, clock);

  await memoryTools.write(
    "core/self.md",
    "---\ntitle: 我是谁\nname: 测试体\npronoun: 我\n---\n测试自我档案。\n",
  );
  await memoryTools.write(
    "core/user.md",
    "---\ntitle: 关于对方\nname: user\npronoun: 你\n---\n测试用户档案。\n",
  );
  await commitMemoryPaths(dataDir, ["core/self.md", "core/user.md"], "init core");

  return { dataDir, clock, config, db, memoryIndex, memoryTools, events };
}

type StreamReq = Parameters<ChatModelClient["stream"]>[0];

class ScriptedChatModel implements ChatModelClient {
  readonly modelId = "mock-radar-chat";
  readonly contextWindow = 128_000;
  calls = 0;
  readonly seenRequests: StreamReq[] = [];

  constructor(
    private readonly handler: (req: StreamReq, callIdx: number) => ChatStreamChunk[],
  ) {}

  async *stream(req: StreamReq): AsyncIterable<ChatStreamChunk> {
    this.seenRequests.push(req);
    const chunks = this.handler(req, this.calls++);
    for (const c of chunks) yield c;
  }
}

describe("Memory Radar · 只读体检雷达", () => {
  test("parses prompts/memory-radar.md with noul criteria and choice options", async () => {
    const loaded = await readPrompt(PROMPTS_DIR, "memory-radar.md");
    const spec = parseMemoryRadarPrompt(loaded.body);

    expect(spec.redundant.type).toBe("noul");
    expect(spec.redundant.criteria?.true_description).toContain("同一事件");
    expect(spec.redundant.criteria?.false_description).toContain("不同维度");

    expect(spec.contradiction.criteria?.true_description).toContain("互相打架");
    expect(spec.obsolete.instructions).toContain("取代");
    expect(spec.obsolete.criteria?.true_description).toContain("完成、取消、恢复");
    expect(spec.link.instructions).toContain("1 跳");
    expect(spec.link.criteria?.true_description).toContain("前因后果");
    expect(spec.promote.type).toBe("noul");
    expect(spec.promote.criteria?.true_description).toContain("跨越不同日期");

    expect(spec.representation.type).toBe("choice");
    expect(Object.keys(spec.representation.criteria ?? {}).sort()).toEqual([
      "keep_separate",
      "merge",
      "promote",
      "uncertain",
    ]);

    expect(spec.boardObsolete.instructions).toContain("{{item_id}}");
    expect(spec.boardContradiction.criteria?.true_description).toContain("{{item_id}}");
  });

  test("extractBoardItems filters placeholders and strictly expired state items", () => {
    const stateMd = [
      "---",
      "title: 近期状态",
      "---",
      "## 短期状态与待办",
      "- [至 2026-11-20] 旧感冒已过有效期",
      "- [until: 2026-11-21] 旧代办已过期",
      "- [至 2026-11-30] 右脚踝扭伤，有点肿还能走（[[11-18 脚踝扭伤]]）",
      "- 空调漏水待报修",
      "- 无糖饮食坚持第 3 天",
      "- （暂无）",
      "- 暂无",
      "## 进行中的长线",
      "- **读书笔记**：共读第 3 本（[[书单进度]]）",
    ].join("\n");

    const items = extractBoardItems("core/state.md", stateMd, "2026-11-26");
    expect(items.length).toBe(4);
    expect(items[0]!.text).toContain("右脚踝扭伤");
    expect(items[0]!.section).toBe("短期状态与待办");
    expect(items[1]!.text).toContain("空调漏水待报修");
    expect(items[2]!.text).toContain("无糖饮食坚持第 3 天");
    expect(items[3]!.text).toContain("读书笔记");
    expect(items[3]!.section).toBe("进行中的长线");
  });

  test("board check + 5-question pair scan obeys space guardrails, skips existing links, and respects scope division", async () => {
    const env = await setupEnv("2026-11-26T23:45:00+08:00");
    try {
      await env.memoryTools.write(
        "core/state.md",
        "---\ntitle: 近期状态\n---\n## 短期状态与待办\n- [至 2026-11-30] 右脚踝扭伤，走路微疼（[[11-18 脚踝扭伤]]）\n",
      );
      await env.memoryTools.write(
        "core/open.md",
        "---\ntitle: 未完挂念\n---\n- 还没确认是否真的讨厌香菜\n",
      );
      // 旧情景切片（不同天）：应屏蔽 obsolete/merge/redundant，放行 promote
      await env.memoryTools.write(
        "episodes/2026/11/18/ep-late-night.md",
        "---\ntitle: 11-18 熬夜头痛\nkind: episode\nstatus: active\ncreated: 2026-11-18\nupdated: 2026-11-18\n---\n昨晚熬夜写东西到三点，第二天头痛。\n",
      );
      // 已与新卡存在双向链接的旧专卡：应跳过 link 提问
      await env.memoryTools.write(
        "entities/food/coriander.md",
        "---\ntitle: 香菜偏好\nkind: note\nstatus: active\ncreated: 2026-11-10\nupdated: 2026-11-10\n---\n对方之前说一点都不吃香菜。\n",
      );
      // 尚未建立双链的长期线索卡：bedtime 应问 link，weekly 不应问 link
      await env.memoryTools.write(
        "threads/running/plan.md",
        "---\ntitle: 晨跑恢复计划\nkind: note\nstatus: active\ncreated: 2026-11-12\nupdated: 2026-11-12\n---\n等脚踝好利索后重新开始晨跑。\n",
      );

      // 今日新卡
      await env.memoryTools.write(
        "episodes/2026/11/26/ep-run-and-late.md",
        "---\ntitle: 11-26 熬夜后晨跑\nkind: episode\nstatus: active\ncreated: 2026-11-26\nupdated: 2026-11-26\n---\n昨晚又熬夜到三点头痛；今天右脚踝彻底好了去晨跑，午饭居然点了加双份香菜（见 [[香菜偏好]]）。\n",
      );

      // 使用受控假向量保证精准配对
      const vecMap: Record<string, number[]> = {
        "episodes/2026/11/26/ep-run-and-late.md": [1, 0, 0],
        "episodes/2026/11/18/ep-late-night.md": [0.95, 0.31, 0],
        "entities/food/coriander.md": [0.92, 0, 0.39],
        "threads/running/plan.md": [0.9, 0.2, 0.38],
      };
      const fakeEmbedding: EmbeddingClient = {
        modelKey: "mock-embed-v1",
        isConfigured: () => true,
        async embed(text: string): Promise<Float32Array> {
          if (text.includes("11-26 熬夜后晨跑")) return new Float32Array(vecMap["episodes/2026/11/26/ep-run-and-late.md"]!);
          if (text.includes("11-18 熬夜头痛")) return new Float32Array(vecMap["episodes/2026/11/18/ep-late-night.md"]!);
          if (text.includes("香菜偏好")) return new Float32Array(vecMap["entities/food/coriander.md"]!);
          if (text.includes("晨跑恢复计划")) return new Float32Array(vecMap["threads/running/plan.md"]!);
          return new Float32Array([0, 0, 1]);
        },
      };

      const askedByPair: Record<string, string[]> = {};
      const fakeDecision: DecisionClient = {
        async decide(req: DecisionRequest): Promise<DecisionResponse> {
          if (req.input.includes("<board_items>")) {
            return {
              answers: {
                ob_b0: { noul: 0.91 },
                ct_b0: { noul: 0.08 },
                ob_b1: { noul: 0.2 },
                ct_b1: { noul: 0.84 },
              },
            };
          }

          const qKeys = Object.keys(req.questions).sort();
          if (req.input.includes("episodes/2026/11/18/ep-late-night.md")) {
            askedByPair["ep-late-night"] = qKeys;
            return {
              answers: {
                // 即使模型误给高 obsolete/redundant，ep<->ep 护栏也只放行 promote
                contradiction: { noul: 0.1 },
                obsolete: { noul: 0.95 },
                redundant: { noul: 0.95 },
                link: { noul: 0.3 },
                promote: { noul: 0.82 },
              },
            };
          }
          if (req.input.includes("entities/food/coriander.md")) {
            askedByPair["coriander"] = qKeys;
            return {
              answers: {
                contradiction: { noul: 0.86 },
                obsolete: { noul: 0.2 },
                promote: { noul: 0.1 },
              },
            };
          }
          if (req.input.includes("threads/running/plan.md")) {
            askedByPair["plan"] = qKeys;
            return {
              answers: {
                contradiction: { noul: 0.05 },
                obsolete: { noul: 0.15 },
                link: { noul: 0.88 },
                promote: { noul: 0.1 },
              },
            };
          }
          return { answers: {} };
        },
      };

      const bedtimeRes = await runMemoryRadar({
        db: env.db,
        dataDir: env.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: env.clock,
        memoryIndex: env.memoryIndex,
        decisionClient: fakeDecision,
        embedding: fakeEmbedding,
        scope: "bedtime",
        targetDay: "2026-11-26",
        newCardPaths: ["episodes/2026/11/26/ep-run-and-late.md"],
        includeOpenBoardInBlock: false,
      });

      expect(bedtimeRes.executed).toBe(true);
      expect(bedtimeRes.boardItemsChecked).toBe(2);
      expect(bedtimeRes.pairsEvaluated).toBe(3);

      // 1) ep<->ep 自动跳过 redundant/obsolete/representation，仅问 contradiction / link / promote
      expect(askedByPair["ep-late-night"]).toEqual(["contradiction", "link", "promote"]);
      // 2) ep<->专卡且已有 [[香菜偏好]] 双链：跳过 link/redundant/representation，仅问 contradiction / obsolete / promote
      expect(askedByPair["coriander"]).toEqual([
        "contradiction",
        "obsolete",
        "promote",
      ]);
      // 3) ep<->未建双链的持久专卡：bedtime 下问 contradiction / link / obsolete / promote
      expect(askedByPair["plan"]).toEqual([
        "contradiction",
        "link",
        "obsolete",
        "promote",
      ]);

      // 4) 产出线索检查：含看板 obsolete、香菜 contradiction、熬夜 promote、晨跑 link
      const kinds = bedtimeRes.findings.map((f) => `${f.source}:${f.kind}:${f.targetPath}`);
      expect(kinds).toContain("board:obsolete:core/state.md");
      expect(kinds).toContain("board:contradiction:core/open.md");
      expect(kinds).toContain("pair:contradiction:entities/food/coriander.md");
      expect(kinds).toContain("pair:promote:episodes/2026/11/18/ep-late-night.md");
      expect(kinds).toContain("pair:link:threads/running/plan.md");

      // 5) bedtime 未合并日反思时 renderedBlock 不暴露 core/open.md，但 reflectGateHint 包含它
      expect(bedtimeRes.renderedBlock).toContain("<memory_radar>");
      expect(bedtimeRes.renderedBlock).toContain("core/state.md");
      expect(bedtimeRes.renderedBlock).not.toContain("core/open.md");
      expect(bedtimeRes.renderedBlock).toContain("[可考虑补双链]");
      expect(bedtimeRes.reflectGateHint).toContain("香菜偏好");
      expect(bedtimeRes.reflectGateHint).toContain("11-18 熬夜头痛");
      expect(bedtimeRes.reflectGateHint).toContain("core/open.md");

      // 6) weekly 模式下不问 link，也不展示 link
      const weeklyAsked: Record<string, string[]> = {};
      const weeklyDecision: DecisionClient = {
        async decide(req: DecisionRequest): Promise<DecisionResponse> {
          if (req.input.includes("threads/running/plan.md")) {
            weeklyAsked["plan"] = Object.keys(req.questions).sort();
          }
          return fakeDecision.decide(req);
        },
      };
      const weeklyRes = await runMemoryRadar({
        db: env.db,
        dataDir: env.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: env.clock,
        memoryIndex: env.memoryIndex,
        decisionClient: weeklyDecision,
        embedding: fakeEmbedding,
        scope: "weekly",
        targetDay: "2026-11-26",
        newCardPaths: ["episodes/2026/11/26/ep-run-and-late.md"],
      });
      expect(weeklyAsked["plan"]).not.toContain("link");
      expect(weeklyRes.renderedBlock).toContain("core/open.md");
      expect(weeklyRes.renderedBlock).not.toContain("[可考虑补双链]");
    } finally {
      env.db.close();
      await fs.rm(env.dataDir, { recursive: true, force: true });
    }
  });

  test("returns null block when below thresholds and degrades non-blockingly on timeout/errors", async () => {
    const env = await setupEnv("2026-11-26T23:45:00+08:00");
    try {
      await env.memoryTools.write(
        "entities/pets/cat.md",
        "---\ntitle: 小橘\nkind: note\nstatus: active\ncreated: 2026-11-10\nupdated: 2026-11-10\n---\n楼下常喂的橘猫。\n",
      );
      await env.memoryTools.write(
        "episodes/2026/11/26/ep-cat.md",
        "---\ntitle: 11-26 喂小橘\nkind: episode\nstatus: active\ncreated: 2026-11-26\nupdated: 2026-11-26\n---\n下班顺手给小橘倒了猫粮。\n",
      );

      // 低分全部不达标 -> renderedBlock 必须为 null（零注入）
      const quietDecision: DecisionClient = {
        async decide() {
          return {
            answers: {
              redundant: { noul: 0.1 },
              contradiction: { noul: 0.05 },
              obsolete: { noul: 0.05 },
              link: { noul: 0.4 },
              representation: { choice: "keep_separate", probabilities: { keep_separate: 0.9 } },
            },
          };
        },
      };
      const quietRes = await runMemoryRadar({
        db: env.db,
        dataDir: env.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: env.clock,
        memoryIndex: env.memoryIndex,
        decisionClient: quietDecision,
        scope: "bedtime",
        targetDay: "2026-11-26",
        newCardPaths: ["episodes/2026/11/26/ep-cat.md"],
      });
      expect(quietRes.executed).toBe(true);
      expect(quietRes.findings.length).toBe(0);
      expect(quietRes.renderedBlock).toBeNull();
      expect(quietRes.reflectGateHint).toBeNull();

      // 模型报错 -> 非阻塞安全降级，绝不抛错
      const brokenDecision: DecisionClient = {
        async decide() {
          throw new Error("503 service unavailable");
        },
      };
      const errRes = await runMemoryRadar({
        db: env.db,
        dataDir: env.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: env.clock,
        memoryIndex: env.memoryIndex,
        decisionClient: brokenDecision,
        scope: "bedtime",
        targetDay: "2026-11-26",
        newCardPaths: ["episodes/2026/11/26/ep-cat.md"],
      });
      expect(errRes.findings.length).toBe(0);
      expect(errRes.renderedBlock).toBeNull();

      // disabled 开关一键关闭 -> 0 调用
      let called = false;
      const disabledRes = await runMemoryRadar({
        db: env.db,
        dataDir: env.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: env.clock,
        memoryIndex: env.memoryIndex,
        decisionClient: {
          async decide() {
            called = true;
            return { answers: {} };
          },
        },
        scope: "bedtime",
        targetDay: "2026-11-26",
        newCardPaths: ["episodes/2026/11/26/ep-cat.md"],
        radarConfig: { enabled: false },
      });
      expect(disabledRes.executed).toBe(false);
      expect(disabledRes.skipReason).toBe("disabled");
      expect(called).toBe(false);
    } finally {
      env.db.close();
      await fs.rm(env.dataDir, { recursive: true, force: true });
    }
  });

  test("bedtime and weekly reflect pipelines inject <memory_radar> and feed radarHint into reflect gate", async () => {
    const env = await setupEnv("2026-11-29T23:45:00+08:00"); // 2026-11-29 is Sunday
    try {
      await env.memoryTools.write(
        "core/state.md",
        "---\ntitle: 近期状态\n---\n## 短期状态与待办\n- [至 2026-12-05] 右脚踝扭伤，还在静养\n",
      );
      await env.memoryTools.write(
        "entities/food/coffee.md",
        "---\ntitle: 咖啡偏好\nkind: note\nstatus: active\ncreated: 2026-11-10\nupdated: 2026-11-10\n---\n只喝浅烘手冲，不喜欢深烘。\n",
      );
      await commitMemoryPaths(
        env.dataDir,
        ["core/state.md", "entities/food/coffee.md"],
        "seed history",
      );
      const lastWeekCommit = await getMemoryHeadCommit(env.dataDir);
      // 模拟上周周反思游标停在历史提交，本周新增 ep-coffee-run.md 与历史 coffee.md 形成新旧对比
      markReflectCursorCompleted(env.db, "weekly", env.clock.now() - 7 * 86_400_000, {
        targetDay: "2026-11-22",
        commitHash: lastWeekCommit,
        committed: true,
      });

      // 模拟今日已有新卡（FT5 与咖啡偏好撞词）
      await env.memoryTools.write(
        "episodes/2026/11/29/ep-coffee-run.md",
        "---\ntitle: 11-29 晨跑喝深烘\nkind: episode\nstatus: active\ncreated: 2026-11-29\nupdated: 2026-11-29\n---\n右脚踝扭伤完全好了，跑完步喝了深烘拿铁说一直很爱喝深烘咖啡。\n",
      );
      await commitMemoryPaths(
        env.dataDir,
        ["episodes/2026/11/29/ep-coffee-run.md"],
        "add today episode",
      );

      let dailyGateSawRadarHint = false;
      let weeklyGateSawRadarHint = false;
      const decisionClient: DecisionClient = {
        async decide(req: DecisionRequest): Promise<DecisionResponse> {
          if (req.input.includes("<board_items>")) {
            return {
              answers: {
                ob_b0: { noul: 0.9 },
                ct_b0: { noul: 0.1 },
              },
            };
          }
          if ("contradiction" in req.questions && "promote" in req.questions) {
            return {
              answers: {
                contradiction: { noul: 0.85 },
                obsolete: { noul: 0.1 },
                promote: { noul: 0.1 },
                link: { noul: 0.2 },
              },
            };
          }
          if ("has_notable_shift" in req.questions) {
            dailyGateSawRadarHint = req.input.includes("只读体检雷达扫出的高置信线索");
            return {
              answers: {
                has_notable_shift: { noul: 0.2 },
                touches_open_thread: { noul: 0.1 },
              },
            };
          }
          if ("has_unabsorbed_changes" in req.questions) {
            weeklyGateSawRadarHint = req.input.includes("只读体检雷达扫出的高置信线索");
            return {
              answers: {
                has_unabsorbed_changes: { noul: 0.82 },
                has_cross_day_pattern: { noul: 0.78 },
              },
            };
          }
          return { answers: {} };
        },
      };

      const bedtimeChat = new ScriptedChatModel((_req, idx) => {
        if (idx === 0) {
          return [
            {
              type: "tool_call",
              id: "tc-index",
              name: "write",
              args: {
                path: "episodes/2026/11/29/index.md",
                content:
                  "---\ntitle: 2026-11-29 日梗概\nkind: note\nstatus: active\ncreated: 2026-11-29\nupdated: 2026-11-29\n---\n脚踝康复晨跑并聊起咖啡偏好。\n",
              },
            },
          ];
        }
        return [{ type: "text_delta", delta: '{"summary": "完成睡前梗概"}' }];
      });

      const bedtimeOutcome = await runMemoryTidyTask(
        {
          db: env.db,
          dataDir: env.dataDir,
          promptsDir: PROMPTS_DIR,
          clock: env.clock,
          events: env.events,
          memoryIndex: env.memoryIndex,
          memoryTools: env.memoryTools,
          chatModel: bedtimeChat,
          decisionClient,
          getConfig: () => env.config,
          retryDelaysMs: [],
        },
        { taskType: "bedtime", nightDate: "2026-11-29" },
      );

      expect(bedtimeOutcome.ok).toBe(true);
      expect(dailyGateSawRadarHint).toBe(true);
      expect(bedtimeOutcome.radar?.executed).toBe(true);
      expect(bedtimeOutcome.radar?.findingsCount).toBeGreaterThanOrEqual(2);
      const bedtimePromptText = bedtimeChat.seenRequests[0]?.messages.map((m) => m.content).join("\n") ?? "";
      expect(bedtimePromptText).toContain("<memory_radar>");
      expect(bedtimePromptText).toContain("咖啡偏好");

      // 再跑周反思：应把雷达线索同时送进周反思门控与周反思材料块
      const weeklyChat = new ScriptedChatModel(() => [
        { type: "text_delta", delta: '{"summary": "核实咖啡偏好线索"}' },
      ]);
      const weeklyOutcome = await evaluateAndRunReflect(
        {
          db: env.db,
          dataDir: env.dataDir,
          promptsDir: PROMPTS_DIR,
          clock: env.clock,
          memoryIndex: env.memoryIndex,
          memoryTools: env.memoryTools,
          chatModel: weeklyChat,
          decisionClient,
          getConfig: () => env.config,
          retryDelaysMs: [],
        },
        { scope: "weekly", targetDay: "2026-11-29" },
      );

      expect(weeklyOutcome.ok).toBe(true);
      expect(weeklyOutcome.triggered).toBe(true);
      expect(weeklyGateSawRadarHint).toBe(true);
      expect(weeklyOutcome.radar?.executed).toBe(true);
      const weeklyPromptText = weeklyChat.seenRequests[0]?.messages.map((m) => m.content).join("\n") ?? "";
      expect(weeklyPromptText).toContain("<memory_radar>");
      expect(weeklyPromptText).toContain("咖啡偏好");
    } finally {
      env.db.close();
      await fs.rm(env.dataDir, { recursive: true, force: true });
    }
  });

  test("renderMemoryRadarBlock maintains objective non-first-person system framing", () => {
    const block = renderMemoryRadarBlock(
      [
        {
          kind: "contradiction",
          score: 0.81,
          source: "pair",
          newCardPath: "episodes/2026/11/26/ep-a.md",
          newCardTitle: "11-26 新卡",
          targetPath: "entities/x.md",
          targetTitle: "旧卡",
          detail: "contradiction=0.81（建议核对原文）",
        },
      ],
      { scope: "bedtime" },
    );
    expect(block).not.toBeNull();
    expect(block).toContain("可能存在误报");
    expect(block).toContain("系统未修改任何文件");
    expect(block).not.toContain("我觉得");
    expect(block).not.toContain("我认为");
    expect(renderMemoryRadarBlock([{ kind: "contradiction", score: 0.81, source: "pair", targetPath: "entities/x.md", targetTitle: "旧卡", detail: "d" }], { scope: "bedtime", maxItems: 0 })).toBeNull();
  });

  test("covers review regressions: board quota, weekly intra-week pairing, FTS skip budget, fallback dedup, abort & config safety", async () => {
    const env = await setupEnv("2026-11-29T23:45:00+08:00");
    try {
      // 1) mergeRadarConfig ignores undefined/null/NaN overrides
      const merged = mergeRadarConfig(
        { timeoutMs: undefined, thresholds: { contradiction: undefined } },
        { concurrency: Number.NaN, thresholds: { promote: null as unknown as number } },
      );
      expect(merged.timeoutMs).toBe(20_000);
      expect(merged.concurrency).toBe(4);
      expect(merged.thresholds.contradiction).toBe(0.55);
      expect(merged.thresholds.promote).toBe(0.65);

      // 2) core/state.md 超过 12 条时不会饿死 core/open.md（每表保底 6 条配额）
      const manyStateLines = Array.from(
        { length: 10 },
        (_, i) => `- [至 2026-12-10] 短期状态条目第 ${i + 1} 项待核对`,
      ).join("\n");
      await env.memoryTools.write(
        "core/state.md",
        `---\ntitle: 近期状态\n---\n## 短期状态与待办\n${manyStateLines}\n`,
      );
      await env.memoryTools.write(
        "core/open.md",
        "---\ntitle: 未完挂念\n---\n- 挂念事项 A：周三体检报告是否出来了\n- 挂念事项 B：空调漏水报修进展\n",
      );

      // 3) 本周内不同天的两张新卡（周二与周四）+ 已双链溯源的专卡与旧 ep-* + 未互链旧卡
      await env.memoryTools.write(
        "episodes/2026/11/24/ep-neck-1.md",
        "---\ntitle: 11-24 久坐颈椎痛\nkind: episode\nstatus: active\ncreated: 2026-11-24\nupdated: 2026-11-24\n---\n连续加班久坐导致颈椎酸痛僵硬。\n",
      );
      await env.memoryTools.write(
        "episodes/2026/11/26/ep-neck-2.md",
        "---\ntitle: 11-26 再次久坐颈椎痛\nkind: episode\nstatus: active\ncreated: 2026-11-26\nupdated: 2026-11-26\n---\n今天又连续久坐没活动，颈椎酸痛复发。\n",
      );
      await env.memoryTools.write(
        "threads/health/neck-care.md",
        "---\ntitle: 颈椎护理记录\nkind: note\nstatus: active\ncreated: 2026-11-27\nupdated: 2026-11-27\n---\n整理自 [[11-24 久坐颈椎痛]] 与 [[11-26 再次久坐颈椎痛]] 的颈椎酸痛护具计划。\n",
      );
      await env.memoryTools.write(
        "lessons/posture-habit.md",
        "---\ntitle: 久坐提醒习惯\nkind: lesson\nstatus: active\ncreated: 2026-11-01\nupdated: 2026-11-01\n---\n久坐颈椎酸痛时每小时站起来活动五分钟。\n",
      );

      // 4) 使用 LlmFallbackDecisionClient 验证 ob_b0/ct_b0 模板去重生效，且周反思同周新卡互配 + FTS 跳过已互链 ep 后继续补齐未互链旧卡
      const fallbackChat = new ScriptedChatModel((req) => {
        const userMsg = String(req.messages[0]?.content ?? "");
        if (userMsg.includes("<board_items>")) {
          // 12 个看板项 × 2 问 = 24 问，应归一化为 t0/t1 两个模板
          expect(userMsg).toContain('"templates"');
          expect(userMsg).toContain('"t0"');
          expect(userMsg).toContain('"t1"');
          expect(userMsg).not.toContain('"t2"');
          return [
            {
              type: "text_delta",
              delta: JSON.stringify({
                answers: {
                  ob_b6: { noul: 0.88 },
                  ct_b6: { noul: 0.05 },
                },
              }),
            },
          ];
        }
        return [
          {
            type: "text_delta",
            delta: JSON.stringify({
              answers: {
                contradiction: { noul: 0.1 },
                obsolete: { noul: 0.1 },
                promote: { noul: 0.81 },
                redundant: { noul: 0.2 },
                representation: { choice: "promote", confidence: 0.5 },
              },
            }),
          },
        ];
      });
      const fallbackDecision = new LlmFallbackDecisionClient(fallbackChat);

      const weeklyRes = await runMemoryRadar({
        db: env.db,
        dataDir: env.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: env.clock,
        memoryIndex: env.memoryIndex,
        decisionClient: fallbackDecision,
        scope: "weekly",
        targetDay: "2026-11-29",
        // 模拟整周所有卡片都是本周新增（测试同周跨日互配 + FTS 跳过已互链 ep-* 后仍能配到 lessons/posture-habit.md）
        newCardPaths: [
          "episodes/2026/11/24/ep-neck-1.md",
          "episodes/2026/11/26/ep-neck-2.md",
          "threads/health/neck-care.md",
        ],
        radarConfig: { topKPerCard: 1 },
        collectDebug: true,
      });

      expect(weeklyRes.executed).toBe(true);
      expect(weeklyRes.boardItemsChecked).toBe(12); // 2 open.md + 10 state.md（每表保底 6 条 + 剩余配额回填至 12 条上限）
      expect(
        weeklyRes.debug?.boardItems.filter((b) => b.filePath === "core/open.md").length,
      ).toBe(2);
      expect(
        weeklyRes.debug?.boardItems.filter((b) => b.filePath === "core/state.md").length,
      ).toBe(10);
      // 1) 同周不同天的 ep-neck-1 与 ep-neck-2 得以成功配对；2) neck-care.md 在 FTS 下跳过已双链的 2 张 ep 后仍配到 posture-habit.md
      const pairKeys = (weeklyRes.debug?.pairs ?? []).map(
        (p) => [p.newCardPath, p.oldCardPath].sort().join("<->"),
      );
      expect(pairKeys).toContain(
        "episodes/2026/11/24/ep-neck-1.md<->episodes/2026/11/26/ep-neck-2.md",
      );
      expect(pairKeys).toContain(
        "lessons/posture-habit.md<->threads/health/neck-care.md",
      );

      // 5) 非反思 bedtime 渲染 promote 时不诱导修改 lessons/ 或 core/
      const nonReflectBlock = renderMemoryRadarBlock(weeklyRes.findings, {
        scope: "bedtime",
        includeOpenBoard: false,
      });
      expect(nonReflectBlock).not.toBeNull();
      expect(nonReflectBlock).toContain("本轮非反思轮，不改 lessons/ 与 core/");

      // 6) AbortSignal 在 embedding 阶段中止时立即退出，不穿透到 FTS5
      const abortCtrl = new AbortController();
      const abortingEmbed: EmbeddingClient = {
        modelKey: "abort-embed",
        isConfigured: () => true,
        async embed() {
          abortCtrl.abort();
          throw new Error("AbortError: cancelled by user turn");
        },
      };
      let decisionCalledAfterAbort = false;
      const abortedRes = await runMemoryRadar({
        db: env.db,
        dataDir: env.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: env.clock,
        memoryIndex: env.memoryIndex,
        decisionClient: {
          async decide() {
            if (abortCtrl.signal.aborted) decisionCalledAfterAbort = true;
            return { answers: {} };
          },
        },
        embedding: abortingEmbed,
        scope: "bedtime",
        targetDay: "2026-11-29",
        newCardPaths: ["episodes/2026/11/26/ep-neck-2.md"],
        signal: abortCtrl.signal,
      });
      expect(abortedRes.error).toBe("Aborted");
      expect(abortedRes.timedOut).toBe(true);
      expect(abortedRes.pairsEvaluated).toBe(0);
      expect(decisionCalledAfterAbort).toBe(false);
    } finally {
      env.db.close();
      await fs.rm(env.dataDir, { recursive: true, force: true });
    }
  });
});
