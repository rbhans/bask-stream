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
- **Requests**: `call(op, fields)` sends any of the 45 operations (generated from `spec/baskstream-protocol.json`); failures reject with `BaskStreamError` whose `code` is the protocol error code, or `timeout`, `not_connected`, `connection_closed`, `login_failed`, `session_expired`, `bad_message`.
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

People use `proposals()`, `approveProposal(id)` and `rejectProposal(id, note)`; `agentLog()` reads the `Agent` records from the station's audit history.

## Develop

```bash
npm install
npm test
```

`npm run gen` regenerates `src/operations.ts` from the spec; `tests/protocol_contract.py` fails if it is stale. Tests run against an in-process fake station (`test/fake-station.mjs`).

On the Parallels shared drive, npm cannot create symlinks, so `.npmrc` sets `bin-links=false` and the scripts call `tsc` through `node`.
