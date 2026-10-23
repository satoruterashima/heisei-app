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

The migration separates owner, staff, and identity-writer policies by database
role. `app.user_id` and `app.staff_scope` are transaction-local values supplied
only after trusted server authorization; setting a GUC never grants access on
its own. The local role definitions are `NOSUPERUSER` and `NOBYPASSRLS`.
Identity lookup uses the same identity-writer role with the verified
`app.auth_subject` context; after the subject-to-UUID mapping, subsequent
queries use `app.user_id`.

```sh
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0000_baseline_profiles.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0000_auth_foundation.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/roles.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0001_profile_visibility.sql
```

Run the reproducible, disposable PostgreSQL security checks with Docker:

```sh
bash scripts/test-database-local.sh
```

The script creates non-owner, non-superuser, `NOBYPASSRLS` login roles and
checks safe profile updates, privileged-column denial, staff scope, identity
evidence writes, audit-writer boundaries, append-only audit logs, and migration
first/reapply behavior. It never connects to a configured external database.

Re-running the migration is intended to be idempotent. A rollback is performed by
discarding the disposable database. On a database containing data, use an
approved expand/contract migration and backup procedure; do not execute a
destructive down migration. Production, staging, Supabase, and shared databases
are explicitly out of scope.
