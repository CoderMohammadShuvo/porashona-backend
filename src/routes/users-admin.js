/**
 * User Management Admin Routes – PRD §11.7 / §14 Permissions Matrix
 *
 * ADMIN-ONLY.  content_uploader will receive 403 from requireAdmin.
 *
 * Class/version update is the SOLE authorised code path in the entire
 * backend that may change these fields post-onboarding.
 * Every mutation writes an audit_logs row.
 */
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

// ─── Shared helpers ──────────────────────────────────────────────────────────
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

// ─── LIST / SEARCH users ─────────────────────────────────────────────────────
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const { search, role, is_suspended, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from("users")
      .select("id, email, name, role, class, version, is_suspended, subscription_status, created_at")
      .order("created_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (search) {
      query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`);
    }
    if (role) query = query.eq("role", role);
    if (is_suspended !== undefined) query = query.eq("is_suspended", is_suspended === "true");

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    console.error("List users error:", err);
    res.status(500).json({ error: "Failed to list users" });
  }
});

// ─── GET single user ─────────────────────────────────────────────────────────
router.get("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "User not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ─── SUSPEND / ACTIVATE toggle ────────────────────────────────────────────────
router.patch("/users/:id/suspend", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { is_suspended } = req.body;

  if (typeof is_suspended !== "boolean") {
    return res.status(400).json({ error: "is_suspended must be a boolean" });
  }

  try {
    const { data: before } = await supabase
      .from("users")
      .select("is_suspended, email")
      .eq("id", id)
      .maybeSingle();

    if (!before) return res.status(404).json({ error: "User not found" });

    const { data, error } = await supabase
      .from("users")
      .update({ is_suspended })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    await writeAuditLog({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: is_suspended ? "suspend_user" : "activate_user",
      targetType: "user",
      targetId: id,
      metadata: { previous: before.is_suspended, current: is_suspended, email: before.email },
    });

    res.json({ success: true, user: data });
  } catch (err) {
    console.error("Suspend toggle error:", err);
    res.status(500).json({ error: "Failed to update suspension status" });
  }
});

// ─── ADMIN class/version update ───────────────────────────────────────────────
// This is THE ONLY code path in the entire backend that may update class/version
// for a student after onboarding. The DB trigger rejects any other path.
router.patch("/users/:id/class-version", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { class: newClass, version: newVersion } = req.body;

  if (newClass == null && newVersion == null) {
    return res.status(400).json({ error: "At least one of class or version must be provided" });
  }

  const VALID_VERSIONS = ["bangla_version", "english_version", "english_medium"];
  if (newVersion && !VALID_VERSIONS.includes(newVersion)) {
    return res.status(400).json({ error: `version must be one of: ${VALID_VERSIONS.join(", ")}` });
  }

  try {
    // Fetch current values for the audit log
    const { data: before, error: fetchErr } = await supabase
      .from("users")
      .select("class, version, email")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!before) return res.status(404).json({ error: "User not found" });

    const updates = {};
    if (newClass != null) updates.class = newClass;
    if (newVersion != null) updates.version = newVersion;

    // Use the service-role client to bypass the student-guard trigger.
    // The trigger only blocks non-admin sessions; service role bypasses RLS.
    const { data, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    // Write audit log with old + new values in metadata
    await writeAuditLog({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: "update_class_version",
      targetType: "user",
      targetId: id,
      metadata: {
        email: before.email,
        old_class: before.class,
        new_class: newClass ?? before.class,
        old_version: before.version,
        new_version: newVersion ?? before.version,
      },
    });

    res.json({ success: true, user: data });
  } catch (err) {
    console.error("Class/version update error:", err);
    res.status(500).json({ error: "Failed to update class/version" });
  }
});

export default router;
