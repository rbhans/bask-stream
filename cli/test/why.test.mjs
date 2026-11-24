// bask why (src/why.ts): what is driving a value, as facts. On Northgate the hot room has a cause
// that can be found: its history turned four days ago, beside a person's change to the box's
// maximum airflow, and the airflow turned with it. Also what commands a writable point, what
// reaches it through links, what is wrong upstream, and what is said when something is not known.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_CHANGE_LIST } from "../dist/log.js";
import { inferModel, inferServes, readEvidence } from "../dist/model.js";
import { NEAR, commandOf, explain, findTurn, refineTurn, whyText } from "../dist/why.js";
import { startStation } from "./harness.mjs";

const NET = "slot:/Drivers/BacnetNetwork";
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const P = (path) => `${NET}/${path.replace("/", "/points/")}`;
const servesOf = async (client) => {
  const { evidence } = await readEvidence(client, "slot:/");
  return inferServes(inferModel(evidence), [], evidence);
};

test("when a series turned: the latest shift of level that lasts, well above its ordinary noise", () => {
  const START = Date.UTC(2026, 10, 1);
  const HALF = 30 * MIN;
  // A value with the swing every building has over a day, a slower drift and some noise.
  const wobble = (i) => 1.2 * Math.sin((2 * Math.PI * i) / 48) + 0.4 * Math.sin(i / 7) + 0.3 * Math.sin(i * 12.9898) ;
  const series = (count, level) => Array.from({ length: count }, (_v, i) => ({ at: START + i * HALF, value: level(i) + wobble(i) }));

  // A week that only swings has no turn, and that is a normal answer.
  assert.equal(findTurn(series(336, () => 72)), undefined);
  // A step of five on day three, among a swing of over two: found to the half hour, with the level each side.
  const step = findTurn(series(336, (i) => (i < 130 ? 72 : 77)));
  assert.equal(step.at, START + 129.5 * HALF, "between the last value before and the first after");
  assert.ok(Math.abs(step.before - 72) < 0.3 && Math.abs(step.after - 77) < 0.3 && step.spread > 0.5 && step.spread < 1.2);
  // A shift no bigger than the swing is not one.
  assert.equal(findTurn(series(336, (i) => (i < 130 ? 72 : 73))), undefined);
  // Up for a day and back: the return is the latest shift that lasts, not the excursion.
  const back = findTurn(series(336, (i) => (i >= 100 && i < 148 ? 80 : 72)));
  assert.equal(back.at, START + 147.5 * HALF);
  assert.ok(back.before > 79 && back.after < 73);
  // Two steps: the later one.
  assert.equal(findTurn(series(336, (i) => (i < 80 ? 60 : i < 200 ? 70 : 80))).at, START + 199.5 * HALF);
  // A setpoint moved by one, with no noise at all.
  const setpoint = findTurn(Array.from({ length: 336 }, (_v, i) => ({ at: START + i * HALF, value: i < 250 ? 72 : 71 })));
  assert.deepEqual([setpoint.at, setpoint.before, setpoint.after, setpoint.spread], [START + 249.5 * HALF, 72, 71, 0]);
  // Flat, or too short to say.
  assert.equal(findTurn(Array.from({ length: 336 }, (_v, i) => ({ at: START + i * HALF, value: 55 }))), undefined);
  assert.equal(findTurn(series(8, (i) => (i < 4 ? 1 : 9))), undefined);
  // One day of history: the daily swing alone, morning against afternoon, is not taken for a turn.
  assert.equal(findTurn(series(48, () => 72)), undefined);
  // A gap in the history does not make one either.
  assert.equal(findTurn(series(336, () => 72).filter((_p, i) => i < 150 || i > 190)), undefined);

  // Placing it with a finer series: when the value first left its earlier level for good.
  const turn = { at: START + 100 * HALF, before: 72, after: 78, spread: 0.4 };
  const ramp = Array.from({ length: 72 }, (_v, i) => ({ at: START + 97 * HALF + i * 5 * MIN, value: 72 + 6 * Math.min(1, Math.max(0, (i - 30) / 9)) + 0.3 * Math.sin(i) }));
  const placed = refineTurn(ramp, turn);
  // The ramp starts at step 30 and is a quarter of the way up by step 33.
  assert.ok(placed.at >= ramp[30].at && placed.at <= ramp[34].at, new Date(placed.at).toISOString());
  assert.deepEqual([placed.before, placed.after], [72, 78]);
  // Already away at the start, or never away: the time stays as it was.
  assert.equal(refineTurn(ramp.slice(45), turn).at, turn.at);
  assert.equal(refineTurn(ramp.slice(0, 25), turn).at, turn.at);
  // A shift smaller than the noise band cannot be placed.
  assert.equal(refineTurn(ramp, { ...turn, spread: 5 }).at, turn.at);
});

test("the hot room: its temperature turned beside a person's change to the box, and its airflow turned with it", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const zone = P("VAV_105/ZoneTemp");
    const serves = await servesOf(client);
    const changed = station.state.audit.find((a) => /MaxAirflow/.test(a.summary)).timestamp;
    const why = await explain(client, zone, { serves });

    assert.deepEqual([why.ord, why.name, why.live, why.window.until - why.window.since], [zone, "VAV_105/ZoneTemp", true, 7 * DAY]);
    assert.deepEqual(why.equipment, { ord: `${NET}/VAV_105`, name: "VAV_105" }, "the device above the point, as bask model picks it");
    assert.match(why.value.display, /^7[89]\.\d °F$/);
    assert.equal(why.value.state, "alarm");

    // The turn: from where the other rooms sit to where this one sits now, placed within half an hour of the cause.
    assert.ok(why.turn.at > changed && why.turn.at - changed < NEAR, `turned ${Math.round((why.turn.at - changed) / MIN)} min after the change`);
    assert.ok(why.turn.before > 72 && why.turn.before < 73.5 && why.turn.after > 78 && why.turn.after < 79.2);
    assert.match(`${why.turn.beforeText} ${why.turn.afterText}`, /^7[23]\.\d °F 7[89]\.\d °F$/);
    assert.equal(why.steady, undefined);

    // The change beside it comes first, and is marked.
    const [first, ...rest] = why.changes;
    assert.deepEqual([first.near, first.event.who, first.event.agent, first.event.ord, first.event.slot, first.event.from, first.event.to], [true, "operator", undefined, P("VAV_105/MaxAirflow"), "fallback", "620 cfm", "310 cfm"]);
    assert.ok(first.gapMs < 0 && first.gapMs > -NEAR, "it came first");
    assert.ok(rest.length >= 1 && rest.every((c) => !c.near && Math.abs(c.gapMs) > NEAR));
    assert.deepEqual(why.changes.map((c) => Math.abs(c.gapMs)), why.changes.map((c) => Math.abs(c.gapMs)).sort((a, b) => a - b), "nearest the turn first");
    assert.ok(why.changes.every((c) => c.event.kind !== "alarm" && c.event.ord.startsWith(`${NET}/VAV_105`)));

    // The one other point of the box that turned then: its airflow, halved.
    assert.deepEqual(why.siblings.map((s) => [s.ord, s.name]), [[P("VAV_105/Airflow"), "Airflow"]]);
    const [air] = why.siblings;
    assert.ok(air.before > 480 && air.after < 312 && Math.abs(air.gapMs) < NEAR && Math.abs(air.at - changed) < 10 * MIN);
    assert.match(`${air.beforeText} | ${air.afterText}`, /^5\d\d cfm \| 30\d cfm$/);

    assert.deepEqual(why.alarms.map((a) => a.ord), [zone, zone, zone]);
    assert.deepEqual(why.alarms.map((a) => a.until === undefined), [true, false, false], "the open one first, then the two that went back to normal");
    // A sensor: nothing commands it and no link feeds it, which is a finding, not a gap.
    assert.equal(why.command, undefined);
    assert.deepEqual(why.feeds, []);

    // Upstream, from what serves what on the station: the air handler, then the plant behind it.
    assert.deepEqual(why.upstream.map((u) => [u.name, u.feedsName, u.medium, u.depth, u.confirmed, u.inferred, u.points]), [["AHU_02", "VAV_105", "air", 1, true, false, 11], ["CHW_Plant", "AHU_02", "chilledWater", 2, true, false, 8]]);
    assert.deepEqual(why.upstream[0].issues.map((i) => [i.name, i.display, i.states, i.turn]), [["SupplyFanSpeed", "85.0 %", ["overridden"], undefined]]);
    assert.deepEqual(why.upstream[1].issues.map((i) => [i.name, i.display, i.states]), [["Chiller2Status", "Off", ["fault"]]]);
    // What is not known is said, and only that: this station has no change list, which nothing here needs.
    assert.equal(why.notes.length, 1);
    assert.match(why.notes[0], /^The audit log starts \d+ \w{3} \d\d:\d\d, after the \d+ \w{3} \d\d:\d\d asked for: changes before that are gone\.$/);
    assert.ok(!why.notes.includes(NO_CHANGE_LIST));

    // As text: the turn and what was found beside it lead; nothing is guessed.
    const text = whyText(why, { width: 110 });
    const lines = text.split("\n");
    assert.ok(lines.every((line) => [...line].length <= 110));
    assert.match(lines[0], /^VAV_105\/ZoneTemp reads 7[89]\.\d °F, in alarm$/);
    assert.match(lines[1], /^Its value turned \d+ \w{3} \d\d:\d\d, 4 days 2 h ago: from about 7[23]\.\d °F to about 7[89]\.\d °F\.$/);
    assert.match(lines[2], /^ {2}└ \d+ min before: operator changed VAV_105\/MaxAirflow fallback from 620 cfm to 310 cfm$/);
    assert.match(lines[3], /^ {2}└ Airflow turned \d+ min before: from about 5\d\d cfm to about 30\d cfm$/);
    assert.equal(lines[4], "No link feeds it.");
    assert.deepEqual(lines.slice(5, 9), ["↑ AHU_02 feeds it air:", "    ↑ SupplyFanSpeed 85.0 %: overridden", "↑ CHW_Plant feeds AHU_02 chilled water:", "    ↑ Chiller2Status Off: in fault"]);
    assert.equal(lines[9], "Alarms on VAV_105 in the last 7 days:");
    assert.match(text, /\nOther changes on VAV_105 in the last 7 days:\n {2}│ \d+ \w{3} \d\d:\d\d Claude Code asked to override 70\.0 °F for 30 min on VAV_105\/ZoneSetpoint \(P5\)/);
    assert.match(text, /\nNot known:\n {2}│ The audit log starts /);
    assert.doesNotMatch(text, /likely|probably|may be|might|because|caused/i, "found and not found, never a guess");

    // Without a model review file, what feeds the box is said not to be known.
    const alone = await explain(client, zone);
    assert.equal(alone.upstream, undefined);
    assert.ok(alone.notes.includes("What feeds VAV_105 is not known: no model review file was given (bask model infer makes one)."));
    // A proposal nobody confirmed is used, and called what it is.
    const guess = await explain(client, zone, { serves: [{ from: `${NET}/AHU_01`, fromName: "AHU_01", to: `${NET}/VAV_105`, toName: "VAV_105", medium: "air", confidence: 0.5, reason: "", confirmed: false, inferred: true }] });
    assert.deepEqual(guess.upstream.map((u) => [u.name, u.confirmed, u.inferred, u.issues.length, u.points]), [["AHU_01", false, true, 0, 11]]);
    assert.match(whyText(guess), /\n↑ AHU_01 feeds it air \(a proposal nobody has confirmed\): none of its 11 points is in alarm, in fault or overridden, and none turned then\n/);
    // A review file that names nothing for it says so.
    assert.ok((await explain(client, zone, { serves: [] })).notes.includes("The model review file names nothing that feeds VAV_105."));

    // A room nothing happened to: no turn, and that is said as what it is.
    const calm = await explain(client, P("VAV_101/ZoneTemp"), { serves });
    assert.deepEqual([calm.turn, calm.steady, calm.siblings, calm.changes, calm.alarms], [undefined, true, undefined, [], []]);
    assert.match(whyText(calm), /\nIts value did not turn in the last 7 days: it held its level\.\nNo link feeds it\.\n↑ AHU_01 feeds it air: none of its 11 points is in alarm, in fault or overridden\n/);
    assert.match(whyText(calm), /\nNothing was changed on VAV_101 in the last 7 days\.\n/);
  } finally {
    await close();
  }
});

test("what commands a writable point: an override and who set it, a linked input, the fallback", async () => {
  const { client, close } = await startStation({ site: "northgate" });
  try {
    // An operator's override, with who set it and when from the audit log.
    const fan = P("AHU_02/SupplyFanSpeed");
    const held = await explain(client, fan);
    assert.deepEqual({ ...held.command, since: 0 }, { level: 8, slot: "in8", held: "override", display: "85.0 %", by: "admin", since: 0 });
    assert.ok(Math.abs(Date.now() - held.command.since - 962 * MIN) < MIN);
    assert.equal(held.steady, true);
    const text = whyText(held).split("\n");
    assert.match(text[0], /^AHU_02\/SupplyFanSpeed reads 85\.0 %, overridden$/);
    assert.match(text[1], /^It is held by an override at 85\.0 % \(priority level 8\), set by admin since \d+ \w{3} \d\d:\d\d \(16 h 2 min\), with no end set\.$/, "what holds it by hand comes first");
    // The override is told once: not again in the list of changes.
    assert.doesNotMatch(text.slice(2).join("\n"), /overrode AHU_02\/SupplyFanSpeed/);

    // One an agent asked for and a person approved: the approver set it, for the agent.
    const proposal = (await client.proposals("pending"))[0];
    assert.equal(proposal.point, P("VAV_105/ZoneSetpoint"));
    await client.approveProposal(proposal.id);
    const asked = await explain(client, proposal.point);
    assert.deepEqual([asked.command.held, asked.command.by, asked.command.agent, asked.command.id, asked.command.display], ["override", "admin", true, proposal.id, "70.0 °F"]);
    assert.match(whyText(asked), new RegExp(`\\nIt is held by an override at 70\\.0 °F \\(priority level 8\\), set by admin \\(approving ${proposal.id}, which an AI agent asked for\\) since `));

    // Released: the next level down takes over. Here the driver's own value, with no link to it.
    await client.write(fan, "auto");
    const released = await explain(client, fan);
    assert.deepEqual([released.command.level, released.command.slot, released.command.held, released.command.source, released.command.by], [16, "in16", "input", undefined, undefined]);
    assert.match(whyText(released), /\nPriority level 16 \(in16\) is in control at \d+\.\d %, with no link to it\.\n/);

    // An input a link feeds, and the wire sheet behind it, a few steps back, as a tree with what each carries now.
    const valve = await explain(client, P("AHU_01/CoolingValve"));
    assert.deepEqual([valve.command.level, valve.command.held, valve.command.source], [10, "input", { ord: "slot:/Logic/AHU_01/SatLoop", slot: "out", name: "AHU_01/SatLoop" }]);
    assert.deepEqual(valve.feeds.map((f) => [f.depth, f.name, f.sourceSlot, f.targetSlot, f.active]), [
      [1, "AHU_01/SatLoop", "out", "in10", true],
      [2, "AHU_01/SatReset", "out", "setpoint", undefined],
      [3, "AHU_01/OutdoorAirTemp", "out", "inA", undefined],
      [2, "AHU_01/SupplyAirTemp", "out", "controlledVariable", undefined]
    ]);
    assert.equal(valve.feeds[0].display, valve.value.display, "the link in control carries what the point reads");
    assert.ok(valve.feeds.every((f) => /^\d+\.\d (%|°F)$/.test(f.display)));
    assert.match(whyText(valve), /\nPriority level 10 \(in10\) is in control at \d+\.\d %, fed by a link from AHU_01\/SatLoop\.out\.\nWhat reaches it through links:\n {2}└ AHU_01\/SatLoop\.out \d+\.\d % → in10, the level in control\n {4}└ AHU_01\/SatReset\.out \d+\.\d °F → SatLoop\.setpoint\n {6}└ AHU_01\/OutdoorAirTemp\.out \d+\.\d °F → SatReset\.inA\n {4}└ AHU_01\/SupplyAirTemp\.out \d+\.\d °F → SatLoop\.controlledVariable\n/);
    // Each link is followed by what feeds its source, four steps back here, and a schedule is reached too.
    const occupied = await explain(client, P("AHU_01/OccupiedCmd"));
    assert.deepEqual(occupied.feeds.map((f) => `${f.depth} ${f.name}.${f.sourceSlot}`), ["1 AHU_01/Occupied.out", "2 AHU_01/NotFreezing.out", "3 AHU_01/LowLimit.out", "4 AHU_01/MixedAirTemp.out", "2 Schedules/OfficeHours.out"]);
    assert.match(occupied.command.display, /^(Occupied|Unoccupied)$/);
    assert.ok(occupied.notes.includes("It keeps no history, so when its value last turned cannot be told."));

    // Nothing at any level: the fallback. It has no history either, and the change to it is still found.
    const most = await explain(client, P("VAV_105/MaxAirflow"));
    assert.deepEqual(most.command, { level: "fallback", slot: "fallback", held: "fallback", display: "310 cfm" });
    assert.deepEqual([most.turn, most.steady], [undefined, undefined]);
    assert.ok(most.changes.some((c) => c.event.who === "operator" && c.event.to === "310 cfm" && c.near === false && c.gapMs === undefined));
    const said = whyText(most);
    assert.match(said, /\nNothing commands it: every priority level is empty, so it sits at its fallback at 310 cfm\.\n/);
    assert.match(said, /\nChanges on VAV_105 in the last 7 days:\n/);
    assert.match(said, /│ \d+ \w{3} \d\d:\d\d operator changed VAV_105\/MaxAirflow fallback from 620 cfm to 310 cfm\n/);
    assert.match(said, /│ It keeps no history, so when its value last turned cannot be told\./);

    await assert.rejects(explain(client, `${NET}/VAV_105/points/Nope`), /^Error: There is no point at slot:\/Drivers\/BacnetNetwork\/VAV_105\/points\/Nope/);
  } finally {
    await close();
  }
});

test("the level in control is read the same from a station's own reply as from the simulated one", () => {
  const ord = "slot:/Drivers/N/AHU/points/Valve";
  const input = (value) => (value === null ? { status: "{null}", ok: false, value: 0, display: "- {null}" } : { status: "{ok}", ok: true, value, display: `${value.toFixed(1)} % {ok}` });
  // What the module sends: the active level as an enum, sixteen levels each with what it holds.
  const levels = (held) => Array.from({ length: 16 }, (_v, i) => ({ level: i + 1, name: String(i + 1), property: `in${i + 1}`, input: input(held[i + 1] ?? null) }));
  const real = (active, held, more = {}) => ({ point: ord, ok: true, writable: true, valueKind: "numeric", activeLevel: active, overrideExpiration: null, fallback: { status: "{ok}", ok: true, value: 20, display: "20.0 % {ok}" }, levels: levels(held), ...more });
  const described = { links: [{ direction: "in", source: "station:|slot:/Logic/Loop", sourceSlot: "out", target: ord, targetSlot: "in10" }, { direction: "out", source: ord, sourceSlot: "out", target: "slot:/Logic/Other", targetSlot: "inA" }] };

  assert.deepEqual(commandOf(real({ ordinal: 8, tag: "level_8", display: "8" }, { 8: 85, 10: 40 }, { overrideExpiration: { timestamp: 1790000000000, display: "…" } }), undefined, described, ord),
    { level: 8, slot: "in8", held: "override", display: "85.0 %", expires: 1790000000000 });
  assert.deepEqual(commandOf(real({ ordinal: 1, tag: "level_1", display: "1" }, { 1: 0, 8: 85 }), undefined, described, ord), { level: 1, slot: "in1", held: "emergency", display: "0.0 %" });
  assert.deepEqual(commandOf(real({ ordinal: 10, tag: "level_10", display: "10" }, { 10: 40 }), undefined, described, ord),
    { level: 10, slot: "in10", held: "input", display: "40.0 %", source: { ord: "slot:/Logic/Loop", slot: "out", name: "Logic/Loop" } });
  assert.deepEqual(commandOf(real({ ordinal: 17, tag: "fallback", display: "def" }, {}), undefined, described, ord), { level: "fallback", slot: "fallback", held: "fallback", display: "20.0 %" });
  // No active level given: the highest level that holds a value.
  assert.deepEqual(commandOf(real(undefined, { 12: 33, 16: 50 }), undefined, undefined, ord), { level: 12, slot: "in12", held: "input", display: "33.0 %" });
  // The simulated station's shape: the level as a word, no levels listed; the snapshot gives the value.
  const snapshot = { point: ord, ok: true, displayValue: "85.0 %", status: "{overridden} @ 8", activeLevel: "8" };
  assert.deepEqual(commandOf({ point: ord, writable: true, activeLevel: "8", levels: [] }, snapshot, described, ord), { level: 8, slot: "in8", held: "override", display: "85.0 %" });
  assert.deepEqual(commandOf({ point: ord, writable: true, activeLevel: "def", fallback: { value: 20, status: "{ok}" }, levels: [] }, { ...snapshot, displayValue: "20.0 %", status: "{ok} @ def", activeLevel: "def" }, described, ord), { level: "fallback", slot: "fallback", held: "fallback", display: "20.0 %" });
  // No write description at all (a station without it): the snapshot's status still says the level.
  assert.deepEqual(commandOf(undefined, { point: ord, ok: true, displayValue: "40.0 %", status: "{ok} @ 10" }, described, ord).source.ord, "slot:/Logic/Loop");
  // Not writable, or nothing that says: no command.
  assert.equal(commandOf({ point: ord, writable: false }, snapshot, described, ord), undefined);
  assert.equal(commandOf(undefined, { point: ord, ok: true, status: "{ok}" }, undefined, ord), undefined);
});

test("a moment in the past: the value then, the changes before it, and an override that was in place", async () => {
  const { client, close } = await startStation({ site: "northgate" });
  try {
    const zone = P("VAV_105/ZoneTemp");
    // Five days ago the room was like the others, and nothing had happened to the box yet.
    const then = Date.now() - 5 * DAY;
    const before = await explain(client, zone, { at: then });
    assert.deepEqual([before.live, before.at, before.window.until], [false, then, then]);
    assert.ok(before.value.value < 74.5 && before.value.at <= then && then - before.value.at < 5 * MIN);
    assert.deepEqual([before.turn, before.steady, before.changes, before.alarms], [undefined, true, [], []]);
    const text = whyText(before);
    assert.match(text, /^VAV_105\/ZoneTemp reads 7[1-4]\.\d °F at \d+ \w{3} \d\d:\d\d\n/);
    assert.match(text, /\nIts value did not turn in the 7 days before: it held its level\.\n/);
    assert.match(text, /\nNothing was changed on VAV_105 in the 7 days before\.\n/);

    // Three days ago, the day after it turned: the same turn, seen from then.
    const after = await explain(client, zone, { at: Date.now() - 3 * DAY });
    assert.ok(after.turn && after.changes[0].near && after.changes[0].event.who === "operator");
    assert.match(whyText(after), /\nIts value turned \d+ \w{3} \d\d:\d\d, 2[5-7] h( \d+ min)? earlier: from about 7[23]\.\d °F to about 7[89]\.\d °F\.\n/);

    // A writable point: which level was in control then is not recorded, but an override is dated by the audit log.
    const fan = P("AHU_01/SupplyFanSpeed");
    const during = await explain(client, fan, { at: Date.now() - (3 * DAY + 300 * MIN) });
    assert.deepEqual([during.command.level, during.command.held, during.command.by, during.command.display], [8, "override", "admin", "60.0 %"]);
    assert.ok(Math.abs(during.at - during.command.since - 100 * MIN) < MIN);
    assert.match(whyText(during), /\nIt is held by an override at 60\.0 % \(priority level 8\), set by admin since \d+ \w{3} \d\d:\d\d \(1 h 40 min\), with no end set\.\n/);
    const later = await explain(client, fan, { at: Date.now() - 2 * DAY });
    assert.equal(later.command, undefined);
    assert.ok(later.notes.some((note) => /^Which priority level was in control at \d+ \w{3} \d\d:\d\d is not recorded\. The audit log shows no override of it in place then\.$/.test(note)));

    // A time before its history begins: said, not made up.
    const early = await explain(client, zone, { at: Date.now() - 30 * DAY });
    assert.equal(early.value, undefined);
    assert.ok(early.notes.some((note) => /^What it read at \d+ \w{3} \d\d:\d\d is not known\. Its history starts \d+ \w{3} \d\d:\d\d, after the time asked for\.$/.test(note)));
  } finally {
    await close();
  }
});

test("Northgate holds what serves what, and a week of history to look back over", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    // On the station itself, as Haystack relations held by the equipment that is fed.
    const ords = [...Array.from({ length: 8 }, (_v, i) => `${NET}/VAV_10${i + 1}`), `${NET}/AHU_01`, `${NET}/AHU_02`, `${NET}/CHW_Plant`];
    const targets = (await client.call("read_tags", { ords, dictionary: "hs", includeRelations: true })).targets;
    const leaving = targets.map((t) => [t.ord.split("/").pop(), ...t.relations.filter((r) => r.direction === "out").map((r) => `${r.name} ${r.endpointOrd.split("/").pop()}`)]);
    assert.deepEqual(leaving, [
      ["VAV_101", "airRef AHU_01"], ["VAV_102", "airRef AHU_01"], ["VAV_103", "airRef AHU_01"], ["VAV_104", "airRef AHU_01"],
      ["VAV_105", "airRef AHU_02"], ["VAV_106", "airRef AHU_02"], ["VAV_107", "airRef AHU_02"], ["VAV_108", "airRef AHU_02"],
      ["AHU_01", "chilledWaterRef CHW_Plant"], ["AHU_02", "chilledWaterRef CHW_Plant"], ["CHW_Plant"]
    ]);
    assert.equal(targets[10].relations.filter((r) => r.direction === "in").length, 2, "the plant sees both air handlers arriving");
    // bask model takes them as they are: held by the station, so not proposals.
    const serves = await servesOf(client);
    assert.equal(serves.length, 10);
    assert.ok(serves.every((s) => s.confirmed && !s.inferred && s.confidence === 1 && /^the station relates them \((airRef|chilledWaterRef)\)$/.test(s.reason)));

    // The box's maximum airflow: writable, in cfm, at half what it was.
    const [most, zone] = await client.read([P("VAV_105/MaxAirflow"), P("VAV_105/ZoneTemp")]);
    assert.deepEqual([most.displayValue, most.facets.units, most.status, (await client.describe(P("VAV_105/MaxAirflow"))).writable], ["310 cfm", "cfm", "{ok} @ def", true]);
    assert.match(zone.displayValue, /^7[89]\.\d °F$/, "the hot room still reads hot");
    // The change was a person's, about four days ago.
    const change = station.state.audit.find((a) => /MaxAirflow/.test(a.summary));
    assert.match(change.value, /\[operator\] Changed;slotName=fallback;oldValue=620 cfm;value=310 cfm$/);
    assert.ok(Math.abs(Date.now() - change.timestamp - 4 * DAY) < 3 * HOUR);

    // The audit history and the alarm history reach back about a week, with an agent's change among them.
    const oldest = Math.min(...station.state.audit.map((a) => a.timestamp));
    assert.ok(Date.now() - oldest > 6 * DAY && Date.now() - oldest < 7 * DAY);
    const alarms = (await client.alarms({ scope: "all", order: "oldest" })).alarms;
    assert.ok(Date.now() - alarms[0].timestamp > 6 * DAY);
    assert.equal(alarms.filter((a) => !a.isOpen && a.sourceState === "normal" && a.ackState === "acked" && a.normalTime > a.timestamp).length, 4);
    assert.equal(alarms.filter((a) => a.isOpen).length, 7, "the open alarms are the seven there were");
    assert.ok(station.state.agentLog.some((r) => Date.now() - r.timestamp > 5 * DAY && r.outcome === "completed"));
  } finally {
    await close();
  }
});
