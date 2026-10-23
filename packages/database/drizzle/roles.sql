-- Local role boundary for HEISEI-003B-R2.
-- Create matching production roles through the approved platform process; do not
-- put passwords or service credentials in this file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_app') THEN
    CREATE ROLE heisei_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_staff') THEN
    CREATE ROLE heisei_staff NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_audit_writer') THEN
    CREATE ROLE heisei_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_identity_writer') THEN
    CREATE ROLE heisei_identity_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_profile_writer') THEN
    CREATE ROLE heisei_profile_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_block_writer') THEN
    CREATE ROLE heisei_block_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_visibility_reader') THEN
    CREATE ROLE heisei_visibility_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_report_writer') THEN
    CREATE ROLE heisei_report_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

ALTER ROLE heisei_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_staff NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_audit_writer NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_identity_writer NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_profile_writer NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_block_writer NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_visibility_reader NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_report_writer NOSUPERUSER NOBYPASSRLS NOLOGIN;

REVOKE ALL ON profiles, user_verifications, user_settings, blocks, audit_logs FROM heisei_app;
GRANT SELECT ON profiles, user_verifications, user_settings, blocks TO heisei_app;
GRANT UPDATE (display_name, bio, favorite_genres, avatar_url, updated_at) ON profiles TO heisei_app;
GRANT INSERT, UPDATE, DELETE ON user_settings TO heisei_app;
REVOKE INSERT, UPDATE, DELETE ON blocks FROM heisei_app;

REVOKE ALL ON profiles, user_verifications, user_settings, blocks, audit_logs FROM heisei_staff;
GRANT SELECT ON profiles, user_verifications, audit_logs TO heisei_staff;

REVOKE ALL ON audit_logs FROM heisei_audit_writer;
GRANT INSERT ON audit_logs TO heisei_audit_writer;

REVOKE ALL ON profiles, user_verifications FROM heisei_identity_writer;
GRANT SELECT ON profiles, user_verifications TO heisei_identity_writer;
GRANT UPDATE (auth_subject, auth_level, membership, roles_json, account_status) ON profiles TO heisei_identity_writer;
GRANT INSERT, UPDATE ON user_verifications TO heisei_identity_writer;

REVOKE ALL ON blocks, audit_logs FROM heisei_block_writer;
GRANT SELECT, INSERT, DELETE ON blocks TO heisei_block_writer;
GRANT INSERT ON audit_logs TO heisei_block_writer;

REVOKE ALL ON profiles, blocks FROM heisei_visibility_reader;
GRANT SELECT ON blocks TO heisei_visibility_reader;

-- The profile writer is the only role allowed to atomically update safe
-- profile fields and append the corresponding audit event in one transaction.
REVOKE ALL ON profiles, audit_logs FROM heisei_profile_writer;
GRANT SELECT ON profiles TO heisei_profile_writer;
GRANT UPDATE (display_name, bio, updated_at) ON profiles TO heisei_profile_writer;
GRANT INSERT ON audit_logs TO heisei_profile_writer;

-- G4-A report grants are reinforced only when the local report migration has
-- already created the tables. This keeps the base role script reusable.
DO $$
BEGIN
  IF to_regclass('public.reports') IS NOT NULL
    AND to_regclass('public.report_idempotency') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON reports, report_idempotency, audit_logs FROM heisei_report_writer';
    EXECUTE 'GRANT SELECT, INSERT ON reports, report_idempotency TO heisei_report_writer';
    EXECUTE 'GRANT INSERT ON audit_logs TO heisei_report_writer';
  END IF;
END $$;
