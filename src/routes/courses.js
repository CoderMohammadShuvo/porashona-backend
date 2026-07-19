import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Courses
 *   description: |
 *     Crash Course Management – DORMANT (PRD §15 Out of Scope for MVP).
 *     All endpoints return 503 until this feature is explicitly re-enabled.
 *     The underlying `crash_courses` table is preserved intact.
 */

/**
 * Dormant guard – applied to every route in this file.
 * Remove this middleware and the use() call below when re-enabling.
 */
function dormantFeature(_req, res) {
  res.status(503).json({
    error: "Feature not available",
    code: "FEATURE_DORMANT",
    detail: "Crash Courses are out of scope for MVP (PRD §15). This endpoint will be re-enabled in a future release.",
  });
}

router.use(dormantFeature);



/**
 * @swagger
 * /courses:
 *   get:
 *     summary: Get all active crash courses
 *     tags: [Courses]
 *     security:
 *       - bearerAuth: []
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("crash_courses")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /courses/admin:
 *   get:
 *     summary: Get all courses for admin
 *     tags: [Courses]
 *     security:
 *       - bearerAuth: []
 */
router.get("/admin", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("crash_courses")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /courses:
 *   post:
 *     summary: Create a new crash course (Admin)
 *     tags: [Courses]
 *     security:
 *       - bearerAuth: []
 */
router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("crash_courses")
      .insert([req.body])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /courses/{id}:
 *   patch:
 *     summary: Update a crash course (Admin)
 *     tags: [Courses]
 *     security:
 *       - bearerAuth: []
 */
router.patch("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("crash_courses")
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
 * /courses/{id}:
 *   delete:
 *     summary: Delete a crash course (Admin)
 *     tags: [Courses]
 *     security:
 *       - bearerAuth: []
 */
router.delete("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from("crash_courses")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
