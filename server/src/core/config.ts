import fs from "node:fs/promises";
import path from "node:path";

export type DoorState = "open" | "quiet" | "closed";

export interface PairedDevice {
  /** 设备唯一 ID */
  deviceId: string;
  /** 客户端安装级稳定标识（可选，同客户端重新配对时原地轮换 Token 避免设备列表重复） */
  clientId?: string;
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
export interface RecallGateConfig {
  /** 是否启用决策模型门控与候选精排（默认 true；关闭后一键回退至纯规则 + FTS 分数门槛） */
  enabled: boolean;
  /** 整轮是否需要召回的概率门槛（0..1，默认 0.35；配合 recall-gate.md v2 双边判据实测平衡误召与命中；偏高更安静，如 0.35/0.35 噪声可低至 ~23%，调低至 0.30 可进一步提升召回率） */
  threshold: number;
}

export interface RecallRerankConfig {
  /** 单张候选卡的相关性概率门槛（0..1，默认 0.30；调高至 0.35 可进一步压低噪声卡，调低保留更多联想卡） */
  threshold: number;
}

export interface RecallMultiHopConfig {
  /** 是否启用基于 [[短标题]] 与相对 Markdown 双链的 1 跳扩展及证据充分性早停（默认 true） */
  enabled: boolean;
  /** 单轮 1 跳最多送审的邻接卡片数（默认 6；调大覆盖更宽但增加单次门控输入） */
  maxNeighbors: number;
  /** 证据充分性早停门槛（0..1，默认 0.75；首跳已选卡片被判定足够接话且分数 >= 此值时立即早停不补卡；调低更克制、调高更积极补卡） */
  sufficientThreshold: number;
  /** 1 跳邻接卡入选的最低相关性门槛（0..1，默认 0.40；高于首跳 rerank.threshold 以严控多跳噪声，仅放行高置信度补全卡） */
  neighborThreshold?: number;
  /** 1 跳扩展单次硬超时（单位：毫秒，默认 2500；超时仅保留首跳结果不报错） */
  timeoutMs?: number;
}

export interface RecallConfig {
  /** 单轮注入记忆卡片的字符总预算（单位：字符，默认 3200；调大可塞入更多历史细节但增加单轮上下文开销，调小更精简但可能截断长卡） */
  charBudget: number;
  /** 同一会话内已召回卡片的去重冷却窗口（单位：分钟，默认 120；调大减少重复提及旧事，调小允许更频繁再次提起） */
  dedupWindowMin: number;
  /** 闲聊时补挂近期日常卡片的时间窗口（单位：小时，默认 72；调大覆盖更多前几天日常，调小只看最近一两天） */
  recentDailyWindowHours: number;
  /** Embedding 向量请求单次超时阈值（单位：毫秒，默认 2500；调小更快降级为本地 FTS5，调大容忍慢网络但增加首字延迟） */
  embedTimeoutMs: number;
  /** 决策模型整轮门控配置（未配置 decision 槽位或关闭时自动平滑降级） */
  gate?: RecallGateConfig;
  /** 决策模型候选卡精排配置 */
  rerank?: RecallRerankConfig;
  /** 决策模型门控与精排单次硬超时（单位：毫秒，默认 3000；全卡目录直扫约 1s，3s 兼顾稳定与防卡死，超时自动降级） */
  decisionTimeoutMs?: number;
  /** 拼入检索查询与门控上下文的近期历史消息条数（单位：条，默认 4，即最近约 2 轮；调大补足短句上下文但可能引入旧话题词） */
  queryWindowTurns?: number;
  /** 精排前宽召回候选池上限（单位：张，默认 15；配置 embedding 时自动走纯向量 Top-15 粗筛，未配置且超 catalogScanMaxCards 时用于 FTS 候选池） */
  candidatePool?: number;
  /** 未配置 embedding 且活跃卡总数不超过此值并开启决策门控时，用单次决策扫描全部活跃卡的「标题 + when_to_recall」（单位：张，默认 250；设为 0 禁用直扫） */
  catalogScanMaxCards?: number;
  /** 门控关闭或超时降级时的 FTS 归一化分数门槛（0..1，默认 0.25；调高过滤弱撞词噪声，调低放宽字面命中） */
  ftsMinScore?: number;
  /** 向量粗筛最低余弦相似度门槛（0..1，默认 0.35；开启决策精排时默认放宽至 0.25 以扩大候选池） */
  embedMinScore?: number;
  /** 向量可用时是否使用 RRF 将 FTS5 字面命中与向量语义命中混合融合（默认 false，实测纯向量粗筛显著优于混合 RRF；FTS5 仍作为向量异常时的降级兜底） */
  hybridFtsWithEmbedding?: boolean;
  /** 二阶段独立精排模型（reranker）单次超时阈值（单位：毫秒，默认 3000；超时自动降级） */
  rerankTimeoutMs?: number;
  /** 基于 [[短标题]] 与 Markdown 双链的 1 跳扩展及证据充分性早停配置 */
  multiHop?: RecallMultiHopConfig;
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  charBudget: 3200,
  dedupWindowMin: 120,
  recentDailyWindowHours: 72,
  embedTimeoutMs: 2500,
  gate: {
    enabled: true,
    threshold: 0.35,
  },
  rerank: {
    threshold: 0.3,
  },
  decisionTimeoutMs: 3000,
  rerankTimeoutMs: 3000,
  queryWindowTurns: 4,
  candidatePool: 15,
  catalogScanMaxCards: 250,
  ftsMinScore: 0.25,
  hybridFtsWithEmbedding: false,
  multiHop: {
    enabled: true,
    maxNeighbors: 6,
    sufficientThreshold: 0.75,
    neighborThreshold: 0.4,
    timeoutMs: 2500,
  },
};

/** 作息与主动心跳可调参数（集中维护于 config.json 的 circadian 节点） */
export interface CircadianConfig {
  /** 睡眠静默窗开始时刻（HH:mm，实例本地时区，默认 "23:30"；仅控制夜间静默与抑制主动打扰） */
  sleepStart: string;
  /** 睡眠静默窗结束时刻（HH:mm，实例本地时区，默认 "07:30"；调晚会延长早晨免打扰） */
  sleepEnd: string;
  /** 进入睡眠窗（或通宵跨出睡眠窗）后，距上次互动静默至少多久才触发 bedtime 日结（单位：分钟，默认 30） */
  bedtimeIdleMin?: number;
  /** 通宵持续聊天跨出睡眠窗后，最晚延迟多久强制按 sleepEnd 截断补跑昨夜 bedtime（单位：分钟，默认 240，即 4 小时） */
  bedtimeForceAfterSleepEndMin?: number;
  /** 心跳巡检间隔（单位：分钟，默认 30；调小响应更及时，调大更省后台开销） */
  heartbeatIntervalMin: number;
  /** 是否启用定时心跳主动唤醒（默认 true；关闭后仅保留睡前整理与正常聊天） */
  proactiveEnabled: boolean;
  /** 距上次互动至少间隔多久才考虑主动唤醒（单位：分钟，默认 240；调大更克制） */
  proactiveMinGapMin: number;
  /** 两次主动唤醒最小冷却间隔（单位：分钟，默认 180；调大减少模型额度消耗） */
  proactiveCooldownMin: number;
}

export const DEFAULT_CIRCADIAN_CONFIG: CircadianConfig = {
  sleepStart: "23:30",
  sleepEnd: "07:30",
  bedtimeIdleMin: 30,
  bedtimeForceAfterSleepEndMin: 240,
  heartbeatIntervalMin: 30,
  proactiveEnabled: true,
  proactiveMinGapMin: 240,
  proactiveCooldownMin: 180,
};

/** 离线通知配置（桌面本地通知 + Webhook + Bark + ntfy，绝不存明文密钥） */
export interface NotificationsConfig {
  desktop: { enabled: boolean };
  webhook?: {
    enabled: boolean;
    url: string;
    /** 引用 credentials.json 中 channelTokens 的键名（可选） */
    credentialKey?: string;
    /** 附加自定义 HTTP 请求头（不含明文密钥） */
    headers?: Record<string, string>;
  };
  bark?: {
    enabled: boolean;
    /** 默认 https://api.day.app */
    serverUrl?: string;
    /** 引用 credentials.json 中 channelTokens 的键名（默认 bark_device_key） */
    deviceKeyRef?: string;
    /** Bark 分组名（默认 Psyber） */
    group?: string;
  };
  ntfy?: {
    enabled: boolean;
    /** 默认 https://ntfy.sh */
    serverUrl?: string;
    /** 订阅主题 */
    topic: string;
    /** 可选鉴权 Token 键名（存 credentials.json 中 channelTokens） */
    credentialKey?: string;
  };
}

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  desktop: { enabled: true },
};

export type ThinkingLevel = "auto" | "off" | "low" | "medium" | "high";

export interface ModelRef {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ContextLimitsConfig {
  /** 聊天对话换段上限（Token），缺省按模型窗口 75% */
  chat?: number;
  /** 独处/主动唤醒换段上限（Token），缺省按模型窗口 75% */
  solo?: number;
}

export interface ModelMetadataOverride {
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  toolCall?: boolean;
}

export interface LlmProviderConfig {
  kind: "anthropic" | "openai" | "google" | "openai-compat";
  authMode: "oauth" | "api_key";
  baseUrl?: string;
  /** 该服务商下用户显式启用/收藏的模型 ID 列表 */
  models?: string[];
  /** 单模型手工覆写参数（最高优先级，覆盖 models.dev 与内置目录） */
  modelOverrides?: Record<string, ModelMetadataOverride>;
}

export interface LlmConfig {
  providers: Record<string, LlmProviderConfig>;
  slots: {
    chat?: ModelRef;
    fallbacks?: ModelRef[];
    memory_task?: ModelRef;
    digest?: ModelRef;
    /** 轻量决策门控槽位（推荐 Google gemini-decision-1；用于日/周反思门控及后续按轮召回判定） */
    decision?: ModelRef;
    vision?: ModelRef;
    embedding?: ModelRef;
    reranker?: ModelRef;
    image_gen?: ModelRef;
  };
  thinking: {
    enabled: boolean;
    level?: ThinkingLevel;
    budgetTokens?: number;
  };
  contextLimits?: ContextLimitsConfig;
}

export interface AvatarsConfig {
  userHash?: string;
  residentHash?: string;
}

export type McpTransport = "stdio" | "streamable_http";
export type McpTrustLevel = "confirm" | "auto";

/**
 * 外部 MCP 服务器配置（落盘于 <dataDir>/config.json 的 mcpServers 节点）。
 * 敏感令牌绝不明文写入，统一通过 "${cred:<key>}" 引用 credentials.json。
 */
export interface McpServerConfig {
  id: string;
  enabled: boolean;
  transport: McpTransport;
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  trustLevel?: McpTrustLevel;
  autoAllowTools?: string[];
  includeTools?: string[];
  excludeTools?: string[];
  timeoutMs?: number;
}

/** 内置 bash 工具安全边界配置（落盘于 <dataDir>/config.json 的 bash 节点） */
export interface BashToolConfig {
  /** 允许免审读/废纸篓删除的目录列表（支持 ~/ 展开；始终默认包含 <dataDir>/workspace） */
  allowedDirs?: string[];
  /** 单次命令执行超时（毫秒，默认 30_000，上限 120_000） */
  timeoutMs?: number;
  /** 命令输出最大字符数（默认 8000） */
  maxOutputChars?: number;
}

/**
 * 单 Psyber 实例核心配置（存盘于 <dataDir>/config.json，绝不含明文密钥）。
 */
/** 用户主动挂出的双人状态签（心绪短句 + 勿扰开关，绝非系统偷窥猜测） */
export interface UserStatusConfig {
  /** 用户主动留下的简短心绪（最多 60 字），默认 null */
  moodText: string | null;
  /** 勿扰开关：开启时自动抑制Psyber非紧急主动 wake 推送，默认 false */
  undisturbed: boolean;
  /** 最近一次状态更新时间戳（Unix 毫秒） */
  updatedAt: number;
}

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
  /** 用户侧双人状态签（心绪短句与勿扰开关） */
  userStatus?: UserStatusConfig;
  /** 开启召回评测检视时是否坦诚告知Psyber（可选透明化开关，默认 false） */
  recallEvalNoticeResident?: boolean;
  /** 已配对客户端设备列表（仅存 token 哈希） */
  auth: {
    devices: PairedDevice[];
  };
  /** 召回可调参数（缺失字段自动回落 DEFAULT_RECALL_CONFIG） */
  recall?: RecallConfig;
  /** 作息静默窗与心跳参数 */
  circadian?: CircadianConfig;
  /** 离线通知通道配置 */
  notifications?: NotificationsConfig;
  /** 双人头像内容寻址哈希（落盘 media/ 且 pinned = 1） */
  avatars?: AvatarsConfig;
  /** LLM 槽位与 Provider 非敏感配置（明文 API Key 存 credentials.json） */
  llm?: LlmConfig;
  /** 外部 MCP 服务器清单（Tier 3 工具池，敏感令牌经 ${cred:<key>} 引用 credentials.json） */
  mcpServers?: McpServerConfig[];
  /** 内置 bash 工具安全边界配置（允许目录、超时与输出上限） */
  bash?: BashToolConfig;
  /** 用户手动停用的非核心扩展工具名列表（Tier 1 元工具不可停用） */
  disabledTools?: string[];
  /** 是否已完成初生引导 */
  genesisCompleted?: boolean;
}

/**
 * 原子写二进制或文本文件（同文件系统 .tmp 暂存 + fsync 刷盘 + rename 替换），防止断电留下半截文件。
 */
export async function atomicWriteBytes(
  dataDir: string,
  absTarget: string,
  bytes: Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(absTarget), { recursive: true });
  const tmpDir = path.join(dataDir, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.tmp`);
  const fh = await fs.open(tmpPath, "w");
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, absTarget);
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

/** 初始化单个 Psyber 数据目录骨架（Ring 1 仅建必需目录） */
export async function initDataDir(dataDir: string): Promise<void> {
  const dirs = [
    dataDir,
    path.join(dataDir, ".tmp"),
    path.join(dataDir, "media"),
    path.join(dataDir, "stickers"),
    path.join(dataDir, "backups"),
    path.join(dataDir, "memory"),
    path.join(dataDir, "memory", "core"),
    path.join(dataDir, "memory", "episodes"),
    path.join(dataDir, "memory", "threads"),
    path.join(dataDir, "memory", "lessons"),
    path.join(dataDir, "memory", "entities"),
    path.join(dataDir, "memory", "favorite"),
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
      circadian: { ...DEFAULT_CIRCADIAN_CONFIG },
      notifications: { ...DEFAULT_NOTIFICATIONS_CONFIG },
      genesisCompleted: false,
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
      gate: {
        ...DEFAULT_RECALL_CONFIG.gate!,
        ...(cfg.recall?.gate ?? {}),
      },
      rerank: {
        ...DEFAULT_RECALL_CONFIG.rerank!,
        ...(cfg.recall?.rerank ?? {}),
      },
    },
    circadian: {
      ...DEFAULT_CIRCADIAN_CONFIG,
      ...(cfg.circadian ?? {}),
    },
    notifications: {
      ...DEFAULT_NOTIFICATIONS_CONFIG,
      ...(cfg.notifications ?? {}),
    },
    userStatus: cfg.userStatus
      ? {
          moodText:
            typeof cfg.userStatus.moodText === "string" && cfg.userStatus.moodText.trim()
              ? cfg.userStatus.moodText.trim().slice(0, 60)
              : null,
          undisturbed: cfg.userStatus.undisturbed === true,
          updatedAt:
            typeof cfg.userStatus.updatedAt === "number" ? cfg.userStatus.updatedAt : nowMs,
        }
      : undefined,
    recallEvalNoticeResident: Boolean(cfg.recallEvalNoticeResident),
    avatars: cfg.avatars
      ? {
          ...(typeof cfg.avatars.userHash === "string" && cfg.avatars.userHash.trim()
            ? { userHash: cfg.avatars.userHash.trim() }
            : {}),
          ...(typeof cfg.avatars.residentHash === "string" && cfg.avatars.residentHash.trim()
            ? { residentHash: cfg.avatars.residentHash.trim() }
            : {}),
        }
      : undefined,
    llm: cfg.llm,
    mcpServers: Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [],
    bash: cfg.bash
      ? {
          ...(Array.isArray(cfg.bash.allowedDirs)
            ? {
                allowedDirs: cfg.bash.allowedDirs.filter(
                  (d): d is string => typeof d === "string" && d.trim().length > 0,
                ),
              }
            : {}),
          ...(typeof cfg.bash.timeoutMs === "number" && Number.isFinite(cfg.bash.timeoutMs)
            ? { timeoutMs: cfg.bash.timeoutMs }
            : {}),
          ...(typeof cfg.bash.maxOutputChars === "number" && Number.isFinite(cfg.bash.maxOutputChars)
            ? { maxOutputChars: cfg.bash.maxOutputChars }
            : {}),
        }
      : undefined,
    disabledTools: Array.isArray(cfg.disabledTools)
      ? cfg.disabledTools.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : [],
    genesisCompleted: Boolean(cfg.genesisCompleted),
  };
}

export async function saveConfig(dataDir: string, cfg: PsyberConfig): Promise<void> {
  const targetPath = path.join(dataDir, "config.json");
  await atomicWriteFile(dataDir, targetPath, JSON.stringify(cfg, null, 2) + "\n");
}
