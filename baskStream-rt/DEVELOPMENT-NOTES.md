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
- The websocket transport is currently bridged from the `BWebServlet` service into an owned Jetty `WebSocketServlet` instance so the station-facing API can stay tied to the service's property sheet and `servletName`.
- The Gradle build declares Niagara module dependencies with `api(...)`, but the plain servlet and Jetty websocket APIs are referenced with `compileOnly(files(...))` from `niagara_home/bin/ext` because this install did not expose those two jars as resolvable `nre(...)` artifacts.

## Follow-up Candidates

- Migrate `BBaskStreamService` to annotations and let Slot-o-matic regenerate `module-include.xml`.
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
