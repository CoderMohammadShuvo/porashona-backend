/**
 * Revenue & Purchase History Routes – PRD §11.5 / §11.6
 *
 * ADMIN-ONLY.  content_uploader will receive 403 from requireAdmin.
 *
 * Both endpoints EXPLICITLY exclude rows where method = 'manual_grant'.
 * Manual access grants never appear in revenue figures or purchase lists.
 */
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

// ─── Purchase History (§11.5) ─────────────────────────────────────────────────
// Returns joined payments + user profile. manual_grant rows excluded.
router.get("/purchase-history", requireAuth, requireAdmin, async (req, res) => {
  const { search, start_date, end_date, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from("payments")
      .select(`
        id,
        amount,
        method,
        status,
        created_at,
        users ( id, name, email, class, version )
      `)
      // EXPLICITLY exclude manual_grant rows – PRD §11.5
      .neq("method", "manual_grant")
      .eq("status", "success")
      .order("created_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (start_date) query = query.gte("created_at", start_date);
    if (end_date)   query = query.lte("created_at", end_date);

    const { data, error } = await query;
    if (error) throw error;

    // Apply search filter in JS after join (name/email are on joined relation)
    let result = data || [];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.users?.name?.toLowerCase().includes(s) ||
          p.users?.email?.toLowerCase().includes(s)
      );
    }

    res.json(result);
  } catch (err) {
    console.error("Purchase history error:", err);
    res.status(500).json({ error: "Failed to fetch purchase history" });
  }
});

// ─── Total Revenue (§11.6) ────────────────────────────────────────────────────
// SUM per day (or week) for chart rendering. manual_grant excluded.
router.get("/total-revenue", requireAuth, requireAdmin, async (req, res) => {
  const { start_date, end_date, group_by = "day" } = req.query;

  if (!["day", "week", "month"].includes(group_by)) {
    return res.status(400).json({ error: "group_by must be 'day', 'week', or 'month'" });
  }

  try {
    // Fetch raw success payments (not manual_grant)
    let query = supabase
      .from("payments")
      .select("amount, created_at")
      .eq("status", "success")
      // EXPLICITLY exclude manual_grant rows – PRD §11.6
      .neq("method", "manual_grant")
      .order("created_at", { ascending: true });

    if (start_date) query = query.gte("created_at", start_date);
    if (end_date)   query = query.lte("created_at", end_date);

    const { data, error } = await query;
    if (error) throw error;

    // Aggregate in JS by the requested granularity
    const buckets = {};
    for (const row of data || []) {
      const d = new Date(row.created_at);
      let key;
      if (group_by === "day") {
        key = d.toISOString().slice(0, 10);           // YYYY-MM-DD
      } else if (group_by === "week") {
        // ISO week: find Monday of the week
        const day = d.getDay() || 7;
        const monday = new Date(d);
        monday.setDate(d.getDate() - day + 1);
        key = monday.toISOString().slice(0, 10);
      } else {
        key = d.toISOString().slice(0, 7);            // YYYY-MM
      }
      buckets[key] = (buckets[key] || 0) + Number(row.amount);
    }

    const series = Object.entries(buckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, total]) => ({ period, total }));

    const grandTotal = series.reduce((s, r) => s + r.total, 0);

    res.json({ grand_total: grandTotal, group_by, series });
  } catch (err) {
    console.error("Total revenue error:", err);
    res.status(500).json({ error: "Failed to compute total revenue" });
  }
});

export default router;
