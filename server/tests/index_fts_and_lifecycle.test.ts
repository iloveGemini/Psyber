import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { vagueWhen } from "../src/core/clock.ts";
import { filterActiveStateMarkdown } from "../src/memory/frontmatter.ts";
import { createTestContext, type TestContext } from "./helpers.ts";

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("T04+T06: CJK 2-gram FTS5 检索、lessons/ 召回与短期状态过期生命周期", () => {
  test("episodes/ state 10 天后索引自动标 faded 退出召回但绝不改写磁盘 Markdown；core/state.md 按到期日过滤", async () => {
    ctx = await createTestContext({
      initialTimeMs: Date.UTC(2026, 10, 18, 4, 0, 0), // 2026-11-18 12:00 Asia/Shanghai
    });

    const cardMd = [
      "---",
      "title: 右脚踝扭伤",
      "kind: state",
      "status: active",
      "created: 2026-11-18",
      "updated: 2026-11-18",
      "ttl_days: 10",
      "tags: [脚踝, 扭伤]",
      'when_to_recall: "聊到走路、运动或脚伤恢复时"',
      "---",
      "今天出门把右脚踝崴了，有点肿但还能走。",
    ].join("\n");

    expect((await ctx.tools.write("episodes/2026/11/18/ep-ankle.md", cardMd)).ok).toBe(true);

    // 当天可通过 CJK 2-gram FTS5 命中
    const hitsDay1 = ctx.index.searchFts("脚踝还疼吗");
    expect(hitsDay1.length).toBe(1);
    expect(hitsDay1[0].path).toBe("episodes/2026/11/18/ep-ankle.md");

    // lessons/ 按场景触发卡同样进入 FTS5 检索，且 episode_index 不进检索池
    expect(
      (
        await ctx.tools.write(
          "lessons/late-night-no-guess.md",
          "---\ntitle: 深夜别猜时间催睡\nkind: lesson\nwhen_to_recall: 半夜聊天或看到日期跳转时\n---\n半夜不猜对方是不是在熬夜，直接问就好。\n",
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await ctx.tools.write(
          "episodes/2026/11/18/index.md",
          "---\ntitle: 2026-11-18 日梗概\n---\n今天脚踝扭伤，半夜聊了天。\n",
        )
      ).ok,
    ).toBe(true);

    const lessonHits = ctx.index.searchFts("半夜聊天");
    expect(lessonHits.some((h) => h.path === "lessons/late-night-no-guess.md")).toBe(true);
    expect(lessonHits.some((h) => h.path === "episodes/2026/11/18/index.md")).toBe(false);

    // 快进 10 天（2026-11-28 12:00 Asia/Shanghai）
    ctx.clock.advance(10 * 86_400_000);

    // 自动退出常规 FTS5 召回
    const hitsDay10 = ctx.index.searchFts("脚踝还疼吗");
    expect(hitsDay10.length).toBe(0);

    // 磁盘 Markdown 原文保持 status: active，未被后台代改
    const diskText = await fs.readFile(
      path.join(ctx.dataDir, "memory/episodes/2026/11/18/ep-ankle.md"),
      "utf8",
    );
    expect(diskText).toContain("status: active");

    // 显式 read 时首行附带客观 faded 提示
    const readRes = await ctx.tools.read("episodes/2026/11/18/ep-ankle.md");
    expect(readRes.ok).toBe(true);
    expect(readRes.output.startsWith("[索引状态: faded（已过短期 TTL）]")).toBe(true);

    // 显式 grep 仍能翻出 faded 卡，便于用户主动追问
    const grepRes = await ctx.tools.grep("脚踝");
    expect(grepRes.ok).toBe(true);
    expect(grepRes.output).toContain("episodes/2026/11/18/ep-ankle.md");

    // core/state.md 到期行过滤
    const stateMd = [
      "---",
      "title: 近期短期状态",
      "---",
      "# 近期短期状态",
      "- [至 2026-11-25] 右脚踝扭伤（见 [11-18](episodes/2026/11/18/ep-ankle.md)）",
      "- [至 2026-11-30] 这周在上海出差",
    ].join("\n");
    const filtered = filterActiveStateMarkdown(stateMd, "2026-11-28");
    expect(filtered).not.toBeNull();
    expect(filtered!).not.toContain("右脚踝扭伤");
    expect(filtered!).toContain("在上海出差");
    expect(filterActiveStateMarkdown(stateMd, "2026-12-01")).toBeNull();
  });

  test("Psyber主动改为 resolved 后立即退出召回与默认 grep", async () => {
    ctx = await createTestContext();

    const md = [
      "---",
      "title: 临时感冒",
      "kind: state",
      "status: active",
      "created: 2026-11-20",
      "tags: [感冒]",
      "---",
      "今天有点流鼻涕。",
    ].join("\n");
    expect((await ctx.tools.write("episodes/2026/11/20/ep-cold.md", md)).ok).toBe(true);
    expect(ctx.index.searchFts("感冒").length).toBe(1);

    expect(
      (await ctx.tools.edit("episodes/2026/11/20/ep-cold.md", "status: active", "status: resolved")).ok,
    ).toBe(true);
    expect(ctx.index.searchFts("感冒").length).toBe(0);

    const grepDefault = await ctx.tools.grep("流鼻涕");
    expect(grepDefault.output).toContain("未找到");

    const grepAll = await ctx.tools.grep("流鼻涕", undefined, true);
    expect(grepAll.output).toContain("episodes/2026/11/20/ep-cold.md");
  });

  test("vagueWhen 按本地日历日渲染自然模糊时间", () => {
    const tz = "Asia/Shanghai";
    const now = Date.UTC(2026, 10, 20, 4, 0, 0); // 2026-11-20 12:00
    expect(vagueWhen(now - 10 * 60_000, now, tz)).toBe("刚才");
    expect(vagueWhen(now - 2 * 3_600_000, now, tz)).toBe("今天早些时候");
    expect(vagueWhen(now - 24 * 3_600_000, now, tz)).toBe("昨天");
    expect(vagueWhen(now - 4 * 86_400_000, now, tz)).toBe("前几天");
    expect(vagueWhen(now - 35 * 86_400_000, now, tz)).toBe("上个月");
  });
});
