import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /progress/video:
 *   post:
 *     summary: Update video watching progress
 *     tags: [Progress]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subtopic_id]
 *             properties:
 *               subtopic_id: { type: string }
 *               watched_seconds: { type: integer }
 *               completed: { type: boolean }
 *     responses:
 *       200:
 *         description: Progress updated
 */
router.post("/video", authMiddleware, async (req, res) => {
  const { subtopic_id, watched_seconds, completed } = req.body;

  if (!subtopic_id) return res.status(400).json({ error: "subtopic_id is required" });

  try {
    // Upsert progress
    const { data: existing } = await supabase
      .from('video_progress')
      .select('xp_awarded, completed')
      .eq('user_id', req.user.id)
      .eq('subtopic_id', subtopic_id)
      .single();

    let awardXp = false;
    if (completed && !existing?.completed) {
      awardXp = true;
    }

    const { error } = await supabase.from('video_progress').upsert({
      user_id: req.user.id,
      subtopic_id,
      watched_seconds,
      completed,
      completed_at: completed ? new Date().toISOString() : null,
      xp_awarded: awardXp || existing?.xp_awarded || false
    }, { onConflict: 'user_id,subtopic_id' });

    if (error) throw error;

    if (awardXp) {
      // Award 50 XP for completing a video
      await supabase.rpc('increment_xp', { user_id: req.user.id, amount: 50 });
    }

    res.json({ success: true, xpEarned: awardXp ? 50 : 0 });
  } catch (err) {
    res.status(500).json({ error: "Failed to save progress" });
  }
});

/**
 * @swagger
 * /progress/user:
 *   get:
 *     summary: Get all progress for current user
 *     tags: [Progress]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of user progress records
 */
router.get("/user", authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('video_progress')
    .select('*')
    .eq('user_id', req.user.id);
    
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/summary", authMiddleware, async (req, res) => {
  const studentId = req.user.id;

  // 1. Fetch Quiz Attempts
  const { data: attempts } = await supabase
    .from('quiz_attempts')
    .select(`
      score,
      total_questions,
      completed_at,
      time_taken_seconds,
      is_exam_attempt,
      quizzes (
        title,
        chapters (subject_id)
      )
    `)
    .eq('user_id', studentId)
    .order('completed_at', { ascending: false });

  // 2. Fetch Video Progress
  const { data: videoProgress } = await supabase
    .from('video_progress')
    .select(`
      completed,
      completed_at,
      subtopic_id,
      subtopics (
        title,
        duration_seconds,
        chapters (subject_id)
      )
    `)
    .eq('user_id', studentId)
    .eq('completed', true);

  // 3. Subject Proficiency
  const subjectsMap = {};
  attempts?.forEach(a => {
    const subjectId = a.quizzes?.chapters?.subject_id || "General";
    if (!subjectsMap[subjectId]) subjectsMap[subjectId] = { total: 0, count: 0 };
    subjectsMap[subjectId].total += (a.score / a.total_questions);
    subjectsMap[subjectId].count += 1;
  });

  const proficiency = Object.keys(subjectsMap).map(s => ({
    subject: s.charAt(0).toUpperCase() + s.slice(1),
    score: Math.round((subjectsMap[s].total / subjectsMap[s].count) * 100)
  }));

  // 4. Activity Feed
  const activity = [
    ...(attempts?.map(a => ({
      icon: a.is_exam_attempt ? "📝" : "📖",
      text: `${a.is_exam_attempt ? 'Exam' : 'Quiz'}: ${a.quizzes?.title || 'Practice'}`,
      time: a.completed_at,
      xp: a.xp_earned || 0
    })) || []),
    ...(videoProgress?.map(v => ({
      icon: "🎥",
      text: `Watched: ${v.subtopics?.title || 'Lesson'}`,
      time: v.completed_at,
      xp: 50
    })) || [])
  ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 10);

  // 5. Streak History (Simplified for now - just returning last 30 days active dates)
  const { data: activeDates } = await supabase
    .from('daily_ai_usage')
    .select('date')
    .eq('user_id', studentId)
    .order('date', { ascending: false })
    .limit(30);

  res.json({
    proficiency: proficiency.length > 0 ? proficiency : [
      { subject: "Physics", score: 0 }, { subject: "Math", score: 0 },
      { subject: "Chemistry", score: 0 }, { subject: "English", score: 0 }
    ],
    activity,
    activeDates: activeDates?.map(d => d.date) || [],
  });
});

router.get("/dashboard", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  // 1. Fetch all video progress with subtopic & chapter info for subject progress %
  const { data: videoProgress } = await supabase
    .from('video_progress')
    .select(`
      subtopic_id,
      watched_seconds,
      completed,
      completed_at,
      subtopics (
        id,
        title,
        duration_seconds,
        chapter_id,
        chapters (
          id,
          title,
          subject_id
        )
      )
    `)
    .eq('user_id', userId)
    .order('completed_at', { ascending: false });

  // 2. Fetch all quiz attempts with subject/chapter info for weak spots (handling both chapter & subtopic quizzes)
  const { data: quizAttempts } = await supabase
    .from('quiz_attempts')
    .select(`
      score,
      total_questions,
      completed_at,
      is_exam_attempt,
      quizzes (
        title,
        chapters (
          id,
          title,
          subject_id
        ),
        subtopics (
          chapters (
            id,
            title,
            subject_id
          )
        )
      )
    `)
    .eq('user_id', userId)
    .order('completed_at', { ascending: false })
    .limit(50);

  // 3. Build subject progress map: subjectId -> { completed, total }
  const subjectProgressMap = {};
  videoProgress?.forEach(vp => {
    const subjectId = vp.subtopics?.chapters?.subject_id;
    if (!subjectId) return;
    if (!subjectProgressMap[subjectId]) {
      subjectProgressMap[subjectId] = { completed: 0, total: 0 };
    }
    subjectProgressMap[subjectId].total += 1;
    if (vp.completed) subjectProgressMap[subjectId].completed += 1;
  });

  // 4. Build weak spots from quiz performance per chapter
  const chapterScoreMap = {};
  quizAttempts?.forEach(a => {
    const chapter = a.quizzes?.chapters || a.quizzes?.subtopics?.chapters;
    const chapterId = chapter?.id;
    const chapterTitle = chapter?.title;
    if (!chapterId || a.total_questions === 0) return;
    if (!chapterScoreMap[chapterId]) {
      chapterScoreMap[chapterId] = { total: 0, count: 0, title: chapterTitle || chapterId };
    }
    chapterScoreMap[chapterId].total += (a.score / a.total_questions) * 100;
    chapterScoreMap[chapterId].count += 1;
  });

  // Weak spots: chapters where average score < 70%
  const weakSpots = Object.entries(chapterScoreMap)
    .map(([id, data]) => ({
      id,
      name: data.title,
      avgScore: Math.round(data.total / data.count)
    }))
    .filter(s => s.avgScore < 70)
    .sort((a, b) => a.avgScore - b.avgScore)
    .slice(0, 5);

  // 5. Daily missions completion status
  // A mission is "done today" if the corresponding activity happened today
  const todayStr = new Date().toISOString().split('T')[0];

  const watchedToday = videoProgress?.some(vp => {
    if (!vp.completed_at) return false;
    return vp.completed_at.split('T')[0] === todayStr && vp.watched_seconds > 60;
  }) || false;

  const quizzedToday = quizAttempts?.some(a => {
    if (!a.completed_at) return false;
    return a.completed_at.split('T')[0] === todayStr;
  }) || false;

  // 6. Smart Resume: find the most recently watched incomplete video
  const lastWatched = videoProgress
    ?.filter(vp => !vp.completed && vp.subtopics)
    .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0))[0];

  const smartResume = lastWatched ? {
    subtopic_id: lastWatched.subtopic_id,
    subtopic_title: lastWatched.subtopics?.title,
    chapter_id: lastWatched.subtopics?.chapter_id,
    chapter_title: lastWatched.subtopics?.chapters?.title,
    subject_id: lastWatched.subtopics?.chapters?.subject_id,
    watched_seconds: lastWatched.watched_seconds,
    duration_seconds: lastWatched.subtopics?.duration_seconds || 0,
  } : null;

  res.json({
    subject_progress: subjectProgressMap,
    weak_spots: weakSpots,
    daily_missions: {
      watched_video_today: watchedToday,
      took_quiz_today: quizzedToday,
    },
    smart_resume: smartResume,
  });
});

export default router;

