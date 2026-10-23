#!/usr/bin/env bash
set -euo pipefail

# Local-only real DB/API integration test. It never reads a configured DB URL.
if ! command -v docker >/dev/null 2>&1; then
  echo "BLOCKED: docker is required" >&2
  exit 2
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container="heisei-api-db-${PPID}-${RANDOM}"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
started=0
for attempt in 1 2 3; do
  echo "INFO: isolated PostgreSQL container start attempt $attempt"
  if docker run --name "$container" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=local-only-password -e POSTGRES_DB=heisei_local -d postgres:16-alpine >/dev/null; then
    started=1
    break
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  sleep 2
done
if [[ "$started" != 1 ]]; then
  echo "FAIL: could not start isolated PostgreSQL container" >&2
  exit 1
fi
# Wait for the final TCP server rather than PostgreSQL's init-only Unix socket.
ready=0
for _ in $(seq 1 45); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d heisei_local >/dev/null 2>&1 &&
     docker exec "$container" psql -h 127.0.0.1 -U postgres -d heisei_local -Atqc 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "FAIL: isolated PostgreSQL did not become ready" >&2
  docker logs --tail 50 "$container" >&2 || true
  exit 1
fi
psql_file() { docker exec -i "$container" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U postgres -d heisei_local "$@"; }
psql_file < "$repo_root/packages/database/drizzle/0000_baseline_profiles.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0000_auth_foundation.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/roles.sql" >/dev/null
psql_file <<'SQL' >/dev/null
CREATE ROLE heisei_test_login LOGIN PASSWORD 'local-test' NOSUPERUSER NOBYPASSRLS;
GRANT heisei_app, heisei_identity_writer TO heisei_test_login;
CREATE ROLE heisei_app_login LOGIN PASSWORD 'local-app' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE heisei_identity_login LOGIN PASSWORD 'local-identity' NOSUPERUSER NOBYPASSRLS;
GRANT heisei_app TO heisei_app_login;
GRANT heisei_identity_writer TO heisei_identity_login;
GRANT USAGE ON SCHEMA public TO heisei_app_login, heisei_identity_login;
INSERT INTO profiles (id, username, display_name, auth_subject, auth_level)
VALUES
 ('00000000-0000-4000-8000-000000000001', 'integration-one', 'Integration One', 'integration-subject-1', 1),
 ('00000000-0000-4000-8000-000000000002', 'integration-two', 'Integration Two', 'integration-subject-2', 1);
INSERT INTO user_verifications (user_id, kind, status, verification_version)
VALUES ('00000000-0000-4000-8000-000000000001', 'email_verified', 'verified', '003e-test');
INSERT INTO blocks (blocker_id, blocked_id)
VALUES
 ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'),
 ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');
SQL
export HEISEI_LOCAL_PG_CONTAINER="$container"
mapped_port="$(docker port "$container" 5432/tcp | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')"
if [[ -z "$mapped_port" ]]; then
  echo "FAIL: could not determine mapped PostgreSQL port" >&2
  exit 1
fi
export HEISEI_LOCAL_PG_URL="postgresql://heisei_test_login:local-test@127.0.0.1:${mapped_port}/heisei_local"
# Use the runner's existing Corepack/pnpm cache; never assume /workspace exists.
pnpm --config.verifyDepsBeforeRun=warn exec vitest run tests/postgres-api.integration.test.ts
echo "PASS: real JWT → Hono → isolated PostgreSQL integration"
