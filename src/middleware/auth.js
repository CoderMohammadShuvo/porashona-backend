import { supabase } from "../lib/supabase.js";

/**
 * Middleware: verifies Supabase JWT from Authorization header.
 * Attaches req.user = { id, email, ...userRow } on success.
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.slice(7);

  try {
    // Verify the JWT via Supabase (service role can decode any valid user token)
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    // Fetch full user profile from users table
    const { data: profile, error: profileError } = await supabase
      .from("users")
      .select("*")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      // Profile might not exist yet (right after registration)
      req.user = { id: user.id, email: user.email };
    } else {
      req.user = { ...user, ...profile };
    }

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res.status(401).json({ error: "Authentication failed" });
  }
}

/**
 * Middleware: requires active PRO subscription.
 */
export async function requirePro(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status, expires_at, plan_id")
    .eq("user_id", req.user.id)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!sub) {
    return res.status(403).json({ error: "PRO subscription required", code: "PRO_REQUIRED" });
  }

  req.subscription = sub;
  next();
}

/**
 * Middleware: requires admin role.
 */
export async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });

  const { data: admin } = await supabase
    .from("admin_users")
    .select("role")
    .eq("id", req.user.id)
    .single();

  if (!admin) {
    return res.status(403).json({ error: "Admin access required" });
  }

  req.adminRole = admin.role;
  next();
}
