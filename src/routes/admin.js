import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { supabase, supabaseAnon } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /admin/login:
 *   post:
 *     summary: Admin Login
 *     tags: [Admin]
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
 *       403:
 *         description: Not an admin
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
      .maybeSingle();

    if (adminError || !admin) {
      if (adminError) console.error("Admin lookup failed:", adminError);
      
      return res.status(403).json({ 
        error: "Access denied: Not an admin user", 
        message: "Authentication successful, but you are not registered in the admin_users table.",
        debug: {
          searchedId: data.user.id,
          email: data.user.email,
          error: adminError?.message || "User record not found in admin_users table",
          code: adminError?.code || "NOT_AN_ADMIN"
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
 * @swagger
 * /admin/me:
 *   get:
 *     summary: Get current admin profile
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Admin profile data
 */
router.get("/me", requireAuth, requireAdmin, async (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    role: req.adminRole,
  });
});

/**
 * @swagger
 * /admin/students:
 *   get:
 *     summary: List all students
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of students
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
 * @swagger
 * /admin/subscriptions:
 *   get:
 *     summary: List all subscriptions
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of subscriptions
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
 * @swagger
 * /admin/content/subjects:
 *   get:
 *     summary: Get all subjects
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of subjects
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
 * @swagger
 * /admin/content/chapters/{subjectId}:
 *   get:
 *     summary: Get chapters for a subject
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subjectId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of chapters
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
 * @swagger
 * /admin/content/subtopics:
 *   get:
 *     summary: List subtopics/videos
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: chapter_id
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of subtopics
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
 * @swagger
 * /admin/content/subtopics:
 *   post:
 *     summary: Create subtopic (Video)
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chapter_id, title, sort_order]
 *     responses:
 *       200:
 *         description: Created subtopic
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
 * @swagger
 * /admin/content/teachers:
 *   get:
 *     summary: Get all teachers
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of teachers
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
 * @swagger
 * /admin/content/subjects:
 *   post:
 *     summary: Create Subject
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, class, group]
 *     responses:
 *       200:
 *         description: Created subject
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
 * @swagger
 * /admin/content/subjects/{id}:
 *   patch:
 *     summary: Update Subject
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Updated subject
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
 * @swagger
 * /admin/content/subjects/{id}:
 *   delete:
 *     summary: Delete Subject
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
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
 * @swagger
 * /admin/content/chapters:
 *   post:
 *     summary: Create Chapter
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subject_id, title, sort_order]
 *     responses:
 *       200:
 *         description: Created chapter
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
 * @swagger
 * /admin/content/chapters/{id}:
 *   patch:
 *     summary: Update Chapter
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Updated chapter
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
 * @swagger
 * /admin/content/chapters/{id}:
 *   delete:
 *     summary: Delete Chapter
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
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
 * @swagger
 * /admin/content/subtopics/{id}:
 *   patch:
 *     summary: Update subtopic
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Updated subtopic
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
 * @swagger
 * /admin/content/subtopics/{id}:
 *   delete:
 *     summary: Delete subtopic
 *     tags: [Admin Content]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Deleted
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
