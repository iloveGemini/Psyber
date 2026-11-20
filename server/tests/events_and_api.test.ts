import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/api/app.ts";
import { SseHub, type SseFrame } from "../src/engine/sse.ts";
import { syncStaticStickers } from "../src/expression/stickers.ts";
import { createTestContext, type TestContext } from "./helpers.ts";

let ctx: TestContext | null = null;

function buildApp(c: TestContext, sse?: SseHub) {
  return createApp({
    version: "0.1.0",
    clock: c.clock,
    getConfig: () => c.config,
    events: c.events,
    getActiveSessionId: () => "sess-1",
    db: c.db,
    sse,
  });
}

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("T11 (Ring 1): Bearer 鉴权、幂等发消息、贴纸校验、door 游标与软删", () => {
  test("GET /api/v1/health 免鉴权，其余业务接口缺 Bearer Token 统一返回 401", async () => {
    ctx = await createTestContext();
    const app = buildApp(ctx);

    const health = await app.request("/api/v1/health");
    expect(health.status).toBe(200);
    const json = (await health.json()) as { ok: boolean; instanceId: string; serverTimeMs: number };
    expect(json.ok).toBe(true);
    expect(json.instanceId).toBe(ctx.config.instanceId);
    expect(json.serverTimeMs).toBe(ctx.clock.now());

    const noAuth = await app.request("/api/v1/door");
    expect(noAuth.status).toBe(401);
    const badAuth = await app.request("/api/v1/chat/history", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(badAuth.status).toBe(401);
  });

  test("POST /api/v1/chat/messages 幂等、校验 stickerId、关门 door_note 游标计数与软删", async () => {
    ctx = await createTestContext();
    const app = buildApp(ctx);
    const authHeaders = {
      authorization: `Bearer ${ctx.authToken}`,
      "content-type": "application/json",
    };

    // 1. 未知 stickerId 返回 400 INVALID_STICKER
    const badSticker = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "cmsg-bad-s", content: "", stickerId: "non-existent" }),
    });
    expect(badSticker.status).toBe(400);

    // 注册贴纸后可正常发送并在历史中还原 sticker 视图
    ctx.db
      .query(
        "INSERT INTO stickers (id, label, pack, media_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("cat-nod", "小猫点头", "default", "a".repeat(64), ctx.clock.now());

    const payload = { clientMessageId: "cmsg-001", content: "今天天气不错", stickerId: "cat-nod" };
    const r1 = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
    expect(r1.status).toBe(202);
    const j1 = (await r1.json()) as {
      deliveredAs: string;
      turnId: string;
      message: { id: string; seq: number; versionCount: number; sticker?: { id: string } };
    };
    expect(j1.deliveredAs).toBe("chat");
    expect(j1.turnId).toBeTruthy();
    expect(j1.message.versionCount).toBe(1);
    expect(j1.message.sticker?.id).toBe("cat-nod");

    // 重复 clientMessageId 幂等
    const r2 = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
    expect(r2.status).toBe(202);
    const j2 = (await r2.json()) as { message: { id: string; seq: number } };
    expect(j2.message.id).toBe(j1.message.id);
    expect(j2.message.seq).toBe(j1.message.seq);

    // 2. 切关门态：发送变为 door_note 且 turnId 为 null，/door 按 door_notes_read 游标计数
    ctx.config.door.state = "closed";
    const rClosed = await app.request("/api/v1/chat/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ clientMessageId: "cmsg-002", content: "门口放了热茶" }),
    });
    expect(rClosed.status).toBe(202);
    const jClosed = (await rClosed.json()) as {
      deliveredAs: string;
      turnId: string | null;
      message: { id: string; kind: string };
    };
    expect(jClosed.deliveredAs).toBe("door_note");
    expect(jClosed.turnId).toBeNull();

    const doorBefore = (await (
      await app.request("/api/v1/door", { headers: { authorization: `Bearer ${ctx.authToken}` } })
    ).json()) as { unreadDoorNotes: number };
    expect(doorBefore.unreadDoorNotes).toBe(1);

    // 推进 door_notes_read 游标后未读归零
    ctx.events.setCursor("door_notes_read", jClosed.message.id);
    const doorAfter = (await (
      await app.request("/api/v1/door", { headers: { authorization: `Bearer ${ctx.authToken}` } })
    ).json()) as { unreadDoorNotes: number };
    expect(doorAfter.unreadDoorNotes).toBe(0);

    // 3. 非法 ID 返回 400 INVALID_ID；合法软删后历史不再返回该条
    const badDel = await app.request("/api/v1/chat/messages/bad$id!", {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.authToken}` },
    });
    expect(badDel.status).toBe(400);

    const sse = new SseHub();
    const frames: SseFrame[] = [];
    sse.subscribe((f) => frames.push(f));
    const appWithSse = buildApp(ctx, sse);
    const delRes = await appWithSse.request(`/api/v1/chat/messages/${j1.message.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ctx.authToken}` },
    });
    expect(delRes.status).toBe(200);
    expect(frames.some((f) => f.event === "message.updated" && f.data.action === "delete" && f.data.deletedId === j1.message.id)).toBe(true);

    // 4. 启动静态 stickers/ 目录同步入库
    await fs.writeFile(path.join(ctx.dataDir, "stickers", "wave.png"), new Uint8Array([137, 80, 78, 71]));
    await fs.writeFile(
      path.join(ctx.dataDir, "stickers", "manifest.json"),
      JSON.stringify([{ id: "wave-hi", label: "挥手打招呼", file: "wave.png" }]),
    );
    const synced = await syncStaticStickers(ctx.db, ctx.dataDir, ctx.clock);
    expect(synced).toBe(1);
    expect(ctx.events.getSticker("wave-hi")?.label).toBe("挥手打招呼");

    const histRes = await app.request("/api/v1/chat/history", {
      headers: { authorization: `Bearer ${ctx.authToken}` },
    });
    const histJson = (await histRes.json()) as { items: Array<{ id: string; content: string; versionCount: number }> };
    expect(histJson.items.length).toBe(1);
    expect(histJson.items[0].content).toBe("门口放了热茶");
    expect(histJson.items[0].versionCount).toBe(1);
  });
});
