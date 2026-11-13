import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
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
  const spec = JSON.parse(readFileSync(new URL("../../spec/baskstream-protocol.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(OPERATIONS), Object.keys(spec.operations));
  assert.equal(OPERATIONS.write.gate, "writes");
});

test("logs in with SCRAM, loads capabilities and reads points", async () => {
  let saved;
  const client = await connect({ onSession: (cookies) => (saved = cookies) });
  try {
    assert.equal(client.capabilities.apiVersion, "1.10");
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

test("agents declare themselves, propose writes, and a person approves", async () => {
  const agent = await connect({ actor: { name: "Claude Code", model: "claude-opus-5-5", onBehalfOf: "ben" } });
  const person = await connect();
  try {
    assert.equal(agent.capabilities.agents.isAgent, true);
    assert.equal(person.capabilities.agents.isAgent, false);

    await assert.rejects(agent.write("slot:/A", "override", 72), (error) => error.code === "reason_required");
    const seen = once(person, "proposal");
    const entry = await agent.write("slot:/A", "override", 72, { reason: "Room 204 is too cold" });
    assert.equal(entry.outcome, "proposed");
    const [created] = await seen;
    assert.equal(created.id, entry.proposal.id);
    assert.equal((await person.proposals("pending")).length >= 1, true);

    await assert.rejects(agent.approveProposal(created.id), (error) => error.code === "agent_cannot_approve");
    const decided = once(agent, "proposal");
    const approved = await person.approveProposal(created.id.replace("P", ""));
    assert.equal(approved.status, "approved");
    assert.equal((await decided)[0].status, "approved");
    await assert.rejects(person.approveProposal(created.id), (error) => error.code === "proposal_closed");

    const log = await person.agentLog();
    assert.match(log.records[0].outcome, /^approved P\d+ by test$/);
    assert.match(log.records[1].outcome, /^proposed P\d+$/);
  } finally {
    agent.close();
    person.close();
  }
});

test("the actor is declared again after a reconnect", async () => {
  const agent = await connect({ actor: { name: "Claude Code" } });
  try {
    const reconnected = once(agent, "reconnected");
    station.dropAll({ forgetGroups: false });
    await reconnected;
    assert.equal(agent.capabilities.agents.isAgent, true);
  } finally {
    agent.close();
  }
});

test("read passes fields and fresh, and keeps the old fields-array form", async () => {
  const client = await connect();
  try {
    const [plain] = await client.read(["slot:/A"]);
    assert.equal(plain.fresh, undefined);
    assert.equal(plain.state, "ok");
    const [fresh] = await client.read(["slot:/A"], { fresh: true, freshWaitMillis: 1000 });
    assert.equal(fresh.fresh, true);
    const sent = station.state.requests.filter((r) => r.op === "read").at(-1);
    assert.equal(sent.freshWaitMillis, 1000);
    await client.read(["slot:/A"], ["value"]);
    assert.deepEqual(station.state.requests.filter((r) => r.op === "read").at(-1).fields, ["value"]);
  } finally {
    client.close();
  }
});

test("queries, station files, jobs and discovery (API 1.10)", async () => {
  const client = await connect();
  try {
    const table = await client.query({ bql: "select slotPath, out.value from control:NumericPoint" }, { ord: "station:|slot:/Drivers" });
    assert.equal(table.columns[0].name, "slotPath");
    assert.equal(table.rows[0][1], 72.5);
    assert.equal(station.state.requests.at(-1).ord, "slot:/Drivers");
    const tagged = await client.query({ neql: "hs:vav" });
    assert.equal(tagged.entities[0].name, "VAV_01");
    await assert.rejects(client.query({ bql: "select x from nothing" }), (error) => error.code === "bad_query");

    assert.deepEqual((await client.listFiles("^px")).entries.map((e) => e.name), ["Home.px"]);
    assert.equal((await client.readFile("^px/Home.px")).text, "<px/>");
    await assert.rejects(client.writeFile("^px/Home.px", { text: "<px>2</px>" }), (error) => error.code === "file_exists");
    assert.equal((await client.writeFile("^px/Home.px", { text: "<px>2</px>" }, { overwrite: true })).created, false);
    assert.equal((await client.writeFile("^px/New.px", { text: "<px/>" }, { reason: "new page" })).created, true);
    assert.deepEqual((await client.deleteFile("^px/New.px")).deleted, ["^px/New.px"]);
    await assert.rejects(client.readFile("^px/New.px"), (error) => error.code === "file_not_found");

    const discovery = await client.discover("slot:/Drivers/Net/VAV_01");
    assert.equal(discovery.kind, "points");
    const job = await client.job(discovery.job);
    assert.equal(job.complete, true);
    assert.equal(job.results[0].slot, "analogInput_3");
    assert.equal((await client.jobs()).length, 1);
    const plan = await client.addDiscovered(discovery.job, [{ slot: "analogInput_3", name: "SpaceTemp" }]);
    assert.equal(plan.state, "preview");
    assert.equal(plan.items[0].name, "SpaceTemp");
    assert.equal((await client.cancelJob(discovery.job)).state, "canceled");
    await assert.rejects(client.discover("slot:/Drivers/Modbus"), (error) => error.code === "discovery_unsupported");
  } finally {
    client.close();
  }
});
