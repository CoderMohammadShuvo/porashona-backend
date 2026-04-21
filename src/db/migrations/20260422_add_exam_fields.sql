-- Migration: Add Exam support to Quizzes
ALTER TABLE quizzes ADD COLUMN is_exam BOOLEAN DEFAULT FALSE;
ALTER TABLE quizzes ADD COLUMN time_limit_seconds INTEGER; -- Time limit in seconds

-- Update quiz_attempts to track if it was an exam
ALTER TABLE quiz_attempts ADD COLUMN is_exam_attempt BOOLEAN DEFAULT FALSE;
