import os from "node:os";
import path from "node:path";
import { createApp } from "./api/app.ts";
import { SystemClock } from "./core/clock.ts";
import { initDataDir, loadOrCreateConfig, saveConfig } from "./core/config.ts";
import { openDatabase, runMigrations } from "./core/db.ts";
import {
  cleanupTransientLocks,
  initMemoryGitRepo,
  recoverUncommittedTrackedCards,
} from "./core/git.ts";
import { DirectEngine } from "./engine/direct.ts";
import { SseHub } from "./engine/sse.ts";
import { syncStaticStickers } from "./expression/stickers.ts";
import type { ChatModelClient, ChatStreamChunk } from "./llm/client.ts";
import { MemoryIndex } from "./memory/index.ts";
import { MemoryTools, isAllowedWritePath } from "./memory/tools.ts";
import { EventStore } from "./store/events.ts";
import { ToolRegistry, registerCoreTier1Tools } from "./tools/registry.ts";

function resolveDataDir(): string {
  const raw = process.env.PSYBER_DATA_DIR || "~/.psyber/default";
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

/** 未配置模型凭证时的安全兜底客户端：经标准 SSE turn.error 引导用户配置 BYOK 凭证 */
class UnconfiguredChatModel implements ChatModelClient {
  readonly contextWindow = 200_000;

  async *stream(): AsyncIterable<ChatStreamChunk> {
    yield {
      type: "error",
      code: "AUTH_EXPIRED",
      message: "尚未配置主对话模型凭证，请先完成 Genesis 或在设置中填入 API Key",
      retryable: false,
    };
  }
}

async function main(): Promise<void> {
  const dataDir = resolveDataDir();
  const promptsDir = path.resolve(import.meta.dir, "../../prompts");
  const port = Number(process.env.PSYBER_PORT || 3721);
  // Spec 05 §5.3：默认监听 0.0.0.0 供局域网移动端扫码直连，仅本机使用可设 127.0.0.1
  const host = process.env.PSYBER_HOST || "0.0.0.0";

  await initDataDir(dataDir);
  await cleanupTransientLocks(dataDir);
  await initMemoryGitRepo(dataDir);
  await recoverUncommittedTrackedCards(dataDir, isAllowedWritePath);

  const bootClock = new SystemClock();
  const config = await loadOrCreateConfig(dataDir, bootClock.now());
  const clock = new SystemClock(config.timezone);

  const db = openDatabase(path.join(dataDir, "psyber.sqlite"));
  runMigrations(db, clock.now());

  const memoryIndex = new MemoryIndex(db, dataDir, clock);
  await memoryIndex.reindexAll();
  await syncStaticStickers(db, dataDir, clock);

  const events = new EventStore(db, clock);
  const memoryTools = new MemoryTools(dataDir, memoryIndex, clock);
  const registry = new ToolRegistry();
  registerCoreTier1Tools(registry, {
    memoryTools,
    events,
    clock,
    getConfig: () => config,
    saveConfig: (cfg) => saveConfig(dataDir, cfg),
  });

  const sse = new SseHub();
  const engine = new DirectEngine({
    dataDir,
    promptsDir,
    clock,
    getConfig: () => config,
    events,
    memoryIndex,
    registry,
    chatModel: new UnconfiguredChatModel(),
    db,
  });

  const app = createApp({
    version: "0.1.0",
    clock,
    getConfig: () => config,
    events,
    getActiveSessionId: () => engine.getActiveSessionId(),
    db,
    sse,
    engine,
  });

  Bun.serve({
    hostname: host,
    port,
    fetch: app.fetch,
  });

  console.log(`Psyber server listening on http://${host}:${port} (dataDir=${dataDir})`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Failed to start Psyber server:", err);
    process.exit(1);
  });
}
