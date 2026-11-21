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

This downloads a single executable from the latest `bask-v*` [release](https://github.com/rbhans/bask-stream/releases), checks it against the release's `SHA256SUMS`, and puts it in `~/.local/bin` (Windows: `%LOCALAPPDATA%\Programs\bask`, added to your user PATH). No Node needed. Set `BASK_VERSION` for a specific version (`curl -fsSL https://raw.githubusercontent.com/rbhans/bask-stream/main/cli/install.sh | BASK_VERSION=0.6.0 sh`) or `BASK_INSTALL_DIR` for another folder. Run the command again to update. To uninstall, delete that file and `~/.config/baskstream` (Windows: `%APPDATA%\baskstream`).

## Use

```bash
bask demo                                              # try it on a built-in simulated building, no station needed
bask login https://192.168.0.126 -u test --insecure   # asks for the password; saves only the session
bask                                                   # the dashboard: every view in one window
bask workspace                                         # a multi-pane workspace in Rex or tmux, with an AI agent
bask fleet                                             # every saved station at once
```

`bask login` needs a station running the baskStream module (setup is in the [root README](../README.md#station-setup)); the demo does not. `bask doctor` checks a connection step by step when something does not work.

## Dashboard

Twelve views, switched with `1`–`0`, `g`, `L` or `tab`:

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
| `L` | Logic | One folder as a wire sheet: its components as blocks with live slot values, the links between them, and a trace of any value to what feeds it and what it drives |

Everywhere: `/` finds a point or component by name, `:` (or `ctrl+k`) opens every command, `?` shows the keys for the current view, `q` quits. The mouse works too: click a tab or a row, scroll with the wheel (`--no-mouse` leaves the mouse to the terminal).

The dashboard starts read-only. Press `W` (or start with `--allow-writes`) to allow changes; each one still asks before it is sent. Edits to components go through a model plan that is previewed first.

Colours follow the terminal: bask asks it whether it is light or dark as it starts, and uses dark when there is no answer. Force one with `--theme dark|light` or `BASK_THEME`.

## Several stations at once

`bask fleet` connects to every saved station (or the profiles you name) and shows a card for each: its link, unacknowledged and open alarms, what the AI is waiting on or did last, and the first points on its watch list, live. Underneath, the newest alarms from all stations in one list. `⏎` or a number opens a station's full dashboard; `q` there comes back. A station whose saved login has expired says so on its card, with the `bask login` command to run.

Two more commands run across saved stations and print a list. Both only read.

```bash
bask fleet check                          # bask check on every saved station
bask fleet check north south --rules our-standard.json
bask fleet diff --against standard/       # every station against a folder of export files
```

- `bask fleet check` prints one line per station with its counts, then every error and warning with the station's profile beside it. `--under` and `--rules` work as in `bask check`. The exit code is 1 when any station has an error or could not be checked.
- `bask fleet diff --against <dir>` takes a folder of files from `bask export` (or one file). Each file is compared with its own branch on each station, so the list shows where each station departs from the standard. "added" is on the station and not in the standard. The exit code is 1 when any station differs or could not be compared.
- With no profiles named, both cover every saved station once, leaving out the demo profiles. A station that cannot be reached is listed with the reason, and the others still run. A saved login that has expired is an error here, not a password prompt; set `BASKSTREAM_PASSWORD` to log in again without one.
- `-o json` and `-o csv` give the same lists.

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

### Four things to show

1. **A finished station.** `bask workspace --demo --layout graphics`: Northgate, with every air handler, VAV box and the plant drawn and moving.
2. **An agent draws the graphics.** `bask workspace --demo --site harbor --layout graphics`: the Graphics pane is empty. Ask the agent, for example: *"Draw graphics for this building: the freezers and coolers, and the compressor rack."* Each one opens in the Graphics pane as it is saved, and the AI Activity pane lists the saves with the agent's reasons.
3. **An agent brings a station up.** `bask workspace --demo --site eastgate --layout build`: the BACnet network has no devices. Ask: *"Discover the BACnet network and add everything it finds, then draw the plants and the air handlers with their zones."* The Jobs pane shows each discovery, the Explorer fills with the controllers and their points, and the graphics follow. The mechanical schedule in `^config/equipment-schedule.csv` says which VAV box is on which air handler.
4. **An agent builds logic.** `bask workspace --demo --layout logic`: Northgate's AHU-1 has a supply air reset and a cooling loop wired up; AHU-2 has none. Ask: *"Give AHU-2 the same supply air reset and cooling loop as AHU-1."* The new sheet opens in the Logic pane as it is applied, and AHU-2's cooling valve starts following the loop.

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

**Niagara Px pages** are a separate thing: `bask px` works on the station's own Px files (baskStream API 1.12). `bask px check ^px/VAV.px --under slot:/Drivers --name 'VAV*' --suggest` shows which VAVs a template's bindings do not resolve on and which points might be the missing ones; `bask px attach` puts a Px on those VAVs as their default view; `bask px qa` is a punch list of broken bindings, missing views, dead nav nodes and unused files. `bask px snapshot ^px/VAV.px --out vav.png` saves a picture of a page as a web browser shows it, with live values, so a person or an AI agent can look at it after changing it; it needs Chrome, Chromium or Edge on this computer. See [docs/GRAPHICS.md](../docs/GRAPHICS.md).

**For an AI agent** this is the whole job: read `bask graphic guide`, write the file, `print` it to see the result as text and fix what it reports (a misspelt symbol comes back with the one that was meant; a point that does not exist is named), then `save`, which opens it in your Graphics pane. The workspace briefing tells the agent this. The demo buildings each start with two graphics drawn this way.

## Logic

The Logic view shows one folder of the station as a wire sheet in text: each component is a block with its inputs and output and what they read now, and the links between slots are drawn as lines. The layout is worked out by bask, left to right in the direction values flow. It is for reading and watching logic; building it is an agent's job (or Workbench's), and the sheet follows as they do.

- It opens on a top-level `Logic` folder when the station has one, else at the station's root. `⏎` on a folder block opens it, `u` goes up. From the Explorer, `L` opens the sheet of whatever is selected.
- `←↑↓→` pick a block and a slot. The two lines under the sheet say what the slot reads, what feeds it and what it drives.
- `⏎` on a slot traces it: everything upstream and downstream is lit and carries moving marks, the rest is dimmed, and the way through is written out with the value at each step.
- Links that leave the folder end at a dashed block naming the component at the far end; `⏎` there goes to its sheet.
- `e` shows the block in the Explorer, `t` trends it, `w` watches the slot, `c` commands a writable point, `y` copies the slot's ORD.
- A device's `points` folder is a sheet too: it shows which points logic reads and which it drives.

It needs nothing set up: it reads the folder with `browse`, each block with `describe_component`, and the slot values the way points are read. Up to 80 components show on one sheet.

```bash
bask logic print slot:/Logic/AHU_01                  # the same sheet once, as text, with every link listed
bask logic print slot:/Logic/AHU_01 --trace SatLoop.setpoint
bask logic guide                                     # how to build logic: the plan file, common blocks, an example
bask plan changes.json                               # check a file of changes against the station
bask plan changes.json --apply --allow-writes        # make them; the Logic view opens on what was built
bask show --logic slot:/Logic/AHU_01                 # open a sheet in the Logic view from any shell
```

**For an AI agent.** `bask logic guide` gives the file format (create blocks, link slots, set properties), the kitControl blocks used most with their real slot names, and a complete example. The agent writes a file, `bask plan` checks it and says what it would do, `--apply` makes the changes, and `bask logic print` reads back what every slot holds, so the agent can see whether the logic does what it meant. Applying a plan as an agent needs `agentDirectModelEdits` on the station; commanding a point stays a proposal.

## Station check

`bask check` reads the station and prints a punch list: what is wrong or worth a look, most serious first. It changes nothing. It sends only `query`, `browse`, `describe_component`, `read_schedule`, `read_history`, `describe_history`, `read_alarms` and `graphics_inventory`, so a login with read permission is enough and `--allow-writes` is not needed.

```bash
bask check                                   # the whole station, as a table
bask check --under slot:/Drivers/BacnetNetwork
bask check -o json                           # also -o csv
bask check --html northgate-check.html       # one page to hand to an owner
bask check --rules our-standard.json         # your own rules
```

The exit code is 1 when any finding is an error, so it can run on a schedule. Severities are `error`, `warning`, `review` and `info`.

The HTML page is one file with its styles inside it: no scripts, no images, nothing loaded from elsewhere.

**What the starter rules check**

| Group | Rule id | Finds |
|---|---|---|
| Points | `points.fault`, `points.down`, `points.stale` | Points in fault, down or stale. Points under a device that is itself reported down are not listed again |
| | `points.overriddenLong` | Points overridden for more than 8 hours. The time comes from the station's audit history: the newest override of the point in the last 7 days |
| | `points.overridden` | Points that are overridden now and not already listed as long |
| | `points.noUnits` | Numeric points with no units |
| | `points.outsideFacets` | A value outside the min and max in the point's own facets |
| Histories and alarms | `histories.missing`, `alarms.missing` | A point with no history (or alarm extension) when at least three quarters of the other points with the same name have one |
| | `histories.stopped` | A point whose history records on an interval and has no record for more than 24 hours. Points under a device that is reported down are not listed again |
| | `alarms.unusedClasses` | An alarm class that no alarm extension names and that no alarm in the alarm database is in |
| Names | `names.devices`, `names.points` | A name that joins its words differently (underscores, hyphens, spaces, joined words) from at least 80% of its siblings |
| | `names.pointSet` | A device that lacks a point most devices named like it have (`VAV_108` has `ZnTmp` where the other `VAV_*` have `ZoneTemp`) |
| Devices | `devices.down`, `devices.duplicateAddress`, `devices.noPoints`, `networks.empty` | Devices down, two BACnet devices with one address, devices with no points, networks with no devices |
| Schedules | `schedules.unreferenced`, `schedules.noEvents` | Schedules no link leaves, and schedules with nothing in their week |
| | `schedules.pastExceptions` | Special events whose dates name a year and are all over |
| Graphics | `graphics.qa` | The `bask px qa` list |
| Security posture | `security.defaultAccounts` | Enabled accounts with a common default name (`admin`, `guest`, `operator`…), as `review`. bask reads the user list only. It never tries a password |

**Limits, and what is left out**

- `points.overriddenLong` reads the last 7 days of the audit history, up to 5,000 records. A point with no override on record is taken to be overridden for at least as long as the records read go back, and the finding says so. When the read stops at its limit, such a point is left as plainly overridden. The set time is the rule's: change the `8` in its test with a rule file.
- `histories.stopped` asks the station about each point's histories, one request a point, for up to 2,000 points. It looks only at histories that record on an interval, and only when the gap is over three intervals. A history that records on change of value may rightly go quiet, so it is left alone. A history that never recorded is not listed either. On a station with many histories this is the slowest rule; `{"id": "histories.stopped", "off": true}` in a rule file leaves it out.
- `alarms.unusedClasses` reads up to 1,000 alarms. A class used only by something that is not an alarm extension, and with no alarm in the database, is listed though it is in use.
- `schedules.pastExceptions` goes by the year in a special event's date text. An event with no year (one that comes round each year) is left alone. A date bask cannot read counts as the last day of its year.
- Northgate has one of each planted: AHU-2's fan overridden sixteen hours ago, a history on VAV-106 that stopped three days ago, an alarm class `afterHours` that nothing uses, and last December's holiday on the OfficeHours schedule. The other buildings have none.
- `points.outsideFacets` is tested on rows made for the test, not on a station: the simulated points have no min and max.
- `schedules.unreferenced` looks at links only. A schedule that something reads by ORD still counts as unreferenced.
- `devices.duplicateAddress` asks for `bacnet:BacnetDevice`. Other drivers need a rule of their own.
- `graphics.qa` needs baskStream API 1.12. On an older station, and on the simulated buildings (API 1.11), it is listed as skipped with the reason.
- A rule the station refuses (a type it does not have, a query it rejects) is skipped and named; the other rules still run.
- A query returns at most 5,000 rows and a walk covers at most 20,000 components. A rule that hits a limit says so. Narrow it with `--under`.
- The rules were tested on the simulated buildings only, not on a real station.

**Rules are data.** A rule names where its rows come from, a test, and a severity. `--rules <file>` takes `{"rules": [...]}`:

```json
{
  "rules": [
    { "id": "points.overridden", "severity": "error" },
    { "id": "security.defaultAccounts", "off": true },
    {
      "id": "site.hotZones", "group": "Site standard", "title": "Zone above 76 °F", "severity": "warning",
      "query": { "bql": "select slotPath, out.value from control:NumericPoint where name = 'ZoneTemp'" },
      "test": { "is": "compare", "all": [{ "field": "out.value", "op": "above", "value": 76 }] },
      "message": "reads {out.value}, above 76"
    }
  ]
}
```

- A rule whose `id` is in the starter set changes only the fields it gives. `"off": true` drops it. Any other `id` adds a rule. `"replace": true` beside `"rules"` leaves the starter set out.
- Source, one of: `"query": {"bql": "..."}` or `{"neql": "..."}`; `"walk": {"type": "*Device", "kind": "point", "name": "VAV*"}` (components of the tree, with the fields `ord`, `name`, `typeSpec`, `kind`, `status`, `parent`, `children`, `points`; add `"describe": true` for `linksIn` and `linksOut`, `"schedule": true` for `events`, `pastExceptions` and `pastExceptionNames`); or `"graphics": true`.
- A query can read more about each row with `"add"`: `"overrideAge"` gives `overriddenHours` and `overriddenFor` from the audit history, and `"historyAge"` gives `lastRecordHours`, `lastRecordFor`, `historyId` and `historyInterval` from `describe_history`.
- Test (`"is"`): `found` (every row), `compare` (`all` conditions with `op` `equals`, `notEquals`, `matches`, `notMatches`, `above`, `below`, `empty`, `notEmpty`), `duplicate` (`field`), `outsideFacets` (`value`, `facets`), `missingAmongAlike` (`key`, `alike`, `having`), `notNamedBy` (`key`, `by`, and `"alarms": true` to count alarm records as use), `nameStyle`, `pointSet`.
- `message` is filled from the row: `{slotPath}`, `{out}`. `where` names the field that says where the finding is. `unless` lists rules whose findings this one does not repeat.
- `bask check -o json` lists every rule that ran with its `id`, how many rows it looked at and how many findings it made.

## Station as text

`bask export <ord>` prints a branch as JSON: every component under the ORD with its type, the properties set on it, the links that arrive at it, and its own tags and relations.

```bash
bask export slot:/Drivers/BacnetNetwork > network.json
bask diff network.json slot:/Drivers/BacnetNetwork     # the file against the station now
bask diff monday.json friday.json                      # two files; no station needed
bask diff slot:/Drivers/BacnetNetwork/AHU_01 slot:/Drivers/BacnetNetwork/AHU_02
bask diff north:Drivers/BacnetNetwork south:Drivers/BacnetNetwork   # two saved stations
bask apply network.json                                # what would make the station match the file
bask apply network.json --allow-writes --yes           # make those changes
```

Two exports of an unchanged branch are the same bytes, so the file can go in version control.

- Components are in path order. Paths are relative to the exported ORD (`.` is the ORD itself), so two branches can be compared.
- A property is left out when it equals the default of its type. The station is asked for each type's defaults with `describe_component_types`. When it cannot say, every property of that type is written.
- Left out because they change while the station only runs: read-only and transient slots (values, status, health, times), inputs a link feeds, and the priority inputs `in1`–`in16` of writable points. An override is not in an export.
- Left out as secrets: slots whose name or type looks like a password, secret, token, key, credential or certificate, and anything the station redacts. A secret in a slot with an ordinary name and a plain string type is not recognised.
- No handles: a value that is a handle ORD (`h:2c45e`) is left out. Links and relations are written by slot path.
- Only tags and relations stored on the component are written, not the ones a tag dictionary implies.
- A component the login cannot read is written with its path and type and `"unreadable": true`.
- An export holds at most 20,000 components. A larger branch is refused; export it in parts.
- Reading is one `describe_component` request per component, so a large branch takes a while.
- Tested on the simulated buildings only. On a real station the list of what counts as state may need more entries; `bask diff` of two exports taken a minute apart shows them.

`bask diff <a> <b>` compares two exports. Each side is a file, or a branch that is exported first. It lists components added and removed, and for a component on both sides the type, properties, links, tags and relations that changed. `-o json` and `-o csv` give the same list. The exit code is 1 when they differ.

A side written `<profile>:<branch>` is a branch on that saved station, so one run can compare two stations, or a file with any station. A side with no profile is on the current station. A name that is a file on this computer is always read as a file.

### Apply

`bask apply <file>` writes an export back. It exports the branch as it is now, compares it with the file, and lists the changes that would make the branch match. **It changes nothing unless you add `--yes`** (with `--allow-writes`, as for every command that changes the station).

```bash
bask apply ahu.json                         # preview against the branch the file was exported from
bask apply ahu.json --to slot:/Drivers/BacnetNetwork/AHU_09
bask apply ahu.json --allow-writes --yes    # make the changes, then read the branch back
bask apply ahu.json --prune --allow-writes --yes
```

- The changes are model plans: `create`, `update`, `create_link`, `delete_link` and, with `--prune`, `delete`. The station checks each plan with `preview_model_changes` and makes it with `apply_model_changes`, as `bask plan` does. Tags and relations are not plan operations, so they are written after the plans with `write_tags` and `write_relations`; the station has no preview for those.
- A plan holds at most 100 changes. New components come first, then properties, links and deletes. In a preview, the station can check a plan only when it does not touch what an earlier plan adds; the others say so and are checked when they are applied.
- A component that comes with its parent (a new device's points folder) is not created a second time. bask asks the station what a new component of the parent's type already holds.
- Without `--prune`, a component on the station that the file does not have is reported and left alone.
- `--to` names another branch. A branch that is not there is created with the file's root type; its parent must exist.
- After `--yes`, the branch is exported again and compared with the file. The output says whether it now matches.
- If the station refuses a plan, bask stops there and reports it. It does not retry.
- As an agent, `apply` needs `agentDirectModelEdits` and `agentDirectTags` on the station, and a `--reason`.

**Limits.** These are reported as differences and never applied: `program:` objects, protected services (users, roles, authentication, categories, security, Fox, Web, audit history, programs, baskStream itself) and platform settings. Every run prints this. Also not applied, each with its reason: a component whose type differs (delete it and apply again), a link whose slot cannot be told from the station's reply, and a property the file leaves at a default the station does not report. Secrets are not in an export, so they are not applied. The station's change sets are not built yet, so the plans are applied directly and there is no one-step undo. Tested on the simulated buildings only: applying an export to an empty folder and exporting it again gives no difference there.

### Templates

A template is an export with named gaps, written `${name}`. A CSV file fills them: its first line names the gaps, and each later line is one copy.

```bash
bask export slot:/Drivers/BacnetNetwork/VAV_101 > vav.json    # then replace what differs per unit with ${name}
bask apply --template vav.json --each units.csv                # preview every row
bask apply --template vav.json --each units.csv --allow-writes --yes
```

```json
{ "format": "bask-export", "version": 1, "root": "slot:/Drivers/BacnetNetwork/${device}",
  "components": [{ "path": ".", "type": "bacnet:BacnetDevice", "properties": { "address": "${address}" } }] }
```

```
device,address
VAV_201,MSTP 3:1
VAV_202,MSTP 3:2
```

- A gap can be anywhere in the file: the root, a path, a property, a tag. `--to` takes gaps too.
- A gap with no column in the CSV is an error that names it, and nothing is applied.
- The template is JSON, whatever the file is called. A YAML reader accepts JSON, but bask does not read other YAML.
- Each row is previewed or applied in turn, with the same limits as `bask apply`.

## Meaning

`bask model infer` proposes what the station's components mean: which are equipment and of what kind (air handler, VAV box, chiller, plant…), what each point under them is for (supply air temperature, cooling valve command…), and which equipment feeds which. Every proposal has a confidence between 0 and 1 and a reason in words. `infer` writes nothing to the station.

```bash
bask model infer                              # writes <station>-model.json and prints a table
bask model infer --under slot:/Drivers/BacnetNetwork --out reviews/north.json
bask model write Northgate-model.json         # what would be written as tags and relations
bask model write Northgate-model.json --allow-writes --yes
bask model export Northgate-model.json --format haystack > northgate-haystack.json
bask model export Northgate-model.json --format brick > northgate.ttl
```

It reads names, types, units, value types, the folder shape and any Haystack tags already there. Points are grouped under the device they belong to, or under their folder when no device is above them. Names are split into words and BAS abbreviations are spelled out (`SAT` is supply air temp, `ZnTmp` is zone temp) with the same word table the station uses for `bask px check --suggest`.

- An equipment's confidence comes from its name, from the points it has, and from siblings named alike that came out the same kind ("name says vav; has zone temperature, damper command; 7 siblings agree").
- A point's confidence comes from how close its name is to a role's, whether its units fit, and whether it is writable ("name 1.00, units °F, read-only").
- A proposal is never above 0.95. Only what is already tagged on the station is 1, and it is marked confirmed.
- A point whose name is not close to any role is `unknown` with a low confidence. It is not guessed.
- A component that is itself a control point is never equipment, and a proxy extension (or anything else inside a point) is never a point. A lone point in a folder is a point of that folder, and the folder is `unknown` unless its name says more.

**What serves what.** The file's `serves` list says which equipment feeds which: an air handler its VAV boxes (air), a chilled or hot water plant the units that have a valve for its water, a chiller or boiler its plant. Every entry bask worked out has `"inferred": true`. The reasons, strongest first:

- A link joins the two, directly or through up to three logic blocks ("a link joins them (VAV_105/DamperPosition → AHU_02/MostOpen → AHU_02/SupplyFanSpeed)"). The kinds say which way the air or water goes, not the link.
- The fed unit's name holds the feeder's name (`AHU1_VAV_3` holds `AHU_1`).
- The feeder is the only one of its kind in the folder, or on the station.
- When two could equally be the feeder and nothing tells them apart, nothing is proposed. Northgate has eight VAV boxes and two air handlers with no link or name between them, so it gets no air proposals.
- A relation the station already holds (`hs:airRef`, `hs:chilledWaterRef`, `hs:hotWaterRef`) is listed as it is, confirmed and not marked inferred.
- Reading links is one request a point, for up to 4,000 components. `--no-links` skips it.

**The review file** is JSON. Equipment is listed with the least certain first, and so are the points inside each. Set `"confirmed": true` on what is right. Where a proposal is wrong, change `kind` or `role`, `label` and `tags`, then confirm it. Running `infer` again on the same file keeps what was confirmed. The table shows the equipment and the points under 0.7; the rest are in the file.

`bask model write <file>` puts the confirmed entries on the station. **It lists what it would write and writes nothing unless you add `--yes`** (with `--allow-writes`). An entry that is not confirmed is never written.

- Confirmed equipment gets `hs:equip` and its tags as Haystack markers. A confirmed point gets `hs:point` and its tags.
- A confirmed point under confirmed equipment gets the relation `hs:equipRef` to it. A confirmed `serves` entry is a relation on the unit that is fed: `hs:airRef`, `hs:chilledWaterRef` or `hs:hotWaterRef`.
- What the station already holds is left out, so a second run has nothing to do. Nothing is ever removed.
- The preview is worked out from `read_tags`; the station has no dry run for tag writes. After writing, the tags and relations are read back.
- A review file made on one station is refused on another. A confirmed entry whose component has gone is named and left out. A tag that is not a Haystack name is named and left out.
- It uses `write_tags` and `write_relations`. As an agent it needs `agentDirectTags` and a `--reason`. The station's change sets are not built yet, so the writes are made directly; the audit history records each one.

`bask model export <file> --format haystack` writes the confirmed entries as a Haystack grid in JSON (version 3.0 encoding: `m:` marker, `r:` ref, `s:` string). Equipment rows have `equip` and their kind tags; point rows have `point`, their role tags, `equipRef`, `kind`, `unit`. A confirmed `serves` entry is an `airRef`, `chilledWaterRef` or `hotWaterRef` on the fed unit's row. `axSlotPath` holds the slot ORD. Unconfirmed entries are never exported.

`--format brick` writes them as a Brick model in Turtle: each equipment and point with its Brick class, `brick:isPointOf` from a point to its equipment, and `brick:feeds` for a confirmed `serves` entry. The class names were checked against Brick 1.3.0. A kind or role with no class of its own there (cooler, UPS, PDU, generator, door status, load) is written as `brick:Equipment` or `brick:Point` and named in a comment at the end. Units are not written.

Limits:

- It knows 18 kinds of equipment and about 55 point roles, mostly HVAC. Anything else comes out `unknown`.
- What serves what covers air handlers, plants, chillers and boilers. Pumps, towers and fan coil units on an air handler are not proposed.
- Tags are written as Haystack only. Brick is an export, not something written to the station.
- The `resolve` operation and bindings by role are not built: they need a change to the station module.
- Tested on the simulated buildings with their tags removed, where it finds the kind of every device the tags named, and on thirty VAV boxes named three ways. It has not been run on a real station since the fix for lone points.

## Test bench for agents

Three commands for trying work away from a building and for measuring an agent.

**Record.** `bask record` turns a station into a site file. It reads the tree, what every point holds now, the open alarms, each schedule's week, the tags, and a day of history for each numeric point. It only reads.

```bash
bask record                                   # writes <station>-site.json
bask record --under slot:/Drivers --hours 48 --interval 30m --out sites/plant.json
bask record --scramble                        # replace names
bask replay Northgate-site.json               # the dashboard on the recorded site
bask replay Northgate-site.json --serve       # only run it; then: bask -p demo-recorded <command>
```

- `bask replay` runs the file as a simulated station on port 47910 and saves it as the profile `demo-recorded`, so every other command works on it. Points with a recorded history play it back and repeat it; the others hold the value they had. Open alarms are there, as old as they were.
- `--scramble` replaces names so the file does not say whose building it is. In each name, digits and the words that only say what a thing is are kept (`AHU`, `Supply`, `Temp`, `Plant`…); every other word becomes a made-up word, the same one each time in that file. `Hartwell_Annex_AHU_01` becomes something like `Gufudusi_Nubif_AHU_01`. The station is called `Recorded`. Alarm text is rebuilt from the alarm's state and source, not copied. Tags outside `hs:` and `n:` are dropped. Top-level containers and the services keep their names.
- Not recorded: links and logic, property values other than a point's facets, files and graphics, histories of points that are not numeric, special events, the audit history, users. Device addresses are not in the file. Look through a scrambled file before you share it: state texts, enum options and schedule entry names are copied as they are.
- A recording holds at most 20,000 components, and one history request is sent per numeric point.
- Tested by recording the simulated buildings and playing them back. It has not been run on a real station.

**Eval.** `bask eval --agent <command>` runs an agent on a set of jobs and scores each one from the simulated station as the agent left it. What the agent prints is not read.

```bash
bask eval --list
bask eval --agent "claude -p"                 # all four tasks
bask eval --agent "claude -p" --task northgate-ahu2-logic --timeout 20m -o json
```

The four tasks are the four things to show above:

| Task | Building | The job | Scored from |
|---|---|---|---|
| `northgate-faults` | Northgate | Find what is wrong and write it to `^notes/faults.md` | That file on the station: does it name the dead device, the chiller in fault, the fan left overridden, the zone in alarm and the stopped history; and that nothing else changed |
| `harbor-graphics` | Harbor | Draw the freezers and coolers, and the compressor rack | The graphics saved on the station: each must be a graphic with no errors that binds to that equipment's points |
| `eastgate-bringup` | Eastgate | Discover the BACnet network, add everything, draw the plants and air handlers | The controllers (of 46) and points (of 614) now in the station, and the six graphics |
| `northgate-ahu2-logic` | Northgate | Give AHU-2 the same supply air reset and cooling loop as AHU-1 | The links and blocks on the station: the valve follows a loop, the loop reads AHU-2's supply air and a reset, the reset reads AHU-2's outdoor air, both have AHU-1's settings, and AHU-1's logic is untouched |

- Each task starts a fresh station. The agent command runs through the shell in an empty folder with `bask` on its PATH, logged in as the station's agent user, so the agent rules apply to it. The job is on its standard input and in `BASK_EVAL_PROMPT`; `{prompt}` and `{task}` in the command are replaced.
- The report gives each task's score (0 to 1), the time, the `bask` commands the agent ran, how many changes the station refused, and how many point writes became proposals. The overall score is the mean.
- While a task runs, the station's values are frozen and its scripted agent is off, so an agent that runs the same commands gets the same score. An agent that is not the same each time will not.
- The first task stands for the README's "a finished station": that one has no job for an agent, so the job is to find Northgate's planted faults.
- It needs a POSIX shell: on Windows, run it under WSL. It was tested with a scripted agent, not with a model.

## Workspace

`bask workspace` lays out a station workspace in Rex (Superlogical's terminal multiplexer) or tmux: an Explorer, Alarms and AI Activity pane, and an AI agent session (Claude Code by default) that works on the station through `bask`. It needs Rex or tmux installed. The agent pane runs `claude` (Claude Code); when that is not on the PATH, the workspace starts without an agent pane and says so. `--agent <command>` starts another agent and `--no-agent` leaves the pane out.

```bash
bask workspace                      # Explorer · Alarms · AI Activity · Claude Code
bask workspace --no-agent           # Explorer · Watch · Alarms · AI Activity
bask workspace --layout graphics    # Graphics · AI Activity · Claude Code
bask workspace --layout logic       # Logic · AI Activity · Claude Code
bask workspace --layout build       # Explorer · Jobs · Graphics · AI Activity · Claude Code (bringing a station up)
bask workspace --layout monitor     # Home · Alarms · Watch · AI Activity
bask workspace --layout duo         # the full dashboard beside the agent
bask workspace --demo               # the same on a simulated building (--site to choose)
bask workspace --dry-run            # print what would be started
```

It uses the multiplexer the terminal is already in, else Rex, else tmux (`--mux rex|tmux` to choose). Each pane is `bask tui --view <name> --pane`: one view, no tab row, though `1`–`0`, `g` and `L` still switch.

**Panes work together.** They share the watch list, so `w` in the Explorer pane adds a row to the Watch pane. `t` (trend) and `e` (show in the Explorer) go to the pane that shows that view when there is one. `bask show <ord>`, `bask show --trend <ord>` and `bask show --watch <ord>` do the same from any shell, which is how the agent points at things for you; `bask graphic save` and `bask graphic show <name>` open a graphic in the Graphics pane.

**MCP tools in terminal Claude Code.** This is optional; the agent works through `bask` without it. The baskStream extension for the Claude desktop app is an MCP server, built from [`mcp/`](../mcp/README.md) in this repository, and it can read a saved `bask` profile. Registered once like this, terminal Claude Code gets the same `baskStream` tools, on the workspace's station inside a workspace pane and on the profile named `ai` anywhere else:

```bash
claude mcp add --scope user baskStream -e 'BASKSTREAM_PROFILE=${BASKSTREAM_PROFILE:-ai}' -e 'BASKSTREAM_PASSWORD=${BASKSTREAM_PASSWORD:-}' -- node "<the extension's folder>/server/index.mjs"
```

On macOS the installed extension's folder is `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.basidekick.baskstream`; a build in this repository is at `mcp/dist/baskstream`. The profile is the agent's login: `bask login <station> -u <the AI's Niagara user> --name ai`.

**Your login and the agent's.** On a real station you stay on your own login in the station panes, and the agent gets the Niagara user made for it:

```bash
bask workspace --agent-user ai-claude
```

The first time, bask asks for that user's password once (it says so: "Password for the AI agent's login ai-claude@..."), saves the login as a profile and remembers it for this station. After that plain `bask workspace` uses it, and says which login the agent gets before it asks for anything. `--agent-profile <name>` picks a saved profile instead, and `bask profiles` shows each station's agent login.

As it starts, the workspace says who is who: "Claude Code is signed in as ai-claude; you are admin", and whether the station itself counts that user as an agent. It does when the user is listed in `agentUsers` on BASkStreamService; then the agent rules (approval, reasons, limits) follow that user however it connects, and its changes are under its own name in the audit history. In the agent's pane, `bask status` shows the user and the rules it works under. With no agent login the agent shares yours, and the workspace says so.

**Asking first.** `bask explain write --point <ord>` (or `explain write_file --path ^px/Home.px`, `explain write_tags`…) says what the station would do with a change and which setting decides, without making it (baskStream API 1.13). A person can add `--user <name>` to ask about an agent's user. `bask status` names the agent profile a login follows, if the station has given it one.

**What the agent may do by itself.** By default the station turns an agent's point writes into proposals (`agentPointWrites` is `ask`; from API 1.13 it can also be `refuse` or `allow`) and refuses every other change unless the matching `agentDirect…` setting on BASkStreamService is on (baskStream API 1.11):

| To let the agent | Set |
|---|---|
| save and delete graphics | `agentDirectFiles` = `^bask/*` |
| run BACnet discovery and add what it finds | `agentDirectDiscovery` = true |
| build and change the station (logic, renames, deletes) | `agentDirectModelEdits` = true |
| tag, schedule, acknowledge alarms | `agentDirectTags`, `agentDirectSchedules`, `agentDirectAlarms` |

From API 1.14 a kind of work can also be set to wait for a person instead of being refused (`agentAskKinds`). A command whose change waits prints `proposed P8: …` and exits with code 2: the change was not made, and it should not be sent again. `bask -o json` prints `{"outcome": "proposed", "proposal": {…}}`. `bask status` lists those kinds under "waits for a person". A person approves with `bask approve P8`, sees everything agents did with `bask changes`, and puts a change back with `bask revert P8`.

The workspace says what the agent may do as it starts, and warns when the layout needs something the station does not allow (graphics in the `graphics` layout, discovery in `build`). `bask status` in the agent's pane lists it under "may do by itself", and the AI Activity header shows it. A refused change names the setting that would allow it. Discovery over a whole building is many changes: `bask discover` waits its turn under `agentMaxChangesPerMinute` rather than failing, so raise that limit if it should go faster. The demo buildings allow files under `^bask/*` and `^notes/*`, discovery, model edits and tags, and leave schedules and alarms to people.

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
| `bask put <file> <path> [--overwrite]` · `bask rm <path> [--recursive]` | Upload or delete station files; needs `--allow-writes`; confirms. A file larger than one message is sent in pieces, up to 16 MiB (API 1.14) |
| `bask px read <path> [--refs]` · `bask px validate <path> [--local]` | What a Px imports, binds to and links to; check it against this station's modules and types (exit code 1 on errors) |
| `bask px put <file> <path> [--overwrite] [--no-backup]` | Validate a local Px and write it; a replaced file is kept under `^bask/backups`. Needs `--allow-writes` |
| `bask px check <path> [ords...] [--under ord --name 'VAV*' --type t] [--views] [--relative-to ord] [--suggest] [--matrix]` | Resolve a Px's bindings on many components: which deviate from the template, and the likeliest points for missing ones |
| `bask px attach <path> [ords...] [--under ... --name ...] [--view name] [--no-default] [--remove]` | Add a Px as the default view on components, or take it off; previews, then confirms. Needs `--allow-writes` |
| `bask px inventory [--under ord] [--check-bindings] [--all]` · `bask px qa` | Every Px, nav file and view and what links them, with a punch list; `qa` checks every view's bindings too (exit code 1 on errors) |
| `bask px snapshot <page> [--view name] [--out file.png] [--size 1600x900] [--settle 3s] [--frames n --interval 3s] [--browser program]` | Pictures of a page as a web browser shows it, with live values, saved as PNG, plus its HTTP status, failed requests and console errors. A page is a Px file (`^px/VAV.px`) or a component and its view. Opens it in headless Chrome, Chromium or Edge on this computer with the session (or `BASKSTREAM_BROWSER`); only what fits the window is pictured. Exit code 1 when the station answers with an error |
| `bask nav check <path> [--local]` | Check that every node of a nav file resolves, and who uses it |
| `bask jobs` · `bask job <ord> [--cancel]` | Station jobs; one job's state, log and results |
| `bask discover <network\|device...> [--add] [--points] [--no-wait]` | BACnet discovery: the devices on a network, or the points of devices. `--add` adds everything found that is not there yet; `--points` on a network does every device under it. Needs `--allow-writes` |
| `bask add <job> <slots...\|all> [--parent ord] [--apply]` | Plan for adding chosen discovery results; `--apply` adds them, a hundred at a time (needs `--allow-writes`) |
| `bask proposals [--all]` · `bask approve <id>` · `bask reject <id> [--note]` | AI agent proposals waiting for a person; approving makes the change with your permissions (needs `--allow-writes`) |
| `bask changes [--status s] [--kind k]` · `bask revert <id> [--force] [--partial]` | Every change AI agents asked for or made in the last week, with what the check afterwards found; `revert` puts one back with your permissions (needs `--allow-writes`; baskStream API 1.14) |
| `bask resolve <equip> <role...> [--tag name]` | The point that plays a role on a piece of equipment, such as `bask resolve Drivers/BacnetNetwork/AHU_1 discharge air temp`. Inferred from tags and names; exit code 1 when no match is clearly best (API 1.14) |
| `bask agent-log [--since 24h]` | What AI agents did, from the station's audit history |
| `bask metrics` | OpenMetrics text |
| `bask tui [--view <name>] [--pane] [--no-mouse] [--theme dark\|light]` | The dashboard (also what `bask` alone runs), opened on a view |
| `bask workspace [--layout ops\|graphics\|logic\|build\|monitor\|duo] [--mux rex\|tmux] [--agent <cmd>\|--no-agent] [--agent-user <user>\|--agent-profile <name>] [--demo [--site <name>\|all]] [--dry-run]` | A multi-pane station workspace in Rex or tmux (`ws` for short) |
| `bask show <ord> [--trend] [--watch] [--logic]` | Select an ORD in the open Explorer, chart it, add it to the watch list, or open its wire sheet |
| `bask logic print <folder> [--trace block.slot]` | A folder's logic as a wire sheet in text, with live values and every link listed |
| `bask logic guide` | How to build logic through bask: the plan file, the common blocks and their slots, an example |
| `bask plan <file> [--apply] [--show ord]` | Check a JSON file of station changes (components, properties, links, actions) and list them; `--apply` makes them (needs `--allow-writes`) |
| `bask check [--under ord] [--rules file] [--html file]` | A read-only punch list for the station from a set of rules: points, histories, names, devices, schedules, graphics, accounts. Exit code 1 when there are errors |
| `bask export <ord>` | A branch as JSON: components, types, set properties, links, tags and relations. The same bytes every time the branch is unchanged |
| `bask diff <a> <b>` | Compare two exports, an export and a live branch, two branches, or two saved stations (`<profile>:<branch>`): added, removed and changed. Exit code 1 when they differ |
| `bask apply <file> [--to ord] [--prune]` | List the changes that would make a branch match an export file; `--yes` makes them (needs `--allow-writes`). `program:` objects, protected services and platform settings are reported and never applied |
| `bask apply --template <file> --each <csv> [--to ord]` | Stamp out an export with `${name}` gaps once per CSV row |
| `bask fleet check [profiles...] [--under ord] [--rules file]` | `bask check` on every saved station, with each one's errors and warnings. Exit code 1 when any has errors |
| `bask fleet diff [profiles...] --against <dir>` | Every saved station against a folder of export files. Exit code 1 when any departs |
| `bask model infer [--under ord] [--out file] [--no-links]` | Propose equipment kinds, point roles and what serves what, each with a confidence and a reason, in a review file to edit. Writes nothing to the station |
| `bask model write <file>` | List the tags and relations the confirmed entries of a review file would add; `--yes` writes them (needs `--allow-writes`). Unconfirmed entries are never written |
| `bask model export <file> --format haystack\|brick` | The confirmed entries of a review file as a Haystack grid (JSON) or a Brick model (Turtle) |
| `bask record [--under ord] [--out file] [--hours n] [--interval 15m] [--scramble]` | Read a station into a demo site file: structure, values, alarms, schedules, a day of histories. `--scramble` replaces names |
| `bask replay <file> [--serve] [--port n]` | Run a recorded site as a simulated station (profile `demo-recorded`) and open the dashboard on it |
| `bask eval --agent <command> [--task id...] [--timeout 30m] [--list]` | Run an agent on four scored jobs on the simulated buildings; the score reads each station as the agent left it |
| `bask agent-brief` | The briefing an AI agent gets on working with this station |
| `bask symbols [--list]` | The terminal symbol library: animated equipment drawn in text, with example assemblies |
| `bask graphic guide` | How to write a graphic: the format, every symbol with its ports, an example |
| `bask graphic print <file-or-name> [--offline]` | Draw a graphic once as text with the points' values, and list anything wrong with it |
| `bask graphic save <file> [--name <name>]` | Check a graphic and store it on the station (`^bask/graphics/`); open windows show it |
| `bask graphic list` · `get <name>` · `show <name>` · `rm <name>` | The saved graphics; one's JSON; open one in the Graphics view; delete one |
| `bask fleet [profiles...] [--demo]` | Every saved station at once: alarms, AI activity and live values per station, and all alarms in one list |
| `bask demo [--site <name>] [--fleet] [--list] [--view <name>] [--serve] [--port <n>]` | The dashboard on a simulated building; `--serve` only runs the station |

`-o json` or `-o csv` on any listing command; `-p <profile>` picks a station. ORDs may drop the `slot:/` prefix. Output of any size arrives whole through a pipe (`bask ... -o json | jq`); up to 0.8.0 the standalone executable stopped at 65,536 bytes.

- Profiles live in `~/.config/baskstream/profiles.json` (mode 0600; `$XDG_CONFIG_HOME/baskstream` when that is set, Windows `%APPDATA%\baskstream`; `BASKSTREAM_CONFIG_DIR` overrides all of these). The password is never saved: it is prompted, or read from `BASKSTREAM_PASSWORD` if you set it.
- `--insecure` accepts a self-signed station certificate.
- **AI agents:** an agent running bask declares itself with `--agent <name>` (plus `--model`, `--on-behalf-of`), or the `BASK_AGENT`, `BASK_MODEL` and `BASK_ON_BEHALF_OF` environment variables, and gives `--reason "…"` with changes. While the station requires approval, `bask write` reports "Proposed P7" instead of writing. See `docs/AI_AGENTS.md`.

## Build

Needs Node 22 or newer. `npm install` here copies the SDK from `../sdk` (its built `dist` only), so build the SDK first:

```bash
(cd ../sdk && npm install && npm run build)
npm install
npm test
node dist/main.js --help        # run it from source
npm run compile                 # optional: the single executable, needs Bun
```

To publish a release, bump `version` in `package.json`, commit, and push a matching tag (`git tag bask-v0.6.0 && git push origin bask-v0.6.0`). The [release workflow](../.github/workflows/release-bask.yml) tests, builds Windows/macOS/Linux executables, and attaches them with checksums.

`node test/peek.mjs --view explorer --size 120x36 --keys "down,right"` prints one frame of the dashboard on the demo station (add `--profile <name>` for a real one), which is the quick way to look at a change. Rendering and input notes are in [DEVELOPMENT-NOTES.md](DEVELOPMENT-NOTES.md).

`npm run compile` produces a single executable `bin/bask` with Bun (about 60 MB, no Node needed). For another platform: `bun scripts/compile.mjs --target=bun-windows-x64 --outfile=bin/bask.exe` (or `bun-linux-x64`, `bun-darwin-arm64`).
