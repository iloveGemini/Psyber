import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../src/api/app.ts";
import { buildDiscoveryAnnounce } from "../src/api/discovery.ts";
import { PairingManager } from "../src/api/pairing.ts";
import { encodeQrMatrix, renderTerminalQr } from "../src/api/qr.ts";
import { SseHub } from "../src/engine/sse.ts";
import { bootPsyberRuntime, type PsyberRuntime } from "../src/index.ts";
import { createTestContext, type TestContext } from "./helpers.ts";

let ctx: TestContext | null = null;
const runtimes: PsyberRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    const rt = runtimes.pop();
    if (rt) await rt.stop();
  }
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe("配对安全补强、本机免码、二维码签发与局域网自动发现", () => {
  test("按 IP 独立限流、Origin 守卫、本机免码、二维码签发与吊销即断 SSE", async () => {
    ctx = await createTestContext();
    const pairing = new PairingManager(ctx.clock);
    const localKey = pairing.issueLocalSecret();
    const sse = new SseHub();
    const sampleLanUrl = "http://lan-peer.local:3721";

    const app = createApp({
      version: "0.1.0",
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      getActiveSessionId: () => "sess-1",
      dataDir: ctx.dataDir,
      db: ctx.db,
      memoryIndex: ctx.index,
      pairing,
      sse,
      getClientIp: (req) => req.headers.get("x-client-ip") ?? "localhost",
      getPairUrls: () => [sampleLanUrl],
    });

    const issued = pairing.issueCode();
    for (let i = 0; i < 5; i++) {
      const bad = await app.request("/api/v1/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json", "x-client-ip": "peer-a" },
        body: JSON.stringify({ code: "XXXX-YYYY", deviceName: "A", platform: "ios" }),
      });
      expect(bad.status).toBe(401);
    }
    const lockedA = await app.request("/api/v1/auth/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-ip": "peer-a" },
      body: JSON.stringify({ code: issued.code, deviceName: "A", platform: "ios" }),
    });
    expect(lockedA.status).toBe(429);

    const crossOrigin = await app.request("http://localhost:3721/api/v1/auth/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://external.example",
        "x-client-ip": "peer-b",
      },
      body: JSON.stringify({ code: issued.code, deviceName: "Web", platform: "web" }),
    });
    expect(crossOrigin.status).toBe(403);

    const browserLocal = await app.request("http://localhost:3721/api/v1/auth/local-pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3721",
        "x-client-ip": "localhost",
      },
      body: JSON.stringify({ secret: localKey, deviceName: "Web", platform: "web" }),
    });
    expect(browserLocal.status).toBe(403);

    const lanLocal = await app.request("/api/v1/auth/local-pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-ip": "peer-lan" },
      body: JSON.stringify({ secret: localKey, deviceName: "LAN", platform: "macos" }),
    });
    expect(lanLocal.status).toBe(403);

    const badLocal = await app.request("/api/v1/auth/local-pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-ip": "localhost" },
      body: JSON.stringify({ secret: "0".repeat(64), deviceName: "Mac", platform: "macos" }),
    });
    expect(badLocal.status).toBe(401);

    const okLocal = await app.request("/api/v1/auth/local-pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-ip": "localhost" },
      body: JSON.stringify({ secret: localKey, deviceName: "Mac", platform: "macos" }),
    });
    expect(okLocal.status).toBe(200);
    const devA = (await okLocal.json()) as { token: string; deviceId: string };

    const qrRes = await app.request("/api/v1/auth/pair-code", {
      method: "POST",
      headers: { authorization: `Bearer ${devA.token}` },
    });
    expect(qrRes.status).toBe(200);
    const qrJson = (await qrRes.json()) as { code: string; urls: string[]; qrPayload: string };
    expect(qrJson.urls).toEqual([sampleLanUrl]);
    const parsedQr = JSON.parse(qrJson.qrPayload) as { v: number; urls: string[]; code: string };
    expect(parsedQr.v).toBe(1);
    expect(parsedQr.code).toBe(qrJson.code);

    const okB = await app.request("/api/v1/auth/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-ip": "peer-b" },
      body: JSON.stringify({ code: parsedQr.code, deviceName: "iPhone", platform: "ios" }),
    });
    expect(okB.status).toBe(200);
    const devB = (await okB.json()) as { token: string; deviceId: string };

    const acA = new AbortController();
    const acB = new AbortController();
    const streamA = await app.request("/api/v1/stream", {
      headers: { authorization: `Bearer ${devA.token}` },
      signal: acA.signal,
    });
    const streamB = await app.request("/api/v1/stream", {
      headers: { authorization: `Bearer ${devB.token}` },
      signal: acB.signal,
    });
    const readerA = streamA.body!.getReader();
    const readerB = streamB.body!.getReader();
    await readerA.read();
    await readerB.read();
    expect(sse.subscriberCount).toBe(2);

    const revokeB = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${devA.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ revokeDeviceIds: [devB.deviceId] }),
    });
    expect(revokeB.status).toBe(200);
    expect(sse.subscriberCount).toBe(1);
    expect((await readerB.read()).done).toBe(true);

    sse.emit("door.updated", { state: "open", note: null, updatedAt: ctx.clock.now() });
    expect((await readerA.read()).done).toBe(false);
    acA.abort();
    acB.abort();

    const matrix = encodeQrMatrix(qrJson.qrPayload);
    expect(matrix.size).toBeGreaterThanOrEqual(21);
    expect(matrix.modules[0]).toBe(1);
    expect(renderTerminalQr(qrJson.qrPayload).split("\n").length).toBeGreaterThan(10);
  });

  test("bootPsyberRuntime 写入 0600 local_pair.json 且停机自动清理，局域网发现仅广播非敏感信息", async () => {
    ctx = await createTestContext();
    const rt = await bootPsyberRuntime({
      dataDir: ctx.dataDir,
      clock: ctx.clock,
      startHeartbeatTimer: false,
      catchUpMissedBedtime: false,
      writeLocalPairFile: true,
      httpPort: 3721,
    });
    runtimes.push(rt);

    const localPairPath = path.join(ctx.dataDir, "local_pair.json");
    const parsed = JSON.parse(await fs.readFile(localPairPath, "utf-8")) as {
      secret: string;
      port: number;
      instanceId: string;
    };
    expect(parsed.secret.length).toBe(64);
    expect(parsed.port).toBe(3721);
    expect(parsed.instanceId).toBe(rt.config.instanceId);

    const announce = buildDiscoveryAnnounce(
      JSON.stringify({ type: "psyber.discover", v: 1, nonce: "n-1" }),
      {
        httpPort: 3721,
        protocol: "http",
        version: "0.1.0",
        getInstanceId: () => rt.config.instanceId,
        getResidentName: () => "Psyber",
        getUrls: () => ["http://lan-peer.local:3721"],
      },
    );
    expect(announce).not.toBeNull();
    expect(announce!.type).toBe("psyber.announce");
    expect(announce!.nonce).toBe("n-1");
    expect(announce!.instanceId).toBe(rt.config.instanceId);
    expect(announce!.urls).toEqual(["http://lan-peer.local:3721"]);
    expect("code" in announce!).toBe(false);
    expect("token" in announce!).toBe(false);
    expect(
      buildDiscoveryAnnounce("not-json", {
        httpPort: 3721,
        version: "0.1.0",
        getInstanceId: () => "x",
      }),
    ).toBeNull();

    await rt.stop();
    runtimes.pop();
    await expect(fs.access(localPairPath)).rejects.toThrow();
  });

  test("SseHub.disconnectAll 立即断流且 runtime.stop 支持超时不挂死", async () => {
    ctx = await createTestContext();
    const rt = await bootPsyberRuntime({
      dataDir: ctx.dataDir,
      clock: ctx.clock,
      startHeartbeatTimer: false,
      catchUpMissedBedtime: false,
    });
    runtimes.push(rt);

    let closedCount = 0;
    rt.sse.subscribe(() => {}, {
      deviceId: "dev-1",
      onClose: () => {
        closedCount += 1;
      },
    });
    rt.sse.subscribe(() => {}, {
      deviceId: "dev-2",
      onClose: () => {
        closedCount += 1;
      },
    });
    expect(rt.sse.subscriberCount).toBe(2);

    await rt.stop({ waitTimeoutMs: 50 });
    runtimes.pop();
    expect(closedCount).toBe(2);
    expect(rt.sse.subscriberCount).toBe(0);
  });

  test("同一 clientId 重复配对/本机免码原地轮换令牌且不新增重复设备", async () => {
    ctx = await createTestContext();
    const pairing = new PairingManager(ctx.clock);
    const localKey = pairing.issueLocalSecret();
    const sse = new SseHub();
    const app = createApp({
      version: "0.1.0",
      clock: ctx.clock,
      getConfig: () => ctx!.config,
      events: ctx.events,
      getActiveSessionId: () => "sess-1",
      dataDir: ctx.dataDir,
      db: ctx.db,
      memoryIndex: ctx.index,
      pairing,
      sse,
      getClientIp: () => "127.0.0.1",
    });

    const initialCount = ctx.config.auth.devices.length;
    const first = await app.request("/api/v1/auth/local-pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: localKey,
        deviceName: "Mac",
        platform: "macos",
        clientId: "cid_mac_stable_001",
      }),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { deviceId: string; token: string };
    expect(ctx.config.auth.devices.length).toBe(initialCount + 1);

    // 同一 clientId 再次免码配对：沿用原 deviceId、轮换 token、设备数不增加
    const second = await app.request("/api/v1/auth/local-pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: localKey,
        deviceName: "Mac",
        platform: "macos",
        clientId: "cid_mac_stable_001",
      }),
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { deviceId: string; token: string };
    expect(secondJson.deviceId).toBe(firstJson.deviceId);
    expect(secondJson.token).not.toBe(firstJson.token);
    expect(ctx.config.auth.devices.length).toBe(initialCount + 1);

    // 旧令牌立即失效，新令牌可用
    const oldRes = await app.request("/api/v1/door", {
      headers: { authorization: `Bearer ${firstJson.token}` },
    });
    expect(oldRes.status).toBe(401);
    const newRes = await app.request("/api/v1/door", {
      headers: { authorization: `Bearer ${secondJson.token}` },
    });
    expect(newRes.status).toBe(200);
  });
});
