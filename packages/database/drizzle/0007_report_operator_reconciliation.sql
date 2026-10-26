-- OPS-RECONCILE-05: least-privilege, append-only operator audit boundary.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_report_operator') THEN
    CREATE ROLE heisei_report_operator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

REVOKE ALL ON audit_logs FROM heisei_report_operator;
GRANT INSERT ON audit_logs TO heisei_report_operator;
DROP POLICY IF EXISTS audit_logs_report_operator_insert ON audit_logs;
CREATE POLICY audit_logs_report_operator_insert ON audit_logs FOR INSERT
  WITH CHECK (
    current_user = 'heisei_report_operator'
    AND action = 'report.reconcile'
    AND rule_version = '003i-ops-reconcile-v1'
    AND actor_user_id::text = current_setting('app.user_id', true)
    AND request_id IS NOT NULL
    AND length(request_id) BETWEEN 1 AND 128
    AND reason IS NOT NULL
    AND reason LIKE 'operator:%'
  );
