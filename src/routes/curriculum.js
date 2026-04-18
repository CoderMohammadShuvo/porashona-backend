import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /curriculum/{class}/{group}:
 *   get:
 *     summary: Get all subjects and chapters for a class and group
 *     tags: [Curriculum]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: class
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: group
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of subjects
 */
router.get("/:class/:group",  async (req, res) => {
  const { class: studentClass, group } = req.params;

  try {
    const classVal = parseInt(studentClass) || req.user?.class || 10;
    const groupVal = group || req.user?.group || "Science";

    const { data: subjects, error } = await supabase
      .from("subjects")
      .select(`
        *,
        chapters (
          id, title, sort_order, is_free, nctb_verified
        )
      `)
      .or(`"class".eq.${classVal},"class".is.null`)
      .or(`"group".ilike.${groupVal},"group".ilike.All`)
      .order("sort_order");

    if (error) return res.status(500).json({ error: error.message });

    // Sort chapters within each subject
    const result = subjects.map((s) => ({
      ...s,
      chapters: (s.chapters || []).sort((a, b) => a.sort_order - b.sort_order),
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch curriculum" });
  }
});

/**
 * @swagger
 * /curriculum/subject/{subjectId}:
 *   get:
 *     summary: Get subject details with chapters and subtopics
 *     tags: [Curriculum]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subjectId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Subject details
 */
router.get("/subject/:subjectId", requireAuth, async (req, res) => {
  const { subjectId } = req.params;

  try {
    const { data: subject, error } = await supabase
      .from("subjects")
      .select(`
        *,
        chapters (
          *,
          subtopics ( id, title, sort_order, video_url_free, duration_seconds, is_published )
        )
      `)
      .eq("id", subjectId)
      .single();

    if (error || !subject) return res.status(404).json({ error: "Subject not found" });

    res.json(subject);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subject" });
  }
});

/**
 * @swagger
 * /curriculum/chapter/{chapterId}:
 *   get:
 *     summary: Get chapter details with subtopics
 *     tags: [Curriculum]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Chapter details
 */
router.get("/chapter/:chapterId", requireAuth, async (req, res) => {
  const { chapterId } = req.params;

  try {
    const { data: chapter, error } = await supabase
      .from("chapters")
      .select(`
        *,
        subtopics (
          id, title, sort_order, video_url_free, video_url_paid,
          youtube_video_id, duration_seconds, is_published, notes_text
        )
      `)
      .eq("id", chapterId)
      .single();

    if (error || !chapter) return res.status(404).json({ error: "Chapter not found" });

    // Check user's subscription to decide which video URLs to expose
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("status")
      .eq("user_id", req.user.id)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .single();

    const isPro = !!sub;

    // Strip paid video URLs for free users
    const subtopics = (chapter.subtopics || [])
      .filter((st) => st.is_published)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((st) => ({
        ...st,
        video_url_paid: isPro ? st.video_url_paid : null,
        youtube_video_id: isPro ? st.youtube_video_id : null,
      }));

    res.json({ ...chapter, subtopics });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch chapter" });
  }
});

export default router;
