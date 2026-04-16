import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { supabase, supabaseAnon } from "../lib/supabase.js";
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
    // 1. Perform Auth check with the Anon client
    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ error: error.message });

    // 2. Perform Admin check with the Service Role client (bypasses RLS)
    const { data: admin, error: adminError } = await supabase
      .from("admin_users")
      .select("role")
      .eq("id", data.user.id)
      .single();

    if (adminError || !admin) {
      console.error("Admin lookup failed:", adminError);
      return res.status(403).json({ 
        error: "Access denied: Not an admin user", 
        debug: {
          searchedId: data.user.id,
          error: adminError?.message || "Record not found",
          code: adminError?.code
        }
      });
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

/**
 * Content Manager: Get all subjects
 */
router.get("/content/subjects", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("subjects")
      .select("*")
      .order("class", { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Get chapters for a subject
 */
router.get("/content/chapters/:subjectId", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("chapters")
      .select("*")
      .eq("subject_id", req.params.subjectId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: List subtopics/videos with optional filters
 */
router.get("/content/subtopics", requireAuth, requireAdmin, async (req, res) => {
  const { chapter_id } = req.query;
  try {
    let query = supabase
      .from("subtopics")
      .select(`
        *,
        chapters (
          title,
          subjects ( name, class, "group" )
        )
      `)
      .order("created_at", { ascending: false });

    if (chapter_id) {
      query = query.eq("chapter_id", chapter_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Create subtopic (Video)
 */
router.post("/content/subtopics", requireAuth, requireAdmin, async (req, res) => {
  try {
    const payload = { id: uuidv4(), ...req.body };
    const { data, error } = await supabase
      .from("subtopics")
      .insert([payload])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Get all teachers
 */
router.get("/content/teachers", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from("teachers").select("*").order("name");
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Create Subject
 */
/**
 * Content Manager: Create Subject
 */
router.post("/content/subjects", requireAuth, requireAdmin, async (req, res) => {
  try {
    const payload = { id: uuidv4(), ...req.body };
    const { data, error } = await supabase.from("subjects").insert([payload]).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Update Subject
 */
router.patch("/content/subjects/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from("subjects").update(req.body).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Delete Subject
 */
router.delete("/content/subjects/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from("subjects").delete().eq("id", req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Create Chapter
 */
router.post("/content/chapters", requireAuth, requireAdmin, async (req, res) => {
  try {
    const payload = { id: uuidv4(), ...req.body };
    const { data, error } = await supabase.from("chapters").insert([payload]).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Update Chapter
 */
router.patch("/content/chapters/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from("chapters").update(req.body).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
  * Content Manager: Delete Chapter
  */
router.delete("/content/chapters/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from("chapters").delete().eq("id", req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Update subtopic
 */
router.patch("/content/subtopics/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("subtopics")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Content Manager: Delete subtopic
 */
router.delete("/content/subtopics/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from("subtopics")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
