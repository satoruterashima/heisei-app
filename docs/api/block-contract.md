# Block API contract

The block mutation endpoints require a verified JWT mapped to the server-side
internal user UUID. Only an active L2+ identity may mutate blocks; the request
cannot provide an actor ID, role, level, or account status.

## Create

`POST /api/v1/blocks`

The request must use exactly `Content-Type: application/json`, be no larger than
8 KiB, and contain only `{ "targetUserId": "<uuid>" }`. Self-blocking is
rejected. Every syntactically valid request returns the same `202` acceptance
envelope with an opaque block UUID. New, repeated, and unknown target UUIDs do
not produce different status codes or fields. The opaque UUID is deterministic
for the actor/target pair, so an owner can use it for the delete operation
without an existence lookup.

## Remove

`DELETE /api/v1/blocks/:id`

`:id` is the block UUID, not a user UUID. PostgreSQL RLS permits deletion only
when the authenticated actor owns the block. A missing or another user's block
returns the same `404` envelope.

Both mutations append an audit event in the same transaction as the block
change. If the audit write fails, the block change is rolled back. Responses
use `{ data, requestId }` or `{ error, requestId }` and sensitive responses are
marked `no-store`.

Read-only access-policy hints may reflect block relationships, but every
mutation reauthorizes the current identity and account status.
