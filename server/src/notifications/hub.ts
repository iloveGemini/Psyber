import type { Clock } from "../core/clock.ts";
import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  type PsyberConfig,
} from "../core/config.ts";

export interface NotificationPayload {
  kind: "wake" | "door_updated";
  title: string;
  body: string;
  turnId?: string;
}

export interface NotificationDispatchResult {
  suppressedReason?: "foreground_active" | "sleep_window" | "no_channels";
  sentChannels: string[];
  failedChannels: string[];
}

export interface NotificationHubDeps {
  clock: Clock;
  getConfig: () => PsyberConfig;
  hasActiveForegroundClient: () => boolean;
  /** 注入睡眠窗判定回调，严格维持 notifications/ 仅依赖 core/（不反向导入 mood/） */
  isInSleepWindow?: () => boolean;
  /** 可选凭证解析器：按 credentialKey 从 credentials.json 读取 Webhook Bearer Token */
  getCredential?: (key: string) => Promise<string | null>;
  /** 可注入桌面通知发送器，测试环境 100% 离线模拟 */
  desktopSender?: (payload: NotificationPayload) => Promise<void>;
  /** 可注入 fetch 实现，测试环境 100% 离线阻断外网 */
  fetchImpl?: typeof fetch;
}

const CHANNEL_TIMEOUT_MS = 5000;

/** 严格转义 AppleScript 双引号字符串（反斜杠、双引号与换行），防止脚本注入 */
function escapeAppleScriptString(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ");
}

async function defaultDesktopNotify(payload: NotificationPayload): Promise<void> {
  if (process.platform === "darwin") {
    const safeTitle = escapeAppleScriptString(payload.title);
    const safeBody = escapeAppleScriptString(payload.body);
    const proc = Bun.spawn([
      "osascript",
      "-e",
      `display notification "${safeBody}" with title "${safeTitle}"`,
    ]);
    await proc.exited;
  } else if (process.platform === "linux") {
    const proc = Bun.spawn(["notify-send", payload.title, payload.body]);
    await proc.exited;
  }
}

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ring 1 极简离线通知中心（desktop + 通用 webhook），带前台活跃抑制、睡眠静默窗与 5s 超时隔离。
 */
export class NotificationHub {
  constructor(private readonly deps: NotificationHubDeps) {}

  async notify(payload: NotificationPayload): Promise<NotificationDispatchResult> {
    if (this.deps.hasActiveForegroundClient()) {
      return { suppressedReason: "foreground_active", sentChannels: [], failedChannels: [] };
    }

    if (payload.kind === "wake" && this.deps.isInSleepWindow?.()) {
      return { suppressedReason: "sleep_window", sentChannels: [], failedChannels: [] };
    }

    const cfg = this.deps.getConfig();
    const notifCfg = cfg.notifications ?? DEFAULT_NOTIFICATIONS_CONFIG;
    const tasks: Array<{ channel: string; run: () => Promise<void> }> = [];

    if (notifCfg.desktop?.enabled) {
      const sender = this.deps.desktopSender ?? defaultDesktopNotify;
      tasks.push({
        channel: "desktop",
        run: () => sender(payload),
      });
    }

    if (notifCfg.webhook?.enabled && notifCfg.webhook.url) {
      const webhook = notifCfg.webhook;
      const fetchFn = this.deps.fetchImpl ?? fetch;
      tasks.push({
        channel: "webhook",
        run: async () => {
          const headers: Record<string, string> = {
            ...(webhook.headers ?? {}),
            "content-type": "application/json",
          };
          if (webhook.credentialKey && this.deps.getCredential) {
            const secret = await this.deps.getCredential(webhook.credentialKey);
            if (secret) {
              headers.authorization = `Bearer ${secret}`;
            }
          }
          const res = await fetchFn(webhook.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...payload,
              timestamp: this.deps.clock.now(),
            }),
            signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
          });
          if (!res.ok) {
            throw new Error(`Webhook HTTP ${res.status}`);
          }
        },
      });
    }

    if (tasks.length === 0) {
      return { suppressedReason: "no_channels", sentChannels: [], failedChannels: [] };
    }

    const settled = await Promise.allSettled(
      tasks.map((t) => runWithTimeout(t.run, CHANNEL_TIMEOUT_MS)),
    );

    const sentChannels: string[] = [];
    const failedChannels: string[] = [];
    settled.forEach((res, idx) => {
      if (res.status === "fulfilled") {
        sentChannels.push(tasks[idx].channel);
      } else {
        failedChannels.push(tasks[idx].channel);
      }
    });

    return { sentChannels, failedChannels };
  }
}
