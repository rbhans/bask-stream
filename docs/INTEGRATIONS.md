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
  Grafana backend data source plugin
  future REST/OpenAPI adapter
  future OpenMetrics adapter

external tools
  Grafana data source plugin
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
6. Any Grafana-specific behavior must not leak into generic WebSocket operation names or payloads.

## First Integration: Grafana

The clean first target is a Grafana data source integration for historical and live Niagara data.

The working plugin implementation and product contract live in [integrations/grafana/README.md](../integrations/grafana/README.md).

Initial Grafana scope:

- Health check against the station and baskStream service.
- Point search/picker using existing browse/search metadata.
- Historical numeric series using existing `describe_history` and `read_history`.
- Current value panels using existing `read`.
- Live panels using existing `replace_subscriptions` and COV frames.
- Read-only behavior only.

Expected Grafana-specific responsibilities:

- Query editor and point picker.
- Grafana secure credential storage.
- Grafana data frame mapping.
- Grafana Live stream mapping.
- Dashboard variables and labels.

Expected module responsibilities:

- Resolve authorized point and history ORDs.
- Read current values and histories.
- Maintain COV subscriptions and leases.
- Provide stable metadata such as display names, units, value type, status, and history availability.
- Enforce limits.

## Likely Core Additions

Add these only when a real integration proves the need:

- Batched history reads for multiple points.
- Server-side history windowing or downsampling for large Grafana time ranges.
- Stable series metadata for labels, units, display names, and status quality.
- A read-only integration mode that blocks write and alarm-action operations.
- A generic REST query endpoint if it helps more than Grafana.

These additions should be generic. For example, prefer `history_query` or `history_batch` over `grafana_history`.

## Integration Priority

| Priority | Integration            | Preferred Shape                                                |
| -------- | ---------------------- | -------------------------------------------------------------- |
| 1        | Grafana                | Grafana plugin first, optional module endpoints only if needed |
| 2        | REST/OpenAPI           | Optional module adapter                                        |
| 3        | Prometheus/OpenMetrics | Optional module `/metrics` endpoint                            |
| 4        | InfluxDB/Timescale     | External exporter first                                        |
| 5        | MQTT/Sparkplug B       | External bridge first                                          |
| 6        | Node-RED               | External node wrapping the WebSocket API                       |
| 7        | Haystack-style API     | Evaluate after Grafana and REST                                |

## Verification Checklist

Before shipping any integration change:

1. Existing WebSocket smoke tests still pass.
2. `/stream/health` response remains backward compatible.
3. New integration paths are disabled or read-only by default.
4. Point and history limits are enforced.
5. Unauthorized paths fail through the same access policy as the WebSocket API.
6. Documentation states which data is live, historical, cached, or inferred.
