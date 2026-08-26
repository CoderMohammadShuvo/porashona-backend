import axios from "axios";
import { AIProvider } from "./aiProvider.js";

/**
 * OpenRouter AI Provider Implementation
 * Compatible with Gemini, Claude, Llama, DeepSeek, and OpenAI models via OpenRouter API.
 */
export class OpenRouterProvider extends AIProvider {
  constructor() {
    super("openrouter");
    this.apiKey = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
    this.defaultModel = process.env.OPENROUTER_MODEL || process.env.AI_MODEL || "google/ggemini-3.7-flash";
    this.baseUrl = "https://openrouter.ai/api/v1";
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  async chat(systemPrompt, messages, options = {}) {
    if (!this.isAvailable()) {
      throw new Error("OpenRouter API key is missing. Set OPENROUTER_API_KEY or GEMINI_API_KEY.");
    }

    const model = options.model || this.defaultModel;
    const formattedMessages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...messages,
    ];

    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model,
        messages: formattedMessages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 2048,
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": process.env.FRONTEND_URL || "https://porashona.com",
          "X-Title": "Porashona AI Platform",
          "Content-Type": "application/json",
        },
        timeout: options.timeout || 30000,
      }
    );

    const choice = response.data?.choices?.[0];
    if (!choice) {
      throw new Error("Empty or invalid response from OpenRouter API.");
    }

    return {
      content: choice.message?.content || "",
      tokensUsed: response.data?.usage?.total_tokens || 0,
      finishReason: choice.finish_reason || "stop",
    };
  }

  async stream(systemPrompt, messages, options = {}) {
    if (!this.isAvailable()) {
      throw new Error("OpenRouter API key is missing. Set OPENROUTER_API_KEY or GEMINI_API_KEY.");
    }

    const model = options.model || this.defaultModel;
    const formattedMessages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...messages,
    ];

    return axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model,
        messages: formattedMessages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 2048,
        stream: true,
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": process.env.FRONTEND_URL || "https://porashona.com",
          "X-Title": "Porashona AI Platform",
          "Content-Type": "application/json",
        },
        responseType: "stream",
        timeout: options.timeout || 60000,
      }
    );
  }
}
