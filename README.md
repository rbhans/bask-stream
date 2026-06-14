# baskStream

baskStream is a Niagara 4 runtime module that exposes station data through an authenticated WebSocket API. The goal is to give external applications a practical live-data path for graphics, dashboards, commissioning tools, and integrations without forcing every app to live inside Niagara UI.

The API is designed around Niagara's object model and permissions. It can browse station structure, read and subscribe to point values, write writable points, read alarms, subscribe to alarm changes, inspect schedules, read histories, and expose metadata that helps an app understand devices, points, parent objects, and evidence for equipment classification.

For the full protocol reference, see [docs/THIRD_PARTY_API.md](docs/THIRD_PARTY_API.md).

## Repository Layout

```text
baskStream-rt/                 Niagara runtime module source
docs/THIRD_PARTY_API.md          Detailed WebSocket protocol guide
tools/baskstream-nav-tree.html Companion guide and demo/test app
tools/baskstream-nav-tree-server.mjs
                                 Local helper for the companion app
tools/baskstream-live-smoke.mjs
                                 Live station smoke test script
tools/baskstream-test.html     Lower-level standalone test harness
tools/baskstream-test-snippet.js
                                 Browser-console station-page test snippet
```

Build artifacts, generated jars, screenshots, local editor settings, and macOS AppleDouble sidecar files are intentionally ignored.

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

- `Guide`: quick setup, app-flow, scale, network/security, and operation-reference guidance.
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
