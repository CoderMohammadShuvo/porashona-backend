import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const metadataPath = path.join(__dirname, "../data/library_metadata.json");

function readMetadata() {
  try {
    if (!fs.existsSync(metadataPath)) return {};
    return JSON.parse(fs.readFileSync(metadataPath, "utf-8") || "{}");
  } catch (err) {
    console.error("Error reading library metadata:", err);
    return {};
  }
}

function writeMetadata(data) {
  try {
    fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing library metadata:", err);
  }
}

/**
 * @swagger
 * /library:
 *   get:
 *     summary: Get all library items
 *     tags: [Library]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of library items
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("library_items")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const metadata = readMetadata();
    const merged = data.map((item) => ({
      ...item,
      class: metadata[item.id]?.class || null,
      group: metadata[item.id]?.group || null,
    }));

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /library:
 *   post:
 *     summary: Create a new library item (Admin)
 *     tags: [Library]
 *     security:
 *       - bearerAuth: []
 */
router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { class: bookClass, group: bookGroup, ...rest } = req.body;
    const { data, error } = await supabase
      .from("library_items")
      .insert([rest])
      .select()
      .single();

    if (error) throw error;

    if (bookClass !== undefined || bookGroup !== undefined) {
      const metadata = readMetadata();
      metadata[data.id] = {
        class: bookClass ? parseInt(bookClass) : null,
        group: bookGroup || null,
      };
      writeMetadata(metadata);
    }

    res.status(201).json({
      ...data,
      class: bookClass || null,
      group: bookGroup || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /library/{id}:
 *   patch:
 *     summary: Update a library item (Admin)
 *     tags: [Library]
 *     security:
 *       - bearerAuth: []
 */
router.patch("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { class: bookClass, group: bookGroup, ...rest } = req.body;
    const { data, error } = await supabase
      .from("library_items")
      .update(rest)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    if (bookClass !== undefined || bookGroup !== undefined) {
      const metadata = readMetadata();
      metadata[req.params.id] = {
        ...(metadata[req.params.id] || {}),
        ...(bookClass !== undefined ? { class: bookClass ? parseInt(bookClass) : null } : {}),
        ...(bookGroup !== undefined ? { group: bookGroup || null } : {}),
      };
      writeMetadata(metadata);
    }

    const currentMetadata = readMetadata()[req.params.id] || {};
    res.json({
      ...data,
      class: currentMetadata.class || null,
      group: currentMetadata.group || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /library/{id}:
 *   delete:
 *     summary: Delete a library item (Admin)
 *     tags: [Library]
 *     security:
 *       - bearerAuth: []
 */
router.delete("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from("library_items")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;

    const metadata = readMetadata();
    if (metadata[req.params.id]) {
      delete metadata[req.params.id];
      writeMetadata(metadata);
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
