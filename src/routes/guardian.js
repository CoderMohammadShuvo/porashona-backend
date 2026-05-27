import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /guardian/students:
 *   get:
 *     summary: Get students linked to this parent phone
 *     tags: [Guardian]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of students
 */
router.get("/students", authMiddleware, async (req, res) => {
  if (req.user.group !== "Guardian") {
    // If the logged in user is a student previewing, return themselves
    return res.json([{
      id: req.user.id,
      name: req.user.name || "Student",
      class: req.user.class || 10,
      group: req.user.group || "Science",
      xp: req.user.xp || 0,
      streak: req.user.streak || 0,
      last_active_date: req.user.last_active_date || null
    }]);
  }

  if (!req.user.phone && !req.user.email) return res.status(200).json([]);

  const lookupPhone = req.user.phone;
  const lookupEmail = req.user.email;

  let query = supabase
    .from('users')
    .select('id, name, class, group, xp, streak, last_active_date');

  if (lookupPhone && lookupEmail) {
    query = query.or(`guardian_phone.eq."${lookupPhone}",guardian_phone.eq."${lookupEmail}"`);
  } else {
    query = query.eq('guardian_phone', lookupPhone || lookupEmail);
  }

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * Register and link a guardian user to the current authenticated student
 */
router.post("/register", authMiddleware, async (req, res) => {
  const { email, password, phone } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Guardian email and password are required" });
  }

  try {
    // 1. Create the guardian user in Supabase auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) return res.status(400).json({ error: authError.message });
    if (!authData.user) return res.status(400).json({ error: "Guardian signup failed" });

    // 2. Create the guardian profile
    const guardianPhone = phone || req.user.guardian_phone || email; // Fallback to student's existing guardian_phone or email
    const { error: profileError } = await supabase.from("users").upsert({
      id: authData.user.id,
      email,
      name: "Guardian",
      class: 10,
      group: "Guardian",
      phone: guardianPhone,
      xp: 0,
      streak: 0,
    });

    if (profileError) throw profileError;

    // 3. Link this student to the guardian by setting the student's guardian_phone to the guardian's identifier
    const { error: linkError } = await supabase
      .from("users")
      .update({ guardian_phone: guardianPhone })
      .eq("id", req.user.id);

    if (linkError) throw linkError;

    res.json({ success: true, message: "Guardian registered and linked successfully" });
  } catch (err) {
    console.error("Guardian register error:", err);
    res.status(500).json({ error: err.message || "Failed to register guardian" });
  }
});

/**
 * @swagger
 * /guardian/report/{studentId}:
 *   get:
 *     summary: Get progress report for a student
 *     tags: [Guardian]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Student progress report
 */
router.get("/report/:studentId", authMiddleware, async (req, res) => {
  const { studentId } = req.params;

  // Verify guardian link
  const { data: student } = await supabase
    .from('users')
    .select('guardian_phone, name, class, group')
    .eq('id', studentId)
    .single();

  const lookupPhone = req.user.phone;
  const lookupEmail = req.user.email;
  if (studentId !== req.user.id && 
      student?.guardian_phone !== lookupPhone && 
      student?.guardian_phone !== lookupEmail) {
    return res.status(403).json({ error: "Unauthorized access to student data" });
  }

  // 1. Fetch Quiz Attempts for Trends and Proficiency
  // Joining with chapters to get subject_id
  const { data: attempts } = await supabase
    .from('quiz_attempts')
    .select(`
      score,
      total_questions,
      completed_at,
      time_taken_seconds,
      is_exam_attempt,
      chapter_id,
      subtopic_id,
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

  // 3. Fetch Subscriptions/Purchases
  const { data: subscriptions } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', studentId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  // 4. Calculate Summary Stats
  const totalAttempts = attempts?.length || 0;
  const avgScore = totalAttempts > 0 
    ? Math.round((attempts.reduce((acc, curr) => acc + (curr.score / curr.total_questions), 0) / totalAttempts) * 100) 
    : 0;
  
  const studyTimeSeconds = (attempts?.reduce((acc, curr) => acc + (curr.time_taken_seconds || 0), 0) || 0) +
                           (videoProgress?.reduce((acc, curr) => acc + (curr.subtopics?.duration_seconds || 0), 0) || 0);
  
  const hours = Math.floor(studyTimeSeconds / 3600);
  const minutes = Math.floor((studyTimeSeconds % 3600) / 60);

  // 5. Performance Trend (Last 8 weeks)
  // Group by week
  const trend = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - (i * 7));
    const weekLabel = `W${8-i}`;
    const weekAttempts = attempts?.filter(a => {
      const ad = new Date(a.completed_at);
      const diff = (new Date() - ad) / (1000 * 60 * 60 * 24);
      return diff >= (i * 7) && diff < ((i + 1) * 7);
    }) || [];
    
    const weekScore = weekAttempts.length > 0
      ? Math.round((weekAttempts.reduce((acc, curr) => acc + (curr.score / curr.total_questions), 0) / weekAttempts.length) * 100)
      : (trend.length > 0 ? trend[trend.length-1].score : 0); // Carry over last score or 0
    
    trend.push({ week: weekLabel, score: weekScore });
  }

  // 6. Subject Proficiency
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

  // 7. Activity Feed
  const activity = [
    ...(attempts?.map(a => ({
      action: `${a.is_exam_attempt ? 'Exam' : 'Quiz'}: ${a.quizzes?.title || 'Practice'}`,
      time: a.completed_at,
      type: a.is_exam_attempt ? 'exam' : 'study',
      score: Math.round((a.score / a.total_questions) * 100)
    })) || []),
    ...(videoProgress?.map(v => ({
      action: `Watched: ${v.subtopics?.title || 'Lesson'}`,
      time: v.completed_at,
      type: 'study'
    })) || [])
  ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 10);

  res.json({
    student: {
      name: student.name,
      class: student.class,
      group: student.group
    },
    summary: {
      overall_score: `${avgScore}%`,
      courses_purchased: subscriptions?.length || 0,
      study_time: `${hours}h ${minutes}m`,
      assignments_done: `${totalAttempts} Quizzes`
    },
    performance_trend: trend,
    subject_proficiency: proficiency.length > 0 ? proficiency : [
      { subject: "Physics", score: 0 }, { subject: "Math", score: 0 },
      { subject: "Chemistry", score: 0 }, { subject: "English", score: 0 }
    ],
    purchase_log: subscriptions?.map(s => ({
      id: s.id,
      name: `Pro Plan: ${s.plan_id}`,
      date: new Date(s.started_at).toLocaleDateString(),
      price: `৳${s.amount_paid}`,
      status: s.status
    })),
    recent_activity: activity,
    report_generated_at: new Date().toISOString()
  });
});

export default router;
