import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { loadOrCreateConfig } from "../src/core/config.ts";
import { commitMemoryPaths } from "../src/core/git.ts";
import { createTestContext, type TestContext } from "./helpers.ts";

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("T01+T02: 原生 5 记忆工具沙箱、原子写与两阶段唯一 edit", () => {
  test("拦截路径越界、绝对路径、.git、private/ 与孤儿路径", async () => {
    ctx = await createTestContext();

    expect((await ctx.tools.write("../escape.md", "bad")).ok).toBe(false);
    expect((await ctx.tools.write("/etc/passwd", "bad")).ok).toBe(false);
    expect((await ctx.tools.write(".git/config", "bad")).ok).toBe(false);
    expect((await ctx.tools.write("daily/no-extension", "bad")).ok).toBe(false);
    expect((await ctx.tools.write("shelf/random.md", "bad")).ok).toBe(false);
    expect((await ctx.tools.write("activities/orphan.md", "bad")).ok).toBe(false);

    // private/ 在全部 5 工具中被硬拦截并返回专属抽屉自救提示
    for (const res of [
      await ctx.tools.glob("private/*.md"),
      await ctx.tools.grep("secret", "private"),
      await ctx.tools.read("private/diary.md"),
      await ctx.tools.write("private/diary.md", "secret"),
      await ctx.tools.edit("private/diary.md", "a", "b"),
    ]) {
      expect(res.ok).toBe(false);
      expect(res.output).toContain("常规 5 工具仅操作 memory/");
    }
  });

  test("self.md 允许首次写入，禁止整篇覆写，允许局部 edit", async () => {
    ctx = await createTestContext();

    const first = await ctx.tools.write(
      "self.md",
      "---\ntitle: 关于我\nnamed: false\n---\n# 我是谁\n\n我刚来到这里。\n",
    );
    expect(first.ok).toBe(true);

    const overwrite = await ctx.tools.write("self.md", "试图覆写");
    expect(overwrite.ok).toBe(false);
    expect(overwrite.output).toContain("禁止整篇覆写");

    const edited = await ctx.tools.edit("self.md", "named: false", "named: true");
    expect(edited.ok).toBe(true);

    const readBack = await ctx.tools.read("self.md");
    expect(readBack.ok).toBe(true);
    expect(readBack.output).toContain("named: true");
  });

  test("edit 支持标点/空白归一化回退匹配，零命中时返回相近片段与行号", async () => {
    ctx = await createTestContext();
    const original = [
      "---",
      "title: 周末散步",
      "kind: episode",
      "---",
      "保留原样：前面有“全角引号”和  双空格。",
      "这一句里，有中文标点！而且   中间有多余空格。",
      "末尾保持原样：100% 不动。",
    ].join("\n");

    expect((await ctx.tools.write("daily/2026-11-20-walk.md", original)).ok).toBe(true);

    const res = await ctx.tools.edit(
      "daily/2026-11-20-walk.md",
      "这一句里,有中文标点!而且 中间有多余空格.",
      "这一句已精确替换。",
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("归一化匹配成功");

    const diskContent = await fs.readFile(
      path.join(ctx.dataDir, "memory/daily/2026-11-20-walk.md"),
      "utf8",
    );
    expect(diskContent).toContain("保留原样：前面有“全角引号”和  双空格。");
    expect(diskContent).toContain("这一句已精确替换。");
    expect(diskContent).toContain("末尾保持原样：100% 不动。");

    // 零命中时返回最相似的原文件片段与行号
    const miss = await ctx.tools.edit("daily/2026-11-20-walk.md", "末尾保持原样：999% 不存在", "x");
    expect(miss.ok).toBe(false);
    expect(miss.output).toContain("L7:");
  });

  test("config.json 损坏时显式抛错，绝不静默覆盖 instanceId", async () => {
    ctx = await createTestContext();
    await fs.writeFile(path.join(ctx.dataDir, "config.json"), "{ broken json", "utf8");
    await expect(loadOrCreateConfig(ctx.dataDir, ctx.clock.now())).rejects.toThrow("JSON 损坏");
  });

  test("REGISTRY.yaml 写前校验拦截非法 Schema 与重名实体，精准 Git 提交不误收未跟踪文件", async () => {
    ctx = await createTestContext();

    const badAct = await ctx.tools.write("activities/REGISTRY.yaml", "spaces:\n  cinema:\n    title: 观影\n");
    expect(badAct.ok).toBe(false);

    const goodAct = await ctx.tools.write(
      "activities/REGISTRY.yaml",
      [
        "spaces:",
        "  cinema:",
        "    title: 一起看片",
        "    triggers: [看电影, 追剧]",
        "    decay: none",
        '    card_style: "一部片一张卡"',
      ].join("\n"),
    );
    expect(goodAct.ok).toBe(true);

    await fs.writeFile(path.join(ctx.dataDir, "memory/scratch.txt"), "do not commit", "utf8");
    const committed = await commitMemoryPaths(
      ctx.dataDir,
      ["activities/REGISTRY.yaml"],
      "memory(init): register cinema space",
    );
    expect(committed).toBe(true);

    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: path.join(ctx.dataDir, "memory"),
      stdout: "pipe",
    });
    const statusOut = await new Response(proc.stdout).text();
    expect(statusOut.trim()).toBe("?? scratch.txt");
  });
});
