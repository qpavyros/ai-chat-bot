# AI Chat Bot Operations Runbook

## Storage source of truth

When `FIRESTORE_SOURCE_OF_TRUTH=true`, startup hydration loads bot configuration, knowledge, and business data into the runtime cache. Orders, appointments, customer profiles, transcripts, escalations, takeover state, and human reply ledgers read from that cache. `FIRESTORE_MIRROR_WRITES=true` updates Firestore after successful local writes and refreshes the cache.

Keep `MIGRATION_FREEZE=false` during normal operation. Set it to `true` only during a planned final migration window; safe writes then return a migration freeze error.

## Verification after deployment

Run the full unit suite and the deployment regression suite. Verify the health endpoint returns HTTP 200, PM2 reports the service online, and recent logs contain no Firestore hydration or mirror errors. Keep the deployment rollback archive and its SHA-256 beside the evidence record.

## Backup and restore

Back up the `data/` directory outside the VPS without copying `.env` or provider credentials. Record the archive SHA-256. Restore into a temporary directory first, count the files and bytes, and remove the temporary extraction after verification. Firestore migration rollback files are separate and must be tested by writing and deleting a temporary rehearsal document.

## Logs and human operations

Admin audit and escalation APIs support `limit` and `cursor`; old JSONL records are appended to an `.archive.jsonl` file before the active file is capped. Human replies use idempotency operation IDs. A `pending` or `unknown` delivery must be reconciled before retrying. Takeover state lasts 24 hours by default and is persisted.

## Security boundaries

Client `auth.json` files remain local and are excluded from Git. Do not put `.env`, provider tokens, or customer exports in the repository or deployment payload. All dashboard and human reply routes require account ownership checks.
