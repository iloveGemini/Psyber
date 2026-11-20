import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { hashBearerToken } from "../src/api/app.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { initDataDir, loadOrCreateConfig, saveConfig, type PsyberConfig } from "../src/core/config.ts";
import { openDatabase, runMigrations } from "../src/core/db.ts";
import { initMemoryGitRepo } from "../src/core/git.ts";
import { MemoryIndex } from "../src/memory/index.ts";
import { MemoryTools } from "../src/memory/tools.ts";
import { EventStore } from "../src/store/events.ts";

export interface TestContext {
  dataDir: string;
  db: Database;
  clock: VirtualClock;
  config: PsyberConfig;
  authToken: string;
  events: EventStore;
  index: MemoryIndex;
  tools: MemoryTools;
  cleanup: () => Promise<void>;
}

/** 创建完全隔离的临时测试目录与虚拟时钟上下文，100% 离线运行 */
export async function createTestContext(
  opts: { initialTimeMs?: number; timeZone?: string } = {},
): Promise<TestContext> {
  const dataDir = path.join(os.tmpdir(), `psyber-test-${crypto.randomUUID()}`);
  const clock = new VirtualClock(
    opts.initialTimeMs ?? Date.UTC(2026, 10, 20, 4, 0, 0), // 2026-11-20 12:00:00 Asia/Shanghai
    opts.timeZone ?? "Asia/Shanghai",
  );

  await initDataDir(dataDir);
  await initMemoryGitRepo(dataDir);
  const config = await loadOrCreateConfig(dataDir, clock.now(), clock.timeZone);
  const authToken = "psb_test_token_0001";
  config.auth.devices.push({
    deviceId: "dev-test-1",
    tokenHash: hashBearerToken(authToken),
    deviceName: "Test Mac",
    platform: "macos",
    createdAt: clock.now(),
    lastSeenAt: clock.now(),
  });
  await saveConfig(dataDir, config);

  const db = openDatabase(path.join(dataDir, "psyber.sqlite"));
  runMigrations(db, clock.now());

  const events = new EventStore(db, clock);
  const index = new MemoryIndex(db, dataDir, clock);
  const tools = new MemoryTools(dataDir, index, clock);

  return {
    dataDir,
    db,
    clock,
    config,
    authToken,
    events,
    index,
    tools,
    cleanup: async () => {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}
