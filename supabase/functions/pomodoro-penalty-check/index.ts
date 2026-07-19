import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const token = authHeader.replace('Bearer ', '')
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized user session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { session_id } = await req.json()
    if (!session_id) {
      return new Response(JSON.stringify({ error: 'Missing session_id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Lookup session details
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('study_sessions')
      .select('*')
      .eq('id', session_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (sessionErr || !session) {
      return new Response(JSON.stringify({ error: 'Study session not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const now = new Date()
    const lockedUntil = session.locked_until ? new Date(session.locked_until) : null

    // Check if the switch falls inside an active lock window
    if (session.status === 'active' && lockedUntil && now < lockedUntil) {
      // Apply penalty (-5 points) via award_points RPC
      const { data: pointsDelta, error: rpcErr } = await supabaseAdmin.rpc('award_points', {
        p_user_id: user.id,
        p_reason: 'break_session'
      })

      if (rpcErr) {
        console.error("Failed to award penalty points:", rpcErr)
        throw rpcErr
      }

      // Increment penalty count
      await supabaseAdmin
        .from('study_sessions')
        .update({ penalty_count: session.penalty_count + 1 })
        .eq('id', session.id)

      return new Response(JSON.stringify({
        penalized: true,
        points_delta: pointsDelta,
        message: 'Tab switch penalty applied successfully.'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    } else {
      return new Response(JSON.stringify({
        penalized: false,
        message: 'No penalty applied. Either the session is inactive or the study lock window has expired.'
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

  } catch (err) {
    console.error("Penalty check error:", err)
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
