/**
 * 决策模型单题定义（对齐 Gemini Decisions API `v1beta/decisions`）：
 * - noul: 是/否校准概率（0.01..0.99）
 * - choice: 单选分类（criteria 键值映射各选项说明）
 * - score: 有序量表打分
 *
 * 置于 core/ 层供 memory/、llm/ 与 engine/ 单向依赖共享，避免跨圈反向引用。
 */
export interface DecisionQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string>;
}

export interface DecisionAnswer {
  /** noul 类型返回 0.01..0.99 校准概率 */
  noul?: number;
  /** choice 类型返回最高概率选项名 */
  choice?: string;
  /** score 类型返回期望分值 */
  score?: number;
  /** 置信度（0..1） */
  confidence?: number;
  /** choice / score 各选项概率分布 */
  probabilities?: Record<string, number>;
}

export interface DecisionRequest {
  input: string;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  /** 实际使用的后端标识（便于日志与测试观测） */
  backend?: string;
}

export interface DecisionClient {
  decide(req: DecisionRequest): Promise<DecisionResponse>;
}

/**
 * 清除字符串中因按 UTF-16 码元截断 emoji 等产生的孤立代理项（lone surrogates），
 * 避免严格 JSON/UTF-8 解析器（如 Google Decisions API）返回 HTTP 400。
 */
export function sanitizeUnicode(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}
