import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";

const router = Router();

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
 *     responses:
 *       200:
 *         description: Quiz details with questions
 *       404:
 *         description: No quiz found
 */
router.get("/chapter/:chapterId", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("quizzes")
      .select("*, questions(*)")
      .eq("chapter_id", req.params.chapterId)
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
 *     responses:
 *       200:
 *         description: Quiz details with questions
 *       404:
 *         description: No quiz found
 */
router.get("/subtopic/:subtopicId", authMiddleware, async (req, res) => {
  try {
    console.log(`Fetching quiz for subtopic: ${req.params.subtopicId} by user: ${req.user.id}`);
    
    const { data, error } = await supabase
      .from("quizzes")
      .select("*, questions(*)")
      .eq("subtopic_id", req.params.subtopicId)
      .maybeSingle();

    if (error) {
       console.error(`Error fetching quiz for subtopic ${req.params.subtopicId}:`, error);
       throw error;
    }

    if (!data) {
      console.warn(`No quiz found for subtopic: ${req.params.subtopicId}`);
      return res.status(404).json({ 
        error: "No quiz found for this subtopic",
        debug: { requestedSubtopicId: req.params.subtopicId }
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
      completed_at: new Date().toISOString(),
    };

    const { data: attempt, error: attemptError } = await supabase
      .from("quiz_attempts")
      .insert([attemptData])
      .select()
      .single();

    if (attemptError) throw attemptError;

    // 5. Update User XP and Streak
    await supabase.rpc("increment_xp", { 
      user_id: req.user.id, 
      amount: xpEarned 
    });

    // Check streak
    const today = new Date().toISOString().split("T")[0];
    if (req.user.last_active_date !== today) {
      await supabase
        .from("users")
        .update({ 
          last_active_date: today,
          streak: (req.user.streak || 0) + 1 
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
  const { id, chapter_id, subtopic_id, title, description, questions } = req.body;

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
      description 
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

export default router;
