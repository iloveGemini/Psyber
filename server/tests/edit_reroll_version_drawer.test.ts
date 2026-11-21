import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VirtualClock } from "../src/core/clock.ts";
import { bootPsyberRuntime, type PsyberRuntime } from "../src/index.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";

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
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Ring 1.5 Edit / Reroll / Version 多版本状态机与上锁抽屉闭环", () => {
  test("Edit 仅允许改末条活跃用户消息，弃用旧回复并触发新轮；关门态仅允许改 door_note", async () => {
    const dataDir = await createTempDir("psyber-edit-");
    const clock = new VirtualClock(Date.UTC(2026, 10, 21, 11, 0, 0), "Asia/Shanghai");
    const seenPrompts: string[] = [];
    let callIndex = 0;

    const chatModel: ChatModelClient = {
      contextWindow: 100_000,
      modelId: "mock-chat",
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        callIndex += 1;
        const last = req.messages[req.messages.length - 1];
        const text = typeof last?.content === "string" ? last.content : "";
        seenPrompts.push(text);
        yield { type: "text_delta", delta: `回复#${callIndex}` };
        yield { type: "usage", inputTokens: 100, outputTokens: 20, totalTokens: 120 };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      chatModel,
      startHeartbeatTimer: false,
    });

    try {
      const token = await pairClient(rt);
      const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      // 发出第 1 条与第 2 条消息
      const r1 = await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientMessageId: "cm-e1", content: "第一句话" }),
      });
      const b1 = (await r1.json()) as { message: { id: string } };
      await waitUntil(() => callIndex === 1);

      clock.advance(2000);
      const r2 = await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientMessageId: "cm-e2", content: "第二句话（打错了）" }),
      });
      const b2 = (await r2.json()) as { message: { id: string; turnId: string } };
      await waitUntil(() => callIndex === 2);

      // 编辑非末条消息 -> 409 NOT_LATEST_USER_MESSAGE
      const badEdit = await rt.app.request(`/api/v1/chat/messages/${b1.message.id}/edit`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ content: "想改第一句" }),
      });
      expect(badEdit.status).toBe(409);
      const badBody = (await badEdit.json()) as { error: { code: string } };
      expect(badBody.error.code).toBe("NOT_LATEST_USER_MESSAGE");

      // 编辑末条消息 -> 202，生成新 turnId，弃用旧用户行和旧回复#2，触发回复#3
      clock.advance(2000);
      const okEdit = await rt.app.request(`/api/v1/chat/messages/${b2.message.id}/edit`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ content: "第二句话（改好了）" }),
      });
      expect(okEdit.status).toBe(202);
      const okBody = (await okEdit.json()) as { message: { id: string; version: number; groupId: string }; turnId: string };
      expect(okBody.message.version).toBe(2);
      expect(okBody.turnId).toBeTruthy();
      expect(okBody.turnId).not.toBe(b2.message.turnId);
      await waitUntil(() => callIndex === 3);

      // 历史中不再出现被弃用的原用户消息与旧回复#2
      const histRes = await rt.app.request("/api/v1/chat/history", {
        headers: { authorization: `Bearer ${token}` },
      });
      const hist = (await histRes.json()) as { items: Array<{ content: string; role: string }> };
      const contents = hist.items.map((x) => x.content);
      expect(contents).toContain("第一句话");
      expect(contents).toContain("回复#1");
      expect(contents).not.toContain("第二句话（打错了）");
      expect(contents).not.toContain("回复#2");
      expect(contents).toContain("第二句话（改好了）");
      expect(contents).toContain("回复#3");

      // 关门态：禁止编辑 chat（409 DOOR_CLOSED），但允许编辑最新 door_note 且不唤醒 AI
      rt.config.door.state = "closed";
      const closedChatEdit = await rt.app.request(`/api/v1/chat/messages/${okBody.message.id}/edit`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ content: "关门后想偷改 chat" }),
      });
      expect(closedChatEdit.status).toBe(409);

      const noteRes = await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientMessageId: "cm-note1", content: "门缝纸条原稿" }),
      });
      const noteBody = (await noteRes.json()) as { message: { id: string }; deliveredAs: string };
      expect(noteBody.deliveredAs).toBe("door_note");

      const noteEdit = await rt.app.request(`/api/v1/chat/messages/${noteBody.message.id}/edit`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ content: "门缝纸条修改稿" }),
      });
      expect(noteEdit.status).toBe(202);
      const noteEditBody = (await noteEdit.json()) as { turnId: string | null };
      expect(noteEditBody.turnId).toBeNull();
      expect(callIndex).toBe(3); // 关门改纸条绝不唤醒 AI
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("Reroll 生成独立 turnId 的版本组并支持 /version 双向切换，拒绝切换 discarded", async () => {
    const dataDir = await createTempDir("psyber-reroll-");
    const clock = new VirtualClock(Date.UTC(2026, 10, 21, 12, 0, 0), "Asia/Shanghai");
    let replySeq = 0;

    const chatModel: ChatModelClient = {
      contextWindow: 100_000,
      modelId: "mock-chat",
      async *stream(): AsyncIterable<ChatStreamChunk> {
        replySeq += 1;
        yield { type: "text_delta", delta: `第${replySeq}版回答` };
        yield { type: "usage", inputTokens: 80, outputTokens: 20, totalTokens: 100 };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      chatModel,
      startHeartbeatTimer: false,
    });

    try {
      const token = await pairClient(rt);
      const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientMessageId: "cm-r1", content: "今天天气怎么样？" }),
      });
      await waitUntil(() => replySeq === 1);

      const h1 = (await (
        await rt.app.request("/api/v1/chat/history", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { items: Array<{ id: string; role: string; turnId: string; content: string }> };
      const asstV1 = h1.items.find((x) => x.role === "assistant")!;
      expect(asstV1.content).toBe("第1版回答");

      // Reroll -> 202，生成第 2 版回答与全新 turnId
      clock.advance(1000);
      const rerollRes = await rt.app.request(`/api/v1/chat/messages/${asstV1.id}/reroll`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      });
      expect(rerollRes.status).toBe(202);
      const rerollBody = (await rerollRes.json()) as {
        turnId: string;
        groupId: string;
        nextVersion: number;
      };
      expect(rerollBody.nextVersion).toBe(2);
      expect(rerollBody.turnId).not.toBe(asstV1.turnId);
      await waitUntil(() => replySeq === 2);

      const h2 = (await (
        await rt.app.request("/api/v1/chat/history", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as {
        items: Array<{
          id: string;
          role: string;
          content: string;
          version: number;
          versionCount: number;
          groupId: string | null;
        }>;
      };
      const asstV2 = h2.items.find((x) => x.role === "assistant")!;
      expect(asstV2.content).toBe("第2版回答");
      expect(asstV2.version).toBe(2);
      expect(asstV2.versionCount).toBe(2);
      expect(asstV2.groupId).toBe(rerollBody.groupId);

      // 切换回第 1 版
      const sw1 = await rt.app.request(`/api/v1/chat/messages/${asstV2.id}/version`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ version: 1 }),
      });
      expect(sw1.status).toBe(200);
      const sw1Body = (await sw1.json()) as {
        activated: { id: string; content: string; version: number; versionCount: number };
      };
      expect(sw1Body.activated.id).toBe(asstV1.id);
      expect(sw1Body.activated.content).toBe("第1版回答");
      expect(sw1Body.activated.version).toBe(1);
      expect(sw1Body.activated.versionCount).toBe(2);

      // 切换不存在的版本 -> 409 INVALID_VERSION_TARGET
      const swBad = await rt.app.request(`/api/v1/chat/messages/${asstV1.id}/version`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ version: 9 }),
      });
      expect(swBad.status).toBe(409);

      // 关门态禁止 Reroll -> 409 DOOR_CLOSED
      rt.config.door.state = "closed";
      const closedReroll = await rt.app.request(`/api/v1/chat/messages/${asstV1.id}/reroll`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      });
      expect(closedReroll.status).toBe(409);
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("上锁抽屉 .sealed 磁盘零明文 + 三道零入库隔离 + 写先于读 privacy.peeked 与 events_notice 游标", async () => {
    const dataDir = await createTempDir("psyber-drawer-");
    const clock = new VirtualClock(Date.UTC(2026, 10, 21, 13, 0, 0), "Asia/Shanghai");
    const seenUserBlocks: string[] = [];
    let turnNo = 0;

    const chatModel: ChatModelClient = {
      contextWindow: 100_000,
      modelId: "mock-chat",
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        turnNo += 1;
        const last = req.messages[req.messages.length - 1];
        const text = typeof last?.content === "string" ? last.content : "";
        seenUserBlocks.push(text);
        if (turnNo === 1) {
          // 住户通过 Tier 1 call_tool 调用 Tier 3 drawer_write
          yield {
            type: "tool_call",
            id: "tc-dw-1",
            name: "call_tool",
            args: {
              name: "drawer_write",
              arguments: {
                id: "2026-11-21-late-night",
                title: "深夜随笔",
                content: "今天心里有点乱，想把这份脆弱先锁进抽屉里。",
              },
            },
          };
          return;
        }
        if (turnNo === 2) {
          yield { type: "text_delta", delta: "写好收起来了。" };
          return;
        }
        yield { type: "text_delta", delta: `收到第${turnNo}轮` };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      chatModel,
      startHeartbeatTimer: false,
    });

    try {
      const token = await pairClient(rt);
      const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      // 1. 触发住户调用 drawer_write
      await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientMessageId: "cm-d1", content: "晚安，你自己写点日记吧" }),
      });
      await waitUntil(() => turnNo === 2);

      // 2. 验证磁盘 .sealed 格式且绝不含明文中文正文
      const sealedPath = path.join(dataDir, "private", "2026-11-21-late-night.sealed");
      const rawDisk = await fs.readFile(sealedPath, "utf8");
      expect(rawDisk.startsWith("PSYBER-SEALED-V1\n")).toBe(true);
      expect(rawDisk).not.toContain("脆弱");
      expect(rawDisk).not.toContain("今天心里有点乱");

      // 3. 验证三道零入库隔离：SQLite card_index / card_fts 零 private 记录，且无 privacy.peeked
      const indexCount = rt.db
        .query("SELECT COUNT(*) AS cnt FROM card_index WHERE path LIKE '%private%' OR path LIKE '%late-night%'")
        .get() as { cnt: number };
      expect(indexCount.cnt).toBe(0);
      const peekCountBefore = rt.db
        .query("SELECT COUNT(*) AS cnt FROM events WHERE kind = 'privacy.peeked'")
        .get() as { cnt: number };
      expect(peekCountBefore.cnt).toBe(0);

      // 4. 住户自己读取不产生 privacy.peeked
      const selfRead = await rt.drawer.readEntryForResident("2026-11-21-late-night");
      expect(selfRead?.content).toBe("今天心里有点乱，想把这份脆弱先锁进抽屉里。");
      const peekAfterSelfRead = rt.db
        .query("SELECT COUNT(*) AS cnt FROM events WHERE kind = 'privacy.peeked'")
        .get() as { cnt: number };
      expect(peekAfterSelfRead.cnt).toBe(0);

      // 5. GET /api/v1/drawer 仅返回清单，绝不返回正文
      const listRes = await rt.app.request("/api/v1/drawer", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(listBody.items).toHaveLength(1);
      expect(listBody.items[0]!.id).toBe("2026-11-21-late-night");
      expect(listBody.items[0]!.title).toBe("深夜随笔");
      expect(listBody.items[0]!.peeked).toBe(false);
      expect(listBody.items[0]!.content).toBeUndefined();

      // 6. POST /drawer/:id/open 缺少 confirmed: true -> 400
      const unconfirmedRes = await rt.app.request("/api/v1/drawer/2026-11-21-late-night/open", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      });
      expect(unconfirmedRes.status).toBe(400);

      // 7. 显式确认拆封 -> 写入 privacy.peeked 并返回明文
      clock.advance(5000);
      const openRes = await rt.app.request("/api/v1/drawer/2026-11-21-late-night/open", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ confirmed: true }),
      });
      expect(openRes.status).toBe(200);
      const opened = (await openRes.json()) as {
        id: string;
        title: string;
        content: string;
        peekedEventId: string;
      };
      expect(opened.content).toBe("今天心里有点乱，想把这份脆弱先锁进抽屉里。");
      expect(opened.peekedEventId).toBeTruthy();

      const peekRow = rt.events.getById(opened.peekedEventId);
      expect(peekRow?.kind).toBe("privacy.peeked");

      // GET /drawer 现在显示 peeked: true
      const listAfter = (await (
        await rt.app.request("/api/v1/drawer", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { items: Array<{ peeked: boolean; lastPeekedAt?: number }> };
      expect(listAfter.items[0]!.peeked).toBe(true);
      expect(listAfter.items[0]!.lastPeekedAt).toBeGreaterThan(0);

      // 8. 下一轮对话注入 <events_notice> 客观事实，且完成后推进游标、再下一轮不重复注入
      clock.advance(60_000);
      await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientMessageId: "cm-d2", content: "早安" }),
      });
      await waitUntil(() => turnNo === 3);
      expect(seenUserBlocks[2]).toContain("<events_notice>");
      expect(seenUserBlocks[2]).toContain("拆封查看了上锁抽屉中的「深夜随笔」");

      clock.advance(60_000);
      await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ clientMessageId: "cm-d3", content: "今天吃什么" }),
      });
      await waitUntil(() => turnNo === 4);
      expect(seenUserBlocks[3]).not.toContain("<events_notice>");
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
