import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashBearerToken } from "../src/api/app.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { saveConfig } from "../src/core/config.ts";
import { bootPsyberRuntime } from "../src/index.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("内置观影伴看插件（cinema · HTTP /pull 零延迟桥接、Tier 2 工具与防误结束巡检）", () => {
  test("开启/前置 /pull?clear=1 自动附带四宫格图与时间轴、跨轮不落盘 base64、切剧同步与停采联动", async () => {
    const dataDir = await makeTempDir("psyber-cinema-pull-");
    const clock = new VirtualClock(Date.parse("2026-11-28T02:00:00Z"), "Asia/Shanghai");
    const gridBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const gridB64 = Buffer.from(gridBytes).toString("base64");

    const bridgeCalls: string[] = [];
    let currentDrama = "测试剧甲";
    let currentProgress = "12:03 / 42:00";
    let hasGridOnPull = true;

    const mockFetch: typeof fetch = (async (input) => {
      const url = new URL(String(input));
      bridgeCalls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/resume") {
        return new Response(JSON.stringify({ ok: true, cowatch: true }), { status: 200 });
      }
      if (url.pathname === "/pause") {
        return new Response(JSON.stringify({ ok: true, cowatch: false }), { status: 200 });
      }
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            adapter: "generic",
            cowatch: true,
            active_drama: currentDrama,
            episode_title: `${currentDrama} 第3集`,
            progress: currentProgress,
            content_mode: "drama",
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/pull") {
        return new Response(
          JSON.stringify({
            drama_name: currentDrama,
            content_mode: "drama",
            episode_title: `${currentDrama} 第3集`,
            latest_playback_progress: currentProgress,
            is_paused: false,
            grid_image_path: hasGridOnPull ? "/tmp/fake_grid.jpg" : "",
            characters: [{ name: "角色A" }],
            prompt_block: `<video_cowatch_context>\n正在观看：${currentDrama} 第3集 | 进度：${currentProgress}\n📍 画面 #1 (12:03)\n  「台词测试」\n</video_cowatch_context>`,
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/api/grid.jpg") {
        return new Response(gridBytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url.pathname === "/windows") {
        return new Response(
          JSON.stringify({
            windows: [{ window_id: 2026, owner: "IINA", title: "测试剧乙 第1集" }],
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/select_window") {
        currentDrama = "测试剧乙";
        return new Response(
          JSON.stringify({ success: true, active_drama: currentDrama }),
          { status: 200 },
        );
      }
      if (url.pathname === "/set_mode") {
        const mode = url.searchParams.get("mode") ?? "auto";
        return new Response(
          JSON.stringify({ success: true, content_mode: mode, content_mode_override: mode }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const seenToolLists: string[][] = [];
    const seenUserImagesPerTurn: number[] = [];
    const seenUserTextsPerTurn: string[] = [];
    const seenHistoryHasLeakedBase64: boolean[] = [];

    const mockModel: ChatModelClient = {
      modelId: "mock-vision-chat",
      contextWindow: 100_000,
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        seenToolLists.push(req.tools.map((t) => t.name));
        const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
        const priorMessages = req.messages.slice(0, -1);
        seenHistoryHasLeakedBase64.push(JSON.stringify(priorMessages).includes(gridB64));
        if (lastUser && lastUser.role === "user") {
          if (Array.isArray(lastUser.content)) {
            const imgs = lastUser.content.filter((p) => p.type === "image");
            const txt = lastUser.content
              .filter((p) => p.type === "text")
              .map((p) => (p.type === "text" ? p.text : ""))
              .join("\n");
            seenUserImagesPerTurn.push(imgs.length);
            seenUserTextsPerTurn.push(txt);
          } else {
            seenUserImagesPerTurn.push(0);
            seenUserTextsPerTurn.push(lastUser.content);
          }
        }
        yield { type: "text_delta", delta: `收到了，当前看的是 ${currentDrama}` };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: mockModel,
      fetchImpl: mockFetch,
      startHeartbeatTimer: false,
    });

    try {
      const token = "psb_cinema_test_1";
      rt.config.auth.devices.push({
        deviceId: "dev-1",
        tokenHash: hashBearerToken(token),
        deviceName: "Mac",
        platform: "macos",
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
      });
      await saveConfig(dataDir, rt.config);

      // 1. 探测活动状态与采集源连通性
      const probeRes = await rt.app.request("/api/v1/activities", {
        headers: makeAuthHeader(token),
      });
      expect(probeRes.status).toBe(200);
      const probeJson = (await probeRes.json()) as {
        activeSession: unknown;
        cinema: { reachable: boolean; health?: { active_drama?: string } };
      };
      expect(probeJson.activeSession).toBeNull();
      expect(probeJson.cinema.reachable).toBe(true);
      expect(probeJson.cinema.health?.active_drama).toBe("测试剧甲");

      // 2. 开启观影（自动 /resume + 探测剧名），重复开启返 409
      const sseEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
      const unsub = rt.sse.subscribe((frame) => {
        sseEvents.push({ event: frame.event, data: (frame.data ?? {}) as Record<string, unknown> });
      });

      const startRes = await rt.app.request("/api/v1/activities/cinema/start", {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(startRes.status).toBe(200);
      const startJson = (await startRes.json()) as {
        session: { id: string; slug: string; title: string; status: string };
      };
      expect(startJson.session.slug).toBe("cinema");
      expect(startJson.session.title).toBe("测试剧甲");
      expect(bridgeCalls).toContain("/resume");

      const dupStartRes = await rt.app.request("/api/v1/activities/cinema/start", {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(dupStartRes.status).toBe(409);

      // 3. 代理四宫格预览、窗口列举/切换与模式切换
      const gridRes = await rt.app.request("/api/v1/activities/cinema/grid", {
        headers: makeAuthHeader(token),
      });
      expect(gridRes.status).toBe(200);
      expect(gridRes.headers.get("content-type")).toBe("image/jpeg");

      const winsRes = await rt.app.request("/api/v1/activities/cinema/windows", {
        headers: makeAuthHeader(token),
      });
      expect(winsRes.status).toBe(200);
      const winsJson = (await winsRes.json()) as { windows: Array<{ window_id: number }> };
      expect(winsJson.windows[0]?.window_id).toBe(2026);

      const selRes = await rt.app.request("/api/v1/activities/cinema/window", {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ windowId: 2026 }),
      });
      expect(selRes.status).toBe(200);
      expect(rt.cinema.getActiveSession()?.title).toBe("测试剧乙");

      const modeRes = await rt.app.request("/api/v1/activities/cinema/mode", {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ mode: "variety" }),
      });
      expect(modeRes.status).toBe(200);

      // 4. 第一轮发消息：零工具轮次前置注入四宫格图 + <video_cowatch_context>；不污染 Tier 1 tools[]
      const turn1 = await rt.engine.runTurn({ mode: "chat", userText: "这段也太好笑了" });
      expect(turn1.error).toBeUndefined();
      expect(bridgeCalls).toContain("/pull?clear=1");
      expect(seenUserImagesPerTurn[0]).toBe(1);
      expect(seenUserTextsPerTurn[0]).toContain("<active_activity");
      expect(seenUserTextsPerTurn[0]).toContain("<video_cowatch_context>");
      expect(seenToolLists[0]?.every((t) => !t.startsWith("cinema."))).toBe(true);

      // 5. 第二轮发消息（无新图）：确认历史消息绝不残留上一轮四宫格 base64，SQLite events 也绝不存 base64
      hasGridOnPull = false;
      currentProgress = "14:20 / 42:00";
      const turn2 = await rt.engine.runTurn({ mode: "chat", userText: "后来怎么了" });
      expect(turn2.error).toBeUndefined();
      expect(seenUserImagesPerTurn[1]).toBe(0);
      expect(seenHistoryHasLeakedBase64[1]).toBe(false);
      expect(JSON.stringify(rt.events.listHistory({ limit: 20 }).items)).not.toContain(gridB64);

      // 6. 结束观影：联动 /pause 并广播 activity.updated(session=null)
      const endRes = await rt.app.request("/api/v1/activities/cinema/end", {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ reason: "user_ended" }),
      });
      expect(endRes.status).toBe(200);
      expect(bridgeCalls).toContain("/pause");
      expect(rt.cinema.getActiveSession()).toBeNull();
      expect(sseEvents.some((e) => e.event === "activity.updated" && e.data.session === null)).toBe(true);
      unsub();

      // 7. 设置页 PATCH cinema 配置校验与持久化
      const settingsPatch = await rt.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({
          cinema: { bridgeUrl: "http://127.0.0.1:19999", timeoutMs: 3000, syncPauseResume: false },
        }),
      });
      expect(settingsPatch.status).toBe(200);
      const settingsJson = (await settingsPatch.json()) as {
        settings: { cinema: { bridgeUrl: string; timeoutMs: number; syncPauseResume: boolean } };
      };
      expect(settingsJson.settings.cinema).toEqual({
        bridgeUrl: "http://127.0.0.1:19999",
        timeoutMs: 3000,
        syncPauseResume: false,
      });
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("观影 Tier 2 工具（save_character / get_frame_at 临时带图）、采集离线降级与心跳防误结束巡检", async () => {
    const dataDir = await makeTempDir("psyber-cinema-tools-");
    const clock = new VirtualClock(Date.parse("2026-11-28T03:00:00Z"), "Asia/Shanghai");
    const lookbackImgPath = path.join(dataDir, "lookback_frame.jpg");
    const lookbackBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
    const lookbackB64 = Buffer.from(lookbackBytes).toString("base64");
    await fs.writeFile(lookbackImgPath, lookbackBytes);

    let bridgeOffline = false;
    const savedChars: string[] = [];

    const mockFetch: typeof fetch = (async (input) => {
      if (bridgeOffline) {
        throw new Error("ECONNREFUSED");
      }
      const url = new URL(String(input));
      if (url.pathname === "/resume" || url.pathname === "/pause") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({ ok: true, active_drama: "悬疑剧", progress: "20:10 / 45:00" }),
          { status: 200 },
        );
      }
      if (url.pathname === "/pull") {
        return new Response(
          JSON.stringify({
            drama_name: "悬疑剧",
            episode_title: "悬疑剧 第5集",
            latest_playback_progress: "20:10 / 45:00",
            grid_image_path: "",
            prompt_block: "<video_cowatch_context>\n[20:05] ⚡ 纯画面镜头切换\n</video_cowatch_context>",
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/save_character") {
        const name = url.searchParams.get("name") ?? "";
        savedChars.push(name);
        return new Response(JSON.stringify({ ok: true, name, avatar_cropped: true }), { status: 200 });
      }
      if (url.pathname === "/frame_at") {
        return new Response(
          JSON.stringify({
            ok: true,
            summary: "已回看 20:05 历史帧",
            image_path: lookbackImgPath,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    let callCount = 0;
    let sawLookbackImageInToolResult = false;
    const mockModel: ChatModelClient = {
      modelId: "mock-chat",
      contextWindow: 100_000,
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        callCount += 1;
        if (callCount === 1) {
          yield {
            type: "tool_call",
            id: "tc_save_char",
            name: "call_tool",
            args: {
              name: "cinema.save_character",
              arguments: { name: "侦探甲", from_panel: 2, visual_traits: "风衣、眼镜" },
            },
          };
          return;
        }
        if (callCount === 2) {
          yield {
            type: "tool_call",
            id: "tc_frame_at",
            name: "call_tool",
            args: { name: "cinema.get_frame_at", arguments: { progress: "20:05", count: 2 } },
          };
          return;
        }
        if (callCount === 3) {
          const lastTool = [...req.messages].reverse().find((m) => m.role === "toolResult");
          if (
            lastTool?.role === "toolResult" &&
            lastTool.images?.some((img) => img.data === lookbackB64)
          ) {
            sawLookbackImageInToolResult = true;
          }
          yield { type: "text_delta", delta: "记下角色也回看到刚才那帧了" };
          return;
        }
        yield { type: "text_delta", delta: "采集断了也能正常聊" };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: mockModel,
      fetchImpl: mockFetch,
      startHeartbeatTimer: false,
    });

    try {
      const started = await rt.cinema.start();
      expect(started.ok).toBe(true);

      // 1. 工具链路：save_character + get_frame_at 临时图片送入模型
      const turn1 = await rt.engine.runTurn({ mode: "chat", userText: "记住第2格是侦探甲，再帮我回看20:05" });
      expect(turn1.error).toBeUndefined();
      expect(savedChars).toEqual(["侦探甲"]);
      expect(sawLookbackImageInToolResult).toBe(true);
      expect(JSON.stringify(rt.events.listHistory({ limit: 20 }).items)).not.toContain(lookbackB64);

      // 2. 采集服务宕机：安全降级不阻塞主对话
      bridgeOffline = true;
      const turn2 = await rt.engine.runTurn({ mode: "chat", userText: "采集停了还能说话吗" });
      expect(turn2.error).toBeUndefined();
      expect(turn2.text).toBe("采集断了也能正常聊");

      // 3. 防误结束巡检：35 分钟未互动转 stale；4 小时未互动自动软结束
      clock.advance(35 * 60_000);
      await rt.tickHeartbeat();
      expect(rt.cinema.getActiveSession()?.status).toBe("stale");

      clock.advance(4 * 60 * 60_000);
      await rt.tickHeartbeat();
      expect(rt.cinema.getActiveSession()).toBeNull();
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
