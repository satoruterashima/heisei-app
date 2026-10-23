# Block API contract

The block mutation endpoints require a verified JWT mapped to the server-side
internal user UUID. Only an active L2+ identity may mutate blocks; the request
cannot provide an actor ID, role, level, or account status.

## Create

`POST /api/v1/blocks`

The request must use exactly `Content-Type: application/json`, be no larger than
8 KiB, and contain only `{ "targetUserId": "<uuid>" }`. Self-blocking is
rejected. Every syntactically valid request returns the same `202` acceptance
envelope with no block identifier. New, repeated, and unknown target UUIDs do
not produce different status codes or fields.

## Remove

`DELETE /api/v1/blocks/:id`

`:id` is the block UUID, not a user UUID. PostgreSQL RLS permits deletion only
when the authenticated actor owns the block. Every syntactically valid UUID is
accepted with the same `202` envelope; missing and another user's blocks are
no-ops. This changes the original 404 contract to prevent POST→DELETE target
enumeration. Existing clients that already hold an owned block UUID remain
compatible; a future owner-only block listing capability is a separate product
decision and is intentionally not added here.

`DELETE /api/v1/blocks/by-target/:targetUserId`

`:targetUserId` is the internal profile UUID obtained from an already authorized
application context. The endpoint does not list users or blocks. For every valid
UUID, including an unknown user, an unblocked user, or a block owned by another
actor, it returns the same `202` acceptance envelope. PostgreSQL RLS limits the
actual deletion to a row created by the current actor, so the endpoint does not
reveal whether the target exists or whether a relationship was present. Invalid
UUID syntax is `400`; database or audit failures are a generic `500`.

Real block changes append an audit event in the same transaction as the block
change. No-op requests do not create an audit event. If an audit write fails,
the block change is rolled back. Responses use `{ data, requestId }` or
`{ error, requestId }` and sensitive responses are marked `no-store`.

Read-only access-policy hints may reflect block relationships, but every
mutation reauthorizes the current identity and account status.
