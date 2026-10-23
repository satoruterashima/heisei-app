# Local migration policy

`0000_auth_foundation.sql` is an expand-only, local-only foundation migration. It
preserves the existing `profiles` columns, including legacy `is_age_verified`, and
adds nullable `auth_subject` so existing rows can be backfilled by a separately
approved process. The source of truth for authorization is the server-loaded
`auth_subject`, `auth_level`, `membership`, `roles_json`, `account_status`, and
`user_verifications`; the legacy boolean is not used by the identity adapter.

Before applying locally, create a new disposable PostgreSQL database and a
non-privileged test role. Set `app.user_id` and, for a single approved staff
non-privileged test role. The staff-scoped policies additionally require the
database role `heisei_staff`; set `app.user_id` and, for a single approved staff
target, `app.staff_scope` with `SET LOCAL` inside each transaction. Never use a
superuser or service role to claim RLS coverage.

```sh
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0000_auth_foundation.sql
```

Re-running the migration is intended to be idempotent. A rollback is performed by
discarding the disposable database. On a database containing data, use an
approved expand/contract migration and backup procedure; do not execute a
destructive down migration. Production, staging, Supabase, and shared databases
are explicitly out of scope.
