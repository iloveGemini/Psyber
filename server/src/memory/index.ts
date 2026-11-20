import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import YAML from "yaml";
import type { Clock } from "../core/clock.ts";
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

const RESERVED_SPACES = new Set([
  "daily",
  "shelf",
  "favorite",
  "gist",
  "entities",
  "private",
  "self",
  "user",
]);
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const VALID_DECAYS = new Set(["none", "slow", "short"]);

/** 写前严格校验 activities/REGISTRY.yaml 或 entities/REGISTRY.yaml，防止 AI 写坏注册表 */
export function validateRegistryYaml(
  relPath: "activities/REGISTRY.yaml" | "entities/REGISTRY.yaml",
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
  if (relPath === "activities/REGISTRY.yaml") {
    if (!obj.spaces || typeof obj.spaces !== "object" || Array.isArray(obj.spaces)) {
      return { ok: false, error: "activities/REGISTRY.yaml 缺少 spaces 映射节点" };
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
  async reindexFile(relPath: string): Promise<void> {
    if (!relPath.endsWith(".md")) return;
    const absPath = path.join(this.memoryDir, relPath);
    let content: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      [content, stat] = await Promise.all([fs.readFile(absPath, "utf8"), fs.stat(absPath)]);
    } catch {
      this.removeFromIndex(relPath);
      return;
    }

    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    const existing = this.db
      .query("SELECT content_hash, access_count, last_accessed FROM card_index WHERE path = ?")
      .get(relPath) as { content_hash: string; access_count: number; last_accessed: number | null } | null;

    if (existing && existing.content_hash === contentHash) {
      return;
    }

    const parsed = parseCardMarkdown(
      relPath,
      content,
      stat.mtimeMs,
      this.clock.timeZone,
      existing !== null,
    );

    const titleTokens = tokenizeForFts(parsed.title);
    const triggerTokens = tokenizeForFts([parsed.whenToRecall ?? "", ...parsed.tags].join(" "));
    const bodyTokens = tokenizeForFts(parsed.body);

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
    });
    tx();
  }

  removeFromIndex(relPath: string): void {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM card_index WHERE path = ?").run(relPath);
      this.db.query("DELETE FROM card_fts WHERE path = ?").run(relPath);
      this.db.query("DELETE FROM card_embeddings WHERE path = ?").run(relPath);
    });
    tx();
  }

  /** 启动对账 / 全量重建索引（跳过 .git 与非 .md 文件） */
  async reindexAll(): Promise<{ indexed: number; removed: number }> {
    const found = new Set<string>();
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
          await this.reindexFile(rel);
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
    this.expireOverdueStateCards();
    return { indexed: found.size, removed };
  }

  /**
   * 索引层过期巡检：仅将到期 daily/ state 卡的 card_index.status 标为 faded，绝不修改磁盘 Markdown。
   */
  expireOverdueStateCards(): number {
    const nowMs = this.clock.now();
    const res = this.db
      .query(
        `UPDATE card_index
         SET status = 'faded'
         WHERE space = 'daily'
           AND kind = 'state'
           AND status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
      )
      .run(nowMs);
    return res.changes;
  }

  /** 极简 FTS5 2-gram 检索（自动过滤 resolved/archived/faded 与常驻前缀文件） */
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
           AND c.space NOT IN ('self', 'user', 'shelf', 'gist')
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
