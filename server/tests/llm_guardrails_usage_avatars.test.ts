import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { saveCredentials } from "../src/core/credentials.ts";
import { bootPsyberRuntime, type PsyberRuntime } from "../src/index.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";
import { DynamicChatModel } from "../src/llm/router.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function pairClient(rt: PsyberRuntime): Promise<string> {
  const { code } = rt.pairing.issueCode();
  const res = await rt.app.request("/api/v1/auth/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: "TestMac", platform: "macos" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Ring 1.5 模型省钱护栏（主备降级、思考档位、双上下文上限）、消耗统计与双人头像", () => {
  test("DynamicChatModel 主备降级链：主模型 429 时自动切备用模型，并透传 thinkingLevel", async () => {
    const dataDir = await createTempDir("psyber-fallback-");
    const clock = new VirtualClock(Date.UTC(2026, 10, 21, 14, 0, 0), "Asia/Shanghai");
    const calledModels: string[] = [];
    const seenThinkingLevels: Array<string | undefined> = [];

    const rt = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      startHeartbeatTimer: false,
    });

    try {
      rt.config.llm = {
        providers: {
          primary: { kind: "openai", authMode: "api_key" },
          backup: { kind: "anthropic", authMode: "api_key" },
        },
        slots: {
          chat: { provider: "primary", model: "gpt-primary" },
          fallbacks: [{ provider: "backup", model: "claude-backup" }],
        },
        thinking: { enabled: true, level: "high" },
        contextLimits: { chat: 50_000, solo: 120_000 },
      };
      await saveCredentials(dataDir, {
        apiKeys: { primary: "sk-p", backup: "sk-b" },
        channelTokens: {},
      });

      const router = new DynamicChatModel({
        dataDir,
        getConfig: () => rt.config,
        clientFactory: (resolved) => ({
          contextWindow: 200_000,
          modelId: resolved.modelId,
          async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
            calledModels.push(resolved.modelId);
            seenThinkingLevels.push(req.thinkingLevel);
            if (resolved.modelId === "gpt-primary") {
              yield {
                type: "error",
                code: "RATE_LIMITED",
                message: "429 too many requests",
                retryable: true,
              };
              return;
            }
            yield { type: "text_delta", delta: "备用模型已接管" };
            yield {
              type: "usage",
              inputTokens: 400,
              outputTokens: 60,
              totalTokens: 460,
              cacheReadTokens: 200,
              estimatedCostUsd: 0.0025,
            };
          },
        }),
      });

      const chunks: ChatStreamChunk[] = [];
      for await (const c of router.stream({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi", timestamp: clock.now() }],
        tools: [],
        thinkingLevel: "high",
      })) {
        chunks.push(c);
      }

      expect(calledModels).toEqual(["gpt-primary", "claude-backup"]);
      expect(seenThinkingLevels).toEqual(["high", "high"]);
      expect(router.modelId).toBe("claude-backup");
      expect(chunks.some((c) => c.type === "text_delta" && c.delta === "备用模型已接管")).toBe(true);
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("双上下文上限（contextLimits.chat）、思考档位设置校验、/llm/models 与 /llm/test 闭环", async () => {
    const dataDir = await createTempDir("psyber-llm-api-");
    const clock = new VirtualClock(Date.UTC(2026, 10, 21, 15, 0, 0), "Asia/Shanghai");
    const seenThinkingLevels: Array<string | undefined> = [];
    let turnCount = 0;

    const chatModel: ChatModelClient = {
      contextWindow: 200_000,
      modelId: "gpt-4o",
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        turnCount += 1;
        seenThinkingLevels.push(req.thinkingLevel);
        yield { type: "text_delta", delta: "收到" };
        // 返回 6000 token，超过自定义 chat 上限 5000，应立刻触发换段
        yield {
          type: "usage",
          inputTokens: 4000,
          outputTokens: 2000,
          totalTokens: 6000,
          cacheReadTokens: 3000,
          estimatedCostUsd: 0.015,
        };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      chatModel,
      startHeartbeatTimer: false,
      llmTestClientFactory: (resolved) => ({
        contextWindow: 128_000,
        modelId: resolved.modelId,
        async *stream(): AsyncIterable<ChatStreamChunk> {
          yield { type: "text_delta", delta: "OK" };
        },
      }),
    });

    try {
      const token = await pairClient(rt);
      const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      // 1. PATCH /settings 设置思考档位 low + chat 上限 5000 + provider/key
      const patchRes = await rt.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({
          llm: {
            providers: { openai: { kind: "openai", authMode: "api_key" } },
            slots: {
              chat: { provider: "openai", model: "gpt-4o" },
              fallbacks: [{ provider: "openai", model: "gpt-4o-mini" }],
            },
            thinking: { enabled: true, level: "low" },
            contextLimits: { chat: 5000, solo: 40000 },
          },
          credentials: { openai: { apiKey: "sk-test-key" } },
        }),
      });
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as {
        settings: {
          llm: {
            thinking: { enabled: boolean; level: string };
            contextLimits: { chat: number; solo: number };
          };
        };
      };
      expect(patchBody.settings.llm.thinking.level).toBe("low");
      expect(patchBody.settings.llm.contextLimits.chat).toBe(5000);

      // 非法思考档位 -> 400
      const badLevel = await rt.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ llm: { thinking: { enabled: true, level: "ultra" } } }),
      });
      expect(badLevel.status).toBe(400);

      // 2. GET /api/v1/llm/models 返回模型目录（离线读取内置目录）
      const modelsRes = await rt.app.request("/api/v1/llm/models?provider=openai", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(modelsRes.status).toBe(200);
      const modelsBody = (await modelsRes.json()) as { models: Array<{ id: string }> };
      expect(modelsBody.models.some((m) => m.id === "gpt-4o")).toBe(true);

      // 3. POST /api/v1/llm/test 一键连通测试
      const testRes = await rt.app.request("/api/v1/llm/test", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ provider: "openai", model: "gpt-4o" }),
      });
      expect(testRes.status).toBe(200);
      const testBody = (await testRes.json()) as { ok: boolean; latencyMs: number };
      expect(testBody.ok).toBe(true);
      expect(testBody.latencyMs).toBeGreaterThanOrEqual(0);

      // 4. 发消息验证 thinkingLevel === 'low' 且超过 chat=5000 上限触发换段
      const oldSess = rt.engine.getActiveSessionId();
      await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientMessageId: "cm-ctx-1", content: "测试双上下文上限" }),
      });
      await waitUntil(() => turnCount >= 1 && rt.engine.getActiveSessionId() !== oldSess);
      expect(seenThinkingLevels[0]).toBe("low");

      // 5. GET /api/v1/usage/stats 汇总今日/累计/按日/按模型与缓存命中率
      const statsRes = await rt.app.request("/api/v1/usage/stats", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(statsRes.status).toBe(200);
      const stats = (await statsRes.json()) as {
        today: { turnCount: number; inputTokens: number; cacheReadTokens: number; cacheHitRate: number; estimatedCostUsd: number };
        total: { turnCount: number; outputTokens: number };
        daily: Array<{ date: string; turnCount: number }>;
        byModel: Array<{ model: string; turnCount: number }>;
      };
      expect(stats.today.turnCount).toBe(1);
      expect(stats.today.inputTokens).toBe(4000);
      expect(stats.today.cacheReadTokens).toBe(3000);
      expect(stats.today.cacheHitRate).toBeCloseTo(3000 / 7000, 3);
      expect(stats.today.estimatedCostUsd).toBeCloseTo(0.015, 4);
      expect(stats.total.outputTokens).toBe(2000);
      expect(stats.daily).toHaveLength(1);
      expect(stats.byModel[0]!.model).toBe("gpt-4o");
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("POST /api/v1/avatars/:who 上传双人头像（落盘 pinned media 并在 /settings 回显 URL）", async () => {
    const dataDir = await createTempDir("psyber-avatars-");
    const clock = new VirtualClock(Date.UTC(2026, 10, 21, 16, 0, 0), "Asia/Shanghai");

    const rt = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      startHeartbeatTimer: false,
    });

    try {
      const token = await pairClient(rt);
      const auth = { authorization: `Bearer ${token}` };

      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
      const formUser = new FormData();
      formUser.append("file", new File([pngBytes], "me.png", { type: "image/png" }));

      const upUser = await rt.app.request("/api/v1/avatars/user", {
        method: "POST",
        headers: auth,
        body: formUser,
      });
      expect(upUser.status).toBe(200);
      const upUserBody = (await upUser.json()) as { who: string; hash: string; url: string };
      expect(upUserBody.who).toBe("user");
      expect(upUserBody.url).toBe(`/api/v1/media/${upUserBody.hash}`);

      const formRes = new FormData();
      formRes.append(
        "file",
        new File([new Uint8Array([137, 80, 78, 71, 9, 8, 7])], "resident.png", { type: "image/png" }),
      );
      const upRes = await rt.app.request("/api/v1/avatars/resident", {
        method: "POST",
        headers: auth,
        body: formRes,
      });
      expect(upRes.status).toBe(200);
      const upResBody = (await upRes.json()) as { who: string; hash: string; url: string };

      // 非法目标 -> 400
      const badTarget = await rt.app.request("/api/v1/avatars/stranger", {
        method: "POST",
        headers: auth,
        body: new FormData(),
      });
      expect(badTarget.status).toBe(400);

      // GET /settings 回显双人头像 URL
      const settingsRes = await rt.app.request("/api/v1/settings", { headers: auth });
      expect(settingsRes.status).toBe(200);
      const settings = (await settingsRes.json()) as {
        avatars: { userUrl?: string; residentUrl?: string };
      };
      expect(settings.avatars.userUrl).toBe(upUserBody.url);
      expect(settings.avatars.residentUrl).toBe(upResBody.url);
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("GET /api/v1/llm/models 支持自定义 kind 与无 API Key 的本地兼容网关自动拉取 /models", async () => {
    const dataDir = await createTempDir("psyber-custom-models-");
    const clock = new VirtualClock(Date.UTC(2026, 10, 25, 14, 0, 0), "Asia/Shanghai");
    const fetchedUrls: string[] = [];

    const rt = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      startHeartbeatTimer: false,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url === "http://localhost:7860/v1/models") {
          return new Response(
            JSON.stringify({
              data: [{ id: "gemini-4-neon" }, { id: "gemini-4-pro" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });

    try {
      const token = await pairClient(rt);
      rt.config.llm = {
        providers: {
          "AI Studio": {
            kind: "AI Studio" as "openai-compat",
            baseUrl: "http://localhost:7860/v1",
            authMode: "api_key",
            models: ["gemini-4-neon"],
          },
        },
        slots: { chat: { provider: "AI Studio", model: "gemini-4-neon" } },
        thinking: { enabled: true },
      };

      const res = await rt.app.request(
        `/api/v1/llm/models?provider=${encodeURIComponent("AI Studio")}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: Array<{ id: string }> };
      expect(fetchedUrls).toContain("http://localhost:7860/v1/models");
      expect(body.models.map((m) => m.id)).toContain("gemini-4-pro");
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
