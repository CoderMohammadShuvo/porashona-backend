import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

// ─── IMPORTANT: Specific routes MUST be registered before /:class/:group ───
// Express matches routes top-to-bottom, so /subjects, /subject/:id,
// /chapters/:id, /chapter/:id must all come before the /:class/:group wildcard.

/**
 * @swagger
 * /curriculum/subjects:
 *   get:
 *     summary: Get all subjects list (without chapters)
 *     tags: [Curriculum]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of subjects
 */
router.get("/subjects", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("subjects")
      .select("*")
      .order("sort_order");

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subjects" });
  }
});

/**
 * @swagger
 * /curriculum/subject/{subjectId}:
 *   get:
 *     summary: Get subject details with all chapters and subtopics
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
 *       404:
 *         description: Subject not found
 */
router.get("/subject/:subjectId", authMiddleware, async (req, res) => {
  const { subjectId } = req.params;

  try {
    const { data: subject, error } = await supabase
      .from("subjects")
      .select(`
        *,
        chapters (
          *,
          subtopics (*)
        )
      `)
      .eq("id", subjectId)
      .single();

    if (error || !subject) return res.status(404).json({ error: "Subject not found" });

    // Sort chapters and their subtopics
    const result = {
      ...subject,
      chapters: (subject.chapters || [])
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((ch) => ({
          ...ch,
          subtopics: (ch.subtopics || [])
            .filter((st) => st.is_published)
            .sort((a, b) => a.sort_order - b.sort_order),
        })),
    };

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subject" });
  }
});

/**
 * @swagger
 * /curriculum/chapters/{subjectId}:
 *   get:
 *     summary: Get all chapters for a subject (with subtopics, respects PRO access)
 *     tags: [Curriculum]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subjectId
 *         required: true
 *         schema: { type: string }
 *         description: UUID of the subject
 *     responses:
 *       200:
 *         description: Subject info + list of chapters with published subtopics
 *       404:
 *         description: Subject not found
 */
router.get("/chapters/:subjectId", authMiddleware, async (req, res) => {
  const { subjectId } = req.params;

  try {
    // Verify subject exists
    const { data: subjectCheck, error: subjectError } = await supabase
      .from("subjects")
      .select("id, name, class, group, emoji")
      .eq("id", subjectId)
      .single();

    if (subjectError || !subjectCheck) {
      return res.status(404).json({ error: "Subject not found" });
    }

    // Fetch chapters with their subtopics
    const { data: chapters, error } = await supabase
      .from("chapters")
      .select(`
        id, title, sort_order, is_free, nctb_verified, subject_id,
        subtopics (
          id, title, sort_order, duration_seconds, is_published, is_free,
          youtube_video_id, video_url_free, notes_text
        )
      `)
      .eq("subject_id", subjectId)
      .order("sort_order");

    if (error) return res.status(500).json({ error: error.message });

    // Check subscription for this user
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("status")
      .eq("user_id", req.user.id)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();

    const isPro = !!sub;

    // Sort subtopics; hide paid video IDs for free users
    const result = (chapters || []).map((ch) => ({
      ...ch,
      subtopics: (ch.subtopics || [])
        .filter((st) => st.is_published)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((st) => ({
          ...st,
          youtube_video_id: (isPro || st.is_free) ? st.youtube_video_id : null,
          video_url_free: st.is_free ? st.video_url_free : null,
        })),
    }));

    res.json({
      subject: subjectCheck,
      chapters: result,
    });
  } catch (err) {
    console.error("Chapters fetch error:", err);
    res.status(500).json({ error: "Failed to fetch chapters" });
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
 *         description: Chapter details with subtopics
 *       404:
 *         description: Chapter not found
 */
router.get("/chapter/:chapterId", authMiddleware, async (req, res) => {
  const { chapterId } = req.params;

  try {
    const { data: chapter, error } = await supabase
      .from("chapters")
      .select(`
        *,
        subject:subjects(*),
        subtopics (
          id, title, sort_order, video_url_free, video_url_paid,
          youtube_video_id, duration_seconds, is_published, notes_text, is_free
        )
      `)
      .eq("id", chapterId)
      .single();

    if (error || !chapter) return res.status(404).json({ error: "Chapter not found" });

    // Check user's subscription
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("status")
      .eq("user_id", req.user.id)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();

    const isPro = !!sub;

    // Free subtopics: all users get the video; paid subtopics: PRO only
    const subtopics = (chapter.subtopics || [])
      .filter((st) => st.is_published)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((st) => ({
        ...st,
        video_url_paid: isPro ? st.video_url_paid : null,
        youtube_video_id: (isPro || st.is_free) ? st.youtube_video_id : null,
      }));

    res.json({ ...chapter, subtopics });
  } catch (err) {
    console.error("Chapter fetch error:", err);
    res.status(500).json({ error: "Failed to fetch chapter" });
  }
});

/**
 * @swagger
 * /curriculum/{class}/{group}:
 *   get:
 *     summary: Get all subjects and chapters for a student's class and group
 *     tags: [Curriculum]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: class
 *         required: true
 *         schema: { type: integer }
 *         description: Class number e.g. 10
 *       - in: path
 *         name: group
 *         required: true
 *         schema: { type: string }
 *         description: Group name e.g. Science
 *     responses:
 *       200:
 *         description: List of subjects with chapters
 */
router.get("/:class/:group", authMiddleware, async (req, res) => {
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
      .or(`class.eq.${classVal},class.is.null`)
      .order("sort_order");

    if (error) return res.status(500).json({ error: error.message });

    // Filter by group in JS
    const filtered = subjects.filter((s) => {
      if (!s.group) return true;
      const sg = s.group.toLowerCase();
      return sg === groupVal.toLowerCase() || sg === "all";
    });

    const result = filtered.map((s) => ({
      ...s,
      chapters: (s.chapters || []).sort((a, b) => a.sort_order - b.sort_order),
    }));

    res.json(result);
  } catch (err) {
    console.error("Curriculum fetch error:", err);
    res.status(500).json({ error: "Failed to fetch curriculum" });
  }
});

export default router;
