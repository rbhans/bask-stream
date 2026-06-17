# Grafana Data Frame Mapping

This document maps current baskStream payloads to Grafana data frames. It is intentionally plugin-facing and does not change Niagara module payloads.

## History Frames

Source operation: `read_history`

Each readable Niagara history should become one Grafana time-series frame.

Frame name preference:

```text
<alias> || <history display> || <point display> || <ord>
```

Recommended fields:

| Field | Type | Source |
| --- | --- | --- |
| `time` | time | `record.timestamp` |
| `value` | number/string/boolean | `record.value` |
| `status` | string | `record.status` |
| `trendFlags` | string | `record.trendFlags` |

Recommended labels:

| Label | Source |
| --- | --- |
| `station` | plugin data source config or health response |
| `ord` | query ORD |
| `historyOrd` | history result |
| `historyId` | history result |
| `display` | history or point display |
| `valueType` | history record value type |
| `unit` | point facets when available |

V1 should render numeric histories as time series first. Non-numeric histories can start as table frames until state timeline behavior is designed.

## Snapshot Frames

Source operation: `read`

For multiple points, return a table frame.

Recommended fields:

| Field | Type | Source |
| --- | --- | --- |
| `point` | string | `point` |
| `display` | string | `display` |
| `value` | number/string/boolean | `value` |
| `displayValue` | string | `displayValue` |
| `status` | string | `status` |
| `ok` | boolean | `ok` |
| `timestamp` | time | `timestamp` |
| `valueType` | string | `valueType` |

V1 returns snapshot data as table rows only. A later version can add one numeric frame per point for stat or gauge panels after dashboard testing defines the desired behavior.

## Live Frames

Source operations: `replace_subscriptions`, COV push frames.

Live frames are time-series frames for numeric COV values. Each frame contains one `time` field and one numeric field per point update.

| Field | Type | Notes |
| --- | --- | --- |
| `time` | time | COV frame timestamp or plugin receive time if missing. |
| `<point display or ORD>` | number | COV point value. |

Recommended labels:

| Label | Source |
| --- | --- |
| `ord` | COV point `point` |
| `status` | COV point `status` when present |
| `valueType` | COV point `valueType` when present |

The plugin should emit initial snapshots immediately after `replace_subscriptions`, then emit updates as COV frames arrive.

## Errors

baskStream point-level errors should become per-query or per-frame errors, not whole-panel failures when other points succeed.

For table frames, preserve failed entries with:

| Field | Source |
| --- | --- |
| `point` | requested point |
| `ok` | `false` |
| `code` | baskStream error code |
| `message` | baskStream error message |

For time-series frames, attach query errors to the affected refId and continue returning successful frames.

## Units And Display

Use point facets for units where possible. V1 does not yet map snapshot facets into field config. If no unit can be inferred, leave the Grafana unit unset instead of guessing.

Preferred unit sources:

1. Point facets returned by `read`.
2. Metadata from `describe` or `search` when available.
3. Manual alias/unit override in the query editor.

Do not infer engineering units from point names alone.
