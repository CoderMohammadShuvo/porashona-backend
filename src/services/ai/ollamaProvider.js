import axios from "axios";
import { PassThrough } from "stream";
import { AIProvider } from "./aiProvider.js";

/**
 * OllamaProvider — Local LLM via Ollama
 *
 * Base URL:  http://localhost:11434 (configurable via OLLAMA_BASE_URL)
 * Endpoint:  POST /api/generate  (non-chat completions)
 *            POST /api/chat      (chat completions — used for streaming)
 * Default model: llama3 (configurable via AI_MODEL env)
 *
 * Timeout is raised to 120s by default because local LLMs can be slower.
 */

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "llama3";
const DEFAULT_TIMEOUT = 120_000; // 120 seconds

export class OllamaProvider extends AIProvider {
  constructor() {
    super("ollama");
    this.baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL;
  }

  /**
   * Build a single flat prompt string from system + messages.
   * Ollama's /api/generate expects a single `prompt` field.
   */
  #buildPrompt(systemPrompt, messages) {
    let prompt = "";
    if (systemPrompt) {
      prompt += `[SYSTEM]\n${systemPrompt}\n\n`;
    }
    for (const msg of messages) {
      const tag = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
      prompt += `${tag}\n${msg.content}\n\n`;
    }
    return prompt.trim();
  }

  /** @override — Uses POST /api/generate (non-streaming) with 1 retry */
  async chat(systemPrompt, messages, options = {}) {
    const model = options.model || process.env.AI_MODEL || DEFAULT_MODEL;
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    const makeRequest = async () => {
      return axios.post(
        `${this.baseUrl}/api/generate`,
        {
          model,
          prompt: this.#buildPrompt(systemPrompt, messages),
          stream: false,
          options: {
            temperature: options.temperature ?? 0.3,
            num_predict: options.max_tokens ?? 800,
            top_p: 0.9,
          },
        },
        { timeout }
      );
    };

    const startMs = Date.now();
    let response;

    try {
      response = await makeRequest();
    } catch (err) {
      console.warn(`[OllamaProvider] Request failed, retrying...`);
      try {
        response = await makeRequest();
      } catch (retryErr) {
        console.error(`[OllamaProvider] Retry also failed: ${retryErr.message}`);
        throw retryErr;
      }
    }

    const elapsedMs = Date.now() - startMs;
    const data = response.data;

    // Ollama returns { response, total_duration, eval_count, ... }
    const content = data.response || "";
    const tokensUsed = data.eval_count || 0;

    console.log(
      `[OllamaProvider] Model: ${model} | Tokens: ${tokensUsed} | Time: ${elapsedMs}ms`
    );

    return {
      content,
      tokensUsed,
      finishReason: data.done ? "stop" : "length",
    };
  }

  /**
   * @override — Uses POST /api/chat (streaming)
   *
   * Returns an Axios response whose `data` is a readable stream.
   * Each line is a JSON object: { message: { role, content }, done }
   *
   * The caller (aiChat.js streaming route) already handles SSE forwarding,
   * but the chunk format differs from OpenAI. We transform it in a
   * PassThrough stream so the existing SSE handler works unchanged.
   */
  async stream(systemPrompt, messages, options = {}) {
    const model = options.model || process.env.AI_MODEL || DEFAULT_MODEL;
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    const ollamaMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    const response = await axios.post(
      `${this.baseUrl}/api/chat`,
      {
        model,
        messages: ollamaMessages,
        stream: true,
        options: {
          temperature: options.temperature ?? 0.3,
          num_predict: options.max_tokens ?? 800,
          top_p: 0.9,
        },
      },
      { timeout, responseType: "stream" }
    );

    // ── Transform Ollama's NDJSON → OpenAI-compatible SSE ──
    const transformed = new PassThrough();
    let buffer = "";

    response.data.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.done) {
            transformed.write("data: [DONE]\n\n");
          } else {
            const content = parsed.message?.content || "";
            if (content) {
              transformed.write(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content } }],
                })}\n\n`
              );
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    });

    response.data.on("end", () => {
      if (!transformed.writableEnded) {
        transformed.write("data: [DONE]\n\n");
        transformed.end();
      }
    });

    response.data.on("error", (err) => {
      transformed.destroy(err);
    });

    // Return in the same shape the existing code expects: { data: ReadableStream }
    return { data: transformed };
  }

  /** @override */
  async isAvailable() {
    try {
      const res = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 5_000,
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
