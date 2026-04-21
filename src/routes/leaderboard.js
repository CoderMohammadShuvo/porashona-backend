import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /leaderboard:
 *   get:
 *     summary: Get global leaderboard
 *     tags: [Leaderboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Leaderboard data
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    // Top 50 by XP
    const { data: topStudents, error } = await supabase
      .from('users')
      .select('id, name, xp, streak, rank')
      .order('xp', { ascending: false })
      .limit(50);

    if (error) throw error;

    // Get current user rank
    const { data: userStats } = await supabase
      .from('users')
      .select('rank, xp')
      .eq('id', req.user.id)
      .single();

    res.json({
      topStudents,
      myRank: userStats?.rank || 'N/A',
      myTotalXp: userStats?.xp || 0
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

export default router;
