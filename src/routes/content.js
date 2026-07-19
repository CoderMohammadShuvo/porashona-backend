/**
 * Content Management Routes – PRD §11.1 / §11.2
 *
 * Notes (admin/content-uploader uploaded materials, NOT AI-generated notes).
 *
 * RBAC matrix enforced server-side (never trust client-supplied filters):
 *  – admin          → read/create/delete any note
 *  – content_uploader → read/create/delete only own rows (uploader_id = auth user)
 *  – student         → read-only (no write access to this router)
 *
 * Every DELETE writes exactly one `audit_logs` row.
 */
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin, requireAdminOrUploader } from "../middleware/auth.js";

const router = Router();

// ─── Shared audit writer ────────────────────────────────────────────────────
async function writeAuditLog({ actorId, actorRole, action, targetType, targetId, metadata = {} }) {
  const { error } = await supabase.from("audit_logs").insert({
    actor_id: actorId,
    actor_role: actorRole,
    action,
    target_type: targetType,
    target_id: String(targetId),
    metadata,
  });
  if (error) console.error("audit_logs write failed:", error.message);
}

// ─── LIST notes ─────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireAdminOrUploader, async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    let query = supabase.from("notes").select("*").order("created_at", { ascending: false });

    // content_uploader sees only their own rows – enforced at query level, NOT via client filter
    if (!isAdmin) {
      query = query.eq("uploader_id", req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("List notes error:", err);
    res.status(500).json({ error: "Failed to list notes" });
  }
});

// ─── CREATE note ────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireAdminOrUploader, async (req, res) => {
  const { curriculum, class: noteClass, version, subject, chapter, estimated_minutes, file_url } = req.body;
  if (!curriculum || !noteClass || !version || !subject || !file_url) {
    return res.status(400).json({ error: "curriculum, class, version, subject, and file_url are required" });
  }

  try {
    const { data, error } = await supabase
      .from("notes")
      .insert({
        uploader_id: req.user.id,   // always stamped from the verified JWT, never from body
        curriculum,
        class: noteClass,
        version,
        subject,
        chapter: chapter || null,
        estimated_minutes: estimated_minutes || null,
        file_url,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error("Create note error:", err);
    res.status(500).json({ error: "Failed to create note" });
  }
});

// ─── GET single note ─────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireAdminOrUploader, async (req, res) => {
  const { id } = req.params;
  const isAdmin = req.user.role === "admin";

  try {
    let query = supabase.from("notes").select("*").eq("id", id);
    if (!isAdmin) query = query.eq("uploader_id", req.user.id);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Note not found or access denied" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch note" });
  }
});

// ─── DELETE note ─────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireAdminOrUploader, async (req, res) => {
  const { id } = req.params;
  const isAdmin = req.user.role === "admin";

  try {
    // Resolve the note first – enforces ownership check at query level
    let fetchQuery = supabase.from("notes").select("id, subject, uploader_id").eq("id", id);
    if (!isAdmin) fetchQuery = fetchQuery.eq("uploader_id", req.user.id);

    const { data: note, error: fetchErr } = await fetchQuery.maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!note) return res.status(404).json({ error: "Note not found or access denied" });

    const { error: delErr } = await supabase.from("notes").delete().eq("id", id);
    if (delErr) throw delErr;

    // Write exactly one audit_log row per PRD requirement
    await writeAuditLog({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: "delete_note",
      targetType: "note",
      targetId: id,
      metadata: { subject: note.subject, uploader_id: note.uploader_id },
    });

    res.json({ success: true, message: "Note deleted successfully" });
  } catch (err) {
    console.error("Delete note error:", err);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

export default router;
