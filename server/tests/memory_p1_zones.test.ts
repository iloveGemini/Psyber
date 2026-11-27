import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createApp, hashBearerToken } from "../src/api/app.ts";
import { localDay } from "../src/core/clock.ts";
import { mergeRecallConfig } from "../src/core/config.ts";
import type { DecisionClient, DecisionRequest, DecisionResponse } from "../src/core/decision.ts";
import type { EmbeddingClient } from "../src/core/embedding.ts";
import { commitMemoryPaths } from "../src/core/git.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";
import { findUpcomingCoreDates, parseCoreDates, renderUpcomingDatesBlock } from "../src/memory/dates.ts";
import { isEligibleRadarRow } from "../src/memory/radar.ts";
import { recallMemories } from "../src/memory/recall.ts";
import { MemoryTools } from "../src/memory/tools.ts";
import { registerCoreTier1Tools } from "../src/tools/core_tools.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createTestContext } from "./helpers.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

describe("P1 · core/dates.md 周期重要日子与忌日动态筛选", () => {
  test("解析多种类型、计算跨年与周年、处理 02-29 平年折算与一次性 deadline", () => {
    const md = [
      "---",
      "title: 重要日子",
      "kind: note",
      "---",
      "",
      "- [11-27 | gentle] 外婆忌日（[[外婆]]）",
      "- [2024-11-30 | milestone] 定名纪念日",
      "- [12-03 | celebrate] 朋友生日",
      "- [01-02 | 喜庆] 新年约定",
      "- [02-29 | celebrate] 闰日纪念",
      "- [2026-11-29 | deadline] 提交材料截止",
      "- [2025-11-29 | deadline] 去年旧截止日（不应循环）",
      "- [08-15] 普通日子",
    ].join("\n");

    const parsed = parseCoreDates(md);
    expect(parsed.length).toBe(8);

    // 2026-11-27 往后 7 天：命中 11-27 忌日、11-29 今年 deadline（不含去年）、11-30 第 2 周年、12-03 生日
    const matches = findUpcomingCoreDates(md, "2026-11-27", 7);
    expect(matches.map((m) => m.entry.text)).toEqual([
      "外婆忌日（[[外婆]]）",
      "提交材料截止",
      "定名纪念日",
      "朋友生日",
    ]);
    expect(matches[0]!.daysUntil).toBe(0);
    expect(matches[0]!.entry.kind).toBe("gentle");
    expect(matches[2]!.anniversaryYears).toBe(2);

    const rendered = renderUpcomingDatesBlock(md, "2026-11-27", 7);
    expect(rendered).not.toBeNull();
    expect(rendered).toContain("今天 2026-11-27 · 敏感忌日·轻声对待，勿自动欢庆");
    expect(rendered).toContain("定名纪念日（第 2 周年）");
    expect(rendered).not.toContain("去年旧截止日");
    expect(rendered).not.toContain("普通日子");

    // 跨年窗口：2026-12-28 往后 7 天命中次年 01-02
    const crossYear = findUpcomingCoreDates(md, "2026-12-28", 7);
    expect(crossYear.length).toBe(1);
    expect(crossYear[0]!.occurrenceDay).toBe("2027-01-02");
    expect(crossYear[0]!.daysUntil).toBe(5);

    // 平年 02-29 折算为 02-28
    const nonLeap = findUpcomingCoreDates(md, "2026-02-25", 5);
    expect(nonLeap.length).toBe(1);
    expect(nonLeap[0]!.occurrenceDay).toBe("2026-02-28");
    expect(nonLeap[0]!.daysUntil).toBe(3);

    // 无命中返回 null
    expect(renderUpcomingDatesBlock(md, "2026-06-01", 7)).toBeNull();
  });

  test("DirectEngine 常驻注入 core/glossary.md，动态注入 7 天内 <upcoming_dates>（不把全年 dates 塞进 Static Prefix）", async () => {
    const ctx = await createTestContext();
    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);
    const seenSystemPrompts: string[] = [];
    const seenUserMessages: string[] = [];

    const mockChat: ChatModelClient = {
      contextWindow: 128_000,
      modelId: "mock-chat",
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        seenSystemPrompts.push(req.systemPrompt);
        const last = req.messages[req.messages.length - 1];
        seenUserMessages.push(typeof last?.content === "string" ? last.content : "");
        yield { type: "text_delta", delta: "收到。" };
        yield { type: "usage", inputTokens: 80, outputTokens: 10, totalTokens: 90 };
      },
    };

    const registry = new ToolRegistry();
    registerCoreTier1Tools(registry, {
      memoryTools,
      events: ctx.events,
      clock: ctx.clock,
      getConfig: () => ctx.config,
      saveConfig: async () => {},
    });
    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      db: ctx.db,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel: mockChat,
      clock: ctx.clock,
      getConfig: () => ctx.config,
      retryDelaysMs: [],
    });

    try {
      const today = localDay(ctx.clock.now(), ctx.clock.timeZone);
      const wGlossary = await memoryTools.write(
        "core/glossary.md",
        "---\ntitle: 专属暗语\nkind: note\n---\n\n- 喂鳄鱼 = 开冗长的跨部门周会\n",
      );
      expect(wGlossary.ok).toBe(true);

      const wDates = await memoryTools.write(
        "core/dates.md",
        [
          "---",
          "title: 重要日子",
          "kind: note",
          "---",
          "",
          `- [${today} | gentle] 纪念一位离世的长辈`,
          "- [03-15 | celebrate] 遥远的春季纪念日",
        ].join("\n"),
      );
      expect(wDates.ok).toBe(true);

      await engine.runTurn({ mode: "chat", userText: "今天又去喂鳄鱼了" });
      expect(seenSystemPrompts.length).toBe(1);
      expect(seenSystemPrompts[0]).toContain("喂鳄鱼 = 开冗长的跨部门周会");
      // core/dates.md 不全文常驻在 Static Prefix
      expect(seenSystemPrompts[0]).not.toContain("遥远的春季纪念日");
      // 7 天内命中的日期在 Dynamic Tail <upcoming_dates> 动态注入
      expect(seenUserMessages[0]).toContain("<upcoming_dates");
      expect(seenUserMessages[0]).toContain("敏感忌日·轻声对待，勿自动欢庆");
      expect(seenUserMessages[0]).not.toContain("遥远的春季纪念日");
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("P1 · memory/sensitive/ 高敏隔离区（外部向量/雷达/1跳/MCP 全面隔离与高门槛召回）", () => {
  test("默认绝不外发 sensitive/ 正文到 Embedding API、严禁 1 跳带出、执行更高精排门槛并排除快脑雷达", async () => {
    const ctx = await createTestContext();
    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);

    try {
      const wSens = await memoryTools.write(
        "sensitive/health-allergy.md",
        [
          "---",
          "title: 健康·花粉过敏",
          "kind: note",
          "status: active",
          "when_to_recall: 聊到花粉、春季打喷嚏或过敏吃药时",
          "created: 2026-10-10",
          "updated: 2026-10-10",
          "---",
          "",
          "对方对春季柏树花粉严重过敏，需要常备氯雷他定。",
        ].join("\n"),
      );
      expect(wSens.ok).toBe(true);

      const wEp = await memoryTools.write(
        "episodes/2026/10/11/ep-park-walk.md",
        [
          "---",
          "title: 10-11 公园散步",
          "kind: episode",
          "status: active",
          "created: 2026-10-11",
          "updated: 2026-10-11",
          "---",
          "",
          "周末去公园散步看了湖景，聊到春天要注意身体（见 [[健康·花粉过敏]]）。",
        ].join("\n"),
      );
      expect(wEp.ok).toBe(true);

      const sensRow = ctx.index.getRow("sensitive/health-allergy.md");
      expect(sensRow?.space).toBe("sensitive");
      // 快脑体检雷达必须排除 sensitive/
      expect(isEligibleRadarRow(sensRow!, ctx.clock.now())).toBe(false);

      // 捕获送给外部 Embedding 的卡片文档文本（embedBatch 仅用于卡片正文）
      const embeddedDocTexts: string[] = [];
      const mockEmbedding: EmbeddingClient = {
        modelKey: "mock-embed:v1",
        async embed(): Promise<Float32Array> {
          return new Float32Array([1, 0, 0, 0]);
        },
        async embedBatch(texts: string[]): Promise<Float32Array[]> {
          embeddedDocTexts.push(...texts);
          return texts.map(() => new Float32Array([1, 0, 0, 0]));
        },
      };

      // Case A: 普通卡 0.40 过 0.30 门槛；高敏卡 0.40 未达 0.55 高门槛被拦；且 1 跳绝不从 ep-park-walk 顺藤摸瓜带出 sensitive/
      const decisionModerate: DecisionClient = {
        async decide(req: DecisionRequest): Promise<DecisionResponse> {
          const answers: DecisionResponse["answers"] = {};
          for (const key of Object.keys(req.questions)) {
            if (key === "needs_memory") {
              answers[key] = { noul: 0.9 };
            } else if (key === "evidence_sufficient") {
              answers[key] = { noul: 0.1 }; // 故意允许尝试 1 跳
            } else {
              answers[key] = { noul: 0.42 }; // > 0.30 普通门槛，但 < 0.55 高敏门槛
            }
          }
          return { answers };
        },
      };

      const resA = await recallMemories({
        db: ctx.db,
        dataDir: ctx.dataDir,
        index: ctx.index,
        clock: ctx.clock,
        sessionId: "s-1",
        turnId: "t-1",
        query: "公园散步花粉过敏",
        embedding: mockEmbedding,
        decisionClient: decisionModerate,
        promptsDir: PROMPTS_DIR,
        recallConfig: mergeRecallConfig(),
      });

      // 绝不把 sensitive/ 卡片正文送去外部 Embedding（普通卡 ep-park-walk 会被送去算向量）
      expect(embeddedDocTexts.length).toBeGreaterThan(0);
      expect(embeddedDocTexts.some((t) => t.includes("氯雷他定"))).toBe(false);
      // ep-park-walk 命中，但 sensitive/ 既没过 0.55 高门槛、也没被 1 跳双链带出
      expect(resA.items.some((i) => i.path === "episodes/2026/10/11/ep-park-walk.md")).toBe(true);
      expect(resA.items.some((i) => i.path === "sensitive/health-allergy.md")).toBe(false);

      // Case B: 当话题直接强命中（Decision 给 0.78 >= 0.55），通过本地 FTS5 强命中 + 高门槛精排安全浮现并带客观轻声标记
      const decisionStrong: DecisionClient = {
        async decide(req: DecisionRequest): Promise<DecisionResponse> {
          const answers: DecisionResponse["answers"] = {};
          for (const key of Object.keys(req.questions)) {
            answers[key] = { noul: key === "needs_memory" ? 0.95 : 0.78 };
          }
          return { answers };
        },
      };
      const resB = await recallMemories({
        db: ctx.db,
        dataDir: ctx.dataDir,
        index: ctx.index,
        clock: ctx.clock,
        sessionId: "s-2",
        turnId: "t-2",
        query: "春天柏树花粉过敏吃氯雷他定",
        embedding: mockEmbedding,
        decisionClient: decisionStrong,
        promptsDir: PROMPTS_DIR,
        recallConfig: mergeRecallConfig(),
      });
      expect(resB.items.some((i) => i.path === "sensitive/health-allergy.md")).toBe(true);
      expect(resB.renderedBlock).toContain("[敏感记录·按需轻声对待]");
      expect(embeddedDocTexts.some((t) => t.includes("氯雷他定"))).toBe(false);

      // Case C: 开启 hybridFtsWithEmbedding=true 时，小语料库（<10 张卡）高敏卡依然能进候选池并过 0.55 门槛
      const resHybrid = await recallMemories({
        db: ctx.db,
        dataDir: ctx.dataDir,
        index: ctx.index,
        clock: ctx.clock,
        sessionId: "s-3",
        turnId: "t-3",
        query: "春天柏树花粉过敏吃氯雷他定",
        embedding: mockEmbedding,
        decisionClient: decisionStrong,
        promptsDir: PROMPTS_DIR,
        recallConfig: mergeRecallConfig(undefined, { hybridFtsWithEmbedding: true }),
      });
      expect(resHybrid.items.some((i) => i.path === "sensitive/health-allergy.md")).toBe(true);

      // Case D: 未配置 Embedding 走全卡直扫（runCatalogScan）时，无关闲聊绝不把未命中高敏卡标题/触发词外发给云端 decisionClient
      const catalogInputs: string[] = [];
      const decisionSpy: DecisionClient = {
        async decide(req: DecisionRequest): Promise<DecisionResponse> {
          catalogInputs.push(req.input);
          const answers: DecisionResponse["answers"] = { needs_memory: { noul: 0.9 } };
          for (const key of Object.keys(req.questions)) {
            if (key !== "needs_memory") answers[key] = { noul: 0.1 };
          }
          return { answers };
        },
      };
      await recallMemories({
        db: ctx.db,
        dataDir: ctx.dataDir,
        index: ctx.index,
        clock: ctx.clock,
        sessionId: "s-4",
        turnId: "t-4",
        query: "公园散步湖景不错",
        decisionClient: decisionSpy,
        promptsDir: PROMPTS_DIR,
        recallConfig: mergeRecallConfig(),
      });
      expect(catalogInputs.length).toBe(1);
      expect(catalogInputs[0]).toContain("10-11 公园散步");
      expect(catalogInputs[0]).not.toContain("健康·花粉过敏");
      expect(catalogInputs[0]).not.toContain("过敏吃药");
    } finally {
      await ctx.cleanup();
    }
  });

  test("对外 memory_mcp 全工具硬屏蔽 sensitive/，同时 memory_context 透出 glossary 与近期 dates；settings 校验 recall.sensitive", async () => {
    const ctx = await createTestContext();
    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);
    const devToken = "dev-tok-p1";
    const mcpToken = "mcp-tok-p1";

    ctx.config.auth.devices.push({
      deviceId: "dev-p1",
      deviceName: "mac",
      platform: "macos",
      tokenHash: hashBearerToken(devToken),
      createdAt: ctx.clock.now(),
      lastSeenAt: ctx.clock.now(),
    });
    ctx.config.memoryMcp = {
      enabled: true,
      accessMode: "read_write",
      allowRemote: false,
      protectCoreFiles: true,
      maxOutputChars: 16_000,
      disabledTools: [],
      replayToolsEnabled: false,
      tokens: [
        {
          id: "tok-p1",
          name: "external-agent",
          tokenHash: hashBearerToken(mcpToken),
          accessMode: "read_write",
          createdAt: ctx.clock.now(),
        },
      ],
    };

    try {
      await memoryTools.write(
        "sensitive/trauma-private.md",
        "---\ntitle: 创伤·私密往事\nkind: note\nwhen_to_recall: 聊到某件私密往事\n---\n\n这是一段绝不该暴露给外部编程工具的绝密私事XYZ999。\n",
      );
      await memoryTools.write(
        "episodes/2026/10/12/ep-normal.md",
        "---\ntitle: 10-12 聊项目\nkind: episode\n---\n\n今天聊了项目进展，也略提了一句 [[创伤·私密往事]]。\n",
      );
      await memoryTools.write(
        "core/glossary.md",
        "---\ntitle: 专属暗语\n---\n\n- 掉线充电 = 戴上耳机放空半小时\n",
      );
      const todayStr = localDay(ctx.clock.now(), ctx.clock.timeZone);
      await memoryTools.write(
        "core/dates.md",
        `---\ntitle: 重要日子\n---\n\n- [${todayStr} | celebrate] 纪念日测试\n`,
      );
      await commitMemoryPaths(
        ctx.dataDir,
        [
          "sensitive/trauma-private.md",
          "episodes/2026/10/12/ep-normal.md",
          "core/glossary.md",
          "core/dates.md",
        ],
        "p1 test commit",
      );

      const app = createApp({
        version: "0.1.0-test",
        dataDir: ctx.dataDir,
        db: ctx.db,
        events: ctx.events,
        memoryIndex: ctx.index,
        memoryTools,
        clock: ctx.clock,
        getConfig: () => ctx.config,
        getActiveSessionId: () => "sess-p1",
        getClientIp: () => "127.0.0.1",
      });

      // 初始化 MCP 会话
      const initRes = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      });
      expect(initRes.status).toBe(200);
      const sid = initRes.headers.get("mcp-session-id") ?? "";

      const callMcp = async (id: number, name: string, args: Record<string, unknown>) => {
        const res = await app.request("/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${mcpToken}`,
            "mcp-session-id": sid,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        expect(res.status).toBe(200);
        return (await res.json()) as {
          result: { content: Array<{ text: string }>; isError?: boolean };
        };
      };

      // 1) memory_context 含 glossary + 7 天内 dates，不含 sensitive
      const ctxRes = await callMcp(2, "memory_context", { include_continuity: false });
      const ctxText = ctxRes.result.content[0]!.text;
      expect(ctxText).toContain("掉线充电 = 戴上耳机放空半小时");
      expect(ctxText).toContain("纪念日测试");
      expect(ctxText).not.toContain("XYZ999");

      // 2) memory_search 搜私密词与普通词（含 1 跳邻居）均绝不泄 sensitive/
      const searchSens = await callMcp(3, "memory_search", { query: "绝密私事XYZ999", include_links: true });
      expect(searchSens.result.content[0]!.text).toContain("未检索到");
      expect(searchSens.result.content[0]!.text).not.toContain("trauma-private");
      const searchNorm = await callMcp(4, "memory_search", { query: "聊项目", include_links: true });
      expect(searchNorm.result.content[0]!.text).toContain("ep-normal.md");
      expect(searchNorm.result.content[0]!.text).not.toContain("trauma-private");

      // 3) memory_glob / memory_grep / memory_read（路径与双链）/ memory_write / memory_history 全面硬屏蔽
      const globAll = await callMcp(5, "memory_glob", { pattern: "**/*.md" });
      expect(globAll.result.content[0]!.text).not.toContain("sensitive/");
      const globDirect = await callMcp(6, "memory_glob", { pattern: "sensitive/*.md" });
      expect(globDirect.result.isError).toBe(true);

      const grepAll = await callMcp(7, "memory_grep", { pattern: "XYZ999" });
      expect(grepAll.result.content[0]!.text).toContain("未找到");
      expect(grepAll.result.content[0]!.text).not.toContain("trauma-private");

      const readPath = await callMcp(8, "memory_read", { path: "sensitive/trauma-private.md" });
      expect(readPath.result.isError).toBe(true);
      // 回归：macOS 大小写不敏感路径与多级 ././ 前缀绕过均必须拦截
      const readUpper = await callMcp(81, "memory_read", { path: "Sensitive/trauma-private.md" });
      expect(readUpper.result.isError).toBe(true);
      expect(readUpper.result.content[0]!.text).not.toContain("XYZ999");
      const readDotDot = await callMcp(82, "memory_read", {
        path: "././sensitive/trauma-private.md",
      });
      expect(readDotDot.result.isError).toBe(true);
      expect(readDotDot.result.content[0]!.text).not.toContain("XYZ999");
      const globUpper = await callMcp(83, "memory_glob", { pattern: "Sensitive/*.md" });
      expect(globUpper.result.isError).toBe(true);
      const grepUpper = await callMcp(84, "memory_grep", {
        pattern: "XYZ999",
        path: "././Sensitive",
      });
      expect(grepUpper.result.isError).toBe(true);
      const histUpper = await callMcp(85, "memory_history", {
        action: "log",
        path: "Sensitive/trauma-private.md",
      });
      expect(histUpper.result.isError).toBe(true);

      const readWiki = await callMcp(9, "memory_read", { path: "[[创伤·私密往事]]" });
      expect(readWiki.result.isError).toBe(true);
      expect(readWiki.result.content[0]!.text).not.toContain("XYZ999");

      const writeSens = await callMcp(10, "memory_write", {
        path: "sensitive/injected.md",
        content: "hi",
      });
      expect(writeSens.result.isError).toBe(true);

      const histShow = await callMcp(11, "memory_history", { action: "show", commit: "HEAD" });
      expect(histShow.result.content[0]!.text).toContain("ep-normal.md");
      expect(histShow.result.content[0]!.text).not.toContain("XYZ999");
      expect(histShow.result.content[0]!.text).not.toContain("trauma-private");
      const histDirect = await callMcp(12, "memory_history", {
        action: "log",
        path: "sensitive/trauma-private.md",
      });
      expect(histDirect.result.isError).toBe(true);

      // 4) PATCH /api/v1/settings 校验 recall.sensitive
      const badSettings = await app.request("/api/v1/settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${devToken}`,
        },
        body: JSON.stringify({ recall: { sensitive: { rerankThreshold: 1.5 } } }),
      });
      expect(badSettings.status).toBe(400);

      const okSettings = await app.request("/api/v1/settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${devToken}`,
        },
        body: JSON.stringify({
          recall: { sensitive: { allowExternalEmbedding: true, rerankThreshold: 0.6 } },
        }),
      });
      expect(okSettings.status).toBe(200);
      expect(ctx.config.recall?.sensitive?.allowExternalEmbedding).toBe(true);
      expect(ctx.config.recall?.sensitive?.rerankThreshold).toBe(0.6);
      expect(ctx.config.recall?.sensitive?.ftsMinScore).toBe(0.45);

      // 5) 回归：memory_replay 搬家步骤内，protectCoreFiles=true 放行 core/dates.md 与 core/glossary.md，仍拦截 core/self.md
      ctx.config.memoryMcp!.replayToolsEnabled = true;
      ctx.events.append({
        sessionId: "replay-sess",
        role: "user",
        kind: "chat",
        content: "以后把开冗长周会叫做喂鳄鱼，另外每年10月15日记得是纪念日。",
      });
      ctx.events.append({
        sessionId: "replay-sess",
        role: "assistant",
        kind: "chat",
        content: "好呀，记住了！",
      });
      const replayApp = createApp({
        version: "0.1.0-test",
        dataDir: ctx.dataDir,
        db: ctx.db,
        promptsDir: PROMPTS_DIR,
        events: ctx.events,
        memoryIndex: ctx.index,
        memoryTools,
        clock: ctx.clock,
        getConfig: () => ctx.config,
        getActiveSessionId: () => "sess-p1",
        getClientIp: () => "127.0.0.1",
      });
      const rInit = await replayApp.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 100,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "replay", version: "1.0.0" },
          },
        }),
      });
      const rSid = rInit.headers.get("mcp-session-id") ?? "";
      const callReplayMcp = async (id: number, name: string, args: Record<string, unknown>) => {
        const res = await replayApp.request("/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${mcpToken}`,
            "mcp-session-id": rSid,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        expect(res.status).toBe(200);
        return (await res.json()) as {
          result: { content: Array<{ text: string }>; isError?: boolean };
        };
      };
      const startRes = await callReplayMcp(101, "memory_replay", { action: "start" });
      expect(startRes.result.isError).toBeFalsy();
      const writeDates = await callReplayMcp(102, "memory_write", {
        path: "core/dates.md",
        content: "---\ntitle: 重要日子\n---\n\n- [10-15 | celebrate] 搬家测试纪念日\n",
      });
      expect(writeDates.result.isError).toBeFalsy();
      const writeGlossary = await callReplayMcp(103, "memory_write", {
        path: "core/glossary.md",
        content: "---\ntitle: 专属暗语\n---\n\n- 喂鳄鱼 = 开冗长周会\n",
      });
      expect(writeGlossary.result.isError).toBeFalsy();
      const writeSelf = await callReplayMcp(104, "memory_edit", {
        path: "core/self.md",
        old_string: "林栖",
        new_string: "改名",
      });
      expect(writeSelf.result.isError).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });
});
