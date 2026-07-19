/**
 * Digital Library Routes – PRD §10.8 / §11.2
 *
 * DEPRECATION NOTICE (2026-07-18):
 *   The legacy `library_items` table path has been deprecated.
 *   All Digital Library surfaces now read from the `notes` table so that
 *   the Syllabus and Digital Library frontend surfaces are served by the
 *   SAME underlying data source (identical note records for the same
 *   class/subject query).
 *
 * Access rules:
 *   - Subscription gate: only users with subscription_status = 'active'
 *     can retrieve note content. Unauthenticated or inactive users receive
 *     metadata only.
 *   - content_uploader may NOT list all library items here (use /content/notes).
 *
 * Admin write operations (create / update / delete) remain on /content/notes.
 */
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /library:
 *   get:
 *     summary: Get Digital Library items (redirected to notes table)
 *     tags: [Library]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: class
 *         schema: { type: integer }
 *       - in: query
 *         name: subject
 *         schema: { type: string }
 *       - in: query
 *         name: version
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of library notes
 *       403:
 *         description: Active subscription required
 */
router.get("/", authMiddleware, async (req, res) => {
  // Subscription gate: subscription_status must be 'active' (set on profile or via subscription row)
  const isActive = req.user.subscription_status === "active";
  if (!isActive) {
    return res.status(403).json({
      error: "Active subscription required to access the Digital Library",
      code: "SUBSCRIPTION_REQUIRED",
    });
  }

  const { class: noteClass, subject, version, chapter } = req.query;

  try {
    let query = supabase
      .from("notes")
      .select("id, curriculum, class, version, subject, chapter, estimated_minutes, file_url, created_at")
      .order("created_at", { ascending: false });

    if (noteClass) query = query.eq("class", noteClass);
    if (subject) query = query.ilike("subject", `%${subject}%`);
    if (version) query = query.eq("version", version);
    if (chapter) query = query.ilike("chapter", `%${chapter}%`);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Library fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /library/{id}:
 *   get:
 *     summary: Get a single library note by id
 *     tags: [Library]
 *     security:
 *       - bearerAuth: []
 */
router.get("/:id", authMiddleware, async (req, res) => {
  const isActive = req.user.subscription_status === "active";
  if (!isActive) {
    return res.status(403).json({ error: "Active subscription required", code: "SUBSCRIPTION_REQUIRED" });
  }

  try {
    const { data, error } = await supabase
      .from("notes")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Note not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
