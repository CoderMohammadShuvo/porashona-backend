/**
 * AI Note Generator Routes — /notes
 *
 * Endpoints:
 *   POST   /notes/generate          — Upload a file → AI generates structured notes → save to DB
 *   GET    /notes/generated         — List user's generated notes
 *   DELETE /notes/generated/:id     — Delete a generated note
 *
 * The generated notes are stored as an HTML string in Supabase Storage under the
 * `generated-notes` bucket.  The `generated_pdf_url` column holds this public URL.
 *
 * Supported upload types: PDF, DOCX (text extracted), PNG/JPG (described by AI)
 * Max file size: 50 MB (but text extraction capped at first 15,000 chars to avoid token abuse)
 */

import { Router } from "express";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
import { v4 as uuidv4 } from "uuid";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";
import { callOpenRouter } from "../lib/aiProvider.js";
import rateLimit from "express-rate-limit";

const router = Router();

// ─── Multer — 50 MB in-memory ───────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/png",
      "image/jpeg",
      "image/jpg",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Please upload PDF, DOCX, PPTX, PNG, or JPG."));
    }
  },
});

// Rate limit: max 5 note generations per user per 10 minutes
const generateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: "Too many note generation requests. Please wait a few minutes." },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Ensure the Supabase storage bucket exists */
async function ensureNotesBucket() {
  try {
    const { error } = await supabase.storage.getBucket("generated-notes");
    if (error && error.message.includes("not found")) {
      await supabase.storage.createBucket("generated-notes", {
        public: true,
        allowedMimeTypes: ["text/html", "text/plain"],
        fileSizeLimit: 10 * 1024 * 1024, // 10 MB for note files
      });
      console.log("[Notes] Created storage bucket: generated-notes");
    }
  } catch (e) {
    console.error("[Notes] Bucket check failed:", e.message);
  }
}
ensureNotesBucket();

/** Extract text from an uploaded file buffer */
async function extractText(file) {
  const mime = file.mimetype;

  if (mime === "application/pdf") {
    try {
      const data = await pdfParse(file.buffer);
      return { text: (data.text || "").trim(), pageCount: data.numpages || 1 };
    } catch (e) {
      console.error("[Notes] PDF parse error:", e.message);
      return { text: "", pageCount: 1 };
    }
  }

  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    // For DOCX/PPTX: convert buffer to string and strip binary noise
    const raw = file.buffer.toString("utf-8", 0, 500000);
    const text = raw.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{5,}/g, "\n").trim();
    return { text: text.slice(0, 15000), pageCount: 1 };
  }

  if (mime.startsWith("image/")) {
    // For images: we'll tell the AI about the image type and let it generate generic notes
    return {
      text: `[IMAGE FILE: ${file.originalname}] - The student has uploaded an image. Generate comprehensive revision notes about the topic visible in or suggested by this filename.`,
      pageCount: 1,
    };
  }

  return { text: "", pageCount: 1 };
}

/** Build the AI prompt for note generation */
function buildNotePrompt(fileName, extractedText) {
  const contentSection = extractedText && extractedText.length > 50
    ? `SOURCE DOCUMENT CONTENT (use this as your primary reference):
---
${extractedText.slice(0, 12000)}
---`
    : `Source document: "${fileName}" — Generate comprehensive academic revision notes on this topic.`;

  return `You are an expert academic tutor creating professional revision notes for a student.

${contentSection}

Generate COMPLETE, WELL-STRUCTURED revision notes in the following HTML format:

<div class="notes-document">
  <h1>[Document Title - derive from content]</h1>
  <p class="subtitle">AI-Generated Revision Notes • [Subject/Topic]</p>

  <div class="section">
    <h2>📌 Key Concepts</h2>
    [Bullet points of core concepts from the document]
  </div>

  <div class="section">
    <h2>📖 Detailed Summary</h2>
    [Comprehensive section-by-section summary. Include definitions, formulas, and explanations]
  </div>

  <div class="section">
    <h2>🔢 Important Formulas & Definitions</h2>
    [Key formulas (use $...$ for math), important terms with definitions]
  </div>

  <div class="section">
    <h2>💡 Tips for Exam Preparation</h2>
    [Study tips and common exam focus areas from this content]
  </div>

  <div class="section">
    <h2>❓ Practice Questions</h2>
    <ol>
      [5 practice questions based on the content with brief answers]
    </ol>
  </div>
</div>

RULES:
1. Output ONLY the HTML — no markdown code fences, no extra text before or after.
2. Make notes comprehensive yet concise. Aim for 3-6 pages worth of content.
3. Use proper HTML tags: <h1>, <h2>, <h3>, <p>, <ul>, <li>, <ol>, <strong>, <em>, <code>.
4. For mathematical expressions, wrap in <span class="math">...</span>.
5. Be specific — use the actual content from the document, not generic placeholders.`;
}

/** Upload HTML content to Supabase Storage and return the public URL */
async function uploadNoteHTML(htmlContent, userId) {
  const fileName = `${userId}/${uuidv4()}.html`;
  const buffer = Buffer.from(htmlContent, "utf-8");

  const { data, error } = await supabase.storage
    .from("generated-notes")
    .upload(fileName, buffer, {
      contentType: "text/html",
      upsert: false,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: { publicUrl } } = supabase.storage
    .from("generated-notes")
    .getPublicUrl(data.path);

  return publicUrl;
}

/** Also upload original source file and return its URL */
async function uploadSourceFile(file, userId) {
  const ext = file.originalname.split(".").pop() || "bin";
  const fileName = `${userId}/source-${uuidv4()}.${ext}`;

  const { data, error } = await supabase.storage
    .from("generated-notes")
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) {
    console.warn("[Notes] Source file upload failed:", error.message);
    return null;
  }

  const { data: { publicUrl } } = supabase.storage
    .from("generated-notes")
    .getPublicUrl(data.path);

  return publicUrl;
}

// ─── POST /notes/generate ─────────────────────────────────────────────────────
/**
 * @swagger
 * /notes/generate:
 *   post:
 *     summary: Generate AI revision notes from an uploaded document or image
 *     description: |
 *       Accepts a file upload (PDF, DOCX, PPTX, PNG, JPG) and uses AI to generate
 *       structured HTML revision notes. The notes are saved to Supabase Storage and
 *       a record is created in the `generated_notes` table.
 *
 *       **Rate limit:** 5 requests per 10 minutes per user.
 *     tags: [Notes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Document or image file (max 50MB)
 *     responses:
 *       200:
 *         description: Generated note record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 title: { type: string }
 *                 file_name: { type: string }
 *                 page_count: { type: integer }
 *                 file_size_bytes: { type: integer }
 *                 pdf_url: { type: string }
 *                 created_at: { type: string, format: date-time }
 *       400:
 *         description: No file provided
 *       429:
 *         description: Rate limit reached
 *       500:
 *         description: AI generation failed
 */
router.post("/generate", authMiddleware, generateLimiter, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided. Please upload a PDF, DOCX, PPTX, PNG, or JPG file." });
  }

  const userId = req.user.id;
  const file = req.file;

  console.log(`[Notes] Generating note for user ${userId}, file: ${file.originalname} (${file.size} bytes)`);

  try {
    // ── 1. Extract text from document ────────────────────────────────────────
    const { text: extractedText, pageCount } = await extractText(file);

    // ── 2. Generate AI notes ─────────────────────────────────────────────────
    const prompt = buildNotePrompt(file.originalname, extractedText);
    const aiResult = await callOpenRouter(
      "You are an expert academic tutor who creates professional, well-structured HTML revision notes.",
      [{ role: "user", content: prompt }],
      { temperature: 0.3, max_tokens: 4096, skipCache: true }
    );

    let htmlContent = aiResult.content.trim();
    // Strip markdown code fences if the AI wrapped the HTML
    htmlContent = htmlContent
      .replace(/^```html\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // Ensure it's wrapped in valid HTML if not already
    if (!htmlContent.includes("<!DOCTYPE") && !htmlContent.startsWith("<html")) {
      htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Generated Notes</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #1a1a2e; background: #fff; line-height: 1.7; }
  h1 { color: #f97316; border-bottom: 3px solid #f97316; padding-bottom: 12px; font-size: 2em; }
  h2 { color: #1d4ed8; margin-top: 2em; font-size: 1.4em; }
  h3 { color: #374151; font-size: 1.1em; }
  .subtitle { color: #6b7280; font-style: italic; font-size: 0.95em; margin-top: -8px; }
  .section { margin-bottom: 2.5em; padding: 20px; background: #f8fafc; border-left: 4px solid #f97316; border-radius: 0 8px 8px 0; }
  ul, ol { padding-left: 24px; }
  li { margin: 6px 0; }
  strong { color: #1e40af; }
  code { background: #e0e7ff; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.9em; }
  .math { font-family: 'Courier New', monospace; background: #fef3c7; padding: 2px 8px; border-radius: 4px; }
  @media print { body { max-width: 100%; padding: 20px; } }
</style>
</head>
<body>
${htmlContent}
</body>
</html>`;
    }

    // ── 3. Extract a clean title from the HTML ───────────────────────────────
    const titleMatch = htmlContent.match(/<h1[^>]*>(.*?)<\/h1>/i);
    let title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
      : file.originalname.replace(/\.[^/.]+$/, "") + " Notes";

    // ── 4. Upload generated HTML to Supabase Storage ─────────────────────────
    const noteUrl = await uploadNoteHTML(htmlContent, userId);

    // ── 5. Upload original source file (best-effort) ─────────────────────────
    const sourceUrl = await uploadSourceFile(file, userId).catch(() => noteUrl);

    // ── 6. Save record to generated_notes table ──────────────────────────────
    const { data: noteRecord, error: dbError } = await supabase
      .from("generated_notes")
      .insert({
        user_id: userId,
        title,
        file_name: file.originalname,
        source_file_url: sourceUrl || noteUrl,
        generated_pdf_url: noteUrl,
        page_count: pageCount,
        file_size_bytes: file.size,
      })
      .select()
      .single();

    if (dbError) {
      console.error("[Notes] DB insert error:", dbError.message);
      throw new Error("Failed to save note record: " + dbError.message);
    }

    // Return in the shape the frontend GeneratedNote interface expects
    return res.json({
      id: noteRecord.id,
      title,
      file_name: file.originalname,
      page_count: pageCount,
      file_size_bytes: file.size,
      pdf_url: noteUrl,
      created_at: noteRecord.created_at,
    });
  } catch (err) {
    console.error("[Notes] Generation error:", err.message);
    return res.status(500).json({ error: err.message || "Failed to generate notes. Please try again." });
  }
});

// ─── GET /notes/generated ─────────────────────────────────────────────────────
/**
 * @swagger
 * /notes/generated:
 *   get:
 *     summary: List all AI-generated notes for the authenticated user
 *     tags: [Notes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of generated note records
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   title: { type: string }
 *                   file_name: { type: string }
 *                   page_count: { type: integer }
 *                   file_size_bytes: { type: integer }
 *                   pdf_url: { type: string }
 *                   created_at: { type: string, format: date-time }
 */
router.get("/generated", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("generated_notes")
      .select("id, title, file_name, source_file_url, generated_pdf_url, page_count, file_size_bytes, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    // Shape records to match frontend GeneratedNote interface
    const shaped = (data || []).map((n) => {
      const urlPath = n.generated_pdf_url || "";
      const rawFileName = n.file_name || urlPath.split("/").pop() || "notes.html";
      const title = n.title || rawFileName.replace(/[-_]/g, " ").replace(/\.[^/.]+$/, "") || "Generated Notes";

      return {
        id: n.id,
        title,
        file_name: rawFileName,
        page_count: n.page_count || 1,
        file_size_bytes: n.file_size_bytes || 0,
        pdf_url: n.generated_pdf_url,
        created_at: n.created_at,
      };
    });

    return res.json(shaped);
  } catch (err) {
    console.error("[Notes] List error:", err.message);
    return res.status(500).json({ error: "Failed to fetch generated notes." });
  }
});

// ─── DELETE /notes/generated/:id ─────────────────────────────────────────────
/**
 * @swagger
 * /notes/generated/{id}:
 *   delete:
 *     summary: Delete a generated note
 *     tags: [Notes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deleted successfully
 *       404:
 *         description: Note not found
 */
router.delete("/generated/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Fetch first to verify ownership and get the storage path
    const { data: note, error: fetchErr } = await supabase
      .from("generated_notes")
      .select("id, generated_pdf_url, source_file_url")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!note) return res.status(404).json({ error: "Note not found or access denied." });

    // Delete from DB
    const { error: delErr } = await supabase
      .from("generated_notes")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (delErr) throw delErr;

    // Best-effort: remove storage files
    const pathFromUrl = (url) => {
      if (!url) return null;
      const match = url.match(/\/generated-notes\/(.+)$/);
      return match ? match[1] : null;
    };

    const paths = [
      pathFromUrl(note.generated_pdf_url),
      pathFromUrl(note.source_file_url),
    ].filter(Boolean);

    if (paths.length > 0) {
      await supabase.storage.from("generated-notes").remove(paths).catch(() => {});
    }

    return res.json({ success: true, message: "Note deleted successfully." });
  } catch (err) {
    console.error("[Notes] Delete error:", err.message);
    return res.status(500).json({ error: "Failed to delete note." });
  }
});

export default router;
