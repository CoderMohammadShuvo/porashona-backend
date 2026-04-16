import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/**
 * Admin Login
 * Checks if the user exists in admin_users table after successful auth
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ error: error.message });

    // Check if user is an admin
    const { data: admin, error: adminError } = await supabase
      .from("admin_users")
      .select("role")
      .eq("id", data.user.id)
      .single();

    if (adminError || !admin) {
      // Not an admin, sign them out immediately
      await supabase.auth.signOut();
      return res.status(403).json({ error: "Access denied: Not an admin user" });
    }

    res.json({
      session: data.session,
      user: { ...data.user, role: admin.role },
    });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ error: "Auth failed" });
  }
});

/**
 * Get current admin profile
 */
router.get("/me", requireAuth, requireAdmin, async (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    role: req.adminRole,
  });
});

/**
 * List all students (Admin Only)
 */
router.get("/students", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: students, error } = await supabase
      .from("users")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch students" });
  }
});

/**
 * List all subscriptions (Admin Only)
 */
router.get("/subscriptions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: subs, error } = await supabase
      .from("subscriptions")
      .select("*, users(name, email)")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(subs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subscriptions" });
  }
});

export default router;
