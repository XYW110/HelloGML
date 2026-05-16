/**
 * Token 健康状态管理模块
 *
 * 设计目标：
 * - 按失败原因分类（auth / rate_limit / upstream / unknown）分别计数
 * - 命中阈值才禁用 token，避免单次抖动误杀
 * - 任何成功调用都重置所有失败计数
 * - auth 类失败 / 累计禁用次数过多 → 永久拉黑 + 自动调游客接口补池
 * - chat.ts 通过 reporters 回调使用，不直接接触 KV
 *
 * KV 键约定：
 * - health:${id}         每个 refresh token 的健康状态（TokenHealth）
 * - cfg:failure_policy   失败策略配置（FailurePolicyConfig）
 */

// ==================== 类型定义 ====================

export type FailureReason = "auth" | "rate_limit" | "upstream" | "unknown";

export interface TokenHealth {
  failures: {
    auth: number;
    rate_limit: number;
    upstream: number;
    unknown: number;
  };
  /** 时间戳 ms，0/undefined 表示未临时禁用 */
  disabledUntil?: number;
  /** 禁用原因（人类可读，用于日志/面板） */
  disabledReason?: string;
  /** true = 永久拉黑（不再可用） */
  blacklisted?: boolean;
  /** 累计被禁用过的总次数（达 blacklistAfterDisables 即拉黑） */
  totalDisables: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

export interface FailurePolicyConfig {
  enabled: boolean;
  thresholds: {
    auth: number;
    rate_limit: number;
    upstream: number;
    unknown: number;
  };
  /** 0 = 达阈值直接 blacklist（不走临时禁用） */
  disableMinutes: {
    auth: number;
    rate_limit: number;
    upstream: number;
    unknown: number;
  };
  /** 累计被禁用 N 次后永久拉黑 */
  blacklistAfterDisables: number;
  /** 拉黑后是否自动调游客接口补 1 个 token */
  autoRefillOnBlacklist: boolean;
}

// ==================== 常量 ====================

export const FAILURE_POLICY_KEY = "cfg:failure_policy";
export const HEALTH_KEY_PREFIX = "health:";

export const DEFAULT_FAILURE_POLICY: FailurePolicyConfig = {
  enabled: true,
  thresholds: { auth: 2, rate_limit: 3, upstream: 5, unknown: 5 },
  disableMinutes: { auth: 0, rate_limit: 10, upstream: 2, unknown: 2 },
  blacklistAfterDisables: 5,
  autoRefillOnBlacklist: true,
};
const EMPTY_HEALTH: TokenHealth = {
  failures: { auth: 0, rate_limit: 0, upstream: 0, unknown: 0 },
  totalDisables: 0,
};

// 纯成功流量下，仅在距上次成功写入超过该阈值后才再次写 KV，节约写额度。
// 失败计数清零、disabled 状态解除等"必要写"不受此节流影响。
const SUCCESS_WRITE_THROTTLE_MS = 5 * 60 * 1000;

// ==================== 失败原因分类 ====================

const AUTH_KEYWORDS = [
  "unauthorized",
  "permission",
  "invalid token",
  "token invalid",
  "token expired",
  "access denied",
  "forbidden",
  "未授权",
  "无权限",
  "token失效",
  "token 失效",
  "登录过期",
  "请重新登录",
  "认证失败",
];

const RATE_LIMIT_KEYWORDS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "quota",
  "frequent",
  "limit exceeded",
  "频繁",
  "限流",
  "配额",
  "限制",
];

/**
 * 根据 HTTP 状态码 + 错误信息体内容判定失败原因。
 * - 同时支持传入 status / body 文本 / Error 对象（含 message）
 */
export function classifyFailure(input: {
  status?: number;
  bodyText?: string;
  contentType?: string;
  error?: { name?: string; message?: string } | null;
}): FailureReason {
  const { status, bodyText, contentType, error } = input;
  const lowerBody = (bodyText || "").toLowerCase();
  const lowerMsg = (error?.message || "").toLowerCase();
  const combined = lowerBody + " " + lowerMsg;

  // 1) 显式 HTTP 状态
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500 && status < 600) {
    return "upstream";
  }

  // 2) 超时 / 网络错误 → upstream
  if (error?.name === "AbortError" || /aborted|timeout/.test(lowerMsg)) {
    return "upstream";
  }

  // 3) 非 SSE Content-Type 通常是上游异常页或网关错误
  if (contentType && !contentType.includes("text/event-stream")) {
    // 如果同时命中 auth 关键词，更倾向 auth
    if (AUTH_KEYWORDS.some((kw) => combined.includes(kw))) return "auth";
    if (RATE_LIMIT_KEYWORDS.some((kw) => combined.includes(kw))) {
      return "rate_limit";
    }
    return "upstream";
  }

  // 4) 内容关键词兜底
  if (AUTH_KEYWORDS.some((kw) => combined.includes(kw))) return "auth";
  if (RATE_LIMIT_KEYWORDS.some((kw) => combined.includes(kw))) {
    return "rate_limit";
  }

  return "unknown";
}

// ==================== 配置读写 ====================

export async function getFailurePolicy(
  kv: KVNamespace
): Promise<FailurePolicyConfig> {
  const stored = (await kv.get(
    FAILURE_POLICY_KEY,
    "json"
  )) as Partial<FailurePolicyConfig> | null;
  if (!stored) return { ...DEFAULT_FAILURE_POLICY };
  return mergePolicy(stored);
}

export async function setFailurePolicy(
  kv: KVNamespace,
  config: FailurePolicyConfig
): Promise<void> {
  await kv.put(FAILURE_POLICY_KEY, JSON.stringify(config));
}

function mergePolicy(
  partial: Partial<FailurePolicyConfig>
): FailurePolicyConfig {
  const base = DEFAULT_FAILURE_POLICY;
  return {
    enabled:
      typeof partial.enabled === "boolean" ? partial.enabled : base.enabled,
    thresholds: { ...base.thresholds, ...(partial.thresholds || {}) },
    disableMinutes: {
      ...base.disableMinutes,
      ...(partial.disableMinutes || {}),
    },
    blacklistAfterDisables:
      typeof partial.blacklistAfterDisables === "number"
        ? partial.blacklistAfterDisables
        : base.blacklistAfterDisables,
    autoRefillOnBlacklist:
      typeof partial.autoRefillOnBlacklist === "boolean"
        ? partial.autoRefillOnBlacklist
        : base.autoRefillOnBlacklist,
  };
}

// ==================== 健康状态读写 ====================

export async function getTokenHealth(
  kv: KVNamespace,
  id: string
): Promise<TokenHealth> {
  const stored = (await kv.get(
    `${HEALTH_KEY_PREFIX}${id}`,
    "json"
  )) as TokenHealth | null;
  if (!stored) return cloneEmpty();
  return normalizeHealth(stored);
}

export async function setTokenHealth(
  kv: KVNamespace,
  id: string,
  health: TokenHealth
): Promise<void> {
  await kv.put(`${HEALTH_KEY_PREFIX}${id}`, JSON.stringify(health));
}

export async function deleteTokenHealth(
  kv: KVNamespace,
  id: string
): Promise<void> {
  await kv.delete(`${HEALTH_KEY_PREFIX}${id}`);
}

export async function listTokenHealth(
  kv: KVNamespace
): Promise<Array<{ id: string; health: TokenHealth }>> {
  const results: Array<{ id: string; health: TokenHealth }> = [];
  let cursor: string | undefined;
  while (true) {
    const page = await kv.list({ prefix: HEALTH_KEY_PREFIX, cursor });
    for (const key of page.keys) {
      const id = key.name.replace(HEALTH_KEY_PREFIX, "");
      const raw = (await kv.get(key.name, "json")) as TokenHealth | null;
      results.push({ id, health: raw ? normalizeHealth(raw) : cloneEmpty() });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return results;
}

function cloneEmpty(): TokenHealth {
  return {
    failures: { ...EMPTY_HEALTH.failures },
    totalDisables: 0,
  };
}

function normalizeHealth(h: Partial<TokenHealth>): TokenHealth {
  return {
    failures: {
      auth: h.failures?.auth ?? 0,
      rate_limit: h.failures?.rate_limit ?? 0,
      upstream: h.failures?.upstream ?? 0,
      unknown: h.failures?.unknown ?? 0,
    },
    disabledUntil: h.disabledUntil,
    disabledReason: h.disabledReason,
    blacklisted: !!h.blacklisted,
    totalDisables: h.totalDisables ?? 0,
    lastFailureAt: h.lastFailureAt,
    lastSuccessAt: h.lastSuccessAt,
  };
}

// ==================== 健康判定（用于选 token 时过滤）====================

export function isTokenUsable(health: TokenHealth, now = Date.now()): boolean {
  if (health.blacklisted) return false;
  if (health.disabledUntil && health.disabledUntil > now) return false;
  return true;
}

/**
 * 给定 token 池 + 各 token 的健康记录，返回当前可用的 token 字符串数组。
 * 不传 healthMap 时返回原 pool。
 */
export function filterUsableTokens<T extends { id: string; token: string }>(
  pool: T[],
  healthMap: Map<string, TokenHealth> | undefined,
  now = Date.now()
): T[] {
  if (!healthMap || healthMap.size === 0) return pool;
  return pool.filter((item) => {
    const h = healthMap.get(item.id);
    if (!h) return true;
    return isTokenUsable(h, now);
  });
}

// ==================== 失败/成功上报 ====================

export interface ReportContext {
  kv: KVNamespace;
  /** 通过 refreshToken 反查 id —— 由调用方注入（chat.ts 不知道 id） */
  resolveTokenId: (token: string) => Promise<string | null>;
  /** 拉黑回调（删 rt:${id} + 触发自动补池），由 index.ts 注入 */
  onBlacklist?: (id: string, reason: string) => Promise<void> | void;
  policy?: FailurePolicyConfig;
}

/**
 * 上报一次失败。命中阈值 → 临时禁用或永久拉黑。
 */
export async function reportFailure(
  ctx: ReportContext,
  token: string,
  reason: FailureReason
): Promise<void> {
  const policy = ctx.policy || (await getFailurePolicy(ctx.kv));
  if (!policy.enabled) return;

  const id = await ctx.resolveTokenId(token);
  if (!id) return; // 未在池中，无需追踪

  const health = await getTokenHealth(ctx.kv, id);
  health.failures[reason] = (health.failures[reason] || 0) + 1;
  health.lastFailureAt = Date.now();

  const threshold = policy.thresholds[reason];
  if (threshold > 0 && health.failures[reason] >= threshold) {
    const minutes = policy.disableMinutes[reason];

    if (minutes <= 0) {
      // 直接拉黑
      health.blacklisted = true;
      health.disabledReason = `${reason} 累计 ${health.failures[reason]} 次 → 永久拉黑`;
      health.totalDisables = (health.totalDisables || 0) + 1;
      await setTokenHealth(ctx.kv, id, health);
      console.warn(
        `[token-health] blacklist token id=${id} reason=${reason} failures=${health.failures[reason]}`
      );
      if (ctx.onBlacklist) {
        try {
          await ctx.onBlacklist(id, health.disabledReason);
        } catch (e: any) {
          console.error(`[token-health] onBlacklist error: ${e?.message}`);
        }
      }
      return;
    }

    // 临时禁用
    health.disabledUntil = Date.now() + minutes * 60 * 1000;
    health.disabledReason = `${reason} 累计 ${health.failures[reason]} 次 → 禁用 ${minutes} 分钟`;
    health.totalDisables = (health.totalDisables || 0) + 1;
    // 重置该类计数器（避免还在禁用期内不停累加）
    health.failures[reason] = 0;
    console.warn(
      `[token-health] temp-disable token id=${id} reason=${reason} for ${minutes}min (totalDisables=${health.totalDisables})`
    );

    // 累计禁用过多 → 升级为拉黑
    if (
      policy.blacklistAfterDisables > 0 &&
      health.totalDisables >= policy.blacklistAfterDisables
    ) {
      health.blacklisted = true;
      health.disabledReason = `累计被禁用 ${health.totalDisables} 次 → 永久拉黑`;
      await setTokenHealth(ctx.kv, id, health);
      console.warn(
        `[token-health] blacklist token id=${id} reason=overuse totalDisables=${health.totalDisables}`
      );
      if (ctx.onBlacklist) {
        try {
          await ctx.onBlacklist(id, health.disabledReason);
        } catch (e: any) {
          console.error(`[token-health] onBlacklist error: ${e?.message}`);
        }
      }
      return;
    }
  }

  await setTokenHealth(ctx.kv, id, health);
}

/**
 * 上报一次成功 —— 重置所有失败计数（不清除 totalDisables/blacklisted，避免坏 token 翻身）。
 */
export async function reportSuccess(
  ctx: ReportContext,
  token: string
): Promise<void> {
  const id = await ctx.resolveTokenId(token);
  if (!id) return;
  const health = await getTokenHealth(ctx.kv, id);
  const hasFailures =
    health.failures.auth > 0 ||
    health.failures.rate_limit > 0 ||
    health.failures.upstream > 0 ||
    health.failures.unknown > 0;
  const hasDisable = !health.blacklisted && !!health.disabledUntil;
  const now = Date.now();

  // 节流路径：无失败、无待解除的临时禁用，且距上次成功不到阈值 → 跳过写入
  if (!hasFailures && !hasDisable) {
    const lastSuccess = health.lastSuccessAt ?? 0;
    if (now - lastSuccess < SUCCESS_WRITE_THROTTLE_MS) {
      return;
    }
  }

  health.failures = { auth: 0, rate_limit: 0, upstream: 0, unknown: 0 };
  health.lastSuccessAt = now;
  // 自动解除临时禁用（仅当未拉黑）
  if (hasDisable) {
    health.disabledUntil = undefined;
    health.disabledReason = undefined;
  }
  await setTokenHealth(ctx.kv, id, health);
  if (hasFailures) {
    console.log(`[token-health] reset failures id=${id}`);
  }
}

/**
 * 手动解禁（admin UI 调用）—— 清除 disabledUntil + blacklisted + failures，保留 totalDisables 作为审计记录。
 */
export async function unblockToken(
  kv: KVNamespace,
  id: string
): Promise<TokenHealth> {
  const health = await getTokenHealth(kv, id);
  health.blacklisted = false;
  health.disabledUntil = undefined;
  health.disabledReason = undefined;
  health.failures = { auth: 0, rate_limit: 0, upstream: 0, unknown: 0 };
  await setTokenHealth(kv, id, health);
  console.log(`[token-health] manually unblocked id=${id}`);
  return health;
}

// ==================== 工具：脱敏 ====================

export function maskTokenForDisplay(token: string): string {
  if (!token) return "<empty>";
  if (token.length <= 12) return `${token.slice(0, 2)}***`;
  return `${token.slice(0, 6)}***${token.slice(-4)}`;
}
