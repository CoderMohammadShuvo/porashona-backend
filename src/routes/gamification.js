import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

// ==========================================
// 1. SESSION MANAGEMENT ENDPOINTS
// ==========================================

/**
 * Start a Pomodoro study session
 */
router.post("/session/start", authMiddleware, async (req, res) => {
  const { note_id } = req.body;
  if (!note_id) return res.status(400).json({ error: "note_id is required" });

  const userId = req.user.id;

  try {
    // Check if there is an active session for this user
    const { data: activeSession } = await supabase
      .from("study_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (activeSession) {
      return res.status(400).json({ error: "You already have an active study session" });
    }

    const now = new Date();
    // 15-minute study lock window
    const lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

    const { data: session, error } = await supabase
      .from("study_sessions")
      .insert({
        user_id: userId,
        note_id,
        status: "active",
        started_at: now.toISOString(),
        locked_until: lockedUntil.toISOString(),
        note_opened_at: now.toISOString(),
        penalty_count: 0
      })
      .select()
      .single();

    if (error) throw error;

    res.json(session);
  } catch (err) {
    console.error("Start session error:", err);
    res.status(500).json({ error: "Failed to start study session" });
  }
});

/**
 * Pause study session
 */
router.post("/session/pause", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: activeSession } = await supabase
      .from("study_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (!activeSession) {
      return res.status(400).json({ error: "No active study session found" });
    }

    const { data: session, error } = await supabase
      .from("study_sessions")
      .update({ status: "paused" })
      .eq("id", activeSession.id)
      .select()
      .single();

    if (error) throw error;

    res.json(session);
  } catch (err) {
    console.error("Pause session error:", err);
    res.status(500).json({ error: "Failed to pause study session" });
  }
});

/**
 * Resume study session
 */
router.post("/session/resume", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: pausedSession } = await supabase
      .from("study_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "paused")
      .maybeSingle();

    if (!pausedSession) {
      return res.status(400).json({ error: "No paused study session found" });
    }

    // Extend study lock window if needed
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

    const { data: session, error } = await supabase
      .from("study_sessions")
      .update({
        status: "active",
        locked_until: lockedUntil.toISOString()
      })
      .eq("id", pausedSession.id)
      .select()
      .single();

    if (error) throw error;

    res.json(session);
  } catch (err) {
    console.error("Resume session error:", err);
    res.status(500).json({ error: "Failed to resume study session" });
  }
});

/**
 * Skip study session
 */
router.post("/session/skip", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: activeSession } = await supabase
      .from("study_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (!activeSession) {
      return res.status(400).json({ error: "No active study session found" });
    }

    const { data: session, error } = await supabase
      .from("study_sessions")
      .update({ status: "skipped" })
      .eq("id", activeSession.id)
      .select()
      .single();

    if (error) throw error;

    res.json(session);
  } catch (err) {
    console.error("Skip session error:", err);
    res.status(500).json({ error: "Failed to skip study session" });
  }
});

/**
 * Complete study session
 */
router.post("/session/complete", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const { data: activeSession } = await supabase
      .from("study_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (!activeSession) {
      return res.status(400).json({ error: "No active study session found" });
    }

    // Complete session
    const { data: session, error } = await supabase
      .from("study_sessions")
      .update({ status: "completed" })
      .eq("id", activeSession.id)
      .select()
      .single();

    if (error) throw error;

    // Award +10 points for note complete
    const { data: awarded, error: rpcError } = await supabase.rpc("award_points", {
      p_user_id: userId,
      p_reason: "note_complete"
    });

    if (rpcError) console.error("Failed to award points for note completion:", rpcError);

    res.json({
      session,
      points_awarded: awarded || 0
    });
  } catch (err) {
    console.error("Complete session error:", err);
    res.status(500).json({ error: "Failed to complete study session" });
  }
});


// ==========================================
// 2. QUIZ SUBMISSION ENDPOINT
// ==========================================

router.post("/quiz/submit", authMiddleware, async (req, res) => {
  const { note_id, score, total_questions, difficulty } = req.body;
  if (!note_id || score === undefined || !total_questions || !difficulty) {
    return res.status(400).json({ error: "note_id, score, total_questions, and difficulty are required" });
  }

  const userId = req.user.id;

  try {
    // 1. Verify that a session exists where note_opened_at was stamped
    const { data: session } = await supabase
      .from("study_sessions")
      .select("note_opened_at")
      .eq("user_id", userId)
      .eq("note_id", note_id)
      .not("note_opened_at", "is", null)
      .limit(1)
      .maybeSingle();

    if (!session) {
      return res.status(403).json({ error: "Quiz locked: you must open/study the note before attempting the quiz" });
    }

    // 2. Check if a prior attempt exists for user + note + difficulty
    const { data: priorAttempt } = await supabase
      .from("quiz_attempts")
      .select("id")
      .eq("user_id", userId)
      .eq("note_id", note_id)
      .eq("difficulty", difficulty)
      .limit(1)
      .maybeSingle();

    const isFirstAttempt = !priorAttempt;

    // 3. Insert quiz attempt
    const { data: attempt, error: insertError } = await supabase
      .from("quiz_attempts")
      .insert({
        user_id: userId,
        note_id,
        score,
        total_questions,
        difficulty,
        is_first_attempt: isFirstAttempt,
        question_count: total_questions
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // 4. Award points if first attempt
    let pointsAwarded = 0;
    if (isFirstAttempt) {
      const { data: awarded, error: rpcError } = await supabase.rpc("award_points", {
        p_user_id: userId,
        p_reason: "quiz_complete"
      });
      if (rpcError) console.error("Failed to award points for quiz completion:", rpcError);
      else pointsAwarded = awarded;
    }

    res.json({
      attempt,
      points_awarded: pointsAwarded
    });

  } catch (err) {
    console.error("Quiz submit error:", err);
    res.status(500).json({ error: "Failed to submit quiz attempt" });
  }
});


// ==========================================
// 3. STREAK RESTORE ENDPOINT
// ==========================================

router.post("/streak/restore", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    // Get current streak record
    const { data: streak, error: fetchError } = await supabase
      .from("streaks")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (!streak) {
      return res.status(404).json({ error: "No streak record found for this user" });
    }

    if (streak.lives_remaining <= 0) {
      return res.status(400).json({ error: "No lives remaining to restore streak" });
    }

    // Restore action: Set streak to 3 (restored streaks resume at Day 3), decrement lives remaining by 1
    const { data: updatedStreak, error: updateError } = await supabase
      .from("streaks")
      .update({
        current_streak_day: 3,
        lives_remaining: streak.lives_remaining - 1,
        restored_at: new Date().toISOString()
      })
      .eq("user_id", userId)
      .select()
      .single();

    if (updateError) throw updateError;

    // -- TODO: confirm life regeneration cadence with product owner
    res.json({
      success: true,
      streak: updatedStreak
    });
  } catch (err) {
    console.error("Restore streak error:", err);
    res.status(500).json({ error: "Failed to restore streak" });
  }
});


// ==========================================
// 4. PREFERENCES AND PRIORITIES
// ==========================================

router.get("/preferences", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("study_hours_preference")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (error) throw error;
    res.json(data || { user_id: req.user.id, hours_per_day: 2 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/preferences", authMiddleware, async (req, res) => {
  const { hours_per_day } = req.body;
  if (hours_per_day === undefined) return res.status(400).json({ error: "hours_per_day is required" });

  try {
    const { data, error } = await supabase
      .from("study_hours_preference")
      .upsert({ user_id: req.user.id, hours_per_day })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/priorities", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("subject_priority")
      .select("*")
      .eq("user_id", req.user.id)
      .order("rank", { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/priorities", authMiddleware, async (req, res) => {
  const { priorities } = req.body; // array of { subject_id, rank }
  if (!priorities || !Array.isArray(priorities)) {
    return res.status(400).json({ error: "priorities array is required" });
  }

  try {
    // Delete existing
    await supabase.from("subject_priority").delete().eq("user_id", req.user.id);

    // Insert new
    const inserts = priorities.map((p) => ({
      user_id: req.user.id,
      subject_id: p.subject_id,
      rank: p.rank
    }));

    const { data, error } = await supabase
      .from("subject_priority")
      .insert(inserts)
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==========================================
// 5. STUDY SCHEDULER
// ==========================================

router.get("/scheduler", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. Read study hours preference (default to 2 hours if not set)
    const { data: pref } = await supabase
      .from("study_hours_preference")
      .select("hours_per_day")
      .eq("user_id", userId)
      .maybeSingle();

    const hours = pref?.hours_per_day || 2;
    // Simple average-note-duration divisor: assume 30 minutes per note
    const averageNoteDurationMinutes = 30;
    const notesCountNeeded = Math.ceil((hours * 60) / averageNoteDurationMinutes);

    // 2. Read subject priorities ordered by rank
    const { data: priorities } = await supabase
      .from("subject_priority")
      .select("subject_id")
      .eq("user_id", userId)
      .order("rank", { ascending: true });

    // 3. Select notes from top prioritized subjects first
    // In this basic version, we query active subtopics/lessons/notes from database
    const prioritySubjectIds = priorities?.map(p => p.subject_id) || [];

    // Let's query lessons/subtopics matching priority subjects
    let query = supabase.from("subtopics").select("id, title, chapter_id, duration_seconds");
    if (prioritySubjectIds.length > 0) {
      // In a real database, chapters link to subjects. For simple mock scheduling,
      // we query up to notesCountNeeded
    }

    const { data: subtopics } = await query.limit(notesCountNeeded);

    res.json({
      hours_preference: hours,
      notes_queued_count: notesCountNeeded,
      queued_notes: subtopics || []
    });
  } catch (err) {
    console.error("Scheduler error:", err);
    res.status(500).json({ error: "Failed to run study scheduler" });
  }
});


// ==========================================
// 6. STUDY CALENDAR DATA
// ==========================================

router.get("/calendar", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { start_date, end_date } = req.query;

  try {
    let query = supabase
      .from("study_sessions")
      .select("status, created_at")
      .eq("user_id", userId);

    if (start_date) query = query.gte("created_at", start_date);
    if (end_date) query = query.lte("created_at", end_date);

    const { data: sessions } = await query;

    const { data: streak } = await supabase
      .from("streaks")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    res.json({
      sessions: sessions || [],
      streak: streak || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==========================================
// 7. EXAM COUNTDOWN
// ==========================================

router.get("/countdown", authMiddleware, async (req, res) => {
  // Check if curriculum/class maps to HSC, SSC, O Level, or A Level
  // In the users table, we have 'group' and 'class' or custom attributes
  const group = req.user.group || "";
  const studentClass = req.user.class || 10;

  let curriculum = null;
  if (studentClass === 10) curriculum = "SSC";
  else if (studentClass === 12) curriculum = "HSC";
  else if (group.toLowerCase().includes("o level") || group.toLowerCase().includes("olevel")) curriculum = "O Level";
  else if (group.toLowerCase().includes("a level") || group.toLowerCase().includes("alevel")) curriculum = "A Level";

  if (!curriculum) {
    return res.json({ countdown: null });
  }

  try {
    const { data: exam } = await supabase
      .from("exam_dates")
      .select("*")
      .eq("curriculum", curriculum)
      .maybeSingle();

    res.json({
      curriculum,
      exam_date: exam?.exam_date || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==========================================
// 8. PROGRESS REPORT DATA Groundwork
// ==========================================

router.get("/progress-report", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. Aggregate the last 10 quiz attempts (first-attempt rows only)
    const { data: quizAttempts } = await supabase
      .from("quiz_attempts")
      .select("*")
      .eq("user_id", userId)
      .eq("is_first_attempt", true)
      .order("created_at", { ascending: false })
      .limit(10);

    // 2. Fetch completed study sessions to compute study hours
    const { data: studySessions } = await supabase
      .from("study_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "completed");

    res.json({
      last_ten_attempts: quizAttempts || [],
      total_completed_sessions: studySessions?.length || 0,
      total_study_hours: ((studySessions?.length || 0) * 15) / 60, // simple Pomodoro conversion
      // Deferring ai_student_scores per PRD's explicit exclusion
      ai_scores_excluded: true
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
