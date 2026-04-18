import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

/**
 * @swagger
 * /subscription/status:
 *   get:
 *     summary: Get current user subscription status
 *     tags: [Subscription]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription details
 */
router.get("/status", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .single();

  if (error && error.code !== 'PGRST116') {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    plan_id: data?.plan_id || 'free',
    isPro: !!data,
    expires_at: data?.expires_at || null,
    features: !!data ? ['unlimited_chat', 'hero_videos', 'snap_solve'] : ['limited_chat', 'textbooks']
  });
});

export default router;
