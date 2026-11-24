import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BashToolConfig, PsyberConfig } from "../core/config.ts";
import type { ToolExecutionContext, ToolRegistry } from "../tools/registry.ts";

export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const MIN_BASH_TIMEOUT_MS = 1_000;
export const MAX_BASH_TIMEOUT_MS = 120_000;
export const DEFAULT_BASH_MAX_OUTPUT_CHARS = 8_000;
export const MAX_BASH_COMMAND_CHARS = 4_000;
const KILL_GRACE_MS = 2_000;

/** 严格只读、无副作用的免审命令白名单（仅在允许目录内且无管道/重定向/子命令时生效） */
const AUTO_READONLY_COMMANDS = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "date",
  "uname",
  "whoami",
  "which",
  "echo",
  "printf",
  "basename",
  "dirname",
  "realpath",
  "grep",
  "rg",
  "tree",
  "find",
  "git",
]);

const AUTO_READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "branch",
  "show",
  "rev-parse",
]);

/** 不可逆删除命令（遵循 Spec 03 §6.1「拦 rm 不拦删除」，引导改用 trash） */
const IRREVERSIBLE_DELETE_RE =
  /(?:^|[;&|(\n`])\s*(?:\/(?:usr\/)?bin\/|command\s+|env\s+)?(?:rm|unlink|shred|srm)\b/i;

/** 磁盘破坏 / 底层覆写命令 */
const DESTRUCTIVE_DISK_RE =
  /(?:^|[;&|(\n`])\s*(?:mkfs(?:\.[a-z0-9]+)?|dd|fdisk|wipefs|parted)\b|diskutil\s+erase|>\s*\/dev\/(?:sd|disk|nvme|rdisk)/i;

/** 提权 / 关机重启 / 凭据转储 */
const PRIVILEGE_OR_SYSTEM_RE =
  /(?:^|[;&|(\n`])\s*(?:sudo|su|doas|pkexec|shutdown|reboot|halt|poweroff)\b|launchctl\s+unload\b|security\s+(?:dump-keychain|find-generic-password|find-internet-password)\b/i;

/** 命令行绕路截屏拦截（Spec 03 §6.1） */
const SCREEN_CAPTURE_RE =
  /(?:^|[;&|(\n`])\s*(?:\/usr\/sbin\/)?(?:screencapture|scrot|grim|slurp|xwd)\b|ffmpeg\b[^\n]*(?:avfoundation|x11grab)|osascript\b[^\n]*screencapture/i;

/** find -delete 绕过删除拦截 */
const FIND_DELETE_RE = /\bfind\b[^\n]*\s-delete\b/i;

/** git clean -f 不可逆清理拦截 */
const GIT_CLEAN_FORCE_RE = /\bgit\s+clean\b[^\n]*-[a-z]*f/i;

/** 绝对禁止在命令文本中直接触碰的敏感文件名或目录片段 */
const SENSITIVE_LITERAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:^|[\s"'/=:])credentials\.json(?=$|[\s"'/:])/i, label: "credentials.json（密钥凭证）" },
  { re: /(?:^|[\s"'/=:])local_pair\.json(?=$|[\s"'/:])/i, label: "local_pair.json（本机配对密钥）" },
  { re: /(?:^|[\s"'/=:])psyber\.sqlite(?:-wal|-shm)?(?=$|[\s"'/:])/i, label: "psyber.sqlite（内部数据库）" },
  { re: /(?:^|[\s"'/=:])active_local_pair\.json(?=$|[\s"'/:])/i, label: "active_local_pair.json（本机配对指针）" },
  { re: /\.sealed(?=$|[\s"'/])/i, label: "上锁抽屉 .sealed 文件" },
  { re: /(?:^|[\s"'/=])rp\/runs(?:\/|$|[\s"'])/i, label: "RP 幕后账本区（rp/runs）" },
  { re: /\/etc\/(?:shadow|sudoers)(?:\/|$|[\s"'])/i, label: "系统敏感凭据文件" },
  { re: /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root)\/\.(?:ssh|gnupg|aws|kube|netrc)(?:\/|$|[\s"'])/i, label: "用户凭据目录" },
];

/** Shell 组合与重定向元字符（出现时不做免审白名单放行，统一走审批） */
const SHELL_META_RE = /[;&|`<>()\n]|\$\(/;

export interface BashAnalysisResult {
  decision: "block" | "auto" | "confirm";
  reason: string;
  isBuiltinTrash?: boolean;
  trashTargets?: string[];
}

export interface BashPolicy {
  dataDir: string;
  workspaceDir: string;
  allowedDirs: string[];
  protectedPaths: string[];
}

export function expandHomePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function clampBashTimeoutMs(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_BASH_TIMEOUT_MS;
  return Math.max(MIN_BASH_TIMEOUT_MS, Math.min(MAX_BASH_TIMEOUT_MS, Math.floor(raw)));
}

export function truncateBashOutput(text: string, maxChars = DEFAULT_BASH_MAX_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[命令输出已截断，原始长度 ${text.length} 字符]`;
}

/**
 * 构建脱敏后的子进程环境变量：剔除潜在 API Key / Token / Secret / Password 与 PSYBER_* 变量。
 */
export function buildSanitizedEnv(baseEnv: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const secretKeyRe = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE)/i;
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (k.startsWith("PSYBER_")) continue;
    if (secretKeyRe.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 简单且安全的 Shell 参数分词器（支持单引号、双引号与反斜杠转义）。
 * 若存在未闭合引号返回 null。
 */
export function tokenizeShellArgs(input: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let escaping = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (escaping) {
      cur += ch;
      escaping = false;
      hasToken = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        cur += ch;
      }
      hasToken = true;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inDouble = false;
      } else {
        cur += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      hasToken = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }

  if (inSingle || inDouble || escaping) return null;
  if (hasToken) tokens.push(cur);
  return tokens;
}

export function isPathInside(targetPath: string, rootPath: string): boolean {
  const rel = path.relative(rootPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 解析目标路径的真实物理路径（若末级尚未存在，回溯到最近存在的父目录做 realpath 拼接），
 * 防止通过符号链接绕过敏感目录或允许目录边界。
 */
export async function resolveRealPathSafe(absPath: string): Promise<string> {
  const normalized = path.resolve(absPath);
  try {
    return await fs.realpath(normalized);
  } catch {
    const missingParts: string[] = [];
    let cur = normalized;
    while (true) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        return normalized;
      }
      missingParts.unshift(path.basename(cur));
      cur = parent;
      try {
        const realBase = await fs.realpath(cur);
        return path.join(realBase, ...missingParts);
      } catch {
        // 继续向上找存在的父目录
      }
    }
  }
}

/**
 * 仅对父目录做 realpath 解析并保留末级名称（不解引用末级符号链接），
 * 用于删除/移动符号链接本身而非其指向的目标文件。
 */
export async function resolveSymlinkEntryPathSafe(absPath: string): Promise<string> {
  const normalized = path.resolve(absPath);
  const parent = path.dirname(normalized);
  if (parent === normalized) return normalized;
  const realParent = await resolveRealPathSafe(parent);
  return path.join(realParent, path.basename(normalized));
}

export async function buildBashPolicy(dataDir: string, cfg?: BashToolConfig): Promise<BashPolicy> {
  const realDataDir = await resolveRealPathSafe(dataDir);
  const workspaceDir = path.join(realDataDir, "workspace");
  const rawAllowed = [workspaceDir, ...(cfg?.allowedDirs ?? [])];
  const allowedDirs: string[] = [];
  for (const dir of rawAllowed) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    const resolved = await resolveRealPathSafe(expandHomePath(dir));
    if (!allowedDirs.includes(resolved)) {
      allowedDirs.push(resolved);
    }
  }

  const home = await resolveRealPathSafe(os.homedir());
  const protectedPaths = [
    path.join(realDataDir, "private"),
    path.join(realDataDir, "memory"),
    path.join(realDataDir, "rp", "runs"),
    path.join(realDataDir, "credentials.json"),
    path.join(realDataDir, "local_pair.json"),
    path.join(realDataDir, "config.json"),
    path.join(realDataDir, "psyber.sqlite"),
    path.join(realDataDir, "psyber.sqlite-wal"),
    path.join(realDataDir, "psyber.sqlite-shm"),
    path.join(realDataDir, "backups"),
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".kube"),
    path.join(home, ".netrc"),
    "/etc/shadow",
    "/etc/sudoers",
  ];

  return {
    dataDir: realDataDir,
    workspaceDir,
    allowedDirs,
    protectedPaths,
  };
}

export function findProtectedPathHit(absPath: string, policy: BashPolicy): string | null {
  for (const root of policy.protectedPaths) {
    if (isPathInside(absPath, root)) {
      return root;
    }
  }
  return null;
}

export function isInsideAllowedDirs(absPath: string, policy: BashPolicy): boolean {
  return policy.allowedDirs.some((root) => isPathInside(absPath, root));
}

function extractCandidatePathToken(token: string): string | null {
  if (!token) return null;
  if (token.startsWith("-")) {
    const eqIdx = token.indexOf("=");
    if (eqIdx > 0 && eqIdx < token.length - 1) {
      return token.slice(eqIdx + 1);
    }
    return null;
  }
  return token;
}

/**
 * 确定性静态安全分析（对齐 Spec 03 §6.1）：
 * 1. 先检查所有硬拦截规则（不可逆删除 rm、截屏绕路、提权、敏感路径）——永不放行；
 * 2. 若是纯内置 `trash <paths...>`：允许目录内免审（auto），允许目录外走审批（confirm）；
 * 3. 若是无元字符的严格只读命令且路径均在允许目录内：免审（auto）；
 * 4. 其余合法命令统一走同步审批（confirm）。
 */
export async function analyzeBashCommand(
  rawCommand: string,
  resolvedCwd: string,
  policy: BashPolicy,
): Promise<BashAnalysisResult> {
  const command = rawCommand.trim();
  if (!command) {
    return { decision: "block", reason: "bash 命令不能为空。" };
  }
  if (command.length > MAX_BASH_COMMAND_CHARS) {
    return {
      decision: "block",
      reason: `bash 命令过长（超过 ${MAX_BASH_COMMAND_CHARS} 字符上限），请拆分为更简短的步骤。`,
    };
  }

  // 1. 敏感 cwd 硬拦截
  const cwdProtected = findProtectedPathHit(resolvedCwd, policy);
  if (cwdProtected) {
    return {
      decision: "block",
      reason: `工作目录命中受保护敏感路径（${path.basename(cwdProtected)}），已拦截。记忆仓请使用原生 5 记忆工具，私密抽屉请使用 drawer_read/drawer_write。`,
    };
  }

  // 2. 不可逆删除拦截（拦 rm 不拦删除）
  if (IRREVERSIBLE_DELETE_RE.test(command) || FIND_DELETE_RE.test(command) || GIT_CLEAN_FORCE_RE.test(command)) {
    return {
      decision: "block",
      reason:
        "已拦截不可逆删除命令（rm / unlink / shred / find -delete / git clean -f）。Psyber 遵循「拦 rm 不拦删除」原则：如需删除文件或文件夹，请改用 `trash <路径>`（移入系统废纸篓，100% 可逆且在允许目录内免审批）。",
    };
  }

  // 3. 磁盘破坏与提权拦截
  if (DESTRUCTIVE_DISK_RE.test(command)) {
    return { decision: "block", reason: "已拦截高危磁盘或设备覆写命令（mkfs / dd / diskutil erase 等）。" };
  }
  if (PRIVILEGE_OR_SYSTEM_RE.test(command)) {
    return { decision: "block", reason: "已拦截提权、关机或系统钥匙串转储命令。" };
  }

  // 4. 严禁命令行绕路截屏（Spec 03 §6.1）
  if (SCREEN_CAPTURE_RE.test(command)) {
    return {
      decision: "block",
      reason: "已拦截命令行截屏绕路操作（screencapture 等）。如需查看屏幕，必须使用显式授权并留账的 look_at_screen 工具。",
    };
  }

  // 5. 命令文本敏感路径字面量拦截
  for (const item of SENSITIVE_LITERAL_PATTERNS) {
    if (item.re.test(command)) {
      return {
        decision: "block",
        reason: `已拦截对受保护敏感目标的访问：${item.label}。`,
      };
    }
  }

  // 检查命令中出现的路径参数是否命中受保护目录（含绝对路径、~/、相对路径、裸文件名及 --flag=path 形式）
  const rawTokens = tokenizeShellArgs(command);
  const hasMeta = SHELL_META_RE.test(command);
  const isTrashCmd = !hasMeta && Boolean(rawTokens && rawTokens[0] === "trash");
  if (rawTokens && !isTrashCmd) {
    for (let i = 1; i < rawTokens.length; i += 1) {
      const candidate = extractCandidatePathToken(rawTokens[i]!);
      if (!candidate) continue;
      const expanded = expandHomePath(candidate);
      const absCandidate = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(resolvedCwd, expanded);
      const realCandidate = await resolveRealPathSafe(absCandidate);
      const hit = findProtectedPathHit(realCandidate, policy);
      if (hit) {
        return {
          decision: "block",
          reason: `已拦截对受保护目录的访问（${path.basename(hit)}）。记忆仓请使用原生 5 记忆工具，私密抽屉请使用 drawer_read/drawer_write。`,
        };
      }
    }
  }

  // 6. 内置废纸篓可逆删除：`trash <path...>`（若目标为符号链接，仅移走符号链接本身，绝不误删指向的目标文件）
  if (isTrashCmd && rawTokens) {
    const targets: string[] = [];
    let endOfFlags = false;
    for (let i = 1; i < rawTokens.length; i += 1) {
      const tok = rawTokens[i]!;
      if (!endOfFlags && tok === "--") {
        endOfFlags = true;
        continue;
      }
      if (!endOfFlags && tok.startsWith("-")) {
        continue;
      }
      targets.push(tok);
    }
    if (targets.length === 0) {
      return { decision: "block", reason: "trash 缺少目标路径，用法：trash <文件或目录路径>" };
    }

    const homeDir = await resolveRealPathSafe(os.homedir());
    const resolvedTargets: string[] = [];
    let allInsideAllowed = true;

    for (const rawTarget of targets) {
      const expanded = expandHomePath(rawTarget);
      const absTarget = path.isAbsolute(expanded)
        ? path.resolve(expanded)
        : path.resolve(resolvedCwd, expanded);
      const entryTarget = await resolveSymlinkEntryPathSafe(absTarget);

      if (entryTarget === "/" || entryTarget === homeDir || entryTarget === policy.dataDir) {
        return { decision: "block", reason: `禁止将根目录、主目录或实例数据目录移入废纸篓：${rawTarget}` };
      }
      const hit = findProtectedPathHit(entryTarget, policy);
      if (hit) {
        return {
          decision: "block",
          reason: `禁止删除受保护敏感路径（${path.basename(hit)}）：${rawTarget}`,
        };
      }
      if (!isInsideAllowedDirs(entryTarget, policy)) {
        allInsideAllowed = false;
      }
      resolvedTargets.push(entryTarget);
    }

    return {
      decision: allInsideAllowed ? "auto" : "confirm",
      reason: allInsideAllowed
        ? "允许目录内的可逆废纸篓删除（免审）"
        : `将允许目录外的文件移入系统废纸篓：${targets.join(", ")}`,
      isBuiltinTrash: true,
      trashTargets: resolvedTargets,
    };
  }

  // 7. 允许目录内的严格只读无元字符命令免审放行
  if (!hasMeta && rawTokens && rawTokens.length > 0 && isInsideAllowedDirs(resolvedCwd, policy)) {
    const bin = path.basename(rawTokens[0]!);
    if (AUTO_READONLY_COMMANDS.has(bin)) {
      let safeArgs = true;
      if (bin === "git") {
        const sub = rawTokens[1] ?? "";
        if (!AUTO_READONLY_GIT_SUBCOMMANDS.has(sub)) {
          safeArgs = false;
        }
        const dangerousGitFlags = ["--output", "--ext-diff", "--git-dir", "--work-tree", "-c"];
        if (
          rawTokens.some((t) =>
            dangerousGitFlags.some((f) => t === f || t.startsWith(`${f}=`)),
          )
        ) {
          safeArgs = false;
        }
      }
      if (bin === "rg") {
        if (
          rawTokens.some(
            (t) => t === "--pre" || t.startsWith("--pre=") || t === "--pre-glob" || t.startsWith("--pre-glob="),
          )
        ) {
          safeArgs = false;
        }
      }
      if (bin === "find") {
        const dangerousFindFlags = new Set([
          "-exec",
          "-execdir",
          "-ok",
          "-okdir",
          "-delete",
          "-fprint",
          "-fprint0",
          "-fprintf",
          "-fls",
        ]);
        if (rawTokens.some((t) => dangerousFindFlags.has(t))) {
          safeArgs = false;
        }
      }
      if (safeArgs) {
        for (let i = 1; i < rawTokens.length; i += 1) {
          const candidate = extractCandidatePathToken(rawTokens[i]!);
          if (!candidate) continue;
          const expanded = expandHomePath(candidate);
          const absCandidate = path.isAbsolute(expanded)
            ? path.resolve(expanded)
            : path.resolve(resolvedCwd, expanded);
          const realCandidate = await resolveRealPathSafe(absCandidate);
          if (!isInsideAllowedDirs(realCandidate, policy)) {
            safeArgs = false;
            break;
          }
        }
      }
      if (safeArgs) {
        return { decision: "auto", reason: "允许目录内的安全只读命令（免审）" };
      }
    }
  }

  // 8. 其余命令均升级为同步确认审批
  return {
    decision: "confirm",
    reason: `执行本机命令：${command.length > 120 ? `${command.slice(0, 120)}…` : command}`,
  };
}

export function resolveDefaultTrashDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".Trash");
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, "Trash", "files");
}

/**
 * 将目标文件或目录原子移入系统废纸篓（防重名覆盖，跨分区自动降级复制后移除）。
 */
export async function movePathsToTrash(
  targets: string[],
  trashDir = resolveDefaultTrashDir(),
): Promise<Array<{ from: string; to: string }>> {
  await fs.mkdir(trashDir, { recursive: true });
  const moved: Array<{ from: string; to: string }> = [];

  for (const target of targets) {
    // 校验目标存在
    await fs.lstat(target);
    const base = path.basename(target);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;

    let dest = path.join(trashDir, base);
    try {
      await fs.lstat(dest);
      // 废纸篓中已存在同名项，附加唯一后缀避免覆盖
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      dest = path.join(trashDir, `${stem}-${suffix}${ext}`);
    } catch {
      // 目标名在废纸篓中尚不存在，直接使用
    }

    try {
      await fs.rename(target, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        await fs.cp(target, dest, { recursive: true, force: false, errorOnExist: true });
        await fs.rm(target, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
    moved.push({ from: target, to: dest });
  }

  return moved;
}

async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  maxBytes: number,
  cancelSignal?: AbortSignal,
): Promise<{ text: string; totalBytes: number }> {
  if (!stream || typeof stream === "number") return { text: "", totalBytes: 0 };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  const onCancel = () => {
    void reader.cancel().catch(() => {});
  };
  if (cancelSignal?.aborted) {
    onCancel();
  } else {
    cancelSignal?.addEventListener("abort", onCancel, { once: true });
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (totalBytes < maxBytes) {
        const remain = maxBytes - totalBytes;
        const chunk = value.byteLength <= remain ? value : value.subarray(0, remain);
        text += decoder.decode(chunk, { stream: true });
      }
      totalBytes += value.byteLength;
    }
    text += decoder.decode();
  } catch {
    // 进程中止或取消读取时静默收尾
  } finally {
    cancelSignal?.removeEventListener("abort", onCancel);
    reader.releaseLock();
  }
  return { text, totalBytes };
}

async function runShellCommand(opts: {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["bash", "-c", opts.command], {
    cwd: opts.cwd,
    env: buildSanitizedEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const streamCancelAc = new AbortController();

  const terminateProc = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      streamCancelAc.abort();
    }, KILL_GRACE_MS);
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminateProc();
  }, opts.timeoutMs);

  const onAbort = () => {
    aborted = true;
    terminateProc();
  };
  if (opts.signal?.aborted) {
    onAbort();
  } else {
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  }

  const maxCaptureBytes = Math.max(opts.maxOutputChars * 4, 32_768);
  const stdoutPromise = readStreamCapped(proc.stdout, maxCaptureBytes, streamCancelAc.signal);
  const stderrPromise = readStreamCapped(proc.stderr, maxCaptureBytes, streamCancelAc.signal);
  const exitCode = await proc.exited;
  if (timedOut || aborted) {
    // 若超时/中止后有孙进程仍占着管道，主动取消流读取防止永久挂起
    streamCancelAc.abort();
  }
  const [stdoutRes, stderrRes] = await Promise.all([stdoutPromise, stderrPromise]);

  clearTimeout(timeoutTimer);
  if (killTimer !== null) clearTimeout(killTimer);
  opts.signal?.removeEventListener("abort", onAbort);

  const parts: string[] = [];
  if (stdoutRes.text.trimEnd()) {
    parts.push(stdoutRes.text.trimEnd());
  }
  if (stderrRes.text.trimEnd()) {
    parts.push(`[stderr]\n${stderrRes.text.trimEnd()}`);
  }
  const combined = parts.join("\n").trim();

  if (aborted) {
    return { ok: false, output: "命令执行已被中止。" };
  }
  if (timedOut) {
    const partial = combined ? `\n${truncateBashOutput(combined, opts.maxOutputChars)}` : "";
    return { ok: false, output: `命令执行超时（超过 ${opts.timeoutMs}ms 已终止）。${partial}` };
  }

  const truncated = truncateBashOutput(combined || "(无输出)", opts.maxOutputChars);
  if (exitCode !== 0) {
    return { ok: false, output: `[exit ${exitCode}]\n${truncated}` };
  }
  return { ok: true, output: truncated };
}

export interface RegisterBashToolDeps {
  dataDir: string;
  getConfig: () => PsyberConfig;
  /** 可注入废纸篓目录，供离线测试隔离避免触碰系统真实废纸篓 */
  trashDir?: string;
}

/**
 * 注册内置 Tier 3 `bash` 工具（对齐 Spec 03 §6.1）：
 * - 固定注册为 Tier 3，不污染 Tier 1 Static Prefix Cache，可在设置页独立开关；
 * - 硬拦截不可逆删除（rm/unlink/shred）、绕路截屏（screencapture）、提权与敏感目录（memory/private/credentials）；
 * - 内置 `trash <路径>` 移入系统废纸篓，允许目录内免审可逆；
 * - 允许目录内严格只读命令免审，其余命令或越界操作经同步审批卡（confirm）放行。
 */
export function registerBashTool(registry: ToolRegistry, deps: RegisterBashToolDeps): void {
  const { dataDir, getConfig, trashDir } = deps;

  const resolveWorkingContext = async (args: Record<string, unknown>) => {
    const cfg = getConfig().bash;
    const policy = await buildBashPolicy(dataDir, cfg);
    await fs.mkdir(policy.workspaceDir, { recursive: true });

    const rawCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : null;
    const resolvedCwd = rawCwd
      ? await resolveRealPathSafe(
          path.isAbsolute(expandHomePath(rawCwd))
            ? expandHomePath(rawCwd)
            : path.resolve(policy.workspaceDir, expandHomePath(rawCwd)),
        )
      : policy.workspaceDir;

    return { cfg, policy, resolvedCwd };
  };

  registry.register({
    name: "bash",
    tier: 3,
    security: "guarded",
    description:
      "在本机受控环境中执行 Shell 命令。遵循「拦 rm 不拦删除」原则：严禁 rm/unlink/shred 等不可逆删除，删除文件请改用内置 `trash <路径>`（移入系统废纸篓，100% 可逆）。允许目录内的只读查询与 `trash` 免审批，其余修改或越界命令需经用户确认审批。",
    tags: ["bash", "shell", "command", "system", "trash", "本机", "命令", "废纸篓"],
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的命令（删除文件请使用 `trash <路径>` 而非 `rm`）",
        },
        cwd: {
          type: "string",
          description: "可选：工作目录路径（支持 ~/），默认位于实例专属 workspace/ 目录",
        },
        timeoutMs: {
          type: "integer",
          description: "可选：单次命令超时毫秒数（1000–120000，默认 30000）",
        },
      },
      required: ["command"],
    },
    guard: async (args) => {
      const command = typeof args.command === "string" ? args.command : "";
      const { policy, resolvedCwd } = await resolveWorkingContext(args);
      const analysis = await analyzeBashCommand(command, resolvedCwd, policy);
      if (analysis.decision === "block") {
        return { ok: false, reason: analysis.reason };
      }
      return { ok: true };
    },
    execute: async (args, ctx: ToolExecutionContext) => {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const { cfg, policy, resolvedCwd } = await resolveWorkingContext(args);
      const analysis = await analyzeBashCommand(command, resolvedCwd, policy);

      if (analysis.decision === "block") {
        return { ok: false, output: analysis.reason };
      }

      if (analysis.decision === "confirm") {
        if (!ctx.requestApproval) {
          return {
            ok: false,
            output: `命令 "${command}" 需要用户确认审批，当前非交互轮次已保守拦截`,
          };
        }
        const approval = await ctx.requestApproval({
          turnId: ctx.turnId,
          toolName: "bash",
          summary: analysis.reason,
          arguments: { command, cwd: resolvedCwd },
        });
        if (approval.decision !== "allow") {
          return {
            ok: false,
            output: approval.reason || "用户拒绝了本次 bash 命令执行",
          };
        }
      }

      // 内置可逆废纸篓处理
      if (analysis.isBuiltinTrash && analysis.trashTargets) {
        try {
          const moved = await movePathsToTrash(analysis.trashTargets, trashDir);
          const lines = moved.map((m) => `- ${m.from} -> 废纸篓 (${path.basename(m.to)})`);
          return {
            ok: true,
            output: `已移入系统废纸篓（可随时还原）：\n${lines.join("\n")}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, output: `移入废纸篓失败：${msg}` };
        }
      }

      // 校验 cwd 存在且为目录
      try {
        const st = await fs.stat(resolvedCwd);
        if (!st.isDirectory()) {
          return { ok: false, output: `工作目录不是文件夹：${resolvedCwd}` };
        }
      } catch {
        return { ok: false, output: `工作目录不存在：${resolvedCwd}` };
      }

      const timeoutMs = clampBashTimeoutMs(
        typeof args.timeoutMs === "number" ? args.timeoutMs : cfg?.timeoutMs,
      );
      const maxOutputChars =
        typeof cfg?.maxOutputChars === "number" && Number.isFinite(cfg.maxOutputChars) && cfg.maxOutputChars >= 256
          ? Math.floor(cfg.maxOutputChars)
          : DEFAULT_BASH_MAX_OUTPUT_CHARS;

      return runShellCommand({
        command,
        cwd: resolvedCwd,
        timeoutMs,
        maxOutputChars,
        signal: ctx.signal,
      });
    },
  });
}
