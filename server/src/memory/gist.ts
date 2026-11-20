import fs from "node:fs/promises";
import path from "node:path";
import { stripFrontmatter } from "../core/prompts.ts";
import type { MemoryIndex } from "./index.ts";

const DEFAULT_GIST_CHAR_BUDGET = 3000;

async function readRecentMarkdownFiles(dir: string, limit: number): Promise<Array<{ name: string; body: string }>> {
  let names: string[];
  try {
    names = (await fs.readdir(dir))
      .filter((n) => n.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }

  const out: Array<{ name: string; body: string }> = [];
  for (const name of names) {
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      const body = stripFrontmatter(raw);
      if (body) out.push({ name, body });
    } catch {
      // 忽略单文件读取异常
    }
  }
  return out.reverse();
}

/**
 * 组装 Ring 1 两层自传骨架 <gist>（gist/weeks + gist/days + 近期未入梗概 daily/ 卡片摘要），
 * 受硬字符预算约束，用于 75% 异步换段后新会话首条锚点（对齐 Spec 01 §2.5 & Spec 02 §2.3）。
 */
export async function buildGistBlock(
  dataDir: string,
  memoryIndex: MemoryIndex,
  charBudget = DEFAULT_GIST_CHAR_BUDGET,
): Promise<string | null> {
  const memoryDir = path.join(dataDir, "memory");
  const sections: string[] = [];
  let used = 0;

  const appendSection = (heading: string, content: string): void => {
    const remaining = charBudget - used;
    if (remaining < 80) return;
    const prefix = `### ${heading}\n`;
    const bodyLimit = remaining - prefix.length - 2;
    if (bodyLimit < 30) return;
    const clipped = content.length > bodyLimit ? content.slice(0, bodyLimit - 1) + "…" : content;
    const block = `${prefix}${clipped}`;
    sections.push(block);
    used += block.length + 2;
  };

  const weeks = await readRecentMarkdownFiles(path.join(memoryDir, "gist", "weeks"), 2);
  for (const w of weeks) {
    appendSection(`周梗概 ${w.name}`, w.body);
  }

  const days = await readRecentMarkdownFiles(path.join(memoryDir, "gist", "days"), 2);
  for (const d of days) {
    appendSection(`日梗概 ${d.name}`, d.body);
  }

  // 待入梗概的近期活跃 daily/ 卡片摘要
  const recentDaily = memoryIndex
    .listAllRows()
    .filter((r) => r.space === "daily" && (r.status === "active" || r.status === "disputed"))
    .slice(0, 5);
  if (recentDaily.length > 0) {
    const lines = recentDaily.map((r) => `- ${r.path}：${r.title}`);
    appendSection("近期日常卡片", lines.join("\n"));
  }

  if (sections.length === 0) return null;
  return `<gist>\n${sections.join("\n\n")}\n</gist>`;
}
