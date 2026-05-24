import { setSignSecret } from "./chat.ts";
import {
  createCompletion,
  createCompletionStream,
  generateImages,
  generateVideos,
  getTokenLiveStatus,
  ChatReporters,
} from "./chat.ts";
import { createClaudeCompletion, createGeminiCompletion } from "./adapters.ts";
import {
  classifyFailure,
  reportFailure,
  reportSuccess,
  filterUsableTokens,
  listTokenHealth,
  getTokenHealth,
  setTokenHealth,
  deleteTokenHealth,
  unblockToken,
  getFailurePolicy,
  setFailurePolicy,
  maskTokenForDisplay,
  HEALTH_KEY_PREFIX,
  TokenHealth,
  FailurePolicyConfig,
  TokenReportBuffer,
} from "./token-health.ts";
import {
  defaultTo,
  isString,
  unixTimestamp,
  md5,
  sleep,
  uuid,
} from "./utils.ts";
import { WELCOME_HTML } from "./welcome.ts";
import {
  getAdminPanelHTML,
  getTokenPanelHTML,
  getChatPanelHTML,
} from "./admin-panel.ts";

export interface Env {
  SIGN_SECRET?: string;
  ADMIN_KEY?: string;
  AUTO_FILL_ENABLED?: string;
  AUTO_FILL_TARGET?: string;
  AUTO_FILL_CRON?: string;
  GLM_TOKENS: KVNamespace;
}

// ==================== Memory Cache (Workers instance scoped) ====================
// 用于减少 Cloudflare KV 读取次数。同一 Worker 实例的多个请求共享缓存。
// 注意：Workers 多实例之间内存不共享，仅在单实例内生效；admin 写操作必须 invalidate。

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function cacheInvalidate(key: string): void {
  memoryCache.delete(key);
}

// TTL 常量
const CACHE_TTL_POOL_MS = 30 * 1000;
const CACHE_TTL_HEALTH_MS = 30 * 1000;
const CACHE_TTL_POLICY_MS = 60 * 1000;
const CACHE_TTL_AUTOFILL_CFG_MS = 60 * 1000;

// 缓存键
const CK_TOKEN_POOL = "tp:pool";
const CK_HEALTH_LIST = "tp:health_list";
const CK_FAILURE_POLICY = "tp:failure_policy";
const CK_AUTOFILL_CONFIG = "tp:autofill_config";

interface TokenPoolItem {
  id: string;
  token: string;
}

interface AutoFillConfig {
  enabled: boolean;
  targetCount: number;
}

interface AutoFillRunResult {
  success: boolean;
  source: "cron" | "manual";
  reason: "disabled" | "target_zero" | "sufficient" | "completed" | "error";
  message: string;
  targetCount: number;
  beforeCount: number;
  afterCount: number;
  beforePoolCount: number;
  beforeLiveCount: number;
  afterPoolCount: number;
  afterLiveCount: number;
  addedCount: number;
  addedIds: string[];
  removedCount: number;
  removedIds: string[];
  runAt: string;
  cron?: string;
}

const DEFAULT_SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";
const AUTO_FILL_CONFIG_KEY = "cfg:auto_fill";
const AUTO_FILL_STATUS_KEY = "cfg:auto_fill_status";
const AUTO_FILL_MAX_BATCH = 100;

const SUPPORTED_MODELS = [
  {
    id: "glm5",
    name: "GLM-5",
    object: "model",
    owned_by: "glm-free-api",
    description: "GLM-5 通用对话模型",
  },
];

const GEMINI_MODELS = [
  {
    name: "models/gemini-1.5-pro",
    displayName: "Gemini 1.5 Pro",
    description: "Most capable model for complex reasoning tasks",
    inputTokenLimit: 2097152,
    outputTokenLimit: 8192,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  },
  {
    name: "models/gemini-1.5-flash",
    displayName: "Gemini 1.5 Flash",
    description: "Fast model for high throughput",
    inputTokenLimit: 1048576,
    outputTokenLimit: 8192,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  },
  {
    name: "models/gemini-pro",
    displayName: "Gemini Pro",
    description: "Previous generation model",
    inputTokenLimit: 32768,
    outputTokenLimit: 2048,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  },
  {
    name: "models/glm-5",
    displayName: "GLM-5",
    description: "GLM-5 chat model via adapter",
    inputTokenLimit: 32768,
    outputTokenLimit: 8192,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  },
];

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function extractAPIKeys(request: Request): string[] {
  let auth =
    request.headers.get("authorization") ||
    request.headers.get("x-api-key") ||
    "";
  if (!auth) return [];
  if (!auth.toLowerCase().startsWith("bearer ")) auth = "Bearer " + auth;
  return auth
    .slice(7)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNonNegativeInt(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

async function listAllKeys(
  kv: KVNamespace,
  prefix: string
): Promise<Array<{ name: string }>> {
  const keys: Array<{ name: string }> = [];
  let cursor: string | undefined;
  while (true) {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys.map((key) => ({ name: key.name })));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return keys;
}

async function verifyAPIKey(kv: KVNamespace, apiKey: string): Promise<boolean> {
  const val = await kv.get(`ak:${apiKey}`);
  if (val !== null) return true;
  const rtVal = await kv.get(`rt:${apiKey}`);
  return rtVal !== null;
}

async function getTokenPool(kv: KVNamespace): Promise<TokenPoolItem[]> {
  const keys = await listAllKeys(kv, "rt:");
  const rawTokens = await Promise.all(keys.map((key) => kv.get(key.name)));
  return keys.flatMap((key, index) => {
    const token = rawTokens[index];
    if (!token) return [];
    return [{ id: key.name.replace("rt:", ""), token }];
  });
}

async function getTokenPoolCount(kv: KVNamespace): Promise<number> {
  const keys = await listAllKeys(kv, "rt:");
  return keys.length;
}

async function inspectTokenPool(kv: KVNamespace): Promise<{
  pool: TokenPoolItem[];
  liveTokens: TokenPoolItem[];
  invalidTokens: TokenPoolItem[];
}> {
  const pool = await getTokenPool(kv);
  const checks = await Promise.all(
    pool.map(async (item) => ({
      item,
      live: await getTokenLiveStatus(item.token),
    }))
  );
  const liveTokens = checks
    .filter((entry) => entry.live)
    .map((entry) => entry.item);
  const invalidTokens = checks
    .filter((entry) => !entry.live)
    .map((entry) => entry.item);
  return { pool, liveTokens, invalidTokens };
}

async function deleteTokensFromPool(
  kv: KVNamespace,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  await Promise.all(ids.map((id) => kv.delete(`rt:${id}`)));
}

async function getAutoFillConfig(env: Env): Promise<AutoFillConfig> {
  const stored = (await env.GLM_TOKENS.get(
    AUTO_FILL_CONFIG_KEY,
    "json"
  )) as Partial<AutoFillConfig> | null;
  return {
    enabled:
      typeof stored?.enabled === "boolean"
        ? stored.enabled
        : parseBoolean(env.AUTO_FILL_ENABLED, false),
    targetCount: parseNonNegativeInt(
      stored?.targetCount,
      parseNonNegativeInt(env.AUTO_FILL_TARGET, 0)
    ),
  };
}

async function setAutoFillConfig(
  env: Env,
  config: AutoFillConfig
): Promise<void> {
  await env.GLM_TOKENS.put(AUTO_FILL_CONFIG_KEY, JSON.stringify(config));
}

async function getAutoFillStatus(env: Env): Promise<AutoFillRunResult | null> {
  return (await env.GLM_TOKENS.get(
    AUTO_FILL_STATUS_KEY,
    "json"
  )) as AutoFillRunResult | null;
}

async function setAutoFillStatus(
  env: Env,
  status: AutoFillRunResult
): Promise<void> {
  await env.GLM_TOKENS.put(AUTO_FILL_STATUS_KEY, JSON.stringify(status));
}

// ==================== Cached KV Readers ====================
// 高频读路径使用缓存版本；admin 写操作必须主动 invalidate 对应缓存键。

async function getTokenPoolCached(kv: KVNamespace): Promise<TokenPoolItem[]> {
  const cached = cacheGet<TokenPoolItem[]>(CK_TOKEN_POOL);
  if (cached) return cached;
  const fresh = await getTokenPool(kv);
  cacheSet(CK_TOKEN_POOL, fresh, CACHE_TTL_POOL_MS);
  return fresh;
}

async function listTokenHealthCached(
  kv: KVNamespace
): Promise<Array<{ id: string; health: TokenHealth }>> {
  const cached =
    cacheGet<Array<{ id: string; health: TokenHealth }>>(CK_HEALTH_LIST);
  if (cached) return cached;
  const fresh = await listTokenHealth(kv);
  cacheSet(CK_HEALTH_LIST, fresh, CACHE_TTL_HEALTH_MS);
  return fresh;
}

async function getFailurePolicyCached(
  kv: KVNamespace
): Promise<FailurePolicyConfig> {
  const cached = cacheGet<FailurePolicyConfig>(CK_FAILURE_POLICY);
  if (cached) return cached;
  const fresh = await getFailurePolicy(kv);
  cacheSet(CK_FAILURE_POLICY, fresh, CACHE_TTL_POLICY_MS);
  return fresh;
}

async function getAutoFillConfigCached(env: Env): Promise<AutoFillConfig> {
  const cached = cacheGet<AutoFillConfig>(CK_AUTOFILL_CONFIG);
  if (cached) return cached;
  const fresh = await getAutoFillConfig(env);
  cacheSet(CK_AUTOFILL_CONFIG, fresh, CACHE_TTL_AUTOFILL_CFG_MS);
  return fresh;
}

function buildAutoFillResponse(
  config: AutoFillConfig,
  status: AutoFillRunResult | null,
  poolCount: number,
  liveCount: number,
  env: Env
) {
  return {
    config: {
      enabled: config.enabled,
      target_count: config.targetCount,
    },
    status: status
      ? {
          success: status.success,
          source: status.source,
          reason: status.reason,
          message: status.message,
          target_count: status.targetCount,
          before_count: status.beforeCount,
          after_count: status.afterCount,
          before_pool_count: status.beforePoolCount,
          before_live_count: status.beforeLiveCount,
          after_pool_count: status.afterPoolCount,
          after_live_count: status.afterLiveCount,
          added_count: status.addedCount,
          added_ids: status.addedIds,
          removed_count: status.removedCount,
          removed_ids: status.removedIds,
          run_at: status.runAt,
          cron: status.cron || "",
        }
      : null,
    pool_count: poolCount,
    live_count: liveCount,
    schedule: {
      cron: env.AUTO_FILL_CRON || "0 * * * *",
      timezone: "UTC",
    },
  };
}

let tokenRoundRobinIndex = 0;

function selectTokenFromPool(tokens: TokenPoolItem[]): string | null {
  if (tokens.length === 0) return null;
  const idx = tokenRoundRobinIndex % tokens.length;
  tokenRoundRobinIndex++;
  return tokens[idx].token;
}

/**
 * 根据 refreshToken 字符串反查 KV 中的 token id（rt:${id} → id）
 * 用于失败上报：把 chat 层只持有的 refreshToken 映射回 health Key 所需 id。
 *
 * 优化：使用内存缓存避免重复 KV 读取，缓存有效期跟随 TOKEN_POOL 缓存。
 */
const CK_TOKEN_ID_MAP = "tp:token_id_map";
const CACHE_TTL_TOKEN_ID_MAP_MS = 5 * 60 * 1000; // 5分钟

async function resolveTokenIdByRefreshToken(
  kv: KVNamespace,
  refreshToken: string
): Promise<string | null> {
  // 先尝试从内存缓存获取映射
  let idMap = cacheGet<Map<string, string>>(CK_TOKEN_ID_MAP);

  if (!idMap) {
    // 缓存未命中，重新构建映射
    const pool = await getTokenPool(kv);
    idMap = new Map(pool.map((item) => [item.token, item.id]));
    cacheSet(CK_TOKEN_ID_MAP, idMap, CACHE_TTL_TOKEN_ID_MAP_MS);
  }

  return idMap.get(refreshToken) ?? null;
}

/**
 * 构造 ChatReporters：
 *  - onSuccess: 命中可用 SSE / 非流响应 → 清零失败计数
 *  - onFailure: retry 用尽或不可重试错误 → 按 reason 累计；达阈值 disable，达拉黑阈值 blacklist
 *
 * onBlacklist 回调中：删除 rt:${id} + 触发一次 runAutoFill 自动补池（autoRefillOnBlacklist=true 时）。
 *
 * 优化：使用 TokenReportBuffer 内存聚合上报，减少 KV 写入次数。
 */
function buildReporters(env: Env): ChatReporters {
  const kv = env.GLM_TOKENS;
  const ctx = {
    kv,
    resolveTokenId: (rt: string) => resolveTokenIdByRefreshToken(kv, rt),
    onBlacklist: async (id: string, _refreshToken: string) => {
      try {
        // 从池中物理删除被拉黑的 token
        await kv.delete(`rt:${id}`);
        cacheInvalidate(CK_TOKEN_POOL);
        cacheInvalidate(CK_HEALTH_LIST);
        cacheInvalidate(CK_TOKEN_ID_MAP); // 同时清除 ID 映射缓存
      } catch (e: any) {
        console.error(
          `[reporter onBlacklist] delete rt:${id} failed: ${e?.message}`
        );
      }
      // 根据 policy 决定是否自动补池
      try {
        const policy = await getFailurePolicy(kv);
        if (policy.autoRefillOnBlacklist) {
          await runAutoFill(env, {
            source: "manual",
            respectEnabled: true,
          });
        }
      } catch (e: any) {
        console.error(
          `[reporter onBlacklist] autoRefill failed: ${e?.message}`
        );
      }
    },
  };

  // 使用内存聚合缓冲区，减少 KV 写入次数
  const reportBuffer = new TokenReportBuffer(ctx);

  return {
    onSuccess: async (token: string) => {
      try {
        // 使用缓冲区聚合成功事件，延迟写入 KV
        reportBuffer.bufferSuccess(token);
      } catch (e: any) {
        console.error(`[reporter onSuccess] ${e?.message}`);
      }
    },
    onFailure: async (token, info) => {
      try {
        const reason = classifyFailure({
          status: info.status,
          bodyText: info.bodyText,
          contentType: info.contentType,
          error: info.error,
        });
        // 使用缓冲区聚合失败事件，auth 类会立即同步
        reportBuffer.bufferFailure(token, reason);
      } catch (e: any) {
        console.error(`[reporter onFailure] ${e?.message}`);
      }
    },
  };
}

/**
 * 认证 + 选 token 的统一入口。
 *
 * 返回 `{ refreshToken, tokenPool }`：
 *  - refreshToken：本次请求选中的 token（chat 层用作首选）
 *  - tokenPool：完整可用 token 字符串数组（chat 层 retry 时使用）
 *
 * 调用方应直接复用 `tokenPool`，避免再次调用 getTokenPool 引发重复 KV 读。
 *
 * 热路径中读取的 pool / health / autofill config 全部走缓存版本（Phase 1 引入），
 * 缓存命中时不触发 KV 调用；缓存失效后才回源 KV。
 */
async function authenticate(
  request: Request,
  env: Env
): Promise<{ refreshToken: string; tokenPool: string[] }> {
  const apiKeys = extractAPIKeys(request);
  if (apiKeys.length === 0) throw new Error("Missing Authorization header");

  let validKey = false;
  for (const apiKey of apiKeys) {
    if (await verifyAPIKey(env.GLM_TOKENS, apiKey)) {
      validKey = true;
      break;
    }
  }
  if (!validKey) throw new Error("Invalid API key");

  let pool = await getTokenPoolCached(env.GLM_TOKENS);

  // 冷启动自动补池：池子为空时立即补充
  if (pool.length === 0) {
    const config = await getAutoFillConfigCached(env);
    if (config.enabled && config.targetCount > 0) {
      const result = await runAutoFill(env, {
        source: "manual",
        respectEnabled: true,
      });
      if (result.success && result.afterCount > 0) {
        // runAutoFill 已 invalidate CK_TOKEN_POOL，这里读到的是新池
        pool = await getTokenPoolCached(env.GLM_TOKENS);
      }
    }
  }

  if (pool.length === 0) throw new Error("No refresh tokens available in pool");

  // 过滤掉 disabled / blacklisted 的 token
  let usablePool: TokenPoolItem[] = pool;
  try {
    const healthList = await listTokenHealthCached(env.GLM_TOKENS);
    const healthMap = new Map<string, TokenHealth>();
    for (const entry of healthList) healthMap.set(entry.id, entry.health);
    const filtered = filterUsableTokens(pool, healthMap);
    if (filtered.length > 0) {
      usablePool = filtered;
    } else {
      // 全部被 disable 时，降级使用原池以避免完全无法服务（chat 层 retry 仍可能成功）
      console.warn(
        "[authenticate] all tokens disabled/blacklisted, falling back to full pool"
      );
    }
  } catch (e: any) {
    console.error(`[authenticate] health filter failed: ${e?.message}`);
  }

  const refreshToken = selectTokenFromPool(usablePool);
  if (!refreshToken) throw new Error("Failed to select token from pool");

  // 返回可用 token 字符串数组（按 usablePool 顺序，便于 chat 层 retry）
  const tokenPool = usablePool.map((t) => t.token);
  return { refreshToken, tokenPool };
}

function authorizeAdmin(request: Request, env: Env): Response | null {
  const adminKey = request.headers.get("X-Admin-Key") || "";
  if (env.ADMIN_KEY && adminKey !== env.ADMIN_KEY) {
    return errorResponse("Unauthorized: invalid admin key", 401);
  }
  return null;
}

async function generateChatGLMSign(
  secret: string
): Promise<{ timestamp: string; nonce: string; sign: string }> {
  const now = Date.now().toString();
  const length = now.length;
  const digits = now.split("").map((char) => Number(char));
  const checksum =
    (digits.reduce((sum, value) => sum + value, 0) - digits[length - 2]) % 10;
  const timestamp =
    now.substring(0, length - 2) + checksum + now.substring(length - 1, length);
  const nonce = uuid(false);
  const sign = await md5(`${timestamp}-${nonce}-${secret}`);
  return { timestamp, nonce, sign };
}

async function requestGuestRefreshToken(
  env: Env
): Promise<{ refreshToken: string; accessToken: string; userId: string }> {
  const signSecret = env.SIGN_SECRET || DEFAULT_SIGN_SECRET;
  const sign = await generateChatGLMSign(signSecret);
  const response = await fetch(
    "https://chatglm.cn/chatglm/user-api/guest/access",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "App-Name": "chatglm",
        "X-Device-Id": uuid(false),
        "X-Request-Id": uuid(false),
        "X-App-Platform": "pc",
        "X-App-Version": "0.0.1",
        "X-App-fr": "browser",
        "X-Lang": "zh-CN",
        "X-Exp-Groups": "",
        "X-Device-Model": "",
        "X-Device-Brand": "",
        "X-Timestamp": sign.timestamp,
        "X-Nonce": sign.nonce,
        "X-Sign": sign.sign,
      },
      body: "{}",
    }
  );

  const rawText = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `[自动补池失败] guest/access 返回了非 JSON 内容: ${rawText.slice(0, 200)}`
    );
  }

  const success =
    data?.status === 0 || data?.code === 0 || data?.message === "success";
  if (!response.ok || !success) {
    throw new Error(
      `[自动补池失败] 获取游客 token 失败: ${
        data?.message || response.statusText
      }`
    );
  }

  const result = data?.result;
  if (!result?.refresh_token || !result?.access_token || !result?.user_id) {
    throw new Error("[自动补池失败] guest/access 未返回完整 token 信息");
  }

  return {
    refreshToken: result.refresh_token,
    accessToken: result.access_token,
    userId: result.user_id,
  };
}

async function runAutoFill(
  env: Env,
  options: { source: "cron" | "manual"; cron?: string; respectEnabled: boolean }
): Promise<AutoFillRunResult> {
  const config = await getAutoFillConfig(env);
  const runAt = new Date().toISOString();
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const beforeInspection = await inspectTokenPool(env.GLM_TOKENS);
  const beforePoolCount = beforeInspection.pool.length;
  const beforeLiveCount = beforeInspection.liveTokens.length;

  const finish = async (
    success: boolean,
    reason: AutoFillRunResult["reason"],
    message: string,
    afterPoolCount: number,
    afterLiveCount: number
  ): Promise<AutoFillRunResult> => {
    const result: AutoFillRunResult = {
      success,
      source: options.source,
      reason,
      message,
      targetCount: config.targetCount,
      beforeCount: beforeLiveCount,
      afterCount: afterLiveCount,
      beforePoolCount,
      beforeLiveCount,
      afterPoolCount,
      afterLiveCount,
      addedCount: addedIds.length,
      addedIds,
      removedCount: removedIds.length,
      removedIds,
      runAt,
      cron: options.cron,
    };
    await setAutoFillStatus(env, result);
    // pool / health 可能在本次 runAutoFill 中被修改（新增 token / 删除失效 token），统一失效缓存
    cacheInvalidate(CK_TOKEN_POOL);
    cacheInvalidate(CK_HEALTH_LIST);
    return result;
  };

  if (options.respectEnabled && !config.enabled) {
    return await finish(
      true,
      "disabled",
      "自动补池已关闭",
      beforePoolCount,
      beforeLiveCount
    );
  }

  if (beforeInspection.invalidTokens.length > 0) {
    const ids = beforeInspection.invalidTokens.map((token) => token.id);
    await deleteTokensFromPool(env.GLM_TOKENS, ids);
    removedIds.push(...ids);
  }

  let currentPoolCount = beforePoolCount - removedIds.length;
  let currentLiveCount = beforeLiveCount;

  if (config.targetCount <= 0) {
    return await finish(
      true,
      "target_zero",
      "目标数量为 0，已完成失效 Token 清理并跳过补池",
      currentPoolCount,
      currentLiveCount
    );
  }

  if (currentLiveCount >= config.targetCount) {
    const message =
      removedIds.length > 0
        ? `已删除 ${removedIds.length} 个失效 Token，当前可用数量已达到目标值`
        : "当前可用 Token 数量已达到目标值";
    return await finish(
      true,
      "sufficient",
      message,
      currentPoolCount,
      currentLiveCount
    );
  }

  const missingCount = Math.min(
    config.targetCount - currentLiveCount,
    AUTO_FILL_MAX_BATCH
  );

  try {
    for (let i = 0; i < missingCount; i++) {
      const guestToken = await requestGuestRefreshToken(env);
      const id = `auto_guest_${guestToken.userId}`;
      await env.GLM_TOKENS.put(`rt:${id}`, guestToken.refreshToken);
      addedIds.push(id);
    }

    let afterInspection = await inspectTokenPool(env.GLM_TOKENS);
    const expectedLiveCount = Math.min(
      config.targetCount,
      currentLiveCount + addedIds.length
    );

    for (
      let retry = 0;
      retry < 3 && afterInspection.liveTokens.length < expectedLiveCount;
      retry++
    ) {
      await sleep(2000);
      afterInspection = await inspectTokenPool(env.GLM_TOKENS);
    }

    const lateInvalidIds = afterInspection.invalidTokens
      .map((token) => token.id)
      .filter((id) => !removedIds.includes(id) && !addedIds.includes(id));

    if (lateInvalidIds.length > 0) {
      await deleteTokensFromPool(env.GLM_TOKENS, lateInvalidIds);
      removedIds.push(...lateInvalidIds);
      afterInspection = await inspectTokenPool(env.GLM_TOKENS);
    }

    currentPoolCount = afterInspection.pool.length;
    currentLiveCount = afterInspection.liveTokens.length;
    return await finish(
      true,
      "completed",
      `自动补充完成，已删除 ${removedIds.length} 个失效 Token，本次新增 ${addedIds.length} 个 Token，可用数量 ${currentLiveCount}`,
      currentPoolCount,
      currentLiveCount
    );
  } catch (err: any) {
    const afterInspection = await inspectTokenPool(env.GLM_TOKENS);
    currentPoolCount = afterInspection.pool.length;
    currentLiveCount = afterInspection.liveTokens.length;
    const result = await finish(
      false,
      "error",
      err?.message || "自动补池失败",
      currentPoolCount,
      currentLiveCount
    );
    throw new Error(result.message);
  }
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ code: -1, message, data: null }, status);
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// ==================== Handlers ====================

async function handleChatCompletions(
  request: Request,
  env: Env
): Promise<Response> {
  const { refreshToken, tokenPool: tokenPoolItems } = await authenticate(
    request,
    env
  );
  const body = (await request.json()) as any;

  if (!Array.isArray(body.messages))
    throw new Error("messages must be an array");

  const {
    model,
    conversation_id: convId,
    messages,
    stream,
    tools,
    tool_choice,
  } = body;
  // 复用 authenticate 已读出的 token 池（避免重复 KV 读）
  const tokenPool = tokenPoolItems;
  const reporters = buildReporters(env);
  if (stream) {
    const glmStream = await createCompletionStream(
      messages,
      refreshToken,
      model,
      convId,
      0,
      tools,
      tokenPool,
      undefined,
      reporters
    );
    return sseResponse(glmStream);
  } else {
    const result = await createCompletion(
      messages,
      refreshToken,
      model,
      convId,
      0,
      tools,
      tokenPool,
      undefined,
      reporters
    );
    return jsonResponse(result);
  }
}

async function handleClaudeMessages(
  request: Request,
  env: Env
): Promise<Response> {
  const { refreshToken, tokenPool: tokenPoolItems } = await authenticate(
    request,
    env
  );
  const body = (await request.json()) as any;

  if (!Array.isArray(body.messages))
    throw new Error("messages must be an array");

  const {
    model,
    messages,
    system,
    stream,
    conversation_id: convId,
    tools,
  } = body;
  // 复用 authenticate 已读出的 token 池（避免重复 KV 读）
  const tokenPool = tokenPoolItems;
  const reporters = buildReporters(env);
  const result = await createClaudeCompletion(
    model,
    messages,
    system,
    refreshToken,
    stream,
    convId,
    tools,
    tokenPool,
    reporters
  );
  if (stream && result instanceof ReadableStream) {
    return sseResponse(result);
  }
  return jsonResponse(result);
}

async function handleGeminiModels(): Promise<Response> {
  return jsonResponse({ models: GEMINI_MODELS });
}

async function handleGeminiGenerateContent(
  request: Request,
  path: string,
  env: Env
): Promise<Response> {
  const { refreshToken, tokenPool: tokenPoolItems } = await authenticate(
    request,
    env
  );
  const body = (await request.json()) as any;

  const modelMatch = path.match(/^\/v1beta\/models\/(.+):generateContent$/);
  const model = modelMatch ? modelMatch[1] : "gemini-pro";
  const { contents, systemInstruction, conversation_id: convId } = body;
  // 复用 authenticate 已读出的 token 池（避免重复 KV 读）
  const tokenPool = tokenPoolItems;
  const reporters = buildReporters(env);
  const result = await createGeminiCompletion(
    model,
    contents,
    systemInstruction,
    refreshToken,
    false,
    convId,
    tokenPool,
    reporters
  );
  return jsonResponse(result);
}

async function handleGeminiStreamGenerateContent(
  request: Request,
  path: string,
  env: Env
): Promise<Response> {
  const { refreshToken, tokenPool: tokenPoolItems } = await authenticate(
    request,
    env
  );
  const body = (await request.json()) as any;

  const modelMatch = path.match(
    /^\/v1beta\/models\/(.+):streamGenerateContent$/
  );
  const model = modelMatch ? modelMatch[1] : "gemini-pro";
  const { contents, systemInstruction, conversation_id: convId } = body;
  // 复用 authenticate 已读出的 token 池（避免重复 KV 读）
  const tokenPool = tokenPoolItems;
  const reporters = buildReporters(env);
  const result = await createGeminiCompletion(
    model,
    contents,
    systemInstruction,
    refreshToken,
    true,
    convId,
    tokenPool,
    reporters
  );
  if (result instanceof ReadableStream) {
    return sseResponse(result);
  }
  return jsonResponse(result);
}

async function handleImageGenerations(
  request: Request,
  env: Env
): Promise<Response> {
  const { refreshToken } = await authenticate(request, env);
  const body = (await request.json()) as any;

  if (!isString(body.prompt)) throw new Error("prompt must be a string");
  const prompt = body.prompt;
  const responseFormat = defaultTo(body.response_format, "url");
  const assistantId = /^[a-z0-9]{24,}$/.test(body.model)
    ? body.model
    : undefined;
  const imageUrls = await generateImages(assistantId, prompt, refreshToken);

  let data: any[];
  if (responseFormat == "b64_json") {
    data = (
      await Promise.all(imageUrls.map((url: string) => fetchBase64(url)))
    ).map((b64) => ({ b64_json: b64 }));
  } else {
    data = imageUrls.map((url: string) => ({ url }));
  }
  return jsonResponse({ created: unixTimestamp(), data });
}

async function fetchBase64(url: string): Promise<string> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function handleVideoGenerations(
  request: Request,
  env: Env
): Promise<Response> {
  const { refreshToken } = await authenticate(request, env);
  const body = (await request.json()) as any;

  if (!isString(body.prompt)) throw new Error("prompt must be a string");
  const {
    model,
    conversation_id: convId,
    prompt,
    image_url: imageUrl,
    video_style: videoStyle = "",
    emotional_atmosphere: emotionalAtmosphere = "",
    mirror_mode: mirrorMode = "",
    audio_id: audioId,
  } = body;

  const validStyles = ["卡通3D", "黑白老照片", "油画", "电影感"];
  const validEmotions = ["温馨和谐", "生动活泼", "紧张刺激", "凄凉寂寞"];
  const validMirrors = ["水平", "垂直", "推近", "拉远"];
  if (videoStyle && !validStyles.includes(videoStyle))
    throw new Error(`video_style must be one of ${validStyles.join("/")}`);
  if (emotionalAtmosphere && !validEmotions.includes(emotionalAtmosphere))
    throw new Error(
      `emotional_atmosphere must be one of ${validEmotions.join("/")}`
    );
  if (mirrorMode && !validMirrors.includes(mirrorMode))
    throw new Error(`mirror_mode must be one of ${validMirrors.join("/")}`);

  const data = await generateVideos(
    model,
    prompt,
    refreshToken,
    {
      imageUrl: imageUrl || "",
      videoStyle,
      emotionalAtmosphere,
      mirrorMode,
      audioId: audioId || "",
    },
    convId
  );
  return jsonResponse({ created: unixTimestamp(), data });
}

async function handleModels(): Promise<Response> {
  return jsonResponse({ data: SUPPORTED_MODELS });
}

async function handleTokenCheck(request: Request, env: Env): Promise<Response> {
  const { refreshToken } = await authenticate(request, env);
  const live = await getTokenLiveStatus(refreshToken);
  return jsonResponse({ live });
}

// ==================== Admin Handlers ====================

async function handleAdminAPIKey(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    const apiKey = body.api_key;
    if (!apiKey) return errorResponse("Missing api_key", 400);
    await env.GLM_TOKENS.put(`ak:${apiKey}`, "1");
    return jsonResponse({
      success: true,
      message: "API key added successfully",
    });
  }

  if (request.method === "GET") {
    const list = await env.GLM_TOKENS.list({ prefix: "ak:" });
    const keys = list.keys.map((k) => ({
      api_key: k.name.replace("ak:", ""),
    }));
    return jsonResponse({ keys });
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as any;
    const apiKey = body.api_key;
    if (!apiKey) return errorResponse("Missing api_key", 400);
    await env.GLM_TOKENS.delete(`ak:${apiKey}`);
    return jsonResponse({
      success: true,
      message: "API key deleted successfully",
    });
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminToken(request: Request, env: Env): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    const refreshToken = body.refresh_token;
    if (!refreshToken) return errorResponse("Missing refresh_token", 400);
    const id =
      body.id || `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await env.GLM_TOKENS.put(`rt:${id}`, refreshToken);
    cacheInvalidate(CK_TOKEN_POOL);
    cacheInvalidate(CK_HEALTH_LIST);
    return jsonResponse({ success: true, message: "Token added to pool", id });
  }

  if (request.method === "GET") {
    const pool = await getTokenPool(env.GLM_TOKENS);
    return jsonResponse({
      tokens: pool.map((t) => ({
        id: t.id,
        token_preview: t.token.slice(0, 8) + "****" + t.token.slice(-4),
      })),
    });
  }

  if (request.method === "DELETE") {
    const body = (await request.json()) as any;
    const id = body.id;
    if (!id) return errorResponse("Missing id", 400);
    await env.GLM_TOKENS.delete(`rt:${id}`);
    // 联动清理对应的健康记录，避免变成孤立 health
    try {
      await deleteTokenHealth(env.GLM_TOKENS, id);
    } catch (_e) {
      // 健康记录可能不存在，忽略
    }
    cacheInvalidate(CK_TOKEN_POOL);
    cacheInvalidate(CK_HEALTH_LIST);
    return jsonResponse({ success: true, message: "Token removed from pool" });
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminTokenCheck(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  const body = (await request.json()) as any;
  const id = body.id;
  if (!id) return errorResponse("Missing id", 400);

  const refreshToken = await env.GLM_TOKENS.get(`rt:${id}`);
  if (!refreshToken) return errorResponse("Token not found", 404);

  const live = await getTokenLiveStatus(refreshToken);
  return jsonResponse({ id, live });
}

async function handleAdminAutoFill(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const config = await getAutoFillConfig(env);
    const status = await getAutoFillStatus(env);
    const inspection = await inspectTokenPool(env.GLM_TOKENS);
    return jsonResponse(
      buildAutoFillResponse(
        config,
        status,
        inspection.pool.length,
        inspection.liveTokens.length,
        env
      )
    );
  }

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    if (typeof body.enabled !== "boolean")
      return errorResponse("enabled must be a boolean", 400);
    const targetCount = parseNonNegativeInt(body.target_count, -1);
    if (targetCount < 0 || targetCount > 1000) {
      return errorResponse(
        "target_count must be an integer between 0 and 1000",
        400
      );
    }

    const config: AutoFillConfig = {
      enabled: body.enabled,
      targetCount,
    };
    await setAutoFillConfig(env, config);
    cacheInvalidate(CK_AUTOFILL_CONFIG);

    const status = await getAutoFillStatus(env);
    const inspection = await inspectTokenPool(env.GLM_TOKENS);
    return jsonResponse({
      success: true,
      message: "Auto fill config updated",
      ...buildAutoFillResponse(
        config,
        status,
        inspection.pool.length,
        inspection.liveTokens.length,
        env
      ),
    });
  }

  return errorResponse("Method not allowed", 405);
}

async function handleAdminAutoFillScan(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const result = await runAutoFill(env, {
    source: "manual",
    respectEnabled: false,
  });
  const config = await getAutoFillConfig(env);
  return jsonResponse({
    success: true,
    message: result.message,
    result: {
      success: result.success,
      reason: result.reason,
      target_count: result.targetCount,
      before_count: result.beforeCount,
      after_count: result.afterCount,
      before_pool_count: result.beforePoolCount,
      before_live_count: result.beforeLiveCount,
      after_pool_count: result.afterPoolCount,
      after_live_count: result.afterLiveCount,
      added_count: result.addedCount,
      added_ids: result.addedIds,
      removed_count: result.removedCount,
      removed_ids: result.removedIds,
      run_at: result.runAt,
    },
    ...buildAutoFillResponse(
      config,
      result,
      result.afterPoolCount,
      result.afterLiveCount,
      env
    ),
  });
}

// ==================== Admin: Token Health & Failure Policy ====================

/**
 * GET /admin/token-health
 * 返回所有 token 的健康状态（健康/disabled/blacklisted），以及当前失败策略配置
 */
async function handleAdminTokenHealth(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  // DELETE: 单独删除某条健康记录（用于清理孤立 health，或强制重置某 token 的健康状态）
  if (request.method === "DELETE") {
    const body = (await request.json()) as any;
    const id = body?.id;
    if (!id || typeof id !== "string") {
      return errorResponse("Missing id", 400);
    }
    await deleteTokenHealth(env.GLM_TOKENS, id);
    cacheInvalidate(CK_HEALTH_LIST);
    return jsonResponse({
      success: true,
      message: `Health record ${id} deleted`,
      id,
    });
  }

  if (request.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  const pool = await getTokenPool(env.GLM_TOKENS);
  const healthList = await listTokenHealth(env.GLM_TOKENS);
  const policy = await getFailurePolicy(env.GLM_TOKENS);
  const now = Date.now();

  // 把 health 列表转 Map 便于按 id 查询
  const healthMap = new Map<string, TokenHealth>();
  for (const entry of healthList) healthMap.set(entry.id, entry.health);

  // pool 中所有 token 的健康状态（含从未失败过的 token —— health 字段返回 null）
  const items = pool.map((t) => {
    const h = healthMap.get(t.id) || null;
    const isDisabled = !!(h?.disabledUntil && h.disabledUntil > now);
    const isBlacklisted = !!h?.blacklisted;
    const usable = !isDisabled && !isBlacklisted;
    return {
      id: t.id,
      token_preview: maskTokenForDisplay(t.token),
      usable,
      health: h
        ? {
            failures: h.failures,
            disabled_until: h.disabledUntil || null,
            disabled_reason: h.disabledReason || null,
            blacklisted: !!h.blacklisted,
            total_disables: h.totalDisables,
            last_failure_at: h.lastFailureAt || null,
            last_success_at: h.lastSuccessAt || null,
          }
        : null,
    };
  });

  // pool 之外的"孤儿"健康记录（token 已被删除但 health 残留）
  const poolIds = new Set(pool.map((t) => t.id));
  const orphanHealth = healthList
    .filter((entry) => !poolIds.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      orphan: true,
      health: {
        failures: entry.health.failures,
        disabled_until: entry.health.disabledUntil || null,
        disabled_reason: entry.health.disabledReason || null,
        blacklisted: !!entry.health.blacklisted,
        total_disables: entry.health.totalDisables,
        last_failure_at: entry.health.lastFailureAt || null,
        last_success_at: entry.health.lastSuccessAt || null,
      },
    }));

  return jsonResponse({
    policy,
    items,
    orphan_health: orphanHealth,
    pool_count: pool.length,
    usable_count: items.filter((i) => i.usable).length,
    server_time: now,
  });
}

/**
 * POST /admin/token-health/unblock
 * Body: { id: string }
 * 手动解禁某个 token（清除失败计数 / 解除 disable / 解除 blacklist）
 */
async function handleAdminTokenHealthUnblock(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const body = (await request.json()) as any;
  const id = body?.id;
  if (!id || typeof id !== "string") {
    return errorResponse("Missing id", 400);
  }

  await unblockToken(env.GLM_TOKENS, id);
  cacheInvalidate(CK_HEALTH_LIST);
  return jsonResponse({ success: true, message: `Token ${id} unblocked`, id });
}

/**
 * GET/POST /admin/failure-policy
 * GET → 返回当前配置
 * POST → 更新配置（部分更新，未指定字段沿用旧值）
 */
async function handleAdminFailurePolicy(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = authorizeAdmin(request, env);
  if (authError) return authError;

  if (request.method === "GET") {
    const policy = await getFailurePolicy(env.GLM_TOKENS);
    return jsonResponse({ policy });
  }

  if (request.method === "POST") {
    const body = (await request.json()) as any;
    const current = await getFailurePolicy(env.GLM_TOKENS);

    const next: FailurePolicyConfig = {
      enabled:
        typeof body?.enabled === "boolean" ? body.enabled : current.enabled,
      thresholds: {
        auth: parseNonNegativeInt(
          body?.thresholds?.auth,
          current.thresholds.auth
        ),
        rate_limit: parseNonNegativeInt(
          body?.thresholds?.rate_limit,
          current.thresholds.rate_limit
        ),
        upstream: parseNonNegativeInt(
          body?.thresholds?.upstream,
          current.thresholds.upstream
        ),
        unknown: parseNonNegativeInt(
          body?.thresholds?.unknown,
          current.thresholds.unknown
        ),
      },
      disableMinutes: {
        auth: parseNonNegativeInt(
          body?.disable_minutes?.auth,
          current.disableMinutes.auth
        ),
        rate_limit: parseNonNegativeInt(
          body?.disable_minutes?.rate_limit,
          current.disableMinutes.rate_limit
        ),
        upstream: parseNonNegativeInt(
          body?.disable_minutes?.upstream,
          current.disableMinutes.upstream
        ),
        unknown: parseNonNegativeInt(
          body?.disable_minutes?.unknown,
          current.disableMinutes.unknown
        ),
      },
      blacklistAfterDisables: parseNonNegativeInt(
        body?.blacklist_after_disables,
        current.blacklistAfterDisables
      ),
      autoRefillOnBlacklist:
        typeof body?.auto_refill_on_blacklist === "boolean"
          ? body.auto_refill_on_blacklist
          : current.autoRefillOnBlacklist,
    };

    await setFailurePolicy(env.GLM_TOKENS, next);
    cacheInvalidate(CK_FAILURE_POLICY);
    return jsonResponse({
      success: true,
      message: "Failure policy updated",
      policy: next,
    });
  }

  return errorResponse("Method not allowed", 405);
}

// ==================== Main Export ====================

export default {
  async fetch(request: Request, env: Env, _ctx: any): Promise<Response> {
    if (env.SIGN_SECRET) setSignSecret(env.SIGN_SECRET);

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      let response: Response;

      if (path === "/" && request.method === "GET") {
        response = new Response(WELCOME_HTML, {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      } else if (path === "/admin" && request.method === "GET") {
        response = new Response(getAdminPanelHTML(), {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      } else if (path === "/token" && request.method === "GET") {
        response = new Response(getTokenPanelHTML(), {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      } else if (path === "/chat" && request.method === "GET") {
        response = new Response(getChatPanelHTML(), {
          headers: { "Content-Type": "text/html", ...corsHeaders() },
        });
      } else if (path === "/v1/chat/completions" && request.method === "POST") {
        response = await handleChatCompletions(request, env);
      } else if (path === "/v1/messages" && request.method === "POST") {
        response = await handleClaudeMessages(request, env);
      } else if (path === "/v1beta/models" && request.method === "GET") {
        response = await handleGeminiModels();
      } else if (
        path.match(/^\/v1beta\/models\/[^:]+:generateContent$/) &&
        request.method === "POST"
      ) {
        response = await handleGeminiGenerateContent(request, path, env);
      } else if (
        path.match(/^\/v1beta\/models\/[^:]+:streamGenerateContent$/) &&
        request.method === "POST"
      ) {
        response = await handleGeminiStreamGenerateContent(request, path, env);
      } else if (
        path === "/v1/images/generations" &&
        request.method === "POST"
      ) {
        response = await handleImageGenerations(request, env);
      } else if (
        path === "/v1/videos/generations" &&
        request.method === "POST"
      ) {
        response = await handleVideoGenerations(request, env);
      } else if (path === "/v1/models" && request.method === "GET") {
        response = await handleModels();
      } else if (path === "/ping" && request.method === "GET") {
        response = new Response("pong", { headers: corsHeaders() });
      } else if (path === "/token/check" && request.method === "POST") {
        response = await handleTokenCheck(request, env);
      } else if (path === "/admin/apikey") {
        response = await handleAdminAPIKey(request, env);
      } else if (path === "/admin/token") {
        response = await handleAdminToken(request, env);
      } else if (path === "/admin/token/check" && request.method === "POST") {
        response = await handleAdminTokenCheck(request, env);
      } else if (path === "/admin/auto-fill") {
        response = await handleAdminAutoFill(request, env);
      } else if (path === "/admin/auto-fill/run") {
        response = await handleAdminAutoFillScan(request, env);
      } else if (path === "/admin/auto-fill/scan") {
        response = await handleAdminAutoFillScan(request, env);
      } else if (path === "/admin/token-health") {
        response = await handleAdminTokenHealth(request, env);
      } else if (path === "/admin/token-health/unblock") {
        response = await handleAdminTokenHealthUnblock(request, env);
      } else if (path === "/admin/failure-policy") {
        response = await handleAdminFailurePolicy(request, env);
      } else {
        const message = `[请求有误]: 正确请求为 POST -> /v1/chat/completions，当前请求为 ${request.method} -> ${path} 请纠正`;
        response = errorResponse(message, 404);
      }

      return response;
    } catch (err: any) {
      console.error(err);
      return errorResponse(err.message || "Internal error", 500);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    if (env.SIGN_SECRET) setSignSecret(env.SIGN_SECRET);

    try {
      await runAutoFill(env, {
        source: "cron",
        cron: controller.cron,
        respectEnabled: true,
      });
    } catch (err) {
      controller.noRetry();
      console.error("Auto fill cron failed:", err);
    }
  },
};
