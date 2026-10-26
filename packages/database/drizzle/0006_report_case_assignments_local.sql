-- HEISEI local operations: case-level staff assignment boundary.
-- Assignment mutation is intentionally not exposed to the API.

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS report_id uuid REFERENCES reports(id);
CREATE INDEX IF NOT EXISTS audit_logs_report_id_idx ON audit_logs(report_id);

CREATE TABLE IF NOT EXISTS report_staff_assignments (
  report_id uuid NOT NULL REFERENCES reports(id),
  staff_user_id uuid NOT NULL REFERENCES profiles(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (report_id, staff_user_id),
  CONSTRAINT report_staff_assignment_dates_check CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);
CREATE INDEX IF NOT EXISTS report_staff_assignments_staff_active_idx
  ON report_staff_assignments (staff_user_id, report_id)
  WHERE revoked_at IS NULL;

ALTER TABLE report_staff_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_staff_assignments FORCE ROW LEVEL SECURITY;

REVOKE ALL ON report_staff_assignments FROM PUBLIC, heisei_app, heisei_staff,
  heisei_report_writer, heisei_report_reconciler, heisei_report_staff_reader;
REVOKE ALL ON profiles FROM heisei_report_staff_reader;
GRANT SELECT (id, auth_level, roles_json, account_status)
  ON profiles TO heisei_report_staff_reader;
DROP POLICY IF EXISTS profiles_report_staff_reader_select ON profiles;
CREATE POLICY profiles_report_staff_reader_select ON profiles FOR SELECT
  USING (current_user = 'heisei_report_staff_reader'
    AND id::text = current_setting('app.user_id', true));
GRANT SELECT (report_id, staff_user_id, assigned_at, revoked_at)
  ON report_staff_assignments TO heisei_report_staff_reader;
-- The reports staff policy references assignments even when the tx-writer
-- branch is planned. Apply this narrow grant after the table exists.
GRANT SELECT (report_id, staff_user_id, revoked_at)
  ON report_staff_assignments TO heisei_report_tx_writer;

DROP POLICY IF EXISTS report_staff_assignments_reader_select ON report_staff_assignments;
CREATE POLICY report_staff_assignments_reader_select ON report_staff_assignments FOR SELECT
  USING (current_user = 'heisei_report_staff_reader'
    AND staff_user_id::text = current_setting('app.user_id', true)
    AND revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM profiles AS staff
      WHERE staff.id = report_staff_assignments.staff_user_id
        AND staff.account_status = 'active'
        AND staff.auth_level >= 3
        AND staff.roles_json::jsonb ? 'admin'
    ));

DROP POLICY IF EXISTS reports_staff_reader_select ON reports;
CREATE POLICY reports_staff_reader_select ON reports FOR SELECT
  USING (current_user = 'heisei_report_staff_reader'
    AND status = 'pending'
    AND EXISTS (
      SELECT 1 FROM report_staff_assignments AS a
      WHERE a.report_id = reports.id
        AND a.staff_user_id::text = current_setting('app.user_id', true)
        AND a.revoked_at IS NULL
    ));

DROP POLICY IF EXISTS audit_logs_staff_reader_insert ON audit_logs;
CREATE POLICY audit_logs_staff_reader_insert ON audit_logs FOR INSERT
  WITH CHECK (current_user = 'heisei_report_staff_reader'
    AND report_id IS NOT NULL
    AND actor_user_id::text = current_setting('app.user_id', true)
    AND action = 'report.staff.view'
    AND reason = 'metadata-only'
    AND rule_version = '003i-ops-v1'
    AND request_id IS NOT NULL
    AND length(request_id) BETWEEN 1 AND 128
    AND EXISTS (
      SELECT 1 FROM report_staff_assignments AS a
      WHERE a.report_id = audit_logs.report_id
        AND a.staff_user_id::text = current_setting('app.user_id', true)
        AND a.revoked_at IS NULL
    )
    AND target_user_id = (SELECT target_user_id FROM reports WHERE id = audit_logs.report_id));
