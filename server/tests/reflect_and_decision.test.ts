import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VirtualClock } from "../src/core/clock.ts";
import { initDataDir, loadOrCreateConfig, saveConfig } from "../src/core/config.ts";
import { saveCredentials } from "../src/core/credentials.ts";
import { openDatabase, runMigrations } from "../src/core/db.ts";
import {
  commitMemoryPaths,
  getMemoryHeadCommit,
  initMemoryGitRepo,
  listChangedMemoryPathsSince,
} from "../src/core/git.ts";
import {
  evaluateAndRunReflect,
  isSubstantiveReflectPath,
  isSundayDay,
  isWeeklyReflectDue,
  maybeRunReflectAfterBedtime,
  mostRecentSundayOnOrBefore,
  type DecisionClient,
  type DecisionRequest,
  type DecisionResponse,
} from "../src/engine/reflect.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";
import {
  DynamicDecisionClient,
  GeminiDecisionClient,
  isGeminiDecisionModel,
} from "../src/llm/decision.ts";
import { discoverProviderModels, resolveByokSlot, testModelConnection } from "../src/llm/router.ts";
import { runMemoryTidyTask } from "../src/engine/tidy.ts";
import { MemoryIndex } from "../src/memory/index.ts";
import { MemoryTools } from "../src/memory/tools.ts";
import { EventStore } from "../src/store/events.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function setupMemoryEnv(startIso = "2026-10-17T23:40:00+08:00") {
  const dataDir = await makeTempDir("psyber-reflect-");
  await initDataDir(dataDir);
  await initMemoryGitRepo(dataDir);
  const clock = new VirtualClock(Date.parse(startIso), "Asia/Shanghai");
  const config = await loadOrCreateConfig(dataDir, clock.now(), "Asia/Shanghai");
  const db = openDatabase(path.join(dataDir, "psyber.sqlite"));
  runMigrations(db, clock.now());
  const memoryIndex = new MemoryIndex(db, dataDir, clock);
  const memoryTools = new MemoryTools(dataDir, memoryIndex, clock);

  await memoryTools.write(
    "core/open.md",
    "---\ntitle: 未完挂念\nkind: note\nstatus: active\ncreated: 2026-10-10\nupdated: 2026-10-10\n---\n- 还没聊完关于慢节奏相处的想法\n",
  );
  await commitMemoryPaths(dataDir, ["core/open.md"], "memory(init): seed open.md");

  return { dataDir, clock, config, db, memoryIndex, memoryTools };
}

class ScriptedChatModel implements ChatModelClient {
  readonly contextWindow = 128_000;
  readonly modelId = "scripted-test";
  calls = 0;

  constructor(
    private readonly handler: (req: ChatStreamRequest, callIdx: number) => ChatStreamChunk[],
  ) {}

  async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
    const idx = this.calls++;
    const chunks = this.handler(req, idx);
    for (const c of chunks) {
      yield c;
    }
  }
}

describe("Git helpers & Reflect hard/decision gating", () => {
  test("getMemoryHeadCommit & listChangedMemoryPathsSince track incremental diffs", async () => {
    const dataDir = await makeTempDir("psyber-git-");
    await initDataDir(dataDir);
    await initMemoryGitRepo(dataDir);

    expect(await getMemoryHeadCommit(dataDir)).toBeNull();
    expect(await listChangedMemoryPathsSince(dataDir, null)).toEqual([]);

    const ep1 = path.join(dataDir, "memory", "episodes/2026/10/16/ep-walk.md");
    await fs.mkdir(path.dirname(ep1), { recursive: true });
    await fs.writeFile(ep1, "# walk\n", "utf8");
    await commitMemoryPaths(dataDir, ["episodes/2026/10/16/ep-walk.md"], "add ep-walk");
    const c1 = await getMemoryHeadCommit(dataDir);
    expect(c1).toBeTruthy();
    expect(await listChangedMemoryPathsSince(dataDir, null)).toEqual([
      "episodes/2026/10/16/ep-walk.md",
    ]);
    expect(await listChangedMemoryPathsSince(dataDir, c1)).toEqual([]);

    const ep2 = path.join(dataDir, "memory", "episodes/2026/10/17/ep-tea.md");
    await fs.mkdir(path.dirname(ep2), { recursive: true });
    await fs.writeFile(ep2, "# tea\n", "utf8");
    await commitMemoryPaths(dataDir, ["episodes/2026/10/17/ep-tea.md"], "add ep-tea");

    expect(await listChangedMemoryPathsSince(dataDir, c1)).toEqual([
      "episodes/2026/10/17/ep-tea.md",
    ]);
  });

  test("isSubstantiveReflectPath ignores index.md, rf-*.md and core/state.md", () => {
    expect(isSubstantiveReflectPath("episodes/2026/10/17/ep-talk.md")).toBe(true);
    expect(isSubstantiveReflectPath("threads/stories/myth.md")).toBe(true);
    expect(isSubstantiveReflectPath("favorite/2026-10-17-quote.md")).toBe(true);
    expect(isSubstantiveReflectPath("episodes/2026/10/17/index.md")).toBe(false);
    expect(isSubstantiveReflectPath("episodes/2026/10/index.md")).toBe(false);
    expect(isSubstantiveReflectPath("episodes/2026/10/17/rf-insight.md")).toBe(false);
    expect(isSubstantiveReflectPath("core/state.md")).toBe(false);
    expect(isSundayDay("2026-10-17")).toBe(false);
    expect(isSundayDay("2026-10-18")).toBe(true);
    expect(mostRecentSundayOnOrBefore("2026-10-18")).toBe("2026-10-18");
    expect(mostRecentSundayOnOrBefore("2026-10-20")).toBe("2026-10-18");
    expect(mostRecentSundayOnOrBefore("2026-10-17")).toBe("2026-10-11");
  });

  test("isWeeklyReflectDue catches up when Sunday was deferred, without firing prematurely on week 1", async () => {
    const env = await setupMemoryEnv("2026-10-13T23:40:00+08:00");
    try {
      const events = new EventStore(env.db, env.clock);
      // 首条对话在周一 2026-10-12，周二 10-13 不应误触发周反思
      env.clock.jumpToWallClock(2026, 10, 12, 22, 0, 0);
      events.append({ sessionId: "s1", turnId: "t1", role: "user", kind: "chat", content: "hello" });
      expect(isWeeklyReflectDue(env.db, "2026-10-13", "Asia/Shanghai")).toBe(false);

      // 跨过周日 2026-10-18 后，周二 10-20 应补触发周反思
      expect(isWeeklyReflectDue(env.db, "2026-10-20", "Asia/Shanghai")).toBe(true);

      // 写入 10-20 已检查游标后，周三 10-21 不再重复触发
      env.db
        .query(
          "INSERT INTO task_cursors (task_key, last_event_id, meta_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          "reflect_weekly",
          "abc",
          JSON.stringify({ last_commit: "abc", last_day: "2026-10-20" }),
          env.clock.now(),
        );
      expect(isWeeklyReflectDue(env.db, "2026-10-21", "Asia/Shanghai")).toBe(false);
      // 下一个周日 2026-10-25 到来时再次触发
      expect(isWeeklyReflectDue(env.db, "2026-10-25", "Asia/Shanghai")).toBe(true);
      // 若 10-25 也顺延到周一 10-26，同样补触发
      expect(isWeeklyReflectDue(env.db, "2026-10-26", "Asia/Shanghai")).toBe(true);
    } finally {
      env.db.close();
    }
  });

  test("daily reflect skips with 0 LLM calls when only index.md or core/state.md changed", async () => {
    const env = await setupMemoryEnv("2026-10-17T23:40:00+08:00");
    try {
      // Establish baseline cursor on 2026-10-16
      const initHead = await getMemoryHeadCommit(env.dataDir);
      env.db
        .query(
          "INSERT INTO task_cursors (task_key, last_event_id, meta_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          "reflect_daily",
          initHead ?? "",
          JSON.stringify({ last_commit: initHead, last_day: "2026-10-16" }),
          env.clock.now(),
        );

      // Only touch index.md and core/state.md
      await env.memoryTools.write(
        "episodes/2026/10/17/index.md",
        "---\ntitle: 2026-10-17 日梗概\nkind: note\nstatus: active\ncreated: 2026-10-17\nupdated: 2026-10-17\n---\n平淡的一天。\n",
      );
      await env.memoryTools.write(
        "core/state.md",
        "---\ntitle: 短期状态\nkind: note\nstatus: active\ncreated: 2026-10-17\nupdated: 2026-10-17\n---\n- [至 2026-10-20] 有点感冒\n",
      );
      await commitMemoryPaths(
        env.dataDir,
        ["episodes/2026/10/17/index.md", "core/state.md"],
        "memory(bedtime): index + state",
      );

      let decisionCalls = 0;
      const decisionClient: DecisionClient = {
        async decide() {
          decisionCalls++;
          return { answers: { has_notable_shift: { noul: 0.99 } } };
        },
      };
      const chatModel = new ScriptedChatModel(() => [{ type: "text_delta", delta: "{}" }]);

      const res = await evaluateAndRunReflect(
        {
          db: env.db,
          dataDir: env.dataDir,
          promptsDir: PROMPTS_DIR,
          clock: env.clock,
          memoryIndex: env.memoryIndex,
          memoryTools: env.memoryTools,
          chatModel,
          decisionClient,
          getConfig: () => env.config,
        },
        { scope: "daily", targetDay: "2026-10-17" },
      );

      expect(res.ok).toBe(true);
      expect(res.triggered).toBe(false);
      expect(res.skipReason).toBe("no_substantive_changes");
      expect(decisionCalls).toBe(0);
      expect(chatModel.calls).toBe(0);
    } finally {
      env.db.close();
    }
  });

  test("daily reflect skips when Decision model scores below threshold, triggers when above", async () => {
    const env = await setupMemoryEnv("2026-10-17T23:40:00+08:00");
    try {
      await env.memoryTools.write(
        "episodes/2026/10/17/ep-dinner.md",
        "---\ntitle: 晚饭闲聊\nkind: episode\nstatus: active\ncreated: 2026-10-17\nupdated: 2026-10-17\n---\n聊了晚饭吃了什么，很平淡。\n",
      );
      await commitMemoryPaths(env.dataDir, ["episodes/2026/10/17/ep-dinner.md"], "add ep-dinner");

      const lowDecision: DecisionClient = {
        async decide() {
          return {
            answers: {
              has_notable_shift: { noul: 0.15 },
              touches_open_thread: { noul: 0.12 },
            },
          };
        },
      };
      const chatModel = new ScriptedChatModel((_req, idx) => {
        if (idx === 0) {
          return [
            {
              type: "tool_call",
              id: "tc-1",
              name: "write",
              args: {
                path: "episodes/2026/10/18/rf-boundary.md",
                content:
                  "---\ntitle: 关于节奏的反思\nkind: reflection\nstatus: active\ncreated: 2026-10-18\nupdated: 2026-10-18\n---\n今天重新想了想聊天节奏。\n",
              },
            },
          ];
        }
        return [{ type: "text_delta", delta: '{"summary": "沉淀聊天节奏反思"}' }];
      });

      const skipped = await evaluateAndRunReflect(
        {
          db: env.db,
          dataDir: env.dataDir,
          promptsDir: PROMPTS_DIR,
          clock: env.clock,
          memoryIndex: env.memoryIndex,
          memoryTools: env.memoryTools,
          chatModel,
          decisionClient: lowDecision,
          getConfig: () => env.config,
        },
        { scope: "daily", targetDay: "2026-10-17" },
      );

      expect(skipped.ok).toBe(true);
      expect(skipped.triggered).toBe(false);
      expect(skipped.skipReason).toBe("decision_below_threshold");
      expect(chatModel.calls).toBe(0);

      // Next day (Sunday 2026-10-18): add a meaningful episode and trigger daily + skip weekly
      env.clock.jumpToWallClock(2026, 10, 18, 23, 40, 0);
      await env.memoryTools.write(
        "episodes/2026/10/18/ep-heart-to-heart.md",
        "---\ntitle: 深夜深聊\nkind: episode\nstatus: active\ncreated: 2026-10-18\nupdated: 2026-10-18\n---\n她认真说希望我不要在深夜催她早睡，我意识到这触碰了边界。\n",
      );
      await commitMemoryPaths(
        env.dataDir,
        ["episodes/2026/10/18/ep-heart-to-heart.md"],
        "add ep-heart-to-heart",
      );

      const seenQuestions: string[][] = [];
      const mixedDecision: DecisionClient = {
        async decide(req: DecisionRequest): Promise<DecisionResponse> {
          seenQuestions.push(Object.keys(req.questions));
          if ("has_notable_shift" in req.questions) {
            return {
              answers: {
                has_notable_shift: { noul: 0.88 },
                touches_open_thread: { noul: 0.71 },
              },
            };
          }
          // Weekly check: everything already absorbed by today's daily reflection!
          expect(req.input).toContain("rf-boundary.md");
          return {
            answers: {
              has_unabsorbed_changes: { noul: 0.18 },
              has_cross_day_pattern: { noul: 0.22 },
            },
          };
        },
      };

      const sundayRes = await maybeRunReflectAfterBedtime(
        {
          db: env.db,
          dataDir: env.dataDir,
          promptsDir: PROMPTS_DIR,
          clock: env.clock,
          memoryIndex: env.memoryIndex,
          memoryTools: env.memoryTools,
          chatModel,
          decisionClient: mixedDecision,
          getConfig: () => env.config,
        },
        { targetDay: "2026-10-18" },
      );

      expect(sundayRes.daily.ok).toBe(true);
      expect(sundayRes.daily.triggered).toBe(true);
      expect(sundayRes.daily.committed).toBe(true);
      expect(sundayRes.daily.touchedMemoryPaths).toEqual(["episodes/2026/10/18/rf-boundary.md"]);

      expect(sundayRes.weekly).not.toBeNull();
      expect(sundayRes.weekly!.ok).toBe(true);
      expect(sundayRes.weekly!.triggered).toBe(false);
      expect(sundayRes.weekly!.skipReason).toBe("decision_below_threshold");
      expect(seenQuestions).toEqual([
        ["has_notable_shift", "touches_open_thread"],
        ["has_unabsorbed_changes", "has_cross_day_pattern"],
      ]);
    } finally {
      env.db.close();
    }
  });

  test("reflect rolls back written files on output truncation", async () => {
    const env = await setupMemoryEnv("2026-10-17T23:40:00+08:00");
    try {
      await env.memoryTools.write(
        "episodes/2026/10/17/ep-important.md",
        "---\ntitle: 重要对话\nkind: episode\nstatus: active\ncreated: 2026-10-17\nupdated: 2026-10-17\n---\n重要转折。\n",
      );
      await commitMemoryPaths(env.dataDir, ["episodes/2026/10/17/ep-important.md"], "add ep");

      const truncModel = new ScriptedChatModel((_req, idx) => {
        if (idx === 0) {
          return [
            {
              type: "tool_call",
              id: "tc-1",
              name: "write",
              args: {
                path: "episodes/2026/10/17/rf-half.md",
                content: "---\ntitle: 半截反思\nkind: reflection\nstatus: active\n---\n写到一半",
              },
            },
          ];
        }
        return [
          {
            type: "usage",
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            stopReason: "length",
          },
        ];
      });

      const res = await evaluateAndRunReflect(
        {
          db: env.db,
          dataDir: env.dataDir,
          promptsDir: PROMPTS_DIR,
          clock: env.clock,
          memoryIndex: env.memoryIndex,
          memoryTools: env.memoryTools,
          chatModel: truncModel,
          getConfig: () => env.config,
        },
        { scope: "daily", targetDay: "2026-10-17" },
      );

      expect(res.ok).toBe(false);
      expect(res.error).toContain("OUTPUT_TRUNCATED");
      const exists = await fs
        .access(path.join(env.dataDir, "memory", "episodes/2026/10/17/rf-half.md"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    } finally {
      env.db.close();
    }
  });

  test("bedtime 合并日反思：过门控时同轮写入 rf-*.md 与 index.md 并推进日反思游标，后续不再重复跑日反思", async () => {
    const env = await setupMemoryEnv("2026-10-17T23:40:00+08:00");
    try {
      const events = new EventStore(env.db, env.clock);
      events.append({
        sessionId: "s-merged",
        turnId: "t-merged",
        role: "user",
        kind: "chat",
        content: "今天认真聊了彼此相处的边界，很有触动。",
      });

      const highDecision: DecisionClient = {
        async decide() {
          return {
            answers: {
              has_notable_shift: { noul: 0.91 },
              touches_open_thread: { noul: 0.72 },
            },
          };
        },
      };

      let sawReflectGuideInBedtime = false;
      const chatModel = new ScriptedChatModel((req, idx) => {
        if (idx === 0) {
          return [
            {
              type: "tool_call",
              id: "tc-ep",
              name: "write",
              args: {
                path: "episodes/2026/10/17/ep-boundary-chat.md",
                content:
                  "---\ntitle: 10-17 边界深聊\nkind: episode\nstatus: active\ncreated: 2026-10-17\nupdated: 2026-10-17\n---\n认真聊了相处边界。\n",
              },
            },
          ];
        }
        if (idx === 1) {
          return [{ type: "text_delta", delta: '{"summary": "归档边界深聊"}' }];
        }
        if (idx === 2) {
          const lastMsg = req.messages[req.messages.length - 1];
          const userContent = String(lastMsg?.role === "user" ? lastMsg.content : "");
          sawReflectGuideInBedtime =
            req.messages.length > 1 &&
            userContent.includes("<bedtime_phase>") &&
            userContent.includes("<daily_reflect_guide>") &&
            userContent.includes("<reflect_context>");
          return [
            {
              type: "tool_call",
              id: "tc-rf",
              name: "write",
              args: {
                path: "episodes/2026/10/17/rf-boundary-shift.md",
                content:
                  "---\ntitle: 10-17 反思·边界共识\nkind: reflection\nstatus: active\ncreated: 2026-10-17\nupdated: 2026-10-17\n---\n今天对相处边界有了更清晰的理解。\n",
              },
            },
            {
              type: "tool_call",
              id: "tc-idx",
              name: "write",
              args: {
                path: "episodes/2026/10/17/index.md",
                content:
                  "---\ntitle: 2026-10-17 日梗概\nkind: note\nstatus: active\ncreated: 2026-10-17\nupdated: 2026-10-17\n---\n认真聊了相处边界（[[10-17 边界深聊]]）。\n",
              },
            },
          ];
        }
        return [{ type: "text_delta", delta: '{"summary": "完成日梗概与边界反思"}' }];
      });

      const res = await runMemoryTidyTask(
        {
          db: env.db,
          dataDir: env.dataDir,
          promptsDir: PROMPTS_DIR,
          clock: env.clock,
          events,
          memoryIndex: env.memoryIndex,
          memoryTools: env.memoryTools,
          chatModel,
          decisionClient: highDecision,
          getConfig: () => env.config,
          retryDelaysMs: [],
        },
        { taskType: "bedtime", nightDate: "2026-10-17" },
      );

      expect(res.ok).toBe(true);
      expect(sawReflectGuideInBedtime).toBe(true);
      expect(res.dailyReflect?.triggered).toBe(true);
      expect(res.touchedMemoryPaths).toContain("episodes/2026/10/17/rf-boundary-shift.md");
      expect(res.touchedMemoryPaths).toContain("episodes/2026/10/17/index.md");

      const callsBefore = chatModel.calls;
      const afterRes = await maybeRunReflectAfterBedtime(
        {
          db: env.db,
          dataDir: env.dataDir,
          promptsDir: PROMPTS_DIR,
          clock: env.clock,
          memoryIndex: env.memoryIndex,
          memoryTools: env.memoryTools,
          chatModel,
          decisionClient: highDecision,
          getConfig: () => env.config,
        },
        { targetDay: "2026-10-17" },
      );
      expect(afterRes.daily.triggered).toBe(false);
      expect(afterRes.daily.skipReason).toBe("already_checked_today");
      expect(chatModel.calls).toBe(callsBefore);
    } finally {
      env.db.close();
    }
  });
});

describe("GeminiDecisionClient, DynamicDecisionClient & router decision slot", () => {
  test("GeminiDecisionClient calls POST /v1beta/decisions with x-goog-api-key and parses noul/choice", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          answers: {
            need_reflect: { noul: 0.82, confidence: 0.91 },
            scope: {
              choice: "weekly",
              confidence: 0.77,
              probabilities: { daily: 0.2, weekly: 0.8 },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new GeminiDecisionClient({
      apiKey: "test-google-key",
      modelId: "gemini-decision-1",
      fetchImpl: mockFetch,
    });

    const res = await client.decide({
      input: "Today we discussed boundaries.",
      questions: {
        need_reflect: { type: "noul", instructions: "Should we reflect?" },
        scope: {
          type: "choice",
          instructions: "Which scope?",
          criteria: { daily: "Single day", weekly: "Cross-day" },
        },
      },
    });

    expect(isGeminiDecisionModel("gemini-decision-1")).toBe(true);
    expect(isGeminiDecisionModel("gemini-2.5-flash")).toBe(false);
    expect(capturedUrl).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(capturedHeaders["x-goog-api-key"]).toBe("test-google-key");
    expect(capturedBody.model).toBe("gemini-decision-1");
    expect(res.backend).toBe("gemini-decisions:gemini-decision-1");
    expect(res.answers.need_reflect?.noul).toBeCloseTo(0.82, 4);
    expect(res.answers.need_reflect?.confidence).toBeCloseTo(0.91, 4);
    expect(res.answers.scope?.choice).toBe("weekly");
  });

  test("DynamicDecisionClient routes google/gemini-decision-1 natively and falls back when unset", async () => {
    const dataDir = await makeTempDir("psyber-decision-slot-");
    await initDataDir(dataDir);
    const config = await loadOrCreateConfig(dataDir, Date.now());
    config.llm = {
      providers: {
        google: { kind: "google", authMode: "api_key" },
        openai: { kind: "openai", authMode: "api_key" },
      },
      slots: {
        chat: { provider: "openai", model: "gpt-4o-mini" },
        decision: { provider: "google", model: "gemini-decision-1" },
      },
      thinking: { enabled: false },
    };
    await saveConfig(dataDir, config);
    await saveCredentials(dataDir, {
      apiKeys: { google: "g-key", openai: "o-key" },
      channelTokens: {},
    });

    // 1. Native gemini-decision-1 path
    let hitNativeUrl = "";
    const mockFetch = (async (input: RequestInfo | URL) => {
      hitNativeUrl = String(input);
      return new Response(
        JSON.stringify({ answers: { q1: { noul: 0.74, confidence: 0.85 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const dynamic = new DynamicDecisionClient({
      dataDir,
      getConfig: () => config,
      fetchImpl: mockFetch,
      chatClientFactory: () =>
        new ScriptedChatModel(() => [
          { type: "text_delta", delta: '{"answers": {"q1": {"noul": 0.33}}}' },
        ]),
    });

    const nativeRes = await dynamic.decide({
      input: "sample",
      questions: { q1: { type: "noul", instructions: "yes?" } },
    });
    expect(hitNativeUrl).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(nativeRes.backend).toBe("gemini-decisions:gemini-decision-1");
    expect(nativeRes.answers.q1?.noul).toBeCloseTo(0.74, 4);

    // 2. Fallback to chat slot when slots.decision is removed
    delete config.llm.slots.decision;
    const fallbackRes = await dynamic.decide({
      input: "sample",
      questions: { q1: { type: "noul", instructions: "yes?" } },
    });
    expect(fallbackRes.backend).toBe("llm-fallback:openai/gpt-4o-mini");
    expect(fallbackRes.answers.q1?.noul).toBeCloseTo(0.33, 4);

    // 3. Router discovery (live /models + pi-ai + gemini-decision-1) & connection test
    const creds = { apiKeys: { google: "g-key", openai: "o-key" }, channelTokens: {} };
    let hitLiveModelsUrl = "";
    const liveModelsFetch = (async (input: RequestInfo | URL) => {
      hitLiveModelsUrl = String(input);
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-3.8-flash",
              displayName: "Gemini 3.8 Flash",
              inputTokenLimit: 1_048_576,
              outputTokenLimit: 65_536,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const discovered = await discoverProviderModels(config, creds, "google", liveModelsFetch);
    expect(hitLiveModelsUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    );
    expect(discovered.some((m) => m.id === "gemini-3.8-flash")).toBe(true);
    expect(discovered.some((m) => m.id === "gemini-decision-1")).toBe(true);

    const connRes = await testModelConnection({
      config,
      creds,
      providerId: "google",
      modelId: "gemini-decision-1",
      fetchImpl: mockFetch,
    });
    expect(connRes.ok).toBe(true);

    // 4. resolveByokSlot fallback order: decision -> digest -> memory_task -> chat
    const slotRes = resolveByokSlot(config, creds, "decision");
    expect(slotRes.ok).toBe(true);
    if (slotRes.ok) {
      expect(slotRes.slot.modelId).toBe("gpt-4o-mini");
    }
  });
});
