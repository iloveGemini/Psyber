import type { DoorState } from "../core/config.ts";
import type { ExpressionPayload } from "../expression/express.ts";
import type { ToolResult } from "../memory/tools.ts";
import type { StoredEvent } from "../store/events.ts";

export type { ExpressionPayload };

export type ToolTier = 1 | 2 | 3;
export type ToolSecurityLevel = "auto" | "guarded" | "confirm";

export interface ToolApprovalRequest {
  turnId: string;
  toolName: string;
  summary: string;
  arguments: Record<string, unknown>;
}

export interface ToolApprovalResult {
  decision: "allow" | "deny";
  scope?: "once" | "session";
  reason?: string;
}

/** 通用工具定义（由 tools/ 导出供 llm/ 消费，保持单向依赖不反向导入 llm/） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ShareCardRecord {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  openedAt?: number;
}

export interface PendingDoorUpdate {
  from: DoorState;
  to: DoorState;
  note: string | null;
  content: string;
}

export interface ToolExecutionContext {
  turnId: string;
  sessionId: string;
  mode: "chat" | "wake";
  touchedMemoryPaths: Set<string>;
  expressionCount: number;
  expressions: ExpressionPayload[];
  shares?: ShareCardRecord[];
  pendingDoorUpdates?: PendingDoorUpdate[];
  signal?: AbortSignal;
  onExpression?: (payload: ExpressionPayload) => void;
  onDoorUpdated?: (state: DoorState, note: string | null) => void;
  onMessageRetracted?: (event: StoredEvent) => void;
  requestApproval?: (req: ToolApprovalRequest) => Promise<ToolApprovalResult>;
}

export interface RegisteredTool {
  name: string;
  tier: ToolTier;
  security: ToolSecurityLevel;
  description: string;
  tags: string[];
  parameters: Record<string, unknown>;
  guard?: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolResult>;
}

/**
 * 三层工具注册中心：
 * - Tier 1 固定 9 工具按 ASCII 升序冻结在 Static Prefix，保护 Prompt Cache 零失效；
 * - Tier 2/3 工具通过 tool_search + call_tool 按需检索与调用。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  unregisterByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of Array.from(this.tools.keys())) {
      if (key.startsWith(prefix)) {
        this.tools.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** 返回按 name ASCII 升序冻结的 Tier 1 工具定义列表 */
  getTier1Definitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter((t) => t.tier === 1)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
  }

  /** 按意图关键词检索 Tier 2/3 工具并返回精简规范（≤ 1200 字符） */
  searchExtendedTools(query: string, limit = 5): string {
    const q = query.trim().toLowerCase();
    const candidates = Array.from(this.tools.values()).filter((t) => t.tier !== 1);
    if (candidates.length === 0) {
      return "当前没有已注册的扩展工具。";
    }

    const scored = candidates
      .map((t) => {
        const hay = `${t.name} ${t.description} ${t.tags.join(" ")}`.toLowerCase();
        let score = 0;
        if (q && hay.includes(q)) score += 3;
        for (const token of q.split(/\s+/).filter(Boolean)) {
          if (hay.includes(token)) score += 1;
        }
        return { tool: t, score };
      })
      .filter((x) => !q || x.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, Math.max(1, Math.min(10, limit)));

    if (scored.length === 0) {
      return `未找到匹配 "${query}" 的扩展工具。`;
    }

    const blocks = scored.map(
      ({ tool }) =>
        `- ${tool.name} (${tool.security}): ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`,
    );
    const joined = blocks.join("\n");
    return joined.length > 1200 ? joined.slice(0, 1190) + "\n…（已截断）" : joined;
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `未知工具 "${name}"，可先用 tool_search 检索可用工具` };
    }
    if (tool.guard) {
      const verdict = await tool.guard(args, ctx);
      if (!verdict.ok) {
        return { ok: false, output: verdict.reason };
      }
    }
    if (tool.security === "confirm") {
      if (!ctx.requestApproval) {
        return {
          ok: false,
          output: `工具 "${name}" 需要用户确认审批，当前非交互轮次已保守拦截`,
        };
      }
      const approval = await ctx.requestApproval({
        turnId: ctx.turnId,
        toolName: name,
        summary: `${tool.description || name}`,
        arguments: args,
      });
      if (approval.decision !== "allow") {
        return {
          ok: false,
          output: approval.reason || `用户拒绝了工具 "${name}" 的本次调用`,
        };
      }
    }
    return tool.execute(args, ctx);
  }
}

export { registerCoreTier1Tools } from "./core_tools.ts";
