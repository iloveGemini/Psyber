const STOPWORDS = new Set([
  "我们",
  "你们",
  "今天",
  "刚才",
  "什么",
  "怎么",
  "还是",
  "可以",
  "就是",
  "已经",
  "这个",
  "那个",
  "一下",
  "觉得",
  "时候",
  "the",
  "and",
  "for",
  "with",
]);

/**
 * 零原生扩展依赖的 CJK 2-gram + 英文数字词元切分器，解决 SQLite unicode61 不切中文的问题。
 */
export function tokenizeForFts(text: string): string {
  const tokens: string[] = [];
  const normalized = text.normalize("NFKC");

  // 1. 英文与数字连续串
  for (const m of normalized.matchAll(/[a-z0-9]+/gi)) {
    tokens.push(m[0].toLowerCase());
  }

  // 2. 连续汉字段：单字保留，≥2 字输出全部相邻 2-gram
  for (const m of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const seg = m[0];
    const chars = Array.from(seg);
    if (chars.length === 1) {
      tokens.push(chars[0]);
    } else {
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1]);
      }
    }
  }

  // 3. 日文假名与韩文音节段
  for (const m of normalized.matchAll(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const chars = Array.from(m[0]);
    if (chars.length === 1) {
      tokens.push(chars[0]);
    } else {
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1]);
      }
    }
  }

  return tokens.join(" ");
}

/**
 * 将用户输入转为安全的 FTS5 MATCH 表达式（每个词元双引号包裹防保留字语法错，OR 拼接）。
 */
export function buildSafeFtsQuery(query: string): string | null {
  const rawTokens = tokenizeForFts(query)
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));

  const unique = Array.from(new Set(rawTokens));
  if (unique.length === 0) return null;

  return unique.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
