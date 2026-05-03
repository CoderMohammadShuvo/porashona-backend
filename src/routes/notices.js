import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     Notice:
 *       type: object
 *       required:
 *         - title
 *         - body
 *       properties:
 *         id: { type: string, format: uuid }
 *         title: { type: string }
 *         body: { type: string }
 *         category: { type: string }
 *         target_class: { type: integer }
 *         target_group: { type: string }
 *         status: { type: string, enum: [draft, published, scheduled] }
 *         publish_date: { type: string, format: date-time }
 *         created_at: { type: string, format: date-time }
 */

/**
 * @swagger
 * /notices:
 *   get:
 *     summary: Get notices for students (filtered by class/group and publish date)
 *     tags: [Notices]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of published notices
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { class: studentClass, group } = req.user;
    const now = new Date().toISOString();

    let query = supabase
      .from("notices")
      .select("*")
      .eq("status", "published")
      .lte("publish_date", now)
      .order("publish_date", { ascending: false });

    // Filter by class if notice has a target_class
    // (target_class IS NULL OR target_class = studentClass)
    // Supabase JS doesn't support complex OR in a single call easily without .or()
    // but we can use raw .or for class/group
    
    query = query.or(`target_class.is.null,target_class.eq.${studentClass || 0}`);
    
    const { data, error } = await query;

    if (error) throw error;

    // Further filter by group in JS if needed, or using more complex .or
    const filtered = data.filter(notice => {
      if (!notice.target_group) return true;
      return notice.target_group.toLowerCase() === (group || "").toLowerCase();
    });

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /notices/admin:
 *   get:
 *     summary: Get all notices (Admin only)
 *     tags: [Admin Notices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, published, scheduled] }
 *     responses:
 *       200:
 *         description: List of all notices
 */
router.get("/admin", authMiddleware, adminMiddleware, async (req, res) => {
  const { status } = req.query;
  try {
    let query = supabase.from("notices").select("*").order("created_at", { ascending: false });

    if (status) {
      query = query.eq("status", status);
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
 * /notices:
 *   post:
 *     summary: Create a new notice (Admin only)
 *     tags: [Admin Notices]
 *     security:
 *       - bearerAuth: []
 */
router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  const { title, body, category, target_class, target_group, publish_date, status } = req.body;

  try {
    const { data, error } = await supabase
      .from("notices")
      .insert([{
        title,
        body,
        category: category || 'general',
        target_class: target_class || null,
        target_group: target_group || null,
        publish_date: publish_date || new Date().toISOString(),
        status: status || 'draft',
        created_by: req.user.id
      }])
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
 * /notices/{id}:
 *   patch:
 *     summary: Update a notice (Admin only)
 *     tags: [Admin Notices]
 *     security:
 *       - bearerAuth: []
 */
router.patch("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("notices")
      .update({ ...req.body, updated_at: new Date().toISOString() })
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
 * /notices/{id}:
 *   delete:
 *     summary: Delete a notice (Admin only)
 *     tags: [Admin Notices]
 *     security:
 *       - bearerAuth: []
 */
router.delete("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { error } = await supabase.from("notices").delete().eq("id", req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
