import { Router } from "express";
import { supabase, supabaseAnon } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new student
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, name]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *               name: { type: string }
 *               class: { type: integer, example: 12 }
 *               group: { type: string, example: "Science" }
 *     responses:
 *       201:
 *         description: Registration successful
 *       400:
 *         description: Validation error
 */
router.post("/register", async (req, res) => {
  const { email, password, name, class: studentClass, group } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: "email, password, and name are required" });
  }

  try {
    // 1. Sign up the user (this triggers the email automatically if SMTP is setup)
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) return res.status(400).json({ error: authError.message });
    if (!authData.user) return res.status(400).json({ error: "Signup failed" });

    // 2. Create user profile row
    const { error: profileError } = await supabase.from("users").upsert({
      id: authData.user.id,
      email,
      name,
      class: studentClass || 12,
      group: group || "Science",
      xp: 0,
      streak: 0,
    });

    if (profileError) {
      return res.status(500).json({ error: profileError.message });
    }

    res.status(201).json({ 
      message: "Registration successful. Please check your email for the verification code.", 
      userId: authData.user.id 
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

/**
 * @swagger
 * /auth/verify-otp:
 *   post:
 *     summary: Verify email OTP
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, token]
 *             properties:
 *               email: { type: string }
 *               token: { type: string }
 *     responses:
 *       200:
 *         description: Email verified
 *       400:
 *         description: Invalid OTP
 */
router.post("/verify-otp", async (req, res) => {
  const { email, token } = req.body;

  if (!email || !token) {
    return res.status(400).json({ error: "email and token are required" });
  }

  try {
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "signup",
    });

    if (error) return res.status(400).json({ error: error.message });

    res.json({
      session: data.session,
      user: data.user,
      message: "Email verified successfully",
    });
  } catch (err) {
    res.status(500).json({ error: "OTP verification failed" });
  }
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login student
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  try {
    // Use the anon client for user authentication
    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ error: error.message });

    // Update last_active_date and streak using the service role client (bypassing RLS)
    const today = new Date().toISOString().split("T")[0];
    const { data: user } = await supabase
      .from("users")
      .select("last_active_date, streak")
      .eq("id", data.user.id)
      .maybeSingle();

    let newStreak = user?.streak || 0;
    if (user?.last_active_date) {
      const last = new Date(user.last_active_date);
      const diff = Math.floor((Date.now() - last.getTime()) / 86400000);
      if (diff === 1) newStreak += 1;
      else if (diff > 1) newStreak = 1;
    } else {
      newStreak = 1;
    }

    await supabase.from("users").update({
      last_active_date: today,
      streak: newStreak,
    }).eq("id", data.user.id);

    res.json({
      session: data.session,
      user: { ...data.user, streak: newStreak },
    });
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 */
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    const token = req.headers.authorization?.slice(7);
    await supabase.auth.admin.signOut(token);
    res.json({ message: "Logged out successfully" });
  } catch {
    res.json({ message: "Logged out" });
  }
});

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Get current user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile data
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.id)
      .single();

    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("plan_id, status, expires_at")
      .eq("user_id", req.user.id)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    const isPro = !!subscription;

    res.json({
      ...profile,
      email: req.user.email,
      isPro,
      subscription: subscription || null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

export default router;
