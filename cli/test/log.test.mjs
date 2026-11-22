// bask log (src/log.ts): one list of what happened, from the audit history, the alarms, the agent
// log and the proposals and changes. Overrides are spans; a change an agent asked for is one thing
// that happened, not two; `under` keeps a branch; and what could not be read is said in notes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BaskStreamClient } from "@basidekick/baskstream";
import { PASSWORD, USER, startFakeStation } from "../../sdk/test/fake-station.mjs";
import { LOG_LEGEND, NO_CHANGE_LIST, auditHistoryOrd, logText, parseAuditRecord, readLog, spanText, whenText } from "../dist/log.js";
import { startStation } from "./harness.mjs";

const NET = "slot:/Drivers/BacnetNetwork";
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ANSI = /\x1b\[[0-9;]*m/g;
const P = (path) => `${NET}/${path.replace("/", "/points/")}`;

test("a week of Northgate is one list, newest first, from the audit history, the alarms and the agent log", async () => {
  const { client, close } = await startStation({ site: "northgate" });
  try {
    const { events, notes } = await readLog(client, { since: Date.now() - 8 * DAY });
    assert.deepEqual(events.map((e) => e.at), events.map((e) => e.at).sort((a, b) => b - a), "newest first");
    assert.deepEqual([...new Set(events.map((e) => e.kind))].sort(), ["agent", "alarm", "change", "override", "proposal"]);
    // This station is API 1.11: it has no list of changes, so nothing comes from one, and a note says so.
    assert.deepEqual([...new Set(events.map((e) => e.source))].sort(), ["agentLog", "alarm", "audit"]);
    assert.ok(notes.includes(NO_CHANGE_LIST));
    assert.ok(events.every((e) => e.text && typeof e.at === "number"));

    // A person's change, with the old and the new value.
    const starved = events.find((e) => e.slot === "fallback" && e.ord === P("VAV_105/MaxAirflow"));
    assert.deepEqual({ ...starved, at: 0 }, { at: 0, kind: "change", who: "operator", ord: P("VAV_105/MaxAirflow"), slot: "fallback", from: "620 cfm", to: "310 cfm", text: "changed VAV_105/MaxAirflow fallback from 620 cfm to 310 cfm", source: "audit" });
    assert.ok(Math.abs(Date.now() - starved.at - (4 * DAY + 137 * MIN)) < MIN, "about four days ago");

    // An agent's own Niagara user is known from the agent log, so Niagara's record of what it did is marked.
    const renamed = events.find((e) => e.source === "audit" && e.who === "ai-claude" && /renamed ZnTmp to ZoneTemp/.test(e.text));
    assert.equal(renamed.agent, true);
    assert.equal(events.find((e) => e.source === "audit" && e.who === "admin" && /priority from 40 to 30/.test(e.text)).agent, undefined);
    // The agent log carries baskStream's own "Agent" audit records, so they are not listed twice; a login is not a change.
    assert.ok(!events.some((e) => /^Agent\b/.test(e.text) || /login/i.test(e.text)));
    const refused = events.find((e) => /was refused \(agent_value_out_of_bounds\)/.test(e.text));
    assert.deepEqual([refused.kind, refused.who, refused.agent, refused.source, refused.ord], ["agent", "Claude Code", true, "agentLog", P("VAV_104/ZoneSetpoint")]);
    // A tag written through baskStream is recorded with the slot "tag:<id>", and reads as a tag.
    assert.match(events.find((e) => e.slot === "tag:hs:chilledWaterPlant").text, /^tagged CHW_Plant hs:chilledWaterPlant$/);

    // Seven days back: an alarm on another day, with when it went back to normal.
    const freeze = events.find((e) => e.kind === "alarm" && /freeze protection/.test(e.text));
    assert.ok(Date.now() - freeze.at > 6 * DAY);
    assert.equal(freeze.until - freeze.at, HOUR);
    assert.match(freeze.text, /^Mixed air temperature low: freeze protection warning on AHU_01\/MixedAirTemp · critical, back to normal \d+ \w{3} \d\d:\d\d, acknowledged$/);
    assert.equal(freeze.who, undefined);
    assert.match(freeze.id, /^a\d{3}-/);
    const open = events.find((e) => e.kind === "alarm" && /Device down/.test(e.text));
    assert.deepEqual([open.until, open.ord], [undefined, `${NET}/VAV_107`]);
    assert.match(open.text, /still in fault, not acknowledged$/);

    const text = logText(events, { width: 120 }).replace(ANSI, "");
    const lines = text.split("\n");
    assert.equal(lines.length, events.length);
    assert.ok(lines.every((line) => [...line].length <= 120), "no line is wider than asked");
    assert.match(text, /^ *\d+ \w{3} \d\d:\d\d {2}• {2}operator +changed VAV_105\/MaxAirflow fallback from 620 cfm to 310 cfm$/m);
    assert.match(text, /^ *\d+ \w{3} \d\d:\d\d {2}• {2}ai-claude \(AI\) +renamed ZnTmp to ZoneTemp in VAV_108$/m);
    assert.match(text, /^ *\d+ \w{3} \d\d:\d\d {2}▲ +Chiller 2 failed to start on CHW_Plant\/Chiller2Status/m);
    assert.match(LOG_LEGEND, /• change {2}◆ override {2}▲ alarm/);
    assert.equal(logText([]), "Nothing happened in this time.");
  } finally {
    await close();
  }
});

test("an override is a span: released by a later auto, replaced by a later override, or said to have ended", async () => {
  const { client, close } = await startStation({ site: "northgate" });
  try {
    const read = async () => (await readLog(client, { since: Date.now() - 8 * DAY })).events;
    const first = await read();
    const overrides = (events, point) => events.filter((e) => e.kind === "override" && e.ord === P(point));

    // Released: the record of the auto closes it, and the release is an event of its own.
    const [fan] = overrides(first, "AHU_01/SupplyFanSpeed");
    assert.ok(Math.abs(fan.until - fan.at - 135 * MIN) < 1000);
    assert.deepEqual([fan.who, fan.to, fan.ended], ["admin", "60.0 %", undefined]);
    assert.match(fan.text, /^overrode AHU_01\/SupplyFanSpeed to 60\.0 % · released \d+ \w{3} \d\d:\d\d, in place 2 h 15 min$/);
    const release = first.find((e) => e.slot === "auto" && e.ord === P("AHU_01/SupplyFanSpeed"));
    assert.deepEqual([release.kind, release.at, release.text], ["change", fan.until, "released the override on AHU_01/SupplyFanSpeed, in place 2 h 15 min"]);

    // Still in place: nothing released it and the point says it is overridden now.
    const [held] = overrides(first, "AHU_02/SupplyFanSpeed");
    assert.deepEqual([held.until, held.ended, held.who], [undefined, undefined, "admin"]);
    assert.match(held.text, /^overrode AHU_02\/SupplyFanSpeed to 85\.0 % · still in place$/);

    // Set for an hour and never released: no record ends it, but the point is no longer overridden.
    // It was approved for an agent, so it is one event: Niagara's record, marked as an agent's, with the proposal.
    const [timed] = overrides(first, "VAV_102/ZoneSetpoint");
    assert.deepEqual([timed.until, timed.ended, timed.who, timed.agent, timed.id, timed.source], [undefined, true, "admin", true, "P1", "audit"]);
    assert.match(timed.text, /^overrode VAV_102\/ZoneSetpoint to 71\.0 °F, 60 min · no longer in place; the audit log does not say when it ended · approving P1, asked by Claude Code$/);
    assert.deepEqual(first.filter((e) => e.id === "P1").map((e) => [e.kind, e.who]), [["override", "admin"], ["proposal", "Claude Code"]], "the approval is not a third event");
    // A proposal that was turned down, or ran out, keeps its decision as an event.
    assert.deepEqual(first.filter((e) => e.id === "P2").map((e) => [e.kind, e.who, e.text.split(":")[0]]), [["proposal", "admin", "rejected P2"], ["proposal", "Claude Code", "asked to override 58.0 °F for 120 min on AHU_01/SupplyAirSetpoint (P2)"]]);
    assert.deepEqual(first.filter((e) => e.id === "P4").map((e) => [e.who, e.text.split(":")[0]]), [[undefined, "P4 ran out with nobody deciding"], ["Claude Code", "asked to set occupied on VAV_106/OccupancyMode (P4)"]]);
    assert.match(first.find((e) => e.id === "P5").text, / · waiting for a person$/);

    // Made now, on the station: one override, a second that takes its place, then a release.
    const zone = P("VAV_103/ZoneSetpoint");
    await client.write(zone, "override", 68);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await client.write(zone, "override", 69);
    const during = overrides(await read(), "VAV_103/ZoneSetpoint");
    assert.deepEqual(during.map((e) => [e.to, e.until === undefined, e.ended]), [["69", true, undefined], ["68", false, undefined]]);
    assert.equal(during[1].until, during[0].at, "the second one's time ends the first");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await client.write(zone, "auto");
    const after = overrides(await read(), "VAV_103/ZoneSetpoint");
    assert.ok(after.every((e) => e.until !== undefined));

    // A time that ended before the release still knows the override was released: the audit history is read on to now.
    const past = (await readLog(client, { since: Date.now() - 8 * DAY, until: during[0].at + 5 })).events.find((e) => e.kind === "override" && e.to === "69");
    assert.equal(past.until, after[0].until);
  } finally {
    await close();
  }
});

test("under keeps what happened to a branch; since and until bound it", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const box = `${NET}/VAV_105`;
    const { events } = await readLog(client, { under: box, since: Date.now() - 8 * DAY });
    assert.ok(events.length >= 5);
    assert.ok(events.every((e) => e.ord === box || e.ord.startsWith(`${box}/`)));
    assert.deepEqual([...new Set(events.map((e) => e.kind))].sort(), ["alarm", "change", "proposal"]);
    // VAV_1050 would not be under VAV_105, and something with no ORD (a file) is under nothing.
    assert.equal((await readLog(client, { under: `${NET}/VAV_10`, since: Date.now() - 8 * DAY })).events.length, 0);
    const onePoint = (await readLog(client, { under: `${box}/points/MaxAirflow`, since: Date.now() - 8 * DAY })).events;
    assert.deepEqual(onePoint.map((e) => e.who), ["operator"]);
    const whole = (await readLog(client, { under: "slot:/", since: Date.now() - 8 * DAY })).events;
    assert.ok(whole.some((e) => e.ord === undefined && /commissioning\.md/.test(e.text)), "the whole station keeps what has no ORD");

    // The alarms come from read_alarms with since and until, which this station now honours as a station does.
    const [from, to] = [Date.now() - 3 * DAY, Date.now() - DAY];
    const between = (await readLog(client, { since: from, until: to })).events;
    assert.ok(between.every((e) => e.at >= from && e.at <= to));
    assert.deepEqual(between.filter((e) => e.kind === "alarm").map((e) => e.text.split(" on ")[0]), ["Zone temperature high: 78.1 °F (limit 76.0 °F)", "Chilled water flow low: 352 gpm"]);
    const asked = await client.alarms({ scope: "all", filter: { since: from, until: to } });
    assert.deepEqual([asked.count, asked.filter], [2, { since: from, until: to }]);
    await assert.rejects(client.alarms({ scope: "all", filter: { from } }), (error) => error.code === "bad_request" && /Unknown alarm filter field: from/.test(error.message));
    await assert.rejects(client.alarms({ scope: "everything" }), (error) => error.code === "bad_request");
    // Closed alarms are in the alarm history only: the open list is as it was.
    assert.equal((await client.alarms({ scope: "open" })).count, [...station.state.alarms.values()].filter((a) => a.isOpen).length);

    // The newest are kept when there are more than asked for, and a note says how many were left out.
    const few = await readLog(client, { since: Date.now() - 8 * DAY, limit: 5 });
    assert.deepEqual(few.events.map((e) => e.at), whole.slice(0, 5).map((e) => e.at));
    assert.ok(few.notes.some((note) => new RegExp(`^${whole.length - 5} older events are left out: only the newest 5 are listed\\.$`).test(note)));
  } finally {
    await close();
  }
});

test("notes say in plain words what could not be read", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    // The audit history service says where the audit history is; the station's name is the fallback.
    assert.equal(await auditHistoryOrd(client), "history:/Northgate/AuditHistory");
    // Asked for further back than the audit log reaches.
    const oldest = Math.min(...station.state.audit.map((a) => a.timestamp));
    const { notes } = await readLog(client, { since: Date.now() - 30 * DAY });
    assert.ok(notes.includes(`The audit log starts ${whenText(oldest)}, after the ${whenText(Date.now() - 30 * DAY)} asked for: changes before that are gone.`), notes.join("\n"));
    // Inside what it holds, that is not said.
    assert.ok(!(await readLog(client, { since: Date.now() - DAY })).notes.some((note) => /audit log starts/.test(note)));
    assert.equal((await client.call("describe_history", { ord: "history:/Northgate/AuditHistory" })).history.histories[0].firstTimestamp, oldest);
    // A history read with its start after its end is refused, as a station refuses it.
    await assert.rejects(client.history("history:/Northgate/AuditHistory", { start: Date.now(), end: Date.now() - HOUR }), (error) => error.code === "bad_request");
  } finally {
    await close();
  }

  // A station with a change list (API 1.14) and no audit history to read.
  const fake = await startFakeStation();
  const person = await BaskStreamClient.connect({ station: fake.url, username: USER, password: PASSWORD });
  try {
    const now = Date.now();
    const point = "slot:/Drivers/Net/VAV_01/points/SpaceTemp";
    const actor = { kind: "agent", name: "Claude Code" };
    const base = { point, agentUser: "ai", actor, expiresAt: now + HOUR, decidedBy: null, decidedAt: null };
    fake.state.proposals.set("P1", { ...base, id: "P1", status: "pending", action: "override", value: 70, description: "override 70", reason: "too warm", createdAt: now - 10 * MIN });
    fake.state.proposals.set("P2", { ...base, id: "P2", status: "approved", action: "override", value: 71, description: "override 71", reason: "still warm", createdAt: now - 50 * MIN, decidedBy: "ben", decidedAt: now - 45 * MIN });
    fake.state.proposals.set("C3", { ...base, id: "C3", status: "applied", direct: true, kind: "files", operation: "write_file", point: "^notes/today.md", action: "write_file", description: "write 1.2 KB", reason: "notes", createdAt: now - 30 * MIN });
    fake.state.proposals.set("C4", { ...base, id: "C4", status: "applied", direct: true, kind: "tags", operation: "write_tags", point: "slot:/Drivers/Net/VAV_01", action: "write_tags", description: "add hs:vav", reason: "tagging", createdAt: now - 20 * MIN });
    // The agent log tells of P1's asking and of C4; the list tells the rest.
    fake.state.agentLog.push({ timestamp: now - 10 * MIN, user: "ai", target: point, action: "override", outcome: "proposed P1", agent: "Claude Code", change: "override 70", reason: "too warm" });
    fake.state.agentLog.push({ timestamp: now - 20 * MIN + 400, user: "ai", agentUser: "ai", target: "slot:/Drivers/Net/VAV_01", action: "write_tags", outcome: "completed", agent: "Claude Code", change: "add hs:vav", reason: "tagging" });

    const { events, notes } = await readLog(person, { since: now - 2 * HOUR });
    const told = events.filter((e) => e.kind !== "alarm").map((e) => [e.source, e.kind, e.id, e.who, e.text]);
    assert.deepEqual(told, [
      ["agentLog", "proposal", "P1", "Claude Code", "asked to override 70 on VAV_01/SpaceTemp (P1): too warm · waiting for a person"],
      // The agent log's record of a change the agent made itself gets the id it can be put back by.
      ["agentLog", "agent", "C4", "Claude Code", "add hs:vav on Net/VAV_01: tagging"],
      ["changes", "agent", "C3", "Claude Code", "write 1.2 KB on ^notes/today.md: notes"],
      ["changes", "proposal", "P2", "ben", "approved P2: override 71 on VAV_01/SpaceTemp, asked by Claude Code"],
      ["changes", "proposal", "P2", "Claude Code", "asked to override 71 on VAV_01/SpaceTemp (P2): still warm"]
    ]);
    assert.ok(events.every((e) => e.kind === "alarm" || e.agent === true));
    assert.equal(events.filter((e) => e.kind === "alarm").length, 2);
    assert.ok(!notes.includes(NO_CHANGE_LIST));
    assert.deepEqual(notes, ["No audit history was found on this station, so what people changed, and overrides, are not listed."]);
    assert.equal(await auditHistoryOrd(person), undefined, "a query answer that is not a history id is not taken for one");
  } finally {
    person.close();
    await fake.close();
  }
});

test("audit records are read from their text, and lengths of time are in words", () => {
  const at = Date.UTC(2026, 10, 12, 19, 50);
  const record = (value, summary) => ({ timestamp: at, recordType: "history:AuditRecord", value, summary });
  assert.deepEqual(parseAuditRecord(record("12-Nov-26 12:50 PM MST[admin] Invoked;slotName=override;value=71.0 °F, 60 min", "12-Nov-26 12:50 PM MST Invoked /Drivers/BacnetNetwork/VAV_102/points/ZoneSetpoint override  71.0 °F, 60 min admin")),
    { at, user: "admin", operation: "Invoked", target: "slot:/Drivers/BacnetNetwork/VAV_102/points/ZoneSetpoint", slot: "override", oldValue: "", value: "71.0 °F, 60 min" });
  // A value that itself holds ";value=" keeps all of it, and an old value with spaces does not move the target.
  assert.deepEqual(parseAuditRecord(record("12-Nov-26 12:50 PM MST[ben] Changed;slotName=fallback;oldValue=54.0 °F {ok};value=a;value=b", "12-Nov-26 12:50 PM MST Changed /Drivers/A B/points/Sp fallback 54.0 °F {ok} a;value=b ben")),
    { at, user: "ben", operation: "Changed", target: "slot:/Drivers/A B/points/Sp", slot: "fallback", oldValue: "54.0 °F {ok}", value: "a;value=b" });
  assert.equal(parseAuditRecord(record("not an audit record", "")), undefined);
  assert.equal(parseAuditRecord({ value: "12-Nov-26 12:50 PM MST[admin] Invoked", summary: "" }), undefined, "a record with no time is not one");
  assert.deepEqual([spanText(20 * 1000), spanText(40 * MIN), spanText(135 * MIN), spanText(3 * HOUR), spanText(4 * DAY + 2 * HOUR + 20 * MIN), spanText(7 * DAY)], ["under a minute", "40 min", "2 h 15 min", "3 h", "4 days 2 h", "7 days"]);
});
