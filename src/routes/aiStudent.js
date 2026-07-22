import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";
import { callOpenRouter } from "../lib/aiProvider.js";

const router = Router();

// ─── Usage limit constants ────────────────────────────────────────────────────
const DAILY_LIMITS = { free: 3, basic: 15, pro: Infinity };

/** Resolve the user's subscription tier: 'free' | 'basic' | 'pro' */
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

/**
 * Check today's AI Student usage and increment if allowed.
 * Uses a separate counter key so it's independent of the tutor quota.
 */
async function checkAndIncrementAiStudentUsage(userId, tier) {
  const today = new Date().toISOString().split("T")[0];
  const limit = DAILY_LIMITS[tier] ?? DAILY_LIMITS.free;

  const { data: usage } = await supabase
    .from("daily_ai_usage")
    .select("ai_student_used")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  const current = usage?.ai_student_used ?? 0;

  if (limit !== Infinity && current >= limit) {
    return { allowed: false, used: current, limit, remaining: 0 };
  }

  await supabase.from("daily_ai_usage").upsert(
    { user_id: userId, date: today, ai_student_used: current + 1 },
    { onConflict: "user_id,date" }
  );

  return {
    allowed: true,
    used: current + 1,
    limit: limit === Infinity ? -1 : limit,
    remaining: limit === Infinity ? -1 : Math.max(0, limit - (current + 1)),
  };
}

// Helper to clean/parse JSON from AI response
function extractJSON(text) {
  try {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    const jsonStr = match[1].trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      return JSON.parse(text.substring(start, end + 1));
    }
    throw new Error("Failed to parse JSON response from AI");
  }
}

/**
 * @swagger
 * /api/ai-student/options:
 *   get:
 *     summary: Fetch subjects, chapters, and topics/subtopics dynamically for dropdowns
 *     tags: [AI Student]
 *     security:
 *       - bearerAuth: []
 */
router.get("/options", authMiddleware, async (req, res) => {
  try {
    const studentClass = req.user.class || 10;
    const studentGroup = req.user.group || "Science";

    // 1. Fetch subjects matching class and group
    const { data: subjects, error: subjectsError } = await supabase
      .from("subjects")
      .select("id, name, class, group")
      .or(`class.eq.${studentClass},class.is.null`)
      .order("sort_order");

    if (subjectsError) throw subjectsError;

    // Filter group in JS
    const filteredSubjects = (subjects || []).filter((s) => {
      if (!s.group) return true;
      const sg = s.group.toLowerCase();
      return sg === studentGroup.toLowerCase() || sg === "all";
    });

    const subjectIds = filteredSubjects.map((s) => s.id);

    if (subjectIds.length === 0) {
      return res.json({ subjects: [], chapters: [], topics: [] });
    }

    // 2. Fetch chapters for these subjects
    const { data: chapters, error: chaptersError } = await supabase
      .from("chapters")
      .select("id, subject_id, title, sort_order")
      .in("subject_id", subjectIds)
      .order("sort_order");

    if (chaptersError) throw chaptersError;

    const chapterIds = (chapters || []).map((c) => c.id);

    // 3. Fetch subtopics/topics for these chapters
    let topics = [];
    if (chapterIds.length > 0) {
      const { data: subtopicsData, error: subtopicsError } = await supabase
        .from("subtopics")
        .select("id, chapter_id, title, notes_text, sort_order, is_published")
        .in("chapter_id", chapterIds)
        .eq("is_published", true)
        .order("sort_order");

      if (subtopicsError) throw subtopicsError;

      topics = (subtopicsData || []).map((st) => ({
        id: st.id,
        chapter_id: st.chapter_id,
        title: st.title,
        brief: st.notes_text || `${st.title} overview and core concepts.`,
        sort_order: st.sort_order,
      }));
    }

    res.json({
      subjects: filteredSubjects.map((s) => ({ id: s.id, name: s.name })),
      chapters: (chapters || []).map((c) => ({ id: c.id, subject_id: c.subject_id, title: c.title })),
      topics,
    });
  } catch (err) {
    console.error("AI Student Options Error:", err);
    res.status(500).json({ error: "Failed to fetch AI Student options" });
  }
});

/**
 * @swagger
 * /api/ai-student/topic-details:
 *   get:
 *     summary: Fetch brief and details for a selected topic
 *     tags: [AI Student]
 *     security:
 *       - bearerAuth: []
 */
router.get("/topic-details", authMiddleware, async (req, res) => {
  try {
    const { topicId, topicTitle } = req.query;

    if (!topicId && !topicTitle) {
      return res.status(400).json({ error: "topicId or topicTitle is required" });
    }

    let topicData = null;

    if (topicId) {
      const { data, error } = await supabase
        .from("subtopics")
        .select("id, title, notes_text, chapter_id, chapters(title, subject_id, subjects(name))")
        .eq("id", topicId)
        .maybeSingle();

      if (!error && data) {
        topicData = {
          id: data.id,
          title: data.title,
          brief: data.notes_text || `${data.title} overview and core concepts.`,
          chapter: data.chapters?.title || "",
          subject: data.chapters?.subjects?.name || "",
        };
      }
    }

    if (!topicData && topicTitle) {
      topicData = {
        id: topicId || "custom",
        title: topicTitle,
        brief: `${topicTitle} overview and core concepts.`,
        chapter: "",
        subject: "",
      };
    }

    res.json(topicData);
  } catch (err) {
    console.error("AI Student Topic Details Error:", err);
    res.status(500).json({ error: "Failed to fetch topic details" });
  }
});

/**
 * @swagger
 * /api/ai-student/evaluate:
 *   post:
 *     summary: Evaluate student's topic explanation with Sofia AI
 *     tags: [AI Student]
 *     security:
 *       - bearerAuth: []
 */
router.post("/evaluate", authMiddleware, async (req, res) => {
  try {
    const { topic_id, topic_title, student_explanation_text } = req.body;
    const userId = req.user.id;

    if (!student_explanation_text || !student_explanation_text.trim()) {
      return res.status(400).json({ error: "student_explanation_text is required" });
    }

    // ── Rate limiting: 3/day free, 15/day basic, unlimited pro ───────────────
    const tier = await getUserTier(userId);
    const usageCheck = await checkAndIncrementAiStudentUsage(userId, tier);
    if (!usageCheck.allowed) {
      return res.status(429).json({
        error: `Daily evaluation limit reached (${usageCheck.limit}/day on the free plan). Upgrade to PRO for unlimited evaluations!`,
        code: "DAILY_LIMIT",
        tier,
        used: usageCheck.used,
        limit: usageCheck.limit,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const topicName = topic_title || topic_id || "Selected Topic";

    // 1. System Prompt for Sofia's Score Assessment
    const systemPrompt = `You are Mrs. Sofia, an expert academic evaluator and principal AI teacher at Porashona AI.
Your task is to evaluate a student's explanation of the topic: "${topicName}".

Analyze the student's explanation and evaluate their conceptual understanding.
You MUST return ONLY a JSON object with the following strict structure:
{
  "score": <integer from 0 to 10>,
  "assessment_summary": "<A 2-3 sentence overarching summary of the evaluation>",
  "conceptual_strengths": [
    "<Bullet point strength 1>",
    "<Bullet point strength 2>"
  ],
  "knowledge_gaps": [
    "<Bullet point gap 1>",
    "<Bullet point gap 2>"
  ]
}

Rules:
1. "score" must be an integer between 0 and 10.
2. "assessment_summary" must directly reference how well they described "${topicName}".
3. Provide 2 to 3 concise, clear bullet points for "conceptual_strengths".
4. Provide 2 to 3 constructive, clear bullet points for "knowledge_gaps".
5. Respond strictly with valid JSON. No conversational introduction or markdown outside the code block.`;

    const userMessage = `Topic: "${topicName}"\nStudent Explanation: "${student_explanation_text}"`;

    // 2. Call AI Provider (OpenRouter/Gemini)
    const aiResult = await callOpenRouter(systemPrompt, [{ role: "user", content: userMessage }], {
      temperature: 0.2,
      skipCache: true,
    });

    const parsedData = extractJSON(aiResult.content);

    const score = Math.max(0, Math.min(10, Number(parsedData.score ?? 5)));
    const assessmentSummary = parsedData.assessment_summary || `Your explanation of "${topicName}" has been assessed.`;
    const conceptualStrengths = Array.isArray(parsedData.conceptual_strengths) ? parsedData.conceptual_strengths : [];
    const knowledgeGaps = Array.isArray(parsedData.knowledge_gaps) ? parsedData.knowledge_gaps : [];

    // Combine feedback text for storage if needed
    const feedbackText = `${assessmentSummary}\n\nStrengths:\n- ${conceptualStrengths.join("\n- ")}\n\nGaps:\n- ${knowledgeGaps.join("\n- ")}`;

    // 3. Persist evaluation score to Supabase DB (ai_student_scores)
    const { data: scoreRecord, error: dbError } = await supabase
      .from("ai_student_scores")
      .insert({
        user_id: userId,
        topic_id: topic_id || topicName,
        score,
        feedback_text: feedbackText,
      })
      .select()
      .maybeSingle();

    if (dbError) {
      console.error("Warning: Failed to save score to DB:", dbError.message);
    }

    // 4. Return exact structure matching frontend requirements
    res.json({
      score,
      assessment_summary: assessmentSummary,
      conceptual_strengths: conceptualStrengths,
      knowledge_gaps: knowledgeGaps,
      id: scoreRecord?.id || null,
      created_at: scoreRecord?.created_at || new Date().toISOString(),
    });
  } catch (err) {
    console.error("AI Student Evaluation Error:", err);
    res.status(500).json({ error: "Failed to evaluate explanation: " + err.message });
  }
});

export default router;
