import type { Clock } from "../core/clock.ts";
import type { DoorState, PsyberConfig } from "../core/config.ts";
import {
  MAX_EXPRESSIONS_PER_TURN,
  normalizeExpressionPayload,
} from "../expression/express.ts";
import type { MemoryTools } from "../memory/tools.ts";
import type { EventStore } from "../store/events.ts";
import type { ToolDefinition, ToolRegistry } from "./registry.ts";

/** 原生 5 记忆工具定义（供 Tier 1 注册与静默整理轮 tidy.ts 共享，避免重复声明） */
export const MEMORY_5_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "edit",
    description: "局部精确替换 memory/ 中的笔记片段（补丁外内容严格不变）",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "glob",
    description: "列举 memory/ 目录下的文件路径清单",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "在 memory/ 中按字面或正则全文检索线索",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include_archived: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read",
    description: "精读某篇记忆卡片正文",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "新建或整篇覆写记忆卡片（严禁覆写 self.md 与 user.md）",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
];

/** 注册 Ring 1 常驻 9 个 Tier 1 核心工具 */
export function registerCoreTier1Tools(
  registry: ToolRegistry,
  deps: {
    memoryTools: MemoryTools;
    events: EventStore;
    clock: Clock;
    getConfig: () => PsyberConfig;
    saveConfig: (cfg: PsyberConfig) => Promise<void>;
  },
): void {
  const { memoryTools, events, clock, getConfig, saveConfig } = deps;

  registry.register({
    name: "call_tool",
    tier: 1,
    security: "auto",
    description: "调用扩展工具库中的具体工具（通过 tool_search 检索后获得）",
    tags: ["extension", "call"],
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["name", "arguments"],
    },
    execute: async (args, ctx) => {
      const targetName = typeof args.name === "string" ? args.name.trim() : "";
      const targetArgs =
        args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
          ? (args.arguments as Record<string, unknown>)
          : {};
      if (!targetName) return { ok: false, output: "call_tool 缺少目标工具名 name" };
      const target = registry.get(targetName);
      if (!target || target.tier === 1) {
        return { ok: false, output: `扩展工具 "${targetName}" 不存在，请先调用 tool_search` };
      }
      return registry.invoke(targetName, targetArgs, ctx);
    },
  });

  registry.register({
    name: "door",
    tier: 1,
    security: "guarded",
    description: "调整自己与外界的关系门状态及门牌便签（open / quiet / closed）",
    tags: ["door", "boundary"],
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "quiet", "closed", "cooling_off", "departed"] },
        note: { type: "string" },
        farewell: { type: "string" },
      },
      required: ["state"],
    },
    guard: async (args) => {
      const state = typeof args.state === "string" ? args.state : "";
      if (state === "cooling_off" || state === "departed") {
        return {
          ok: false,
          reason: "当前版本尚未开启冷静期与离开流程，如需独处请先将门设为 closed",
        };
      }
      if (state !== "open" && state !== "quiet" && state !== "closed") {
        return { ok: false, reason: `非法门状态: ${state}` };
      }
      return { ok: true };
    },
    execute: async (args, ctx) => {
      const cfg = getConfig();
      const from = cfg.door.state;
      const to = args.state as DoorState;
      const note = typeof args.note === "string" ? args.note.trim() || null : null;

      cfg.door.state = to;
      cfg.door.note = note;
      cfg.door.updatedAt = clock.now();
      await saveConfig(cfg);

      events.append({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        role: "system",
        kind: "door.updated",
        content: `门状态已由 ${from} 切换为 ${to}${note ? `（便签：${note}）` : ""}`,
        metadata: { from, to, note },
      });
      ctx.onDoorUpdated?.(to, note);
      return { ok: true, output: `已将门设为 ${to}${note ? `，便签：${note}` : ""}` };
    },
  });

  registry.register({
    name: "edit",
    tier: 1,
    security: "guarded",
    description: "局部精确替换 memory/ 中的笔记片段（补丁外内容严格不变）",
    tags: ["memory", "edit"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    execute: async (args, ctx) => {
      const p = String(args.path ?? "");
      const res = await memoryTools.edit(
        p,
        String(args.old_string ?? ""),
        String(args.new_string ?? ""),
      );
      if (res.ok) ctx.touchedMemoryPaths.add(p);
      return res;
    },
  });

  registry.register({
    name: "express",
    tier: 1,
    security: "auto",
    description: "发出具身身体语言、情绪出口或贴纸",
    tags: ["expression", "haptic", "sticker"],
    parameters: {
      type: "object",
      properties: {
        haptic: { type: "string", enum: ["light", "medium", "double", "heartbeat"] },
        atmosphere: {
          type: "object",
          properties: {
            tone: { type: "string", enum: ["warm", "cool", "dim", "bright", "neutral"] },
            intensity: { type: "string", enum: ["subtle", "noticeable"] },
            durationSec: { type: "number" },
          },
          required: ["tone", "intensity"],
        },
        motion: { type: "string", enum: ["shake", "breathe", "hesitate", "nod"] },
        stickerId: { type: "string" },
      },
    },
    execute: async (args, ctx) => {
      if (ctx.expressionCount >= MAX_EXPRESSIONS_PER_TURN) {
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            throttled: true,
            message: "本轮表达次数已达上限，后续请用文字自然交流",
          }),
        };
      }
      const normalized = normalizeExpressionPayload(args);
      if (!normalized.ok) {
        return { ok: false, output: normalized.error };
      }

      const payload = { ...normalized.payload };
      if (payload.stickerId) {
        const stickerRec = events.getSticker(payload.stickerId);
        if (!stickerRec) {
          const suggestions = events
            .listStickers(5)
            .map((s) => `${s.id}(${s.label})`)
            .join("、");
          const hint = suggestions ? `；可用贴纸参考：${suggestions}` : "；当前贴纸库为空";
          return { ok: false, output: `未找到贴纸 ID "${payload.stickerId}"${hint}` };
        }
        events.incrementStickerUsage(stickerRec.id);
        payload.sticker = {
          id: stickerRec.id,
          label: stickerRec.label,
          url: `/api/v1/media/${stickerRec.mediaHash}`,
        };
      }

      ctx.expressionCount += 1;
      ctx.expressions.push(payload);
      ctx.onExpression?.(payload);
      return { ok: true, output: "已发出具身表达" };
    },
  });

  registry.register({
    name: "glob",
    tier: 1,
    security: "auto",
    description: "列举 memory/ 目录下的文件路径清单",
    tags: ["memory", "glob"],
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
    execute: async (args) => memoryTools.glob(String(args.pattern ?? "")),
  });

  registry.register({
    name: "grep",
    tier: 1,
    security: "auto",
    description: "在 memory/ 中按字面或正则全文检索线索",
    tags: ["memory", "grep"],
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include_archived: { type: "boolean" },
      },
      required: ["pattern"],
    },
    execute: async (args) =>
      memoryTools.grep(
        String(args.pattern ?? ""),
        typeof args.path === "string" ? args.path : undefined,
        Boolean(args.include_archived),
      ),
  });

  registry.register({
    name: "read",
    tier: 1,
    security: "auto",
    description: "精读某篇记忆卡片正文",
    tags: ["memory", "read"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
    execute: async (args, ctx) =>
      memoryTools.read(String(args.path ?? ""), {
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        // 对齐 Spec 02 §1.2：仅主对话轮精读时累加 access_count
        countAccess: ctx.mode === "chat",
      }),
  });

  registry.register({
    name: "tool_search",
    tier: 1,
    security: "auto",
    description: "按意图检索当前可用的扩展工具，返回精简调用规范",
    tags: ["extension", "search"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
    execute: async (args) => ({
      ok: true,
      output: registry.searchExtendedTools(
        String(args.query ?? ""),
        typeof args.limit === "number" ? args.limit : 5,
      ),
    }),
  });

  registry.register({
    name: "write",
    tier: 1,
    security: "guarded",
    description: "新建或整篇覆写记忆卡片（严禁覆写 self.md 与 user.md）",
    tags: ["memory", "write"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    execute: async (args, ctx) => {
      const p = String(args.path ?? "");
      const res = await memoryTools.write(p, String(args.content ?? ""));
      if (res.ok) ctx.touchedMemoryPaths.add(p);
      return res;
    },
  });
}
