/*
  AI Faculty System — Database Migration
  Run in Supabase SQL Editor.

  This migration ensures the required tables and indexes exist
  for the AI Faculty chat system. Most tables already exist from
  the base schema — this adds any missing indexes and the
  RPC function for usage tracking.
*/

-- ─── Indexes for AI Chat Performance ─────────────────────

-- Fast lookup of daily usage per user
CREATE INDEX IF NOT EXISTS idx_daily_ai_usage_user_date
  ON daily_ai_usage (user_id, date);

-- Fast chat history retrieval
CREATE INDEX IF NOT EXISTS idx_ai_chat_logs_user_teacher
  ON ai_chat_logs (user_id, teacher_id, created_at DESC);

-- Fast subscription status check
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON subscriptions (user_id, status, expires_at);

-- Fast subtopic notes lookup by chapter
CREATE INDEX IF NOT EXISTS idx_subtopics_chapter_published
  ON subtopics (chapter_id, is_published);

-- ─── RPC: Atomic Usage Increment ─────────────────────────

CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_user_id UUID,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO daily_ai_usage (user_id, date, questions_used)
  VALUES (p_user_id, p_date, 1)
  ON CONFLICT (user_id, date)
  DO UPDATE SET questions_used = daily_ai_usage.questions_used + 1
  RETURNING questions_used INTO v_count;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;
