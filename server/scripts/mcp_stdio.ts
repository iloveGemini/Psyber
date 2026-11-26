#!/usr/bin/env bun
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const CLOSE_SESSION_TIMEOUT_MS = 1_500;

export interface BridgeOptions {
  dataDir: string;
  url?: string;
  token?: string;
  tokenFile?: string;
  timeoutMs: number;
  help: boolean;
}

export interface StdioBridgeIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: { write: (chunk: string) => unknown };
  stderr?: { write: (chunk: string) => unknown };
  fetchImpl?: typeof fetch;
  registerSignalHandlers?: boolean;
}

interface LocalPairInfo {
  protocol?: string;
  host?: string;
  port?: number;
}

function expandHome(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function printHelp(stderr: { write: (chunk: string) => unknown }): void {
  stderr.write(`Psyber 记忆 MCP stdio 转发桥（单进程防分叉，直连本机 /mcp）

用法：
  bun run mcp:stdio -- [options]

选项：
  --data-dir <path>      实例目录（默认 PSYBER_DATA_DIR 或 ~/.psyber/default）
  --url <endpoint>       覆盖目标 HTTP 端点（默认按 local_pair.json 或 http://127.0.0.1:3721/mcp）
  --token <raw>          直接传入令牌明文（不推荐，建议改用 --save-stdio 或 --token-file）
  --token-file <path>    指定存放令牌明文的文件（默认读取 <dataDir>/mcp_stdio_token）
  --timeout-ms <ms>      单次请求超时毫秒（默认 30000）
  -h, --help             显示帮助
`);
}

export function parseBridgeArgs(argv: string[]): BridgeOptions {
  const opts: BridgeOptions = {
    dataDir: expandHome(process.env.PSYBER_DATA_DIR || "~/.psyber/default"),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a === "--data-dir") {
      const val = argv[++i];
      if (!val) throw new Error("--data-dir 缺少参数");
      opts.dataDir = expandHome(val);
    } else if (a === "--url") {
      const val = argv[++i];
      if (!val) throw new Error("--url 缺少参数");
      opts.url = val.trim();
    } else if (a === "--token") {
      const val = argv[++i];
      if (!val) throw new Error("--token 缺少参数");
      opts.token = val.trim();
    } else if (a === "--token-file") {
      const val = argv[++i];
      if (!val) throw new Error("--token-file 缺少参数");
      opts.tokenFile = expandHome(val);
    } else if (a === "--timeout-ms") {
      const raw = Number(argv[++i]);
      if (!Number.isFinite(raw) || raw < 500 || raw > 300_000) {
        throw new Error("--timeout-ms 须为 500..300000 之间的数字");
      }
      opts.timeoutMs = Math.floor(raw);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

async function resolveEndpoint(opts: BridgeOptions): Promise<string> {
  if (opts.url) return opts.url;
  const envUrl = process.env.PSYBER_MCP_URL?.trim();
  if (envUrl) return envUrl;

  try {
    const raw = await fs.readFile(path.join(opts.dataDir, "local_pair.json"), "utf8");
    const lp = JSON.parse(raw) as LocalPairInfo;
    const protocol = lp?.protocol === "https" ? "https" : "http";
    const host = typeof lp?.host === "string" && lp.host ? lp.host : "127.0.0.1";
    const port = typeof lp?.port === "number" && lp.port > 0 ? lp.port : 3721;
    return `${protocol}://${host}:${port}/mcp`;
  } catch {
    const port = Number(process.env.PSYBER_PORT || 3721);
    return `http://127.0.0.1:${port}/mcp`;
  }
}

async function resolveToken(opts: BridgeOptions): Promise<string> {
  if (opts.token) return opts.token;
  const envTok = process.env.PSYBER_MCP_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenFile = opts.tokenFile ?? path.join(opts.dataDir, "mcp_stdio_token");
  try {
    const content = (await fs.readFile(tokenFile, "utf8")).trim();
    if (content) return content;
  } catch {
    // fallback to clear error below
  }
  throw new Error(
    `未找到记忆 MCP 令牌（请先执行: bun run mcp -- --data-dir "${opts.dataDir}" token create --name desktop --save-stdio，或设置 PSYBER_MCP_TOKEN）`,
  );
}

function extractRpcId(raw: unknown): string | number | null | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const id = (raw as { id?: unknown }).id;
  if (id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id))) {
    return id;
  }
  return undefined;
}

/**
 * 运行极薄 stdio JSON-RPC 2.0 转发桥：
 * - stdin 逐行读取并转发至本机 Streamable HTTP `/mcp`；
 * - 缓存 `mcp-session-id` 并在流结束或退出时发送 `DELETE /mcp` 清理会话。
 */
export async function runStdioBridge(opts: BridgeOptions, io: StdioBridgeIo = {}): Promise<void> {
  const stdin = (io.stdin ?? process.stdin) as NodeJS.ReadableStream;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const fetchImpl = io.fetchImpl ?? fetch;

  if (opts.help) {
    printHelp(stderr);
    return;
  }

  const endpoint = await resolveEndpoint(opts);
  const token = await resolveToken(opts);
  let sessionId: string | null = null;
  let closed = false;

  const writeStdoutLine = (payload: unknown): void => {
    stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const emitBridgeErrorForInput = (parsedInput: unknown, code: number, message: string): void => {
    if (Array.isArray(parsedInput)) {
      const errs = parsedInput
        .map((item) => {
          const id = extractRpcId(item);
          return id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message } };
        })
        .filter((x) => x !== null);
      if (errs.length > 0) writeStdoutLine(errs);
      return;
    }
    const id = extractRpcId(parsedInput);
    if (id !== undefined) {
      writeStdoutLine({ jsonrpc: "2.0", id, error: { code, message } });
    }
  };

  const closeSession = async (): Promise<void> => {
    if (!sessionId) return;
    const sid = sessionId;
    sessionId = null;
    try {
      await fetchImpl(endpoint, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          "mcp-session-id": sid,
        },
        signal: AbortSignal.timeout(CLOSE_SESSION_TIMEOUT_MS),
      });
    } catch {
      // 忽略退出时的会话清理超时
    }
  };

  const forwardLine = async (line: string): Promise<void> => {
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(line);
    } catch {
      writeStdoutLine({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: stdin 行不是合法 JSON" },
      });
      return;
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    let resp: Response;
    try {
      resp = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: line,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`[psyber-mcp-stdio] 请求 ${endpoint} 失败: ${msg}\n`);
      emitBridgeErrorForInput(
        parsedInput,
        -32000,
        `无法连接 Psyber 记忆 MCP 服务（${endpoint}）：${msg}。请确认 Psyber 服务端已启动。`,
      );
      return;
    }

    const returnedSid = resp.headers.get("mcp-session-id")?.trim();
    if (returnedSid) {
      sessionId = returnedSid;
    }

    if (resp.status === 202) {
      return;
    }

    const text = await resp.text();
    if (!resp.ok) {
      let errCode = "";
      let errMsg = `HTTP ${resp.status}`;
      try {
        const parsedErr = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (parsedErr?.error?.code) errCode = parsedErr.error.code;
        if (parsedErr?.error?.message) errMsg = parsedErr.error.message;
      } catch {
        if (text.trim()) errMsg = `${errMsg}: ${text.trim().slice(0, 200)}`;
      }
      if (resp.status === 404 && errCode === "MCP_SESSION_NOT_FOUND") {
        sessionId = null;
      }
      stderr.write(`[psyber-mcp-stdio] 服务端拒绝 (${resp.status} ${errCode}): ${errMsg}\n`);
      emitBridgeErrorForInput(parsedInput, -32000, `${errMsg}${errCode ? ` (${errCode})` : ""}`);
      return;
    }

    if (!text.trim()) return;
    try {
      const json = JSON.parse(text);
      writeStdoutLine(json);
    } catch {
      emitBridgeErrorForInput(parsedInput, -32000, "Psyber 记忆 MCP 返回了非 JSON 响应");
    }
  };

  let chain = Promise.resolve();
  const enqueueLine = (line: string) => {
    chain = chain.then(() => forwardLine(line)).catch((err) => {
      stderr.write(
        `[psyber-mcp-stdio] 转发异常: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  };

  if (io.registerSignalHandlers) {
    const shutdown = async () => {
      if (closed) return;
      closed = true;
      await chain;
      await closeSession();
      process.exit(0);
    };
    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });
  }

  stdin.setEncoding?.("utf8");
  let buffer = "";
  stdin.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const rawLine = buffer.slice(0, nl).replace(/\r$/, "").trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (rawLine) enqueueLine(rawLine);
    }
  });

  await new Promise<void>((resolve) => {
    stdin.on("end", () => {
      const tail = buffer.replace(/\r$/, "").trim();
      if (tail) enqueueLine(tail);
      resolve();
    });
  });

  await chain;
  await closeSession();
}

async function main(): Promise<void> {
  const opts = parseBridgeArgs(process.argv.slice(2));
  await runStdioBridge(opts, { registerSignalHandlers: true });
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[psyber-mcp-stdio] 启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
