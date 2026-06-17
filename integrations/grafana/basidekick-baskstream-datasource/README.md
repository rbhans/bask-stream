# baskStream Grafana Data Source

This is the first Grafana backend data source implementation for baskStream. It consumes the existing baskStream `/stream` contract without changing the Niagara runtime module.

## Current Scope

Implemented:

- Data source settings for station URL, Niagara username/password, TLS mode, timeout, history record limit, point count limit, and live lease limit.
- Backend Niagara SCRAM login flow, matching the existing baskStream MCP client behavior.
- `/stream/health` and WebSocket `capabilities` checks for Grafana Save & Test.
- `history` query mode backed by `read_history`.
- Numeric history records mapped into Grafana time-series data frames.
- `snapshot` query mode backed by `read`.
- Point snapshot rows mapped into a Grafana table frame, including per-point errors.
- `live` query mode backed by `replace_subscriptions` and COV frames through Grafana Live.
- Read-only resource endpoints for health, search, browse, describe, and describe-history.
- Basic point search and shallow browse selection in the query editor.

Defined but not implemented yet:

- Richer multi-level browse tree and point metadata picker.

The Niagara runtime module is unchanged. This plugin consumes the existing API.

The implementation uses Grafana's `@grafana/create-plugin` backend data source tooling, webpack, and Mage.

## Development

Install frontend dependencies:

```bash
npm ci
```

The checked-in provisioning file expects these environment variables when you run the generated Grafana server:

```bash
export BASKSTREAM_STATION_URL=https://station.example.com
export BASKSTREAM_USERNAME=grafana
export BASKSTREAM_PASSWORD='station password'
```

Run backend tests:

```bash
go test ./...
```

Run frontend type checks after dependencies are installed:

```bash
npm run typecheck
```

Start the generated Grafana development environment:

```bash
npm run server
```

## Package And Install

Build the frontend and backend from this plugin directory:

```bash
npm run build
go run github.com/magefile/mage -v build:linux
```

Or create an unsigned internal Linux ZIP artifact:

```bash
npm run package:linux
```

The packaged ZIP is written to `artifacts/` and contains a top-level directory named with the plugin ID, matching Grafana's expected package layout. It includes Linux amd64 and Linux arm64 backend binaries. This script does not sign the plugin.

For the normal cross-platform install package, build all supported backend binaries:

```bash
npm run package:all
```

That package includes Windows x64, Linux x64, Linux arm64, macOS Intel, and macOS Apple Silicon binaries.

For normal private installs, build a signed package:

```bash
export GRAFANA_ACCESS_POLICY_TOKEN='<grafana cloud access policy token>'
GRAFANA_ROOT_URLS=http://127.0.0.1:3000 npm run package:signed
```

The signed package is written to:

```text
artifacts/basidekick-baskstream-datasource-1.0.0-signed.zip
```

`GRAFANA_ROOT_URLS` must exactly match the Grafana `server.root_url` values where the private plugin will run. If Grafana is configured as `http://localhost:3000/`, a plugin signed only for `http://127.0.0.1:3000/` will be rejected as invalid.

Windows-first install steps and Docker examples are in [INSTALL.md](INSTALL.md).

Restart Grafana after installing or after changing `src/plugin.json`; Grafana loads plugin metadata at startup.

If you are developing on Windows, build from WSL or another filesystem that supports npm's symlinks. The plugin can run on native Windows Grafana, but the build tooling should not be run from a mounted filesystem that rejects symlink creation.

## Configuration

| Field               | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Station URL         | Base Niagara station URL, for example `https://station.example.com`.                     |
| Username            | Least-privilege Niagara user for Grafana.                                                |
| Password            | Stored in Grafana secure JSON data.                                                      |
| TLS mode            | `verify` for trusted certs or `insecureSkipVerify` for trusted lab/self-signed stations. |
| Allow plain HTTP    | Disabled by default; only enable for trusted lab stations on isolated networks.           |
| Timeout seconds     | Per-request station timeout.                                                             |
| Max history records | Plugin-side clamp, capped at the module's current 5000-record history limit.             |
| Max point ORDs      | Plugin-side clamp for snapshot and live point ORD arrays, capped at 1000.                |
| Max live lease      | Plugin-side cap for live subscription lease seconds, defaulting to 300.                  |

## Query Modes

### History

Uses `read_history` over the existing MessagePack WebSocket API.

Required query fields:

- `mode: "history"`
- `ord`: point or history ORD

Optional query fields:

- `alias`
- `limit`

### Snapshot

Uses `read` over the existing MessagePack WebSocket API.

Required query fields:

- `mode: "snapshot"`
- `ords`: one or more point ORDs

### Live

Uses `replace_subscriptions` over the existing MessagePack WebSocket API, then forwards initial snapshots and COV frames through Grafana Live.

Required query fields:

- `mode: "live"`
- `ords`: one or more point ORDs

Optional query fields:

- `alias`
- `leaseSec`

Requested `leaseSec` values are capped by the data source's Max live lease setting before the plugin sends `replace_subscriptions` or `renew_subscriptions` to the station.

Live point counts are also capped by the station-advertised `maxLivePointsPerStream`/`maxSubscriptionsPerClient` limit. If that capability is unavailable, the plugin falls back to the module's current 500-point live default.

## Resource Endpoints

The plugin exposes read-only Grafana resource routes that translate UI helper calls into existing baskStream WebSocket operations:

| Route               | baskStream operation                  |
| ------------------- | ------------------------------------- |
| `/health`           | `/stream/health`, then `capabilities` |
| `/search`           | `search`                              |
| `/browse`           | `browse`                              |
| `/describe`         | `describe`                            |
| `/describe-history` | `describe_history`                    |

These routes do not accept or forward caller-supplied `op` values.

## Security

V1 is read-only. Do not expose point writes, alarm acknowledgements, alarm clearing, or schedule edits through Grafana until the read-only path is proven and reviewed.

Use a dedicated Niagara user with only the required read permissions and constrain station scope with the baskStream service `allowedPathPatterns`.
