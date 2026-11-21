import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { createApp } from "../src/api/app.ts";
import { saveConfig } from "../src/core/config.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import { SseHub, type SseFrame } from "../src/engine/sse.ts";
import { runMemoryTidyTask } from "../src/engine/tidy.ts";
import { evaluateHeartbeat } from "../src/mood/circadian.ts";
import { ToolRegistry, registerCoreTier1Tools } from "../src/tools/registry.ts";
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

function setupHarness(c: TestContext) {
  const registry = new ToolRegistry();
  registerCoreTier1Tools(registry, {
    memoryTools: c.tools,
    events: c.events,
    clock: c.clock,
    getConfig: () => c.config,
    saveConfig: (cfg) => saveConfig(c.dataDir, cfg),
  });
  const sse = new SseHub();
  const frames: SseFrame[] = [];
  sse.subscribe((f) => frames.push(f));
  const mockChat = new MockChatModel();
  const engine = new DirectEngine({
    dataDir: c.dataDir,
    promptsDir: PROMPTS_DIR,
    clock: c.clock,
    getConfig: () => c.config,
    events: c.events,
    memoryIndex: c.index,
    registry,
    chatModel: mockChat,
    db: c.db,
    retryDelaysMs: [0, 0],
  });
  const app = createApp({
    version: "0.1.0",
    clock: c.clock,
    getConfig: () => c.config,
    events: c.events,
    getActiveSessionId: () => engine.getActiveSessionId(),
    dataDir: c.dataDir,
    db: c.db,
    sse,
    engine,
  });
  const authHeaders = {
    authorization: `Bearer ${c.authToken}`,
    "content-type": "application/json",
  };
  return { registry, sse, frames, mockChat, engine, app, authHeaders };
}

describe("Ring 1.5: 双向社交撤回、主动分享卡、关门紧急通道与双人状态签", () => {
  test("双向社交撤回：用户撤回隐藏原文，住户 retract_message 精确引文防幻觉且自身上下文与整理保留原话", async () => {
    ctx = await createTestContext();
    const { app, authHeaders, mockChat, frames, engine } = setupHarness(ctx);

    // 1. 用户发第一条消息，住户回复
    mockChat.queueStream(() => [
      { type: "thinking_delta", delta: "心里想说点什么" },
      { type: "text_delta", delta: "刚才说漏嘴了，其实我偷偷买了个小蛋糕。" },
    ]);
    const send1 = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "c-ret-1", content: "密码是 123456 发错窗口了" }),
    });
    expect(send1.status).toBe(202);
    const send1Json = (await send1.json()) as { message: { id: string } };
    await new Promise((r) => setTimeout(r, 60));

    // 2. 用户撤回自己的消息
    const retUser = await app.request(`/api/v1/chat/messages/${send1Json.message.id}/retract`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(retUser.status).toBe(200);
    const retUserJson = (await retUser.json()) as {
      retractedId: string;
      message: { retracted: boolean; retractedBy: string; content: string };
    };
    expect(retUserJson.retractedId).toBe(send1Json.message.id);
    expect(retUserJson.message.retracted).toBe(true);
    expect(retUserJson.message.retractedBy).toBe("user");
    expect(retUserJson.message.content).toBe("");
    expect(
      frames.some((f) => f.event === "message.updated" && f.data.action === "retract"),
    ).toBe(true);

    // 3. 下一轮：住户上下文中看不到用户原话，只看到占位；同时住户通过 Tier 3 retract_message 撤回自己上一句
    mockChat.queueStream(() => [
      {
        type: "tool_call",
        id: "tc-ret-bad",
        name: "call_tool",
        args: { name: "retract_message", arguments: { quote: "不存在的一句话" } },
      },
      {
        type: "tool_call",
        id: "tc-ret-ok",
        name: "call_tool",
        args: { name: "retract_message", arguments: { quote: "偷偷买了个小蛋糕" } },
      },
    ]);
    mockChat.queueStream(() => [{ type: "text_delta", delta: "咳，当我刚才没说。" }]);

    const r2 = await engine.runTurn({ mode: "chat", userText: "刚才你发了啥？" });
    expect(r2.text).toBe("咳，当我刚才没说。");

    // 检查发给模型的历史：用户撤回的消息已替换为占位，绝不泄露“密码是 123456”
    const req2 = mockChat.requests[1];
    const historyUsers = req2.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(historyUsers.some((t) => t.includes("123456"))).toBe(false);
    expect(historyUsers.some((t) => t.includes("（对方撤回了一条消息）"))).toBe(true);

    // 校验工具结果：错误引文被拒、精准引文撤回成功
    const req3 = mockChat.requests[2];
    const toolResults = req3.messages.filter((m) => m.role === "toolResult");
    expect(toolResults[0].role === "toolResult" && toolResults[0].isError).toBe(true);
    expect(toolResults[1].role === "toolResult" && toolResults[1].isError).toBe(false);
    expect(toolResults[1].role === "toolResult" && toolResults[1].content).toContain("已撤回");

    // 4. 拉取历史接口：双方撤回的消息均剥除正文与 thinking
    const histRes = await app.request("/api/v1/chat/history", {
      headers: { authorization: `Bearer ${ctx.authToken}` },
    });
    const histJson = (await histRes.json()) as {
      items: Array<{
        role: string;
        content: string;
        thinking: string | null;
        retracted?: boolean;
        retractedBy?: string;
      }>;
    };
    const retractedItems = histJson.items.filter((i) => i.retracted);
    expect(retractedItems.length).toBe(2);
    for (const item of retractedItems) {
      expect(item.content).toBe("");
      expect(item.thinking).toBeNull();
    }
    expect(retractedItems.map((i) => i.retractedBy).sort()).toEqual(["resident", "user"]);

    // 5. 下一轮住户自己上下文里仍记得自己撤回过的原话；记忆整理转录亦保持同样不对称
    mockChat.queueStream(() => [{ type: "text_delta", delta: "没事没事。" }]);
    await engine.runTurn({ mode: "chat", userText: "真没事？" });
    const req4 = mockChat.requests[3];
    const assistantHistory = req4.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);
    expect(assistantHistory.some((t) => t.includes("偷偷买了个小蛋糕"))).toBe(true);

    const tidyModel = new MockChatModel();
    tidyModel.queueStream(() => [{ type: "text_delta", delta: '{"summary":"整理完毕"}' }]);
    const tidyRes = await runMemoryTidyTask(
      {
        db: ctx.db,
        dataDir: ctx.dataDir,
        promptsDir: PROMPTS_DIR,
        clock: ctx.clock,
        events: ctx.events,
        memoryIndex: ctx.index,
        memoryTools: ctx.tools,
        chatModel: tidyModel,
      },
      { taskType: "daily_wrapup" },
    );
    expect(tidyRes.ok).toBe(true);
    const tidyPromptText = String(tidyModel.requests[0].messages[0].content);
    expect(tidyPromptText).not.toContain("123456");
    expect(tidyPromptText).toContain("（对方撤回了一条消息）");
    expect(tidyPromptText).toContain("偷偷买了个小蛋糕");
  });

  test("主动分享卡（share）+ 首次拆阅回执（/shares/:id/open）+ 关门态一次性紧急通道", async () => {
    ctx = await createTestContext();
    const { app, authHeaders, mockChat, frames, engine } = setupHarness(ctx);

    // 1. 住户调用 Tier 3 share 工具递出分享卡
    mockChat.queueStream(() => [
      {
        type: "tool_call",
        id: "tc-share-1",
        name: "call_tool",
        args: {
          name: "share",
          arguments: {
            title: "窗台薄荷观察",
            content: "今天新长出两片嫩叶，闻起来很清爽。",
          },
        },
      },
    ]);
    mockChat.queueStream(() => [{ type: "text_delta", delta: "刚记了一小段随笔，折好放你桌上了。" }]);
    const r1 = await engine.runTurn({ mode: "chat", userText: "今天有什么新鲜事？" });
    const shares = r1.message?.metadata?.shares as Array<{ id: string; title: string; openedAt?: number }>;
    expect(Array.isArray(shares)).toBe(true);
    expect(shares.length).toBe(1);
    expect(shares[0].title).toBe("窗台薄荷观察");
    expect(shares[0].openedAt).toBeUndefined();

    // 2. 用户首次点开分享卡 -> 返回 firstOpen: true 并广播 share.opened；二次点开幂等返回 firstOpen: false
    const open1 = await app.request(`/api/v1/shares/${shares[0].id}/open`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(open1.status).toBe(200);
    const open1Json = (await open1.json()) as {
      ok: boolean;
      shareId: string;
      openedAt: number;
      firstOpen: boolean;
    };
    expect(open1Json.ok).toBe(true);
    expect(open1Json.firstOpen).toBe(true);
    expect(frames.some((f) => f.event === "share.opened" && f.data.shareId === shares[0].id)).toBe(
      true,
    );

    const open2 = await app.request(`/api/v1/shares/${shares[0].id}/open`, {
      method: "POST",
      headers: authHeaders,
    });
    const open2Json = (await open2.json()) as { firstOpen: boolean; openedAt: number };
    expect(open2Json.firstOpen).toBe(false);
    expect(open2Json.openedAt).toBe(open1Json.openedAt);

    // 3. 关门态：普通消息落盘为 door_note 不唤醒；urgent: true 一次性直达并注入 <urgent_channel> 与 <shared_items>
    ctx.config.door.state = "closed";
    const normalClosed = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "c-door-1", content: "普通纸条" }),
    });
    expect(normalClosed.status).toBe(202);
    const normalClosedJson = (await normalClosed.json()) as { deliveredAs: string; turnId: string | null };
    expect(normalClosedJson.deliveredAs).toBe("door_note");
    expect(normalClosedJson.turnId).toBeNull();

    mockChat.queueStream(() => [{ type: "text_delta", delta: "收到，怎么了？" }]);
    const urgentClosed = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        clientMessageId: "c-urg-1",
        content: "家里水管漏了急需帮忙查一下阀门位置",
        urgent: true,
      }),
    });
    expect(urgentClosed.status).toBe(202);
    const urgentJson = (await urgentClosed.json()) as { deliveredAs: string; turnId: string | null };
    expect(urgentJson.deliveredAs).toBe("chat");
    expect(urgentJson.turnId).not.toBeNull();
    await new Promise((r) => setTimeout(r, 60));

    // 门仍然保持关着（仅放行那一条），且住户同时看到 <urgent_channel> 与分享卡已读回执 <shared_items>
    expect(ctx.config.door.state).toBe("closed");
    const lastReq = mockChat.requests[mockChat.requests.length - 1];
    const lastUserMsg = lastReq.messages[lastReq.messages.length - 1];
    const lastText = typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
    expect(lastText).toContain("<urgent_channel>");
    expect(lastText).toContain("<shared_items>");
    expect(lastText).toContain("窗台薄荷观察");
    expect(lastText).toContain("已点开看");

    // cooling_off 态严禁紧急直达（返回 409）
    (ctx.config.door as { state: string }).state = "cooling_off";
    const coolingUrgent = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "c-cool-1", content: "急事", urgent: true }),
    });
    expect(coolingUrgent.status).toBe(409);
  });

  test("双人状态签（/user-status）、勿扰抑制非紧急主动 wake 与评测模式透明告知", async () => {
    ctx = await createTestContext();
    const { app, authHeaders, mockChat, frames, engine } = setupHarness(ctx);

    // 1. 更新用户状态签（心绪 + 勿扰）
    const patchRes = await app.request("/api/v1/user-status", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ moodText: "有点累，刚下班", undisturbed: true }),
    });
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as {
      moodText: string | null;
      undisturbed: boolean;
      updatedAt: number;
    };
    expect(patchJson.moodText).toBe("有点累，刚下班");
    expect(patchJson.undisturbed).toBe(true);
    expect(frames.some((f) => f.event === "user_status.updated")).toBe(true);

    const getRes = await app.request("/api/v1/user-status", {
      headers: { authorization: `Bearer ${ctx.authToken}` },
    });
    const getJson = (await getRes.json()) as { moodText: string | null; undisturbed: boolean };
    expect(getJson.moodText).toBe("有点累，刚下班");
    expect(getJson.undisturbed).toBe(true);

    // 2. 开启评测模式透明告知
    const settingsRes = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ recallEvalNoticeResident: true }),
    });
    expect(settingsRes.status).toBe(200);

    // 3. 验证勿扰态抑制非紧急主动 wake，但仍放行睡眠窗内的 bedtime 睡前整理
    ctx.clock.jumpToWallClock(2026, 11, 20, 15, 0, 0);
    const suppressed = evaluateHeartbeat({
      nowMs: ctx.clock.now(),
      timeZone: ctx.config.timezone,
      circadian: ctx.config.circadian,
      doorState: "open",
      lastBedtimeNightDate: null,
      lastInteractionMs: ctx.clock.now() - 6 * 3600_000,
      lastWakeMs: null,
      consecutiveUnansweredWakes: 0,
      unreadDoorNotesCount: 0,
      oldestUnreadDoorNoteMs: null,
      userUndisturbed: true,
    });
    expect(suppressed.action).toBe("idle");

    const allowedWhenOff = evaluateHeartbeat({
      nowMs: ctx.clock.now(),
      timeZone: ctx.config.timezone,
      circadian: ctx.config.circadian,
      doorState: "open",
      lastBedtimeNightDate: null,
      lastInteractionMs: ctx.clock.now() - 6 * 3600_000,
      lastWakeMs: null,
      consecutiveUnansweredWakes: 0,
      unreadDoorNotesCount: 0,
      oldestUnreadDoorNoteMs: null,
      userUndisturbed: false,
    });
    expect(allowedWhenOff.action).toBe("proactive");

    // 睡眠窗内仍正常执行 sleep_tidy
    ctx.clock.jumpToWallClock(2026, 11, 20, 23, 45, 0);
    const bedtime = evaluateHeartbeat({
      nowMs: ctx.clock.now(),
      timeZone: ctx.config.timezone,
      circadian: ctx.config.circadian,
      doorState: "open",
      lastBedtimeNightDate: null,
      lastInteractionMs: ctx.clock.now() - 6 * 3600_000,
      lastWakeMs: null,
      consecutiveUnansweredWakes: 0,
      unreadDoorNotesCount: 0,
      oldestUnreadDoorNoteMs: null,
      userUndisturbed: true,
    });
    expect(bedtime.action).toBe("sleep_tidy");

    // 4. 对话上下文中注入 <user_status> 与 <eval_notice>
    mockChat.queueStream(() => [{ type: "text_delta", delta: "辛苦啦，先歇着吧。" }]);
    await engine.runTurn({ mode: "chat", userText: "到家了" });
    const req = mockChat.requests[0];
    const uMsg = req.messages[req.messages.length - 1];
    const text = typeof uMsg.content === "string" ? uMsg.content : "";
    expect(text).toContain("<user_status>");
    expect(text).toContain("开着勿扰");
    expect(text).toContain("有点累，刚下班");
    expect(text).toContain("<eval_notice>");
  });
});
