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
    // Derive balance from points_ledger (SUM of delta per user) – canonical source of truth.
    // The legacy `xp` column on `users` is no longer written to by any active code path.
    const { data: ledger, error: ledgerErr } = await supabase
      .from("points_ledger")
      .select("user_id, delta");

    if (ledgerErr) throw ledgerErr;

    // Aggregate balances in JS
    const balanceMap = {};
    for (const row of ledger || []) {
      balanceMap[row.user_id] = (balanceMap[row.user_id] || 0) + row.delta;
    }

    // Fetch student profiles for display (guardian role no longer exists)
    const { data: users, error: usersErr } = await supabase
      .from("users")
      .select("id, name, streak")
      .eq("role", "student")
      .eq("is_suspended", false);

    if (usersErr) throw usersErr;

    const ranked = (users || [])
      .map((u) => ({ ...u, points: balanceMap[u.id] || 0 }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 50)
      .map((u, idx) => ({ ...u, rank: idx + 1 }));

    const myBalance = balanceMap[req.user.id] || 0;
    const myRank =
      (users || []).filter((u) => (balanceMap[u.id] || 0) > myBalance).length + 1;

    res.json({
      topStudents: ranked,
      myRank,
      myTotalPoints: myBalance,
    });
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

export default router;
