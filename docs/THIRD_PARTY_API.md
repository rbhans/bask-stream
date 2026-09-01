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

- `subscriptions_revoked` — emitted when periodic revalidation finds that the connected user can no longer read one or more active subscriptions (permission/category change, or a narrowed `allowedPathPatterns`). Shape: `{ "op": "subscriptions_revoked", "points": ["slot:/..."], "reason": "authorization_revoked" }`. The listed points have already been dropped server-side; a client that still needs them must re-`subscribe` (and will be re-checked).
- `session_revoked` — emitted just before the server closes the socket (close code `1008`) because the connected user is no longer present in the station. Shape: `{ "op": "session_revoked", "reason": "<text>" }`. Clients should re-authenticate before reconnecting.

## Supported Operations

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
    "apiVersion": "1.5",
    "operations": ["browse", "read", "subscribe", "replace_subscriptions", "write", "read_alarms", "ack_alarm", "clear_alarm", "read_tags", "write_tags", "write_relations"],
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

### `ack_alarm`

Acknowledges one or more alarm records by UUID through Niagara `BAlarmService.ackAlarm`. The authenticated Niagara user is used as the acknowledgement user.

```json
{
  "op": "ack_alarm",
  "id": "9b",
  "uuid": "594379d7-2d8d-4cef-a766-8097a09d52e0"
}
```

Batch form:

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

Batch form uses `clear_alarms` with `uuids`. Prefer `ack_alarm` for ordinary operator acknowledgement and reserve `clear_alarm` for explicit force-clear workflows.

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
