import { GoogleGenAI } from "@google/genai";
import { PassThrough } from "stream";
import { AIProvider } from "./aiProvider.js";

/**
 * GeminiProvider — Google Gemini AI Provider
 *
 * Uses the @google/genai SDK for native integration.
 * Emulates OpenAI-compatible SSE chunking for stream support
 * to match the existing expectations of the aiChat.js route.
 */

const DEFAULT_MODEL = "gemini-3.7-flash"; // Corrected from typo

export class GeminiProvider extends AIProvider {
  constructor() {
    super("gemini");
    this.apiKey = process.env.GEMINI_API_KEY;
    if (!this.apiKey) {
      console.warn("⚠️  GEMINI_API_KEY not set — GeminiProvider will fail at runtime.");
    } else {
      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }
  }

  /**
   * Internal: Format standard chat messages to Gemini's format.
   */
  #formatMessages(messages) {
    const formatted = [];
    for (const msg of messages) {
      // Ignore system messages here, they are handled via config.systemInstruction
      if (msg.role === "system") continue;
      
      formatted.push({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      });
    }
    return formatted;
  }

  /** @override */
  async chat(systemPrompt, messages, options = {}) {
    if (!this.ai) throw new Error("GEMINI_API_KEY is not configured.");
    
    const baseModel = options.model || process.env.AI_MODEL || DEFAULT_MODEL;
    const modelsToTry = [...new Set([baseModel, "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"])];
    
    const contents = this.#formatMessages(messages);
    
    const config = {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.max_tokens ?? 2048,
      topP: 0.9,
    };

    if (systemPrompt) {
      config.systemInstruction = systemPrompt;
    }

    // Safety fallback: if no user message exists, inject one
    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Hello" }] });
    }

    let response = null;
    let lastErr = null;

    for (const m of modelsToTry) {
      try {
        response = await this.ai.models.generateContent({
          model: m,
          contents,
          config
        });
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`Model ${m} failed in chat:`, err.message);
      }
    }

    if (!response) {
      throw lastErr || new Error("All AI models failed");
    }

    const content = response.text || "";
    const tokensUsed = response.usageMetadata?.totalTokenCount || 0;
    
    return {
      content,
      tokensUsed,
      finishReason: response.candidates?.[0]?.finishReason === "MAX_TOKENS" ? "length" : "stop",
    };
  }

  /** @override */
  async stream(systemPrompt, messages, options = {}) {
    if (!this.ai) throw new Error("GEMINI_API_KEY is not configured.");

    const baseModel = options.model || process.env.AI_MODEL || DEFAULT_MODEL;
    const modelsToTry = [...new Set([baseModel, "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"])];
    
    const contents = this.#formatMessages(messages);
    
    const config = {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.max_tokens ?? 2048,
      topP: 0.9,
    };

    if (systemPrompt) {
      config.systemInstruction = systemPrompt;
    }

    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Hello" }] });
    }

    let streamResponse = null;
    let lastErr = null;

    for (const m of modelsToTry) {
      try {
        streamResponse = await this.ai.models.generateContentStream({
          model: m,
          contents,
          config
        });
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`Model ${m} failed in stream:`, err.message);
      }
    }

    if (!streamResponse) {
      throw lastErr || new Error("All AI models failed");
    }

    const transformed = new PassThrough();

    (async () => {
      try {
        for await (const chunk of streamResponse) {
          const content = chunk.text || "";
          if (content) {
            transformed.write(
              `data: ${JSON.stringify({
                choices: [{ delta: { content } }],
              })}\n\n`
            );
          }
        }
        transformed.write("data: [DONE]\n\n");
        transformed.end();
      } catch (err) {
        transformed.destroy(err);
      }
    })();

    return { data: transformed };
  }

  /** @override */
  async isAvailable() {
    if (!this.apiKey) return false;
    try {
      // Fast check: generate 1 token
      await this.ai.models.generateContent({
        model: "gemini-3.7-flash",
        contents: "test",
        config: { maxOutputTokens: 1 }
      });
      return true;
    } catch {
      return false;
    }
  }
}
