# baskStream

baskStream is a read-only Grafana data source for Niagara live values and histories. It connects to a Niagara station that has the baskStream module installed, authenticates with a Niagara user, checks `/stream/health`, and uses the existing `/stream` MessagePack WebSocket API for point reads, history reads, point discovery, and live COV updates.

## Requirements

- Grafana 13.0 or newer.
- A Niagara station with the baskStream runtime module installed and enabled.
- Niagara WebService enabled on the station.
- A dedicated least-privilege Niagara user for Grafana.
- Station TLS configured with a trusted certificate, or explicit lab-only use of `insecureSkipVerify`.

## Supported Query Modes

| Mode     | Purpose                              | baskStream operation              |
| -------- | ------------------------------------ | --------------------------------- |
| History  | Historical numeric time series       | `read_history`                    |
| Snapshot | Current-value table rows             | `read`                            |
| Live     | Grafana Live panels from COV updates | `replace_subscriptions` and `cov` |

The query editor also uses read-only helper resources backed by `search`, `browse`, `describe`, and `describe_history`.

## Configuration

Configure the data source with:

| Field               | Notes                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Station URL         | Base station URL, for example `https://station.example.com`.                                     |
| Username            | Niagara user used by Grafana.                                                                    |
| Password            | Stored in Grafana secure JSON data.                                                              |
| TLS mode            | Use `verify` for production. Use `insecureSkipVerify` only for trusted lab/self-signed stations. |
| Allow plain HTTP    | Disabled by default; only enable for trusted lab stations on isolated networks.                   |
| Timeout seconds     | Per-request station timeout.                                                                     |
| Max history records | Plugin-side history limit, capped at 5000.                                                       |
| Max point ORDs      | Plugin-side snapshot/live point limit, capped at 1000.                                           |
| Max live lease      | Plugin-side live subscription lease cap, defaulting to 300 seconds.                              |

Live point counts are also capped by station-advertised `maxLivePointsPerStream` or `maxSubscriptionsPerClient` values. If those capabilities are unavailable, the plugin falls back to the module's current 500-point live default.

## Provisioning

The included provisioning file uses environment variables for station-specific connection settings:

```bash
export BASKSTREAM_STATION_URL=https://station.example.com
export BASKSTREAM_USERNAME=grafana
export BASKSTREAM_PASSWORD='station password'
```

Secrets belong in `secureJsonData`; do not put Niagara passwords in panel query JSON or browser-side settings.

## Security

This first Grafana integration is read-only. It does not expose point writes, priority-array overrides, alarm acknowledgement, alarm clearing, schedule edits, or raw arbitrary baskStream operations.

Station security remains authoritative. Use Niagara permissions and baskStream `allowedPathPatterns` to constrain what Grafana can read.
