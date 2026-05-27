import axios from "axios";
import { AIProvider } from "./aiProvider.js";

/**
 * TogetherProvider — Together AI (OpenAI-compatible chat/completions)
 *
 * Refactored from the original src/lib/aiProvider.js logic.
 * Uses Together AI's v1/chat/completions endpoint.
 */

const TOGETHER_BASE_URL = "https://api.together.xyz/v1";
const DEFAULT_MODEL = "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo";

export class TogetherProvider extends AIProvider {
  constructor() {
    super("together");
    this.apiKey = process.env.TOGETHER_API_KEY;
    if (!this.apiKey) {
      console.warn("⚠️  TOGETHER_API_KEY not set — TogetherProvider will fail at runtime.");
    }
  }

  /**
   * Internal: Make a Together AI request with 1 automatic retry.
   */
  async #request(body, axiosOpts = {}) {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    const url = `${TOGETHER_BASE_URL}/chat/completions`;

    try {
      return await axios.post(url, body, {
        headers,
        timeout: axiosOpts.timeout || 30_000,
        ...axiosOpts,
      });
    } catch (firstErr) {
      console.warn(
        `[TogetherProvider] Request failed (${firstErr.response?.status || firstErr.code}), retrying…`
      );
      try {
        return await axios.post(url, body, {
          headers,
          timeout: axiosOpts.timeout || 30_000,
          ...axiosOpts,
        });
      } catch (retryErr) {
        const status = retryErr.response?.status;
        const msg = retryErr.response?.data?.error?.message || retryErr.message;
        console.error(`[TogetherProvider] Retry also failed (${status}): ${msg}`);
        throw retryErr;
      }
    }
  }

  /** @override */
  async chat(systemPrompt, messages, options = {}) {
    const model = options.model || process.env.TOGETHER_MODEL || DEFAULT_MODEL;
    const temperature = options.temperature ?? 0.3;
    const maxTokens = options.max_tokens ?? 800;

    const response = await this.#request(
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        temperature,
        max_tokens: maxTokens,
        top_p: 0.9,
      },
      { timeout: options.timeout || 30_000 }
    );

    const choice = response.data?.choices?.[0];
    if (!choice) {
      throw new Error("No response from Together AI");
    }

    const usage = response.data?.usage || {};
    const tokensUsed =
      (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

    return {
      content: choice.message?.content || "",
      tokensUsed,
      finishReason: choice.finish_reason,
    };
  }

  /** @override */
  async stream(systemPrompt, messages, options = {}) {
    const model = options.model || process.env.TOGETHER_MODEL || DEFAULT_MODEL;
    const temperature = options.temperature ?? 0.3;
    const maxTokens = options.max_tokens ?? 800;

    return this.#request(
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        temperature,
        max_tokens: maxTokens,
        top_p: 0.9,
        stream: true,
      },
      { timeout: options.timeout || 60_000, responseType: "stream" }
    );
  }

  /** @override */
  async isAvailable() {
    if (!this.apiKey) return false;
    try {
      // Lightweight models list call — verifies API key validity
      await axios.get(`${TOGETHER_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
