# bask

Command line and terminal dashboard for baskStream on Niagara 4 stations.

## Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.ps1 | iex
```

This downloads a single executable from the latest `bask-v*` [release](https://github.com/rbhans/bask-stream/releases), checks it against the release's `SHA256SUMS`, and puts it in `~/.local/bin` (Windows: `%LOCALAPPDATA%\Programs\bask`, added to your user PATH). No Node needed. Set `BASK_VERSION` for a specific version or `BASK_INSTALL_DIR` for another folder. To uninstall, delete that file and `~/.config/baskstream` (Windows: `%APPDATA%\baskstream`).

## Use

```bash
bask login https://192.168.0.126 -u test --insecure   # asks for the password; saves only the session
bask                                                   # the dashboard: every view in one window
bask workspace                                         # a multi-pane workspace in Rex or tmux, with an AI agent
bask fleet                                             # every saved station at once
bask demo                                              # try it on a built-in simulated building, no station needed
```

## Dashboard

Ten views, switched with `1`–`0` or `tab`:

| | View | What you do there |
|---|---|---|
| `1` | Home | Station, link and traffic; open alarms; what AI agents did and what is waiting for you; the watch list |
| `2` | Explorer | The station tree with live point values. Details and a property sheet for the selected component. Command points, edit properties, invoke actions, rename, delete, add components, start a discovery |
| `3` | Watch | Live values with sparklines. The list is saved and shared with other bask windows on the station |
| `4` | Alarms | Open alarms, live. Filter, see details, acknowledge, jump to the source |
| `5` | Trends | A line chart of a point's history; zoom, pan, follow live |
| `6` | Schedules | Each schedule's week, what it outputs now and what is coming up |
| `7` | Query | BQL and tag (NEQL) queries, with ready-made reports: points in alarm, overridden, down, devices, histories and more. Save results as CSV |
| `8` | Files | The station's file space: browse, preview, edit in your editor, upload, save a copy, delete |
| `9` | Jobs | Station jobs. Run BACnet discovery and add the devices or points it finds |
| `0` | AI Activity | What AI agents did and why, from the station's audit history, and their proposals for you to approve or reject |

Everywhere: `/` finds a point or component by name, `:` (or `ctrl+k`) opens every command, `?` shows the keys for the current view, `q` quits. The mouse works too: click a tab or a row, scroll with the wheel (`--no-mouse` leaves the mouse to the terminal).

The dashboard starts read-only. Press `W` (or start with `--allow-writes`) to allow changes; each one still asks before it is sent. Edits to components go through a model plan that is previewed first.

Colours follow the terminal: bask asks it whether it is light or dark as it starts, and uses dark when there is no answer. Force one with `--theme dark|light` or `BASK_THEME`.

## Several stations at once

`bask fleet` connects to every saved station (or the profiles you name) and shows a card for each: its link, unacknowledged and open alarms, what the AI is waiting on or did last, and the first points on its watch list, live. Underneath, the newest alarms from all stations in one list. `⏎` or a number opens a station's full dashboard; `q` there comes back. A station whose saved login has expired says so on its card, with the `bask login` command to run.

## Demo buildings

`bask demo` needs no station. There are four simulated buildings, each with its own equipment, alarms, schedules, files and AI agent history, and each keeps changing while it runs:

| `--site` | Station | What it is |
|---|---|---|
| `northgate` (default) | Northgate | An office: two air handlers, eight VAV boxes, a chilled water plant |
| `riverside` | Riverside | A surgery center: operating rooms, isolation rooms, a boiler plant, medical gas |
| `harbor` | Harbor | Cold storage: freezers, coolers, a compressor rack, dock doors, a Modbus power meter |
| `summit` | Summit | A data hall: CRAC units, hot and cold aisles, chillers, UPS and PDUs over SNMP |

```bash
bask demo --site harbor              # one building's dashboard
bask demo --fleet                    # all four in the all-stations view (same as bask fleet --demo)
bask workspace --demo --site summit  # a workspace on one building
bask workspace --demo --site all     # a Rex or tmux session per building
```

Each site is saved as a profile (`demo`, `demo-riverside`, `demo-harbor`, `demo-summit`) on its own local port, so every other `bask` command works on it too. The first window to open a site hosts its station; closing that window stops it.

## Symbols

`bask symbols` opens the terminal symbol library: equipment drawn in text, with moving parts and status colours. Fans turn, coils pulse with flow, flames flicker, water falls through a tower, and everything stops when it is off, faulted or unreachable.

- **Air handling:** airflow, louver, damper, filter, cooling and heating coils, electric heater, fan, humidifier, duct sensor, VAV box. These are five rows tall and join side by side into one casing.
- **Water and plant:** pump, valve, chiller, boiler, cooling tower, heat exchanger, tank.
- **Refrigeration and critical rooms:** compressor, cold room, CRAC unit, server rack.
- **Power:** UPS battery, generator.
- **Indicators:** value plate, bar gauge, thermometer, status light, alarm marker.

In the gallery, the arrow keys choose a symbol and `s` (status), `[` `]` (value), `p` (start/stop), `m` (medium), `f` (direction) and `o` (door) try its states. `tab` shows two example assemblies: an air handler with its coil piping, and a chilled water plant joined by pipes with flow marks. `bask symbols --list` prints the ids and sizes.

The library is in `src/tui/symbols`: `library.ts` (the symbols), `canvas.ts` (a grid to place them on, with pipes and ducts that join where they meet) and `examples.ts`. It does not read a station yet; binding symbols to live points is the next step.

## Workspace

`bask workspace` lays out a station workspace in Rex (Superlogical's terminal multiplexer) or tmux: an Explorer, Alarms and AI Activity pane, and an AI agent session (Claude Code by default) that works on the station through `bask`.

```bash
bask workspace                      # Explorer · Alarms · AI Activity · Claude Code
bask workspace --no-agent           # Explorer · Watch · Alarms · AI Activity
bask workspace --layout monitor     # Home · Alarms · Watch · AI Activity
bask workspace --layout duo         # the full dashboard beside the agent
bask workspace --demo               # the same on a simulated building (--site to choose)
bask workspace --dry-run            # print what would be started
```

It uses the multiplexer the terminal is already in, else Rex, else tmux (`--mux rex|tmux` to choose). Each pane is `bask tui --view <name> --pane`: one view, no tab row, though `1`–`0` still switch.

**Panes work together.** They share the watch list, so `w` in the Explorer pane adds a row to the Watch pane. `t` (trend) and `e` (show in the Explorer) go to the pane that shows that view when there is one. `bask show <ord>`, `bask show --trend <ord>` and `bask show --watch <ord>` do the same from any shell, which is how the agent points at things for you.

**MCP tools in terminal Claude Code.** The baskStream extension for the Claude desktop app is an MCP server, and it can read a saved `bask` profile. Registered once like this, terminal Claude Code gets the same `baskStream` tools, on the workspace's station inside a workspace pane and on the profile named `ai` anywhere else:

```bash
claude mcp add --scope user baskStream -e 'BASKSTREAM_PROFILE=${BASKSTREAM_PROFILE:-ai}' -e 'BASKSTREAM_PASSWORD=${BASKSTREAM_PASSWORD:-}' -- node "<the extension's folder>/server/index.mjs"
```

On macOS the folder is `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.basidekick.baskstream`. The profile is the agent's login: `bask login <station> -u <the AI's Niagara user> --name ai`.

**The agent** starts with a briefing on the station and how to use `bask` (`bask agent-brief` prints it). It connects with `--agent-profile <name>`, or a saved profile for the same station whose name or user says agent or ai, or else your own profile. Give it its own Niagara user and list that user in the service's agent users: then its writes become proposals in the AI Activity pane, every change carries its reason, and the audit history shows which changes were its own. Another agent: `--agent "<command>"`; it finds the briefing at `$BASK_STATION_BRIEF`.

## Commands

| Command | |
|---|---|
| `bask login <station> -u <user> [--insecure] [--name <profile>]` | Log in and save a profile |
| `bask profiles` · `bask use <profile>` · `bask logout [--remove]` | Manage saved stations |
| `bask doctor [station]` | Step-by-step connection check (reachable, certificate, login page, session, service, WebSocket) with a fix for whatever fails |
| `bask status` | Station, user, limits, traffic |
| `bask browse [ord] [-d depth]` · `bask search <text> [--kind point]` | Explore |
| `bask read <ords...>` | Current values |
| `bask watch <ords...> [--plain]` | Live values (dashboard, or one line per change) |
| `bask history <ord> [--since 7d] [--until now] [--rollup 1h]` | Records or rollups |
| `bask alarms [--scope open] [--class c] [--unacked] [-f]` | Alarms, newest first; `-f` follows |
| `bask ack\|clear <uuids...>` or `--class/--unacked/--since` | Needs `--allow-writes`; confirms; `--dry-run` previews |
| `bask write <ord> <set\|override\|auto\|emergency_override\|emergency_auto> [value] [--for 30m]` | Needs `--allow-writes`; confirms |
| `bask schedule <ord> [--days 7]` | Current output and upcoming changes |
| `bask call <op> '<json>'` | Any operation (gated ones need `--allow-writes`) |
| `bask query "<bql>"` · `bask query --neql "<tags>" [--base ord] [--limit n]` | A BQL select or a NEQL tag query |
| `bask files [path]` · `bask cat <path> [--out file]` | List and read the station's files (`^px/Home.px`) |
| `bask put <file> <path> [--overwrite]` · `bask rm <path> [--recursive]` | Upload or delete station files; needs `--allow-writes`; confirms |
| `bask jobs` · `bask job <ord> [--cancel]` | Station jobs; one job's state, log and results |
| `bask discover <network\|device> [--no-wait]` | BACnet discovery: devices on a network, or a device's points; needs `--allow-writes` |
| `bask add <job> <slots...\|all> [--parent ord] [--apply]` | Plan for adding discovered devices or points; `--apply` adds them (needs `--allow-writes`) |
| `bask proposals [--all]` · `bask approve <id>` · `bask reject <id> [--note]` | AI agent proposals waiting for a person; approving runs the write with your permissions (needs `--allow-writes`) |
| `bask agent-log [--since 24h]` | What AI agents did, from the station's audit history |
| `bask metrics` | OpenMetrics text |
| `bask tui [--view <name>] [--pane] [--no-mouse] [--theme dark\|light]` | The dashboard (also what `bask` alone runs), opened on a view |
| `bask workspace [--layout ops\|monitor\|duo] [--mux rex\|tmux] [--agent <cmd>\|--no-agent] [--agent-profile <name>] [--demo] [--dry-run]` | A multi-pane station workspace in Rex or tmux |
| `bask show <ord> [--trend] [--watch]` | Select an ORD in the open Explorer, chart it, or add it to the watch list |
| `bask agent-brief` | The briefing an AI agent gets on working with this station |
| `bask symbols [--list]` | The terminal symbol library: animated equipment drawn in text, with example assemblies |
| `bask fleet [profiles...] [--demo]` | Every saved station at once: alarms, AI activity and live values per station, and all alarms in one list |
| `bask demo [--site <name>] [--fleet] [--list] [--view <name>] [--serve]` | The dashboard on a simulated building; `--serve` only runs the station |

`-o json` or `-o csv` on any listing command; `-p <profile>` picks a station. ORDs may drop the `slot:/` prefix.

- Profiles live in `~/.config/baskstream/profiles.json` (mode 0600; `BASKSTREAM_CONFIG_DIR` overrides). The password is never saved: it is prompted, or read from `BASKSTREAM_PASSWORD` if you set it.
- `--insecure` accepts a self-signed station certificate.
- **AI agents:** an agent running bask declares itself with `--agent <name>` (plus `--model`, `--on-behalf-of`), or the `BASK_AGENT`, `BASK_MODEL` and `BASK_ON_BEHALF_OF` environment variables, and gives `--reason "…"` with changes. While the station requires approval, `bask write` reports "Proposed P7" instead of writing. See `docs/AI_AGENTS.md`.

## Build

```bash
npm install
npm test
npm run compile
```

To publish a release, bump `version` in `package.json`, commit, and push a matching tag (`git tag bask-v0.1.0 && git push origin bask-v0.1.0`). The [release workflow](../.github/workflows/release-bask.yml) tests, builds Windows/macOS/Linux executables, and attaches them with checksums.

`node test/peek.mjs --view explorer --size 120x36 --keys "down,right"` prints one frame of the dashboard on the demo station (add `--profile <name>` for a real one), which is the quick way to look at a change. Rendering and input notes are in [DEVELOPMENT-NOTES.md](DEVELOPMENT-NOTES.md).

`npm run compile` produces a single executable `bin/bask` with Bun (about 60 MB, no Node needed). For another platform: `bun scripts/compile.mjs --target=bun-windows-x64 --outfile=bin/bask.exe` (or `bun-linux-x64`, `bun-darwin-arm64`).
