import type { McpServerConfig, McpTransport, McpTrustLevel } from "../core/config.ts";
import type { StoredCredentials } from "../core/credentials.ts";
import { DEFAULT_LLM_IMAGE_HARD_BYTES } from "../core/image_compress.ts";
import type { ToolRegistry, ToolResult, ToolResultImage } from "../tools/registry.ts";

export const MCP_SERVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MAX_MCP_OUTPUT_CHARS = 8000;
export const MAX_MCP_IMAGES = 4;
export const MAX_MCP_IMAGE_BYTES = DEFAULT_LLM_IMAGE_HARD_BYTES;
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
export const MAX_MCP_TIMEOUT_MS = 120_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_RECONNECT_DELAYS_MS = [2_000, 10_000, 30_000];
export const DEFAULT_KILL_GRACE_MS = 3_000;

const MCP_SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const DATA_URI_IMAGE_RE = /^data:([^;,]+);base64,([\s\S]+)$/i;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type McpServerStatus = "connected" | "degraded" | "disabled";

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

export interface McpServerStatusView {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  trustLevel: McpTrustLevel;
  autoAllowTools?: string[];
  timeoutMs: number;
  status: McpServerStatus;
  toolCount: number;
  tools: string[];
  lastError?: string;
}

export interface McpPreset {
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  trustLevel: McpTrustLevel;
  autoAllowTools?: string[];
  secretKeys?: string[];
}

/** 内置常用开源 MCP 生态预设模板（一键填入配置框架与 ${cred:...} 占位符） */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: "fetch",
    label: "网页抓取 (Fetch)",
    description: "按需抓取公开网页正文并转为 Markdown，适合查阅文档与新闻",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    trustLevel: "confirm",
  },
  {
    id: "filesystem",
    label: "本机只读目录 (Filesystem)",
    description: "授权 Psyber 按需查看指定文件夹内的文档（请将路径改为允许访问的目录）",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/folder"],
    trustLevel: "confirm",
  },
  {
    id: "tavily",
    label: "Tavily 联网搜索",
    description: "通过 Streamable HTTP 接入 Tavily 实时网页检索（只读搜索默认免审批）",
    transport: "streamable_http",
    url: "https://mcp.tavily.com/mcp/",
    headers: {
      Authorization: "Bearer ${cred:tavily_api_key}",
    },
    trustLevel: "confirm",
    autoAllowTools: ["tavily-search", "tavily-extract", "tavily_search", "tavily_extract"],
    secretKeys: ["tavily_api_key"],
  },
  {
    id: "github",
    label: "GitHub 仓库协作",
    description: "查阅 Issue、PR 与代码仓库信息",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "${cred:github_token}",
    },
    trustLevel: "confirm",
    secretKeys: ["github_token"],
  },
  {
    id: "sqlite",
    label: "SQLite 数据查询",
    description: "查询本地指定 SQLite 数据库文件",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "/path/to/data.db"],
    trustLevel: "confirm",
  },
];

export function clampMcpTimeoutMs(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MCP_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_MCP_TIMEOUT_MS, Math.floor(raw)));
}

export function truncateMcpOutput(text: string, maxChars = MAX_MCP_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[外部工具输出已截断，原始长度 ${text.length} 字符]`;
}

export function resolveCredentialString(raw: string, creds: StoredCredentials): string {
  return raw.replace(/\$\{cred:([a-zA-Z0-9._-]+)\}/g, (_m, key: string) => {
    return creds.mcpSecrets?.[key] ?? creds.channelTokens[key] ?? creds.apiKeys[key] ?? "";
  });
}

export function resolveCredentialRecord(
  record: Record<string, string> | undefined,
  creds: StoredCredentials,
): Record<string, string> {
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") {
      out[k] = resolveCredentialString(v, creds);
    }
  }
  return out;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateMcpServers(
  raw: unknown,
): { ok: true; servers: McpServerConfig[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "mcpServers 必须为数组" };
  }
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "mcpServers 元素必须为对象" };
    }
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!MCP_SERVER_ID_RE.test(id)) {
      return {
        ok: false,
        error: `MCP 服务器 ID "${id}" 非法，须匹配 ^[a-z0-9][a-z0-9_-]{0,31}$`,
      };
    }
    if (seen.has(id)) {
      return { ok: false, error: `MCP 服务器 ID "${id}" 重复` };
    }
    seen.add(id);

    const enabled = obj.enabled !== false;
    const transport = obj.transport;
    if (transport !== "stdio" && transport !== "streamable_http") {
      return { ok: false, error: `MCP "${id}" 的 transport 须为 stdio 或 streamable_http` };
    }

    const command = typeof obj.command === "string" ? obj.command.trim() : undefined;
    const args = Array.isArray(obj.args)
      ? obj.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const cwd = typeof obj.cwd === "string" && obj.cwd.trim() ? obj.cwd.trim() : undefined;
    const url = typeof obj.url === "string" ? obj.url.trim() : undefined;

    if (transport === "stdio" && !command) {
      return { ok: false, error: `stdio MCP "${id}" 缺少 command` };
    }
    if (transport === "streamable_http" && (!url || !isValidHttpUrl(url))) {
      return { ok: false, error: `streamable_http MCP "${id}" 需要合法的 http/https url` };
    }

    const trustLevel: McpTrustLevel =
      obj.trustLevel === "auto" || obj.trustLevel === "confirm" ? obj.trustLevel : "confirm";

    const cleanStringMap = (v: unknown): Record<string, string> | undefined => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };

    const cleanStringArray = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const list = v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim());
      return list.length > 0 ? list : undefined;
    };

    servers.push({
      id,
      enabled,
      transport,
      ...(typeof obj.description === "string" && obj.description.trim()
        ? { description: obj.description.trim().slice(0, 120) }
        : {}),
      ...(command ? { command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(cleanStringMap(obj.env) ? { env: cleanStringMap(obj.env) } : {}),
      ...(cwd ? { cwd } : {}),
      ...(url ? { url } : {}),
      ...(cleanStringMap(obj.headers) ? { headers: cleanStringMap(obj.headers) } : {}),
      trustLevel,
      ...(cleanStringArray(obj.autoAllowTools)
        ? { autoAllowTools: cleanStringArray(obj.autoAllowTools) }
        : {}),
      ...(cleanStringArray(obj.includeTools)
        ? { includeTools: cleanStringArray(obj.includeTools) }
        : {}),
      ...(cleanStringArray(obj.excludeTools)
        ? { excludeTools: cleanStringArray(obj.excludeTools) }
        : {}),
      timeoutMs: clampMcpTimeoutMs(typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined),
    });
  }
  return { ok: true, servers };
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpTransportClient {
  initialize(timeoutMs: number): Promise<void>;
  listTools(timeoutMs: number): Promise<McpToolSpec[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

function combineAbortSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeoutSignal, external]);
  }
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (external.aborted || timeoutSignal.aborted) {
    ac.abort();
    return ac.signal;
  }
  external.addEventListener("abort", onAbort, { once: true });
  timeoutSignal.addEventListener("abort", onAbort, { once: true });
  return ac.signal;
}

/**
 * 原生 stdio JSON-RPC 2.0 MCP 客户端（零外部依赖，直接基于 Bun.spawn）。
 */
export class StdioMcpClient implements McpTransportClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly cfg: McpServerConfig,
    private readonly resolvedEnv: Record<string, string>,
    private readonly opts: {
      killGraceMs?: number;
      onUnexpectedExit?: (code: number | null) => void;
    } = {},
  ) {}

  private ensureSpawned(): void {
    if (this.proc) return;
    if (!this.cfg.command) {
      throw new Error(`stdio MCP "${this.cfg.id}" 缺少 command`);
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, this.resolvedEnv);

    this.proc = Bun.spawn([this.cfg.command, ...(this.cfg.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.cfg.cwd,
      env,
    });

    void this.readStdoutLoop(this.proc.stdout as ReadableStream<Uint8Array>);
    void this.proc.exited.then((code) => {
      const err = new Error(`MCP "${this.cfg.id}" 子进程退出 (code=${code})`);
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(err);
        this.pending.delete(id);
      }
      this.proc = null;
      if (!this.closed) {
        this.opts.onUnexpectedExit?.(code);
      }
    });
  }

  private async readStdoutLoop(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nlIdx = buffer.indexOf("\n");
        while (nlIdx >= 0) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          nlIdx = buffer.indexOf("\n");
          if (!line) continue;
          this.handleLine(line);
        }
      }
    } catch {
      // 流结束或进程终止
    } finally {
      reader.releaseLock();
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(msg.error.message || `MCP JSON-RPC error ${msg.error.code ?? ""}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  private writeJson(payload: unknown): void {
    this.ensureSpawned();
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number") {
      throw new Error(`MCP "${this.cfg.id}" stdin 不可写`);
    }
    stdin.write(JSON.stringify(payload) + "\n");
    void stdin.flush();
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP "${this.cfg.id}" 连接已关闭`));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("调用已中止"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(new Error(`MCP "${this.cfg.id}" ${method} 已中止`));
        }
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        reject(new Error(`MCP "${this.cfg.id}" ${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer,
      });

      try {
        this.writeJson({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async initialize(timeoutMs: number): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "psyber", version: "0.1.0" },
      },
      timeoutMs,
    );
    try {
      this.writeJson({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    } catch {
      // 忽略通知发送异常
    }
  }

  async listTools(timeoutMs: number): Promise<McpToolSpec[]> {
    const res = (await this.request("tools/list", {}, timeoutMs)) as { tools?: unknown };
    if (!res || !Array.isArray(res.tools)) return [];
    return res.tools
      .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object"))
      .map((t) => ({
        name: String(t.name ?? "").trim(),
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
            ? (t.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      }))
      .filter((t) => t.name.length > 0);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    const res = await this.request("tools/call", { name, arguments: args }, timeoutMs, signal);
    return (res && typeof res === "object" ? (res as McpToolCallResult) : {}) as McpToolCallResult;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`MCP "${this.cfg.id}" 已关闭`));
      this.pending.delete(id);
    }
    const proc = this.proc;
    if (!proc) return;
    try {
      if (proc.stdin && typeof proc.stdin !== "number") {
        proc.stdin.end();
      }
    } catch {
      // ignore
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    const graceMs = this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const exitedEarly = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!exitedEarly) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await proc.exited.catch(() => {});
    }
    this.proc = null;
  }
}

/**
 * Streamable HTTP JSON-RPC 2.0 MCP 客户端（支持 application/json 与 text/event-stream）。
 */
export class StreamableHttpMcpClient implements McpTransportClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private readonly cfg: McpServerConfig,
    private readonly resolvedHeaders: Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.cfg.url) {
      throw new Error(`streamable_http MCP "${this.cfg.id}" 缺少 url`);
    }
    const id = this.nextId++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.resolvedHeaders,
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    const combinedSignal = combineAbortSignals(timeoutMs, signal);
    const resp = await this.fetchImpl(this.cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: combinedSignal,
    });
    const newSessionId = resp.headers.get("mcp-session-id");
    if (newSessionId) {
      this.sessionId = newSessionId;
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const text = await resp.text();
    let msg: JsonRpcResponse | null = null;
    if (contentType.includes("text/event-stream")) {
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const jsonPart = line.slice(5).trim();
        if (!jsonPart) continue;
        try {
          const parsed = JSON.parse(jsonPart) as JsonRpcResponse;
          if (parsed.id === id || msg === null) {
            msg = parsed;
          }
        } catch {
          // 跳过非 JSON 事件
        }
      }
    } else if (text.trim()) {
      msg = JSON.parse(text) as JsonRpcResponse;
    }
    if (!msg) {
      throw new Error(`MCP "${this.cfg.id}" 返回空响应`);
    }
    if (msg.error) {
      throw new Error(msg.error.message || `MCP JSON-RPC error ${msg.error.code ?? ""}`);
    }
    return msg.result;
  }

  async initialize(timeoutMs: number): Promise<void> {
    await this.rpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "psyber", version: "0.1.0" },
      },
      timeoutMs,
    );
  }

  async listTools(timeoutMs: number): Promise<McpToolSpec[]> {
    const res = (await this.rpc("tools/list", {}, timeoutMs)) as { tools?: unknown };
    if (!res || !Array.isArray(res.tools)) return [];
    return res.tools
      .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object"))
      .map((t) => ({
        name: String(t.name ?? "").trim(),
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema)
            ? (t.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      }))
      .filter((t) => t.name.length > 0);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    const res = await this.rpc("tools/call", { name, arguments: args }, timeoutMs, signal);
    return (res && typeof res === "object" ? (res as McpToolCallResult) : {}) as McpToolCallResult;
  }

  async close(): Promise<void> {
    this.sessionId = null;
  }
}

interface ManagedServerEntry {
  config: McpServerConfig;
  fingerprint: string;
  client: McpTransportClient | null;
  status: McpServerStatus;
  tools: string[];
  lastError?: string;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface McpManagerDeps {
  registry: ToolRegistry;
  loadCredentials: () => Promise<StoredCredentials>;
  fetchImpl?: typeof fetch;
  handshakeTimeoutMs?: number;
  reconnectDelaysMs?: number[];
  killGraceMs?: number;
  /** 可注入自定义客户端工厂，供离线单测模拟各类传输与故障 */
  clientFactory?: (
    cfg: McpServerConfig,
    resolved: { env: Record<string, string>; headers: Record<string, string> },
    onUnexpectedExit: (code: number | null) => void,
  ) => McpTransportClient;
}

function normalizeMcpImageMime(raw?: string): string {
  const clean = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (clean === "image/jpg") return "image/jpeg";
  return clean;
}

function estimateBase64DecodedBytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function parseMcpImagePayload(
  rawData: unknown,
  rawMime: unknown,
): { ok: true; image: ToolResultImage } | { ok: false; reason: string } {
  if (typeof rawData !== "string" || !rawData.trim()) {
    return { ok: false, reason: "图片数据为空" };
  }
  let dataStr = rawData.trim();
  let mimeStr = typeof rawMime === "string" ? rawMime : "";
  const dataUriMatch = DATA_URI_IMAGE_RE.exec(dataStr);
  if (dataUriMatch) {
    if (!mimeStr) mimeStr = dataUriMatch[1] ?? "";
    dataStr = dataUriMatch[2] ?? "";
  }
  const cleanB64 = dataStr.replace(/\s+/g, "");
  if (!cleanB64 || cleanB64.length % 4 === 1 || !BASE64_BODY_RE.test(cleanB64)) {
    return { ok: false, reason: "图片 base64 格式无效" };
  }
  const mimeType = normalizeMcpImageMime(mimeStr);
  if (!MCP_SUPPORTED_IMAGE_MIMES.has(mimeType)) {
    return { ok: false, reason: `暂不支持格式 ${mimeType || "unknown"}` };
  }
  const approxBytes = estimateBase64DecodedBytes(cleanB64);
  if (approxBytes === 0) {
    return { ok: false, reason: "图片数据为空" };
  }
  if (approxBytes > MAX_MCP_IMAGE_BYTES) {
    const mb = (approxBytes / (1024 * 1024)).toFixed(2);
    const limitMb = (MAX_MCP_IMAGE_BYTES / (1024 * 1024)).toFixed(2);
    return { ok: false, reason: `体积约 ${mb} MB，超过单图上限 ${limitMb} MB` };
  }
  return {
    ok: true,
    image: {
      type: "image",
      data: cleanB64,
      mimeType,
    },
  };
}

/**
 * 格式化外部 MCP 工具调用结果（Spec 03 §5.2）：
 * - 文本块截断至 MAX_MCP_OUTPUT_CHARS；
 * - 图片块（`type: "image"` 或 `type: "resource"` 中 `image/*` blob）透传为当轮临时 `ToolResult.images`，
 *   仅在当轮工具循环送给模型，跨轮不落盘 base64，绝不把 base64 原文混进文本 output。
 */
export function formatMcpCallResult(res: McpToolCallResult): ToolResult {
  const parts: string[] = [];
  const images: ToolResultImage[] = [];
  let totalImageBlocks = 0;
  let skippedByCount = 0;

  const tryPushImage = (rawData: unknown, rawMime: unknown): void => {
    totalImageBlocks += 1;
    if (images.length >= MAX_MCP_IMAGES) {
      skippedByCount += 1;
      return;
    }
    const parsed = parseMcpImagePayload(rawData, rawMime);
    if (parsed.ok) {
      images.push(parsed.image);
    } else {
      parts.push(`[外部工具图片已跳过：${parsed.reason}]`);
    }
  };

  if (Array.isArray(res.content)) {
    for (const block of res.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "image") {
        tryPushImage(block.data, block.mimeType ?? block.mime_type);
        continue;
      }
      if (block.type === "audio") {
        const mime = typeof block.mimeType === "string" ? block.mimeType : "audio";
        parts.push(`[外部工具返回音频块（${mime}），当前暂不支持直接透传]`);
        continue;
      }
      if (block.type === "resource" && block.resource && typeof block.resource === "object") {
        const resource = block.resource as Record<string, unknown>;
        if (typeof resource.blob === "string") {
          const rMime = normalizeMcpImageMime(
            typeof resource.mimeType === "string"
              ? resource.mimeType
              : typeof resource.mime_type === "string"
                ? resource.mime_type
                : "",
          );
          if (rMime.startsWith("image/")) {
            tryPushImage(resource.blob, rMime);
          } else {
            const uri = typeof resource.uri === "string" ? ` ${resource.uri}` : "";
            parts.push(`[外部工具返回二进制资源${uri}（${rMime || "binary"}），当前暂不支持直接透传]`);
          }
          continue;
        }
        if (typeof resource.text === "string") {
          parts.push(resource.text);
          continue;
        }
      }
      if (typeof block.text === "string") {
        parts.push(block.text);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
  }

  if (skippedByCount > 0) {
    parts.push(`[外部工具共返回 ${totalImageBlocks} 张图片，已仅载入前 ${MAX_MCP_IMAGES} 张]`);
  }

  let rawText: string;
  if (parts.length > 0) {
    rawText = parts.join("\n");
  } else if (images.length > 0) {
    rawText = `[外部工具返回了 ${images.length} 张图片（仅本轮可见，下轮将自动回收）]`;
  } else {
    rawText = JSON.stringify(res ?? {});
  }

  return {
    ok: !res.isError,
    output: truncateMcpOutput(rawText, MAX_MCP_OUTPUT_CHARS),
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * 外部 MCP 桥接管理器（对齐 Spec 03 §5）：
 * - 所有外部工具强制注册为 Tier 3 `mcp.<serverId>.<toolName>`，绝不污染 Tier 1 Static Prefix Cache；
 * - 异步非阻塞启动、单服 10s 握手超时、故障隔离降级 `degraded`、stdio 指数退避重连（2s→10s→30s 最多 3 次）；
 * - 支持热重载优雅停进程（SIGTERM → 3s SIGKILL）与 8000 字输出截断。
 */
export class McpManager {
  private readonly entries = new Map<string, ManagedServerEntry>();
  private readonly inflightConnects = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: McpManagerDeps) {}

  /** 异步非阻塞连接所有已启用的 MCP 服务器（不阻塞主服务启动） */
  connectAllAsync(servers: McpServerConfig[]): void {
    for (const cfg of servers) {
      this.upsertEntry(cfg);
      if (cfg.enabled) {
        this.launchConnect(cfg.id);
      }
    }
  }

  /** 等待当前正在进行的连接/重载任务收尾（供测试与优雅停机使用） */
  async waitForReady(): Promise<void> {
    while (this.inflightConnects.size > 0) {
      await Promise.allSettled(Array.from(this.inflightConnects));
    }
  }

  /** 热重载 MCP 配置：先关闭已移除或变更的旧连接并注销旧工具，再连接新配置 */
  async reload(servers: McpServerConfig[]): Promise<void> {
    if (this.stopped) return;
    const nextById = new Map(servers.map((s) => [s.id, s]));

    // 1. 清理已删除或配置发生变更的旧服务
    const teardownPromises: Promise<void>[] = [];
    for (const [id, entry] of Array.from(this.entries.entries())) {
      const nextCfg = nextById.get(id);
      const nextFp = nextCfg ? JSON.stringify(nextCfg) : null;
      if (!nextCfg || nextFp !== entry.fingerprint) {
        teardownPromises.push(this.teardownEntry(id, !nextCfg));
      }
    }
    await Promise.allSettled(teardownPromises);

    // 2. 启动新增或变更的已启用服务
    const connectPromises: Promise<void>[] = [];
    for (const cfg of servers) {
      const existing = this.entries.get(cfg.id);
      const fp = JSON.stringify(cfg);
      if (existing && existing.fingerprint === fp) {
        continue;
      }
      this.upsertEntry(cfg);
      if (cfg.enabled) {
        connectPromises.push(this.connectServer(cfg.id));
      }
    }
    await Promise.allSettled(connectPromises);
  }

  /** 手动重连单个 MCP 服务器（重置退避计数） */
  async reconnect(serverId: string): Promise<McpServerStatusView | null> {
    const entry = this.entries.get(serverId);
    if (!entry) return null;
    if (!entry.config.enabled) {
      return this.toStatusView(entry);
    }
    await this.teardownEntry(serverId, false);
    entry.reconnectAttempts = 0;
    await this.connectServer(serverId);
    const updated = this.entries.get(serverId);
    return updated ? this.toStatusView(updated) : null;
  }

  /** 返回脱敏后的全部 MCP 服务器状态视图（严禁泄露任何 credentials.json 值） */
  getStatusList(): McpServerStatusView[] {
    return Array.from(this.entries.values()).map((e) => this.toStatusView(e));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const ids = Array.from(this.entries.keys());
    await Promise.allSettled(ids.map((id) => this.teardownEntry(id, true)));
  }

  private upsertEntry(cfg: McpServerConfig): ManagedServerEntry {
    const entry: ManagedServerEntry = {
      config: cfg,
      fingerprint: JSON.stringify(cfg),
      client: null,
      status: cfg.enabled ? "degraded" : "disabled",
      tools: [],
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
    this.entries.set(cfg.id, entry);
    return entry;
  }

  private launchConnect(serverId: string): void {
    const p = this.connectServer(serverId);
    this.inflightConnects.add(p);
    void p.finally(() => {
      this.inflightConnects.delete(p);
    });
  }

  private async teardownEntry(serverId: string, removeFromMap: boolean): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    if (entry.reconnectTimer !== null) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    this.deps.registry.unregisterByPrefix(`mcp.${serverId}.`);
    entry.tools = [];
    const client = entry.client;
    entry.client = null;
    if (client) {
      await client.close().catch(() => {});
    }
    if (removeFromMap) {
      this.entries.delete(serverId);
    } else if (!entry.config.enabled) {
      entry.status = "disabled";
      entry.lastError = undefined;
    }
  }

  private scheduleReconnect(serverId: string): void {
    if (this.stopped) return;
    const entry = this.entries.get(serverId);
    if (!entry || !entry.config.enabled || entry.config.transport !== "stdio") return;
    const delays = this.deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    if (entry.reconnectAttempts >= delays.length) return;
    const delayMs = delays[entry.reconnectAttempts]!;
    entry.reconnectAttempts += 1;
    if (entry.reconnectTimer !== null) {
      clearTimeout(entry.reconnectTimer);
    }
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (!this.stopped) {
        this.launchConnect(serverId);
      }
    }, delayMs);
  }

  private async connectServer(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry || !entry.config.enabled || this.stopped) return;
    const cfg = entry.config;
    const handshakeTimeoutMs = this.deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

    try {
      const creds = await this.deps.loadCredentials();
      const resolvedEnv = resolveCredentialRecord(cfg.env, creds);
      const resolvedHeaders = resolveCredentialRecord(cfg.headers, creds);

      const onUnexpectedExit = (code: number | null) => {
        const cur = this.entries.get(serverId);
        if (!cur || cur !== entry || this.stopped) return;
        cur.status = "degraded";
        cur.lastError = `子进程意外退出 (code=${code})`;
        cur.client = null;
        this.deps.registry.unregisterByPrefix(`mcp.${serverId}.`);
        cur.tools = [];
        console.warn(`[psyber][mcp] server "${serverId}" exited unexpectedly (code=${code})`);
        this.scheduleReconnect(serverId);
      };

      const client: McpTransportClient = this.deps.clientFactory
        ? this.deps.clientFactory(cfg, { env: resolvedEnv, headers: resolvedHeaders }, onUnexpectedExit)
        : cfg.transport === "stdio"
          ? new StdioMcpClient(cfg, resolvedEnv, {
              killGraceMs: this.deps.killGraceMs,
              onUnexpectedExit,
            })
          : new StreamableHttpMcpClient(cfg, resolvedHeaders, this.deps.fetchImpl);

      await client.initialize(handshakeTimeoutMs);
      const discovered = await client.listTools(handshakeTimeoutMs);

      // 若握手期间配置已被热更新或停机，立即丢弃过期连接
      if (this.stopped || this.entries.get(serverId) !== entry) {
        await client.close().catch(() => {});
        return;
      }

      entry.client = client;
      entry.status = "connected";
      entry.lastError = undefined;
      entry.reconnectAttempts = 0;
      this.registerDiscoveredTools(entry, discovered);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.status = "degraded";
      entry.lastError = msg;
      this.deps.registry.unregisterByPrefix(`mcp.${serverId}.`);
      entry.tools = [];
      console.warn(`[psyber][mcp] server "${serverId}" degraded: ${msg}`);
    }
  }

  private registerDiscoveredTools(entry: ManagedServerEntry, discovered: McpToolSpec[]): void {
    const cfg = entry.config;
    const prefix = `mcp.${cfg.id}.`;
    this.deps.registry.unregisterByPrefix(prefix);

    const includeSet = cfg.includeTools ? new Set(cfg.includeTools) : null;
    const excludeSet = cfg.excludeTools ? new Set(cfg.excludeTools) : null;
    const autoAllowSet = new Set(cfg.autoAllowTools ?? []);
    const timeoutMs = clampMcpTimeoutMs(cfg.timeoutMs);

    const registeredNames: string[] = [];
    for (const spec of discovered) {
      if (includeSet && !includeSet.has(spec.name)) continue;
      if (excludeSet && excludeSet.has(spec.name)) continue;

      const fullName = `${prefix}${spec.name}`;
      const isAuto = cfg.trustLevel === "auto" || autoAllowSet.has(spec.name);
      const descPrefix = cfg.description ? `[${cfg.description}] ` : "";
      this.deps.registry.register({
        name: fullName,
        tier: 3,
        security: isAuto ? "auto" : "confirm",
        description: `${descPrefix}${spec.description || `外部 MCP 工具 ${spec.name}`}`,
        tags: ["mcp", cfg.id, spec.name],
        parameters: spec.inputSchema ?? { type: "object", properties: {} },
        execute: async (args, ctx) => {
          const current = this.entries.get(cfg.id);
          if (!current || !current.client || current.status !== "connected") {
            return {
              ok: false,
              output: `外部 MCP 服务 "${cfg.id}" 当前不可用（状态：${current?.status ?? "disconnected"}）`,
            };
          }
          try {
            const callRes = await current.client.callTool(spec.name, args, timeoutMs, ctx.signal);
            return formatMcpCallResult(callRes);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, output: `外部 MCP 工具 "${fullName}" 调用失败：${msg}` };
          }
        },
      });
      registeredNames.push(fullName);
    }

    entry.tools = registeredNames;
  }

  private toStatusView(entry: ManagedServerEntry): McpServerStatusView {
    const cfg = entry.config;
    return {
      id: cfg.id,
      enabled: cfg.enabled,
      transport: cfg.transport,
      ...(cfg.description ? { description: cfg.description } : {}),
      ...(cfg.command ? { command: cfg.command } : {}),
      ...(cfg.args ? { args: cfg.args } : {}),
      ...(cfg.url ? { url: cfg.url } : {}),
      trustLevel: cfg.trustLevel ?? "confirm",
      ...(cfg.autoAllowTools ? { autoAllowTools: cfg.autoAllowTools } : {}),
      timeoutMs: clampMcpTimeoutMs(cfg.timeoutMs),
      status: entry.status,
      toolCount: entry.tools.length,
      tools: [...entry.tools],
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
    };
  }
}
