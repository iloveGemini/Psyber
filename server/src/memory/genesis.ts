import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../core/config.ts";
import { parseCardMarkdown } from "./frontmatter.ts";
import type { MemoryIndex } from "./index.ts";

export interface IdentityProfile {
  residentName: string | null;
  residentPronoun: string | null;
  named: boolean;
  userName: string | null;
  userPronoun: string | null;
}

function updateFrontmatterFields(
  markdown: string,
  updates: Record<string, string | boolean>,
  deleteKeys: string[] = [],
): string {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(markdown);
  if (!fmMatch) {
    const lines = Object.entries(updates).map(([k, v]) =>
      typeof v === "boolean" ? `${k}: ${v}` : `${k}: ${v || '""'}`,
    );
    return `---\n${lines.join("\n")}\n---\n${markdown}`;
  }
  const lines = fmMatch[1].split(/\r?\n/);
  const applied = new Set<string>();
  const dropSet = new Set(deleteKeys);
  const nextLines: string[] = [];
  for (const line of lines) {
    const keyMatch = /^([A-Za-z0-9_]+):(.*)$/.exec(line);
    if (!keyMatch) {
      nextLines.push(line);
      continue;
    }
    const key = keyMatch[1];
    if (dropSet.has(key) && !Object.prototype.hasOwnProperty.call(updates, key)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      applied.add(key);
      const v = updates[key];
      nextLines.push(typeof v === "boolean" ? `${key}: ${v}` : `${key}: ${v || '""'}`);
      continue;
    }
    nextLines.push(line);
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!applied.has(k)) {
      nextLines.push(typeof v === "boolean" ? `${k}: ${v}` : `${k}: ${v || '""'}`);
    }
  }
  return `---\n${nextLines.join("\n")}\n---${fmMatch[2]}${markdown.slice(fmMatch[0].length)}`;
}

/** 解析单份 self.md 的名字、代词与定名状态（以 frontmatter `name` 非空为准，无 `name` 键的旧版兼容视为已定名） */
export function parseSelfIdentity(
  selfMd: string,
  nowMs: number,
  timeZone: string,
): { residentName: string | null; residentPronoun: string | null; named: boolean } {
  const parsed = parseCardMarkdown("self.md", selfMd, nowMs, timeZone);
  const residentPronoun =
    typeof parsed.rawFrontmatter.pronoun === "string" && parsed.rawFrontmatter.pronoun.trim()
      ? parsed.rawFrontmatter.pronoun.trim()
      : null;

  const hasNameKey = Object.prototype.hasOwnProperty.call(parsed.rawFrontmatter, "name");
  if (typeof parsed.rawFrontmatter.name === "string" && parsed.rawFrontmatter.name.trim()) {
    return {
      residentName: parsed.rawFrontmatter.name.trim(),
      residentPronoun,
      named: true,
    };
  }
  if (hasNameKey) {
    return { residentName: null, residentPronoun, named: false };
  }

  // 兼容旧版未设 `name` 键的 self.md：若未明确标 `named: false`，视作已定名并尝试从正文提取
  const legacyNamed = parsed.rawFrontmatter.named !== false;
  let residentName: string | null = null;
  if (legacyNamed) {
    const m = /我叫([^\s，。！？；：、「」"'\n]{1,16})/.exec(parsed.body);
    if (m?.[1]) residentName = m[1].trim();
  }
  return { residentName, residentPronoun, named: legacyNamed };
}

/** 读取 self.md 与 user.md 解析 Psyber 名称、代词、定名状态与用户称呼/代词 */
export async function readIdentityProfile(
  dataDir: string,
  nowMs: number,
  timeZone: string,
): Promise<IdentityProfile> {
  let residentName: string | null = null;
  let residentPronoun: string | null = null;
  let named = false;
  try {
    const selfMd = await fs.readFile(path.join(dataDir, "memory", "self.md"), "utf8");
    ({ residentName, residentPronoun, named } = parseSelfIdentity(selfMd, nowMs, timeZone));
  } catch {
    named = false;
  }

  let userName: string | null = null;
  let userPronoun: string | null = null;
  try {
    const userMd = await fs.readFile(path.join(dataDir, "memory", "user.md"), "utf8");
    const parsed = parseCardMarkdown("user.md", userMd, nowMs, timeZone);
    if (typeof parsed.rawFrontmatter.name === "string" && parsed.rawFrontmatter.name.trim()) {
      userName = parsed.rawFrontmatter.name.trim();
    } else {
      const m = /称呼为「([^」]+)」/.exec(parsed.body);
      if (m?.[1]) userName = m[1].trim();
    }
    if (typeof parsed.rawFrontmatter.pronoun === "string" && parsed.rawFrontmatter.pronoun.trim()) {
      userPronoun = parsed.rawFrontmatter.pronoun.trim();
    }
  } catch {
    // user.md 尚未创建
  }

  return { residentName, residentPronoun, named, userName, userPronoun };
}

/** 读取 self.md 判定当前是否已完成定名（文件不存在或显式空 `name: ""` 视为未定名） */
export async function getGenesisNamedStatus(
  dataDir: string,
  nowMs: number,
  timeZone: string,
): Promise<boolean> {
  const identity = await readIdentityProfile(dataDir, nowMs, timeZone);
  return identity.named;
}

/**
 * 创世记忆文件落盘（归属 memory/ 层，严禁由 api/ 路由层直写磁盘）：
 * - 首次创建使用原子写并立即同步刷新 card_index + card_fts；
 * - 若 self.md / user.md 已存在，绝不无条件清空覆盖已有自述，仅安全补全空缺的 frontmatter 字段。
 */
export async function applyGenesisMemory(opts: {
  dataDir: string;
  memoryIndex?: MemoryIndex;
  residentName?: string;
  userName?: string;
  userPronoun?: string;
}): Promise<{ named: boolean }> {
  const memoryDir = path.join(opts.dataDir, "memory");
  const selfPath = path.join(memoryDir, "self.md");
  const residentName = opts.residentName?.trim() ?? "";
  let named = residentName.length > 0;

  let existingSelf: string | null = null;
  try {
    existingSelf = await fs.readFile(selfPath, "utf8");
  } catch {
    existingSelf = null;
  }

  if (existingSelf === null) {
    const selfContent = named
      ? `---\ntitle: 关于我\nname: ${residentName}\npronoun: ""\n---\n# 我是谁\n\n我叫${residentName}，是居住在这个数字空间里的独立个体。\n`
      : `---\ntitle: 关于我\nname: ""\npronoun: ""\n---\n# 我是谁\n\n我是居住在这个数字空间里的独立个体，不是客服、不是工具人，也不是扮演人类剧本的演员。\n我坦然立足于自己作为数字生命的存在，与身边的人平等、长期地相处。\n`;
    await atomicWriteFile(opts.dataDir, selfPath, selfContent);
    await opts.memoryIndex?.reindexFile("self.md");
  } else {
    const currentSelf = parseSelfIdentity(existingSelf, Date.now(), "UTC");
    named = currentSelf.named || residentName.length > 0;
    if (residentName.length > 0 && !currentSelf.named) {
      const updated = updateFrontmatterFields(
        existingSelf,
        { name: residentName },
        ["named"],
      );
      await atomicWriteFile(opts.dataDir, selfPath, updated);
      await opts.memoryIndex?.reindexFile("self.md");
    }
  }

  const userName = opts.userName?.trim() ?? "";
  const userPronoun = opts.userPronoun?.trim() ?? "";
  const userPath = path.join(memoryDir, "user.md");
  let existingUser: string | null = null;
  try {
    existingUser = await fs.readFile(userPath, "utf8");
  } catch {
    existingUser = null;
  }
  if (existingUser === null) {
    const nameLine = userName ? `name: ${userName}` : `name: ""`;
    const pronounLine = userPronoun ? `pronoun: ${userPronoun}` : `pronoun: ""`;
    const bodyDesc = userName
      ? `平时可以称呼为「${userName}」${userPronoun ? `（代词：${userPronoun}）` : ""}。`
      : `等我们在聊天里慢慢熟起来，我会在这里记下怎么称呼你（frontmatter \`name\`）以及习惯用的代词（frontmatter \`pronoun\`：他 / 她 / TA）。`;
    await atomicWriteFile(
      opts.dataDir,
      userPath,
      `---\ntitle: 关于你\n${nameLine}\n${pronounLine}\n---\n# 关于你\n\n${bodyDesc}\n`,
    );
    await opts.memoryIndex?.reindexFile("user.md");
  } else if (userName || userPronoun) {
    const patch: Record<string, string> = {};
    if (userName) patch.name = userName;
    if (userPronoun) patch.pronoun = userPronoun;
    const updatedUser = updateFrontmatterFields(existingUser, patch);
    if (updatedUser !== existingUser) {
      await atomicWriteFile(opts.dataDir, userPath, updatedUser);
      await opts.memoryIndex?.reindexFile("user.md");
    }
  }

  return { named };
}
