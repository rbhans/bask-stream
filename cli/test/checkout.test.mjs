// bask test (docs/CHECKOUT.md): a checkout document is read whole or not at all; a rehearsal looks
// and commands nothing; a run overrides with a time limit, watches the feedback, and releases every
// point a step overrode whether the step passed, failed or was stopped; and the station's rules for
// agents still decide what is commanded.
//
// Riverside is the building for it: AHU_OR's fan status follows its speed command and its supply air
// follows its setpoint, while AHU_Patient's fan status reads On whatever the fan is told.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BaskStreamClient, BaskStreamError, ChangeProposedError } from "@basidekick/baskstream";
import { CheckoutParseError, checkoutExitCode, checkoutReport, checkoutText, holdSeconds, parseCheckout, rehearseCheckout, runCheckout } from "../dist/checkout.js";
import { startStation } from "./harness.mjs";

const NET = "slot:/Drivers/BacnetNetwork";
const OR = `${NET}/AHU_OR/points`;
const PATIENT = `${NET}/AHU_Patient/points`;
const ANSI = /\x1b\[[0-9;]*m/g;
const text = (result) => checkoutText(result).replace(ANSI, "");

/** Riverside, with the feedbacks answering in a third of a second so a test does not wait on them. */
async function riverside() {
  const started = await startStation({ site: "riverside" });
  const { nodes } = started.station.state;
  nodes.get(`${OR}/SupplyFanStatus`).follows.lagMs = 300;
  nodes.get(`${OR}/SupplyAirTemp`).follows.lagMs = 300;
  return { ...started, nodes, overridden: () => [...nodes.values()].filter((n) => n.override).map((n) => n.ord) };
}

/** A client that answers some writes itself, the way a station with tighter rules would. */
function answering(client, write) {
  return new Proxy(client, {
    get(target, name) {
      if (name === "write") return async (point, action, value, options) => (await write(point, action, value, options)) ?? target.write(point, action, value, options);
      const member = Reflect.get(target, name);
      return typeof member === "function" ? member.bind(target) : member;
    }
  });
}

const AHU = `# AHU-OR functional test
station: Riverside
equipment: ${OR}

Unit in Auto at the starter before this is run.

## Supply fan proves off and on
The status comes from a current switch on the fan motor.
- note SupplyFanSpeed
- set SupplyFanSpeed 0
- expect SupplyFanStatus is off within 5s
- set SupplyFanSpeed 60 %
- expect SupplyFanStatus is on within 5s

## Supply air follows its setpoint
- note SupplyAirTemp
- for 66, 70:
  - set SupplyAirSetpoint {value}
  - expect SupplyAirTemp within 1.5 of {value} within 5s

## Patient wing fan proves off
equipment: ${PATIENT}
- set SupplyFanSpeed 0
- expect SupplyFanStatus is off within 1s
`;

test("a document reads the way it is written: steps, points under the equipment, a for written out, text kept", () => {
  const doc = parseCheckout(`# AHU-2 functional test
equipment: slot:/Drivers/BacnetNetwork/AHU_02/points

Have the unit in Auto.
- Ladder and a meter

## Supply fan starts on command
Listen for the fan.
- set SupplyFanCmd on
- expect SupplyFanStatus is on within 30s

## Fan speed follows command
- for 25, 50, 75, 100:
  - set SupplyFanSpeed {value}
  - expect SupplyFanSpeedFbk within 3 of {value} within 60s

## Cooling valve closes fully
- note SupplyAirTemp
- set CoolingValve 0
- wait 2m
- expect SupplyAirTemp rises at least 2 within 5m
- release CoolingValve
`, "jobs/ahu-2.md");
  assert.equal(doc.title, "AHU-2 functional test");
  assert.equal(doc.from, "jobs/ahu-2.md");
  assert.deepEqual(doc.text, ["Have the unit in Auto.", "- Ladder and a meter"]);
  assert.deepEqual(doc.steps.map((s) => [s.title, s.line, s.lines.length]), [["Supply fan starts on command", 7, 2], ["Fan speed follows command", 12, 8], ["Cooling valve closes fully", 17, 5]]);
  assert.deepEqual(doc.steps[0].text, ["Listen for the fan."]);

  const [set, expect] = doc.steps[0].lines;
  assert.deepEqual(set, { line: 9, text: "set SupplyFanCmd on", point: `${NET}/AHU_02/points/SupplyFanCmd`, name: "SupplyFanCmd", kind: "set", value: true, valueText: "on" });
  assert.deepEqual(expect, { line: 10, text: "expect SupplyFanStatus is on within 30s", point: `${NET}/AHU_02/points/SupplyFanStatus`, name: "SupplyFanStatus", kind: "expect", comparison: { kind: "is", value: true, text: "on" }, withinMs: 30000 });

  // The for is written out: one copy of its lines for each value, in order.
  const loop = doc.steps[1].lines;
  assert.deepEqual(loop.map((l) => [l.kind, l.loop, l.line]), [25, 50, 75, 100].flatMap((v) => [["set", String(v), 14], ["expect", String(v), 15]]));
  assert.deepEqual([loop[2].value, loop[2].text], [50, "set SupplyFanSpeed 50"]);
  assert.deepEqual(loop[3].comparison, { kind: "near", value: 50, tolerance: 3 });
  assert.equal(loop[3].withinMs, 60000);

  const valve = doc.steps[2].lines;
  assert.deepEqual(valve.map((l) => l.kind), ["note", "set", "wait", "expect", "release"]);
  assert.equal(valve[2].ms, 120000);
  assert.deepEqual([valve[3].comparison, valve[3].withinMs], [{ kind: "rises", by: 2 }, 300000]);
  assert.equal(doc.points.length, 6);

  // Each override is asked to last 15 minutes, or the step's own waits and two minutes more.
  assert.equal(holdSeconds(doc.steps[0]), 900);
  assert.equal(holdSeconds(parseCheckout(`equipment: ${OR}\n## Long soak\n- set SupplyAirSetpoint 70\n- wait 40m\n- expect SupplyAirTemp above 68 within 10m\n`, "soak.md").steps[0]), 50 * 60 + 120 + 15);
});

test("the grammar forgives how people write: numbered and ticked lists, units, spelled-out times, to, code ticks", () => {
  const doc = parseCheckout(`equipment: Drivers/BacnetNetwork/VAV_101/points/
## Box
1. Set \`DamperPosition\` to 100 % for 10 minutes.
2. [ ] expect Airflow is above 500 cfm within 90 sec
* [x] EXPECT Airflow below 900cfm
+ expect OccupancyMode is not "standby"
- expect ZoneSetpoint = 72 °F
- expect ${NET}/VAV_102/points/ZoneTemp falls by at least 1.5 °F within 1.5h
- expect station:|slot:/Schedules/OfficeHours/out is Occupied
- set OccupancyMode unoccupied
- wait for 500ms
- for each of low, high:
    - set DamperPosition { value }
`, "/jobs/vav box.md");
  assert.equal(doc.title, "vav box");
  const [set, above, below, not, is, falls, schedule, mode, wait, low, high] = doc.steps[0].lines;
  assert.deepEqual([set.point, set.value, set.forMs], [`${NET}/VAV_101/points/DamperPosition`, 100, 600000]);
  assert.deepEqual([above.comparison, above.withinMs], [{ kind: "above", value: 500 }, 90000]);
  assert.deepEqual([below.comparison, below.withinMs], [{ kind: "below", value: 900 }, 0]);
  assert.deepEqual(not.comparison, { kind: "isNot", value: "standby", text: "standby" });
  assert.deepEqual(is.comparison, { kind: "is", value: 72, text: "72" });
  assert.deepEqual([falls.point, falls.name, falls.comparison, falls.withinMs], [`${NET}/VAV_102/points/ZoneTemp`, "VAV_102/ZoneTemp", { kind: "falls", by: 1.5 }, 5400000]);
  assert.equal(schedule.point, "slot:/Schedules/OfficeHours/out");
  assert.deepEqual([mode.value, wait.ms], ["unoccupied", 500]);
  assert.deepEqual([low.value, low.loop, high.value], ["low", "low", "high"]);
});

test("a line that cannot be read is an error with its line number, and every one is listed", () => {
  const broken = `# Broken
## Before any equipment
- set SupplyFanCmd on

equipment: ${OR}
## Lines
- open the damper
- set SupplyFanSpeed
- set SupplyFanSpeed {value}
- expect SupplyFanStatus within 30s
- expect SupplyFanStatus
- expect SupplyFanStatus is on within 30
- wait a bit
- expect SupplyAirTemp above warm
- set SupplyFanSpeed 50 right now
- for 25, 50:
- note history:/Riverside/SupplyAirTemp
set SupplyFanSpeed 0
## Nothing in it
Only words here.
`;
  assert.throws(() => parseCheckout(broken, "broken.md"), (error) => {
    assert.ok(error instanceof CheckoutParseError);
    assert.deepEqual(error.problems.map((p) => p.line), [3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const said = Object.fromEntries(error.problems.map((p) => [p.line, p.message]));
    assert.match(said[3], /"SupplyFanCmd" needs an "equipment:" line above it/);
    assert.match(said[7], /Cannot read "open the damper"\. A step line starts with set, release, expect, wait, note or for\./);
    assert.match(said[8], /needs a value/);
    assert.match(said[9], /only filled in on the lines under a "for"/);
    assert.match(said[10], /written "within 3 of 50"\. To give a time limit, put the check first/);
    assert.match(said[11], /needs a check after the point/);
    assert.match(said[12], /"30" needs a unit of time: write 30s, 30m or 30h/);
    assert.match(said[13], /"a" is not a length of time/);
    assert.match(said[14], /"above" needs a number, and "warm" is not one/);
    assert.match(said[15], /Did not understand "now" at the end of the line/);
    assert.match(said[16], /This "for" has nothing under it/);
    assert.match(said[17], /is not a point bask can test/);
    assert.match(said[18], /reads as a step line but has no "- " in front/);
    assert.match(said[19], /Step "Nothing in it" has nothing to do under it/);
    // The message a person sees names the file and the line of each.
    assert.match(error.message, /^broken\.md:3: /);
    assert.equal(error.message.split("\n").length, 14);
    return true;
  });
  assert.throws(() => parseCheckout("# Just a title\nSome words.\n", "empty.md"), /empty\.md:1: No steps found/);
  assert.throws(() => parseCheckout(`equipment: ${OR}\n- set SupplyFanSpeed 0\n## Step\n- wait 1s\n`, "early.md"), /early\.md:2: This line is not under a step/);
  assert.throws(() => parseCheckout(`equipment: ${OR}\n## Step\n- for 1, 2:\n  - for 3, 4:\n    - wait {value}s\n`, "nested.md"), /nested\.md:4: A "for" inside a "for" is not supported/);
});

test("a rehearsal looks at every point, lists exactly what a run would command, and commands nothing", async () => {
  const { station, client, close, overridden } = await riverside();
  try {
    const rehearsal = await rehearseCheckout(client, parseCheckout(AHU, "ahu-or.md"));
    assert.deepEqual([rehearsal.kind, rehearsal.ok, rehearsal.station, rehearsal.user, rehearsal.problems], ["rehearsal", true, "Riverside", "admin", []]);
    // Five overrides, each with its time limit, and a release as each step ends.
    assert.deepEqual(rehearsal.commands.map((c) => [c.step, c.line, c.name, c.action, c.value, c.durationSec, c.why]), [
      [0, 10, "SupplyFanSpeed", "override", 0, 900, "set"],
      [0, 12, "SupplyFanSpeed", "override", 60, 900, "set"],
      [0, 7, "SupplyFanSpeed", "auto", undefined, undefined, "step end"],
      [1, 18, "SupplyAirSetpoint", "override", 66, 900, "set"],
      [1, 18, "SupplyAirSetpoint", "override", 70, 900, "set"],
      [1, 15, "SupplyAirSetpoint", "auto", undefined, undefined, "step end"],
      [2, 23, "SupplyFanSpeed", "override", 0, 900, "set"],
      [2, 21, "SupplyFanSpeed", "auto", undefined, undefined, "step end"]
    ]);
    assert.deepEqual(rehearsal.commands.map((c) => c.point).filter((p, i, all) => all.indexOf(p) === i), [`${OR}/SupplyFanSpeed`, `${OR}/SupplyAirSetpoint`, `${PATIENT}/SupplyFanSpeed`]);
    assert.deepEqual(rehearsal.steps.map((s) => s.releases), [[`${OR}/SupplyFanSpeed`], [`${OR}/SupplyAirSetpoint`], [`${PATIENT}/SupplyFanSpeed`]]);
    assert.match(rehearsal.steps[0].lines[2].now, /^On$/);

    const shown = text(rehearsal);
    assert.match(shown, /Rehearsal: AHU-OR functional test {2}Riverside · admin · ahu-or\.md/);
    assert.match(shown, /Nothing was commanded/);
    assert.match(shown, /override SupplyFanSpeed to 0, held for up to 15m {2}\(reads \d+\.\d % now\)/);
    assert.match(shown, /check that SupplyAirTemp is within 1\.5 of 70, looking for up to 5s/);
    assert.match(shown, /then release AHU_OR\/SupplyFanSpeed, however the step ends/);
    assert.match(shown, /A run would send 5 overrides to 3 points: AHU_OR\/SupplyFanSpeed, AHU_OR\/SupplyAirSetpoint, AHU_Patient\/SupplyFanSpeed\./);
    assert.match(shown, /Ready\. To run it for real: add --allow-writes --yes\./);
    assert.equal(checkoutExitCode(rehearsal), 0);

    assert.equal(station.state.counters.writes, 0);
    assert.deepEqual(overridden(), []);
  } finally {
    await close();
  }
});

test("a rehearsal finds what is wrong with the document on this station, and a run with errors does not start", async () => {
  const { station, client, close, overridden } = await riverside();
  try {
    const doc = parseCheckout(`# Mistakes
station: Northgate
equipment: ${OR}
## Step
- set SupplyFanSpeed 0
- expect SupplyFanStatuz is off within 5s
- set SupplyFanStatus off
- set SupplyAirSetpoint high
- expect SupplyFanStatus above 50
- expect SupplyAirTemp above 50
`, "mistakes.md");
    const rehearsal = await rehearseCheckout(client, doc);
    assert.equal(rehearsal.ok, false);
    assert.deepEqual(rehearsal.problems.map((p) => [p.severity, p.line]), [["error", 2], ["error", 6], ["error", 7], ["error", 8], ["error", 9]]);
    const [wrongStation, missing, readOnly, wrongKind, notNumber] = rehearsal.problems.map((p) => p.message);
    assert.match(wrongStation, /This document is for Northgate; the station connected is Riverside\. Nothing is commanded on a different station\./);
    assert.match(missing, /SupplyFanStatuz was not found on the station/);
    assert.match(readOnly, /SupplyFanStatus cannot be commanded: it is not a writable point/);
    assert.match(wrongKind, /SupplyAirSetpoint takes a number, and "high" is not one/);
    assert.match(notNumber, /SupplyFanStatus reads On, which is not a number, so "is above 50" cannot be checked/);
    assert.match(text(rehearsal), /Not ready: a run would not start/);
    assert.equal(checkoutExitCode(rehearsal), 1);

    const result = await runCheckout(client, doc);
    assert.deepEqual([result.outcome, result.ok, result.steps[0].status, result.problems.length], ["not-started", false, "not-run", 5]);
    assert.match(text(result), /line 6: SupplyFanStatuz was not found on the station[\s\S]*Not started: nothing was commanded/);
    assert.match(checkoutReport(result), /## Why it did not start\n\n- Error \(line 2\): This document is for Northgate/);
    assert.equal(station.state.counters.writes, 0);
    assert.deepEqual(overridden(), []);
  } finally {
    await close();
  }

  // A point someone has overridden already: the test would take that override away, so it says so first.
  const north = await startStation({ site: "northgate" });
  try {
    const rehearsal = await rehearseCheckout(north.client, parseCheckout(`equipment: ${NET}/AHU_02/points\n## Fan\n- set SupplyFanSpeed 40\n- expect SupplyFanStatus is on\n`, "north.md"));
    assert.equal(rehearsal.ok, true);
    assert.deepEqual(rehearsal.problems.map((p) => [p.severity, p.line]), [["warning", 3]]);
    assert.match(rehearsal.problems[0].message, /SupplyFanSpeed is overridden now \(85\.0 %\)\. The test replaces that override and releases the point when the step ends; it does not put the old override back\./);
  } finally {
    await north.close();
  }
});

test("a run: the feedback that follows passes, the one that does not fails with what was expected and what was seen", async () => {
  const { station, client, close, overridden } = await riverside();
  try {
    const events = [];
    const result = await runCheckout(client, parseCheckout(AHU, "ahu-or.md"), { pollMs: 60, onEvent: (event) => events.push(event) });
    assert.deepEqual([result.kind, result.outcome, result.ok, result.station, result.user], ["result", "failed", false, "Riverside", "admin"]);
    assert.deepEqual(result.steps.map((s) => s.status), ["pass", "pass", "fail"]);
    assert.deepEqual(result.counts, { steps: 3, passed: 2, failed: 1, errors: 0, notRun: 0 });
    assert.equal(result.summary, "2 of 3 steps passed, 1 failed.");
    assert.equal(checkoutExitCode(result), 1);

    // Step 1: commanded off, the status proved it a moment later; then on again.
    const [fan, air, patient] = result.steps;
    assert.deepEqual(fan.lines.map((l) => [l.kind, l.status]), [["note", "done"], ["set", "done"], ["expect", "pass"], ["set", "done"], ["expect", "pass"]]);
    assert.deepEqual([fan.commanded, fan.observed], ["SupplyFanSpeed 0, 60", "SupplyFanStatus Off, On"]);
    assert.equal(fan.lines[1].seen, "0.0 %");
    const proved = fan.lines[2];
    assert.deepEqual([proved.expected, proved.seen], ["is off", "Off"]);
    assert.ok(proved.tookMs >= 250 && proved.tookMs < 3000, `took ${proved.tookMs}`);
    // It was still On for the first readings and Off for the last: that is the trend.
    assert.deepEqual([proved.readings[0], proved.readings.at(-1)], [1, 0]);

    // Step 2: the for ran once per value, and supply air climbed to each setpoint.
    assert.deepEqual(air.lines.map((l) => [l.kind, l.loop, l.status]), [["note", undefined, "done"], ["set", "66", "done"], ["expect", "66", "pass"], ["set", "70", "done"], ["expect", "70", "pass"]]);
    assert.equal(air.commanded, "SupplyAirSetpoint 66, 70");
    const climbed = air.lines[4];
    assert.ok(climbed.readings.length >= 3 && climbed.readings.at(-1) > climbed.readings[0], JSON.stringify(climbed.readings));
    assert.ok(Math.abs(parseFloat(climbed.seen) - 70) <= 1.5, climbed.seen);
    assert.deepEqual(air.readings, climbed.readings);

    // Step 3: the status never moved. The step failed after its second, and says what it wanted and what it saw.
    assert.deepEqual(patient.lines.map((l) => l.status), ["done", "fail"]);
    assert.deepEqual([patient.expected, patient.seen], ["is off", "On"]);
    assert.equal(patient.message, "SupplyFanStatus was expected to be off within 1s, and read On.");
    assert.ok(patient.lines[1].tookMs >= 1000 && patient.lines[1].tookMs < 3000);

    // The notes are the values written down, and every point was let go again.
    assert.deepEqual(result.notes.map((n) => [n.step, n.name, /^\d+\.\d (%|°F)$/.test(n.value)]), [[0, "SupplyFanSpeed", true], [1, "SupplyAirTemp", true]]);
    assert.deepEqual(result.steps.map((s) => s.released), [[`${OR}/SupplyFanSpeed`], [`${OR}/SupplyAirSetpoint`], [`${PATIENT}/SupplyFanSpeed`]]);
    assert.deepEqual(result.leftOverridden, []);
    assert.deepEqual(overridden(), []);
    // Five overrides and three releases, each recorded on the station with why.
    assert.equal(station.state.counters.writes, 8);

    // What a screen is told: each step and line as it starts and ends, and each reading of a line being waited on.
    assert.deepEqual(events.filter((e) => e.type !== "reading").map((e) => e.type).slice(0, 4), ["step-started", "line-started", "line-finished", "line-started"]);
    assert.deepEqual(events.filter((e) => e.type === "step-started").map((e) => [e.step, e.title, e.lines]), [[0, "Supply fan proves off and on", 5], [1, "Supply air follows its setpoint", 5], [2, "Patient wing fan proves off", 2]]);
    assert.deepEqual(events.filter((e) => e.type === "step-finished").map((e) => e.result), result.steps);
    assert.deepEqual(events.filter((e) => e.type === "line-finished" && e.step === 1).map((e) => e.result), air.lines);
    const waited = events.filter((e) => e.type === "line-started" && e.waitMs).map((e) => [e.step, e.line, e.kind, e.waitMs]);
    assert.deepEqual(waited, [[0, 2, "expect", 5000], [0, 4, "expect", 5000], [1, 2, "expect", 5000], [1, 4, "expect", 5000], [2, 1, "expect", 1000]]);
    const readings = events.filter((e) => e.type === "reading" && e.step === 1 && e.line === 4);
    assert.ok(readings.length >= 3);
    assert.deepEqual(readings.map((e) => e.readings.length), readings.map((_e, i) => i + 1));
    assert.deepEqual([readings[0].point, readings[0].name, typeof readings[0].value, /°F$/.test(readings[0].display)], [`${OR}/SupplyAirTemp`, "SupplyAirTemp", "number", true]);
    assert.deepEqual(readings.at(-1).readings, climbed.readings);
    // Events are plain data.
    assert.deepEqual(JSON.parse(JSON.stringify(events)), events);

    const shown = text(result);
    assert.match(shown, /✓ {2}1 {2}Supply fan proves off and on/);
    assert.match(shown, /✓ expect SupplyFanStatus is off within 5s: passed in [\d.]+s, read Off {2}[▁-█]+/);
    assert.match(shown, /✗ {2}3 {2}Patient wing fan proves off/);
    assert.match(shown, /✗ expect SupplyFanStatus is off within 1s: FAILED after 1(\.\d)?s: expected to be off, read On/);
    assert.match(shown, /2 of 3 steps passed, 1 failed\.\nEvery point the test overrode was released\./);

    // The report: who, where, when; a row per step; the text of the document; the notes; nothing left overridden.
    const report = checkoutReport(result);
    assert.match(report, /^# AHU-OR functional test\n\nCheckout report\n/);
    assert.match(report, /\| Result \| \*\*Failed\*\*: 2 of 3 steps passed, 1 failed\. \|\n\| Station \| Riverside \|\n\| Run by \| admin \|\n\| Started \| \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \|\n\| Took \| [\d.]+s \|\n\| Document \| ahu-or\.md \|/);
    assert.match(report, /\nUnit in Auto at the starter before this is run\.\n/);
    assert.match(report, /\| 1 \| Supply fan proves off and on \| Pass \| SupplyFanSpeed 0, 60 \| SupplyFanStatus Off, On \| [\d.]+s \| [▁-█]+ \|/);
    assert.match(report, /\| 2 \| Supply air follows its setpoint \| Pass \| SupplyAirSetpoint 66, 70 \| SupplyAirTemp [\d.]+ °F, [\d.]+ °F \| [\d.]+s \| [▁-█]+ \|/);
    assert.match(report, /\| 3 \| Patient wing fan proves off \| \*\*FAIL\*\* \| SupplyFanSpeed 0 \| expected to be off, read On \| [\d.]+s \| [▁-█]+ \|/);
    assert.match(report, /### 1\. Supply fan proves off and on: passed\n\nThe status comes from a current switch on the fan motor\.\n\n- note SupplyFanSpeed: read [\d.]+ %\n- set SupplyFanSpeed 0: done, reads 0\.0 %\n/);
    assert.match(report, /### 3\. Patient wing fan proves off: failed\n\nSupplyFanStatus was expected to be off within 1s, and read On\.\n/);
    assert.match(report, /- released when the step ended: AHU_Patient\/SupplyFanSpeed\n/);
    assert.match(report, /## Notes\n\nValues written down during the test\.\n[\s\S]*\| 1\. Supply fan proves off and on \| SupplyFanSpeed \| [\d.]+ % \| \d\d:\d\d:\d\d \|/);
    assert.match(report, /## Left overridden\n\nNothing\. Every point the test overrode was released\.\n/);
    assert.match(report, /recorded on the station with the reason "Checkout: AHU-OR functional test" and the step's name\./);
    assert.ok(!/\x1b\[/.test(report), "the report is plain markdown");
    // The station's audit history has each command, with the step it belonged to.
    assert.ok(station.state.audit.some((a) => /Invoked.*AHU_OR\/points\/SupplyFanSpeed.*override/.test(a.summary)));
  } finally {
    await close();
  }
});

test("what each check means: is, is not, above, below, a rise counted from the note, and a reading that proves nothing", async () => {
  const { client, close, overridden } = await riverside();
  try {
    const run = async (lines) => (await runCheckout(client, parseCheckout(`equipment: ${OR}\n## Checks\n${lines.map((l) => `- ${l}`).join("\n")}\n`, "checks.md"), { pollMs: 60 })).steps[0];

    // Nothing is commanded by a document that only reads; every check here is true of the station as it stands.
    const reads = await run(["expect SupplyFanStatus is on", "expect SupplyFanStatus is not off", "expect SupplyFanStatus is 1", "expect SupplyAirSetpoint is 62", "expect SupplyAirSetpoint is 62.0 °F", "expect SupplyAirSetpoint is not 70",
      "expect SupplyAirTemp above 50", "expect SupplyAirTemp below 80 °F", "expect SupplyAirTemp within 5 of 62", "expect SupplyFanSpeed is above 0 %"]);
    assert.deepEqual(reads.lines.map((l) => l.status), Array(10).fill("pass"));
    assert.deepEqual([reads.status, reads.commanded, reads.released], ["pass", "", []]);

    // A check with no time limit looks once.
    const once = await run(["expect SupplyAirTemp above 90"]);
    assert.deepEqual([once.status, once.lines[0].expected, once.lines[0].readings.length], ["fail", "above 90", 1]);
    assert.match(once.message, /^SupplyAirTemp was expected to be above 90, and read \d+\.\d °F\.$/);

    // A rise is counted from the value noted before the command, not from where the wait began.
    // A second note moves the place it is counted from.
    const rise = await run(["note SupplyAirTemp", "set SupplyAirSetpoint 72", "wait 400ms", "expect SupplyAirTemp rises at least 8 within 2s", "note SupplyAirTemp", "expect SupplyAirTemp falls at least 1 within 300ms"]);
    assert.deepEqual(rise.lines.map((l) => l.status), ["done", "done", "done", "pass", "done", "fail"]);
    assert.match(rise.lines[3].expected, /^rises at least 8 from 6\d(\.\d+)?$/);
    assert.match(rise.lines[3].seen, /^7\d\.\d °F \(up \d+(\.\d+)? from 6\d(\.\d+)?\)$/);
    assert.match(rise.message, /^SupplyAirTemp was expected to fall at least 1 from 7\d(\.\d+)? within 0\.3s, and read 7\d\.\d °F \(/);
    assert.deepEqual(overridden(), []);
  } finally {
    await close();
  }

  // Northgate's VAV 107 is not answering: what it shows is old, so it proves nothing. Its neighbour's mode is an enum.
  const north = await startStation({ site: "northgate" });
  try {
    const doc = parseCheckout(`equipment: ${NET}\n## Down\n- expect VAV_107/points/ZoneTemp above 0 within 200ms\n## Mode\n- expect VAV_106/points/OccupancyMode is Standby\n- expect VAV_101/points/OccupancyMode is not standby\n`, "north.md");
    const result = await runCheckout(north.client, doc, { pollMs: 60 });
    assert.deepEqual(result.steps.map((s) => s.status), ["fail", "pass"]);
    assert.match(result.steps[0].seen, /^\d+\.\d °F \(down\)$/);
    assert.equal(north.station.state.counters.writes, 0);
    assert.match(checkoutReport(result), /## Left overridden\n\nNothing\. The test overrode no points\./);
  } finally {
    await north.close();
  }
});

test("every override has a time limit, and is released after a pass, after a fail and after the run is stopped", async () => {
  const { station, client, close, nodes, overridden } = await riverside();
  try {
    const speed = `${OR}/SupplyFanSpeed`;
    const doc = parseCheckout(`equipment: ${OR}
## Passes
- set SupplyFanSpeed 0
- expect SupplyFanStatus is off within 5s
## Fails, with a long wait still to come
- set SupplyFanSpeed 30
- set SupplyAirSetpoint 64 for 30s
- expect SupplyFanSpeed above 50 within 300ms
- wait 30m
## Stopped part way
- set SupplyFanSpeed 45
- wait 30s
- expect SupplyFanStatus is on within 30s
## Never reached
- set SupplyFanSpeed 10
`, "limits.md");
    // What the station holds as each set goes through: the value, and how long until it lets go by itself.
    const held = [];
    const state = [];
    const stop = new AbortController();
    const started = Date.now();
    const result = await runCheckout(client, doc, {
      pollMs: 60, signal: stop.signal,
      onEvent(event) {
        if (event.type === "line-finished" && event.result.kind === "set") {
          const override = nodes.get(event.result.point).override;
          held.push([event.step, event.result.name, override.value, Math.round((override.until - Date.now()) / 1000)]);
        }
        // After each step, nothing it overrode is still overridden.
        if (event.type === "step-finished") state.push(overridden());
        if (event.type === "line-started" && event.step === 2 && event.kind === "wait") setTimeout(() => stop.abort(), 150);
      }
    });
    // 15 minutes; or the step's waits (30 minutes and 0.3 seconds), five seconds a line and two minutes more; or what "for" says.
    assert.equal(holdSeconds(doc.steps[1]), 1941);
    assert.deepEqual(held, [[0, "SupplyFanSpeed", 0, 900], [1, "SupplyFanSpeed", 30, 1941], [1, "SupplyAirSetpoint", 64, 30], [2, "SupplyFanSpeed", 45, 900]]);
    assert.deepEqual(state, [[], [], []]);
    assert.ok(Date.now() - started < 8000, "the 30 minute and 30 second waits were not sat through");

    assert.deepEqual([result.outcome, result.ok], ["aborted", false]);
    assert.deepEqual(result.steps.map((s) => s.status), ["pass", "fail", "stopped", "not-run"]);
    assert.deepEqual(result.steps.map((s) => s.released), [[speed], [`${OR}/SupplyAirSetpoint`, speed], [speed], []]);
    // The failed step stopped at its failed check; the stopped one in its wait.
    assert.deepEqual(result.steps[1].lines.map((l) => l.status), ["done", "done", "fail", "not-run"]);
    assert.deepEqual(result.steps[2].lines.map((l) => l.status), ["done", "stopped", "not-run"]);
    assert.equal(result.steps[2].message, "Stopped during the wait.");
    assert.equal(result.summary, "1 of 4 steps passed, 1 failed, 1 could not be finished, 1 not run. Stopped before the end.");
    assert.deepEqual(result.leftOverridden, []);
    assert.deepEqual(overridden(), []);
    // Four overrides and four releases; the step never reached commanded nothing.
    assert.equal(station.state.counters.writes, 8);
    assert.match(text(result), /■ {2}3 {2}Stopped part way[\s\S]*– {2}4 {2}Never reached {2}not run[\s\S]*Every point the test overrode was released\./);

    // Stopped while a check is waiting on its feedback: the same.
    const again = new AbortController();
    const waiting = await runCheckout(client, parseCheckout(`equipment: ${PATIENT}\n## Waiting\n- set SupplyFanSpeed 0\n- expect SupplyFanStatus is off within 30s\n`, "waiting.md"), {
      pollMs: 60, signal: again.signal, onEvent: (event) => event.type === "reading" && event.readings.length === 2 && again.abort()
    });
    assert.deepEqual([waiting.outcome, waiting.steps[0].status, waiting.steps[0].lines[1].status, waiting.steps[0].lines[1].message], ["aborted", "stopped", "stopped", "Stopped while waiting for it."]);
    assert.deepEqual(waiting.steps[0].released, [`${PATIENT}/SupplyFanSpeed`]);
    assert.deepEqual(overridden(), []);
  } finally {
    await close();
  }
});

test("a command the station keeps for a person to approve stops the run, and nothing is commanded", async () => {
  const { station, close, overridden } = await riverside();
  // The station counts this login as an AI agent, and an agent's point commands wait for a person here.
  const agent = await BaskStreamClient.connect({ station: station.url, username: "ai-claude", password: station.password });
  try {
    const doc = parseCheckout(AHU, "ahu-or.md");
    const rehearsal = await rehearseCheckout(agent, doc);
    assert.deepEqual([rehearsal.ok, rehearsal.problems.map((p) => p.severity)], [true, ["warning"]]);
    assert.match(rehearsal.problems[0].message, /This login is an AI agent, and this station keeps an agent's point commands for a person to approve\. A run stops at its first command\./);

    const before = station.state.proposals.size;
    const result = await runCheckout(agent, doc, { pollMs: 60 });
    assert.deepEqual([result.outcome, result.ok, checkoutExitCode(result)], ["stopped", false, 2]);
    assert.deepEqual(result.steps.map((s) => s.status), ["stopped", "not-run", "not-run"]);
    assert.deepEqual(result.steps[0].lines.map((l) => l.status), ["done", "stopped", "not-run", "not-run", "not-run"]);

    // One proposal, for the first command only, with the reason and the time limit it would have had.
    assert.equal(station.state.proposals.size, before + 1);
    const proposal = station.state.proposals.get(result.proposal.id);
    assert.deepEqual([proposal.status, proposal.point, proposal.action, proposal.value, proposal.durationSec], ["pending", `${OR}/SupplyFanSpeed`, "override", 0, 900]);
    assert.equal(proposal.reason, "Checkout: AHU-OR functional test (Supply fan proves off and on)");
    assert.match(result.steps[0].message, new RegExp(`^The station did not make this command\\. It kept it for a person to approve, as ${proposal.id}\\.$`));
    assert.match(result.summary, new RegExp(`^Stopped: the station kept "override 0\\.0 % for 15 min" on AHU_OR/SupplyFanSpeed for a person to approve \\(${proposal.id}\\)\\. It was not made, and the test did not go on\\.`));

    // Nothing was overridden, so there was nothing to release, and no release was asked for.
    assert.equal(station.state.counters.writes, 0);
    assert.deepEqual(overridden(), []);
    assert.deepEqual(result.leftOverridden, []);
    assert.match(text(result), /■ {2}1 {2}Supply fan proves off and on[\s\S]*Stopped: the station kept/);
    assert.match(checkoutReport(result), new RegExp(`for a person to approve, as ${proposal.id}\\. It was not made\\.`));
  } finally {
    agent.close();
    await close();
  }
});

test("a refused command ends its step and the run; with keepGoing the next step still runs", async () => {
  const { client, close, overridden } = await riverside();
  try {
    const doc = parseCheckout(`equipment: ${OR}
## Setpoint
- set SupplyAirSetpoint 66
- expect SupplyAirTemp above 63 within 5s
## Fan
- set SupplyFanSpeed 0
- expect SupplyFanStatus is off within 5s
`, "refused.md");
    // A station answers a command this login may not make with an entry of its own, not with a failed request.
    const strict = answering(client, (point, action) => (point.endsWith("SupplyAirSetpoint") && action === "override" ? { point, ok: false, code: "forbidden_action", message: "User cannot invoke override on this point." } : undefined));

    const stopped = await runCheckout(strict, doc, { pollMs: 60 });
    assert.deepEqual([stopped.outcome, checkoutExitCode(stopped)], ["stopped", 1]);
    assert.deepEqual(stopped.steps.map((s) => s.status), ["error", "not-run"]);
    assert.equal(stopped.steps[0].message, "The station refused the command: User cannot invoke override on this point. [forbidden_action]");
    assert.match(stopped.summary, /^0 of 2 steps passed, 1 could not be finished, 1 not run\. The run stopped at the command the station refused; to go on to the next step anyway, add --keep-going\.$/);
    assert.deepEqual(overridden(), []);

    const went = await runCheckout(strict, doc, { pollMs: 60, keepGoing: true });
    assert.deepEqual([went.outcome, went.steps.map((s) => s.status)], ["failed", ["error", "pass"]]);
    assert.deepEqual(went.steps.map((s) => s.released), [[], [`${OR}/SupplyFanSpeed`]]);
    assert.deepEqual(overridden(), []);

    // A command whose answer never came may have been made all the same: the step still releases the point.
    const lossy = answering(client, async (point, action, value, options) => {
      if (action !== "override") return undefined;
      await client.write(point, action, value, options);
      throw new BaskStreamError("timeout", "write got no reply within 15000 ms.", "write");
    });
    const unsure = await runCheckout(lossy, doc, { pollMs: 60 });
    assert.deepEqual([unsure.steps[0].status, unsure.steps[0].message], ["error", "No answer to the command: write got no reply within 15000 ms. [timeout]"]);
    assert.deepEqual(unsure.steps[0].released, [`${OR}/SupplyAirSetpoint`]);
    assert.deepEqual(overridden(), []);
  } finally {
    await close();
  }
});

test("a release that does not go through is reported at the end with the point's ORD", async () => {
  const { client, close, overridden } = await riverside();
  try {
    const speed = `${OR}/SupplyFanSpeed`;
    const doc = parseCheckout(`# Fan\nequipment: ${OR}\n## Fan proves off\n- set SupplyFanSpeed 0\n- expect SupplyFanStatus is off within 5s\n`, "fan.md");

    const refusing = answering(client, (point, action) => (action === "auto" ? { point, ok: false, code: "forbidden_action", message: "User cannot invoke auto on this point." } : undefined));
    const result = await runCheckout(refusing, doc, { pollMs: 60 });
    // The step itself passed, and the run still did not: a point is left overridden.
    assert.deepEqual([result.steps[0].status, result.outcome, result.ok, checkoutExitCode(result)], ["pass", "failed", false, 1]);
    assert.equal(result.summary, "1 of 1 step passed. 1 point is still overridden.");
    assert.equal(result.leftOverridden.length, 1);
    const [left] = result.leftOverridden;
    assert.deepEqual([left.point, left.name, left.step, left.value], [speed, "SupplyFanSpeed", "Fan proves off", "0"]);
    assert.equal(left.why, "the release did not go through: User cannot invoke auto on this point. [forbidden_action]");
    // When the station lets go by itself: the 15 minutes the override was given.
    assert.ok(Math.abs(left.until - Date.now() - 900000) < 10000);
    assert.deepEqual(overridden(), [speed]);
    assert.match(text(result), new RegExp(`STILL OVERRIDDEN\\. Release these by hand:\\n {2}${speed} \\(overridden to 0 in "Fan proves off"\\): the release did not go through: .*\\. The station lets go of it by itself at \\d\\d:\\d\\d:\\d\\d\\.`));
    assert.match(checkoutReport(result), new RegExp(`## Left overridden\\n\\n\\*\\*These points are still overridden\\. Release them by hand\\.\\*\\*\\n\\n- ${speed} \\(overridden to 0`));
    await client.write(speed, "auto");

    // A release the station keeps for a person is not a release either.
    const asking = answering(client, (point, action) => {
      if (action === "auto") throw new ChangeProposedError("This change was not made. It is waiting for a person to approve it as P9.", "write", { id: "P9", status: "pending", point, action, description: "auto (release override)" });
      return undefined;
    });
    const kept = await runCheckout(asking, doc, { pollMs: 60 });
    assert.equal(kept.leftOverridden[0].why, "the station kept the release for a person to approve (P9)");
    await client.write(speed, "auto");

    // A dropped connection is not a refusal: the release is sent again, and goes through.
    let drops = 1;
    const flaky = answering(client, (_point, action) => {
      if (action === "auto" && drops-- > 0) throw new BaskStreamError("connection_closed", "Connection closed (1006).", "write");
      return undefined;
    });
    const retried = await runCheckout(flaky, doc, { pollMs: 60 });
    assert.deepEqual([retried.outcome, retried.leftOverridden, retried.steps[0].released], ["passed", [], [speed]]);
    assert.equal(checkoutExitCode(retried), 0);
    assert.deepEqual(overridden(), []);
  } finally {
    await close();
  }
});

test("the example documents: both read, vav.md rehearses on Northgate, and ahu.md passes on Riverside", async () => {
  const example = (name) => parseCheckout(readFileSync(new URL(`../examples/checkout/${name}`, import.meta.url), "utf8"), name);
  const [ahu, vav] = [example("ahu.md"), example("vav.md")];
  assert.deepEqual([ahu.title, ahu.station, ahu.steps.length], ["AHU-OR functional test", "Riverside", 4]);
  assert.deepEqual([vav.title, vav.station, vav.steps.length], ["VAV-101 point-to-point checkout", undefined, 6]);
  // What to have ready is a list above the first step: it is text for the report, not something to run.
  assert.ok(ahu.text.includes("- The drive is in Auto and the disconnect is closed."));

  const north = await startStation({ site: "northgate" });
  try {
    const rehearsal = await rehearseCheckout(north.client, vav);
    assert.deepEqual([rehearsal.ok, rehearsal.problems], [true, []]);
    assert.equal(rehearsal.commands.filter((c) => c.action === "override").length, 9);
    // The reheat step waits up to 15 minutes, so its overrides are asked to last longer than that.
    assert.deepEqual(rehearsal.steps.map((s) => s.holdSec), [900, 900, 900, 15 * 60 + 120 + 20, 900, 900]);
    // On another station the air handler's document commands nothing.
    const elsewhere = await runCheckout(north.client, ahu);
    assert.equal(elsewhere.outcome, "not-started");
    assert.match(elsewhere.problems[0].message, /This document is for Riverside; the station connected is Northgate/);
    assert.equal(north.station.state.counters.writes, 0);
  } finally {
    await north.close();
  }

  const { client, close, overridden } = await riverside();
  try {
    const result = await runCheckout(client, ahu, { pollMs: 60 });
    assert.deepEqual([result.outcome, checkoutExitCode(result), result.steps.map((s) => s.status)], ["passed", 0, ["pass", "pass", "pass", "pass"]]);
    assert.equal(result.summary, "4 of 4 steps passed.");
    assert.deepEqual(overridden(), []);
  } finally {
    await close();
  }
});
