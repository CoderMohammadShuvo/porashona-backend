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

router.get("/students", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: students, error } = await supabase
      .from("profiles")
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
 * /admin/students/{id}:
 *   get:
 *     summary: Get detailed student profile
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.get("/students/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const [profile, progress, quizzes, subscriptions, chats] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', id).single(),
        supabase.from('user_progress').select('*').eq('user_id', id),
        supabase.from('quiz_attempts').select('*, quizzes(title)').eq('user_id', id),
        supabase.from('subscriptions').select('*').eq('user_id', id).order('created_at', { ascending: false }),
        supabase.from('chat_history').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(50)
    ]);

    res.json({
        profile: profile.data,
        progress: progress.data,
        quizzes: quizzes.data,
        subscriptions: subscriptions.data,
        chats: chats.data
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch student details" });
  }
});

/**
 * @swagger
 * /admin/students/{id}/upgrade:
 *   post:
 *     summary: Manually upgrade student to Pro
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.post("/students/:id/upgrade", requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { plan_id, duration_months = 1 } = req.body;

    const expires_at = new Date();
    expires_at.setMonth(expires_at.getMonth() + duration_months);

    try {
        const { error } = await supabase.from('subscriptions').insert([{
            user_id: id,
            plan_id: plan_id || 'admin_manual_pro',
            status: 'active',
            payment_reference: `ADMIN_MANUAL_${uuidv4().substring(0,6)}`,
            amount_paid: 0,
            expires_at: expires_at.toISOString()
        }]);

        if (error) throw error;
        res.json({ success: true, expires_at });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
      .select("*, users:profiles(name, email)")
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
