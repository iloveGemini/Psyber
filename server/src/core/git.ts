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

const SAFE_COMMIT_REF_RE = /^(?:[0-9a-fA-F]{4,40}|HEAD(?:~\d{1,3})?)$/;

/** 规范化并校验记忆历史查询路径，严禁访问 .git / .. / memory/ 外路径 */
export function normalizeMemoryHistoryPath(
  raw: unknown,
): { ok: true; relPath?: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") {
    return { ok: false, reason: "path 必须为字符串。" };
  }
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed) return { ok: true };
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    return { ok: false, reason: "path 包含非法控制字符。" };
  }
  if (trimmed.startsWith("-") || trimmed.startsWith("/") || trimmed.startsWith("~")) {
    return { ok: false, reason: `path 必须是 memory/ 内的相对路径：${raw}` };
  }

  const normalized = path.posix.normalize(trimmed).replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return { ok: false, reason: `禁止访问 memory/ 之外的路径：${raw}` };
  }
  const segments = normalized.split("/");
  if (segments.some((seg) => seg === ".git" || seg === "..")) {
    return { ok: false, reason: `禁止直接访问受保护路径：${raw}` };
  }
  return { ok: true, relPath: normalized };
}

/** 校验只读 git show 使用的提交引用（仅允许 4-40 位十六进制哈希或 HEAD / HEAD~N） */
export function validateCommitRef(raw: unknown): { ok: true; commit: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "action=show 时必须提供 commit（如短哈希或 HEAD / HEAD~1）。" };
  }
  const trimmed = raw.trim();
  if (!SAFE_COMMIT_REF_RE.test(trimmed)) {
    return { ok: false, reason: `非法的提交标识：${trimmed}（仅支持 4-40 位十六进制哈希或 HEAD / HEAD~N）。` };
  }
  return { ok: true, commit: trimmed };
}

/** 校验只读 git log 使用的 --since 参数，防止参数注入 */
export function validateSinceFilter(
  raw: unknown,
): { ok: true; since?: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") {
    return { ok: false, reason: "since 必须为字符串。" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  if (trimmed.length > 64 || trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed)) {
    return { ok: false, reason: `非法的 since 时间过滤参数：${trimmed}` };
  }
  return { ok: true, since: trimmed };
}

/** 只读查询 memory/.git 提交历史（用于 memory_history 工具回溯记忆演变） */
export async function readMemoryGitLog(
  dataDir: string,
  opts: { relPath?: string; limit?: number; since?: string } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const memoryDir = path.join(dataDir, "memory");
  const head = await getMemoryHeadCommit(dataDir);
  if (!head) {
    return { ok: true, stdout: "" };
  }
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 10)));
  const args = [
    "-c",
    "core.quotepath=false",
    "log",
    "-n",
    String(limit),
    "--date=iso-strict",
    "--stat",
    "--format=commit %h | %ad | %s",
  ];
  if (opts.since) {
    args.push(`--since=${opts.since}`);
  }
  if (opts.relPath) {
    args.push("--", opts.relPath);
  }
  const res = await runGit(memoryDir, args);
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || `git log failed (code=${res.code})` };
  }
  return { ok: true, stdout: res.stdout.trim() };
}

/** 只读查看 memory/.git 单次提交的变更详情（commit + diff） */
export async function readMemoryGitShow(
  dataDir: string,
  commitRef: string,
  opts: { relPath?: string } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const memoryDir = path.join(dataDir, "memory");
  const head = await getMemoryHeadCommit(dataDir);
  if (!head) {
    return { ok: false, error: "记忆仓目前还没有任何提交记录。" };
  }
  const verify = await runGit(memoryDir, ["cat-file", "-e", `${commitRef}^{commit}`]);
  if (verify.code !== 0) {
    return { ok: false, error: `未找到对应的记忆提交记录：${commitRef}` };
  }
  const args = [
    "-c",
    "core.quotepath=false",
    "show",
    "--date=iso-strict",
    "--stat",
    "--patch",
    "--format=commit %h | %ad | %s",
    commitRef,
  ];
  if (opts.relPath) {
    args.push("--", opts.relPath);
  }
  const res = await runGit(memoryDir, args);
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || `git show failed (code=${res.code})` };
  }
  return { ok: true, stdout: res.stdout.trim() };
}
