-- ============================================================
-- Migration: Extend generated_notes table for Note Generator
-- Run this in Supabase SQL Editor or psql
-- ============================================================

-- 1. Add missing columns to generated_notes
ALTER TABLE generated_notes
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT DEFAULT 0;

-- 2. Create the Supabase Storage bucket for generated notes
-- (The backend will auto-create it, but you can pre-create here too)
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('generated-notes', 'generated-notes', true)
-- ON CONFLICT (id) DO NOTHING;

-- 3. Add INSERT policy so authenticated users can save their own notes
-- (The existing policies only cover SELECT and DELETE)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'generated_notes' AND policyname = 'generated_notes_insert_self'
  ) THEN
    CREATE POLICY generated_notes_insert_self ON generated_notes
      FOR INSERT TO authenticated
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- 4. Storage bucket policies for 'generated-notes' bucket
-- These allow authenticated users to upload/read their own files
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'generated-notes',
  'generated-notes',
  true,
  10485760,  -- 10 MB
  ARRAY['text/html', 'text/plain', 'application/pdf', 'application/octet-stream',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/png', 'image/jpeg']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 10485760;

-- Storage RLS for uploads (authenticated users can upload to their own subfolder)
CREATE POLICY "Users can upload own notes" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'generated-notes' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Storage RLS for reads (public bucket — anyone can read)
CREATE POLICY "Public read generated notes" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'generated-notes');

-- Storage RLS for deletes
CREATE POLICY "Users can delete own notes storage" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'generated-notes' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );
