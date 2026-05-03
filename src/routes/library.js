import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Library
 *   description: Digital Library Management
 */

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
    res.json(data);
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
    const { data, error } = await supabase
      .from("library_items")
      .insert([req.body])
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
 * /library/{id}:
 *   patch:
 *     summary: Update a library item (Admin)
 *     tags: [Library]
 *     security:
 *       - bearerAuth: []
 */
router.patch("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("library_items")
      .update(req.body)
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
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
