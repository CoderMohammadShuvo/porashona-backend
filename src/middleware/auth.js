import { supabase } from "../lib/supabase.js";

/**
 * Middleware: verifies Supabase JWT from Authorization header.
 * Attaches req.user = { id, email, ...userRow } on success.
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.error("❌ Auth Failed: Missing or malformed header. Received:", authHeader);
    return res.status(401).json({ 
      error: "Missing or invalid Authorization header",
      hint: "Ensure you are sending 'Authorization: Bearer <token>'" 
    });
  }

  const token = authHeader.split(" ")[1];
  if (!token || token === "null" || token === "undefined") {
    console.error("❌ Auth Failed: Token is empty or literal 'null'/'undefined'");
    return res.status(401).json({ error: "Token is missing from Authorization header" });
  }

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
      if (profile.is_suspended) {
        return res.status(403).json({ error: "User profile is suspended.", code: "USER_SUSPENDED" });
      }
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

  const { data: admin, error: adminError } = await supabase
    .from("admin_users")
    .select("role")
    .eq("id", req.user.id)
    .maybeSingle();

  if (adminError || !admin) {
    console.warn(`Admin access denied for user ${req.user.id} (${req.user.email})`);
    if (adminError) console.error("Admin check error:", adminError);

    return res.status(403).json({ 
      error: "Access denied: Admin privileges required",
      debug: {
        userId: req.user.id,
        email: req.user.email,
        table: "admin_users",
        reason: adminError ? "db_error" : "not_found_in_table",
        db_message: adminError?.message
      }
    });
  }

  req.adminRole = admin.role;
  next();
}

/**
 * Middleware: requires content_uploader role.
 * Checks the `role` column on the users table, not admin_users.
 */
export async function requireContentUploader(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (req.user.role !== "content_uploader") {
    return res.status(403).json({ error: "Access denied: content_uploader role required" });
  }
  next();
}

/**
 * Middleware: passes if caller is EITHER an admin OR a content_uploader.
 * Note: does NOT share logic with requireAdmin – the two roles are checked
 * independently so a content_uploader can never escalate to admin.
 */
export async function requireAdminOrUploader(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  const isAdmin = req.user.role === "admin";
  const isUploader = req.user.role === "content_uploader";
  if (!isAdmin && !isUploader) {
    return res.status(403).json({ error: "Access denied: admin or content_uploader role required" });
  }
  next();
}

// Aliases for consistency with current route imports
export const authMiddleware = requireAuth;
export const adminMiddleware = requireAdmin;
export const proMiddleware = requirePro;

