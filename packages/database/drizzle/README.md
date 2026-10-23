# Local migration policy

`0000_auth_foundation.sql` is an expand-only, local-only foundation migration. It
preserves the existing `profiles` columns, including legacy `is_age_verified`, and
adds nullable `auth_subject` so existing rows can be backfilled by a separately
approved process. The source of truth for authorization is the server-loaded
`auth_subject`, `auth_level`, `membership`, `roles_json`, `account_status`, and
`user_verifications`; the legacy boolean is not used by the identity adapter.

Before applying locally, create a new disposable PostgreSQL database and apply
`roles.sql` after the schema migration. The application role receives only safe
profile columns; the privileged identity columns have no UPDATE grant. Staff
queries require the separate `heisei_staff` database role as well as an approved
scope. Audit INSERT requires `heisei_audit_writer` and `app.audit_actor_id`; a
normal application role cannot forge events. Authentication evidence and the
privileged profile columns are written only through the separate
`heisei_identity_writer` role.

```sh
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0000_baseline_profiles.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0000_auth_foundation.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/roles.sql
```

Re-running the migration is intended to be idempotent. A rollback is performed by
discarding the disposable database. On a database containing data, use an
approved expand/contract migration and backup procedure; do not execute a
destructive down migration. Production, staging, Supabase, and shared databases
are explicitly out of scope.
