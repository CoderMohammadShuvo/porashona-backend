/**
 * Vouchers & Offers Routes – PRD §11.4 / §10.14
 *
 * RBAC:
 *  – admin only  → create vouchers
 *  – any auth'd student → list available, redeem
 *  – content_uploader  → 403 on all voucher-creation endpoints (enforced)
 *
 * Google Sheets sync is triggered server-side. If the sync fails, the
 * voucher row still records a `google_sheet_row_id = 'SYNC_PENDING'` so
 * the state is retryable, never silently dropped.
 */
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function writeAuditLog({ actorId, actorRole, action, targetType, targetId, metadata = {} }) {
  await supabase.from("audit_logs").insert({
    actor_id: actorId,
    actor_role: actorRole,
    action,
    target_type: targetType,
    target_id: String(targetId),
    metadata,
  });
}

/**
 * Calls the voucher-sheets-sync Edge Function.
 * On failure sets google_sheet_row_id = 'SYNC_PENDING' (retryable state).
 */
async function syncToSheets(voucherId, payload) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/voucher-sheets-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ voucherId, ...payload }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Sheets sync HTTP ${res.status}: ${errBody}`);
    }
    const { rowId } = await res.json();
    return rowId ?? "SYNC_OK";
  } catch (err) {
    console.error(`[voucher-sheets-sync] failed for voucher ${voucherId}:`, err.message);
    // Mark as pending so it can be retried – not a silent no-op
    await supabase
      .from("vouchers")
      .update({ google_sheet_row_id: "SYNC_PENDING" })
      .eq("id", voucherId);
    return "SYNC_PENDING";
  }
}

// ─── Admin: CREATE voucher ───────────────────────────────────────────────────
// content_uploader will receive 403 from requireAdmin
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { code, points_cost, discount_type, discount_value } = req.body;
  if (!code || points_cost == null || !discount_type || discount_value == null) {
    return res.status(400).json({ error: "code, points_cost, discount_type, and discount_value are required" });
  }
  if (!["percentage", "fixed"].includes(discount_type)) {
    return res.status(400).json({ error: "discount_type must be 'percentage' or 'fixed'" });
  }

  try {
    const { data: voucher, error } = await supabase
      .from("vouchers")
      .insert({
        code: code.toUpperCase().trim(),
        points_cost,
        discount_type,
        discount_value,
        created_by: req.user.id,
        google_sheet_row_id: "SYNC_PENDING", // optimistically mark; updated after sync
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Voucher code already exists" });
      throw error;
    }

    // Sync to Google Sheets – failure sets SYNC_PENDING, not a silent error
    const rowId = await syncToSheets(voucher.id, { action: "create", voucher });
    if (rowId !== "SYNC_PENDING") {
      await supabase.from("vouchers").update({ google_sheet_row_id: rowId }).eq("id", voucher.id);
      voucher.google_sheet_row_id = rowId;
    }

    res.status(201).json(voucher);
  } catch (err) {
    console.error("Create voucher error:", err);
    res.status(500).json({ error: "Failed to create voucher" });
  }
});

// ─── Admin: LIST all vouchers ────────────────────────────────────────────────
router.get("/admin/all", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("vouchers")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to list vouchers" });
  }
});

// ─── Student: LIST available (unredeemed) vouchers ───────────────────────────
router.get("/", requireAuth, async (req, res) => {
  // content_uploader blocked – only student/admin may list
  if (req.user.role === "content_uploader") {
    return res.status(403).json({ error: "Access denied" });
  }
  try {
    const { data, error } = await supabase
      .from("vouchers")
      .select("id, code, points_cost, discount_type, discount_value, created_at")
      .is("redeemed_by", null)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to list vouchers" });
  }
});

// ─── Student: REDEEM a voucher ───────────────────────────────────────────────
router.post("/redeem", requireAuth, async (req, res) => {
  if (req.user.role === "content_uploader") {
    return res.status(403).json({ error: "Access denied" });
  }

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code is required" });

  try {
    // 1. Fetch the voucher
    const { data: voucher, error: fetchErr } = await supabase
      .from("vouchers")
      .select("*")
      .eq("code", code.toUpperCase().trim())
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!voucher) return res.status(404).json({ error: "Voucher not found" });
    if (voucher.redeemed_by) return res.status(409).json({ error: "Voucher already redeemed" });

    // 2. Verify student's points balance via SUM(delta) – derived, never stored
    const { data: ledger, error: ledgerErr } = await supabase
      .from("points_ledger")
      .select("delta")
      .eq("user_id", req.user.id);

    if (ledgerErr) throw ledgerErr;
    const balance = (ledger || []).reduce((sum, row) => sum + row.delta, 0);

    if (balance < voucher.points_cost) {
      return res.status(400).json({
        error: "Insufficient points",
        balance,
        required: voucher.points_cost,
      });
    }

    // 3. Mark voucher redeemed
    const now = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .from("vouchers")
      .update({ redeemed_by: req.user.id, redeemed_at: now })
      .eq("id", voucher.id)
      .is("redeemed_by", null)  // prevents race condition
      .select()
      .maybeSingle();

    if (updateErr) throw updateErr;
    if (!updated) return res.status(409).json({ error: "Voucher was just redeemed by another request" });

    // 4. Deduct points via the central award_points function (negative delta)
    const { error: rpcErr } = await supabase.rpc("award_points", {
      p_user_id: req.user.id,
      p_reason: "voucher_redeem",
      p_custom_delta: -voucher.points_cost,
    });
    if (rpcErr) console.error("award_points RPC error on voucher redeem:", rpcErr.message);

    // 5. Sync update to Sheets – failure → SYNC_PENDING, surfaced not swallowed
    await syncToSheets(voucher.id, {
      action: "redeem",
      redeemed_by: req.user.id,
      redeemed_at: now,
      google_sheet_row_id: updated.google_sheet_row_id,
    });

    res.json({ success: true, voucher: updated });
  } catch (err) {
    console.error("Redeem voucher error:", err);
    res.status(500).json({ error: "Failed to redeem voucher" });
  }
});

export default router;
