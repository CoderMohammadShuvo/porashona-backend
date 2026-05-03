/**
 * AIProvider — Base Interface
 *
 * All AI providers (Together, Ollama, etc.) must implement this interface.
 * This ensures consistent behavior across the codebase regardless of
 * which provider is active.
 */

export class AIProvider {
  constructor(name) {
    if (new.target === AIProvider) {
      throw new Error("AIProvider is an abstract class — use a concrete provider.");
    }
    this.name = name;
  }

  /**
   * Send a chat completion request.
   * @param {string} systemPrompt - The system message
   * @param {Array<{role: string, content: string}>} messages - Chat messages
   * @param {object} options - { temperature, max_tokens, model, timeout }
   * @returns {Promise<{content: string, tokensUsed: number, finishReason: string}>}
   */
  async chat(systemPrompt, messages, options = {}) {
    throw new Error(`${this.name}.chat() is not implemented`);
  }

  /**
   * Stream a chat completion response (SSE).
   * @param {string} systemPrompt - The system message
   * @param {Array<{role: string, content: string}>} messages - Chat messages
   * @param {object} options - { temperature, max_tokens, model, timeout }
   * @returns {Promise<import("axios").AxiosResponse>} - Axios response with stream
   */
  async stream(systemPrompt, messages, options = {}) {
    throw new Error(`${this.name}.stream() is not implemented`);
  }

  /**
   * Health check — verify the provider is reachable.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return false;
  }
}
