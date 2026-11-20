import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CIRCADIAN_CONFIG, type PsyberConfig } from "../src/core/config.ts";
import { saveCredentials } from "../src/core/credentials.ts";
import type { ChatModelClient, ChatStreamChunk } from "../src/llm/client.ts";
import {
  DynamicChatModel,
  buildPiAiChatClient,
  resolveByokSlot,
  type ResolvedByokSlot,
} from "../src/llm/router.ts";

const cleanupDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `psyber-llm-router-test-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeBaseConfig(): PsyberConfig {
  return {
    instanceId: "inst-router-test",
    timezone: "Asia/Shanghai",
    door: { state: "open", note: null, updatedAt: 0 },
    auth: { devices: [] },
    circadian: { ...DEFAULT_CIRCADIAN_CONFIG },
  };
}

describe("BYOK 动态模型路由（llm/router.ts）", () => {
  test("未配置模型或 API Key 时返回 AUTH_EXPIRED；写入配置与凭证后无需重启热切换到新模型", async () => {
    const dataDir = await makeTempDir();
    const config = makeBaseConfig();
    const factoryCalls: ResolvedByokSlot[] = [];

    const fakeFactory = (resolved: ResolvedByokSlot): ChatModelClient => {
      factoryCalls.push(resolved);
      return {
        contextWindow: 128_000,
        async *stream(req): AsyncIterable<ChatStreamChunk> {
          yield {
            type: "text_delta",
            delta: `ok:${resolved.providerId}/${resolved.modelId}:temp=${req.temperature ?? "none"}`,
          };
        },
      };
    };

    const dynamic = new DynamicChatModel({
      dataDir,
      getConfig: () => config,
      slot: "chat",
      clientFactory: fakeFactory,
    });

    // 1. 未配置 -> 返回标准 AUTH_EXPIRED 引导错误，不崩溃
    const firstChunks: ChatStreamChunk[] = [];
    for await (const c of dynamic.stream({ systemPrompt: "sys", messages: [], tools: [] })) {
      firstChunks.push(c);
    }
    expect(firstChunks).toHaveLength(1);
    expect(firstChunks[0].type).toBe("error");
    if (firstChunks[0].type === "error") {
      expect(firstChunks[0].code).toBe("AUTH_EXPIRED");
    }
    expect(factoryCalls).toHaveLength(0);

    // 2. 热更新 config + credentials.json -> 下一轮立即命中新模型并缓存
    config.llm = {
      providers: {
        anthropic: { kind: "anthropic", authMode: "api_key" },
      },
      slots: {
        chat: { provider: "anthropic", model: "claude-sonnet-4-5", temperature: 0.7 },
      },
      thinking: { enabled: true },
    };
    await saveCredentials(dataDir, {
      apiKeys: { anthropic: "demo-anthropic-key" },
      channelTokens: {},
    });

    const secondChunks: ChatStreamChunk[] = [];
    for await (const c of dynamic.stream({ systemPrompt: "sys", messages: [], tools: [] })) {
      secondChunks.push(c);
    }
    expect(secondChunks).toEqual([
      { type: "text_delta", delta: "ok:anthropic/claude-sonnet-4-5:temp=0.7" },
    ]);
    expect(factoryCalls).toHaveLength(1);
    expect(dynamic.contextWindow).toBe(128_000);

    // 配置未变更时复用缓存，不重复构建
    for await (const _ of dynamic.stream({ systemPrompt: "sys", messages: [], tools: [] })) {
      // consume
    }
    expect(factoryCalls).toHaveLength(1);

    // 3. 切换为 openai-compat 自定义地址 -> 立即失效旧缓存并重建
    config.llm.providers.deepseek = {
      kind: "openai-compat",
      authMode: "api_key",
      baseUrl: "https://api.example.invalid/v1",
    };
    config.llm.slots.chat = { provider: "deepseek", model: "deepseek-chat" };
    await saveCredentials(dataDir, {
      apiKeys: {
        anthropic: "demo-anthropic-key",
        deepseek: "demo-deepseek-key",
      },
      channelTokens: {},
    });

    const thirdChunks: ChatStreamChunk[] = [];
    for await (const c of dynamic.stream({ systemPrompt: "sys", messages: [], tools: [] })) {
      thirdChunks.push(c);
    }
    expect(thirdChunks).toEqual([
      { type: "text_delta", delta: "ok:deepseek/deepseek-chat:temp=none" },
    ]);
    expect(factoryCalls).toHaveLength(2);
  });

  test("memory_task 槽位缺省共用 chat；4 类 Provider（含 openai-compat）均可离线构造 PiAiChatClient", () => {
    const config = makeBaseConfig();
    config.llm = {
      providers: {
        anthropic: { kind: "anthropic", authMode: "api_key" },
        openai: { kind: "openai", authMode: "api_key" },
        google: { kind: "google", authMode: "api_key" },
        local: {
          kind: "openai-compat",
          authMode: "api_key",
          baseUrl: "http://localhost:11434/v1",
        },
      },
      slots: {
        chat: { provider: "anthropic", model: "claude-sonnet-4-5" },
      },
      thinking: { enabled: true },
    };

    const creds = {
      apiKeys: {
        anthropic: "demo-k1",
        openai: "demo-k2",
        google: "demo-k3",
        local: "demo-k4",
      },
      channelTokens: {},
    };

    // memory_task 缺省时自动回落 chat
    const shared = resolveByokSlot(config, creds, "memory_task");
    expect(shared.ok).toBe(true);
    if (shared.ok) {
      expect(shared.slot.providerId).toBe("anthropic");
    }

    // 4 类 Provider 均能离线构造 PiAiChatClient（零外网调用）
    for (const [providerId, kind, modelId, baseUrl] of [
      ["anthropic", "anthropic", "claude-sonnet-4-5", undefined],
      ["openai", "openai", "gpt-4o", undefined],
      ["google", "google", "gemini-2.5-flash", undefined],
      ["local", "openai-compat", "qwen2.5:14b", "http://localhost:11434/v1"],
    ] as const) {
      const client = buildPiAiChatClient({
        providerId,
        kind,
        modelId,
        apiKey: "demo-key",
        baseUrl,
      });
      expect(client.contextWindow).toBeGreaterThan(0);
    }
  });
});
