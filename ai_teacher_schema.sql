/* 
  AI TEACHER MODULE - DATABASE SCHEMA
  Extends the Porashona schema to support structured, book-based AI lessons.
*/

-- 1. AI Lessons (The "Course" or "Book" content)
CREATE TABLE ai_lessons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  teacher_id TEXT REFERENCES teachers(id),
  subject_id TEXT REFERENCES subjects(id),
  title TEXT NOT NULL,
  description TEXT,
  pdf_url TEXT, -- URL to the book PDF in storage
  content_text TEXT, -- Extracted text for LLM context (optional if using Gemini PDF)
  character_type TEXT DEFAULT 'friendly', -- friendly, strict, mentor, etc.
  tuning_data TEXT, -- Additional instructions/prompts for this specific teacher/subject
  class INTEGER NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. AI Lesson Sessions (Stateful interaction tracking)
CREATE TABLE ai_lesson_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  lesson_id UUID REFERENCES ai_lessons(id),
  current_topic_index INTEGER DEFAULT 0,
  current_state TEXT DEFAULT 'briefing', -- briefing, quizzing, completed
  last_briefing TEXT,
  last_quiz_json JSONB, -- { question: "", options: [], correctAnswer: "" }
  attempts_at_current_topic INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, lesson_id)
);

-- 3. AI Lesson History (Optional: Logs of every interaction)
CREATE TABLE ai_lesson_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID REFERENCES ai_lesson_sessions(id),
  user_id UUID REFERENCES users(id),
  role TEXT CHECK (role IN ('user', 'assistant')),
  content TEXT,
  type TEXT, -- brief, quiz, answer, feedback
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
