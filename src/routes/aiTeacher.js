import { Router } from "express";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import { v4 as uuidv4 } from "uuid";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, requireAdmin } from "../middleware/auth.js";
import { callOpenRouter } from "../lib/aiProvider.js";
import { buildAITeacherLessonPrompt } from "../lib/promptEngine.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Helper to extract JSON from AI response
function extractJSON(text) {
  let jsonStr = text;
  try {
    // 1. Try to extract from markdown blocks
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    jsonStr = match[1].trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    try {
      // 2. Try to find the first '{' and last '}'
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start !== -1) {
        let candidate = end !== -1 ? jsonStr.substring(start, end + 1) : jsonStr.substring(start);
        
        // Simple Repair: If it doesn't end with }, try adding it
        if (!candidate.trim().endsWith('}')) {
          // If it's cut off inside a string, we might need a quote first
          if ((candidate.split('"').length - 1) % 2 !== 0) candidate += '"';
          // Add missing braces
          const openBraces = (candidate.match(/\{/g) || []).length;
          const closeBraces = (candidate.match(/\}/g) || []).length;
          for (let i = 0; i < (openBraces - closeBraces); i++) candidate += '}';
        }
        
        return JSON.parse(candidate);
      }
    } catch (e2) {
      throw new Error("Could not parse or repair JSON: " + e2.message);
    }
    throw e;
  }
}

// Ensure Storage Buckets exist on startup (or first use)
async function ensureBuckets() {
  try {
    const buckets = ["books", "faculty"];
    for (const b of buckets) {
      const { data, error } = await supabase.storage.getBucket(b);
      if (error && error.message.includes("not found")) {
        console.log(`Creating missing storage bucket: ${b}`);
        await supabase.storage.createBucket(b, { public: true });
      }
    }
  } catch (e) {
    console.error("Bucket check failed:", e);
  }
}
ensureBuckets();

/**
 * @swagger
 * /api/ai-teacher/admin/teachers-with-book:
 *   post:
 *     summary: Create a new AI Teacher Persona with an initial Book PDF
 *     tags: [AI Teacher]
 *     security:
 *       - bearerAuth: []
 */
router.post("/admin/teachers-with-book", authMiddleware, requireAdmin, upload.fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'book', maxCount: 1 }
]), async (req, res) => {
  try {
    const { name, teacher_id, subject, title, personality, character_type, tuning_data, class_level } = req.body;
    const avatarFile = req.files['avatar']?.[0];
    const bookFile = req.files['book']?.[0];

    if (!name || !teacher_id) {
      return res.status(400).json({ error: "Teacher name and ID are required" });
    }

    // 1. Upload Avatar if provided
    let imageUrl = null;
    if (avatarFile) {
      const avatarPath = `${uuidv4()}-${avatarFile.originalname}`;
      const { data: avatarUpload, error: avatarError } = await supabase.storage
        .from("faculty")
        .upload(avatarPath, avatarFile.buffer, { contentType: avatarFile.mimetype, upsert: true });
      
      if (avatarError) {
        console.error("Supabase Storage Error (Avatar):", avatarError);
      } else {
        imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/faculty/${avatarUpload.path}`;
      }
    }

    // 2. Create or Update Teacher Persona
    const { data: teacher, error: teacherError } = await supabase
      .from("teachers")
      .upsert([{
        id: teacher_id,
        name,
        subject,
        title,
        personality: personality || 'professional',
        image_url: imageUrl,
        is_active: true
      }], { onConflict: 'id' })
      .select()
      .single();

    if (teacherError) throw teacherError;

    // 2.5 Ensure Subject Exists (Auto-register missing subjects)
    const { data: existingSubject } = await supabase
      .from("subjects")
      .select("id")
      .eq("id", subject)
      .maybeSingle();
    
    if (!existingSubject) {
      console.log(`Auto-creating subject: ${subject}`);
      await supabase
        .from("subjects")
        .insert([{
          id: subject,
          name: subject,
          class: parseInt(class_level) || 10,
          teacher_id: teacher.id
        }]);
    }

    // 3. Generate Curriculum Map (Always, using PDF or Online Reference)
    console.log("Generating curriculum map with AI...");
    let contentText = "";
    let pdfUrl = null;

    if (bookFile) {
      console.log(`Processing book: ${bookFile.originalname} (${bookFile.size} bytes)`);
      const pdfData = await pdf(bookFile.buffer);
      contentText = (pdfData.text || "").trim();
      
      const bookPath = `${uuidv4()}.pdf`; 
      const { data: bookUpload } = await supabase.storage.from("books").upload(bookPath, bookFile.buffer, { contentType: "application/pdf", upsert: true });
      if (bookUpload) {
        const { data: { publicUrl } } = supabase.storage.from("books").getPublicUrl(bookUpload.path);
        pdfUrl = publicUrl;
      }
    }

    let mapPrompt = "";
    if (contentText) {
      mapPrompt = `Analyze the following textbook content and generate a structured list of 10-15 logical learning topics/chapters in order.
      Return ONLY a JSON array of strings. 
      Example: ["Chapter 1: Intro", "Chapter 2: Forces"]
      
      Content: ${contentText.slice(0, 15000)}`;
    } else {
      mapPrompt = `Act as an NCTB expert. Generate the official curriculum structure (list of chapters/topics) for Class ${class_level} ${subject} in Bangladesh.
      ${tuning_data ? `ADHERE TO THESE TUNING INSTRUCTIONS: ${tuning_data}` : ""}
      Return ONLY a JSON array of strings representing the logical order of learning.
      Example: ["Chapter 1: Introduction to Physics", "Chapter 2: Physical Quantities"]`;
    }

    let curriculumMap = [];
    try {
      const mapResult = await callOpenRouter(mapPrompt, [{ role: "user", content: "Extract topics." }], { temperature: 0.1 });
      const jsonMatch = mapResult.content.match(/\[.*\]/s);
      if (jsonMatch) curriculumMap = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("Failed to generate curriculum map:", e);
    }

    // 4. Create/Update the Lesson record
    // Try to find existing lesson first to avoid constraint issues if we don't have the UNIQUE constraint yet
    const { data: existingLesson } = await supabase
      .from("ai_lessons")
      .select("id")
      .eq("teacher_id", teacher.id)
      .eq("class", parseInt(class_level) || 10)
      .eq("subject_id", subject)
      .maybeSingle();

    let lesson;
    if (existingLesson) {
      const { data, error } = await supabase
        .from("ai_lessons")
        .update({
          title: title || `${subject} for Class ${class_level}`,
          description: `Serialized tuition course for ${name}`,
          pdf_url: pdfUrl,
          content_text: contentText,
          curriculum_map: curriculumMap,
          character_type: character_type || 'friendly',
          tuning_data,
          is_active: true
        })
        .eq("id", existingLesson.id)
        .select()
        .single();
      if (error) throw error;
      lesson = data;
    } else {
      const { data, error } = await supabase
        .from("ai_lessons")
        .insert([{
          teacher_id: teacher.id,
          subject_id: subject,
          title: title || `${subject} for Class ${class_level}`,
          description: `Serialized tuition course for ${name}`,
          pdf_url: pdfUrl,
          content_text: contentText,
          curriculum_map: curriculumMap,
          character_type: character_type || 'friendly',
          tuning_data,
          class: parseInt(class_level) || 10,
          is_active: true
        }])
        .select()
        .single();
      if (error) throw error;
      lesson = data;
    }

    res.json({ teacher, lesson });
  } catch (err) {
    console.error("Unified Creator Error:", err);
    res.status(500).json({ error: "Failed to create teacher/lesson: " + err.message });
  }
});

// ─── STUDENT ENDPOINTS ────────────────────────────────────

/**
 * @swagger
 * /api/ai-teacher/lessons:
 *   get:
 *     summary: List available AI lessons for the student
 *     tags: [AI Teacher]
 */
router.get("/lessons", authMiddleware, async (req, res) => {
  try {
    const userClass = req.user.class || 10;
    const isAdmin = req.user.role === 'admin';
    
    console.log(`Fetching lessons for User: ${req.user.id}, Class: ${userClass}, Role: ${req.user.role}`);

    let query = supabase
      .from("ai_lessons")
      .select("*, teachers(name, image_url, subject)")
      .eq("is_active", true);

    // Only filter by class if NOT an admin (for testing convenience)
    if (!isAdmin) {
      query = query.eq("class", userClass);
    }

    const { data: lessons, error } = await query;

    if (error) throw error;
    console.log(`Found ${lessons.length} lessons.`);
    res.json(lessons);
  } catch (err) {
    console.error("Fetch Lessons Error:", err);
    res.status(500).json({ error: "Failed to fetch lessons" });
  }
});

/**
 * @swagger
 * /api/ai-teacher/lessons/{id}/session:
 *   get:
 *     summary: Get current session or start a new one
 *     tags: [AI Teacher]
 */
router.get("/lessons/:id/session", authMiddleware, async (req, res) => {
  try {
    const { id: lessonId } = req.params;
    const userId = req.user.id;

    const { data: session, error } = await supabase
      .from("ai_lesson_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("lesson_id", lessonId)
      .maybeSingle();

    if (error) throw error;

    if (!session) {
      // Start new session
      const { data: newSession, error: createError } = await supabase
        .from("ai_lesson_sessions")
        .insert([{ user_id: userId, lesson_id: lessonId }])
        .select()
        .single();
      
      if (createError) throw createError;
      return res.json(newSession);
    }

    res.json(session);
  } catch (err) {
    res.status(500).json({ error: "Failed to handle session" });
  }
});

/**
 * @swagger
 * /api/ai-teacher/lessons/{id}/next:
 *   post:
 *     summary: Get the next part of the lesson (Brief or Quiz)
 *     tags: [AI Teacher]
 */
router.post("/lessons/:id/next", authMiddleware, async (req, res) => {
  try {
    const { id: lessonId } = req.params;
    const userId = req.user.id;

    // 1. Get session and lesson
    const { data: session } = await supabase
      .from("ai_lesson_sessions")
      .select("*, ai_lessons(*, teachers(*))")
      .eq("user_id", userId)
      .eq("lesson_id", lessonId)
      .single();

    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.completed) return res.json({ completed: true, message: "Lesson already finished!" });

    const lesson = session.ai_lessons;
    const teacher = lesson.teachers;

    // 2. Decide next state
    // If current state is 'briefing', next is 'quizzing'
    // If current state is 'quizzing' (and they are calling /next), it means they need a new brief or re-brief
    // For simplicity: /next always returns the next thing to DO.
    
    let targetState = session.current_state;
    
    // 3. Call AI
    const systemPrompt = buildAITeacherLessonPrompt({
      teacher,
      lesson,
      state: targetState,
      topicIndex: session.current_topic_index,
      lastBriefing: session.last_briefing
    });

    const result = await callOpenRouter(systemPrompt, [{ role: "user", content: "Continue the lesson." }], {
      skipCache: targetState === "quizzing" // Always generate fresh quizzes
    });
    const content = result.content;

    // 4. Update session based on what was generated
    const updates = { last_active_at: new Date() };

    if (targetState === "briefing") {
      updates.last_briefing = content;
      updates.current_state = "quizzing"; // Move to quiz after briefing
    } else if (targetState === "quizzing") {
      try {
        const quiz = extractJSON(content);
        updates.last_quiz_json = quiz;
        // Stay in quizzing state until answered
      } catch (e) {
        console.error("Failed to parse quiz JSON:", content);
        // Fallback for truncated/broken JSON
        return res.status(500).json({ 
          error: "AI generated an incomplete quiz. Retrying...",
          raw: content 
        });
      }
    }

    await supabase.from("ai_lesson_sessions").update(updates).eq("id", session.id);

    res.json({
      state: targetState,
      content: targetState === "quizzing" ? updates.last_quiz_json : content,
      nextState: updates.current_state || targetState
    });

  } catch (err) {
    console.error("AI Next Error:", err);
    res.status(500).json({ error: "AI Teacher is busy. Try again." });
  }
});

/**
 * @swagger
 * /api/ai-teacher/lessons/{id}/submit:
 *   post:
 *     summary: Submit an answer to the current quiz
 *     tags: [AI Teacher]
 */
router.post("/lessons/:id/submit", authMiddleware, async (req, res) => {
  try {
    const { id: lessonId } = req.params;
    const { answer } = req.body;
    const userId = req.user.id;

    const { data: session } = await supabase
      .from("ai_lesson_sessions")
      .select("*, ai_lessons(*, teachers(*))")
      .eq("user_id", userId)
      .eq("lesson_id", lessonId)
      .single();

    if (!session || session.current_state !== "quizzing") {
      return res.status(400).json({ error: "No active quiz for this session." });
    }

    const lesson = session.ai_lessons;
    const teacher = lesson.teachers;
    const quiz = session.last_quiz_json;
    
    const isCorrect = answer.trim().toLowerCase() === quiz.correctAnswer.trim().toLowerCase();

    // Call AI for feedback
    const systemPrompt = buildAITeacherLessonPrompt({
      teacher,
      lesson,
      state: "feedback",
      topicIndex: session.current_topic_index,
      lastBriefing: session.last_briefing
    });

    const userMessage = `My answer: "${answer}". Correct answer: "${quiz.correctAnswer}". Result: ${isCorrect ? "Correct" : "Wrong"}. Provide feedback.`;
    const result = await callOpenRouter(systemPrompt, [{ role: "user", content: userMessage }]);
    const feedback = result.content;

    const updates = { last_active_at: new Date() };

    if (isCorrect) {
      // Move to next topic
      updates.current_topic_index = session.current_topic_index + 1;
      updates.current_state = "briefing";
      updates.attempts_at_current_topic = 0;
      
      // Check if finished (simple heuristic: if we ran out of content or reached a certain index)
      // For now, let the AI decide or just keep going.
    } else {
      // Repeat current topic
      updates.current_state = "briefing"; // Brief them again
      updates.attempts_at_current_topic = session.attempts_at_current_topic + 1;
    }

    await supabase.from("ai_lesson_sessions").update(updates).eq("id", session.id);

    res.json({
      correct: isCorrect,
      feedback,
      nextState: updates.current_state,
      explanation: quiz.explanation
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to process answer." });
  }
});

export default router;
