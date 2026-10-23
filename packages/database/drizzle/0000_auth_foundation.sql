-- HEISEI-003B local-only foundation migration.
-- Apply only to a newly-created isolated PostgreSQL database.
-- Do not run against Supabase, staging, production, or a shared database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auth_subject varchar(255);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auth_level integer NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS membership varchar(20) NOT NULL DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS roles_json text NOT NULL DEFAULT '["member"]';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS account_status varchar(20) NOT NULL DEFAULT 'active';

CREATE UNIQUE INDEX IF NOT EXISTS profiles_auth_subject_unique
  ON profiles (auth_subject)
  WHERE auth_subject IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_auth_level_check CHECK (auth_level BETWEEN 0 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_membership_check CHECK (membership IN ('free', 'paid', 'official'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE profiles ADD CONSTRAINT profiles_account_status_check CHECK (account_status IN ('active', 'ai_suspended', 'suspended', 'banned'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS user_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id),
  kind varchar(40) NOT NULL,
  status varchar(20) NOT NULL,
  verified_at timestamptz,
  provider_ref_hash varchar(128),
  verification_version varchar(40) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_verifications_status_check CHECK (status IN ('pending', 'verified', 'rejected', 'revoked'))
);
CREATE INDEX IF NOT EXISTS user_verifications_user_id_idx ON user_verifications(user_id);
ALTER TABLE user_verifications DROP CONSTRAINT IF EXISTS user_verifications_active_unique;
DROP INDEX IF EXISTS user_verifications_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS user_verifications_verified_unique
  ON user_verifications(user_id, kind)
  WHERE status = 'verified';

CREATE TABLE IF NOT EXISTS user_settings (
  user_id uuid PRIMARY KEY REFERENCES profiles(id),
  allow_friend_requests boolean NOT NULL DEFAULT true,
  allow_direct_messages boolean NOT NULL DEFAULT true,
  timezone varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL REFERENCES profiles(id),
  blocked_id uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocks_blocker_blocked_unique UNIQUE (blocker_id, blocked_id),
  CONSTRAINT blocks_no_self_block_check CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocker_id_idx ON blocks(blocker_id);
CREATE INDEX IF NOT EXISTS blocks_blocked_id_idx ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES profiles(id),
  target_user_id uuid REFERENCES profiles(id),
  action varchar(80) NOT NULL,
  reason varchar(240),
  request_id varchar(128),
  rule_version varchar(40) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_actor_user_id_idx ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS audit_logs_target_user_id_idx ON audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at);

-- The API sets these transaction-local settings through the dedicated roles:
-- app.user_id = authenticated profile UUID; app.auth_subject = the already
-- verified provider subject during identity lookup; app.staff_scope = one approved target UUID;
-- app.audit_actor_id = actor UUID for the trusted audit writer.
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- The application role receives only safe profile columns through roles.sql.
-- These columns must never be granted UPDATE to a general API role.
REVOKE UPDATE (auth_subject, auth_level, membership, roles_json, account_status) ON profiles FROM PUBLIC;
REVOKE ALL ON user_verifications FROM PUBLIC;
REVOKE ALL ON audit_logs FROM PUBLIC;

-- GUC values are transaction-local inputs from the trusted API role. A GUC is
-- not an identity proof by itself; each policy also requires the dedicated DB
-- role selected after server-side JWT and identity verification.
DROP POLICY IF EXISTS profiles_owner_select ON profiles;
CREATE POLICY profiles_owner_select ON profiles FOR SELECT
  USING ((current_user = 'heisei_app' OR current_user = 'heisei_profile_writer')
      AND id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS profiles_owner_update ON profiles;
CREATE POLICY profiles_owner_update ON profiles FOR UPDATE
  USING ((current_user = 'heisei_app' OR current_user = 'heisei_profile_writer')
      AND id::text = current_setting('app.user_id', true))
  WITH CHECK ((current_user = 'heisei_app' OR current_user = 'heisei_profile_writer')
      AND id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS profiles_staff_scoped_select ON profiles;
CREATE POLICY profiles_staff_scoped_select ON profiles FOR SELECT
  USING (current_user = 'heisei_staff' AND id::text = current_setting('app.staff_scope', true));
DROP POLICY IF EXISTS profiles_identity_select ON profiles;
CREATE POLICY profiles_identity_select ON profiles FOR SELECT
  USING (current_user = 'heisei_identity_writer'
      AND id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS profiles_identity_subject_select ON profiles;
CREATE POLICY profiles_identity_subject_select ON profiles FOR SELECT
  USING (current_user = 'heisei_identity_writer'
      AND auth_subject = current_setting('app.auth_subject', true));
DROP POLICY IF EXISTS profiles_identity_update ON profiles;
CREATE POLICY profiles_identity_update ON profiles FOR UPDATE
  USING (current_user = 'heisei_identity_writer'
      AND id::text = current_setting('app.user_id', true))
  WITH CHECK (current_user = 'heisei_identity_writer'
      AND id::text = current_setting('app.user_id', true));

DROP POLICY IF EXISTS user_verifications_owner_select ON user_verifications;
CREATE POLICY user_verifications_owner_select ON user_verifications FOR SELECT
  USING (current_user = 'heisei_app'
      AND user_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS user_verifications_staff_scoped_select ON user_verifications;
CREATE POLICY user_verifications_staff_scoped_select ON user_verifications FOR SELECT
  USING (current_user = 'heisei_staff' AND user_id::text = current_setting('app.staff_scope', true));
DROP POLICY IF EXISTS user_verifications_identity_select ON user_verifications;
CREATE POLICY user_verifications_identity_select ON user_verifications FOR SELECT
  USING (current_user = 'heisei_identity_writer'
      AND user_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS user_verifications_identity_subject_select ON user_verifications;
CREATE POLICY user_verifications_identity_subject_select ON user_verifications FOR SELECT
  USING (current_user = 'heisei_identity_writer'
      AND user_id IN (
        SELECT id FROM profiles
        WHERE auth_subject = current_setting('app.auth_subject', true)
      ));
DROP POLICY IF EXISTS user_verifications_identity_insert ON user_verifications;
CREATE POLICY user_verifications_identity_insert ON user_verifications FOR INSERT
  WITH CHECK (current_user = 'heisei_identity_writer'
      AND user_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS user_verifications_identity_update ON user_verifications;
CREATE POLICY user_verifications_identity_update ON user_verifications FOR UPDATE
  USING (current_user = 'heisei_identity_writer'
      AND user_id::text = current_setting('app.user_id', true))
  WITH CHECK (current_user = 'heisei_identity_writer'
      AND user_id::text = current_setting('app.user_id', true));

DROP POLICY IF EXISTS user_settings_owner_all ON user_settings;
CREATE POLICY user_settings_owner_all ON user_settings
  USING (current_user = 'heisei_app'
      AND user_id::text = current_setting('app.user_id', true))
  WITH CHECK (current_user = 'heisei_app'
      AND user_id::text = current_setting('app.user_id', true));

DROP POLICY IF EXISTS blocks_participant_select ON blocks;
CREATE POLICY blocks_participant_select ON blocks FOR SELECT
  USING (current_user = 'heisei_app'
      AND (blocker_id::text = current_setting('app.user_id', true)
        OR blocked_id::text = current_setting('app.user_id', true)));
DROP POLICY IF EXISTS blocks_owner_insert ON blocks;
CREATE POLICY blocks_owner_insert ON blocks FOR INSERT
  WITH CHECK (current_user = 'heisei_app'
      AND blocker_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS blocks_owner_delete ON blocks;
CREATE POLICY blocks_owner_delete ON blocks FOR DELETE
  USING (current_user = 'heisei_app'
      AND blocker_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS blocks_block_writer_select ON blocks;
CREATE POLICY blocks_block_writer_select ON blocks FOR SELECT
  USING (current_user = 'heisei_block_writer'
      AND (blocker_id::text = current_setting('app.user_id', true)
        OR blocked_id::text = current_setting('app.user_id', true)));
DROP POLICY IF EXISTS blocks_block_writer_insert ON blocks;
CREATE POLICY blocks_block_writer_insert ON blocks FOR INSERT
  WITH CHECK (current_user = 'heisei_block_writer'
      AND blocker_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS blocks_block_writer_delete ON blocks;
CREATE POLICY blocks_block_writer_delete ON blocks FOR DELETE
  USING (current_user = 'heisei_block_writer'
      AND blocker_id::text = current_setting('app.user_id', true));

DROP POLICY IF EXISTS audit_logs_scoped_select ON audit_logs;
CREATE POLICY audit_logs_scoped_select ON audit_logs FOR SELECT
  USING (current_user = 'heisei_staff'
      AND (actor_user_id::text = current_setting('app.staff_scope', true)
        OR target_user_id::text = current_setting('app.staff_scope', true)));
DROP POLICY IF EXISTS audit_logs_actor_insert ON audit_logs;
DROP POLICY IF EXISTS audit_logs_trusted_insert ON audit_logs;
CREATE POLICY audit_logs_trusted_insert ON audit_logs FOR INSERT
  WITH CHECK (current_user = 'heisei_audit_writer'
      AND actor_user_id::text = current_setting('app.audit_actor_id', true));
DROP POLICY IF EXISTS audit_logs_block_writer_insert ON audit_logs;
CREATE POLICY audit_logs_block_writer_insert ON audit_logs FOR INSERT
  WITH CHECK (current_user = 'heisei_block_writer'
      AND actor_user_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS audit_logs_profile_writer_insert ON audit_logs;
CREATE POLICY audit_logs_profile_writer_insert ON audit_logs FOR INSERT
  WITH CHECK (current_user = 'heisei_profile_writer'
      AND actor_user_id::text = current_setting('app.user_id', true)
      AND target_user_id::text = current_setting('app.user_id', true));

-- No UPDATE/DELETE policies are created for audit_logs: append-only for non-owner roles.
