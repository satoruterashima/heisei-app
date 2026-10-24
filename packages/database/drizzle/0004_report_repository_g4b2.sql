-- HEISEI-003I-A G4-B2 Phase 1 local-only repository boundary.
-- This migration is for disposable PostgreSQL integration tests only.

REVOKE ALL ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar) FROM heisei_report_writer;

REVOKE ALL ON reports, report_idempotency, audit_logs FROM heisei_report_tx_writer;
GRANT SELECT (id, auth_level, account_status, profile_visibility) ON profiles TO heisei_report_tx_writer;
GRANT SELECT ON blocks TO heisei_report_tx_writer;
GRANT SELECT ON reports, report_idempotency TO heisei_report_tx_writer;
GRANT INSERT ON reports, report_idempotency, audit_logs TO heisei_report_tx_writer;
GRANT EXECUTE ON FUNCTION report_idempotency_touch(uuid) TO heisei_report_tx_writer;

DROP POLICY IF EXISTS reports_report_tx_writer_insert ON reports;
CREATE POLICY reports_report_tx_writer_insert ON reports FOR INSERT
  WITH CHECK (
    current_user = 'heisei_report_tx_writer'
    AND reporter_user_id::text = current_setting('app.user_id', true)
    AND target_user_id::text = current_setting('app.visibility_target_id', true)
  );
DROP POLICY IF EXISTS reports_report_tx_writer_select ON reports;
CREATE POLICY reports_report_tx_writer_select ON reports FOR SELECT
  USING (
    current_user = 'heisei_report_tx_writer'
    AND reporter_user_id::text = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS report_idempotency_tx_writer_select ON report_idempotency;
CREATE POLICY report_idempotency_tx_writer_select ON report_idempotency FOR SELECT
  USING (
    current_user = 'heisei_report_tx_writer'
    AND reporter_user_id::text = current_setting('app.user_id', true)
  );
DROP POLICY IF EXISTS report_idempotency_tx_writer_insert ON report_idempotency;
CREATE POLICY report_idempotency_tx_writer_insert ON report_idempotency FOR INSERT
  WITH CHECK (
    current_user = 'heisei_report_tx_writer'
    AND reporter_user_id::text = current_setting('app.user_id', true)
  );

DROP POLICY IF EXISTS audit_logs_report_tx_writer_insert ON audit_logs;
CREATE POLICY audit_logs_report_tx_writer_insert ON audit_logs FOR INSERT
  WITH CHECK (
    current_user = 'heisei_report_tx_writer'
    AND actor_user_id::text = current_setting('app.user_id', true)
    AND target_user_id::text = current_setting('app.visibility_target_id', true)
    AND action = 'report.create'
    AND rule_version = '003i-g4b2'
    AND request_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION report_create_atomic_v2(
  p_target_user_id uuid,
  p_category varchar,
  p_category_version varchar,
  p_request_id varchar,
  p_report_id uuid,
  p_fingerprint_candidates jsonb,
  p_ciphertext_hex text,
  p_nonce_hex text,
  p_algorithm_version text,
  p_encryption_key_version text,
  p_aad_version text,
  p_fingerprint_algorithm_version text
)
RETURNS TABLE (result varchar, report_id uuid)
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
  v_candidate record;
  v_existing record;
  v_pending uuid;
  v_first_candidate record;
  v_lock_hex text;
BEGIN
  IF p_target_user_id IS NULL OR p_report_id IS NULL
     OR p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 1 AND 128
     OR p_fingerprint_candidates IS NULL
     OR jsonb_typeof(p_fingerprint_candidates) <> 'array'
     OR jsonb_array_length(p_fingerprint_candidates) = 0
  THEN
    RETURN QUERY SELECT 'unavailable'::varchar, NULL::uuid;
    RETURN;
  END IF;

  v_actor_user_id := current_setting('app.user_id', true)::uuid;
  PERFORM set_config('app.visibility_target_id', p_target_user_id::text, true);

  -- All report/block paths use this canonical pair order.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    LEAST(v_actor_user_id::text, p_target_user_id::text), 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    GREATEST(v_actor_user_id::text, p_target_user_id::text), 0));

  -- The pair lock does not protect the same actor using one key for another
  -- target. Lock every retained HMAC scope candidate in deterministic order.
  FOR v_lock_hex IN
    SELECT value->>'scope_hex'
      FROM jsonb_array_elements(p_fingerprint_candidates) AS candidates(value)
     ORDER BY value->>'scope_hex'
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'report-idempotency:' || v_actor_user_id::text || ':' || v_lock_hex, 0));
  END LOOP;

  -- Reconcile an existing key before evaluating current visibility. This
  -- makes replay independent of later visibility changes without creating an
  -- existence oracle for unknown targets, which never receive a record.
  FOR v_existing IN
    SELECT ri.id, ri.report_id, ri.payload_fingerprint, ri.fingerprint_key_version
      FROM report_idempotency AS ri
     WHERE ri.reporter_user_id = v_actor_user_id
       AND ri.reporter_scope_digest IN (
         SELECT decode(value->>'scope_hex', 'hex')
           FROM jsonb_array_elements(p_fingerprint_candidates) AS candidates(value)
       )
  LOOP
    FOR v_candidate IN
      SELECT * FROM jsonb_to_recordset(p_fingerprint_candidates)
        AS candidate(scope_hex text, payload_hex text, key_version text, algorithm_version text)
    LOOP
      IF v_existing.fingerprint_key_version = v_candidate.key_version
         AND v_existing.payload_fingerprint = decode(v_candidate.payload_hex, 'hex')
      THEN
        PERFORM report_idempotency_touch(v_existing.id);
        RETURN QUERY SELECT 'replayed'::varchar, v_existing.report_id;
        RETURN;
      END IF;
    END LOOP;
    RETURN QUERY SELECT 'idempotency_conflict'::varchar, NULL::uuid;
    RETURN;
  END LOOP;

  SELECT auth_level, account_status
    INTO v_actor_level, v_actor_status
    FROM profiles
   WHERE id = v_actor_user_id;
  SELECT account_status, profile_visibility
    INTO v_target_status, v_target_visibility
    FROM profiles
   WHERE id = p_target_user_id;

  IF NOT FOUND OR v_actor_level < 2 OR v_actor_status <> 'active'
     OR v_target_status <> 'active' OR v_target_visibility <> 'public'
     OR v_actor_user_id = p_target_user_id
  THEN
    RETURN QUERY SELECT 'denied'::varchar, NULL::uuid;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM blocks
     WHERE (blocker_id = v_actor_user_id AND blocked_id = p_target_user_id)
        OR (blocker_id = p_target_user_id AND blocked_id = v_actor_user_id)
  ) THEN
    RETURN QUERY SELECT 'denied'::varchar, NULL::uuid;
    RETURN;
  END IF;

  SELECT id INTO v_pending
    FROM reports
   WHERE reporter_user_id = v_actor_user_id
     AND target_type = 'user'
     AND target_user_id = p_target_user_id
     AND status = 'pending'
   LIMIT 1;

  SELECT * INTO v_first_candidate
    FROM jsonb_to_record(p_fingerprint_candidates->0)
      AS candidate(scope_hex text, payload_hex text, key_version text, algorithm_version text);

  IF v_pending IS NOT NULL THEN
    INSERT INTO report_idempotency (
      reporter_user_id, reporter_scope_digest, payload_fingerprint,
      fingerprint_algorithm_version, fingerprint_key_version,
      report_id, expires_at
    ) VALUES (
      v_actor_user_id, decode(v_first_candidate.scope_hex, 'hex'),
      decode(v_first_candidate.payload_hex, 'hex'),
      p_fingerprint_algorithm_version, v_first_candidate.key_version,
      v_pending, now() + interval '30 days'
    );
    RETURN QUERY SELECT 'duplicate'::varchar, v_pending;
    RETURN;
  END IF;

  INSERT INTO reports (
    id, reporter_user_id, target_type, target_user_id,
    category, category_version,
    description_ciphertext, description_nonce,
    encryption_algorithm_version, encryption_key_version, aad_version
  ) VALUES (
    p_report_id, v_actor_user_id, 'user', p_target_user_id,
    p_category, p_category_version,
    CASE WHEN p_ciphertext_hex IS NULL THEN NULL ELSE decode(p_ciphertext_hex, 'hex') END,
    CASE WHEN p_nonce_hex IS NULL THEN NULL ELSE decode(p_nonce_hex, 'hex') END,
    p_algorithm_version, p_encryption_key_version, p_aad_version
  );

  INSERT INTO report_idempotency (
    reporter_user_id, reporter_scope_digest, payload_fingerprint,
    fingerprint_algorithm_version, fingerprint_key_version,
    report_id, expires_at
  ) VALUES (
    v_actor_user_id, decode(v_first_candidate.scope_hex, 'hex'),
    decode(v_first_candidate.payload_hex, 'hex'),
    p_fingerprint_algorithm_version, v_first_candidate.key_version,
    p_report_id, now() + interval '30 days'
  );

  INSERT INTO audit_logs (actor_user_id, target_user_id, action, rule_version, request_id)
  VALUES (v_actor_user_id, p_target_user_id, 'report.create', '003i-g4b2', p_request_id);

  RETURN QUERY SELECT 'accepted'::varchar, p_report_id;
END;
$$;

ALTER FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text)
  OWNER TO heisei_report_tx_writer;
REVOKE ALL ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text)
  TO heisei_report_writer;

COMMENT ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text) IS
  'G4-B2 local-only report, idempotency, visibility and audit atomic boundary; not a public API';
