import { Router } from "express";
import axios from "axios";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import { callOpenRouter } from "../lib/aiProvider.js";

const router = Router();

// Usage limits per tier for Quiz Generation (2 per day on free)
const QUIZ_DAILY_LIMITS = { free: 2, basic: 10, pro: Infinity };

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

  if (!sub) return "free";
  const planId = (sub.plan_id || "").toLowerCase();
  if (planId.includes("pro") || planId.includes("premium")) return "pro";
  if (planId.includes("basic") || planId.includes("starter")) return "basic";
  return "basic";
}

async function checkAndIncrementQuizUsage(userId, tier) {
  const today = new Date().toISOString().split("T")[0];
  const limit = QUIZ_DAILY_LIMITS[tier] ?? QUIZ_DAILY_LIMITS.free;

  const { data: usage } = await supabase
    .from("daily_ai_usage")
    .select("quiz_gen_used")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  const current = usage?.quiz_gen_used ?? 0;

  if (limit !== Infinity && current >= limit) {
    return { allowed: false, used: current, limit, remaining: 0 };
  }

  await supabase.from("daily_ai_usage").upsert(
    { user_id: userId, date: today, quiz_gen_used: current + 1 },
    { onConflict: "user_id,date" }
  );

  return {
    allowed: true,
    used: current + 1,
    limit: limit === Infinity ? -1 : limit,
    remaining: limit === Infinity ? -1 : Math.max(0, limit - (current + 1)),
  };
}

/**
 * @swagger
 * /quiz/chapter/{chapterId}:
 *   get:
 *     summary: Get quiz for a chapter
 *     tags: [Quiz]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema: { type: string }
 *         description: UUID of the chapter
 *       - in: query
 *         name: isExam
 *         schema: { type: boolean }
 *         description: Filter for exams vs regular quizzes
 *     responses:
 *       200:
 *         description: Quiz details with questions
 *       404:
 *         description: No quiz found
 */
router.get("/chapter/:chapterId", authMiddleware, async (req, res) => {
  const { isExam } = req.query;
  try {
    // Filter by is_exam (default to false if not specified)
    // This prevents PGRST116 errors when both a practice quiz and an exam exist
    const isExamBool = isExam === "true";
    
    const { data, error } = await supabase
      .from("quizzes")
      .select("*, questions(*)")
      .eq("chapter_id", req.params.chapterId)
      .eq("is_exam", isExamBool)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "No quiz found for this chapter" });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /quiz/subtopic/{subtopicId}:
 *   get:
 *     summary: Get quiz for a subtopic
 *     tags: [Quiz]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subtopicId
 *         required: true
 *         schema: { type: string }
 *         description: UUID of the subtopic
 *       - in: query
 *         name: isExam
 *         schema: { type: boolean }
 *         description: Filter for exams vs regular quizzes
 *     responses:
 *       200:
 *         description: Quiz details with questions
 *       404:
 *         description: No quiz found
 */
router.get("/subtopic/:subtopicId", authMiddleware, async (req, res) => {
  const { isExam } = req.query;
  try {
    console.log(`Fetching quiz for subtopic: ${req.params.subtopicId} by user: ${req.user.id}, isExam: ${isExam}`);
    
    // Filter by is_exam (default to false if not specified)
    // This prevents PGRST116 errors when both a practice quiz and an exam exist
    const isExamBool = isExam === "true";

    const { data, error } = await supabase
      .from("quizzes")
      .select("*, questions(*)")
      .eq("subtopic_id", req.params.subtopicId)
      .eq("is_exam", isExamBool)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
       console.error(`Error fetching quiz for subtopic ${req.params.subtopicId}:`, error);
       throw error;
    }

    if (!data) {
      console.warn(`No quiz found for subtopic: ${req.params.subtopicId}`);
      return res.status(404).json({ 
        error: "No quiz found for this subtopic",
        debug: { requestedSubtopicId: req.params.subtopicId, isExam }
      });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /quiz/submit:
 *   post:
 *     summary: Submit quiz answers and calculate XP
 *     tags: [Quiz]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [quizId, answers]
 *             properties:
 *               quizId: { type: string }
 *               answers: 
 *                 type: array
 *                 items: { type: integer }
 *                 description: Array of selected option indices
 *               timeTaken: 
 *                 type: integer
 *                 description: Time spent on quiz in seconds
 *     responses:
 *       200:
 *         description: Results and XP earned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 score: { type: integer }
 *                 totalQuestions: { type: integer }
 *                 xpEarned: { type: integer }
 *                 attemptId: { type: string }
 */
router.post("/submit", authMiddleware, async (req, res) => {
  const { quizId, answers, timeTaken } = req.body;

  try {
    // 1. Fetch quiz and questions
    const { data: quiz, error: quizError } = await supabase
      .from("quizzes")
      .select("*, questions(*)")
      .eq("id", quizId)
      .single();

    if (quizError || !quiz) return res.status(404).json({ error: "Quiz not found" });

    // 2. Calculate score
    let score = 0;
    const questions = quiz.questions || [];
    const totalQuestions = questions.length;

    questions.forEach((q, index) => {
      if (answers[index] === q.correct_answer_index) {
        score++;
      }
    });

    // 3. Calculate XP (e.g., 10 XP per correct answer + 20 bonus for full completion)
    let xpEarned = score * 10;
    if (score === totalQuestions && totalQuestions > 0) {
      xpEarned += 20;
    }

    // 4. Save attempt
    const attemptData = {
      user_id: req.user.id,
      quiz_id: quizId,
      chapter_id: quiz.chapter_id,
      subtopic_id: quiz.subtopic_id,
      score,
      total_questions: totalQuestions,
      time_taken_seconds: timeTaken || 0,
      xp_earned: xpEarned,
      is_exam_attempt: quiz.is_exam, // Mark if this was an exam attempt
      completed_at: new Date().toISOString(),
    };

    const { data: attempt, error: attemptError } = await supabase
      .from("quiz_attempts")
      .insert([attemptData])
      .select()
      .single();

    if (attemptError) throw attemptError;

    // 5. Award points via the canonical award_points function (→ points_ledger)
    //    The legacy increment_xp RPC and direct users.xp mutation are no longer used.
    if (xpEarned > 0) {
      const { error: rpcErr } = await supabase.rpc("award_points", {
        p_user_id: req.user.id,
        p_reason: "quiz_complete",
        p_custom_delta: xpEarned,
      });
      if (rpcErr) console.error("award_points RPC error (quiz):", rpcErr.message);
    }

    // Streak update (display field only, not gamification balance)
    const today = new Date().toISOString().split("T")[0];
    if (req.user.last_active_date !== today) {
      await supabase
        .from("users")
        .update({
          last_active_date: today,
          streak: (req.user.streak || 0) + 1,
        })
        .eq("id", req.user.id);
    }


    res.json({
      score,
      totalQuestions,
      xpEarned,
      attemptId: attempt.id
    });
  } catch (err) {
    console.error("Quiz submission error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- ADMIN ROUTES ---

/**
 * @swagger
 * /quiz:
 *   post:
 *     summary: Create or update a quiz (Admin)
 *     tags: [Admin Quiz]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, questions]
 *             properties:
 *               id: { type: string, description: "UUID if updating existing quiz" }
 *               chapter_id: { type: string }
 *               subtopic_id: { type: string }
 *               title: { type: string }
 *               description: { type: string }
 *               is_exam: { type: boolean }
 *               time_limit_seconds: { type: integer }
 *               passing_score: { type: integer }
 *               max_attempts: { type: integer }
 *               questions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     question_text: { type: string }
 *                     options: { type: array, items: { type: string } }
 *                     correct_answer_index: { type: integer }
 *                     explanation: { type: string }
 *     responses:
 *       200:
 *         description: Quiz saved successfully
 */
router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  const { 
    id, chapter_id, subtopic_id, title, description, questions, 
    is_exam, time_limit_seconds, passing_score, max_attempts 
  } = req.body;

  // 1. Sanitize IDs (convert empty strings to null)
  const targetChapter = chapter_id || null;
  const targetSubtopic = subtopic_id || null;

  // 2. Validate "one_target" constraint
  if ((targetChapter && targetSubtopic) || (!targetChapter && !targetSubtopic)) {
    return res.status(400).json({ 
      error: "A quiz must be linked to EXACTLY one target: either a chapter or a subtopic." 
    });
  }

  try {
    let quizId = id;

    // 3. Upsert Quiz
    const quizPayload = { 
      chapter_id: targetChapter, 
      subtopic_id: targetSubtopic, 
      title, 
      description,
      is_exam: is_exam || false,
      time_limit_seconds: time_limit_seconds || null,
      passing_score: passing_score || 0,
      max_attempts: max_attempts || null
    };
    if (id) {
      const { error } = await supabase.from("quizzes").update(quizPayload).eq("id", id);
      if (error) throw error;
    } else {
      const { data, error } = await supabase.from("quizzes").insert([quizPayload]).select().single();
      if (error) throw error;
      quizId = data.id;
    }

    // 2. Handle Questions (Full replace for simplicity in this version)
    if (questions && Array.isArray(questions)) {
      // Delete old questions if updating
      if (id) {
        await supabase.from("questions").delete().eq("quiz_id", quizId);
      }

      const questionsPayload = questions.map((q, index) => ({
        quiz_id: quizId,
        question_text: q.question_text,
        options: q.options,
        correct_answer_index: q.correct_answer_index,
        explanation: q.explanation,
        sort_order: q.sort_order || index,
      }));

      const { error: qError } = await supabase.from("questions").insert(questionsPayload);
      if (qError) throw qError;
    }

    res.json({ message: "Quiz saved successfully", quizId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /quiz/attempts/me:
 *   get:
 *     summary: Get current authenticated user's quiz attempts
 *     tags: [Quiz]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of user's past quiz attempts
 */
router.get("/attempts/me", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("quiz_attempts")
      .select(`
        *,
        quizzes (title)
      `)
      .eq("user_id", req.user.id)
      .order("completed_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /quiz/generate — AI Note-Based Quiz Generator ──────────────────
/**
 * @swagger
 * /quiz/generate:
 *   post:
 *     summary: Generate interactive quiz questions from a study note
 *     description: |
 *       Fetches the user's generated note content, sends it to AI (Gemini),
 *       and generates the specified number of multiple choice questions (5, 10, 15)
 *       with custom difficulty (easy, medium, hard, mixed).
 *     tags: [Quiz]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [note_id]
 *             properties:
 *               note_id: { type: string }
 *               count: { type: integer, enum: [5, 10, 15], default: 10 }
 *               difficulty: { type: string, enum: [easy, medium, hard, mixed], default: mixed }
 *               language: { type: string, default: en }
 *     responses:
 *       200:
 *         description: Quiz generated successfully
 *       400:
 *         description: Invalid parameters
 *       404:
 *         description: Note not found
 *       500:
 *         description: Generation failed
 */
router.post("/generate", authMiddleware, async (req, res) => {
  const { note_id, count = 10, difficulty = "mixed", language = "en" } = req.body;
  const userId = req.user.id;

  if (!note_id) {
    return res.status(400).json({ error: "note_id is required" });
  }

  // Rate limiting: max 2 per day on free plan
  const tier = await getUserTier(userId);
  const usageCheck = await checkAndIncrementQuizUsage(userId, tier);
  if (!usageCheck.allowed) {
    return res.status(429).json({
      error: `Daily quiz generation limit reached (${usageCheck.limit}/day on free plan). Upgrade to PRO for unlimited quizzes!`,
      code: "DAILY_LIMIT",
      tier,
      used: usageCheck.used,
      limit: usageCheck.limit,
    });
  }

  const validCounts = [5, 10, 15];
  const questionCount = validCounts.includes(Number(count)) ? Number(count) : 10;
  const validDifficulties = ["easy", "medium", "hard", "mixed"];
  const quizDifficulty = validDifficulties.includes(difficulty) ? difficulty : "mixed";

  try {
    // 1. Fetch note record from generated_notes
    const { data: note, error: fetchErr } = await supabase
      .from("generated_notes")
      .select("*")
      .eq("id", note_id)
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    let noteText = "";
    let noteTitle = note?.title || "Study Note";

    if (note) {
      // 2. Fetch note content HTML/text from generated_pdf_url or source_file_url
      const targetUrl = note.generated_pdf_url || note.source_file_url;
      if (targetUrl) {
        try {
          const fetchRes = await axios.get(targetUrl, { timeout: 8000 });
          if (typeof fetchRes.data === "string") {
            // Strip HTML tags for clean text content
            noteText = fetchRes.data.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
          }
        } catch (e) {
          console.warn("Could not fetch content from note URL:", e.message);
        }
      }
    }

    if (!noteText) {
      noteText = `Topic: ${noteTitle}. Provide standard academic practice questions for this subject.`;
    }

    // 3. Build AI prompt
    const prompt = `You are an expert exam setter. Based on the following study note content, generate EXACTLY ${questionCount} multiple-choice quiz questions.

STUDY NOTE TITLE: ${noteTitle}
DIFFICULTY LEVEL: ${quizDifficulty}
LANGUAGE: ${language === "bn" ? "Bangla" : "English"}

SOURCE CONTENT:
---
${noteText.slice(0, 10000)}
---

REQUIREMENTS:
1. Generate EXACTLY ${questionCount} questions.
2. Each question MUST have exactly 4 distinct options.
3. Indicate the zero-based index (0, 1, 2, or 3) of the correct answer in "correct_answer_index".
4. Provide a clear, concise explanation (1-2 sentences) for why the correct answer is right.
5. Return ONLY a JSON object in the exact format specified below, with no markdown fences, no leading/trailing text.

EXPECTED JSON FORMAT:
{
  "title": "${noteTitle} Practice Quiz",
  "questions": [
    {
      "question_text": "The question string here",
      "options": ["Option 0", "Option 1", "Option 2", "Option 3"],
      "correct_answer_index": 0,
      "explanation": "Explanation here..."
    }
  ]
}`;

    // 4. Call AI provider
    const aiRes = await callOpenRouter(
      "You are a precise JSON generator for academic quizzes. Output only JSON.",
      [{ role: "user", content: prompt }],
      { temperature: 0.3, max_tokens: 4000, skipCache: true }
    );

    let rawContent = aiRes.content.trim();
    rawContent = rawContent
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsedJSON;
    try {
      parsedJSON = JSON.parse(rawContent);
    } catch (parseErr) {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) {
        parsedJSON = JSON.parse(match[0]);
      } else {
        throw new Error("Failed to parse AI quiz output as JSON");
      }
    }

    const questions = parsedJSON.questions || [];

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("AI returned empty question set");
    }

    // 5. Store generated quiz in generated_quizzes table (optional / fire & forget)
    let savedQuizId = null;
    try {
      const { data: quizRecord } = await supabase
        .from("generated_quizzes")
        .insert({
          note_id: note ? note.id : null,
          questions: questions,
          difficulty: quizDifficulty,
          question_count: questions.length,
        })
        .select("id")
        .single();
      if (quizRecord) savedQuizId = quizRecord.id;
    } catch (dbErr) {
      console.warn("Could not save to generated_quizzes:", dbErr.message);
    }

    return res.json({
      id: savedQuizId || `quiz-${Date.now()}`,
      note_id: note_id,
      title: parsedJSON.title || `${noteTitle} Practice Quiz`,
      difficulty: quizDifficulty,
      question_count: questions.length,
      questions: questions,
    });
  } catch (err) {
    console.error("AI Quiz generation error:", err);
    return res.status(500).json({ error: err.message || "Failed to generate AI quiz." });
  }
});

export default router;
