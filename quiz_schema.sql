-- NEW: Quiz System Tables

-- 11. Quizzes
CREATE TABLE quizzes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chapter_id TEXT REFERENCES chapters(id),
  subtopic_id TEXT REFERENCES subtopics(id),
  title TEXT NOT NULL,
  description TEXT,
  passing_score INTEGER DEFAULT 0,
  max_attempts INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT one_target CHECK (
    (chapter_id IS NOT NULL AND subtopic_id IS NULL) OR 
    (chapter_id IS NULL AND subtopic_id IS NOT NULL)
  )
);

-- 12. Questions
CREATE TABLE questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quiz_id UUID REFERENCES quizzes(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  options JSONB NOT NULL, -- Array of strings e.g. ["Option A", "Option B", ...]
  correct_answer_index INTEGER NOT NULL,
  explanation TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 13. Quiz Attempts (As requested)
CREATE TABLE quiz_attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  chapter_id TEXT REFERENCES chapters(id),
  subtopic_id TEXT REFERENCES subtopics(id), -- Added for subtopic quizzes
  quiz_id UUID REFERENCES quizzes(id),
  score INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  time_taken_seconds INTEGER,
  xp_earned INTEGER DEFAULT 0,
  completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for performance
CREATE INDEX idx_quiz_attempts_user ON quiz_attempts(user_id);
CREATE INDEX idx_quiz_attempts_quiz ON quiz_attempts(quiz_id);
