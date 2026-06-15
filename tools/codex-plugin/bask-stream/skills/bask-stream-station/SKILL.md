---
name: bask-stream-station
description: Use when working with a Niagara station through baskStream MCP tools, including station discovery, point reads, histories, schedules, alarms, or gated point writes.
---

# baskStream Station Workflow

Use live MCP calls as the source of truth when the station is reachable.

Start with:

1. `baskstream_diagnose_connection`
2. `baskstream_capabilities`
3. `baskstream_browse` on `slot:/` with shallow depth
4. Targeted `baskstream_search`, `baskstream_describe`, or summary tools

Rules:

- Do not guess equipment meaning, room relationships, or point roles.
- Use read-only tools by default.
- For values, use `baskstream_read_points`.
- For histories, use `baskstream_describe_history` before `baskstream_read_history`.
- For schedules, use `baskstream_read_schedule`.
- For alarms, use bounded `baskstream_read_alarms` calls.
- For writes, call `baskstream_describe_write` first and only use actions it reports as supported.
- Do not treat metadata such as `writable` as enough to render or execute write controls.
- Point writes require `BASKSTREAM_ALLOW_WRITES=true`.
- Alarm acknowledge and clear require `BASKSTREAM_ALLOW_ALARM_ACTIONS=true`.

When reporting results, separate verified station facts from unresolved questions.

