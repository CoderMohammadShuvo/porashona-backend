import { Router } from "express";
import multer from "multer";
import { supabase } from "../lib/supabase.js";
import { anthropic, CLAUDE_MODEL } from "../lib/claude.js";
import { requireAuth, requirePro } from "../middleware/auth.js";

const router = Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

/**
 * @swagger
 * /ocr/solve:
 *   post:
 *     summary: Solve academic problem from image
 *     tags: [OCR]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Solution to the problem
 */
router.post("/solve", requireAuth, requirePro, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image provided" });

  try {
    // 1. In a real app, you'd send this to Google Vision API or similar
    // For this prototype, we'll simulate the OCR process.
    const base64Image = req.file.buffer.toString('base64');
    
    // 2. Send to Claude with vision capability (if using Vision models)
    // Or just simulated text extraction for now
    const prompt = `Solve this academic problem from a student in Bangladesh: 
    [The image contains an NCTB curriculum physics problem about Force and Motion]`;

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: "You are an expert NCTB teacher. Solve problems step-by-step with clear explanations in English/Bangla (mixed) as used in Bangladesh.",
      messages: [{ role: "user", content: prompt }]
    });

    res.json({
      solution: response.content[0].text,
      problem_extracted: "Calculate the force needed to accelerate a 5kg mass at 2m/s²"
    });

  } catch (err) {
    res.status(500).json({ error: "AI Solving failed" });
  }
});

export default router;
