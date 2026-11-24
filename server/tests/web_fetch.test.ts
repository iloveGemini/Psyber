import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashBearerToken } from "../src/api/app.ts";
import { VirtualClock } from "../src/core/clock.ts";
import { saveConfig } from "../src/core/config.ts";
import { MCP_PRESETS } from "../src/extensions/mcp.ts";
import {
  extractReadableTextFromHtml,
  isPrivateOrReservedIp,
  registerWebFetchTool,
  validateFetchUrl,
} from "../src/extensions/web_fetch.ts";
import { bootPsyberRuntime } from "../src/index.ts";
import { ToolRegistry, type ToolExecutionContext } from "../src/tools/registry.ts";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeCtx(): ToolExecutionContext {
  return {
    turnId: "turn-web-1",
    sessionId: "sess-web-1",
    mode: "chat",
    touchedMemoryPaths: new Set<string>(),
    expressionCount: 0,
    expressions: [],
  };
}

describe("内置 web_fetch 工具与 Tavily 预设优化", () => {
  test("内网防护守卫：拦截私网 IP、非 http 协议、内网域名（含尾随点）与 DNS 指向内网", async () => {
    for (const ip of [
      "10.0.0.1",
      "172.16.5.1",
      "192.168.1.10",
      "100.64.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "64:ff9b::7f00:1",
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);

    for (const badUrl of [
      "ftp://example.com/a.txt",
      "http://localhost./status",
      "http://mybox.local/status",
      "http://mybox.local./status",
      "http://app.internal/panel",
    ]) {
      const res = await validateFetchUrl(badUrl, { skipDnsLookup: true });
      expect(res.ok).toBe(false);
    }

    const dnsBlocked = await validateFetchUrl("https://private-dns.example.test/page", {
      resolveHostIps: async () => ["10.20.30.40"],
    });
    expect(dnsBlocked.ok).toBe(false);

    const dnsAllowed = await validateFetchUrl("https://public.example.test/page", {
      resolveHostIps: async () => ["93.184.216.34"],
    });
    expect(dnsAllowed.ok).toBe(true);
  });

  test("HTML 正文提取、重定向复检、二进制拒绝与长度截断", async () => {
    const html = [
      "<!doctype html><html>",
      "<head><title>Psyber &amp; Friends</title></head>",
      "<body><nav>首页 登录</nav><article>",
      "<h1>关于本地陪伴系统</h1>",
      "<p>这是一段足够长的正文内容，用来确保文章提取器优先选中 article 主体而不是导航栏杂项，同时保留自然的换行和列表结构。</p>",
      "<ul><li>第一条特性</li><li>第二条特性</li></ul>",
      "</article><footer>版权所有</footer></body></html>",
    ].join("");

    const extracted = extractReadableTextFromHtml(html);
    expect(extracted.title).toBe("Psyber & Friends");
    expect(extracted.text).toContain("# 关于本地陪伴系统");
    expect(extracted.text).toContain("- 第一条特性");
    expect(extracted.text).not.toContain("首页 登录");

    const mockFetch: typeof fetch = (async (input) => {
      const url = String(input);
      if (url === "https://public.example.test/article") {
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url === "https://public.example.test/redirect-local") {
        return new Response("", {
          status: 302,
          headers: { location: "http://mybox.local/status" },
        });
      }
      if (url === "https://public.example.test/long") {
        return new Response("长".repeat(1500), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url === "https://public.example.test/image.png") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url === "https://public.example.test/unknown.bin") {
        return new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03]), {
          status: 200,
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    let dnsCalls = 0;
    const registry = new ToolRegistry();
    registerWebFetchTool(registry, {
      fetchImpl: mockFetch,
      resolveHostIps: async () => {
        dnsCalls += 1;
        return ["93.184.216.34"];
      },
    });

    const okRes = await registry.invoke(
      "web_fetch",
      { url: "https://public.example.test/article" },
      makeCtx(),
    );
    expect(okRes.ok).toBe(true);
    expect(okRes.output).toContain("标题：Psyber & Friends");
    expect(okRes.output).toContain("# 关于本地陪伴系统");
    // guard 阶段不重复执行 DNS 查询，单跳仅查询一次
    expect(dnsCalls).toBe(1);

    const redirRes = await registry.invoke(
      "web_fetch",
      { url: "https://public.example.test/redirect-local" },
      makeCtx(),
    );
    expect(redirRes.ok).toBe(false);
    expect(redirRes.output).toContain("已拦截");

    const longRes = await registry.invoke(
      "web_fetch",
      { url: "https://public.example.test/long", maxChars: 600 },
      makeCtx(),
    );
    expect(longRes.ok).toBe(true);
    expect(longRes.output).toContain("[网页正文已截断，原始长度 1500 字符]");

    const binRes = await registry.invoke(
      "web_fetch",
      { url: "https://public.example.test/image.png" },
      makeCtx(),
    );
    expect(binRes.ok).toBe(false);
    expect(binRes.output).toContain("非文本内容");

    const rawBinRes = await registry.invoke(
      "web_fetch",
      { url: "https://public.example.test/unknown.bin" },
      makeCtx(),
    );
    expect(rawBinRes.ok).toBe(false);
    expect(rawBinRes.output).toContain("二进制");
  });

  test("集成注册：web_fetch 归类为「联网与浏览」且 Tavily 预设仅白名单只读工具免审批", async () => {
    const tavily = MCP_PRESETS.find((p) => p.id === "tavily");
    expect(tavily).toBeDefined();
    expect(tavily?.trustLevel).toBe("confirm");
    expect(tavily?.autoAllowTools).toContain("tavily-search");
    expect(tavily?.autoAllowTools).toContain("tavily-extract");

    const dataDir = await makeTempDir("psyber-webfetch-boot-");
    const clock = new VirtualClock(Date.parse("2026-11-24T05:10:00Z"), "Asia/Shanghai");
    const rt = await bootPsyberRuntime({ dataDir, clock, startHeartbeatTimer: false });
    try {
      const token = "psb_webfetch_1";
      rt.config.auth.devices.push({
        deviceId: "dev-1",
        tokenHash: hashBearerToken(token),
        deviceName: "Mac",
        platform: "macos",
        createdAt: clock.now(),
        lastSeenAt: clock.now(),
      });
      await saveConfig(dataDir, rt.config);

      const res = await rt.app.request("/api/v1/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        tools: Array<{ name: string; tier: number; category: string; security: string; locked: boolean }>;
      };
      const wf = json.tools.find((t) => t.name === "web_fetch");
      expect(wf).toBeDefined();
      expect(wf?.tier).toBe(3);
      expect(wf?.category).toBe("联网与浏览");
      expect(wf?.security).toBe("auto");
      expect(wf?.locked).toBe(false);
    } finally {
      await rt.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
