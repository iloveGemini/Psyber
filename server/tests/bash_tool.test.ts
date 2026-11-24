import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashBearerToken } from "../src/api/app.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { saveConfig } from "../src/core/config.ts";
import {
  analyzeBashCommand,
  buildBashPolicy,
  buildSanitizedEnv,
  registerBashTool,
  tokenizeShellArgs,
} from "../src/extensions/bash.ts";
import { bootPsyberRuntime } from "../src/index.ts";
import type { ChatModelClient, ChatStreamChunk, ChatStreamRequest } from "../src/llm/client.ts";
import { ToolRegistry, type ToolExecutionContext } from "../src/tools/registry.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    turnId: "turn-bash-1",
    sessionId: "sess-bash-1",
    mode: "chat",
    touchedMemoryPaths: new Set<string>(),
    expressionCount: 0,
    expressions: [],
    ...overrides,
  };
}

describe("内置 bash 工具（Tier 3 隔离、废纸篓可逆守卫、敏感路径/命令拦截与审批衔接）", () => {
  test("硬拦截不可逆删除、绕路截屏、提权、敏感路径与符号链接绕过", async () => {
    const dataDir = await makeTempDir("psyber-bash-guard-");
    try {
      await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
      await fs.mkdir(path.join(dataDir, "private"), { recursive: true });
      await fs.mkdir(path.join(dataDir, "memory", "core"), { recursive: true });
      await fs.writeFile(path.join(dataDir, "private", "secret.sealed"), "sealed", "utf8");
      await fs.writeFile(path.join(dataDir, "memory", "core", "self.md"), "self", "utf8");

      // 在 workspace 中制造指向 private/ 的符号链接尝试绕过
      const symlinkPath = path.join(dataDir, "workspace", "sneak");
      await fs.symlink(path.join(dataDir, "private"), symlinkPath);

      const policy = await buildBashPolicy(dataDir);
      const cwd = policy.workspaceDir;

      // 1. 不可逆删除全部拦截并提示改用 trash
      for (const cmd of [
        "rm note.txt",
        "/bin/rm -rf folder",
        "unlink note.txt",
        "shred -u note.txt",
        "find . -name '*.tmp' -delete",
        "git clean -fd",
      ]) {
        const res = await analyzeBashCommand(cmd, cwd, policy);
        expect(res.decision).toBe("block");
        expect(res.reason).toContain("trash");
      }

      // 2. 绕路截屏、磁盘破坏与提权硬拦截
      for (const cmd of [
        "screencapture /tmp/shot.png",
        "osascript -e 'do shell script \"screencapture /tmp/a.png\"'",
        "sudo ls",
        "dd if=/dev/zero of=out.img bs=1m count=1",
        "security dump-keychain",
      ]) {
        const res = await analyzeBashCommand(cmd, cwd, policy);
        expect(res.decision).toBe("block");
      }

      // 3. 敏感目录与符号链接绕过拦截
      for (const cmd of [
        `cat ${path.join(dataDir, "credentials.json")}`,
        `cat ${path.join(dataDir, "memory", "core", "self.md")}`,
        `ls ${path.join(dataDir, "private")}`,
        `cat ${path.join(dataDir, "psyber.sqlite")}`,
        "cat ~/.ssh/id_rsa",
        "cat ./sneak/secret.sealed",
        "cat sneak",
        "ls sneak",
        "ls ../rp/runs/run-1",
      ]) {
        const res = await analyzeBashCommand(cmd, cwd, policy);
        expect(res.decision).toBe("block");
      }

      // 3b. cwd 在 dataDir 时，裸名访问受保护子目录/配置也必须硬拦截
      for (const cmd of ["ls private", "cat config.json", "ls memory"]) {
        const res = await analyzeBashCommand(cmd, policy.dataDir, policy);
        expect(res.decision).toBe("block");
      }

      // 3c. 只读白名单命令带危险写/执行参数时不得免审放行
      for (const cmd of [
        "rg --pre sh foo",
        "git diff --output=evil.txt",
        "find . -fls out.txt",
        "grep --file=/etc/hosts foo",
      ]) {
        const res = await analyzeBashCommand(cmd, cwd, policy);
        expect(res.decision).toBe("confirm");
      }

      // 4. cwd 落在受保护目录也硬拦截
      const cwdRes = await analyzeBashCommand("ls", path.join(policy.dataDir, "private"), policy);
      expect(cwdRes.decision).toBe("block");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("拦 rm 不拦删除：允许目录内 trash 免审移入废纸篓且防重名覆盖，目录外需审批", async () => {
    const dataDir = await makeTempDir("psyber-bash-trash-");
    const trashDir = await makeTempDir("psyber-trash-bin-");
    const outsideDir = await makeTempDir("psyber-outside-");
    try {
      const registry = new ToolRegistry();
      registerBashTool(registry, {
        dataDir,
        trashDir,
        getConfig: () => ({
          instanceId: "inst-bash",
          timezone: "Asia/Shanghai",
          door: { state: "open", note: null, updatedAt: Date.now() },
          auth: { devices: [] },
        }),
      });

      const workspace = path.join(dataDir, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "draft.txt"), "v1", "utf8");

      // 1. 允许目录内 trash 免审批直接执行
      let approvalCalls = 0;
      const res1 = await registry.invoke(
        "bash",
        { command: "trash draft.txt" },
        makeCtx({
          requestApproval: async () => {
            approvalCalls += 1;
            return { decision: "allow", scope: "once" };
          },
        }),
      );
      expect(res1.ok).toBe(true);
      expect(res1.output).toContain("已移入系统废纸篓");
      expect(approvalCalls).toBe(0);
      await expect(fs.stat(path.join(workspace, "draft.txt"))).rejects.toThrow();
      expect(await fs.readFile(path.join(trashDir, "draft.txt"), "utf8")).toBe("v1");

      // 2. 同名文件再次 trash 不覆盖废纸篓中已有文件
      await fs.writeFile(path.join(workspace, "draft.txt"), "v2", "utf8");
      const res2 = await registry.invoke("bash", { command: "trash draft.txt" }, makeCtx());
      expect(res2.ok).toBe(true);
      const trashFiles = await fs.readdir(trashDir);
      expect(trashFiles.length).toBe(2);

      // 3. 允许目录外文件 trash 必须触发审批；拒绝则保留原文件
      const outsideFile = path.join(outsideDir, "keep-me.txt");
      await fs.writeFile(outsideFile, "important", "utf8");
      const denied = await registry.invoke(
        "bash",
        { command: `trash "${outsideFile}"` },
        makeCtx({
          requestApproval: async (req) => {
            approvalCalls += 1;
            expect(req.toolName).toBe("bash");
            expect(req.summary).toContain("废纸篓");
            return { decision: "deny", reason: "先别删" };
          },
        }),
      );
      expect(denied.ok).toBe(false);
      expect(approvalCalls).toBe(1);
      expect(await fs.readFile(outsideFile, "utf8")).toBe("important");

      // 4. 批准后允许目录外文件同样可逆移入废纸篓
      const approved = await registry.invoke(
        "bash",
        { command: `trash "${outsideFile}"` },
        makeCtx({
          requestApproval: async () => ({ decision: "allow", scope: "once" }),
        }),
      );
      expect(approved.ok).toBe(true);
      await expect(fs.stat(outsideFile)).rejects.toThrow();
      expect(await fs.readFile(path.join(trashDir, "keep-me.txt"), "utf8")).toBe("important");

      // 5. trash 符号链接仅移走链接本身，绝不误删链接指向的外部目标文件
      const targetFile = path.join(outsideDir, "preserve-target.txt");
      await fs.writeFile(targetFile, "keep target", "utf8");
      const linkInWs = path.join(workspace, "my-link.txt");
      await fs.symlink(targetFile, linkInWs);
      const trashLinkRes = await registry.invoke("bash", { command: "trash my-link.txt" }, makeCtx());
      expect(trashLinkRes.ok).toBe(true);
      await expect(fs.lstat(linkInWs)).rejects.toThrow();
      expect(await fs.readFile(targetFile, "utf8")).toBe("keep target");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(trashDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("允许目录内只读免审、输出截断、超时终止与环境变量脱敏", async () => {
    const dataDir = await makeTempDir("psyber-bash-exec-");
    try {
      const sanitized = buildSanitizedEnv({
        PATH: "/usr/bin:/bin",
        HOME: "/Users/test",
        OPENAI_API_KEY: "sk-secret",
        GITHUB_TOKEN: "ghp_secret",
        PSYBER_DATA_DIR: "/tmp/psyber",
        MY_PASSWORD: "123",
      });
      expect(sanitized.PATH).toBe("/usr/bin:/bin");
      expect(sanitized.OPENAI_API_KEY).toBeUndefined();
      expect(sanitized.GITHUB_TOKEN).toBeUndefined();
      expect(sanitized.PSYBER_DATA_DIR).toBeUndefined();
      expect(sanitized.MY_PASSWORD).toBeUndefined();
      expect(tokenizeShellArgs(`trash "hello world.txt" 'a b'`)).toEqual([
        "trash",
        "hello world.txt",
        "a b",
      ]);

      const registry = new ToolRegistry();
      registerBashTool(registry, {
        dataDir,
        getConfig: () => ({
          instanceId: "inst-exec",
          timezone: "Asia/Shanghai",
          door: { state: "open", note: null, updatedAt: Date.now() },
          auth: { devices: [] },
          bash: { maxOutputChars: 300 },
        }),
      });

      const workspace = path.join(dataDir, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "big.txt"), "X".repeat(600), "utf8");

      // 只读命令免审批且按 maxOutputChars 截断
      let approvalCount = 0;
      const readRes = await registry.invoke(
        "bash",
        { command: "cat big.txt" },
        makeCtx({
          requestApproval: async () => {
            approvalCount += 1;
            return { decision: "allow" };
          },
        }),
      );
      expect(readRes.ok).toBe(true);
      expect(approvalCount).toBe(0);
      expect(readRes.output).toContain("[命令输出已截断，原始长度 600 字符]");

      // 非交互轮次（无 requestApproval）遇写命令保守拦截
      const noApprovalRes = await registry.invoke("bash", { command: "touch a.txt" }, makeCtx());
      expect(noApprovalRes.ok).toBe(false);
      expect(noApprovalRes.output).toContain("需要用户确认审批");

      // 超时自动终止慢命令
      const timeoutRes = await registry.invoke(
        "bash",
        { command: "sleep 5", timeoutMs: 1000 },
        makeCtx({
          requestApproval: async () => ({ decision: "allow", scope: "once" }),
        }),
      );
      expect(timeoutRes.ok).toBe(false);
      expect(timeoutRes.output).toContain("超时");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("端到端集成：Tier 3 隔离、disabledTools 开关与同步审批卡放行", async () => {
    const dataDir = await makeTempDir("psyber-bash-e2e-");
    const trashDir = await makeTempDir("psyber-bash-e2e-trash-");
    const clock = new VirtualClock(Date.parse("2026-11-24T04:50:00Z"), "Asia/Shanghai");
    const seenTier1ToolNames: string[][] = [];

    let step = 0;
    const mockModel: ChatModelClient = {
      modelId: "mock-chat",
      contextWindow: 100_000,
      async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamChunk> {
        seenTier1ToolNames.push(req.tools.map((t) => t.name));
        step += 1;
        if (step === 1) {
          yield {
            type: "tool_call",
            id: "tc_1",
            name: "call_tool",
            args: { name: "bash", arguments: { command: "mkdir -p notes && echo hi > notes/ok.txt" } },
          };
          return;
        }
        const toolMsg = [...req.messages].reverse().find((m) => m.role === "toolResult");
        yield {
          type: "text_delta",
          delta: `搞定了：${toolMsg?.role === "toolResult" ? toolMsg.content : ""}`,
        };
      },
    };

    const rt = await bootPsyberRuntime({
      dataDir,
      clock,
      chatModel: mockModel,
      bashTrashDir: trashDir,
      startHeartbeatTimer: false,
    });

    try {
      const token = "psb_bash_e2e_1";
      rt.config.auth.devices.push({
        deviceId: "dev-1",
        tokenHash: hashBearerToken(token),
        deviceName: "Mac",
        platform: "macos",
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
      });
      await saveConfig(dataDir, rt.config);

      // 1. 设置接口可见 bash 且归类为「本机与系统」、非锁定可开关
      const settingsRes = await rt.app.request("/api/v1/settings", {
        headers: makeAuthHeader(token),
      });
      expect(settingsRes.status).toBe(200);
      const settingsJson = (await settingsRes.json()) as {
        tools: Array<{ name: string; tier: number; category: string; locked: boolean; enabled: boolean }>;
      };
      const bashTool = settingsJson.tools.find((t) => t.name === "bash");
      expect(bashTool).toBeDefined();
      expect(bashTool?.tier).toBe(3);
      expect(bashTool?.category).toBe("本机与系统");
      expect(bashTool?.locked).toBe(false);
      expect(bashTool?.enabled).toBe(true);

      // 2. 发起包含写操作的 bash 调用 -> 推送 turn.approval_required -> 审批放行
      let resolveApprovalReq!: (payload: Record<string, unknown>) => void;
      const approvalReqPromise = new Promise<Record<string, unknown>>((resolve) => {
        resolveApprovalReq = resolve;
      });
      let resolveTurnDone!: () => void;
      const turnDonePromise = new Promise<void>((resolve) => {
        resolveTurnDone = resolve;
      });

      const unsub = rt.sse.subscribe((frame) => {
        const data = (frame.data ?? {}) as Record<string, unknown>;
        if (frame.event === "turn.approval_required") {
          resolveApprovalReq(data);
        }
        if (frame.event === "turn.done") {
          resolveTurnDone();
        }
      });

      const sendRes = await rt.app.request("/api/v1/chat/messages", {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId: "c_bash_1", content: "在工作区建个笔记" }),
      });
      expect(sendRes.status).toBe(202);

      const reqData = await approvalReqPromise;
      expect(reqData.toolName).toBe("bash");
      const approveRes = await rt.app.request(`/api/v1/turns/${String(reqData.turnId)}/approval`, {
        method: "POST",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({
          approvalId: String(reqData.approvalId),
          decision: "allow",
          scope: "once",
        }),
      });
      expect(approveRes.status).toBe(200);

      await turnDonePromise;
      unsub();

      // 验证文件确实落盘在 workspace 中，且 Tier 1 工具清单绝不含 bash（Prompt Cache 零污染）
      expect(await fs.readFile(path.join(dataDir, "workspace", "notes", "ok.txt"), "utf8")).toBe("hi\n");
      expect(seenTier1ToolNames.every((list) => !list.includes("bash"))).toBe(true);
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(trashDir, { recursive: true, force: true });
    }
  });

  test("GET/PATCH /api/v1/settings 支持读写 bash 配置并拦截危险目录与越界参数", async () => {
    const dataDir = await makeTempDir("psyber-bash-settings-");
    const extraDir = await makeTempDir("psyber-bash-extra-");
    const clock = new VirtualClock(Date.parse("2026-11-24T05:30:00Z"), "Asia/Shanghai");
    const rt = await bootPsyberRuntime({ dataDir, clock, startHeartbeatTimer: false });
    try {
      const token = "psb_bash_settings_1";
      rt.config.auth.devices.push({
        deviceId: "dev-1",
        tokenHash: hashBearerToken(token),
        deviceName: "Mac",
        platform: "macos",
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
      });
      await saveConfig(dataDir, rt.config);

      // 1. GET 返回默认 bash 配置与 workspaceDir
      const getRes = await rt.app.request("/api/v1/settings", {
        headers: makeAuthHeader(token),
      });
      expect(getRes.status).toBe(200);
      const getJson = (await getRes.json()) as {
        bash: { allowedDirs: string[]; timeoutMs: number; maxOutputChars: number; workspaceDir?: string };
      };
      expect(getJson.bash.allowedDirs).toEqual([]);
      expect(getJson.bash.timeoutMs).toBe(30_000);
      expect(getJson.bash.maxOutputChars).toBe(8_000);
      expect(getJson.bash.workspaceDir).toBe(path.join(dataDir, "workspace"));

      // 2. 非法目录（/、~、受保护目录、相对路径）与越界参数均被 400 拦截
      const badPayloads = [
        { bash: { allowedDirs: ["/"] } },
        { bash: { allowedDirs: ["~"] } },
        { bash: { allowedDirs: [path.join(dataDir, "private")] } },
        { bash: { allowedDirs: ["relative/dir"] } },
        { bash: { timeoutMs: 500 } },
        { bash: { maxOutputChars: 100 } },
      ];
      for (const payload of badPayloads) {
        const badRes = await rt.app.request("/api/v1/settings", {
          method: "PATCH",
          headers: { ...makeAuthHeader(token), "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(badRes.status).toBe(400);
      }

      // 3. 合法配置落盘并立即生效（额外目录内 fs_read 免审批）
      const patchRes = await rt.app.request("/api/v1/settings", {
        method: "PATCH",
        headers: { ...makeAuthHeader(token), "content-type": "application/json" },
        body: JSON.stringify({
          bash: {
            allowedDirs: [extraDir, extraDir],
            timeoutMs: 45_000,
            maxOutputChars: 12_000,
          },
        }),
      });
      expect(patchRes.status).toBe(200);
      const patchJson = (await patchRes.json()) as {
        ok: boolean;
        settings: { bash: { allowedDirs: string[]; timeoutMs: number; maxOutputChars: number } };
      };
      expect(patchJson.ok).toBe(true);
      expect(patchJson.settings.bash.allowedDirs).toEqual([extraDir]);
      expect(patchJson.settings.bash.timeoutMs).toBe(45_000);
      expect(patchJson.settings.bash.maxOutputChars).toBe(12_000);

      // 4. 确认配置已持久化到 config.json 并在 rt.config 中即时生效
      expect(rt.config.bash).toEqual({
        allowedDirs: [extraDir],
        timeoutMs: 45_000,
        maxOutputChars: 12_000,
      });
      const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8")) as {
        bash?: { allowedDirs?: string[]; timeoutMs?: number; maxOutputChars?: number };
      };
      expect(persisted.bash).toEqual({
        allowedDirs: [extraDir],
        timeoutMs: 45_000,
        maxOutputChars: 12_000,
      });
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(extraDir, { recursive: true, force: true });
    }
  });
});
