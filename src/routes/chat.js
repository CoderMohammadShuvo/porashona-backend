import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabase } from "../lib/supabase.js";
import { anthropic, CLAUDE_MODEL, defaultTeacherPrompt } from "../lib/claude.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// Strict rate limit for AI chat — prevents abuse
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: "Too many messages. Please slow down." },
});

const FREE_DAILY_LIMIT = 10;
const PRO_DAILY_LIMIT = 150;

// Helper — check and increment daily usage
async function checkDailyLimit(userId, isPro) {
  const today = new Date().toISOString().split("T")[0];

  const { data: usage, error } = await supabase
    .from("daily_ai_usage")
    .select("questions_used")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  const current = usage?.questions_used || 0;
  const limit = isPro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;

  if (current >= limit) {
    return { allowed: false, current, limit };
  }

  // Upsert usage count
  await supabase.from("daily_ai_usage").upsert({
    user_id: userId,
    date: today,
    questions_used: current + 1,
  }, { onConflict: "user_id,date" });

  return { allowed: true, current: current + 1, limit };
}

/**
 * @swagger
 * /chat/send:
 *   post:
 *     summary: Send message to AI teacher
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [teacher_id, message]
 *             properties:
 *               teacher_id: { type: string }
 *               message: { type: string }
 *               context: { type: string }
 *               history: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Streaming response
 */
router.post("/send", requireAuth, chatLimiter, async (req, res) => {
  const { teacher_id, message, context, history = [] } = req.body;

  if (!teacher_id || !message?.trim()) {
    return res.status(400).json({ error: "teacher_id and message are required" });
  }

  // Check subscription
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", req.user.id)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .limit(1)
    .single();

  const isPro = !!sub;

  // Check daily limit
  const limitCheck = await checkDailyLimit(req.user.id, isPro);
  if (!limitCheck.allowed) {
    return res.status(429).json({
      error: `Daily limit of ${limitCheck.limit} messages reached.`,
      code: "DAILY_LIMIT",
      isPro,
      limit: limitCheck.limit,
    });
  }

  // Fetch teacher from DB
  const { data: teacher } = await supabase
    .from("teachers")
    .select("*")
    .eq("id", teacher_id)
    .single();

  if (!teacher) {
    return res.status(404).json({ error: "Teacher not found" });
  }

  // Block free users from PRO-only teachers
  if (teacher.is_pro_only && !isPro) {
    return res.status(403).json({ error: "This teacher is PRO only", code: "PRO_REQUIRED" });
  }

  const systemPrompt = teacher.system_prompt
    ? `${defaultTeacherPrompt(teacher)}\n\n${teacher.system_prompt}`
    : defaultTeacherPrompt(teacher);

  // Build messages array (last 10 from history)
  const messages = [
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: context
        ? `[Context: ${context}]\n\n${message}`
        : message,
    },
  ];

  // ── Streaming response ──────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let fullResponse = "";
  let tokensUsed = 0;

  try {
    const stream = await anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        const chunk = event.delta.text;
        fullResponse += chunk;
        // SSE format matching the frontend's parser
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: chunk } }]
        })}\n\n`);
      }
    }

    const finalMessage = await stream.finalMessage();
    tokensUsed = finalMessage.usage?.input_tokens + finalMessage.usage?.output_tokens || 0;

    res.write("data: [DONE]\n\n");
    res.end();

    // Log to ai_chat_logs (async, don't await)
    supabase.from("ai_chat_logs").insert([
      { user_id: req.user.id, teacher_id, role: "user", content: message, tokens_used: 0 },
      { user_id: req.user.id, teacher_id, role: "assistant", content: fullResponse, tokens_used: tokensUsed },
    ]).then(() => {}).catch(console.error);

  } catch (err) {
    console.error("Claude streaming error:", err);
    res.write(`data: ${JSON.stringify({ error: "AI service temporarily unavailable" })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

/**
 * @swagger
 * /chat/history/{teacherId}:
 *   get:
 *     summary: Get chat history with a teacher
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: teacherId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of messages
 */
router.get("/history/:teacherId", requireAuth, async (req, res) => {
  const { teacherId } = req.params;

  const { data, error } = await supabase
    .from("ai_chat_logs")
    .select("role, content, created_at")
    .eq("user_id", req.user.id)
    .eq("teacher_id", teacherId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });

  res.json((data || []).reverse()); // chronological order
});

/**
 * @swagger
 * /chat/daily-usage:
 *   get:
 *     summary: Get daily AI usage
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Usage statistics
 */
router.get("/daily-usage", requireAuth, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", req.user.id)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .limit(1)
    .single();

  const isPro = !!sub;

  const { data: usage } = await supabase
    .from("daily_ai_usage")
    .select("questions_used")
    .eq("user_id", req.user.id)
    .eq("date", today)
    .single();

  res.json({
    used: usage?.questions_used || 0,
    limit: isPro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT,
    isPro,
    remaining: Math.max(0, (isPro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT) - (usage?.questions_used || 0)),
  });
});

export default router;
