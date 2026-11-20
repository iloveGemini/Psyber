import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { localDay, type Clock } from "./clock.ts";

const DAILY_BACKUP_RE = /^psyber-(\d{8})\.sqlite$/;
const DEFAULT_KEEP_DAILY_COUNT = 7;

/** 进程级单飞锁（按数据目录绝对路径隔离），避免并发 VACUUM INTO 互相踩踏 */
const backupInFlight = new Set<string>();

/**
 * 清理过期的每日 SQLite 备份：
 * - Ring 1 保留最近 keepDailyCount（默认 7）份按本地日命名的备份，绝不误删 psyber-latest.sqlite 当前指向目标；
 * - Ring 1.5 将按 Spec 05 §4.2 升级为 GFS 三级轮转（7 天 + 4 周日 + 12 月末）。
 */
export async function rotateDailyBackups(
  backupsDir: string,
  keepDailyCount = DEFAULT_KEEP_DAILY_COUNT,
): Promise<string[]> {
  const keepCount = Math.max(1, keepDailyCount);
  const latestLink = path.join(backupsDir, "psyber-latest.sqlite");
  let latestTarget: string | null = null;
  try {
    latestTarget = path.basename(await fs.readlink(latestLink));
  } catch {
    latestTarget = null;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(backupsDir);
  } catch {
    return [];
  }

  const dailyFiles = entries
    .map((name) => {
      const m = DAILY_BACKUP_RE.exec(name);
      return m ? { name, dateKey: m[1] } : null;
    })
    .filter((item): item is { name: string; dateKey: string } => item !== null)
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey));

  const keepSet = new Set<string>(dailyFiles.slice(0, keepCount).map((f) => f.name));
  if (latestTarget) keepSet.add(latestTarget);

  const removed: string[] = [];
  for (const file of dailyFiles) {
    if (keepSet.has(file.name)) continue;
    await fs.rm(path.join(backupsDir, file.name), { force: true });
    removed.push(file.name);
  }
  return removed;
}

/**
 * 执行一次 SQLite 在线一致性热备（对齐 Spec 05 §4.1）：
 * 1. 按实例本地时区命名 psyber-YYYYMMDD.sqlite（绝不用 UTC toISOString()）；
 * 2. 参数化 VACUUM INTO 临时文件后原子 rename，防断电留下半截备份；
 * 3. 原子更新 psyber-latest.sqlite 软链并执行最近 7 份轮转；
 * 4. 内存单飞锁防重入，不阻塞前台并发读写。
 */
export async function performSqliteBackup(
  db: Database,
  dataDir: string,
  clock: Clock,
  opts: { keepDailyCount?: number } = {},
): Promise<string | null> {
  const lockKey = path.resolve(dataDir);
  if (backupInFlight.has(lockKey)) {
    return null;
  }
  backupInFlight.add(lockKey);

  const backupsDir = path.join(dataDir, "backups");
  const dateStr = localDay(clock.now(), clock.timeZone).replace(/-/g, "");
  const tmpFile = path.join(backupsDir, `psyber-${dateStr}.${crypto.randomUUID()}.sqlite.tmp`);
  const targetFile = path.join(backupsDir, `psyber-${dateStr}.sqlite`);
  const latestLink = path.join(backupsDir, "psyber-latest.sqlite");

  try {
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.rm(tmpFile, { force: true });

    db.run("VACUUM INTO ?", [tmpFile]);
    await fs.rename(tmpFile, targetFile);

    const tmpLink = path.join(backupsDir, `.psyber-latest.${crypto.randomUUID()}.tmp`);
    await fs.symlink(path.basename(targetFile), tmpLink);
    await fs.rename(tmpLink, latestLink);

    await rotateDailyBackups(backupsDir, opts.keepDailyCount ?? DEFAULT_KEEP_DAILY_COUNT);
    return targetFile;
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    backupInFlight.delete(lockKey);
  }
}
