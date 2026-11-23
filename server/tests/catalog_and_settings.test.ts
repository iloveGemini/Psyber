import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { bootPsyberRuntime } from "../src/index.ts";
import { ModelCatalogService, normalizeModelKey, parseModelsDevPayload } from "../src/llm/catalog.ts";

describe("ModelCatalogService & Settings Extensions", () => {
  test("parses models.dev payload and resolves normalized/overridden models", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "psyber-catalog-"));
    try {
      const mockPayload = {
        google: {
          id: "google",
          name: "Google",
          models: {
            "gemini-4-argon": {
              id: "gemini-4-argon",
              name: "Gemini 4 Argon",
              reasoning: true,
              tool_call: true,
              limit: { context: 1_048_576, output: 65_536 },
              modalities: { input: ["text", "image", "audio", "video", "pdf"], output: ["text"] },
              cost: { input: 0.6, output: 3.0, cache_read: 0.15 },
            },
          },
        },
      };

      const parsed = parseModelsDevPayload(mockPayload);
      expect(parsed.length).toBe(1);
      expect(parsed[0]!.contextWindow).toBe(1_048_576);
      expect(parsed[0]!.maxTokens).toBe(65_536);
      expect(parsed[0]!.inputModalities).toEqual(["text", "image", "audio", "video", "pdf"]);

      const catalog = new ModelCatalogService(tmpDir);
      const syncRes = await catalog.syncFromRemote({
        nowMs: 1_700_000_000_000,
        fetchImpl: (async () =>
          new Response(JSON.stringify(mockPayload), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      });
      expect(syncRes.ok).toBe(true);
      expect(syncRes.count).toBe(1);

      expect(normalizeModelKey("custom/google/gemini-4-argon:free")).toBe("gemini-4-argon");
      const matched = catalog.lookup("custom/google/gemini-4-argon-preview:free");
      expect(matched).not.toBeNull();
      expect(matched!.contextWindow).toBe(1_048_576);
      expect(matched!.maxTokens).toBe(65_536);
      expect(matched!.reasoning).toBe(true);
      expect(matched!.source).toBe("catalog");

      const overridden = catalog.lookup("gemini-4-argon", {
        override: { maxTokens: 32_768, inputModalities: ["text"] },
      });
      expect(overridden!.maxTokens).toBe(32_768);
      expect(overridden!.inputModalities).toEqual(["text"]);
      expect(overridden!.source).toBe("override");

      // 重新从磁盘加载缓存
      const reloaded = new ModelCatalogService(tmpDir);
      await reloaded.loadFromDisk();
      expect(reloaded.getStatus().modelCount).toBe(1);
      expect(reloaded.lookup("gemini-4-argon")?.maxTokens).toBe(65_536);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("settings returns full tool catalog with Tier 1 locked and usage supports ?days filter", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "psyber-settings-ext-"));
    const clock = new VirtualClock(Date.parse("2026-11-22T12:00:00+08:00"));
    const runtime = await bootPsyberRuntime({
      dataDir: tmpDir,
      clock,
      startHeartbeatTimer: false,
      catchUpMissedBedtime: false,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            openai: {
              models: {
                "gpt-6-mini": {
                  id: "gpt-6-mini",
                  name: "GPT-6 Mini",
                  reasoning: true,
                  limit: { context: 512_000, output: 64_000 },
                  modalities: { input: ["text", "image"], output: ["text"] },
                },
              },
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    try {
      const pair = runtime.pairing.issueCode();
      const pairRes = await runtime.app.request("/api/v1/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pair.code, deviceName: "TestMac", platform: "macos" }),
      });
      const { token } = (await pairRes.json()) as { token: string };
      const auth = { authorization: `Bearer ${token}` };

      // 1. 拉取设置：包含全部工具与系统路径信息
      const getRes = await runtime.app.request("/api/v1/settings", { headers: auth });
      expect(getRes.status).toBe(200);
      const settings = (await getRes.json()) as {
        tools: Array<{ name: string; tier: number; locked: boolean; enabled: boolean }>;
        system: { version: string; dataDir: string; configPath: string; memoryDir: string };
      };
      expect(settings.tools.length).toBeGreaterThanOrEqual(12);
      const readTool = settings.tools.find((t) => t.name === "read");
      expect(readTool?.locked).toBe(true);
      expect(readTool?.enabled).toBe(true);
      const shareTool = settings.tools.find((t) => t.name === "share");
      expect(shareTool?.locked).toBe(false);
      expect(shareTool?.enabled).toBe(true);
      expect(settings.system.dataDir).toBe(tmpDir);
      expect(settings.system.configPath).toBe(path.join(tmpDir, "config.json"));

      // 2. 尝试关闭 Tier 1 元工具（应被忽略）与关闭 Tier 3 扩展工具（应生效）
      const patchRes = await runtime.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ disabledTools: ["read", "share"] }),
      });
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as {
        settings: {
          tools: Array<{ name: string; locked: boolean; enabled: boolean }>;
          disabledTools: string[];
        };
      };
      expect(patched.settings.disabledTools).toEqual(["share"]);
      expect(patched.settings.tools.find((t) => t.name === "read")?.enabled).toBe(true);
      expect(patched.settings.tools.find((t) => t.name === "share")?.enabled).toBe(false);

      // 3. 同步模型目录接口
      const syncRes = await runtime.app.request("/api/v1/llm/catalog/sync", {
        method: "POST",
        headers: auth,
      });
      expect(syncRes.status).toBe(200);
      const syncBody = (await syncRes.json()) as { ok: boolean; count: number };
      expect(syncBody.ok).toBe(true);
      expect(syncBody.count).toBe(1);

      // 4. 用量统计按天筛选
      clock.setTime(Date.parse("2026-11-10T10:00:00+08:00"));
      runtime.events.append({
        sessionId: "s1",
        role: "assistant",
        kind: "chat",
        content: "old",
        metadata: {
          model: "gpt-old",
          usage: { inputTokens: 1000, outputTokens: 200, estimatedCostUsd: 0.01 },
        },
      });
      clock.setTime(Date.parse("2026-11-22T12:00:00+08:00"));
      runtime.events.append({
        sessionId: "s1",
        role: "assistant",
        kind: "chat",
        content: "today",
        metadata: {
          model: "gpt-new",
          usage: { inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.005 },
        },
      });

      const stats7Res = await runtime.app.request("/api/v1/usage/stats?days=7", { headers: auth });
      expect(stats7Res.status).toBe(200);
      const stats7 = (await stats7Res.json()) as {
        rangeDays: number | null;
        range: { turnCount: number; inputTokens: number };
        total: { turnCount: number; inputTokens: number };
        byModel: Array<{ model: string }>;
      };
      expect(stats7.rangeDays).toBe(7);
      expect(stats7.range.turnCount).toBe(1);
      expect(stats7.range.inputTokens).toBe(500);
      expect(stats7.total.turnCount).toBe(2);
      expect(stats7.byModel.map((m) => m.model)).toEqual(["gpt-new"]);
    } finally {
      await runtime.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
