-- ==============================================================================
-- Excalidraw Supabase Production Schema
-- Compatible with PostgreSQL 15+ / Supabase
-- ==============================================================================

-- 1. Create the documents table
CREATE TABLE IF NOT EXISTS public.documents (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled Drawing',
  elements JSONB NOT NULL DEFAULT '[]'::jsonb,
  app_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. Indexes for fast user queries and ordering
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON public.documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON public.documents(updated_at DESC);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- 4. Create RLS Policies so each authenticated user can only access their own documents
DROP POLICY IF EXISTS "Users can view own documents" ON public.documents;
CREATE POLICY "Users can view own documents"
  ON public.documents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own documents" ON public.documents;
CREATE POLICY "Users can insert own documents"
  ON public.documents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own documents" ON public.documents;
CREATE POLICY "Users can update own documents"
  ON public.documents FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own documents" ON public.documents;
CREATE POLICY "Users can delete own documents"
  ON public.documents FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 5. Storage Bucket Configuration for Canvas Images & Embedded PDFs
-- Note: You can create a bucket named 'canvas-files' in Supabase Studio -> Storage.
-- Make sure the bucket is public or set up storage RLS policies as shown below:

INSERT INTO storage.buckets (id, name, public)
VALUES ('canvas-files', 'canvas-files', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Storage RLS Policies:
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
CREATE POLICY "Allow authenticated uploads"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'canvas-files');

DROP POLICY IF EXISTS "Allow authenticated updates" ON storage.objects;
CREATE POLICY "Allow authenticated updates"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'canvas-files');

DROP POLICY IF EXISTS "Allow public file reads" ON storage.objects;
CREATE POLICY "Allow public file reads"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'canvas-files');
