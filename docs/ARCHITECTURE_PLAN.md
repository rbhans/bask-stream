# baskStream architecture plan

Status: Phase 0 done 2026-09-24. Phase 1 done 2026-09-25 and smoke-tested on a station. Phase 2 done 2026-09-26 and checked on a station. Phases 3 and 4 done 2026-09-28 in source (type-checked; station test pending). Later phases are proposals.

## Why

The protocol and the domain split (browse, points, history, alarms, schedules, tags, model editing) are sound. The problems found in review cluster around three structural gaps, and each new feature makes them worse:

1. **No single permission layer.** Every resolver checks access its own way, so gaps appear at the edges: related metadata, alarms, histories and hierarchy bindings.
2. **One very large session class.** `BaskStreamClientSession` (about 2,100 lines) handles dispatch, gates, subscriptions, leases, COV batching, alarm and model streams, and lifecycle. Adding an operation means editing several hand-kept lists.
3. **Ad-hoc threading.** Work runs on Niagara callback threads, the shared scheduler, Jetty threads and the session worker, with locks held across slow calls.

Niagara 5 also changes the transport (Jakarta Servlet, JPMS), and the current upgrade path depends on Jetty 9.4 internals.

The aim is a restructure in place. The wire protocol stays backward compatible throughout.

## Target shape

```text
Transport adapter      Jetty/servlet upgrade and send queue only. The one piece to swap for Niagara 5.
      |
Session                lifecycle (open/close/revalidate) + outbound mailbox
      |
Operation registry     op name -> handler + flags {writes, modelEdit, costClass}
      |                capabilities.operations is generated from this table
Authorizer             the only place that answers "may this user see/do this?"
      |                path policy + Niagara permissions + redaction helpers
Resolvers              browse, point, history, alarm, schedule, tag, write, model
      |                use the Authorizer for every object they return or touch
Event pipeline         Niagara callbacks only enqueue small change records.
                       One per-session drain encodes and sends them. Nothing blocks.
```

Supporting pieces:

- **Protocol spec:** a machine-readable description of every operation, request, response and error code (JSON Schema, optionally wrapped in AsyncAPI). Contract tests check it against the operation registry.
- **TypeScript SDK:** generated from, or checked against, the spec. It becomes the one client library for web, Node, Electron and, later, MCP.

## Phases

Each phase ends with a user-run build and a station pass before the next starts.

### Phase 0: base fixes (done 2026-09-24)

Alarm, history and per-action write permissions; the model-edit link loophole; non-blocking session close; lexicon. See `docs/2026-09-24-permission-lifecycle-fixes.md`.

### Phase 1: operation registry and protocol contract

This phase is low risk and makes everything after it testable.

- Replace the dispatch `if` chain and the separate write-gate list with one table: `name -> handler, requiresWrites, requiresModelEdits, costClass`.
- Generate `capabilities.operations` and the write gate from that table, so a new write operation cannot skip the gate.
- Write the protocol spec, starting from `THIRD_PARTY_API.md` and `MODEL_EDITING_API.md`, including an error-code table (about 50 codes).
- Add a contract test: the registry, the spec and the docs must list the same operations.

Exit: all current operations work unchanged, and the contract test passes.

**Done 2026-09-25.** What was built:

- `BaskStreamOperations` holds the 42 operations and their gates (`NONE`, `WRITES`, `MODEL_EDITS`).
- Dispatch looks up the operation, applies the writes gate, and calls the handler bound in `BaskStreamClientSession.bindHandlers()`. The session refuses to start if the handlers and the table differ.
- `capabilities.operations` comes from the table. Wire behaviour is unchanged: the same 7 operations are writes-gated, and `modelEditsEnabled` is still enforced by the plan engine.
- `spec/baskstream-protocol.json`: request JSON Schemas (valid against 2020-12), reply names, response keys, server notices and 58 error codes.
- `spec/render_error_table.py` generates the error table in `THIRD_PARTY_API.md`.
- `tests/protocol_contract.py` checks table, handlers, spec gates, source error codes and docs against each other. It was mutation-tested: an ungated write, a missing handler, a new error code and doc drift each fail it.

The cost class was left out until Phase 3, where the resource budgets will use it.

**Protocol decisions to settle before the next API version** (proposals; all additive, so existing clients keep working):

1. **Point timestamps:** keep `timestamp` (read time) and add `changeTime` when the point exposes it.
2. **Status:** keep the `status` string and add `statusFlags` (array of flag names) and `activeLevel` for writable points.
3. **Schedule times:** add structured `{hour, minute}` and ISO dates alongside the current locale strings.
4. **Non-finite history values:** send `null` with `valueFlag: "nan" | "+inf" | "-inf"`. Enum histories gain `ordinal`.
5. **Cancelling:** a `cancel` operation taking a request `id`, honoured between batch entries and by long reads.
6. **Continuation:** history, alarm and search results return an opaque `next` token when `truncated`.
7. **Back-pressure:** a `slow_consumer` notice before the server closes a session whose outbound queue is filling, plus a `resync_required` notice after COV coalescing drops events.
8. **Fresh reads and discovery:** `read` with `fresh: true` subscribes briefly and waits for the first poll. `discover_devices` and `discover_points` wrap driver discovery (see the commissioning findings).

### Phase 2: central Authorizer

- Create `BaskStreamAuthorizer` with `canRead(object)`, `canWrite(object)`, `canInvoke(component, action)`, `canViewAlarm(record)`, `canAckAlarm(record)`, `canReadHistory(history)`, and a `summaryOrRedacted(related object)` helper.
- Move the Phase 0 checks and `BaskStreamAccessPolicy` behind it.
- Route every related object through it: parents, ancestors, device/network, extensions, history IDs, relation endpoints and hierarchy bindings (open item F17).
- Authorize the resolved target, not only the raw ORD string (the rest of F01). Reject remote or imported sources as local paths.
- Model editing: block creating or cloning the baskStream service, add a denylist for security, user and platform services, require `confirm: true` for confirm-required actions, and require admin write to clone anything that holds passwords.
- Revalidation also covers alarm and model subscriptions, and drops a subscription when its permission check throws.

Exit: tests with a restricted user show no data from unreadable objects in any response.

**Done 2026-09-25 (source, type-checked against N4.15.1.16 and 4.15.3.28; station test pending):**

- **2a:** `BaskStreamAuthorizer` holds every access check. Related objects are redacted, resolved browse targets are checked, and remote or imported sources are never treated as local (F01, F17).
- **2b:** protected services; no creating or copying of protected services or `program:` components; admin write to clone anything holding passwords; `confirm_required`.
- **2c:** revalidation covers alarm and model subscriptions. Points are dropped after two failed checks in a row.
- **2d:** `reverted: true` when a component undoes an edit. The permission limit is documented, and whether to request `NETWORK_COMMUNICATION` is decision 5.
- **2e:** history reads use the public `BIHistory` and `HistorySpaceConnection` API. There are no `com.tridium` imports left.
- `tests/typecheck.py` compiles all sources against an installed SDK, without building the module.

### Phase 3: event pipeline and resource budgets

- One outbound mailbox per session. Niagara callbacks enqueue records and return immediately; the drain does encoding and sending.
- Move alarm snapshot queries and point snapshots off callback threads.
- Make COV and alarm sequence numbers atomic and assign them in send order.
- Key model subscriptions by component handle, not slot path, so they survive rename and move.
- Add a response byte budget to browse, search, history and alarm reads, returning `truncated` instead of closing the socket.
- Alarm queries use source- and time-indexed calls instead of a full `scan()`.
- Per-user limit on model plans, and previews also gated by `modelEditsEnabled`.

Exit: a slow-client and burst test leaves other clients responsive, and metrics return to baseline after disconnect.

**Done 2026-09-28 (source, type-checked; station test pending):**

- `BaskStreamEventLane`: each session's event work runs in order on a two-thread shared pool. Niagara callbacks and the scheduler only hand over work. On backlog overflow, the backlog is dropped and a `resync_required` notice is sent.
- Point COV marks points changed and reads values at flush time. Alarm events (including snapshot-mode queries) and model notices run on the lane. The model fan-out after an apply is queued per session.
- COV and alarm sequence numbers are atomic and assigned in send order.
- Model subscriptions are keyed by component handle, and their read check uses the authorizer instead of re-resolving an ORD.
- Replies over 8 MiB return `response_too_large` instead of closing the session.
- Alarm reads stop after examining 50,000 records (`truncatedReason`).
- Previews need `modelEditsEnabled`, and each user may hold 8 open previews (the oldest is dropped first). A full ledger drops the oldest finished result first.
- Watchdog: a request running more than 10 minutes sends `request_timeout` and closes the session.
- Not done: a per-response byte budget that truncates browse or search results; the size error covers the failure case.

### Phase 4: split the session and isolate the transport

- Split `BaskStreamClientSession` into `SessionLifecycle`, `PointSubscriptions` (direct, groups, leases), `CovBatcher`, `AlarmStream` and `ModelStream`.
- Keep all Jetty and servlet types inside the transport adapter so nothing else imports them. This is the Niagara 5 swap point.
- Migrate `BBaskStreamService` fully to Slot-o-matic annotations and let it regenerate `module-include.xml`.

Exit: no class over about 600 lines, and Jetty imports appear only in the adapter.

**Done 2026-09-28 (source, type-checked; station test pending):**

- **4a:** `BaskStreamJettyTransport` holds the upgrade handshake, origin/header checks, connection limits and socket factory. Sessions use the `BaskStreamTransport` interface. Jetty and servlet imports appear only in `BaskStreamJettyTransport` and `BaskStreamJettyWebSocketConnection`.
- **4b:** `BaskStreamClientSession` (2,230 lines) is now about 600 lines of lifecycle, dispatch, watchdog, revalidation and send. The rest moved verbatim into:
  - `BaskStreamPointSubscriptions`: direct subscriptions, groups, leases, the point subscriber and point revalidation.
  - `BaskStreamCovBatcher`: pending changes, flush and COV send.
  - `BaskStreamAlarmStream` and `BaskStreamModelStream`.
  - `BaskStreamRequests`: single-reply handlers.
  - `BaskStreamCapabilities`.

  A method-by-method comparison against the pre-split source found no logic changes beyond qualification and the delegation edits.
- `BBaskStreamService` is already annotation-based: 19 `@NiagaraProperty` declarations, regenerated by Slot-o-matic on 2026-09-21.
- Remaining large classes (`BaskStreamBrowseResolver` at about 1,750 lines, plus the tag, model and write resolvers) are single-purpose resolvers. Splitting them is optional.

### Phase 5: clients

- Build the TypeScript SDK: connect/login, request/response matching, reconnect, lease renewal, typed errors, `truncated`/`changed` handling, and model plan helpers.
- Move the companion app to the SDK. The Grafana front end can use it too; the Go backend follows the spec.
- MCP: park it now (freeze it or move it to its own repository). Later, rebuild it as a thin layer over the SDK.
- Python: keep one small smoke-test script unless there is a Python audience.

### Phase 6: expansion (after Phases 1–3)

In rough value-for-effort order:

1. Server-side history rollups plus batch history reads with a continuation token.
2. Alarm filters (class, priority, ack state, time window, newest first) and ack by filter with a preview.
3. Per-integration client profiles: child components, each with its own path patterns and write/model switches.
4. Metrics as service slots, with an optional OpenMetrics endpoint.
5. A dry-run for batch point writes, using the model-plan preview/apply flow.
6. Schedule events and schedule editing.
7. Niagara audit-history integration.
8. A read-only REST/OpenAPI adapter, if a real consumer needs it.

## Findings from the live BACnet commissioning test (2026-09-25)

Using baskStream only, against a test station and the Python BACnet simulator (1 device, 617 objects), we created and configured a BACnet network, ran device and point discovery, created the device, and added all 617 proxy points in 47 equipment folders. The points were added in 8 preview/apply plans, in 3.4 s, with no failures. Live reads and a point write then worked.

What needs fixing (Phase 2–3 unless noted):

1. **Edits run with baskStream's Java permissions.** *(Phase 2d: documented and surfaced as `reverted`; the permission request is decision 5 below.)* Enabling a BACnet/IP port or setting its adapter made the driver open a socket on baskStream's thread. The security manager denied it (`SocketPermission ... listen`) and the driver silently reset the setting. The same edit works in Workbench. Run mutations on a Niagara-owned thread, or through a path that does not put baskStream's protection domain on the stack.
2. **Silent reverts are reported as applied.** *(Fixed in Phase 2d: property results and steps carry `reverted: true`.)* After apply, read each value back and flag any mismatch (`reverted: true`) instead of reporting success.
3. **Device discovery results are not readable.** `submitDeviceManagerJob` runs, but the found devices are not exposed as slots. Point discovery results are readable (`dc0…dcN` `bacnet:DiscoveryPoint` slots on the job). A dedicated `discover_devices`/`discover_points` operation should wrap both.
4. **`read` on an unsubscribed proxy point returns stale data.** Add an option that subscribes briefly and waits for the first poll ("fresh read").
5. **Write replies can show the pre-write value.** The 150 ms settle delay is shorter than a BACnet poll. Return a "pending" state, or wait for the next value change with a timeout.
6. **The plan limit is tight for commissioning.** Trial previews and batched imports each use one of the 32 station-wide plans. Add a per-user limit, cancel previews automatically when a plan is applied, or allow larger commissioning plans.
7. **Sessions expire overnight.** Clients (SDK, CLI) need automatic re-login using a stored credential.
8. **Model edits are not saved to disk.** Changes live in memory until the station saves. Offer a gated `save_station` step, or document that Workbench save or the auto-save interval is required.

9. **Loading `program:` types hung the session worker (found 2026-09-26, fixed in source).**
   - **Symptom:** on the Phase 2 build, a `preview_model_changes` that creates `program:Program` never replied, and neither did anything after it on that connection. Then every create, update or invoke preview hung too.
   - **Cause:** `Sys.getType` for `program:` types never returned when called from the session worker. The Phase 2b protected-service check looked up every protected type name, including `program:ProgramService`, for each ordinary edit.
   - **Fix:** the check now walks the component's own, already-loaded superclass chain and compares names. Requested and client-supplied type names are refused by name before any `Sys.getType`: `protectedSpec` for creates, and `requireLoadable` in `describe_component_types` and typed values.
   - **Verification:** the stand-in `Sys.getType` throws for protected names and `program:` types, and all tests pass. Station check pending on the next build.
   - **Operational note:** workers that were already stuck stay stuck until the station restarts. A per-request watchdog is part of Phase 3.

Environment notes: when the simulator ran on the Mac and the station in a Parallels VM, BACnet needed the adapter set in Workbench (see 1). We also added inbound and outbound Windows firewall rules for UDP 47808; it is not confirmed whether they were needed.

## Findings from the first live CLI run (2026-09-28)

- **`read_alarms` with `order: "newest"` repeated one alarm.** Symptom: every row had the same UUID. Cause: the alarm database cursor reuses one `BAlarmRecord` instance per `get()`, and the newest-first window stored references. Fix: store `record.newCopy()` (`BaskStreamAlarmResolver`). Verified: type-checks against 4.15.3.28; live check pending the next module build. Oldest-first reads were never affected because they convert each record immediately.
- **Browse/search return `local:|station:|slot:/…` ORDs, but point, history and schedule operations accept only `slot:/…`.** The SDK now reduces ORDs with `toSlotOrd` before those calls. Verified live with `bask read` on a full ORD.
- Stations report alarm `sourceState`/`ackState` capitalised (`Normal`, `Unacked`), and `msgText` may be an unresolved `%lexicon(module:key)%`; clients should compare case-insensitively.
- A point snapshot's `ok: false` means a non-ok status (e.g. `{stale}`); it is an error entry only when `code` is present.

## Housekeeping to fold in along the way

- Stop tracking the stale root `baskStream-rt.jar` and add `*.jar` to `.gitignore`. Publish releases with a checksum and a version.
- Bump `vendorVersion` with each release so stations can tell builds apart.
- Decide whether `writesEnabled` should default to `false`. This is safer, but existing clients need a heads-up.
- Move dated handoff notes out of the public `docs/` folder (for example to `docs/history/`).
- Add Niagara `srcTest` tests where the stub harness cannot reach, such as service lifecycle and slot defaults.

## Decisions needed from you

1. Park the MCP server in this repo, or move it to its own repo?
2. Target date for Niagara 5 support. This decides whether Phase 4 moves ahead of Phase 3.
3. Should the default for `writesEnabled` become `false`?
4. Add an optional JSON wire mode alongside MessagePack?
5. Should baskStream request Niagara's `NETWORK_COMMUNICATION` permission so model edits can reconfigure driver network ports? It can be scoped by host and port and marked optional, so the station admin approves it at install. A narrow grant (BACnet/IP 47808, for example) fixes only that driver; a general grant gives baskStream broad network rights it does not otherwise need. Until decided, such edits report `reverted` and must be made in Workbench.
