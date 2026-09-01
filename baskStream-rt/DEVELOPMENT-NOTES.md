# baskStream Development Notes

## Working Agreement

- The user always handles jar/module compilation and Niagara build execution.
- Codex should not assume it will run the real compile/package/install flow; local syntax checks are fine, but final jar building is user-owned.

This module was cross-checked against the local Obsidian Niagara developer-guide vault at `/Users/benhansen/wiki`, especially:

- `raw/n4-dev-guide/07-component-model.md`
- `raw/n4-dev-guide/31-web-overview.md`
- `raw/n4-dev-guide/43-slot-o-matic.md`

## Relevant Findings

- `BWebServlet` registration is driven by `servletName`, and Niagara treats it as a station-installed servlet component.
- Niagara's developer docs prefer `@NiagaraType` and Slot-o-matic-generated `module-include.xml` over hand-maintained type entries.
- Standard container-managed `HttpServlet` deployment in Niagara 4 is `WEB-INF/web.xml` based, which may be a better long-term home for a production `WebSocketServlet`.

## Current Intentional Deviations

- `module-include.xml` is currently maintained manually because the first implementation pass used explicit slot/type code instead of a full Slot-o-matic migration.
- The websocket transport is bridged from the `BWebServlet` service into an owned Jetty `WebSocketServerFactory` so the station-facing API can stay tied to the service's property sheet and `servletName`. The upgrade uses the Jetty 9.4 handshake path described below.
- The Gradle build declares Niagara module dependencies with `api(...)`, but the plain servlet and Jetty websocket APIs are referenced with `compileOnly(files(...))` from `niagara_home/bin/ext` because this install did not expose those two jars as resolvable `nre(...)` artifacts.

## Transport Upgrade (Jetty 9.4)

- Symptom: replacing the manual handshake with `WebSocketServerFactory.acceptWebSocket(...)` caused every authenticated `/stream` upgrade to fail with HTTP 500 on the installed Jetty 9.4 runtime.
- Cause: the installed Jetty 9.4.56 implementation changes the current thread's context class loader inside `acceptWebSocket`. Niagara's station security manager denies that operation unless the module requests `RuntimePermission("setContextClassLoader")`.
- Fix: retain the public request/policy/creator APIs but perform the final Jetty 9.4 connection upgrade directly, as the previously live-tested implementation did. The documented `MANAGE_EXECUTION` request now covers the separate executor-lifecycle requirement; the established upgrade path remains unchanged while preserving the new authorization-header, origin, audit, per-user-cap, and frame-size controls.
- Compatibility: the module manifest keeps `bajaVersion` at `4.10`, matching QAGCharts' cross-Niagara version floor. The transport path depends on Jetty 9.4 internals, so re-verify it against installed artifacts if a target Niagara release changes Jetty.

## Request Threading (per-session worker)

- Symptom/risk: requests were dispatched synchronously on the Jetty IO thread, and `BaskStreamWriteResolver.snapshotAfterWrite` did `Thread.sleep` per point (up to `MAX_WRITE_POINTS_PER_REQUEST = 1000`), so a single batch write could hold a shared Jetty thread for up to ~150 s and degrade the station web tier.
- Fix: `BaskStreamClientSession.onBinary` now hands the raw frame to a per-session single-thread daemon executor (`worker`); the original decode/dispatch body is `processFrame`. Per-session FIFO ordering is preserved. `close()` drains the worker (`shutdown()` + bounded `awaitTermination`/`shutdownNow`), guarding the self-call case where `close()` runs on the worker thread via the `send()` IO-failure path. The shared `scheduler` is intentionally NOT reused (it would let one client's batch stall COV/lease delivery for all sessions).
- The post-write settle delay is now the `writeSettleMillis` property (default 150) instead of a literal, so timing/output is unchanged by default.

## Security Hardening (API 1.4)

Three WebSocket-security items were addressed. Defaults keep current clients (Grafana Go datasource, MCP TS tool, live-smoke script) working without change.

- CSWSH hardening (handshake). Symptom/risk: the handshake authenticated against Niagara's web session, but for browser clients that is ambient cookie auth — the classic Cross-Site WebSocket Hijacking vector — and the `Origin` check also allowed an absent `Origin`. Cause: no header-channel requirement and an unconditional empty-`Origin` allowance. Fix: opt-in service properties `requireAuthorizationHeader` (reject upgrades lacking an `Authorization` header — a browser cannot set headers on a WS handshake) and `rejectMissingOrigin`, wired in `BaskStreamWebSocketRuntime.handleUpgrade`/`isAllowedOrigin`. Niagara still validates the credential; this only constrains the channel. Both default `false` (no behavior change). Verify: with `requireAuthorizationHeader=true`, a cookie-only upgrade is 403 and a header-auth upgrade is 101; with `rejectMissingOrigin=true`, a no-`Origin` upgrade is 403.
- Session revalidation (lifecycle). Symptom/risk: auth is checked once at connect, so a since-removed user or a permission/category change can keep streaming on an already-open socket. Optional fix: when `revalidateIntervalSec` is set above `0`, `BaskStreamClientSession` schedules a sweep on the per-session worker; it drops now-unreadable subscriptions (re-check `allowedPathPatterns` + `OrdTarget.canRead()`) with a `subscriptions_revoked` notice, and tears down the socket (close 1008 + `session_revoked` notice) when the principal was mounted at connect and later becomes unmounted. The default is `0` (disabled) because the handshake principal's mounted/detached lifecycle has not been proven across target Niagara installations; existing app connections therefore retain their prior behavior. Transient resolve failures are not treated as revocation. Enable and verify this option on-station before relying on it.
- Path policy compatibility. `allowedPathPatterns` retains its established `slot:/*` default, and an unset/empty value keeps the same wide-open fallback. This avoids breaking existing app, Grafana, MCP, history, alarm, and schedule flows. Niagara user permissions remain authoritative; deployments can still configure narrower `slot:/...` patterns as an additional scope boundary.

### Batch 2: Resource Limits and Audit Logging

- Inbound message-size cap. Risk: long-lived sockets on a constrained JACE could be fed an oversized frame to exhaust memory; the Jetty policy was left at defaults. Fix: new `maxMessageBytes` property (default 1 MiB; floored at 4 KiB) applied to the Jetty `WebSocketPolicy` max binary/text message size in `BaskStreamWebSocketRuntime.ensureFactory`. Verify: a frame larger than the cap closes the connection (message-too-big); default comfortably fits a 1000-point batch.
- Per-user connection cap. Risk: only a global `maxConnections` existed, so one authenticated user could consume every slot. Fix: new `maxConnectionsPerUser` property (default `0` = unlimited, to avoid breaking shared service-account deployments). Enforced in `BaskStreamSubscriptionManager.register` (authoritative) and pre-checked in the socket creator (`getConnectionCountForUser`). Default off — admins should set it to a value matching their connection topology (one datasource/MCP/Electron instance is typically one connection). Verify: with the cap set, the Nth+1 connection for the same user is refused (503 pre-upgrade or 1013).
- Security/audit logging. Risk: connect/auth-failure/disconnect events were only at FINE, not auditable. Fix: `BBaskStreamService.audit(event, detail)` logs at INFO with a stable `AUDIT baskStream` prefix. Events: `upgrade_rejected` (missing_authorization_header / origin_not_allowed / unauthenticated / max_connections / max_connections_per_user, with remote+user+origin where known), `connect`, `connect_rejected`, `disconnect`, `subscriptions_revoked`, `session_revoked`. Deferred: routing these into Niagara's formal audit-history (BAuditRecord / audit service) — that API is not in the extracted dev guide and needs station confirmation; structured INFO logging is the interim, greppable trail.

### Module permissions

`module-permissions.xml` uses the documented Niagara `MANAGE_EXECUTION` permission group for the station profile. The installed Niagara 4.15 Developer Guide maps that group to `RuntimePermission("modifyThread")` and related thread-management permissions required by the module-owned executors. Do not insert generated-manifest `<java-permissions>` entries into this source descriptor; doing so caused the rebuilt module to be excluded from the station registry.

### App-Impact Summary

- Path-policy impact: there is no default behavior change. New, upgraded, and explicitly blank service instances retain the legacy wide-open path behavior, subject to Niagara user permissions. Administrators can still narrow the field per integration.
- All current clients use cookie auth with no `Authorization` header, and the MCP client sends no `Origin`. So `requireAuthorizationHeader` and `rejectMissingOrigin` must stay `false` until those clients are updated; enabling either today would break them. Session revalidation also defaults off so it cannot unexpectedly sever an established app connection. Header auth requires a client that sets `Authorization` on the handshake (Electron can; browser/`ws`/gorilla cookie flows would need migration).
- Additive notices `subscriptions_revoked`/`session_revoked` are new server→client ops; existing clients ignore unknown ops. `apiVersion` is now `1.4`; no client gates behavior on it (smoke test only displays it).
- Batch 2 impact: `maxMessageBytes` (1 MiB default) and `maxConnectionsPerUser` (0 = unlimited default) are backward compatible — existing clients send small frames and typically one connection per user. Registration enforces the configured global/per-user caps atomically. Audit logging is additive INFO output. Formal audit-history routing remains a separate enhancement that needs the audit-service API confirmed on-station.
- Slot-o-matic: the five new slots (`requireAuthorizationHeader`, `rejectMissingOrigin`, `revalidateIntervalSec`, `maxConnectionsPerUser`, `maxMessageBytes`) were hand-added to the generated region in the existing style (like `writeSettleMillis`); re-running Slot-o-matic will normalize them and the stale type-hash comment.

## Tag And Relation Operations (API 1.5)

- New ops `read_tags`, `write_tags`, `write_relations` in `BaskStreamTagResolver`, dispatched from `BaskStreamClientSession`. `apiVersion` is now `1.5`; `capabilities` gained a `tags` block and `schemas.tags = "1"`. All changes are additive — existing clients are unaffected.
- API surface verified against the installed 4.15 `baja.jar` (`javax.baja.tag`): `BComponent.tags()`/`relations()` return `SmartTags`/`SmartRelations`, whose `getDirectTags()`/`getDirectRelations()` split lets the wire format mark each tag/relation `direct` vs `implied`. Writes go through `Tags.set(Tag)`/`Tags.removeAll(Id)` and `Relations.add(...)`/`Relations.remove(relation)`.
- Relation-add gotcha (found live on-station): `ComponentRelations.add` rejects a generic `javax.baja.tag.BasicRelation` with "... is not a BRelation type, cannot be added." Component-space direct relations must be `javax.baja.sys.BRelation` structs; the resolver now uses `new BRelation(id, endpointComponent, inbound)`.
- Relation-remove gotcha (same live pass): `Relations.getAll()` wrappers cannot be passed back to `relations.remove(...)` — Niagara reports "... isn't a BRelation type, cannot be mapped to property." Removal iterates `component.getComponentRelations()` and tries `relations.remove(BRelation)`, then `component.remove(BRelation)` if needed.
- Haystack and hierarchy tags need no extra module dependencies: they are ordinary dictionary-qualified tags (`hs:...`, `n:...`, site dictionaries), and Haystack refs (`siteRef`/`equipRef`) are Niagara relations. No dependency on `haystack-rt`/`hierarchy-rt` was added.
- Hierarchy *trees* are a separate browse path. `browse`/`describe`/`search` accept `hierarchy:` ORDs only when the client asks for that scheme. Existing `slot:/` browse/search child filtering is unchanged (`slotBrowseOnly` stays `true`). Hierarchy grouping nodes get additive `entityOrd`/`targetOrd`/`targetSlotPath` via reflection so the module still loads on stations without `hierarchy-rt`. Bound components are still checked against `allowedPathPatterns`.
- Permission model: reads require `OrdTarget.canRead()`; writes require `canWrite()` **and** `BPermissions.hasAdminWrite()` on the target (tag edits are component-model edits, matching Workbench). Relation endpoints must be readable. `allowedPathPatterns` applies to all targets and endpoints; only `slot:/` ORDs are accepted.
- Value mapping: omitted/`null` value → `BMarker` (Haystack marker); boolean → `BBoolean`; number → `BDouble` by default (matches Niagara Haystack number tags; `valueType: "long"` forces `BLong`); string → `BString`. Implied tags are read-only; removal attempts return `implied_tag` per entry rather than failing the batch.
- Limits: 100 targets per request, 100 set/remove ops per target, 500 tags/relations per target on the wire. Not yet live-tested on-station; verify direct-tag persistence (station save) and `model_cov` hints (`facets_changed`, `relation_added`/`relation_removed`) during the next station test pass.

## Follow-up Candidates

- Migrate `BBaskStreamService` to annotations and let Slot-o-matic regenerate `module-include.xml`. (The new `writeSettleMillis` slot was hand-added to the generated region in the existing style; re-running Slot-o-matic will normalize it.)
- If websocket lifecycle behavior is flaky on-station, move the transport into a container-managed servlet declared through `WEB-INF/web.xml`, and keep `BBaskStreamService` focused on configuration/runtime state.

## Alarm Subscription Shape

- `subscribe_alarms` always returns one bounded initial snapshot in `alarms_subscribed.alarms`.
- Live `alarm_cov` defaults to `mode: "event"` so large stations do not resend the whole open alarm set for every alarm transition.
- Event-mode `alarm_cov` includes `event` as the changed alarm record and `inScope` to tell clients whether that record currently belongs in the subscription's `scope`.
- Clients that want the old full-list push can subscribe with `mode: "snapshot"`. Clients that want both can use `mode: "both"`.
- For large stations, API clients should maintain their own alarm map keyed by `event.uuid`, update or remove records using `inScope`, and call `read_alarms` only for initial load or resync.

## Third-Party Integration Metadata

- `browse` and `describe` can include an additive `metadata` block for app-side discovery logic.
- `browse` defaults to `metadata: "none"` so broad tree navigation stays light; clients should request `metadata: "full"` for initial discovery or structural refreshes.
- `describe` defaults to `metadata: "full"` because it returns a single node; clients can request `metadata: "none"` when they only need base node properties.
- `read` is the batch point snapshot operation. It can return point facets and supports optional `fields` trimming for lean Dial-style point tables.
- The metadata intentionally exposes evidence rather than making universal equipment claims: parent/ancestor summaries, deterministic Niagara type flags, driver/device/proxy ancestry, point facets/extensions, tags, and relations.
- Device and point detection can be deterministic through Niagara types such as `BDevice` and `BControlPoint`; equipment detection should be treated as confirmed only when tags/relations/user mappings say so, otherwise inferred and reviewed by the app.
- See `docs/THIRD_PARTY_API.md` for the external API guide and client-side discovery recommendations.
