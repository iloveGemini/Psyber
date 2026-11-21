import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Clock } from "../core/clock.ts";
import type { EventStore, StoredEvent } from "../store/events.ts";

const SEALED_HEADER = "PSYBER-SEALED-V1";
const SEALED_DOMAIN_SALT = "psyber-sealed-v1";
const DRAWER_ID_RE = /^[\p{Script=Han}a-zA-Z0-9_-]{1,80}$/u;

export interface DrawerManifest {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sha256: string;
}

export interface DrawerEntrySummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  peeked: boolean;
  lastPeekedAt?: number;
}

export interface DrawerEntryContent {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface DrawerOpenedResult extends DrawerEntryContent {
  peekedEventId: string;
  peekedEvent: StoredEvent;
}

export function isValidDrawerId(id: string): boolean {
  return DRAWER_ID_RE.test(id);
}

/**
 * 基于 instanceId + 条目 id + 固定域分离盐派生的 SHA-256 计数器流式混淆（Spec 02 §2.1）：
 * 可逆、无额外密码、随 <dataDir> 无损跨机迁移，且磁盘绝不暴露明文中文。
 */
function xorStreamObfuscate(bytes: Uint8Array, instanceId: string, entryId: string): Uint8Array {
  const out = new Uint8Array(bytes.length);
  const baseSeed = `${instanceId}:${entryId}:${SEALED_DOMAIN_SALT}`;
  let offset = 0;
  let counter = 0;
  while (offset < bytes.length) {
    const keystream = crypto
      .createHash("sha256")
      .update(`${baseSeed}:${counter}`)
      .digest();
    const take = Math.min(keystream.length, bytes.length - offset);
    for (let i = 0; i < take; i++) {
      out[offset + i] = bytes[offset + i]! ^ keystream[i]!;
    }
    offset += take;
    counter += 1;
  }
  return out;
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function encodeSealedFile(
  manifest: DrawerManifest,
  plaintext: string,
  instanceId: string,
): string {
  const plainBytes = Buffer.from(plaintext, "utf8");
  const obfuscated = xorStreamObfuscate(plainBytes, instanceId, manifest.id);
  const payloadB64 = Buffer.from(obfuscated).toString("base64");
  return `${SEALED_HEADER}\n${JSON.stringify(manifest)}\n${payloadB64}\n`;
}

function parseManifestOnly(raw: string): DrawerManifest | null {
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2 || lines[0]?.trim() !== SEALED_HEADER) {
    return null;
  }
  try {
    const parsed = JSON.parse(lines[1] ?? "") as Partial<DrawerManifest>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.updatedAt !== "number" ||
      typeof parsed.sha256 !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      title: parsed.title,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      sha256: parsed.sha256,
    };
  } catch {
    return null;
  }
}

function unsealFile(raw: string, instanceId: string): { manifest: DrawerManifest; content: string } {
  const lines = raw.split(/\r?\n/);
  const manifest = parseManifestOnly(raw);
  if (!manifest) {
    throw new Error("抽屉文件封装头损坏，无法识别");
  }
  const b64 = lines.slice(2).join("").trim();
  const cipherBytes = Buffer.from(b64, "base64");
  const plainBytes = xorStreamObfuscate(cipherBytes, instanceId, manifest.id);
  const content = Buffer.from(plainBytes).toString("utf8");
  const actualHash = sha256Hex(content);
  if (actualHash !== manifest.sha256) {
    throw new Error("抽屉文件完整性校验失败（sha256 不匹配）");
  }
  return { manifest, content };
}

/**
 * 上锁抽屉存储层（Spec 02 §2 & Spec 03 §1.2）：
 * - 物理落盘于 <dataDir>/private/*.sealed（独立于 memory/，绝不进 memory/.git 与 SQLite 记忆索引）；
 * - 住户通过 drawer_read / drawer_write 透明读写，不产生 privacy.peeked；
 * - 用户通过 openEntryForUser 拆封时严格执行「写 privacy.peeked 先于返回明文」。
 */
export class DrawerStore {
  private readonly privateDir: string;
  private readonly tmpDir: string;

  constructor(
    private readonly dataDir: string,
    private readonly getInstanceId: () => string,
    private readonly clock: Clock,
  ) {
    this.privateDir = path.join(dataDir, "private");
    this.tmpDir = path.join(dataDir, ".tmp");
  }

  private entryPath(id: string): string {
    return path.join(this.privateDir, `${id}.sealed`);
  }

  /** 仅读取第 1–2 行明文清单，绝不解封正文（供 GET /api/v1/drawer 与住户列目录共用） */
  async listEntries(events?: EventStore): Promise<DrawerEntrySummary[]> {
    let filenames: string[];
    try {
      filenames = await fs.readdir(this.privateDir);
    } catch {
      return [];
    }

    const peekStats = events ? events.getDrawerPeekStats() : new Map<string, number>();
    const results: DrawerEntrySummary[] = [];

    for (const file of filenames) {
      if (!file.endsWith(".sealed")) continue;
      const expectedId = file.slice(0, -".sealed".length);
      if (!isValidDrawerId(expectedId)) continue;
      try {
        const raw = await fs.readFile(path.join(this.privateDir, file), "utf8");
        const manifest = parseManifestOnly(raw);
        if (!manifest || manifest.id !== expectedId) continue;
        const lastPeekedAt = peekStats.get(manifest.id);
        results.push({
          id: manifest.id,
          title: manifest.title,
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
          peeked: lastPeekedAt !== undefined,
          ...(lastPeekedAt !== undefined ? { lastPeekedAt } : {}),
        });
      } catch {
        // 忽略单个损坏文件，避免整个抽屉列表崩溃
      }
    }

    results.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return results;
  }

  /** 住户写入或更新私密抽屉条目（保留原 createdAt，原子落盘，绝不写 privacy.peeked） */
  async writeEntry(opts: {
    id: string;
    title: string;
    content: string;
  }): Promise<DrawerManifest> {
    const id = opts.id.trim();
    const title = opts.title.trim();
    const content = opts.content;
    if (!isValidDrawerId(id)) {
      throw new Error("抽屉条目 id 仅允许中英文、数字、下划线与连字符（1–80 字符）");
    }
    if (!title) {
      throw new Error("抽屉条目 title 不能为空");
    }
    if (!content.trim()) {
      throw new Error("抽屉条目 content 不能为空");
    }

    await fs.mkdir(this.privateDir, { recursive: true });
    await fs.mkdir(this.tmpDir, { recursive: true });

    const targetPath = this.entryPath(id);
    const nowMs = this.clock.now();
    let createdAt = nowMs;
    try {
      const existingRaw = await fs.readFile(targetPath, "utf8");
      const existingManifest = parseManifestOnly(existingRaw);
      if (existingManifest) {
        createdAt = existingManifest.createdAt;
      }
    } catch {
      // 新建条目
    }

    const manifest: DrawerManifest = {
      id,
      title: title.slice(0, 100),
      createdAt,
      updatedAt: nowMs,
      sha256: sha256Hex(content),
    };
    const encoded = encodeSealedFile(manifest, content, this.getInstanceId());

    const tmpFile = path.join(this.tmpDir, `drawer-${crypto.randomUUID()}.tmp`);
    const fh = await fs.open(tmpFile, "w", 0o600);
    try {
      await fh.writeFile(encoded, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmpFile, targetPath);
    return manifest;
  }

  /** 住户本人透明阅读私密抽屉条目（绝不写入 privacy.peeked） */
  async readEntryForResident(id: string): Promise<DrawerEntryContent | null> {
    const cleanId = id.trim();
    if (!isValidDrawerId(cleanId)) {
      throw new Error("非法抽屉条目 id");
    }
    let raw: string;
    try {
      raw = await fs.readFile(this.entryPath(cleanId), "utf8");
    } catch {
      return null;
    }
    const { manifest, content } = unsealFile(raw, this.getInstanceId());
    return {
      id: manifest.id,
      title: manifest.title,
      content,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    };
  }

  /**
   * 用户拆封阅读上锁抽屉条目（Spec 03 §1.2 写先于读硬约束）：
   * 先确认目标存在并可解封，再强制在 SQLite 写入 privacy.peeked 不可篡改事件，
   * 落盘成功后才向调用方返回明文内容。
   */
  async openEntryForUser(opts: {
    id: string;
    events: EventStore;
    sessionId: string;
    channel?: "app" | "cli";
  }): Promise<DrawerOpenedResult | null> {
    const cleanId = opts.id.trim();
    if (!isValidDrawerId(cleanId)) {
      throw new Error("非法抽屉条目 id");
    }
    let raw: string;
    try {
      raw = await fs.readFile(this.entryPath(cleanId), "utf8");
    } catch {
      return null;
    }
    const { manifest, content } = unsealFile(raw, this.getInstanceId());
    const channel = opts.channel ?? "app";

    // 写先于读：事件落盘失败直接抛错中止，绝不返回明文
    const { event: peekedEvent } = opts.events.append({
      sessionId: opts.sessionId || "system",
      role: "system",
      kind: "privacy.peeked",
      content: `用户在 ${channel} 拆封了上锁抽屉「${manifest.title}」`,
      metadata: {
        drawerId: manifest.id,
        title: manifest.title,
        channel,
      },
    });

    return {
      id: manifest.id,
      title: manifest.title,
      content,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      peekedEventId: peekedEvent.id,
      peekedEvent,
    };
  }
}
