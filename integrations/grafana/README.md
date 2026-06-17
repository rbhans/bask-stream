# baskStream Grafana Integration

This folder contains the Grafana data source integration direction and the first backend data source plugin implementation. The implementation consumes the current baskStream WebSocket API without changing existing station behavior.

## Product Goal

Give Grafana a direct read-only path to Niagara live values and histories:

```text
Grafana panel
  -> baskStream Grafana data source plugin
    -> Niagara login
    -> GET /stream/health
    -> wss://<station>/stream
      -> capabilities
      -> search / browse / describe
      -> read
      -> read_history / describe_history
      -> replace_subscriptions / cov
```

The Niagara station still only needs the baskStream runtime module and service. The Grafana plugin handles Grafana-specific configuration, query editing, data frames, and streaming.

## Non-Breaking Rule

Version 1 must use the existing `/stream` contract first. Do not add new Java endpoints or change current response shapes until the plugin proves a specific missing capability.

Allowed module changes for v1:

- Documentation.
- Capability metadata that is backward compatible.
- Generic core helpers that do not alter existing payloads.

Avoid in v1:

- Changing existing MessagePack operation names.
- Changing `read`, `read_history`, `describe_history`, or COV response shapes.
- Adding writes, alarm actions, or schedule edits.
- Adding Grafana-specific names to generic protocol operations.

## Initial Scope

| Grafana Feature                   | baskStream Operation                      |
| --------------------------------- | ----------------------------------------- |
| Save & Test                       | `GET /stream/health`, then `capabilities` |
| Point search and helper resources | `search`, `browse`, `describe`            |
| Historical time series            | `describe_history`, `read_history`        |
| Current value table               | `read`                                    |
| Live value stream                 | `replace_subscriptions`, COV push frames  |

## Build, Sign, And Install

The plugin can be packaged as either an unsigned development artifact or a private signed package. Use signed packages for normal local, lab, and customer-controlled Grafana installs.

From `integrations/grafana/basidekick-baskstream-datasource`:

```bash
npm ci
export GRAFANA_ACCESS_POLICY_TOKEN='<grafana cloud access policy token>'
GRAFANA_ROOT_URLS=http://127.0.0.1:3000 npm run package:signed
```

`GRAFANA_ROOT_URLS` must match the Grafana `server.root_url` where the private plugin will run. For multiple private Grafana roots, pass a comma-separated list.

The signed package is written to:

```text
artifacts/basidekick-baskstream-datasource-1.0.0-signed.zip
```

Install steps for Windows, Linux, macOS, Docker, unsigned development builds, and first datasource setup are in [basidekick-baskstream-datasource/INSTALL.md](basidekick-baskstream-datasource/INSTALL.md).

## Query Modes

### History

Inputs:

- point or history ORD
- Grafana time range
- optional display alias
- max records limit

Backend behavior:

1. Read records with `read_history` for the Grafana query time range.
2. Return one Grafana time-series data frame per readable history.
3. Add labels for ORD, history ORD, history ID, and value type.

`describe_history` is exposed as a read-only helper resource for query-builder metadata, but the current history query path does not require a separate metadata call.

### Snapshot

Inputs:

- one or more point ORDs
- optional field selection

Backend behavior:

1. Call `read`.
2. Return a table frame for table panels.
3. Preserve status, display value, timestamp, and per-point errors.

V1 does not yet emit dedicated single-value stat/gauge frames or facets. Add those only after real dashboard usage proves the expected panel behavior.

### Live

Inputs:

- one or more point ORDs
- stream lease seconds

Backend behavior:

1. Open an authenticated WebSocket.
2. Call `replace_subscriptions` with a bounded group name derived from datasource UID and sanitized live query identity.
3. Emit the initial snapshots.
4. Forward COV push frames into Grafana Live data frames.
5. Release subscriptions when the stream ends.

## Plugin Package Shape

The plugin uses the standard Grafana backend data source layout:

```text
integrations/grafana/basidekick-baskstream-datasource/
  README.md
  src/plugin.json
  package.json
  src/
    ConfigEditor.tsx
    QueryEditor.tsx
    datasource.ts
    types.ts
  pkg/
    plugin/
      datasource.go
    baskstream/
      client.go
      protocol.go
      history.go
      stream.go
```

The implementation was generated with Grafana's create-plugin tooling as a backend data source. Do not hand-roll the Grafana plugin runtime for this integration.

## Backend Responsibilities

- Store station credentials in Grafana secure data source settings.
- Keep Niagara credentials out of browser-side query code.
- Support trusted and self-signed station TLS modes explicitly.
- Re-authenticate when Niagara web sessions expire.
- Convert baskStream errors into per-query Grafana errors without failing unrelated queries.
- Enforce plugin-side max points, station-advertised live point caps, bounded live leases, and max history records before sending data requests.
- Keep writes and alarm actions unavailable.

## Module Responsibilities

- Authenticate through Niagara web security.
- Enforce `allowedPathPatterns` and Niagara read permissions.
- Resolve points, histories, metadata, and status.
- Maintain COV subscriptions and leases.
- Enforce station-side limits.
- Keep the current WebSocket API backward compatible.

## Likely Future Module Additions

Add these only after the plugin demonstrates real need:

- `history_batch`: read multiple point/history ORDs in one request.
- `history_query`: accept Grafana-style range, interval, and max datapoints.
- Server-side history downsampling with average, min, max, last, and count.
- Stable series metadata for labels and units.
- Read-only integration mode that rejects mutation operations.

These should be generic protocol additions, not Grafana-only endpoints.

## Implementation Milestones

1. Scaffold plugin with Grafana create-plugin as a backend data source. Done.
2. Implement the query JSON defined in [QUERY_MODEL.md](QUERY_MODEL.md). Done.
3. Implement the frame mapping defined in [DATAFRAME_MAPPING.md](DATAFRAME_MAPPING.md). Done for numeric history, snapshot table rows, and numeric live COV series.
4. Apply the security rules in [SECURITY.md](SECURITY.md). Done for read-only credentials, TLS mode, HTTPS-by-default station URLs, history limits, point caps, and bounded live leases.
5. Implement Save & Test against `/stream/health` and `capabilities`. Done.
6. Add history query mode backed by `read_history`. Done.
7. Add snapshot mode backed by `read`. Done.
8. Add live mode backed by `replace_subscriptions`. Done.
9. Add point search resources backed by `search`. Done.
10. Add shallow browse selection in the query editor. Done.
11. Add private signing and signed package flow. Done.
12. Add richer multi-level browse tree and metadata picker. Next.
13. Evaluate whether module-level history batching or downsampling is needed after real dashboard testing.

## References

- Grafana backend data source plugins: https://grafana.com/developers/plugin-tools/tutorials/build-a-data-source-backend-plugin
- Grafana streaming data source plugins: https://grafana.com/developers/plugin-tools/tutorials/build-a-streaming-data-source-plugin
- Grafana data frames: https://grafana.com/developers/plugin-tools/key-concepts/data-frames
