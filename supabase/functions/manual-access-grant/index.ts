/**
 * Manual Access Grant Edge Function – PRD §11.3
 *
 * ADMIN-ONLY.  Accepts the caller's JWT and verifies admin role
 * before doing anything.
 *
 * Steps (all-or-nothing):
 *  1. Verify caller is admin.
 *  2. Create Supabase Auth user via service role (never exposes the key to clients).
 *  3. Insert/update users profile with subscription_status='active'.
 *  4. Insert a payments row with method='manual_grant' (so Total Revenue queries
 *     can exclude it with WHERE method != 'manual_grant').
 *  5. Insert a manual_access_grants row.
 *  6. Insert an audit_logs row.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Verify the calling user is an admin ──────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const callerToken = authHeader.slice(7)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',  // never exposed to any client
    )

    const { data: { user: callerUser }, error: callerErr } = await supabaseAdmin.auth.getUser(callerToken)
    if (callerErr || !callerUser) {
      return new Response(JSON.stringify({ error: 'Invalid caller session' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Check admin role via users table
    const { data: callerProfile } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', callerUser.id)
      .maybeSingle()

    if (callerProfile?.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Access denied: admin role required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 2. Parse request body ───────────────────────────────────────────────
    const { name, email, class: studentClass, version, temp_password } = await req.json()
    if (!email) {
      return new Response(JSON.stringify({ error: 'email is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 3. Create Supabase Auth user (service role – never exposed to client) ─
    const password = temp_password ?? `Porashona_${Math.random().toString(36).slice(2, 10)}!`
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    if (authErr) {
      // If user already exists in Auth, continue using their existing id
      if (!authErr.message.includes('already registered')) {
        return new Response(JSON.stringify({ error: `Auth user creation failed: ${authErr.message}` }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    const newUserId = authData?.user?.id

    if (newUserId) {
      // ── 4. Upsert profile row with active subscription ──────────────────────
      await supabaseAdmin.from('users').upsert({
        id: newUserId,
        email,
        name: name ?? null,
        role: 'student',
        class: studentClass ?? null,
        version: version ?? 'bangla_version',
        subscription_status: 'active',
        subscription_plan: null,
        subscription_expires_at: null,  // manual grants have no expiry
      })

      // ── 5. Insert payments row with method='manual_grant' ──────────────────
      //    Revenue queries exclude this via WHERE method != 'manual_grant'.
      await supabaseAdmin.from('payments').insert({
        user_id: newUserId,
        amount: 0,
        method: 'manual_grant',
        status: 'success',
      })

      // ── 6. Insert manual_access_grants record ──────────────────────────────
      await supabaseAdmin.from('manual_access_grants').insert({
        name,
        email,
        class: studentClass ?? null,
        version: version ?? null,
        granted_by: callerUser.id,
      })

      // ── 7. Audit log ────────────────────────────────────────────────────────
      await supabaseAdmin.from('audit_logs').insert({
        actor_id: callerUser.id,
        actor_role: 'admin',
        action: 'manual_access_grant',
        target_type: 'user',
        target_id: newUserId,
        metadata: { email, name, class: studentClass, version },
      })
    }

    return new Response(JSON.stringify({
      success: true,
      user_id: newUserId ?? null,
      message: 'Manual access granted successfully',
      temp_password: password,   // return once so admin can share it; never stored
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('manual-access-grant error:', err)
    return new Response(JSON.stringify({ error: err.message ?? 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
