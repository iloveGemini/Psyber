import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../src/api/app.ts";
import { PairingManager } from "../src/api/pairing.ts";
import { runMemoryTidyTask } from "../src/engine/tidy.ts";
import { evaluateHeartbeat, getSleepWindowStatus, renderCircadianState } from "../src/mood/circadian.ts";
import { NotificationHub } from "../src/notifications/hub.ts";
import { createTestContext, type TestContext } from "./helpers.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("Ring 1 切片 3: 作息心跳、异步单轮整理、离线通知与配对/初生/媒体/设置端点", () => {
  test("circadian.ts: 跨午夜 bedtime 同一夜只跑一次，主动唤醒遵守冷却与连续未回上限 2", () => {
    const tz = "Asia/Shanghai";
    // 2026-11-20 23:45 Asia/Shanghai = 2026-11-20 15:45 UTC
    const t2345 = Date.UTC(2026, 10, 20, 15, 45, 0);
    // 2026-11-21 00:15 Asia/Shanghai = 2026-11-20 16:15 UTC
    const t0015 = Date.UTC(2026, 10, 20, 16, 15, 0);

    expect(getSleepWindowStatus(t2345, tz)).toEqual({ inSleepWindow: true, nightDate: "2026-11-20" });
    expect(getSleepWindowStatus(t0015, tz)).toEqual({ inSleepWindow: true, nightDate: "2026-11-20" });
    expect(renderCircadianState(t2345, tz)).toBe("夜间静默窗");

    // 23:45 未跑过 bedtime -> sleep_tidy
    const d1 = evaluateHeartbeat({
      nowMs: t2345,
      timeZone: tz,
      doorState: "open",
      lastBedtimeNightDate: null,
      lastInteractionMs: t2345 - 60_000,
      lastWakeMs: null,
      consecutiveUnansweredWakes: 0,
      unreadDoorNotesCount: 0,
      oldestUnreadDoorNoteMs: null,
    });
    expect(d1).toEqual({ action: "sleep_tidy", nightDate: "2026-11-20" });

    // 00:15 同一夜已跑过 -> idle，绝不重跑
    const d2 = evaluateHeartbeat({
      nowMs: t0015,
      timeZone: tz,
      doorState: "open",
      lastBedtimeNightDate: "2026-11-20",
      lastInteractionMs: t2345 - 60_000,
      lastWakeMs: null,
      consecutiveUnansweredWakes: 0,
      unreadDoorNotesCount: 0,
      oldestUnreadDoorNoteMs: null,
    });
    expect(d2).toEqual({ action: "idle" });

    // 白天 14:00（06:00 UTC），连续未回 >= 2 时彻底静默
    const t1400 = Date.UTC(2026, 10, 21, 6, 0, 0);
    expect(renderCircadianState(t1400, tz)).toBe("清醒");
    const capped = evaluateHeartbeat({
      nowMs: t1400,
      timeZone: tz,
      doorState: "open",
      lastBedtimeNightDate: "2026-11-20",
      lastInteractionMs: t1400 - 5 * 3_600_000,
      lastWakeMs: t1400 - 4 * 3_600_000,
      consecutiveUnansweredWakes: 2,
      unreadDoorNotesCount: 0,
      oldestUnreadDoorNoteMs: null,
    });
    expect(capped).toEqual({ action: "idle" });

    // 关门但有未读门缝纸条且已过 30m -> proactive
    const noteWake = evaluateHeartbeat({
      nowMs: t1400,
      timeZone: tz,
      doorState: "closed",
      lastBedtimeNightDate: "2026-11-20",
      lastInteractionMs: t1400 - 60_000,
      lastWakeMs: null,
      consecutiveUnansweredWakes: 0,
      unreadDoorNotesCount: 1,
      oldestUnreadDoorNoteMs: t1400 - 35 * 60_000,
    });
    expect(noteWake.action).toBe("proactive");
  });

  test("NotificationHub: 前台活跃抑制、睡眠窗回调拦截 wake、离线 desktop + webhook（含 headers/credentialKey）扇出", async () => {
    ctx = await createTestContext({
      initialTimeMs: Date.UTC(2026, 10, 20, 6, 0, 0), // 14:00 Asia/Shanghai
    });
    ctx.config.notifications = {
      desktop: { enabled: true },
      webhook: {
        enabled: true,
        url: "https://mock.local/hook",
        credentialKey: "hook_main",
        headers: { "x-custom-tag": "psyber" },
      },
    };

    let fg = true;
    const desktopSent: string[] = [];
    const webhookCalls: Array<{ headers: Record<string, string>; body: string }> = [];

    const hub = new NotificationHub({
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      hasActiveForegroundClient: () => fg,
      isInSleepWindow: () =>
        getSleepWindowStatus(ctx!.clock.now(), ctx!.config.timezone, ctx!.config.circadian).inSleepWindow,
      getCredential: async (key) => (key === "hook_main" ? "secret-hook-token" : null),
      desktopSender: async (p) => {
        desktopSent.push(p.body);
      },
      fetchImpl: (async (_url, init) => {
        webhookCalls.push({
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: String(init?.body ?? ""),
        });
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });

    // 前台在线时抑制推送
    const rFg = await hub.notify({ kind: "wake", title: "Psyber", body: "想起你了" });
    expect(rFg.suppressedReason).toBe("foreground_active");
    expect(desktopSent.length).toBe(0);

    // 切后台后双通道成功扇出，且 webhook 携带 credentialKey 令牌与自定义头
    fg = false;
    const rBg = await hub.notify({ kind: "wake", title: "Psyber", body: "想起你了" });
    expect(rBg.sentChannels).toEqual(["desktop", "webhook"]);
    expect(desktopSent).toEqual(["想起你了"]);
    expect(webhookCalls.length).toBe(1);
    expect(webhookCalls[0].headers.authorization).toBe("Bearer secret-hook-token");
    expect(webhookCalls[0].headers["x-custom-tag"]).toBe("psyber");

    // 切到深夜 23:45，wake 被睡眠窗静默拦截
    ctx.clock.setTime(Date.UTC(2026, 10, 20, 15, 45, 0));
    const rNight = await hub.notify({ kind: "wake", title: "Psyber", body: "晚安" });
    expect(rNight.suppressedReason).toBe("sleep_window");

    // 开启勿扰模式后，即使在白天，wake 也被 user_undisturbed 拦截；而 bypassSuppression 可穿透测试
    ctx.clock.setTime(Date.UTC(2026, 10, 20, 6, 0, 0));
    ctx.config.userStatus = { undisturbed: true, updatedAt: ctx.clock.now() };
    const rDnd = await hub.notify({ kind: "wake", title: "Psyber", body: "你在吗" });
    expect(rDnd.suppressedReason).toBe("user_undisturbed");

    const rTestBypass = await hub.notify(
      { kind: "test", title: "Psyber", body: "测试通知" },
      { bypassSuppression: true },
    );
    expect(rTestBypass.sentChannels).toEqual(["desktop", "webhook"]);
  });

  test("NotificationHub & /settings: Bark + ntfy 扇出与凭证脱敏落盘、/notifications/test 穿透测试", async () => {
    ctx = await createTestContext({
      initialTimeMs: Date.UTC(2026, 10, 20, 6, 0, 0),
    });
    const pairing = new PairingManager(ctx.clock);
    const issued = pairing.issueCode();

    const pushedCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const hub = new NotificationHub({
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      hasActiveForegroundClient: () => true, // 即使前台在线，/notifications/test 也应穿透发送
      desktopSender: async () => {},
      getCredential: async (key) => {
        const { loadCredentials } = await import("../src/core/credentials.ts");
        const creds = await loadCredentials(ctx!.dataDir);
        return creds.channelTokens?.[key] ?? null;
      },
      fetchImpl: (async (url, init) => {
        pushedCalls.push({
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
    });

    const app = createApp({
      version: "0.1.0",
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      getActiveSessionId: () => "sess-1",
      dataDir: ctx.dataDir,
      db: ctx.db,
      memoryIndex: ctx.index,
      pairing,
      notifications: hub,
    });

    const pairRes = await app.request("/api/v1/auth/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code, deviceName: "iPhone", platform: "ios" }),
    });
    const pairJson = (await pairRes.json()) as { token: string };
    const authHeaders = {
      authorization: `Bearer ${pairJson.token}`,
      "content-type": "application/json",
    };

    // 1. 保存 Bark + ntfy 配置与密钥：密钥应落入 credentials.json，不出现在 config.json 与 GET /settings
    const patchRes = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        notifications: {
          bark: { enabled: true, serverUrl: "https://bark.example.com" },
          ntfy: { enabled: true, serverUrl: "https://ntfy.example.com", topic: "psyber-room" },
        },
        notificationSecrets: {
          barkDeviceKey: "bark-secret-key-001",
          ntfyToken: "ntfy-secret-tok-002",
        },
      }),
    });
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as {
      settings: {
        notifications: {
          hasBarkKey?: boolean;
          hasNtfyToken?: boolean;
          bark: { enabled: boolean; serverUrl?: string };
          ntfy: { enabled: boolean; serverUrl?: string; topic?: string };
        };
      };
    };
    expect(patchJson.settings.notifications.bark.enabled).toBe(true);
    expect(patchJson.settings.notifications.hasBarkKey).toBe(true);
    expect(patchJson.settings.notifications.ntfy.enabled).toBe(true);
    expect(patchJson.settings.notifications.ntfy.topic).toBe("psyber-room");
    expect(patchJson.settings.notifications.hasNtfyToken).toBe(true);

    const configText = await fs.readFile(path.join(ctx.dataDir, "config.json"), "utf8");
    expect(configText).not.toContain("bark-secret-key-001");
    expect(configText).not.toContain("ntfy-secret-tok-002");

    // 2. 调用 POST /api/v1/notifications/test 验证穿透前台抑制并正确扇出到 Bark 与 ntfy
    const testRes = await app.request("/api/v1/notifications/test", {
      method: "POST",
      headers: authHeaders,
    });
    expect(testRes.status).toBe(200);
    const testJson = (await testRes.json()) as { sentChannels: string[]; failedChannels: string[] };
    expect(testJson.sentChannels).toEqual(["desktop", "bark", "ntfy"]);
    expect(testJson.failedChannels).toEqual([]);

    expect(pushedCalls.length).toBe(2);
    expect(pushedCalls[0].url).toBe("https://bark.example.com/push");
    expect(pushedCalls[0].body.device_key).toBe("bark-secret-key-001");
    expect(pushedCalls[0].body.url).toBe("psyber://open");
    expect(pushedCalls[1].url).toBe("https://ntfy.example.com");
    expect(pushedCalls[1].body.topic).toBe("psyber-room");
    expect(pushedCalls[1].headers.authorization).toBe("Bearer ntfy-secret-tok-002");
  });

  test("runMemoryTidyTask: 沙箱外越界路径绝不进回滚备份；模型异常回滚磁盘；bedtime 先排空对话再汇总当日卡片", async () => {
    ctx = await createTestContext();
    ctx.events.append({
      sessionId: "s1",
      turnId: "t1",
      role: "user",
      kind: "door_note",
      content: "买了一袋草莓放冰箱",
    });
    expect(ctx.events.countUnreadDoorNotes()).toBe(1);

    const originalConfigText = await fs.readFile(path.join(ctx.dataDir, "config.json"), "utf8");
    const mockChat = new MockChatModel();

    // 1. 模拟先尝试越界写 ../config.json（被沙箱拒写），再写合法新卡，第 2 步模型报错 -> 仅回滚合法新卡，config.json 毫发无损
    mockChat.queueStream(() => [
      {
        type: "tool_call",
        id: "tc-escape",
        name: "write",
        args: { path: "../config.json", content: "hacked" },
      },
      {
        type: "tool_call",
        id: "tc-fail-1",
        name: "write",
        args: {
          path: "daily/2026-11-20-strawberry.md",
          content: "---\ntitle: 草莓\nkind: episode\n---\n买了草莓。\n",
        },
      },
    ]);
    mockChat.queueStream(() => [
      { type: "error", code: "PROVIDER_ERROR", message: "502 bad gateway", retryable: true },
    ]);

    const failed = await runMemoryTidyTask(
      {
        db: ctx.db,
        dataDir: ctx.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: ctx.clock,
        events: ctx.events,
        memoryIndex: ctx.index,
        memoryTools: ctx.tools,
        chatModel: mockChat,
      },
      { taskType: "daily_wrapup" },
    );
    expect(failed.ok).toBe(false);
    expect(ctx.events.getCursor("daily_wrapup")).toBeNull();
    expect(ctx.index.getRow("daily/2026-11-20-strawberry.md")).toBeNull();
    expect(await fs.readFile(path.join(ctx.dataDir, "config.json"), "utf8")).toBe(originalConfigText);

    // 2. bedtime 模式：先自动排空 daily_wrapup 写入草莓卡，再在 bedtime 轮注入当日已整理卡片摘要并更新 gist/days
    mockChat.queueStream(() => [
      {
        type: "tool_call",
        id: "tc-drain-1",
        name: "write",
        args: {
          path: "daily/2026-11-20-strawberry.md",
          content: "---\ntitle: 草莓\nkind: episode\n---\n对方买了一袋草莓放冰箱。\n",
        },
      },
    ]);
    mockChat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "记录冰箱里的草莓"}' }]);
    // bedtime 总结轮
    mockChat.queueStream(() => [
      {
        type: "tool_call",
        id: "tc-bed-1",
        name: "write",
        args: {
          path: "gist/days/2026-11.md",
          content: "---\ntitle: 2026-11 日梗概\n---\n### 2026-11-20\n对方买了草莓放进冰箱。\n",
        },
      },
    ]);
    mockChat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "完成睡前日梗概"}' }]);

    const bedRes = await runMemoryTidyTask(
      {
        db: ctx.db,
        dataDir: ctx.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: ctx.clock,
        events: ctx.events,
        memoryIndex: ctx.index,
        memoryTools: ctx.tools,
        chatModel: mockChat,
      },
      { taskType: "bedtime", nightDate: "2026-11-20" },
    );
    expect(bedRes.ok).toBe(true);
    expect(bedRes.committed).toBe(true);
    expect(bedRes.processedEvents).toBe(1);
    expect(ctx.events.getCursor("daily_wrapup")).toBeTruthy();
    expect(ctx.events.getCursor("bedtime")).toBeTruthy();
    // 整理轮绝不推进 door_notes_read
    expect(ctx.events.countUnreadDoorNotes()).toBe(1);
    // bedtime 轮的输入应包含今日已整理卡片摘要
    const bedtimeReq = mockChat.requests[mockChat.requests.length - 2];
    const bedtimeUserMsg = bedtimeReq.messages[0];
    expect(bedtimeUserMsg.role === "user" && bedtimeUserMsg.content).toContain("今日已整理卡片摘要");
    expect(bedtimeUserMsg.role === "user" && bedtimeUserMsg.content).toContain("daily/2026-11-20-strawberry.md");
  });

  test("API 端点闭环：/auth/pair 防伪造头爆破、/genesis BYOK 0600 落盘与防覆写、/media、/settings 校验脱敏与未回重置", async () => {
    ctx = await createTestContext();
    const pairing = new PairingManager(ctx.clock);
    let userMsgPersistedCount = 0;

    const app = createApp({
      version: "0.1.0",
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      getActiveSessionId: () => "sess-1",
      dataDir: ctx.dataDir,
      db: ctx.db,
      memoryIndex: ctx.index,
      pairing,
      onUserMessagePersisted: () => {
        userMsgPersistedCount += 1;
      },
    });

    // 1. /auth/pair 一次性兑换 + 伪造不同 x-forwarded-for 仍触发 429 锁定
    const issued = pairing.issueCode();
    const pairOk = await app.request("/api/v1/auth/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code, deviceName: "My iPhone", platform: "ios" }),
    });
    expect(pairOk.status).toBe(200);
    const pairJson = (await pairOk.json()) as { token: string; instanceId: string; deviceId: string };
    expect(pairJson.token.startsWith("psb_")).toBe(true);
    expect(pairJson.deviceId).toBeDefined();
    expect(pairJson.instanceId).toBe(ctx.config.instanceId);

    for (let i = 0; i < 5; i++) {
      const bad = await app.request("/api/v1/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i + 1}` },
        body: JSON.stringify({ code: "XXXX-XXXX", deviceName: "Evil", platform: "web" }),
      });
      expect(bad.status).toBe(401);
    }
    const locked = await app.request("/api/v1/auth/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.99" },
      body: JSON.stringify({ code: "XXXX-XXXX", deviceName: "Evil", platform: "web" }),
    });
    expect(locked.status).toBe(429);

    const authHeaders = {
      authorization: `Bearer ${pairJson.token}`,
      "content-type": "application/json",
    };

    // 2. /genesis 一步传入 BYOK apiKey -> 直落 0600 credentials.json，不进 config.json，且刷新 card_index
    const genPost = await app.request("/api/v1/genesis", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        timezone: "Asia/Shanghai",
        sleepWindow: { start: "23:00", end: "07:00" },
        llm: {
          providers: { openai: { kind: "openai", authMode: "api_key" } },
          slots: { chat: { provider: "openai", model: "gpt-4o" } },
        },
        credentials: { openai: { apiKey: "sk-test-secret-key-999" } },
      }),
    });
    expect(genPost.status).toBe(200);

    const credStat = await fs.stat(path.join(ctx.dataDir, "credentials.json"));
    expect(credStat.mode & 0o777).toBe(0o600);
    const configText = await fs.readFile(path.join(ctx.dataDir, "config.json"), "utf8");
    expect(configText).not.toContain("sk-test-secret-key-999");

    const genGet = (await (
      await app.request("/api/v1/genesis", { headers: { authorization: `Bearer ${pairJson.token}` } })
    ).json()) as { initialized: boolean; named: boolean; hasChatProvider: boolean };
    expect(genGet.initialized).toBe(true);
    expect(genGet.named).toBe(false);
    expect(genGet.hasChatProvider).toBe(true);
    expect(ctx.index.getRow("self.md")).not.toBeNull();

    // 重复调用 /genesis 不会清空已有自定义自述正文
    await ctx.tools.edit("self.md", "独立个体", "热爱观察世界的独立个体");
    await app.request("/api/v1/genesis", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ timezone: "Asia/Shanghai" }),
    });
    expect(await fs.readFile(path.join(ctx.dataDir, "memory/self.md"), "utf8")).toContain("热爱观察世界");

    // 3. /media 上传 + ETag 缓存读取
    const form = new FormData();
    form.append("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10])], "tiny.png", { type: "image/png" }));
    const upRes = await app.request("/api/v1/media", {
      method: "POST",
      headers: { authorization: `Bearer ${pairJson.token}` },
      body: form,
    });
    expect(upRes.status).toBe(200);
    const upJson = (await upRes.json()) as { hash: string; url: string; size: number };
    expect(upJson.size).toBe(6);

    const cached304 = await app.request(`${upJson.url}?token=${pairJson.token}`, {
      headers: { "if-none-match": `"${upJson.hash}"` },
    });
    expect(cached304.status).toBe(304);

    // 4. /settings 脱敏读写 + 非法参数拦截（非法 webhook.url 返回 400）
    const badSettings = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ notifications: { desktop: { enabled: true }, webhook: { enabled: true, url: "file:///etc/passwd" } } }),
    });
    expect(badSettings.status).toBe(400);

    const patchSettings = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ circadian: { proactiveEnabled: false } }),
    });
    expect(patchSettings.status).toBe(200);
    const settingsText = await (
      await app.request("/api/v1/settings", { headers: { authorization: `Bearer ${pairJson.token}` } })
    ).text();
    expect(settingsText).not.toContain("tokenHash");
    expect(settingsText).not.toContain("sk-test-secret-key-999");
    expect(settingsText).toContain('"authStatus":"configured"');
    expect(settingsText).toContain('"proactiveEnabled":false');

    // 5. 发消息触发 onUserMessagePersisted 钩子（重置连续未回计数）
    const msgRes = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "cmsg-reset-1", content: "回来啦" }),
    });
    expect(msgRes.status).toBe(202);
    expect(userMsgPersistedCount).toBe(1);

    // 6. 测试设备吊销（对齐 Spec 04 §1.1）：通过 revokeDeviceIds 移除已绑定设备并验证令牌失效
    const revokeRes = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ revokeDeviceIds: [pairJson.deviceId] }),
    });
    expect(revokeRes.status).toBe(200);
    const settingsAfterRevoke = (await revokeRes.json()) as { settings?: { devices?: Array<{ deviceId: string }> } };
    expect(settingsAfterRevoke.settings?.devices?.some((d) => d.deviceId === pairJson.deviceId)).toBe(false);

    // 验证吊销后该设备的令牌立即失效返回 401
    const revokedCheck = await app.request("/api/v1/settings", { headers: authHeaders });
    expect(revokedCheck.status).toBe(401);
  });
});
