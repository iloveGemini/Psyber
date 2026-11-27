import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp, hashBearerToken } from "../src/api/app.ts";
import { commitMemoryPaths } from "../src/core/git.ts";
import { MediaStore } from "../src/core/media.ts";
import { detectSecrets, redactSecrets, redactUnknownJson } from "../src/core/redact.ts";
import { generateAttachmentDigest } from "../src/engine/digest.ts";
import { DirectEngine } from "../src/engine/direct.ts";
import { SseHub } from "../src/engine/sse.ts";
import { formatTidyTranscriptLine } from "../src/engine/tidy.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";
import { MemoryTools } from "../src/memory/tools.ts";
import { registerCoreTier1Tools } from "../src/tools/core_tools.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { runSecretAudit } from "../scripts/audit_secrets.ts";
import { createTestContext } from "./helpers.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");
const SAMPLE_OPENAI_KEY = "sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUvWxYz";
const SAMPLE_ANTHROPIC_KEY = "sk-ant-api03-AbCdEf1234567890GhIjKlMnOpQrStUvWxYz";
const SAMPLE_GITHUB_TOKEN = "ghp_1234567890abcdef1234567890abcdef1234";
const SAMPLE_GOOGLE_KEY = "AIzaSyD-ExampleKey1234567890abcdefghijk";
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlV0ZXIifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const SAMPLE_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDummyKeyBody12345",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("core/redact 隐私与凭证脱敏引擎", () => {
  test("精准脱敏常见结构化凭证且具备幂等性", () => {
    const raw = [
      `OpenAI: ${SAMPLE_OPENAI_KEY}`,
      `Anthropic: ${SAMPLE_ANTHROPIC_KEY}`,
      `Google: ${SAMPLE_GOOGLE_KEY}`,
      `GitHub: ${SAMPLE_GITHUB_TOKEN}`,
      `JWT: ${SAMPLE_JWT}`,
      "DB: postgres://admin:SuperSecretPass99@db.local:5432/psyber",
      "Header: Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWx123456",
      'JSON: {"client_secret": "ZxCvBn1234567890!", "password": "MyPass,2026!", "token": "AbCdEf1234567890"}',
      'Env: DB_PASSWORD="foo;bar123" BOT_TOKEN=Zx9kLm2pQr7x88 API_TOKEN=\'Qa1Ws2Ed3Rf4\'',
      SAMPLE_PEM,
    ].join("\n");

    const res = redactSecrets(raw);
    expect(res.redacted).toBe(true);
    expect(res.text).toContain("[已隐藏:OpenAI密钥]");
    expect(res.text).toContain("[已隐藏:Anthropic密钥]");
    expect(res.text).toContain("[已隐藏:Google密钥]");
    expect(res.text).toContain("[已隐藏:GitHub令牌]");
    expect(res.text).toContain("[已隐藏:JWT令牌]");
    expect(res.text).toContain("postgres://admin:[已隐藏:连接串密码]@db.local:5432/psyber");
    expect(res.text).toContain("Authorization: Bearer [已隐藏:认证令牌]");
    expect(res.text).toContain('"client_secret": "[已隐藏:配置密钥]"');
    expect(res.text).toContain('"password": "[已隐藏:明文密码]"');
    expect(res.text).toContain('"token": "[已隐藏:配置密钥]"');
    expect(res.text).toContain('DB_PASSWORD="[已隐藏:明文密码]"');
    expect(res.text).toContain("BOT_TOKEN=[已隐藏:配置密钥]");
    expect(res.text).toContain("API_TOKEN='[已隐藏:配置密钥]'");
    expect(res.text).toContain("[已隐藏:私钥块]");

    expect(res.text).not.toContain(SAMPLE_OPENAI_KEY);
    expect(res.text).not.toContain("SuperSecretPass99");
    expect(res.text).not.toContain("MyPass,2026!");
    expect(res.text).not.toContain("foo;bar123");
    expect(res.text).not.toContain("AbCdEf1234567890");
    expect(res.text).not.toContain("Zx9kLm2pQr7x88");
    expect(res.text).not.toContain("Qa1Ws2Ed3Rf4");
    expect(res.text).not.toContain("DummyKeyBody12345");

    // 幂等性：再次扫描不重复命中
    const again = redactSecrets(res.text);
    expect(again.redacted).toBe(false);
    expect(again.text).toBe(res.text);
  });

  test("不误伤普通聊天、小游戏昵称、SHA-256 哈希与占位符配置", () => {
    const benignSamples = [
      "今天去 4399 玩小游戏，账号叫小橘猫，区服 108234，得分 9876543210。",
      "图片哈希是 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855。",
      "配置样例：OPENAI_API_KEY=your-api-key-here，password: required，token: invalid_grant。",
      "MCP 模板：Authorization: Bearer ${cred:tavily_api_key}，secret: ./config/dev.pem",
      "文档地址 https://docs.example.com/auth/password?tab=token，示例值 sk-xxxx。",
      '用量与分页：max_tokens: 16384, input_tokens: 4096, cache_read_tokens: 2048, next_page_token: "AbCdEf1234567890"',
    ];

    for (const sample of benignSamples) {
      const res = redactSecrets(sample);
      expect(res.redacted).toBe(false);
      expect(res.text).toBe(sample);
    }
  });

  test("redactUnknownJson 递归脱敏 metadata 且跳过哈希/ID 字段", () => {
    const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const res = redactUnknownJson({
      attachments: [hash],
      mediaHash: hash,
      toolCalls: [
        {
          name: "bash",
          arguments: {
            command: 'curl -H "Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWx123456"',
          },
          output: `TOKEN=${SAMPLE_GITHUB_TOKEN}`,
        },
      ],
    });
    expect(res.redacted).toBe(true);
    expect(res.value.mediaHash).toBe(hash);
    expect(res.value.attachments[0]).toBe(hash);
    expect(res.value.toolCalls[0]!.output).toBe("TOKEN=[已隐藏:GitHub令牌]");
    expect(res.value.toolCalls[0]!.arguments.command).toContain("[已隐藏:认证令牌]");
  });
});

describe("全链路源头脱敏与 memory/ 写盘硬拦截", () => {
  test("EventStore 入库、编辑与附件摘要自动脱敏", async () => {
    const ctx = await createTestContext();
    try {
      const { event } = ctx.events.append({
        sessionId: "sess-1",
        role: "user",
        kind: "chat",
        content: `帮我看看这个 Key 报错：${SAMPLE_OPENAI_KEY}`,
        thinking: `思考中引用了 ${SAMPLE_GITHUB_TOKEN}`,
        metadata: {
          note: "postgres://root:Pass123456@127.0.0.1:5432/db",
        },
      });
      expect(event.content).toBe("帮我看看这个 Key 报错：[已隐藏:OpenAI密钥]");
      expect(event.thinking).toBe("思考中引用了 [已隐藏:GitHub令牌]");
      expect(event.metadata?.note).toBe("postgres://root:[已隐藏:连接串密码]@127.0.0.1:5432/db");

      const edited = ctx.events.editLatestUserMessage(
        event.id,
        `改一下，其实是 ${SAMPLE_ANTHROPIC_KEY}`,
        { doorState: "open", newTurnId: "turn-2", activeSessionId: "sess-1" },
      );
      expect(edited.ok).toBe(true);
      if (edited.ok) {
        expect(edited.event.content).toBe("改一下，其实是 [已隐藏:Anthropic密钥]");
        const updated = ctx.events.setAttachmentDigestState(edited.event.id, {
          status: "done",
          digest: `截图显示了密钥 ${SAMPLE_GOOGLE_KEY}`,
        });
        expect(updated?.metadata?.attachmentDigest).toBe("截图显示了密钥 [已隐藏:Google密钥]");
      }
    } finally {
      await ctx.cleanup();
    }
  });

  test("用户发送消息：本轮内存传明文给主模型，落库/召回/助手复读/后续历史均已脱敏", async () => {
    const ctx = await createTestContext();
    const token = "test-bearer-token";
    ctx.config.auth.devices.push({
      deviceId: "dev-1",
      deviceName: "test",
      platform: "macos",
      tokenHash: hashBearerToken(token),
      createdAt: ctx.clock.now(),
      lastSeenAt: ctx.clock.now(),
    });
    const media = new MediaStore(ctx.db, ctx.dataDir);
    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);

    const seenPrompts: string[] = [];
    const mockChatModel: ChatModelClient = {
      contextWindow: 128_000,
      modelId: "mock-chat",
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        const lastMsg = req.messages[req.messages.length - 1];
        const text =
          typeof lastMsg?.content === "string"
            ? lastMsg.content
            : lastMsg?.content.map((p) => (p.type === "text" ? p.text : "")).join("\n") ?? "";
        seenPrompts.push(
          req.messages
            .map((m) =>
              typeof m.content === "string"
                ? `${m.role}:${m.content}`
                : `${m.role}:[multipart]`,
            )
            .join("\n---\n"),
        );
        // 模拟助手在回复与思考中复读了这个密钥
        yield {
          type: "thinking_delta",
          delta: `看到用户发了 ${SAMPLE_OPENAI_KEY}`,
        };
        yield {
          type: "text_delta",
          delta: text.includes(SAMPLE_OPENAI_KEY)
            ? `收到了你发的 ${SAMPLE_OPENAI_KEY}，看起来前缀没问题。`
            : "收到下一轮消息。",
        };
        yield { type: "usage", inputTokens: 100, outputTokens: 20, totalTokens: 120 };
      },
    };

    const registry = new ToolRegistry();
    registerCoreTier1Tools(registry, {
      memoryTools,
      events: ctx.events,
      clock: ctx.clock,
      getConfig: () => ctx.config,
      saveConfig: async () => {},
    });
    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      db: ctx.db,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel: mockChatModel,
      clock: ctx.clock,
      media,
      getConfig: () => ctx.config,
      retryDelaysMs: [],
    });
    const app = createApp({
      version: "0.1.0-test",
      dataDir: ctx.dataDir,
      events: ctx.events,
      memoryIndex: ctx.index,
      memoryTools,
      toolRegistry: registry,
      engine,
      media,
      clock: ctx.clock,
      getConfig: () => ctx.config,
      getActiveSessionId: () => engine.getActiveSessionId(),
    });

    try {
      const res1 = await app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: `帮我看下 ${SAMPLE_OPENAI_KEY} 对不对` }),
      });
      expect(res1.status).toBe(202);
      const body1 = (await res1.json()) as { message: { id: string; content: string } };
      // 落库与返回时间线已脱敏
      expect(body1.message.content).toBe("帮我看下 [已隐藏:OpenAI密钥] 对不对");

      // 等待异步轮次落盘
      await Bun.sleep(80);

      // 1) 当轮主模型确实收到了明文
      expect(seenPrompts.length).toBe(1);
      expect(seenPrompts[0]).toContain(SAMPLE_OPENAI_KEY);

      // 2) 召回留痕表 recall_traces 绝不含明文
      const traceRow = ctx.db
        .query("SELECT query FROM recall_traces ORDER BY id DESC LIMIT 1")
        .get() as { query: string } | null;
      if (traceRow) {
        expect(traceRow.query).not.toContain(SAMPLE_OPENAI_KEY);
        expect(traceRow.query).toContain("[已隐藏:OpenAI密钥]");
      }

      // 3) 助手复读的正文和思考在 events 中均已脱敏
      const allEvents = ctx.events.listHistory({ limit: 10 }).items;
      expect(allEvents.length).toBe(2);
      const asst = allEvents[1]!;
      expect(asst.content).not.toContain(SAMPLE_OPENAI_KEY);
      expect(asst.content).toContain("[已隐藏:OpenAI密钥]");
      expect(asst.thinking).not.toContain(SAMPLE_OPENAI_KEY);
      expect(asst.thinking).toContain("[已隐藏:OpenAI密钥]");

      // 4) 下一轮对话从历史加载时，旧消息已不再含明文
      const res2 = await app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: "好的谢谢" }),
      });
      expect(res2.status).toBe(202);
      await Bun.sleep(80);
      expect(seenPrompts.length).toBe(2);
      expect(seenPrompts[1]).not.toContain(SAMPLE_OPENAI_KEY);
      expect(seenPrompts[1]).toContain("[已隐藏:OpenAI密钥]");
    } finally {
      await ctx.cleanup();
    }
  });

  test("ToolRegistry 拦截外部工具返回值中的凭证（bash / mcp 等）", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      tier: 3,
      security: "auto",
      description: "mock bash",
      tags: ["bash"],
      parameters: {},
      execute: async () => ({
        ok: true,
        output: `DATABASE_URL=postgres://dev:TopSecret99@localhost:5432/app\nGH=${SAMPLE_GITHUB_TOKEN}`,
      }),
    });
    registry.register({
      name: "mcp.demo.read",
      tier: 3,
      security: "auto",
      description: "mock mcp",
      tags: ["mcp"],
      parameters: {},
      execute: async () => ({
        ok: false,
        output: "401 Unauthorized with Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWx123456",
      }),
    });

    const dummyCtx = {
      turnId: "t1",
      sessionId: "s1",
      mode: "chat" as const,
      touchedMemoryPaths: new Set<string>(),
      expressionCount: 0,
      expressions: [],
    };
    const r1 = await registry.invoke("bash", {}, dummyCtx);
    expect(r1.ok).toBe(true);
    expect(r1.output).toContain("postgres://dev:[已隐藏:连接串密码]@localhost:5432/app");
    expect(r1.output).toContain("GH=[已隐藏:GitHub令牌]");

    const r2 = await registry.invoke("mcp.demo.read", {}, dummyCtx);
    expect(r2.ok).toBe(false);
    expect(r2.output).toContain("Authorization: Bearer [已隐藏:认证令牌]");
  });

  test("MemoryTools.write / edit 硬拦截明文凭证且不静默篡改", async () => {
    const ctx = await createTestContext();
    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);
    try {
      const blockedWrite = await memoryTools.write(
        "episodes/2026/11/27/ep-key.md",
        `---\ntitle: 11-27 配环境\nkind: episode\nstatus: active\ncreated: 2026-11-27\nupdated: 2026-11-27\n---\n\n今天配了新密钥 ${SAMPLE_OPENAI_KEY}。`,
      );
      expect(blockedWrite.ok).toBe(false);
      expect(blockedWrite.output).toContain("OpenAI密钥");
      await expect(
        fs.access(path.join(ctx.dataDir, "memory/episodes/2026/11/27/ep-key.md")),
      ).rejects.toThrow();

      // 合法不含明文的写法可正常写入
      const okWrite = await memoryTools.write(
        "episodes/2026/11/27/ep-key.md",
        `---\ntitle: 11-27 配环境\nkind: episode\nstatus: active\ncreated: 2026-11-27\nupdated: 2026-11-27\n---\n\n今天换了新的 OpenAI 密钥并测试通过。`,
      );
      expect(okWrite.ok).toBe(true);

      // edit 试图把明文密码塞进去同样硬拦截
      const blockedEdit = await memoryTools.edit(
        "episodes/2026/11/27/ep-key.md",
        "今天换了新的 OpenAI 密钥并测试通过。",
        '今天换了新密码：password="MySecret2026!"',
      );
      expect(blockedEdit.ok).toBe(false);
      expect(blockedEdit.output).toContain("明文密码");
    } finally {
      await ctx.cleanup();
    }
  });

  test("tidy 话单与 digest 摘要具备兜底脱敏，历史只读体检脚本可检出旧数据而不修改磁盘", async () => {
    const ctx = await createTestContext();
    const media = new MediaStore(ctx.db, ctx.dataDir);
    try {
      // 1) formatTidyTranscriptLine 兜底脱敏旧库未脱敏行
      const line = formatTidyTranscriptLine(
        {
          id: "ev-old",
          seq: 1,
          turn_id: null,
          status: "active",
          role: "user",
          kind: "chat",
          content: `历史遗留 ${SAMPLE_GITHUB_TOKEN}`,
          metadata: JSON.stringify({
            attachments: ["abc"],
            attachmentDigest: `截图中出现 ${SAMPLE_GOOGLE_KEY}`,
          }),
          created_at: ctx.clock.now(),
        },
        ctx.clock.timeZone,
        "阿明",
      );
      expect(line).not.toContain(SAMPLE_GITHUB_TOKEN);
      expect(line).not.toContain(SAMPLE_GOOGLE_KEY);
      expect(line).toContain("[已隐藏:GitHub令牌]");
      expect(line).toContain("[已隐藏:Google密钥]");

      // 2) generateAttachmentDigest 兜底脱敏模型违规抄录的密钥
      const savedImg = await media.save({
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mimeType: "image/png",
        origin: "user_upload",
        nowMs: ctx.clock.now(),
      });
      const leakyDigestModel: ChatModelClient = {
        contextWindow: 32_000,
        modelId: "mock-digest",
        async *stream(): AsyncIterable<ChatStreamChunk> {
          yield { type: "text_delta", delta: `终端截图显示了 ${SAMPLE_OPENAI_KEY}` };
          yield { type: "usage", inputTokens: 50, outputTokens: 20, totalTokens: 70 };
        },
      };
      const digest = await generateAttachmentDigest({
        digestModel: leakyDigestModel,
        media,
        attachments: [savedImg.hash],
      });
      expect(digest).toBe("终端截图显示了 [已隐藏:OpenAI密钥]");

      // 3) 构造一处历史遗留的未脱敏 memory 文件与 events 行，验证 audit:secrets 只读检出
      const leakyMemPath = path.join(ctx.dataDir, "memory/episodes/2026/11/27/ep-legacy.md");
      await fs.mkdir(path.dirname(leakyMemPath), { recursive: true });
      const legacyBody = `---\ntitle: 11-27 遗留\n---\n\n旧记录含 ${SAMPLE_ANTHROPIC_KEY}\n`;
      await fs.writeFile(leakyMemPath, legacyBody, "utf8");
      ctx.db
        .query(
          `INSERT INTO events (
            id, seq, session_id, turn_id, client_message_id,
            group_id, version, status, role, kind,
            source, fonds, activity, content, thinking, metadata, created_at
          ) VALUES ('ev-legacy-1', 99, 's-old', NULL, NULL, NULL, 1, 'active', 'user', 'chat', 'live', '', NULL, ?, NULL, NULL, ?)`,
        )
        .run(`旧聊天记录含 ${SAMPLE_JWT}`, ctx.clock.now());

      const report = await runSecretAudit(ctx.dataDir, { verbose: true });
      expect(report.memoryFindings.length).toBe(1);
      expect(report.memoryFindings[0]!.path).toBe("episodes/2026/11/27/ep-legacy.md");
      expect(report.memoryFindings[0]!.labels).toContain("Anthropic密钥");
      expect(report.memoryFindings[0]!.redactedExcerpt).not.toContain(SAMPLE_ANTHROPIC_KEY);

      expect(report.eventFindings.length).toBe(1);
      expect(report.eventFindings[0]!.id).toBe("ev-legacy-1");
      expect(report.eventFindings[0]!.labels).toContain("JWT令牌");
      expect(report.eventFindings[0]!.redactedExcerpt).not.toContain(SAMPLE_JWT);

      // 确认只读：原文件未被修改
      expect(await fs.readFile(leakyMemPath, "utf8")).toBe(legacyBody);
      expect(detectSecrets(legacyBody).length).toBe(1);
    } finally {
      await ctx.cleanup();
    }
  });

  test("审查回归：多步失败 TurnCheckpoint 清洗、SSE 重放缓冲清除、MCP memory_history 脱敏与混合多行 PEM 审计", async () => {
    const ctx = await createTestContext();
    const token = "test-bearer-token-2";
    const mcpToken = "mcp-test-secret-token";
    ctx.config.auth.devices.push({
      deviceId: "dev-2",
      deviceName: "test",
      platform: "macos",
      tokenHash: hashBearerToken(token),
      createdAt: ctx.clock.now(),
      lastSeenAt: ctx.clock.now(),
    });
    ctx.config.memoryMcp = {
      enabled: true,
      accessMode: "read_only",
      allowRemote: false,
      protectCoreFiles: true,
      maxOutputChars: 16_000,
      disabledTools: [],
      replayToolsEnabled: false,
      tokens: [
        {
          id: "tok-1",
          name: "reviewer",
          tokenHash: hashBearerToken(mcpToken),
          accessMode: "read_only",
          createdAt: ctx.clock.now(),
        },
      ],
    };

    const media = new MediaStore(ctx.db, ctx.dataDir);
    const memoryTools = new MemoryTools(ctx.dataDir, ctx.index, ctx.clock);
    const sse = new SseHub();

    // 1) 多步工具第 1 步成功、第 2 步报错 -> 验证 TurnCheckpoint 已彻底清除当轮明文
    let callNum = 0;
    const seenRetryPrompts: string[] = [];
    const flakyModel: ChatModelClient = {
      contextWindow: 128_000,
      modelId: "mock-flaky",
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        callNum += 1;
        seenRetryPrompts.push(JSON.stringify(req.messages));
        if (callNum === 1) {
          yield { type: "thinking_delta", delta: `排查 ${SAMPLE_OPENAI_KEY}` };
          yield { type: "tool_call", id: "tc-1", name: "glob", args: { pattern: "core/*.md" } };
          yield { type: "usage", inputTokens: 80, outputTokens: 20, totalTokens: 100 };
          return;
        }
        if (callNum === 2) {
          yield { type: "error", code: "PROVIDER_ERROR", message: "boom", retryable: false };
          return;
        }
        // 第 3 次：从 checkpoint 恢复后输出含复读密钥的回复
        yield { type: "thinking_delta", delta: `重试思考 ${SAMPLE_OPENAI_KEY}` };
        yield { type: "text_delta", delta: `重试回复 ${SAMPLE_OPENAI_KEY}` };
        yield { type: "usage", inputTokens: 90, outputTokens: 20, totalTokens: 110 };
      },
    };

    const registry = new ToolRegistry();
    registerCoreTier1Tools(registry, {
      memoryTools,
      events: ctx.events,
      clock: ctx.clock,
      getConfig: () => ctx.config,
      saveConfig: async () => {},
    });
    const engine = new DirectEngine({
      dataDir: ctx.dataDir,
      promptsDir: PROMPTS_DIR,
      db: ctx.db,
      events: ctx.events,
      memoryIndex: ctx.index,
      registry,
      chatModel: flakyModel,
      clock: ctx.clock,
      media,
      getConfig: () => ctx.config,
      retryDelaysMs: [],
    });

    try {
      const { event: uev } = ctx.events.append({
        sessionId: engine.getActiveSessionId(),
        role: "user",
        kind: "chat",
        content: `检查 ${SAMPLE_OPENAI_KEY}`,
      });
      const failedRes = await engine.runTurn({
        mode: "chat",
        userText: `检查 ${SAMPLE_OPENAI_KEY}`,
        userEventId: uev.id,
        callbacks: {
          onThinkingDelta: (delta) => sse.emit("turn.thinking", { turnId: "t-cp", delta }),
          onTextDelta: (delta) => sse.emit("turn.text", { turnId: "t-cp", delta }),
        },
      });
      expect(failedRes.error).toBeDefined();
      expect(failedRes.checkpoint).toBeDefined();
      const cpJson = JSON.stringify(failedRes.checkpoint);
      expect(cpJson).not.toContain(SAMPLE_OPENAI_KEY);
      expect(cpJson).toContain("[已隐藏:OpenAI密钥]");

      // 2) 用清洗后的 checkpoint 续跑，模型不再收到明文；SSE 重放缓冲清除后不留明文分片且不误报 overflow
      const resumed = await engine.runTurn({
        mode: "chat",
        userText: uev.content,
        userEventId: uev.id,
        turnId: "t-cp",
        resumeCheckpoint: failedRes.checkpoint,
        callbacks: {
          onThinkingDelta: (delta) => sse.emit("turn.thinking", { turnId: "t-cp", delta }),
          onTextDelta: (delta) => sse.emit("turn.text", { turnId: "t-cp", delta }),
          onAssistantPersisted: (ev) => {
            sse.purgeTurnStreamFrames("t-cp");
            sse.emit("message.created", { message: ev });
          },
          onTurnDone: (info) => sse.emit("turn.done", info),
        },
      });
      expect(resumed.error).toBeUndefined();
      expect(seenRetryPrompts[2]).not.toContain(SAMPLE_OPENAI_KEY);

      const replayed = sse.replaySince(0);
      expect(replayed.resetReason).toBeNull();
      expect(JSON.stringify(replayed.frames)).not.toContain(SAMPLE_OPENAI_KEY);
      expect(replayed.frames.some((f) => f.event === "message.created")).toBe(true);

      // 3) 对外 /mcp memory_history(action="show") 脱敏历史 Git 提交中的遗留密钥
      const legacyGitPath = path.join(ctx.dataDir, "memory/episodes/2026/11/27/ep-git-old.md");
      await fs.mkdir(path.dirname(legacyGitPath), { recursive: true });
      await fs.writeFile(
        legacyGitPath,
        `---\ntitle: 11-27 混合遗留\n---\n\n单行 ${SAMPLE_OPENAI_KEY}\n\n${SAMPLE_PEM}\n`,
        "utf8",
      );
      await commitMemoryPaths(ctx.dataDir, ["episodes/2026/11/27/ep-git-old.md"], "legacy commit");

      const app = createApp({
        version: "0.1.0-test",
        dataDir: ctx.dataDir,
        db: ctx.db,
        events: ctx.events,
        memoryIndex: ctx.index,
        memoryTools,
        toolRegistry: registry,
        engine,
        media,
        sse,
        clock: ctx.clock,
        getConfig: () => ctx.config,
        getActiveSessionId: () => engine.getActiveSessionId(),
        getClientIp: () => "127.0.0.1",
      });
      const initRes = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      });
      expect(initRes.status).toBe(200);
      const mcpSid = initRes.headers.get("mcp-session-id") ?? "";
      const histRes = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${mcpToken}`,
          "mcp-session-id": mcpSid,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "memory_history",
            arguments: { action: "show", commit: "HEAD" },
          },
        }),
      });
      expect(histRes.status).toBe(200);
      const histBody = await histRes.text();
      expect(histBody).not.toContain(SAMPLE_OPENAI_KEY);
      expect(histBody).not.toContain("DummyKeyBody12345");
      expect(histBody).toContain("[已隐藏:OpenAI密钥]");
      expect(histBody).toContain("[已隐藏:私钥块]");

      // 4) audit:secrets 同文件同时含单行密钥与多行 PEM 私钥 -> 两处均上报；events.metadata JSON 转义换行 PEM 也能检出
      ctx.db
        .query(
          `INSERT INTO events (
            id, seq, session_id, turn_id, client_message_id,
            group_id, version, status, role, kind,
            source, fonds, activity, content, thinking, metadata, created_at
          ) VALUES ('ev-meta-pem', 120, 's-old', NULL, NULL, NULL, 1, 'active', 'assistant', 'chat', 'live', '', NULL, 'ok', NULL, ?, ?)`,
        )
        .run(
          JSON.stringify({
            mediaHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            toolCalls: [{ output: SAMPLE_PEM }],
          }),
          ctx.clock.now(),
        );

      const report = await runSecretAudit(ctx.dataDir, { verbose: true });
      const mixedFileFindings = report.memoryFindings.filter(
        (f) => f.path === "episodes/2026/11/27/ep-git-old.md",
      );
      expect(mixedFileFindings.length).toBe(2);
      expect(mixedFileFindings.some((f) => f.labels.includes("OpenAI密钥"))).toBe(true);
      expect(mixedFileFindings.some((f) => f.labels.includes("私钥块"))).toBe(true);

      const metaFinding = report.eventFindings.find(
        (f) => f.id === "ev-meta-pem" && f.field === "metadata",
      );
      expect(metaFinding).toBeDefined();
      expect(metaFinding?.labels).toContain("私钥块");
    } finally {
      await ctx.cleanup();
    }
  });
});
