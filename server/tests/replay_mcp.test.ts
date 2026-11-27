import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/api/app.ts";
import { VirtualClock, localDay } from "../src/core/clock.ts";
import { loadOrCreateConfig, mergeMemoryMcpConfig, saveConfig } from "../src/core/config.ts";
import { commitMemoryPaths, getMemoryHeadCommit, readMemoryGitLog } from "../src/core/git.ts";
import { AsyncMutex } from "../src/core/mutex.ts";
import { bootPsyberRuntime, type PsyberRuntime } from "../src/index.ts";
import { ulid } from "../src/core/ulid.ts";
import { createTestContext, type TestContext } from "./helpers.ts";
import { MockChatModel } from "./mocks/chat_model.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

let ctx: TestContext | null = null;
let runtime: PsyberRuntime | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  if (runtime) {
    await runtime.stop({ waitTimeoutMs: 2_000 });
    runtime = null;
  }
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `psyber-replay-mcp-test-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

function mcpRpc(
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

async function callMcpTool(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: mcpRpc("tools/call", { name, arguments: args }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (body.error) {
    return { isError: true, text: body.error.message ?? "RPC error" };
  }
  return {
    isError: Boolean(body.result?.isError),
    text: body.result?.content?.[0]?.text ?? "",
  };
}

function insertHistoricalEvent(
  c: Pick<TestContext, "db">,
  input: {
    seq: number;
    atMs: number;
    role: "user" | "assistant";
    kind?: "chat" | "wake" | "door_note";
    status?: "active" | "retracted" | "deleted";
    turnId: string;
    sessionId?: string;
    content: string;
    metadata?: Record<string, unknown>;
  },
): string {
  const id = ulid(input.atMs);
  c.db
    .query(
      `INSERT INTO events (
        id, seq, session_id, turn_id, client_message_id,
        group_id, version, status, role, kind,
        source, fonds, activity, content, thinking, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, 'import', 'test-import', NULL, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      input.seq,
      input.sessionId ?? "import-sess-1",
      input.turnId,
      `import:test:${input.seq}`,
      input.status ?? "active",
      input.role,
      input.kind ?? "chat",
      input.content,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.atMs,
    );
  return id;
}

function extractStepId(output: string): string {
  const m = /^step_id:\s*(.+)$/m.exec(output);
  if (!m) throw new Error(`未能从任务包提取 step_id:\n${output.slice(0, 300)}`);
  return m[1]!.trim();
}

describe("对外记忆 MCP 第二阶段（单工具 memory_replay 搬家工具链）", () => {
  test("三重门控：replayToolsEnabled=false / read_only / 单令牌降权均隐藏并拒绝，/settings 校验生效", async () => {
    const c = (ctx = await createTestContext());
    const app = createApp({
      version: "0.1.0",
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      getActiveSessionId: () => "sess-1",
      dataDir: c.dataDir,
      promptsDir: PROMPTS_DIR,
      db: c.db,
      memoryIndex: c.index,
      memoryTools: c.tools,
      memoryGitMutex: new AsyncMutex(),
    });

    const authHeaders = {
      authorization: `Bearer ${c.authToken}`,
      "content-type": "application/json",
    };

    const rwTokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "rw-client" }),
    });
    const rwToken = ((await rwTokRes.json()) as { token: string }).token;

    const roTokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "ro-client", accessMode: "read_only" }),
    });
    const roToken = ((await roTokRes.json()) as { token: string }).token;

    // 1. /settings 非法 replayToolsEnabled 校验
    const badPatch = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ memoryMcp: { replayToolsEnabled: "yes" } }),
    });
    expect(badPatch.status).toBe(400);

    // 2. 开启 MCP + read_write，但默认 replayToolsEnabled=false -> 不暴露且拒绝
    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ memoryMcp: { enabled: true, accessMode: "read_write" } }),
    });
    const list1 = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${rwToken}`, "content-type": "application/json" },
      body: mcpRpc("tools/list"),
    });
    const tools1 = ((await list1.json()) as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools1.map((t) => t.name)).not.toContain("memory_replay");

    const call1 = await callMcpTool(app, rwToken, "memory_replay", { action: "status" });
    expect(call1.isError).toBe(true);
    expect(call1.text).toContain("replayToolsEnabled");

    // 3. 开启 replayToolsEnabled=true，但在全局 read_only 或令牌降权 read_only 下仍隐藏并拒绝
    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ memoryMcp: { accessMode: "read_only", replayToolsEnabled: true } }),
    });
    const listGlobalRo = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${rwToken}`, "content-type": "application/json" },
      body: mcpRpc("tools/list"),
    });
    expect(
      ((await listGlobalRo.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (t) => t.name,
      ),
    ).not.toContain("memory_replay");

    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ memoryMcp: { accessMode: "read_write", replayToolsEnabled: true } }),
    });
    const listTokenRo = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${roToken}`, "content-type": "application/json" },
      body: mcpRpc("tools/list"),
    });
    expect(
      ((await listTokenRo.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (t) => t.name,
      ),
    ).not.toContain("memory_replay");
    const callTokenRo = await callMcpTool(app, roToken, "memory_replay", { action: "status" });
    expect(callTokenRo.isError).toBe(true);

    // 4. 三重门控全开后可见且可执行
    const listOk = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${rwToken}`, "content-type": "application/json" },
      body: mcpRpc("tools/list"),
    });
    expect(
      ((await listOk.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (t) => t.name,
      ),
    ).toContain("memory_replay");
    const callOk = await callMcpTool(app, rwToken, "memory_replay", { action: "status" });
    expect(callOk.isError).toBe(false);
    expect(callOk.text).toContain("status: idle");
  });

  test("完整多日搬家闭环：低量日顺延、超长日不拆 turn 且豁免全局截断、历史时钟与 protectCoreFiles 分级放行、单步统一 Commit 与 replay_state 同步", async () => {
    // 真实当前时间为 2026-11-20，而搬家历史在 2026-06-12..15
    const c = (ctx = await createTestContext({
      initialTimeMs: Date.UTC(2026, 10, 20, 4, 0, 0),
    }));

    await c.tools.write(
      "core/self.md",
      "---\ntitle: 自我档案\nkind: note\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n我是 TestPsyber。",
    );
    await c.tools.write(
      "core/user.md",
      "---\ntitle: 对方档案\nkind: note\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\nname: 小林\npronoun: 她\n---\n对方叫小林。",
    );
    await c.tools.write(
      "threads/REGISTRY.yaml",
      "spaces:\n  walks:\n    title: 散步笔记\n    triggers: [散步, 公园]\n    decay: none\n    card_style: \"记录每次散步细节\"\n",
    );
    await c.tools.write(
      "threads/walks/park.md",
      "---\ntitle: 公园长椅\nkind: note\nstatus: active\ncreated: 2026-06-10\nupdated: 2026-06-10\n---\n六月初第一次路过南门那排槐树下的长椅。",
    );
    await commitMemoryPaths(
      c.dataDir,
      ["core/self.md", "core/user.md", "threads/REGISTRY.yaml", "threads/walks/park.md"],
      "memory(genesis): init baseline",
    );

    // 写入模拟 replay.ts --init --import-only 留下的 replay_state.json
    await fs.writeFile(
      path.join(c.dataDir, "replay_state.json"),
      JSON.stringify(
        {
          version: 1,
          sourcePath: "/tmp/synthetic.jsonl",
          importedDays: ["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15"],
          tidiedDays: [],
          results: {
            "2026-06-12": { day: "2026-06-12", importedAt: "2026-11-20T00:00:00Z", importedEvents: 2, importedAttachments: 0 },
            "2026-06-13": { day: "2026-06-13", importedAt: "2026-11-20T00:00:00Z", importedEvents: 2, importedAttachments: 0 },
            "2026-06-14": { day: "2026-06-14", importedAt: "2026-11-20T00:00:00Z", importedEvents: 4, importedAttachments: 0 },
            "2026-06-15": { day: "2026-06-15", importedAt: "2026-11-20T00:00:00Z", importedEvents: 2, importedAttachments: 0 },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // 2026-06-12 (周五) 正常日（> 500 字）+ 1 条不可泄露的用户撤回 & 1 条已删除消息
    let seq = 1;
    const t0612 = Date.UTC(2026, 5, 12, 12, 0, 0);
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t0612,
      role: "user",
      turnId: "t-0612-1",
      content:
        "周五晚上下班买了一杯手冲耶加雪菲，边走边听歌，还拍了照片。晚风很舒服，路过面包店时又顺便带了两只可颂回家，打算周末早上烤热了配咖啡吃。".repeat(8),
      metadata: { attachments: ["hash_coffee_01"] },
    });
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t0612 + 30_000,
      role: "assistant",
      turnId: "t-0612-1",
      content: "听起来这一周收尾得很松弛，花香调的豆子配晚风正好，可颂留到明早配咖啡一定很香。",
    });
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t0612 + 60_000,
      role: "user",
      status: "retracted",
      turnId: "t-0612-2",
      content: "SECRET_RETRACTED_TEXT_MUST_NOT_LEAK",
    });
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t0612 + 90_000,
      role: "user",
      status: "deleted",
      turnId: "t-0612-3",
      content: "SECRET_DELETED_TEXT_MUST_NOT_LEAK",
    });

    // 2026-06-13 (周六) 低量日（< 500 字），应当自动顺延并入 2026-06-14
    const t0613 = Date.UTC(2026, 5, 13, 13, 0, 0);
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t0613,
      role: "user",
      turnId: "t-0613-1",
      content: "周六午后打了个盹，懒洋洋的。",
    });
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t0613 + 20_000,
      role: "assistant",
      turnId: "t-0613-1",
      content: "周末本来就该留一点发呆的空隙。",
    });

    // 2026-06-14 (周日) 超长日：2 个 turn 共约 5400 字；配合 max_chars=4000 拆为 2 批且不切断同 turn，且总输出 > maxOutputChars(2000) 不被截断
    const t0614 = Date.UTC(2026, 5, 14, 14, 0, 0);
    const turn1User = "周日去河滨公园走了很远的路，看到很多有趣的小摊和街头艺人。" + "河风吹过树梢，".repeat(260);
    const turn1Asst = "能连续走那么久说明状态恢复得不错，我把河滨这段路记在心里。" + "细节很清晰，".repeat(260);
    const turn2User = "晚上回家后在阳台一起核对了接下来的读书单和散步路线，发现槐树长椅那边修好了。" + "路线补充，".repeat(260);
    const turn2Asst = "太好了，下回正好再去南门长椅坐一会儿。结尾标记：TAIL_MARKER_0614";
    insertHistoricalEvent(c, { seq: seq++, atMs: t0614, role: "user", turnId: "t-0614-1", content: turn1User });
    insertHistoricalEvent(c, { seq: seq++, atMs: t0614 + 20_000, role: "assistant", turnId: "t-0614-1", content: turn1Asst });
    insertHistoricalEvent(c, { seq: seq++, atMs: t0614 + 40_000, role: "user", turnId: "t-0614-2", content: turn2User });
    insertHistoricalEvent(c, { seq: seq++, atMs: t0614 + 60_000, role: "assistant", turnId: "t-0614-2", content: turn2Asst });

    // 2026-06-15 (周一) 正常日（> 500 字）
    const t0615 = Date.UTC(2026, 5, 15, 11, 0, 0);
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t0615,
      role: "user",
      turnId: "t-0615-1",
      content: "周一早上重新整理了书桌和日程本，把这周要读的两本书摆到台灯旁边，心情比上个月笃定很多。".repeat(8),
    });
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t0615 + 20_000,
      role: "assistant",
      turnId: "t-0615-1",
      content: "新的周一开局很稳，我在旁边陪你把节奏慢慢接住。".repeat(4),
    });

    const app = createApp({
      version: "0.1.0",
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      getActiveSessionId: () => "sess-1",
      dataDir: c.dataDir,
      promptsDir: PROMPTS_DIR,
      db: c.db,
      memoryIndex: c.index,
      memoryTools: c.tools,
      memoryGitMutex: new AsyncMutex(),
    });

    const authHeaders = { authorization: `Bearer ${c.authToken}`, "content-type": "application/json" };
    const tokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "claude-desktop" }),
    });
    const mcpToken = ((await tokRes.json()) as { token: string }).token;

    // 故意把全局 maxOutputChars 调小为 2000，验证 memory_replay 豁免全局截断且 protectCoreFiles=true
    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        memoryMcp: {
          enabled: true,
          accessMode: "read_write",
          protectCoreFiles: true,
          replayToolsEnabled: true,
          maxOutputChars: 2000,
        },
      }),
    });

    // Step 1: start(all=true, max_chars=4000, min_chars=500) -> 拿到 2026-06-12 wrapup
    const s1 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "start",
      all: true,
      max_chars: 4000,
      min_chars: 500,
    });
    expect(s1.isError).toBe(false);
    expect(s1.text).toContain("day: 2026-06-12");
    expect(s1.text).toContain("phase: wrapup");
    expect(s1.text).toContain("media/hash_coffee_01");
    expect(s1.text).toContain("小林撤回了一条消息");
    expect(s1.text).not.toContain("SECRET_RETRACTED_TEXT_MUST_NOT_LEAK");
    expect(s1.text).not.toContain("SECRET_DELETED_TEXT_MUST_NOT_LEAK");
    const step1Id = extractStepId(s1.text);

    // 验证 protectCoreFiles=true 时搬家内放行 core/state.md 但拦截 core/self.md
    const blockedSelf = await callMcpTool(app, mcpToken, "memory_edit", {
      path: "core/self.md",
      old_string: "我是 TestPsyber。",
      new_string: "篡改自我",
    });
    expect(blockedSelf.isError).toBe(true);
    expect(blockedSelf.text).toContain("protectCoreFiles");

    const wState = await callMcpTool(app, mcpToken, "memory_write", {
      path: "core/state.md",
      content:
        "---\ntitle: 近期状态\nkind: note\nstatus: active\ncreated: 2026-06-12\nupdated: 2026-06-12\n---\n## 短期状态与待办\n- [至 2026-06-18] 本周整理散步路线（[[06-12 晚风手冲]]）\n",
    });
    expect(wState.isError).toBe(false);
    expect(wState.text).toContain("已暂存至当前搬家步骤");

    const wEp1 = await callMcpTool(app, mcpToken, "memory_write", {
      path: "episodes/2026/06/12/ep-coffee.md",
      content:
        "---\ntitle: 06-12 晚风手冲\nkind: episode\nstatus: active\ncreated: 2026-06-12\nupdated: 2026-06-12\n---\n买了一杯花香调的耶加雪菲，拍了 [照片](media/hash_coffee_01)。",
    });
    expect(wEp1.isError).toBe(false);

    // 确认步内未碎提交 git
    const headBeforeNext = await getMemoryHeadCommit(c.dataDir);
    const logBeforeNext = await readMemoryGitLog(c.dataDir, { limit: 10 });
    expect(logBeforeNext.ok).toBe(true);
    if (logBeforeNext.ok) {
      expect(logBeforeNext.stdout).not.toContain("06-12");
    }

    // 交卷 Step 1 -> 拿到 2026-06-12 bedtime，且 core/state.md 按 2026-06-12 过滤（未因今天 2026-11-20 过期消失！）
    const s2 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: step1Id,
      summary: "记06-12晚风手冲",
    });
    expect(s2.isError).toBe(false);
    expect(s2.text).toContain("day: 2026-06-12");
    expect(s2.text).toContain("phase: bedtime");
    expect(s2.text).toContain("本周整理散步路线");
    const headAfterStep1 = await getMemoryHeadCommit(c.dataDir);
    expect(headAfterStep1).not.toBe(headBeforeNext);

    const wIdx1 = await callMcpTool(app, mcpToken, "memory_write", {
      path: "episodes/2026/06/12/index.md",
      content:
        "---\ntitle: 2026-06-12 日梗概\nkind: note\nstatus: active\ncreated: 2026-06-12\nupdated: 2026-06-12\n---\n周五晚买了一杯耶加雪菲散步放松（[[06-12 晚风手冲]]）。",
    });
    expect(wIdx1.isError).toBe(false);

    // Step 3: 交卷 2026-06-12 bedtime -> 2026-06-13 为低量日(<500字)自动顺延，直接进入 2026-06-14 wrapup 1/2（携带 06-13 对话）
    const step2Id = extractStepId(s2.text);
    const s3 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: step2Id,
      summary: "06-12日梗概",
    });
    expect(s3.isError).toBe(false);
    expect(s3.text).toContain("day: 2026-06-14");
    expect(s3.text).toContain("phase: wrapup");
    expect(s3.text).toContain("wrapup_part: 1/2");
    expect(s3.text).toContain("低量顺延 1 天");
    expect(s3.text).toContain("周六午后打了个盹");
    expect(s3.text).toContain("周日去河滨公园");
    expect(s3.text).toContain("能连续走那么久说明状态恢复得不错");
    // 确认 turn1 完整保留且不被全局 maxOutputChars=2000 截断
    expect(s3.text.length).toBeGreaterThan(2500);
    expect(s3.text).not.toContain("记忆输出已截断");
    expect(s3.text).not.toContain("TAIL_MARKER_0614");

    // Step 4: 交卷 2026-06-14 wrapup 1/2 -> 进入 2026-06-14 wrapup 2/2
    const s4 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: extractStepId(s3.text),
      summary: "06-13至14前半整理",
    });
    expect(s4.isError).toBe(false);
    expect(s4.text).toContain("day: 2026-06-14");
    expect(s4.text).toContain("phase: wrapup");
    expect(s4.text).toContain("wrapup_part: 2/2");
    expect(s4.text).toContain("TAIL_MARKER_0614");

    // 编辑历史卡 threads/walks/park.md，验证 updated_at 保持历史日期 2026-06-14 而非现实 2026-11-20
    const editPark = await callMcpTool(app, mcpToken, "memory_edit", {
      path: "threads/walks/park.md",
      old_string: "updated: 2026-06-10\n---\n六月初第一次路过南门那排槐树下的长椅。",
      new_string: "updated: 2026-06-14\n---\n六月初第一次路过南门那排槐树下的长椅，6月14日再看已修缮完毕。",
    });
    expect(editPark.isError).toBe(false);
    const parkRow = c.index.getRow("threads/walks/park.md");
    expect(parkRow).not.toBeNull();
    expect(localDay(parkRow!.updated_at, "Asia/Shanghai")).toBe("2026-06-14");

    // 交卷 2026-06-14 wrapup 2/2 -> 进入 2026-06-14 bedtime
    const s5 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: extractStepId(s4.text),
      summary: "06-14后半与长椅更新",
    });
    expect(s5.isError).toBe(false);
    expect(s5.text).toContain("day: 2026-06-14");
    expect(s5.text).toContain("phase: bedtime");
    expect(s5.text).toContain("本周整理散步路线");

    // 写 2026-06-14 日梗概并交卷 -> 周日触发 reflect_weekly
    const wIdx2 = await callMcpTool(app, mcpToken, "memory_write", {
      path: "episodes/2026/06/14/index.md",
      content:
        "---\ntitle: 2026-06-14 日梗概\nkind: note\nstatus: active\ncreated: 2026-06-14\nupdated: 2026-06-14\n---\n河滨长走后复盘散步路线，南门槐树长椅也修好了（[[公园长椅]]）。",
    });
    expect(wIdx2.isError).toBe(false);

    const s6 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: extractStepId(s5.text),
      summary: "06-14日梗概",
    });
    expect(s6.isError).toBe(false);
    expect(s6.text).toContain("day: 2026-06-14");
    expect(s6.text).toContain("phase: reflect_weekly");
    expect(s6.text).toContain("core/open.md");

    // 周反思期放行 core/open.md，继续拦截 core/self.md
    const wOpen = await callMcpTool(app, mcpToken, "memory_write", {
      path: "core/open.md",
      content:
        "---\ntitle: 未完挂念\nkind: note\nstatus: active\ncreated: 2026-06-14\nupdated: 2026-06-14\n---\n- 下次再去南门槐树长椅坐坐。\n",
    });
    expect(wOpen.isError).toBe(false);

    // 交卷周反思 -> 进入 2026-06-15 wrapup -> bedtime -> finished
    const s7 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: extractStepId(s6.text),
      summary: "首周周反思",
    });
    expect(s7.isError).toBe(false);
    expect(s7.text).toContain("day: 2026-06-15");
    expect(s7.text).toContain("phase: wrapup");

    const s8 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: extractStepId(s7.text),
      summary: "06-15切片跳过",
    });
    expect(s8.isError).toBe(false);
    expect(s8.text).toContain("day: 2026-06-15");
    expect(s8.text).toContain("phase: bedtime");

    await callMcpTool(app, mcpToken, "memory_write", {
      path: "episodes/2026/06/15/index.md",
      content:
        "---\ntitle: 2026-06-15 日梗概\nkind: note\nstatus: active\ncreated: 2026-06-15\nupdated: 2026-06-15\n---\n周一整理书桌与书单，状态笃定。",
    });
    const sDone = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: extractStepId(s8.text),
      summary: "06-15日梗概",
    });
    expect(sDone.isError).toBe(false);
    expect(sDone.text).toContain("status: finished");
    expect(sDone.text).toContain("共完成 3 天");
    expect(sDone.text).toContain("低量顺延 1 天");

    // 搬家退出活跃步骤后，非搬家态下 protectCoreFiles=true 重新拦死 core/state.md
    const blockedAfterReplay = await callMcpTool(app, mcpToken, "memory_edit", {
      path: "core/state.md",
      old_string: "本周整理散步路线",
      new_string: "擅自篡改",
    });
    expect(blockedAfterReplay.isError).toBe(true);
    expect(blockedAfterReplay.text).toContain("protectCoreFiles");

    // replay_state.json 同步检查（含低量顺延、processedEvents 与周反思新写卡片）
    const replayStateRaw = JSON.parse(
      await fs.readFile(path.join(c.dataDir, "replay_state.json"), "utf8"),
    ) as {
      tidiedDays: string[];
      results: Record<
        string,
        { deferredToNext?: boolean; processedEvents?: number; touchedMemoryPaths?: string[] }
      >;
    };
    expect(replayStateRaw.tidiedDays).toEqual(["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15"]);
    expect(replayStateRaw.results["2026-06-12"]?.processedEvents).toBe(3);
    expect(replayStateRaw.results["2026-06-13"]?.deferredToNext).toBe(true);
    expect(replayStateRaw.results["2026-06-14"]?.processedEvents).toBe(6);
    expect(replayStateRaw.results["2026-06-14"]?.touchedMemoryPaths).toContain("core/open.md");
  });

  test("断线/换窗口不传或错传 step_id 原样续接防跳步；abort(rollback=true) 安全回滚且保留用户未跟踪杂文件", async () => {
    const c = (ctx = await createTestContext());
    await c.tools.write(
      "threads/REGISTRY.yaml",
      "spaces:\n  walks:\n    title: 散步笔记\n    triggers: [散步]\n    decay: none\n    card_style: \"记录每次散步\"\n",
    );
    await c.tools.write(
      "threads/walks/park.md",
      "---\ntitle: 公园长椅\nkind: note\nstatus: active\ncreated: 2026-06-10\nupdated: 2026-06-10\n---\n原版公园长椅内容。",
    );
    await commitMemoryPaths(
      c.dataDir,
      ["threads/REGISTRY.yaml", "threads/walks/park.md"],
      "memory(genesis): base",
    );

    const t0 = Date.UTC(2026, 5, 20, 12, 0, 0);
    insertHistoricalEvent(c, {
      seq: 1,
      atMs: t0,
      role: "user",
      turnId: "t-1",
      content: "今天又去公园散步，顺便带了相机拍槐花。",
    });
    insertHistoricalEvent(c, {
      seq: 2,
      atMs: t0 + 10_000,
      role: "assistant",
      turnId: "t-1",
      content: "六月槐花快落了吧，拍下来刚好留个影。",
    });

    const app = createApp({
      version: "0.1.0",
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      getActiveSessionId: () => "sess-1",
      dataDir: c.dataDir,
      promptsDir: PROMPTS_DIR,
      db: c.db,
      memoryIndex: c.index,
      memoryTools: c.tools,
      memoryGitMutex: new AsyncMutex(),
    });
    const authHeaders = { authorization: `Bearer ${c.authToken}`, "content-type": "application/json" };
    const tokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "cursor" }),
    });
    const mcpToken = ((await tokRes.json()) as { token: string }).token;
    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        memoryMcp: { enabled: true, accessMode: "read_write", replayToolsEnabled: true },
      }),
    });

    const startRes = await callMcpTool(app, mcpToken, "memory_replay", { action: "start", days: 1 });
    const stepId = extractStepId(startRes.text);

    // 步骤内新建卡片 + 修改旧卡片 + 用户自己放了一个未跟踪杂文件
    await callMcpTool(app, mcpToken, "memory_write", {
      path: "episodes/2026/06/20/ep-draft.md",
      content: "---\ntitle: 06-20 槐花草稿\nkind: episode\nstatus: active\ncreated: 2026-06-20\nupdated: 2026-06-20\n---\n草稿",
    });
    await callMcpTool(app, mcpToken, "memory_edit", {
      path: "threads/walks/park.md",
      old_string: "原版公园长椅内容。",
      new_string: "中途写歪的长椅修改。",
    });
    const scratchPath = path.join(c.dataDir, "memory", "user-scratch.txt");
    await fs.writeFile(scratchPath, "KEEP_USER_SCRATCH_SAFE", "utf8");

    // 模拟新窗口不传 step_id 或错传 step_id 调 next / start -> 必须原样续接，不推进游标
    const resumeNoId = await callMcpTool(app, mcpToken, "memory_replay", { action: "next" });
    expect(resumeNoId.text).toContain(`step_id: ${stepId}`);
    expect(resumeNoId.text).toContain("续接上次未提交步骤");
    expect(resumeNoId.text).toContain("episodes/2026/06/20/ep-draft.md");
    expect(c.events.getCursor("daily_wrapup")).toBeNull();

    const resumeWrongId = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: "wrong-id",
    });
    expect(resumeWrongId.text).toContain(`step_id: ${stepId}`);
    expect(c.events.getCursor("daily_wrapup")).toBeNull();

    const resumeStart = await callMcpTool(app, mcpToken, "memory_replay", { action: "start", days: 1 });
    expect(resumeStart.text).toContain(`step_id: ${stepId}`);
    expect(resumeStart.text).toContain("续接上次未提交步骤");

    // abort(rollback=true) 安全回滚
    const abortRes = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "abort",
      rollback: true,
    });
    expect(abortRes.isError).toBe(false);
    expect(abortRes.text).toContain("status: aborted");

    // 新建草稿被删除，旧卡恢复原貌，用户未跟踪杂文件完好，索引已清除草稿，游标未推进
    await expect(
      fs.access(path.join(c.dataDir, "memory", "episodes/2026/06/20/ep-draft.md")),
    ).rejects.toThrow();
    expect(
      await fs.readFile(path.join(c.dataDir, "memory", "threads/walks/park.md"), "utf8"),
    ).toContain("原版公园长椅内容。");
    expect(await fs.readFile(scratchPath, "utf8")).toBe("KEEP_USER_SCRATCH_SAFE");
    expect(c.index.getRow("episodes/2026/06/20/ep-draft.md")).toBeNull();
    expect(c.events.getCursor("daily_wrapup")).toBeNull();
  });

  test("搬家完毕关闭 MCP 回家后（热切换 + 重启开机），绝不对历史已搬家日期误跑 bedtime 或全量反思", async () => {
    const dataDir = await makeTempDir();
    // 当前时间：2026-11-26 14:00（白天清醒期，最容易触发 catchUpMissedBedtime）
    const clock = new VirtualClock(Date.UTC(2026, 10, 26, 6, 0, 0), "Asia/Shanghai");
    const mockChat = new MockChatModel();

    runtime = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      chatModel: mockChat,
      startHeartbeatTimer: false,
      catchUpMissedBedtime: false,
      writeLocalPairFile: false,
    });

    // 插入一条半年前的历史导入对话（2026-06-10）
    insertHistoricalEvent(runtime, {
      seq: 1,
      atMs: Date.UTC(2026, 5, 10, 12, 0, 0),
      role: "user",
      turnId: "t-hist-1",
      content: "六月十号聊过的老事情，搬家时要整理掉。",
    });
    insertHistoricalEvent(runtime, {
      seq: 2,
      atMs: Date.UTC(2026, 5, 10, 12, 1, 0),
      role: "assistant",
      turnId: "t-hist-1",
      content: "好，我记下来。",
    });

    const authToken = "psb_home_check_01";
    const { hashBearerToken } = await import("../src/api/pairing.ts");
    const devEntry = {
      deviceId: "dev-home-1",
      tokenHash: hashBearerToken(authToken),
      deviceName: "Home Mac",
      platform: "macos",
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
    };
    runtime.config.auth.devices.push(devEntry);
    runtime.config.circadian = {
      ...(runtime.config.circadian ?? {
        sleepStart: "23:30",
        sleepEnd: "07:30",
        heartbeatIntervalMin: 15,
        proactiveEnabled: false,
        proactiveMinGapMin: 240,
        proactiveCooldownMin: 180,
      }),
      proactiveEnabled: false,
    };
    runtime.config.memoryMcp = mergeMemoryMcpConfig(runtime.config.memoryMcp, {
      enabled: true,
      accessMode: "read_write",
      replayToolsEnabled: true,
    });
    await saveConfig(dataDir, runtime.config);
    await runtime.reloadMemoryMcpConfigFromDisk();

    const authHeaders = { authorization: `Bearer ${authToken}`, "content-type": "application/json" };
    const tokRes = await runtime.app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "migrator" }),
    });
    expect(tokRes.status).toBe(201);
    const mcpToken = ((await tokRes.json()) as { token: string }).token;

    // 跑完这 1 天搬家（wrapup + bedtime）
    const s1 = await callMcpTool(runtime.app, mcpToken, "memory_replay", { action: "start", all: true });
    await callMcpTool(runtime.app, mcpToken, "memory_write", {
      path: "episodes/2026/06/10/ep-old.md",
      content: "---\ntitle: 06-10 往事\nkind: episode\nstatus: active\ncreated: 2026-06-10\nupdated: 2026-06-10\n---\n六月十号的老事情。",
    });
    const s2 = await callMcpTool(runtime.app, mcpToken, "memory_replay", {
      action: "next",
      step_id: extractStepId(s1.text),
      summary: "记06-10往事",
    });
    await callMcpTool(runtime.app, mcpToken, "memory_write", {
      path: "episodes/2026/06/10/index.md",
      content: "---\ntitle: 2026-06-10 日梗概\nkind: note\nstatus: active\ncreated: 2026-06-10\nupdated: 2026-06-10\n---\n记下了六月十号往事。",
    });
    const sEnd = await callMcpTool(runtime.app, mcpToken, "memory_replay", {
      action: "next",
      step_id: extractStepId(s2.text),
      summary: "06-10日梗概",
    });
    expect(sEnd.text).toContain("status: finished");

    // 1. 热切换关闭 MCP 回家：tickHeartbeat 绝不触发 sleep_tidy
    const offCfg = await loadOrCreateConfig(dataDir, clock.now());
    offCfg.memoryMcp = mergeMemoryMcpConfig(offCfg.memoryMcp, { enabled: false });
    await saveConfig(dataDir, offCfg);
    await runtime.reloadMemoryMcpConfigFromDisk();

    const hb = await runtime.tickHeartbeat();
    expect(hb.action).toBe("idle");
    expect(mockChat.requests).toHaveLength(0);

    // 2. 停机后以 catchUpMissedBedtime: true 重启，仍绝不对 2026-06-10 重跑 bedtime
    await runtime.stop({ waitTimeoutMs: 2_000 });
    runtime = await bootPsyberRuntime({
      dataDir,
      promptsDir: PROMPTS_DIR,
      clock,
      chatModel: mockChat,
      startHeartbeatTimer: false,
      catchUpMissedBedtime: true,
      writeLocalPairFile: false,
    });
    await runtime.waitForIdle(2_000);
    expect(mockChat.requests).toHaveLength(0);
    expect(runtime.events.getBedtimeNightDate()).toBe("2026-06-10");
    const headCommit = await getMemoryHeadCommit(dataDir);
    const weeklyRow = runtime.db
      .query("SELECT last_event_id FROM task_cursors WHERE task_key = 'reflect_weekly'")
      .get() as { last_event_id: string } | null;
    expect(weeklyRow?.last_event_id).toBe(headCommit!);
  });

  test("CLI 脚本 scripts/memory_mcp.ts 支持 --replay 开关与 disable 未收尾搬家步骤提醒", async () => {
    const c = (ctx = await createTestContext());
    insertHistoricalEvent(c, {
      seq: 1,
      atMs: Date.UTC(2026, 5, 18, 12, 0, 0),
      role: "user",
      turnId: "t-cli-1",
      content: "CLI 搬家提醒测试对话。",
    });
    // 先释放 db 句柄避免影响 CLI 只读打开检查
    const dataDir = c.dataDir;
    const scriptPath = path.resolve(import.meta.dir, "../scripts/memory_mcp.ts");
    const runCli = async (args: string[]) => {
      const proc = Bun.spawn(["bun", "run", scriptPath, "--data-dir", dataDir, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    };

    const en = await runCli(["enable", "--mode", "read_write", "--replay"]);
    expect(en.code).toBe(0);
    expect(en.stdout).toContain("replayToolsEnabled=true");

    const st = await runCli(["status"]);
    expect(st.code).toBe(0);
    expect(st.stdout).toContain("开启（允许 memory_replay）");

    // 开启一个未结算步骤后执行 disable，应打印提醒
    const app = createApp({
      version: "0.1.0",
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      getActiveSessionId: () => "sess-1",
      dataDir,
      promptsDir: PROMPTS_DIR,
      db: c.db,
      memoryIndex: c.index,
      memoryTools: c.tools,
      memoryGitMutex: new AsyncMutex(),
    });
    const reloaded = await loadOrCreateConfig(dataDir, c.clock.now());
    c.config.memoryMcp = reloaded.memoryMcp;
    const tokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${c.authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "cli-test" }),
    });
    expect(tokRes.status).toBe(201);
    const mcpToken = ((await tokRes.json()) as { token: string }).token;
    await callMcpTool(app, mcpToken, "memory_replay", { action: "start", days: 1 });

    const dis = await runCli(["disable"]);
    expect(dis.code).toBe(0);
    expect(dis.stderr).toContain("检测到仍有未结算的搬家步骤");
  });

  test("并发回归与无基准提交回滚：并发 next/write 零死锁不重复结算，空仓回滚显式警告无法还原的旧文件", async () => {
    const c = (ctx = await createTestContext());
    // 空 Git 仓库（无任何 commit，baseCommit === null），但磁盘上预先有一个未提交旧卡片
    await c.tools.write(
      "lessons/preexisting.md",
      "---\ntitle: 经验·既有旧卡\nkind: lesson\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\nwhen_to_recall: 测试空仓回滚\n---\n旧内容。",
    );

    const t1 = Date.UTC(2026, 5, 22, 12, 0, 0);
    insertHistoricalEvent(c, {
      seq: 1,
      atMs: t1,
      role: "user",
      turnId: "t-c-1",
      content: "并发与空仓回滚测试对话第一句。",
    });
    insertHistoricalEvent(c, {
      seq: 2,
      atMs: t1 + 10_000,
      role: "assistant",
      turnId: "t-c-1",
      content: "并发与空仓回滚测试对话第二句。",
    });

    const app = createApp({
      version: "0.1.0",
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      getActiveSessionId: () => "sess-1",
      dataDir: c.dataDir,
      promptsDir: PROMPTS_DIR,
      db: c.db,
      memoryIndex: c.index,
      memoryTools: c.tools,
      memoryGitMutex: new AsyncMutex(),
    });
    const authHeaders = { authorization: `Bearer ${c.authToken}`, "content-type": "application/json" };
    const tokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "race-client" }),
    });
    const mcpToken = ((await tokRes.json()) as { token: string }).token;
    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        memoryMcp: { enabled: true, accessMode: "read_write", replayToolsEnabled: true },
      }),
    });

    // 1. 空仓（baseCommit === null）修改已有文件 + 新建文件 -> abort(rollback=true) 删新建并显式警告旧文件无法还原
    const s0 = await callMcpTool(app, mcpToken, "memory_replay", { action: "start", days: 1 });
    expect(s0.isError).toBe(false);
    await callMcpTool(app, mcpToken, "memory_edit", {
      path: "lessons/preexisting.md",
      old_string: "旧内容。",
      new_string: "被改后的内容。",
    });
    await callMcpTool(app, mcpToken, "memory_write", {
      path: "episodes/2026/06/22/ep-temp.md",
      content:
        "---\ntitle: 06-22 临时卡\nkind: episode\nstatus: active\ncreated: 2026-06-22\nupdated: 2026-06-22\n---\n临时内容。",
    });

    const abortNoBase = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "abort",
      rollback: true,
    });
    expect(abortNoBase.isError).toBe(false);
    expect(abortNoBase.text).toContain("删除新建 1 个");
    expect(abortNoBase.text).toContain("[警告]");
    expect(abortNoBase.text).toContain("lessons/preexisting.md");
    await expect(
      fs.access(path.join(c.dataDir, "memory", "episodes/2026/06/22/ep-temp.md")),
    ).rejects.toThrow();

    // 2. 并发发送两个相同 step_id 的 next + 一个 memory_write：在 gitMutex 内严格串行，零死锁且不跳过 bedtime
    const s1 = await callMcpTool(app, mcpToken, "memory_replay", { action: "start", days: 1 });
    const wrapupStepId = extractStepId(s1.text);
    const [n1, n2, wConcurrent] = await Promise.all([
      callMcpTool(app, mcpToken, "memory_replay", {
        action: "next",
        step_id: wrapupStepId,
        summary: "并发交卷1",
      }),
      callMcpTool(app, mcpToken, "memory_replay", {
        action: "next",
        step_id: wrapupStepId,
        summary: "并发交卷2",
      }),
      callMcpTool(app, mcpToken, "memory_write", {
        path: "episodes/2026/06/22/ep-race.md",
        content:
          "---\ntitle: 06-22 并发写卡\nkind: episode\nstatus: active\ncreated: 2026-06-22\nupdated: 2026-06-22\n---\n并发写入内容。",
      }),
    ]);

    expect(n1.isError).toBe(false);
    expect(n2.isError).toBe(false);
    expect(wConcurrent.isError).toBe(false);
    // 两者之一结算 wrapup 进入 bedtime，另一者在锁内看到已进入 bedtime 且 step_id 不匹配 -> 原样续接 bedtime，绝不跳过
    expect(n1.text).toContain("phase: bedtime");
    expect(n2.text).toContain("phase: bedtime");
    expect([n1.text, n2.text].some((t) => t.includes("续接上次未提交步骤"))).toBe(true);
    expect(c.events.getBedtimeNightDate()).toBeNull();
  });

  test("工具 annotations、compact_rules（含新窗口自动回退完整规则）、跨批低量顺延与 stepSeq 连续递增", async () => {
    const c = (ctx = await createTestContext());
    await c.tools.write(
      "core/self.md",
      "---\ntitle: 关于我\nkind: note\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n我是 Roy。",
    );
    await c.tools.write(
      "core/user.md",
      "---\ntitle: 关于TA\nkind: note\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\nname: Joy\n---\n对方叫 Joy。",
    );
    await commitMemoryPaths(c.dataDir, ["core/self.md", "core/user.md"], "memory(genesis): init");

    // 2026-06-23 正常日（> 500 字），2026-06-24 低量日（< 500 字），2026-06-28 周日（验证跨批顺延合并 + compact_rules 下周反思仍完整下发 <reflect_rules>）
    let seq = 1;
    const t23 = Date.UTC(2026, 5, 23, 12, 0, 0);
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t23,
      role: "user",
      turnId: "t-23",
      content: "第一天正常长度对话。".repeat(60),
    });
    const t24 = Date.UTC(2026, 5, 24, 12, 0, 0);
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t24,
      role: "user",
      turnId: "t-24",
      content: "第二天很短",
    });
    const t28 = Date.UTC(2026, 5, 28, 12, 0, 0);
    insertHistoricalEvent(c, {
      seq: seq++,
      atMs: t28,
      role: "user",
      turnId: "t-28",
      content: "周日正常对话。".repeat(60),
    });

    const app = createApp({
      version: "0.1.0",
      clock: c.clock,
      getConfig: () => c.config,
      events: c.events,
      getActiveSessionId: () => "sess-1",
      dataDir: c.dataDir,
      promptsDir: PROMPTS_DIR,
      db: c.db,
      memoryIndex: c.index,
      memoryTools: c.tools,
      memoryGitMutex: new AsyncMutex(),
    });
    const authHeaders = { authorization: `Bearer ${c.authToken}`, "content-type": "application/json" };
    const tokRes = await app.request("/api/v1/memory-mcp/tokens", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "annot-client" }),
    });
    const mcpToken = ((await tokRes.json()) as { token: string }).token;
    await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        memoryMcp: { enabled: true, accessMode: "read_write", replayToolsEnabled: true },
      }),
    });

    // 1. 校验 tools/list 所有工具 annotations 均为 destructiveHint: false，且读写标注准确
    const listRes = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" },
      body: mcpRpc("tools/list"),
    });
    const tools = (
      (await listRes.json()) as {
        result: {
          tools: Array<{
            name: string;
            annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
          }>;
        };
      }
    ).result.tools;
    expect(tools).toHaveLength(9);
    for (const t of tools) {
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(false);
      const isWrite = t.name === "memory_write" || t.name === "memory_edit" || t.name === "memory_replay";
      expect(t.annotations?.readOnlyHint).toBe(!isWrite);
    }

    // 2. start(days=2, min_chars=500, compact_rules=true)：首步保留完整规则，stepSeq = #1
    const s1 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "start",
      days: 2,
      min_chars: 500,
      compact_rules: true,
    });
    expect(s1.isError).toBe(false);
    expect(extractStepId(s1.text)).toBe("2026-06-23:wrapup:1#1");
    expect(s1.text).toContain("<tidy_rules>");
    expect(s1.text).toContain("<self>");

    // 3. 连续 next 进入 bedtime：compact_rules 生效省略重复规则，stepSeq = #2
    const s2 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: "2026-06-23:wrapup:1#1",
      summary: "06-23切片",
    });
    expect(s2.isError).toBe(false);
    expect(extractStepId(s2.text)).toBe("2026-06-23:bedtime:1#2");
    expect(s2.text).toContain("compact_rules");
    expect(s2.text).not.toContain("<tidy_rules>\n");
    expect(s2.text).not.toContain("# 整理原则");
    expect(s2.text).not.toContain("<self>\n");

    // 4. 新窗口续接（不传 step_id）：自动回退为完整规则
    const resumed = await callMcpTool(app, mcpToken, "memory_replay", { action: "next" });
    expect(resumed.isError).toBe(false);
    expect(extractStepId(resumed.text)).toBe("2026-06-23:bedtime:1#2");
    expect(resumed.text).toContain("续接上次未提交步骤");
    expect(resumed.text).toContain("<tidy_rules>");
    expect(resumed.text).toContain("<self>");

    // 5. 结算 06-23 bedtime 后，窗口末尾的 06-24（低量 < 500）自动顺延并拉入 06-28 合并消化，stepSeq 连续为 #3（无空跳）
    const s3 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: "2026-06-23:bedtime:1#2",
      summary: "06-23日梗概",
    });
    expect(s3.isError).toBe(false);
    expect(extractStepId(s3.text)).toBe("2026-06-28:wrapup:1#3");
    expect(s3.text).toContain("低量顺延 1 天");
    expect(s3.text).toContain("第二天很短");
    expect(s3.text).toContain("周日正常对话");

    // 6. 写入一张实质卡片并推进到周反思：即使开启了 compact_rules，reflect_weekly 也必须完整下发 <reflect_rules>、<self>、<user>
    await callMcpTool(app, mcpToken, "memory_write", {
      path: "episodes/2026/06/28/ep-sunday.md",
      content:
        "---\ntitle: 06-28 周日记录\nkind: episode\nstatus: active\ncreated: 2026-06-28\nupdated: 2026-06-28\n---\n周日对话记录。",
    });
    const s4 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: "2026-06-28:wrapup:1#3",
      summary: "06-28切片",
    });
    expect(extractStepId(s4.text)).toBe("2026-06-28:bedtime:1#4");
    const s5 = await callMcpTool(app, mcpToken, "memory_replay", {
      action: "next",
      step_id: "2026-06-28:bedtime:1#4",
      summary: "06-28日梗概",
    });
    expect(s5.isError).toBe(false);
    expect(extractStepId(s5.text)).toBe("2026-06-28:reflect_weekly:1#5");
    expect(s5.text).toContain("<reflect_rules>");
    expect(s5.text).toContain("<self>");
    expect(s5.text).not.toContain("规则模式：compact_rules");
  });
});
