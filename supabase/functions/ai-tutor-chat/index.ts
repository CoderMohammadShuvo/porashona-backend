import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { resolveLanguage } from "../shared.ts"

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
    // ── Server-side JWT verification ────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const callerToken = authHeader.slice(7)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const { data: { user: callerUser }, error: authErr } = await supabaseAdmin.auth.getUser(callerToken)
    if (authErr || !callerUser) {
      return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { userId: bodyUserId, message, ui_language } = await req.json()

    if (bodyUserId && bodyUserId !== callerUser.id) {
      return new Response(JSON.stringify({ error: 'userId mismatch: must match authenticated user' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const userId = callerUser.id

    if (!message) {
      return new Response(JSON.stringify({ error: 'Missing message' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Fetch student profile fresh at request time (no session caching)
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: 'User profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Per-user rate limit: max 30 calls/hour
    const { data: allowed } = await supabaseAdmin.rpc('check_ai_rate_limit', {
      p_user_id: userId,
      p_function_name: 'ai-tutor-chat',
      p_max_calls: 30,
      p_window_hours: 1,
    })
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Maximum 30 tutor messages per hour.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const targetLanguage = resolveLanguage(profile, ui_language)

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set')
    }

    const systemPrompt = `You are a helpful and polite academic AI tutor.
The student details:
- Name: ${profile.name || 'Student'}
- Class: ${profile.class || '10'}
- Curriculum/Group: ${profile.group || 'Science'}
- Target Response Language: ${targetLanguage}

Rules:
1. Answer ONLY academic questions relevant to the student's curriculum, class, and group.
2. If the user asks non-academic questions (e.g. personal talk, gaming, coding unrelated to curriculum, music, pop culture), politely refuse to answer and redirect them back to their academic studies.
3. Write your entire response in ${targetLanguage}.
4. Do NOT ask follow-up questions.
5. Keep your response concise, structured, and easy to read. Do not reference any prior session transcripts.`

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: message }
            ]
          }
        ],
        systemInstruction: {
          parts: [
            { text: systemPrompt }
          ]
        }
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error("Gemini call failed:", errText)
      throw new Error("Failed to communicate with AI Tutor model")
    }

    const geminiResult = await response.json()
    const tutorResponse = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text || "I am unable to answer that at this moment."

    return new Response(JSON.stringify({ response: tutorResponse }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error("Error in ai-tutor-chat edge function:", err)
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
