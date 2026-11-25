import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { VirtualClock } from "../src/core/clock.ts";
import { saveConfig } from "../src/core/config.ts";
import { hashBearerToken } from "../src/api/app.ts";
import type { SseFrame } from "../src/engine/sse.ts";
import { bootPsyberRuntime, type PsyberRuntime } from "../src/index.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

const tempDirs: string[] = [];
const activeRuntimes: PsyberRuntime[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "psyber-rollover-"));
  tempDirs.push(dir);
  return dir;
}

async function attachAuthDevice(rt: PsyberRuntime, token = "tok-rollover-test"): Promise<string> {
  rt.config.auth.devices.push({
    deviceId: "dev-rollover",
    deviceName: "Test Client",
    platform: "macos",
    tokenHash: hashBearerToken(token),
    createdAt: rt.clock.now(),
    lastSeenAt: rt.clock.now(),
  });
  await saveConfig(rt.dataDir, rt.config);
  return token;
}

afterEach(async () => {
  while (activeRuntimes.length > 0) {
    const rt = activeRuntimes.pop()!;
    await rt.stop().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("同步换段、sessionId 持久化、<continuity> 金字塔与安全白名单边界", () => {
  test("常驻服务不重启：白天聊过天后，夜间 bedtime 完成必须自动切新 sessionId（零死锁）且次日首轮注入最新 <continuity>", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 21, 14, 0, 0);

    const chat = new MockChatModel(10_000);
    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt);

    const sessDay1 = rt.engine.getActiveSessionId();
    const u1 = rt.events.append({
      sessionId: sessDay1,
      role: "user",
      kind: "chat",
      content: "今天下午去植物园看了银杏",
    });
    chat.queueStream(() => [
      { type: "text_delta", delta: "银杏全黄了吧，拍照片了吗？" },
      { type: "usage", inputTokens: 300, outputTokens: 100, totalTokens: 400 },
    ]);
    await rt.engine.runTurn({
      mode: "chat",
      userText: u1.event.content,
      userEventId: u1.event.id,
    });

    // 同一进程不重启，推进至当晚 23:40 触发 bedtime（先排空 daily_wrapup，再写 gist/days）
    clock.jumpToWallClock(2026, 11, 21, 23, 40, 0);
    chat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "记下植物园看银杏"}' }]);
    chat.queueStream(() => [
      {
        type: "tool_call",
        id: "bt-gist",
        name: "write",
        args: {
          path: "episodes/2026/11/21/index.md",
          content: "---\nupdated: 2026-11-21\n---\n下午聊了去植物园看银杏。\n",
        },
      },
    ]);
    chat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "写入 11-21 日梗概"}' }]);

    const hb = await rt.tickHeartbeat();
    expect(hb.action).toBe("sleep_tidy");
    await rt.waitForIdle();

    const sessDay2 = rt.engine.getActiveSessionId();
    expect(sessDay2).not.toBe(sessDay1);
    expect(rt.engine.getContextUsage().usedTokens).toBe(0);

    // 次日 09:00 开启新段首轮：Static Prefix 应冻结 <continuity>（含昨晚日梗概 + 末尾原话），messages[0] 为 user
    clock.jumpToWallClock(2026, 11, 22, 9, 0, 0);
    const u2 = rt.events.append({
      sessionId: sessDay2,
      role: "user",
      kind: "chat",
      content: "早安",
    });
    chat.queueStream(() => [{ type: "text_delta", delta: "早安呀！" }]);
    await rt.engine.runTurn({
      mode: "chat",
      userText: u2.event.content,
      userEventId: u2.event.id,
    });

    const day2Req = chat.requests[chat.requests.length - 1]!;
    expect(day2Req.systemPrompt).toContain("<continuity>");
    expect(day2Req.systemPrompt).toContain("下午聊了去植物园看银杏");
    expect(day2Req.systemPrompt).toContain("今天下午去植物园看了银杏");
    expect(day2Req.messages[0]?.role).toBe("user");
  });

  test("换段未发言即重启绝不复活已收尾旧段；短停重启恢复上下文水位；昨晚手动换段后关机次日仍补跑 bedtime", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 21, 20, 0, 0);

    const chat1 = new MockChatModel(1000);
    const rt1 = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat1,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt1);
    const token = await attachAuthDevice(rt1);

    const sess1 = rt1.engine.getActiveSessionId();
    const u1 = rt1.events.append({
      sessionId: sess1,
      role: "user",
      kind: "chat",
      content: "聊完这件大事先存个记忆",
    });
    chat1.queueStream(() => [
      { type: "text_delta", delta: "好，我收拢一下。" },
      { type: "usage", inputTokens: 400, outputTokens: 100, totalTokens: 500 },
    ]);
    await rt1.engine.runTurn({
      mode: "chat",
      userText: u1.event.content,
      userEventId: u1.event.id,
    });

    // 手动存记忆换段（同步执行 daily_wrapup 写入 episodes/）
    chat1.queueStream(() => [
      {
        type: "tool_call",
        id: "wrap-daily",
        name: "write",
        args: {
          path: "episodes/2026/11/21/ep-big-thing.md",
          content: "---\ntitle: 大事定案\nkind: episode\ncreated: 2026-11-21\n---\n今晚我们一起敲定了搬家日期。\n",
        },
      },
    ]);
    chat1.queueStream(() => [{ type: "text_delta", delta: '{"summary": "记下搬家日期"}' }]);

    const wrapRes = await rt1.app.request("/api/v1/chat/wrap-up", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(wrapRes.status).toBe(202);
    const wrapBody = (await wrapRes.json()) as {
      oldSessionId: string;
      newSessionId: string;
      wrapped: boolean;
    };
    expect(wrapBody.oldSessionId).toBe(sess1);
    expect(wrapBody.newSessionId).not.toBe(sess1);
    expect(wrapBody.wrapped).toBe(true);
    const sess2 = wrapBody.newSessionId;

    // 在 sess2 尚未说任何话之前直接重启（同日 20:10）
    await rt1.stop();
    activeRuntimes.pop();

    clock.jumpToWallClock(2026, 11, 21, 20, 10, 0);
    const chat2 = new MockChatModel(1000);
    const rt2 = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat2,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt2);
    // 绝不复活旧 sess1，必须保持 sess2
    expect(rt2.engine.getActiveSessionId()).toBe(sess2);

    // 在 sess2 说第一句，应吃到刚写入的 daily/ 正文（非仅标题）与上段末尾原话
    const u2 = rt2.events.append({
      sessionId: sess2,
      role: "user",
      kind: "chat",
      content: "继续聊聊箱子怎么打包",
    });
    chat2.queueStream(() => [
      { type: "text_delta", delta: "先打包换季衣服最省心。" },
      { type: "usage", inputTokens: 320, outputTokens: 80, totalTokens: 400 },
    ]);
    await rt2.engine.runTurn({
      mode: "chat",
      userText: u2.event.content,
      userEventId: u2.event.id,
    });
    const req2 = chat2.requests[0]!;
    expect(req2.systemPrompt).toContain("<continuity>");
    expect(req2.systemPrompt).toContain("今晚我们一起敲定了搬家日期");
    expect(req2.systemPrompt).toContain("聊完这件大事先存个记忆");

    await rt2.stop();
    activeRuntimes.pop();

    // 同日 20:20 再次短停重启：应续接 sess2 且恢复 lastUsedTokens = 400
    clock.jumpToWallClock(2026, 11, 21, 20, 20, 0);
    const chat3 = new MockChatModel(1000);
    const rt3 = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat3,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt3);
    expect(rt3.engine.getActiveSessionId()).toBe(sess2);
    expect(rt3.engine.getContextUsage().usedTokens).toBe(400);
    await rt3.stop();
    activeRuntimes.pop();

    // 次日 10:00 开机：即使昨晚手动换段已排空 daily_wrapup 游标，因昨夜缺 bedtime 仍应自动补跑
    clock.jumpToWallClock(2026, 11, 22, 10, 0, 0);
    const chat4 = new MockChatModel(1000);
    chat4.queueStream(() => [{ type: "text_delta", delta: '{"summary": "补写剩余对话"}' }]);
    chat4.queueStream(() => [{ type: "text_delta", delta: '{"summary": "补写昨夜日梗概"}' }]);
    const rt4 = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat4,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt4);
    await rt4.waitForIdle();
    expect(rt4.events.getBedtimeNightDate()).toBe("2026-11-21");
    expect(rt4.engine.getActiveSessionId()).not.toBe(sess2);
  });

  test("75% 换段整理失败时保留原段不硬切；CONTEXT_OVERFLOW 有历史时同步换段当轮自动重试成功且不双发", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 22, 11, 0, 0);

    const chat = new MockChatModel(1000);
    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt);

    const frames: SseFrame[] = [];
    const unsub = rt.sse.subscribe((f) => frames.push(f));

    const sess1 = rt.engine.getActiveSessionId();
    const u1 = rt.events.append({
      sessionId: sess1,
      role: "user",
      kind: "chat",
      content: "第一轮先触发 75% 但模拟整理接口报错",
    });
    // 第 1 轮命中 75%（800 / 750）
    chat.queueStream(() => [
      { type: "text_delta", delta: "第一轮正常回复。" },
      { type: "usage", inputTokens: 600, outputTokens: 200, totalTokens: 800 },
    ]);
    // 紧接着同步 daily_wrapup 报错
    chat.queueStream(() => [
      { type: "error", code: "PROVIDER_ERROR", message: "503 upstream down", retryable: true },
    ]);

    const r1 = await rt.engine.runTurn({
      mode: "chat",
      userText: u1.event.content,
      userEventId: u1.event.id,
    });
    expect(r1.text).toBe("第一轮正常回复。");
    expect(r1.rolledOver).toBe(false);
    // 整理失败必须保留原 sess1，不硬切防失忆
    expect(rt.engine.getActiveSessionId()).toBe(sess1);
    expect(frames.some((f) => f.event === "turn.rollover" && f.data.phase === "error")).toBe(true);

    // 第 2 轮遭遇 CONTEXT_OVERFLOW：当前段已有历史 -> 同步整理旧段 -> 切新 sessionId -> 当轮自动重试成功
    const u2 = rt.events.append({
      sessionId: sess1,
      role: "user",
      kind: "chat",
      content: "第二轮触发溢出自动换段续跑",
    });
    let turnErrorCount = 0;
    // 1) 主对话报 CONTEXT_OVERFLOW
    chat.queueStream(() => [
      { type: "error", code: "CONTEXT_OVERFLOW", message: "prompt is too long", retryable: true },
    ]);
    // 2) 同步 daily_wrapup 消化旧段（仅截至 u2 之前）
    chat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "溢出前整理完成"}' }]);
    // 3) 新段当轮自动重试返回正常回复
    chat.queueStream(() => [
      { type: "text_delta", delta: "换段后已顺利接上！" },
      { type: "usage", inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    ]);

    const r2 = await rt.engine.runTurn({
      mode: "chat",
      userText: u2.event.content,
      userEventId: u2.event.id,
      callbacks: {
        onTurnError: () => {
          turnErrorCount += 1;
        },
      },
    });
    expect(turnErrorCount).toBe(0);
    expect(r2.text).toBe("换段后已顺利接上！");
    expect(r2.rolledOver).toBe(true);
    const sess2 = rt.engine.getActiveSessionId();
    expect(sess2).not.toBe(sess1);
    expect(r2.sessionId).toBe(sess2);
    // u2 应已重绑到 sess2，且新段请求中 u2 仅出现一次（绝不双发）
    expect(rt.events.getById(u2.event.id)?.sessionId).toBe(sess2);
    const retryReq = chat.requests[chat.requests.length - 1]!;
    expect(retryReq.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(retryReq.systemPrompt).not.toContain("第二轮触发溢出自动换段续跑");
    expect(retryReq.systemPrompt).toContain("第一轮正常回复。");

    unsub();
  });

  test("工具 scope=session 白名单换段后自动失效，且换段后禁止 edit/reroll 旧段消息", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 22, 15, 0, 0);

    const chat = new MockChatModel(2000);
    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt);
    const token = await attachAuthDevice(rt);

    // 注册一个需要 confirm 审批的扩展工具
    let toolRunCount = 0;
    const registry = (rt.engine as unknown as { deps: { registry: { register: (t: unknown) => void } } }).deps.registry;
    registry.register({
      name: "demo.risky",
      tier: 3,
      security: "confirm",
      description: "测试高风险工具",
      tags: ["demo"],
      parameters: { type: "object", properties: {} },
      execute: async () => {
        toolRunCount += 1;
        return { ok: true, output: `ran-${toolRunCount}` };
      },
    });

    const approvals: Array<{ approvalId: string; turnId: string }> = [];
    const unsub = rt.sse.subscribe((f) => {
      if (f.event === "turn.approval_required") {
        approvals.push({
          approvalId: String(f.data.approvalId),
          turnId: String(f.data.turnId),
        });
      }
    });

    const waitForApproval = async (expectedCount: number) => {
      for (let i = 0; i < 60; i++) {
        if (approvals.length >= expectedCount) return approvals[expectedCount - 1]!;
        await Bun.sleep(10);
      }
      throw new Error("未收到审批事件");
    };

    // 第 1 轮：触发审批并选择 scope: "session"
    chat.queueStream(() => [
      {
        type: "tool_call",
        id: "call-1",
        name: "call_tool",
        args: { name: "demo.risky", arguments: {} },
      },
    ]);
    chat.queueStream(() => [{ type: "text_delta", delta: "第一次调用完成" }]);

    const m1Res = await rt.app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientMessageId: "c-app-1", content: "执行一次" }),
    });
    expect(m1Res.status).toBe(202);
    const m1Body = (await m1Res.json()) as { message: { id: string } };

    const a1 = await waitForApproval(1);
    const approve1 = await rt.app.request(`/api/v1/turns/${a1.turnId}/approval`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: a1.approvalId, decision: "allow", scope: "session" }),
    });
    expect(approve1.status).toBe(200);
    for (let i = 0; i < 60 && toolRunCount < 1; i++) await Bun.sleep(10);
    await Bun.sleep(30);

    // 同会话第 2 轮：应命中 session 白名单，不再弹审批
    chat.queueStream(() => [
      {
        type: "tool_call",
        id: "call-2",
        name: "call_tool",
        args: { name: "demo.risky", arguments: {} },
      },
    ]);
    chat.queueStream(() => [{ type: "text_delta", delta: "第二次静默放行完成" }]);

    await rt.app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientMessageId: "c-app-2", content: "再执行一次" }),
    });
    for (let i = 0; i < 60 && toolRunCount < 2; i++) await Bun.sleep(10);
    await Bun.sleep(30);
    expect(approvals).toHaveLength(1);

    // 手动换段：切入新 sessionId
    chat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "手动换段"}' }]);
    const wrapRes = await rt.app.request("/api/v1/chat/wrap-up", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(wrapRes.status).toBe(202);

    // 换段后禁止编辑旧段最后一条用户消息
    const editOld = await rt.app.request(`/api/v1/chat/messages/${m1Body.message.id}/edit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "试图篡改旧段" }),
    });
    expect(editOld.status).toBe(409);

    // 新会话第 3 轮：session 白名单必须已失效，重新弹出审批！
    chat.queueStream(() => [
      {
        type: "tool_call",
        id: "call-3",
        name: "call_tool",
        args: { name: "demo.risky", arguments: {} },
      },
    ]);
    chat.queueStream(() => [{ type: "text_delta", delta: "新会话重新审批通过" }]);
    await rt.app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientMessageId: "c-app-3", content: "新段再执行" }),
    });

    const a2 = await waitForApproval(2);
    expect(a2.approvalId).not.toBe(a1.approvalId);
    await rt.app.request(`/api/v1/turns/${a2.turnId}/approval`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: a2.approvalId, decision: "allow", scope: "once" }),
    });
    for (let i = 0; i < 60 && toolRunCount < 3; i++) await Bun.sleep(10);
    expect(toolRunCount).toBe(3);

    unsub();
  });

  test("<continuity> 严格排除 threads/ 与已入日梗概的旧 episodes/，保留今日 episodes/ 正文与当月滚动月梗概，末尾原话遵守 2000 字预算", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 22, 12, 0, 0);

    const chat = new MockChatModel(5000);
    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt);

    // 写入基于 covered_until 的年/月/日分形梗概，验证零重叠零断层拼接
    await fs.mkdir(path.join(dataDir, "memory", "episodes", "2025"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2025", "index.md"),
      "---\ncovered_until: 2025-12\nupdated: 2025-12-31\n---\n2025年我们刚刚认识。\n",
      "utf8",
    );
    await fs.mkdir(path.join(dataDir, "memory", "episodes", "2026", "08"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "memory", "episodes", "2026", "09"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "index.md"),
      "---\ncovered_until: 2026-08\nupdated: 2026-08-31\n---\n2026年前八个月一起打好了地基。\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "08", "index.md"),
      "---\ncovered_until: 2026-08-31\nupdated: 2026-08-31\n---\n八月已滚入年梗概，不应重复出现。\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "09", "index.md"),
      `---\ncovered_until: 2026-09-30\nupdated: 2026-09-30\n---\n九月一起跑通了初版原型。${"月".repeat(400)}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(dataDir, "memory", "episodes", "2026", "11", "10"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "memory", "episodes", "2026", "11", "20"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "memory", "episodes", "2026", "11", "21"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "memory", "episodes", "2026", "11", "22"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "11", "index.md"),
      "---\ncovered_until: 2026-11-15\nupdated: 2026-11-15\n---\n十一月上半月换了新键盘并试做了面包。\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "11", "10", "index.md"),
      "---\nupdated: 2026-11-10\n---\n十号已滚入月梗概，不应重复出现。\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "11", "20", "index.md"),
      `---\nupdated: 2026-11-20\n---\n前天整理了桌面。${"天".repeat(500)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "11", "21", "index.md"),
      "---\nupdated: 2026-11-21\n---\n昨天完成了周末大扫除。\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "11", "21", "ep-old.md"),
      "---\ntitle: 昨日旧卡片\nkind: episode\ncreated: 2026-11-21\nupdated: 2026-11-21\n---\n这条旧日常正文不该再塞进开局。\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dataDir, "memory", "episodes", "2026", "11", "22", "ep-morning.md"),
      "---\ntitle: 上午买菜\nkind: episode\ncreated: 2026-11-22\nupdated: 2026-11-22\n---\n今天上午在菜市场买了新鲜莲藕和排骨，打算晚上煲汤。\n",
      "utf8",
    );
    await fs.mkdir(path.join(dataDir, "memory", "threads", "cinema"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "memory", "threads", "cinema", "film.md"),
      "---\ntitle: 观影记录\nkind: work\ncreated: 2026-11-22\nupdated: 2026-11-22\n---\n观影专题正文应交给召回，不进开局。\n",
      "utf8",
    );
    await rt.memoryIndex.reindexAll();

    // 写入超过 2000 字的旧对话，再手动换段
    const sess1 = rt.engine.getActiveSessionId();
    rt.events.append({
      sessionId: sess1,
      role: "user",
      kind: "chat",
      content: `最早的一段超长旧话_${"甲".repeat(1600)}`,
    });
    rt.events.append({
      sessionId: sess1,
      role: "assistant",
      kind: "chat",
      content: `中间回复_${"乙".repeat(900)}`,
    });
    rt.events.append({
      sessionId: sess1,
      role: "user",
      kind: "chat",
      content: "最后一句简短收尾",
    });

    chat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "午间换段"}' }]);
    const roll = await rt.engine.manualRollover();
    expect(roll.ok).toBe(true);

    chat.queueStream(() => [{ type: "text_delta", delta: "中午好！" }]);
    await rt.engine.runTurn({ mode: "chat", userText: "新段第一句" });

    const req = chat.requests[chat.requests.length - 1]!;
    expect(req.systemPrompt).toContain("<continuity>");
    expect(req.systemPrompt).toContain("昨天完成了周末大扫除");
    // 年 + 未滚入年的月 + 未滚入月的天 严格零重叠拼接
    expect(req.systemPrompt).toContain("2025年我们刚刚认识");
    expect(req.systemPrompt).toContain("2026年前八个月一起打好了地基");
    expect(req.systemPrompt).not.toContain("八月已滚入年梗概，不应重复出现");
    expect(req.systemPrompt).toContain("九月一起跑通了初版原型");
    expect(req.systemPrompt).toContain("十一月上半月换了新键盘并试做了面包");
    expect(req.systemPrompt).not.toContain("十号已滚入月梗概，不应重复出现");
    expect(req.systemPrompt).not.toContain("天".repeat(450));
    // 今日 episodes/ 正文必须完整进来
    expect(req.systemPrompt).toContain("买了新鲜莲藕和排骨，打算晚上煲汤");
    // 旧天 episodes/ 与 threads/ 不应占开局预算
    expect(req.systemPrompt).not.toContain("这条旧日常正文不该再塞进开局");
    expect(req.systemPrompt).not.toContain("观影专题正文应交给召回，不进开局");
    // 2000 字预算应保留最后一句、截掉最早的 1600 字长段
    expect(req.systemPrompt).toContain("最后一句简短收尾");
    expect(req.systemPrompt).not.toContain("最早的一段超长旧话_");
  });

  test("会话尾部热写整理：复用逐字节一致的 Static Prefix 与工具集命中缓存、不污染 events、广播 turn.tidy，热写超容自动降级冷写", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 23, 15, 0, 0);

    const chat = new MockChatModel(50_000);
    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: chat,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt);

    const tidyFrames: SseFrame[] = [];
    const unsub = rt.sse.subscribe((f) => {
      if (f.event === "turn.tidy") tidyFrames.push(f);
    });

    const sess1 = rt.engine.getActiveSessionId();
    const u1 = rt.events.append({
      sessionId: sess1,
      role: "user",
      kind: "chat",
      content: "今天试做了一锅番茄牛腩，超香！",
    });
    chat.queueStream(() => [
      { type: "text_delta", delta: "听起来就很有食欲，牛腩炖烂了吗？" },
      { type: "usage", inputTokens: 800, outputTokens: 100, totalTokens: 900 },
    ]);
    await rt.engine.runTurn({
      mode: "chat",
      userText: u1.event.content,
      userEventId: u1.event.id,
    });
    const chatReq = chat.requests[0]!;

    // 1. 手动存记忆换段：走会话尾部热写
    chat.queueStream(() => [
      {
        type: "tool_call",
        id: "hot-w1",
        name: "write",
        args: {
          path: "episodes/2026/11/23/ep-beef-stew.md",
          content: "---\ntitle: 番茄牛腩\nkind: episode\ncreated: 2026-11-23\n---\n做了番茄牛腩。\n",
        },
      },
    ]);
    chat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "记下番茄牛腩"}' }]);

    const roll = await rt.engine.manualRollover();
    expect(roll.ok).toBe(true);
    expect(rt.engine.getActiveSessionId()).not.toBe(sess1);

    const hotReq = chat.requests[1]!;
    // 精确前缀一致（KV Cache 命中关键前提）
    expect(hotReq.systemPrompt).toBe(chatReq.systemPrompt);
    expect(hotReq.tools.map((t) => t.name)).toEqual(chatReq.tools.map((t) => t.name));
    expect(hotReq.messages.length).toBe(3); // user + assistant + <tidy_mode>
    expect(String(hotReq.messages[2]!.content)).toContain("<tidy_mode");
    // <tidy_mode> 绝不落盘进 events 聊天表
    const allEvs = rt.events.listSessionMessages(sess1);
    expect(allEvs.some((e) => e.content.includes("<tidy_mode"))).toBe(false);
    // SSE 收到 turn.tidy started -> done（mode=hot）
    expect(tidyFrames.some((f) => f.data.phase === "started" && f.data.mode === "hot")).toBe(true);
    expect(tidyFrames.some((f) => f.data.phase === "done" && f.data.mode === "hot")).toBe(true);

    // 2. 新段再聊一句后热写遭遇 CONTEXT_OVERFLOW -> 自动降级冷写成功并广播 mode=cold
    const sess2 = rt.engine.getActiveSessionId();
    const u2 = rt.events.append({
      sessionId: sess2,
      role: "user",
      kind: "chat",
      content: "明天准备再熬点排骨汤",
    });
    chat.queueStream(() => [
      { type: "text_delta", delta: "好主意，加点玉米和胡萝卜。" },
      { type: "usage", inputTokens: 800, outputTokens: 100, totalTokens: 900 },
    ]);
    await rt.engine.runTurn({
      mode: "chat",
      userText: u2.event.content,
      userEventId: u2.event.id,
    });

    // 热写报 CONTEXT_OVERFLOW -> 自动回落冷写成功
    chat.queueStream(() => [
      { type: "error", code: "CONTEXT_OVERFLOW", message: "too long for hot tail", retryable: true },
    ]);
    chat.queueStream(() => [{ type: "text_delta", delta: '{"summary": "冷写兜底完成"}' }]);

    const roll2 = await rt.engine.manualRollover();
    expect(roll2.ok).toBe(true);
    expect(rt.engine.getActiveSessionId()).not.toBe(sess2);
    expect(tidyFrames.some((f) => f.data.phase === "done" && f.data.mode === "cold")).toBe(true);

    unsub();
  });

  test("bedtime 热写期间用户发来新消息：立即 abort 让路回滚、广播 turn.tidy deferred、不换段且用户对话正常完成", async () => {
    const dataDir = await makeTempDir();
    const clock = new VirtualClock(0, "Asia/Shanghai");
    clock.jumpToWallClock(2026, 11, 23, 21, 0, 0);

    let tidyStartedResolve: (() => void) | null = null;
    const tidyStarted = new Promise<void>((r) => {
      tidyStartedResolve = r;
    });

    // 自定义可观察 signal 中止的 MockChatModel
    let callIdx = 0;
    const abortableModel = {
      contextWindow: 50_000,
      modelId: "mock-abortable",
      async *stream(req: { signal?: AbortSignal }) {
        const idx = callIdx++;
        if (idx === 0) {
          // 正常第一轮对话
          yield { type: "text_delta" as const, delta: "晚上好呀！" };
          yield { type: "usage" as const, inputTokens: 500, outputTokens: 50, totalTokens: 550 };
          return;
        }
        if (idx === 1) {
          // bedtime 热写：先写一张临时卡，然后阻塞等待被用户新消息 abort
          yield {
            type: "tool_call" as const,
            id: "tc-defer-1",
            name: "write",
            args: {
              path: "episodes/2026/11/23/ep-should-rollback.md",
              content: "---\ntitle: 未完成卡片\n---\n应被回滚。\n",
            },
          };
          return;
        }
        if (idx === 2) {
          // 第二步挂起直到 signal.aborted
          tidyStartedResolve?.();
          await new Promise<void>((resolve) => {
            if (req.signal?.aborted) {
              resolve();
              return;
            }
            req.signal?.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(resolve, 2000);
          });
          yield { type: "text_delta" as const, delta: '{"summary": "不应提交"}' };
          return;
        }
        // 用户插话的新一轮对话
        yield { type: "text_delta" as const, delta: "我还没睡呢，接着聊！" };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: abortableModel,
      startHeartbeatTimer: false,
    });
    activeRuntimes.push(rt);

    const tidyFrames: SseFrame[] = [];
    const unsub = rt.sse.subscribe((f) => {
      if (f.event === "turn.tidy") tidyFrames.push(f);
    });

    const sess1 = rt.engine.getActiveSessionId();
    const u1 = rt.events.append({
      sessionId: sess1,
      role: "user",
      kind: "chat",
      content: "晚上好",
    });
    await rt.engine.runTurn({
      mode: "chat",
      userText: u1.event.content,
      userEventId: u1.event.id,
    });

    // 23:40 静默超 30m 触发 bedtime 热写
    clock.jumpToWallClock(2026, 11, 23, 23, 40, 0);
    const hb = await rt.tickHeartbeat();
    expect(hb).toEqual({ action: "sleep_tidy", nightDate: "2026-11-23" });

    // 等到 bedtime 整理进入第二步后，用户突然发来新消息
    await tidyStarted;
    const u2 = rt.events.append({
      sessionId: sess1,
      role: "user",
      kind: "chat",
      content: "等等我还没睡！",
    });
    const chatRes = await rt.engine.runTurn({
      mode: "chat",
      userText: u2.event.content,
      userEventId: u2.event.id,
    });
    await rt.waitForIdle();

    expect(chatRes.text).toBe("我还没睡呢，接着聊！");
    // 整理让路回滚：不换段、不记 bedtime 完成、临时卡片已回滚、广播 turn.tidy deferred
    expect(rt.engine.getActiveSessionId()).toBe(sess1);
    expect(rt.events.getBedtimeNightDate()).toBeNull();
    expect(rt.memoryIndex.getRow("episodes/2026/11/23/ep-should-rollback.md")).toBeNull();
    expect(tidyFrames.some((f) => f.data.phase === "deferred")).toBe(true);

    unsub();
  });
});
