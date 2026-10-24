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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_report_tx_writer') THEN
    CREATE ROLE heisei_report_tx_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_report_reconciler') THEN
    CREATE ROLE heisei_report_reconciler NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_report_ttl_writer') THEN
    CREATE ROLE heisei_report_ttl_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- G4-B2 supersedes the isolated pre-repository function when present. The
-- legacy function remains in the schema for migration compatibility but is
-- not an executable report-write path after the repository boundary exists.
DO $$
BEGIN
  IF to_regprocedure('public.report_create_atomic_v2(uuid,character varying,character varying,character varying,uuid,jsonb,text,text,text,text,text,text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar) FROM PUBLIC, heisei_report_writer';
    EXECUTE 'REVOKE ALL ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text, text) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text, text) TO heisei_report_writer';
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
ALTER ROLE heisei_report_tx_writer NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_report_reconciler NOSUPERUSER NOBYPASSRLS NOLOGIN;
ALTER ROLE heisei_report_ttl_writer NOSUPERUSER NOBYPASSRLS NOLOGIN;

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
    EXECUTE 'GRANT SELECT ON reports TO heisei_report_writer';
    EXECUTE 'GRANT SELECT, INSERT ON report_idempotency TO heisei_report_writer';
    EXECUTE 'REVOKE INSERT ON reports, audit_logs FROM heisei_report_writer';
    EXECUTE 'REVOKE ALL ON reports, report_idempotency, audit_logs FROM heisei_report_ttl_writer';
    EXECUTE 'GRANT SELECT (id, reporter_user_id) ON report_idempotency TO heisei_report_ttl_writer';
    EXECUTE 'GRANT UPDATE (last_used_at, expires_at) ON report_idempotency TO heisei_report_ttl_writer';
    EXECUTE 'REVOKE ALL ON FUNCTION report_idempotency_touch(uuid) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION report_idempotency_touch(uuid) TO heisei_report_writer';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.report_idempotency') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON reports, report_idempotency, audit_logs FROM heisei_report_reconciler';
    EXECUTE 'GRANT SELECT ON report_idempotency TO heisei_report_reconciler';
  END IF;
END $$;

-- Re-apply visibility-reader grants only after the local visibility migration
-- has added its column. This keeps this base role script safe before migration
-- application while preserving the least-privilege reader boundary after it.
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'profiles'
        AND column_name = 'profile_visibility'
    ) THEN
    EXECUTE 'REVOKE ALL ON profiles, blocks FROM heisei_visibility_reader';
    EXECUTE 'GRANT SELECT (id, account_status, profile_visibility) ON profiles TO heisei_visibility_reader';
    EXECUTE 'GRANT SELECT ON blocks TO heisei_visibility_reader';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.reports') IS NOT NULL
    AND to_regprocedure('public.report_create_atomic(uuid,character varying,character varying,character varying)') IS NOT NULL THEN
    IF to_regprocedure('public.report_create_atomic_v2(uuid,character varying,character varying,character varying,uuid,jsonb,text,text,text,text,text,text,text)') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar) FROM PUBLIC, heisei_report_writer';
      EXECUTE 'REVOKE ALL ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text, text) FROM PUBLIC';
      EXECUTE 'GRANT EXECUTE ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text, text) TO heisei_report_writer';
    ELSE
      EXECUTE 'REVOKE ALL ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar) FROM PUBLIC';
      EXECUTE 'GRANT EXECUTE ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar) TO heisei_report_writer';
    END IF;
  END IF;
END $$;
