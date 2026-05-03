/**
 * AI Migration Test Script
 *
 * This script tests the AI provider abstraction, fallback mechanism,
 * and caching without needing to run the full Express server.
 */

import "dotenv/config";
import * as AI from "../src/services/ai/index.js";

async function runTest() {
  console.log("🚀 Starting AI Provider Migration Test...\n");

  // 1. Check Health
  console.log("--- 1. Checking Provider Health ---");
  const health = await AI.checkHealth();
  console.log("Provider Status:", health);
  console.log("Configured Primary:", process.env.AI_PROVIDER || "together");
  console.log("");

  // 2. Test Chat (Simple)
  console.log("--- 2. Testing Chat Completion ---");
  try {
    const start = Date.now();
    const result = await AI.chat(
      "You are a helpful assistant.",
      [{ role: "user", content: "Say 'Hello from Porashona' in one sentence." }],
      { max_tokens: 50 }
    );
    const elapsed = Date.now() - start;

    console.log("Result:", result.content);
    console.log("Provider Used:", result.provider);
    console.log("Time Taken:", elapsed, "ms");
    console.log("Tokens Used:", result.tokensUsed);
    console.log("Cached:", result.cached);
    console.log("");

    // 3. Test Cache
    console.log("--- 3. Testing Cache (should be near instant) ---");
    const cacheStart = Date.now();
    const cacheResult = await AI.chat(
      "You are a helpful assistant.",
      [{ role: "user", content: "Say 'Hello from Porashona' in one sentence." }],
      { max_tokens: 50 }
    );
    const cacheElapsed = Date.now() - cacheStart;

    console.log("Result:", cacheResult.content);
    console.log("Cached:", cacheResult.cached);
    console.log("Time Taken:", cacheElapsed, "ms");
    console.log("");

  } catch (err) {
    console.error("❌ Chat Test Failed:", err.message);
  }

  console.log("✅ Test Run Complete.");
}

runTest();
