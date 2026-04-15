import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// POST /payment/initiate
router.post("/initiate", requireAuth, async (req, res) => {
  const { plan_id } = req.body;
  
  if (!plan_id) return res.status(400).json({ error: "plan_id is required" });

  const total_amount = plan_id.includes('monthly') ? 199 : plan_id.includes('yearly') ? 1499 : 3999;
  const tran_id = `PORA_${uuidv4().substring(0, 8).toUpperCase()}`;

  // This is where you would call SSLCommerz API
  // For now, we simulate the initialization and return a fake redirect URL
  // In production, use: https://sandbox.sslcommerz.com/gwprocess/v4/api.php
  
  try {
    // Save temporary payment intent
    const { error } = await supabase.from('subscriptions').insert([{
      user_id: req.user.id,
      plan_id,
      status: 'pending',
      payment_reference: tran_id,
      amount_paid: total_amount
    }]);

    if (error) throw error;

    res.json({
      status: "SUCCESS",
      gatewayPageURL: `${process.env.PAYMENT_SUCCESS_URL}?tran_id=${tran_id}`, // Mock redirect
      tran_id
    });
  } catch (err) {
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

// POST /payment/verify (SSLCommerz Webhook)
router.post("/verify", async (req, res) => {
  const { tran_id, status, amount, pay_status } = req.body;

  if (status === 'VALID' || pay_status === 'Successful') {
    // Update subscription to active
    const expires_at = new Date();
    expires_at.setMonth(expires_at.getMonth() + (tran_id.includes('yearly') ? 12 : 1));

    try {
      const { error } = await supabase
        .from('subscriptions')
        .update({
          status: 'active',
          started_at: new Date().toISOString(),
          expires_at: expires_at.toISOString()
        })
        .eq('payment_reference', tran_id);

      if (error) throw error;
      
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=success`);
    } catch (err) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=error`);
    }
  }

  res.redirect(`${process.env.FRONTEND_URL}/dashboard?payment=failed`);
});

export default router;
