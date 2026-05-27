import { TogetherProvider } from "./togetherProvider.js";
import { GeminiProvider } from "./geminiProvider.js";

/**
 * AI Service Factory — Provider Resolution + Fallback + Cache + Logging
 *
 * Reads AI_PROVIDER env to determine the primary provider.
 * If the primary fails, falls back to the secondary automatically.
 *
 * Environment variables:
 *   AI_PROVIDER      = "gemini" | "together"  (default: "gemini")
 *   AI_MODEL         = model name (provider-specific)
 *   GEMINI_API_KEY   = Google Gemini API key
 *   TOGETHER_API_KEY = Together AI API key
 *   AI_CACHE_TTL     = In-memory cache TTL in ms (default: 300000 = 5 min)
 */

// ─── Provider instances (singletons) ─────────────────────
const providers = {
  together: new TogetherProvider(),
  gemini: new GeminiProvider(),
};

/**
 * Get the primary provider based on AI_PROVIDER env.
 * @returns {import("./aiProvider.js").AIProvider}
 */
export function getPrimaryProvider() {
  const name = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  return providers[name] || providers.gemini;
}

/**
 * Get the fallback provider (opposite of primary).
 * @returns {import("./aiProvider.js").AIProvider}
 */
export function getFallbackProvider() {
  const primary = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  return primary === "together" ? providers.gemini : providers.together;
}

// ─── In-Memory Response Cache ────────────────────────────
const cache = new Map();
const CACHE_TTL = parseInt(process.env.AI_CACHE_TTL) || 5 * 60 * 1000; // 5 min default
const MAX_CACHE_SIZE = 200;

function getCacheKey(systemPrompt, messages, options) {
  // Use the full system prompt and message history for the cache key to prevent collisions
  const raw = JSON.stringify({
    s: systemPrompt,
    m: messages.map((m) => `${m.role}:${m.content}`),
    t: options.temperature,
    k: options.max_tokens,
  });
  // Simple djb2 hash
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
  }
  return `ai_${hash}`;
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  // Evict oldest if at capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { value, ts: Date.now() });
}

// ─── Public API with Fallback + Logging ──────────────────

/**
 * Send a chat request with automatic provider fallback.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options - { temperature, max_tokens, model, timeout, skipCache }
 * @returns {Promise<{content: string, tokensUsed: number, finishReason: string, provider: string, cached: boolean}>}
 */
export async function chat(systemPrompt, messages, options = {}) {
  // ── Check cache ──────────────────────────────────────
  if (!options.skipCache) {
    const cacheKey = getCacheKey(systemPrompt, messages, options);
    const cached = getFromCache(cacheKey);
    if (cached) {
      console.log(`[AI] Cache HIT (provider: ${cached.provider})`);
      return { ...cached, cached: true };
    }
  }

  const primary = getPrimaryProvider();
  const fallback = getFallbackProvider();

  // ── Try primary ──────────────────────────────────────
  const startMs = Date.now();
  try {
    console.log(`[AI] Using provider: ${primary.name}`);
    const result = await primary.chat(systemPrompt, messages, options);
    const elapsed = Date.now() - startMs;
    console.log(`[AI] ${primary.name} responded in ${elapsed}ms (${result.tokensUsed} tokens)`);

    const enriched = { ...result, provider: primary.name, cached: false };

    // Cache the result
    if (!options.skipCache) {
      const cacheKey = getCacheKey(systemPrompt, messages, options);
      setCache(cacheKey, enriched);
    }

    return enriched;
  } catch (primaryErr) {
    const elapsed = Date.now() - startMs;
    console.error(
      `[AI] ${primary.name} FAILED after ${elapsed}ms: ${primaryErr.message}`
    );

    // ── Try fallback ─────────────────────────────────────
    const fbStart = Date.now();
    try {
      console.log(`[AI] Falling back to: ${fallback.name}`);
      const result = await fallback.chat(systemPrompt, messages, options);
      const fbElapsed = Date.now() - fbStart;
      console.log(
        `[AI] ${fallback.name} (fallback) responded in ${fbElapsed}ms (${result.tokensUsed} tokens)`
      );

      const enriched = { ...result, provider: fallback.name, cached: false };

      if (!options.skipCache) {
        const cacheKey = getCacheKey(systemPrompt, messages, options);
        setCache(cacheKey, enriched);
      }

      return enriched;
    } catch (fallbackErr) {
      const fbElapsed = Date.now() - fbStart;
      console.error(
        `[AI] ${fallback.name} (fallback) ALSO FAILED after ${fbElapsed}ms: ${fallbackErr.message}`
      );
      // Propagate the primary error (more relevant to the configured provider)
      throw primaryErr;
    }
  }
}

/**
 * Stream a chat response with automatic provider fallback.
 *
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options
 * @returns {Promise<import("axios").AxiosResponse>}
 */
export async function stream(systemPrompt, messages, options = {}) {
  const primary = getPrimaryProvider();
  const fallback = getFallbackProvider();

  const startMs = Date.now();
  try {
    console.log(`[AI] Streaming via: ${primary.name}`);
    const response = await primary.stream(systemPrompt, messages, options);
    const elapsed = Date.now() - startMs;
    console.log(`[AI] ${primary.name} stream connected in ${elapsed}ms`);
    return response;
  } catch (primaryErr) {
    const elapsed = Date.now() - startMs;
    console.error(
      `[AI] ${primary.name} stream FAILED after ${elapsed}ms: ${primaryErr.message}`
    );

    const fbStart = Date.now();
    try {
      console.log(`[AI] Stream falling back to: ${fallback.name}`);
      const response = await fallback.stream(systemPrompt, messages, options);
      const fbElapsed = Date.now() - fbStart;
      console.log(`[AI] ${fallback.name} (fallback) stream connected in ${fbElapsed}ms`);
      return response;
    } catch (fallbackErr) {
      const fbElapsed = Date.now() - fbStart;
      console.error(
        `[AI] ${fallback.name} (fallback) stream ALSO FAILED after ${fbElapsed}ms: ${fallbackErr.message}`
      );
      throw primaryErr;
    }
  }
}

/**
 * Check health of all registered providers.
 * @returns {Promise<Record<string, boolean>>}
 */
export async function checkHealth() {
  const results = {};
  for (const [name, provider] of Object.entries(providers)) {
    results[name] = await provider.isAvailable();
  }
  return results;
}

// Re-export provider classes for direct access if needed
export { TogetherProvider } from "./togetherProvider.js";
export { GeminiProvider } from "./geminiProvider.js";
export { AIProvider } from "./aiProvider.js";
