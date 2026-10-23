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
docker run --name "$container" -e POSTGRES_PASSWORD=local-only-password -e POSTGRES_DB=heisei_local -d postgres:16-alpine >/dev/null
for _ in $(seq 1 45); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d heisei_local >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d heisei_local >/dev/null
psql_file() { docker exec -i "$container" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U postgres -d heisei_local "$@"; }
psql_file < "$repo_root/packages/database/drizzle/0000_baseline_profiles.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/0000_auth_foundation.sql" >/dev/null
psql_file < "$repo_root/packages/database/drizzle/roles.sql" >/dev/null
psql_file <<'SQL' >/dev/null
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
export COREPACK_HOME="${COREPACK_HOME:-/workspace/.heisei-cloud/corepack}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/workspace/.heisei-cloud/data}"
export npm_config_cache="${npm_config_cache:-/workspace/.heisei-cloud/npm}"
corepack pnpm --config.verifyDepsBeforeRun=warn vitest run tests/postgres-api.integration.test.ts
echo "PASS: real JWT → Hono → isolated PostgreSQL integration"
