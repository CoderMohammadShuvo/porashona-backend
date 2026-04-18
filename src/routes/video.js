import { Router } from "express";
import { requireAuth, requirePro } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /video/paid/{youtubeVideoId}:
 *   get:
 *     summary: Get paid video URL
 *     tags: [Video]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: youtubeVideoId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Video URL
 */
router.get("/paid/:youtubeVideoId", requireAuth, requirePro, async (req, res) => {
  const { youtubeVideoId } = req.params;

  res.json({ url: `https://www.youtube.com/embed/${youtubeVideoId}` });
});

/**
 * @swagger
 * /video/free/{subtopicId}:
 *   get:
 *     summary: Get free video URL
 *     tags: [Video]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: subtopicId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Video URL
 */
router.get("/free/:subtopicId", requireAuth, async (req, res) => {
  const { subtopicId } = req.params;
  // This would normally fetch from DB subtopics table
  res.json({ 
    url: `https://www.youtube.com/embed/dQw4w9WgXcQ`, // Placeholder
    is_free: true 
  });
});

export default router;
