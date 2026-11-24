import dns from "node:dns/promises";
import net from "node:net";
import type { ToolExecutionContext, ToolRegistry } from "../tools/registry.ts";

export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 15_000;
export const MIN_WEB_FETCH_TIMEOUT_MS = 1_000;
export const MAX_WEB_FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_WEB_FETCH_MAX_CHARS = 8_000;
export const MIN_WEB_FETCH_MAX_CHARS = 500;
export const MAX_WEB_FETCH_MAX_CHARS = 20_000;
export const MAX_WEB_FETCH_BYTES = 2 * 1024 * 1024;
export const MAX_WEB_FETCH_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

const ALLOWED_TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/ld+json",
  "application/javascript",
  "application/x-javascript",
];

const NOISE_TAGS = ["script", "style", "noscript", "svg", "iframe", "template", "head"];
const LAYOUT_NOISE_TAGS = ["nav", "footer", "aside"];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/**
 * 判定 IP（v4 / v6 / IPv4-mapped IPv6）是否属于私网、回环、链路本地或保留地址段。
 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const stripped = rawIp.trim().replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  const ver = net.isIP(stripped);
  if (ver === 4) {
    return isPrivateIpv4(stripped);
  }
  if (ver !== 6) {
    return true;
  }

  if (stripped === "::" || stripped === "::1") return true;

  if (stripped.startsWith("::ffff:")) {
    const rest = stripped.slice(7);
    if (net.isIP(rest) === 4) {
      return isPrivateIpv4(rest);
    }
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      const ipv4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isPrivateIpv4(ipv4);
    }
  }

  // 拦截 NAT64（64:ff9b::/96、64:ff9b:1::/48）、丢弃段（100::/64）与文档段（2001:db8::/32）
  if (stripped.startsWith("64:ff9b:") || stripped.startsWith("100::") || stripped.startsWith("2001:db8:")) {
    return true;
  }

  const firstGroup = stripped.split(":")[0] || "0";
  const firstWord = parseInt(firstGroup, 16);
  if (Number.isNaN(firstWord)) return true;
  if ((firstWord & 0xfe00) === 0xfc00) return true;
  if ((firstWord & 0xffc0) === 0xfe80) return true;
  if ((firstWord & 0xffc0) === 0xfec0) return true;
  if ((firstWord & 0xff00) === 0xff00) return true;
  return false;
}

export interface UrlGuardOptions {
  /** 可注入 DNS 解析函数；未提供且使用真实 fetch 时走系统 dns.lookup */
  resolveHostIps?: (hostname: string) => Promise<string[]>;
  /** 为 true 时跳过真实 DNS 查询（仅在离线测试注入 mock fetch 且未传 resolveHostIps 时启用） */
  skipDnsLookup?: boolean;
}

/**
 * 严格校验目标 URL 合法性与内网访问防护边界（协议、主机名、IP 字面量与 DNS 解析结果）。
 */
export async function validateFetchUrl(
  rawUrl: string,
  opts: UrlGuardOptions = {},
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, reason: "url 不能为空。" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `非法 URL：${rawUrl}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `仅允许 http/https 协议，已拦截：${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "禁止在 URL 中嵌入账号或密码凭据。" };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) {
    return { ok: false, reason: "URL 缺少有效主机名。" };
  }
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return { ok: false, reason: `已拦截本机或内网主机名访问：${host}` };
  }

  if (net.isIP(host) !== 0) {
    if (isPrivateOrReservedIp(host)) {
      return { ok: false, reason: `已拦截私网或回环 IP 访问：${host}` };
    }
    return { ok: true, url: parsed };
  }
  if (/^\d+$/.test(host)) {
    return { ok: false, reason: `已拦截纯数字 IP 访问：${host}` };
  }

  if (!opts.skipDnsLookup) {
    const resolver =
      opts.resolveHostIps ??
      (async (h: string) => {
        const records = await dns.lookup(h, { all: true });
        return records.map((r) => r.address);
      });
    let ips: string[];
    try {
      ips = await resolver(host);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `无法解析主机名 ${host}：${msg}` };
    }
    if (ips.length === 0) {
      return { ok: false, reason: `主机名 ${host} 未解析到有效 IP 地址。` };
    }
    for (const ip of ips) {
      if (isPrivateOrReservedIp(ip)) {
        return {
          ok: false,
          reason: `已拦截指向私网或回环地址的域名：${host} -> ${ip}`,
        };
      }
    }
  }

  return { ok: true, url: parsed };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    });
}

function stripTagBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    out = out.replace(re, " ");
  }
  return out;
}

/**
 * 零依赖 HTML 正文提取：去除脚本/样式/导航噪点，优先提取 article/main 并保留标题与列表换行。
 */
export function extractReadableTextFromHtml(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() || null
    : null;

  let cleaned = stripTagBlocks(html.replace(/<!--[\s\S]*?-->/g, " "), NOISE_TAGS);

  const articleMatch = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned);
  const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned);
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned);

  const candidate =
    articleMatch && articleMatch[1]!.replace(/<[^>]+>/g, "").trim().length >= 120
      ? articleMatch[1]!
      : mainMatch && mainMatch[1]!.replace(/<[^>]+>/g, "").trim().length >= 120
        ? mainMatch[1]!
        : bodyMatch
          ? bodyMatch[1]!
          : cleaned;

  cleaned = stripTagBlocks(candidate, LAYOUT_NOISE_TAGS)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => {
      const hashes = "#".repeat(Math.max(1, Math.min(6, Number(lvl) || 2)));
      const heading = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return heading ? `\n\n${hashes} ${heading}\n\n` : "\n";
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|blockquote|pre|ul|ol|li|dt|dd)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const decoded = decodeHtmlEntities(cleaned)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, text: decoded };
}

export function truncateWebContent(text: string, maxChars = DEFAULT_WEB_FETCH_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[网页正文已截断，原始长度 ${text.length} 字符]`;
}

function clampTimeoutMs(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_WEB_FETCH_TIMEOUT_MS;
  return Math.max(MIN_WEB_FETCH_TIMEOUT_MS, Math.min(MAX_WEB_FETCH_TIMEOUT_MS, Math.floor(raw)));
}

function clampMaxChars(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_WEB_FETCH_MAX_CHARS;
  return Math.max(MIN_WEB_FETCH_MAX_CHARS, Math.min(MAX_WEB_FETCH_MAX_CHARS, Math.floor(raw)));
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

async function readResponseBytesCapped(
  resp: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
  const body = resp.body;
  if (!body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return { bytes: buf.subarray(0, maxBytes), truncatedByBytes: true };
    }
    return { bytes: buf, truncatedByBytes: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncatedByBytes = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        const remain = maxBytes - total;
        if (remain > 0) chunks.push(value.subarray(0, remain));
        truncatedByBytes = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: merged, truncatedByBytes };
}

function hasNullByte(bytes: Uint8Array, probeLimit = 4096): boolean {
  const len = Math.min(bytes.byteLength, probeLimit);
  for (let i = 0; i < len; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function isAllowedTextContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime) return true;
  return ALLOWED_TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

export interface RegisterWebFetchToolDeps {
  /** 可注入 fetch 实现（用于离线测试或自定义网络层） */
  fetchImpl?: typeof fetch;
  /** 可注入 DNS 解析函数（用于离线测试域名解析拦截） */
  resolveHostIps?: (hostname: string) => Promise<string[]>;
  /** 显式跳过 DNS 解析检查（仅限离线单测，严禁在生产环境开启） */
  skipDnsLookup?: boolean;
}

/**
 * 注册 Tier 3 内置轻量联网抓页工具 `web_fetch`：
 * - 零外部依赖，开箱即用读公开网页/文档/JSON；
 * - 内置内网访问防护（协议/主机名/IPv4/IPv6/DNS 解析拦截 + 手动跟随重定向逐跳复检；注：基于 fetch 的校验仍存在极短 DNS Rebinding 窗口）；
 * - 自动剥离脚本/样式/导航噪点提取正文并按上限截断。
 */
export function registerWebFetchTool(
  registry: ToolRegistry,
  deps: RegisterWebFetchToolDeps = {},
): void {
  const fetchFn = deps.fetchImpl ?? fetch;
  const guardOpts: UrlGuardOptions = {
    resolveHostIps: deps.resolveHostIps,
    skipDnsLookup: deps.skipDnsLookup === true,
  };

  registry.register({
    name: "web_fetch",
    tier: 3,
    security: "auto",
    description:
      "抓取公开网页、文章或文档正文（内置内网访问防护、HTML 正文提取与长度截断，免审批只读）。适合阅读用户发来的链接或查阅在线资料。",
    tags: ["web", "network", "fetch", "url", "网页", "链接", "阅读"],
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "必填：公开的 http:// 或 https:// 网页地址" },
        maxChars: {
          type: "integer",
          description: "可选：返回正文最大字符数（500–20000，默认 8000）",
        },
        timeoutMs: {
          type: "integer",
          description: "可选：请求超时毫秒数（1000–60000，默认 15000）",
        },
      },
      required: ["url"],
    },
    guard: async (args) => {
      // guard 阶段仅做零网络开销的静态 URL/主机名/IP 字面量校验，避免与 execute 第 0 跳重复执行 DNS 查询
      const check = await validateFetchUrl(String(args.url ?? ""), { skipDnsLookup: true });
      return check.ok ? { ok: true } : { ok: false, reason: check.reason };
    },
    execute: async (args, ctx: ToolExecutionContext) => {
      const timeoutMs = clampTimeoutMs(
        typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      );
      const maxChars = clampMaxChars(
        typeof args.maxChars === "number" ? args.maxChars : undefined,
      );

      let currentUrl = String(args.url ?? "").trim();
      const signal = combineAbortSignals(timeoutMs, ctx.signal);
      let resp: Response | null = null;

      try {
        for (let hop = 0; hop <= MAX_WEB_FETCH_REDIRECTS; hop += 1) {
          const check = await validateFetchUrl(currentUrl, guardOpts);
          if (!check.ok) {
            return { ok: false, output: check.reason };
          }
          const res = await fetchFn(check.url.toString(), {
            method: "GET",
            redirect: "manual",
            headers: {
              "user-agent": "Psyber/0.1 (readable-web-fetch)",
              accept: "text/html, application/xhtml+xml, text/plain, application/json;q=0.9, */*;q=0.5",
            },
            signal,
          });

          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) {
              return { ok: false, output: `网页返回重定向 (${res.status}) 但缺少 Location 头。` };
            }
            if (hop === MAX_WEB_FETCH_REDIRECTS) {
              return { ok: false, output: `网页重定向次数超过上限（${MAX_WEB_FETCH_REDIRECTS} 次）。` };
            }
            currentUrl = new URL(loc, check.url).toString();
            continue;
          }

          resp = res;
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, output: `抓取网页失败：${msg}` };
      }

      if (!resp) {
        return { ok: false, output: "未能获取网页响应。" };
      }
      if (!resp.ok) {
        return { ok: false, output: `网页请求失败：HTTP ${resp.status} ${resp.statusText}`.trim() };
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (!isAllowedTextContentType(contentType)) {
        return {
          ok: false,
          output: `不支持抓取非文本内容（Content-Type: ${contentType || "unknown"}）。`,
        };
      }

      const { bytes: rawBytes } = await readResponseBytesCapped(resp, MAX_WEB_FETCH_BYTES);
      const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!mime && hasNullByte(rawBytes)) {
        return { ok: false, output: "响应似乎是二进制内容且未声明文本 Content-Type，已拒绝解析。" };
      }
      const rawBody = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);

      let title: string | null = null;
      let bodyText: string;

      if (mime.includes("html") || (!mime && /<(?:!doctype|html|body|article)\b/i.test(rawBody))) {
        const extracted = extractReadableTextFromHtml(rawBody);
        title = extracted.title;
        bodyText = extracted.text;
      } else if (mime.includes("json")) {
        try {
          bodyText = JSON.stringify(JSON.parse(rawBody), null, 2);
        } catch {
          bodyText = rawBody.trim();
        }
      } else {
        bodyText = rawBody.trim();
      }

      if (!bodyText) {
        return { ok: false, output: `网页未提取到可读文本内容（可能是纯前端动态渲染页）：${currentUrl}` };
      }

      const headerLines = [
        ...(title ? [`标题：${title}`] : []),
        `来源：${currentUrl}`,
      ];
      return {
        ok: true,
        output: `${headerLines.join("\n")}\n\n${truncateWebContent(bodyText, maxChars)}`,
      };
    },
  });
}
