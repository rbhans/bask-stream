# @basidekick/baskstream

TypeScript client for the baskStream WebSocket API on Niagara 4 stations (Node 20+).

```ts
import { BaskStreamClient } from "@basidekick/baskstream";

const client = await BaskStreamClient.connect({
  station: "https://192.168.0.126",
  username: "test",
  password: () => process.env.BASKSTREAM_PASSWORD!, // only asked for when a login is needed
  verifyTls: false,                                   // self-signed station certificate
  onSession: (cookies) => save(cookies)               // reuse with { cookies } next time
});

const [temp] = await client.read(["slot:/Drivers/Net/VAV_01/points/SpaceTemp"]);

const watch = await client.watch(["slot:/Drivers/Net/VAV_01/points/SpaceTemp"]);
watch.on("change", (snapshot) => console.log(snapshot.point, snapshot.value));

const day = await client.historyRollup(temp.point, { start: Date.now() - 86400000, interval: 3600000 });
const open = await client.alarms({ scope: "open", order: "newest" });
```

- **Login**: Niagara's SCRAM-SHA-256 web login, verifying the station's signature. Saved cookies are reused; the password is requested only when they have expired.
- **Requests**: `call(op, fields)` sends any of the 67 operations (generated from `spec/baskstream-protocol.json`); failures reject with `BaskStreamError` whose `code` is the protocol error code, or `timeout`, `not_connected`, `connection_closed`, `login_failed`, `session_expired`, `bad_message`. `message_too_large` means the request is bigger than the station's `maxMessageBytes`; it is refused before it is sent. `snapshot()` adds `browser_not_found` and `snapshot_failed`.
- **Helpers**: `browse`, `describe`, `search`, `read`, `write`, `describeWrite`, `history`, `historyRollup`, `alarms`, `ackAlarms`, `clearAlarms`, `schedule`, `scheduleEvents`, `writeSchedule`, `subscriptionStatus`, `subscribeAlarms`.
- **Live data**: `watch()` keeps a named subscription group: it renews the lease, re-reads after `resync_required`, and is restored after a reconnect. The client also emits `value`, `cov`, `alarm`, `model`, `resync`, `revoked` and `notice`.
- **Staying connected**: keepalive pings; after a drop it reconnects with backoff (1 s → 30 s), logs in again if needed, and emits `disconnected`, `reconnecting`, `reconnected`.

## AI agents

Pass `actor` to declare the connection an AI agent; the station then applies its agent rules (see `docs/AI_AGENTS.md`). Give a `reason` with changes. While the station requires approval, writes come back as proposals:

```ts
const agent = await BaskStreamClient.connect({ ...options, actor: { name: "Claude Code", model: "claude-opus-5-5", onBehalfOf: "ben" } });
const entry = await agent.write(point, "override", 72, { reason: "Room 204 is too cold" });
// entry.outcome === "proposed"; entry.proposal.id === "P7"
agent.on("proposal", (p) => console.log(p.id, p.status)); // approved, rejected, expired or failed
```

People use `proposals()`, `approveProposal(id)` and `rejectProposal(id, note)`; `agentLog()` reads the `Agent` records from the station's audit history. `explainChange("write_file", { path: "^px/Home.px" })` says what the station would do with a change and which setting decides, without making it (API 1.13). `capabilities.agents.profile` names the agent profile a session follows, if any.

From API 1.14 any kind of change can be kept for a person instead of being made. The call then rejects with `ChangeProposedError` (`code: "change_proposed"`), which carries the `proposal`: catch it, tell the person, and do not send the change again. `changes()` lists every change agents asked for or made, with `canRevert` and the `check` the station ran afterwards; `revertChange(id, { force, partial, reason })` puts one back (people only). A `write` entry may carry `expect: { point, min, max, withinMinutes }`.

`putFile(path, bytes)` writes a file of any size up to 16 MiB, in pieces when it does not fit one message. `resolve(equip, { role: "discharge air temp" })` returns the point that plays a role on a piece of equipment, inferred from tags and names; `point` is null when no match is clearly best.

An agent's other changes (files, discovery, model plans, tags, schedules, alarms) fail with `approval_required` unless the station's `agentDirect…` setting for that kind is on. `agent.capabilities.agents.direct` (API 1.11) says what is allowed: `{ pointWrites, files, discovery, modelEdits, tags, schedules, alarms }`, and `agents.pointWrites` (API 1.13) says whether a point command is refused, proposed or written: `refuse`, `ask` or `allow`. With `refuse`, `write` fails with `agent_writes_refused`. An agent's model plan cannot command a writable point (`agent_use_write`); use `write`.

## Seeing a page

`snapshot()` takes pictures of a Px page as a person sees it in a web browser, with live values, so an app or an AI agent can check a page after changing it:

```ts
const shot = await client.snapshot("^px/ahu.px");                                   // a Px file
const unit = await client.snapshot("slot:/Drivers/BacnetNetwork/AHU_1", { view: "Graphic" }); // a component's view
await writeFile("ahu.png", shot.frames[0].png);
```

- It opens the page in headless Chrome, Chromium or Microsoft Edge on this computer (`browser`, or `BASKSTREAM_BROWSER`, picks one), using this connection's session cookies; it logs in again first if they have expired. The browser gets a throwaway profile, deleted afterwards. Nothing is added to the station.
- It waits for the page to load and its network to go quiet, then `settleMs` (default 3000) for bound values. `width` × `height` is the window (default 1600 × 900); only what fits is pictured. `frames` and `intervalMs` take several pictures to show animation or changing values.
- The result has the PNG `frames` and what an agent needs to judge the page: `title`, `httpStatus`, `failedRequests` and the page's `consoleErrors`.
- It's the browser's rendering, through the user's web profile; Workbench can differ.
- Errors: `browser_not_found`, `session_expired` (the station sent the browser to its login page) and `snapshot_failed`. `snapshotPage(http, page, options)` does the same with a `StationHttp` alone.

## Develop

```bash
npm install
npm test
```

This repository does not publish the package to npm. To use it in an app, build it here (`npm install && npm run build`), then add it from the app's folder with `npm install <path to this repository>/sdk`.

`npm run gen` regenerates `src/operations.ts` from the spec; `tests/protocol_contract.py` fails if it is stale. Tests run against an in-process fake station (`test/fake-station.mjs`).

On the Parallels shared drive, npm cannot create symlinks, so `.npmrc` sets `bin-links=false` and the scripts call `tsc` through `node`.

## Headless Workbench (API 1.10)

Queries, station files, jobs and discovery; see `docs/HEADLESS_WORKBENCH.md`.

```ts
const faults = await client.query({ bql: "select slotPath, status from control:ControlPoint where status.fault" }, { ord: "slot:/Drivers" });
const page = await client.readFile("^px/Home.px");
await client.writeFile("^px/Home.px", { text: page.text! }, { overwrite: true, reason: "fix label" });

const { job } = await client.discover("slot:/Drivers/BacnetNetwork/AHU_1");
let found = await client.job(job);
while (!found.complete) found = await client.job(job);
const plan = await client.addDiscovered(job, found.results.map((r) => ({ slot: r.slot })));
await client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: crypto.randomUUID() });
```

Also `listFiles`, `deleteFile`, `jobs` and `cancelJob`.

## The engines

Everything `bask` works out about a station is in this package, so another program gets it without the CLI. Each takes a connected `BaskStreamClient` and returns plain data; the `…Text` functions give the same thing as readable text.

| What | Functions |
| --- | --- |
| Why a point reads what it does | `explain`, `whyText` |
| What happened: changes, overrides, alarms, AI activity | `readLog`, `logText` |
| What points read at a past moment | `valuesAt`, `seriesFor`, `parseAt` |
| Checkouts from a plain document | `parseCheckout`, `rehearseCheckout`, `runCheckout`, `checkoutReport` |
| The site: equipment, what feeds what | `readEvidence`, `inferModel`, `inferServes`, `buildReview`, `readSite` |
| Logic: reading a sheet, following a value | `loadSheet`, `traceOf` |
| Checks, export, diff, apply | `@basidekick/baskstream/check`, `/export`, `/diff`, `/apply` |

```ts
import { BaskStreamClient, explain, readLog } from "@basidekick/baskstream";

const client = await BaskStreamClient.connect({ station, username, password });
const why = await explain(client, "slot:/Drivers/BacnetNetwork/VAV_105/points/ZoneTemp");
const log = await readLog(client, { since: Date.now() - 86_400_000 });
```

Each module can also be imported by itself, e.g. `@basidekick/baskstream/why`.
