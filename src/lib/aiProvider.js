/**
 * Porashona AI Provider — Unified Abstraction Layer
 *
 * Drop-in replacement that maintains the EXACT same function signatures
 * used by aiChat.js and any other consumer.
 *
 * Delegates to the provider-based system in services/ai/ which handles:
 *   - Provider selection (AI_PROVIDER env: "together" | "ollama")
 *   - Automatic fallback (primary → secondary)
 *   - Response caching
 *   - Structured logging (provider, response time, tokens)
 *
 * No breaking changes to any import paths or function calls.
 */

import { chat, stream } from "../services/ai/index.js";

// ─── Prompt Sanitization (unchanged) ─────────────────────

/**
 * Sanitize user input to prevent prompt injection attacks.
 * Strips control characters, excessive whitespace, and known injection patterns.
 */
export function sanitizePrompt(input) {
  if (!input || typeof input !== "string") return "";

  return input
    // Remove null bytes and control characters (except newlines/tabs)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Collapse excessive whitespace to prevent payload bloat
    .replace(/\s{10,}/g, " ")
    // Strip known injection delimiters
    .replace(/```system/gi, "")
    .replace(/\[INST\]/gi, "")
    .replace(/<\|im_start\|>/gi, "")
    .replace(/<\|im_end\|>/gi, "")
    // Trim to reasonable length (prevent token abuse)
    .trim()
    .slice(0, 2000);
}

// ─── Public API (same signatures as before) ──────────────

/**
 * Call the active AI provider's chat completions endpoint.
 * @param {string} systemPrompt - The system message
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {object} options - Optional overrides (temperature, max_tokens, model)
 * @returns {Promise<{content: string, tokensUsed: number, finishReason: string}>}
 */
export async function callOpenRouter(systemPrompt, messages, options = {}) {
  return chat(systemPrompt, messages, options);
}

/**
 * Stream responses from the active AI provider using SSE.
 * @param {string} systemPrompt - The system message
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {object} options - Optional overrides
 * @returns {Promise<import("axios").AxiosResponse>} - Axios response with stream
 */
export async function streamOpenRouter(systemPrompt, messages, options = {}) {
  return stream(systemPrompt, messages, options);
}

// ─── NCTB Validation (unchanged logic, uses provider abstraction) ─

/**
 * Validate if a response is NCTB-syllabus-compliant using a second LLM call.
 * @param {string} question - The user's original question
 * @param {string} answer - The AI-generated answer
 * @param {string} subject - The subject name
 * @returns {Promise<boolean>} - true if valid, false if suspect
 */
export async function validateNCTBCompliance(question, answer, subject) {
  try {
    const validationPrompt = `You are a strict NCTB (National Curriculum and Textbook Board, Bangladesh) syllabus verifier.

Given the following question and answer for the subject "${subject}", determine:
1. Is this answer strictly correct based on NCTB curriculum content?
2. Does this answer contain any hallucinated or fabricated information?
3. Is this answer within the scope of the NCTB syllabus?

QUESTION: ${question}

ANSWER: ${answer}

Respond with ONLY one word: YES or NO.
YES = The answer is correct and within NCTB syllabus.
NO = The answer contains inaccuracies or is outside NCTB scope.`;

    const result = await callOpenRouter(
      "You are an NCTB syllabus compliance checker. Respond only with YES or NO.",
      [{ role: "user", content: validationPrompt }],
      { temperature: 0.1, max_tokens: 10, skipCache: true }
    );

    const verdict = result.content.trim().toUpperCase();
    return verdict.startsWith("YES");
  } catch (err) {
    // If validation fails, err on the side of caution but don't block
    console.error("NCTB validation error:", err.message);
    return true; // Allow through if validation service is down
  }
}
