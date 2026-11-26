import { Database } from "bun:sqlite";

const MIGRATION_001_INIT = `
CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- 1. 只追加原始事件账本
CREATE TABLE IF NOT EXISTS events (
  id                TEXT PRIMARY KEY,
  seq               INTEGER UNIQUE NOT NULL,
  session_id        TEXT NOT NULL,
  turn_id           TEXT,
  client_message_id TEXT UNIQUE,
  group_id          TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'active',
  role              TEXT NOT NULL,
  kind              TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'live',
  fonds             TEXT NOT NULL DEFAULT '',
  activity          TEXT,
  content           TEXT NOT NULL,
  thinking          TEXT,
  metadata          TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_status_id ON events(status, id);
CREATE INDEX IF NOT EXISTS idx_events_activity  ON events(activity, id) WHERE activity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_group     ON events(group_id, version) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_turn      ON events(turn_id) WHERE turn_id IS NOT NULL;

-- 2. 卡片可重建元索引（仅扫描 memory/**/*.md）
CREATE TABLE IF NOT EXISTS card_index (
  path           TEXT PRIMARY KEY,
  space          TEXT NOT NULL,
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,
  tags           TEXT,
  when_to_recall TEXT,
  date_kind      TEXT NOT NULL DEFAULT 'ordinary',
  expires_at     INTEGER,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_accessed  INTEGER,
  content_hash   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_space_status ON card_index(space, status);
CREATE INDEX IF NOT EXISTS idx_card_expires      ON card_index(expires_at) WHERE expires_at IS NOT NULL AND status = 'active';

-- 3. CJK 友好 FTS5 全文索引
CREATE VIRTUAL TABLE IF NOT EXISTS card_fts USING fts5(
  path UNINDEXED,
  title_tokens,
  trigger_tokens,
  body_tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 4. 分模型向量缓存
CREATE TABLE IF NOT EXISTS card_embeddings (
  path         TEXT NOT NULL,
  model_key    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (path, model_key)
);

-- 5. 召回留痕与真实评测标注
CREATE TABLE IF NOT EXISTS recall_traces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  query         TEXT NOT NULL,
  activity_hint TEXT,
  card_path     TEXT NOT NULL,
  track         TEXT NOT NULL,
  sem_score     REAL NOT NULL DEFAULT 0,
  kw_score      REAL NOT NULL DEFAULT 0,
  rerank_score  REAL,
  final_score   REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recall_traces_turn    ON recall_traces(turn_id);
CREATE INDEX IF NOT EXISTS idx_recall_traces_session ON recall_traces(session_id, created_at);

CREATE TABLE IF NOT EXISTS recall_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id       TEXT NOT NULL,
  card_path     TEXT,
  verdict       TEXT NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recall_feedback_turn ON recall_feedback(turn_id);

-- 6. 静默整理与未读纸条游标
CREATE TABLE IF NOT EXISTS task_cursors (
  task_key      TEXT PRIMARY KEY,
  last_event_id TEXT NOT NULL,
  meta_json     TEXT,
  updated_at    INTEGER NOT NULL
);

-- 7. 媒体内容寻址账本
CREATE TABLE IF NOT EXISTS media_assets (
  hash                TEXT PRIMARY KEY,
  ext                 TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  origin              TEXT NOT NULL,
  activity_session_id TEXT,
  pinned              INTEGER NOT NULL DEFAULT 0,
  expired             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_cleanup ON media_assets(origin, pinned, expired, created_at);

-- 8. 互发表情贴纸清单（Ring 1 由静态 stickers/ 目录同步入表）
CREATE TABLE IF NOT EXISTS stickers (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  pack         TEXT NOT NULL DEFAULT 'default',
  media_hash   TEXT NOT NULL,
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stickers_recent ON stickers(last_used_at DESC, use_count DESC);
`;

const MIGRATION_002_CARD_LINKS = `
-- 9. 卡片双向链接可重建派生索引（供 1 跳轻量多跳召回使用，唯一真相仍在 memory/*.md）
CREATE TABLE IF NOT EXISTS card_links (
  src_path    TEXT NOT NULL,
  target_ref  TEXT NOT NULL,
  link_kind   TEXT NOT NULL,
  PRIMARY KEY (src_path, target_ref, link_kind)
);
CREATE INDEX IF NOT EXISTS idx_card_links_src    ON card_links(src_path);
CREATE INDEX IF NOT EXISTS idx_card_links_target ON card_links(link_kind, target_ref);
`;

/**
 * 打开 SQLite 数据库并启用 WAL + 外键 + 忙等待，保证单进程并发读写稳定。
 */
export function openDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

export function runMigrations(db: Database, nowMs: number): void {
  db.exec(MIGRATION_001_INIT);
  const v1 = db.query("SELECT 1 FROM _migrations WHERE version = 1").get();
  if (!v1) {
    db.query("INSERT INTO _migrations (version, applied_at) VALUES (1, ?)").run(nowMs);
  }
  db.exec(MIGRATION_002_CARD_LINKS);
  const v2 = db.query("SELECT 1 FROM _migrations WHERE version = 2").get();
  if (!v2) {
    db.query("INSERT INTO _migrations (version, applied_at) VALUES (2, ?)").run(nowMs);
  }
}
