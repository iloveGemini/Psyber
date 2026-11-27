/**
 * 高置信度隐私与凭证脱敏模块（Spec 01 §1.1 & Spec 02 §1.2）：
 * - 聚焦结构化强特征凭证（厂商前缀 API Key / Token、PEM 私钥块、带账密 URL、JWT、Bearer/Basic 认证头、高熵密钥配置键值），
 *   避免误伤普通聊天数字、游戏昵称、SHA-256 哈希、ULID/UUID 或常见占位符；
 * - 替换结果保持幂等（再次扫描不再重复命中），并保留周围语境（协议、用户名、配置键名）以便排障与阅读。
 */

export interface SecretMatch {
  ruleId: string;
  label: string;
}

export interface RedactResult {
  text: string;
  redacted: boolean;
  matches: SecretMatch[];
  labels: string[];
}

interface SecretRule {
  id: string;
  label: string;
  apply: (text: string, onHit: (hit: SecretMatch) => void) => string;
}

const REDACTED_MARKER_RE = /^\[已隐藏:[^\]]+\]$/;

const PLACEHOLDER_VALUE_RE =
  /^(?:(?:your|my|example|sample|dummy|test|demo)[_-](?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|key|secret|password|passwd|pass|value|here)(?:[_-]here)?|placeholder(?:[_-][a-z_-]+)?|changeme|change[_-]?me|replace[_-]?me|redacted|hidden|masked|secret|password|passwd|token|api[_-]?key|none|null|undefined|true|false|required|optional|string|number|boolean|invalid[_-]?grant|not[_-]?configured|missing[_-][a-z_-]+|empty|test|demo|example|sample|dummy|\*+|x+|•+|\.+|<[^>\s]+>|\$\{[^}\s]+\}|\{\{[^}\s]+\}\})$/i;

/** 判定配置值是否明显是占位符、路径、普通枚举词或已脱敏标记（防误杀） */
function isSafePlaceholderOrNonSecret(rawValue: string): boolean {
  const val = rawValue.trim();
  if (!val) return true;
  if (REDACTED_MARKER_RE.test(val) || val.includes("[已隐藏:")) return true;
  if (PLACEHOLDER_VALUE_RE.test(val)) return true;
  // 明显是本地文件路径或不含账密的普通 URL
  if (/^(?:\.{0,2}\/|~\/|[a-zA-Z]:\\)/.test(val)) return true;
  if (/^https?:\/\/[^@\s]+$/i.test(val)) return true;
  // 明显的环境变量引用（如 $OPENAI_API_KEY / %API_KEY% / ${cred:xxx}）
  if (/^(?:\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\$\{[^}]+\})$/.test(val)) return true;
  // 全同字符（如 00000000 / aaaaaaaa）
  if (/^(.)\1+$/.test(val)) return true;
  return false;
}

function countCharClasses(val: string): number {
  let classes = 0;
  if (/[a-z]/.test(val)) classes += 1;
  if (/[A-Z]/.test(val)) classes += 1;
  if (/\d/.test(val)) classes += 1;
  if (/[^A-Za-z0-9]/.test(val)) classes += 1;
  return classes;
}

const NON_SECRET_TOKEN_KEY_RE =
  /^(?:max|min|input|output|total|prompt|completion|cache(?:[_-]?read|[_-]?write)?|context|used|limit|budget|page|next[_-]?page|prev[_-]?page|continuation|cursor)[_-]?tokens?$/i;

/**
 * 校验结构化键值中的值是否具备高置信度凭证特征：
 * - password/passwd 类：≥ 8 位，且包含数字或至少 2 种字符类（避免 `password: required` / `password: string` 误杀）；
 * - key/token/secret 类：≥ 12 位且至少 2 种字符类，或 ≥ 20 位无空格长串（避免 `token: invalid_grant` 误杀）。
 */
function looksLikeHighConfidenceKvSecret(keyName: string, val: string): boolean {
  if (NON_SECRET_TOKEN_KEY_RE.test(keyName)) return false;
  if (isSafePlaceholderOrNonSecret(val)) return false;
  if (/\s/.test(val)) return false;
  const isPasswordKey = /(?:pass(?:word|wd)?)$/i.test(keyName);
  const classes = countCharClasses(val);
  if (isPasswordKey) {
    if (val.length < 8) return false;
    return /\d/.test(val) || classes >= 2;
  }
  if (val.length < 12) return false;
  if (classes >= 2) return true;
  return val.length >= 20 && /^[A-Za-z0-9_-]+$/.test(val);
}

function makeSimpleRegexRule(id: string, label: string, pattern: RegExp): SecretRule {
  return {
    id,
    label,
    apply: (text, onHit) =>
      text.replace(pattern, () => {
        onHit({ ruleId: id, label });
        return `[已隐藏:${label}]`;
      }),
  };
}

const SECRET_RULES: SecretRule[] = [
  // 1. PEM 私钥块（含完整块与被截断的私钥头部）
  makeSimpleRegexRule(
    "pem_private_key",
    "私钥块",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  ),
  makeSimpleRegexRule(
    "pem_private_key_partial",
    "私钥块",
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{40,}/g,
  ),

  // 2. 明确前缀的主流 AI / 云平台 / 代码托管密钥与令牌（更具体前缀优先于通用前缀）
  makeSimpleRegexRule(
    "anthropic_api_key",
    "Anthropic密钥",
    /\bsk-ant-(?:api\d{2}-|oat\d{2}-|admin\d{2}-)?[A-Za-z0-9_-]{20,}\b/g,
  ),
  makeSimpleRegexRule(
    "openai_api_key",
    "OpenAI密钥",
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
  ),
  makeSimpleRegexRule("google_api_key", "Google密钥", /\bAIza[0-9A-Za-z_-]{30,}\b/g),
  makeSimpleRegexRule(
    "github_token",
    "GitHub令牌",
    /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  ),
  makeSimpleRegexRule("gitlab_token", "GitLab令牌", /\bglpat-[A-Za-z0-9_-]{20,}\b/g),
  makeSimpleRegexRule("aws_access_key", "AWS密钥", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g),
  makeSimpleRegexRule("slack_token", "Slack令牌", /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/g),
  makeSimpleRegexRule("stripe_key", "Stripe密钥", /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/g),
  makeSimpleRegexRule("huggingface_token", "HuggingFace令牌", /\bhf_[A-Za-z0-9]{24,}\b/g),
  makeSimpleRegexRule("groq_api_key", "Groq密钥", /\bgsk_[A-Za-z0-9]{24,}\b/g),
  makeSimpleRegexRule("perplexity_api_key", "Perplexity密钥", /\bpplx-[A-Za-z0-9]{24,}\b/g),
  makeSimpleRegexRule(
    "tavily_api_key",
    "Tavily密钥",
    /\btvly-(?:dev-|prod-)?[A-Za-z0-9_-]{20,}\b/g,
  ),
  makeSimpleRegexRule("npm_token", "npm令牌", /\bnpm_[A-Za-z0-9]{30,}\b/g),
  makeSimpleRegexRule("pypi_token", "PyPI令牌", /\bpypi-[A-Za-z0-9_-]{40,}\b/g),
  makeSimpleRegexRule("telegram_bot_token", "Telegram令牌", /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}\b/g),
  makeSimpleRegexRule(
    "discord_webhook",
    "DiscordWebhook",
    /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{30,}/g,
  ),
  makeSimpleRegexRule(
    "slack_webhook",
    "SlackWebhook",
    /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  ),

  // 3. JWT 令牌
  makeSimpleRegexRule(
    "jwt_token",
    "JWT令牌",
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g,
  ),

  // 4. 带账密的 URL / 数据库连接串（保留协议、用户名与主机，仅隐藏密码段）
  {
    id: "url_credentials",
    label: "连接串密码",
    apply: (text, onHit) =>
      text.replace(
        /\b((?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|ftp|ftps|sftp|smtp|smtps):\/\/)([^/\s:@，。；！？（）【】、]*):([^/\s@，。；！？（）【】、]{4,})@/gi,
        (full, scheme: string, user: string, pass: string) => {
          if (isSafePlaceholderOrNonSecret(pass)) return full;
          onHit({ ruleId: "url_credentials", label: "连接串密码" });
          return `${scheme}${user}:[已隐藏:连接串密码]@`;
        },
      ),
  },

  // 5. HTTP Authorization 认证头（Bearer / Basic / Token）
  {
    id: "auth_header",
    label: "认证令牌",
    apply: (text, onHit) =>
      text.replace(
        /(\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)([^\s"',;}{，。；！？（）【】、“”‘’]{16,})(["']?)/gi,
        (full, prefix: string, token: string, quote: string) => {
          if (isSafePlaceholderOrNonSecret(token)) return full;
          onHit({ ruleId: "auth_header", label: "认证令牌" });
          return `${prefix}[已隐藏:认证令牌]${quote}`;
        },
      ),
  },

  // 6. 结构化键值对中的明确凭证（.env / JSON / YAML / INI 风格）
  //    拆分为「双引号值」「单引号值」「无引号值」三分支：
  //    - 引号分支允许逗号/分号/冒号等密码常用符号，仅排除换行与同种引号；
  //    - 无引号分支按空白及中英文行内标点截断，防误吞后续正文；
  //    - 键名覆盖通用 token（bot_token / api_token / session_token / 裸 token 等），由 NON_SECRET_TOKEN_KEY_RE 与高熵校验防误杀。
  {
    id: "kv_secret",
    label: "配置密钥",
    apply: (text, onHit) => {
      const replaceKv = (
        full: string,
        prefix: string,
        quote: string,
        val: string,
        endQuote: string,
      ): string => {
        const keyMatch = /([A-Za-z0-9_-]+)["']?\s*[:=]\s*$/.exec(prefix);
        const keyName = keyMatch?.[1] ?? "";
        if (!looksLikeHighConfidenceKvSecret(keyName, val)) return full;
        const isPassword = /(?:pass(?:word|wd)?)$/i.test(keyName);
        const label = isPassword ? "明文密码" : "配置密钥";
        onHit({ ruleId: isPassword ? "kv_password" : "kv_secret", label });
        return `${prefix}${quote}[已隐藏:${label}]${endQuote}`;
      };

      const keyPart =
        `["']?\\b(?:[A-Za-z0-9_-]{0,24}[_-])?(?:api[_-]?key|secret[_-]?key|secret[_-]?access[_-]?key|token|client[_-]?secret|app[_-]?secret|signing[_-]?secret|webhook[_-]?secret|private[_-]?key|db[_-]?pass(?:word)?|password|passwd)\\b["']?\\s*[:=]\\s*`;
      const doubleQuotedRe = new RegExp(`(${keyPart})(")([^"\\r\\n]{8,})(")`, "gi");
      const singleQuotedRe = new RegExp(`(${keyPart})(')([^'\\r\\n]{8,})(')`, "gi");
      const unquotedRe = new RegExp(
        `(${keyPart})()([^\\s"',;}{\`<>，。；：！？（）【】、“”‘’]{8,})()`,
        "gi",
      );

      let out = text.replace(doubleQuotedRe, replaceKv);
      out = out.replace(singleQuotedRe, replaceKv);
      out = out.replace(unquotedRe, replaceKv);
      return out;
    },
  },
];

/**
 * 脱敏文本中的高置信度凭证，返回脱敏后文本及命中的凭证类别。
 */
export function redactSecrets(input: string): RedactResult {
  if (!input) {
    return { text: input, redacted: false, matches: [], labels: [] };
  }
  const matches: SecretMatch[] = [];
  let text = input;
  for (const rule of SECRET_RULES) {
    text = rule.apply(text, (hit) => matches.push(hit));
  }
  if (matches.length === 0) {
    return { text: input, redacted: false, matches: [], labels: [] };
  }
  const labels = Array.from(new Set(matches.map((m) => m.label)));
  return { text, redacted: true, matches, labels };
}

/**
 * 仅检测文本中是否包含高置信度明文凭证（不改写原文，供写盘硬拦截与审计脚本使用）。
 */
export function detectSecrets(input: string): SecretMatch[] {
  return redactSecrets(input).matches;
}

const DEFAULT_SKIP_JSON_KEYS = new Set([
  "id",
  "eventId",
  "turnId",
  "sessionId",
  "groupId",
  "clientMessageId",
  "inReplyTo",
  "stickerId",
  "mediaHash",
  "attachments",
  "frameHashes",
  "sha256",
  "model",
]);

/**
 * 递归脱敏 JSON 兼容对象（如 events.metadata 中的 toolCalls / journalSteps / shares / attachmentDigest）。
 */
export function redactUnknownJson<T>(
  value: T,
  skipKeys: ReadonlySet<string> = DEFAULT_SKIP_JSON_KEYS,
): { value: T; redacted: boolean; labels: string[] } {
  const labelSet = new Set<string>();
  let redacted = false;

  const walk = (node: unknown, key?: string): unknown => {
    if (key && skipKeys.has(key)) return node;
    if (typeof node === "string") {
      const res = redactSecrets(node);
      if (res.redacted) {
        redacted = true;
        for (const l of res.labels) labelSet.add(l);
        return res.text;
      }
      return node;
    }
    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((item) => {
        const walked = walk(item);
        if (walked !== item) changed = true;
        return walked;
      });
      return changed ? next : node;
    }
    if (node && typeof node === "object") {
      let changed = false;
      const record = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) {
        const walked = walk(v, k);
        if (walked !== v) changed = true;
        out[k] = walked;
      }
      return changed ? out : node;
    }
    return node;
  };

  const nextValue = walk(value) as T;
  return { value: nextValue, redacted, labels: Array.from(labelSet) };
}

/** 生成统一的 memory/ 写盘硬拦截提示（不静默篡改，保留第一人称改写权） */
export function formatMemorySecretBlockError(matches: SecretMatch[]): string {
  const labels = Array.from(new Set(matches.map((m) => m.label))).join("、");
  return `检测到疑似明文凭证（${labels}），禁止写入 memory/。请移除明文密钥、私钥或密码，改用不含凭证原文的自然语言描述后再保存。`;
}
