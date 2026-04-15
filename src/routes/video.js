import { Router } from "express";
import { requireAuth, requirePro } from "../middleware/auth.js";

const router = Router();

// GET /video/paid/:youtubeVideoId
router.get("/paid/:youtubeVideoId", requireAuth, requirePro, async (req, res) => {
  const { youtubeVideoId } = req.params;

  res.json({ url: `https://www.youtube.com/embed/${youtubeVideoId}` });
});

// GET /video/free/:subtopicId (Returns YouTube URL)
router.get("/free/:subtopicId", requireAuth, async (req, res) => {
  const { subtopicId } = req.params;
  // This would normally fetch from DB subtopics table
  res.json({ 
    url: `https://www.youtube.com/embed/dQw4w9WgXcQ`, // Placeholder
    is_free: true 
  });
});

export default router;
