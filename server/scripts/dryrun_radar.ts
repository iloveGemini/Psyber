#!/usr/bin/env bun
/**
 * 离线只读体检雷达干跑脚本（严守 NG-2：绝不修改磁盘上的任何记忆文件）：
 * 用法：
 *   cd server && bun run radar:dryrun -- --data-dir ~/.psyber/test --scope bedtime --days 1 --verbose
 *   cd server && bun run radar:dryrun -- --data-dir ~/.psyber/test --scope weekly --days 7 --verbose
 *   cd server && bun run radar:dryrun -- --data-dir ~/.psyber/test --paths episodes/2026/11/26/ep-foo.md
 */
import os from "node:os";
import path from "node:path";
import { SystemClock, localDay } from "../src/core/clock.ts";
import { loadOrCreateConfig, mergeRadarConfig } from "../src/core/config.ts";
import { openDatabase, runMigrations } from "../src/core/db.ts";
import { expandHomePath } from "../src/extensions/bash.ts";
import { DynamicDecisionClient } from "../src/llm/decision.ts";
import { DynamicEmbeddingClient } from "../src/llm/embedding.ts";
import { MemoryIndex } from "../src/memory/index.ts";
import {
  episodeDateFromPath,
  isEligibleRadarRow,
  runMemoryRadar,
  type RadarScope,
} from "../src/memory/radar.ts";

interface CliOpts {
  dataDir: string;
  promptsDir: string;
  scope: RadarScope;
  days: number;
  paths: string[];
  targetDay?: string;
  /** 可选按情景路径日期（episodes/YYYY/MM/DD/...）筛选新卡的起始日（含） */
  epFrom?: string;
  timeoutMs?: number;
  allowProdDir: boolean;
  verbose: boolean;
}

function resolveDataDirInput(rawPath: string): string {
  return path.resolve(expandHomePath(rawPath.trim()));
}

function assertSafeDataDir(dataDir: string, allowProdDir: boolean): void {
  const prodDefault = path.resolve(os.homedir(), ".psyber", "default");
  if (!allowProdDir && path.resolve(dataDir) === prodDefault) {
    throw new Error(
      `安全拦截：禁止在默认正式目录 (${prodDefault}) 执行干跑脚本！请使用专用测试目录（如 --data-dir ~/.psyber/test）。`,
    );
  }
}

function parseArgs(argv: string[]): CliOpts {
  const defaultDir =
    process.env.PSYBER_DATA_DIR || path.join(os.homedir() || ".", ".psyber", "test");
  const opts: CliOpts = {
    dataDir: resolveDataDirInput(defaultDir),
    promptsDir: path.resolve(import.meta.dir, "../../prompts"),
    scope: "bedtime",
    days: 1,
    paths: [],
    allowProdDir: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--data-dir" && argv[i + 1]) {
      opts.dataDir = resolveDataDirInput(argv[++i]!);
    } else if (a === "--allow-prod-dir") {
      opts.allowProdDir = true;
    } else if (a === "--prompts-dir" && argv[i + 1]) {
      opts.promptsDir = path.resolve(argv[++i]!);
    } else if (a === "--scope" && argv[i + 1]) {
      const v = argv[++i]!;
      if (v === "bedtime" || v === "weekly") opts.scope = v;
    } else if (a === "--days" && argv[i + 1]) {
      const n = Number(argv[++i]!);
      if (Number.isFinite(n) && n > 0) opts.days = n;
    } else if (a === "--day" && argv[i + 1]) {
      opts.targetDay = argv[++i]!;
    } else if (a === "--ep-from" && argv[i + 1]) {
      opts.epFrom = argv[++i]!;
    } else if (a === "--timeout" && argv[i + 1]) {
      const n = Number(argv[++i]!);
      if (Number.isFinite(n) && n >= 1000) opts.timeoutMs = n;
    } else if (a === "--verbose" || a === "-v") {
      opts.verbose = true;
    } else if (a === "--paths" && argv[i + 1]) {
      opts.paths.push(
        ...argv[++i]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  assertSafeDataDir(opts.dataDir, opts.allowProdDir);
  const nowMs = Date.now();
  const config = await loadOrCreateConfig(opts.dataDir, nowMs);
  const clock = new SystemClock(config.timezone);
  const db = openDatabase(path.join(opts.dataDir, "psyber.sqlite"));
  runMigrations(db, nowMs);

  try {
    const memoryIndex = new MemoryIndex(db, opts.dataDir, clock);
    await memoryIndex.reindexAll();

    const allEligible = memoryIndex
      .listAllRows()
      .filter((r) => isEligibleRadarRow(r, nowMs));

    // 若库是历史回放库（最新卡早于当前墙钟），自动以库内最新卡片日期为基准窗口，避免 --days 误选出 0 张卡
    const anchorMs = allEligible.length > 0 ? Math.min(nowMs, allEligible[0]!.updated_at) : nowMs;
    const effectiveTargetDay = opts.targetDay ?? localDay(anchorMs, config.timezone);
    const cutoffMs = anchorMs - opts.days * 86_400_000;

    const newCardPaths =
      opts.paths.length > 0
        ? opts.paths
        : opts.epFrom
          ? allEligible
              .filter((r) => {
                const epDay = episodeDateFromPath(r.path);
                if (epDay) {
                  return epDay >= opts.epFrom!;
                }
                return localDay(r.updated_at, config.timezone) >= opts.epFrom!;
              })
              .map((r) => r.path)
          : allEligible.filter((r) => r.updated_at >= cutoffMs).map((r) => r.path);

    const decisionClient = new DynamicDecisionClient({
      dataDir: opts.dataDir,
      getConfig: () => config,
    });
    const embedding = new DynamicEmbeddingClient({
      dataDir: opts.dataDir,
      getConfig: () => config,
    });

    const cachedVecRow = db
      .query("SELECT COUNT(*) AS cnt FROM card_embeddings WHERE model_key = ?")
      .get(embedding.modelKey) as { cnt: number } | null;

    const radarCfg = mergeRadarConfig(config.radar, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });

    console.log(
      `[radar:dryrun] dataDir=${opts.dataDir} | scope=${opts.scope} | targetDay=${effectiveTargetDay} | totalEligible=${allEligible.length} | newCards=${newCardPaths.length} | embeddingConfigured=${embedding.isConfigured()} (cached=${cachedVecRow?.cnt ?? 0})`,
    );
    const t0 = Date.now();
    const res = await runMemoryRadar({
      db,
      dataDir: opts.dataDir,
      promptsDir: opts.promptsDir,
      clock,
      memoryIndex,
      decisionClient,
      embedding,
      scope: opts.scope,
      targetDay: effectiveTargetDay,
      newCardPaths,
      radarConfig: radarCfg,
      includeOpenBoardInBlock: true,
      collectDebug: opts.verbose,
    });
    const elapsedMs = Date.now() - t0;

    console.log(
      `[radar:dryrun] done in ${elapsedMs}ms | executed=${res.executed} | match=${res.debug?.matchMethod ?? "n/a"} | boardChecked=${res.boardItemsChecked} | pairsEvaluated=${res.pairsEvaluated} | findings=${res.findings.length}${res.timedOut ? " | TIMED_OUT" : ""}${res.skipReason ? ` | skip=${res.skipReason}` : ""}`,
    );

    if (opts.verbose && res.debug) {
      if (res.debug.boardItems.length > 0) {
        console.log("\n=== 看板条目打分明细 ===");
        for (const b of res.debug.boardItems) {
          console.log(
            `  [${b.id}] (${b.filePath}) ob=${b.obsoleteScore.toFixed(2)} ct=${b.contradictionScore.toFixed(2)} | ${b.text}`,
          );
        }
      }
      if (res.debug.pairs.length > 0) {
        console.log("\n=== 新旧卡片对 5 问打分明细 ===");
        for (const p of res.debug.pairs) {
          const parts = [
            `sim=${p.similarity.toFixed(2)}(${p.matchMethod})`,
            p.contradiction !== undefined ? `ct=${p.contradiction.toFixed(2)}` : null,
            p.obsolete !== undefined ? `ob=${p.obsolete.toFixed(2)}` : null,
            p.redundant !== undefined ? `rd=${p.redundant.toFixed(2)}` : null,
            p.promote !== undefined ? `pm=${p.promote.toFixed(2)}` : null,
            p.link !== undefined ? `lk=${p.link.toFixed(2)}` : p.alreadyLinked ? "lk=linked" : null,
            p.representation
              ? `rep=${p.representation}(${(p.representationProb ?? 0).toFixed(2)})`
              : null,
            p.selectedFindingKind ? `=> HIT:${p.selectedFindingKind}` : null,
          ].filter(Boolean);
          console.log(`  [[${p.newCardTitle}]] ↔ [[${p.oldCardTitle}]] | ${parts.join(" ")}`);
        }
      }
    }

    if (res.reflectGateHint) {
      console.log("\n=== reflectGateHint ===\n" + res.reflectGateHint);
    }
    if (res.renderedBlock) {
      console.log("\n=== <memory_radar> ===\n" + res.renderedBlock);
    } else {
      console.log("\n（本次无达到高置信阈值的线索，实际运行将零注入）");
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[radar:dryrun] failed:", err);
  process.exit(1);
});
