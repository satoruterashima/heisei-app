-- HEISEI-004A local-only public profile visibility foundation.
-- Apply only to a newly-created isolated PostgreSQL database. Never apply to
-- production, staging, Supabase, or a shared database from this file.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS profile_visibility varchar(20) NOT NULL DEFAULT 'private';

DO $$
BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_profile_visibility_check
    CHECK (profile_visibility IN ('private', 'public'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON profiles, blocks FROM heisei_visibility_reader;
GRANT SELECT (id, account_status, profile_visibility) ON profiles TO heisei_visibility_reader;
GRANT SELECT ON blocks TO heisei_visibility_reader;

DROP POLICY IF EXISTS profiles_visibility_reader_select ON profiles;
CREATE POLICY profiles_visibility_reader_select ON profiles FOR SELECT
  USING (
    current_user = 'heisei_visibility_reader'
    AND id::text = current_setting('app.visibility_target_id', true)
    AND profile_visibility = 'public'
  );

DROP POLICY IF EXISTS blocks_visibility_reader_select ON blocks;
CREATE POLICY blocks_visibility_reader_select ON blocks FOR SELECT
  USING (
    current_user = 'heisei_visibility_reader'
    AND (
      (blocker_id::text = current_setting('app.user_id', true)
       AND blocked_id::text = current_setting('app.visibility_target_id', true))
      OR
      (blocker_id::text = current_setting('app.visibility_target_id', true)
       AND blocked_id::text = current_setting('app.user_id', true))
    )
  );
