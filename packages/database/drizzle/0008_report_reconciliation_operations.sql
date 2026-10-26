-- OPS-RECONCILE-06: durable operator intent/completion record.
CREATE TABLE IF NOT EXISTS report_reconciliation_operations (
  operation_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES profiles(id),
  reservation_id uuid NOT NULL,
  request_id varchar(128) NOT NULL,
  status varchar(24) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_reconciliation_operations_status_check CHECK (status IN ('prepared', 'applied', 'held')),
  CONSTRAINT report_reconciliation_operations_unique_target UNIQUE (actor_user_id, reservation_id)
);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS report_id uuid REFERENCES reports(id);
ALTER TABLE report_reconciliation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_reconciliation_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON report_reconciliation_operations FROM PUBLIC, heisei_app, heisei_staff, heisei_report_reconciler;
GRANT SELECT, INSERT, UPDATE ON report_reconciliation_operations TO heisei_report_operator;
DROP POLICY IF EXISTS report_reconciliation_operations_operator_all ON report_reconciliation_operations;
CREATE POLICY report_reconciliation_operations_operator_all ON report_reconciliation_operations FOR ALL
  USING (current_user = 'heisei_report_operator' AND actor_user_id::text = current_setting('app.user_id', true))
  WITH CHECK (current_user = 'heisei_report_operator' AND actor_user_id::text = current_setting('app.user_id', true));

GRANT SELECT (actor_user_id, action, request_id, rule_version, report_id) ON audit_logs TO heisei_report_reconciler;
GRANT INSERT ON audit_logs TO heisei_report_operator;
DROP POLICY IF EXISTS audit_logs_report_operator_insert ON audit_logs;
CREATE POLICY audit_logs_report_operator_insert ON audit_logs FOR INSERT
  WITH CHECK (current_user = 'heisei_report_operator'
    AND actor_user_id::text = current_setting('app.user_id', true)
    AND action = 'report.reconcile'
    AND rule_version = '003i-ops-reconcile-v1'
    AND request_id IS NOT NULL
    AND length(request_id) BETWEEN 1 AND 128);
DROP POLICY IF EXISTS audit_logs_report_reconciler_select ON audit_logs;
CREATE POLICY audit_logs_report_reconciler_select ON audit_logs FOR SELECT
  USING (current_user = 'heisei_report_reconciler'
    AND actor_user_id::text = current_setting('app.user_id', true)
    AND action = 'report.create'
    AND rule_version = '003i-g4b2');
