import fs from "node:fs/promises";
import path from "node:path";

async function runGit(memoryDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: memoryDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** 检测当前系统是否存在存活的 git 进程，防止在 git 运行中误删 index.lock */
async function hasLiveGitProcess(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pgrep", "-x", "git"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    // 某些精简环境无 pgrep 时保守视为无存活进程
    return false;
  }
}

/** 初始化 memory/.git 仓库并配置开源匿名作者，确保卡片改动可回溯 */
export async function initMemoryGitRepo(dataDir: string): Promise<void> {
  const memoryDir = path.join(dataDir, "memory");
  const gitDir = path.join(memoryDir, ".git");
  try {
    await fs.access(gitDir);
  } catch {
    const init = await runGit(memoryDir, ["init"]);
    if (init.code !== 0) {
      throw new Error(`git init failed: ${init.stderr}`);
    }
    await runGit(memoryDir, ["config", "user.name", "Psyber Resident"]);
    await runGit(memoryDir, ["config", "user.email", "resident@psyber.local"]);
  }
}

/** 启动自愈：清理 .tmp 残留，并在确认无存活 git 进程后清理孤儿 index.lock */
export async function cleanupTransientLocks(dataDir: string): Promise<void> {
  const tmpDir = path.join(dataDir, ".tmp");
  try {
    const entries = await fs.readdir(tmpDir);
    for (const entry of entries) {
      await fs.rm(path.join(tmpDir, entry), { force: true, recursive: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const indexLock = path.join(dataDir, "memory", ".git", "index.lock");
  try {
    await fs.access(indexLock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  if (await hasLiveGitProcess()) {
    throw new Error(`检测到活跃 git 进程，已拒绝清理 ${indexLock}`);
  }
  await fs.unlink(indexLock);
}

/**
 * 精准提交指定相对路径：严禁 git add -A，防止误收用户未跟踪杂文件。
 * 若暂存区无实质差异则跳过提交返回 false。
 */
export async function commitMemoryPaths(
  dataDir: string,
  relPaths: string[],
  message: string,
): Promise<boolean> {
  if (relPaths.length === 0) return false;
  const memoryDir = path.join(dataDir, "memory");

  const add = await runGit(memoryDir, ["add", "--", ...relPaths]);
  if (add.code !== 0) {
    throw new Error(`git add failed: ${add.stderr}`);
  }

  const diff = await runGit(memoryDir, ["diff", "--cached", "--quiet"]);
  if (diff.code === 0) {
    return false;
  }

  const commit = await runGit(memoryDir, ["commit", "-m", message]);
  if (commit.code !== 0) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }
  return true;
}

/**
 * 启动崩溃自愈（对齐 Spec 02 §5.3 & Spec 05 §5.2）：
 * 仅暂存已跟踪（严格排除 ?? 未跟踪文件）且位于写白名单内的脏卡片并执行安全兜底提交。
 */
export async function recoverUncommittedTrackedCards(
  dataDir: string,
  isAllowedWritePath: (relPath: string) => boolean,
): Promise<boolean> {
  const memoryDir = path.join(dataDir, "memory");
  const status = await runGit(memoryDir, ["status", "--porcelain"]);
  if (status.code !== 0 || !status.stdout.trim()) return false;

  const trackedDirty: string[] = [];
  for (const rawLine of status.stdout.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const xy = rawLine.slice(0, 2);
    if (xy === "??") continue; // 严禁误收未跟踪文件
    const rel = rawLine.slice(3).trim().replace(/^"|"$/g, "");
    if (isAllowedWritePath(rel)) {
      trackedDirty.push(rel);
    }
  }

  if (trackedDirty.length === 0) return false;
  return commitMemoryPaths(
    dataDir,
    trackedDirty,
    "recovery(memory): preserve uncommitted changes on startup",
  );
}

/** 获取 memory/.git 当前 HEAD commit hash；尚未有任何提交时返回 null */
export async function getMemoryHeadCommit(dataDir: string): Promise<string | null> {
  const memoryDir = path.join(dataDir, "memory");
  const res = await runGit(memoryDir, ["rev-parse", "--verify", "HEAD"]);
  if (res.code !== 0) return null;
  const hash = res.stdout.trim();
  return hash.length > 0 ? hash : null;
}

/**
 * 列出自 sinceCommit 以来在 memory/ 中发生变更（新增/修改/重命名/删除）的相对路径。
 * - 若 sinceCommit 为 null 或仓库中不存在该提交，则退化为列出当前已跟踪的全部文件（git ls-files）。
 * - 若 sinceCommit === HEAD，直接返回空数组。
 */
export async function listChangedMemoryPathsSince(
  dataDir: string,
  sinceCommit: string | null,
): Promise<string[]> {
  const memoryDir = path.join(dataDir, "memory");
  const head = await getMemoryHeadCommit(dataDir);
  if (!head) return [];

  if (sinceCommit && sinceCommit === head) {
    return [];
  }

  if (sinceCommit) {
    const verify = await runGit(memoryDir, ["cat-file", "-e", `${sinceCommit}^{commit}`]);
    if (verify.code === 0) {
      const diff = await runGit(memoryDir, [
        "-c",
        "core.quotepath=false",
        "diff",
        "--name-only",
        `${sinceCommit}..HEAD`,
      ]);
      if (diff.code === 0) {
        return diff.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
  }

  const ls = await runGit(memoryDir, ["-c", "core.quotepath=false", "ls-files"]);
  if (ls.code !== 0) return [];
  return ls.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
