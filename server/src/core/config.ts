import fs from "node:fs/promises";
import path from "node:path";

export type DoorState = "open" | "quiet" | "closed";

export interface PairedDevice {
  /** 设备唯一 ID */
  deviceId: string;
  /** Bearer Token 的 SHA-256 十六进制哈希（绝不明文存盘） */
  tokenHash: string;
  /** 设备展示名 */
  deviceName: string;
  /** 平台标识（macos / ios / android / windows / web） */
  platform: string;
  /** 配对时间戳（Unix 毫秒） */
  createdAt: number;
  /** 最近活跃时间戳（Unix 毫秒） */
  lastSeenAt: number;
}

/**
 * 召回引擎可调参数（集中维护于 <dataDir>/config.json 的 recall 节点）。
 */
export interface RecallConfig {
  /** 单轮注入记忆卡片的字符总预算（单位：字符，默认 3200；调大可塞入更多历史细节但增加单轮上下文开销，调小更精简但可能截断长卡） */
  charBudget: number;
  /** 同一会话内已召回卡片的去重冷却窗口（单位：分钟，默认 120；调大减少重复提及旧事，调小允许更频繁再次提起） */
  dedupWindowMin: number;
  /** 闲聊时补挂近期日常卡片的时间窗口（单位：小时，默认 72；调大覆盖更多前几天日常，调小只看最近一两天） */
  recentDailyWindowHours: number;
  /** Embedding 向量请求单次超时阈值（单位：毫秒，默认 2500；调小更快降级为本地 FTS5，调大容忍慢网络但增加首字延迟） */
  embedTimeoutMs: number;
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  charBudget: 3200,
  dedupWindowMin: 120,
  recentDailyWindowHours: 72,
  embedTimeoutMs: 2500,
};

/**
 * 单住户实例核心配置（存盘于 <dataDir>/config.json，绝不含明文密钥）。
 */
export interface PsyberConfig {
  /** 实例唯一 UUID，用于多地址防串连校验与抽屉域分离；首次初始化生成，不可静默重置 */
  instanceId: string;
  /** IANA 时区标识，默认 "Asia/Shanghai"；影响本地日切分、作息静默窗、TTL 到期日与热备命名 */
  timezone: string;
  /** 一扇门状态机（Ring 1 仅开放 open/quiet/closed） */
  door: {
    /** 当前门状态，默认 "open"；设为 "closed" 时发消息落盘为 door_note 且不唤醒 AI */
    state: DoorState;
    /** 门牌留给对方的简短便签，默认 null */
    note: string | null;
    /** 最近一次门状态变更时间戳（Unix 毫秒） */
    updatedAt: number;
  };
  /** 已配对客户端设备列表（仅存 token 哈希） */
  auth: {
    devices: PairedDevice[];
  };
  /** 召回可调参数（缺失字段自动回落 DEFAULT_RECALL_CONFIG） */
  recall?: RecallConfig;
}

/**
 * 原子写文件（同文件系统 .tmp 暂存 + fsync 刷盘 + rename 替换），防止断电留下半截文件。
 */
export async function atomicWriteFile(
  dataDir: string,
  absTarget: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(absTarget), { recursive: true });
  const tmpDir = path.join(dataDir, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.tmp`);
  const fh = await fs.open(tmpPath, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, absTarget);
}

/** 初始化单住户数据目录骨架（Ring 1 仅建必需目录） */
export async function initDataDir(dataDir: string): Promise<void> {
  const dirs = [
    dataDir,
    path.join(dataDir, ".tmp"),
    path.join(dataDir, "media"),
    path.join(dataDir, "stickers"),
    path.join(dataDir, "backups"),
    path.join(dataDir, "memory"),
    path.join(dataDir, "memory", "daily"),
    path.join(dataDir, "memory", "shelf"),
    path.join(dataDir, "memory", "favorite"),
    path.join(dataDir, "memory", "gist", "days"),
    path.join(dataDir, "memory", "gist", "weeks"),
    path.join(dataDir, "memory", "activities"),
    path.join(dataDir, "memory", "entities"),
  ];
  for (const d of dirs) {
    await fs.mkdir(d, { recursive: true });
  }
}

/**
 * 读取或首次创建 config.json。
 * 仅在文件不存在（ENOENT）时初始化新配置；若文件损坏或无权限则显式抛错，绝不静默覆盖 instanceId。
 */
export async function loadOrCreateConfig(
  dataDir: string,
  nowMs: number,
  defaultTimeZone = "Asia/Shanghai",
): Promise<PsyberConfig> {
  const configPath = path.join(dataDir, "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`无法读取配置文件 ${configPath}: ${(err as Error).message}`);
    }
    const cfg: PsyberConfig = {
      instanceId: crypto.randomUUID(),
      timezone: defaultTimeZone,
      door: {
        state: "open",
        note: null,
        updatedAt: nowMs,
      },
      auth: {
        devices: [],
      },
      recall: { ...DEFAULT_RECALL_CONFIG },
    };
    await saveConfig(dataDir, cfg);
    return cfg;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 ${configPath} JSON 损坏，已拒绝覆盖以保护 instanceId: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${configPath} 结构非法，顶层必须为 JSON 对象`);
  }
  const cfg = parsed as Partial<PsyberConfig>;
  if (typeof cfg.instanceId !== "string" || !cfg.instanceId.trim()) {
    throw new Error(`配置文件 ${configPath} 缺少有效 instanceId`);
  }
  return {
    instanceId: cfg.instanceId,
    timezone: typeof cfg.timezone === "string" && cfg.timezone.trim() ? cfg.timezone : defaultTimeZone,
    door: cfg.door ?? { state: "open", note: null, updatedAt: nowMs },
    auth: {
      devices: Array.isArray(cfg.auth?.devices) ? cfg.auth.devices : [],
    },
    recall: {
      ...DEFAULT_RECALL_CONFIG,
      ...(cfg.recall ?? {}),
    },
  };
}

export async function saveConfig(dataDir: string, cfg: PsyberConfig): Promise<void> {
  const targetPath = path.join(dataDir, "config.json");
  await atomicWriteFile(dataDir, targetPath, JSON.stringify(cfg, null, 2) + "\n");
}
