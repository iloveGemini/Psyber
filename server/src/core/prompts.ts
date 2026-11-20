import fs from "node:fs/promises";
import path from "node:path";

export interface LoadedPrompt {
  name: string;
  body: string;
}

/** 剥离 Markdown 顶部 YAML Frontmatter 并去除首尾空白（供 prompts 与 recall 共享） */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

/**
 * 读时现读、不缓存地读取 prompts/<filename> 并剥离 YAML Frontmatter，
 * 支持 {{var}} 微模板替换，热改提示词在下一次对话或整理轮立即生效。
 */
export async function readPrompt(
  promptsDir: string,
  filename: string,
  vars?: Record<string, string>,
): Promise<LoadedPrompt> {
  const file = filename.endsWith(".md") ? filename : `${filename}.md`;
  const fullPath = path.join(promptsDir, file);
  const raw = await fs.readFile(fullPath, "utf8");
  let body = stripFrontmatter(raw);

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      body = body.replaceAll(`{{${k}}}`, v);
    }
  }

  return { name: file, body };
}
