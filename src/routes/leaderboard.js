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
    // Top 50 by XP (excluding Guardians)
    const { data: topStudents, error } = await supabase
      .from('users')
      .select('id, name, xp, streak, rank')
      .neq('group', 'Guardian')
      .order('xp', { ascending: false })
      .limit(50);

    if (error) throw error;

    // Get current user rank dynamically based on XP
    const { data: userStats } = await supabase
      .from('users')
      .select('xp')
      .eq('id', req.user.id)
      .single();

    let myRank = 1;
    if (userStats) {
      const { count, error: countError } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .gt('xp', userStats.xp);

      if (!countError) {
        myRank = (count || 0) + 1;
      }
    }

    res.json({
      topStudents,
      myRank,
      myTotalXp: userStats?.xp || 0
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

export default router;
