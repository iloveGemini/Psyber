import dgram from "node:dgram";
import os from "node:os";

export const DEFAULT_DISCOVERY_PORT = 37219;

export interface DiscoveryProbePacket {
  type: "psyber.discover";
  v: 1;
  nonce?: string;
}

export interface DiscoveryAnnouncePacket {
  type: "psyber.announce";
  v: 1;
  nonce?: string;
  instanceId: string;
  residentName: string | null;
  hostname: string;
  version: string;
  protocol: "http" | "https";
  port: number;
  urls: string[];
}

/**
 * 枚举本机非回环局域网 IPv4 地址并拼装候选服务 URL，供扫码二维码与局域网发现复用。
 */
export function getLanUrls(port: number, protocol: "http" | "https" = "http"): string[] {
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (info.address.startsWith("169.254.")) continue;
      const url = `${protocol}://${info.address}:${port}`;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
}

export interface LanDiscoveryResponderOptions {
  port?: number;
  bindAddress?: string;
  httpPort: number;
  protocol?: "http" | "https";
  version: string;
  getInstanceId: () => string;
  getResidentName?: () => string | null;
  getUrls?: () => string[];
}

export interface LanDiscoveryResponder {
  readonly port: number;
  close: () => Promise<void>;
}

/**
 * 纯函数处理单条 UDP 局域网发现探测包：仅返回非敏感元信息，绝不含配对码或令牌。
 */
export function buildDiscoveryAnnounce(
  raw: Buffer | string,
  opts: LanDiscoveryResponderOptions,
): DiscoveryAnnouncePacket | null {
  const text = typeof raw === "string" ? raw : raw.toString("utf-8");
  if (text.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as Record<string, unknown>).type !== "psyber.discover"
  ) {
    return null;
  }
  const nonceRaw = (parsed as Record<string, unknown>).nonce;
  const nonce =
    typeof nonceRaw === "string" && nonceRaw.length <= 64 ? nonceRaw : undefined;
  const protocol = opts.protocol ?? "http";
  const urls = opts.getUrls?.() ?? getLanUrls(opts.httpPort, protocol);
  return {
    type: "psyber.announce",
    v: 1,
    ...(nonce ? { nonce } : {}),
    instanceId: opts.getInstanceId(),
    residentName: opts.getResidentName?.() ?? null,
    hostname: os.hostname(),
    version: opts.version,
    protocol,
    port: opts.httpPort,
    urls,
  };
}

/**
 * 局域网 UDP 自动发现应答器（仅广播非敏感元信息：instanceId、称呼与候选地址，绝不含配对码或令牌）。
 */
export async function startLanDiscoveryResponder(
  opts: LanDiscoveryResponderOptions,
): Promise<LanDiscoveryResponder> {
  const discoveryPort = opts.port ?? DEFAULT_DISCOVERY_PORT;
  const bindAddress = opts.bindAddress ?? "0.0.0.0";
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", (msg, rinfo) => {
    const payload = buildDiscoveryAnnounce(msg, opts);
    if (!payload) return;
    const buf = Buffer.from(JSON.stringify(payload), "utf-8");
    socket.send(buf, rinfo.port, rinfo.address, () => {
      // 单次发现应答失败静默忽略，绝不影响主服务
    });
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(discoveryPort, bindAddress, () => {
      socket.off("error", reject);
      resolve();
    });
  });

  const boundPort = socket.address().port;
  socket.unref?.();
  let closed = false;
  return {
    port: boundPort,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        // 兜底防止部分 Bun 版本下 dgram socket.close 回调未触发导致停机挂死
        const timer = setTimeout(done, 200);
        timer.unref?.();
        try {
          socket.close(done);
        } catch {
          done();
        }
      });
    },
  };
}
