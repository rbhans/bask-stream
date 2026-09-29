# baskStream

baskStream is a Niagara 4 runtime module that gives outside applications an authenticated WebSocket connection to station data. I built it for graphics, dashboards, commissioning tools, and integrations that need live Niagara data without having to run inside Niagara's UI.

The API stays close to Niagara's object model and permission system. A client can browse the station, read and subscribe to points, write writable points, work with alarms, inspect schedules and histories, and read or edit direct tags and relations. Discovery responses include the evidence an application needs to understand devices, points, parents, and likely equipment without pretending every station is modeled the same way.

For the full protocol reference, see [docs/THIRD_PARTY_API.md](docs/THIRD_PARTY_API.md). To try it from a terminal, [install the `bask` CLI](#bask-cli-and-dashboard).

This project is not affiliated with, endorsed by, or sponsored by Tridium, Honeywell, Anthropic, OpenAI, or any AI-client vendor. Use it only with Niagara stations and software licenses you are authorized to access and administer.

The repository's own code and documentation are open source under the [Apache License 2.0](LICENSE). That license does not grant rights to Niagara Framework, Tridium/Honeywell software, product documentation, license keys, services, marks, or customer systems.

## Current API highlights

- The current source advertises API version `1.6`. Clients should still call `capabilities` instead of assuming a deployed station is on the same version.
- New since the first 1.6 release, all additive: `read_history_rollup` (time-bucketed min/max/avg for charts), alarm filters with newest-first reads and filtered acknowledge/clear with `dryRun`, `read_schedule_events` and `write_schedule`, OpenMetrics counters at `/stream/metrics`, and audit-trail records for every change made through the stream.
- A [TypeScript SDK](sdk/README.md) and the [`bask` CLI and terminal dashboard](cli/README.md) are the first clients built on the shared protocol spec.
- API 1.6 adds [station model editing](docs/MODEL_EDITING_API.md): installed component types, properties, clone/rename/move/delete, hierarchy configuration, slots, links and actions, with preview/apply and recorded outcomes.
- `BASkStreamService.writesEnabled=false` turns off all writes through the module while reads continue. It defaults to true for compatibility. New model-plan application additionally requires `modelEditsEnabled=true` (default false).
- `read` is the batch point snapshot operation for point/value ORDs.
- Point snapshots can include facets, enum metadata, status, timestamps, display values, and raw values.
- Clients can pass `fields` to `read` for lean point tables; `point` and `ok` are always returned.
- `capabilities` advertises point snapshot limits and supported snapshot fields through `pointSnapshot`.
- API 1.5 adds `read_tags`, `write_tags`, and `write_relations`, plus `hierarchy:` browsing for stations that use Niagara hierarchies.
- Plain Px/graphic embedding is not implemented yet; `capabilities.graphics.plainPx` and `plainGraphic` report `false`.

## Where to start

| Surface | Use it for | Start here |
| --- | --- | --- |
| Niagara module | The actual station runtime API. Install this when another app needs authenticated WebSocket access to live station data. | [Station Setup](#station-setup) |
| Companion app | Guided startup, live station testing, API inspection, and setup snippets for external tools. | [Companion guide and demo app](#companion-guide-and-demo-app) |
| WebSocket protocol | Production apps, graphics, dashboards, and integrations that should talk directly to the station. | [docs/THIRD_PARTY_API.md](docs/THIRD_PARTY_API.md) |
| TypeScript SDK | JavaScript/TypeScript apps (Node, Electron, tooling) that want login, reconnects and live subscriptions handled for them. | [TypeScript SDK](#typescript-sdk) |
| `bask` CLI | Quick station checks, scripts and exports from a terminal, plus a full-screen live dashboard. | [bask CLI and dashboard](#bask-cli-and-dashboard) |
| Integration direction | Compatibility rules and the future adapter strategy for Grafana, REST, OpenMetrics, and exporters. | [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| Python tools | Bench tests, quick station checks, and scripting experiments. | [Python test tools](#python-test-tools) |
| MCP server | An optional local bridge for AI clients and agent workflows. It sits around the module; it is not the main runtime API. It has not been updated for API 1.6 yet; the plan is to rebuild it on the SDK. | [AI tooling: MCP server](#ai-tooling-mcp-server) |

## TypeScript SDK

[`sdk/`](sdk/README.md) is a typed client for the WebSocket API (Node 20+). It handles the connection plumbing every app otherwise repeats:

- Niagara SCRAM-SHA-256 login with the station's signature verified, session reuse, and re-login when a session expires.
- `call()` for all 45 operations, generated from [spec/baskstream-protocol.json](spec/baskstream-protocol.json), with protocol error codes on every failure, plus helpers such as `read`, `browse`, `historyRollup`, `alarms` and `writeSchedule`.
- `watch()` subscription groups that renew their lease, re-read after `resync_required`, and come back after a reconnect.
- Keepalive pings and reconnect with backoff.

```ts
const client = await BaskStreamClient.connect({ station: "https://my-jace", username: "tech", password: () => ask() });
const watch = await client.watch(["slot:/Drivers/.../ZoneTemp"]);
watch.on("change", (point) => console.log(point.point, point.value));
```

## bask CLI and dashboard

[`cli/`](cli/README.md) is a command-line tool built on the SDK. Run `bask` with no command for a full-screen terminal dashboard: a station tree with live details, a watch list with sparklines, live alarms, history charts, and station status.

### 1. Install

No Node or admin rights needed. The installer downloads a single executable from the latest [`bask-v*` release](https://github.com/rbhans/bask-stream/releases) and checks it against the release checksums.

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.ps1 | iex
```

It installs to `~/.local/bin/bask` (Windows: `%LOCALAPPDATA%\Programs\bask\bask.exe`, added to your user PATH). If `bask` is not found afterwards, open a new terminal or follow the PATH hint the installer prints. Run `bask --version` to check.

### 2. Log in to a station

The station needs the baskStream module and `BASkStreamService` running (see [Station setup](#station-setup)).

```bash
bask login https://<station> -u <user> --insecure
```

It asks for the password and saves only the session, never the password. Use `--insecure` for the self-signed certificate most stations have. Add `--name <profile>` to keep several stations, then switch with `bask use <profile>` or `-p <profile>`.

### 3. Use it

```bash
bask                                                     # full-screen dashboard (? for keys, q to quit)
bask status                                              # station, user, limits, traffic
bask browse Drivers -d 2                                 # station tree
bask read Drivers/.../ZoneTemp                           # current values
bask watch Drivers/.../ZoneTemp Drivers/.../ZoneSP       # live values
bask history Drivers/.../ZoneTemp --since 7d --rollup 1h -o csv > zonetemp.csv
bask alarms --unacked -f                                 # alarms, then follow new ones
```

In the dashboard: `1`–`5` switch between Browse, Watch, Alarms, History and Status. In Browse, arrow keys move and open branches, `w` adds a point to Watch, and `t` opens its trend.

Everything is read-only unless you add `--allow-writes`, and every write or alarm acknowledgement asks before sending. The full command list is in [cli/README.md](cli/README.md).

### Update or uninstall

- **Update:** run the install command again.
- **Uninstall:** delete the `bask` executable and the saved sessions in `~/.config/baskstream` (Windows: `%APPDATA%\baskstream`).

## Grafana integration

The first product integration is a read-only Grafana backend data source at [integrations/grafana/basidekick-baskstream-datasource](integrations/grafana/basidekick-baskstream-datasource). It connects Grafana directly to a Niagara station running baskStream:

```text
Grafana panel -> BaskStream data source -> Niagara login -> /stream/health -> /stream WebSocket
```

It does not require a Niagara module API change. The plugin uses the existing `/stream` operations for point search, current values, histories, and live COV updates.

To get a first panel running:

1. Install and enable the baskStream runtime module on the Niagara station.
2. Create a least-privilege Niagara user for Grafana.
3. Build and sign the Grafana plugin from `integrations/grafana/basidekick-baskstream-datasource`.
4. Install the signed plugin into Grafana's plugin directory and restart Grafana.
5. Add the `BaskStream` data source in Grafana.
6. Use `History`, `Snapshot`, or `Live` query mode in panels.

For private signed installs, the Grafana root URL used during signing must exactly match Grafana's configured `server.root_url`. See [integrations/grafana/basidekick-baskstream-datasource/INSTALL.md](integrations/grafana/basidekick-baskstream-datasource/INSTALL.md).

## Repository layout

```text
baskStream-rt/                   Niagara runtime module source
LICENSE                          Apache License 2.0 for this repository's code
docs/THIRD_PARTY_API.md          Detailed WebSocket protocol guide
docs/INTEGRATIONS.md             Integration adapter direction and compatibility rules
docs/LEGAL_AND_SAFETY.md         EULA, AI-tool, and distribution checklist
docs/PRIVACY.md                  Local data-handling notes
docs/TERMS.md                    Open-source terms and third-party boundaries
sdk/                             TypeScript SDK (login, calls, live watches, reconnects)
cli/                             bask CLI and terminal dashboard, built on the SDK
cli/install.sh, cli/install.ps1  One-line installers for the released executables
.github/workflows/release-bask.yml
                                 Builds and publishes bask releases on bask-v* tags
tools/baskstream-nav-tree.html   Companion guide and demo/test app
tools/baskstream-nav-tree-server.mjs
                                 Local helper for the companion app
tools/baskstream-live-smoke.mjs
                                 Live station smoke test script
tools/python-tools/README.md     Python bench-test tooling guide
tools/python-tools/tools/python/
                                 Read-only Python client, CLI, and smoke test
tools/mcp/README.md              Local stdio MCP server guide
tools/mcp/INSTALL.md             Windows-first MCP install guide
tools/mcp/CLIENTS.md             MCP client matrix and config examples
tools/mcp/examples/              Ready-to-edit client config templates
tools/mcp/src/                   MCP server source for AI station workflows
tools/codex-plugin/bask-stream/  Codex plugin template for the MCP server
tools/claude-plugin/bask-stream/ Claude Code plugin template for the MCP server
integrations/grafana/            Grafana integration implementation and product contract
tools/baskstream-test.html       Lower-level standalone test harness
tools/baskstream-test-snippet.js
                                 Browser-console station-page test snippet
spec/baskstream-protocol.json    Machine-readable protocol spec: operations, request schemas, errors
spec/render_error_table.py       Regenerates the error-code table in docs/THIRD_PARTY_API.md
tests/                           Local regression and contract checks (no Niagara build or station)
docs/ARCHITECTURE_PLAN.md        Architecture phases and live-test findings
```

Run the local checks from the repository root:

```bash
python3 tests/protocol_contract.py
python3 tests/protocol_regression.py
python3 tests/transport_regression.py
python3 tests/model_plan_regression.py
python3 tests/model_adapter_regression.py
python3 tests/event_lane_regression.py
python3 tests/typecheck.py /path/to/niagara_home   # javac against the SDK jars; not a module build
(cd sdk && npm install && npm test)
(cd cli && npm install && npm test)
```

Build artifacts, generated jars, screenshots, local editor settings, and macOS AppleDouble sidecar files are intentionally ignored.

## Legal and AI-tool boundaries

This is engineering guidance, not legal advice. Review the current [Tridium Niagara EULA](https://www.tridium.com/us/en/eula), the order terms for the target license, and customer agreements before distributing or using this project on a third-party station.

- Project notices: [NOTICE.md](NOTICE.md)
- Privacy notes: [docs/PRIVACY.md](docs/PRIVACY.md)
- Terms starting point: [docs/TERMS.md](docs/TERMS.md)
- Distribution checklist: [docs/LEGAL_AND_SAFETY.md](docs/LEGAL_AND_SAFETY.md)

- Keep baskStream additive: a Niagara module and external clients using the module's authenticated WebSocket API.
- Do not use AI tools to inspect, summarize, reproduce, or transform Tridium source code, decompiled classes, binary internals, license keys, proprietary documentation, confidential benchmarks, or vulnerability findings.
- Do not copy Tridium code or documentation into this project or into AI prompts.
- Do not reverse engineer, decompile, disassemble, extract, modify binary behavior, or change Niagara APIs.
- Use only licensed Niagara development tooling and authorized stations.
- Use least-privilege Niagara users, and get explicit customer authorization before connecting AI tooling to customer systems.
- Avoid Tridium, Honeywell, Anthropic, OpenAI, Claude, Codex, or MCP Registry branding in a way that implies partnership, certification, or endorsement.

## Station setup

1. Compile the module jar with your Niagara build environment.
2. Install the compiled baskStream module jar on the station host.
3. Restart Niagara so the module is available.
4. Add the BASkStreamService to the station.
5. Confirm the service `servletName` property is `stream`; blank values are defaulted to `stream` on startup.
6. Verify the health endpoint responds after station login:

```text
GET https://<station>/stream/health
```

7. Create or choose a Niagara user with only the permissions your external application needs.
8. For browser clients hosted outside the station origin, add those exact origins to the BASkStreamService `allowedOrigins` property. Same-origin station pages and non-browser service clients do not need this setting.

The Niagara build may add a development code-signing block to the jar. If your target station or distribution workflow requires an unsigned module jar, remove the signature artifacts and stale manifest digest sections before installing it:

```bash
tmpdir="$(mktemp -d)"
unzip -p baskStream-rt.jar META-INF/MANIFEST.MF \
  | perl -0pe 's/\r?\n\r?\n.*\z//s; s/\r?\n/\r\n/g; $_ .= "\r\n\r\n"' \
  > "$tmpdir/MANIFEST.MF"
zip -d baskStream-rt.jar 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.DSA' 'META-INF/*.EC' META-INF/MANIFEST.MF
mkdir -p "$tmpdir/META-INF"
mv "$tmpdir/MANIFEST.MF" "$tmpdir/META-INF/MANIFEST.MF"
(cd "$tmpdir" && zip "$OLDPWD/baskStream-rt.jar" META-INF/MANIFEST.MF)
rm -rf "$tmpdir"
```

You can confirm the result with:

```bash
jarsigner -verify -verbose -certs baskStream-rt.jar
```

The expected unsigned result is `jar is unsigned`.

The WebSocket API runs through Niagara web authentication. A client must authenticate to the station first, then connect to:

```text
wss://<station>/stream
```

## Client flow

Recommended external app flow:

1. Authenticate to Niagara and open the WebSocket at `/stream`.
2. Send `ping` to verify the connection.
3. Send `capabilities` and adapt to the deployed API version.
4. Use shallow `browse`, `describe`, or `search` calls for discovery.
5. Request `metadata: "full"` for initial discovery or refresh passes.
6. Omit metadata for routine navigation when the app already has cached structure.
7. Use `read` for current value snapshots, including optional field selection for lean point tables.
8. Use `replace_subscriptions` for points on the active graphic or UI view.
9. Use `release_subscriptions` when a view closes.
10. Use alarm, schedule, and history calls only where the app needs those views.

## Core operations

| Need | Operation | Use |
| --- | --- | --- |
| Verify API | `ping`, `capabilities` | Confirm connection and discover supported features, limits, and schema versions. |
| Discover station tree | `browse`, `describe`, `search` | Build equipment, point, schedule, history, and metadata views. |
| Read live values | `read` | Fetch current point snapshots with value, display value, status, timestamp, and facets. |
| Subscribe to graphic values | `replace_subscriptions`, `renew_subscriptions`, `release_subscriptions` | Keep live COV data scoped to the active view and let the server manage diffing and leases. |
| Simple point watches | `subscribe`, `unsubscribe` | Use for simple clients or long-lived manual watches. |
| Write points | `describe_write`, `write` | Render safe controls, then set, override, auto, or emergency override writable points. |
| Alarms | `read_alarms`, `ack_alarm`, `clear_alarm`, `subscribe_alarms`, `unsubscribe_alarms` | Load bounded snapshots (filtered by class, priority, ack state and time; newest first if asked), acknowledge or force-clear by UUID or filter with `dryRun`, and maintain client alarm state with event pushes. |
| Schedules | `read_schedule`, `read_schedule_events`, `write_schedule` | Read schedule state, list upcoming output changes, and replace weekday entries (audited, with `dryRun`). |
| Histories | `describe_history`, `read_history`, `read_history_rollup` | Detect trend availability, load records by time range, or summarise them into fixed-width buckets for charts. |
| Tags and relations | `read_tags`, `write_tags`, `write_relations` | Read direct and implied tags, edit direct tags, and manage component relations. |
| Model changes | `subscribe_model`, `unsubscribe_model` | Receive branch-scoped structure-change hints, then refresh affected nodes. |
| Model editing | `describe_component_types`, `describe_component`, `preview_model_changes`, `apply_model_changes`, and convenience previews | Preview, then apply, station model changes. See [docs/MODEL_EDITING_API.md](docs/MODEL_EDITING_API.md). |
| Diagnostics | `subscription_status`, `GET /stream/metrics` | Inspect subscriptions, groups and leases; scrape request, error, resync and connection counters. |

## Changed, tightened, or removed

Most changes since API 1.5 are additive, but some requests that used to succeed now return less or are refused. Details are in the [compatibility notes](docs/THIRD_PARTY_API.md#compatibility-notes).

- **Permissions are enforced everywhere.** Alarms are filtered by alarm-class permission (acknowledge needs operator write, force-clear admin write). Histories reached through a point are hidden if the user cannot read the history. Each write action checks invoke permission on that action slot.
- **Related objects are redacted, not leaked.** Parents, ancestors, driver objects, history extensions, alarm sources and relation endpoints the user cannot read come back as `{ "redacted": true }`. Navigation children without an ORD are omitted.
- **Model editing is stricter.** Previews now need `modelEditsEnabled` (not only apply), and each user may hold 8 open previews. Link and relation values are rejected inside `add_slot`/`update`; use `create_link`/`delete_link` and `write_relations`. Protected services and `program:` components cannot be edited, and actions flagged confirm-required need explicit confirmation.
- **Limits replace failures.** A reply over 8 MiB returns `response_too_large` instead of closing the session. Alarm reads stop after examining 50,000 records (`truncatedReason: "examined_limit"`). A request running over 10 minutes gets `request_timeout` and the session closes. A client that falls behind gets `resync_required` instead of an unbounded backlog.
- **COV is coalesced.** Each point appears once per batch with its latest value.
- **Not updated:** the MCP server still targets the API before 1.6, and the Python tools cover read-only health, tree and values only.

## Metadata and discovery

Metadata is additive and request-controlled. It is meant to give client applications useful evidence, not to claim perfect equipment detection in every station.

Useful metadata includes:

- parent and ancestor summaries
- Niagara type and classification flags
- driver network, device, proxy, and point-device evidence
- point evidence such as writable state, proxy extension, history extension, and alarm extension
- tags and relations when available
- compact write, schedule, history, and alarm hints

Recommended pattern:

1. Cache discovered nodes in your application with `ord`, `slotPath`, parent, type, features, operations, and metadata evidence.
2. Treat deterministic Niagara types such as devices and control points as strong evidence.
3. Treat equipment grouping as app-side logic unless the station has tags, relations, or manual mappings that prove it.
4. Use `subscribe_model` as a hint that cached structure may need refresh.
5. Support manual review and correction in the external app for large or inconsistent sites.

## Live values and scale

For graphics and UI apps, avoid subscribing to every discovered point forever. Keep discovered equipment and point metadata cached, then subscribe only to points that are actively needed by the current view.

A practical pattern is:

1. Initial app load: discover and cache station structure.
2. Graphic open: call `replace_subscriptions` with the points shown on that graphic.
3. Graphic stays open: renew the subscription lease as needed.
4. Graphic close: call `release_subscriptions`.
5. Socket close or client crash: server-side connection cleanup and leases release orphaned subscriptions.

For alarms, use `subscribe_alarms` when the app needs global alarm awareness. On large stations, prefer event mode, maintain a client-side alarm map keyed by alarm UUID, and call `read_alarms` only for initial load or resync.

When the station sends `resync_required`, re-read whatever the client shows. The SDK's `watch()` does this for you.

Tested at bench scale against a BACnet simulator: about 32 VAVs plus AHUs and hot- and chilled-water plants.

## Python test tools

The Python tools under `tools/python-tools/tools/python/` are standalone read-only helpers for bench testing and client experiments. They reuse the same station contract as other clients: Niagara web login, `/stream/health`, then MessagePack WebSocket calls to `/stream`.

Setup from the Python tools folder:

```bash
cd tools/python-tools/tools/python
python3 -m pip install -r requirements.txt
```

Useful commands:

```bash
python3 baskstream_smoke.py --station https://<station> --user <user> --ask-pass --root 'slot:/Drivers'
python3 baskstream_cli.py --station https://<station> --user <user> --ask-pass health
python3 baskstream_cli.py --station https://<station> --user <user> --ask-pass tree --base 'slot:/Drivers' --depth 3
python3 baskstream_cli.py --station https://<station> --user <user> --ask-pass values --base 'slot:/Drivers/.../points'
```

For local/self-signed stations, the tools default to TLS verification off. Use `--verify-tls` only when the station certificate is trusted by the client machine. See [tools/python-tools/README.md](tools/python-tools/README.md) for platform-specific examples and PowerShell ORD quoting notes.

## AI tooling: MCP server

The MCP server under `tools/mcp/` is optional AI-client tooling. It does not replace the Niagara module, the WebSocket protocol, the companion app, or a production graphics/dashboard client. It wraps the same station contract used everywhere else: Niagara login, `/stream/health`, then MessagePack WebSocket calls to `/stream`.

Use the MCP when an AI client should inspect a station, summarize equipment, read live values, review histories/schedules/alarms, or perform explicitly enabled point writes. Use the WebSocket protocol directly for production apps that need persistent UI sessions or long-lived COV subscriptions.

Setup:

```bash
cd tools/mcp
npm run setup
```

`npm run setup` installs dependencies, handles mounted/shared filesystem npm issues, builds the server, and verifies local MCP startup.

Windows-first install guides and client-specific examples are in [tools/mcp/INSTALL.md](tools/mcp/INSTALL.md) and [tools/mcp/CLIENTS.md](tools/mcp/CLIENTS.md). Those guides cover generic MCP JSON, Claude Code, Claude Desktop/MCPB, Codex plugin, Claude Code plugin, Hermes, VS Code, Cursor, Windsurf/Cascade, Cline, and Augment. The companion app Guide tab also generates ready-to-copy setup commands and config snippets.

Keep Niagara credentials in local MCP client settings, environment variables, or ignored `tools/mcp/config.json`; do not commit them. The MCP defaults to read-oriented discovery, diagnostics, values, histories, schedules, alarms, inventory, and summary tools. Point writes require `BASKSTREAM_ALLOW_WRITES=true`; alarm acknowledge/clear requires `BASKSTREAM_ALLOW_ALARM_ACTIONS=true`. Niagara permissions still apply, so use a least-privilege station user.

The raw operation tool is hidden unless the MCP server starts with `BASKSTREAM_ALLOW_RAW=true`. Leave it off for normal installs and public distribution.

Recommended AI-client workflow:

1. Run diagnostics and `capabilities`.
2. Browse/search shallowly before deep metadata requests.
3. Read current values with `read`.
4. For writes, call `describe_write` first and only expose actions that response reports as supported.
5. Enable point writes or alarm actions only through explicit local MCP settings.
6. Do not paste Niagara internals, Tridium docs, license files, keys, security reports, or benchmark results into AI prompts.

See [tools/mcp/README.md](tools/mcp/README.md) for the full tool list and inspector workflow.

## Network and security

Common blockers for real deployments:

- The client must reach the Niagara web port.
- Firewalls and proxies must allow WebSocket upgrade traffic to `/stream`.
- Browser clients must trust the station HTTPS certificate, or development must explicitly allow the self-signed certificate.
- Reverse proxies must preserve cookies, TLS behavior, and `Upgrade: websocket` headers.
- Niagara user permissions still apply. Use a least-privilege user for external apps.
- Corporate VPNs, SSL inspection, and gateway timeouts can interrupt long-lived WebSocket sessions.

### Settings worth reviewing before deployment

Niagara user permissions are the main access control. Every integration should have a dedicated, least-privilege station user. `allowedPathPatterns` adds another boundary, but its default, `slot:/*`, is intentionally broad for backward compatibility. Narrow it to the parts of the station an integration actually needs.

Non-browser clients such as Grafana, the Python tools, and server-to-server integrations may omit the `Origin` header. baskStream allows that by default. Browser clients that send an origin are checked against the station origin and `allowedOrigins`. If every client in a deployment sends an origin, `rejectMissingOrigin` can make that check strict.

The remaining hardening settings are opt-in so existing clients keep working. `requireAuthorizationHeader` rejects cookie-only WebSocket upgrades, `revalidateIntervalSec` periodically checks long-lived sessions, and `maxConnectionsPerUser` limits one Niagara account's open sockets. Check client compatibility before enabling them. `maxMessageBytes` defaults to 1 MiB.

After a point write, baskStream waits for `writeSettleMillis` before reading the point back. The default is 150 ms. Lower it only when the target points settle faster and the shorter response time matters.

## Companion guide and demo app

The companion app is:

```text
tools/baskstream-nav-tree.html
```

It has two tabs:

- `Guide`: startup checklist, module, companion app, Python tools, optional MCP/client setup generator, scale, network/security, and operation-reference guidance.
- `Test Console`: connect to a live station, browse the station tree, inspect metadata, read selected point values, and subscribe to the selected point.

The app is intentionally standalone HTML/CSS/JS. There is no npm install, bundler, or app server requirement.

For best results, run the local helper:

```bash
node tools/baskstream-nav-tree-server.mjs --port=8787
```

Then open:

```text
http://127.0.0.1:8787/
```

The helper exists so the standalone browser app can test stations with local credentials, self-signed certificates, and WebSocket proxying. Production apps should implement their own Niagara login flow, certificate trust model, and MessagePack WebSocket client.

You can also open the HTML file directly, but browser security rules may block direct station login or self-signed station requests from `file://`.

## Demo app test flow

1. Start the helper with `node tools/baskstream-nav-tree-server.mjs --port=8787`.
2. Open `http://127.0.0.1:8787/`.
3. Enter the station URL, username, password, and root ORD.
4. Click `Connect`.
5. Confirm the Station API panel reports the API version and connection/subscription state.
6. Use `Current Root`, `Drivers`, or `Schedules` to browse station roots.
7. Expand tree nodes to browse children.
8. Select points to see basics, metadata, live value snapshots, and subscription state.
9. Use `Capabilities` and `Subscription Status` for diagnostics.

The demo app is not intended to be a production UI. It is a companion test tool and implementation reference for third-party clients.

## Development notes

- The person compiling/deploying the module should run the real Niagara build and station validation.
- Local checks can verify JavaScript syntax and helper scripts, but they do not replace a Niagara compile or station test.
- `baskStream-rt/DEVELOPMENT-NOTES.md` captures implementation notes and follow-up candidates.
- `docs/THIRD_PARTY_API.md` is the source of truth for request/response examples and schema details.
