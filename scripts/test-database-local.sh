#!/usr/bin/env bash
set -euo pipefail

# Disposable PostgreSQL RLS integration test for HEISEI-003B-R2.
# This script never uses an externally configured database URL.

if ! command -v docker >/dev/null 2>&1; then
  echo "BLOCKED: docker is required for the local PostgreSQL test" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container="heisei-db-r2-${PPID}-${RANDOM}"
db_password="heisei_local_only_password"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT

# Startup can fail transiently on freshly provisioned GitHub runners while the
# daemon is pulling the image. Preserve diagnostics and retry only container
# creation; failures in schema/RLS assertions must never be retried or hidden.
started=0
for attempt in 1 2 3; do
  echo "INFO: PostgreSQL container startup attempt $attempt"
  if docker run --name "$container" -e POSTGRES_PASSWORD="$db_password" -e POSTGRES_DB=heisei_local -d postgres:16-alpine; then
    started=1
    break
  fi
  echo "WARN: Docker startup failed (attempt $attempt)" >&2
  docker rm -f "$container" >/dev/null 2>&1 || true
  sleep 2
done
if [[ "$started" != "1" ]]; then
  echo "FAIL: unable to start isolated PostgreSQL container" >&2
  docker info --format 'Docker Engine: {{.ServerVersion}}' >&2 || true
  exit 1
fi
echo "INFO: waiting for isolated PostgreSQL readiness"

# The official Postgres image brings up a temporary Unix-socket-only server
# during initdb, shuts it down, then starts the final TCP-listening server.
# An unqualified pg_isready can report the transient server as healthy.
ready=0
for _ in $(seq 1 45); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d heisei_local >/dev/null 2>&1 &&
     docker exec "$container" psql -h 127.0.0.1 -U postgres -d heisei_local -Atqc 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "FAIL: PostgreSQL did not become ready on TCP" >&2
  docker logs --tail 60 "$container" >&2 || true
  exit 1
fi
echo "INFO: PostgreSQL final TCP server is ready"

psql_file() {
  docker exec -i "$container" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U postgres -d heisei_local "$@"
}

psql_file < "$repo_root/packages/database/drizzle/0000_baseline_profiles.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0000_auth_foundation.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/roles.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0001_profile_visibility.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0002_report_foundation_g4a.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0003_report_atomic_boundary_g4b1.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/roles.sql" >/dev/null
echo "PASS: initial migration and role grants applied"

psql_file <<'SQL' >/dev/null
CREATE ROLE heisei_app_login LOGIN PASSWORD 'local-only-app' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_staff_login LOGIN PASSWORD 'local-only-staff' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_identity_login LOGIN PASSWORD 'local-only-identity' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_audit_login LOGIN PASSWORD 'local-only-audit' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_report_login LOGIN PASSWORD 'local-only-report' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_visibility_login LOGIN PASSWORD 'local-only-visibility' NOSUPERUSER NOBYPASSRLS;
GRANT heisei_app TO heisei_app_login;
GRANT heisei_staff TO heisei_staff_login;
GRANT heisei_identity_writer TO heisei_identity_login;
GRANT heisei_audit_writer TO heisei_audit_login;
GRANT heisei_report_writer TO heisei_report_login;
GRANT heisei_visibility_reader TO heisei_visibility_login;
GRANT USAGE ON SCHEMA public TO heisei_app_login, heisei_staff_login,
  heisei_identity_login, heisei_audit_login, heisei_report_login, heisei_visibility_login;
INSERT INTO profiles (id, username, display_name, auth_subject, auth_level)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'r2-user-1', 'R2 User 1', 'r2-subject-1', 1),
  ('00000000-0000-4000-8000-000000000002', 'r2-user-2', 'R2 User 2', 'r2-subject-2', 1),
  ('00000000-0000-4000-8000-000000000003', 'r2-user-3', 'R2 User 3', 'r2-subject-3', 1);
INSERT INTO user_verifications (user_id, kind, status, verification_version)
VALUES ('00000000-0000-4000-8000-000000000001', 'email_verified', 'verified', 'r2-test');
SQL

echo "PASS: test users and non-privileged login roles created"

roles_ok="$(psql_file -At <<'SQL'
SELECT count(*) FROM pg_roles
WHERE rolname IN ('heisei_app', 'heisei_staff', 'heisei_identity_writer', 'heisei_audit_writer')
  AND rolsuper = false AND rolbypassrls = false;
SQL
)"
if [[ "$roles_ok" != "4" ]]; then
  printf 'FAIL: expected 4 least-privileged roles; query result was [%s]\\n' "$roles_ok" >&2
  exit 1
fi
echo "PASS: least-privileged roles present"

expect_failure() {
  local label="$1"
  shift
  local output
  output="$(mktemp)"
  if "$@" >"$output" 2>&1; then
    rm -f "$output"
    echo "FAIL: $label unexpectedly succeeded" >&2
    exit 1
  fi
  rm -f "$output"
  echo "PASS: $label"
}

run_as() {
  local role="$1"
  shift
  psql_file -v role_name="$role" "$@"
}

psql_file <<'SQL' >/dev/null
UPDATE profiles
SET auth_level = 2, profile_visibility = CASE
  WHEN id IN ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002') THEN 'public'
  ELSE 'private'
END;
UPDATE profiles SET auth_level = 2 WHERE id = '00000000-0000-4000-8000-000000000003';
SQL
atomic_report_id="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
SELECT report_create_atomic('00000000-0000-4000-8000-000000000001', 'other', 'category-v1', 'g4b1-success');
SQL
)"
test -n "$atomic_report_id"
atomic_audit_count="$(psql_file -Atqc "SELECT count(*) FROM audit_logs WHERE action = 'report.create' AND rule_version = '003i-g4b1' AND request_id = 'g4b1-success'")"
test "$atomic_audit_count" = 1
echo "PASS: atomic visibility/report/audit function commits together"

deny_report_id="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
SELECT report_create_atomic('00000000-0000-4000-8000-000000000003', 'other', 'category-v1', 'g4b1-deny');
SQL
)"
test -z "$deny_report_id"
echo "PASS: atomic function denies private target without saving"

psql_file <<'SQL' >/dev/null
UPDATE profiles SET account_status = 'suspended'
WHERE id = '00000000-0000-4000-8000-000000000002';
SQL
suspended_target_report_id="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
SELECT report_create_atomic('00000000-0000-4000-8000-000000000002', 'other', 'category-v1', 'g4b1-suspended-target');
SQL
)"
test -z "$suspended_target_report_id"
psql_file <<'SQL' >/dev/null
UPDATE profiles SET account_status = 'active'
WHERE id = '00000000-0000-4000-8000-000000000002';
UPDATE profiles SET account_status = 'suspended'
WHERE id = '00000000-0000-4000-8000-000000000003';
SQL
suspended_actor_report_id="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
SELECT report_create_atomic('00000000-0000-4000-8000-000000000001', 'other', 'category-v1', 'g4b1-suspended-actor');
SQL
)"
test -z "$suspended_actor_report_id"
psql_file <<'SQL' >/dev/null
UPDATE profiles SET account_status = 'active'
WHERE id = '00000000-0000-4000-8000-000000000003';
SQL
echo "PASS: atomic function denies suspended target and actor"

psql_file <<'SQL' >/dev/null
INSERT INTO blocks (blocker_id, blocked_id)
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');
SQL
blocked_actor_report_id="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
SELECT report_create_atomic('00000000-0000-4000-8000-000000000001', 'other', 'category-v1', 'g4b1-blocked-actor');
SQL
)"
test -z "$blocked_actor_report_id"
psql_file <<'SQL' >/dev/null
DELETE FROM blocks
WHERE blocker_id = '00000000-0000-4000-8000-000000000002'
  AND blocked_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO blocks (blocker_id, blocked_id)
VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
SQL
blocked_target_report_id="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
SELECT report_create_atomic('00000000-0000-4000-8000-000000000001', 'other', 'category-v1', 'g4b1-blocked-target');
SQL
)"
test -z "$blocked_target_report_id"
psql_file <<'SQL' >/dev/null
DELETE FROM blocks
WHERE blocker_id = '00000000-0000-4000-8000-000000000001'
  AND blocked_id = '00000000-0000-4000-8000-000000000002';
SQL
echo "PASS: atomic function denies actor->target and target->actor blocks"

# Deterministic advisory-lock barrier: session A holds the target lock before
# admission, while session B must wait and then complete after A commits.
psql_file <<'SQL' >/dev/null
UPDATE profiles SET profile_visibility = 'public'
WHERE id = '00000000-0000-4000-8000-000000000003';
DELETE FROM reports
WHERE target_user_id = '00000000-0000-4000-8000-000000000003'
  AND reporter_user_id IN ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
SQL
lock_a="$(mktemp)"
lock_b="$(mktemp)"
set +e
run_as heisei_report_login >"$lock_a" 2>&1 <<'SQL' &
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('00000000-0000-4000-8000-000000000003', 0));
SELECT pg_sleep(1);
SELECT report_create_atomic('00000000-0000-4000-8000-000000000003', 'other', 'category-v1', 'g4b1-lock-a');
COMMIT;
SQL
lock_pid_a=$!
sleep 0.2
run_as heisei_report_login >"$lock_b" 2>&1 <<'SQL' &
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
SELECT report_create_atomic('00000000-0000-4000-8000-000000000003', 'other', 'category-v1', 'g4b1-lock-b');
SQL
lock_pid_b=$!
wait "$lock_pid_a"
lock_status_a=$?
wait "$lock_pid_b"
lock_status_b=$?
set -e
lock_audit_count="$(psql_file -Atqc "SELECT count(*) FROM audit_logs WHERE request_id IN ('g4b1-lock-a', 'g4b1-lock-b')")"
rm -f "$lock_a" "$lock_b"
if [[ "$lock_status_a" != 0 ]] || [[ "$lock_status_b" != 0 ]] || [[ "$lock_audit_count" != 2 ]]; then
  echo "FAIL: advisory-lock barrier did not serialize two atomic admissions" >&2
  exit 1
fi
psql_file <<'SQL' >/dev/null
DELETE FROM reports
WHERE target_user_id = '00000000-0000-4000-8000-000000000003'
  AND reporter_user_id IN ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
UPDATE profiles SET profile_visibility = 'private'
WHERE id = '00000000-0000-4000-8000-000000000003';
SQL
echo "PASS: barriered concurrent atomic admissions serialize by target lock"

expect_failure "atomic audit failure rollback" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
SELECT report_create_atomic('00000000-0000-4000-8000-000000000001', 'other', 'category-v1', repeat('x', 129));
SQL
atomic_rollback_count="$(psql_file -Atqc "SELECT count(*) FROM reports WHERE reporter_user_id = '00000000-0000-4000-8000-000000000003' AND target_user_id = '00000000-0000-4000-8000-000000000001' AND category = 'other'")"
test "$atomic_rollback_count" = 1
echo "PASS: atomic audit failure rolls back report insert"

# Owner: safe profile columns are writable, but privileged columns are not.
run_as heisei_app_login <<'SQL' >/dev/null
SET ROLE heisei_app;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
UPDATE profiles SET display_name = 'R2 Updated' WHERE id = current_setting('app.user_id')::uuid;
SQL
echo "PASS: general user safe profile update"

expect_failure "general user privileged profile update" run_as heisei_app_login <<'SQL'
SET ROLE heisei_app;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
UPDATE profiles SET auth_level = 4 WHERE id = current_setting('app.user_id')::uuid;
SQL

# Staff scope is role-bound; app.user_id cannot broaden the staff result.
staff_in_scope="$(run_as heisei_staff_login -At <<'SQL'
SET ROLE heisei_staff;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
SET app.staff_scope = '00000000-0000-4000-8000-000000000002';
SELECT count(*) FROM profiles WHERE id = '00000000-0000-4000-8000-000000000002';
SQL
)"
test "$staff_in_scope" = 1
echo "PASS: staff in-scope profile read"

staff_verification_in_scope="$(run_as heisei_staff_login -At <<'SQL'
SET ROLE heisei_staff;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SET app.staff_scope = '00000000-0000-4000-8000-000000000001';
SELECT count(*) FROM user_verifications WHERE user_id = '00000000-0000-4000-8000-000000000001';
SQL
)"
test "$staff_verification_in_scope" = 1
echo "PASS: staff in-scope verification read"

staff_out_scope="$(run_as heisei_staff_login -At <<'SQL'
SET ROLE heisei_staff;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
SET app.staff_scope = '00000000-0000-4000-8000-000000000001';
SELECT count(*) FROM profiles WHERE id = '00000000-0000-4000-8000-000000000002';
SQL
)"
test "$staff_out_scope" = 0
echo "PASS: staff out-of-scope profile denied"

staff_verification_out_scope="$(run_as heisei_staff_login -At <<'SQL'
SET ROLE heisei_staff;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
SET app.staff_scope = '00000000-0000-4000-8000-000000000002';
SELECT count(*) FROM user_verifications WHERE user_id = '00000000-0000-4000-8000-000000000001';
SQL
)"
test "$staff_verification_out_scope" = 0
echo "PASS: staff out-of-scope verification denied"

# Identity writer is the only non-owner path that can create/update evidence.
identity_subject_count="$(run_as heisei_identity_login -At <<'SQL'
SET ROLE heisei_identity_writer;
SET app.auth_subject = 'r2-subject-1';
SELECT count(*) FROM profiles WHERE auth_subject = current_setting('app.auth_subject');
SQL
)"
test "$identity_subject_count" = 1
echo "PASS: identity writer subject lookup is role-scoped"

identity_evidence_count="$(run_as heisei_identity_login -At <<'SQL'
SET ROLE heisei_identity_writer;
SET app.auth_subject = 'r2-subject-1';
SELECT count(*) FROM user_verifications WHERE user_id IN (
  SELECT id FROM profiles WHERE auth_subject = current_setting('app.auth_subject')
);
SQL
)"
test "$identity_evidence_count" = 1
echo "PASS: subject-scoped verification evidence is visible to identity writer"

identity_other_subject="$(run_as heisei_identity_login -At <<'SQL'
SET ROLE heisei_identity_writer;
SET app.auth_subject = 'missing-subject';
SELECT count(*) FROM user_verifications WHERE user_id = '00000000-0000-4000-8000-000000000001';
SQL
)"
test "$identity_other_subject" = 0
echo "PASS: missing subject cannot read another user's verification evidence"

app_subject_only="$(run_as heisei_app_login -At <<'SQL'
SET ROLE heisei_app;
SET app.auth_subject = 'r2-subject-1';
SELECT count(*) FROM profiles WHERE auth_subject = current_setting('app.auth_subject');
SQL
)"
test "$app_subject_only" = 0
echo "PASS: normal app role cannot claim identity writer's subject lookup"

run_as heisei_identity_login <<'SQL' >/dev/null
SET ROLE heisei_identity_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO user_verifications (user_id, kind, status, verification_version)
VALUES (current_setting('app.user_id')::uuid, 'phone_verified', 'pending', 'r2-test');
UPDATE user_verifications SET status = 'verified', verified_at = now()
WHERE user_id = current_setting('app.user_id')::uuid AND kind = 'phone_verified';
SQL
echo "PASS: identity writer verification INSERT/UPDATE"

expect_failure "general user verification forgery" run_as heisei_app_login <<'SQL'
SET ROLE heisei_app;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO user_verifications (user_id, kind, status, verification_version)
VALUES (current_setting('app.user_id')::uuid, 'identity_verified', 'verified', 'forged');
SQL

run_as heisei_audit_login <<'SQL' >/dev/null
SET ROLE heisei_audit_writer;
SET app.audit_actor_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO audit_logs (actor_user_id, action, reason, rule_version)
VALUES (current_setting('app.audit_actor_id')::uuid, 'r2_test', 'local test', 'r2-test');
SQL
echo "PASS: audit writer INSERT"

expect_failure "general user audit forgery" run_as heisei_app_login <<'SQL'
SET ROLE heisei_app;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO audit_logs (actor_user_id, action, rule_version)
VALUES (current_setting('app.user_id')::uuid, 'forged', 'r2-test');
SQL

expect_failure "general user report INSERT" run_as heisei_app_login <<'SQL'
SET ROLE heisei_app;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000002', 'spam', 'category-v1');
SQL

run_as heisei_report_login <<'SQL' >/dev/null
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000002', 'spam', 'category-v1');
SQL
echo "PASS: report writer own report INSERT"

expect_failure "invalid report category" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000001', 'unknown', 'category-v1');
SQL
expect_failure "invalid report category version" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000001', 'spam', 'category-v2');
SQL

expect_failure "invalid report nonce length" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version, description_ciphertext, description_nonce, encryption_algorithm_version, encryption_key_version, aad_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000001', 'spam', 'category-v1', decode(repeat('01', 16), 'hex'), decode(repeat('02', 11), 'hex'), 'aes-256-gcm-v1', 'enc-v1', 'aad-v1');
SQL
expect_failure "empty report ciphertext" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version, description_ciphertext, description_nonce, encryption_algorithm_version, encryption_key_version, aad_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000001', 'spam', 'category-v1', decode('', 'hex'), decode(repeat('02', 12), 'hex'), 'aes-256-gcm-v1', 'enc-v1', 'aad-v1');
SQL
expect_failure "unsupported encryption algorithm" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version, description_ciphertext, description_nonce, encryption_algorithm_version, encryption_key_version, aad_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000001', 'spam', 'category-v1', decode(repeat('01', 16), 'hex'), decode(repeat('02', 12), 'hex'), 'unknown', 'enc-v1', 'aad-v1');
SQL
expect_failure "unsupported report AAD version" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version, description_ciphertext, description_nonce, encryption_algorithm_version, encryption_key_version, aad_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000001', 'spam', 'category-v1', decode(repeat('01', 16), 'hex'), decode(repeat('02', 12), 'hex'), 'aes-256-gcm-v1', 'enc-v1', 'unknown');
SQL
expect_failure "empty encryption key version" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version, description_ciphertext, description_nonce, encryption_algorithm_version, encryption_key_version, aad_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000001', 'spam', 'category-v1', decode(repeat('01', 16), 'hex'), decode(repeat('02', 12), 'hex'), 'aes-256-gcm-v1', ' ', 'aad-v1');
SQL

own_report_count="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT count(*) FROM reports WHERE reporter_user_id = '00000000-0000-4000-8000-000000000001';
SQL
)"
test "$own_report_count" = 1
echo "PASS: report writer own report SELECT"

other_report_count="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
SELECT count(*) FROM reports WHERE reporter_user_id = '00000000-0000-4000-8000-000000000001';
SQL
)"
test "$other_report_count" = 0
echo "PASS: report writer other-actor report SELECT denied by RLS"

expect_failure "report writer other-actor INSERT" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES ('00000000-0000-4000-8000-000000000002', 'user', '00000000-0000-4000-8000-000000000003', 'spam', 'category-v1');
SQL

expect_failure "report writer UPDATE" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
UPDATE reports SET category = 'fraud';
SQL
expect_failure "report writer DELETE" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
DELETE FROM reports;
SQL

expect_failure "pending duplicate" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000002', 'fraud', 'category-v1');
SQL
duplicate_category="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT category FROM reports WHERE reporter_user_id = current_setting('app.user_id')::uuid AND target_user_id = '00000000-0000-4000-8000-000000000002';
SQL
)"
test "$duplicate_category" = spam
echo "PASS: pending duplicate preserves existing report"

run_as heisei_report_login <<'SQL' >/dev/null
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000002', 'spam', 'category-v1');
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000003', 'fraud', 'category-v1');
SQL
echo "PASS: independent reporter and target pending rows"

concurrent_a="$(mktemp)"
concurrent_b="$(mktemp)"
set +e
run_as heisei_report_login >"$concurrent_a" 2>&1 <<'SQL' &
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000003', 'spam', 'category-v1');
SQL
concurrent_pid_a=$!
run_as heisei_report_login >"$concurrent_b" 2>&1 <<'SQL' &
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000003', 'fraud', 'category-v1');
SQL
concurrent_pid_b=$!
wait "$concurrent_pid_a"
concurrent_status_a=$?
wait "$concurrent_pid_b"
concurrent_status_b=$?
set -e
concurrent_count="$(psql_file -Atqc "SELECT count(*) FROM reports WHERE reporter_user_id = '00000000-0000-4000-8000-000000000001' AND target_user_id = '00000000-0000-4000-8000-000000000003'")"
rm -f "$concurrent_a" "$concurrent_b"
if [[ "$concurrent_count" != "1" ]] || [[ "$concurrent_status_a" == "$concurrent_status_b" ]]; then
  echo "FAIL: concurrent pending INSERT did not produce exactly one row" >&2
  exit 1
fi
echo "PASS: concurrent pending INSERT keeps one row"

expect_failure "partial encryption envelope" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version, description_ciphertext)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000003', 'other', 'category-v1', decode('01', 'hex'));
SQL

expect_failure "general user idempotency INSERT" run_as heisei_app_login <<'SQL'
SET ROLE heisei_app;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO report_idempotency (reporter_user_id, reporter_scope_digest, payload_fingerprint, fingerprint_algorithm_version, fingerprint_key_version, expires_at)
VALUES (current_setting('app.user_id')::uuid, decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'), 'hmac-sha256-v1', 'hmac-v1', now() + interval '30 days');
SQL

run_as heisei_report_login <<'SQL' >/dev/null
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO report_idempotency (reporter_user_id, reporter_scope_digest, payload_fingerprint, fingerprint_algorithm_version, fingerprint_key_version, expires_at)
VALUES (current_setting('app.user_id')::uuid, decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'), 'hmac-sha256-v1', 'hmac-v1', now() + interval '30 days');
SQL
echo "PASS: report idempotency writer INSERT"

null_report_reference_count="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT count(*) FROM report_idempotency WHERE reporter_user_id = current_setting('app.user_id')::uuid AND report_id IS NULL;
SQL
)"
test "$null_report_reference_count" = 1
echo "PASS: idempotency record supports nullable report reference"

expect_failure "report writer fingerprint UPDATE" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
UPDATE report_idempotency SET payload_fingerprint = decode(repeat('03', 32), 'hex');
SQL
expect_failure "report writer direct TTL UPDATE" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
UPDATE report_idempotency SET last_used_at = now(), expires_at = now() + interval '365 days';
SQL
expect_failure "report writer key version UPDATE" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
UPDATE report_idempotency SET fingerprint_key_version = 'hmac-v2';
SQL
expect_failure "report writer report reference UPDATE" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
UPDATE report_idempotency SET report_id = gen_random_uuid();
SQL

ttl_role_attributes="$(psql_file -Atqc "SELECT rolsuper::int || ':' || rolbypassrls::int || ':' || rolcanlogin::int FROM pg_roles WHERE rolname = 'heisei_report_ttl_writer'")"
test "$ttl_role_attributes" = '0:0:0'
echo "PASS: TTL executor role is NOLOGIN/NOSUPERUSER/NOBYPASSRLS"
ttl_memberships="$(psql_file -Atqc "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'heisei_report_ttl_writer'")"
test "$ttl_memberships" = 0
echo "PASS: TTL executor role has no memberships"
function_owner="$(psql_file -Atqc "SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = 'public.report_idempotency_touch(uuid)'::regprocedure")"
test "$function_owner" = heisei_report_ttl_writer
echo "PASS: TTL function owner is dedicated executor role"
public_execute="$(psql_file -Atqc "SELECT has_function_privilege('heisei_app', 'public.report_idempotency_touch(uuid)', 'EXECUTE')")"
report_writer_execute="$(psql_file -Atqc "SELECT has_function_privilege('heisei_report_writer', 'public.report_idempotency_touch(uuid)', 'EXECUTE')")"
test "$public_execute" = f
test "$report_writer_execute" = t
echo "PASS: TTL function EXECUTE is not public and is writer-scoped"
report_writer_ttl_update="$(psql_file -Atqc "SELECT has_column_privilege('heisei_report_writer', 'public.report_idempotency', 'last_used_at', 'UPDATE')")"
ttl_role_ttl_update="$(psql_file -Atqc "SELECT has_column_privilege('heisei_report_ttl_writer', 'public.report_idempotency', 'last_used_at', 'UPDATE')")"
ttl_payload_select="$(psql_file -Atqc "SELECT has_column_privilege('heisei_report_ttl_writer', 'public.report_idempotency', 'payload_fingerprint', 'SELECT')")"
ttl_report_insert="$(psql_file -Atqc "SELECT has_table_privilege('heisei_report_ttl_writer', 'public.reports', 'INSERT')")"
test "$report_writer_ttl_update" = f
test "$ttl_role_ttl_update" = t
test "$ttl_payload_select" = f
test "$ttl_report_insert" = f
echo "PASS: TTL executor has only required column UPDATE/identity SELECT privileges"

idempotency_id="$(run_as heisei_report_login -At <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT id FROM report_idempotency WHERE reporter_user_id = current_setting('app.user_id')::uuid;
SQL
)"
before_fingerprint="$(run_as heisei_report_login -At <<SQL
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT encode(payload_fingerprint, 'hex') FROM report_idempotency WHERE id = '$idempotency_id';
SQL
)"
touch_result="$(run_as heisei_report_login -At <<SQL
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT report_idempotency_touch('$idempotency_id');
SQL
)"
test "$touch_result" = t
touch_window="$(run_as heisei_report_login -At <<SQL
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT extract(epoch FROM (expires_at - last_used_at))::bigint FROM report_idempotency WHERE id = '$idempotency_id';
SQL
)"
after_fingerprint="$(run_as heisei_report_login -At <<SQL
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT encode(payload_fingerprint, 'hex') FROM report_idempotency WHERE id = '$idempotency_id';
SQL
)"
test "$touch_window" = 2592000
test "$before_fingerprint" = "$after_fingerprint"
echo "PASS: TTL touch updates only last_used_at/expires_at and preserves fingerprint"

other_actor_touch="$(run_as heisei_report_login -At <<SQL
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
SELECT report_idempotency_touch('$idempotency_id');
SQL
)"
test "$other_actor_touch" = f
echo "PASS: other actor cannot touch idempotency record"

concurrent_touch_a="$(mktemp)"
concurrent_touch_b="$(mktemp)"
set +e
run_as heisei_report_login >"$concurrent_touch_a" 2>&1 <<SQL &
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT report_idempotency_touch('$idempotency_id');
SQL
concurrent_touch_pid_a=$!
run_as heisei_report_login >"$concurrent_touch_b" 2>&1 <<SQL &
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SELECT report_idempotency_touch('$idempotency_id');
SQL
concurrent_touch_pid_b=$!
wait "$concurrent_touch_pid_a"
concurrent_touch_status_a=$?
wait "$concurrent_touch_pid_b"
concurrent_touch_status_b=$?
set -e
rm -f "$concurrent_touch_a" "$concurrent_touch_b"
if [[ "$concurrent_touch_status_a" != "0" ]] || [[ "$concurrent_touch_status_b" != "0" ]]; then
  echo "FAIL: concurrent idempotency touches did not both succeed" >&2
  exit 1
fi
echo "PASS: concurrent same-key TTL touches succeed without fingerprint rewrite"

expect_failure "report audit non-allowlisted event" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO audit_logs (actor_user_id, target_user_id, action, rule_version, request_id)
VALUES (current_setting('app.user_id')::uuid, '00000000-0000-4000-8000-000000000002', 'profile.update', '003i-g4a', 'g4a-negative');
SQL
expect_failure "report audit other actor" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO audit_logs (actor_user_id, target_user_id, action, rule_version, request_id)
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'report.create', '003i-g4a', 'g4a-negative');
SQL
expect_failure "report audit UPDATE" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
UPDATE audit_logs SET reason = 'tampered';
SQL
expect_failure "report audit DELETE" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
DELETE FROM audit_logs;
SQL

run_as heisei_report_login <<'SQL' >/dev/null
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000002';
BEGIN;
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000001', 'other', 'category-v1');
INSERT INTO audit_logs (actor_user_id, target_user_id, action, rule_version, request_id)
VALUES (current_setting('app.user_id')::uuid, '00000000-0000-4000-8000-000000000001', 'report.create', '003i-g4a', 'g4a-atomic-success');
COMMIT;
SQL
echo "PASS: report INSERT and report.create audit same transaction"

expect_failure "audit failure transaction" run_as heisei_report_login <<'SQL'
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
BEGIN;
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000003', 'other', 'category-v1');
INSERT INTO audit_logs (actor_user_id, target_user_id, action, rule_version, request_id)
VALUES (current_setting('app.user_id')::uuid, '00000000-0000-4000-8000-000000000003', 'profile.update', '003i-g4a', 'g4a-atomic-failure');
COMMIT;
SQL
rollback_count="$(psql_file -Atqc "SELECT count(*) FROM reports WHERE reporter_user_id = '00000000-0000-4000-8000-000000000003' AND target_user_id = '00000000-0000-4000-8000-000000000003'" )"
test "$rollback_count" = 0
echo "PASS: audit failure rolls back report INSERT"

# Preflight only: a visibility decision made in one transaction is stale if
# the target changes before a later report INSERT. This intentionally records
# the G4-B boundary; no report repository is implemented here.
psql_file <<'SQL' >/dev/null
UPDATE profiles
SET profile_visibility = 'public'
WHERE id = '00000000-0000-4000-8000-000000000002';
SQL
visibility_decision_before_change="$(run_as heisei_visibility_login -At <<'SQL'
SET ROLE heisei_visibility_reader;
SET app.user_id = '00000000-0000-4000-8000-000000000001';
SET app.visibility_target_id = '00000000-0000-4000-8000-000000000002';
SELECT count(*) FROM profiles WHERE id = '00000000-0000-4000-8000-000000000002';
SQL
)"
test "$visibility_decision_before_change" = 1
psql_file <<'SQL' >/dev/null
UPDATE profiles
SET profile_visibility = 'private'
WHERE id = '00000000-0000-4000-8000-000000000002';
SQL
run_as heisei_report_login <<'SQL' >/dev/null
SET ROLE heisei_report_writer;
SET app.user_id = '00000000-0000-4000-8000-000000000003';
INSERT INTO reports (reporter_user_id, target_type, target_user_id, category, category_version)
VALUES (current_setting('app.user_id')::uuid, 'user', '00000000-0000-4000-8000-000000000002', 'other', 'category-v1');
SQL
stale_visibility_report_count="$(psql_file -Atqc "SELECT count(*) FROM reports WHERE reporter_user_id = '00000000-0000-4000-8000-000000000003' AND target_user_id = '00000000-0000-4000-8000-000000000002'")"
test "$stale_visibility_report_count" = 1
psql_file <<'SQL' >/dev/null
DELETE FROM reports
WHERE reporter_user_id = '00000000-0000-4000-8000-000000000003'
  AND target_user_id = '00000000-0000-4000-8000-000000000002';
SQL
echo "PASS: split visibility decision permits stale report insert (G4-B TOCTOU boundary reproduced)"

plaintext_columns="$(psql_file -Atqc "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reports' AND column_name IN ('description', 'normalized_description')")"
test "$plaintext_columns" = 0
echo "PASS: reports has no plaintext description column"

report_memberships="$(psql_file -Atqc "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'heisei_report_writer'")"
test "$report_memberships" = 0
echo "PASS: report writer has no role memberships"
expect_failure "audit log UPDATE" run_as heisei_audit_login <<'SQL'
SET ROLE heisei_audit_writer;
UPDATE audit_logs SET reason = 'tampered';
SQL
expect_failure "audit log DELETE" run_as heisei_audit_login <<'SQL'
SET ROLE heisei_audit_writer;
DELETE FROM audit_logs;
SQL

# Reapplying both SQL files must remain successful and idempotent.
psql_file < "$repo_root/packages/database/drizzle/0000_auth_foundation.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/roles.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0001_profile_visibility.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0002_report_foundation_g4a.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0003_report_atomic_boundary_g4b1.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/roles.sql" >/dev/null
echo "PASS: migration first application and reapplication"
echo "PASS: PostgreSQL RLS integration checks"
