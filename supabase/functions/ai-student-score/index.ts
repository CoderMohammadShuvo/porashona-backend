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
    // Verify the caller's token independently of RLS so userId cannot be
    // spoofed via the request body.
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

    const { userId: bodyUserId, topic_id, student_explanation_text, ui_language_override } = await req.json()

    // Enforce: the userId in the body MUST match the verified JWT identity.
    // A mismatch is a spoofing attempt – reject it.
    if (bodyUserId && bodyUserId !== callerUser.id) {
      return new Response(JSON.stringify({ error: 'userId mismatch: must match authenticated user' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const userId = callerUser.id  // always use the verified identity

    if (!topic_id || !student_explanation_text) {
      return new Response(JSON.stringify({ error: 'Missing topic_id or student_explanation_text' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }


    // Fetch user profile to resolve language settings
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

    // Per-user rate limit: max 10 calls/hour
    const { data: allowed } = await supabaseAdmin.rpc('check_ai_rate_limit', {
      p_user_id: userId,
      p_function_name: 'ai-student-score',
      p_max_calls: 10,
      p_window_hours: 1,
    })
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Maximum 10 evaluations per hour.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const targetLanguage = resolveLanguage(profile, ui_language_override)

    // Call Gemini API
    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) {

      throw new Error('GEMINI_API_KEY environment variable is not set')
    }

    const systemPrompt = `You are an expert academic evaluator. You are strictly restricted to evaluating the student's understanding of the syllabus topic: "${topic_id}".
Analyze the student's explanation and evaluate their understanding on a scale of 0 to 10 (where 0 means no understanding/incorrect, and 10 means perfect understanding).
Provide a brief, constructive feedback paragraph in ${targetLanguage}.
Rules:
1. Do NOT ask follow-up questions.
2. Do NOT reference any prior conversation or history.
3. Keep the feedback concise (maximum 3 sentences).
4. Output your response in JSON format matching the schema provided.`

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `Student Explanation: ${student_explanation_text}` }
            ]
          }
        ],
        systemInstruction: {
          parts: [
            { text: systemPrompt }
          ]
        },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              score: { type: 'INTEGER' },
              feedback: { type: 'STRING' }
            },
            required: ['score', 'feedback']
          }
        }
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error("Gemini call failed:", errText)
      throw new Error("Failed to evaluate explanation with Gemini API")
    }

    const geminiResult = await response.json()
    const textResponse = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text
    if (!textResponse) {
      throw new Error("Empty response returned from Gemini")
    }

    const parsedResult = JSON.parse(textResponse)
    const score = Math.max(0, Math.min(10, Number(parsedResult.score ?? 0)))
    const feedback = parsedResult.feedback ?? ""

    // Persist score to ai_student_scores
    const { data: scoreRecord, error: dbError } = await supabaseAdmin
      .from('ai_student_scores')
      .insert({
        user_id: userId,
        topic_id,
        score,
        feedback_text: feedback
      })
      .select()
      .single()

    if (dbError) {
      throw dbError
    }

    return new Response(JSON.stringify(scoreRecord), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error("Error in ai-student-score edge function:", err)
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
