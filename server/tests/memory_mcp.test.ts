import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "bun:test";
import { runStdioBridge } from "../scripts/mcp_stdio.ts";
import { createApp } from "../src/api/app.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { loadOrCreateConfig, mergeMemoryMcpConfig, saveConfig } from "../src/core/config.ts";
import type { EmbeddingClient } from "../src/core/embedding.ts";
import { AsyncMutex } from "../src/core/mutex.ts";
import { bootPsyberRuntime, type PsyberRuntime } from "../src/index.ts";
import { createTestContext, type TestContext } from "./helpers.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

let ctx: TestContext | null = null;
let runtime: PsyberRuntime | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  if (runtime) {
    await runtime.stop({ waitTimeoutMs: 2_000 });
    runtime = null;
  }
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `psyber-mcp-test-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

function mcpRpc(
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

describe("对外记忆 MCP 工具层（第一阶段：Streamable HTTP + 读写切换 + 出差互斥）", () => {
  test("默认关闭返回 404；开启后校验回环 IP、Origin 跨站与专属令牌，且与设备 Token 严格隔离", async () => {
    const c = (ctx = await createTestContext());
    let clientIp = "127.0.0.1";

    const app = createApp({
      version: "0.1.0",
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      getActiveSessionId: () => "sess-1",
      dataDir: c.dataDir,
      db: c.db,
      memoryIndex: c.index,
      memoryTools: c.tools,
      memoryGitMutex: new AsyncMutex(),
      getClientIp: () => clientIp,
    });

    // 1. 默认关闭 -> /mcp 返回 404，/health 标记 memoryMcpEnabled=false
    const h0 = await app.request("/api/v1/health");
    expect(((await h0.json()) as { memoryMcpEnabled: boolean }).memoryMcpEnabled).toBe(false);

    const closedRes = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: mcpRpc("initialize"),
    });
    expect(closedRes.status).toBe(404);

    // 2. 通过管理接口签发专属 MCP 令牌并开启 MCP
    const authHeaders = {
      authorization: `Bearer ${ctx.authToken}`,
      "content-type": "application/json",
    };
    const tokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "claude-code" }),
    });
    expect(tokRes.status).toBe(201);
    const tokJson = (await tokRes.json()) as {
      ok: boolean;
      token: string;
      tokenInfo: { id: string; name: string };
    };
    expect(tokJson.ok).toBe(true);
    expect(tokJson.token.startsWith("psbm_")).toBe(true);

    // 验证 /settings 不泄露 tokenHash
    const patchRes = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ memoryMcp: { enabled: true } }),
    });
    expect(patchRes.status).toBe(200);
    const settingsBody = (await patchRes.json()) as {
      settings: { memoryMcp: { enabled: boolean; tokens: Array<Record<string, unknown>> } };
    };
    expect(settingsBody.settings.memoryMcp.enabled).toBe(true);
    expect(settingsBody.settings.memoryMcp.tokens).toHaveLength(1);
    expect(settingsBody.settings.memoryMcp.tokens[0]!.tokenHash).toBeUndefined();

    // 3. 专属 MCP 令牌绝不能访问 /api/v1/*
    const crossUse = await app.request("/api/v1/settings", {
      headers: { authorization: `Bearer ${tokJson.token}` },
    });
    expect(crossUse.status).toBe(401);

    // 4. Flutter 设备令牌绝不能访问 /mcp
    const deviceUseMcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.authToken}`,
        "content-type": "application/json",
      },
      body: mcpRpc("initialize"),
    });
    expect(deviceUseMcp.status).toBe(401);

    // 5. allowRemote=false 时非回环 IP 返回 403
    clientIp = "192.168.1.88";
    const remoteRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokJson.token}`,
        "content-type": "application/json",
      },
      body: mcpRpc("initialize"),
    });
    expect(remoteRes.status).toBe(403);
    clientIp = "127.0.0.1";

    // 6. 跨站 Origin 返回 403
    const originRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3721",
        origin: "https://evil.example",
        authorization: `Bearer ${tokJson.token}`,
        "content-type": "application/json",
      },
      body: mcpRpc("initialize"),
    });
    expect(originRes.status).toBe(403);

    // 7. 正常回环请求握手 + notifications + ping + GET 405 + DELETE 204
    const mcpHeaders = {
      authorization: `Bearer ${tokJson.token}`,
      "content-type": "application/json",
    };
    const initRes = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: mcpRpc("initialize", { protocolVersion: "2025-03-26" }),
    });
    expect(initRes.status).toBe(200);
    const sid = initRes.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    const initJson = (await initRes.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(initJson.result.protocolVersion).toBe("2025-03-26");
    expect(initJson.result.serverInfo.name).toBe("psyber-memory");

    const notifRes = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notifRes.status).toBe(202);

    const pingRes = await app.request("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sid! },
      body: mcpRpc("ping", undefined, 2),
    });
    expect(pingRes.status).toBe(200);
    expect(((await pingRes.json()) as { result: unknown }).result).toEqual({});

    // 伪造或跨令牌 mcp-session-id 均返回 404
    const forgedSidRes = await app.request("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": "mcps_forged_session" },
      body: mcpRpc("ping", undefined, 21),
    });
    expect(forgedSidRes.status).toBe(404);

    const otherTokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "other-client" }),
    });
    const otherTok = ((await otherTokRes.json()) as { token: string }).token;
    const crossSidRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${otherTok}`,
        "content-type": "application/json",
        "mcp-session-id": sid!,
      },
      body: mcpRpc("ping", undefined, 22),
    });
    expect(crossSidRes.status).toBe(404);

    // 他人无法 DELETE 关闭我的会话
    const crossDelRes = await app.request("/mcp", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${otherTok}`,
        "mcp-session-id": sid!,
      },
    });
    expect(crossDelRes.status).toBe(204);
    const stillAlive = await app.request("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sid! },
      body: mcpRpc("ping", undefined, 23),
    });
    expect(stillAlive.status).toBe(200);

    const badMethod = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: mcpRpc("unknown/method", undefined, 3),
    });
    expect(((await badMethod.json()) as { error: { code: number } }).error.code).toBe(-32601);

    const badJson = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: "{broken",
    });
    expect(((await badJson.json()) as { error: { code: number } }).error.code).toBe(-32700);

    const getRes = await app.request("/mcp", { method: "GET" });
    expect(getRes.status).toBe(405);

    const delRes = await app.request("/mcp", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${tokJson.token}`,
        "mcp-session-id": sid!,
      },
    });
    expect(delRes.status).toBe(204);

    // 关闭会话后再携带该 mcp-session-id 调用，返回 404
    const afterClose = await app.request("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sid! },
      body: mcpRpc("ping", undefined, 24),
    });
    expect(afterClose.status).toBe(404);

    // 8. 吊销令牌后立刻失效
    const revRes = await app.request(`/api/v1/memory-mcp/tokens/${tokJson.tokenInfo.id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(revRes.status).toBe(200);

    const afterRevoke = await app.request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: mcpRpc("ping"),
    });
    expect(afterRevoke.status).toBe(401);
  });

  test("read_only 模式暴露 6 只读工具、绝不泄私密抽屉/原始聊天、不污染 access_count 且支持向量+双链检索", async () => {
    ctx = await createTestContext();

    // 准备记忆卡片、过期/未过期状态、双链与私密抽屉/原始聊天记录
    await ctx.tools.write(
      "core/self.md",
      "---\ntitle: 自我档案\nkind: note\nstatus: active\ncreated: 2026-11-01\nupdated: 2026-11-20\n---\n我是 TestPsyber，喜欢在雨夜泡茶写笔记。",
    );
    await ctx.tools.write(
      "core/state.md",
      "---\ntitle: 近期状态\nkind: note\nstatus: active\ncreated: 2026-11-18\nupdated: 2026-11-20\n---\n- [至 2026-11-10] 过期测试状态SECRET_EXPIRED\n- [至 2026-11-28] 周末准备一起逛旧书店",
    );
    await ctx.tools.write(
      "episodes/2026/11/19/ep-tea.md",
      "---\ntitle: 11-19 雨夜乌龙茶\nkind: episode\nstatus: active\ncreated: 2026-11-19\nupdated: 2026-11-19\n---\n晚上一起喝了炭焙乌龙茶，顺便翻出了 [[旧书店约定]]。",
    );
    await ctx.tools.write(
      "threads/REGISTRY.yaml",
      "spaces:\n  walks:\n    title: 散步笔记\n    triggers: [散步, 书店]\n    decay: none\n    card_style: \"记录每次去过的地方与细节\"",
    );
    await ctx.tools.write(
      "threads/walks/bookstore.md",
      "---\ntitle: 旧书店约定\nkind: note\nstatus: active\ncreated: 2026-11-19\nupdated: 2026-11-19\nwhen_to_recall: 聊起旧书店或周末安排时\n---\n约定周末去城南拐角那家二楼旧书店淘老唱片。",
    );

    // 写入私密抽屉文件与原始聊天消息（验证绝不会通过 MCP 泄露）
    await fs.mkdir(path.join(ctx.dataDir, "private"), { recursive: true });
    await fs.writeFile(path.join(ctx.dataDir, "private", "secret.sealed"), "TOP_SECRET_DRAWER_TEXT", "utf8");
    ctx.events.append({
      sessionId: "sess-1",
      role: "user",
      kind: "chat",
      content: "RAW_CHAT_EVENT_SHOULD_NOT_LEAK",
    });

    const mockEmbedding: EmbeddingClient = {
      modelKey: "mock-embed",
      async embed(text: string): Promise<Float32Array> {
        // 含茶/乌龙向 [1, 0]，书店向 [0, 1]
        if (text.includes("茶") || text.includes("乌龙")) return new Float32Array([1, 0]);
        return new Float32Array([0.1, 0.9]);
      },
    };

    const app = createApp({
      version: "0.1.0",
      clock: ctx!.clock,
      getConfig: () => ctx!.config,
      events: ctx!.events,
      getActiveSessionId: () => "sess-1",
      dataDir: ctx!.dataDir,
      db: ctx!.db,
      memoryIndex: ctx!.index,
      memoryTools: ctx!.tools,
      embedding: mockEmbedding,
      memoryGitMutex: new AsyncMutex(),
    });

    const authHeaders = {
      authorization: `Bearer ${ctx.authToken}`,
      "content-type": "application/json",
    };
    const tokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "cursor" }),
    });
    const mcpToken = ((await tokRes.json()) as { token: string }).token;
    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ memoryMcp: { enabled: true, accessMode: "read_only" } }),
    });

    const callMcp = async (method: string, params?: Record<string, unknown>) => {
      const r = await app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${mcpToken}`,
          "content-type": "application/json",
        },
        body: mcpRpc(method, params),
      });
      return (await r.json()) as {
        result?: {
          tools?: Array<{ name: string }>;
          content?: Array<{ text: string }>;
          isError?: boolean;
        };
        error?: { code: number; message: string };
      };
    };

    // 1. tools/list 在 read_only 下仅暴露 6 个只读工具
    const listRes = await callMcp("tools/list");
    const toolNames = (listRes.result?.tools ?? []).map((t) => t.name);
    expect(toolNames).toEqual([
      "memory_context",
      "memory_search",
      "memory_glob",
      "memory_grep",
      "memory_read",
      "memory_history",
    ]);

    // 2. 硬调 memory_write 被拒绝
    const writeBlocked = await callMcp("tools/call", {
      name: "memory_write",
      arguments: { path: "episodes/2026/11/20/ep-x.md", content: "hi" },
    });
    expect(writeBlocked.result?.isError).toBe(true);

    // 3. memory_context 返回常驻档案且自动过滤过期 state，绝不泄露原始聊天与抽屉
    const ctxRes = await callMcp("tools/call", { name: "memory_context", arguments: {} });
    const ctxText = ctxRes.result?.content?.[0]?.text ?? "";
    expect(ctxText).toContain("我是 TestPsyber");
    expect(ctxText).toContain("周末准备一起逛旧书店");
    expect(ctxText).not.toContain("SECRET_EXPIRED");
    expect(ctxText).not.toContain("RAW_CHAT_EVENT_SHOULD_NOT_LEAK");
    expect(ctxText).not.toContain("TOP_SECRET_DRAWER_TEXT");

    // 4. memory_search 命中向量与 1 跳双链邻接卡
    const searchRes = await callMcp("tools/call", {
      name: "memory_search",
      arguments: { query: "那天夜里喝了什么茶", limit: 3 },
    });
    const searchText = searchRes.result?.content?.[0]?.text ?? "";
    expect(searchText).toContain("11-19 雨夜乌龙茶");
    expect(searchText).toContain("双链关联延伸");
    expect(searchText).toContain("旧书店约定");

    // 5. memory_read 支持 [[短标题]] 且不递增 access_count；访问 private/ 与 ../ 被拒绝
    const readRes = await callMcp("tools/call", {
      name: "memory_read",
      arguments: { path: "[[旧书店约定]]" },
    });
    expect(readRes.result?.isError).toBe(false);
    expect(readRes.result?.content?.[0]?.text).toContain("城南拐角");
    expect(ctx.index.getRow("threads/walks/bookstore.md")?.access_count).toBe(0);

    const privRes = await callMcp("tools/call", {
      name: "memory_read",
      arguments: { path: "private/secret.sealed" },
    });
    expect(privRes.result?.isError).toBe(true);

    const escapeRes = await callMcp("tools/call", {
      name: "memory_grep",
      arguments: { pattern: "TOP_SECRET", path: "../private" },
    });
    expect(escapeRes.result?.isError).toBe(true);

    // 6. memory_glob 与 memory_history 在空提交库下优雅返回
    const globRes = await callMcp("tools/call", {
      name: "memory_glob",
      arguments: { pattern: "episodes/**/*.md" },
    });
    expect(globRes.result?.content?.[0]?.text).toContain("ep-tea.md");

    const histEmpty = await callMcp("tools/call", {
      name: "memory_history",
      arguments: { action: "log" },
    });
    expect(histEmpty.result?.isError).toBe(false);
    expect(histEmpty.result?.content?.[0]?.text).toContain("还没有任何历史提交记录");
  });

  test("read_write 模式切换、protectCoreFiles 保护、并发写锁、单令牌降权与 Git 来源留痕", async () => {
    ctx = await createTestContext();
    await ctx.tools.write(
      "core/self.md",
      "---\ntitle: 自我档案\nkind: note\nstatus: active\ncreated: 2026-11-20\nupdated: 2026-11-20\n---\n初始自我介绍",
    );
    await ctx.tools.write(
      "core/state.md",
      "---\ntitle: 近期状态\nkind: note\nstatus: active\ncreated: 2026-11-20\nupdated: 2026-11-20\n---\n## 短期状态与待办\n- [至 2026-11-25] 整理桌面",
    );

    const app = createApp({
      version: "0.1.0",
      clock: ctx!.clock,
      getConfig: () => ctx!.config,
      events: ctx!.events,
      getActiveSessionId: () => "sess-1",
      dataDir: ctx!.dataDir,
      db: ctx!.db,
      memoryIndex: ctx!.index,
      memoryTools: ctx!.tools,
      memoryGitMutex: new AsyncMutex(),
    });

    const authHeaders = {
      authorization: `Bearer ${ctx.authToken}`,
      "content-type": "application/json",
    };
    const rwTokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "claude-code" }),
    });
    const rwToken = ((await rwTokRes.json()) as { token: string }).token;

    const roTokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "viewer", accessMode: "read_only" }),
    });
    const roToken = ((await roTokRes.json()) as { token: string }).token;

    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        memoryMcp: { enabled: true, accessMode: "read_write", protectCoreFiles: true },
      }),
    });

    const callWith = async (token: string, method: string, params?: Record<string, unknown>) => {
      const r = await app.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: mcpRpc(method, params),
      });
      return (await r.json()) as {
        result?: {
          tools?: Array<{ name: string }>;
          content?: Array<{ text: string }>;
          isError?: boolean;
        };
      };
    };

    // 1. rwToken 看到 8 个工具；单令牌降权为 read_only 的 roToken 依然只看到 6 个只读工具
    const rwList = await callWith(rwToken, "tools/list");
    expect((rwList.result?.tools ?? []).map((t) => t.name)).toContain("memory_write");
    expect((rwList.result?.tools ?? []).map((t) => t.name)).toContain("memory_edit");

    const roList = await callWith(roToken, "tools/list");
    expect((roList.result?.tools ?? []).map((t) => t.name)).not.toContain("memory_write");

    // 2. protectCoreFiles=true 拦截 core/state.md 和 core/self.md
    const coreBlocked = await callWith(rwToken, "tools/call", {
      name: "memory_edit",
      arguments: { path: "core/state.md", old_string: "整理桌面", new_string: "整理书架" },
    });
    expect(coreBlocked.result?.isError).toBe(true);
    expect(coreBlocked.result?.content?.[0]?.text).toContain("protectCoreFiles");

    // 3. 并发写入多张合规卡片，共享 gitMutex 下全部成功且 Git 留痕完整
    const writes = await Promise.all([
      callWith(rwToken, "tools/call", {
        name: "memory_write",
        arguments: {
          path: "episodes/2026/11/20/ep-trip-a.md",
          content: "---\ntitle: 11-20 外出记A\nkind: episode\nstatus: active\ncreated: 2026-11-20\nupdated: 2026-11-20\n---\n出门测试A",
          note: "记录出差见闻A",
        },
      }),
      callWith(rwToken, "tools/call", {
        name: "memory_write",
        arguments: {
          path: "episodes/2026/11/20/ep-trip-b.md",
          content: "---\ntitle: 11-20 外出记B\nkind: episode\nstatus: active\ncreated: 2026-11-20\nupdated: 2026-11-20\n---\n出门测试B",
          note: "记录出差见闻B",
        },
      }),
    ]);
    expect(writes[0]!.result?.isError).toBe(false);
    expect(writes[1]!.result?.isError).toBe(false);

    const editRes = await callWith(rwToken, "tools/call", {
      name: "memory_edit",
      arguments: {
        path: "episodes/2026/11/20/ep-trip-a.md",
        old_string: "出门测试A",
        new_string: "出门测试A·补充细节",
        note: "补充见闻A",
      },
    });
    expect(editRes.result?.isError).toBe(false);

    const histRes = await callWith(rwToken, "tools/call", {
      name: "memory_history",
      arguments: { action: "log", limit: 5 },
    });
    const histText = histRes.result?.content?.[0]?.text ?? "";
    expect(histText).toContain("memory(mcp:claude-code): 记录出差见闻A");
    expect(histText).toContain("memory(mcp:claude-code): 补充见闻A");

    // 4. 关闭 protectCoreFiles 后允许 edit core/state.md，但仍禁止整篇 write 覆写 core/self.md
    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ memoryMcp: { protectCoreFiles: false } }),
    });
    const coreEditOk = await callWith(rwToken, "tools/call", {
      name: "memory_edit",
      arguments: { path: "core/state.md", old_string: "整理桌面", new_string: "整理书架" },
    });
    expect(coreEditOk.result?.isError).toBe(false);

    const selfOverwriteBlocked = await callWith(rwToken, "tools/call", {
      name: "memory_write",
      arguments: { path: "core/self.md", content: "覆盖掉" },
    });
    expect(selfOverwriteBlocked.result?.isError).toBe(true);
    expect(selfOverwriteBlocked.result?.content?.[0]?.text).toContain("禁止整篇覆写");
  });

  test("出差互斥与回家交接：开启后拦截内部对话与心跳/整理；关闭后重建索引、刷新前缀并恢复对话", async () => {
    const dataDir = await makeTempDir();
    const promptsDir = path.resolve(import.meta.dir, "../../prompts");
    // 2026-11-20 23:45 Asia/Shanghai（处于默认睡眠窗内，正常态本可触发心跳逻辑）
    const clock = new VirtualClock(Date.UTC(2026, 10, 20, 15, 45, 0), "Asia/Shanghai");
    const mockChat = new MockChatModel();

    runtime = await bootPsyberRuntime({
      dataDir,
      promptsDir,
      clock,
      chatModel: mockChat,
      startHeartbeatTimer: false,
      catchUpMissedBedtime: false,
      writeLocalPairFile: false,
    });

    // 配对一个测试设备并初始化核心记忆
    const pairCode = runtime.pairing.issueCode().code;
    const pairRes = await runtime.app.request("/api/v1/auth/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairCode, deviceName: "TestMac", platform: "macos" }),
    });
    const deviceToken = ((await pairRes.json()) as { token: string }).token;
    const authHeaders = {
      authorization: `Bearer ${deviceToken}`,
      "content-type": "application/json",
    };

    await runtime.app.request("/api/v1/genesis", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ residentName: "TestPsyber", userName: "TestUser", userPronoun: "TA" }),
    });

    // 1. 先正常发一轮消息，让引擎冻结首轮 staticPrefixSnapshot
    mockChat.queueStream(() => [
      { type: "text_delta", delta: "在家呢。" },
      { type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15, stopReason: "stop" },
    ]);
    const msg1 = await runtime.app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "m1", content: "在吗" }),
    });
    expect(msg1.status).toBe(202);
    await runtime.waitForIdle();
    await runtime.engine.waitForTurnIdle();
    const m1Json = (await msg1.json()) as { message: { id: string } };
    expect(mockChat.requests[0]!.systemPrompt).not.toContain("出差新边界");

    // 2. 签发 MCP 令牌并开启出差模式（read_write + 允许改 core 以验证回家前缀刷新）
    const tokRes = await runtime.app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "travel-agent" }),
    });
    const mcpToken = ((await tokRes.json()) as { token: string }).token;

    await runtime.app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        memoryMcp: { enabled: true, accessMode: "read_write", protectCoreFiles: false },
      }),
    });

    // 3. 出差期间：内部聊天写接口全数返回 409 MCP_ACTIVE，心跳与整理短路暂停
    const blockedSend = await runtime.app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "m2", content: "我发一条试试" }),
    });
    expect(blockedSend.status).toBe(409);
    expect(((await blockedSend.json()) as { error: { code: string } }).error.code).toBe("MCP_ACTIVE");

    const blockedWrap = await runtime.app.request("/api/v1/chat/wrap-up", {
      method: "POST",
      headers: authHeaders,
    });
    expect(blockedWrap.status).toBe(409);

    const blockedEdit = await runtime.app.request(`/api/v1/chat/messages/${m1Json.message.id}/edit`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ content: "改写" }),
    });
    expect(blockedEdit.status).toBe(409);

    expect((await runtime.tickHeartbeat()).action).toBe("idle");
    expect(await runtime.enqueueTidy("daily_wrapup")).toBeNull();

    // 4. 外部 MCP 客户端在出差期间写入一条新 boundary，并在磁盘外部手改一张新卡片验证回家后 reindexAll
    const mcpWrite = await runtime.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" },
      body: mcpRpc("tools/call", {
        name: "memory_write",
        arguments: {
          path: "core/boundaries.md",
          content: "---\ntitle: 相处边界\nkind: note\nstatus: active\ncreated: 2026-11-20\nupdated: 2026-11-20\n---\n出差新边界：睡前不催回复",
        },
      }),
    });
    expect(mcpWrite.status).toBe(200);

    await fs.mkdir(path.join(dataDir, "memory", "lessons"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "memory", "lessons", "travel-note.md"),
      "---\ntitle: 出差经验\nkind: lesson\nstatus: active\nwhen_to_recall: 聊到出差工具时\n---\n外部工具帮我整理了长文档。",
      "utf8",
    );

    // 5. 关闭出差模式（通过磁盘写回 + reloadMemoryMcpConfigFromDisk 验证 CLI 热重载链路）
    const diskCfg = await loadOrCreateConfig(dataDir, clock.now());
    diskCfg.memoryMcp = mergeMemoryMcpConfig(diskCfg.memoryMcp, { enabled: false });
    await saveConfig(dataDir, diskCfg);
    await runtime.reloadMemoryMcpConfigFromDisk();

    // 回家交接后：磁盘新卡已被 reindexAll 收入索引，且内部对话恢复并读取到最新 staticPrefix
    expect(runtime.memoryIndex.getRow("lessons/travel-note.md")?.title).toBe("出差经验");

    mockChat.queueStream(() => [
      { type: "text_delta", delta: "我回来啦。" },
      { type: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15, stopReason: "stop" },
    ]);
    const msgAfter = await runtime.app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "m3", content: "欢迎回来" }),
    });
    expect(msgAfter.status).toBe(202);
    await runtime.waitForIdle();
    await runtime.engine.waitForTurnIdle();
    expect(mockChat.requests[1]!.systemPrompt).toContain("出差新边界");
  });

  test("CLI 脚本 scripts/memory_mcp.ts 支持隔离目录启停、模式切换与签发/吊销令牌", async () => {
    const dataDir = await makeTempDir();
    const scriptPath = path.resolve(import.meta.dir, "../scripts/memory_mcp.ts");
    const runCli = async (args: string[]) => {
      const proc = Bun.spawn(["bun", "run", scriptPath, "--data-dir", dataDir, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    };

    const tok = await runCli(["token", "create", "--name", "cli-client", "--mode", "read_write"]);
    expect(tok.code).toBe(0);
    expect(tok.stdout).toContain("psbm_");
    expect(tok.stdout).toContain("psyber-memory");

    const en = await runCli(["enable", "--mode", "read_write", "--allow-core"]);
    expect(en.code).toBe(0);

    const st = await runCli(["status"]);
    expect(st.code).toBe(0);
    expect(st.stdout).toContain("已开启");
    expect(st.stdout).toContain("read_write");
    expect(st.stdout).toContain("cli-client");

    const cfg = await loadOrCreateConfig(dataDir, Date.now());
    expect(cfg.memoryMcp?.enabled).toBe(true);
    expect(cfg.memoryMcp?.accessMode).toBe("read_write");
    expect(cfg.memoryMcp?.protectCoreFiles).toBe(false);
    expect(cfg.memoryMcp?.tokens).toHaveLength(1);

    const tokenId = cfg.memoryMcp!.tokens[0]!.id;
    const rev = await runCli(["token", "revoke", tokenId]);
    expect(rev.code).toBe(0);

    const dis = await runCli(["disable"]);
    expect(dis.code).toBe(0);

    const cfgAfter = await loadOrCreateConfig(dataDir, Date.now());
    expect(cfgAfter.memoryMcp?.enabled).toBe(false);
    expect(cfgAfter.memoryMcp?.tokens).toHaveLength(0);
  });

  test("stdio 转发桥 scripts/mcp_stdio.ts 端到端链路（--save-stdio、握手、tools/list、tools/call、关停报错与退出清理）", async () => {
    const c = (ctx = await createTestContext());
    await c.tools.write(
      "lessons/stdio-tip.md",
      "---\ntitle: stdio 桥接测试卡\nkind: lesson\nstatus: active\nwhen_to_recall: 测 stdio 桥时\n---\n标准输入输出转发正常。",
    );

    const cliPath = path.resolve(import.meta.dir, "../scripts/memory_mcp.ts");
    const stdioPath = path.resolve(import.meta.dir, "../scripts/mcp_stdio.ts");

    // 1. 使用 --save-stdio 签发令牌并检查真实子进程帮助信息
    const createProc = Bun.spawn(
      [
        process.execPath,
        "run",
        cliPath,
        "--data-dir",
        c.dataDir,
        "token",
        "create",
        "--name",
        "desktop-stdio",
        "--save-stdio",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [createOut, createCode] = await Promise.all([
      new Response(createProc.stdout).text(),
      createProc.exited,
    ]);
    expect(createCode).toBe(0);
    expect(createOut).toContain("mcp_stdio.ts");
    expect(createOut).toContain("mcp_stdio_token");

    const helpProc = Bun.spawn([process.execPath, "run", stdioPath, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [helpErr, helpCode] = await Promise.all([
      new Response(helpProc.stderr).text(),
      helpProc.exited,
    ]);
    expect(helpCode).toBe(0);
    expect(helpErr).toContain("Psyber 记忆 MCP stdio 转发桥");

    const diskCfg = await loadOrCreateConfig(c.dataDir, c.clock.now());
    c.config.memoryMcp = mergeMemoryMcpConfig(diskCfg.memoryMcp, {
      enabled: true,
      accessMode: "read_only",
    });

    const app = createApp({
      version: "0.1.0",
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      getActiveSessionId: () => "sess-stdio",
      dataDir: c.dataDir,
      db: c.db,
      memoryIndex: c.index,
      memoryTools: c.tools,
      memoryGitMutex: new AsyncMutex(),
    });

    const stdinStream = new PassThrough();
    const outLines: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    let outBuf = "";
    const stdoutMock = {
      write: (chunk: string) => {
        outBuf += chunk;
        let nl = outBuf.indexOf("\n");
        while (nl >= 0) {
          const line = outBuf.slice(0, nl).trim();
          outBuf = outBuf.slice(nl + 1);
          nl = outBuf.indexOf("\n");
          if (!line) continue;
          const waiter = waiters.shift();
          if (waiter) waiter(line);
          else outLines.push(line);
        }
        return true;
      },
    };
    const nextStdoutJson = async () => {
      if (outLines.length > 0) {
        return JSON.parse(outLines.shift()!) as Record<string, unknown>;
      }
      const line = await new Promise<string>((resolve) => waiters.push(resolve));
      return JSON.parse(line) as Record<string, unknown>;
    };

    const stderrChunks: string[] = [];
    let lastSessionId: string | null = null;
    const bridgePromise = runStdioBridge(
      {
        dataDir: c.dataDir,
        url: "http://127.0.0.1:3721/mcp",
        timeoutMs: 5_000,
        help: false,
      },
      {
        stdin: stdinStream,
        stdout: stdoutMock,
        stderr: { write: (s: string) => stderrChunks.push(s) },
        fetchImpl: (async (input, init) => {
          const req = input instanceof Request ? input : new Request(String(input), init);
          const resp = await app.request(req);
          const sid = resp.headers.get("mcp-session-id");
          if (sid) lastSessionId = sid;
          return resp;
        }) as typeof fetch,
      },
    );

    const sendLine = (obj: unknown) => {
      stdinStream.write(`${JSON.stringify(obj)}\n`);
    };

    // 2. initialize
    sendLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    const initResp = (await nextStdoutJson()) as { id: number; result: { serverInfo: { name: string } } };
    expect(initResp.id).toBe(1);
    expect(initResp.result.serverInfo.name).toBe("psyber-memory");
    expect(lastSessionId).toBeTruthy();

    // 3. notification（202 无 stdout 输出）+ tools/list 验证 session-id 透传
    sendLine({ jsonrpc: "2.0", method: "notifications/initialized" });
    sendLine({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listResp = (await nextStdoutJson()) as {
      id: number;
      result: { tools: Array<{ name: string }> };
    };
    expect(listResp.id).toBe(2);
    expect(listResp.result.tools.map((t) => t.name)).toContain("memory_read");

    // 4. tools/call 读取卡片
    sendLine({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "memory_read", arguments: { path: "lessons/stdio-tip.md" } },
    });
    const callResp = (await nextStdoutJson()) as {
      id: number;
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(callResp.id).toBe(3);
    expect(callResp.result.isError).toBe(false);
    expect(callResp.result.content[0]?.text).toContain("标准输入输出转发正常");

    // 5. 主服务关闭 MCP 开关后，stdio 桥应立刻返回 JSON-RPC error 而不挂死
    c.config.memoryMcp = mergeMemoryMcpConfig(c.config.memoryMcp, { enabled: false });
    sendLine({ jsonrpc: "2.0", id: 4, method: "ping" });
    const errResp = (await nextStdoutJson()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(errResp.id).toBe(4);
    expect(errResp.error.code).toBe(-32000);
    expect(errResp.error.message).toContain("MCP_DISABLED");

    // 6. 先重新开启以验证 stdin.end() 时会发 DELETE /mcp 清理服务端会话
    c.config.memoryMcp = mergeMemoryMcpConfig(c.config.memoryMcp, { enabled: true });
    stdinStream.end();
    await bridgePromise;

    const rawToken = (await fs.readFile(path.join(c.dataDir, "mcp_stdio_token"), "utf8")).trim();
    const afterCloseRes = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawToken}`,
        "content-type": "application/json",
        "mcp-session-id": lastSessionId!,
      },
      body: mcpRpc("ping", undefined, 99),
    });
    expect(afterCloseRes.status).toBe(404);

    // 7. 撤销令牌时同步清理 mcp_stdio_token
    const tokenId = c.config.memoryMcp.tokens[0]!.id;
    const revProc = Bun.spawn(
      [process.execPath, "run", cliPath, "--data-dir", c.dataDir, "token", "revoke", tokenId],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await revProc.exited).toBe(0);
    await expect(fs.access(path.join(c.dataDir, "mcp_stdio_token"))).rejects.toThrow();
    expect(stderrChunks.some((s) => s.includes("MCP_DISABLED"))).toBe(true);
  });
});
