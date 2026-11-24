import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashBearerToken } from "../src/api/app.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { saveConfig } from "../src/core/config.ts";
import { commitMemoryPaths, initMemoryGitRepo } from "../src/core/git.ts";
import { registerMemoryHistoryTool } from "../src/extensions/memory_history.ts";
import { bootPsyberRuntime } from "../src/index.ts";
import { ToolRegistry, type ToolExecutionContext } from "../src/tools/registry.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeCtx(): ToolExecutionContext {
  return {
    turnId: "turn-mem-hist-1",
    sessionId: "sess-mem-hist-1",
    mode: "chat",
    touchedMemoryPaths: new Set<string>(),
    expressionCount: 0,
    expressions: [],
  };
}

describe("Tier 3 只读记忆历史回溯工具（memory_history）", () => {
  test("空仓安全返回、支持按路径查询 log 与查看单次提交 show diff 及截断", async () => {
    const dataDir = await makeTempDir("psyber-mem-hist-");
    try {
      const memDir = path.join(dataDir, "memory");
      await fs.mkdir(path.join(memDir, "core"), { recursive: true });
      await fs.mkdir(path.join(memDir, "episodes"), { recursive: true });
      await initMemoryGitRepo(dataDir);

      const registry = new ToolRegistry();
      registerMemoryHistoryTool(registry, { dataDir });

      // 1. 尚无提交时优雅返回提示
      const emptyRes = await registry.invoke("memory_history", {}, makeCtx());
      expect(emptyRes.ok).toBe(true);
      expect(emptyRes.output).toContain("还没有任何历史提交记录");

      // 2. 写入两次记忆提交
      await fs.writeFile(path.join(memDir, "core", "self.md"), "# Self\n\n第一版自我认知。\n", "utf8");
      await commitMemoryPaths(dataDir, ["core/self.md"], "genesis: init self");

      await fs.writeFile(
        path.join(memDir, "core", "self.md"),
        "# Self\n\n第一版自我认知。\n最近开始喜欢整理书架。\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(memDir, "episodes", "ep-1.md"),
        "# Ep 1\n\n" + "长内容".repeat(400) + "\n",
        "utf8",
      );
      await commitMemoryPaths(dataDir, ["core/self.md", "episodes/ep-1.md"], "tidy: update self and ep-1");

      // 3. log 全仓与按 path 筛选
      const logAll = await registry.invoke("memory_history", { action: "log", limit: 5 }, makeCtx());
      expect(logAll.ok).toBe(true);
      expect(logAll.output).toContain("tidy: update self and ep-1");
      expect(logAll.output).toContain("genesis: init self");

      const logEp = await registry.invoke(
        "memory_history",
        { action: "log", path: "episodes/ep-1.md" },
        makeCtx(),
      );
      expect(logEp.ok).toBe(true);
      expect(logEp.output).toContain("tidy: update self and ep-1");
      expect(logEp.output).not.toContain("genesis: init self");

      // 4. show 查看 HEAD 某单文件 diff
      const showSelf = await registry.invoke(
        "memory_history",
        { action: "show", commit: "HEAD", path: "core/self.md" },
        makeCtx(),
      );
      expect(showSelf.ok).toBe(true);
      expect(showSelf.output).toContain("+最近开始喜欢整理书架。");
      expect(showSelf.output).not.toContain("ep-1.md");

      // 5. show 超长输出按 maxChars 截断
      const showTrunc = await registry.invoke(
        "memory_history",
        { action: "show", commit: "HEAD", path: "episodes/ep-1.md", maxChars: 500 },
        makeCtx(),
      );
      expect(showTrunc.ok).toBe(true);
      expect(showTrunc.output).toContain("[记忆历史输出已截断");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("严格拦截越界路径、.git 访问、非法 commit ref 与非法参数", async () => {
    const dataDir = await makeTempDir("psyber-mem-hist-guard-");
    try {
      await fs.mkdir(path.join(dataDir, "memory"), { recursive: true });
      await initMemoryGitRepo(dataDir);

      const registry = new ToolRegistry();
      registerMemoryHistoryTool(registry, { dataDir });

      for (const badPath of ["../private/secret.sealed", "/etc/passwd", ".git/config", "--all", "~/x"]) {
        const res = await registry.invoke("memory_history", { action: "log", path: badPath }, makeCtx());
        expect(res.ok).toBe(false);
      }

      for (const badCommit of ["", "--exec=id", "HEAD;rm", "main..HEAD", "abc"]) {
        const res = await registry.invoke("memory_history", { action: "show", commit: badCommit }, makeCtx());
        expect(res.ok).toBe(false);
      }

      const badSince = await registry.invoke(
        "memory_history",
        { action: "log", since: "--all" },
        makeCtx(),
      );
      expect(badSince.ok).toBe(false);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("集成注册：Tier 3 隔离、自动免审且在 /settings 归类为「记忆读写」", async () => {
    const dataDir = await makeTempDir("psyber-mem-hist-boot-");
    const clock = new VirtualClock(Date.parse("2026-11-24T06:50:00Z"), "Asia/Shanghai");
    const rt = await bootPsyberRuntime({ dataDir, clock, startHeartbeatTimer: false });
    try {
      const token = "psb_mem_hist_1";
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
        tools: Array<{ name: string; tier: number; category: string; security: string; locked: boolean }>;
      };
      const item = json.tools.find((t) => t.name === "memory_history");
      expect(item).toBeDefined();
      expect(item?.tier).toBe(3);
      expect(item?.category).toBe("记忆读写");
      expect(item?.security).toBe("auto");
      expect(item?.locked).toBe(false);
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
