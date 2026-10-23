-- HEISEI-003I-A G4-A local-only report foundation.
-- Apply only to a newly-created isolated PostgreSQL database.
-- This migration does not implement the report API or G2/G3/G5 runtime integration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_report_writer') THEN
    CREATE ROLE heisei_report_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

ALTER ROLE heisei_report_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid NOT NULL REFERENCES profiles(id),
  target_type varchar(20) NOT NULL,
  target_user_id uuid NOT NULL REFERENCES profiles(id),
  category varchar(80) NOT NULL,
  category_version varchar(40) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  description_ciphertext bytea,
  description_nonce bytea,
  encryption_algorithm_version varchar(40),
  encryption_key_version varchar(80),
  aad_version varchar(40),
  created_at timestamptz NOT NULL DEFAULT now(),
  review_closed_at timestamptz,
  CONSTRAINT reports_target_type_check CHECK (target_type = 'user'),
  CONSTRAINT reports_status_check CHECK (status = 'pending'),
  CONSTRAINT reports_description_envelope_check CHECK (
    (description_ciphertext IS NULL
      AND description_nonce IS NULL
      AND encryption_algorithm_version IS NULL
      AND encryption_key_version IS NULL
      AND aad_version IS NULL)
    OR
    (description_ciphertext IS NOT NULL
      AND description_nonce IS NOT NULL
      AND encryption_algorithm_version IS NOT NULL
      AND encryption_key_version IS NOT NULL
      AND aad_version IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS reports_pending_reporter_target_unique
  ON reports (reporter_user_id, target_type, target_user_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS report_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid NOT NULL REFERENCES profiles(id),
  reporter_scope_digest bytea NOT NULL,
  payload_fingerprint bytea NOT NULL,
  fingerprint_algorithm_version varchar(40) NOT NULL,
  fingerprint_key_version varchar(80) NOT NULL,
  report_id uuid REFERENCES reports(id),
  accepted_projection varchar(40) NOT NULL DEFAULT 'accepted',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT report_idempotency_scope_digest_length CHECK (octet_length(reporter_scope_digest) = 32),
  CONSTRAINT report_idempotency_payload_fingerprint_length CHECK (octet_length(payload_fingerprint) = 32),
  CONSTRAINT report_idempotency_expiry_check CHECK (expires_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS report_idempotency_reporter_scope_unique
  ON report_idempotency (reporter_user_id, reporter_scope_digest);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;
ALTER TABLE report_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_idempotency FORCE ROW LEVEL SECURITY;

REVOKE ALL ON reports, report_idempotency FROM PUBLIC;
REVOKE ALL ON reports, report_idempotency FROM heisei_app;
REVOKE ALL ON reports, report_idempotency FROM heisei_staff;
REVOKE ALL ON reports, report_idempotency FROM heisei_audit_writer;
REVOKE ALL ON reports, report_idempotency FROM heisei_identity_writer;
REVOKE ALL ON reports, report_idempotency FROM heisei_profile_writer;
REVOKE ALL ON reports, report_idempotency FROM heisei_block_writer;

REVOKE ALL ON reports, report_idempotency, audit_logs FROM heisei_report_writer;
GRANT SELECT, INSERT ON reports, report_idempotency TO heisei_report_writer;
GRANT INSERT ON audit_logs TO heisei_report_writer;

DROP POLICY IF EXISTS reports_writer_select ON reports;
CREATE POLICY reports_writer_select ON reports FOR SELECT
  USING (current_user = 'heisei_report_writer'
    AND reporter_user_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS reports_writer_insert ON reports;
CREATE POLICY reports_writer_insert ON reports FOR INSERT
  WITH CHECK (current_user = 'heisei_report_writer'
    AND reporter_user_id::text = current_setting('app.user_id', true));

DROP POLICY IF EXISTS report_idempotency_writer_select ON report_idempotency;
CREATE POLICY report_idempotency_writer_select ON report_idempotency FOR SELECT
  USING (current_user = 'heisei_report_writer'
    AND reporter_user_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS report_idempotency_writer_insert ON report_idempotency;
CREATE POLICY report_idempotency_writer_insert ON report_idempotency FOR INSERT
  WITH CHECK (current_user = 'heisei_report_writer'
    AND reporter_user_id::text = current_setting('app.user_id', true));

-- The writer may append only the report.create event for its verified actor.
-- Atomic report+audit execution remains the responsibility of the future
-- report repository transaction; G4-A tests the rollback boundary explicitly.
DROP POLICY IF EXISTS audit_logs_report_writer_insert ON audit_logs;
CREATE POLICY audit_logs_report_writer_insert ON audit_logs FOR INSERT
  WITH CHECK (current_user = 'heisei_report_writer'
    AND actor_user_id::text = current_setting('app.user_id', true)
    AND action = 'report.create'
    AND rule_version = '003i-g4a'
    AND target_user_id IS NOT NULL
    AND request_id IS NOT NULL
    AND length(request_id) BETWEEN 1 AND 128);

-- No UPDATE/DELETE policies are created for reports, report_idempotency, or
-- audit_logs. The writer cannot mutate existing data or bypass append-only audit.
