# baskStream Third-Party API Guide

baskStream exposes station data over an authenticated WebSocket endpoint using MessagePack frames. It is intended to give external applications a faster live-data path than polling Niagara REST, while still preserving Niagara's native object model, permissions, point status, alarms, schedules, and histories.

This project is not affiliated with, endorsed by, or sponsored by Tridium or Honeywell. Use the API only with Niagara stations and licenses you are authorized to access. Do not use this API work to reverse engineer, decompile, modify, or reproduce Niagara Framework internals, license files, proprietary documentation, or confidential security/performance information.

## Connection Model

- Health check: `GET /stream/health`
- WebSocket endpoint: `/stream`
- Transport: `wss://<station>/stream`
- Encoding: MessagePack maps
- Service path: the BASkStreamService `servletName` property must be `stream`; blank values are defaulted to `stream` on startup.
- Authentication: the WebSocket runs inside the authenticated Niagara web session. Browser-based clients can reuse the logged-in station session; service clients should perform Niagara login first and then connect with the session cookies.
- Optional header auth (CSWSH hardening): when the service property `requireAuthorizationHeader` is `true`, the handshake is rejected (HTTP 403) unless it carries an `Authorization` header. This defeats cookie-riding cross-site hijacks because a browser cannot set request headers on a WebSocket handshake. Default is `false`, so cookie-authenticated clients keep working unchanged. Clients that can set handshake headers (e.g. a desktop/Electron client) should send `Authorization` so the deployment can then enable this flag.
- Origin policy: browser WebSocket requests must come from the station origin or an exact origin listed in the service `allowedOrigins` property. Service clients that do not send an `Origin` header are allowed after Niagara authentication, unless the service property `rejectMissingOrigin` is `true` (default `false`).
- Path policy: `allowedPathPatterns` defaults to `slot:/*`. An empty value preserves that established wide-open behavior; Niagara user permissions still apply to every resolved target. Configure narrower `slot:/...` patterns when an integration should be confined to part of the station.
- Optional session revalidation: `revalidateIntervalSec` defaults to `0` (disabled) so existing long-lived clients retain their established connection behavior. When an administrator sets a positive interval, the server periodically checks that the connected user is still present and that each active subscription is still readable, trimming or tearing down as needed. See "Server-Initiated Notices" below.

Every request frame should include:

```json
{
  "op": "ping",
  "id": "client-request-id"
}
```

Responses echo `id` when the operation is request/response based. Push frames such as `cov` and `alarm_cov` do not require a request id.

### Server-Initiated Notices

These unsolicited frames have no `id`. Clients should tolerate (and may act on) them; unknown ops can be safely ignored.

- `subscriptions_revoked` — emitted when periodic revalidation (`revalidateIntervalSec` above `0`) finds that the connected user can no longer see one or more active subscriptions: a permission or category change, a narrowed `allowedPathPatterns`, or a subscribed component that was deleted. Shape: `{ "op": "subscriptions_revoked", "points": ["slot:/..."], "alarmSubscriptions": ["<source>|<scope>|<limit>|<mode>"], "modelSubscriptions": ["slot:/..."], "reason": "authorization_revoked" }`. The listed subscriptions have already been dropped server-side; a client that still needs them must subscribe again (and will be re-checked). A point whose check fails because it cannot be resolved is dropped only after failing two sweeps in a row, so a brief glitch does not remove it. `alarmSubscriptions` and `modelSubscriptions` were added on 2026-09-25; older clients can ignore them.
- `resync_required` — the session's event backlog overflowed (a client that reads too slowly, or a burst of changes), so queued events were dropped. Shape: `{ "op": "resync_required", "reason": "event_backlog", "droppedEvents": 1000, "timestamp": ... }`. Re-read whatever the client shows (`read`, `read_alarms`, `browse`); COV continues normally afterwards. Added 2026-09-28.
- `request_timeout` — a request has been running for more than 10 minutes. Shape: `{ "op": "request_timeout", "requestOp": "write", "elapsedMillis": 600000 }`. The server closes the session (close code `1011`) right after. Split very large batches. Added 2026-09-28.
- `session_revoked` — emitted just before the server closes the socket (close code `1008`) because the connected user is no longer present in the station. Shape: `{ "op": "session_revoked", "reason": "<text>" }`. Clients should re-authenticate before reconnecting.

### Audit trail

Changes made through baskStream are recorded in the station's audit history under the connected user:

- Point writes, alarm acknowledge and force-clear, and model-edit changes use the user's Niagara context, so Niagara audits them itself as property changes and invoked actions. baskStream does not add duplicate records for them.
- Schedule edits (`write_schedule`) are applied with Niagara's `auditableCopyFrom`, which audits them.
- Tag and relation edits (`write_tags`, `write_relations`) go through Niagara APIs that do not audit, so baskStream records them itself: tag set as `Changed`, tag removal and relation removal as `Removed`, relation add as `Added`. The slot is `tag:<id>` or `relation:<id>`.
- Connect, disconnect, rejected upgrades, timeouts and model plans are also written to the station log with the `AUDIT baskStream` prefix.

### Metrics

`GET https://<station>/stream/metrics` (after station login, like `/stream/health`) returns counters since the service started, in Prometheus/OpenMetrics text format:

```text
baskstream_requests_total 1523
baskstream_errors_total 12
baskstream_write_requests_total 40
baskstream_resyncs_total 0
baskstream_request_timeouts_total 0
baskstream_active_connections 3
baskstream_subscriptions 212
```

The same counters appear as read-only properties on the BASkStreamService (`requestCount`, `errorCount`, `writeRequestCount`, `resyncCount`, `requestTimeoutCount`), updated every 15 seconds. They reset when the service restarts.

## Supported Operations

API 1.6 also provides the [station model editing API](MODEL_EDITING_API.md): component/type inspection, component and hierarchy editing, dynamic slots, links, generic actions, preview/apply, plan status and cancellation. That reference includes the complete action schema and partial-result contract.

The station-side `writesEnabled` switch disables **all** mutations, including the existing point, tag/relation, and alarm operations documented below. Reads and subscriptions stay available. It defaults to true for compatibility; new model-plan application additionally requires `modelEditsEnabled=true` (default false). Both states are advertised by health/capabilities.

### `ping`

Request:

```json
{ "op": "ping", "id": "1" }
```

Response:

```json
{ "op": "pong", "id": "1" }
```

### `capabilities`

Returns API version, supported operations, limits, schema versions, and live subscription types. Call this after connecting so an external app can adapt to the deployed module version.

```json
{ "op": "capabilities", "id": "caps-1" }
```

Response:

```json
{
  "op": "capabilities_result",
  "id": "caps-1",
  "capabilities": {
    "apiVersion": "1.6",
    "operations": ["ping", "capabilities", "browse", "describe", "search", "read", "subscribe", "unsubscribe", "replace_subscriptions", "renew_subscriptions", "release_subscriptions", "subscription_status", "write", "describe_write", "read_history", "describe_history", "read_alarms", "ack_alarm", "ack_alarms", "clear_alarm", "clear_alarms", "subscribe_alarms", "unsubscribe_alarms", "read_schedule", "subscribe_model", "unsubscribe_model", "read_tags", "write_tags", "write_relations", "describe_component_types", "describe_component", "preview_model_changes", "apply_model_changes", "model_plan_status", "cancel_model_plan", "create_components", "update_component_properties", "rename_component", "move_components", "delete_components", "create_hierarchy", "configure_hierarchy"],
    "writesEnabled": true,
    "modelEditing": { "enabled": false, "maxChanges": 100, "previewRequired": true, "atomic": false },
    "limits": {
      "maxConnectionsPerUser": 0,
      "maxMessageBytes": 1048576,
      "maxSubscriptionsPerClient": 500,
      "maxLivePointsPerStream": 500,
      "maxPointSnapshotPoints": 1000,
      "heartbeatIntervalSec": 30,
      "subscriptionLeaseSec": 300,
      "covBatchWindowMillis": 100,
      "defaultBrowseDepth": 1,
      "maxBrowseDepth": 4,
      "defaultSearchDepth": 32,
      "maxSearchDepth": 64,
      "defaultSearchLimit": 500,
      "maxSearchLimit": 5000,
      "defaultSearchMaxVisited": 50000,
      "maxSearchMaxVisited": 200000,
      "defaultSearchTimeoutMillis": 5000,
      "maxSearchTimeoutMillis": 30000
    },
    "subscriptions": {
      "pointCov": true,
      "pointCovBatching": true,
      "viewGroups": true,
      "leasedGroups": true,
      "sharedStationSubscriptions": false,
      "alarmEvents": true,
      "modelEvents": true,
      "historyLive": false,
      "scheduleLive": false
    },
    "pointSnapshot": {
      "operation": "read",
      "batch": true,
      "facets": true,
      "fieldSelection": true,
      "maxPoints": 1000,
      "fields": ["point", "ok", "display", "type", "valueType", "value", "displayValue", "status", "timestamp", "facets", "enumOrdinal", "enumTag", "enumDisplay", "enumOptions"]
    },
    "graphics": {
      "plainPx": false,
      "plainGraphic": false
    }
  }
}
```

### `browse`

Returns a station tree node and, when `depth` is greater than zero, child nodes.

By default, `browse` omits the `metadata` block so large station traversals stay light. Request metadata only during discovery or refresh passes.

```json
{
  "op": "browse",
  "id": "2",
  "base": "slot:/Drivers",
  "depth": 2,
  "metadata": "full"
}
```

Response:

```json
{
  "op": "browse_result",
  "id": "2",
  "depth": 2,
  "metadata": "full",
  "node": {
    "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01",
    "slotPath": "slot:/Drivers/LonNetwork/Floor1/AHU_01",
    "name": "AHU_01",
    "display": "AHU-01",
    "description": "lonworks:LonDevice",
    "typeSpec": "lonworks:LonDevice",
    "status": "{ok}",
    "ok": true,
    "kind": "container",
    "hasChildren": true,
    "writable": false,
    "features": [],
    "operations": ["describe", "browse"],
    "metadata": {
      "classification": {
        "isDriverDevice": true,
        "equipmentCertainty": "device"
      }
    }
  }
}
```

Lean repeat browse:

```json
{
  "op": "browse",
  "id": "2b",
  "base": "slot:/Drivers/LonNetwork",
  "depth": 1,
  "metadata": "none"
}
```

`metadata` also accepts booleans: `true` is the same as `"full"`, and `false` is the same as `"none"`.

`depth` is clamped by the station service. Clients should use shallow browse calls and drill in as needed rather than requesting broad deep station traversals.

`browse`, `describe`, and `search` also accept Niagara hierarchy ORDs (`hierarchy:`). This is the tagged/grouped tree from HierarchyService, not the raw station slot tree. Use it after tagging equipment with Haystack or other dictionaries — it does not replace `read_tags`/`write_tags`. Grouping nodes often have a `hierarchy:` `ord` and a null `slotPath`. When the node binds to a station component, the response also includes additive `entityOrd`, `targetOrd`, and `targetSlotPath` so tag writes can target the real component. Existing `slot:/` browse/search behavior is unchanged.

```json
{
  "op": "browse",
  "id": "2c",
  "base": "hierarchy:",
  "depth": 1
}
```

### `describe`

Returns the same node shape as `browse`, without children. Use this for precise metadata on a single ORD. `describe` includes metadata by default because it returns only one node; set `"metadata": "none"` or `false` if the client only needs the structural fields.

```json
{
  "op": "describe",
  "id": "3",
  "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/TestEnum"
}
```

### `search`

Searches within a guarded station branch and returns matching shallow node objects. Use this for raw station search, discovery shortcuts, writable point lookup, history-capable points, or schedules under a branch. Search uses its own traversal limits and is not bounded by the shallow browse-depth limit.

```json
{
  "op": "search",
  "id": "3b",
  "base": "slot:/Drivers",
  "depth": 32,
  "query": "temp",
  "features": ["point"],
  "operations": ["read"],
  "metadata": "none",
  "limit": 250,
  "maxVisited": 50000,
  "timeoutMillis": 5000
}
```

`depth` is search-specific. Clients may also send `maxDepth`; when both are present, `maxDepth` wins. `maxVisited`, `limit`, and `timeoutMillis` are capped by the values reported from `capabilities`.

Response:

```json
{
  "op": "search_result",
  "id": "3b",
  "result": {
    "base": "slot:/Drivers",
    "depth": 32,
    "limit": 250,
    "maxVisited": 50000,
    "timeoutMillis": 5000,
    "visited": 1200,
    "count": 12,
    "truncated": false,
    "truncatedReasons": [],
    "nodes": []
  }
}
```

When traversal stops early, `truncated` is `true` and `truncatedReasons` may include `"limit"`, `"depth"`, `"visited"`, or `"timeout"`.

### `read`

Reads one or more point/value ORDs. This is the batch point snapshot operation; it does not perform a full component `describe` or `browse` for each point.

```json
{
  "op": "read",
  "id": "4",
  "points": [
    "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp",
    "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/FanCmd"
  ]
}
```

Response:

```json
{
  "op": "read_result",
  "id": "4",
  "points": [
    {
      "point": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp",
      "display": "Space Temp",
      "valueType": "baja:Double",
      "value": 72.4,
      "displayValue": "72.4 °F",
      "status": "{ok}",
      "ok": true,
      "timestamp": 1779648232328,
      "facets": {
        "units": "°F",
        "precision": "1"
      }
    }
  ]
}
```

Use optional `fields` to trim successful point snapshots. The server always returns `point` and `ok`; partial error entries still include `point`, `ok`, `code`, and `message`.

```json
{
  "op": "read",
  "id": "4b",
  "points": [
    "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp"
  ],
  "fields": ["value", "displayValue", "status", "facets", "timestamp", "type"]
}
```

Supported fields are advertised by `capabilities.pointSnapshot.fields`. `type` is a field-selection alias for the existing `valueType` string. The maximum `read.points` count is configurable and advertised as `capabilities.limits.maxPointSnapshotPoints`.

Enum and Boolean values include enum metadata when available:

```json
{
  "valueType": "baja:DynamicEnum",
  "value": "Off",
  "displayValue": "Off",
  "enumOrdinal": 0,
  "enumTag": "Off",
  "enumDisplay": "Off",
  "enumOptions": [
    { "ordinal": 0, "tag": "Off", "display": "Off" },
    { "ordinal": 1, "tag": "On", "display": "On" },
    { "ordinal": 2, "tag": "Auto", "display": "Auto" }
  ]
}
```

### `subscribe` and `unsubscribe`

Subscribes to point COV updates. Point subscription frames are value/status oriented and do not include node metadata.

```json
{
  "op": "subscribe",
  "id": "5",
  "points": [
    "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp"
  ]
}
```

Initial response:

```json
{
  "op": "subscribed",
  "id": "5",
  "points": [ { "point": "...", "value": 72.4, "status": "{ok}" } ]
}
```

Push frame:

```json
{
  "op": "cov",
  "sequence": 42,
  "timestamp": 1779648232328,
  "batched": true,
  "sourceEvents": 3,
  "points": [
    { "point": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp", "value": 72.5 }
  ]
}
```

Unsubscribe:

```json
{
  "op": "unsubscribe",
  "points": [
    "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp"
  ]
}
```

### View-Scoped Subscriptions

For graphics and other UI views, prefer grouped subscriptions over manual subscribe/unsubscribe churn. A group is the client's current desired point list for one screen or widget. `replace_subscriptions` diffs the group server-side, subscribes newly needed points, releases points no longer referenced by any direct subscription or group, and returns current snapshots immediately.

```json
{
  "op": "replace_subscriptions",
  "id": "view-1",
  "group": "graphic:ahu-01",
  "points": [
    "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp",
    "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/FanCmd"
  ],
  "leaseSec": 300
}
```

Response:

```json
{
  "op": "subscriptions_replaced",
  "id": "view-1",
  "group": "graphic:ahu-01",
  "points": [
    { "point": ".../SpaceTemp", "value": 72.4, "status": "{ok}" }
  ],
  "added": 2,
  "removed": 0,
  "leaseSec": 300,
  "leaseExpiresAt": 1779648532328,
  "pointSubscriptions": 2,
  "subscriptionGroups": 1
}
```

Use `renew_subscriptions` to extend a view lease if the view stays open:

```json
{
  "op": "renew_subscriptions",
  "id": "view-1-renew",
  "group": "graphic:ahu-01",
  "leaseSec": 300
}
```

Use `release_subscriptions` when the view closes:

```json
{
  "op": "release_subscriptions",
  "id": "view-1-close",
  "group": "graphic:ahu-01"
}
```

If the client crashes or navigates without releasing the group, the lease expires and the server releases points that are not referenced by another group or direct subscription. A lease of `0` disables expiration for that group.

For diagnostics:

```json
{
  "op": "subscription_status",
  "id": "subs-1",
  "includePoints": true
}
```

Response:

```json
{
  "op": "subscription_status_result",
  "id": "subs-1",
  "session": {
    "pointSubscriptions": 120,
    "directPointSubscriptions": 0,
    "subscriptionGroups": 3,
    "alarmSubscriptions": 1,
    "modelSubscriptions": 0,
    "pendingCovPoints": 4
  },
  "groups": [
    {
      "group": "graphic:ahu-01",
      "pointCount": 42,
      "leaseSec": 300,
      "ttlSec": 251
    }
  ]
}
```

The older `subscribe` and `unsubscribe` operations remain useful for simple clients and long-lived manual point watches. They are connection-scoped and are removed automatically when the WebSocket closes.

### `subscription_status`

Reports this connection's subscriptions: counts by kind, pending COV work, the limits in force, and a summary of each subscription group. Pass `includePoints: true` to list each group's points.

```json
{ "op": "subscription_status", "id": "5b", "includePoints": false }
```

Response:

```json
{
  "op": "subscription_status_result",
  "id": "5b",
  "session": { "id": "...", "user": "operator", "pointSubscriptions": 42, "directPointSubscriptions": 2, "alarmSubscriptions": 1, "modelSubscriptions": 0, "subscriptionGroups": 1, "pendingCovPoints": 0, "pendingCovSourceEvents": 0 },
  "limits": { "maxSubscriptionsPerClient": 500, "subscriptionLeaseSec": 300, "covBatchWindowMillis": 100 },
  "groups": []
}
```

### `write`

Writes to Niagara writable points.

Supported actions:

- `set`: set fallback
- `override`: level 8 override, optional `durationSec`
- `auto`: release level 8
- `emergency_override`: level 1 override
- `emergency_auto`: release level 1

```json
{
  "op": "write",
  "id": "6",
  "point": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/FanCmd",
  "action": "override",
  "value": true,
  "durationSec": 300
}
```

Response:

```json
{
  "op": "write_result",
  "id": "6",
  "points": [
    {
      "point": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/FanCmd",
      "action": "override",
      "activeLevel": "8",
      "value": true,
      "status": "{overridden} @ 8"
    }
  ]
}
```

If a higher priority input is active, a lower priority write can succeed without changing the output. Clients should inspect `activeLevel`, `status`, and the returned value.

Each action is checked against the user's invoke permission for that action slot, not just the point. Operator actions need operator invoke. Admin-only actions, which usually include the emergency actions, need admin invoke. A refused action returns a per-point `forbidden_action` entry.

### `describe_write`

Returns write capabilities without writing. Use this before rendering set/override/auto controls.

```json
{
  "op": "describe_write",
  "id": "6b",
  "points": [
    "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/FanCmd"
  ]
}
```

Response:

```json
{
  "op": "write_description",
  "id": "6b",
  "points": [
    {
      "point": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/FanCmd",
      "writable": true,
      "valueKind": "boolean",
      "actions": ["set", "override", "auto", "emergency_override", "emergency_auto"],
      "supportsDuration": true,
      "fallback": { "value": false, "status": "{ok}" },
      "levels": []
    }
  ]
}
```

### `read_history`

Reads records for a history-capable point/history ORD.

```json
{
  "op": "read_history",
  "id": "7",
  "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp",
  "start": 1779043432000,
  "end": 1779648232000,
  "limit": 1000
}
```

### `describe_history`

Returns history descriptors and summary information without pulling records. Use this to decide whether to show chart/history UI and to choose sane default time windows.

```json
{
  "op": "describe_history",
  "id": "7b",
  "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp"
}
```

Response:

```json
{
  "op": "history_description",
  "id": "7b",
  "history": {
    "requestOrd": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SpaceTemp",
    "count": 1,
    "histories": [
      {
        "historyOrd": "history:/Station/SpaceTemp",
        "historyId": "Station/SpaceTemp",
        "recordType": "history:NumericTrendRecord",
        "totalCount": 12000,
        "firstTimestamp": 1779043432000,
        "lastTimestamp": 1779648232000,
        "config": {}
      }
    ]
  }
}
```

### `read_history_rollup`

Summarises history records into fixed-width time buckets, so a chart of a month at one-hour resolution needs about 720 rows instead of every record. It uses the same ORD rules and permission checks as `read_history`.

```json
{ "op": "read_history_rollup", "id": "r1", "ord": "slot:/Drivers/.../Space_Temp", "start": 1790000000000, "end": 1790086400000, "interval": 3600000 }
```

Response:

```json
{
  "op": "history_rollup_result",
  "id": "r1",
  "rollup": {
    "interval": 3600000,
    "histories": [
      {
        "historyId": "/Dev/Space_Temp",
        "buckets": [ { "start": 1790000000000, "count": 720, "min": 70.1, "max": 72.4, "sum": 51230.5, "avg": 71.15, "first": 70.2, "last": 71.9 } ],
        "bucketCount": 24, "examined": 17280, "skippedInvalid": 0, "truncated": false
      }
    ]
  }
}
```

- `interval` is required, in milliseconds (at least 1000). The range may produce at most 5,000 buckets.
- Numeric records aggregate directly. Boolean records count as 1/0, so `avg` is the fraction of time true. Enum and string records report `count`, `first` and `last` only.
- Records whose status is not valid (fault, down, stale, disabled, null) are skipped unless `includeInvalid: true`; `skippedInvalid` counts them. NaN values are ignored.
- Empty buckets are omitted. Each history examines at most 1,000,000 records or 20 seconds; if it stops early, `truncated` is true with `truncatedReason` `record_limit` or `time_limit`.

### `read_schedule`

Reads a Niagara schedule.

```json
{
  "op": "read_schedule",
  "id": "8",
  "ord": "slot:/Schedules/BooleanSchedule",
  "at": 1779648232000
}
```

### `read_schedule_events`

Lists when a schedule's output changes over a window: the output at `start`, then each time it may change, with the new output.

```json
{ "op": "read_schedule_events", "id": "s2", "ord": "slot:/Schedules/OfficeHours", "start": 1790000000000, "end": 1790604800000 }
```

Response: `{ "op": "schedule_events_result", "id": "s2", "schedule": { "events": [ { "time": 1790000000000, "value": { ... } }, ... ], "count": 11, "truncated": false } }`. The window defaults to 7 days and may be at most 366; `limit` defaults to 100 (max 1,000).

### `write_schedule`

Replaces the entries of the listed weekdays on a weekly schedule. Days you leave out are untouched. It requires `writesEnabled` and write permission on the schedule.

```json
{
  "op": "write_schedule", "id": "s3", "ord": "slot:/Schedules/OfficeHours", "dryRun": true,
  "days": {
    "monday":   [ { "start": "07:00", "finish": "18:00", "value": true } ],
    "saturday": []
  }
}
```

- Times are `"HH:MM"` or `"HH:MM:SS"`; `"24:00"` means the end of the day. Up to 48 entries per day; overlapping entries are rejected.
- `value` follows the schedule's output type: `true`/`false`, a number, an enum ordinal or tag, or a string.
- The reply lists `before` and `after` for each day. With `dryRun: true` nothing changes. Otherwise the edit is applied with Niagara's `auditableCopyFrom`, the same path its Scheduler uses, so it is recorded in the station's audit history.
- Special events are not edited by this operation.

### `read_alarms`

Reads a bounded alarm snapshot.

```json
{
  "op": "read_alarms",
  "id": "9",
  "scope": "open",
  "limit": 500
}
```

Common scopes:

- `open`
- `ack_pending`
- `all`

Optional `filter` narrows the read, and `order: "newest"` returns the most recent matches first:

```json
{
  "op": "read_alarms", "id": "9a", "scope": "all", "limit": 100, "order": "newest",
  "filter": { "alarmClass": ["hvacCritical"], "maxPriority": 100, "ackState": "unacked", "since": 1790000000000 }
}
```

`alarmClass` is a name or list of names. `minPriority`/`maxPriority` bound Niagara's priority number (lower is more urgent). `ackState` is `acked` or `unacked`. `since`/`until` are epoch milliseconds; with `scope: "all"` they use the alarm database's time index instead of a full scan. The reply echoes the `filter`.

Records are included only when the user has operator read permission on the record's alarm class. The same filter applies to `subscribe_alarms` snapshots and live `alarm_cov` events.

### `ack_alarm`

Acknowledges one or more alarm records by UUID through Niagara `BAlarmService.ackAlarm`. The authenticated Niagara user is used as the acknowledgement user.

```json
{
  "op": "ack_alarm",
  "id": "9b",
  "uuid": "594379d7-2d8d-4cef-a766-8097a09d52e0"
}
```

Batch form uses `ack_alarms` with `uuids`:

```json
{
  "op": "ack_alarms",
  "id": "9c",
  "uuids": [
    "594379d7-2d8d-4cef-a766-8097a09d52e0"
  ]
}
```

Optional `source` narrows the action to an expected alarm source ORD and is also used with `allowedPathPatterns` when the service is not wide open.

Acknowledging requires operator write permission on the record's alarm class. If the user cannot read the alarm class, the entry reports `invalid_alarm`, the same as a missing record. If the user can read it but lacks write permission, the entry reports `forbidden_alarm`. When writes are disabled, the whole request fails with `writes_disabled` before any record is looked up.

Response:

```json
{
  "op": "alarm_action_result",
  "id": "9b",
  "alarms": {
    "action": "ack_alarm",
    "count": 1,
    "alarms": [
      { "uuid": "...", "ok": true, "ackState": "acked" }
    ]
  }
}
```

### `clear_alarm`

Force-clears one or more alarm records by UUID. This is intentionally separate from acknowledgement: it audits the force-clear action, marks the local alarm record normal and acknowledged, and updates the alarm database. If the source is still actively in alarm, Niagara may generate or update an alarm again.

```json
{
  "op": "clear_alarm",
  "id": "9d",
  "uuid": "594379d7-2d8d-4cef-a766-8097a09d52e0"
}
```

Both `ack_alarms` and `clear_alarms` also accept a `filter` (same fields as `read_alarms`) instead of `uuids`, plus optional `scope` (default `open`), `limit` (default 500, max 5,000) and `dryRun`. A filter request finds the matching alarms first, then each one goes through the usual per-alarm checks. With `dryRun: true`, nothing changes and each entry reports `dryRun: true`, so a client can show "this will acknowledge 37 alarms" before doing it. The reply adds `matched`, `truncated` and the `filter`.

Batch form uses `clear_alarms` with `uuids`. Prefer `ack_alarm` for ordinary operator acknowledgement and reserve `clear_alarm` for explicit force-clear workflows. Force-clearing requires admin write permission on the record's alarm class; otherwise the entry reports `forbidden_alarm`.

### `subscribe_alarms`

Subscribes to alarm changes. The initial response always includes a bounded snapshot. Live pushes default to event mode so large stations do not resend all alarms on every transition.

```json
{
  "op": "subscribe_alarms",
  "id": "10",
  "source": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/TestPoint",
  "scope": "all",
  "mode": "event",
  "limit": 500
}
```

Initial response:

```json
{
  "op": "alarms_subscribed",
  "id": "10",
  "mode": "event",
  "alarms": { "count": 12, "alarms": [] }
}
```

Event-mode push:

```json
{
  "op": "alarm_cov",
  "sequence": 18,
  "timestamp": 1779648232328,
  "source": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/TestPoint",
  "scope": "all",
  "limit": 500,
  "mode": "event",
  "event": { "uuid": "..." },
  "inScope": true
}
```

Alarm modes:

- `event`: push only the changed event record.
- `snapshot`: push the bounded alarm snapshot each time.
- `both`: push both the changed event and the refreshed snapshot.

For large stations, use `event`, keep a client-side alarm map keyed by `uuid`, and call `read_alarms` only for initial load or resync.

### `unsubscribe_alarms`

Removes alarm subscriptions. With no `source`, `scope`, `limit` or `mode`, it removes every alarm subscription on the connection. With any of those fields, it removes the subscriptions whose filter matches. If `mode` is omitted from a filtered request, matching subscriptions are removed in every mode.

```json
{ "op": "unsubscribe_alarms", "id": "11", "scope": "all" }
```

Response (sent only when the request has an `id`):

```json
{ "op": "alarms_unsubscribed", "id": "11", "remaining": 0 }
```

### `subscribe_model` and `unsubscribe_model`

Subscribes to bounded component model-change hints. This is for station-structure changes such as added, removed, renamed, reordered, recategorized, flags/facets changes, and tag/relation changes on subscribed components. It is not a point-value subscription.

```json
{
  "op": "subscribe_model",
  "id": "model-1",
  "base": "slot:/Drivers",
  "depth": 2
}
```

Push frame:

```json
{
  "op": "model_cov",
  "sequence": 3,
  "timestamp": 1779648232328,
  "event": "property_added",
  "slot": "NewPoint",
  "source": {
    "slotPath": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points",
    "name": "points"
  },
  "refreshRecommended": true
}
```

Treat `model_cov` as a hint and refresh the affected branch with `browse` or `describe`. Keep model subscriptions scoped to branches the app has cached or is actively monitoring.

### `read_tags`

Reads Niagara tags and relations for one or more components. Tags are dictionary-neutral: Project Haystack tags (`hs:...`), Niagara tags (`n:...`), and site/hierarchy tag-dictionary tags are all returned and addressed by their qualified name. Requires read permission on each target.

```json
{
  "op": "read_tags",
  "id": "tags-1",
  "ords": ["slot:/Drivers/LonNetwork/Floor1/AHU_01"],
  "dictionary": "hs",
  "includeRelations": true
}
```

- `ords` (or a single `ord`): up to 100 `slot:/` targets per request.
- `dictionary` (optional): return only tags/relations in one dictionary, e.g. `"hs"` for Haystack or a station's hierarchy/site dictionary namespace.
- `includeRelations` (optional, default `true`).

Response:

```json
{
  "op": "tags_result",
  "id": "tags-1",
  "targets": [
    {
      "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01",
      "ok": true,
      "slotPath": "slot:/Drivers/LonNetwork/Floor1/AHU_01",
      "display": "AHU_01",
      "typeSpec": "lonworks:LonDevice",
      "tags": [
        { "id": "hs:equip", "dictionary": "hs", "name": "equip", "value": null, "valueType": "baja:Marker", "marker": true, "source": "direct" },
        { "id": "hs:ahu", "dictionary": "hs", "name": "ahu", "value": null, "valueType": "baja:Marker", "marker": true, "source": "implied" },
        { "id": "n:name", "dictionary": "n", "name": "name", "value": "AHU_01", "valueType": "baja:String", "marker": false, "source": "implied" }
      ],
      "relations": [
        { "id": "hs:siteRef", "dictionary": "hs", "name": "siteRef", "direction": "out", "endpointOrd": "slot:/Site", "source": "direct" }
      ]
    }
  ]
}
```

`source` is `"direct"` for tags/relations stored on the component, `"implied"` for tags/relations contributed by a tag dictionary (SmartTags), and `"unknown"` when the station's tag provider does not expose the split. Only direct tags/relations are writable.

### `write_tags`

Adds, updates, or removes direct tags on components. Requires admin write permission on each target (tag edits change the component model, matching Workbench semantics). Implied tags from tag dictionaries cannot be removed; attempting to do so returns `implied_tag` for that entry.

```json
{
  "op": "write_tags",
  "id": "tags-2",
  "targets": [
    {
      "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01",
      "set": [
        { "id": "hs:equip" },
        { "id": "hs:ahu" },
        { "id": "hs:area", "value": 5200.0 },
        { "id": "myDict:floorName", "value": "Level 1" }
      ],
      "remove": ["hs:stage"]
    }
  ]
}
```

- A single target can also be written without the `targets` wrapper by putting `ord`, `set`, and `remove` at the top level.
- `set` entries: `id` is the qualified tag name; `value` omitted or `null` writes a Haystack-style marker tag; boolean/number/string values map to Niagara boolean/double/string tag values. Pass `valueType` (`"marker"`, `"string"`, `"boolean"`, `"double"`, `"long"`) to force a specific value type — numbers default to double to match Niagara's Haystack number tags.
- `remove` entries: qualified tag names; removal drops every direct value stored under that id.
- Limits: 100 targets per request, 100 set/remove operations per target.

Response `tags_written` echoes per-operation results and the target's full post-write tag list:

```json
{
  "op": "tags_written",
  "id": "tags-2",
  "targets": [
    {
      "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01",
      "ok": true,
      "results": [
        { "op": "set", "id": "hs:equip", "ok": true },
        { "op": "remove", "id": "hs:stage", "ok": false, "code": "tag_not_found", "message": "No direct tag with this id exists on the component." }
      ],
      "tags": []
    }
  ]
}
```

### `write_relations`

Adds or removes direct relations between components — this is how Haystack reference tags (`hs:siteRef`, `hs:equipRef`, `hs:spaceRef`) and hierarchy/site relations are modeled in Niagara. Requires admin write permission on the target component and read permission on each endpoint.

```json
{
  "op": "write_relations",
  "id": "rel-1",
  "targets": [
    {
      "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points/SupplyTemp",
      "add": [
        { "id": "hs:equipRef", "endpoint": "slot:/Drivers/LonNetwork/Floor1/AHU_01" }
      ],
      "remove": [
        { "id": "hs:siteRef", "endpoint": "slot:/OldSite" }
      ]
    }
  ]
}
```

- `add` entries: `id` (qualified relation name) and `endpoint` (`slot:/` ORD). Relations are outbound from the target by default; pass `"inbound": true` to reverse the direction.
- `remove` entries: `id` required; `endpoint` and `direction` (`"in"`/`"out"`) optionally narrow the match. Without them, every direct relation with that id is removed.
- Same limits as `write_tags`: 100 targets per request, 100 operations per target.

Response `relations_written` echoes per-operation results (including a `removed` count for removals) and the target's post-write relation list.

Tag and relation writes on subscribed model branches surface to other clients as `model_cov` hints (`facets_changed`, `relation_added`, `relation_removed`), so apps that maintain a cached model can refresh affected nodes.

## Error Codes

Failures arrive in two ways. A **request** error fails the whole request with an `error` message carrying `code` and `message`. An **entry** error appears inside a batch result (per point, alarm, tag target and so on) with `ok: false`, while the other entries still succeed. Clients should branch on `code`, never on `message`. This table is generated from `spec/baskstream-protocol.json`.

| Code | Scope | Meaning |
| --- | --- | --- |
| `alarm_failed` | request | AlarmService unavailable or alarm database/read failure; also a per-uuid entry for unexpected ack/clear failures. |
| `auth_required` | request | No authenticated Niagara user at the WebSocket handshake; the socket is closed (1008), no frame is sent. |
| `bad_reference` | request | Model @ref does not identify an earlier create/clone, or a ref is duplicated. |
| `bad_request` | request | Malformed request or field (type, range, missing field, MessagePack decoding); also per-item in write/tag results. |
| `browse_failed` | request | Unexpected failure resolving a browse/describe target. |
| `children_present` | request | Deleting a component with children requires recursive=true. |
| `confirm_required` | request | The model plan invokes an action Niagara marks confirm-required; resend the change with confirm: true. |
| `cycle` | request | Cannot move a component into its own subtree. |
| `forbidden_action` | entry | User cannot invoke the write action slot on the point; also request-level for model invoke without invoke+admin-write. |
| `forbidden_alarm` | entry | Missing operator write (ack) or admin write (force-clear) on the alarm class. |
| `forbidden_component` | request | Model target outside allowedPathPatterns, unreadable, or lacking admin write. |
| `forbidden_point` | request | Target outside allowedPathPatterns or not readable/invokable/admin-writable; also per-item in read/subscribe/write/tag/alarm results. |
| `frozen_slot` | request | Only dynamic child components/properties can be moved, renamed, deleted or removed. |
| `group_not_found` | request | Subscription group does not exist. |
| `history_failed` | request | History lookup/query failed or the point has no readable history extensions. |
| `idempotency_conflict` | request | Plan already submitted with another key, or the key belongs to another plan. |
| `illegal_parent` | request | Niagara rejected this parent/child type combination. |
| `implied_tag` | entry | Tag is implied by a tag dictionary and cannot be removed. |
| `internal_error` | request | Unhandled server exception while processing the request. |
| `invalid_action` | request | Model invoke names an action slot that does not exist. |
| `invalid_alarm` | entry | Alarm record not found or not readable. |
| `invalid_component` | request | Model ORD does not resolve to a component/struct, or configure_hierarchy target is not hierarchy:Hierarchy. |
| `invalid_link` | request | Niagara link check failed, or delete_link slot does not hold a link. |
| `invalid_name` | request | Not a valid Niagara slot name (1-128 chars). |
| `invalid_point` | request | Blank/unsupported ORD scheme, unresolvable target or wrong target kind; also per-item in read/subscribe/write/tag results. |
| `invalid_property` | request | Property path does not exist, crosses a scalar, is empty, or addresses a link/relation. |
| `invalid_slot` | request | Named slot does not exist. |
| `invalid_type` | request | Unknown, abstract, incompatible, link/relation or unrepresentable type for a model value/component. |
| `invalid_value` | request | Encoded value was not understood by the type's decoder (would be stored as null). |
| `model_busy` | request | Another model plan is currently applying. |
| `model_change_failed` | entry | Non-protocol exception during a model apply step; outcome unknown_or_partial. |
| `model_edits_disabled` | request | modelEditsEnabled is false on the service; also a step result if flipped mid-apply. |
| `model_limit` | request | Model size bounds exceeded (slots, branch, snapshot, nesting, preview size, dependencies). |
| `name_conflict` | request | Slot name already exists (collision=fail) or no suffix could be allocated. |
| `not_writable` | entry | Target is not a Niagara writable point or its type is unsupported. |
| `plan_closed` | request | Plan is not in preview state (cannot apply or cancel). |
| `plan_conflict` | request | Overlapping property or structural edits in one plan; use separate previews. |
| `plan_dependency` | request | Change depends on a branch moved/renamed/deleted/created earlier in the same plan. |
| `plan_limit` | request | Plan ledger is full (32 plans). |
| `plan_mismatch` | request | planHash does not match the stored plan. |
| `plan_not_found` | request | Plan unknown, expired, or owned by another user. |
| `protected_component` | request | The baskStream service and its descendants cannot be edited remotely. |
| `read_failed` | entry | Point snapshot could not be produced or the target is no longer available. |
| `readonly` | request | Property is read-only. |
| `relation_failed` | entry | Unexpected failure adding/removing a relation. |
| `relation_not_found` | entry | No matching direct relation to remove. |
| `relation_rejected` | entry | Niagara rejected the relation add. |
| `response_too_large` | request | The reply would exceed the 8 MiB outbound limit; request less (smaller depth, limit, time range or field list). The session stays open. |
| `schedule_failed` | request | Unexpected failure resolving/reading a schedule. |
| `search_failed` | request | Unexpected failure resolving the search root. |
| `stale_plan` | request | Principal, target, property, slot or branch changed since preview; also a per-step apply result. |
| `subscription_limit` | request | maxSubscriptionsPerClient or group limit reached; per-point entry in subscribe/replace_subscriptions. |
| `tag_failed` | entry | Unexpected failure setting/removing a tag. |
| `tag_not_found` | entry | No direct tag with this id to remove. |
| `unknown_type` | request | describe_component_types baseType not found. |
| `unsupported_action` | entry | Write action unsupported by the point; also request-level for an unknown model action. |
| `unsupported_op` | request | Operation name is not in the protocol. |
| `write_cancelled` | entry | Session closed or thread interrupted before the write invocation. |
| `write_failed` | entry | Unexpected runtime failure writing a point, or enum point without an enum range. |
| `writes_disabled` | request | Service disabled or writesEnabled is false; also per-item if flipped mid-batch. |

## Node Metadata

`metadata` is attached to each node when requested. It is evidence for your application; it is not a universal equipment classifier.

Browse, search, and describe node objects include the underlying component `status` and boolean `ok` when Niagara exposes component status. That applies to devices, networks, point folders, equipment-like folders, and point nodes. Point `read`/subscription payloads also include `status` and `ok`, but those are value-status snapshots rather than structural node metadata.

Recommended flow:

1. Initial discovery: call shallow `browse` requests with `"metadata": "full"` where you need equipment/point evidence.
2. Live operation: use `read` and `replace_subscriptions` for view-scoped values; these responses stay value-only.
3. Structure refresh: optionally use `subscribe_model` for cached branches, then call `browse` or `describe` again with `"metadata": "full"` for the affected branch or object when a `model_cov` hint arrives.
4. Routine tree navigation: call `browse` with `"metadata": "none"` or omit the field.

Model events are branch-scoped hints, not a full synchronized station database. Apps should still support startup discovery, manual refresh, scheduled rediscovery, and app-observed mismatch refreshes.

```json
{
  "metadata": {
    "classification": {
      "isComponent": true,
      "isControlPoint": true,
      "isWritablePoint": true,
      "isStatusValue": true,
      "isDriverNetwork": false,
      "isDriverDevice": false,
      "isPointDeviceExt": false,
      "isPointExtension": false,
      "isProxyExt": false,
      "isProxyPoint": true,
      "isSchedule": false,
      "hasHistory": true,
      "hasAlarm": true,
      "isPoint": true,
      "equipmentCertainty": "unknown"
    },
    "parent": {
      "ord": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points",
      "slotPath": "slot:/Drivers/LonNetwork/Floor1/AHU_01/points",
      "name": "points",
      "display": "points",
      "typeSpec": "lonworks:LonPointDeviceExt",
      "status": "{ok}",
      "ok": true
    },
    "ancestors": [],
    "driver": {
      "isDriverBacked": true,
      "network": {},
      "device": {},
      "pointDeviceExt": {},
      "proxyExt": {},
      "proxyExtType": "lonworks:LonProxyExt",
      "deviceExtType": "lonworks:LonPointDeviceExt",
      "readWriteMode": "readWrite",
      "tuningPolicyName": "Default Policy",
      "deviceFacets": {}
    },
    "point": {
      "recognizedAsPoint": true,
      "writable": true,
      "facets": {},
      "hasProxyExt": true,
      "hasHistoryExt": true,
      "hasAlarmExt": true,
      "activeLevel": "def",
      "extensions": []
    },
    "write": {
      "writable": true,
      "valueKind": "boolean",
      "actions": ["set", "override", "auto"],
      "detailsOp": "describe_write"
    },
    "history": {
      "hasHistory": true,
      "count": 1,
      "detailsOp": "describe_history"
    },
    "alarm": {
      "hasAlarm": true,
      "snapshotOp": "read_alarms",
      "subscribeOp": "subscribe_alarms"
    },
    "subscriptions": {
      "pointCov": true,
      "alarmEvents": true,
      "historyReadOnDemand": true,
      "scheduleReadOnDemand": false
    },
    "facets": {},
    "tags": [],
    "relations": []
  }
}
```

### Classification Semantics

Use these flags as evidence:

- `classification.isDriverDevice`: the component is a Niagara driver `BDevice`. This is deterministic.
- `classification.isDriverNetwork`: the component is a Niagara driver network. This is deterministic.
- `classification.isControlPoint`: the component is a Niagara `BControlPoint`. This is deterministic.
- `classification.isProxyPoint`: the point has a driver proxy extension. This is strong evidence that it maps to an external protocol/device value.
- `classification.equipmentCertainty`: currently `"device"` only when the component is a `BDevice`; otherwise `"unknown"`.

Do not treat `"unknown"` as “not equipment.” It only means baskStream cannot prove that the component is equipment from type alone.

### Parent And Ancestors

- `metadata.parent` is the direct parent component.
- `metadata.ancestors` is the root-to-parent chain.
- Each summary contains `ord`, `slotPath`, `name`, `display`, `typeSpec`, `status`, and `ok` when a component is present.

This lets client applications preserve the station's structure and make their own grouping decisions.

### Driver Metadata

`metadata.driver` connects points back to Niagara driver structure when available:

- `network`: nearest or direct `BDeviceNetwork`.
- `device`: nearest or direct `BDevice`.
- `pointDeviceExt`: point container extension for driver proxy points.
- `proxyExt`: driver proxy extension on a control point.
- `proxyExtType`: protocol-specific proxy type.
- `deviceExtType`: protocol-specific point-device extension type.
- `readWriteMode`: proxy read/write mode when available.
- `tuningPolicyName`: driver tuning policy name when available.
- `deviceFacets`: facets reported by the proxy extension.

This is the best source for protocol-neutral device/point discovery across BACnet, Lon, Modbus, and other Niagara drivers.

The `network`, `device`, `pointDeviceExt`, and `proxyExt` summaries include component `status` and `ok` when present, so clients can show device/network health without first reading a child point.

### Point Metadata

`metadata.point` includes:

- whether baskStream recognized the node as a point
- whether it is writable
- point facets such as units, precision, range, or text labels when available
- proxy extension summary
- point extension summaries
- booleans for history and alarm extensions
- active priority level for writable points when available

Related blocks:

- `metadata.write`: compact write summary for graphics controls; use `describe_write` for full priority-array detail.
- `metadata.history`: attached history extensions and a pointer to `describe_history`.
- `metadata.alarm`: alarm-source summary and alarm snapshot/subscription operations.
- `metadata.subscriptions`: which live or on-demand flows make sense for the node.

### Tags And Relations

`metadata.tags` and `metadata.relations` expose Niagara tag/relation evidence when present. This is where Haystack-like modeling or project-specific semantic modeling can make equipment classification deterministic.

Tags and relations are supplemental. If a provider throws while reading tags or relations, browse/describe will still succeed and return an empty list for that portion.

For focused or batch tag access — and for editing tags and relations — use the dedicated `read_tags`, `write_tags`, and `write_relations` operations, which also report whether each tag is `direct` (stored on the component, writable) or `implied` (contributed by a tag dictionary, read-only).

## Equipment Discovery Guidance

baskStream intentionally does not claim 100% equipment detection.

Deterministic:

- A `BDevice` is a Niagara driver device.
- A `BControlPoint` is a Niagara control point.
- A point with `isProxyPoint` maps through a driver proxy extension.
- Tags/relations or a maintained mapping can confirm equipment if your station standard defines them.

Not deterministic:

- A folder named `AHU_01` may be equipment, a graphic grouping, a logic folder, or a convention.
- A driver device may represent one physical unit, a gateway, a controller serving multiple logical systems, or a virtual integration endpoint.
- A protocol network may organize points differently by vendor, station builder, or project.

Recommended client approach:

1. Treat driver devices and control/proxy points as type-guaranteed facts.
2. Treat tags/relations or a user-maintained mapping as confirmed equipment.
3. Use parent chain, driver ancestry, naming, facets, and point signatures for inferred equipment.
4. Present inferred equipment for manual review inside the app.
5. Store user review decisions so the next discovery pass becomes deterministic for that station.

## Suggested App-Side Confidence Levels

- `confirmed_device`: `metadata.classification.isDriverDevice === true`.
- `confirmed_point`: `metadata.classification.isControlPoint === true`.
- `confirmed_equipment`: station tags/relations or user mapping say it is equipment.
- `inferred_equipment_high`: folder or device has a strong point signature and consistent driver ancestry.
- `inferred_equipment_low`: name or location suggests equipment, but point signature is weak.
- `not_equipment`: user rejected it or it is a known organizational/support node.

## Compatibility Notes

The `metadata` block is additive and request-controlled. Clients can ignore it or omit it and continue using `ord`, `slotPath`, `name`, `typeSpec`, `features`, `operations`, and point read/write payloads.

Third-party clients should not require every metadata subfield to be populated. Different protocols and station models expose different evidence.

### Permission tightening (API 1.6 source, 2026-09-24)

These changes keep `apiVersion` at `1.6` and add no new fields. Clients that connect with a restricted Niagara user may now see less data or receive refusals where they previously succeeded:

- Alarm reads, subscriptions, and live events are filtered by operator read on the alarm class. Acknowledge needs operator write on the alarm class; force-clear needs admin write. New per-entry code: `forbidden_alarm`.
- Histories reached through a point (`slot:/` ORD) are omitted when the user cannot read the history itself.
- `write` checks invoke permission for each action slot. New per-point code: `forbidden_action`.
- Model editing rejects link and relation values in `add_slot`, `update`, and nested values. Use `create_link`/`delete_link` and `write_relations` instead.

### Event delivery and limits (2026-09-28)

These changes are additive, apart from the preview gate:

- Point COV values are read when a batch is sent, not when the change fires, so each point appears once per batch with its latest value. `covBatchWindowMillis: 0` still sends each change promptly (`batched: false`).
- COV, alarm and model notices are prepared on a per-session queue off Niagara's threads. Their `sequence` numbers are strictly increasing in send order.
- A reply that would exceed 8 MiB returns a `response_too_large` error for that request instead of closing the session.
- `read_alarms` and alarm snapshots stop after examining 50,000 records. `truncated: true` then comes with `truncatedReason: "examined_limit"`; a normal limit reports `"limit"`.
- Model subscriptions follow components through rename and move.
- Model previews (`preview_model_changes` and the convenience operations) now need `modelEditsEnabled`, like apply. Each user may hold 8 open previews.

### Redacted related objects (2026-09-25)

Metadata about objects related to the requested node is now checked against the same rules as the node itself: the user's Niagara read permission and `allowedPathPatterns`. When a related object fails that check, the response keeps its place but hides what it is:

- `parent`, `ancestors` entries, `driver.network`, `driver.device`, `driver.pointDeviceExt`, `driver.proxyExt`, history extension summaries and alarm sources become `{ "redacted": true }`.
- A history extension whose history the user cannot read keeps its summary but gains `historyRedacted: true` and omits `historyOrd`/`historyId`.
- A relation whose endpoint the user cannot read (in `browse`/`describe` metadata and in `read_tags`) keeps `id` and `direction`, gains `endpointRedacted: true` and omits the endpoint.
- A hierarchy node bound to a component the user cannot read gains `bindingRedacted: true` and omits `entityOrd`, `targetOrd` and `targetSlotPath`.
- Navigation children without an ORD are omitted, because they cannot be permission-checked.
- `browse`/`describe` also check where an ORD actually resolves, not only its text. Alarm and history sources on other stations are never treated as local paths.

Clients should tolerate `redacted` entries anywhere they read related-object summaries.

### API 1.5 changes

`apiVersion` advanced from `1.4` to `1.5`. The changes are additive:

- New operations `read_tags`, `write_tags`, and `write_relations` for reading and editing Niagara component tags and relations (Haystack `hs:` tags, Niagara `n:` tags, and hierarchy/site tag-dictionary tags and reference relations).
- New `capabilities.tags` block (`read`, `writeDirect`, `relations`, `impliedTagsReadOnly`, `maxTargetsPerRequest`) and `schemas.tags = "1"`.
- Tag/relation writes require admin write permission on the target component; reads require read permission. `allowedPathPatterns` applies to targets and relation endpoints.
- `browse`/`describe`/`search` accept `hierarchy:` ORDs in addition to `slot:/`. `capabilities.policy.slotBrowseOnly` stays `true` (slot-tree clients are unchanged); `hierarchyBrowse` is the additive flag. Hierarchy grouping nodes may include `entityOrd` / `targetOrd` / `targetSlotPath` when they bind to a station component. Component-backed hierarchy nodes are still filtered by `allowedPathPatterns` on their real slot path.

### API 1.4 changes

`apiVersion` advanced from `1.3` to `1.4`. The protocol changes are additive and the existing path, authentication, origin, and write-settle defaults remain compatible:

- New server→client notices `subscriptions_revoked` and `session_revoked` (additive; ignore if unhandled).
- New service properties: `requireAuthorizationHeader` (default `false`), `rejectMissingOrigin` (default `false`), `revalidateIntervalSec` (default `0` = disabled), `maxConnectionsPerUser` (default `0` = unlimited), `maxMessageBytes` (default `1048576`).
- `allowedPathPatterns` remains `slot:/*` by default, and an empty value retains the legacy wide-open fallback. Narrow it explicitly when a deployment needs an additional scope boundary beyond Niagara user permissions.
- Resource limits: inbound frames larger than `maxMessageBytes` cause the station to drop the connection (standard WebSocket message-too-big close). Keep batch requests within this size; it comfortably fits the documented per-request maximums at default. When `maxConnectionsPerUser > 0`, an upgrade beyond a single user's allowance is rejected (HTTP 503 pre-upgrade, or close `1013` if the limit is hit during the open handshake). The `capabilities` response advertises `maxConnectionsPerUser` and `maxMessageBytes` under `limits`.
