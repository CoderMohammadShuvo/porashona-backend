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

    const { noteId, difficulty, questionCount } = await req.json()

    if (!noteId || !difficulty || !questionCount) {
      return new Response(JSON.stringify({ error: 'Missing noteId, difficulty, or questionCount' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const count = Number(questionCount)
    if (count !== 5 && count !== 10 && count !== 15) {
      return new Response(JSON.stringify({ error: 'Question count must be 5, 10, or 15' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }



    // Retrieve note
    const { data: note, error: noteErr } = await supabaseAdmin
      .from('generated_notes')
      .select('*, users(*)')
      .eq('id', noteId)
      .maybeSingle()

    if (noteErr || !note) {
      return new Response(JSON.stringify({ error: 'Source note not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Ownership check: the caller must own the note they are generating a quiz from
    if (note.user_id !== callerUser.id) {
      return new Response(JSON.stringify({ error: 'Access denied: you do not own this note' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Per-user rate limit: max 10 quiz generations per day (24-hour window)
    const { data: allowed } = await supabaseAdmin.rpc('check_ai_rate_limit', {
      p_user_id: callerUser.id,
      p_function_name: 'generate-quiz',
      p_max_calls: 10,
      p_window_hours: 24,
    })
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Maximum 10 quiz generations per day.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const targetLanguage = resolveLanguage(note.users)

    // Call Gemini API to produce MCQs

    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set')
    }

    const systemPrompt = `You are an EdTech assessment creator.
Generate exactly ${count} multiple choice questions (MCQs) based on the provided study notes.
Target language for questions, options, and explanations is ${targetLanguage}.
Difficulty level: ${difficulty}.
Return the response as a JSON object matching the schema. Each question must have exactly 4 options.`

    const noteContext = `Study Note Reference PDF: ${note.generated_pdf_url}`
    const modelsToTry = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"];
    let response: any;
    for (const model of modelsToTry) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
    response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `Create quiz from notes content context: ${noteContext}` }
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
              questions: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    question_text: { type: 'STRING' },
                    options: {
                      type: 'ARRAY',
                      items: { type: 'STRING' }
                    },
                    correct_answer_index: { type: 'INTEGER' },
                    explanation: { type: 'STRING' }
                  },
                  required: ['question_text', 'options', 'correct_answer_index', 'explanation']
                }
              }
            },
            required: ['questions']
          }
        }
      })
      if (response.ok) break;
      console.warn(`Model ${model} failed with status:`, response.status);
    }

    if (!response || !response.ok) {
      const errText = await response.text()
      console.error("Gemini quiz generation failed:", errText)
      throw new Error("Failed to generate quiz questions using Gemini")
    }

    const geminiResult = await response.json()
    const textResponse = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text
    if (!textResponse) {
      throw new Error("Empty response returned from Gemini")
    }

    const parsedResult = JSON.parse(textResponse)

    // Insert into generated_quizzes
    const { data: quizRow, error: dbError } = await supabaseAdmin
      .from('generated_quizzes')
      .insert({
        note_id: noteId,
        questions: parsedResult.questions,
        difficulty,
        question_count: count
      })
      .select()
      .single()

    if (dbError) {
      throw dbError
    }

    return new Response(JSON.stringify(quizRow), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error("Error in generate-quiz function:", err)
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
