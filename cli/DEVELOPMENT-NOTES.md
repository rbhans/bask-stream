# bask development notes

Short notes on problems that were solved, so they are not solved twice.

## Dashboard rendering

- **Stale or doubled lines in a real terminal (2026-11-12).** Symptom: with Ink's `incrementalRendering`, panes in tmux and Rex kept lines from an earlier frame, shifting everything below them; resizing a pane made it worse. In-memory tests could not show it. Cause: Ink redraws relative to where it believes the cursor is, and that drifts. Fix: `src/tui/run.tsx` renders Ink in debug mode into a stand-in stream (each write is one whole frame) and a small `Painter` writes only the changed lines, each at its absolute row, inside synchronized-output markers; a resize clears the screen and repaints. Each row is cleared before it is written, because clearing after a line that fills the row erases its last character. Verified in tmux and Rex with `tmux capture-pane` / `rex capture`.
- **Overlapping lines inside a panel.** Symptom: one line drawn over another (a label lost its first letter). Cause: content one row taller than its panel; Yoga shrank a one-line `<Text>` to zero height. Fix: `Panel` wraps its children in a box with `flexShrink={0}` and `minHeight`, so overflow is cut off at the bottom. Views should still budget their rows.
- **Control sequences.** With Ink writing into the stand-in stream, anything written to Ink's `stdout` is treated as a frame. Mouse mode, the window title and clipboard copies go through the `terminal` prop instead.
- **Tables.** `fit()` treats a column with `min: 0` as hidden (no width, no separator). Give a column a real `min` when it should show.

## Symbols

- A symbol is `draw(state, frame)` returning rows of characters and a paint letter per character (`paint()` in `library.ts` maps letters to theme colours, so both themes work). Every row and paint row must be the symbol's full width in every state and frame; `test/symbols.test.mjs` checks all of them.
- Air-handler sections are five rows (wall, three rows, wall) with no side walls, so placing them side by side makes one casing. Other equipment draws its own outline and lists `ports`: the cell just outside it where a line attaches.
- `Canvas.route` keeps the lines separate from the sprites: sprites cover lines, routes that meet become tees and crosses, and a route's end is drawn as plain line so it meets the port it runs up to. Flow marks sit only on straight cells.
- Characters are limited to box drawing, block elements, geometric shapes and a few ASCII marks, which terminal fonts have. Dingbats and emoji are avoided: fonts fall back and the cells stop lining up.
- When judging the look from an HTML capture, a font fallback there can widen some marks and nudge a border; a terminal keeps every cell the same width.

## Input

- **A burst of keys acted on stale state (2026-11-12).** Symptom: `down` then `right` sent together (key repeat, fast typing, a multiplexer's send-keys) opened the row the cursor had just left. Cause: both keys reach the handlers in one turn of the event loop, before React has drawn the first one's effect. Fix: `useKeyPump` (once, in `App`) queues input and hands out one event at a time, waiting for a render in between; `useKeys` / `useMouse` register with it and always call the newest handler. Do not call Ink's `useInput` anywhere else.

- **Mouse.** SGR mouse reports (`ESC [ < b ; x ; y M`) arrive through Ink's input parser as one token. `useKeys` (the wrapper every view uses instead of `useInput`) drops them, so they never reach a text field; `useMouse` reads them from Ink's internal input emitter. Rows are located by absolute screen position, which is why views get a `rect`.
- **Backspace.** Ink reports macOS backspace (0x7f) as `key.delete`; treat `backspace` and `delete` alike.

## Demo station

- `src/demo/station.ts` speaks the real protocol and is what the dashboard tests run on (`live: false` freezes its values). When the module's replies change shape, change the demo to match; do not special-case the demo in the views.
- The buildings are in `src/demo/sites.ts`: a site fills in the tree, alarms, a day of agent history, files, and what keeps happening. To add one, add a `Site` there with its own port and profile; nothing else needs to know.
- The first `bask demo` to start hosts the station on the port; later ones (other panes, an agent's `bask`) join it. When the host window closes the others reconnect to nothing.

## Checked on the live station, and not yet

- Read from the 4.15.3.28 station on 2026-11-12: `describe` (full metadata, the `n:station` tag used for the audit history ORD), `describe_component` slots, `read_agent_log`, and `read_history` on `history:/<station>/AuditHistory` (the text form `parseAudit` reads).
- Not yet run against it: the new dashboard as a whole, the built-in BQL reports (their syntax comes from the Developer Guide's BQL examples), and the Schedules view (that station has no schedules).
