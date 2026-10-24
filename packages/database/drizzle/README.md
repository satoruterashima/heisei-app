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

`0002_report_foundation_g4a.sql` is a separate G4-A local-only migration. It
creates the reports and report-idempotency tables, the `heisei_report_writer`
boundary, pending uniqueness, and report audit allowlisting. It does not create
a report API or connect G2/G3/G5 runtime behavior.

The migration separates owner, staff, and identity-writer policies by database
role. `app.user_id` is a transaction-local value supplied only after trusted
server authorization; setting a GUC never grants access on its own. The local
role definitions are `NOSUPERUSER` and `NOBYPASSRLS`. Case access is derived
from active `report_staff_assignments` rows, not from a target-user scope.
Identity lookup uses the same identity-writer role with the verified
`app.auth_subject` context; after the subject-to-UUID mapping, subsequent
queries use `app.user_id`.

```sh
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0000_baseline_profiles.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0000_auth_foundation.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/roles.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0001_profile_visibility.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0002_report_foundation_g4a.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0003_report_atomic_boundary_g4b1.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/roles.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0004_report_repository_g4b2.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/roles.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0005_report_operations_local.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/roles.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/0006_report_case_assignments_local.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/database/drizzle/roles.sql
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

`0005_report_operations_local.sql` and `0006_report_case_assignments_local.sql`
add a metadata-only, case-assigned staff reader for local operations tests. It
cannot read encrypted columns, decrypt, change report status, dispose,
disclose, or alter assignments. Assignment mutation is not exposed by the API;
the database derives visibility from active rows in
`report_staff_assignments`.
