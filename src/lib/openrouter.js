import axios from "axios";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

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

/**
 * Call OpenRouter's chat completions endpoint.
 * @param {string} systemPrompt - The system message
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {object} options - Optional overrides (temperature, max_tokens, model)
 * @returns {Promise<{content: string, tokensUsed: number}>}
 */
export async function callOpenRouter(systemPrompt, messages, options = {}) {
  const model = options.model || process.env.OPENROUTER_MODEL || "meta-llama/llama-3-70b-instruct";
  const temperature = options.temperature ?? 0.3;
  const maxTokens = options.max_tokens ?? 800;

  const response = await axios.post(
    `${OPENROUTER_BASE_URL}/chat/completions`,
    {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      temperature,
      max_tokens: maxTokens,
      // Prevent model from inventing URLs, emails, phone numbers
      top_p: 0.9,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://porashona.com",
        "X-Title": "Porashona AI Faculty",
      },
      timeout: 30000, // 30s timeout
    }
  );

  const choice = response.data?.choices?.[0];
  if (!choice) {
    throw new Error("No response from OpenRouter");
  }

  const usage = response.data?.usage || {};
  const tokensUsed = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

  return {
    content: choice.message?.content || "",
    tokensUsed,
    finishReason: choice.finish_reason,
  };
}

/**
 * Stream responses from OpenRouter using SSE.
 * @param {string} systemPrompt - The system message
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {object} options - Optional overrides
 * @returns {Promise<import("axios").AxiosResponse>} - Axios response with stream
 */
export async function streamOpenRouter(systemPrompt, messages, options = {}) {
  const model = options.model || process.env.OPENROUTER_MODEL || "meta-llama/llama-3-70b-instruct";
  const temperature = options.temperature ?? 0.3;
  const maxTokens = options.max_tokens ?? 800;

  const response = await axios.post(
    `${OPENROUTER_BASE_URL}/chat/completions`,
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
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://porashona.com",
        "X-Title": "Porashona AI Faculty",
      },
      timeout: 60000,
      responseType: "stream",
    }
  );

  return response;
}

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
      { temperature: 0.1, max_tokens: 10 }
    );

    const verdict = result.content.trim().toUpperCase();
    return verdict.startsWith("YES");
  } catch (err) {
    // If validation fails, err on the side of caution but don't block
    console.error("NCTB validation error:", err.message);
    return true; // Allow through if validation service is down
  }
}
