import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";
import { v4 as uuidv4 } from 'uuid';

const router = Router();

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

  const total_amount = plan_id.includes('monthly') ? 199 : plan_id.includes('yearly') ? 1499 : 3999;
  const tran_id = `PORA_${uuidv4().substring(0, 8).toUpperCase()}`;

  const data = {
    store_id: process.env.SSLCOMMERZ_STORE_ID || "dummy65e0642fa3d66",
    store_passwd: process.env.SSLCOMMERZ_STORE_PASSWORD || "dummy65e0642fa3d66@ssl",
    total_amount: total_amount,
    currency: "BDT",
    tran_id: tran_id,
    success_url: `${process.env.BACKEND_URL || "https://porashona-backend.railway.app"}/payment/success`,
    fail_url: `${process.env.BACKEND_URL || "https://porashona-backend.railway.app"}/payment/fail`,
    cancel_url: `${process.env.BACKEND_URL || "https://porashona-backend.railway.app"}/payment/cancel`,
    ipn_url: `${process.env.BACKEND_URL || "https://porashona-backend.railway.app"}/payment/ipn`,
    shipping_method: "NO",
    product_name: `Porashona Pro - ${plan_id}`,
    product_category: "Education",
    product_profile: "non-physical-goods",
    cus_name: req.user.email,
    cus_email: req.user.email,
    cus_add1: "Dhaka",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    cus_phone: "01700000000",
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

    const response = await fetch("https://sandbox.sslcommerz.com/gwprocess/v4/api.php", {
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
      res.status(400).json({ error: result.failedreason || "Payment initiation failed" });
    }
  } catch (err) {
    console.error("Payment init error:", err);
    res.status(500).json({ error: "Payment server error" });
  }
});

router.post("/success", async (req, res) => {
  const { tran_id, val_id } = req.body;

  // Ideally, verify with SSLCommerz here using val_id
  const expires_at = new Date();
  expires_at.setMonth(expires_at.getMonth() + (tran_id.includes('yearly') ? 12 : 1));

  try {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .update({
        status: 'active',
        started_at: new Date().toISOString(),
        expires_at: expires_at.toISOString()
      })
      .eq('payment_reference', tran_id)
      .select('user_id')
      .single();

    if (subscription) {
      // Logic for total stats / rewards could go here
    }
    
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=success`);
  } catch (err) {
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=error`);
  }
});

router.post("/fail", (req, res) => {
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=failed`);
});

router.post("/cancel", (req, res) => {
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=cancelled`);
});

export default router;
