# bask development notes

Short notes on problems that were solved, so they are not solved twice.

## Dashboard rendering

- **Stale or doubled lines in a real terminal (2026-11-12).** Symptom: with Ink's `incrementalRendering`, panes in tmux and Rex kept lines from an earlier frame, shifting everything below them; resizing a pane made it worse. In-memory tests could not show it. Cause: Ink redraws relative to where it believes the cursor is, and that drifts. Fix: `src/tui/run.tsx` renders Ink in debug mode into a stand-in stream (each write is one whole frame) and a small `Painter` writes only the changed lines, each at its absolute row, inside synchronized-output markers; a resize clears the screen and repaints. Each row is cleared before it is written, because clearing after a line that fills the row erases its last character. Verified in tmux and Rex with `tmux capture-pane` / `rex capture`.
- **Overlapping lines inside a panel.** Symptom: one line drawn over another (a label lost its first letter). Cause: content one row taller than its panel; Yoga shrank a one-line `<Text>` to zero height. Fix: `Panel` wraps its children in a box with `flexShrink={0}` and `minHeight`, so overflow is cut off at the bottom. Views should still budget their rows.
- **Control sequences.** With Ink writing into the stand-in stream, anything written to Ink's `stdout` is treated as a frame. Mouse mode, the window title and clipboard copies go through the `terminal` prop instead.
- **Light or dark (2026-11-12).** Symptom: dark-theme colours on a light terminal (Rex with a light theme sets no `COLORFGBG`). Fix: `askTerminalTheme()` in `src/tui/theme.ts` asks the terminal before the first frame: its background colour (OSC 11), its colour scheme (`CSI ? 996 n`, answered as `CSI ? 997 ; 1|2 n`) and device attributes, which every terminal answers, so the wait ends at once. Order: `--theme`, `BASK_THEME`, `COLORFGBG`, the terminal's answer, dark. It must read stdin the way Ink does (the `readable` event, `ref`/`unref`): reading with a `data` listener and `pause()` left the standalone (Bun) build deaf to keys afterwards, while node was fine. Keys typed during startup are handed back with `stdin.unshift`, and the key pump drops a late answer. Verified in tmux 3.8 with light and dark panes (node and standalone), and in Rex 0.1.0-preview.14, which answers the scheme question only. A light Rex window itself was not seen: a scratch session cannot be made light from the command line, because `set_theme` only applies for the client that owns the block (the app).
- **Tables.** `fit()` treats a column with `min: 0` as hidden (no width, no separator). Give a column a real `min` when it should show.

## Symbols

- A symbol is `draw(state, frame)` returning rows of characters and a paint letter per character (`paint()` in `library.ts` maps letters to theme colours, so both themes work). Every row and paint row must be the symbol's full width in every state and frame; `test/symbols.test.mjs` checks all of them.
- Air-handler sections are five rows (wall, three rows, wall) with no side walls, so placing them side by side makes one casing. Other equipment draws its own outline and lists `ports`: the cell just outside it where a line attaches.
- `Canvas.route` keeps the lines separate from the sprites: sprites cover lines, routes that meet become tees and crosses, and a route's end is drawn as plain line so it meets the port it runs up to. Flow marks sit only on straight cells.
- Characters are limited to box drawing, block elements, geometric shapes and a few ASCII marks, which terminal fonts have. Dingbats and emoji are avoided: fonts fall back and the cells stop lining up.
- When judging the look from an HTML capture, a font fallback there can widen some marks and nudge a border; a terminal keeps every cell the same width.

## Graphics

- `src/tui/symbols/graphic.ts` turns a document with no coordinates into a drawing: `checkGraphic` (what is wrong, with the place in the document), `planGraphic` (layout and pipe routes, done once per document), `drawGraphic` (one frame with the points' values). The gallery's two examples and the demo buildings' graphics (`src/demo/graphics.ts`) are such documents, so the format is what draws them.
- Layout: rows stack and are centred. An air row is names, readings, a five-row casing, and six more rows when a coil's piping is drawn. A parts row stands its equipment on one floor line with names under it; a part with a pipe on a port that points down gets its name above instead. A column of text tags floats level with the port its first pipe goes to.
- Routing (`findWay`) is a cheapest-path search over the cells: a step costs one, a turn four more, crossing another pipe six more, and running along another pipe is not allowed unless both start or end at the same port (a branch). A pipe leaves and enters a port straight, and the two cells in front of every used port are kept for that port's pipes. **Float32 bug (2026-11-12):** with a fractional cost (the 0.6 for running right beside equipment), costs stored in a `Float32Array` no longer equalled the doubles queued for them, entries looked out of date, and the search gave up with "No way through". The costs are a `Float64Array`.
- Flow marks are placed from the cell's own coordinate, not its place along the route, so pipes that share a stretch carry one set of marks there.
- Readings: the plan keeps a little room for each (`READING`). `roomNeeded` reports readings that came out longer; planning again with that room fits them, and room only grows, so the drawing does not shift as values change.
- Storage (`src/graphics.ts`) is the station file space, `^bask/graphics/<name>.json`, through the `list_files`, `read_file`, `write_file` and `delete_file` operations (API 1.10). `bask graphic save` and `show` send a `graphic` show request through the shared state file, like `bask show`.
- Checked in tmux at 132x38 and 80x24 on the demo building: the view, picking parts, the view following the picked part when the drawing is larger than the pane, and a graphic saved from another shell opening in the view. Not yet run on the live station.

## Input

- **A burst of keys acted on stale state (2026-11-12).** Symptom: `down` then `right` sent together (key repeat, fast typing, a multiplexer's send-keys) opened the row the cursor had just left. Cause: both keys reach the handlers in one turn of the event loop, before React has drawn the first one's effect. Fix: `useKeyPump` (once, in `App`) queues input and hands out one event at a time, waiting for a render in between; `useKeys` / `useMouse` register with it and always call the newest handler. Do not call Ink's `useInput` anywhere else.

- **Mouse.** SGR mouse reports (`ESC [ < b ; x ; y M`) arrive through Ink's input parser as one token. `useKeys` (the wrapper every view uses instead of `useInput`) drops them, so they never reach a text field; `useMouse` reads them from Ink's internal input emitter. Rows are located by absolute screen position, which is why views get a `rect`.
- **Backspace.** Ink reports macOS backspace (0x7f) as `key.delete`; treat `backspace` and `delete` alike.

## Installing a local build

- **`bask` killed on start after copying a new build over the old one (2026-11-12).** Symptom: `cp bin/bask ~/.local/bin/bask` succeeded, but every `bask` command then exited at once with status 137 and no output; the copy's checksum matched the build. Cause (as far as I can tell): macOS keeps the code signature it saw for that file, and `cp` rewrites the same file in place, so the new contents no longer match and the system kills it. Fix: put the new binary beside the old one and move it into place, which makes a new file: `cp bin/bask ~/.local/bin/bask.new && chmod +x ~/.local/bin/bask.new && mv -f ~/.local/bin/bask.new ~/.local/bin/bask`. Verified: the same binary ran from the new file and after the move.

## Demo station

- `src/demo/station.ts` speaks the real protocol and is what the dashboard tests run on (`live: false` freezes its values). When the module's replies change shape, change the demo to match; do not special-case the demo in the views.
- The buildings are in `src/demo/sites.ts`: a site fills in the tree, alarms, a day of agent history, files, and what keeps happening. To add one, add a `Site` there with its own port and profile; nothing else needs to know.
- The first `bask demo` to start hosts the station on the port; later ones (other panes, an agent's `bask`) join it. When the host window closes the others reconnect to nothing.

## Checked on the live station, and not yet

- Read from the 4.15.3.28 station on 2026-11-12: `describe` (full metadata, the `n:station` tag used for the audit history ORD), `describe_component` slots, `read_agent_log`, and `read_history` on `history:/<station>/AuditHistory` (the text form `parseAudit` reads).
- Not yet run against it: the new dashboard as a whole, the built-in BQL reports (their syntax comes from the Developer Guide's BQL examples), and the Schedules view (that station has no schedules).
