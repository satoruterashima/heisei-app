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
echo "PASS: initial migration and role grants applied"

psql_file <<'SQL' >/dev/null
CREATE ROLE heisei_app_login LOGIN PASSWORD 'local-only-app' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_staff_login LOGIN PASSWORD 'local-only-staff' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_identity_login LOGIN PASSWORD 'local-only-identity' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_audit_login LOGIN PASSWORD 'local-only-audit' NOSUPERUSER NOBYPASSRLS;
GRANT heisei_app TO heisei_app_login;
GRANT heisei_staff TO heisei_staff_login;
GRANT heisei_identity_writer TO heisei_identity_login;
GRANT heisei_audit_writer TO heisei_audit_login;
GRANT USAGE ON SCHEMA public TO heisei_app_login, heisei_staff_login,
  heisei_identity_login, heisei_audit_login;
INSERT INTO profiles (id, username, display_name, auth_subject, auth_level)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'r2-user-1', 'R2 User 1', 'r2-subject-1', 1),
  ('00000000-0000-4000-8000-000000000002', 'r2-user-2', 'R2 User 2', 'r2-subject-2', 1);
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
echo "PASS: migration first application and reapplication"
echo "PASS: PostgreSQL RLS integration checks"
