import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { BaskStreamClient, BaskStreamError, OPERATIONS, toSlotOrd } from "../dist/index.js";
import { PASSWORD, USER, startFakeStation } from "./fake-station.mjs";

let station;
before(async () => {
  station = await startFakeStation();
});
after(async () => {
  await station.close();
});

const connect = (extra = {}) => BaskStreamClient.connect({ station: station.url, username: USER, password: PASSWORD, ...extra });

test("generated operations match the spec count", () => {
  assert.equal(Object.keys(OPERATIONS).length, 45);
  assert.equal(OPERATIONS.write.gate, "writes");
});

test("logs in with SCRAM, loads capabilities and reads points", async () => {
  let saved;
  const client = await connect({ onSession: (cookies) => (saved = cookies) });
  try {
    assert.equal(client.capabilities.apiVersion, "1.7");
    assert.ok(saved?.JSESSIONID, "session cookies were reported");
    const [snapshot] = await client.read(["slot:/Drivers/A"]);
    assert.equal(snapshot.value, 72.5);
  } finally {
    client.close();
  }
});

test("reuses a saved session without logging in again", async () => {
  let saved;
  const first = await connect({ onSession: (cookies) => (saved = cookies) });
  first.close();
  const logins = station.state.logins;
  const second = await BaskStreamClient.connect({ station: station.url, cookies: saved });
  try {
    assert.equal(station.state.logins, logins);
    assert.equal((await second.ping()).op, "pong");
  } finally {
    second.close();
  }
});

test("wrong password fails with login_failed", async () => {
  await assert.rejects(connect({ password: "nope" }), (error) => error instanceof BaskStreamError && error.code === "login_failed");
});

test("no credentials and no session fails with session_expired", async () => {
  await assert.rejects(BaskStreamClient.connect({ station: station.url }), (error) => error.code === "session_expired");
});

test("server errors reject with the protocol code", async () => {
  const client = await connect();
  try {
    await assert.rejects(client.write("slot:/A", "set", 1), (error) => error.code === "writes_disabled" && error.op === "write");
  } finally {
    client.close();
  }
});

test("requests time out", async () => {
  const client = await connect();
  try {
    await assert.rejects(client.call("slow", {}, { timeoutMs: 100 }), (error) => error.code === "timeout");
  } finally {
    client.close();
  }
});

test("watch receives cov values and stops on close", async () => {
  const client = await connect();
  try {
    const watch = await client.watch(["slot:/A", "slot:/B"], { group: "w1" });
    assert.equal(watch.values.get("slot:/A").value, 72.5);
    const changed = once(watch, "change");
    station.push({ op: "cov", points: [{ point: "slot:/B", ok: true, value: 55 }, { point: "slot:/Other", ok: true, value: 1 }] });
    const [snapshot] = await changed;
    assert.equal(snapshot.point, "slot:/B");
    assert.equal(watch.values.get("slot:/B").value, 55);
    assert.equal(watch.values.has("slot:/Other"), false);
    await watch.close();
    assert.equal(station.state.groups.has("w1"), false);
  } finally {
    client.close();
  }
});

test("resync re-reads watched points", async () => {
  const client = await connect();
  try {
    await client.watch(["slot:/A"], { group: "w2" });
    const reads = station.state.requests.filter((r) => r.op === "read").length;
    const changed = once(client, "resync");
    station.push({ op: "resync_required", reason: "event_backlog_overflow", droppedEvents: 3 });
    await changed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(station.state.requests.filter((r) => r.op === "read").length, reads + 1);
  } finally {
    client.close();
  }
});

test("reconnects after a drop, logs in again and restores watches", async () => {
  const client = await connect();
  try {
    await client.watch(["slot:/A"], { group: "w3" });
    const logins = station.state.logins;
    station.expireSessions();
    const reconnected = once(client, "reconnected");
    station.dropAll();
    await reconnected;
    assert.equal(station.state.logins, logins + 1);
    assert.deepEqual(station.state.groups.get("w3"), ["slot:/A"]);
    assert.equal(client.connected, true);
  } finally {
    client.close();
  }
});

test("pending requests fail when the connection drops", async () => {
  const client = await connect({ reconnect: false });
  const pending = client.call("slow", {}, { timeoutMs: 5000 });
  station.dropAll({ forgetGroups: false });
  await assert.rejects(pending, (error) => error.code === "connection_closed");
  client.close();
});

test("metrics and health over HTTP", async () => {
  const client = await connect();
  try {
    assert.match(await client.http.metrics(), /baskstream_requests_total/);
    assert.equal((await client.http.health()).ok, true);
  } finally {
    client.close();
  }
});

test("an empty watch holds no group and can grow later", async () => {
  const client = await connect();
  try {
    const watch = await client.watch([], { group: "w4" });
    assert.equal(station.state.groups.has("w4"), false);
    await watch.update(["slot:/A"]);
    assert.deepEqual(station.state.groups.get("w4"), ["slot:/A"]);
    await watch.update([]);
    assert.equal(station.state.groups.has("w4"), false);
    assert.equal(watch.values.size, 0);
  } finally {
    client.close();
  }
});

test("full station ORDs are reduced to slot ORDs", async () => {
  assert.equal(toSlotOrd("local:|station:|slot:/Drivers/A"), "slot:/Drivers/A");
  assert.equal(toSlotOrd("slot:/Drivers/A"), "slot:/Drivers/A");
  assert.equal(toSlotOrd("hierarchy:/x"), "hierarchy:/x");
  const client = await connect();
  try {
    const [snapshot] = await client.read(["local:|station:|slot:/Drivers/A"]);
    assert.equal(snapshot.point, "slot:/Drivers/A");
  } finally {
    client.close();
  }
});
