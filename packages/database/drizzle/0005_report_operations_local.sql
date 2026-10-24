-- Local-only operations boundary. No decryption, status change, disposition,
-- disclosure, or assignment mutation is provided by this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_report_staff_reader') THEN
    CREATE ROLE heisei_report_staff_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE heisei_report_staff_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;

REVOKE ALL ON reports, report_idempotency, audit_logs FROM heisei_report_staff_reader;
GRANT SELECT (id, target_type, target_user_id, category, status, created_at, review_closed_at)
  ON reports TO heisei_report_staff_reader;
GRANT INSERT ON audit_logs TO heisei_report_staff_reader;

DROP POLICY IF EXISTS reports_staff_reader_select ON reports;
CREATE POLICY reports_staff_reader_select ON reports FOR SELECT
  USING (current_user = 'heisei_report_staff_reader'
    AND target_user_id::text = current_setting('app.staff_scope', true)
    AND status = 'pending');

DROP POLICY IF EXISTS audit_logs_staff_reader_insert ON audit_logs;
CREATE POLICY audit_logs_staff_reader_insert ON audit_logs FOR INSERT
  WITH CHECK (current_user = 'heisei_report_staff_reader'
    AND actor_user_id::text = current_setting('app.user_id', true)
    AND target_user_id::text = current_setting('app.staff_scope', true)
    AND action = 'report.staff.view'
    AND reason = 'metadata-only'
    AND rule_version = '003i-ops-v1'
    AND request_id IS NOT NULL
    AND length(request_id) BETWEEN 1 AND 128);
