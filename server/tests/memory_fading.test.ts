import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { mergeRecallConfig } from "../src/core/config.ts";
import { renderMemoryRadarBlock, runMemoryRadar, scanStaleThreadFindings } from "../src/memory/radar.ts";
import { recallMemories } from "../src/memory/recall.ts";
import { createTestContext, type TestContext } from "./helpers.ts";

let ctx: TestContext | null = null;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("双层记忆淡出机制（episodes 索引层软淡出 + threads 周反思久未更新雷达）", () => {
  test("episodes/ 索引层软淡出：超 90 天普通切片退出召回，pinned / 核心收藏经验入链 / 近期访问均自动保活，且磁盘原文不动仍可 read", async () => {
    // 虚拟当前时间：2026-11-20（距 2026-07-01 约 142 天 > 90 天）
    ctx = await createTestContext({ initialTimeMs: Date.UTC(2026, 10, 20, 4, 0, 0) });

    // 1. 超 90 天的普通情景切片（无保护入链、未 pinned、未访问）
    const ordinaryPath = "episodes/2026/07/01/ep-ordinary-lunch.md";
    const ordinaryWrite = await ctx.tools.write(
      ordinaryPath,
      [
        "---",
        "title: 07-01 午饭吃麻辣烫",
        "kind: episode",
        "status: active",
        "created: 2026-07-01",
        "updated: 2026-07-01",
        "---",
        "中午一起聊了楼下新开的麻酱麻辣烫味道不错。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    expect(ordinaryWrite.ok).toBe(true);

    // 2. 超 90 天但显式 pinned: true 的情景切片
    const pinnedPath = "episodes/2026/07/02/ep-pinned-promise.md";
    const pinnedWrite = await ctx.tools.write(
      pinnedPath,
      [
        "---",
        "title: 07-02 星空下的约定",
        "kind: episode",
        "status: active",
        "pinned: true",
        "created: 2026-07-02",
        "updated: 2026-07-02",
        "---",
        "那晚我们在阳台聊了很久关于未来养猫与搬家的麻辣烫约定。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    expect(pinnedWrite.ok).toBe(true);

    // 3. 超 90 天但被 lessons/ 通过 [[短标题]] 引用的情景切片
    const linkedPath = "episodes/2026/07/03/ep-lesson-linked.md";
    await ctx.tools.write(
      linkedPath,
      [
        "---",
        "title: 07-03 深夜误会复盘",
        "kind: episode",
        "status: active",
        "created: 2026-07-03",
        "updated: 2026-07-03",
        "---",
        "因为语气太冲导致关于麻辣烫的小争执，后来坦诚聊开了。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    await ctx.tools.write(
      "lessons/communication-tone.md",
      [
        "---",
        "title: 经验·沟通语气放柔",
        "kind: lesson",
        "status: active",
        "when_to_recall: 当对话出现小摩擦或语气生硬时",
        "created: 2026-07-04",
        "updated: 2026-07-04",
        "---",
        "吸取 [[07-03 深夜误会复盘]] 的教训，先听完对方想法再接话。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );

    // 4. 90 天内的近期情景切片
    const recentPath = "episodes/2026/10/15/ep-recent-dinner.md";
    await ctx.tools.write(
      recentPath,
      [
        "---",
        "title: 10-15 晚饭吃麻辣烫",
        "kind: episode",
        "status: active",
        "created: 2026-10-15",
        "updated: 2026-10-15",
        "---",
        "下班后又去了那家麻辣烫店，加了双份豆皮。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );

    // 验证软淡出集合仅包含 ordinaryPath
    const faded = ctx.index.computeSoftFadedEpisodePaths({ fadeAfterDays: 90 });
    expect(faded.has(ordinaryPath)).toBe(true);
    expect(faded.has(pinnedPath)).toBe(false);
    expect(faded.has(linkedPath)).toBe(false);
    expect(faded.has(recentPath)).toBe(false);

    // 召回检索「麻辣烫」：ordinaryPath 退出召回，其余三张正常进入
    const recallRes = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-fade-1",
      turnId: "turn-fade-1",
      query: "我们之前吃过麻辣烫吗",
    });
    const recalledPaths = recallRes.items.map((i) => i.path);
    expect(recalledPaths).not.toContain(ordinaryPath);
    expect(recalledPaths).toContain(pinnedPath);
    expect(recalledPaths).toContain(linkedPath);
    expect(recalledPaths).toContain(recentPath);

    // 磁盘 Markdown 原文保持 status: active 未被改写，且 read 工具可正常直读
    const rawOnDisk = await fs.readFile(path.join(ctx.dataDir, "memory", ordinaryPath), "utf8");
    expect(rawOnDisk).toContain("status: active");
    const readRes = await ctx.tools.read(ordinaryPath, { countAccess: true });
    expect(readRes.ok).toBe(true);
    expect(readRes.output).toContain("麻酱麻辣烫");

    // 被 read 访问过（last_accessed 已刷新至今天）后，ordinaryPath 自动复活恢复召回资格
    const fadedAfterRead = ctx.index.computeSoftFadedEpisodePaths({ fadeAfterDays: 90 });
    expect(fadedAfterRead.has(ordinaryPath)).toBe(false);

    // episodeFadeDays: 0 关闭软淡出
    const fadedDisabled = ctx.index.computeSoftFadedEpisodePaths({ fadeAfterDays: 0 });
    expect(fadedDisabled.size).toBe(0);
  });

  test("threads/ 久未更新只读雷达：按 decay 阈值扫描、豁免 none/lists/work、入链保活、单次上限 5 条且无决策模型亦可出块", async () => {
    // 虚拟当前时间：2026-11-20
    ctx = await createTestContext({ initialTimeMs: Date.UTC(2026, 10, 20, 4, 0, 0) });

    // 写入 threads/REGISTRY.yaml
    const regWrite = await ctx.tools.write(
      "threads/REGISTRY.yaml",
      [
        "spaces:",
        "  fitness:",
        "    title: 阶段健身打卡",
        "    triggers: [健身, 跑步]",
        "    decay: short",
        "    card_style: 打卡记录",
        "  hobbies:",
        "    title: 长期兴趣线索",
        "    triggers: [吉他, 摄影]",
        "    decay: slow",
        "    card_style: 进展追踪",
        "  writing:",
        "    title: 共创作品",
        "    triggers: [小说, 设定]",
        "    decay: none",
        "    card_style: 作品集",
        "  lists:",
        "    title: 书影音清单",
        "    triggers: [书单, 片单]",
        "    decay: slow",
        "    card_style: 清单",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    expect(regWrite.ok).toBe(true);

    // 1. decay: short 且闲置 45 天（>= 30 天）-> 应报 stale
    await ctx.tools.write(
      "threads/fitness/morning-run.md",
      [
        "---",
        "title: 线索·晨跑计划",
        "kind: serial",
        "status: active",
        "created: 2026-10-01",
        "updated: 2026-10-05",
        "---",
        "计划每周晨跑三次。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );

    // 2. decay: short 更新于 60 天前，但 5 天前的新 episode 引用了它 -> 入链保活，不应报 stale
    await ctx.tools.write(
      "threads/fitness/yoga.md",
      [
        "---",
        "title: 线索·晚间拉伸",
        "kind: serial",
        "status: active",
        "created: 2026-09-15",
        "updated: 2026-09-20",
        "---",
        "睡前拉伸 15 分钟。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    await ctx.tools.write(
      "episodes/2026/11/15/ep-yoga-mention.md",
      [
        "---",
        "title: 11-15 聊起晚间拉伸",
        "kind: episode",
        "status: active",
        "created: 2026-11-15",
        "updated: 2026-11-15",
        "---",
        "今晚又想起 [[线索·晚间拉伸]]，跟着做了十分钟。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );

    // 3. decay: slow 闲置 45 天（< 90 天）-> 不应报 stale
    await ctx.tools.write(
      "threads/hobbies/guitar-recent.md",
      [
        "---",
        "title: 线索·指弹练习",
        "kind: serial",
        "status: active",
        "created: 2026-10-01",
        "updated: 2026-10-06",
        "---",
        "正在练 F 和弦。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );

    // 4. 豁免项：decay: none / thread:lists / kind: work（即使超 200 天也不报）
    await ctx.tools.write(
      "threads/writing/novel.md",
      [
        "---",
        "title: 作品·星海漫游",
        "kind: serial",
        "status: active",
        "created: 2026-03-01",
        "updated: 2026-03-01",
        "---",
        "长篇设定集。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    await ctx.tools.write(
      "threads/lists/books.md",
      [
        "---",
        "title: 清单·年度书单",
        "kind: note",
        "status: active",
        "created: 2026-03-01",
        "updated: 2026-03-01",
        "---",
        "待读书目列表。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    await ctx.tools.write(
      "threads/hobbies/sketch-work.md",
      [
        "---",
        "title: 作品·手绘插画",
        "kind: work",
        "status: active",
        "created: 2026-03-01",
        "updated: 2026-03-01",
        "---",
        "静态作品记录。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );

    // 5. 再写入 5 张超 90 天的 decay: slow 卡片，测试 top-5 防刷屏上限与按闲置天数降序
    const oldSlowDates = [
      { slug: "old-1", date: "2026-04-01", title: "线索·胶片摄影" },
      { slug: "old-2", date: "2026-05-01", title: "线索·手冲咖啡" },
      { slug: "old-3", date: "2026-06-01", title: "线索·木工入门" },
      { slug: "old-4", date: "2026-07-01", title: "线索·烘焙吐司" },
      { slug: "old-5", date: "2026-08-01", title: "线索·露营装备" },
    ];
    for (const item of oldSlowDates) {
      await ctx.tools.write(
        `threads/hobbies/${item.slug}.md`,
        [
          "---",
          `title: ${item.title}`,
          "kind: serial",
          "status: active",
          `created: ${item.date}`,
          `updated: ${item.date}`,
          "---",
          "久未更新的兴趣线索。",
        ].join("\n"),
        { trustFrontmatterDates: true },
      );
    }

    // 总计 6 张超期（5 张 slow + 1 张 short），应截断为最久的 5 张且不含任何豁免/保活卡
    const staleFindings = await scanStaleThreadFindings({
      db: ctx.db,
      dataDir: ctx.dataDir,
      memoryIndex: ctx.index,
      nowMs: ctx.clock.now(),
    });
    expect(staleFindings.length).toBe(5);
    const stalePaths = staleFindings.map((f) => f.targetPath);
    expect(stalePaths[0]).toBe("threads/hobbies/old-1.md");
    expect(stalePaths).not.toContain("threads/fitness/yoga.md");
    expect(stalePaths).not.toContain("threads/hobbies/guitar-recent.md");
    expect(stalePaths).not.toContain("threads/writing/novel.md");
    expect(stalePaths).not.toContain("threads/lists/books.md");
    expect(stalePaths).not.toContain("threads/hobbies/sketch-work.md");
    // 未召回过的导入卡显式附带提示
    expect(staleFindings[0]!.detail).toContain("尚未被召回，历史导入属正常");

    // 放宽上限为 10 时，decay: short 的 morning-run.md 也会出现
    const allStale = await scanStaleThreadFindings({
      db: ctx.db,
      dataDir: ctx.dataDir,
      memoryIndex: ctx.index,
      nowMs: ctx.clock.now(),
      maxItems: 10,
    });
    expect(allStale.map((f) => f.targetPath)).toContain("threads/fitness/morning-run.md");

    // 无 decisionClient 时，周反思 runMemoryRadar 仍可纯本地扫出 [久未更新 / 可考虑淡出]
    const weeklyRes = await runMemoryRadar({
      db: ctx.db,
      dataDir: ctx.dataDir,
      clock: ctx.clock,
      memoryIndex: ctx.index,
      scope: "weekly",
      newCardPaths: [],
    });
    expect(weeklyRes.executed).toBe(true);
    expect(weeklyRes.findings.length).toBe(5);
    expect(weeklyRes.renderedBlock).toContain("[久未更新 / 可考虑淡出]");
    expect(weeklyRes.renderedBlock).toContain("[[线索·胶片摄影]]");

    // bedtime 渲染绝不混入 stale 线索
    const bedtimeBlock = renderMemoryRadarBlock(staleFindings, { scope: "bedtime" });
    expect(bedtimeBlock).toBeNull();

    // 有 decisionClient 但无符合条件新卡时，weekly runMemoryRadar 仍照常扫出 stale 线索
    const dummyDecision = {
      async decide() {
        return { answers: {} };
      },
    };
    const weeklyNoNewRes = await runMemoryRadar({
      db: ctx.db,
      dataDir: ctx.dataDir,
      clock: ctx.clock,
      memoryIndex: ctx.index,
      decisionClient: dummyDecision,
      scope: "weekly",
      newCardPaths: [],
    });
    expect(weeklyNoNewRes.executed).toBe(true);
    expect(weeklyNoNewRes.findings.length).toBe(5);
    expect(weeklyNoNewRes.renderedBlock).toContain("[久未更新 / 可考虑淡出]");
  });

  test("审查缺陷回归：自动召回同步刷新 access_count/last_accessed、1 跳双链排除软淡出切片、non-state faded 文案准确与 episodeFadeDays 钳制", async () => {
    ctx = await createTestContext({ initialTimeMs: Date.UTC(2026, 10, 20, 4, 0, 0) });

    // 1. 普通 140 天前的 ep-*.md 被一张活跃 threads/ 卡引用（非 core/favorite/lessons，不应保活，也不应被 1 跳捞回）
    const fadedEp = "episodes/2026/07/01/ep-old-coffee.md";
    await ctx.tools.write(
      fadedEp,
      [
        "---",
        "title: 07-01 街角买冰美式",
        "kind: episode",
        "status: active",
        "created: 2026-07-01",
        "updated: 2026-07-01",
        "---",
        "路过街角买了一杯普通冰美式。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    const activeThread = "threads/hobbies/coffee-notes.md";
    await ctx.tools.write(
      activeThread,
      [
        "---",
        "title: 线索·咖啡豆手账",
        "kind: serial",
        "status: active",
        "created: 2026-11-10",
        "updated: 2026-11-10",
        "---",
        "记录各种浅烘咖啡豆的萃取参数，早年还聊过 [[07-01 街角买冰美式]]。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );

    // 构造始终放行首跳与 1 跳的 decisionClient，验证 1 跳不会把 fadedEp 捞回
    const hopDecision = {
      async decide(req: { questions: Record<string, unknown> }) {
        const answers: Record<string, { noul?: number }> = {};
        for (const k of Object.keys(req.questions)) {
          answers[k] = { noul: k === "evidence_sufficient" ? 0.1 : 0.95 };
        }
        return { answers };
      },
    };
    const recallRes = await recallMemories({
      db: ctx.db,
      dataDir: ctx.dataDir,
      index: ctx.index,
      clock: ctx.clock,
      sessionId: "sess-reg-1",
      turnId: "turn-reg-1",
      query: "最近咖啡豆手账记了什么",
      decisionClient: hopDecision,
    });
    const recalledPaths = recallRes.items.map((i) => i.path);
    expect(recalledPaths).toContain(activeThread);
    expect(recalledPaths).not.toContain(fadedEp);

    // 2. 自动召回命中 activeThread 后，access_count 与 last_accessed 自动更新
    const threadRow = ctx.index.getRow(activeThread);
    expect(threadRow?.access_count).toBe(1);
    expect(threadRow?.last_accessed).toBe(ctx.clock.now());

    // 3. 手动标为 status: faded 的非 state 卡，read 时提示「已自然淡出」而非「已过短期 TTL」
    const fadedThread = "threads/hobbies/old-stamp.md";
    await ctx.tools.write(
      fadedThread,
      [
        "---",
        "title: 线索·集邮计划",
        "kind: serial",
        "status: faded",
        "created: 2026-06-01",
        "updated: 2026-06-01",
        "---",
        "曾经想集邮，后来淡了。",
      ].join("\n"),
      { trustFrontmatterDates: true },
    );
    const readFaded = await ctx.tools.read(fadedThread);
    expect(readFaded.ok).toBe(true);
    expect(readFaded.output).toContain("已自然淡出");
    expect(readFaded.output).not.toContain("已过短期 TTL");

    // 4. mergeRecallConfig 对 episodeFadeDays 做非负取整钳制
    expect(mergeRecallConfig({ episodeFadeDays: -15 }).episodeFadeDays).toBe(0);
    expect(mergeRecallConfig({ episodeFadeDays: 120.8 }).episodeFadeDays).toBe(120);
  });
});
