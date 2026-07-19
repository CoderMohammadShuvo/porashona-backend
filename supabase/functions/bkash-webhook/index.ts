import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    let paymentID = url.searchParams.get('paymentID')
    let status = url.searchParams.get('status')

    if (req.method === 'POST') {
      try {
        const body = await req.json()
        paymentID = paymentID || body.paymentID
        status = status || body.status
      } catch (_) {
        // Safe to ignore if JSON body is not present
      }
    }

    if (!paymentID || !status) {
      return new Response(JSON.stringify({ error: 'Missing paymentID or status' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Retrieve the payment record and user info
    const { data: paymentRow, error: dbError } = await supabaseAdmin
      .from('payments')
      .select('*, users(email)')
      .eq('bkash_transaction_id', paymentID)
      .maybeSingle()

    if (dbError || !paymentRow) {
      console.error("Payment not found or DB error:", dbError, "for paymentID:", paymentID)
      return new Response(JSON.stringify({ error: 'Payment record not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Check idempotency: if already processed, return success immediately
    if (paymentRow.status === 'success') {
      return new Response(JSON.stringify({ message: 'Success (Already processed)', status: 'success' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    if (paymentRow.status === 'failed') {
      return new Response(JSON.stringify({ message: 'Failed (Already processed)', status: 'failed' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (status === 'success') {
      // 1. Authenticate with Bkash to execute
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
        throw new Error("Failed to grant token during execution")
      }

      const tokenData = await tokenResponse.json()
      const idToken = tokenData.id_token

      // 2. Execute payment via Bkash
      const executeResponse = await fetch("https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/payment/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${idToken}`,
          "X-App-Key": Deno.env.get("BKASH_APP_KEY") ?? ""
        },
        body: JSON.stringify({ paymentID })
      })

      const executeData = await executeResponse.json()

      if (executeData.statusCode !== "0000") {
        console.error("Bkash execution failed status:", executeData)
        // Mark payment as failed
        await supabaseAdmin
          .from('payments')
          .update({ status: 'failed' })
          .eq('id', paymentRow.id)

        return new Response(JSON.stringify({ message: 'Bkash transaction failed execution', code: executeData.statusCode }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Calculate expiration
      const amount = Number(paymentRow.amount)
      const isYearly = amount >= 1000
      const expiresAt = new Date()
      if (isYearly) {
        expiresAt.setFullYear(expiresAt.getFullYear() + 1)
      } else {
        expiresAt.setMonth(expiresAt.getMonth() + 1)
      }

      // 3. Update payment status to success
      const trxID = executeData.trxID || paymentID
      await supabaseAdmin
        .from('payments')
        .update({
          status: 'success',
          bkash_transaction_id: trxID
        })
        .eq('id', paymentRow.id)

      // 4. Activate user's subscription
      await supabaseAdmin
        .from('users')
        .update({
          subscription_status: 'active',
          subscription_plan: isYearly ? 'yearly' : 'monthly',
          subscription_expires_at: expiresAt.toISOString()
        })
        .eq('id', paymentRow.user_id)

      // 5. Create a subscription row for compatibility
      await supabaseAdmin
        .from('subscriptions')
        .insert({
          user_id: paymentRow.user_id,
          plan_id: isYearly ? 'yearly_pro' : 'monthly_pro',
          status: 'active',
          started_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
          payment_reference: trxID,
          amount_paid: amount
        })

      // 6. Send confirmation email
      const resendApiKey = Deno.env.get("RESEND_API_KEY")
      const userEmail = paymentRow.users?.email
      if (userEmail) {
        if (resendApiKey) {
          try {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${resendApiKey}`
              },
              body: JSON.stringify({
                from: "Porashona <noreply@porashona.com>",
                to: [userEmail],
                subject: "Your Porashona Pro Subscription is Active!",
                html: `<p>Hello,</p><p>Your payment of ৳${amount} has been successfully verified. Your subscription plan is now <strong>active</strong> until ${expiresAt.toLocaleDateString()}.</p><p>Happy learning!<br/>Team Porashona</p>`
              })
            })
            console.log("Confirmation email sent to:", userEmail)
          } catch (emailErr) {
            console.error("Resend email delivery failed:", emailErr)
          }
        } else {
          console.log(`[Email Mock] Successfully sent confirmation email to ${userEmail} for transaction ${trxID}`)
        }
      }

      return new Response(JSON.stringify({ message: 'Payment success', status: 'success', trxID }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })

    } else {
      // Payment failed or cancelled
      await supabaseAdmin
        .from('payments')
        .update({ status: 'failed' })
        .eq('id', paymentRow.id)

      return new Response(JSON.stringify({ message: 'Payment marked as failed/cancelled', status: 'failed' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

  } catch (err) {
    console.error("Webhook processing error:", err)
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
