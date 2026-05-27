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
    // 1. Get current stats
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("xp, streak, last_active_date")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Calculate XP earned: 10 XP per correct answer + completion bonus (e.g. 50 XP if score > 0)
    const xpEarned = correctCount * 10;

    // Update streak logic
    const today = new Date().toISOString().split("T")[0];
    let newStreak = user.streak || 0;
    if (user.last_active_date !== today) {
      newStreak += 1;
    }

    // Increment games_played and best_streak in user metadata or custom columns if any,
    // otherwise update XP, streak, and last_active_date
    const newXp = (user.xp || 0) + xpEarned;

    const { error: updateError } = await supabase
      .from("users")
      .update({
        xp: newXp,
        streak: newStreak,
        last_active_date: today
      })
      .eq("id", userId);

    if (updateError) throw updateError;

    // Return the updated user stats and leaderboard information
    const { data: topStudents } = await supabase
      .from("users")
      .select("id, name, xp, streak, rank")
      .order("xp", { ascending: false })
      .limit(50);

    let myRank = 1;
    const { count, error: countError } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .gt("xp", newXp);

    if (!countError) {
      myRank = (count || 0) + 1;
    }

    res.json({
      xpEarned,
      newXp,
      newStreak,
      myRank,
      topStudents: topStudents || []
    });
  } catch (err) {
    console.error("Error submitting blitz score:", err);
    res.status(500).json({ error: "Failed to submit blitz score" });
  }
});

export default router;
