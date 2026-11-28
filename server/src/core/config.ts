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
  /** 1 跳邻接卡入选的最低相关性门槛（0..1，缺省取 Math.max(0.40, rerank.threshold)；调高仅放行强补全卡以压低噪声，调低放宽延伸联想） */
  neighborThreshold?: number;
  /** 1 跳扩展单次硬超时（单位：毫秒，默认 2500；调大容忍慢网络但增加响应尾延迟，调小更快保留首跳结果回落） */
  timeoutMs?: number;
}

export interface RecallSensitiveConfig {
  /** 是否允许将 memory/sensitive/ 高敏卡片正文发往外部 Embedding 接口（默认 false：仅走本地 FTS5 关键词 + when_to_recall 按需触发；若部署纯本地向量模型可开启） */
  allowExternalEmbedding: boolean;
  /** 高敏卡片通过 Decision / Reranker 精排的最低相关性门槛（0..1，默认 0.55，显著高于普通卡 0.30 以防闲聊撞词误揭私事） */
  rerankThreshold: number;
  /** 高敏卡片进入本地 FTS5 候选或降级放行的最低归一化分门槛（0..1，默认 0.45，高于普通卡 0.25） */
  ftsMinScore: number;
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
  /** 向量粗筛最低余弦相似度门槛（0..1，未配置时开启精排默认 0.25、单阶段默认 0.35；调高减少弱相关向量入池，调低扩大候选覆盖面） */
  embedMinScore?: number;
  /** 向量可用时是否使用 RRF 将 FTS5 字面命中与向量语义命中混合融合（默认 false，实测纯向量粗筛显著优于混合 RRF；FTS5 仍作为向量异常时的降级兜底） */
  hybridFtsWithEmbedding?: boolean;
  /** 二阶段独立精排模型（reranker）单次超时阈值（单位：毫秒，默认 3000；调大容忍慢网络但增加延迟，调小更快超时回退） */
  rerankTimeoutMs?: number;
  /** 基于 [[短标题]] 与 Markdown 双链的 1 跳扩展及证据充分性早停配置 */
  multiHop?: RecallMultiHopConfig;
  /** 高敏私密记忆区（memory/sensitive/）的外部向量隔离与高门槛召回策略 */
  sensitive?: RecallSensitiveConfig;
  /** 普通情景切片（episodes/ ep-*.md）无 core/favorite/lessons 入链且未 pinned 时，超过此天数未更新且未被召回即在索引层自动软淡出召回（单位：天，默认 90；设为 0 禁用） */
  episodeFadeDays?: number;
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
    timeoutMs: 2500,
  },
  sensitive: {
    allowExternalEmbedding: false,
    rerankThreshold: 0.55,
    ftsMinScore: 0.45,
  },
  episodeFadeDays: 90,
};

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function pickFinite(a: unknown, b: unknown, fallback: number): number {
  if (typeof b === "number" && Number.isFinite(b)) return b;
  if (typeof a === "number" && Number.isFinite(a)) return a;
  return fallback;
}

function pickOptFinite(a: unknown, b: unknown, fallback?: number): number | undefined {
  if (typeof b === "number" && Number.isFinite(b)) return b;
  if (typeof a === "number" && Number.isFinite(a)) return a;
  return fallback;
}

function pickBool(a: unknown, b: unknown, fallback: boolean): boolean {
  if (typeof b === "boolean") return b;
  if (typeof a === "boolean") return a;
  return fallback;
}

/** 深度合并召回配置（防止部分更新 gate / rerank / multiHop 时覆盖默认子字段或被 undefined/null 污染） */
export function mergeRecallConfig(
  base?: Partial<RecallConfig>,
  patch?: Partial<RecallConfig>,
): RecallConfig {
  const b = isPlainRecord(base) ? (base as Partial<RecallConfig>) : undefined;
  const p = isPlainRecord(patch) ? (patch as Partial<RecallConfig>) : undefined;
  const bGate = isPlainRecord(b?.gate) ? b!.gate : undefined;
  const pGate = isPlainRecord(p?.gate) ? p!.gate : undefined;
  const bRerank = isPlainRecord(b?.rerank) ? b!.rerank : undefined;
  const pRerank = isPlainRecord(p?.rerank) ? p!.rerank : undefined;
  const bHop = isPlainRecord(b?.multiHop) ? b!.multiHop : undefined;
  const pHop = isPlainRecord(p?.multiHop) ? p!.multiHop : undefined;
  const bSens = isPlainRecord(b?.sensitive) ? b!.sensitive : undefined;
  const pSens = isPlainRecord(p?.sensitive) ? p!.sensitive : undefined;
  const neighborThreshold = pickOptFinite(
    bHop?.neighborThreshold,
    pHop?.neighborThreshold,
    DEFAULT_RECALL_CONFIG.multiHop?.neighborThreshold,
  );
  const embedMinScore = pickOptFinite(
    b?.embedMinScore,
    p?.embedMinScore,
    DEFAULT_RECALL_CONFIG.embedMinScore,
  );
  return {
    charBudget: pickFinite(b?.charBudget, p?.charBudget, DEFAULT_RECALL_CONFIG.charBudget),
    dedupWindowMin: pickFinite(b?.dedupWindowMin, p?.dedupWindowMin, DEFAULT_RECALL_CONFIG.dedupWindowMin),
    recentDailyWindowHours: pickFinite(
      b?.recentDailyWindowHours,
      p?.recentDailyWindowHours,
      DEFAULT_RECALL_CONFIG.recentDailyWindowHours,
    ),
    embedTimeoutMs: pickFinite(b?.embedTimeoutMs, p?.embedTimeoutMs, DEFAULT_RECALL_CONFIG.embedTimeoutMs),
    decisionTimeoutMs: pickFinite(
      b?.decisionTimeoutMs,
      p?.decisionTimeoutMs,
      DEFAULT_RECALL_CONFIG.decisionTimeoutMs!,
    ),
    rerankTimeoutMs: pickFinite(
      b?.rerankTimeoutMs,
      p?.rerankTimeoutMs,
      DEFAULT_RECALL_CONFIG.rerankTimeoutMs!,
    ),
    queryWindowTurns: pickFinite(
      b?.queryWindowTurns,
      p?.queryWindowTurns,
      DEFAULT_RECALL_CONFIG.queryWindowTurns!,
    ),
    candidatePool: pickFinite(b?.candidatePool, p?.candidatePool, DEFAULT_RECALL_CONFIG.candidatePool!),
    catalogScanMaxCards: pickFinite(
      b?.catalogScanMaxCards,
      p?.catalogScanMaxCards,
      DEFAULT_RECALL_CONFIG.catalogScanMaxCards!,
    ),
    ftsMinScore: pickFinite(b?.ftsMinScore, p?.ftsMinScore, DEFAULT_RECALL_CONFIG.ftsMinScore!),
    ...(embedMinScore !== undefined ? { embedMinScore } : {}),
    hybridFtsWithEmbedding: pickBool(
      b?.hybridFtsWithEmbedding,
      p?.hybridFtsWithEmbedding,
      DEFAULT_RECALL_CONFIG.hybridFtsWithEmbedding!,
    ),
    gate: {
      enabled: pickBool(bGate?.enabled, pGate?.enabled, DEFAULT_RECALL_CONFIG.gate!.enabled),
      threshold: pickFinite(bGate?.threshold, pGate?.threshold, DEFAULT_RECALL_CONFIG.gate!.threshold),
    },
    rerank: {
      threshold: pickFinite(bRerank?.threshold, pRerank?.threshold, DEFAULT_RECALL_CONFIG.rerank!.threshold),
    },
    multiHop: {
      enabled: pickBool(bHop?.enabled, pHop?.enabled, DEFAULT_RECALL_CONFIG.multiHop!.enabled),
      maxNeighbors: pickFinite(
        bHop?.maxNeighbors,
        pHop?.maxNeighbors,
        DEFAULT_RECALL_CONFIG.multiHop!.maxNeighbors,
      ),
      sufficientThreshold: pickFinite(
        bHop?.sufficientThreshold,
        pHop?.sufficientThreshold,
        DEFAULT_RECALL_CONFIG.multiHop!.sufficientThreshold,
      ),
      ...(neighborThreshold !== undefined ? { neighborThreshold } : {}),
      timeoutMs: pickFinite(bHop?.timeoutMs, pHop?.timeoutMs, DEFAULT_RECALL_CONFIG.multiHop!.timeoutMs!),
    },
    sensitive: {
      allowExternalEmbedding: pickBool(
        bSens?.allowExternalEmbedding,
        pSens?.allowExternalEmbedding,
        DEFAULT_RECALL_CONFIG.sensitive!.allowExternalEmbedding,
      ),
      rerankThreshold: pickFinite(
        bSens?.rerankThreshold,
        pSens?.rerankThreshold,
        DEFAULT_RECALL_CONFIG.sensitive!.rerankThreshold,
      ),
      ftsMinScore: pickFinite(
        bSens?.ftsMinScore,
        pSens?.ftsMinScore,
        DEFAULT_RECALL_CONFIG.sensitive!.ftsMinScore,
      ),
    },
    episodeFadeDays: Math.max(
      0,
      Math.floor(
        pickFinite(
          b?.episodeFadeDays,
          p?.episodeFadeDays,
          DEFAULT_RECALL_CONFIG.episodeFadeDays!,
        ),
      ),
    ),
  };
}

/**
 * 快脑只读体检雷达（Memory Radar）各维度高置信门槛（0..1）。
 * 调高可压低误报噪声，调低会放宽疑似线索进入 <memory_radar> 清单。
 */
export interface RadarThresholdsConfig {
  /** 疑似纯重复（无实质新信息）的最低概率（默认 0.75；调高仅报极高重合专卡，调低更容易提示疑似重复） */
  redundant: number;
  /** 疑似前后矛盾或立场反转的最低概率（默认 0.55；实测真实反转/版本冲突落在 0.54+，正常推进 ≤ 0.29；调高减少争议提示，调低更敏感捕获说法冲突） */
  contradiction: number;
  /** 疑似旧状态/旧卡过时的最低概率（默认 0.70；调高仅提示明确完结项，调低更积极提醒核对旧状态） */
  obsolete: number;
  /** 建议补 [[短标题]] 双向链接的最低概率（默认 0.75，仅 bedtime 展示；调高只推强因果/同线索双链，调低增加补链建议） */
  link: number;
  /** 独立 promote 跨天提炼判据（或 representation=promote）的最低概率（默认 0.65；调高仅在规律极明显时提示提炼，调低更容易浮现跨天共性线索） */
  promote: number;
  /** representation 选中 merge 时该选项的最低概率（默认 0.65，仅对非 ep-* 持久专卡生效；调高更保守合并，调低更容易建议专卡收拢） */
  merge: number;
}

/**
 * 快脑只读体检雷达配置（集中维护于 <dataDir>/config.json 的 radar 节点）。
 * 严守 NG-2：仅做只读扫描并向 bedtime / reflect_weekly 递交线索，绝不代写卡片；异常自动静默跳过。
 */
export interface RadarConfig {
  /** 是否启用快脑只读体检雷达（默认 true；关闭后立即停用；未配 decision 槽位时自动静默跳过） */
  enabled: boolean;
  /** 每日 bedtime 最多评估的新旧卡片对数（单位：对，默认 12；调大覆盖更宽但增加决策调用次数，调小更省额度但可能漏检低排位相似卡） */
  maxPairsDaily: number;
  /** 每周 reflect_weekly 最多评估的新旧卡片对数（单位：对，默认 20；调大能覆盖整周更多跨日卡片组合但耗时更长，调小更快更省额度） */
  maxPairsWeekly: number;
  /** 每张新卡最多配对的相似旧卡数（单位：张，默认 3；调大能为单张新卡拉入更多历史对照但更容易占满总配对预算，调小聚焦最相近旧卡） */
  topKPerCard: number;
  /** 向量粗筛配对的最低余弦相似度（单位：0..1 余弦分，默认 0.45；调高仅扫高度相关旧卡，调低扩大扫描范围但增加无关配对） */
  minSimilarity: number;
  /** 并行发起的决策请求并发上限（单位：并发请求数，默认 4；调大可缩短整轮体检耗时但更容易触发接口限流，调小更平稳但耗时增加） */
  concurrency: number;
  /** 整轮雷达体检总超时（单位：毫秒，默认 20000；调大允许慢速模型扫完更多卡片对，调小更快截断返回已扫线索、绝不阻塞整理） */
  timeoutMs: number;
  /** 每日 bedtime 注入 <memory_radar> 的最多线索条数（单位：条，默认 5；调大提供更多线索但增加整理轮上下文阅读负担，调小仅聚焦最高优先级线索） */
  maxFindingsDaily: number;
  /** 每周 reflect_weekly 注入 <memory_radar> 的最多线索条数（单位：条，默认 8；调大展示更多周度跨天线索，调小保持反思输入精简） */
  maxFindingsWeekly: number;
  /** 各维度高置信门槛 */
  thresholds?: Partial<RadarThresholdsConfig>;
}

export const DEFAULT_RADAR_THRESHOLDS: RadarThresholdsConfig = {
  redundant: 0.75,
  contradiction: 0.55,
  obsolete: 0.70,
  link: 0.75,
  promote: 0.65,
  merge: 0.65,
};

export const DEFAULT_RADAR_CONFIG: RadarConfig & { thresholds: RadarThresholdsConfig } = {
  enabled: true,
  maxPairsDaily: 12,
  maxPairsWeekly: 20,
  topKPerCard: 3,
  minSimilarity: 0.45,
  concurrency: 4,
  timeoutMs: 20_000,
  maxFindingsDaily: 5,
  maxFindingsWeekly: 8,
  thresholds: { ...DEFAULT_RADAR_THRESHOLDS },
};

/** 深度合并雷达配置（防止部分更新 thresholds 时覆盖默认子字段或被 undefined/null/NaN 污染） */
export function mergeRadarConfig(
  base?: Partial<RadarConfig>,
  patch?: Partial<RadarConfig>,
): RadarConfig & { thresholds: RadarThresholdsConfig } {
  const b = isPlainRecord(base) ? (base as Partial<RadarConfig>) : undefined;
  const p = isPlainRecord(patch) ? (patch as Partial<RadarConfig>) : undefined;
  const bt = isPlainRecord(b?.thresholds) ? b!.thresholds : undefined;
  const pt = isPlainRecord(p?.thresholds) ? p!.thresholds : undefined;
  return {
    enabled: pickBool(b?.enabled, p?.enabled, DEFAULT_RADAR_CONFIG.enabled),
    maxPairsDaily: pickFinite(b?.maxPairsDaily, p?.maxPairsDaily, DEFAULT_RADAR_CONFIG.maxPairsDaily),
    maxPairsWeekly: pickFinite(b?.maxPairsWeekly, p?.maxPairsWeekly, DEFAULT_RADAR_CONFIG.maxPairsWeekly),
    topKPerCard: pickFinite(b?.topKPerCard, p?.topKPerCard, DEFAULT_RADAR_CONFIG.topKPerCard),
    minSimilarity: pickFinite(b?.minSimilarity, p?.minSimilarity, DEFAULT_RADAR_CONFIG.minSimilarity),
    concurrency: pickFinite(b?.concurrency, p?.concurrency, DEFAULT_RADAR_CONFIG.concurrency),
    timeoutMs: pickFinite(b?.timeoutMs, p?.timeoutMs, DEFAULT_RADAR_CONFIG.timeoutMs),
    maxFindingsDaily: pickFinite(
      b?.maxFindingsDaily,
      p?.maxFindingsDaily,
      DEFAULT_RADAR_CONFIG.maxFindingsDaily,
    ),
    maxFindingsWeekly: pickFinite(
      b?.maxFindingsWeekly,
      p?.maxFindingsWeekly,
      DEFAULT_RADAR_CONFIG.maxFindingsWeekly,
    ),
    thresholds: {
      redundant: pickFinite(bt?.redundant, pt?.redundant, DEFAULT_RADAR_THRESHOLDS.redundant),
      contradiction: pickFinite(
        bt?.contradiction,
        pt?.contradiction,
        DEFAULT_RADAR_THRESHOLDS.contradiction,
      ),
      obsolete: pickFinite(bt?.obsolete, pt?.obsolete, DEFAULT_RADAR_THRESHOLDS.obsolete),
      link: pickFinite(bt?.link, pt?.link, DEFAULT_RADAR_THRESHOLDS.link),
      promote: pickFinite(bt?.promote, pt?.promote, DEFAULT_RADAR_THRESHOLDS.promote),
      merge: pickFinite(bt?.merge, pt?.merge, DEFAULT_RADAR_THRESHOLDS.merge),
    },
  };
}

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

export type MemoryMcpAccessMode = "read_only" | "read_write";

/**
 * 第三方客户端访问 Psyber 记忆 MCP 服务的专属令牌元数据（绝不存明文，仅存 SHA-256 哈希）。
 */
export interface MemoryMcpToken {
  /** 令牌唯一标识（如 mcp_a1b2c3d4e5f6） */
  id: string;
  /** 客户端展示名称（如 claude-code、cursor） */
  name: string;
  /** Bearer Token 的 SHA-256 十六进制哈希 */
  tokenHash: string;
  /** 可选单令牌权限上限：设为 read_only 时即使全局开了 read_write 也仅允许只读 */
  accessMode?: MemoryMcpAccessMode;
  /** 创建时间戳（Unix 毫秒） */
  createdAt: number;
  /** 最近一次调用时间戳（Unix 毫秒） */
  lastUsedAt?: number;
}

/**
 * 对外记忆 MCP 服务配置（落盘于 <dataDir>/config.json 的 memoryMcp 节点）。
 * 开启后进入「出差互斥模式」：暂停内部对话与作息心跳，防止两个 Psyber 同时写记忆分叉。
 */
export interface MemoryMcpConfig {
  /** 总开关（默认 false；开启后开放 /mcp 并暂停内部 Psyber 活动，关闭立即恢复） */
  enabled: boolean;
  /** 读写权限模式（默认 "read_only"；切换为 "read_write" 才暴露写入/编辑工具） */
  accessMode: MemoryMcpAccessMode;
  /** 是否允许非本机回环 IP 访问 /mcp（默认 false；跨机访问建议配合 HTTPS 或 Tailscale） */
  allowRemote: boolean;
  /** 写入模式下是否禁止外部 MCP 修改 core/* 常驻身份与边界文件（默认 true，强烈建议开启） */
  protectCoreFiles: boolean;
  /** 单次 MCP 工具返回的最大字符数（单位：字符，默认 12000，范围 1000..50000；调大保留更多长文细节，调小省客户端上下文） */
  maxOutputChars: number;
  /** 按需单独停用的暴露工具名列表（默认 []） */
  disabledTools: string[];
  /** 是否在 read_write 模式下向外部 MCP 暴露历史记忆搬家任务工具 memory_replay（默认 false；开启后才按游标受控下发历史对话，关闭时彻底隐藏并拒绝调用） */
  replayToolsEnabled: boolean;
  /** 已签发的外部 MCP 客户端令牌列表（仅存哈希） */
  tokens: MemoryMcpToken[];
}

export const DEFAULT_MEMORY_MCP_CONFIG: MemoryMcpConfig = {
  enabled: false,
  accessMode: "read_only",
  allowRemote: false,
  protectCoreFiles: true,
  maxOutputChars: 12_000,
  disabledTools: [],
  replayToolsEnabled: false,
  tokens: [],
};

function sanitizeMemoryMcpTokens(raw: unknown): MemoryMcpToken[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: MemoryMcpToken[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const tokenHash = typeof item.tokenHash === "string" ? item.tokenHash.trim() : "";
    if (!id || !name || !tokenHash || seen.has(id)) continue;
    seen.add(id);
    const accessMode: MemoryMcpAccessMode | undefined =
      item.accessMode === "read_only" || item.accessMode === "read_write"
        ? item.accessMode
        : undefined;
    out.push({
      id,
      name: name.slice(0, 64),
      tokenHash,
      ...(accessMode ? { accessMode } : {}),
      createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
      ...(typeof item.lastUsedAt === "number" && Number.isFinite(item.lastUsedAt)
        ? { lastUsedAt: item.lastUsedAt }
        : {}),
    });
  }
  return out;
}

/** 深度合并对外记忆 MCP 配置（防 undefined/null 污染；patch 未提供 tokens 时保留既有令牌） */
export function mergeMemoryMcpConfig(
  base?: Partial<MemoryMcpConfig>,
  patch?: Partial<MemoryMcpConfig>,
): MemoryMcpConfig {
  const b = isPlainRecord(base) ? (base as Partial<MemoryMcpConfig>) : undefined;
  const p = isPlainRecord(patch) ? (patch as Partial<MemoryMcpConfig>) : undefined;
  const accessMode: MemoryMcpAccessMode =
    p?.accessMode === "read_only" || p?.accessMode === "read_write"
      ? p.accessMode
      : b?.accessMode === "read_only" || b?.accessMode === "read_write"
        ? b.accessMode
        : DEFAULT_MEMORY_MCP_CONFIG.accessMode;
  const rawMax = pickFinite(b?.maxOutputChars, p?.maxOutputChars, DEFAULT_MEMORY_MCP_CONFIG.maxOutputChars);
  const maxOutputChars = Math.max(1_000, Math.min(50_000, Math.floor(rawMax)));
  const rawDisabled = Array.isArray(p?.disabledTools)
    ? p!.disabledTools
    : Array.isArray(b?.disabledTools)
      ? b!.disabledTools
      : DEFAULT_MEMORY_MCP_CONFIG.disabledTools;
  const disabledTools = Array.from(
    new Set(
      rawDisabled
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim()),
    ),
  );
  const tokens =
    sanitizeMemoryMcpTokens(p?.tokens) ??
    sanitizeMemoryMcpTokens(b?.tokens) ??
    [];
  return {
    enabled: pickBool(b?.enabled, p?.enabled, DEFAULT_MEMORY_MCP_CONFIG.enabled),
    accessMode,
    allowRemote: pickBool(b?.allowRemote, p?.allowRemote, DEFAULT_MEMORY_MCP_CONFIG.allowRemote),
    protectCoreFiles: pickBool(
      b?.protectCoreFiles,
      p?.protectCoreFiles,
      DEFAULT_MEMORY_MCP_CONFIG.protectCoreFiles,
    ),
    maxOutputChars,
    disabledTools,
    replayToolsEnabled: pickBool(
      b?.replayToolsEnabled,
      p?.replayToolsEnabled,
      DEFAULT_MEMORY_MCP_CONFIG.replayToolsEnabled,
    ),
    tokens,
  };
}

/**
 * 内置观影伴看插件（cinema）桥接配置（集中维护于 <dataDir>/config.json 的 cinema 节点）。
 */
export interface CinemaConfig {
  /** 本地伴看采集服务基础地址（如 cowatch serve 的 http://127.0.0.1:18765）；留空表示不主动拉取外部采集源 */
  bridgeUrl: string;
  /** 单次向采集服务拉取 /pull 或转发工具的超时阈值（单位：毫秒，默认 2500；调小更快降级为纯文字聊天，调大容忍首次四宫格拼图） */
  timeoutMs: number;
  /** 在 Psyber 开启/结束观影时是否自动联动采集服务的 /resume 与 /pause 休眠采集（默认 true） */
  syncPauseResume: boolean;
}

export const DEFAULT_CINEMA_CONFIG: CinemaConfig = {
  bridgeUrl: "http://127.0.0.1:18765",
  timeoutMs: 2500,
  syncPauseResume: true,
};

export function mergeCinemaConfig(
  base?: Partial<CinemaConfig>,
  patch?: Partial<CinemaConfig>,
): CinemaConfig {
  const b = isPlainRecord(base) ? (base as Partial<CinemaConfig>) : undefined;
  const p = isPlainRecord(patch) ? (patch as Partial<CinemaConfig>) : undefined;
  const rawUrl =
    typeof p?.bridgeUrl === "string"
      ? p.bridgeUrl.trim()
      : typeof b?.bridgeUrl === "string"
        ? b.bridgeUrl.trim()
        : DEFAULT_CINEMA_CONFIG.bridgeUrl;
  const bridgeUrl = rawUrl.replace(/\/+$/, "");
  const rawTimeout = pickFinite(b?.timeoutMs, p?.timeoutMs, DEFAULT_CINEMA_CONFIG.timeoutMs);
  const timeoutMs = Math.max(500, Math.min(15_000, Math.floor(rawTimeout)));
  return {
    bridgeUrl,
    timeoutMs,
    syncPauseResume: pickBool(
      b?.syncPauseResume,
      p?.syncPauseResume,
      DEFAULT_CINEMA_CONFIG.syncPauseResume,
    ),
  };
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
  /** 快脑只读体检雷达可调参数（缺失字段自动回落 DEFAULT_RADAR_CONFIG） */
  radar?: RadarConfig;
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
  /** 对外暴露记忆工具的 MCP 服务端配置（开启时进入出差互斥模式，默认关闭） */
  memoryMcp?: MemoryMcpConfig;
  /** 内置 bash 工具安全边界配置（允许目录、超时与输出上限） */
  bash?: BashToolConfig;
  /** 内置观影伴看（cinema）本地采集桥接配置（如 cowatch HTTP /pull） */
  cinema?: CinemaConfig;
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
      recall: mergeRecallConfig(),
      radar: mergeRadarConfig(),
      circadian: { ...DEFAULT_CIRCADIAN_CONFIG },
      notifications: { ...DEFAULT_NOTIFICATIONS_CONFIG },
      memoryMcp: mergeMemoryMcpConfig(),
      cinema: mergeCinemaConfig(),
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
    recall: mergeRecallConfig(cfg.recall),
    radar: mergeRadarConfig(cfg.radar),
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
    memoryMcp: mergeMemoryMcpConfig(cfg.memoryMcp),
    cinema: mergeCinemaConfig(cfg.cinema),
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
