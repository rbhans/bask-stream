# Station model editing and master write control

The source adds API 1.6 model editing to the module's WebSocket API. All 15 model actions use installed Baja component types and public Niagara APIs: create, update, clone, rename, move, delete, hierarchy creation/configuration, dynamic slot addition/removal, metadata, reorder, links and component action invocation. The complete wire contract is in [MODEL_EDITING_API.md](MODEL_EDITING_API.md).

`writesEnabled=false` gates existing point/tag/relation/alarm writes and model application, at dispatch where applicable and immediately before mutations. Its default remains true for existing clients. The new editor separately requires `modelEditsEnabled=true`, default false. These are annotation declarations awaiting the user-owned Slot-o-matic/build step.

Model writes use principal-bound preview/hash/apply plans, current permissions and identity checks, collision reservations, bounded diffs, secret redaction, audit events, partial outcomes and a reconnect-safe in-memory idempotency ledger. Status remains readable during action execution; concurrent plans cannot apply together. No blanket transaction, restart-persistent replay, external reference rewriting, or platform/host administration is claimed.

## Issues addressed during validation

- Nested struct output could expose an unreadable child despite checking its parent. Mounted descriptions now filter nested reads; structural copy/delete checks traverse nested values. API-double tests cover hidden nested fields.
- An external replacement of a nested struct could leave a preview pointing at a detached previous owner. Apply now checks the actual property owner identity, and overlapping parent/child property edits are rejected during preview. Regression tests cover identical-value owner replacement.
- A write can succeed before auditing or reply delivery fails. The ledger retains the write result before auditing, records partial failure, and deduplicates subsequent identical requests. Tests cover audit failure, per-property failure and concurrent status/deduplication.

## Verification

- Existing protocol and transport regression scripts passed.
- Plan-ledger regressions passed for binding, expiry/cancellation, stale state, the write gate, failures, deduplication and concurrent status/application exclusion.
- Actual resolver source exercised against in-memory Baja API doubles passed all 15 action paths plus references, collisions, nested permission/identity changes, redaction, service protection and structural guards.
- Read-only Java type analysis against installed N4.15 API signatures passed, without class generation or a Niagara module build.

These checks do not establish live Niagara lifecycle behavior, move-handle preservation, driver effects, hierarchy licensing or Workbench acceptance. No station was started, connected, changed or restarted. No Niagara JAR was built or deployed.
