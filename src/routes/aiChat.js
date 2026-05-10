import { Router } from "express";
import rateLimit from "express-rate-limit";
import { supabase } from "../lib/supabase.js";
import { callOpenRouter, streamOpenRouter, sanitizePrompt, validateNCTBCompliance } from "../lib/aiProvider.js";
import { checkHealth } from "../services/ai/index.js";
import { buildSystemPrompt, buildGeneralPrompt } from "../lib/promptEngine.js";
import { authMiddleware } from "../middleware/auth.js";
import { getTeacher, getAccessibleTeachers } from "../lib/teachers.js";

const router = Router();

// ─── Constants ───────────────────────────────────────────
const USAGE_LIMITS = {
  free: 3,
  basic: 15,
  pro: Infinity, // unlimited
};

// Strict rate limit for AI chat — prevents abuse
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10, // max 10 requests per minute per IP
  message: { error: "Too many messages. Please slow down." },
});

// ─── Helpers ─────────────────────────────────────────────

/**
 * Determine user's subscription tier.
 * Returns { tier: 'free'|'basic'|'pro', subscription: object|null }
 */
async function getUserTier(userId) {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status, plan_id, expires_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!sub) return { tier: "free", subscription: null };

  // Map plan_id to tier
  const planId = (sub.plan_id || "").toLowerCase();
  if (planId.includes("pro") || planId.includes("premium")) {
    return { tier: "pro", subscription: sub };
  }
  if (planId.includes("basic") || planId.includes("starter")) {
    return { tier: "basic", subscription: sub };
  }

  // Default to basic if they have any active subscription
  return { tier: "basic", subscription: sub };
}

/**
 * Check and increment daily usage. Returns usage status.
 */
async function checkAndIncrementUsage(userId, tier) {
  const today = new Date().toISOString().split("T")[0];
  const limit = USAGE_LIMITS[tier] || USAGE_LIMITS.free;

  const { data: usage } = await supabase
    .from("daily_ai_usage")
    .select("questions_used")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  const current = usage?.questions_used || 0;

  // Pro users have unlimited access
  if (limit === Infinity) {
    await supabase.from("daily_ai_usage").upsert(
      { user_id: userId, date: today, questions_used: current + 1 },
      { onConflict: "user_id,date" }
    );
    return { allowed: true, used: current + 1, limit: -1, remaining: -1 };
  }

  if (current >= limit) {
    return { allowed: false, used: current, limit, remaining: 0 };
  }

  await supabase.from("daily_ai_usage").upsert(
    { user_id: userId, date: today, questions_used: current + 1 },
    { onConflict: "user_id,date" }
  );

  return {
    allowed: true,
    used: current + 1,
    limit,
    remaining: Math.max(0, limit - (current + 1)),
  };
}

/**
 * Fetch NCTB content from subtopics table based on chapter + topic.
 */
async function fetchNCTBContent({ subjectName, chapterId, topicTitle }) {
  // Try to find by chapter_id and topic title match
  if (chapterId) {
    const { data: subtopics } = await supabase
      .from("subtopics")
      .select("title, notes_text")
      .eq("chapter_id", chapterId)
      .eq("is_published", true);

    if (subtopics && subtopics.length > 0) {
      // If topic title provided, find best match
      if (topicTitle) {
        const match = subtopics.find(
          (s) => s.title.toLowerCase().includes(topicTitle.toLowerCase()) ||
                 topicTitle.toLowerCase().includes(s.title.toLowerCase())
        );
        if (match?.notes_text) return match.notes_text;
      }

      // Concatenate all available notes for the chapter
      const allNotes = subtopics
        .filter((s) => s.notes_text)
        .map((s) => `## ${s.title}\n${s.notes_text}`)
        .join("\n\n");
      return allNotes || "";
    }
  }

  return "";
}

/**
 * Store chat messages in ai_chat_logs (fire-and-forget).
 */
function logChatMessages(userId, teacherId, userMessage, assistantMessage, tokensUsed) {
  supabase
    .from("ai_chat_logs")
    .insert([
      { user_id: userId, teacher_id: teacherId, role: "user", content: userMessage, tokens_used: 0 },
      { user_id: userId, teacher_id: teacherId, role: "assistant", content: assistantMessage, tokens_used: tokensUsed },
    ])
    .then(() => {})
    .catch((err) => console.error("Chat log insert error:", err.message));
}

// ─── GET /api/ai/teachers — Public Teacher Listing ──────
router.get("/teachers", async (req, res) => {
  try {
    const { data: teachers, error } = await supabase
      .from("teachers")
      .select("id, name, subject, title, personality, is_pro_only, image_url, glow_color")
      .eq("is_active", true)
      .order("name");

    if (error) throw error;
    res.json(teachers);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch faculty" });
  }
});

// ─── POST /api/ai/chat — Main AI Chat Endpoint ──────────
/**
 * @swagger
 * /api/ai/chat:
 *   post:
 *     summary: Send a question to an AI teacher (NCTB-grounded)
 *     description: |
 *       Sends a student's question to an AI teacher persona. The response is
 *       grounded in NCTB syllabus content fetched from the subtopics table.
 *       A second LLM call validates the answer for NCTB compliance.
 *
 *       **Provider Support:**
 *       This endpoint now supports Google **Gemini AI** with automatic
 *       fallback to **Together AI** if the primary is unavailable.
 *
 *       **Usage Limits:**
 *       - Free tier: 3 questions/day
 *       - Basic tier: 15 questions/day
 *       - Pro tier: Unlimited
 *
 *       **Available Teachers:**
 *       | ID | Name | Subject | Tier |
 *       |---|---|---|---|
 *       | khalid | Prof. Khalid | Physics | Free |
 *       | ayaan | Prof. Ayaan | Mathematics | Pro |
 *       | rafiq | Mr. Rafiq | Chemistry | Free |
 *       | nabila | Dr. Nabila | Biology | Free |
 *       | sara | Ms. Sara | English | Free |
 *       | maya | Ms. Maya | Bangla | Free |
 *       | tanvir | Mr. Tanvir | Business Studies | Free |
 *       | imran | Mr. Imran | ICT | Free |
 *       | fariha | Miss Fariha | Library | Free |
 *       | tariq | Mr. Tariq | University Counseling | Pro |
 *       | sofia | Mrs. Sofia | Principal | Pro |
 *     tags: [AI Faculty]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question, teacherId]
 *             properties:
 *               question:
 *                 type: string
 *                 description: The student's question (max 2000 chars, auto-sanitized)
 *                 example: "নিউটনের তৃতীয় সূত্র ব্যাখ্যা করো"
 *               teacherId:
 *                 type: string
 *                 description: ID of the AI teacher persona
 *                 enum: [khalid, ayaan, rafiq, nabila, sara, maya, tanvir, imran, fariha, tariq, sofia]
 *                 example: khalid
 *               subject:
 *                 type: string
 *                 description: Subject name (defaults to teacher's subject if omitted)
 *                 example: Physics
 *               class:
 *                 type: string
 *                 description: Class/grade level (defaults to user's class from profile)
 *                 example: "10"
 *               chapter:
 *                 type: string
 *                 description: Chapter ID or title — used to fetch NCTB notes for grounding
 *                 example: "physics-ch3-newtons-laws"
 *               topic:
 *                 type: string
 *                 description: Subtopic title — narrows NCTB content to a specific topic
 *                 example: "Newton's Third Law"
 *           example:
 *             question: "নিউটনের তৃতীয় সূত্র ব্যাখ্যা করো"
 *             teacherId: khalid
 *             subject: Physics
 *             class: "10"
 *             chapter: "physics-ch3-newtons-laws"
 *             topic: "Newton's Third Law"
 *     responses:
 *       200:
 *         description: NCTB-grounded AI teacher response with usage stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 answer:
 *                   type: string
 *                   description: The AI teacher's response (may be fallback text if validation failed)
 *                 teacher:
 *                   type: string
 *                   description: Display name of the teacher
 *                   example: "Prof. Khalid"
 *                 teacherId:
 *                   type: string
 *                   description: ID of the teacher that responded
 *                   example: khalid
 *                 subject:
 *                   type: string
 *                   description: Subject of the response
 *                   example: Physics
 *                 validated:
 *                   type: boolean
 *                   description: Whether the response passed NCTB compliance check
 *                 usageRemaining:
 *                   type: integer
 *                   description: Questions remaining today (-1 for unlimited/Pro)
 *                   example: 2
 *                 usageUsed:
 *                   type: integer
 *                   description: Questions used today
 *                   example: 1
 *                 usageLimit:
 *                   type: integer
 *                   description: Daily limit for user's tier (-1 for unlimited)
 *                   example: 3
 *                 tier:
 *                   type: string
 *                   enum: [free, basic, pro]
 *                   description: User's current subscription tier
 *                   example: free
 *             example:
 *               answer: "নিউটনের তৃতীয় সূত্র অনুযায়ী, প্রতিটি ক্রিয়ার একটি সমান ও বিপরীত প্রতিক্রিয়া আছে..."
 *               teacher: "Prof. Khalid"
 *               teacherId: khalid
 *               subject: Physics
 *               validated: true
 *               usageRemaining: 2
 *               usageUsed: 1
 *               usageLimit: 3
 *               tier: free
 *       400:
 *         description: Missing or invalid input
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *             example:
 *               error: "question is required"
 *       403:
 *         description: Teacher requires Pro subscription
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *                 code: { type: string, enum: [PRO_REQUIRED] }
 *             example:
 *               error: "Prof. Ayaan is available for Pro subscribers only."
 *               code: PRO_REQUIRED
 *       404:
 *         description: Teacher not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *             example:
 *               error: "Teacher not found"
 *       429:
 *         description: Daily usage limit reached or rate limited
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *                 code: { type: string, enum: [DAILY_LIMIT] }
 *                 tier: { type: string, enum: [free, basic, pro] }
 *                 used: { type: integer }
 *                 limit: { type: integer }
 *             example:
 *               error: "Daily limit of 3 questions reached. Upgrade to Basic or Pro for more questions!"
 *               code: DAILY_LIMIT
 *               tier: free
 *               used: 3
 *               limit: 3
 *       500:
 *         description: AI service error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *             example:
 *               error: "AI service temporarily unavailable. Please try again."
 */
router.post("/chat", authMiddleware, chatLimiter, async (req, res) => {
  try {
    const { question, subject, class: className, chapter, topic, teacherId } = req.body;
    const userId = req.user.id;

    // ── 1. Validate input ─────────────────────────────────
    if (!question?.trim()) {
      return res.status(400).json({ error: "question is required" });
    }
    if (!teacherId) {
      return res.status(400).json({ error: "teacherId is required" });
    }

    const sanitizedQuestion = sanitizePrompt(question);
    if (!sanitizedQuestion) {
      return res.status(400).json({ error: "Invalid question content" });
    }

    // ── 2. Check subscription tier ────────────────────────
    const { tier, subscription } = await getUserTier(userId);

    // ── 3. Check daily usage limit ────────────────────────
    const usageCheck = await checkAndIncrementUsage(userId, tier);
    if (!usageCheck.allowed) {
      return res.status(429).json({
        error: `Daily limit of ${usageCheck.limit} questions reached. ${
          tier === "free"
            ? "Upgrade to Basic or Pro for more questions!"
            : "You've reached your daily limit."
        }`,
        code: "DAILY_LIMIT",
        tier,
        used: usageCheck.used,
        limit: usageCheck.limit,
      });
    }

    // ── 4. Get teacher from database ──────────────────────
    const { data: teacher, error: teacherError } = await supabase
      .from("teachers")
      .select("*")
      .eq("id", teacherId)
      .eq("is_active", true)
      .single();

    if (teacherError || !teacher) {
      return res.status(404).json({ error: "Teacher not found or inactive" });
    }

    // Block free users from PRO-only teachers
    if (teacher.is_pro_only && tier === "free") {
      return res.status(403).json({
        error: `${teacher.name} is available for Pro subscribers only.`,
        code: "PRO_REQUIRED",
      });
    }

    // ── 5. Fetch NCTB content ─────────────────────────────
    let notesText = "";
    if (chapter) {
      // Try to resolve chapter ID
      let chapterId = chapter;

      // If chapter is a title rather than an ID, look it up
      if (subject && !chapter.includes("-")) {
        const { data: chapterData } = await supabase
          .from("chapters")
          .select("id, title")
          .ilike("title", `%${chapter}%`)
          .limit(1)
          .single();

        if (chapterData) {
          chapterId = chapterData.id;
        }
      }

      notesText = await fetchNCTBContent({
        subjectName: subject || teacher.subject,
        chapterId,
        topicTitle: topic,
      });
    }

    // ── 6. Build system prompt ────────────────────────────
    const userGroup = req.user.group || "Science";
    const userClass = className || String(req.user.class || 10);

    const systemPrompt = buildSystemPrompt({
      teacher,
      subject: subject || teacher.subject,
      className: userClass,
      group: userGroup,
      chapter: chapter || "General",
      topic: topic || "General",
      notesText,
      question: sanitizedQuestion,
    });

    // ── 7. Call OpenRouter ────────────────────────────────
    const result = await callOpenRouter(
      systemPrompt,
      [{ role: "user", content: sanitizedQuestion }],
      { temperature: 0.3, max_tokens: 800 }
    );

    let answer = result.content;

    // ── 8. Safety validation (second LLM call) ────────────
    const isValid = await validateNCTBCompliance(
      sanitizedQuestion,
      answer,
      subject || teacher.subject
    );

    if (!isValid) {
      answer = "দুঃখিত, এই উত্তরের নির্ভুলতা নিয়ে আমি সম্পূর্ণ নিশ্চিত নই। সঠিক তথ্যের জন্য আপনার NCTB পাঠ্যবই দেখুন।\n\n(Please refer to your NCTB textbook for accurate information.)";
    }

    // ── 9. Store chat log (fire-and-forget) ───────────────
    logChatMessages(userId, teacherId, sanitizedQuestion, answer, result.tokensUsed);

    // ── 10. Return response ──────────────────────────────
    return res.json({
      answer,
      teacher: teacher.name,
      teacherId: teacher.id,
      subject: subject || teacher.subject,
      validated: isValid,
      usageRemaining: usageCheck.remaining,
      usageUsed: usageCheck.used,
      usageLimit: usageCheck.limit,
      tier,
    });
  } catch (err) {
    console.error("AI Chat error:", err.response?.data || err.message);

    if (err.response?.status === 402) {
      return res.status(503).json({ error: "AI service credit limit reached. Please try again later." });
    }
    if (err.response?.status === 429) {
      return res.status(429).json({ error: "AI service is busy. Please try again in a moment." });
    }

    return res.status(500).json({ error: "AI service temporarily unavailable. Please try again." });
  }
});

// ─── POST /api/ai/chat/stream — Streaming AI Chat ───────
/**
 * @swagger
 * /api/ai/chat/stream:
 *   post:
 *     summary: Stream AI teacher response via Server-Sent Events (SSE)
 *     description: |
 *       Streams the AI teacher's response in real-time using SSE.
 *       Supports conversation history (last 10 messages) for multi-turn chat.
 *       Same validation, usage tracking, and teacher access rules as /api/ai/chat.
 *
 *       **SSE Format (OpenAI-compatible):**
 *       ```
 *       data: {"choices":[{"delta":{"content":"chunk text"}}]}
 *       data: {"choices":[{"delta":{"content":" more text"}}]}
 *       data: [DONE]
 *       ```
 *
 *       **Error during stream:**
 *       ```
 *       data: {"error":"Stream interrupted"}
 *       data: [DONE]
 *       ```
 *     tags: [AI Faculty]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question, teacherId]
 *             properties:
 *               question:
 *                 type: string
 *                 description: The student's question (max 2000 chars)
 *                 example: "Solve x² + 5x + 6 = 0"
 *               teacherId:
 *                 type: string
 *                 enum: [khalid, ayaan, rafiq, nabila, sara, maya, tanvir, imran, fariha, tariq, sofia]
 *                 description: ID of the AI teacher persona
 *                 example: ayaan
 *               subject:
 *                 type: string
 *                 description: Subject name (defaults to teacher's subject)
 *                 example: Mathematics
 *               class:
 *                 type: string
 *                 description: Class/grade level
 *                 example: "10"
 *               chapter:
 *                 type: string
 *                 description: Chapter ID or title for NCTB grounding
 *               topic:
 *                 type: string
 *                 description: Subtopic title
 *               history:
 *                 type: array
 *                 description: Previous conversation messages (last 10 used)
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *                 example:
 *                   - role: user
 *                     content: "What is a quadratic equation?"
 *                   - role: assistant
 *                     content: "A quadratic equation is a polynomial equation of degree 2..."
 *           example:
 *             question: "Now solve x² + 5x + 6 = 0"
 *             teacherId: ayaan
 *             subject: Mathematics
 *             class: "10"
 *             history:
 *               - role: user
 *                 content: "What is a quadratic equation?"
 *               - role: assistant
 *                 content: "A quadratic equation is a polynomial equation of degree 2..."
 *     responses:
 *       200:
 *         description: SSE stream of AI response chunks (Content-Type text/event-stream)
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error: { type: string }
 *             example:
 *               error: "question and teacherId are required"
 *       403:
 *         description: Teacher requires Pro subscription
 *       404:
 *         description: Teacher not found
 *       429:
 *         description: Daily limit or rate limit reached
 */
router.post("/chat/stream", authMiddleware, chatLimiter, async (req, res) => {
  try {
    const { question, subject, class: className, chapter, topic, teacherId, history = [] } = req.body;
    const userId = req.user.id;

    // Validate
    if (!question?.trim() || !teacherId) {
      return res.status(400).json({ error: "question and teacherId are required" });
    }

    const sanitizedQuestion = sanitizePrompt(question);

    // Check tier & usage
    const { tier } = await getUserTier(userId);
    const usageCheck = await checkAndIncrementUsage(userId, tier);
    if (!usageCheck.allowed) {
      return res.status(429).json({
        error: `Daily limit reached (${usageCheck.limit}/day).`,
        code: "DAILY_LIMIT",
        tier,
      });
    }

    // Get teacher from database
    const { data: teacher, error: teacherError } = await supabase
      .from("teachers")
      .select("*")
      .eq("id", teacherId)
      .eq("is_active", true)
      .single();

    if (teacherError || !teacher) return res.status(404).json({ error: "Teacher not found or inactive" });
    if (teacher.is_pro_only && tier === "free") {
      return res.status(403).json({ error: "PRO only teacher", code: "PRO_REQUIRED" });
    }

    // Fetch NCTB content
    let notesText = "";
    if (chapter) {
      notesText = await fetchNCTBContent({
        subjectName: subject || teacher.subject,
        chapterId: chapter,
        topicTitle: topic,
      });
    }

    const userGroup = req.user.group || "Science";
    const userClass = className || String(req.user.class || 10);

    const systemPrompt = buildSystemPrompt({
      teacher,
      subject: subject || teacher.subject,
      className: userClass,
      group: userGroup,
      chapter: chapter || "General",
      topic: topic || "General",
      notesText,
      question: sanitizedQuestion,
    });

    // Build messages with history
    const messages = [
      ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: sanitizedQuestion },
    ];

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    let fullResponse = "";

    try {
      const streamResponse = await streamOpenRouter(systemPrompt, messages, {
        temperature: 0.3,
        max_tokens: 1024,
      });

      let buffer = "";

      streamResponse.data.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullResponse += content;
              // Forward in the same format the frontend expects
              res.write(`data: ${JSON.stringify({
                choices: [{ delta: { content } }]
              })}\n\n`);
            }
          } catch {
            // Skip unparseable chunks
          }
        }
      });

      streamResponse.data.on("end", () => {
        res.write("data: [DONE]\n\n");
        res.end();

        // Log chat (fire-and-forget)
        logChatMessages(userId, teacherId, sanitizedQuestion, fullResponse, 0);
      });

      streamResponse.data.on("error", (err) => {
        console.error("Stream error:", err.message);
        res.write(`data: ${JSON.stringify({ error: "Stream interrupted" })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });

    } catch (streamErr) {
      console.error("Stream setup error:", streamErr.message);
      res.write(`data: ${JSON.stringify({ error: "AI service unavailable" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    console.error("Stream chat error:", err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: "AI service temporarily unavailable" });
    }
  }
});

// ─── GET /api/ai/usage — Get Usage Stats ─────────────────
/**
 * @swagger
 * /api/ai/usage:
 *   get:
 *     summary: Get current daily AI usage statistics
 *     description: |
 *       Returns the authenticated user's AI question usage for today,
 *       including their subscription tier and remaining quota.
 *
 *       **Limits by tier:**
 *       | Tier | Daily Limit |
 *       |------|-------------|
 *       | free | 3 |
 *       | basic | 15 |
 *       | pro | unlimited (-1) |
 *     tags: [AI Faculty]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Daily AI usage statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 used:
 *                   type: integer
 *                   description: Number of questions used today
 *                   example: 1
 *                 limit:
 *                   type: integer
 *                   description: Daily limit for user's tier (-1 = unlimited)
 *                   example: 3
 *                 remaining:
 *                   type: integer
 *                   description: Questions remaining today (-1 = unlimited)
 *                   example: 2
 *                 tier:
 *                   type: string
 *                   enum: [free, basic, pro]
 *                   description: User's current subscription tier
 *                   example: free
 *             example:
 *               used: 1
 *               limit: 3
 *               remaining: 2
 *               tier: free
 */
router.get("/usage", authMiddleware, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const { tier } = await getUserTier(req.user.id);
  const limit = USAGE_LIMITS[tier] || USAGE_LIMITS.free;

  const { data: usage } = await supabase
    .from("daily_ai_usage")
    .select("questions_used")
    .eq("user_id", req.user.id)
    .eq("date", today)
    .single();

  const used = usage?.questions_used || 0;

  res.json({
    used,
    limit: limit === Infinity ? -1 : limit,
    remaining: limit === Infinity ? -1 : Math.max(0, limit - used),
    tier,
  });
});

// ─── GET /api/ai/history/:teacherId — Chat History ───────
/**
 * @swagger
 * /api/ai/history/{teacherId}:
 *   get:
 *     summary: Get chat history with a specific AI teacher
 *     description: |
 *       Returns the authenticated user's conversation history with a specific
 *       AI teacher, ordered chronologically (oldest first). Max 50 messages.
 *     tags: [AI Faculty]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: teacherId
 *         required: true
 *         description: AI teacher ID
 *         schema:
 *           type: string
 *           enum: [khalid, ayaan, rafiq, nabila, sara, maya, tanvir, imran, fariha, tariq, sofia]
 *         example: khalid
 *       - in: query
 *         name: limit
 *         required: false
 *         description: Max number of messages to return (default 20, max 50)
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 50
 *     responses:
 *       200:
 *         description: Array of chat messages in chronological order
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   role:
 *                     type: string
 *                     enum: [user, assistant]
 *                     description: Who sent the message
 *                   content:
 *                     type: string
 *                     description: Message content
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *                     description: When the message was sent
 *                   tokens_used:
 *                     type: integer
 *                     description: LLM tokens consumed (0 for user messages)
 *             example:
 *               - role: user
 *                 content: "নিউটনের তৃতীয় সূত্র কি?"
 *                 created_at: "2026-04-24T16:30:00.000Z"
 *                 tokens_used: 0
 *               - role: assistant
 *                 content: "নিউটনের তৃতীয় সূত্র অনুযায়ী..."
 *                 created_at: "2026-04-24T16:30:05.000Z"
 *                 tokens_used: 342
 *       500:
 *         description: Database error
 */
router.get("/history/:teacherId", authMiddleware, async (req, res) => {
  const { teacherId } = req.params;
  const msgLimit = Math.min(parseInt(req.query.limit) || 20, 50);

  const { data, error } = await supabase
    .from("ai_chat_logs")
    .select("role, content, created_at, tokens_used")
    .eq("user_id", req.user.id)
    .eq("teacher_id", teacherId)
    .order("created_at", { ascending: false })
    .limit(msgLimit);

  if (error) return res.status(500).json({ error: error.message });

  res.json((data || []).reverse()); // Return in chronological order
});

// ─── GET /api/ai/teachers — List Available Teachers ──────
/**
 * @swagger
 * /api/ai/teachers:
 *   get:
 *     summary: Get all AI Faculty teachers with access info
 *     description: |
 *       Returns the full list of 11 AI teacher personas with their subjects,
 *       personalities, and whether the current user can access them based on
 *       their subscription tier. Pro-only teachers show `accessible: false`
 *       for free-tier users.
 *     tags: [AI Faculty]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of AI teachers
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     description: Unique teacher identifier (use in teacherId fields)
 *                     example: khalid
 *                   name:
 *                     type: string
 *                     description: Display name
 *                     example: "Prof. Khalid"
 *                   subject:
 *                     type: string
 *                     description: Teacher's subject area
 *                     example: Physics
 *                   title:
 *                     type: string
 *                     description: Teacher's honorary title
 *                     example: "The Academic Pillar"
 *                   personality:
 *                     type: string
 *                     enum: [strict, chill, friendly, professional, elite]
 *                     description: Personality archetype
 *                     example: strict
 *                   is_pro_only:
 *                     type: boolean
 *                     description: Whether this teacher requires a Pro subscription
 *                     example: false
 *                   is_active:
 *                     type: boolean
 *                     description: Whether this teacher is currently available
 *                     example: true
 *                   image_url:
 *                     type: string
 *                     nullable: true
 *                     description: Teacher avatar image URL
 *                   glow_color:
 *                     type: string
 *                     description: CSS class for chat UI glow effect
 *                     example: chat-glow-strict
 *                   accessible:
 *                     type: boolean
 *                     description: Whether the current user can chat with this teacher
 *                     example: true
 *             example:
 *               - id: khalid
 *                 name: "Prof. Khalid"
 *                 subject: Physics
 *                 title: "The Academic Pillar"
 *                 personality: strict
 *                 is_pro_only: false
 *                 is_active: true
 *                 image_url: null
 *                 glow_color: chat-glow-strict
 *                 accessible: true
 *               - id: ayaan
 *                 name: "Prof. Ayaan"
 *                 subject: Mathematics
 *                 title: "The Math Magician"
 *                 personality: chill
 *                 is_pro_only: true
 *                 is_active: true
 *                 image_url: null
 *                 glow_color: chat-glow-chill
 *                 accessible: false
 */
router.get("/teachers", authMiddleware, async (req, res) => {
  const { tier } = await getUserTier(req.user.id);
  const teachers = getAccessibleTeachers(tier);
  res.json(teachers);
});

// ─── GET /api/ai/health — AI Provider Health ─────────────
/**
 * @swagger
 * /api/ai/health:
 *   get:
 *     summary: Check status of AI providers (Ollama & Together)
 *     description: |
 *       Returns the availability status of both the local Ollama instance
 *       and the Together AI cloud provider.
 *     tags: [AI Faculty]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Provider status report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 primary: { type: string }
 *                 status:
 *                   type: object
 *                   properties:
 *                     ollama: { type: boolean }
 *                     together: { type: boolean }
 */
router.get("/health", authMiddleware, async (req, res) => {
  const status = await checkHealth();
  const primary = (process.env.AI_PROVIDER || "together").toLowerCase();
  res.json({ primary, status });
});

export default router;
