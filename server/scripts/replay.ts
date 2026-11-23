#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VirtualClock, localDay, localWeekday } from "../src/core/clock.ts";
import {
  atomicWriteFile,
  initDataDir,
  loadOrCreateConfig,
  saveConfig,
} from "../src/core/config.ts";
import { loadCredentials } from "../src/core/credentials.ts";
import { openDatabase, runMigrations } from "../src/core/db.ts";
import {
  cleanupTransientLocks,
  commitMemoryPaths,
  initMemoryGitRepo,
} from "../src/core/git.ts";
import { MediaStore } from "../src/core/media.ts";
import { ulid } from "../src/core/ulid.ts";
import { maybeRunReflectAfterBedtime } from "../src/engine/reflect.ts";
import { runMemoryTidyTask } from "../src/engine/tidy.ts";
import type { ChatModelClient, ChatStreamChunk } from "../src/llm/client.ts";
import { DynamicDecisionClient } from "../src/llm/decision.ts";
import { DynamicChatModel, resolveByokSlot } from "../src/llm/router.ts";
import { applyGenesisMemory } from "../src/memory/genesis.ts";
import { MemoryIndex } from "../src/memory/index.ts";
import { MemoryTools } from "../src/memory/tools.ts";
import { EventStore } from "../src/store/events.ts";

const DEFAULT_PROMPTS_DIR = path.resolve(import.meta.dir, "../../prompts");
const STATE_FILENAME = "replay_state.json";

type SourceFormat = "auto" | "jsonl" | "psyche";

interface NormalizedAttachment {
  kind: "file" | "psyche_material";
  /** kind === "file" 时的绝对路径 */
  filePath?: string;
  /** kind === "psyche_material" 时的 material 哈希 */
  materialHash?: string;
  mime?: string;
}

interface NormalizedMessage {
  id: string;
  at: number;
  day: string;
  role: "user" | "assistant";
  text: string;
  session?: string;
  source: string;
  attachments: NormalizedAttachment[];
}

interface PsycheSourceRow {
  id: string;
  at: number;
  day: string;
  kind: "message.in" | "message.out";
  source: string;
  payload: string;
}

interface DaySummary {
  day: string;
  msgIn: number;
  msgOut: number;
  attachments: number;
  chars: number;
}

interface ReplayDayResult {
  day: string;
  importedAt: string;
  importedEvents: number;
  importedAttachments: number;
  tidiedAt?: string;
  processedEvents?: number;
  touchedMemoryPaths?: string[];
  summary?: string;
}

interface ReplayState {
  version: 1;
  sourcePath: string;
  importedDays: string[];
  tidiedDays: string[];
  results: Record<string, ReplayDayResult>;
}

interface CliOptions {
  dataDir: string;
  sourcePath: string;
  format: SourceFormat;
  promptsDir: string;
  tz: string;
  userName: string;
  userPronoun: string;
  residentName: string;
  sourceUser: string;
  fonds: string;
  status: boolean;
  init: boolean;
  reset: boolean;
  importOnly: boolean;
  tidyOnly: boolean;
  mock: boolean;
  all: boolean;
  allowAppend: boolean;
  hasExplicitStep: boolean;
  days: number;
  until: string | null;
  help: boolean;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

function inferMimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".heic") return "image/heic";
  return "application/octet-stream";
}

function parseTimestamp(raw: unknown, lineNum: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // 兼容秒级与毫秒级 Unix 时间戳
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const ms = Date.parse(raw.trim());
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(`第 ${lineNum} 行缺少合法的时间戳字段 at（需 ISO 8601 字符串或 Unix 毫秒数）`);
}

function resolveFormat(sourcePath: string, explicit: SourceFormat): "jsonl" | "psyche" {
  if (explicit === "jsonl" || explicit === "psyche") return explicit;
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".db" || ext === ".sqlite" || ext === ".sqlite3") return "psyche";
  return "jsonl";
}

function parseArgs(argv: string[]): CliOptions {
  const envSource = process.env.PSYBER_REPLAY_SOURCE?.trim() ?? "";
  const opts: CliOptions = {
    dataDir: expandHome(process.env.PSYBER_DATA_DIR || "~/.psyber/test"),
    sourcePath: envSource ? expandHome(envSource) : "",
    format: "auto",
    promptsDir: DEFAULT_PROMPTS_DIR,
    tz: "Asia/Shanghai",
    userName: "",
    userPronoun: "",
    residentName: "",
    sourceUser: "",
    fonds: "",
    status: false,
    init: false,
    reset: false,
    importOnly: false,
    tidyOnly: false,
    mock: false,
    all: false,
    allowAppend: false,
    hasExplicitStep: false,
    days: 1,
    until: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--status") opts.status = true;
    else if (a === "--init") opts.init = true;
    else if (a === "--reset") opts.reset = true;
    else if (a === "--import-only") {
      opts.importOnly = true;
      opts.hasExplicitStep = true;
    } else if (a === "--tidy-only") {
      opts.tidyOnly = true;
      opts.hasExplicitStep = true;
    } else if (a === "--mock") opts.mock = true;
    else if (a === "--all") {
      opts.all = true;
      opts.hasExplicitStep = true;
    } else if (a === "--allow-append") opts.allowAppend = true;
    else if (a === "--data-dir") opts.dataDir = expandHome(argv[++i] ?? "");
    else if (a === "--source") opts.sourcePath = expandHome(argv[++i] ?? "");
    else if (a === "--format") {
      const f = (argv[++i] ?? "").toLowerCase();
      if (f !== "auto" && f !== "jsonl" && f !== "psyche") {
        throw new Error(`--format 须为 auto | jsonl | psyche，收到: ${f}`);
      }
      opts.format = f;
    } else if (a === "--prompts-dir") opts.promptsDir = expandHome(argv[++i] ?? "");
    else if (a === "--tz") opts.tz = argv[++i] ?? "Asia/Shanghai";
    else if (a === "--user-name") opts.userName = argv[++i] ?? "";
    else if (a === "--user-pronoun") opts.userPronoun = argv[++i] ?? "";
    else if (a === "--resident-name") opts.residentName = argv[++i] ?? "";
    else if (a === "--source-user") opts.sourceUser = argv[++i] ?? "";
    else if (a === "--fonds") opts.fonds = argv[++i] ?? "";
    else if (a === "--days") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--days 必须是正整数，收到: ${argv[i]}`);
      opts.days = n;
      opts.hasExplicitStep = true;
    } else if (a === "--until") {
      const d = argv[++i] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`--until 格式须为 YYYY-MM-DD，收到: ${d}`);
      opts.until = d;
      opts.hasExplicitStep = true;
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }

  if (!opts.sourceUser && opts.userName) {
    opts.sourceUser = opts.userName;
  }
  if (!opts.fonds && opts.sourcePath) {
    const ext = path.extname(opts.sourcePath);
    const stem = path.basename(opts.sourcePath, ext) || "import";
    opts.fonds = stem.replace(/[^a-zA-Z0-9_-]/g, "-");
  }
  return opts;
}

function printHelp(): void {
  console.log(`
Psyber 历史对话导入与按天回放脚本（支持标准 JSONL 导入与断点续跑）

用法:
  cd server && bun run replay -- --source <import.jsonl> [选项]

标准导入格式（JSONL，每行一条消息）:
  {"at":"2026-10-11T23:34:00+08:00","role":"user","text":"睡前聊到我睡着"}
  {"at":"2026-10-11T23:34:25+08:00","role":"assistant","text":"好呀，先讲个冷知识。"}
  {"id":"m-3","at":"2026-10-12T00:18:10+08:00","role":"user","text":"看照片","session":"s1","attachments":["./media/cat.jpg"]}

  必填字段: at (ISO 8601 或 Unix 毫秒), role ("user"|"assistant"), text (字符串)
  可选字段: id (幂等去重), session (会话分组), source (源平台标记), attachments (相对/绝对图片路径数组)

常用流程:
  1. 查看源数据各天概况与当前进度:
     bun run replay -- --source /path/to/import.jsonl --status

  2. 初始化目标目录（写入初始 core/self.md、core/user.md，保留已有模型配置与密钥）:
     bun run replay -- --source /path/to/import.jsonl --data-dir ~/.psyber/test --user-name 小夏 --user-pronoun 她 --init

  3. 零成本 --mock 干跑 2 天验证全链路（导入 + 附件 + 整理 + Git 提交）:
     bun run replay -- --source /path/to/import.jsonl --mock --days 2

  4. 改完提示词或代码后，重置测试库（保留 LLM 配置与 API Key）重新开始:
     bun run replay -- --source /path/to/import.jsonl --reset

  5. 用真实模型逐天推进（默认每次跑 1 天，成功才记断点，失败可原地续跑）:
     bun run replay -- --source /path/to/import.jsonl --days 1
     bun run replay -- --source /path/to/import.jsonl --until 2026-10-18
     bun run replay -- --source /path/to/import.jsonl --all

选项:
  --source <path>        必填（或设 PSYBER_REPLAY_SOURCE）：标准 .jsonl 文件路径（也兼容旧 Psyche .db）
  --format <fmt>         auto（默认，按后缀识别）| jsonl | psyche
  --data-dir <path>      目标 Psyber 数据目录（默认 ~/.psyber/test，禁止指向 ~/.psyber/default）
  --status               仅查看各活跃日进度与统计
  --init                 初始化目录、SQLite、memory/.git 与初始 core/self.md、core/user.md
  --reset                清空目标目录的数据库/记忆/媒体/回放状态并重新初始化（保留 config.json 与 credentials.json）
  --days <N>             本次最多推进 N 天（默认 1）
  --until <YYYY-MM-DD>   推进到指定日期为止（含）
  --all                  推进全部剩余日期
  --import-only          仅导入原始对话与附件到 SQLite/media，不跑整理模型
  --tidy-only            仅对「已导入但尚未整理」的日期补跑整理
  --mock                 使用内置 Mock 模型干跑（不请求真实 API、不花额度）
  --user-name <name>     写入 core/user.md 的用户称呼
  --user-pronoun <代词>  写入 core/user.md 的代词（如 她 / 他 / TA，同步生成「关于她/他」标题）
  --resident-name <name> 写入 core/self.md 的名字（默认空，保持未定名态）
  --source-user <name>   仅 psyche 格式有效：筛选 soma/pwa 单聊发送者名（默认同 --user-name）
  --fonds <id>           导入全宗标识（默认按源文件名推导）
  --tz <iana>            虚拟时钟与日期切分时区（默认 Asia/Shanghai）
`);
}

function assertSafeDataDir(dataDir: string): void {
  const defaultProd = expandHome("~/.psyber/default");
  if (path.resolve(dataDir) === path.resolve(defaultProd)) {
    throw new Error(`安全拦截：禁止对正式数据目录 (${defaultProd}) 执行回放脚本！请通过 --data-dir 指定独立目录`);
  }
}

async function loadJsonlMessages(filePath: string, timeZone: string): Promise<NormalizedMessage[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const baseDir = path.dirname(filePath);
  const lines = raw.split(/\r?\n/);
  const messages: NormalizedMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const lineNum = i + 1;

    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("顶层必须为 JSON 对象");
      }
      obj = parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(`JSONL 第 ${lineNum} 行解析失败: ${(err as Error).message}`);
    }

    const role = obj.role;
    if (role !== "user" && role !== "assistant") {
      throw new Error(`JSONL 第 ${lineNum} 行 role 必须为 "user" 或 "assistant"，收到: ${String(role)}`);
    }

    const at = parseTimestamp(obj.at, lineNum);
    const text = typeof obj.text === "string" ? obj.text : "";
    const day = localDay(at, timeZone);

    const attachments: NormalizedAttachment[] = [];
    if (Array.isArray(obj.attachments)) {
      for (const att of obj.attachments) {
        if (typeof att === "string" && att.trim()) {
          const abs = path.isAbsolute(att.trim())
            ? att.trim()
            : path.resolve(baseDir, att.trim());
          attachments.push({ kind: "file", filePath: abs, mime: inferMimeFromExt(abs) });
        } else if (att && typeof att === "object" && !Array.isArray(att)) {
          const rec = att as { path?: unknown; mime?: unknown };
          if (typeof rec.path === "string" && rec.path.trim()) {
            const abs = path.isAbsolute(rec.path.trim())
              ? rec.path.trim()
              : path.resolve(baseDir, rec.path.trim());
            attachments.push({
              kind: "file",
              filePath: abs,
              mime: typeof rec.mime === "string" && rec.mime.trim() ? rec.mime.trim() : inferMimeFromExt(abs),
            });
          }
        }
      }
    }

    if (!text.trim() && attachments.length === 0) continue;

    const explicitId = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : "";
    const fallbackId = crypto
      .createHash("sha256")
      .update(`${lineNum}:${at}:${role}:${text}`)
      .digest("hex")
      .slice(0, 16);

    messages.push({
      id: explicitId || `L${lineNum}-${fallbackId}`,
      at,
      day,
      role,
      text,
      session: typeof obj.session === "string" && obj.session.trim() ? obj.session.trim() : undefined,
      source: typeof obj.source === "string" && obj.source.trim() ? obj.source.trim() : "jsonl",
      attachments,
    });
  }

  messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return messages;
}

function loadPsycheMessages(srcDb: Database, sourceUser: string, timeZone: string): NormalizedMessage[] {
  const trimmedUser = sourceUser.trim();
  const rows = (
    trimmedUser
      ? srcDb
          .query(
            `SELECT id, at, day, kind, source, payload
             FROM events
             WHERE (
               source = 'claude-chat'
               AND kind IN ('message.in', 'message.out')
             )
             OR (
               source = 'soma'
               AND kind = 'message.in'
               AND json_extract(payload, '$.via') = 'pwa'
               AND json_extract(payload, '$.from') = ?
             )
             OR (
               source = 'soma'
               AND kind = 'message.out'
               AND (
                 SELECT json_extract(i.payload, '$.via') || ':' || json_extract(i.payload, '$.from')
                 FROM events i
                 WHERE i.kind = 'message.in'
                   AND json_extract(i.payload, '$.session') = json_extract(events.payload, '$.session')
                   AND i.id < events.id
                 ORDER BY i.id DESC
                 LIMIT 1
               ) = ?
             )
             ORDER BY at ASC, id ASC`,
          )
          .all(trimmedUser, `pwa:${trimmedUser}`)
      : srcDb
          .query(
            `SELECT id, at, day, kind, source, payload
             FROM events
             WHERE (
               source = 'claude-chat'
               AND kind IN ('message.in', 'message.out')
             )
             OR (
               source = 'soma'
               AND kind = 'message.in'
               AND json_extract(payload, '$.via') = 'pwa'
             )
             OR (
               source = 'soma'
               AND kind = 'message.out'
               AND (
                 SELECT json_extract(i.payload, '$.via')
                 FROM events i
                 WHERE i.kind = 'message.in'
                   AND json_extract(i.payload, '$.session') = json_extract(events.payload, '$.session')
                   AND i.id < events.id
                 ORDER BY i.id DESC
                 LIMIT 1
               ) = 'pwa'
             )
             ORDER BY at ASC, id ASC`,
          )
          .all()
  ) as PsycheSourceRow[];

  return rows.map((row) => {
    let payloadObj: { text?: string; session?: string; attachments?: Array<{ hash?: string; mime?: string }> };
    try {
      payloadObj = JSON.parse(row.payload) as typeof payloadObj;
    } catch {
      payloadObj = {};
    }
    const attachments: NormalizedAttachment[] = [];
    if (Array.isArray(payloadObj.attachments)) {
      for (const att of payloadObj.attachments) {
        if (att?.hash) {
          attachments.push({ kind: "psyche_material", materialHash: att.hash, mime: att.mime });
        }
      }
    }
    return {
      id: row.id,
      at: row.at,
      day: row.day || localDay(row.at, timeZone),
      role: row.kind === "message.in" ? "user" : "assistant",
      text: typeof payloadObj.text === "string" ? payloadObj.text : "",
      session:
        typeof payloadObj.session === "string" && payloadObj.session.trim()
          ? payloadObj.session.trim()
          : undefined,
      source: row.source,
      attachments,
    };
  });
}

function groupByDay(rows: NormalizedMessage[]): {
  days: string[];
  byDay: Map<string, NormalizedMessage[]>;
  summaries: DaySummary[];
} {
  const byDay = new Map<string, NormalizedMessage[]>();
  for (const row of rows) {
    const list = byDay.get(row.day) ?? [];
    list.push(row);
    byDay.set(row.day, list);
  }
  const days = Array.from(byDay.keys()).sort();
  const summaries: DaySummary[] = days.map((day) => {
    const list = byDay.get(day)!;
    let msgIn = 0;
    let msgOut = 0;
    let attachments = 0;
    let chars = 0;
    for (const r of list) {
      if (r.role === "user") msgIn++;
      else msgOut++;
      chars += r.text.length;
      attachments += r.attachments.length;
    }
    return { day, msgIn, msgOut, attachments, chars };
  });
  return { days, byDay, summaries };
}

async function loadReplayState(dataDir: string, sourcePath: string): Promise<ReplayState> {
  const filePath = path.join(dataDir, STATE_FILENAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ReplayState> & { sourceDb?: string };
    return {
      version: 1,
      sourcePath: parsed.sourcePath || parsed.sourceDb || sourcePath,
      importedDays: Array.isArray(parsed.importedDays) ? parsed.importedDays : [],
      tidiedDays: Array.isArray(parsed.tidiedDays) ? parsed.tidiedDays : [],
      results: parsed.results ?? {},
    };
  } catch {
    return {
      version: 1,
      sourcePath,
      importedDays: [],
      tidiedDays: [],
      results: {},
    };
  }
}

async function saveReplayState(dataDir: string, state: ReplayState): Promise<void> {
  await atomicWriteFile(dataDir, path.join(dataDir, STATE_FILENAME), JSON.stringify(state, null, 2) + "\n");
}

async function resetDataDirPreserveConfig(dataDir: string): Promise<void> {
  const targets = [
    "psyber.sqlite",
    "psyber.sqlite-wal",
    "psyber.sqlite-shm",
    "memory",
    "media",
    "backups",
    ".tmp",
    STATE_FILENAME,
  ];
  for (const name of targets) {
    await fs.rm(path.join(dataDir, name), { recursive: true, force: true });
  }
}

async function ensureInitialized(opts: CliOptions): Promise<{
  db: Database;
  clock: VirtualClock;
  memoryIndex: MemoryIndex;
  config: Awaited<ReturnType<typeof loadOrCreateConfig>>;
}> {
  if (opts.reset) {
    console.log(`[reset] 清理 ${opts.dataDir}（保留 config.json 与 credentials.json）...`);
    await resetDataDirPreserveConfig(opts.dataDir);
  }

  await initDataDir(opts.dataDir);
  await cleanupTransientLocks(opts.dataDir);
  await initMemoryGitRepo(opts.dataDir);

  const initClock = new VirtualClock(Date.UTC(2026, 9, 10, 12, 0, 0), opts.tz);
  const config = await loadOrCreateConfig(opts.dataDir, initClock.now(), opts.tz);
  const clock = new VirtualClock(initClock.now(), config.timezone || opts.tz);

  const db = openDatabase(path.join(opts.dataDir, "psyber.sqlite"));
  runMigrations(db, clock.now());

  const memoryIndex = new MemoryIndex(db, opts.dataDir, clock);

  await applyGenesisMemory({
    dataDir: opts.dataDir,
    memoryIndex,
    residentName: opts.residentName,
    userName: opts.userName,
    userPronoun: opts.userPronoun,
  });

  const initPaths: string[] = ["core/self.md", "core/user.md"];
  const threadRegPath = path.join(opts.dataDir, "memory", "threads", "REGISTRY.yaml");
  const entRegPath = path.join(opts.dataDir, "memory", "entities", "REGISTRY.yaml");
  try {
    await fs.access(threadRegPath);
  } catch {
    await atomicWriteFile(opts.dataDir, threadRegPath, "spaces: {}\n");
    initPaths.push("threads/REGISTRY.yaml");
  }
  try {
    await fs.access(entRegPath);
  } catch {
    await atomicWriteFile(opts.dataDir, entRegPath, "entities: {}\n");
    initPaths.push("entities/REGISTRY.yaml");
  }

  if (!config.genesisCompleted) {
    config.genesisCompleted = true;
    await saveConfig(opts.dataDir, config);
  }

  await memoryIndex.reindexAll();
  await commitMemoryPaths(opts.dataDir, initPaths, "memory(genesis): init replay baseline");

  return { db, clock, memoryIndex, config };
}

async function importSingleDay(opts: {
  day: string;
  fonds: string;
  dayRows: NormalizedMessage[];
  srcDb: Database | null;
  dstDb: Database;
  mediaStore: MediaStore;
}): Promise<{ insertedEvents: number; savedAttachments: number }> {
  const { day, fonds, dayRows, srcDb, dstDb, mediaStore } = opts;
  const selectMaterial = srcDb ? srcDb.query("SELECT content, mime FROM materials WHERE hash = ?") : null;

  const resolvedAttachments = new Map<string, string[]>();
  let savedAttachments = 0;

  for (const row of dayRows) {
    if (row.attachments.length === 0) continue;
    const hashes: string[] = [];

    for (const att of row.attachments) {
      if (att.kind === "file" && att.filePath) {
        try {
          const bytes = await fs.readFile(att.filePath);
          const saved = await mediaStore.save({
            bytes: new Uint8Array(bytes),
            mimeType: att.mime || inferMimeFromExt(att.filePath),
            origin: "user_upload",
            nowMs: row.at,
          });
          hashes.push(saved.hash);
          savedAttachments++;
        } catch {
          console.warn(`  [warn] ${day} 事件 ${row.id} 引用了无法读取的附件文件: ${att.filePath}`);
        }
      } else if (att.kind === "psyche_material" && att.materialHash && selectMaterial) {
        const mat = selectMaterial.get(att.materialHash) as { content: Uint8Array; mime: string } | null;
        if (!mat) {
          console.warn(`  [warn] ${day} 事件 ${row.id} 引用了缺失的 material: ${att.materialHash}`);
          continue;
        }
        const saved = await mediaStore.save({
          bytes: mat.content instanceof Uint8Array ? mat.content : new Uint8Array(mat.content),
          mimeType: att.mime || mat.mime || "application/octet-stream",
          origin: "user_upload",
          nowMs: row.at,
        });
        hashes.push(saved.hash);
        savedAttachments++;
      }
    }

    if (hashes.length > 0) {
      resolvedAttachments.set(row.id, hashes);
    }
  }

  const maxSeqRow = dstDb.query("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events").get() as {
    max_seq: number;
  };
  const maxAtRow = dstDb.query("SELECT COALESCE(MAX(created_at), 0) AS max_at FROM events").get() as {
    max_at: number;
  };
  let nextSeq = maxSeqRow.max_seq + 1;
  let monotonicAt = maxAtRow.max_at;

  const insertStmt = dstDb.query(
    `INSERT INTO events (
      id, seq, session_id, turn_id, client_message_id,
      group_id, version, status, role, kind,
      source, fonds, activity, content, thinking, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 1, 'active', ?, 'chat', 'import', ?, NULL, ?, NULL, ?, ?)
    ON CONFLICT(client_message_id) DO NOTHING`,
  );

  const sessionTurnMap = new Map<string, string>();
  let insertedEvents = 0;

  const tx = dstDb.transaction(() => {
    for (const row of dayRows) {
      const sessionId = row.session ? `import-${row.session}` : `import-${row.source}-${day}`;

      let turnId: string;
      if (row.role === "user") {
        turnId = `import-turn-${row.id}`;
        sessionTurnMap.set(sessionId, turnId);
      } else {
        turnId = sessionTurnMap.get(sessionId) ?? `import-turn-${row.id}`;
      }

      const atForUlid = Math.max(row.at, monotonicAt);
      monotonicAt = atForUlid;
      const newId = ulid(atForUlid);
      const clientMsgId = `import:${fonds}:${row.id}`;

      const attachments = resolvedAttachments.get(row.id);
      const metadata: Record<string, unknown> = {
        importedFrom: fonds,
        originalId: row.id,
        originalSource: row.source,
        originalDay: day,
      };
      if (attachments && attachments.length > 0) {
        metadata.attachments = attachments;
      }

      const res = insertStmt.run(
        newId,
        nextSeq,
        sessionId,
        turnId,
        clientMsgId,
        row.role,
        fonds,
        row.text,
        JSON.stringify(metadata),
        row.at,
      );
      if (res.changes > 0) {
        nextSeq++;
        insertedEvents++;
      }
    }
  });
  tx();

  return { insertedEvents, savedAttachments };
}

class DryRunMockChatModel implements ChatModelClient {
  readonly contextWindow = 128_000;
  readonly modelId = "mock-dry-run";
  async *stream(): AsyncIterable<ChatStreamChunk> {
    yield { type: "text_delta", delta: '{"summary": "mock干跑跳过"}' };
  }
}

function countMemoryCards(dataDir: string): number {
  const dbPath = path.join(dataDir, "psyber.sqlite");
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT count(*) AS cnt FROM card_index").get() as { cnt: number };
    db.close();
    return row.cnt;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.sourcePath) {
    console.error("[错误] 缺少导入源路径，请传入 --source <path/to/import.jsonl> 或设置 PSYBER_REPLAY_SOURCE。\n");
    printHelp();
    process.exit(1);
  }
  assertSafeDataDir(opts.dataDir);

  const fmt = resolveFormat(opts.sourcePath, opts.format);
  let srcDb: Database | null = null;
  let allRows: NormalizedMessage[];
  if (fmt === "psyche") {
    srcDb = new Database(opts.sourcePath, { readonly: true });
    allRows = loadPsycheMessages(srcDb, opts.sourceUser, opts.tz);
  } else {
    allRows = await loadJsonlMessages(opts.sourcePath, opts.tz);
  }

  const { days, byDay, summaries } = groupByDay(allRows);
  const state = await loadReplayState(opts.dataDir, opts.sourcePath);

  if (opts.status) {
    const importedSet = new Set(state.importedDays);
    const tidiedSet = new Set(state.tidiedDays);
    console.log(`源件: ${opts.sourcePath}（格式: ${fmt}）`);
    console.log(`目标: ${opts.dataDir}`);
    console.log(`总计有效消息: ${allRows.length} 条（跨越 ${days.length} 个活跃日）`);
    console.log(`当前目标库卡片数: ${countMemoryCards(opts.dataDir)}\n`);
    console.log("日期        | 入/出   | 附件 | 字数   | 导入 | 整理 | 摘要");
    console.log("------------|---------|------|--------|------|------|-----");
    for (const s of summaries) {
      const imp = importedSet.has(s.day) ? "✅" : "⏳";
      const tidy = tidiedSet.has(s.day) ? "✅" : "⏳";
      const summary = state.results[s.day]?.summary ?? "";
      const io = `${String(s.msgIn).padStart(3)}/${String(s.msgOut).padEnd(3)}`;
      console.log(
        `${s.day}  | ${io} | ${String(s.attachments).padStart(4)} | ${String(s.chars).padStart(6)} |  ${imp}  |  ${tidy}  | ${summary}`,
      );
    }
    srcDb?.close();
    return;
  }

  const { db, clock, memoryIndex, config } = await ensureInitialized(opts);
  if (opts.init || opts.reset) {
    const freshState: ReplayState = opts.reset
      ? { version: 1, sourcePath: opts.sourcePath, importedDays: [], tidiedDays: [], results: {} }
      : await loadReplayState(opts.dataDir, opts.sourcePath);
    await saveReplayState(opts.dataDir, freshState);
    state.importedDays = freshState.importedDays;
    state.tidiedDays = freshState.tidiedDays;
    state.results = freshState.results;
    console.log(`[ok] 已初始化目标目录: ${opts.dataDir}`);
    if (!opts.hasExplicitStep) {
      db.close();
      srcDb?.close();
      return;
    }
  }

  if (state.importedDays.length === 0 && !opts.allowAppend) {
    const existingRow = db.query("SELECT count(*) AS cnt FROM events").get() as { cnt: number };
    if (existingRow.cnt > 0) {
      console.error(
        `\n[拦截] 目标目录 ${opts.dataDir} 的 events 表已有 ${existingRow.cnt} 条历史数据，且无本次回放断点记录。`,
      );
      console.error(
        `  为防混库，请加 --reset 清空测试数据（保留 config.json / credentials.json / stickers），或用 --data-dir 另建隔离目录。\n`,
      );
      db.close();
      srcDb?.close();
      process.exit(1);
    }
  }

  const importedSet = new Set(state.importedDays);
  const tidiedSet = new Set(state.tidiedDays);

  let chatModel: ChatModelClient;
  if (opts.mock) {
    chatModel = new DryRunMockChatModel();
  } else if (!opts.importOnly) {
    const creds = await loadCredentials(opts.dataDir);
    const resolved = resolveByokSlot(config, creds, "memory_task");
    if (!resolved.ok) {
      console.error(`\n[错误] 尚未配置整理模型，无法运行真实 tidy：\n  ${resolved.reason}`);
      console.error(`\n请先在 ${opts.dataDir}/config.json 与 credentials.json 配置模型，或先加 --import-only / --mock 测试。\n`);
      db.close();
      srcDb?.close();
      process.exit(1);
    }
    chatModel = new DynamicChatModel({ dataDir: opts.dataDir, getConfig: () => config, slot: "memory_task" });
    console.log(
      `[llm] 使用 memory_task 槽位: ${resolved.slot.providerId}/${resolved.slot.modelId}`,
    );
  } else {
    chatModel = new DryRunMockChatModel();
  }

  const pendingDays = days.filter((day) => {
    if (opts.until && day > opts.until) return false;
    if (opts.importOnly) return !importedSet.has(day);
    if (opts.tidyOnly) return importedSet.has(day) && !tidiedSet.has(day);
    return !importedSet.has(day) || !tidiedSet.has(day);
  });

  const targetDays = opts.all || opts.until ? pendingDays : pendingDays.slice(0, opts.days);
  if (targetDays.length === 0) {
    console.log("[done] 当前条件下没有待推进的日期。用 --status 查看进度。");
    db.close();
    srcDb?.close();
    return;
  }

  const events = new EventStore(db, clock);
  const mediaStore = new MediaStore(db, opts.dataDir);
  const memoryTools = new MemoryTools(opts.dataDir, memoryIndex, clock);

  console.log(`\n准备推进 ${targetDays.length} 天: ${targetDays[0]} .. ${targetDays[targetDays.length - 1]}\n`);

  for (const day of targetDays) {
    const dayRows = byDay.get(day)!;
    const [y, m, d] = day.split("-").map(Number);

    if (!importedSet.has(day) && !opts.tidyOnly) {
      clock.jumpToWallClock(y, m, d, 23, 30, 0);
      const impRes = await importSingleDay({
        day,
        fonds: opts.fonds || "jsonl-import",
        dayRows,
        srcDb,
        dstDb: db,
        mediaStore,
      });
      importedSet.add(day);
      state.importedDays = days.filter((x) => importedSet.has(x));
      state.results[day] = {
        ...(state.results[day] ?? { day, importedAt: new Date().toISOString(), importedEvents: 0, importedAttachments: 0 }),
        importedAt: new Date().toISOString(),
        importedEvents: impRes.insertedEvents,
        importedAttachments: impRes.savedAttachments,
      };
      await saveReplayState(opts.dataDir, state);
      console.log(
        `[${day}] 导入完成: +${impRes.insertedEvents} 条消息, +${impRes.savedAttachments} 个附件`,
      );
    }

    if (opts.importOnly) continue;

    if (!tidiedSet.has(day)) {
      clock.jumpToWallClock(y, m, d, 23, 35, 0);
      const weekday = localWeekday(clock.now(), clock.timeZone);
      console.log(`[${day} ${weekday}] 开始静默整理 (VirtualClock = ${day} 23:35:00)...`);
      const t0 = Date.now();
      const outcome = await runMemoryTidyTask(
        {
          db,
          dataDir: opts.dataDir,
          promptsDir: opts.promptsDir,
          clock,
          events,
          memoryIndex,
          memoryTools,
          chatModel,
          getConfig: () => config,
        },
        { taskType: "bedtime", nightDate: day },
      );
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

      if (!outcome.ok) {
        console.error(`\n[${day}] 整理失败 (${elapsedSec}s): ${outcome.error}`);
        console.error("  已自动回滚本批未提交卡片且未推进游标；修改提示词/代码或配额恢复后直接重跑即可从今天续跑。");
        db.close();
        srcDb?.close();
        process.exit(1);
      }

      tidiedSet.add(day);
      state.tidiedDays = days.filter((x) => tidiedSet.has(x));
      state.results[day] = {
        ...(state.results[day] ?? { day, importedAt: new Date().toISOString(), importedEvents: 0, importedAttachments: 0 }),
        tidiedAt: new Date().toISOString(),
        processedEvents: outcome.processedEvents,
        touchedMemoryPaths: outcome.touchedMemoryPaths,
        summary: outcome.summary,
      };
      await saveReplayState(opts.dataDir, state);
      console.log(
        `[${day}] 整理成功 (${elapsedSec}s): 消化 ${outcome.processedEvents} 条 | 摘要: ${outcome.summary} | 触碰卡片 (${outcome.touchedMemoryPaths.length}): ${outcome.touchedMemoryPaths.join(", ") || "无"}`,
      );

      if (!opts.mock) {
        const decisionClient = new DynamicDecisionClient({
          dataDir: opts.dataDir,
          getConfig: () => config,
        });
        const refRes = await maybeRunReflectAfterBedtime(
          {
            db,
            dataDir: opts.dataDir,
            promptsDir: opts.promptsDir,
            clock,
            memoryIndex,
            memoryTools,
            chatModel,
            decisionClient,
            getConfig: () => config,
          },
          { targetDay: day },
        );
        const logRef = (label: string, r: typeof refRes.daily) => {
          const scores = r.decisionScores
            ? ` scores=${JSON.stringify(r.decisionScores)}`
            : "";
          if (!r.triggered) {
            console.log(`  [${day}] ${label}跳过: ${r.skipReason ?? r.summary}${scores}`);
          } else if (r.ok) {
            console.log(
              `  [${day}] ${label}完成: ${r.summary}${scores} | 触碰 (${r.touchedMemoryPaths.length}): ${r.touchedMemoryPaths.join(", ") || "无"}`,
            );
          } else {
            console.warn(`  [${day}] ${label}失败: ${r.error}`);
          }
        };
        logRef("日反思", refRes.daily);
        if (refRes.weekly) {
          logRef("周日反思", refRes.weekly);
        }
      }
    }
  }

  console.log(`\n[完成] 当前总卡片数: ${countMemoryCards(opts.dataDir)}，记忆 Git 仓库: ${path.join(opts.dataDir, "memory")}`);
  db.close();
  srcDb?.close();
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
