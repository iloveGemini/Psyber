#!/usr/bin/env bun
/**
 * 历史记忆与事件库只读凭证体检脚本（绝不修改磁盘文件或 SQLite，绝不在终端打印明文凭证）：
 * 用法：
 *   cd server && bun run audit:secrets -- --data-dir ~/.psyber/test
 *   cd server && bun run audit:secrets -- --data-dir ~/.psyber/test --verbose
 *   cd server && bun run audit:secrets -- --data-dir ~/.psyber/test --json
 */
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectSecrets, redactSecrets, redactUnknownJson } from "../src/core/redact.ts";
import { expandHomePath } from "../src/extensions/bash.ts";

export interface MemorySecretFinding {
  path: string;
  line: number;
  labels: string[];
  redactedExcerpt?: string;
}

export interface EventSecretFinding {
  id: string;
  seq: number;
  role: string;
  kind: string;
  field: "content" | "thinking" | "metadata";
  labels: string[];
  redactedExcerpt?: string;
}

export interface SecretAuditReport {
  dataDir: string;
  scannedMemoryFiles: number;
  scannedEvents: number;
  memoryFindings: MemorySecretFinding[];
  eventFindings: EventSecretFinding[];
}

function makeRedactedExcerpt(text: string, maxChars = 120): string {
  const safe = redactSecrets(text).text.replace(/\s+/g, " ").trim();
  return safe.length > maxChars ? `${safe.slice(0, maxChars - 1)}…` : safe;
}

async function collectFilesRecursively(dir: string, baseDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".tmp") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursively(abs, baseDir)));
    } else if (entry.isFile() && /\.(?:md|yaml|yml)$/i.test(entry.name)) {
      files.push(path.relative(baseDir, abs).replace(/\\/g, "/"));
    }
  }
  files.sort();
  return files;
}

export async function auditMemoryDir(
  dataDir: string,
  opts: { verbose?: boolean } = {},
): Promise<{ scannedFiles: number; findings: MemorySecretFinding[] }> {
  const memoryDir = path.join(dataDir, "memory");
  const relFiles = await collectFilesRecursively(memoryDir, memoryDir);
  const findings: MemorySecretFinding[] = [];

  for (const rel of relFiles) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(memoryDir, rel), "utf8");
    } catch {
      continue;
    }
    // 先整文件快速扫一遍，避免多行 PEM 私钥块拆行漏检
    const wholeHits = detectSecrets(raw);
    if (wholeHits.length === 0) continue;

    const lines = raw.split(/\r?\n/);
    const coveredRuleIds = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const lineHits = detectSecrets(lines[i]!);
      if (lineHits.length > 0) {
        for (const h of lineHits) coveredRuleIds.add(h.ruleId);
        findings.push({
          path: rel,
          line: i + 1,
          labels: Array.from(new Set(lineHits.map((h) => h.label))),
          ...(opts.verbose ? { redactedExcerpt: makeRedactedExcerpt(lines[i]!) } : {}),
        });
      }
    }

    // 补报跨行规则（如完整多行 PEM 私钥块），避免同文件已有单行命中时静默漏报多行块
    const uncoveredWhole = wholeHits.filter((h) => !coveredRuleIds.has(h.ruleId));
    if (uncoveredWhole.length > 0) {
      const hasUncoveredPem = uncoveredWhole.some((h) => h.ruleId.startsWith("pem_private_key"));
      if (hasUncoveredPem) {
        const pemStartLines: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(lines[i]!)) {
            pemStartLines.push(i + 1);
          }
        }
        for (const startLine of pemStartLines.length > 0 ? pemStartLines : [1]) {
          findings.push({
            path: rel,
            line: startLine,
            labels: ["私钥块"],
            ...(opts.verbose
              ? {
                  redactedExcerpt: makeRedactedExcerpt(
                    lines.slice(startLine - 1, startLine + 4).join("\n"),
                  ),
                }
              : {}),
          });
        }
      }
      const otherUncovered = uncoveredWhole.filter((h) => !h.ruleId.startsWith("pem_private_key"));
      if (otherUncovered.length > 0) {
        findings.push({
          path: rel,
          line: 1,
          labels: Array.from(new Set(otherUncovered.map((h) => h.label))),
          ...(opts.verbose ? { redactedExcerpt: makeRedactedExcerpt(raw) } : {}),
        });
      }
    }
  }

  return { scannedFiles: relFiles.length, findings };
}

export function auditEventsDb(
  dataDir: string,
  opts: { verbose?: boolean } = {},
): { scannedEvents: number; findings: EventSecretFinding[] } {
  const dbPath = path.join(dataDir, "psyber.sqlite");
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return { scannedEvents: 0, findings: [] };
  }

  const findings: EventSecretFinding[] = [];
  let scannedEvents = 0;
  try {
    const rows = db
      .query(
        `SELECT id, seq, role, kind, content, thinking, metadata
         FROM events
         ORDER BY seq ASC`,
      )
      .all() as Array<{
      id: string;
      seq: number;
      role: string;
      kind: string;
      content: string;
      thinking: string | null;
      metadata: string | null;
    }>;

    scannedEvents = rows.length;
    for (const row of rows) {
      const checkField = (field: "content" | "thinking" | "metadata", val: string | null) => {
        if (!val) return;
        const hits = detectSecrets(val);
        if (hits.length === 0) return;
        findings.push({
          id: row.id,
          seq: row.seq,
          role: row.role,
          kind: row.kind,
          field,
          labels: Array.from(new Set(hits.map((h) => h.label))),
          ...(opts.verbose ? { redactedExcerpt: makeRedactedExcerpt(val) } : {}),
        });
      };
      checkField("content", row.content);
      checkField("thinking", row.thinking);
      if (row.metadata) {
        let parsedJson: unknown;
        let jsonOk = false;
        try {
          parsedJson = JSON.parse(row.metadata);
          jsonOk = parsedJson !== null && typeof parsedJson === "object";
        } catch {
          jsonOk = false;
        }
        if (jsonOk) {
          const jsonRes = redactUnknownJson(parsedJson);
          if (jsonRes.redacted) {
            findings.push({
              id: row.id,
              seq: row.seq,
              role: row.role,
              kind: row.kind,
              field: "metadata",
              labels: jsonRes.labels,
              ...(opts.verbose
                ? { redactedExcerpt: makeRedactedExcerpt(JSON.stringify(jsonRes.value)) }
                : {}),
            });
          }
        } else {
          checkField("metadata", row.metadata);
        }
      }
    }
  } finally {
    db.close();
  }

  return { scannedEvents, findings };
}

export async function runSecretAudit(
  dataDir: string,
  opts: { skipMemory?: boolean; skipEvents?: boolean; verbose?: boolean } = {},
): Promise<SecretAuditReport> {
  const mem = opts.skipMemory
    ? { scannedFiles: 0, findings: [] }
    : await auditMemoryDir(dataDir, { verbose: opts.verbose });
  const ev = opts.skipEvents
    ? { scannedEvents: 0, findings: [] }
    : auditEventsDb(dataDir, { verbose: opts.verbose });

  return {
    dataDir,
    scannedMemoryFiles: mem.scannedFiles,
    scannedEvents: ev.scannedEvents,
    memoryFindings: mem.findings,
    eventFindings: ev.findings,
  };
}

interface CliOpts {
  dataDir: string;
  skipMemory: boolean;
  skipEvents: boolean;
  verbose: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const defaultDir =
    process.env.PSYBER_DATA_DIR || path.join(os.homedir() || ".", ".psyber", "test");
  const opts: CliOpts = {
    dataDir: path.resolve(expandHomePath(defaultDir)),
    skipMemory: false,
    skipEvents: false,
    verbose: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir" && argv[i + 1]) {
      opts.dataDir = path.resolve(expandHomePath(argv[++i]!));
    } else if (arg === "--skip-memory") {
      opts.skipMemory = true;
    } else if (arg === "--skip-events") {
      opts.skipEvents = true;
    } else if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
    } else if (arg === "--json") {
      opts.json = true;
    }
  }
  return opts;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runSecretAudit(opts.dataDir, opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== Psyber 历史凭证只读体检 ===`);
    console.log(`目录: ${report.dataDir}`);
    console.log(
      `已扫描: memory/ ${report.scannedMemoryFiles} 个文件，events ${report.scannedEvents} 条记录`,
    );

    if (report.memoryFindings.length === 0 && report.eventFindings.length === 0) {
      console.log("结果: 未发现高置信度明文凭证。");
    } else {
      if (report.memoryFindings.length > 0) {
        console.log(`\n[memory/] 发现 ${report.memoryFindings.length} 处疑似明文凭证:`);
        for (const f of report.memoryFindings) {
          console.log(`  - memory/${f.path}:${f.line} [${f.labels.join(", ")}]`);
          if (f.redactedExcerpt) console.log(`    脱敏预览: ${f.redactedExcerpt}`);
        }
      }
      if (report.eventFindings.length > 0) {
        console.log(`\n[events] 发现 ${report.eventFindings.length} 处疑似明文凭证:`);
        for (const f of report.eventFindings) {
          console.log(
            `  - seq=${f.seq} id=${f.id} (${f.role}/${f.kind} · ${f.field}) [${f.labels.join(", ")}]`,
          );
          if (f.redactedExcerpt) console.log(`    脱敏预览: ${f.redactedExcerpt}`);
        }
      }
    }
  }

  const totalHits = report.memoryFindings.length + report.eventFindings.length;
  process.exit(totalHits > 0 ? 1 : 0);
}
