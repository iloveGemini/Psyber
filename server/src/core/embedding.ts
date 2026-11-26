/**
 * 向量嵌入客户端抽象（置于 core/ 层，供 llm/、memory/ 与 engine/ 单向依赖共享）。
 */
export type EmbeddingTaskType = "query" | "document";

export interface EmbeddingOptions {
  signal?: AbortSignal;
  taskType?: EmbeddingTaskType;
}

export interface EmbeddingClient {
  /** 稳定模型标识（用于 SQLite card_embeddings 分模型隔离缓存，如 "google:gemini-embedding-2"） */
  readonly modelKey: string;
  /** 可选：运行期动态客户端指示当前是否已配置 embedding 槽位（未配置时召回引擎直接跳过，免抛错） */
  isConfigured?(): boolean;
  /** 对单条文本计算 L2 归一化向量 */
  embed(text: string, opts?: EmbeddingOptions): Promise<Float32Array>;
  /** 可选：批量计算多条文本向量（冷启动建索引大幅提速） */
  embedBatch?(texts: string[], opts?: EmbeddingOptions): Promise<Float32Array[]>;
}
