/**
 * 二阶段精排客户端抽象（置于 core/ 层，供 llm/、memory/ 与 engine/ 单向依赖共享）。
 */
export interface RerankItem {
  /** 对应输入 documents 数组的 0-based 索引 */
  index: number;
  /** 相关性分数（通常在 0..1 区间，越大越相关） */
  relevanceScore: number;
}

export interface RerankerOptions {
  signal?: AbortSignal;
  topN?: number;
}

export interface RerankerClient {
  /** 稳定模型标识（用于日志与评测缓存隔离，如 "Siliconflow-cn:Qwen/Qwen3-Reranker-8B"） */
  readonly modelKey: string;
  /** 可选：运行期动态客户端指示当前是否已配置 reranker 槽位 */
  isConfigured?(): boolean;
  /** 对候选文档按查询相关性重排打分 */
  rerank(query: string, documents: string[], opts?: RerankerOptions): Promise<RerankItem[]>;
}
