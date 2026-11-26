#!/usr/bin/env bun
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { hashBearerToken, issueMemoryMcpToken } from "../src/api/pairing.ts";
import { SystemClock } from "../src/core/clock.ts";
import {
  initDataDir,
  loadOrCreateConfig,
  mergeMemoryMcpConfig,
  saveConfig,
  type MemoryMcpAccessMode,
  type MemoryMcpConfig,
} from "../src/core/config.ts";

function expandHome(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function printHelp(): void {
  console.log(`Psyber 对外记忆 MCP 管理命令行

用法：
  bun run mcp -- [--data-dir <path>] <command> [options]

命令：
  status                                  查看 memoryMcp 开关、模式、端点与令牌清单
  enable [options]                        开启对外记忆 MCP（进入出差互斥模式，暂停内部 Psyber）
    --mode <read_only|read_write>         设置权限模式（默认沿用当前配置或 read_only）
    --allow-core                          允许写入 core/*（仅 read_write 生效）
    --protect-core                        保护 core/* 禁止外部写入（默认开启）
    --replay                              开启历史搬家任务工具 memory_replay（仅 read_write 生效）
    --no-replay                           关闭历史搬家任务工具 memory_replay（默认）
    --allow-remote                        允许非本机回环 IP 访问
    --local-only                          仅允许本机回环访问（默认）
  disable                                 关闭对外记忆 MCP（恢复内部 Psyber 正常对话与心跳）
  mode <read_only|read_write>             单独切换读写模式
  token create --name <label> [--mode read_only|read_write] [--save-stdio]
                                          签发新的专属 MCP 访问令牌（--save-stdio 同步写入 0600 mcp_stdio_token）
  token list                              列出已签发令牌
  token revoke <id>                       吊销指定令牌

选项：
  --data-dir <path>                       指定实例目录（默认 PSYBER_DATA_DIR 或 ~/.psyber/default）
  -h, --help                              显示本帮助
`);
}

interface LocalPairInfo {
  port?: number;
  host?: string;
  protocol?: string;
  instanceId?: string;
  pid?: number;
}

async function readLocalPairInfo(dataDir: string): Promise<LocalPairInfo | null> {
  try {
    const raw = await fs.readFile(path.join(dataDir, "local_pair.json"), "utf8");
    const parsed = JSON.parse(raw) as LocalPairInfo;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveMcpEndpoint(lp: LocalPairInfo | null): string {
  const protocol = lp?.protocol === "https" ? "https" : "http";
  const host = typeof lp?.host === "string" && lp.host ? lp.host : "127.0.0.1";
  const port = typeof lp?.port === "number" && lp.port > 0 ? lp.port : Number(process.env.PSYBER_PORT || 3721);
  return `${protocol}://${host}:${port}/mcp`;
}

async function notifyRunningServer(dataDir: string, instanceId: string): Promise<{ notified: boolean; endpoint: string }> {
  const lp = await readLocalPairInfo(dataDir);
  const endpoint = resolveMcpEndpoint(lp);

  if (!lp || lp.instanceId !== instanceId || typeof lp.pid !== "number" || lp.pid <= 0) {
    return { notified: false, endpoint };
  }
  try {
    process.kill(lp.pid, "SIGUSR2");
    return { notified: true, endpoint };
  } catch {
    return { notified: false, endpoint };
  }
}

function formatConfigStatus(cfg: MemoryMcpConfig, endpoint: string, dataDir: string): string {
  const lines = [
    `数据目录: ${dataDir}`,
    `服务状态: ${cfg.enabled ? "已开启（出差互斥模式，内部对话与心跳已暂停）" : "已关闭"}`,
    `权限模式: ${cfg.accessMode}`,
    `核心档案保护 (protectCoreFiles): ${cfg.protectCoreFiles ? "开启" : "关闭"}`,
    `搬家任务工具 (replayToolsEnabled): ${cfg.replayToolsEnabled ? "开启（允许 memory_replay）" : "关闭"}`,
    `允许远端访问 (allowRemote): ${cfg.allowRemote ? "是" : "否（仅本机回环）"}`,
    `单次输出上限: ${cfg.maxOutputChars} 字符`,
    `MCP 端点: ${endpoint}`,
    `已签发令牌 (${cfg.tokens.length}):`,
  ];
  if (cfg.tokens.length === 0) {
    lines.push("  （暂无令牌，可执行 bun run mcp -- token create --name claude-code 签发）");
  } else {
    for (const t of cfg.tokens) {
      const modeTag = t.accessMode ? ` | token上限=${t.accessMode}` : "";
      const lastUsed = t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : "未使用";
      lines.push(`  - ${t.id} | ${t.name}${modeTag} | 最近使用=${lastUsed}`);
    }
  }
  return lines.join("\n");
}

function parseGlobalArgs(argv: string[]): { dataDir: string; rest: string[]; help: boolean } {
  let dataDir = expandHome(process.env.PSYBER_DATA_DIR || "~/.psyber/default");
  let help = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      help = true;
    } else if (a === "--data-dir") {
      const val = argv[++i];
      if (!val) throw new Error("--data-dir 缺少路径参数");
      dataDir = expandHome(val);
    } else {
      rest.push(a);
    }
  }
  return { dataDir, rest, help };
}

async function main(): Promise<void> {
  const { dataDir, rest, help } = parseGlobalArgs(process.argv.slice(2));
  if (help || rest.length === 0) {
    printHelp();
    return;
  }

  const clock = new SystemClock();
  const cmd = rest[0]!;
  const subArgs = rest.slice(1);

  if (cmd === "status") {
    const cfg = await loadOrCreateConfig(dataDir, clock.now());
    const mcpCfg = mergeMemoryMcpConfig(cfg.memoryMcp);
    const lp = await readLocalPairInfo(dataDir);
    console.log(formatConfigStatus(mcpCfg, resolveMcpEndpoint(lp), dataDir));
    return;
  }

  await initDataDir(dataDir);
  const cfg = await loadOrCreateConfig(dataDir, clock.now());
  const current = mergeMemoryMcpConfig(cfg.memoryMcp);

  if (cmd === "enable") {
    let accessMode: MemoryMcpAccessMode | undefined;
    let protectCoreFiles: boolean | undefined;
    let replayToolsEnabled: boolean | undefined;
    let allowRemote: boolean | undefined;
    for (let i = 0; i < subArgs.length; i++) {
      const a = subArgs[i]!;
      if (a === "--mode") {
        const m = subArgs[++i];
        if (m !== "read_only" && m !== "read_write") {
          throw new Error("--mode 须为 read_only 或 read_write");
        }
        accessMode = m;
      } else if (a === "--allow-core") {
        protectCoreFiles = false;
      } else if (a === "--protect-core") {
        protectCoreFiles = true;
      } else if (a === "--replay") {
        replayToolsEnabled = true;
      } else if (a === "--no-replay") {
        replayToolsEnabled = false;
      } else if (a === "--allow-remote") {
        allowRemote = true;
      } else if (a === "--local-only") {
        allowRemote = false;
      } else {
        throw new Error(`未知参数: ${a}`);
      }
    }
    cfg.memoryMcp = mergeMemoryMcpConfig(current, {
      enabled: true,
      ...(accessMode !== undefined ? { accessMode } : {}),
      ...(protectCoreFiles !== undefined ? { protectCoreFiles } : {}),
      ...(replayToolsEnabled !== undefined ? { replayToolsEnabled } : {}),
      ...(allowRemote !== undefined ? { allowRemote } : {}),
    });
    await saveConfig(dataDir, cfg);
    const { notified, endpoint } = await notifyRunningServer(dataDir, cfg.instanceId);
    console.log(
      `已开启对外记忆 MCP（mode=${cfg.memoryMcp.accessMode}，protectCoreFiles=${cfg.memoryMcp.protectCoreFiles}，replayToolsEnabled=${cfg.memoryMcp.replayToolsEnabled}）。`,
    );
    console.log(`端点：${endpoint}`);
    console.log(notified ? "已通知运行中的 Psyber 服务端即时热重载（内部对话与心跳已暂停）。" : "配置已落盘，将在服务端启动时生效。");
    return;
  }

  if (cmd === "disable") {
    cfg.memoryMcp = mergeMemoryMcpConfig(current, { enabled: false });
    await saveConfig(dataDir, cfg);
    const { notified } = await notifyRunningServer(dataDir, cfg.instanceId);
    console.log("已关闭对外记忆 MCP。");
    console.log(notified ? "已通知运行中的 Psyber 服务端恢复内部对话与作息心跳。" : "配置已落盘，将在服务端启动时生效。");

    const sqlitePath = path.join(dataDir, "psyber.sqlite");
    try {
      await fs.access(sqlitePath);
      const db = new Database(sqlitePath, { readonly: true });
      try {
        const row = db
          .query("SELECT meta_json FROM task_cursors WHERE task_key = 'mcp_replay'")
          .get() as { meta_json: string | null } | null;
        if (row?.meta_json) {
          const parsed = JSON.parse(row.meta_json) as {
            activeStep?: { stepId?: string; day?: string; phase?: string } | null;
          };
          if (parsed?.activeStep?.stepId) {
            console.warn(
              `[提醒] 检测到仍有未结算的搬家步骤 (${parsed.activeStep.stepId} | ${parsed.activeStep.day} ${parsed.activeStep.phase})，建议下次开启后通过 memory_replay(action="next" 或 "abort") 收尾。`,
            );
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // 数据库不存在或未初始化表结构时忽略
    }
    return;
  }

  if (cmd === "mode") {
    const m = subArgs[0];
    if (m !== "read_only" && m !== "read_write") {
      throw new Error("用法: bun run mcp -- mode <read_only|read_write>");
    }
    cfg.memoryMcp = mergeMemoryMcpConfig(current, { accessMode: m });
    await saveConfig(dataDir, cfg);
    const { notified } = await notifyRunningServer(dataDir, cfg.instanceId);
    console.log(`已切换记忆 MCP 权限模式为 ${m}。`);
    if (notified) console.log("已通知运行中的 Psyber 服务端即时生效。");
    return;
  }

  if (cmd === "token") {
    const subCmd = subArgs[0];
    const tokenArgs = subArgs.slice(1);
    if (subCmd === "list") {
      if (current.tokens.length === 0) {
        console.log("暂无记忆 MCP 令牌。");
        return;
      }
      for (const t of current.tokens) {
        const modeTag = t.accessMode ? ` | token上限=${t.accessMode}` : "";
        const lastUsed = t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : "未使用";
        console.log(`${t.id} | ${t.name}${modeTag} | created=${new Date(t.createdAt).toISOString()} | lastUsed=${lastUsed}`);
      }
      return;
    }

    if (subCmd === "create") {
      let name = "";
      let mode: MemoryMcpAccessMode | undefined;
      let saveStdio = false;
      for (let i = 0; i < tokenArgs.length; i++) {
        const a = tokenArgs[i]!;
        if (a === "--name") {
          name = (tokenArgs[++i] ?? "").trim();
        } else if (a === "--mode") {
          const m = tokenArgs[++i];
          if (m !== "read_only" && m !== "read_write") {
            throw new Error("--mode 须为 read_only 或 read_write");
          }
          mode = m;
        } else if (a === "--save-stdio") {
          saveStdio = true;
        } else {
          throw new Error(`未知参数: ${a}`);
        }
      }
      if (!name || name.length > 48) {
        throw new Error(
          "用法: bun run mcp -- token create --name <1..48字符> [--mode read_only|read_write] [--save-stdio]",
        );
      }
      const { rawToken, entry } = issueMemoryMcpToken(name, clock.now(), mode);
      cfg.memoryMcp = mergeMemoryMcpConfig(current, {
        tokens: [...current.tokens, entry],
      });
      await saveConfig(dataDir, cfg);
      const stdioTokenPath = path.join(dataDir, "mcp_stdio_token");
      if (saveStdio) {
        const tmpTokenPath = `${stdioTokenPath}.tmp.${process.pid}.${Date.now()}`;
        await fs.writeFile(tmpTokenPath, `${rawToken}\n`, { mode: 0o600 });
        await fs.chmod(tmpTokenPath, 0o600).catch(() => {});
        await fs.rename(tmpTokenPath, stdioTokenPath);
        await fs.chmod(stdioTokenPath, 0o600).catch(() => {});
      }
      const { notified, endpoint } = await notifyRunningServer(dataDir, cfg.instanceId);
      const stdioScriptPath = path.resolve(import.meta.dir, "mcp_stdio.ts");
      const defaultDataDir = expandHome(process.env.PSYBER_DATA_DIR || "~/.psyber/default");
      const dataDirArg = dataDir === defaultDataDir ? "" : ` --data-dir ${dataDir}`;
      const stdioCmd = saveStdio
        ? `${process.execPath} run ${stdioScriptPath}${dataDirArg}`
        : `${process.execPath} run ${stdioScriptPath}${dataDirArg} --token ${rawToken}`;

      console.log(`已签发记忆 MCP 令牌：${entry.id} (${name})`);
      console.log(`令牌明文（仅显示一次，请妥善保存）：\n${rawToken}\n`);
      if (saveStdio) {
        console.log(`已安全保存 0600 凭证至：${stdioTokenPath}`);
      }
      console.log(`本地 stdio 客户端命令行（可直接填入桌面端「命令」框）：\n${stdioCmd}\n`);
      console.log("第三方客户端 Streamable HTTP 配置示例：");
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              "psyber-memory": {
                type: "http",
                url: endpoint,
                headers: {
                  Authorization: `Bearer ${rawToken}`,
                },
              },
            },
          },
          null,
          2,
        ),
      );
      if (notified) {
        console.log("\n已通知运行中的 Psyber 服务端即时加载新令牌。");
      }
      return;
    }

    if (subCmd === "revoke") {
      const targetId = (tokenArgs[0] ?? "").trim();
      if (!targetId) {
        throw new Error("用法: bun run mcp -- token revoke <tokenId>");
      }
      const revoked = current.tokens.find((t) => t.id === targetId);
      if (!revoked) {
        throw new Error(`未找到记忆 MCP 令牌: ${targetId}`);
      }
      const nextTokens = current.tokens.filter((t) => t.id !== targetId);
      cfg.memoryMcp = mergeMemoryMcpConfig(current, { tokens: nextTokens });
      await saveConfig(dataDir, cfg);

      const stdioTokenPath = path.join(dataDir, "mcp_stdio_token");
      try {
        const savedRaw = (await fs.readFile(stdioTokenPath, "utf8")).trim();
        if (savedRaw && hashBearerToken(savedRaw) === revoked.tokenHash) {
          await fs.rm(stdioTokenPath, { force: true });
        }
      } catch {
        // 文件不存在则忽略
      }

      const { notified } = await notifyRunningServer(dataDir, cfg.instanceId);
      console.log(`已吊销记忆 MCP 令牌: ${targetId}`);
      if (notified) console.log("已通知运行中的 Psyber 服务端即时生效。");
      return;
    }

    throw new Error(`未知 token 子命令: ${subCmd ?? "(空)"}`);
  }

  throw new Error(`未知命令: ${cmd}（使用 --help 查看用法）`);
}

main().catch((err) => {
  console.error(`[psyber-mcp] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
