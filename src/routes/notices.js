import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const metadataPath = path.join(__dirname, "../data/notice_metadata.json");

function readMetadata() {
  try {
    if (!fs.existsSync(metadataPath)) return {};
    return JSON.parse(fs.readFileSync(metadataPath, "utf-8") || "{}");
  } catch (err) {
    console.error("Error reading notice metadata:", err);
    return {};
  }
}

function writeMetadata(data) {
  try {
    fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing notice metadata:", err);
  }
}

/**
 * @swagger
 * /notices:
 *   get:
 *     summary: Get notices for students (filtered by class/group and publish date)
 *     tags: [Notices]
 *     security:
 *       - bearerAuth: []
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
    
    query = query.or(`target_class.is.null,target_class.eq.${studentClass || 0}`);
    
    const { data, error } = await query;
    if (error) throw error;

    const metadata = readMetadata();

    // Filter by group and expired status
    const filtered = data.filter(notice => {
      // Filter by group
      if (notice.target_group && notice.target_group.toLowerCase() !== (group || "").toLowerCase()) {
        return false;
      }
      
      // Filter out expired notices
      const expireStr = metadata[notice.id]?.expire_date;
      if (expireStr) {
        const expireDate = new Date(expireStr);
        if (new Date() > expireDate) {
          return false;
        }
      }
      return true;
    }).map(notice => ({
      ...notice,
      expire_date: metadata[notice.id]?.expire_date || null
    }));

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

    const metadata = readMetadata();
    const merged = data.map(notice => ({
      ...notice,
      expire_date: metadata[notice.id]?.expire_date || null
    }));

    res.json(merged);
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
  const { title, body, category, target_class, target_group, publish_date, status, expire_date } = req.body;

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

    if (expire_date) {
      const metadata = readMetadata();
      metadata[data.id] = { expire_date };
      writeMetadata(metadata);
    }

    res.status(201).json({
      ...data,
      expire_date: expire_date || null
    });
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
  const { expire_date, ...rest } = req.body;
  try {
    const { data, error } = await supabase
      .from("notices")
      .update({ ...rest, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    if (expire_date !== undefined) {
      const metadata = readMetadata();
      if (expire_date) {
        metadata[req.params.id] = {
          ...(metadata[req.params.id] || {}),
          expire_date
        };
      } else if (metadata[req.params.id]) {
        delete metadata[req.params.id].expire_date;
      }
      writeMetadata(metadata);
    }

    const currentMetadata = readMetadata()[req.params.id] || {};
    res.json({
      ...data,
      expire_date: currentMetadata.expire_date || null
    });
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
