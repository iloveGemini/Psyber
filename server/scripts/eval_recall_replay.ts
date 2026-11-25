#!/usr/bin/env bun
/**
 * 闲聊回放召回评测 CLI（Spec 02 §9.3）：
 *   bun run eval:recall-replay --data-dir ~/.psyber/test-replay prepare
 *   bun run eval:recall-replay --data-dir ~/.psyber/test-replay grade [--sample 180] [--review 50]
 *   bun run eval:recall-replay --data-dir ~/.psyber/test-replay apply-review
 *   bun run eval:recall-replay --data-dir ~/.psyber/test-replay run [--variant baseline]
 *
 * 隐私红线：所有产物仅写入 <dataDir>/eval/，绝不修改源库，绝不提交进仓库。
 */
import os from "node:os";
import path from "node:path";
import { loadOrCreateConfig } from "../src/core/config.ts";
import { DynamicDecisionClient } from "../src/llm/decision.ts";
import {
  applyReviewMarkdown,
  buildAndGradeGold,
  CachedDecisionClient,
  formatComparisonTable,
  prepareMoments,
  runEvalVariant,
  type EvalReport,
  type EvalVariantSpec,
} from "../src/memory/recall_eval.ts";

const PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function parseArgs(argv: string[]) {
  let dataDir = "";
  let command = "";
  let sampleSize = 180;
  let reviewCount = 50;
  let concurrency = 6;
  let decisionProvider = "";
  const variants: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") dataDir = expandHome(argv[++i] ?? "");
    else if (a === "--sample") sampleSize = Number(argv[++i] ?? 180);
    else if (a === "--review") reviewCount = Number(argv[++i] ?? 50);
    else if (a === "--concurrency") concurrency = Number(argv[++i] ?? 6);
    else if (a === "--decision-provider") decisionProvider = argv[++i] ?? "";
    else if (a === "--variant") variants.push(argv[++i] ?? "");
    else if (!a.startsWith("-") && !command) command = a;
  }

  if (!dataDir || !command) {
    console.error(
      "Usage: bun run eval:recall-replay --data-dir <dir> <prepare|grade|apply-review|run> [--sample 180] [--review 50] [--variant baseline] [--decision-provider <name>]",
    );
    process.exit(1);
  }
  return { dataDir, command, sampleSize, reviewCount, concurrency, decisionProvider, variants };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadOrCreateConfig(args.dataDir);
  if (args.decisionProvider && cfg.llm?.slots?.decision) {
    cfg.llm.slots.decision = {
      ...cfg.llm.slots.decision,
      provider: args.decisionProvider,
    };
  }
  const cachePath = path.join(args.dataDir, "eval", "decision_cache.jsonl");
  const rawDecision = new DynamicDecisionClient({
    dataDir: args.dataDir,
    getConfig: () => cfg,
  });
  const decisionClient = new CachedDecisionClient(rawDecision, cachePath);

  if (args.command === "prepare") {
    console.log(`[eval] 正在对 ${args.dataDir} 提取并分类聊天时刻...`);
    const moments = await prepareMoments({
      dataDir: args.dataDir,
      timeZone: cfg.timezone,
      decisionClient,
      concurrency: args.concurrency,
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) {
          console.log(`  classified ${done}/${total} (cache hits=${decisionClient.hits}, misses=${decisionClient.misses})`);
        }
      },
    });
    const counts: Record<string, number> = {};
    for (const m of moments) counts[m.momentClass] = (counts[m.momentClass] ?? 0) + 1;
    console.log(`[eval] 完成：共 ${moments.length} 条可评测时刻，分布：`, counts);
    return;
  }

  if (args.command === "grade") {
    console.log(`[eval] 正在分层抽样 (${args.sampleSize}) + 全目录候选池 + 事后打分...`);
    const { gold, reviewPath } = await buildAndGradeGold({
      dataDir: args.dataDir,
      timeZone: cfg.timezone,
      decisionClient,
      sampleSize: args.sampleSize,
      reviewCount: args.reviewCount,
      concurrency: Math.min(args.concurrency, 4),
      onProgress: (done, total) => {
        if (done % 20 === 0 || done === total) {
          console.log(`  graded ${done}/${total} (cache hits=${decisionClient.hits}, misses=${decisionClient.misses})`);
        }
      },
    });
    const suspected = gold.filter((g) => g.missingMemorySuspected).length;
    console.log(`[eval] 完成：gold=${gold.length} 条（其中疑似整理轮漏写卡=${suspected}），人工抽查单已生成：${reviewPath}`);
    return;
  }

  if (args.command === "apply-review") {
    const res = await applyReviewMarkdown(args.dataDir, {
      timeZone: cfg.timezone,
      sleepEnd: cfg.circadian?.sleepEnd,
    });
    console.log(
      `[eval] 已应用人工抽查改动：修改时刻分类 ${res.updatedTurns} 条，修改卡片评分 ${res.updatedCards} 条，新增漏召卡 ${res.addedCards} 张，修正跨午夜快照 ${res.fixedSnapshots} 条。`,
    );
    return;
  }

  if (args.command === "run") {
    const requested = args.variants.length > 0 ? args.variants : ["baseline"];
    const baseCfg = {
      charBudget: cfg.recall?.charBudget ?? 3200,
      dedupWindowMin: cfg.recall?.dedupWindowMin ?? 120,
      recentDailyWindowHours: cfg.recall?.recentDailyWindowHours ?? 72,
      embedTimeoutMs: cfg.recall?.embedTimeoutMs ?? 2500,
    };
    const buildVariant = (name: string): EvalVariantSpec => {
      switch (name) {
        case "baseline":
          // 原版行为：仅当前句 FTS、无分数门槛、无门控
          return {
            name,
            useDecisionClient: false,
            recallConfig: {
              ...baseCfg,
              gate: { enabled: false, threshold: 0.55 },
              queryWindowTurns: 0,
              ftsMinScore: 0,
            },
          };
        case "window_fts":
          return {
            name,
            useDecisionClient: false,
            recallConfig: {
              ...baseCfg,
              gate: { enabled: false, threshold: 0.55 },
              queryWindowTurns: 4,
              ftsMinScore: 0,
            },
          };
        case "fts_thresh":
          return {
            name,
            useDecisionClient: false,
            recallConfig: {
              ...baseCfg,
              gate: { enabled: false, threshold: 0.55 },
              queryWindowTurns: 4,
              ftsMinScore: 0.45,
            },
          };
        case "gate_rerank":
          return {
            name,
            useDecisionClient: true,
            recallConfig: {
              ...baseCfg,
              gate: { enabled: true, threshold: 0.25 },
              rerank: { threshold: 0.25 },
              queryWindowTurns: 4,
              candidatePool: 10,
              catalogScanMaxCards: 0,
              decisionTimeoutMs: 10_000,
            },
          };
        case "catalog_gate":
          return {
            name,
            useDecisionClient: true,
            recallConfig: {
              ...baseCfg,
              gate: { enabled: true, threshold: 0.45 },
              rerank: { threshold: 0.4 },
              queryWindowTurns: 4,
              catalogScanMaxCards: 250,
              decisionTimeoutMs: 10_000,
            },
          };
        case "catalog_strict":
          return {
            name,
            useDecisionClient: true,
            recallConfig: {
              ...baseCfg,
              gate: { enabled: true, threshold: 0.55 },
              rerank: { threshold: 0.5 },
              queryWindowTurns: 4,
              catalogScanMaxCards: 250,
              decisionTimeoutMs: 10_000,
            },
          };
        case "catalog_loose":
          return {
            name,
            useDecisionClient: true,
            recallConfig: {
              ...baseCfg,
              gate: { enabled: true, threshold: 0.3 },
              rerank: { threshold: 0.3 },
              queryWindowTurns: 4,
              catalogScanMaxCards: 250,
              decisionTimeoutMs: 10_000,
            },
          };
        default:
          return { name, useDecisionClient: name.includes("gate") };
      }
    };
    const specs: EvalVariantSpec[] = requested.map(buildVariant);

    const reports: EvalReport[] = [];
    for (const spec of specs) {
      console.log(`[eval] 运行变体：${spec.name}...`);
      const report = await runEvalVariant({
        dataDir: args.dataDir,
        timeZone: cfg.timezone,
        variant: spec,
        decisionClient,
        promptsDir: PROMPTS_DIR,
      });
      reports.push(report);
    }
    console.log("\n" + formatComparisonTable(reports));
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

await main();
