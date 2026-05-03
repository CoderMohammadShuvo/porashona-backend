-- Digital Library and Crash Courses Schema

-- 14. Library Items
CREATE TABLE library_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  file_url TEXT NOT NULL,
  file_type TEXT, -- e.g. 'pdf', 'image', 'doc'
  category TEXT DEFAULT 'general',
  thumbnail_url TEXT,
  is_free BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 15. Crash Courses
CREATE TABLE crash_courses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  price INTEGER DEFAULT 0,
  thumbnail_url TEXT,
  instructor TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  curriculum JSONB DEFAULT '[]', -- JSON array of modules/lessons
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE library_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE crash_courses ENABLE ROW LEVEL SECURITY;

-- Policies for Library Items
CREATE POLICY "Anyone can view free library items" ON library_items
  FOR SELECT USING (is_free = true);

CREATE POLICY "Pro users can view all library items" ON library_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM subscriptions 
      WHERE user_id = auth.uid() AND status = 'active' AND expires_at > NOW()
    )
  );

CREATE POLICY "Admins have full access to library" ON library_items
  FOR ALL USING (
    EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid())
  );

-- Policies for Crash Courses
CREATE POLICY "Anyone can view active courses" ON crash_courses
  FOR SELECT USING (is_active = true);

CREATE POLICY "Admins have full access to courses" ON crash_courses
  FOR ALL USING (
    EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid())
  );

-- ─── Storage Policies for 'porashona' bucket ─────────────────

-- 1. Allow public to read files (if you want public library access)
CREATE POLICY "Public Read Access" ON storage.objects
  FOR SELECT USING (bucket_id = 'porashona');

-- 2. Allow authenticated admins to upload files
CREATE POLICY "Admin Upload Access" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'porashona' AND
    EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid())
  );

-- 3. Allow admins to update files
CREATE POLICY "Admin Update Access" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'porashona' AND
    EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid())
  );

-- 4. Allow admins to delete files
CREATE POLICY "Admin Delete Access" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'porashona' AND
    EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid())
  );

