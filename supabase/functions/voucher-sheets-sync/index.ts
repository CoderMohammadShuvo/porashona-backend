/**
 * Voucher Google Sheets Sync Edge Function – PRD §11.4
 *
 * Called server-side only. Google service account credentials are stored as
 * env vars (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_KEY /
 * GOOGLE_SHEET_ID) — never exposed to any client.
 *
 * Actions:
 *  – action='create'  → appendRow, return rowId
 *  – action='redeem'  → updateRow at google_sheet_row_id
 *
 * On any Sheets API failure the function returns HTTP 500 with a clear error
 * message; the caller (vouchers.js) then sets google_sheet_row_id='SYNC_PENDING'.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ─── Google JWT helper ────────────────────────────────────────────────────────
/**
 * Generates a signed JWT for a Google service account and exchanges it for
 * an access token to call Sheets API.
 */
async function getGoogleAccessToken(): Promise<string> {
  const serviceAccountEmail = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL')
  const serviceAccountKey   = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY') // PEM private key, newlines as \n

  if (!serviceAccountEmail || !serviceAccountKey) {
    throw new Error('Google service account env vars not configured')
  }

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }

  const encode = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const headerB64  = encode(header)
  const payloadB64 = encode(payload)
  const signingInput = `${headerB64}.${payloadB64}`

  // Import the RSA private key
  const pemBody = serviceAccountKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\n/g, '')
  const keyBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  )
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const jwt = `${signingInput}.${sig}`

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    throw new Error(`Google token exchange failed: ${err}`)
  }

  const { access_token } = await tokenRes.json()
  return access_token
}

// ─── Sheets helpers ──────────────────────────────────────────────────────────
async function appendRow(accessToken: string, sheetId: string, values: string[]): Promise<string> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:append?valueInputOption=USER_ENTERED&includeValuesInResponse=true`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets appendRow failed: ${err}`)
  }
  const json = await res.json()
  // Return the A1 notation of the updated range so we can address it later
  return json.updates?.updatedRange ?? 'UNKNOWN'
}

async function updateRow(accessToken: string, sheetId: string, range: string, values: string[]): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [values] }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets updateRow failed: ${err}`)
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { voucherId, action, voucher, redeemed_by, redeemed_at, google_sheet_row_id } = body

    if (!voucherId || !action) {
      return new Response(JSON.stringify({ error: 'voucherId and action are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const sheetId = Deno.env.get('GOOGLE_SHEET_ID')
    if (!sheetId) throw new Error('GOOGLE_SHEET_ID env var not configured')

    const accessToken = await getGoogleAccessToken()

    let rowId: string

    if (action === 'create' && voucher) {
      // Append a new row: [voucherId, code, points_cost, discount_type, discount_value, created_at, status]
      const values = [
        voucherId,
        voucher.code ?? '',
        String(voucher.points_cost ?? ''),
        voucher.discount_type ?? '',
        String(voucher.discount_value ?? ''),
        voucher.created_at ?? new Date().toISOString(),
        'AVAILABLE',
      ]
      rowId = await appendRow(accessToken, sheetId, values)
    } else if (action === 'redeem' && google_sheet_row_id && google_sheet_row_id !== 'SYNC_PENDING') {
      // Update the existing row's status + redemption info
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      )
      const { data: v } = await supabaseAdmin.from('vouchers').select('*').eq('id', voucherId).maybeSingle()
      const values = [
        voucherId,
        v?.code ?? '',
        String(v?.points_cost ?? ''),
        v?.discount_type ?? '',
        String(v?.discount_value ?? ''),
        v?.created_at ?? '',
        'REDEEMED',
        redeemed_by ?? '',
        redeemed_at ?? new Date().toISOString(),
      ]
      await updateRow(accessToken, sheetId, google_sheet_row_id, values)
      rowId = google_sheet_row_id
    } else {
      return new Response(JSON.stringify({ error: 'Unknown action or missing fields' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ success: true, rowId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    // Failure is surfaced explicitly – caller sets SYNC_PENDING as retryable state
    console.error('voucher-sheets-sync error:', err)
    return new Response(JSON.stringify({ error: err.message ?? 'Sheets sync failed' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
