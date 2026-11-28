import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import YAML from "yaml";
import type { Clock } from "../core/clock.ts";
import { localDay } from "../core/clock.ts";
import { mergeRadarConfig, type RadarConfig, type RadarThresholdsConfig } from "../core/config.ts";
import {
  sanitizeUnicode,
  type DecisionClient,
  type DecisionQuestion,
} from "../core/decision.ts";
import type { EmbeddingClient } from "../core/embedding.ts";
import { readPrompt, stripFrontmatter } from "../core/prompts.ts";
import { combineTimeoutSignal, cosineSimilarity, ensureCardEmbeddings } from "./embeddings.ts";
import { effectiveStatus } from "./frontmatter.ts";
import { normalizeWikiTitle, type CardIndexRow, type MemoryIndex } from "./index.ts";

export type RadarScope = "bedtime" | "weekly";

export type RadarFindingKind =
  | "contradiction"
  | "obsolete"
  | "promote"
  | "merge"
  | "redundant"
  | "link"
  | "stale";

export interface RadarFinding {
  kind: RadarFindingKind;
  score: number;
  source: "board" | "pair" | "stale";
  /** 涉及的新卡路径与短标题（看板巡检时省略或指向最近变动批次） */
  newCardPath?: string;
  newCardTitle?: string;
  /** 涉及的旧卡或看板文件路径（如 core/state.md、core/open.md、entities/...） */
  targetPath: string;
  /** 旧卡短标题或看板条目原文摘要 */
  targetTitle: string;
  /** 客观系统信号与核实建议（严守「判断禁用我」，绝不替 Psyber 下心理定性） */
  detail: string;
}

export interface RadarBoardDebugItem {
  id: string;
  filePath: "core/state.md" | "core/open.md";
  text: string;
  obsoleteScore: number;
  contradictionScore: number;
}

export interface RadarPairDebugItem {
  newCardPath: string;
  newCardTitle: string;
  oldCardPath: string;
  oldCardTitle: string;
  similarity: number;
  matchMethod: "embedding" | "fts";
  alreadyLinked: boolean;
  redundant?: number;
  contradiction?: number;
  obsolete?: number;
  link?: number;
  promote?: number;
  representation?: string;
  representationProb?: number;
  selectedFindingKind?: RadarFindingKind;
}

export interface MemoryRadarResult {
  executed: boolean;
  skipReason?: string;
  scope: RadarScope;
  boardItemsChecked: number;
  pairsEvaluated: number;
  findings: RadarFinding[];
  /** 可直接注入上下文的 <memory_radar> 文本块（无命中时为 null） */
  renderedBlock: string | null;
  /** 供日/周反思门控综合参考的高置信 contradiction/promote/open-obsolete 简短摘要（无命中时为 null） */
  reflectGateHint: string | null;
  timedOut?: boolean;
  error?: string;
  /** 仅当 collectDebug=true 时填充，供离线干跑脚本观察各题原始分数与调参 */
  debug?: {
    matchMethod: "embedding" | "fts";
    boardItems: RadarBoardDebugItem[];
    pairs: RadarPairDebugItem[];
  };
}

export interface RadarQuestionSpec {
  type: "noul" | "choice";
  instructions: string;
  criteria?: Record<string, string>;
}

export interface RadarPromptSpec {
  redundant: RadarQuestionSpec;
  contradiction: RadarQuestionSpec;
  obsolete: RadarQuestionSpec;
  link: RadarQuestionSpec;
  promote: RadarQuestionSpec;
  representation: RadarQuestionSpec;
  boardObsolete: RadarQuestionSpec;
  boardContradiction: RadarQuestionSpec;
}

const DEFAULT_RADAR_PROMPT_SPEC: RadarPromptSpec = {
  redundant: {
    type: "noul",
    instructions:
      "比较 `<new_card>` 与 `<old_card>`，判断两张持久专卡是否几乎只记录了同一件事/同一条信息，且新卡没有补充实质新事实、新进展或新情绪。",
    criteria: {
      true_description:
        "两张卡记录的是同一事件、同一条经验或同一份实体/线索信息，新卡只是换种说法复述旧卡内容，几乎没有新增细节、新进展或新态度（常见于同一主题的长期专卡写重了）。",
      false_description:
        "两张卡虽然主题相近，但各自承担不同维度、或补充了新的阶段进展、新感受、新原话与新背景。",
    },
  },
  contradiction: {
    type: "noul",
    instructions:
      "比较 `<new_card>` 与 `<old_card>`，判断两者在同一时间语境或长期稳定认知上是否存在明显的前后矛盾或立场反转。",
    criteria: {
      true_description:
        "两张卡对同一人、同一事、同一长期偏好、同一立场或同一约定的描述互相打架，或新卡明确推翻/收回了旧卡里的说法与判断，值得核对澄清或修订旧认识。",
      false_description:
        "只是随时间自然演进的状态更新或阶段推进（例如生病后康复、计划执行完成，这属于过时替代而非矛盾）；或人在不同情境下的正常两面性；或两张卡谈的本就不是同一件事。",
    },
  },
  obsolete: {
    type: "noul",
    instructions:
      "比较 `<new_card>` 与 `<old_card>`，判断 `<new_card>` 中的新事实或新进度是否明确取代、终结或使 `<old_card>` 的当前状态失效。",
    criteria: {
      true_description:
        "`<old_card>` 记录的短期状态、待办、暂定计划或旧阶段进度，已被 `<new_card>` 明确宣告完成、取消、恢复或进入新阶段，旧状态继续挂着会误导后续对话。",
      false_description:
        "`<old_card>` 是过去发生过的历史情景经历、逐字原话收藏或依然有效的长期背景/教训，不会因为新事情发生而失效；或者 `<new_card>` 只是顺带提及，并未推翻旧卡状态。",
    },
  },
  link: {
    type: "noul",
    instructions:
      "比较 `<new_card>` 与 `<old_card>`，判断在两张卡之间补充一条 `[[短标题]]` 双向链接，是否对未来对话中顺藤摸瓜的 1 跳联想召回有明显帮助。",
    criteria: {
      true_description:
        "两张卡之间存在明确的前因后果、同一条长期线索/作品/实体的续篇、或相互印证对照的关系，未来想起其中一张时顺手翻到另一张能明显补全背景。",
      false_description:
        "两张卡只是泛泛话题沾边、偶尔出现相同词，或连起来对未来接话几乎没有补全价值，硬连反而会让 1 跳召回扯远。",
    },
  },
  promote: {
    type: "noul",
    instructions:
      "比较 `<new_card>` 与 `<old_card>`，判断这两张记录是否共同反映出一个跨天反复出现的规律、模式或方法论，值得在保留原卡的同时，额外提炼上升为长期经验（`lessons/`）、稳定认知（`core/`）或独立长期档案（`threads/`/`entities/`）。",
    criteria: {
      true_description:
        "两张卡跨越不同日期，共同印证了反复出现的行为习惯、情绪模式、沟通雷区、稳定偏好或重要相处规律，且值得从具体事件中抽象出一条更持久的经验或认知（而不仅仅留在单次日记里）。",
      false_description:
        "只是单次偶发事件、同一项既定长线的常规进度推进，或其中一方本就是已提炼好的经验卡/核心档案对单次例证的常规印证；或者两张卡只是话题沾边，没有值得抽象提炼的新规律。",
    },
  },
  representation: {
    type: "choice",
    instructions:
      "综合 `<new_card>` 与 `<old_card>` 两张持久专卡的目录性质与内容关系，选择最合理的整理收纳建议。",
    criteria: {
      keep_separate: "两张卡各有独立语境、职责清晰，分开保留即可（最多按需补一条 `[[短标题]]` 双链）。",
      merge: "两张卡属于同一长期档案、同一经验或同一线索的重复/碎片，适合合并整理进同一张持久专卡以防膨胀或分散。",
      promote:
        "两张卡共同反映出更高层级的长期规律，适合进一步抽象沉淀进 `lessons/` 或 `core/`。",
      uncertain: "目前信息不足以判断需要合并或提炼，暂时保留原样、留待后续观察即可。",
    },
  },
  boardObsolete: {
    type: "noul",
    instructions:
      "结合 `<new_cards>` 中近期新整理的事实，判断 `<board_items>` 中的条目 `{{item_id}}` 是否已经被新进展明确终结、恢复、完成、取消或过时。",
    criteria: {
      true_description:
        "`<new_cards>` 中出现了明确事实表明条目 `{{item_id}}` 对应的短期状态已恢复/结束、待办已完成/取消、挂念已闭环或长线进度已被新进展取代。",
      false_description:
        "`<new_cards>` 未涉及条目 `{{item_id}}`，或仅略有提及但该状态/待办/挂念依然有效、尚未结束。",
    },
  },
  boardContradiction: {
    type: "noul",
    instructions:
      "结合 `<new_cards>` 中近期新整理的事实，判断 `<board_items>` 中的条目 `{{item_id}}` 与新近记录是否存在需要核实的前后说法冲突或版本不一致。",
    criteria: {
      true_description:
        "`<new_cards>` 中的新事实与条目 `{{item_id}}` 的描述、立场或版本号直接打架，且不是自然的状态恢复/完成，值得核对澄清。",
      false_description: "两者无关、一致，或属于自然的时间演进与状态恢复（自然恢复归为过时而非矛盾）。",
    },
  },
};

const DEFAULT_PROMPTS_DIR = path.resolve(import.meta.dir, "../../../prompts");
const EPISODE_SLICE_RE = /^episodes\/(\d{4})\/(\d{2})\/(\d{2})\/ep-[^/]+\.md$/;
const EXPIRY_TAG_RE = /\[(?:至|until:?)\s*(\d{4}-\d{2}-\d{2})\]/i;
// 仅匹配整条被括号包裹的占位说明（如「（暂无）」「(empty)」）或纯占位短词本身，绝不误伤以“无/空”开头的真实事项（如“空调漏水”“无糖饮食”）
const PLACEHOLDER_ITEM_RE =
  /^(?:[（(]\s*(?:暂无|无|空|待补充|none|empty)[^）)]*[）)]|(?:暂无|无|空|待补充|none|empty)[。.!！~～—\-]*)$/i;

const FINDING_PRIORITY: Record<RadarFindingKind, number> = {
  contradiction: 1,
  obsolete: 2,
  promote: 3,
  merge: 4,
  redundant: 5,
  link: 6,
  stale: 7,
};

/** 判断路径是否为情景切片（episodes/YYYY/MM/DD/ep-*.md） */
export function isEpisodeSlicePath(relPath: string): boolean {
  return EPISODE_SLICE_RE.test(relPath);
}

/** 提取情景切片的日期（YYYY-MM-DD），非情景切片返回 null */
export function episodeDateFromPath(relPath: string): string | null {
  const m = EPISODE_SLICE_RE.exec(relPath);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 判断卡片索引行是否满足只读体检雷达的候选条件（排除常驻 core/self/user、日/月/年梗概、私密抽屉、高敏隔离区 sensitive/、反思卡及已失效状态） */
export function isEligibleRadarRow(row: CardIndexRow, nowMs: number): boolean {
  if (
    row.space === "self" ||
    row.space === "user" ||
    row.space === "core" ||
    row.space === "episode_index" ||
    row.space === "private" ||
    row.space === "sensitive" ||
    row.kind === "reflection"
  ) {
    return false;
  }
  const st = effectiveStatus(row, nowMs);
  return st === "active" || st === "disputed";
}

function parseSubSectionQuestion(
  rawSection: string | undefined,
  fallback: RadarQuestionSpec,
  allowedKeys: readonly string[],
): RadarQuestionSpec {
  const section = rawSection?.trim();
  if (!section) return fallback;

  const keyPattern = allowedKeys.join("|");
  const subHeadingRe = new RegExp(`^##\\s+(${keyPattern})[ \\t]*\\r?$`, "gim");
  const matches: Array<{ key: string; start: number; contentStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = subHeadingRe.exec(section)) !== null) {
    matches.push({
      key: m[1]!.toLowerCase(),
      start: m.index,
      contentStart: m.index + m[0].length,
    });
  }

  if (matches.length === 0) {
    return { type: fallback.type, instructions: section, ...(fallback.criteria ? { criteria: fallback.criteria } : {}) };
  }

  const instructions = section.slice(0, matches[0]!.start).trim() || fallback.instructions;
  const criteria: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const nextStart = i + 1 < matches.length ? matches[i + 1]!.start : section.length;
    const text = section.slice(cur.contentStart, nextStart).trim();
    if (!text) continue;
    if (fallback.type === "noul") {
      criteria[cur.key === "true" ? "true_description" : "false_description"] = text;
    } else {
      criteria[cur.key] = text;
    }
  }

  const finalCriteria = Object.keys(criteria).length > 0 ? criteria : fallback.criteria;
  return finalCriteria
    ? { type: fallback.type, instructions, criteria: finalCriteria }
    : { type: fallback.type, instructions };
}

/** 解析 `prompts/memory-radar.md`（向后兼容缺省节，自动回落默认判据） */
export function parseMemoryRadarPrompt(body: string): RadarPromptSpec {
  const topHeadingRe =
    /^#\s+(redundant|contradiction|obsolete|link|promote|representation|board_obsolete|board_contradiction)[ \t]*\r?$/gm;
  const sections = new Map<string, string>();
  const matches: Array<{ name: string; start: number; contentStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = topHeadingRe.exec(body)) !== null) {
    matches.push({ name: m[1]!, start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const nextStart = i + 1 < matches.length ? matches[i + 1]!.start : body.length;
    sections.set(cur.name, body.slice(cur.contentStart, nextStart));
  }

  return {
    redundant: parseSubSectionQuestion(sections.get("redundant"), DEFAULT_RADAR_PROMPT_SPEC.redundant, [
      "true",
      "false",
    ]),
    contradiction: parseSubSectionQuestion(
      sections.get("contradiction"),
      DEFAULT_RADAR_PROMPT_SPEC.contradiction,
      ["true", "false"],
    ),
    obsolete: parseSubSectionQuestion(sections.get("obsolete"), DEFAULT_RADAR_PROMPT_SPEC.obsolete, [
      "true",
      "false",
    ]),
    link: parseSubSectionQuestion(sections.get("link"), DEFAULT_RADAR_PROMPT_SPEC.link, ["true", "false"]),
    promote: parseSubSectionQuestion(sections.get("promote"), DEFAULT_RADAR_PROMPT_SPEC.promote, [
      "true",
      "false",
    ]),
    representation: parseSubSectionQuestion(
      sections.get("representation"),
      DEFAULT_RADAR_PROMPT_SPEC.representation,
      ["keep_separate", "merge", "promote", "uncertain"],
    ),
    boardObsolete: parseSubSectionQuestion(
      sections.get("board_obsolete"),
      DEFAULT_RADAR_PROMPT_SPEC.boardObsolete,
      ["true", "false"],
    ),
    boardContradiction: parseSubSectionQuestion(
      sections.get("board_contradiction"),
      DEFAULT_RADAR_PROMPT_SPEC.boardContradiction,
      ["true", "false"],
    ),
  };
}

async function loadRadarPromptSpec(promptsDir?: string): Promise<RadarPromptSpec> {
  const dir = promptsDir ?? DEFAULT_PROMPTS_DIR;
  try {
    const loaded = await readPrompt(dir, "memory-radar.md");
    return parseMemoryRadarPrompt(loaded.body);
  } catch {
    return DEFAULT_RADAR_PROMPT_SPEC;
  }
}

function buildRadarQuestion(spec: RadarQuestionSpec, itemId?: string): DecisionQuestion {
  const render = (s: string) => (itemId ? s.replaceAll("{{item_id}}", itemId) : s);
  const q: DecisionQuestion = {
    type: spec.type,
    instructions: render(spec.instructions),
  };
  if (spec.criteria) {
    const renderedCriteria: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.criteria)) {
      if (v.trim()) renderedCriteria[k] = render(v);
    }
    if (Object.keys(renderedCriteria).length > 0) {
      q.criteria = renderedCriteria;
    }
  }
  return q;
}

function clipText(text: string, maxChars: number): string {
  const cleaned = sanitizeUnicode(text.replace(/\s+/g, " ").trim());
  if (cleaned.length <= maxChars) return cleaned;
  return sanitizeUnicode(`${cleaned.slice(0, Math.max(20, maxChars - 1))}…`);
}

function finiteOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function finiteOpt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export interface BoardItem {
  id: string;
  filePath: "core/state.md" | "core/open.md";
  section?: string;
  text: string;
}

/** 提取 `core/state.md` 或 `core/open.md` 中的有效列表条目（跳过空行、占位文案与已严格过期的 state 条目） */
export function extractBoardItems(
  filePath: "core/state.md" | "core/open.md",
  rawMarkdown: string,
  targetDay: string,
): BoardItem[] {
  const body = stripFrontmatter(rawMarkdown);
  const lines = body.split(/\r?\n/);
  const items: BoardItem[] = [];
  let currentSection: string | undefined;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const hMatch = /^#{1,4}\s+(.+)$/.exec(trimmed);
    if (hMatch) {
      currentSection = hMatch[1]!.trim();
      continue;
    }
    const bulletMatch = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(trimmed);
    if (!bulletMatch) continue;
    const content = bulletMatch[1]!.trim();
    if (!content || content.length < 4 || PLACEHOLDER_ITEM_RE.test(content)) continue;

    // core/state.md 中 [至 YYYY-MM-DD] 已早于今日的条目由 tidy.md 按确定性规则清理，不浪费快脑调用
    if (filePath === "core/state.md") {
      const exp = EXPIRY_TAG_RE.exec(content);
      if (exp && exp[1]! < targetDay) continue;
    }

    items.push({
      id: "",
      filePath,
      ...(currentSection ? { section: currentSection } : {}),
      text: clipText(content, 240),
    });
  }
  return items;
}

/** 检查两张卡片在 `card_links` 派生表中是否已经存在任意方向的站内链接（用于 `link` 提问短路） */
export function hasExistingCardLink(db: Database, a: CardIndexRow, b: CardIndexRow): boolean {
  const normA = normalizeWikiTitle(a.title);
  const normB = normalizeWikiTitle(b.title);
  const row = db
    .query(
      `SELECT 1 FROM card_links
       WHERE (src_path = ? AND ((link_kind = 'path' AND target_ref = ?) OR (link_kind = 'wiki' AND target_ref = ?)))
          OR (src_path = ? AND ((link_kind = 'path' AND target_ref = ?) OR (link_kind = 'wiki' AND target_ref = ?)))
       LIMIT 1`,
    )
    .get(a.path, b.path, normB, b.path, a.path, normA);
  return Boolean(row);
}

/**
 * 预加载当前活跃卡片的 `card_links` 双向关联索引：
 * - 单次 SQLite 查询构建内存邻接表，将 O(newCards × oldCards) 次同步查询降为 1 次查询 + O(1) 查表。
 */
function buildCardLinkChecker(
  db: Database,
  rows: readonly CardIndexRow[],
): (a: CardIndexRow, b: CardIndexRow) => boolean {
  const normTitleByPath = new Map<string, string>();
  for (const r of rows) {
    normTitleByPath.set(r.path, normalizeWikiTitle(r.title));
  }
  const pathLinks = new Set<string>();
  const wikiLinks = new Set<string>();
  try {
    const linkRows = db
      .query(`SELECT src_path, link_kind, target_ref FROM card_links`)
      .all() as Array<{ src_path: string; link_kind: string; target_ref: string }>;
    for (const lr of linkRows) {
      if (lr.link_kind === "path") {
        pathLinks.add(`${lr.src_path}\0${lr.target_ref}`);
      } else if (lr.link_kind === "wiki") {
        wikiLinks.add(`${lr.src_path}\0${lr.target_ref}`);
      }
    }
  } catch {
    return (a, b) => hasExistingCardLink(db, a, b);
  }

  return (a: CardIndexRow, b: CardIndexRow): boolean => {
    const normA = normTitleByPath.get(a.path) ?? normalizeWikiTitle(a.title);
    const normB = normTitleByPath.get(b.path) ?? normalizeWikiTitle(b.title);
    return (
      pathLinks.has(`${a.path}\0${b.path}`) ||
      pathLinks.has(`${b.path}\0${a.path}`) ||
      (Boolean(normB) && wikiLinks.has(`${a.path}\0${normB}`)) ||
      (Boolean(normA) && wikiLinks.has(`${b.path}\0${normA}`))
    );
  };
}

interface CandidatePair {
  newCard: CardIndexRow;
  oldCard: CardIndexRow;
  similarity: number;
  alreadyLinked: boolean;
}

function formatCardBlock(tag: string, row: CardIndexRow, body: string, timeZone: string): string {
  const createdDay = localDay(row.created_at, timeZone);
  const updatedDay = localDay(row.updated_at, timeZone);
  const headerParts = [
    `path: ${row.path}`,
    `title: ${row.title}`,
    `space: ${row.space}`,
    `kind: ${row.kind}`,
    `status: ${row.status}`,
    `created: ${createdDay}`,
    `updated: ${updatedDay}`,
  ];
  if (row.when_to_recall) {
    headerParts.push(`when_to_recall: ${row.when_to_recall}`);
  }
  return `<${tag}>\n${headerParts.join(" | ")}\n---\n${clipText(body, 750)}\n</${tag}>`;
}

function compareFindings(a: RadarFinding, b: RadarFinding): number {
  const pa = FINDING_PRIORITY[a.kind];
  const pb = FINDING_PRIORITY[b.kind];
  if (pa !== pb) return pa - pb;
  return b.score - a.score;
}

function selectPairFindings(opts: {
  scope: RadarScope;
  newCard: CardIndexRow;
  oldCard: CardIndexRow;
  alreadyLinked: boolean;
  answers: Record<string, { noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  thresholds: RadarThresholdsConfig;
}): RadarFinding | null {
  const { scope, newCard, oldCard, alreadyLinked, answers, thresholds } = opts;
  const newIsEp = isEpisodeSlicePath(newCard.path);
  const oldIsEp = isEpisodeSlicePath(oldCard.path);

  const candidates: RadarFinding[] = [];

  const contradictionScore = finiteOrZero(answers.contradiction?.noul);
  if (contradictionScore >= thresholds.contradiction) {
    candidates.push({
      kind: "contradiction",
      score: contradictionScore,
      source: "pair",
      newCardPath: newCard.path,
      newCardTitle: newCard.title,
      targetPath: oldCard.path,
      targetTitle: oldCard.title,
      detail: `contradiction=${contradictionScore.toFixed(2)}（建议 read 两张原文确认是偏好/情况演进还是前后说法冲突）`,
    });
  }

  // 空间硬护栏：历史情景切片 ep-*.md 不标记过时（不回改历史日记）
  const obsoleteScore = finiteOrZero(answers.obsolete?.noul);
  if (!oldIsEp && obsoleteScore >= thresholds.obsolete) {
    candidates.push({
      kind: "obsolete",
      score: obsoleteScore,
      source: "pair",
      newCardPath: newCard.path,
      newCardTitle: newCard.title,
      targetPath: oldCard.path,
      targetTitle: oldCard.title,
      detail: `obsolete=${obsoleteScore.toFixed(2)}（建议核对旧卡状态或进度是否已被新进展取代）`,
    });
  }

  const directPromoteScore = finiteOrZero(answers.promote?.noul);
  const redundantScore = finiteOrZero(answers.redundant?.noul);

  const repAns = answers.representation;
  const repChoice = repAns?.choice;
  const rawChoiceProb =
    repChoice && repAns?.probabilities
      ? finiteOpt(repAns.probabilities[repChoice])
      : undefined;
  const rawConfidence = finiteOpt(repAns?.confidence);
  // 若原生 Decisions API 提供概率分布或降级模型返回 confidence 则直接采用；若两者均缺省，则对齐同轮校准的 noul 分（绝不以硬编码 0.80 绕过阈值，也杜绝 NaN 污染）
  const repProb =
    rawChoiceProb ??
    rawConfidence ??
    (repChoice === "promote"
      ? directPromoteScore
      : repChoice === "merge"
        ? redundantScore
        : 0);

  // 独立 noul promote（与保留原卡不互斥）优先；同时兼容 representation=promote
  const choicePromoteScore = repChoice === "promote" ? repProb : 0;
  const promoteScore = Math.max(directPromoteScore, choicePromoteScore);
  if (promoteScore >= thresholds.promote) {
    const label =
      directPromoteScore >= choicePromoteScore
        ? `promote=${directPromoteScore.toFixed(2)}`
        : `representation=promote(${choicePromoteScore.toFixed(2)})`;
    candidates.push({
      kind: "promote",
      score: promoteScore,
      source: "pair",
      newCardPath: newCard.path,
      newCardTitle: newCard.title,
      targetPath: oldCard.path,
      targetTitle: oldCard.title,
      detail: `${label}（跨天反复出现相似主题或规律，可结合相关记录看是否值得提炼进 lessons/、core/ 或建专卡）`,
    });
  }

  // 空间硬护栏：仅非情景切片的持久专卡才放出 merge / redundant 建议（专卡提炼自情景切片属正常分工，不判重复）
  if (!newIsEp && !oldIsEp && repChoice === "merge" && repProb >= thresholds.merge) {
    const extra = redundantScore >= thresholds.redundant ? `、redundant=${redundantScore.toFixed(2)}` : "";
    candidates.push({
      kind: "merge",
      score: Math.max(repProb, redundantScore),
      source: "pair",
      newCardPath: newCard.path,
      newCardTitle: newCard.title,
      targetPath: oldCard.path,
      targetTitle: oldCard.title,
      detail: `representation=merge(${repProb.toFixed(2)})${extra}（两张持久专卡疑似重复或碎片化，可自行确认是否适合合并整理）`,
    });
  } else if (!newIsEp && !oldIsEp && redundantScore >= thresholds.redundant) {
    candidates.push({
      kind: "redundant",
      score: redundantScore,
      source: "pair",
      newCardPath: newCard.path,
      newCardTitle: newCard.title,
      targetPath: oldCard.path,
      targetTitle: oldCard.title,
      detail: `redundant=${redundantScore.toFixed(2)}（内容高度重叠，可核对是否与既有专卡重复记录）`,
    });
  }

  // 分工约定：link 仅在 bedtime 展示，且仅当两卡尚未建立双向链接
  const linkScore = finiteOrZero(answers.link?.noul);
  if (scope === "bedtime" && !alreadyLinked && linkScore >= thresholds.link) {
    candidates.push({
      kind: "link",
      score: linkScore,
      source: "pair",
      newCardPath: newCard.path,
      newCardTitle: newCard.title,
      targetPath: oldCard.path,
      targetTitle: oldCard.title,
      detail: `link=${linkScore.toFixed(2)}（两卡当前尚无 [[短标题]] 互链，可按需补链以增强未来 1 跳联想）`,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort(compareFindings);
  return candidates[0]!;
}

/**
 * 将雷达命中的线索渲染为客观中立的 `<memory_radar>` 上下文块：
 * - 严守 `prompts/README.md`「判断禁用我」：用系统客观口吻说明可能误报且未改任何文件，处置权完全归 Psyber；
 * - 无命中时返回 `null`（零注入、零打扰）。
 */
/**
 * 纯本地 SQLite + threads/REGISTRY.yaml 扫描久未更新的 threads/ 活跃卡片（0 LLM 调用，绝不改盘）：
 * - 豁免：decay: none、space === 'thread:lists'、kind === 'work'；
 * - 阈值：decay: short >= 30 天，decay: slow（或未登记）>= 90 天；
 * - 活跃度时间取 max(updated_at, last_accessed ?? 0, latestInboundLinkUpdatedAt)，兼顾历史导入卡与实时对话卡；
 * - 每次周反思最多返回 5 条最久未活跃线索，避免刷屏。
 */
export async function scanStaleThreadFindings(opts: {
  db: Database;
  dataDir: string;
  memoryIndex: MemoryIndex;
  nowMs: number;
  maxItems?: number;
}): Promise<RadarFinding[]> {
  const { db, dataDir, memoryIndex, nowMs } = opts;
  const maxItems = Math.max(0, Math.floor(opts.maxItems ?? 5));
  if (maxItems <= 0) return [];

  const decayBySlug = new Map<string, "none" | "slow" | "short">();
  try {
    const regPath = path.join(dataDir, "memory", "threads", "REGISTRY.yaml");
    const rawYaml = await fs.readFile(regPath, "utf8");
    const parsed = YAML.parse(rawYaml) as { spaces?: Record<string, { decay?: string }> } | null;
    if (parsed?.spaces && typeof parsed.spaces === "object") {
      for (const [slug, cfg] of Object.entries(parsed.spaces)) {
        const d = cfg?.decay;
        if (d === "none" || d === "slow" || d === "short") {
          decayBySlug.set(slug, d);
        }
      }
    }
  } catch {
    // 无 REGISTRY.yaml 或解析失败时按默认 slow(90 天) 处理
  }

  const threadRows = memoryIndex.listAllRows().filter((r) => {
    if (!r.space.startsWith("thread:")) return false;
    if (r.space === "thread:lists") return false;
    if (r.kind === "work") return false;
    const slug = r.space.slice("thread:".length);
    if (decayBySlug.get(slug) === "none") return false;
    return effectiveStatus(r, nowMs) === "active";
  });
  if (threadRows.length === 0) return [];

  const maxInboundByPath = new Map<string, number>();
  const maxInboundByWiki = new Map<string, number>();
  try {
    const edges = db
      .query(
        `SELECT l.src_path, l.link_kind, l.target_ref, s.updated_at
         FROM card_links l
         JOIN card_index s ON s.path = l.src_path
         WHERE s.status NOT IN ('resolved', 'archived', 'faded')`,
      )
      .all() as Array<{ src_path: string; link_kind: string; target_ref: string; updated_at: number }>;
    for (const e of edges) {
      if (e.link_kind === "path") {
        if (e.src_path === e.target_ref) continue;
        const prev = maxInboundByPath.get(e.target_ref) ?? 0;
        if (e.updated_at > prev) maxInboundByPath.set(e.target_ref, e.updated_at);
      } else if (e.link_kind === "wiki") {
        const prev = maxInboundByWiki.get(e.target_ref) ?? 0;
        if (e.updated_at > prev) maxInboundByWiki.set(e.target_ref, e.updated_at);
      }
    }
  } catch {
    // 忽略链接查询异常
  }

  const staleEntries: Array<{ row: CardIndexRow; idleDays: number; decay: "slow" | "short"; thresholdDays: number }> = [];
  for (const row of threadRows) {
    const slug = row.space.slice("thread:".length);
    const decay = decayBySlug.get(slug) === "short" ? "short" : "slow";
    const thresholdDays = decay === "short" ? 30 : 90;
    const normTitle = normalizeWikiTitle(row.title);
    const inboundPathAt = maxInboundByPath.get(row.path) ?? 0;
    const inboundWikiAt = normTitle ? (maxInboundByWiki.get(normTitle) ?? 0) : 0;
    const lastActivityAt = Math.max(row.updated_at, row.last_accessed ?? 0, inboundPathAt, inboundWikiAt);
    const idleDays = Math.floor((nowMs - lastActivityAt) / 86_400_000);
    if (idleDays >= thresholdDays) {
      staleEntries.push({ row, idleDays, decay, thresholdDays });
    }
  }

  staleEntries.sort((a, b) => b.idleDays - a.idleDays || a.row.path.localeCompare(b.row.path));
  return staleEntries.slice(0, maxItems).map((item) => {
    const recallNote =
      item.row.access_count === 0
        ? "（尚未被召回，历史导入属正常）"
        : `（累计召回 ${item.row.access_count} 次）`;
    const score = Math.min(0.99, 0.5 + (item.idleDays - item.thresholdDays) / (item.thresholdDays * 4));
    return {
      kind: "stale" as const,
      score,
      source: "stale" as const,
      targetPath: item.row.path,
      targetTitle: item.row.title,
      detail: `已 ${item.idleDays} 天无更新、无入链提及且未被召回（decay=${item.decay}，阈值 ${item.thresholdDays} 天）${recallNote}；若话题已自然淡出可考虑改为 status: faded，若仍长期有效可保持 active 或调整对应空间 decay: none`,
    };
  });
}

export function renderMemoryRadarBlock(
  findings: readonly RadarFinding[],
  opts: {
    scope: RadarScope;
    includeOpenBoard?: boolean;
    maxItems?: number;
  },
): string | null {
  const filtered = findings.filter((f) => {
    if (opts.scope === "weekly" && f.kind === "link") return false;
    if (opts.scope === "bedtime" && f.kind === "stale") return false;
    if (!opts.includeOpenBoard && f.source === "board" && f.targetPath === "core/open.md") {
      return false;
    }
    return true;
  });
  if (filtered.length === 0) return null;

  const rawLimit = opts.maxItems ?? (opts.scope === "bedtime" ? 5 : 8);
  const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 0;
  if (limit <= 0) return null;
  const top = [...filtered].sort(compareFindings).slice(0, limit);
  if (top.length === 0) return null;

  const allowReflectTargets = opts.scope === "weekly" || Boolean(opts.includeOpenBoard);
  const sectionMeta: Array<{ kinds: RadarFindingKind[]; header: string }> = [
    { kinds: ["contradiction"], header: "[疑似前后矛盾 / 待核实]" },
    { kinds: ["obsolete"], header: "[疑似过时 / 可核对闭环]" },
    { kinds: ["promote"], header: "[跨天反复出现 / 可考虑提炼]" },
    { kinds: ["merge", "redundant"], header: "[疑似重复专卡 / 可考虑整理]" },
    { kinds: ["link"], header: "[可考虑补双链]" },
    { kinds: ["stale"], header: "[久未更新 / 可考虑淡出]" },
  ];

  const lines: string[] = [
    "<memory_radar>",
    "说明：以下为系统只读比对扫出的疑似记忆线索（基于相似度、活跃度与轻量分类器初筛，可能存在误报），系统未修改任何文件；是否需要查阅原文、修改卡片、调整状态、补链或忽略，完全由你自己决定。",
  ];

  for (const sec of sectionMeta) {
    const group = top.filter((f) => sec.kinds.includes(f.kind));
    if (group.length === 0) continue;
    lines.push("", sec.header);
    for (const f of group) {
      const detailText =
        !allowReflectTargets && f.kind === "promote"
          ? f.detail.replace(
              "提炼进 lessons/、core/ 或建专卡",
              "归档或更新进 threads/、entities/ 持久专卡（本轮非反思轮，不改 lessons/ 与 core/）",
            )
          : f.detail;
      if (f.source === "board") {
        lines.push(`- 看板 \`${f.targetPath}\` 条目：「${f.targetTitle}」`);
        lines.push(`  信号：${detailText}`);
      } else if (f.source === "stale") {
        lines.push(`- 长期线索 \`${f.targetPath}\`（[[${f.targetTitle}]]）`);
        lines.push(`  信号：${detailText}`);
      } else {
        const newLabel = f.newCardPath
          ? `\`${f.newCardPath}\`（[[${f.newCardTitle ?? f.newCardPath}]]）`
          : "近期新卡";
        const oldLabel = `\`${f.targetPath}\`（[[${f.targetTitle}]]）`;
        lines.push(`- 新卡 ${newLabel} ↔ 旧卡 ${oldLabel}`);
        lines.push(`  信号：${detailText}`);
      }
    }
  }

  lines.push("</memory_radar>");
  return lines.join("\n");
}

/**
 * 提取供日/周反思门控综合参考的高置信雷达线索摘要：
 * - 仅提炼 `contradiction`、`promote` 以及 `core/open.md` 的 `obsolete` 线索；
 * - 作为参考上下文交由反思门控的 DecisionClient 综合裁决，绝不硬触发主模型反思。
 */
export function buildReflectGateRadarHint(findings: readonly RadarFinding[]): string | null {
  const notable = findings
    .filter(
      (f) =>
        f.kind === "contradiction" ||
        f.kind === "promote" ||
        (f.source === "board" && f.targetPath === "core/open.md" && f.kind === "obsolete"),
    )
    .sort(compareFindings)
    .slice(0, 4);

  if (notable.length === 0) return null;

  const lines = notable.map((f) => {
    if (f.source === "board") {
      return `- [${f.kind} ${f.score.toFixed(2)}] ${f.targetPath} 条目「${clipText(f.targetTitle, 80)}」`;
    }
    return `- [${f.kind} ${f.score.toFixed(2)}] [[${f.newCardTitle ?? f.newCardPath}]] ↔ [[${f.targetTitle}]]`;
  });
  return `只读体检雷达扫出的高置信线索（供门控综合参考，可能误报）：\n${lines.join("\n")}`;
}

export interface RunMemoryRadarOptions {
  db: Database;
  dataDir: string;
  promptsDir?: string;
  clock: Clock;
  memoryIndex: MemoryIndex;
  decisionClient?: DecisionClient;
  embedding?: EmbeddingClient;
  scope: RadarScope;
  targetDay?: string;
  /** 本周期新增或修改的记忆相对路径（如今日新卡或本周 Git diff 实质路径） */
  newCardPaths: readonly string[];
  radarConfig?: Partial<RadarConfig>;
  /** 普通情景切片软淡出天数（默认 90，0 禁用） */
  episodeFadeDays?: number;
  /** bedtime 未合并日反思时不把 core/open.md 渲染进 <memory_radar>（默认 weekly=true, bedtime=false） */
  includeOpenBoardInBlock?: boolean;
  /** 是否收集各看板条目与卡片对的原始打分明细（仅离线干跑与调参使用） */
  collectDebug?: boolean;
  signal?: AbortSignal;
}

/**
 * 执行一次快脑只读体检雷达扫描（绝不修改任何文件，任何超时或异常均静默降级）。
 */
export async function runMemoryRadar(opts: RunMemoryRadarOptions): Promise<MemoryRadarResult> {
  const cfg = mergeRadarConfig(opts.radarConfig);
  const scope = opts.scope;
  const empty = (skipReason: string): MemoryRadarResult => ({
    executed: false,
    skipReason,
    scope,
    boardItemsChecked: 0,
    pairsEvaluated: 0,
    findings: [],
    renderedBlock: null,
    reflectGateHint: null,
  });

  if (!cfg.enabled) {
    return empty("disabled");
  }

  const nowMs = opts.clock.now();
  const targetDay = opts.targetDay ?? localDay(nowMs, opts.clock.timeZone);
  const memoryDir = path.join(opts.dataDir, "memory");

  if (!opts.decisionClient) {
    if (scope === "weekly") {
      const staleFindings = await scanStaleThreadFindings({
        db: opts.db,
        dataDir: opts.dataDir,
        memoryIndex: opts.memoryIndex,
        nowMs,
      }).catch(() => []);
      if (staleFindings.length > 0) {
        const renderedBlock = renderMemoryRadarBlock(staleFindings, {
          scope: "weekly",
          includeOpenBoard: opts.includeOpenBoardInBlock ?? true,
          maxItems: cfg.maxFindingsWeekly,
        });
        return {
          executed: true,
          scope,
          boardItemsChecked: 0,
          pairsEvaluated: 0,
          findings: staleFindings,
          renderedBlock,
          reflectGateHint: null,
        };
      }
    }
    return empty("no_decision_client");
  }

  try {
    const softFadedEpisodes = opts.memoryIndex.computeSoftFadedEpisodePaths({
      fadeAfterDays: opts.episodeFadeDays ?? 90,
      nowMs,
    });
    const allRows = opts.memoryIndex.listAllRows();
    const eligibleRows = allRows.filter(
      (r) => isEligibleRadarRow(r, nowMs) && !softFadedEpisodes.has(r.path),
    );
    const eligibleByPath = new Map<string, CardIndexRow>();
    for (const r of eligibleRows) eligibleByPath.set(r.path, r);

    const uniqueNewPaths = Array.from(new Set(opts.newCardPaths));
    const maxNewCards = scope === "bedtime" ? 8 : 15;
    const allNewEligible = uniqueNewPaths
      .map((p) => eligibleByPath.get(p))
      .filter((r): r is CardIndexRow => Boolean(r))
      .sort((a, b) => b.updated_at - a.updated_at);
    // 防止同批更新的多张持久专卡挤光预算：先按情景切片与持久专卡交替保底，再按时间补齐
    const newEpisodes = allNewEligible.filter((r) => isEpisodeSlicePath(r.path));
    const newDurables = allNewEligible.filter((r) => !isEpisodeSlicePath(r.path));
    const maxEpQuota = Math.ceil(maxNewCards * 0.65);
    const newCards = [
      ...newEpisodes.slice(0, maxEpQuota),
      ...newDurables,
      ...newEpisodes.slice(maxEpQuota),
    ].slice(0, maxNewCards);

    if (newCards.length === 0) {
      if (scope === "weekly") {
        const staleFindings = await scanStaleThreadFindings({
          db: opts.db,
          dataDir: opts.dataDir,
          memoryIndex: opts.memoryIndex,
          nowMs,
        }).catch(() => []);
        if (staleFindings.length > 0) {
          const renderedBlock = renderMemoryRadarBlock(staleFindings, {
            scope: "weekly",
            includeOpenBoard: opts.includeOpenBoardInBlock ?? true,
            maxItems: cfg.maxFindingsWeekly,
          });
          return {
            executed: true,
            scope,
            boardItemsChecked: 0,
            pairsEvaluated: 0,
            findings: staleFindings,
            renderedBlock,
            reflectGateHint: null,
          };
        }
      }
      return empty("no_eligible_new_cards");
    }

    const newPathSet = new Set(newCards.map((c) => c.path));
    const oldCards = eligibleRows.filter((r) => !newPathSet.has(r.path));
    // weekly 模式下 newCardPaths 跨越整周多天，允许不同日的新卡之间以及与旧卡之间互相比对（亦兼容首次周反思无历史旧卡）
    const comparePool = scope === "weekly" ? eligibleRows : oldCards;

    const promptSpec = await loadRadarPromptSpec(opts.promptsDir);
    const deadline = Date.now() + Math.max(500, cfg.timeoutMs);
    let timedOut = false;

    const bodyCache = new Map<string, Promise<string | null>>();
    const readCardBody = (relPath: string): Promise<string | null> => {
      const existing = bodyCache.get(relPath);
      if (existing) return existing;
      const p = (async () => {
        try {
          const raw = await fs.readFile(path.join(memoryDir, relPath), "utf8");
          return stripFrontmatter(raw).trim();
        } catch {
          return null;
        }
      })();
      bodyCache.set(relPath, p);
      return p;
    };

    const findings: RadarFinding[] = [];
    const debugBoardItems: RadarBoardDebugItem[] = [];
    const debugPairs: RadarPairDebugItem[] = [];
    let matchMethod: "embedding" | "fts" = "fts";
    let boardItemsChecked = 0;
    let pairsEvaluated = 0;

    // 路 1：看板条目巡检（core/state.md + core/open.md，每份文件保底 6 条配额、总上限 12 条，防止单一看板占满预算饿死另一份）
    const maxBoardItems = 12;
    const perBoardQuota = 6;
    const boardFiles: Array<"core/state.md" | "core/open.md"> =
      scope === "bedtime" ? ["core/state.md", "core/open.md"] : ["core/open.md", "core/state.md"];
    const extractedByBoard: BoardItem[][] = [];
    for (const rel of boardFiles) {
      try {
        const raw = await fs.readFile(path.join(memoryDir, rel), "utf8");
        extractedByBoard.push(extractBoardItems(rel, raw, targetDay));
      } catch {
        extractedByBoard.push([]);
      }
    }
    const boardItems: BoardItem[] = [];
    for (const list of extractedByBoard) {
      for (const item of list.slice(0, perBoardQuota)) {
        if (boardItems.length < maxBoardItems) boardItems.push(item);
      }
    }
    for (const list of extractedByBoard) {
      for (const item of list.slice(perBoardQuota)) {
        if (boardItems.length >= maxBoardItems) break;
        boardItems.push(item);
      }
    }

    if (boardItems.length > 0) {
      if (deadline - Date.now() <= 300) {
        timedOut = true;
      } else {
        const newCardBodies = await Promise.all(newCards.map((c) => readCardBody(c.path)));
        const newCardSummaries: string[] = newCards.map((c, idx) => {
          const body = newCardBodies[idx] ?? "";
          return `- [${c.path}] [[${c.title}]] (${localDay(c.updated_at, opts.clock.timeZone)}): ${clipText(body, 220)}`;
        });
        const boardLines: string[] = [];
        const boardQuestions: Record<string, DecisionQuestion> = {};
        for (let i = 0; i < boardItems.length; i++) {
          const item = boardItems[i]!;
          const id = `b${i}`;
          item.id = id;
          const secTag = item.section ? ` / ${item.section}` : "";
          boardLines.push(`[${id}] (${item.filePath}${secTag}) ${item.text}`);
          boardQuestions[`ob_${id}`] = buildRadarQuestion(promptSpec.boardObsolete, `[${id}]`);
          boardQuestions[`ct_${id}`] = buildRadarQuestion(promptSpec.boardContradiction, `[${id}]`);
        }

        const boardInput = sanitizeUnicode(
          [
            `当前日期：${targetDay}`,
            `<new_cards>\n${newCardSummaries.join("\n")}\n</new_cards>`,
            `<board_items>\n${boardLines.join("\n")}\n</board_items>`,
          ].join("\n\n"),
        );

        try {
          const rem = deadline - Date.now();
          const res = await opts.decisionClient.decide({
            input: boardInput,
            questions: boardQuestions,
            signal: combineTimeoutSignal(opts.signal, Math.min(10_000, rem)),
          });
          boardItemsChecked = boardItems.length;

          for (const item of boardItems) {
            const obScore = finiteOrZero(res.answers[`ob_${item.id}`]?.noul);
            const ctScore = finiteOrZero(res.answers[`ct_${item.id}`]?.noul);
            if (opts.collectDebug) {
              debugBoardItems.push({
                id: item.id,
                filePath: item.filePath,
                text: item.text,
                obsoleteScore: obScore,
                contradictionScore: ctScore,
              });
            }
            if (ctScore >= cfg.thresholds.contradiction && ctScore >= obScore) {
              findings.push({
                kind: "contradiction",
                score: ctScore,
                source: "board",
                targetPath: item.filePath,
                targetTitle: item.text,
                detail: `board_contradiction=${ctScore.toFixed(2)}（与近期新卡疑似存在说法冲突，建议核实）`,
              });
            } else if (obScore >= cfg.thresholds.obsolete) {
              findings.push({
                kind: "obsolete",
                score: obScore,
                source: "board",
                targetPath: item.filePath,
                targetTitle: item.text,
                detail: `board_obsolete=${obScore.toFixed(2)}（建议核对是否已恢复/完成/闭环可清理）`,
              });
            }
          }
        } catch (err) {
          if (opts.signal?.aborted) {
            return {
              executed: true,
              scope,
              boardItemsChecked,
              pairsEvaluated,
              findings,
              renderedBlock: null,
              reflectGateHint: null,
              timedOut: true,
              error: "Aborted",
            };
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (deadline - Date.now() <= 0 || /timeout|abort/i.test(msg)) {
            timedOut = true;
          }
          console.warn(`[psyber] memory radar(${scope}) board check failed:`, err);
        }
      }
    }

    if (opts.signal?.aborted) {
      return {
        executed: true,
        scope,
        boardItemsChecked,
        pairsEvaluated,
        findings,
        renderedBlock: null,
        reflectGateHint: null,
        timedOut: true,
        error: "Aborted",
      };
    }

    // 路 2：新卡 vs 相似旧卡 5 问并行扫描
    const maxPairs = scope === "bedtime" ? cfg.maxPairsDaily : cfg.maxPairsWeekly;
    const candidatePairs: CandidatePair[] = [];
    const checkLinked = buildCardLinkChecker(opts.db, eligibleRows);

    if (comparePool.length > 0) {
      if (deadline - Date.now() <= 400) {
        timedOut = true;
      } else {
        const seenPairKeys = new Set<string>();
        const canPairWith = (
          newCard: CardIndexRow,
          oldCard: CardIndexRow,
        ): { ok: boolean; alreadyLinked: boolean } => {
          if (newCard.path === oldCard.path) return { ok: false, alreadyLinked: false };
          // 同日兄弟情景切片是有意按「一事一卡」拆开的，不互相送审
          const newDay = episodeDateFromPath(newCard.path);
          const oldDay = episodeDateFromPath(oldCard.path);
          if (newDay && oldDay && newDay === oldDay) return { ok: false, alreadyLinked: false };
          const alreadyLinked = checkLinked(newCard, oldCard);
          // 持久专卡 ↔ 已被其双链引用的历史情景切片属于正常溯源关系，跳过以免高相似度挤占配对预算
          if (!isEpisodeSlicePath(newCard.path) && isEpisodeSlicePath(oldCard.path) && alreadyLinked) {
            return { ok: false, alreadyLinked: true };
          }
          return { ok: true, alreadyLinked };
        };

        const addPair = (
          newCard: CardIndexRow,
          oldCard: CardIndexRow,
          similarity: number,
          precheckedLink?: boolean,
        ): boolean => {
          let alreadyLinked: boolean;
          if (precheckedLink !== undefined) {
            alreadyLinked = precheckedLink;
          } else {
            const check = canPairWith(newCard, oldCard);
            if (!check.ok) return false;
            alreadyLinked = check.alreadyLinked;
          }
          const key =
            newCard.path < oldCard.path
              ? `${newCard.path}\0${oldCard.path}`
              : `${oldCard.path}\0${newCard.path}`;
          if (seenPairKeys.has(key)) return false;
          seenPairKeys.add(key);
          candidatePairs.push({ newCard, oldCard, similarity, alreadyLinked });
          return true;
        };

        let usedEmbedding = false;
        const embeddingActive = Boolean(opts.embedding && opts.embedding.isConfigured?.() !== false);
        if (embeddingActive && opts.embedding) {
          const vecByPath = new Map<string, Float32Array>();
          const remBeforeEmbed = deadline - Date.now();
          const maxEmbedWindow = Math.max(200, remBeforeEmbed - 250);
          const embedBudget = Math.min(
            maxEmbedWindow,
            Math.max(Math.min(2_000, maxEmbedWindow), Math.floor(remBeforeEmbed * 0.55)),
          );
          try {
            const rowsToEmbed =
              scope === "weekly" ? eligibleRows : [...newCards, ...oldCards];
            await ensureCardEmbeddings({
              db: opts.db,
              memoryDir,
              rows: rowsToEmbed,
              embedding: opts.embedding,
              nowMs,
              embedTimeoutMs: Math.min(8_000, embedBudget),
              maxTotalTimeoutMs: embedBudget,
              readCardBody,
              outMap: vecByPath,
              signal: opts.signal,
            });
            usedEmbedding = true;
            matchMethod = "embedding";
          } catch (err) {
            if (opts.signal?.aborted) {
              return {
                executed: true,
                scope,
                boardItemsChecked,
                pairsEvaluated,
                findings,
                renderedBlock: null,
                reflectGateHint: null,
                timedOut: true,
                error: "Aborted",
              };
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (deadline - Date.now() <= 0 || /deadline|timeout|abort/i.test(msg)) {
              timedOut = true;
            }
            // 若新卡与部分旧卡已在超时前命中缓存或完成分块，直接复用已有向量配对，避免白丢已算向量
            const hasNewVec = newCards.some((nc) => vecByPath.has(nc.path));
            const hasPoolVec = comparePool.some(
              (oc) => !newPathSet.has(oc.path) && vecByPath.has(oc.path),
            );
            if (hasNewVec && hasPoolVec) {
              usedEmbedding = true;
              matchMethod = "embedding";
              console.warn(
                `[psyber] memory radar(${scope}) embedding partially timed out, pairing with ${vecByPath.size} available vectors:`,
                err,
              );
            } else {
              console.warn(
                `[psyber] memory radar(${scope}) embedding failed, falling back to FTS5:`,
                err,
              );
            }
          }

          if (usedEmbedding) {
            for (const nc of newCards) {
              const nVec = vecByPath.get(nc.path);
              if (!nVec) continue;
              const scored: Array<{ row: CardIndexRow; sim: number; alreadyLinked: boolean }> = [];
              for (const oc of comparePool) {
                if (nc.path === oc.path) continue;
                const oVec = vecByPath.get(oc.path);
                if (!oVec) continue;
                const sim = cosineSimilarity(nVec, oVec);
                if (sim < cfg.minSimilarity) continue;
                // 先过余弦门槛再做同日/双链过滤，既保证同日兄弟卡不占 Top-K 槽位，又省去 99% 无关卡的链接检查
                const check = canPairWith(nc, oc);
                if (!check.ok) continue;
                scored.push({ row: oc, sim, alreadyLinked: check.alreadyLinked });
              }
              scored.sort((a, b) => b.sim - a.sim);
              for (const top of scored.slice(0, cfg.topKPerCard)) {
                addPair(nc, top.row, top.sim, top.alreadyLinked);
              }
            }
          }
        }

        if (!usedEmbedding) {
          const poolByPath = new Map<string, CardIndexRow>();
          for (const oc of comparePool) poolByPath.set(oc.path, oc);
          const ftsLimit = Math.max(24, cfg.topKPerCard * 3 + newCards.length + 8);

          for (const nc of newCards) {
            if (opts.signal?.aborted) break;
            const body = (await readCardBody(nc.path)) ?? "";
            const ftsQuery = `${nc.title} ${nc.when_to_recall ?? ""} ${body.slice(0, 100)}`.trim();
            const hits = opts.memoryIndex.searchFts(ftsQuery, ftsLimit);
            let added = 0;
            for (const h of hits) {
              if (added >= cfg.topKPerCard) break;
              const oc = poolByPath.get(h.path);
              if (!oc) continue;
              const kwScore = Math.min(1, Math.max(0.1, -h.rank / (-h.rank + 1.2)));
              if (addPair(nc, oc, kwScore)) {
                added++;
              }
            }
          }
        }
      }
    }

    candidatePairs.sort((a, b) => b.similarity - a.similarity);
    const pairsToEval = candidatePairs.slice(0, maxPairs);

    if (pairsToEval.length > 0) {
      if (deadline - Date.now() <= 300) {
        timedOut = true;
      } else {
        let nextIdx = 0;
        const workerCount = Math.min(Math.max(1, cfg.concurrency), pairsToEval.length);

        const worker = async (): Promise<void> => {
          while (true) {
            if (opts.signal?.aborted) {
              timedOut = true;
              return;
            }
            const rem = deadline - Date.now();
            if (rem <= 300) {
              timedOut = true;
              return;
            }
            const idx = nextIdx++;
            if (idx >= pairsToEval.length) return;

            const pair = pairsToEval[idx]!;
            const [newBody, oldBody] = await Promise.all([
              readCardBody(pair.newCard.path),
              readCardBody(pair.oldCard.path),
            ]);
            if (newBody === null || oldBody === null) continue;

            const newIsEp = isEpisodeSlicePath(pair.newCard.path);
            const oldIsEp = isEpisodeSlicePath(pair.oldCard.path);
            const alreadyLinked = pair.alreadyLinked;

            const questions: Record<string, DecisionQuestion> = {
              contradiction: buildRadarQuestion(promptSpec.contradiction),
              promote: buildRadarQuestion(promptSpec.promote),
            };
            // 仅两张持久专卡互相比对时才问 redundant 与 representation（merge 仅对持久专卡合法，专卡↔情景切片不误问）
            if (!newIsEp && !oldIsEp) {
              questions.redundant = buildRadarQuestion(promptSpec.redundant);
              questions.representation = buildRadarQuestion(promptSpec.representation);
            }
            if (!oldIsEp) {
              questions.obsolete = buildRadarQuestion(promptSpec.obsolete);
            }
            if (scope === "bedtime" && !alreadyLinked) {
              questions.link = buildRadarQuestion(promptSpec.link);
            }

            const input = sanitizeUnicode(
              [
                `当前日期：${targetDay}`,
                formatCardBlock("new_card", pair.newCard, newBody, opts.clock.timeZone),
                formatCardBlock("old_card", pair.oldCard, oldBody, opts.clock.timeZone),
              ].join("\n\n"),
            );

            try {
              const callRem = deadline - Date.now();
              if (callRem <= 250) {
                timedOut = true;
                return;
              }
              const res = await opts.decisionClient!.decide({
                input,
                questions,
                signal: combineTimeoutSignal(opts.signal, Math.min(12_000, callRem)),
              });
              pairsEvaluated++;

              const finding = selectPairFindings({
                scope,
                newCard: pair.newCard,
                oldCard: pair.oldCard,
                alreadyLinked,
                answers: res.answers,
                thresholds: cfg.thresholds,
              });
              if (opts.collectDebug) {
                const repAns = res.answers.representation;
                const repChoice = repAns?.choice;
                const repProb =
                  repChoice && repAns?.probabilities
                    ? finiteOpt(repAns.probabilities[repChoice]) ?? finiteOpt(repAns?.confidence)
                    : finiteOpt(repAns?.confidence);
                debugPairs.push({
                  newCardPath: pair.newCard.path,
                  newCardTitle: pair.newCard.title,
                  oldCardPath: pair.oldCard.path,
                  oldCardTitle: pair.oldCard.title,
                  similarity: pair.similarity,
                  matchMethod,
                  alreadyLinked,
                  ...(res.answers.redundant?.noul !== undefined ? { redundant: res.answers.redundant.noul } : {}),
                  ...(res.answers.contradiction?.noul !== undefined
                    ? { contradiction: res.answers.contradiction.noul }
                    : {}),
                  ...(res.answers.obsolete?.noul !== undefined ? { obsolete: res.answers.obsolete.noul } : {}),
                  ...(res.answers.link?.noul !== undefined ? { link: res.answers.link.noul } : {}),
                  ...(res.answers.promote?.noul !== undefined ? { promote: res.answers.promote.noul } : {}),
                  ...(repChoice ? { representation: repChoice } : {}),
                  ...(repProb !== undefined ? { representationProb: repProb } : {}),
                  ...(finding ? { selectedFindingKind: finding.kind } : {}),
                });
              }
              if (finding) {
                findings.push(finding);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (opts.signal?.aborted || deadline - Date.now() <= 0 || /timeout|abort/i.test(msg)) {
                timedOut = true;
              }
              console.warn(
                `[psyber] memory radar(${scope}) pair (${pair.newCard.path} <-> ${pair.oldCard.path}) failed: ${msg}`,
              );
            }
          }
        };

        await Promise.all(Array.from({ length: workerCount }, () => worker()));
      }
    }

    if (opts.signal?.aborted) {
      return {
        executed: true,
        scope,
        boardItemsChecked,
        pairsEvaluated,
        findings,
        renderedBlock: null,
        reflectGateHint: null,
        timedOut: true,
        error: "Aborted",
      };
    }

    if (scope === "weekly") {
      const staleFindings = await scanStaleThreadFindings({
        db: opts.db,
        dataDir: opts.dataDir,
        memoryIndex: opts.memoryIndex,
        nowMs,
      }).catch(() => []);
      findings.push(...staleFindings);
    }

    findings.sort(compareFindings);
    const maxFindings = scope === "bedtime" ? cfg.maxFindingsDaily : cfg.maxFindingsWeekly;
    const includeOpen = opts.includeOpenBoardInBlock ?? scope === "weekly";
    const renderedBlock = renderMemoryRadarBlock(findings, {
      scope,
      includeOpenBoard: includeOpen,
      maxItems: maxFindings,
    });
    const reflectGateHint = buildReflectGateRadarHint(findings);

    return {
      executed: true,
      scope,
      boardItemsChecked,
      pairsEvaluated,
      findings,
      renderedBlock,
      reflectGateHint,
      ...(timedOut ? { timedOut: true } : {}),
      ...(opts.collectDebug
        ? {
            debug: {
              matchMethod,
              boardItems: debugBoardItems,
              pairs: debugPairs,
            },
          }
        : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[psyber] memory radar(${scope}) failed safely, skipping:`, err);
    return {
      executed: false,
      skipReason: `error: ${msg}`,
      scope,
      boardItemsChecked: 0,
      pairsEvaluated: 0,
      findings: [],
      renderedBlock: null,
      reflectGateHint: null,
      error: msg,
    };
  }
}
