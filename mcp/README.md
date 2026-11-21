# baskStream MCP server

An MCP server for one Niagara 4 station running the baskStream module (`BASkStreamService`), so Claude and other MCP clients can find, read and command points, read history, alarms and schedules, and see Px pages. It is a thin layer over the [TypeScript SDK](../sdk/README.md) and is packed as a Claude Desktop Extension (`baskStream.mcpb`).

It always declares itself an AI agent, so the station's [agent rules](../docs/AI_AGENTS.md) apply: changes need a reason, and point writes can become proposals a person approves in Workbench or `bask`.

## Set up

1. **On the station:** create a Niagara user for the agent (for example `ai-claude`) with a role covering only what it should touch, and list it in `agentUsers` on `BASkStreamService`. Its approval, reason, rate and bound settings then apply to everything the agent does.
2. **Build the extension** (see [Develop](#develop)): `dist/baskStream.mcpb`.
3. **In the Claude desktop app:** open `dist/baskStream.mcpb` (or Settings → Extensions → Install Extension), then fill in its settings:
   - the station address, e.g. `https://192.168.0.126`
   - that user
   - its password (kept in the keychain)
   - Allow self-signed certificate
4. **Check it:** in a new session, ask Claude for `station_status`.

A new build installs over the old one; the version is `package.json`'s.

## Tools

- **Reads**, marked read-only: `station_status`, `find_points`, `browse`, `describe_point`, `read_points`, `watch_points` (a long poll, for callers that can only poll), `point_history`, `list_alarms`, `read_schedule`, `list_proposals`, `read_agent_log`.
  - **`station_status`:** asks the station for its agent rules each time, so it shows a change to approval right away.
  - **`read_points`:** a driver polls a proxy point only while something subscribes to it, so a snapshot of an unpolled point comes back stale. `read_points` then subscribes it and waits up to 3 s for the first poll, and marks those values `fresh: true`. The point stays polled for two minutes.
- **Seeing a page:** `px_snapshot` returns pictures of a Px page (`^folder/Page.px`, or a component and its view) as a web browser shows it, with live values, plus the page's title, HTTP status, failed requests and console errors. It opens the page in headless Chrome, Chromium or Edge on the computer running the server, with the server's station session (the SDK's [`snapshot()`](../sdk/README.md#seeing-a-page)), and needs one of them installed (`BASKSTREAM_BROWSER` picks one). Only what fits in the window (default 1600 × 900) is pictured, and Workbench can draw a page differently.
- **Changes**, each with a required reason: `write_points`, `ack_alarms`, `clear_alarms`, `write_schedule`.
- **What agents changed:** `list_changes` lists the changes agents asked for or made, with what the station found when it looked again (baskStream API 1.14).
- **By meaning:** `resolve_point` finds the point that plays a role on a piece of equipment (API 1.14).
- **Everything else:** `baskstream_call` runs any protocol operation.

A change the station keeps for a person instead of making (API 1.14) comes back as a result with `outcome: "proposed"` and the proposal, not as an error.

The server declares itself an agent on API 1.8 stations and later, under the MCP client's name, so a write can come back `proposed`.

**Artifact pages:** a page you own in the Claude desktop app can call these tools through the app as `host:baskStream`, declaring `capabilities: {mcp: {servers: [{server: "host:baskStream", tools: [...]}]}}`. A page can't open a socket itself, and only the app's own servers qualify, which is why this is a Desktop Extension. Desktop Extensions also show up in the app's Code sessions, so one install serves both.

## Settings

The extension's settings arrive as environment variables; the server also runs without the desktop app:

| Variable | Meaning |
|---|---|
| `BASKSTREAM_STATION`, `BASKSTREAM_USERNAME`, `BASKSTREAM_PASSWORD` | The station and the Niagara user it acts as |
| `BASKSTREAM_INSECURE` | `true` to accept a self-signed certificate |
| `BASKSTREAM_PROFILE` | Without `BASKSTREAM_STATION`: the saved `bask login` profile to use (default `bask`'s current one); `BASKSTREAM_PASSWORD` then logs in again when the session expires |
| `BASKSTREAM_MODEL` | The model name declared to the station with the agent |
| `BASKSTREAM_BROWSER` | The Chrome, Chromium or Edge program `px_snapshot` uses |

**In terminal Claude Code:** after `bask login <station> -u <user>`, add it with `claude mcp add baskstream -- node <this folder>/dist/baskstream/server/index.mjs`, and it uses `bask`'s current profile.

## Remote: claude.ai custom connectors

claude.ai custom connectors run in Anthropic's cloud. They can't start the extension, and they can't reach a station on a private network. With `--http`, the same server speaks MCP's Streamable HTTP at `/mcp`. Run it on any machine that reaches the station, and put a tunnel in front of it. The station stays private; only the server is exposed.

1. **On the station first:** turn on approval for the agent user on `BASkStreamService`, so a remote assistant's writes become proposals a person approves. A read-only role is safer still.
2. **Keep the secrets in the keychain** (on a Mac), so they stay out of shell history. The first command prompts for the agent user's password; the second makes the access token every request must carry:

   ```bash
   security add-generic-password -s baskstream -a ai-claude -w
   security add-generic-password -s baskstream-http -a token -w "$(openssl rand -hex 32)"
   ```

   `security find-generic-password -s baskstream-http -w` shows the token again when you add the connector.
3. **Start it:**

   ```bash
   BASKSTREAM_HTTP_TOKEN="$(security find-generic-password -s baskstream-http -w)" \
   BASKSTREAM_PASSWORD="$(security find-generic-password -s baskstream -a ai-claude -w)" \
   BASKSTREAM_STATION=https://192.168.0.126 BASKSTREAM_USERNAME=ai-claude BASKSTREAM_INSECURE=true \
   node dist/baskstream/server/index.mjs --http
   ```

   It listens on `127.0.0.1:8787` by default; `BASKSTREAM_HTTP_PORT` and `BASKSTREAM_HTTP_HOST` change that. It won't start without a token of at least 32 characters. Without `BASKSTREAM_STATION`, it uses `bask`'s current profile, as the stdio server does. If it can't reach the station (`EHOSTUNREACH`) though the station answers `ping`, allow your terminal app under Privacy & Security → Local Network.
4. **Tunnel it:** `cloudflared tunnel --url http://127.0.0.1:8787` prints a public `https://….trycloudflare.com` address that changes on each run. A named Cloudflare tunnel or Tailscale Funnel keeps the address fixed.
5. **Add the connector:** in claude.ai, Customize → Connectors → **+** → custom connector, with the URL `https://<tunnel>/mcp` and the request header `Authorization: Bearer <token>`. If a client can't send headers, use `https://<tunnel>/mcp/<token>` instead. A token in the URL can turn up in logs, so prefer the header.

The HTTP server keeps no sessions: each request gets a fresh MCP server, and all of them share one station connection. The station knows the agent by the name of the first client that connects.

## Develop

The tests use the SDK's fake station and its build, so set up the SDK first:

```bash
cd ../sdk && npm ci && npm run build
```

Then, here:

```bash
npm ci
```

```bash
npm test
```

`npm test` builds the extension (`node build.mjs`, which bundles the SDK from `../sdk/src` and checks the bundle starts and lists its tools), then runs `test/` against the fake station:

- **`agent.test.mjs`:** the agent declaration and proposals.
- **`http.test.mjs`:** the `--http` mode: token checks, the same tools as over stdio, one shared station connection.
- **`snapshot.test.mjs`:** `px_snapshot` returns the picture as an image with the page's details. The picture tests are skipped without Chrome, Chromium or Edge.

Bump `version` in `package.json` before building a release, then install the new `.mcpb`.
