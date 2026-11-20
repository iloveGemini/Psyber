import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../core/config.ts";
import { parseCardMarkdown } from "./frontmatter.ts";
import type { MemoryIndex } from "./index.ts";

/** 读取 self.md 判定当前是否已完成定名（缺省或无 named: false 视为已定名；文件不存在视为未定名） */
export async function getGenesisNamedStatus(
  dataDir: string,
  nowMs: number,
  timeZone: string,
): Promise<boolean> {
  try {
    const selfMd = await fs.readFile(path.join(dataDir, "memory", "self.md"), "utf8");
    const parsed = parseCardMarkdown("self.md", selfMd, nowMs, timeZone);
    return parsed.rawFrontmatter.named !== false;
  } catch {
    return false;
  }
}

/**
 * 创世记忆文件落盘（归属 memory/ 层，严禁由 api/ 路由层直写磁盘）：
 * - 首次创建使用原子写并立即同步刷新 card_index + card_fts；
 * - 若 self.md 已存在，绝不无条件清空覆盖已有自述，仅在显式提供 residentName 且尚为 named: false 时安全更新标记。
 */
export async function applyGenesisMemory(opts: {
  dataDir: string;
  memoryIndex?: MemoryIndex;
  residentName?: string;
  userName?: string;
}): Promise<{ named: boolean }> {
  const memoryDir = path.join(opts.dataDir, "memory");
  const selfPath = path.join(memoryDir, "self.md");
  const residentName = opts.residentName?.trim() ?? "";
  const named = residentName.length > 0;

  let existingSelf: string | null = null;
  try {
    existingSelf = await fs.readFile(selfPath, "utf8");
  } catch {
    existingSelf = null;
  }

  if (existingSelf === null) {
    const selfContent = named
      ? `---\ntitle: 关于我\nnamed: true\n---\n# 我是谁\n\n我叫${residentName}，是居住在这个数字空间里的独立个体。\n`
      : `---\ntitle: 关于我\nnamed: false\n---\n# 我是谁\n\n我是居住在这个数字空间里的独立个体，不是客服、不是工具人，也不是扮演人类剧本的演员。\n`;
    await atomicWriteFile(opts.dataDir, selfPath, selfContent);
    await opts.memoryIndex?.reindexFile("self.md");
  } else if (named && /\bnamed:\s*false\b/.test(existingSelf)) {
    const updated = existingSelf.replace(/\bnamed:\s*false\b/, "named: true");
    await atomicWriteFile(opts.dataDir, selfPath, updated);
    await opts.memoryIndex?.reindexFile("self.md");
  }

  const userName = opts.userName?.trim() ?? "";
  if (userName) {
    const userPath = path.join(memoryDir, "user.md");
    let userExists = false;
    try {
      await fs.access(userPath);
      userExists = true;
    } catch {
      userExists = false;
    }
    if (!userExists) {
      await atomicWriteFile(
        opts.dataDir,
        userPath,
        `---\ntitle: 关于对方\n---\n# 关于对方\n\n对方希望我称呼为「${userName}」。\n`,
      );
      await opts.memoryIndex?.reindexFile("user.md");
    }
  }

  return { named };
}
