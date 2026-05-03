-- Notice Board Table
CREATE TABLE notices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT DEFAULT 'general', -- e.g. 'exam', 'holiday', 'academic', 'system'
  target_class INTEGER, -- NULL means all classes
  target_group TEXT, -- e.g. 'Science', 'Arts', 'Commerce', NULL means all groups
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'scheduled')),
  publish_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id)
);

-- Index for filtering
CREATE INDEX idx_notices_status ON notices(status);
CREATE INDEX idx_notices_publish_date ON notices(publish_date);
CREATE INDEX idx_notices_target ON notices(target_class, target_group);

-- Enable RLS
ALTER TABLE notices ENABLE ROW LEVEL SECURITY;

-- Policies
-- 1. Everyone can read published notices where publish_date <= NOW()
CREATE POLICY "Anyone can view published notices" ON notices
  FOR SELECT USING (status = 'published' AND publish_date <= NOW());

-- 2. Admins can do everything (handled via service role or specific admin policy)
-- Note: Assuming admin_users table exists from previous KIs/context
CREATE POLICY "Admins have full access" ON notices
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM admin_users WHERE id = auth.uid()
    )
  );
