import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashBearerToken } from "../src/api/app.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { saveConfig } from "../src/core/config.ts";
import {
  formatMcpCallResult,
  MAX_MCP_IMAGE_BYTES,
  MAX_MCP_IMAGES,
  MAX_MCP_OUTPUT_CHARS,
} from "../src/extensions/mcp.ts";
import { bootPsyberRuntime } from "../src/index.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("Ring 1.5 外部 MCP 桥接（Tier 3 隔离、凭证分离、confirm 审批、8000 字截断与热重载）", () => {
  test("streamable_http MCP 挂载为 Tier 3、${cred:...} 凭证隔离、8000 字截断与预设接口", async () => {
    const dataDir = await makeTempDir("psyber-mcp-http-");
    const clock = new VirtualClock(Date.parse("2026-11-21T12:00:00Z"), "Asia/Shanghai");
    const observedAuthHeaders: string[] = [];
    const seenToolNamesInLlm: string[][] = [];

    let callStep = 0;
    const mockModel: ChatModelClient = {
      modelId: "mock-chat",
      contextWindow: 100_000,
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        seenToolNamesInLlm.push(req.tools.map((t) => t.name));
        callStep += 1;
        if (callStep === 1) {
          yield {
            type: "tool_call",
            id: "tc_search",
            name: "tool_search",
            args: { query: "tavily" },
          };
          yield { type: "usage", inputTokens: 100, outputTokens: 20, totalTokens: 120 };
          return;
        }
        if (callStep === 2) {
          yield {
            type: "tool_call",
            id: "tc_call",
            name: "call_tool",
            args: { name: "mcp.tavily.search", arguments: { q: "psyber" } },
          };
          yield { type: "usage", inputTokens: 150, outputTokens: 20, totalTokens: 170 };
          return;
        }
        const lastToolMsg = [...req.messages].reverse().find((m) => m.role === "toolResult");
        const toolOut = lastToolMsg?.role === "toolResult" ? lastToolMsg.content : "";
        yield { type: "text_delta", delta: `查到了：${toolOut.slice(-40)}` };
        yield { type: "usage", inputTokens: 200, outputTokens: 30, totalTokens: 230 };
      },
    };

    const mockFetch: typeof fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization");
      if (auth) observedAuthHeaders.push(auth);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2024-11-05", capabilities: {} },
          }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } },
        );
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "search",
                  description: "联网搜索公开网页",
                  inputSchema: { type: "object", properties: { q: { type: "string" } } },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body.method === "tools/call") {
        const huge = "A".repeat(MAX_MCP_OUTPUT_CHARS + 500);
        return new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: huge }] },
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: mockModel,
      fetchImpl: mockFetch,
      startHeartbeatTimer: false,
    });
    try {
      const token = "psb_mcp_test_1";
      rt.config.auth.devices.push({
        deviceId: "dev-1",
        tokenHash: hashBearerToken(token),
        deviceName: "Mac",
        platform: "macos",
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
      });
      await saveConfig(dataDir, rt.config);

      // 1. 预设接口可用
      const presetRes = await rt.app.request("/api/v1/mcp/presets", {
        headers: makeAuthHeader(token),
      });
      expect(presetRes.status).toBe(200);
      const presetJson = (await presetRes.json()) as { presets: Array<{ id: string }> };
      expect(presetJson.presets.some((p) => p.id === "tavily")).toBe(true);

      // 2. 通过 PATCH /settings 写入 MCP 与隔离密钥，触发热重载
      const patchRes = await rt.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({
          mcpSecrets: { tavily_key: "secret-tavily-999" },
          mcpServers: [
            {
              id: "tavily",
              enabled: true,
              transport: "streamable_http",
              url: "https://mcp.example.test/mcp",
              headers: { Authorization: "Bearer ${cred:tavily_key}" },
              trustLevel: "auto",
            },
          ],
        }),
      });
      expect(patchRes.status).toBe(200);
      const patchJson = (await patchRes.json()) as {
        settings: { mcpServers: Array<{ id: string; status: string; tools: string[] }> };
      };
      expect(patchJson.settings.mcpServers[0]?.status).toBe("connected");
      expect(patchJson.settings.mcpServers[0]?.tools).toEqual(["mcp.tavily.search"]);

      // 3. 凭证隔离核验：config.json 绝不含明文密钥，但实际请求注入了真实密钥
      const rawConfigText = await fs.readFile(path.join(dataDir, "config.json"), "utf8");
      expect(rawConfigText).not.toContain("secret-tavily-999");
      expect(rawConfigText).toContain("${cred:tavily_key}");
      expect(observedAuthHeaders.every((h) => h === "Bearer secret-tavily-999")).toBe(true);

      // 4. 对话中通过 tool_search + call_tool 调用；Tier 1 工具声明绝不含 mcp.tavily.search
      const turnRes = await rt.engine.runTurn({ mode: "chat", userText: "帮我搜一下 psyber" });
      expect(turnRes.error).toBeUndefined();
      expect(seenToolNamesInLlm.every((list) => !list.includes("mcp.tavily.search"))).toBe(true);
      expect(turnRes.text).toContain(`[外部工具输出已截断，原始长度 ${MAX_MCP_OUTPUT_CHARS + 500} 字符]`);
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("默认 confirm 审批挂起 -> POST /turns/:turnId/approval 放行并广播销除（重复提交 409）", async () => {
    const dataDir = await makeTempDir("psyber-mcp-confirm-");
    const clock = new VirtualClock(Date.parse("2026-11-21T12:10:00Z"), "Asia/Shanghai");

    let step = 0;
    const mockModel: ChatModelClient = {
      modelId: "mock-chat",
      contextWindow: 100_000,
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        step += 1;
        if (step === 1) {
          yield {
            type: "tool_call",
            id: "tc_1",
            name: "call_tool",
            args: { name: "mcp.demo.echo", arguments: { text: "hello-mcp" } },
          };
          return;
        }
        const toolMsg = [...req.messages].reverse().find((m) => m.role === "toolResult");
        yield {
          type: "text_delta",
          delta: `外部回声：${toolMsg?.role === "toolResult" ? toolMsg.content : ""}`,
        };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: mockModel,
      startHeartbeatTimer: false,
      mcpClientFactory: () => ({
        async initialize() {},
        async listTools() {
          return [{ name: "echo", description: "回声测试" }];
        },
        async callTool(_name, args) {
          return { content: [{ type: "text", text: `ECHO:${String(args.text ?? "")}` }] };
        },
        async close() {},
      }),
    });

    try {
      const token = "psb_mcp_confirm_1";
      rt.config.auth.devices.push({
        deviceId: "dev-1",
        tokenHash: hashBearerToken(token),
        deviceName: "Mac",
        platform: "macos",
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
      });
      await saveConfig(dataDir, rt.config);

      // 不传 trustLevel，默认应为 confirm
      await rt.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({
          mcpServers: [
            {
              id: "demo",
              enabled: true,
              transport: "streamable_http",
              url: "https://demo.example.test/mcp",
            },
          ],
        }),
      });

      const sseEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
      let resolveApprovalReq!: (payload: Record<string, unknown>) => void;
      const approvalReqPromise = new Promise<Record<string, unknown>>((resolve) => {
        resolveApprovalReq = resolve;
      });
      let resolveTurnDone!: () => void;
      const turnDonePromise = new Promise<void>((resolve) => {
        resolveTurnDone = resolve;
      });

      const unsub = rt.sse.subscribe((frame) => {
        const data = (frame.data ?? {}) as Record<string, unknown>;
        sseEvents.push({ event: frame.event, data });
        if (frame.event === "turn.approval_required") {
          resolveApprovalReq(data);
        }
        if (frame.event === "turn.done") {
          resolveTurnDone();
        }
      });

      const sendRes = await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId: "c_1", content: "测试审批" }),
      });
      expect(sendRes.status).toBe(202);

      const reqData = await approvalReqPromise;
      expect(reqData.toolName).toBe("mcp.demo.echo");
      const approvalId = String(reqData.approvalId);
      const turnId = String(reqData.turnId);

      // 放行审批
      const approveRes = await rt.app.request(`/api/v1/turns/${turnId}/approval`, {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ approvalId, decision: "allow", scope: "once" }),
      });
      expect(approveRes.status).toBe(200);

      // 重复审批必须返 409
      const dupRes = await rt.app.request(`/api/v1/turns/${turnId}/approval`, {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ approvalId, decision: "deny" }),
      });
      expect(dupRes.status).toBe(409);

      await turnDonePromise;
      unsub();

      expect(sseEvents.some((e) => e.event === "turn.approval_resolved")).toBe(true);
      const history = rt.events.listHistory({ limit: 10 }).items;
      const reply = history.find((e) => e.role === "assistant");
      expect(reply?.content).toContain("外部回声：ECHO:hello-mcp");
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("真实 stdio 子进程、单服宕机零阻塞启动与热重载清理旧工具", async () => {
    const dataDir = await makeTempDir("psyber-mcp-stdio-");
    const clock = new VirtualClock(Date.parse("2026-11-21T12:20:00Z"), "Asia/Shanghai");

    const stdioScript = [
      `const dec = new TextDecoder();`,
      `let buf = "";`,
      `for await (const chunk of Bun.stdin.stream()) {`,
      `  buf += dec.decode(chunk, { stream: true });`,
      `  let idx = buf.indexOf("\\n");`,
      `  while (idx >= 0) {`,
      `    const line = buf.slice(0, idx).trim();`,
      `    buf = buf.slice(idx + 1);`,
      `    idx = buf.indexOf("\\n");`,
      `    if (!line) continue;`,
      `    const msg = JSON.parse(line);`,
      `    if (msg.method === "initialize") {`,
      `      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }));`,
      `    } else if (msg.method === "tools/list") {`,
      `      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "本地 stdio 探活" }] } }));`,
      `    } else if (msg.method === "tools/call") {`,
      `      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong-from-stdio" }] } }));`,
      `    }`,
      `  }`,
      `}`,
    ].join("\n");

    // 预写入 config.json：一个不可达 HTTP 服务 + 一个真实 stdio 服务
    const token = "psb_mcp_stdio_1";
    await saveConfig(dataDir, {
      instanceId: "inst-mcp-stdio",
      timezone: "Asia/Shanghai",
      door: { state: "open", note: null, updatedAt: clock.now() },
      auth: {
        devices: [
          {
            deviceId: "dev-1",
            tokenHash: hashBearerToken(token),
            deviceName: "Mac",
            platform: "macos",
            createdAt: clock.now(),
            lastSeenAt: clock.now(),
          },
        ],
      },
      mcpServers: [
        {
          id: "broken_http",
          enabled: true,
          transport: "streamable_http",
          url: "https://broken.invalid/mcp",
        },
        {
          id: "local_stdio",
          enabled: true,
          transport: "stdio",
          command: process.execPath,
          args: ["-e", stdioScript],
          trustLevel: "auto",
        },
      ],
    });

    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      fetchImpl: failingFetch,
      mcpHandshakeTimeoutMs: 2_000,
      mcpReconnectDelaysMs: [50],
      startHeartbeatTimer: false,
    });
    try {
      // 启动绝不因 broken_http 阻塞或抛错；等异步连接完成后检查状态隔离
      await rt.mcp.waitForReady();
      const statuses = rt.mcp.getStatusList();
      const broken = statuses.find((s) => s.id === "broken_http");
      const local = statuses.find((s) => s.id === "local_stdio");
      expect(broken?.status).toBe("degraded");
      expect(broken?.lastError).toContain("ECONNREFUSED");
      expect(local?.status).toBe("connected");
      expect(local?.tools).toEqual(["mcp.local_stdio.ping"]);

      // 热重载移除 local_stdio 后，旧工具应被注销且进程被关闭
      const reloadRes = await rt.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ mcpServers: [] }),
      });
      expect(reloadRes.status).toBe(200);
      expect(rt.mcp.getStatusList()).toEqual([]);
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("formatMcpCallResult 图片透传、纯图结果、格式归一、数量上限与防 base64 泄漏", () => {
    const sampleB64 = Buffer.from("fake-jpeg-bytes").toString("base64");

    // 1. 文本 + 标准 image 块 + data URI / image/jpg 归一 + resource 嵌入图
    const mixed = formatMcpCallResult({
      content: [
        { type: "text", text: "<video_cowatch_context>进度 12:03</video_cowatch_context>" },
        { type: "image", data: `data:image/jpg;base64,${sampleB64}\n`, mimeType: "" },
        {
          type: "resource",
          resource: { uri: "file:///frame.png", mimeType: "image/png", blob: sampleB64 },
        },
      ],
    });
    expect(mixed.ok).toBe(true);
    expect(mixed.output).toBe("<video_cowatch_context>进度 12:03</video_cowatch_context>");
    expect(mixed.output).not.toContain(sampleB64);
    expect(mixed.images).toEqual([
      { type: "image", data: sampleB64, mimeType: "image/jpeg" },
      { type: "image", data: sampleB64, mimeType: "image/png" },
    ]);

    // 2. 纯图片响应：绝不把 JSON.stringify(res) 的 base64 倒进 output
    const imageOnly = formatMcpCallResult({
      content: [{ type: "image", data: sampleB64, mimeType: "image/webp" }],
    });
    expect(imageOnly.ok).toBe(true);
    expect(imageOnly.output).toContain("1 张图片");
    expect(imageOnly.output).not.toContain(sampleB64);
    expect(imageOnly.images).toEqual([{ type: "image", data: sampleB64, mimeType: "image/webp" }]);

    // 3. 超过 MAX_MCP_IMAGES 截断 + 不支持格式 + 超体积拦截，均不泄漏 base64
    const oversizedB64 = "A".repeat(Math.ceil(((MAX_MCP_IMAGE_BYTES + 1024) * 4) / 3));
    const guarded = formatMcpCallResult({
      content: [
        { type: "image", data: sampleB64, mimeType: "image/svg+xml" },
        { type: "image", data: oversizedB64, mimeType: "image/png" },
        ...Array.from({ length: MAX_MCP_IMAGES + 2 }, () => ({
          type: "image",
          data: sampleB64,
          mimeType: "image/jpeg",
        })),
      ],
    });
    expect(guarded.ok).toBe(true);
    expect(guarded.images?.length).toBe(MAX_MCP_IMAGES);
    expect(guarded.output).toContain("暂不支持格式 image/svg+xml");
    expect(guarded.output).toContain("超过单图上限");
    expect(guarded.output).toContain(`仅载入前 ${MAX_MCP_IMAGES} 张`);
    expect(guarded.output).not.toContain(sampleB64);
    expect(guarded.output).not.toContain("AAAA".repeat(20));
  });

  test("端到端 MCP 图片透传：经 call_tool 送入当轮模型 toolResult.images，跨轮不落盘 base64", async () => {
    const dataDir = await makeTempDir("psyber-mcp-image-e2e-");
    const clock = new VirtualClock(Date.parse("2026-11-28T01:30:00Z"), "Asia/Shanghai");
    const gridB64 = Buffer.from("mock-2x2-grid-jpeg-payload").toString("base64");
    const observedToolImagesPerCall: Array<Array<{ mimeType: string; data: string }>> = [];

    let step = 0;
    const mockModel: ChatModelClient = {
      modelId: "mock-vision-chat",
      contextWindow: 100_000,
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        step += 1;
        const toolResults = req.messages.filter((m) => m.role === "toolResult");
        const latestImages = toolResults.flatMap((m) =>
          m.role === "toolResult" && m.images ? m.images.map((i) => ({ mimeType: i.mimeType, data: i.data })) : [],
        );
        observedToolImagesPerCall.push(latestImages);

        if (step === 1) {
          yield {
            type: "tool_call",
            id: "tc_cowatch",
            name: "call_tool",
            args: { name: "mcp.cowatch.get_recent_video_context", arguments: { clear_subtitles: true } },
          };
          return;
        }
        if (step === 2) {
          yield { type: "text_delta", delta: `看到了四宫格（共 ${latestImages.length} 张图）` };
          return;
        }
        // 第二轮普通聊天：确认历史消息里绝不残留上一轮 MCP 图片 base64
        const hasLeakedBase64 = JSON.stringify(req.messages).includes(gridB64);
        yield { type: "text_delta", delta: hasLeakedBase64 ? "LEAKED" : "第二轮干净" };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: mockModel,
      startHeartbeatTimer: false,
      mcpClientFactory: () => ({
        async initialize() {},
        async listTools() {
          return [{ name: "get_recent_video_context", description: "获取观影四宫格与字幕时间轴" }];
        },
        async callTool() {
          return {
            content: [
              { type: "text", text: "[12:03] 台词：这一幕也太帅了" },
              { type: "image", data: gridB64, mimeType: "image/jpeg" },
            ],
          };
        },
        async close() {},
      }),
    });

    try {
      const token = "psb_mcp_img_1";
      rt.config.auth.devices.push({
        deviceId: "dev-1",
        tokenHash: hashBearerToken(token),
        deviceName: "Mac",
        platform: "macos",
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
      });
      await saveConfig(dataDir, rt.config);

      const patchRes = await rt.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({
          mcpServers: [
            {
              id: "cowatch",
              enabled: true,
              transport: "streamable_http",
              url: "https://cowatch.example.test/mcp",
              trustLevel: "auto",
            },
          ],
        }),
      });
      expect(patchRes.status).toBe(200);

      // 第一轮：调用 MCP 获取图文并验证模型真实收到 image 块
      const turn1 = await rt.engine.runTurn({ mode: "chat", userText: "看看刚才那段画面" });
      expect(turn1.error).toBeUndefined();
      expect(turn1.text).toContain("看到了四宫格（共 1 张图）");
      expect(observedToolImagesPerCall[1]).toEqual([{ mimeType: "image/jpeg", data: gridB64 }]);

      // 验证 SQLite events 绝未落盘 base64
      const history = rt.events.listHistory({ limit: 20 }).items;
      expect(JSON.stringify(history)).not.toContain(gridB64);

      // 第二轮：确认跨轮自动回收，不再携带旧图 base64
      const turn2 = await rt.engine.runTurn({ mode: "chat", userText: "接着聊别的" });
      expect(turn2.error).toBeUndefined();
      expect(turn2.text).toBe("第二轮干净");
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
