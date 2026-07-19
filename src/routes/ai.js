import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";

const router = Router();

/**
 * Endpoint to update the user's UI language override manually.
 * Accepts { language_override: 'bn' | 'en' | null }
 */
router.patch("/language-override", authMiddleware, async (req, res) => {
  const { language_override } = req.body;
  
  if (language_override !== undefined && language_override !== null && language_override !== 'bn' && language_override !== 'en') {
    return res.status(400).json({ error: "Invalid language override value (must be 'bn', 'en', or null)" });
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .update({ ui_language_override: language_override })
      .eq("id", req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Language override updated successfully",
      profile: data
    });
  } catch (err) {
    console.error("Language override update failed:", err);
    res.status(500).json({ error: "Failed to update language override" });
  }
});

/**
 * Admin view generated notes.
 * Excludes editing per PRD ("Generated notes are not editable by admins").
 */
router.get("/admin/notes", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("generated_notes")
      .select("*, users(email, name)")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Admin view notes error:", err);
    res.status(500).json({ error: "Failed to fetch generated notes list" });
  }
});

/**
 * Admin delete generated note.
 */
router.delete("/admin/notes/:id", authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("generated_notes")
      .delete()
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, message: "Note deleted successfully", note: data });
  } catch (err) {
    console.error("Admin delete note error:", err);
    res.status(500).json({ error: "Failed to delete generated note" });
  }
});

export default router;
