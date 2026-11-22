// The four later checks of bask check (docs/ROADMAP.md, E1): points overridden for longer than a
// set time, histories that stopped recording, alarm classes nothing uses, and schedule exceptions in
// the past. Each is found where the simulated building has it planted, and only there.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OPERATIONS } from "@basidekick/baskstream";
import { CHECK_OPERATIONS, exceptionEnd, intervalMs, overridesIn, runCheck } from "../dist/check.js";
import { loadRules } from "../dist/check-rules.js";
import { startStation } from "./harness.mjs";

const dir = mkdtempSync(join(tmpdir(), "bask-check-more-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NET = "slot:/Drivers/BacnetNetwork";
const HOUR = 3600000;
const found = (result, rule) => result.findings.filter((f) => f.rule === rule);
const places = (result, rule) => found(result, rule).map((f) => f.where);

async function check(site, plant, rules = loadRules()) {
  const { station, client, close } = await startStation({ site });
  try {
    await plant?.(station, client);
    return await runCheck(client, rules);
  } finally {
    await close();
  }
}

test("Northgate as it ships: the old override, the stopped history, the unused alarm class and last year's holiday", async () => {
  const result = await check("northgate");
  const long = found(result, "points.overriddenLong");
  assert.deepEqual(long.map((f) => f.where), [`${NET}/AHU_02/points/SupplyFanSpeed`]);
  assert.match(long[0].message, /^overridden for 16 hours \(since \d+ \w{3} \d\d:\d\d, by admin\): 85\.0 %/);

  assert.deepEqual(places(result, "histories.stopped"), [`${NET}/VAV_106/points/Airflow`]);
  assert.equal(found(result, "histories.stopped")[0].message, "its history has no record for 3 days; it records every 5 minutes");
  assert.ok(result.rules.find((r) => r.id === "histories.stopped").rows > 50, "every point with a history was asked about");

  // critical, maintenance and default each hold an alarm; afterHours holds none and no extension names it.
  assert.deepEqual(places(result, "alarms.unusedClasses"), ["slot:/Services/AlarmService/afterHours"]);
  assert.match(found(result, "alarms.unusedClasses")[0].message, /no alarm extension names afterHours, and none of the 11 alarms read is in it/);

  // WinterBreak was last December; NewYear is still to come and is left alone.
  const past = found(result, "schedules.pastExceptions");
  assert.deepEqual(past.map((f) => f.where), ["slot:/Schedules/OfficeHours"]);
  assert.equal(past[0].message, `special events whose dates are over: WinterBreak (24 Dec ${new Date().getFullYear() - 1})`);
  for (const rule of ["points.overriddenLong", "histories.stopped"]) assert.equal(found(result, rule)[0].severity, "warning");
  for (const rule of ["alarms.unusedClasses", "schedules.pastExceptions"]) assert.equal(found(result, rule)[0].severity, "info");
});

test("the other buildings have none of the four", async () => {
  for (const site of ["riverside", "harbor", "summit", "eastgate"]) {
    const result = await check(site);
    for (const rule of ["points.overriddenLong", "histories.stopped", "alarms.unusedClasses", "schedules.pastExceptions"]) {
      assert.deepEqual(places(result, rule), [], `${site} ${rule}`);
      assert.equal(result.rules.find((r) => r.id === rule).skipped, undefined, `${site} ${rule}`);
    }
  }
});

test("an override counts as long by the audit history: a new one is not, one with no record is as old as the history reaches", async () => {
  const zone = `${NET}/VAV_101/points/ZoneSetpoint`;
  const fresh = await check("northgate", async (_station, client) => void (await client.write(zone, "override", 70)));
  // Just overridden: listed as overridden, not as long.
  assert.deepEqual(places(fresh, "points.overridden"), [zone]);
  assert.deepEqual(places(fresh, "points.overriddenLong"), [`${NET}/AHU_02/points/SupplyFanSpeed`]);

  // An override the audit history has no record of: older than everything that was read.
  const silent = await check("northgate", (station) => void (station.state.nodes.get(`${NET}/VAV_108/points/ZoneSetpoint`).override = { value: 68 }));
  const old = found(silent, "points.overriddenLong").find((f) => f.where === `${NET}/VAV_108/points/ZoneSetpoint`);
  assert.match(old.message, /^overridden for more than 6 days \(the audit history has no override of it since \d+ \w{3} \d\d:\d\d\)/);

  // The set time is the rule's: at 20 hours the sixteen-hour override is only "overridden".
  const file = join(dir, "long.json");
  writeFileSync(file, JSON.stringify({ rules: [{ id: "points.overriddenLong", test: { is: "compare", all: [{ field: "overriddenHours", op: "above", value: 20 }] } }] }));
  const lenient = await check("northgate", undefined, loadRules(file));
  assert.deepEqual(places(lenient, "points.overriddenLong"), []);
  assert.deepEqual(places(lenient, "points.overridden"), [`${NET}/AHU_02/points/SupplyFanSpeed`]);
});

test("a history under a dead device is not listed again, and one that records on change is left alone", async () => {
  const result = await check("northgate", (station) => {
    const { nodes } = station.state;
    for (const name of ["ZoneTemp", "Airflow"]) nodes.get(`${NET}/VAV_107/points/${name}`).historyStoppedAt = Date.now() - 50 * HOUR;
    nodes.get(`${NET}/VAV_101/points/ZoneTemp`).historyStoppedAt = Date.now() - 30 * HOUR;
    // Twelve minutes without a record is under three intervals and far under a day.
    nodes.get(`${NET}/VAV_102/points/ZoneTemp`).historyStoppedAt = Date.now() - 12 * 60000;
  });
  assert.deepEqual(places(result, "histories.stopped"), [`${NET}/VAV_101/points/ZoneTemp`, `${NET}/VAV_106/points/Airflow`]);
  assert.equal(result.rules.find((r) => r.id === "histories.stopped").covered, 2);
  assert.equal(intervalMs("15 minutes"), 900000);
  assert.equal(intervalMs("1 hour"), HOUR);
  assert.equal(intervalMs("irregular"), undefined);
});

test("reading the parts: overrides in audit records, and when a special event is over", () => {
  const at = Date.UTC(2026, 10, 12, 19, 50);
  const record = (user, operation, target, slot, value, timestamp = at) => ({ timestamp, value: `12-Nov-26 12:50 PM MST[${user}] ${operation};slotName=${slot};value=${value}`, summary: `12-Nov-26 12:50 PM MST ${operation} ${target} ${slot}  ${value} ${user}` });
  const overrides = overridesIn([
    record("admin", "Invoked", "/Drivers/N/AHU/points/Fan", "override", "85.0 %", at - 5000),
    record("ben", "Invoked", "/Drivers/N/AHU/points/Fan", "override", "90.0 %"),
    record("ben", "Invoked", "/Drivers/N/AHU/points/Fan", "auto", ""),
    record("ben", "Changed", "/Drivers/N/AHU/points/Valve", "override", "1"),
    record("ben", "Invoked", "/Drivers/N/AHU/points/Damper", "emergencyOverride", "0.0 %")
  ]);
  assert.deepEqual([...overrides], [["slot:/Drivers/N/AHU/points/Fan", { at, user: "ben" }], ["slot:/Drivers/N/AHU/points/Damper", { at, user: "ben" }]]);

  const day = (text) => ({ name: "x", display: text, days: { typeSpec: "schedule:DateSchedule", date: text } });
  assert.equal(exceptionEnd(day("24 Dec 2025")), new Date(2025, 11, 25).getTime());
  // A range ends when its last day does; a date with no year comes round again, so nothing is said.
  assert.equal(exceptionEnd({ name: "x", days: { typeSpec: "schedule:DateRangeSchedule", range: { start: "20 Dec 2024", end: "2 Jan 2025", display: "20 Dec 2024 - 2 Jan 2025" } } }), new Date(2025, 0, 3).getTime());
  assert.equal(exceptionEnd(day("25 Dec")), undefined);
  assert.equal(exceptionEnd({ name: "x", days: { typeSpec: "schedule:WeekAndDaySchedule", display: "last Monday of May" } }), undefined);
  // A date that cannot be read is taken as the end of its year.
  assert.equal(exceptionEnd(day("week 51 of 2024")), new Date(2025, 0, 1).getTime());
});

test("the four checks only read, and a station that refuses one skips it and runs the rest", async () => {
  for (const op of CHECK_OPERATIONS) assert.equal(OPERATIONS[op].gate, "none", op);
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const before = { audit: station.state.audit.length, writes: station.state.counters.writes, files: station.state.files.size };
    const call = client.call.bind(client);
    // An older station: no describe_history.
    client.call = (op, ...rest) => (op === "describe_history" ? call("describe_history_gone", ...rest) : call(op, ...rest));
    const result = await runCheck(client, loadRules());
    assert.match(result.rules.find((r) => r.id === "histories.stopped").skipped, /does not have describe_history/);
    assert.equal(places(result, "points.overriddenLong").length, 1);
    assert.equal(places(result, "alarms.unusedClasses").length, 1);
    assert.deepEqual({ audit: station.state.audit.length, writes: station.state.counters.writes, files: station.state.files.size }, before);
  } finally {
    await close();
  }
});
