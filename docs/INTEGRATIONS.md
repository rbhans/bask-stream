# baskStream Integration Direction

baskStream should evolve as a small Niagara data gateway: one core Niagara access layer with optional protocol adapters around it. The current WebSocket API remains the primary runtime API and must stay backward compatible.

## Goals

- Keep the existing `/stream` WebSocket contract stable for current clients.
- Add integrations as optional adapters that reuse the same point, history, subscription, alarm, schedule, metadata, permission, and limit logic.
- Keep integrations read-only by default.
- Avoid outbound dependencies or external service credentials in the station unless an integration explicitly requires them.
- Make every new integration easy to disable, test, and remove without affecting the core WebSocket path.

## Non-Goals

- Do not turn the core WebSocket protocol into a product-specific API.
- Do not add writes, alarm actions, or schedule edits to integrations until read-only behavior is proven.
- Do not duplicate Niagara resolution logic per integration.
- Do not change existing response shapes without a versioned protocol addition.

## Target Architecture

```text
baskStream core
  access policy
  browse/search/describe
  point reads
  history reads
  COV subscriptions
  alarms/schedules/model hints
  metadata and limits

protocol adapters
  current MessagePack WebSocket API
  OpenMetrics counters at GET /stream/metrics (API 1.7)
  future REST/OpenAPI adapter

external tools
  Influx/Timescale exporter
  MQTT/Sparkplug bridge
  Node-RED node
```

The core owns Niagara facts. Adapters only translate those facts into another protocol or tool-specific shape.

## Compatibility Rules

1. Existing `/stream` and `/stream/health` behavior stays unchanged unless the change is explicitly backward compatible.
2. New integration endpoints live under their own path or feature flag.
3. New capabilities are advertised before clients rely on them.
4. Integration defaults are disabled or read-only.
5. Limits are enforced in the module, not trusted to clients.
6. Behavior that only one tool needs must not leak into generic WebSocket operation names or payloads.

## Removed: the Grafana data source

A read-only Grafana backend data source was the first integration. It was removed from this repository on 2026-11-21: data exporters and dashboards are not where baskStream is different (see [ROADMAP.md](ROADMAP.md#left-out-on-purpose)), and it was not being kept in step with the API. It is in the git history under `integrations/grafana/`.

## Likely Core Additions

Add these only when a real integration proves the need:

- Batched history reads for multiple points.
- Server-side history windowing or downsampling for large time ranges. (The module has `read_history_rollup` since API 1.7.)
- Stable series metadata for labels, units, display names, and status quality.
- A read-only integration mode that blocks write and alarm-action operations.
- A generic REST query endpoint.

These additions should be generic. For example, prefer `history_query` or `history_batch` over an operation named for one tool.

## Integration Priority

| Priority | Integration            | Preferred Shape                                                |
| -------- | ---------------------- | -------------------------------------------------------------- |
| 2        | REST/OpenAPI           | Optional module adapter                                        |
| 3        | Prometheus/OpenMetrics | Done: `GET /stream/metrics` (API 1.7)                          |
| 4        | InfluxDB/Timescale     | External exporter first                                        |
| 5        | MQTT/Sparkplug B       | External bridge first                                          |
| 6        | Node-RED               | External node wrapping the WebSocket API                       |
| 7        | Haystack-style API     | Evaluate after REST                                            |

## Verification Checklist

Before shipping any integration change:

1. Existing WebSocket smoke tests still pass.
2. `/stream/health` response remains backward compatible.
3. New integration paths are disabled or read-only by default.
4. Point and history limits are enforced.
5. Unauthorized paths fail through the same access policy as the WebSocket API.
6. Documentation states which data is live, historical, cached, or inferred.
