# baskStream

baskStream is a Niagara 4 runtime module that exposes station data through an authenticated WebSocket API. The goal is to give external applications a practical live-data path for graphics, dashboards, commissioning tools, and integrations without forcing every app to live inside Niagara UI.

The API is designed around Niagara's object model and permissions. It can browse station structure, read and subscribe to point values, write writable points, read alarms, subscribe to alarm changes, inspect schedules, read histories, and expose metadata that helps an app understand devices, points, parent objects, and evidence for equipment classification.

For the full protocol reference, see [docs/THIRD_PARTY_API.md](docs/THIRD_PARTY_API.md).

This project is not affiliated with, endorsed by, or sponsored by Tridium, Honeywell, Anthropic, OpenAI, or any AI-client vendor. Use it only with Niagara stations and software licenses you are authorized to access and administer.

The repository's own code and documentation are open source under the [Apache License 2.0](LICENSE). That license does not grant rights to Niagara Framework, Tridium/Honeywell software, product documentation, license keys, services, marks, or customer systems.

## Current API Highlights

- Current protocol examples target API version `1.3`.
- `read` is the batch point snapshot operation for point/value ORDs.
- Point snapshots can include facets, enum metadata, status, timestamps, display values, and raw values.
- Clients can pass `fields` to `read` for lean point tables; `point` and `ok` are always returned.
- `capabilities` advertises point snapshot limits and supported snapshot fields through `pointSnapshot`.
- Plain Px/graphic embedding is not implemented yet; `capabilities.graphics.plainPx` and `plainGraphic` report `false`.

## What To Use When

| Surface | Use it for | Start here |
| --- | --- | --- |
| Niagara module | The actual station runtime API. Install this when another app needs authenticated WebSocket access to live station data. | [Station Setup](#station-setup) |
| Companion app | Human-guided startup, live station testing, API inspection, and generated setup snippets for external tools. | [Companion Guide And Demo App](#companion-guide-and-demo-app) |
| WebSocket protocol | Production apps, graphics, dashboards, and integrations that should talk directly to the station. | [docs/THIRD_PARTY_API.md](docs/THIRD_PARTY_API.md) |
| Integration direction | Compatibility rules and the future adapter strategy for Grafana, REST, OpenMetrics, and exporters. | [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| Python tools | Bench tests, quick station checks, and scripting experiments. | [Python Test Tools](#python-test-tools) |
| MCP server | Optional local bridge for AI clients and agent workflows. It is tooling around the module, not the primary runtime surface. | [AI Tooling: MCP Server](#ai-tooling-mcp-server) |

## Grafana Integration

The first product integration is a read-only Grafana backend data source at [integrations/grafana/basidekick-baskstream-datasource](integrations/grafana/basidekick-baskstream-datasource). It connects Grafana directly to a Niagara station running baskStream:

```text
Grafana panel -> BaskStream data source -> Niagara login -> /stream/health -> /stream WebSocket
```

It does not require a Niagara module API change. The plugin uses the existing `/stream` operations for point search, current values, histories, and live COV updates.

Quick path:

1. Install and enable the baskStream runtime module on the Niagara station.
2. Create a least-privilege Niagara user for Grafana.
3. Build and sign the Grafana plugin from `integrations/grafana/basidekick-baskstream-datasource`.
4. Install the signed plugin into Grafana's plugin directory and restart Grafana.
5. Add the `BaskStream` data source in Grafana.
6. Use `History`, `Snapshot`, or `Live` query mode in panels.

For private signed installs, the Grafana root URL used during signing must exactly match Grafana's configured `server.root_url`. See [integrations/grafana/basidekick-baskstream-datasource/INSTALL.md](integrations/grafana/basidekick-baskstream-datasource/INSTALL.md).

## Repository Layout

```text
baskStream-rt/                   Niagara runtime module source
LICENSE                          Apache License 2.0 for this repository's code
docs/THIRD_PARTY_API.md          Detailed WebSocket protocol guide
docs/INTEGRATIONS.md             Integration adapter direction and compatibility rules
docs/LEGAL_AND_SAFETY.md         EULA, AI-tool, and distribution checklist
docs/PRIVACY.md                  Local data-handling notes
docs/TERMS.md                    Open-source terms and third-party boundaries
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
```

Build artifacts, generated jars, screenshots, local editor settings, and macOS AppleDouble sidecar files are intentionally ignored.

## Legal And AI Tool Boundary

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

## Station Setup

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

## Client Flow

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

## Core Operations

| Need | Operation | Use |
| --- | --- | --- |
| Verify API | `ping`, `capabilities` | Confirm connection and discover supported features, limits, and schema versions. |
| Discover station tree | `browse`, `describe`, `search` | Build equipment, point, schedule, history, and metadata views. |
| Read live values | `read` | Fetch current point snapshots with value, display value, status, timestamp, and facets. |
| Subscribe to graphic values | `replace_subscriptions`, `renew_subscriptions`, `release_subscriptions` | Keep live COV data scoped to the active view and let the server manage diffing and leases. |
| Simple point watches | `subscribe`, `unsubscribe` | Use for simple clients or long-lived manual watches. |
| Write points | `describe_write`, `write` | Render safe controls, then set, override, auto, or emergency override writable points. |
| Alarms | `read_alarms`, `ack_alarm`, `clear_alarm`, `subscribe_alarms`, `unsubscribe_alarms` | Load bounded snapshots, acknowledge or force-clear records, and maintain client alarm state with event pushes. |
| Schedules | `read_schedule` | Read Niagara schedule state and schedule data for UI display. |
| Histories | `describe_history`, `read_history` | Detect trend availability and load chart records by time range. |
| Model changes | `subscribe_model`, `unsubscribe_model` | Receive branch-scoped structure-change hints, then refresh affected nodes. |
| Diagnostics | `subscription_status` | Inspect active point subscriptions, groups, leases, and counts. |

## Metadata And Discovery

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

## Live Values And Scale

For graphics and UI apps, avoid subscribing to every discovered point forever. Keep discovered equipment and point metadata cached, then subscribe only to points that are actively needed by the current view.

A practical pattern is:

1. Initial app load: discover and cache station structure.
2. Graphic open: call `replace_subscriptions` with the points shown on that graphic.
3. Graphic stays open: renew the subscription lease as needed.
4. Graphic close: call `release_subscriptions`.
5. Socket close or client crash: server-side connection cleanup and leases release orphaned subscriptions.

For alarms, use `subscribe_alarms` when the app needs global alarm awareness. On large stations, prefer event mode, maintain a client-side alarm map keyed by alarm UUID, and call `read_alarms` only for initial load or resync.

## Python Test Tools

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

## AI Tooling: MCP Server

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

## Network And Security

Common blockers for real deployments:

- The client must reach the Niagara web port.
- Firewalls and proxies must allow WebSocket upgrade traffic to `/stream`.
- Browser clients must trust the station HTTPS certificate, or development must explicitly allow the self-signed certificate.
- Reverse proxies must preserve cookies, TLS behavior, and `Upgrade: websocket` headers.
- Niagara user permissions still apply. Use a least-privilege user for external apps.
- Corporate VPNs, SSL inspection, and gateway timeouts can interrupt long-lived WebSocket sessions.

## Companion Guide And Demo App

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

## Demo App Test Flow

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

## Development Notes

- The person compiling/deploying the module should run the real Niagara build and station validation.
- Local checks can verify JavaScript syntax and helper scripts, but they do not replace a Niagara compile or station test.
- `baskStream-rt/DEVELOPMENT-NOTES.md` captures implementation notes and follow-up candidates.
- `docs/THIRD_PARTY_API.md` is the source of truth for request/response examples and schema details.
