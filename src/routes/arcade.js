import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

// Auto-generate 15 random MCQs for the daily blitz
router.get("/questions", authMiddleware, async (req, res) => {
  try {
    // 1. Fetch random questions from the database
    // Since SQL random() is not natively clean via simple supabase JS API without custom RPC,
    // we can either select a batch and sample them, or run a query.
    // Let's query a pool of questions from quizzes.
    const { data: questions, error } = await supabase
      .from("questions")
      .select("question_text, options, correct_answer_index, explanation")
      .limit(100);

    if (error) throw error;

    // Default pool of fallback questions if database doesn't have enough questions
    const fallbackPool = [
      { q: "What is the unit of Force?", options: ["Joule", "Newton", "Pascal", "Watt"], answer: 1 },
      { q: "Who wrote the national anthem of Bangladesh?", options: ["Kazi Nazrul Islam", "Rabindranath Tagore", "Jibanananda Das", "Jasimuddin"], answer: 1 },
      { q: "What is the chemical formula for table salt?", options: ["H₂O", "CO₂", "NaCl", "HCl"], answer: 2 },
      { q: "In Accounting, what is the normal balance of an Asset account?", options: ["Debit", "Credit", "Neutral", "None"], answer: 0 },
      { q: "Acceleration is the rate of change of ___", options: ["Displacement", "Velocity", "Force", "Mass"], answer: 1 },
      { q: "sin(90°) = ?", options: ["0", "1", "√2", "∞"], answer: 1 },
      { q: "The powerhouse of the cell is ___", options: ["Nucleus", "Ribosome", "Mitochondria", "Golgi Body"], answer: 2 },
      { q: "Which protocol is used for the web?", options: ["FTP", "SMTP", "HTTP", "SSH"], answer: 2 },
      { q: "What is the atomic number of Sodium?", options: ["10", "11", "12", "23"], answer: 1 },
      { q: "'Bidrohi' was written by ___", options: ["Rabindranath Tagore", "Kazi Nazrul Islam", "Michael Madhusudan", "Jibanananda Das"], answer: 1 },
      { q: "What is the formula for calculating Work?", options: ["F × d", "m × a", "m × v", "P × t"], answer: 0 },
      { q: "Which blood cells fight infection?", options: ["Red Blood Cells", "White Blood Cells", "Platelets", "Plasma"], answer: 1 },
      { q: "The capital of Australia is ___", options: ["Sydney", "Melbourne", "Canberra", "Perth"], answer: 2 },
      { q: "What does HTML stand for?", options: ["Hyper Text Markup Language", "High Tech Modern Language", "Hyper Transfer Markup Language", "Home Tool Markup Language"], answer: 0 },
      { q: "pH of pure water is ___", options: ["0", "7", "14", "1"], answer: 1 }
    ];

    // Combine database questions and fallback questions
    const mappedDbQuestions = (questions || []).map(q => ({
      q: q.question_text,
      options: Array.isArray(q.options) ? q.options : JSON.parse(q.options || "[]"),
      answer: q.correct_answer_index
    })).filter(q => q.options && q.options.length > 0);

    const combinedPool = [...mappedDbQuestions, ...fallbackPool];

    // Shuffle the pool
    const shuffled = combinedPool.sort(() => 0.5 - Math.random());

    // Select top 15 unique or available questions
    const selected = shuffled.slice(0, 15);

    res.json(selected);
  } catch (err) {
    console.error("Error generating blitz questions:", err);
    res.status(500).json({ error: "Failed to generate blitz questions" });
  }
});

// Submit blitz score and update stats/streaks/rankings
router.post("/submit", authMiddleware, async (req, res) => {
  const { score, correctCount } = req.body;
  const userId = req.user.id;

  try {
    // Award +10 points per correct answer via the shared award_points function.
    // This writes to points_ledger (the canonical source of truth) and respects
    // the daily cap. The legacy `xp` column on `users` is intentionally NOT updated.
    const pointsEarned = (correctCount || 0) * 10;

    if (pointsEarned > 0) {
      const { error: rpcErr } = await supabase.rpc("award_points", {
        p_user_id: userId,
        p_reason: "quiz_complete",
        p_custom_delta: pointsEarned,
      });
      if (rpcErr) console.error("award_points RPC error (arcade):", rpcErr.message);
    }

    // Streak tracking (uses users.streak which is a derived display field, not gamification balance)
    const today = new Date().toISOString().split("T")[0];
    const { data: user } = await supabase
      .from("users")
      .select("streak, last_active_date")
      .eq("id", userId)
      .single();

    let newStreak = user?.streak || 0;
    if (user && user.last_active_date !== today) {
      newStreak += 1;
      await supabase.from("users").update({ streak: newStreak, last_active_date: today }).eq("id", userId);
    }

    // Derive current balance from points_ledger for response
    const { data: ledger } = await supabase
      .from("points_ledger")
      .select("delta")
      .eq("user_id", userId);
    const myBalance = (ledger || []).reduce((s, r) => s + r.delta, 0);

    res.json({
      pointsEarned,
      myTotalPoints: myBalance,
      newStreak,
    });
  } catch (err) {
    console.error("Error submitting blitz score:", err);
    res.status(500).json({ error: "Failed to submit blitz score" });
  }
});


export default router;
