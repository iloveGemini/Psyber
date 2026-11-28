import fs from "node:fs/promises";
import path from "node:path";

export interface LoadedPrompt {
  name: string;
  body: string;
}

const INCLUDE_RE = /\{\{>\s*([A-Za-z0-9_./-]+)\s*\}\}/g;
const MAX_INCLUDE_DEPTH = 3;

/** 剥离 Markdown 顶部 YAML Frontmatter 并去除首尾空白（供 prompts 与 recall 共享） */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

async function resolveIncludes(
  promptsDir: string,
  text: string,
  depth: number,
  seen: Set<string>,
): Promise<string> {
  if (depth >= MAX_INCLUDE_DEPTH || !text.includes("{{>")) return text;
  const resolvedRoot = path.resolve(promptsDir);
  const matches = Array.from(text.matchAll(INCLUDE_RE));
  if (matches.length === 0) return text;

  let out = text;
  for (const m of matches) {
    const rawRef = m[1]!.trim();
    const file = rawRef.endsWith(".md") ? rawRef : `${rawRef}.md`;
    const absPath = path.resolve(resolvedRoot, file);
    if (!absPath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Prompt include escapes promptsDir: ${rawRef}`);
    }
    if (seen.has(absPath)) {
      throw new Error(`Circular prompt include detected: ${rawRef}`);
    }
    const raw = await fs.readFile(absPath, "utf8");
    const nextSeen = new Set(seen);
    nextSeen.add(absPath);
    const expanded = await resolveIncludes(
      promptsDir,
      stripFrontmatter(raw),
      depth + 1,
      nextSeen,
    );
    out = out.replaceAll(m[0], expanded);
  }
  return out;
}

/**
 * 读时现读、不缓存地读取 prompts/<filename> 并剥离 YAML Frontmatter，
 * 支持 {{var}} 微模板替换与 {{> partial.md}} 共享片段引入，热改提示词在下一次对话或整理轮立即生效。
 */
export async function readPrompt(
  promptsDir: string,
  filename: string,
  vars?: Record<string, string>,
): Promise<LoadedPrompt> {
  const file = filename.endsWith(".md") ? filename : `${filename}.md`;
  const fullPath = path.resolve(promptsDir, file);
  const raw = await fs.readFile(fullPath, "utf8");
  let body = stripFrontmatter(raw);

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      body = body.replaceAll(`{{${k}}}`, v);
    }
  }

  body = await resolveIncludes(promptsDir, body, 0, new Set([fullPath]));
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  return { name: file, body };
}
