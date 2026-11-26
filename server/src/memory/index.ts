import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import YAML from "yaml";
import type { Clock } from "../core/clock.ts";
import { stripFrontmatter } from "../core/prompts.ts";
import { effectiveStatus, parseCardMarkdown } from "./frontmatter.ts";
import { buildSafeFtsQuery, tokenizeForFts } from "./fts.ts";

export interface CardIndexRow {
  path: string;
  space: string;
  title: string;
  kind: string;
  status: string;
  tags: string | null;
  when_to_recall: string | null;
  date_kind: string;
  expires_at: number | null;
  access_count: number;
  last_accessed: number | null;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

export interface FtsSearchHit {
  path: string;
  title: string;
  space: string;
  kind: string;
  status: string;
  rank: number;
  updatedAt: number;
}

export interface ExtractedCardLink {
  targetRef: string;
  linkKind: "wiki" | "path";
}

export interface LinkedNeighbor {
  row: CardIndexRow;
  viaAnchorPath: string;
  viaAnchorTitle: string;
  direction: "out" | "in";
  /** 被多少个首跳锚点同时连到（多锚点共指优先级更高） */
  anchorHitCount: number;
}

/** 归一化双链短标题（NFKC + 去首尾空白 + 小写），用于与 card_index.title 精确匹配 */
export function normalizeWikiTitle(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase();
}

/** 从 Markdown 正文中提取站内 `[[短标题]]` 双链与相对 `.md` 路径链接（忽略外链与 media/ 附件） */
export function extractMarkdownLinks(body: string, srcPath?: string): ExtractedCardLink[] {
  const seen = new Set<string>();
  const out: ExtractedCardLink[] = [];
  const add = (linkKind: "wiki" | "path", targetRef: string) => {
    if (!targetRef) return;
    if (linkKind === "path" && srcPath && targetRef === srcPath) return;
    const key = `${linkKind}:${targetRef}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ linkKind, targetRef });
  };

  // 1) [[短标题]] 或 [[短标题|展示别名]]
  const wikiRe = /\[\[([^\]\r\n|]+?)(?:\|[^\]\r\n]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(body)) !== null) {
    const norm = normalizeWikiTitle(m[1]);
    if (norm) add("wiki", norm);
  }

  // 2) [文本](relative/path.md) 或 [文本](relative/path.md "title")
  const mdRe = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
  while ((m = mdRe.exec(body)) !== null) {
    let raw = m[1].trim();
    if (
      !raw ||
      /^(?:https?:|mailto:|#)/i.test(raw) ||
      raw.startsWith("media/") ||
      raw.startsWith("/api/")
    ) {
      continue;
    }
    raw = raw.split("#")[0]?.split("?")[0]?.trim() ?? "";
    if (!raw.endsWith(".md")) continue;
    raw = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) continue;
    const segs = raw.split("/").filter(Boolean);
    if (segs.length === 0 || segs.some((s) => s === "." || s === "..")) continue;
    add("path", segs.join("/"));
  }

  return out;
}

const RESERVED_SPACES = new Set([
  "core",
  "episodes",
  "episode_index",
  "threads",
  "lessons",
  "favorite",
  "entities",
  "private",
  "self",
  "user",
]);
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const VALID_DECAYS = new Set(["none", "slow", "short"]);

/** 写前严格校验 threads/REGISTRY.yaml 或 entities/REGISTRY.yaml，防止 AI 写坏注册表 */
export function validateRegistryYaml(
  relPath: "threads/REGISTRY.yaml" | "entities/REGISTRY.yaml",
  content: string,
): { ok: true } | { ok: false; error: string } {
  let doc: unknown;
  try {
    doc = YAML.parse(content, { uniqueKeys: true });
  } catch (err) {
    return { ok: false, error: `YAML 语法错误: ${(err as Error).message}` };
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: `${relPath} 顶层必须是 YAML 映射对象` };
  }

  const obj = doc as Record<string, unknown>;
  if (relPath === "threads/REGISTRY.yaml") {
    if (!obj.spaces || typeof obj.spaces !== "object" || Array.isArray(obj.spaces)) {
      return { ok: false, error: "threads/REGISTRY.yaml 缺少 spaces 映射节点" };
    }
    for (const [slug, val] of Object.entries(obj.spaces as Record<string, unknown>)) {
      if (!SLUG_RE.test(slug) || RESERVED_SPACES.has(slug)) {
        return { ok: false, error: `非法活动空间 slug: "${slug}"` };
      }
      if (!val || typeof val !== "object" || Array.isArray(val)) {
        return { ok: false, error: `空间 "${slug}" 必须为对象` };
      }
      const s = val as Record<string, unknown>;
      if (typeof s.title !== "string" || !s.title.trim()) {
        return { ok: false, error: `空间 "${slug}" 缺少非空 title` };
      }
      if (!Array.isArray(s.triggers) || s.triggers.length === 0 || s.triggers.some((t) => typeof t !== "string" || !t.trim())) {
        return { ok: false, error: `空间 "${slug}" 的 triggers 须为至少含 1 个非空字符串的数组` };
      }
      if (typeof s.decay !== "string" || !VALID_DECAYS.has(s.decay)) {
        return { ok: false, error: `空间 "${slug}" 的 decay 必须为 none | slow | short` };
      }
      if (typeof s.card_style !== "string" || !s.card_style.trim()) {
        return { ok: false, error: `空间 "${slug}" 缺少非空 card_style` };
      }
    }
    return { ok: true };
  }

  // entities/REGISTRY.yaml
  if (!obj.entities || typeof obj.entities !== "object" || Array.isArray(obj.entities)) {
    return { ok: false, error: "entities/REGISTRY.yaml 缺少 entities 映射节点" };
  }
  const seenNames = new Map<string, string>();
  for (const [id, val] of Object.entries(obj.entities as Record<string, unknown>)) {
    if (!ENTITY_ID_RE.test(id)) {
      return { ok: false, error: `非法实体 id: "${id}"` };
    }
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      return { ok: false, error: `实体 "${id}" 必须为对象` };
    }
    const e = val as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name.trim()) {
      return { ok: false, error: `实体 "${id}" 缺少非空 name` };
    }
    if (typeof e.category !== "string" || !SLUG_RE.test(e.category)) {
      return { ok: false, error: `实体 "${id}" 的 category 不合法` };
    }
    if (typeof e.relation !== "string" || !e.relation.trim()) {
      return { ok: false, error: `实体 "${id}" 缺少非空 relation` };
    }
    if (e.first_seen !== undefined && (typeof e.first_seen !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.first_seen))) {
      return { ok: false, error: `实体 "${id}" 的 first_seen 须为 YYYY-MM-DD 格式` };
    }
    const candidates = [e.name.trim()];
    if (Array.isArray(e.aliases)) {
      for (const a of e.aliases) {
        if (typeof a !== "string" || !a.trim()) {
          return { ok: false, error: `实体 "${id}" 的 aliases 包含空值` };
        }
        candidates.push(a.trim());
      }
    }
    for (const c of candidates) {
      const norm = c.normalize("NFKC").toLowerCase();
      const conflict = seenNames.get(norm);
      if (conflict && conflict !== id) {
        return { ok: false, error: `实体 "${id}" 的名称/别名 "${c}" 与既有实体 "${conflict}" 冲突` };
      }
      seenNames.set(norm, id);
    }
  }
  return { ok: true };
}

/**
 * 记忆派生索引管理器：负责单文件增量同步、全量重建、到期 state 过期巡检与极简 FTS5 检索。
 */
export class MemoryIndex {
  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
    private readonly clock: Clock,
  ) {}

  private get memoryDir(): string {
    return path.join(this.dataDir, "memory");
  }

  /** 增量同步单张 Markdown 卡片到 card_index + card_fts */
  async reindexFile(relPath: string, opts?: { trustFrontmatterDates?: boolean }): Promise<void> {
    await this.reindexFileInternal(relPath, opts);
  }

  private async reindexFileInternal(
    relPath: string,
    opts?: { trustFrontmatterDates?: boolean },
  ): Promise<boolean> {
    if (!relPath.endsWith(".md")) return false;
    const absPath = path.join(this.memoryDir, relPath);
    let content: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      [content, stat] = await Promise.all([fs.readFile(absPath, "utf8"), fs.stat(absPath)]);
    } catch {
      this.removeFromIndex(relPath);
      return false;
    }

    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    const existing = this.db
      .query("SELECT content_hash, access_count, last_accessed FROM card_index WHERE path = ?")
      .get(relPath) as { content_hash: string; access_count: number; last_accessed: number | null } | null;

    if (existing && existing.content_hash === contentHash) {
      return false;
    }

    const parsed = parseCardMarkdown(
      relPath,
      content,
      stat.mtimeMs,
      this.clock.timeZone,
      opts?.trustFrontmatterDates ? false : existing !== null,
    );

    const titleTokens = tokenizeForFts(parsed.title);
    const triggerTokens = tokenizeForFts([parsed.whenToRecall ?? "", ...parsed.tags].join(" "));
    const bodyTokens = tokenizeForFts(parsed.body);
    const links = extractMarkdownLinks(parsed.body, relPath);

    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO card_index (
            path, space, title, kind, status, tags, when_to_recall,
            date_kind, expires_at, access_count, last_accessed,
            content_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            space = excluded.space,
            title = excluded.title,
            kind = excluded.kind,
            status = excluded.status,
            tags = excluded.tags,
            when_to_recall = excluded.when_to_recall,
            date_kind = excluded.date_kind,
            expires_at = excluded.expires_at,
            content_hash = excluded.content_hash,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
        )
        .run(
          relPath,
          parsed.space,
          parsed.title,
          parsed.kind,
          parsed.status,
          JSON.stringify(parsed.tags),
          parsed.whenToRecall,
          parsed.dateKind,
          parsed.expiresAt,
          existing?.access_count ?? 0,
          existing?.last_accessed ?? null,
          contentHash,
          parsed.createdAt,
          parsed.updatedAt,
        );

      this.db.query("DELETE FROM card_fts WHERE path = ?").run(relPath);
      this.db
        .query(
          "INSERT INTO card_fts (path, title_tokens, trigger_tokens, body_tokens) VALUES (?, ?, ?, ?)",
        )
        .run(relPath, titleTokens, triggerTokens, bodyTokens);

      this.db.query("DELETE FROM card_links WHERE src_path = ?").run(relPath);
      if (links.length > 0) {
        const insertLink = this.db.query(
          "INSERT OR IGNORE INTO card_links (src_path, target_ref, link_kind) VALUES (?, ?, ?)",
        );
        for (const l of links) {
          insertLink.run(relPath, l.targetRef, l.linkKind);
        }
      }
    });
    tx();
    return true;
  }

  removeFromIndex(relPath: string): void {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM card_index WHERE path = ?").run(relPath);
      this.db.query("DELETE FROM card_fts WHERE path = ?").run(relPath);
      this.db.query("DELETE FROM card_embeddings WHERE path = ?").run(relPath);
      this.db.query("DELETE FROM card_links WHERE src_path = ?").run(relPath);
    });
    tx();
  }

  /** 启动对账 / 全量重建索引（跳过 .git 与非 .md 文件） */
  async reindexAll(): Promise<{ indexed: number; removed: number }> {
    const linksBackfilled = Boolean(
      this.db.query("SELECT 1 FROM task_cursors WHERE task_key = 'index:card_links_v2'").get(),
    );
    const found = new Set<string>();
    const updatedInWalk = new Set<string>();
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, rel);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          found.add(rel);
          if (await this.reindexFileInternal(rel)) {
            updatedInWalk.add(rel);
          }
        }
      }
    };
    await walk(this.memoryDir, "");

    const existingRows = this.db.query("SELECT path FROM card_index").all() as Array<{ path: string }>;
    let removed = 0;
    for (const row of existingRows) {
      if (!found.has(row.path)) {
        this.removeFromIndex(row.path);
        removed++;
      }
    }

    // 兼容从 v1 升级到 v2 的既有库：用 task_cursors 标记是否完成过回填，防止个别文件先写入导致其余旧卡漏回填或零链接库每次重启全量重扫
    if (!linksBackfilled) {
      const toBackfill = Array.from(found).filter((p) => !updatedInWalk.has(p));
      if (toBackfill.length > 0) {
        await this.backfillCardLinks(toBackfill);
      }
      this.db
        .query(
          `INSERT INTO task_cursors (task_key, last_event_id, meta_json, updated_at)
           VALUES ('index:card_links_v2', 'v2', NULL, ?)
           ON CONFLICT(task_key) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(this.clock.now());
    }

    this.expireOverdueStateCards();
    return { indexed: found.size, removed };
  }

  private async backfillCardLinks(relPaths: readonly string[]): Promise<void> {
    const extracted = await Promise.all(
      relPaths.map(async (rel) => {
        try {
          const content = await fs.readFile(path.join(this.memoryDir, rel), "utf8");
          // 与 reindexFile 保持一致：先剥除 YAML Frontmatter，仅扫描正文链接
          const links = extractMarkdownLinks(stripFrontmatter(content), rel);
          return { srcPath: rel, links };
        } catch {
          return null;
        }
      }),
    );
    const deleteLinks = this.db.query("DELETE FROM card_links WHERE src_path = ?");
    const insertLink = this.db.query(
      "INSERT OR IGNORE INTO card_links (src_path, target_ref, link_kind) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const item of extracted) {
        if (!item) continue;
        deleteLinks.run(item.srcPath);
        for (const l of item.links) {
          insertLink.run(item.srcPath, l.targetRef, l.linkKind);
        }
      }
    });
    tx();
  }

  /**
   * 沿 `card_links` 查找一组锚点卡的 1 跳双向邻接活跃卡片（包含正向引用与反向被引用）：
   * - 自动过滤常驻区（core/self/user/episode_index）、反思卡（kind='reflection'）及失效卡；
   * - 统计 `anchorHitCount`（被多张锚点卡共同指向的邻卡优先级更高）。
   */
  findLinkedNeighbors(
    anchorPaths: readonly string[],
    opts: { excludePaths?: ReadonlySet<string>; maxResults?: number } = {},
  ): LinkedNeighbor[] {
    if (anchorPaths.length === 0) return [];
    this.expireOverdueStateCards();
    const nowMs = this.clock.now();
    const exclude = new Set<string>(opts.excludePaths ?? []);
    for (const p of anchorPaths) exclude.add(p);

    const allRows = this.db.query("SELECT * FROM card_index").all() as CardIndexRow[];
    const byPath = new Map<string, CardIndexRow>();
    const byNormTitle = new Map<string, CardIndexRow[]>();
    for (const r of allRows) {
      byPath.set(r.path, r);
      const norm = normalizeWikiTitle(r.title);
      if (norm) {
        const arr = byNormTitle.get(norm);
        if (arr) arr.push(r);
        else byNormTitle.set(norm, [r]);
      }
    }

    const isEligibleNeighbor = (row: CardIndexRow | undefined): row is CardIndexRow => {
      if (!row) return false;
      if (exclude.has(row.path)) return false;
      if (
        row.space === "self" ||
        row.space === "user" ||
        row.space === "core" ||
        row.space === "episode_index" ||
        row.kind === "reflection"
      ) {
        return false;
      }
      const st = effectiveStatus(row, nowMs);
      return st === "active" || st === "disputed";
    };

    const neighborMap = new Map<
      string,
      {
        row: CardIndexRow;
        viaAnchorPath: string;
        viaAnchorTitle: string;
        direction: "out" | "in";
        anchors: Set<string>;
      }
    >();

    const record = (
      row: CardIndexRow,
      anchor: CardIndexRow,
      direction: "out" | "in",
    ) => {
      const prev = neighborMap.get(row.path);
      if (prev) {
        prev.anchors.add(anchor.path);
        // 若既有反向边又有正向边，优先保留正向语义
        if (prev.direction === "in" && direction === "out") {
          prev.direction = "out";
          prev.viaAnchorPath = anchor.path;
          prev.viaAnchorTitle = anchor.title;
        }
      } else {
        neighborMap.set(row.path, {
          row,
          viaAnchorPath: anchor.path,
          viaAnchorTitle: anchor.title,
          direction,
          anchors: new Set([anchor.path]),
        });
      }
    };

    const outStmt = this.db.query(
      "SELECT target_ref, link_kind FROM card_links WHERE src_path = ?",
    );
    const inStmt = this.db.query(
      "SELECT src_path FROM card_links WHERE (link_kind = 'path' AND target_ref = ?) OR (link_kind = 'wiki' AND target_ref = ?)",
    );

    for (const anchorPath of anchorPaths) {
      const anchor = byPath.get(anchorPath);
      if (!anchor) continue;

      // 1) 正向出边：锚点正文引用了 [[target]] 或 [x](target.md)
      const outs = outStmt.all(anchorPath) as Array<{ target_ref: string; link_kind: string }>;
      for (const edge of outs) {
        if (edge.link_kind === "path") {
          const target = byPath.get(edge.target_ref);
          if (isEligibleNeighbor(target)) record(target, anchor, "out");
        } else {
          const targets = byNormTitle.get(edge.target_ref) ?? [];
          for (const target of targets) {
            if (isEligibleNeighbor(target)) record(target, anchor, "out");
          }
        }
      }

      // 2) 反向入边：其他活跃卡片引用了当前锚点
      const normAnchorTitle = normalizeWikiTitle(anchor.title);
      const ins = inStmt.all(anchorPath, normAnchorTitle) as Array<{ src_path: string }>;
      for (const edge of ins) {
        const src = byPath.get(edge.src_path);
        if (isEligibleNeighbor(src)) record(src, anchor, "in");
      }
    }

    const list: LinkedNeighbor[] = Array.from(neighborMap.values()).map((n) => ({
      row: n.row,
      viaAnchorPath: n.viaAnchorPath,
      viaAnchorTitle: n.viaAnchorTitle,
      direction: n.direction,
      anchorHitCount: n.anchors.size,
    }));

    // 默认按：多锚点共指 > 正向引用 > 持久专卡（threads/entities/lessons/favorite）> 更新时间
    const isDurableSpace = (space: string) => space !== "episodes";
    list.sort((a, b) => {
      if (b.anchorHitCount !== a.anchorHitCount) return b.anchorHitCount - a.anchorHitCount;
      if (a.direction !== b.direction) return a.direction === "out" ? -1 : 1;
      const da = isDurableSpace(a.row.space) ? 1 : 0;
      const dbFlag = isDurableSpace(b.row.space) ? 1 : 0;
      if (dbFlag !== da) return dbFlag - da;
      return b.row.updated_at - a.row.updated_at;
    });

    const limit = opts.maxResults ?? 24;
    return list.slice(0, limit);
  }

  /**
   * 索引层过期巡检：将到期 state 卡的 card_index.status 标为 faded，绝不修改磁盘 Markdown。
   */
  expireOverdueStateCards(): number {
    const nowMs = this.clock.now();
    const res = this.db
      .query(
        `UPDATE card_index
         SET status = 'faded'
         WHERE kind = 'state'
           AND status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
      )
      .run(nowMs);
    return res.changes;
  }

  /** 极简 FTS5 2-gram 检索（自动过滤 resolved/archived/faded 与常驻前缀 / 梗概索引文件） */
  searchFts(query: string, limit = 5): FtsSearchHit[] {
    this.expireOverdueStateCards();
    const ftsExpr = buildSafeFtsQuery(query);
    if (!ftsExpr) return [];

    const rows = this.db
      .query(
        `SELECT c.path, c.title, c.space, c.kind, c.status, c.expires_at, c.updated_at,
                bm25(card_fts, 0.0, 2.0, 2.0, 1.0) AS rank
         FROM card_fts f
         JOIN card_index c ON c.path = f.path
         WHERE card_fts MATCH ?
           AND c.space NOT IN ('self', 'user', 'core', 'episode_index')
           AND c.status NOT IN ('resolved', 'archived', 'faded')
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(ftsExpr, limit) as Array<{
      path: string;
      title: string;
      space: string;
      kind: string;
      status: string;
      expires_at: number | null;
      updated_at: number;
      rank: number;
    }>;

    const nowMs = this.clock.now();
    return rows
      .filter((r) => effectiveStatus(r, nowMs) !== "faded")
      .map((r) => ({
        path: r.path,
        title: r.title,
        space: r.space,
        kind: r.kind,
        status: effectiveStatus(r, nowMs),
        rank: r.rank,
        updatedAt: r.updated_at,
      }));
  }

  getRow(relPath: string): CardIndexRow | null {
    return (
      (this.db.query("SELECT * FROM card_index WHERE path = ?").get(relPath) as CardIndexRow | null) ??
      null
    );
  }

  listAllRows(): CardIndexRow[] {
    this.expireOverdueStateCards();
    return this.db
      .query("SELECT * FROM card_index ORDER BY updated_at DESC")
      .all() as CardIndexRow[];
  }

  incrementAccess(relPath: string): void {
    this.db
      .query("UPDATE card_index SET access_count = access_count + 1, last_accessed = ? WHERE path = ?")
      .run(this.clock.now(), relPath);
  }
}
