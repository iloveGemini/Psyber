import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashBearerToken } from "../src/api/app.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { saveConfig } from "../src/core/config.ts";
import { registerFsTools } from "../src/extensions/fs_tools.ts";
import { bootPsyberRuntime } from "../src/index.ts";
import { ToolRegistry, type ToolExecutionContext } from "../src/tools/registry.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    turnId: "turn-fs-1",
    sessionId: "sess-fs-1",
    mode: "chat",
    touchedMemoryPaths: new Set<string>(),
    expressionCount: 0,
    expressions: [],
    ...overrides,
  };
}

describe("Tier 3 本机文件工具（fs_read / fs_write / fs_edit）", () => {
  test("workspace 内免审读/写/改，支持分段读取与唯一匹配校验", async () => {
    const dataDir = await makeTempDir("psyber-fs-ws-");
    try {
      const registry = new ToolRegistry();
      registerFsTools(registry, {
        dataDir,
        getConfig: () => ({
          instanceId: "inst-fs",
          timezone: "Asia/Shanghai",
          door: { state: "open", note: null, updatedAt: Date.now() },
          auth: { devices: [] },
        }),
      });

      let approvalCalls = 0;
      const ctx = makeCtx({
        requestApproval: async () => {
          approvalCalls += 1;
          return { decision: "allow", scope: "once" };
        },
      });

      // 1. workspace 内免审写入
      const writeRes = await registry.invoke(
        "fs_write",
        { path: "notes/todo.txt", content: "line1\nline2\nline1\n" },
        ctx,
      );
      expect(writeRes.ok).toBe(true);
      expect(approvalCalls).toBe(0);

      // 2. workspace 内免审读取与分页
      const readSlice = await registry.invoke(
        "fs_read",
        { path: "notes/todo.txt", offset: 0, limit: 5 },
        ctx,
      );
      expect(readSlice.ok).toBe(true);
      expect(readSlice.output).toContain("line1");
      expect(readSlice.output).toContain("offset=5");

      // 3. fs_edit 重复片段拦截
      const dupEdit = await registry.invoke(
        "fs_edit",
        { path: "notes/todo.txt", old_string: "line1", new_string: "LINE1" },
        ctx,
      );
      expect(dupEdit.ok).toBe(false);
      expect(dupEdit.output).toContain("共出现 2 次");

      // 4. fs_edit 唯一片段替换成功且免审批
      const okEdit = await registry.invoke(
        "fs_edit",
        { path: "notes/todo.txt", old_string: "line2", new_string: "LINE2" },
        ctx,
      );
      expect(okEdit.ok).toBe(true);
      expect(approvalCalls).toBe(0);
      const after = await registry.invoke("fs_read", { path: "notes/todo.txt" }, ctx);
      expect(after.ok).toBe(true);
      expect(after.output).toBe("line1\nLINE2\nline1\n");

      // 5. 二进制文件拒绝以文本读取与编辑
      await fs.writeFile(path.join(dataDir, "workspace", "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
      const binRes = await registry.invoke("fs_read", { path: "bin.dat" }, ctx);
      expect(binRes.ok).toBe(false);
      expect(binRes.output).toContain("二进制");
      const binEditRes = await registry.invoke(
        "fs_edit",
        { path: "bin.dat", old_string: "a", new_string: "b" },
        ctx,
      );
      expect(binEditRes.ok).toBe(false);
      expect(binEditRes.output).toContain("二进制");

      // 6. fs_write 写入已有目录时失败且不残留临时文件
      await fs.mkdir(path.join(dataDir, "workspace", "sub_dir"), { recursive: true });
      const dirWriteRes = await registry.invoke("fs_write", { path: "sub_dir", content: "x" }, ctx);
      expect(dirWriteRes.ok).toBe(false);
      const wsEntries = await fs.readdir(path.join(dataDir, "workspace"));
      expect(wsEntries.some((n) => n.startsWith(".psyber-tmp-"))).toBe(false);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("前置硬拦截受保护路径（memory/private/credentials/符号链接绕过）", async () => {
    const dataDir = await makeTempDir("psyber-fs-guard-");
    try {
      await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
      await fs.mkdir(path.join(dataDir, "memory", "core"), { recursive: true });
      await fs.mkdir(path.join(dataDir, "private"), { recursive: true });
      await fs.writeFile(path.join(dataDir, "memory", "core", "self.md"), "self", "utf8");
      await fs.writeFile(path.join(dataDir, "private", "diary.sealed"), "sealed", "utf8");
      await fs.writeFile(path.join(dataDir, "credentials.json"), "{}", "utf8");
      await fs.symlink(path.join(dataDir, "private"), path.join(dataDir, "workspace", "link_priv"));

      const registry = new ToolRegistry();
      registerFsTools(registry, {
        dataDir,
        getConfig: () => ({
          instanceId: "inst-fs-guard",
          timezone: "Asia/Shanghai",
          door: { state: "open", note: null, updatedAt: Date.now() },
          auth: { devices: [] },
        }),
      });

      const forbiddenPaths = [
        path.join(dataDir, "memory", "core", "self.md"),
        path.join(dataDir, "private", "diary.sealed"),
        path.join(dataDir, "credentials.json"),
        "link_priv/diary.sealed",
        "~/.ssh/id_rsa",
      ];

      for (const p of forbiddenPaths) {
        const r = await registry.invoke("fs_read", { path: p }, makeCtx());
        expect(r.ok).toBe(false);
        expect(r.output).toContain("受保护敏感路径");

        const w = await registry.invoke("fs_write", { path: p, content: "x" }, makeCtx());
        expect(w.ok).toBe(false);
        expect(w.output).toContain("受保护敏感路径");

        const e = await registry.invoke(
          "fs_edit",
          { path: p, old_string: "a", new_string: "b" },
          makeCtx(),
        );
        expect(e.ok).toBe(false);
        expect(e.output).toContain("受保护敏感路径");
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("权限梯度：额外 allowedDirs 只读免审但写入需审批；目录外读/写/改均需审批", async () => {
    const dataDir = await makeTempDir("psyber-fs-grad-");
    const extraAllowed = await makeTempDir("psyber-fs-allowed-");
    const outsideDir = await makeTempDir("psyber-fs-outside-");
    try {
      const allowedFile = path.join(extraAllowed, "doc.md");
      const outsideFile = path.join(outsideDir, "ext.txt");
      await fs.writeFile(allowedFile, "hello allowed", "utf8");
      await fs.writeFile(outsideFile, "hello outside", "utf8");

      const registry = new ToolRegistry();
      registerFsTools(registry, {
        dataDir,
        getConfig: () => ({
          instanceId: "inst-fs-grad",
          timezone: "Asia/Shanghai",
          door: { state: "open", note: null, updatedAt: Date.now() },
          auth: { devices: [] },
          bash: { allowedDirs: [extraAllowed] },
        }),
      });

      const approvalLog: string[] = [];
      const approvalArgs: Array<Record<string, unknown>> = [];
      const allowCtx = makeCtx({
        requestApproval: async (req) => {
          approvalLog.push(req.toolName);
          approvalArgs.push(req.arguments);
          return { decision: "allow", scope: "once" };
        },
      });
      const denyCtx = makeCtx({
        requestApproval: async (req) => {
          approvalLog.push(`deny:${req.toolName}`);
          return { decision: "deny", reason: "不给改" };
        },
      });

      // 1. 额外 allowedDirs 内：fs_read 免审批
      const r1 = await registry.invoke("fs_read", { path: allowedFile }, allowCtx);
      expect(r1.ok).toBe(true);
      expect(r1.output).toBe("hello allowed");
      expect(approvalLog).toEqual([]);

      // 2. 额外 allowedDirs 内：fs_edit 必须走审批（拒绝时不落盘，批准后落盘）
      const eDeny = await registry.invoke(
        "fs_edit",
        { path: allowedFile, old_string: "allowed", new_string: "changed" },
        denyCtx,
      );
      expect(eDeny.ok).toBe(false);
      expect(await fs.readFile(allowedFile, "utf8")).toBe("hello allowed");

      const eAllow = await registry.invoke(
        "fs_edit",
        { path: allowedFile, old_string: "allowed", new_string: "changed" },
        allowCtx,
      );
      expect(eAllow.ok).toBe(true);
      expect(await fs.readFile(allowedFile, "utf8")).toBe("hello changed");

      // 3. allowedDirs 外：fs_read 也必须走审批
      const rOutDeny = await registry.invoke("fs_read", { path: outsideFile }, denyCtx);
      expect(rOutDeny.ok).toBe(false);
      const rOutAllow = await registry.invoke("fs_read", { path: outsideFile }, allowCtx);
      expect(rOutAllow.ok).toBe(true);
      expect(rOutAllow.output).toBe("hello outside");

      expect(approvalLog).toEqual(["deny:fs_edit", "fs_edit", "deny:fs_read", "fs_read"]);
      expect(approvalArgs[0]).toMatchObject({ oldPreview: "allowed", newPreview: "changed" });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(extraAllowed, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("集成注册：Tier 3 隔离且在 /settings 工具目录归类为「本机与系统」", async () => {
    const dataDir = await makeTempDir("psyber-fs-boot-");
    const clock = new VirtualClock(Date.parse("2026-11-24T05:05:00Z"), "Asia/Shanghai");
    const rt = await bootPsyberRuntime({ dataDir, clock, startHeartbeatTimer: false });
    try {
      const token = "psb_fs_boot_1";
      rt.config.auth.devices.push({
        deviceId: "dev-1",
        tokenHash: hashBearerToken(token),
        deviceName: "Mac",
        platform: "macos",
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
      });
      await saveConfig(dataDir, rt.config);

      const res = await rt.app.request("/api/v1/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        tools: Array<{ name: string; tier: number; category: string; locked: boolean }>;
      };

      for (const name of ["fs_read", "fs_write", "fs_edit"]) {
        const item = json.tools.find((t) => t.name === name);
        expect(item).toBeDefined();
        expect(item?.tier).toBe(3);
        expect(item?.category).toBe("本机与系统");
        expect(item?.locked).toBe(false);
      }
      // 确认 memory 5 工具原封不动留在 Tier 1
      for (const name of ["read", "write", "edit", "glob", "grep"]) {
        const item = json.tools.find((t) => t.name === name);
        expect(item?.tier).toBe(1);
        expect(item?.locked).toBe(true);
      }
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
