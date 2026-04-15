/* 
  PORASHONA — DATABASE SCHEMA (PostgreSQL / Supabase)
  Run this SQL in your Supabase SQL Editor.
*/

-- 1. Users Table
CREATE TABLE users (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  class INTEGER DEFAULT 10,
  "group" TEXT DEFAULT 'Science',
  phone TEXT,
  guardian_phone TEXT,
  xp INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  last_active_date DATE,
  "rank" INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Subscriptions Table
CREATE TABLE subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  plan_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  payment_reference TEXT UNIQUE,
  bkash_number TEXT,
  amount_paid INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Teachers Table (Admin managed)
CREATE TABLE teachers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT,
  title TEXT,
  personality TEXT,
  system_prompt TEXT,
  is_pro_only BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  image_url TEXT,
  attire_description TEXT,
  glow_color TEXT
);

-- 4. Subjects
CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  class INTEGER,
  "group" TEXT DEFAULT 'All',
  teacher_id TEXT REFERENCES teachers(id),
  emoji TEXT,
  sort_order INTEGER DEFAULT 0
);

-- 5. Chapters
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id),
  title TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_free BOOLEAN DEFAULT FALSE,
  nctb_verified BOOLEAN DEFAULT FALSE
);

-- 6. Subtopics
CREATE TABLE subtopics (
  id TEXT PRIMARY KEY,
  chapter_id TEXT REFERENCES chapters(id),
  title TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  video_url_free TEXT,
  video_url_paid TEXT,
  youtube_video_id TEXT,
  duration_seconds INTEGER,
  is_published BOOLEAN DEFAULT TRUE,
  notes_text TEXT
);

-- 7. Video Progress
CREATE TABLE video_progress (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  subtopic_id TEXT REFERENCES subtopics(id),
  watched_seconds INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP WITH TIME ZONE,
  xp_awarded BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, subtopic_id)
);

-- 8. AI Chat Logs
CREATE TABLE ai_chat_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  teacher_id TEXT REFERENCES teachers(id),
  role TEXT CHECK (role IN ('user', 'assistant')),
  content TEXT,
  tokens_used INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Daily AI Usage
CREATE TABLE daily_ai_usage (
  user_id UUID REFERENCES users(id),
  date DATE DEFAULT CURRENT_DATE,
  questions_used INTEGER DEFAULT 0,
  videos_watched INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- 10. Admin Users
CREATE TABLE admin_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT UNIQUE,
  role TEXT DEFAULT 'content_manager'
);

-- RPC for incrementing XP safely
CREATE OR REPLACE FUNCTION increment_xp(user_id UUID, amount INTEGER)
RETURNS void AS $$
BEGIN
  UPDATE users 
  SET xp = xp + amount
  WHERE id = user_id;
END;
$$ LANGUAGE plpgsql;

-- Initial Teacher Seeding
INSERT INTO teachers (id, name, subject, title, personality, system_prompt, is_pro_only, glow_color) VALUES
('khalid', 'Prof. Khalid', 'Physics', 'The Academic Pillar', 'strict', 'You are formal, strict but fair. Expect perfection.', FALSE, 'chat-glow-strict'),
('ayaan', 'Prof. Ayaan', 'Mathematics', 'The Math Magician', 'chill', 'You are fast and energetic. Solve with magic tricks.', TRUE, 'chat-glow-chill'),
('sofia', 'Mrs. Sofia', 'Principal', 'The Visionary', 'elite', 'You are the leader. Guide students with high-level wisdom.', TRUE, 'chat-glow-elite');
