# Grafana Query Model

This document defines the initial query JSON for the future baskStream Grafana data source plugin. The query model is plugin-facing. It does not change the baskStream `/stream` protocol.

## Common Fields

```json
{
  "mode": "history",
  "refId": "A",
  "ord": "slot:/Drivers/NiagaraNetwork/AHU_01/points/SpaceTemp",
  "alias": "AHU-01 Space Temp"
}
```

| Field      | Required | Notes                                                 |
| ---------- | -------- | ----------------------------------------------------- |
| `mode`     | yes      | One of `history`, `snapshot`, or `live`.              |
| `refId`    | yes      | Grafana query reference ID.                           |
| `ord`      | yes      | `slot:/` point ORD or `history:` ORD where supported. |
| `alias`    | no       | Optional display name override.                       |
| `metadata` | no       | Optional metadata mode for search/browse helpers.     |

## History Query

Use for Grafana time-series panels backed by Niagara histories.

```json
{
  "mode": "history",
  "refId": "A",
  "ord": "slot:/Drivers/NiagaraNetwork/AHU_01/points/SpaceTemp",
  "alias": "AHU-01 Space Temp",
  "limit": 5000
}
```

Plugin behavior:

1. Use Grafana's query time range as `start` and `end` epoch milliseconds.
2. Call `read_history` with `ord`, `start`, `end`, and `limit`.
3. Return one time-series frame per readable history.

The `/describe-history` resource is available to the query editor for metadata and trend availability, but V1 history execution does not require a separate `describe_history` call.

V1 constraints:

- Numeric histories are the primary supported panel type.
- Boolean, enum, and string histories may be returned as table data or state timelines after numeric history works.
- Do not call this live history. baskStream currently advertises `historyLive: false`.

## Snapshot Query

Use for table panels that need current values. Stat/gauge-specific frames are a later enhancement.

```json
{
  "mode": "snapshot",
  "refId": "B",
  "ords": [
    "slot:/Drivers/NiagaraNetwork/AHU_01/points/SpaceTemp",
    "slot:/Drivers/NiagaraNetwork/AHU_01/points/SupplyFanStatus"
  ],
  "fields": [
    "point",
    "display",
    "value",
    "displayValue",
    "status",
    "timestamp",
    "facets"
  ]
}
```

Plugin behavior:

1. Call `read` with `points` and optional `fields`.
2. Return a table frame for the requested points.
3. Preserve point-level errors as table rows where possible.

## Live Query

Use for live current-value panels backed by COV updates.

```json
{
  "mode": "live",
  "refId": "C",
  "ords": ["slot:/Drivers/NiagaraNetwork/AHU_01/points/SpaceTemp"],
  "leaseSec": 300
}
```

Plugin behavior:

1. Open an authenticated baskStream WebSocket.
2. Call `replace_subscriptions`.
3. Emit initial snapshots.
4. Forward COV frames to Grafana Live.
5. Release the subscription group when the stream closes.

Recommended subscription group format:

```text
grafana:<hash(datasourceUid + refId + ords + leaseSec)>
```

The group sent to the station must remain below the module's group-name limit, so the backend hashes sanitized query identity instead of sending full ORD lists as group names.

## Resource Requests

The plugin backend exposes read-only resource handlers for query-builder UI calls.

| Resource            | baskStream operation             | Purpose                         |
| ------------------- | -------------------------------- | ------------------------------- |
| `/health`           | `/stream/health`, `capabilities` | Save & Test and diagnostics.    |
| `/search`           | `search`                         | Point picker search.            |
| `/browse`           | `browse`                         | Tree navigation.                |
| `/describe`         | `describe`                       | Detail view for selected nodes. |
| `/describe-history` | `describe_history`               | Show trend availability.        |

Resource responses should be plugin JSON, not raw MessagePack.

Resource handlers map to fixed read-only operations. They must ignore caller-supplied `op` and `id` fields and reject unsupported fields so Grafana helper routes cannot become a mutation tunnel.

## Validation Rules

- `mode` must be one of the supported values.
- `history` requires `ord`.
- `snapshot` and `live` require at least one point ORD.
- `limit` must be clamped before reaching the station.
- `leaseSec` must be clamped before reaching the station.
- Snapshot and live point ORD arrays must be rejected or capped before reaching the station.
- Writes, alarm actions, and schedule edits are invalid in V1.
