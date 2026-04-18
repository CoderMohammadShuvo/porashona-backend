import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

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
router.post("/video", requireAuth, async (req, res) => {
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
router.get("/user", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('video_progress')
    .select('*')
    .eq('user_id', req.user.id);
    
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
