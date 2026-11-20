import fs from "node:fs/promises";
import path from "node:path";

export interface StoredCredentials {
  /** 各 Provider 的 BYOK API Key（按 provider 键名索引，仅存 0600 权限的 credentials.json） */
  apiKeys: Record<string, string>;
  /** 通用 Webhook 等离线通道引用的 Bearer Token（按 credentialKey 索引） */
  channelTokens: Record<string, string>;
}

const EMPTY_CREDENTIALS: StoredCredentials = {
  apiKeys: {},
  channelTokens: {},
};

/**
 * 读取 <dataDir>/credentials.json；不存在时返回空凭证对象。
 */
export async function loadCredentials(dataDir: string): Promise<StoredCredentials> {
  const credPath = path.join(dataDir, "credentials.json");
  try {
    const raw = await fs.readFile(credPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    return {
      apiKeys: parsed.apiKeys && typeof parsed.apiKeys === "object" ? { ...parsed.apiKeys } : {},
      channelTokens:
        parsed.channelTokens && typeof parsed.channelTokens === "object"
          ? { ...parsed.channelTokens }
          : {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { apiKeys: {}, channelTokens: {} };
    }
    throw new Error(`无法读取凭证文件 ${credPath}: ${(err as Error).message}`);
  }
}

/**
 * 原子写入 <dataDir>/credentials.json 并强制权限为 0600（仅当前系统用户可读可写）。
 */
export async function saveCredentials(dataDir: string, creds: StoredCredentials): Promise<void> {
  const targetPath = path.join(dataDir, "credentials.json");
  const tmpDir = path.join(dataDir, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `cred.${crypto.randomUUID()}.tmp`);
  const content = JSON.stringify(
    {
      apiKeys: creds.apiKeys ?? EMPTY_CREDENTIALS.apiKeys,
      channelTokens: creds.channelTokens ?? EMPTY_CREDENTIALS.channelTokens,
    },
    null,
    2,
  ) + "\n";

  const fh = await fs.open(tmpPath, "w", 0o600);
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, targetPath);
  await fs.chmod(targetPath, 0o600);
}
