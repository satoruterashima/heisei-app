-- HEISEI-003I-A G4-B2 Phase 1 local-only repository boundary.
-- This migration is for disposable PostgreSQL integration tests only.

REVOKE ALL ON FUNCTION report_create_atomic(uuid, varchar, varchar, varchar) FROM heisei_report_writer;

REVOKE ALL ON reports, report_idempotency, audit_logs FROM heisei_report_tx_writer;
REVOKE ALL ON reports, report_idempotency, audit_logs FROM heisei_report_reconciler;
GRANT SELECT (id, auth_subject, auth_level, account_status, profile_visibility) ON profiles TO heisei_report_tx_writer;
GRANT SELECT ON blocks TO heisei_report_tx_writer;
GRANT SELECT ON reports, report_idempotency TO heisei_report_tx_writer;
GRANT INSERT ON reports, report_idempotency, audit_logs TO heisei_report_tx_writer;
GRANT EXECUTE ON FUNCTION report_idempotency_touch(uuid) TO heisei_report_tx_writer;

GRANT SELECT ON report_idempotency TO heisei_report_reconciler;

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

DROP POLICY IF EXISTS report_idempotency_reconciler_select ON report_idempotency;
CREATE POLICY report_idempotency_reconciler_select ON report_idempotency FOR SELECT
  USING (
    current_user = 'heisei_report_reconciler'
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

DROP FUNCTION IF EXISTS report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text);

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
  p_active_fingerprint_key_version text,
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
     OR p_category IS NULL OR p_category NOT IN ('harassment', 'spam', 'impersonation', 'inappropriate_content', 'fraud', 'other')
     OR p_category_version IS DISTINCT FROM 'category-v1'
     OR p_active_fingerprint_key_version IS NULL OR length(p_active_fingerprint_key_version) NOT BETWEEN 1 AND 80
     OR p_fingerprint_candidates IS NULL
     OR jsonb_typeof(p_fingerprint_candidates) <> 'array'
     OR jsonb_array_length(p_fingerprint_candidates) = 0
  THEN
    RETURN QUERY SELECT 'unavailable'::varchar, NULL::uuid;
    RETURN;
  END IF;

  -- Reject malformed candidates and extra/missing JSON fields before any
  -- lock or write. Digests are fixed-size HMAC-SHA-256 values.
  IF p_fingerprint_algorithm_version <> 'hmac-sha256-v1'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_fingerprint_candidates) AS c(value)
       WHERE jsonb_typeof(value) <> 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(value) AS k(key)
              WHERE key NOT IN ('scope_hex', 'payload_hex', 'key_version', 'algorithm_version')) <> 0
          OR (SELECT count(*) FROM (VALUES ('scope_hex'), ('payload_hex'), ('key_version'), ('algorithm_version')) AS required(key)
              WHERE NOT (value ? required.key)) <> 0
          OR jsonb_typeof(value->'scope_hex') <> 'string'
          OR jsonb_typeof(value->'payload_hex') <> 'string'
          OR jsonb_typeof(value->'key_version') <> 'string'
          OR jsonb_typeof(value->'algorithm_version') <> 'string'
          OR value->>'algorithm_version' <> 'hmac-sha256-v1'
          OR value->>'scope_hex' !~ '^[0-9a-f]{64}$'
          OR value->>'payload_hex' !~ '^[0-9a-f]{64}$'
          OR length(value->>'key_version') NOT BETWEEN 1 AND 80
     )
     OR EXISTS (
     SELECT 1
       FROM jsonb_array_elements(p_fingerprint_candidates) WITH ORDINALITY AS a(value, ordinal)
       JOIN jsonb_array_elements(p_fingerprint_candidates) WITH ORDINALITY AS b(value, ordinal)
         ON a.ordinal < b.ordinal
        AND a.value->>'key_version' = b.value->>'key_version'
     )
  THEN
    RETURN QUERY SELECT 'unavailable'::varchar, NULL::uuid;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_fingerprint_candidates) AS c(value)
    WHERE value->>'key_version' = p_active_fingerprint_key_version
  ) THEN
    RETURN QUERY SELECT 'unavailable'::varchar, NULL::uuid;
    RETURN;
  END IF;

  IF (p_ciphertext_hex IS NULL OR p_nonce_hex IS NULL OR p_algorithm_version IS NULL OR p_encryption_key_version IS NULL OR p_aad_version IS NULL)
       AND NOT (p_ciphertext_hex IS NULL AND p_nonce_hex IS NULL AND p_algorithm_version IS NULL AND p_encryption_key_version IS NULL AND p_aad_version IS NULL)
  THEN
    RETURN QUERY SELECT 'unavailable'::varchar, NULL::uuid;
    RETURN;
  END IF;
  IF p_ciphertext_hex IS NOT NULL AND (
       p_algorithm_version <> 'aes-256-gcm-v1'
       OR p_aad_version <> 'aad-v1'
       OR length(btrim(p_encryption_key_version)) = 0 OR length(p_encryption_key_version) > 80
       OR p_nonce_hex !~ '^[0-9a-f]{24}$'
       OR p_ciphertext_hex !~ '^[0-9a-f]+$' OR length(p_ciphertext_hex) < 32 OR mod(length(p_ciphertext_hex), 2) <> 0
  ) THEN
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
    SELECT ri.id, ri.report_id, ri.reporter_scope_digest, ri.payload_fingerprint, ri.fingerprint_key_version
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
         AND v_existing.reporter_scope_digest = decode(v_candidate.scope_hex, 'hex')
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
   WHERE id = v_actor_user_id
     AND auth_subject = current_setting('app.auth_subject', true);
  SELECT account_status, profile_visibility
    INTO v_target_status, v_target_visibility
    FROM profiles
   WHERE id = p_target_user_id;

  IF NOT FOUND OR COALESCE(v_actor_level, 0) < 2 OR COALESCE(v_actor_status, '') <> 'active'
     OR COALESCE(v_target_status, '') <> 'active' OR COALESCE(v_target_visibility, '') <> 'public'
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
    FROM jsonb_to_record((
      SELECT value FROM jsonb_array_elements(p_fingerprint_candidates) AS c(value)
       WHERE value->>'key_version' = p_active_fingerprint_key_version
       LIMIT 1
    ))
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

ALTER FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text, text)
  OWNER TO heisei_report_tx_writer;
REVOKE ALL ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text, text)
  TO heisei_report_writer;

COMMENT ON FUNCTION report_create_atomic_v2(uuid, varchar, varchar, varchar, uuid, jsonb, text, text, text, text, text, text, text) IS
  'G4-B2 local-only report, idempotency, visibility and audit atomic boundary; not a public API';
