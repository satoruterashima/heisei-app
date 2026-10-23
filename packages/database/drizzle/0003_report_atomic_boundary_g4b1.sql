-- HEISEI-003I-A G4-B1 local-only atomic report boundary.
-- This is an isolated proof boundary. It is not a public API or production
-- report repository and must not be applied to shared or production databases.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heisei_report_tx_writer') THEN
    CREATE ROLE heisei_report_tx_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

ALTER ROLE heisei_report_tx_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;

REVOKE ALL ON profiles, blocks, reports, audit_logs FROM heisei_report_tx_writer;
GRANT SELECT (id, auth_level, account_status, profile_visibility) ON profiles TO heisei_report_tx_writer;
GRANT SELECT ON blocks TO heisei_report_tx_writer;
GRANT SELECT (id) ON reports TO heisei_report_tx_writer;
GRANT INSERT ON reports, audit_logs TO heisei_report_tx_writer;

DROP POLICY IF EXISTS profiles_report_tx_writer_select ON profiles;
CREATE POLICY profiles_report_tx_writer_select ON profiles FOR SELECT
  USING (
    current_user = 'heisei_report_tx_writer'
    AND (
      id::text = current_setting('app.user_id', true)
      OR (
        id::text = current_setting('app.visibility_target_id', true)
        AND profile_visibility = 'public'
      )
    )
  );

DROP POLICY IF EXISTS blocks_report_tx_writer_select ON blocks;
CREATE POLICY blocks_report_tx_writer_select ON blocks FOR SELECT
  USING (
    current_user = 'heisei_report_tx_writer'
    AND (
      (blocker_id::text = current_setting('app.user_id', true)
       AND blocked_id::text = current_setting('app.visibility_target_id', true))
      OR
      (blocker_id::text = current_setting('app.visibility_target_id', true)
       AND blocked_id::text = current_setting('app.user_id', true))
    )
  );

DROP POLICY IF EXISTS reports_report_tx_writer_insert ON reports;
CREATE POLICY reports_report_tx_writer_insert ON reports FOR INSERT
  WITH CHECK (current_user = 'heisei_report_tx_writer');

DROP POLICY IF EXISTS reports_report_tx_writer_select ON reports;
CREATE POLICY reports_report_tx_writer_select ON reports FOR SELECT
  USING (current_user = 'heisei_report_tx_writer');

DROP POLICY IF EXISTS audit_logs_report_tx_writer_insert ON audit_logs;
CREATE POLICY audit_logs_report_tx_writer_insert ON audit_logs FOR INSERT
  WITH CHECK (current_user = 'heisei_report_tx_writer');

CREATE OR REPLACE FUNCTION report_create_atomic(
  p_target_user_id uuid,
  p_category varchar,
  p_category_version varchar,
  p_request_id varchar
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_user_id uuid;
  v_actor_level integer;
  v_actor_status text;
  v_target_status text;
  v_target_visibility text;
  v_report_id uuid;
BEGIN
  v_actor_user_id := current_setting('app.user_id', true)::uuid;
  PERFORM set_config('app.visibility_target_id', p_target_user_id::text, true);
  -- Serialize report admission for one target. Existing profile/block writers
  -- do not yet take this lock, so this does not by itself close their TOCTOU.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_target_user_id::text, 0));

  SELECT auth_level, account_status
    INTO v_actor_level, v_actor_status
    FROM profiles
   WHERE id = v_actor_user_id;
  SELECT account_status, profile_visibility
    INTO v_target_status, v_target_visibility
    FROM profiles
   WHERE id = p_target_user_id;

  IF NOT FOUND
     OR v_actor_level < 2
     OR v_actor_status <> 'active'
     OR v_target_status <> 'active'
     OR v_target_visibility <> 'public'
     OR v_actor_user_id = p_target_user_id
  THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM blocks
     WHERE (blocker_id = v_actor_user_id AND blocked_id = p_target_user_id)
        OR (blocker_id = p_target_user_id AND blocked_id = v_actor_user_id)
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
  VALUES (v_actor_user_id, 'user', p_target_user_id, p_category, p_category_version)
  RETURNING id INTO v_report_id;

  INSERT INTO audit_logs (actor_user_id, target_user_id, action, rule_version, request_id)
  VALUES (v_actor_user_id, p_target_user_id, 'report.create', '003i-g4b1', p_request_id);

  RETURN v_report_id;
END;
$$;

ALTER FUNCTION report_create_atomic(uuid, varchar, varchar, varchar)
  OWNER TO heisei_report_tx_writer;
REVOKE ALL ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar)
  TO heisei_report_writer;

COMMENT ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar) IS
  'G4-B1 isolated atomic visibility, report, and audit boundary; not a public API';
