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
  if (!req.user.phone) return res.status(200).json([]);

  const { data, error } = await supabase
    .from('users')
    .select('id, name, class, group, xp, streak, last_active_date')
    .eq('guardian_phone', req.user.phone);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    .select('guardian_phone')
    .eq('id', studentId)
    .single();

  if (student?.guardian_phone !== req.user.phone) {
    return res.status(403).json({ error: "Unauthorized access to student data" });
  }

  // Fetch usage stats
  const { data: usage } = await supabase
    .from('daily_ai_usage')
    .select('*')
    .eq('user_id', studentId)
    .order('date', { ascending: false })
    .limit(7);

  const { data: progress } = await supabase
    .from('video_progress')
    .select('completed, subtopic_id, completed_at')
    .eq('user_id', studentId)
    .eq('completed', true)
    .limit(20);

  res.json({
    weekly_usage: usage,
    recent_videos: progress,
    report_generated_at: new Date().toISOString()
  });
});

export default router;
