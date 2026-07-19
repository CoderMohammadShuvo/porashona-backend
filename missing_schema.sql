-- ======================================================
-- 0. Create Enums (if they do not exist)
-- ======================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('student', 'content_uploader', 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'academic_version') THEN
    CREATE TYPE academic_version AS ENUM ('bangla_version', 'english_version', 'english_medium');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
    CREATE TYPE subscription_status AS ENUM ('active', 'inactive');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_plan') THEN
    CREATE TYPE subscription_plan AS ENUM ('monthly', 'yearly');
  END IF;
END$$;

-- ======================================================
-- 1. Alter Users Table to add missing columns
-- ======================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role DEFAULT 'student';
ALTER TABLE users ADD COLUMN IF NOT EXISTS version academic_version DEFAULT 'bangla_version';
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status subscription_status DEFAULT 'inactive';
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan subscription_plan;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_language TEXT DEFAULT 'bn';
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_language_override TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMP WITH TIME ZONE;

-- 11. Payments Table
CREATE TYPE payment_method AS ENUM ('bkash', 'manual_grant');
CREATE TYPE payment_status AS ENUM ('pending', 'success', 'failed');

CREATE TABLE payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  method payment_method NOT NULL,
  bkash_transaction_id TEXT UNIQUE,
  status payment_status DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 12. Subject Priority Table
CREATE TABLE subject_priority (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  subject_id TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  PRIMARY KEY (user_id, subject_id)
);

-- 13. Audit Logs Table
CREATE TABLE audit_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  actor_id UUID,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Helper functions for RLS and validation
CREATE OR REPLACE FUNCTION check_is_admin(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM users WHERE id = user_id AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION check_is_suspended(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM users WHERE id = user_id AND is_suspended = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to make class and version immutable for students after onboarding completion
CREATE OR REPLACE FUNCTION check_student_profile_update()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    DECLARE
      updater_role user_role;
    BEGIN
      SELECT role INTO updater_role FROM users WHERE id = auth.uid();
      
      IF updater_role != 'admin' AND OLD.onboarding_completed_at IS NOT NULL THEN
        IF NEW.class IS DISTINCT FROM OLD.class OR NEW.version IS DISTINCT FROM OLD.version THEN
          RAISE EXCEPTION 'Students cannot modify class or version after completing onboarding.';
        END IF;
      END IF;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trigger_check_student_profile_update
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION check_student_profile_update();

-- Row Level Security (RLS) Configuration

-- Enable RLS on modified and new tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_priority ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- 1. Users table policies
CREATE POLICY users_admin_policy ON users FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY users_self_policy ON users FOR ALL TO authenticated
  USING (auth.uid() = id AND NOT check_is_suspended(auth.uid()))
  WITH CHECK (auth.uid() = id AND NOT check_is_suspended(auth.uid()));

-- 2. Payments table policies
CREATE POLICY payments_admin_policy ON payments FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY payments_student_policy ON payments FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- 3. Subject Priority table policies
CREATE POLICY subject_priority_admin_policy ON subject_priority FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY subject_priority_student_policy ON subject_priority FOR ALL TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()))
  WITH CHECK (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- 4. Audit Logs table policies
CREATE POLICY audit_logs_admin_policy ON audit_logs FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

-- 5. Complete Onboarding RPC
CREATE OR REPLACE FUNCTION complete_onboarding(
  p_name TEXT,
  p_class INTEGER,
  p_version academic_version,
  p_subjects TEXT[]
)
RETURNS VOID AS $$
DECLARE
  v_user_id UUID;
  v_subject TEXT;
  v_rank INTEGER := 1;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE users
  SET 
    name = p_name,
    class = p_class,
    version = p_version,
    onboarding_completed_at = NOW()
  WHERE id = v_user_id;

  DELETE FROM subject_priority WHERE user_id = v_user_id;

  IF p_subjects IS NOT NULL THEN
    FOREACH v_subject IN ARRAY p_subjects LOOP
      INSERT INTO subject_priority (user_id, subject_id, rank)
      VALUES (v_user_id, v_subject, v_rank);
      v_rank := v_rank + 1;
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 14. Gamification and Session Lock Tables

CREATE TABLE study_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  status TEXT CHECK (status IN ('active', 'paused', 'completed', 'skipped')) DEFAULT 'active',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  locked_until TIMESTAMP WITH TIME ZONE,
  note_opened_at TIMESTAMP WITH TIME ZONE,
  penalty_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure only one active session per user at a time
CREATE UNIQUE INDEX idx_active_study_session ON study_sessions(user_id) WHERE (status = 'active');

CREATE TYPE points_reason AS ENUM ('note_complete', 'quiz_complete', 'daily_streak', 'break_session', 'miss_study', 'voucher_redeem');

CREATE TABLE points_ledger (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason points_reason NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE daily_point_caps (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  points_awarded_today INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE streaks (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
  current_streak_day INTEGER DEFAULT 0,
  lives_remaining INTEGER DEFAULT 3,
  last_active_date DATE,
  restored_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE study_hours_preference (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
  hours_per_day INTEGER NOT NULL
);

CREATE TABLE exam_dates (
  curriculum TEXT PRIMARY KEY,
  exam_date DATE NOT NULL
);

-- Alter quiz_attempts to support notes/gamification if it exists
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS note_id TEXT;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS question_count INTEGER CHECK (question_count IN (5, 10, 15));
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS difficulty TEXT CHECK (difficulty IN ('easy', 'medium', 'hard', 'mixed'));
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS is_first_attempt BOOLEAN DEFAULT TRUE;

-- Enable RLS
ALTER TABLE study_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE points_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_point_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE streaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_hours_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_dates ENABLE ROW LEVEL SECURITY;

-- Study Sessions policies
CREATE POLICY study_sessions_admin ON study_sessions FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY study_sessions_self ON study_sessions FOR ALL TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()))
  WITH CHECK (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- Points Ledger policies
CREATE POLICY points_ledger_admin ON points_ledger FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY points_ledger_self ON points_ledger FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- Daily Point Caps policies
CREATE POLICY daily_point_caps_admin ON daily_point_caps FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY daily_point_caps_self ON daily_point_caps FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- Streaks policies
CREATE POLICY streaks_admin ON streaks FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY streaks_self ON streaks FOR ALL TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()))
  WITH CHECK (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- Study Hours Preference policies
CREATE POLICY study_hours_preference_admin ON study_hours_preference FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY study_hours_preference_self ON study_hours_preference FOR ALL TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()))
  WITH CHECK (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- Exam Dates policies
CREATE POLICY exam_dates_admin ON exam_dates FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY exam_dates_all ON exam_dates FOR SELECT TO authenticated
  USING (NOT check_is_suspended(auth.uid()));

-- Central Points Function
CREATE OR REPLACE FUNCTION award_points(p_user_id UUID, p_reason TEXT, p_custom_delta INTEGER DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
  v_delta INTEGER;
  v_today DATE := CURRENT_DATE;
  v_awarded INTEGER := 0;
  v_new_delta INTEGER;
BEGIN
  -- Determine delta based on reason
  IF p_reason = 'note_complete' THEN
    v_delta := 10;
  ELSIF p_reason = 'quiz_complete' THEN
    v_delta := 20;
  ELSIF p_reason = 'daily_streak' THEN
    v_delta := 15;
  ELSIF p_reason = 'break_session' THEN
    v_delta := -5;
  ELSIF p_reason = 'miss_study' THEN
    v_delta := -5;
  ELSIF p_reason = 'voucher_redeem' THEN
    v_delta := COALESCE(p_custom_delta, 0);
  ELSE
    RAISE EXCEPTION 'Invalid points reason: %', p_reason;
  END IF;

  -- If delta is positive, check and apply cap
  IF v_delta > 0 THEN
    -- Get or create daily points cap record for today
    INSERT INTO daily_point_caps (user_id, date, points_awarded_today)
    VALUES (p_user_id, v_today, 0)
    ON CONFLICT (user_id, date) DO NOTHING;

    SELECT points_awarded_today INTO v_awarded
    FROM daily_point_caps
    WHERE user_id = p_user_id AND date = v_today;

    IF v_awarded >= 50 THEN
      -- Cap reached, no points awarded
      v_new_delta := 0;
    ELSIF v_awarded + v_delta > 50 THEN
      -- Clamp points to remaining cap
      v_new_delta := 50 - v_awarded;
    ELSE
      v_new_delta := v_delta;
    END IF;

    -- Update daily caps
    IF v_new_delta > 0 THEN
      UPDATE daily_point_caps
      SET points_awarded_today = points_awarded_today + v_new_delta
      WHERE user_id = p_user_id AND date = v_today;
    END IF;
  ELSE
    -- Penalties/negative points are never capped
    v_new_delta := v_delta;
  END IF;

  -- Write to points ledger if delta is not zero
  IF v_new_delta <> 0 OR p_reason = 'voucher_redeem' THEN
    INSERT INTO points_ledger (user_id, delta, reason)
    VALUES (p_user_id, v_new_delta, p_reason::points_reason);
  END IF;

  RETURN v_new_delta;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 15. AI Student Scores Table
CREATE TABLE ai_student_scores (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 10),
  feedback_text TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 16. Generated Notes Table
CREATE TABLE generated_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  source_file_url TEXT NOT NULL,
  generated_pdf_url TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 17. Generated Quizzes Table
CREATE TABLE generated_quizzes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  note_id UUID REFERENCES generated_notes(id) ON DELETE CASCADE,
  questions JSONB NOT NULL,
  difficulty TEXT CHECK (difficulty IN ('easy', 'medium', 'hard', 'mixed')),
  question_count INTEGER NOT NULL CHECK (question_count IN (5, 10, 15)),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE ai_student_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_quizzes ENABLE ROW LEVEL SECURITY;

-- AI Student Scores policies
CREATE POLICY ai_student_scores_admin ON ai_student_scores FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY ai_student_scores_self ON ai_student_scores FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- Generated Notes policies (Admins cannot UPDATE notes, only SELECT or DELETE)
CREATE POLICY generated_notes_admin ON generated_notes FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY generated_notes_self ON generated_notes FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

CREATE POLICY generated_notes_delete ON generated_notes FOR DELETE TO authenticated
  USING (auth.uid() = user_id AND NOT check_is_suspended(auth.uid()));

-- Generated Quizzes policies (Admins cannot UPDATE quizzes, only SELECT or DELETE)
CREATE POLICY generated_quizzes_admin ON generated_quizzes FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

CREATE POLICY generated_quizzes_self ON generated_quizzes FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM generated_notes WHERE id = note_id AND user_id = auth.uid()
  ) AND NOT check_is_suspended(auth.uid()));

CREATE POLICY generated_quizzes_delete ON generated_quizzes FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM generated_notes WHERE id = note_id AND user_id = auth.uid()
  ) AND NOT check_is_suspended(auth.uid()));

-- ======================================================
-- 18. Notes Table (admin/content-uploader uploaded materials)
--     Distinct from AI-generated `generated_notes`.
-- ======================================================
CREATE TABLE notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  uploader_id UUID REFERENCES users(id) ON DELETE SET NULL,
  curriculum TEXT NOT NULL,
  class INTEGER NOT NULL,
  version TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT,
  estimated_minutes INTEGER,
  file_url TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY notes_admin ON notes FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

-- Content uploader: read/delete only their own rows; insert only their own
CREATE POLICY notes_uploader_select ON notes FOR SELECT TO authenticated
  USING (
    uploader_id = auth.uid()
    AND NOT check_is_suspended(auth.uid())
    AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'content_uploader')
  );

CREATE POLICY notes_uploader_insert ON notes FOR INSERT TO authenticated
  WITH CHECK (
    uploader_id = auth.uid()
    AND NOT check_is_suspended(auth.uid())
    AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'content_uploader')
  );

CREATE POLICY notes_uploader_delete ON notes FOR DELETE TO authenticated
  USING (
    uploader_id = auth.uid()
    AND NOT check_is_suspended(auth.uid())
    AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'content_uploader')
  );

-- Students: read-only access to all notes
CREATE POLICY notes_student_read ON notes FOR SELECT TO authenticated
  USING (NOT check_is_suspended(auth.uid()));

-- ======================================================
-- 19. Vouchers Table
-- ======================================================
CREATE TABLE vouchers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  points_cost INTEGER NOT NULL,
  discount_type TEXT CHECK (discount_type IN ('percentage', 'fixed')) NOT NULL,
  discount_value NUMERIC NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  redeemed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMP WITH TIME ZONE,
  google_sheet_row_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY vouchers_admin ON vouchers FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

-- Students: SELECT unredeemed vouchers + their own redeemed ones
CREATE POLICY vouchers_student_read ON vouchers FOR SELECT TO authenticated
  USING (
    NOT check_is_suspended(auth.uid())
    AND (redeemed_by IS NULL OR redeemed_by = auth.uid())
  );

-- ======================================================
-- 20. Manual Access Grants Table
-- ======================================================
CREATE TABLE manual_access_grants (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT,
  email TEXT NOT NULL,
  class INTEGER,
  version TEXT,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE manual_access_grants ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY manual_access_grants_admin ON manual_access_grants FOR ALL TO authenticated
  USING (check_is_admin(auth.uid()))
  WITH CHECK (check_is_admin(auth.uid()));

-- ======================================================
-- Helper: check if calling user is a content_uploader
-- ======================================================
CREATE OR REPLACE FUNCTION check_is_content_uploader(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM users WHERE id = user_id AND role = 'content_uploader'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ======================================================
-- Supabase Storage bucket policy note
-- The 'generated-notes' and 'uploads' buckets must be
-- configured with a 50MB max object size via the Supabase
-- dashboard or the management API. RLS policies on storage
-- objects should mirror the table-level policies above.
-- ======================================================


-- ======================================================
-- NON-FUNCTIONAL REQUIREMENTS: Append-Only Tables
--
-- points_ledger, payments, and audit_logs are APPEND-ONLY.
-- No hard DELETE or UPDATE to a prior row should ever be
-- issued against these tables from any code path.
-- If "deletion" is ever needed, model it as a status flag:
--   payments:     status = 'refunded' (never DELETE)
--   points_ledger: insert a negative delta (never DELETE)
--   audit_logs:   append a reversal row (never DELETE)
--
-- The triggers below enforce this at the DB level by
-- raising an exception if any DELETE is attempted.
-- ======================================================

CREATE OR REPLACE FUNCTION prevent_delete_on_immutable_table()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'DELETE is forbidden on %: this table is append-only. Model removal as a status change or a negative-delta row.', TG_TABLE_NAME;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER points_ledger_no_delete
  BEFORE DELETE ON points_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_delete_on_immutable_table();

CREATE TRIGGER payments_no_delete
  BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION prevent_delete_on_immutable_table();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_delete_on_immutable_table();

-- ======================================================
-- NON-FUNCTIONAL REQUIREMENTS: AI Rate Limiting
--
-- The Edge Functions below are the most resource-intensive
-- and require per-user rate limiting to prevent abuse:
--
--   ai-student-score    – max 10 calls/user/hour
--   ai-tutor-chat       – max 30 calls/user/hour
--   generate-note       – max 5 calls/user/day
--   generate-quiz       – max 10 calls/user/day
--
-- Rate limiting is tracked via the ai_rate_limits table.
-- Each Edge Function should call check_ai_rate_limit()
-- before invoking the upstream AI API.
-- ======================================================

CREATE TABLE IF NOT EXISTS ai_rate_limits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  function_name TEXT NOT NULL,
  window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, function_name, window_start)
);

ALTER TABLE ai_rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_rate_limits_self ON ai_rate_limits FOR ALL TO authenticated
  USING (user_id = auth.uid());

-- Helper function: check and increment rate limit.
-- Returns TRUE if the call is allowed, FALSE if limit exceeded.
CREATE OR REPLACE FUNCTION check_ai_rate_limit(
  p_user_id UUID,
  p_function_name TEXT,
  p_max_calls INTEGER,
  p_window_hours INTEGER DEFAULT 1
) RETURNS BOOLEAN AS $$
DECLARE
  v_window TIMESTAMP WITH TIME ZONE;
  v_count INTEGER;
BEGIN
  -- Truncate to the start of the rate window
  v_window := date_trunc('hour', NOW()) - INTERVAL '1 hour' * (p_window_hours - 1);

  -- Upsert: increment call count in the current window
  INSERT INTO ai_rate_limits (user_id, function_name, window_start, call_count)
  VALUES (p_user_id, p_function_name, v_window, 1)
  ON CONFLICT (user_id, function_name, window_start)
  DO UPDATE SET call_count = ai_rate_limits.call_count + 1
  RETURNING call_count INTO v_count;

  RETURN v_count <= p_max_calls;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


