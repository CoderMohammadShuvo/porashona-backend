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

    const { plan } = await req.json()
    if (!plan || (plan !== 'monthly' && plan !== 'yearly')) {
      return new Response(JSON.stringify({ error: 'Invalid or missing plan (must be monthly or yearly)' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const amount = plan === 'yearly' ? 1499 : 199

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Insert pending payment record
    const { data: paymentRow, error: dbError } = await supabaseAdmin
      .from('payments')
      .insert({
        user_id: user.id,
        amount: amount,
        method: 'bkash',
        status: 'pending'
      })
      .select()
      .single()

    if (dbError) {
      console.error("DB pending insert failed:", dbError)
      return new Response(JSON.stringify({ error: 'Database error creating payment record' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Call Bkash Tokenized Grant API
    const tokenResponse = await fetch("https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/token/grant", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "username": Deno.env.get("BKASH_USERNAME") ?? "",
        "password": Deno.env.get("BKASH_PASSWORD") ?? ""
      },
      body: JSON.stringify({
        app_key: Deno.env.get("BKASH_APP_KEY") ?? "",
        app_secret: Deno.env.get("BKASH_APP_SECRET") ?? ""
      })
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      console.error("Bkash grant token failed:", errorText)
      return new Response(JSON.stringify({ error: 'Failed to authenticate with Bkash API' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const tokenData = await tokenResponse.json()
    const idToken = tokenData.id_token

    // Call Bkash Create Payment API
    const createResponse = await fetch("https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/payment/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`,
        "X-App-Key": Deno.env.get("BKASH_APP_KEY") ?? ""
      },
      body: JSON.stringify({
        mode: "0011",
        payerReference: user.email ?? user.id,
        callbackURL: Deno.env.get("BKASH_CALLBACK_URL") ?? `${Deno.env.get("SUPABASE_URL")}/functions/v1/bkash-webhook`,
        amount: amount.toString(),
        currency: "BDT",
        intent: "sale",
        merchantInvoiceNumber: paymentRow.id
      })
    })

    if (!createResponse.ok) {
      const errorText = await createResponse.text()
      console.error("Bkash payment create failed:", errorText)
      return new Response(JSON.stringify({ error: 'Failed to create payment session with Bkash' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const createData = await createResponse.json()

    // Update payment row with Bkash transaction ID (paymentID)
    const { error: updateError } = await supabaseAdmin
      .from('payments')
      .update({
        bkash_transaction_id: createData.paymentID
      })
      .eq('id', paymentRow.id)

    if (updateError) {
      console.error("Failed to update payment with transaction ID:", updateError)
    }

    return new Response(JSON.stringify({
      checkoutURL: createData.bkashURL,
      paymentID: createData.paymentID,
      paymentRecordId: paymentRow.id
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error("Unhandled initiate error:", err)
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
