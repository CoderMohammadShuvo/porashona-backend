import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const SSL_IS_LIVE = process.env.SSLCOMMERZ_IS_LIVE === "true";
const SSL_BASE_URL = SSL_IS_LIVE 
  ? "https://securepay.sslcommerz.com" 
  : "https://sandbox.sslcommerz.com";

/**
 * @swagger
 * /payment/initiate:
 *   post:
 *     summary: Initiate a subscription payment
 *     tags: [Payment]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plan_id]
 *             properties:
 *               plan_id: { type: string, example: "monthly_basic" }
 *     responses:
 *       200:
 *         description: Payment initiation response with redirect URL
 */
router.post("/initiate", authMiddleware, async (req, res) => {
  const { plan_id } = req.body;
  
  if (!plan_id) return res.status(400).json({ error: "plan_id is required" });

  // Price mapping
  let total_amount = 3999; // Default/One-time
  if (plan_id.includes('monthly')) total_amount = 199;
  else if (plan_id.includes('yearly')) total_amount = 1499;

  const tran_id = `PORA_${uuidv4().substring(0, 8).toUpperCase()}`;

  const data = {
    store_id: process.env.SSLCOMMERZ_STORE_ID,
    store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD,
    total_amount: total_amount,
    currency: "BDT",
    tran_id: tran_id,
    success_url: process.env.PAYMENT_SUCCESS_URL,
    fail_url: process.env.PAYMENT_FAIL_URL,
    cancel_url: process.env.PAYMENT_CANCEL_URL,
    ipn_url: `${process.env.BACKEND_URL}/payment/ipn`,
    shipping_method: "NO",
    product_name: `Porashona Pro - ${plan_id}`,
    product_category: "Education",
    product_profile: "non-physical-goods",
    cus_name: req.user.name || req.user.email,
    cus_email: req.user.email,
    cus_add1: "Dhaka",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    cus_phone: req.user.phone || "01700000000",
  };

  try {
    // Save temporary payment intent
    await supabase.from('subscriptions').insert([{
      user_id: req.user.id,
      plan_id,
      status: 'pending',
      payment_reference: tran_id,
      amount_paid: total_amount
    }]);

    const response = await fetch(`${SSL_BASE_URL}/gwprocess/v4/api.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data).toString()
    });

    const result = await response.json();

    if (result.status === "SUCCESS") {
      res.json({
        status: "SUCCESS",
        gatewayPageURL: result.GatewayPageURL,
        tran_id
      });
    } else {
      console.error("SSLCommerz Init Fail:", result);
      res.status(400).json({ error: result.failedreason || "Payment initiation failed" });
    }
  } catch (err) {
    console.error("Payment init error:", err);
    res.status(500).json({ error: "Payment server error" });
  }
});

router.post("/success", async (req, res) => {
  const { tran_id, val_id } = req.body;

  try {
    // 1. Fetch the pending subscription to get the plan_id
    const { data: sub, error: fetchError } = await supabase
      .from('subscriptions')
      .select('plan_id, user_id')
      .eq('payment_reference', tran_id)
      .single();

    if (fetchError || !sub) {
      console.error("Subscription not found for tran_id:", tran_id);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=error&reason=not_found`);
    }

    // 2. Calculate expiry date
    const expires_at = new Date();
    if (sub.plan_id.includes('yearly')) {
      expires_at.setFullYear(expires_at.getFullYear() + 1);
    } else {
      expires_at.setMonth(expires_at.getMonth() + 1);
    }

    // 3. Update subscription status
    await supabase
      .from('subscriptions')
      .update({
        status: 'active',
        started_at: new Date().toISOString(),
        expires_at: expires_at.toISOString()
      })
      .eq('payment_reference', tran_id);

    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=success`);
  } catch (err) {
    console.error("Payment success handling error:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=error`);
  }
});

router.post("/fail", (req, res) => {
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=failed`);
});

router.post("/cancel", (req, res) => {
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=cancelled`);
});

router.post("/ipn", async (req, res) => {
  // IPN handling logic (similar to success but more robust)
  res.send("OK");
});

export default router;
