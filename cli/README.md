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

Eleven views, switched with `1`–`0`, `g` or `tab`:

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
| `g` | Graphics | Drawings of the station's equipment, moving, with live values. Pick a part to trend, watch or command its point |

Everywhere: `/` finds a point or component by name, `:` (or `ctrl+k`) opens every command, `?` shows the keys for the current view, `q` quits. The mouse works too: click a tab or a row, scroll with the wheel (`--no-mouse` leaves the mouse to the terminal).

The dashboard starts read-only. Press `W` (or start with `--allow-writes`) to allow changes; each one still asks before it is sent. Edits to components go through a model plan that is previewed first.

Colours follow the terminal: bask asks it whether it is light or dark as it starts, and uses dark when there is no answer. Force one with `--theme dark|light` or `BASK_THEME`.

## Several stations at once

`bask fleet` connects to every saved station (or the profiles you name) and shows a card for each: its link, unacknowledged and open alarms, what the AI is waiting on or did last, and the first points on its watch list, live. Underneath, the newest alarms from all stations in one list. `⏎` or a number opens a station's full dashboard; `q` there comes back. A station whose saved login has expired says so on its card, with the `bask login` command to run.

## Demo buildings

`bask demo` needs no station. There are five simulated buildings, each with its own equipment, alarms, schedules, files and AI agent history, and each keeps changing while it runs. They start in different states, so there is one to look at and two to work on:

| `--site` | Station | What it is | How it starts |
|---|---|---|---|
| `northgate` (default) | Northgate | An office: two air handlers, eight VAV boxes, a chilled water plant | Finished: a graphic for every piece of equipment (12) |
| `riverside` | Riverside | A surgery center: operating rooms, isolation rooms, a boiler plant, medical gas | Part done: two graphics |
| `harbor` | Harbor | Cold storage: freezers, coolers, a compressor rack, dock doors, a Modbus power meter | Nothing drawn: have the agent draw it |
| `summit` | Summit | A data hall: CRAC units, hot and cold aisles, chillers, UPS and PDUs over SNMP | Part done: two graphics |
| `eastgate` | Eastgate | A new office station: four air handlers, 32 VAV boxes, a chilled water and a heating water plant | Nothing added: the BACnet network is empty, and discovery finds 46 controllers with 614 points |

```bash
bask demo --site harbor              # one building's dashboard
bask demo --fleet                    # all five in the all-stations view (same as bask fleet --demo)
bask workspace --demo --site summit  # a workspace on one building
bask workspace --demo --site all     # a Rex or tmux session per building
bask demo --list                     # the buildings and how each starts
```

Each site is saved as a profile (`demo`, `demo-riverside`, `demo-harbor`, `demo-summit`, `demo-eastgate`) on its own local port, so every other `bask` command works on it too. The first window to open a site hosts its station; closing that window stops it, and the next start is a fresh copy: nothing an agent drew or added is kept, so a demo can be run again.

### Three things to show

1. **A finished station.** `bask workspace --demo --layout graphics`: Northgate, with every air handler, VAV box and the plant drawn and moving.
2. **An agent draws the graphics.** `bask workspace --demo --site harbor --layout graphics`: the Graphics pane is empty. Ask the agent, for example: *"Draw graphics for this building: the freezers and coolers, and the compressor rack."* Each one opens in the Graphics pane as it is saved, and the AI Activity pane lists the saves with the agent's reasons.
3. **An agent brings a station up.** `bask workspace --demo --site eastgate --layout build`: the BACnet network has no devices. Ask: *"Discover the BACnet network and add everything it finds, then draw the plants and the air handlers with their zones."* The Jobs pane shows each discovery, the Explorer fills with the controllers and their points, and the graphics follow. The mechanical schedule in `^config/equipment-schedule.csv` says which VAV box is on which air handler.

Eastgate's equipment and point names (`AHU_01`/`Supply_Air_Temp`, `VAV_12`/`Space_Temp`) follow the BACnet HVAC simulator used for testing against real stations, with one controller per piece of equipment here. The agent's part is two commands: `bask discover <network> --add`, then `bask discover <network> --points --add`.

While a real agent session is working on a demo station, the scripted agent that otherwise keeps proposing changes stays quiet, so the AI Activity pane shows only what the real one did.

## Symbols

`bask symbols` opens the terminal symbol library: equipment drawn in text, with moving parts and status colours. Fans turn, coils pulse with flow, flames flicker, water falls through a tower, and everything stops when it is off, faulted or unreachable.

- **Air handling:** airflow, louver, damper, filter, cooling and heating coils, electric heater, fan, humidifier, duct sensor, VAV box. These are five rows tall and join side by side into one casing.
- **Water and plant:** pump, valve, chiller, boiler, cooling tower, heat exchanger, tank.
- **Refrigeration and critical rooms:** compressor, cold room, CRAC unit, server rack.
- **Power:** UPS battery, generator.
- **Indicators:** value plate, bar gauge, thermometer, status light, alarm marker.

In the gallery, the arrow keys choose a symbol and `s` (status), `[` `]` (value), `p` (start/stop), `m` (medium), `f` (direction) and `o` (door) try its states. `tab` shows two example assemblies: an air handler with its coil piping, and a chilled water plant joined by pipes with flow marks. `bask symbols --list` prints the ids and sizes.

The library is in `src/tui/symbols`: `library.ts` (the symbols), `canvas.ts` (a grid to place them on, with pipes and ducts that join where they meet), `graphic.ts` (graphics, below) and `examples.ts`. It is compiled into `bask`, so every install has it.

## Graphics

A graphic is a drawing of equipment made from the symbols and tied to a station's points: an air handler, a plant, a row of freezers. It is a small JSON file with **no coordinates**. You list the parts; bask places them and finds the way for each pipe.

```json
{
  "title": "AHU-1",
  "base": "slot:/Drivers/BacnetNetwork/AHU_01/points",
  "rows": [
    { "air": [
        { "symbol": "louver" },
        { "symbol": "filter", "label": "Filter", "reading": "FilterDP" },
        { "symbol": "cooling-coil", "label": "Cooling", "value": "CoolingValve" },
        { "symbol": "fan", "label": "Supply fan", "value": "SupplyFanSpeed", "on": "SupplyFanStatus" },
        { "symbol": "sensor", "label": "Supply air", "text": "T", "reading": "SupplyAirTemp" }
      ],
      "from": { "label": "OA", "reading": "OutdoorAirTemp" }, "to": "SA" }
  ]
}
```

- An `air` row is an air path: its sections join into one casing, air moves between them while the fan runs, and each coil gets its supply and return legs with a valve.
- A `parts` row is equipment side by side; an array inside it is a column. `pipes` join parts by `id.port` (`{"from": "ch1.chwOut", "to": "p1.in", "medium": "chw"}`), go round the equipment by themselves, and branch where two leave the same port.
- `value`, `on` and `reading` take a point (a path under `base`, or a full ORD) or a fixed number. Alarm, fault, down and overridden colours, units and number formats come from the points.

```bash
bask graphic guide                  # the format, every symbol with its ports, and an example
bask graphic print ahu-01.json      # the drawing as text with live values, and anything wrong with the file
bask graphic save ahu-01.json --allow-writes
bask graphic list                   # also: get <name>, show <name>, rm <name>
```

**Where they live.** Graphics are saved on the station, in its file space under `^bask/graphics/`, one JSON file each. So they stay with the station (its backups and copies carry them), every bask on that station shows the same ones in the Graphics view, and each save is in the station's audit history. Nothing is kept on your computer.

**For an AI agent** this is the whole job: read `bask graphic guide`, write the file, `print` it to see the result as text and fix what it reports (a misspelt symbol comes back with the one that was meant; a point that does not exist is named), then `save`, which opens it in your Graphics pane. The workspace briefing tells the agent this. The demo buildings each start with two graphics drawn this way.

## Workspace

`bask workspace` lays out a station workspace in Rex (Superlogical's terminal multiplexer) or tmux: an Explorer, Alarms and AI Activity pane, and an AI agent session (Claude Code by default) that works on the station through `bask`.

```bash
bask workspace                      # Explorer · Alarms · AI Activity · Claude Code
bask workspace --no-agent           # Explorer · Watch · Alarms · AI Activity
bask workspace --layout graphics    # Graphics · AI Activity · Claude Code
bask workspace --layout build       # Explorer · Jobs · Graphics · AI Activity · Claude Code (bringing a station up)
bask workspace --layout monitor     # Home · Alarms · Watch · AI Activity
bask workspace --layout duo         # the full dashboard beside the agent
bask workspace --demo               # the same on a simulated building (--site to choose)
bask workspace --dry-run            # print what would be started
```

It uses the multiplexer the terminal is already in, else Rex, else tmux (`--mux rex|tmux` to choose). Each pane is `bask tui --view <name> --pane`: one view, no tab row, though `1`–`0` and `g` still switch.

**Panes work together.** They share the watch list, so `w` in the Explorer pane adds a row to the Watch pane. `t` (trend) and `e` (show in the Explorer) go to the pane that shows that view when there is one. `bask show <ord>`, `bask show --trend <ord>` and `bask show --watch <ord>` do the same from any shell, which is how the agent points at things for you; `bask graphic save` and `bask graphic show <name>` open a graphic in the Graphics pane.

**MCP tools in terminal Claude Code.** The baskStream extension for the Claude desktop app is an MCP server, and it can read a saved `bask` profile. Registered once like this, terminal Claude Code gets the same `baskStream` tools, on the workspace's station inside a workspace pane and on the profile named `ai` anywhere else:

```bash
claude mcp add --scope user baskStream -e 'BASKSTREAM_PROFILE=${BASKSTREAM_PROFILE:-ai}' -e 'BASKSTREAM_PASSWORD=${BASKSTREAM_PASSWORD:-}' -- node "<the extension's folder>/server/index.mjs"
```

On macOS the folder is `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.basidekick.baskstream`. The profile is the agent's login: `bask login <station> -u <the AI's Niagara user> --name ai`.

**Your login and the agent's.** On a real station you stay on your own login in the station panes, and the agent gets the Niagara user made for it:

```bash
bask workspace --agent-user ai-claude
```

The first time, bask asks for that user's password once (it says so: "Password for the AI agent's login ai-claude@..."), saves the login as a profile and remembers it for this station. After that plain `bask workspace` uses it, and says which login the agent gets before it asks for anything. `--agent-profile <name>` picks a saved profile instead, and `bask profiles` shows each station's agent login.

As it starts, the workspace says who is who: "Claude Code is signed in as ai-claude; you are admin", and whether the station itself counts that user as an agent. It does when the user is listed in `agentUsers` on BASkStreamService; then the agent rules (approval, reasons, limits) follow that user however it connects, and its changes are under its own name in the audit history. In the agent's pane, `bask status` shows the user and the rules it works under. With no agent login the agent shares yours, and the workspace says so.

A saved login lapses when nothing uses it for a while, and an agent cannot type a password, so the agent's pane keeps its login in use for as long as it runs. If the agent does report an expired session, log it in again with the `bask login` command it prints.

**The agent** starts with a briefing on the station and how to use `bask` (`bask agent-brief` prints it): how to read, how to change things with a reason, how to bring BACnet equipment in, and how to draw graphics.

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
| `bask discover <network\|device...> [--add] [--points] [--no-wait]` | BACnet discovery: the devices on a network, or the points of devices. `--add` adds everything found that is not there yet; `--points` on a network does every device under it. Needs `--allow-writes` |
| `bask add <job> <slots...\|all> [--parent ord] [--apply]` | Plan for adding chosen discovery results; `--apply` adds them, a hundred at a time (needs `--allow-writes`) |
| `bask proposals [--all]` · `bask approve <id>` · `bask reject <id> [--note]` | AI agent proposals waiting for a person; approving runs the write with your permissions (needs `--allow-writes`) |
| `bask agent-log [--since 24h]` | What AI agents did, from the station's audit history |
| `bask metrics` | OpenMetrics text |
| `bask tui [--view <name>] [--pane] [--no-mouse] [--theme dark\|light]` | The dashboard (also what `bask` alone runs), opened on a view |
| `bask workspace [--layout ops\|graphics\|build\|monitor\|duo] [--mux rex\|tmux] [--agent <cmd>\|--no-agent] [--agent-user <user>\|--agent-profile <name>] [--demo] [--dry-run]` | A multi-pane station workspace in Rex or tmux |
| `bask show <ord> [--trend] [--watch]` | Select an ORD in the open Explorer, chart it, or add it to the watch list |
| `bask agent-brief` | The briefing an AI agent gets on working with this station |
| `bask symbols [--list]` | The terminal symbol library: animated equipment drawn in text, with example assemblies |
| `bask graphic guide` | How to write a graphic: the format, every symbol with its ports, an example |
| `bask graphic print <file-or-name> [--offline]` | Draw a graphic once as text with the points' values, and list anything wrong with it |
| `bask graphic save <file> [--name <name>]` | Check a graphic and store it on the station (`^bask/graphics/`); open windows show it |
| `bask graphic list` · `get <name>` · `show <name>` · `rm <name>` | The saved graphics; one's JSON; open one in the Graphics view; delete one |
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
