import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performSqliteBackup } from "../src/core/backup.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { openDatabase } from "../src/core/db.ts";
import { bootPsyberRuntime, type PsyberRuntime } from "../src/index.ts";
import type { NotificationPayload } from "../src/notifications/hub.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

const cleanupDirs: string[] = [];
const activeRuntimes: PsyberRuntime[] = [];

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `psyber-runtime-test-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeRuntimes.length > 0) {
    const rt = activeRuntimes.pop()!;
    await rt.stop().catch(() => {});
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("SQLite VACUUM INTO 热备与 7 份轮转", () => {
  test("连续 9 天热备仅保留最近 7 份、psyber-latest 软链有效且快照可独立查询", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 10, 23, 45, 0);

    const runtime = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: new MockChatModel(),
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(runtime);

    for (let day = 10; day <= 18; day++) {
      clock.jumpToWallClock(2026, 11, day, 23, 45, 0);
      runtime.events.append({
        sessionId: runtime.engine.getActiveSessionId(),
        role: "user",
        kind: "chat",
        content: `第 ${day} 天的记录`,
      });
      const outPath = await performSqliteBackup(runtime.db, dataDir, clock);
      expect(outPath).toBe(path.join(dataDir, "backups", `psyber-202611${day}.sqlite`));
    }

    const backupsDir = path.join(dataDir, "backups");
    const entries = await fs.readdir(backupsDir);
    const dailyFiles = entries.filter((f) => /^psyber-\d{8}\.sqlite$/.test(f)).sort();
    const tmpFiles = entries.filter((f) => f.endsWith(".tmp"));

    expect(tmpFiles).toHaveLength(0);
    expect(dailyFiles).toEqual([
      "psyber-20261112.sqlite",
      "psyber-20261113.sqlite",
      "psyber-20261114.sqlite",
      "psyber-20261115.sqlite",
      "psyber-20261116.sqlite",
      "psyber-20261117.sqlite",
      "psyber-20261118.sqlite",
    ]);

    const latestLinkTarget = await fs.readlink(path.join(backupsDir, "psyber-latest.sqlite"));
    expect(latestLinkTarget).toBe("psyber-20261118.sqlite");

    // 校验热备副本是完整可读的独立 SQLite 文件
    const snapDb = openDatabase(path.join(backupsDir, "psyber-latest.sqlite"));
    try {
      const row = snapDb
        .query("SELECT COUNT(*) AS cnt FROM events WHERE content LIKE '第 % 天的记录'")
        .get() as { cnt: number };
      expect(row.cnt).toBe(9);
    } finally {
      snapDb.close();
    }
  });
});

describe("index.ts 运行时全链路串联（配对、75% 异步整理、作息心跳、热备与离线通知）", () => {
  test("配对鉴权、睡眠窗 bedtime 整理自动触发热备且跨午夜不跑重", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 20, 21, 0, 0);

    const mockChat = new MockChatModel();
    const runtime = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: mockChat,
      desktopSender: async () => {},
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(runtime);

    // 1. 配对码兑换 Bearer Token
    const pairCode = runtime.pairing.issueCode();
    const pairRes = await runtime.app.request("/api/v1/auth/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: pairCode.code,
        deviceName: "Test Mac",
        platform: "macos",
      }),
    });
    expect(pairRes.status).toBe(200);
    const pairJson = (await pairRes.json()) as { token: string; deviceId: string };
    expect(pairJson.token.startsWith("psb_")).toBe(true);

    // 凭新签发 Token 正常访问受保护端点（含 /door 与 /stickers）
    const doorRes = await runtime.app.request("/api/v1/door", {
      headers: { authorization: `Bearer ${pairJson.token}` },
    });
    expect(doorRes.status).toBe(200);

    const stickersRes = await runtime.app.request("/api/v1/stickers", {
      headers: { authorization: `Bearer ${pairJson.token}` },
    });
    expect(stickersRes.status).toBe(200);
    const stickersJson = (await stickersRes.json()) as { items: unknown[] };
    expect(Array.isArray(stickersJson.items)).toBe(true);

    // 2. 写入一条待整理对话
    runtime.events.append({
      sessionId: runtime.engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "今晚喝了热红茶，准备早点睡。",
    });

    // 3. 23:40 进入睡眠窗 -> 触发 bedtime（含排空 daily_wrapup + bedtime 总结）并自动执行 VACUUM INTO 热备
    clock.jumpToWallClock(2026, 11, 20, 23, 40, 0);
    mockChat.queueStream(() => [
      {
        type: "tool_call",
        id: "tc-wrap-1",
        name: "write",
        args: {
          path: "daily/2026-11-20-tea.md",
          content: "---\nkind: moment\ntags: [茶]\n---\n对方今晚喝了热红茶准备早睡。\n",
        },
      },
    ]);
    mockChat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "记录热红茶"}' }]);
    mockChat.queueStream(() => [
      {
        type: "tool_call",
        id: "tc-bed-1",
        name: "write",
        args: {
          path: "gist/days/2026-11.md",
          content: "- 2026-11-20：喝热红茶早睡。\n",
        },
      },
    ]);
    mockChat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "今日睡前梗概"}' }]);

    const nightDecision = await runtime.tickHeartbeat();
    expect(nightDecision).toEqual({ action: "sleep_tidy", nightDate: "2026-11-20" });
    await runtime.waitForIdle();

    // 验证记忆卡片与当日热备均已落盘
    const gistExists = await fs
      .access(path.join(dataDir, "memory", "gist", "days", "2026-11.md"))
      .then(() => true)
      .catch(() => false);
    expect(gistExists).toBe(true);

    const backupExists = await fs
      .access(path.join(dataDir, "backups", "psyber-20261120.sqlite"))
      .then(() => true)
      .catch(() => false);
    expect(backupExists).toBe(true);

    // 4. 次日 00:15 仍在同一夜睡眠窗内 -> 必须返回 idle，绝不重跑 bedtime
    clock.jumpToWallClock(2026, 11, 21, 0, 15, 0);
    const midnightDecision = await runtime.tickHeartbeat();
    expect(midnightDecision).toEqual({ action: "idle" });
  });

  test("75% 换段自动触发异步 daily_wrapup，清醒期主动唤醒送达离线通知并支持用户发消息重置退避", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 21, 9, 0, 0);

    const mockChat = new MockChatModel();
    const desktopSent: NotificationPayload[] = [];
    const runtime = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: mockChat,
      desktopSender: async (payload) => {
        desktopSent.push(payload);
      },
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(runtime);

    // 配对拿到 Token 供 /api/v1/chat/messages 使用
    const code = runtime.pairing.issueCode().code;
    const pairJson = (await (
      await runtime.app.request("/api/v1/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, deviceName: "Phone", platform: "ios" }),
      })
    ).json()) as { token: string };

    // 1. 触发 75% 换段：前台回复完成后，后台自动执行 daily_wrapup
    const ev = runtime.events.append({
      sessionId: runtime.engine.getActiveSessionId(),
      role: "user",
      kind: "chat",
      content: "今天项目进度很顺利",
    }).event;
    mockChat.queueStream(() => [
      { type: "text_delta", delta: "太好了！" },
      { type: "usage", inputTokens: 155_000, outputTokens: 5_000, totalTokens: 160_000 },
    ]);
    // 后台 daily_wrapup 的一次响应
    mockChat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "项目顺利"}' }]);

    const turnRes = await runtime.engine.runTurn({
      mode: "chat",
      userText: ev.content,
      userEventId: ev.id,
    });
    expect(turnRes.rolledOver).toBe(true);
    await runtime.waitForIdle();
    expect(runtime.events.getCursor("daily_wrapup")).not.toBeNull();

    // 2. 快进 5 小时（14:00），仅有 background SSE 订阅者（foreground: false）-> 仍应送达离线通知；
    //    先测试一次 [SILENT] 唤醒：绝不递增 consecutiveUnansweredWakes，也不发通知
    clock.jumpToWallClock(2026, 11, 21, 14, 0, 0);
    const unsubBg = runtime.sse.subscribe(() => {}, { foreground: false });
    mockChat.queueStream(() => [{ type: "text_delta", delta: "[SILENT]" }]);
    const silentWake = await runtime.tickHeartbeat();
    expect(silentWake.action).toBe("proactive");
    expect(desktopSent).toHaveLength(0);

    // 紧接着再快进 4 小时（18:00），真正开口第 1 次 -> 触发桌面通知（background 订阅不抑制）
    clock.jumpToWallClock(2026, 11, 21, 18, 0, 0);
    mockChat.queueStream(() => [{ type: "text_delta", delta: "下午好，忙完可以歇会儿。" }]);
    const wake1 = await runtime.tickHeartbeat();
    expect(wake1.action).toBe("proactive");
    expect(desktopSent).toHaveLength(1);
    expect(desktopSent[0].kind).toBe("wake");
    unsubBg();

    // 3. 再快进 4 小时（22:00），此时有前台 SSE 订阅者 -> 触发第 2 次真正开口但抑制桌面通知
    clock.jumpToWallClock(2026, 11, 21, 22, 0, 0);
    const unsubscribe = runtime.sse.subscribe(() => {}, { foreground: true });
    mockChat.queueStream(() => [{ type: "text_delta", delta: "晚饭打算吃什么？" }]);
    const wake2 = await runtime.tickHeartbeat();
    expect(wake2.action).toBe("proactive");
    expect(desktopSent).toHaveLength(1);
    unsubscribe();

    // 4. 次日 10:00（距上次唤醒 > 3h），因连续未回真正开口已达 2 次 -> 退避静默
    clock.jumpToWallClock(2026, 11, 22, 10, 0, 0);
    const suppressed = await runtime.tickHeartbeat();
    expect(suppressed).toEqual({ action: "idle" });

    // 5. 用户通过 HTTP 接口发一条新消息 -> 重置连续未回计数为 0
    mockChat.queueStream(() => [{ type: "text_delta", delta: "收到，早点休息。" }]);
    const msgRes = await runtime.app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${pairJson.token}`,
      },
      body: JSON.stringify({ content: "刚忙完，准备吃晚饭了" }),
    });
    expect(msgRes.status).toBe(202);
    // 等待异步 chat turn 完成
    await new Promise((r) => setTimeout(r, 20));

    // 6. 同日 16:00（距上次互动 > 4 小时，且连续未回已清零）-> 重新允许主动唤醒
    clock.jumpToWallClock(2026, 11, 22, 16, 0, 0);
    mockChat.queueStream(() => [{ type: "text_delta", delta: "下午好！" }]);
    const wake3 = await runtime.tickHeartbeat();
    expect(wake3.action).toBe("proactive");
    expect(desktopSent).toHaveLength(2);
  });

  test("夜间关机错过 bedtime：次日重启自动携带昨晚过渡对话 + <gist> 并在后台补跑昨夜整理，同日短停重启无缝续接原会话", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");

    // 1. 昨晚 21:00 聊了一轮后直接关服（未经历 23:30 睡眠窗 bedtime）
    clock.jumpToWallClock(2026, 11, 21, 21, 0, 0);
    const chat1 = new MockChatModel();
    const rt1 = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat1,
      startHeartbeatTimer: false,
    });
    const sessionDay1 = rt1.engine.getActiveSessionId();
    const u1 = rt1.events.append({
      sessionId: sessionDay1,
      role: "user",
      kind: "chat",
      content: "昨晚我们约好周六去看海边日出",
    });
    chat1.queueStream(() => [{ type: "text_delta", delta: "记下了，周六早起去看日出。" }]);
    await rt1.engine.runTurn({
      mode: "chat",
      userText: u1.event.content,
      userEventId: u1.event.id,
    });
    await rt1.stop();

    // 写入一份既有日梗概，验证跨日重启首轮也能同步注入 <gist>
    await fs.writeFile(
      path.join(dataDir, "memory", "gist", "days", "2026-11-20.md"),
      "---\nupdated: 2026-11-20\n---\n前天整理了相机和三脚架。",
      "utf8",
    );

    // 2a. 次日 13:20 重启但用户立刻发第一句话（尚未等后台补跑完 bedtime）：不截断昨天未整理的原始对话，直接续接原 sessionId
    clock.jumpToWallClock(2026, 11, 22, 13, 20, 0);
    const chatImmediate = new MockChatModel();
    chatImmediate.queueStream(() => [{ type: "text_delta", delta: "刚开机我也记得昨晚的话。" }]);
    const rtImmediate = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chatImmediate,
      startHeartbeatTimer: false,
      catchUpMissedBedtime: false,
    });
    activeRuntimes.push(rtImmediate);
    expect(rtImmediate.engine.getActiveSessionId()).toBe(sessionDay1);
    const uImm = rtImmediate.events.append({
      sessionId: sessionDay1,
      role: "user",
      kind: "chat",
      content: "刚开机就问你一句",
    });
    await rtImmediate.engine.runTurn({
      mode: "chat",
      userText: uImm.event.content,
      userEventId: uImm.event.id,
    });
    const immBlob = chatImmediate.requests[0]!.messages.map((m) => String(m.content)).join("\n");
    expect(immBlob).toContain("昨晚我们约好周六去看海边日出");
    await rtImmediate.stop();
    activeRuntimes.pop();

    // 2b. 若次日重启先完成后台补跑昨夜 bedtime 再开始聊：先沿用原段防丢，补跑完自动换入带 <gist> + 最近 6 轮过渡的新段
    clock.jumpToWallClock(2026, 11, 22, 13, 22, 0);
    const chat2 = new MockChatModel();
    // 后台补跑昨夜 bedtime 的两段响应（先排空 daily_wrapup，再写 bedtime 梗概）
    chat2.queueStream(() => [{ type: "text_delta", delta: '{"summary": "约了周六海边日出"}' }]);
    chat2.queueStream(() => [{ type: "text_delta", delta: '{"summary": "生成昨夜日梗概"}' }]);
    // 今日第一句聊天响应
    chat2.queueStream(() => [{ type: "text_delta", delta: "早上好，周六看日出我没忘！" }]);

    const rt2 = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat2,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt2);
    // 补跑完成前仍保留原 sessionDay1；补跑完成后自动切入 sessionDay2
    await rt2.waitForIdle();
    const sessionDay2 = rt2.engine.getActiveSessionId();
    expect(sessionDay2).not.toBe(sessionDay1);
    expect(rt2.events.getBedtimeNightDate()).toBe("2026-11-21");

    clock.jumpToWallClock(2026, 11, 22, 13, 25, 0);
    const u2 = rt2.events.append({
      sessionId: sessionDay2,
      role: "user",
      kind: "chat",
      content: "早上好呀",
    });
    const turn2 = await rt2.engine.runTurn({
      mode: "chat",
      userText: u2.event.content,
      userEventId: u2.event.id,
    });
    expect(turn2.text).toBe("早上好，周六看日出我没忘！");

    const chatCall = chat2.requests.find((c) =>
      c.messages.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("早上好呀"),
      ),
    );
    expect(chatCall).toBeDefined();
    expect(chatCall!.systemPrompt).toContain("<continuity>");
    expect(chatCall!.systemPrompt).toContain("前天整理了相机和三脚架");
    expect(chatCall!.systemPrompt).toContain("昨晚我们约好周六去看海边日出");
    expect(chatCall!.systemPrompt).toContain("记下了，周六早起去看日出。");
    expect(chatCall!.messages[0]?.role).toBe("user");

    await rt2.stop();
    activeRuntimes.pop();

    // 3. 同日 30 分钟后再次短停重启（13:50，未再跑 bedtime）：续接原 sessionId 并完整保留冻结的 <continuity> 与本段全部历史
    clock.jumpToWallClock(2026, 11, 22, 13, 50, 0);
    const chat3 = new MockChatModel();
    chat3.queueStream(() => [{ type: "text_delta", delta: "刚聊过，我都接得上。" }]);
    const rt3 = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat3,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt3);
    expect(rt3.engine.getActiveSessionId()).toBe(sessionDay2);

    const u3 = rt3.events.append({
      sessionId: sessionDay2,
      role: "user",
      kind: "chat",
      content: "顺便带点热茶",
    });
    await rt3.engine.runTurn({
      mode: "chat",
      userText: u3.event.content,
      userEventId: u3.event.id,
    });
    const call3 = chat3.requests[0]!;
    const blob3 = call3.messages.map((m) => String(m.content)).join("\n");
    expect(blob3).toContain("早上好呀");
    expect(blob3).toContain("早上好，周六看日出我没忘！");
    expect(call3.systemPrompt).toContain("<continuity>");
    expect(call3.systemPrompt).toContain("昨晚我们约好周六去看海边日出");
  });
});
