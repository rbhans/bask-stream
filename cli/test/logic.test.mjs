// Logic: a folder as a wire sheet in text. The layout and tracing on their own, the demo station's
// blocks and links (which compute, with kitControl's slot names), building logic from a plan file
// through the commands, and the Logic view.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BaskStreamClient } from "@basidekick/baskstream";
import { Link } from "../dist/link.js";
import { drawSheet, loadSheet, planSheet, slotOrd, traceOf, traceText } from "../dist/logic.js";
import { logicGuide } from "../dist/logic-guide.js";
import { buildLayout } from "../dist/workspace.js";
import { mount, settle, startStation } from "./harness.mjs";

const len = (text) => [...text].length;
const NET = "slot:/Drivers/BacnetNetwork";
const AHU = `${NET}/AHU_01/points`;
const LOGIC = "slot:/Logic/AHU_01";
const block = (name, slots, extra = {}) => ({ ord: `slot:/L/${name}`, name, type: "Add", typeSpec: "kitControl:Add", container: false, outside: false, slots, point: true, writable: false, ...extra });
const link = (from, to) => {
  const [a, b] = [from.split("."), to.split(".")];
  return { source: `slot:/L/${a[0]}`, sourceSlot: a[1], target: `slot:/L/${b[0]}`, targetSlot: b[1] };
};

test("a sheet is laid out left to right the way values flow, and every link finds a way", () => {
  const sheet = {
    folder: "slot:/L", hidden: 0,
    blocks: [block("Mix", ["inA", "inB", "out"]), block("Low", ["inA", "out"]), block("Sensor", ["out"]), block("Valve", ["in10", "out"]), block("Spare", ["out"]), block("Zones", [], { container: true, type: "Folder" })],
    links: [link("Sensor.out", "Low.inA"), link("Sensor.out", "Mix.inA"), link("Low.out", "Mix.inB"), link("Mix.out", "Valve.in10")]
  };
  const plan = planSheet(sheet);
  const at = Object.fromEntries(plan.blocks.map((p) => [p.block.name, p]));
  // What feeds a block sits to its left; the unlinked ones go underneath.
  assert.ok(at.Sensor.x < at.Low.x && at.Low.x < at.Mix.x && at.Mix.x < at.Valve.x);
  assert.ok(at.Spare.y > at.Mix.y + at.Mix.h && at.Zones.y === at.Spare.y);
  for (const a of plan.blocks) for (const b of plan.blocks) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.block.name} overlaps ${b.block.name}`);
  assert.deepEqual(plan.routes.map(Boolean), [true, true, true, true]);
  // A wire leaves the right of its source's row and arrives at the left of its target's.
  plan.routes.forEach((route, i) => {
    const from = at[sheet.links[i].source.slice(8)];
    const to = at[sheet.links[i].target.slice(8)];
    assert.deepEqual(route[0], [from.x + from.w, from.rows.get(sheet.links[i].sourceSlot)]);
    assert.deepEqual(route[route.length - 1], [to.x - 1, to.rows.get(sheet.links[i].targetSlot)]);
  });
  assert.deepEqual(plan.points.slice(0, 3), ["slot:/L/Mix/inA", "slot:/L/Mix/inB", "slot:/L/Mix/out"]);

  const values = (ord) => ({ ok: true, displayValue: ord.endsWith("out") ? "72.0 °F" : "1", state: ord.includes("Low") ? "alarm" : "ok" });
  const text = drawSheet(plan, values, 0).toString();
  for (const line of text.split("\n")) assert.ok(len(line) <= plan.width);
  assert.match(text, /╭─ Sensor ─+╮/);
  assert.match(text, /│ out +72\.0 °F ├─/);
  assert.match(text, /─▸┤ in10 +1 │/);
  assert.match(text, /╰─ Add ─+╯/);
  assert.match(text, /╭─ ▸ Zones ─*╮\n.*│ Folder/);
  // A longer value gets room when the sheet is planned for it, and is cut short when it is not.
  assert.match(drawSheet(plan, () => ({ ok: true, displayValue: "Unoccupied until 6:30" }), 0).toString(), /Unoccupi…/);
  assert.match(drawSheet(planSheet(sheet, { valueWidth: 21 }), () => ({ ok: true, displayValue: "Unoccupied until 6:30" }), 0).toString(), /out Unoccupied until 6:30 /);
  assert.match(drawSheet(plan, () => undefined, 0).toString(), /│ out +… │/);

  // A loop of links still lays out, and the blocks with no links wrap at the width given.
  const loop = planSheet({ folder: "slot:/L", hidden: 0, blocks: [block("A", ["in", "out"]), block("B", ["in", "out"])], links: [link("A.out", "B.in"), link("B.out", "A.in")] });
  assert.deepEqual(loop.routes.map(Boolean), [true, true]);
  const many = planSheet({ folder: "slot:/L", hidden: 0, blocks: Array.from({ length: 12 }, (_v, i) => block(`Point${i}`, ["out"])), links: [] }, { maxWidth: 70 });
  assert.ok(many.width <= 74 && new Set(many.blocks.map((p) => p.y)).size >= 3);
});

test("a value is followed to what feeds it and what it drives", () => {
  const sheet = {
    folder: "slot:/L", hidden: 0,
    blocks: [block("Sensor", ["out"]), block("Reset", ["inA", "out"]), block("Loop", ["cv", "sp", "out"]), block("Valve", ["in10", "out"]), block("Other", ["out"]), block("Alarm", ["inA", "out"])],
    links: [link("Sensor.out", "Reset.inA"), link("Reset.out", "Loop.sp"), link("Loop.out", "Valve.in10"), link("Other.out", "Alarm.inA")]
  };
  const trace = traceOf(sheet, "slot:/L/Loop", "sp");
  assert.deepEqual([...trace.links].sort(), [0, 1, 2]);
  assert.deepEqual([...trace.blocks].map((ord) => ord.slice(8)).sort(), ["Loop", "Reset", "Sensor", "Valve"]);
  const values = (ord) => ({ ok: true, displayValue: { "slot:/L/Sensor/out": "68.4 °F", "slot:/L/Reset/out": "56.0 °F", "slot:/L/Loop/out": "38 %", "slot:/L/Valve/in10": "38 %" }[ord] });
  assert.equal(traceText(sheet, trace, values), "Sensor.out 68.4 °F → Reset.inA → Reset.out 56.0 °F → Loop.sp → Loop.out 38 % → Valve.in10 38 %");
  // From an output: the block's inputs are what feed it.
  assert.equal(traceText(sheet, traceOf(sheet, "slot:/L/Reset", "out"), values), "Sensor.out 68.4 °F → Reset.inA → Reset.out 56.0 °F → Loop.sp → Loop.out 38 % → Valve.in10 38 %");
  // On a narrow line the middle steps go, and both ends stay.
  assert.equal(traceText(sheet, trace, values, 60), "Sensor.out 68.4 °F → Reset.inA → … → Valve.in10 38 %");
  assert.equal(traceText(sheet, trace, values, 200), traceText(sheet, trace, values));
  // Nothing wired: only itself.
  assert.deepEqual(traceOf(sheet, "slot:/L/Other", "out").chain.map((s) => `${s.ord.slice(8)}.${s.slot}`), ["Other.out", "Alarm.inA"]);
  assert.equal(traceOf(sheet, "slot:/L/Valve", "out").links.size, 3);
});

// ---- On the demo station ----------------------------------------------------------------------------

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const configDir = mkdtempSync(join(tmpdir(), "bask-logic-"));
process.env.BASKSTREAM_CONFIG_DIR = configDir;
let station;
let client;
let closeStation;
const bask = (env, ...args) =>
  run(process.execPath, [main, ...args], { env: { ...process.env, BASKSTREAM_CONFIG_DIR: configDir, BASKSTREAM_PASSWORD: "demo", FORCE_COLOR: "0", ...env } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e) => ({ code: e.code, out: e.stdout + e.stderr })
  );
const AGENT = { BASK_AGENT: "Claude Code", BASK_ON_BEHALF_OF: "pat" };
before(async () => {
  ({ station, client, close: closeStation } = await startStation());
  assert.equal((await bask({}, "login", station.url, "-u", station.user, "--name", "demo")).code, 0);
});
after(async () => {
  await closeStation();
  rmSync(configDir, { recursive: true, force: true });
});

test("the demo station's logic computes: blocks follow their inputs, links carry values, and a point follows its in10", async () => {
  const read = async (...ords) => (await client.read(ords)).map((p) => p.value);
  const [oat, reset, sat, loopOut, valve, valveIn] = await read(`${AHU}/OutdoorAirTemp`, `${LOGIC}/SatReset`, `${AHU}/SupplyAirTemp`, `${LOGIC}/SatLoop`, `${AHU}/CoolingValve`, `${AHU}/CoolingValve/in10`);
  // The reset is a line from 57 °F at 55 °F outside to 54 °F at 80 °F, and the loop is proportional about its bias.
  const expected = 57 + (54 - 57) * Math.min(1, Math.max(0, (oat - 55) / 25));
  assert.ok(Math.abs(reset - expected) < 0.02, `${reset} for ${oat} outside`);
  assert.ok(Math.abs(loopOut - Math.min(100, Math.max(0, 55 + 8 * (sat - reset)))) < 0.6);
  assert.ok(loopOut > 20 && loopOut < 80);
  assert.equal(valve, valveIn);
  assert.ok(Math.abs(valve - loopOut) < 0.02);
  // Any slot reads like a point, an input in the units of what feeds it.
  const [inA, inB, flag] = await client.read([`${LOGIC}/SatReset/inA`, `${LOGIC}/LowLimit/inB`, `${LOGIC}/NotFreezing/out`]);
  assert.match(inA.displayValue, /^\d\d\.\d °F$/);
  assert.equal(inA.value, oat);
  assert.deepEqual([inB.value, inB.displayValue, flag.value], [38, "38.0", true]);
  assert.equal((await client.read([`${LOGIC}/SatReset/nope`]))[0].ok, false);
  // The valve is held by the loop at level 10, under an operator's override at 8.
  assert.match((await client.read([`${AHU}/CoolingValve`]))[0].status, /@ 10$/);

  const described = (await client.call("describe_component", { ord: `${LOGIC}/SatLoop` })).result;
  assert.deepEqual(described.links.map((l) => `${l.direction} ${l.source.split("/").pop()}.${l.sourceSlot} → ${l.target.split("/").pop()}.${l.targetSlot}`),
    ["in SupplyAirTemp.out → SatLoop.controlledVariable", "in SatReset.out → SatLoop.setpoint", "out SatLoop.out → CoolingValve.in10"]);
  assert.deepEqual(described.dependencies.knownReferences.map((r) => r.kind), ["incoming_link"]);
  const slots = Object.fromEntries(described.slots.map((slot) => [slot.name, slot]));
  assert.deepEqual([slots.controlledVariable.typeSpec, slots.controlledVariable.flags, slots.proportionalConstant.value.encoded, slots.out.flags], ["baja:StatusNumeric", 8, "8", 11]);
  assert.deepEqual(described.slots.filter((slot) => slot.typeSpec === "baja:Link").length, 2);
  const type = (await client.call("describe_component_types", { typeSpec: "kitControl:Reset" })).result;
  assert.deepEqual(type.slots.map((slot) => slot.name), ["facets", "inA", "inputLowLimit", "inputHighLimit", "outputLowLimit", "outputHighLimit", "out"]);
});

test("a folder loads as a sheet: its blocks, the far ends of links that leave it, and a route for each", async () => {
  const sheet = await loadSheet(client, LOGIC);
  assert.deepEqual(sheet.blocks.filter((b) => !b.outside).map((b) => `${b.name}:${b.type}:${b.slots.join(",")}`),
    ["SatReset:Reset:inA,out", "SatLoop:LoopPoint:controlledVariable,setpoint,out", "LowLimit:LessThan:inA,inB,out", "NotFreezing:Not:in,out", "Occupied:And:inA,inB,out"]);
  assert.deepEqual(sheet.blocks.filter((b) => b.outside).map((b) => `${b.name}:${b.slots.join(",")}`).sort(),
    ["AHU_01/CoolingValve:in10", "AHU_01/MixedAirTemp:out", "AHU_01/OccupiedCmd:in10", "AHU_01/OutdoorAirTemp:out", "AHU_01/SupplyAirTemp:out", "Schedules/OfficeHours:out"]);
  assert.equal(sheet.links.length, 9);
  const plan = planSheet(sheet);
  assert.equal(plan.routes.filter((route) => !route).length, 0);
  const now = new Map((await client.read(plan.points)).map((p) => [p.point, p]));
  assert.deepEqual([...now.values()].filter((p) => !p.ok).map((p) => p.point), []);
  const text = drawSheet(plan, (ord) => now.get(ord), 0).toString();
  assert.match(text, /╭┄ AHU_01\/OutdoorAirTemp ┄╮/);
  assert.match(text, /▸┤ setpoint +5\d\.\d °F │/);
  assert.match(text, /│ out +\d\d\.\d % ├─/);
  // A device's points show the logic that reads and drives them; the root shows folders to open.
  const points = await loadSheet(client, AHU);
  assert.ok(points.blocks.some((b) => b.outside && b.name === "AHU_01/SatLoop"));
  assert.deepEqual(points.blocks.find((b) => b.name === "CoolingValve").slots, ["in10", "in16", "out"]);
  const root = await loadSheet(client, "slot:/");
  assert.deepEqual(root.blocks.map((b) => [b.name, b.container]), [["Services", true], ["Drivers", true], ["Schedules", true], ["Logic", true]]);
});

test("logic is built from a plan file through bask, as the guide shows it, and read back", async () => {
  const guide = await bask({}, "logic", "guide");
  assert.equal(guide.out, logicGuide());
  const file = join(configDir, "logic.json");
  writeFileSync(file, /```json\n(\{[\s\S]*?)\n```/.exec(guide.out)[1]);

  // The guide's own example: checking it changes nothing, and applying it makes a zone's setpoint follow a schedule.
  const checked = await bask(AGENT, "plan", file);
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /add +Logic\/VAV_101\/Setpoint +kitControl:NumericSwitch/);
  assert.match(checked.out, /link +Logic\/VAV_101\/Setpoint\.out → VAV_101\/points\/ZoneSetpoint\.in10/);
  assert.match(checked.out, /The station accepts these 8 changes\. Nothing is changed yet/);
  assert.equal(station.state.nodes.has("slot:/Logic/VAV_101"), false);
  assert.match((await bask(AGENT, "plan", file, "--apply")).out, /--allow-writes/);
  assert.match((await bask(AGENT, "plan", file, "--apply", "--allow-writes", "-y")).out, /reason_required/);
  const example = await bask(AGENT, "plan", file, "--apply", "--allow-writes", "-y", "--reason", "Room 101 sets back out of hours");
  assert.equal(example.code, 0, example.out);
  assert.match(example.out, /✓ Made 8 changes\. +Check it: bask logic print slot:\/Logic\/VAV_101/);
  const [occupied, setpoint] = await client.read(["slot:/Schedules/OfficeHours/out", `${NET}/VAV_101/points/ZoneSetpoint`]);
  assert.equal(setpoint.value, occupied.value ? 72 : 78);
  assert.match(setpoint.status, /@ 10$/);
  const zone = await bask({}, "logic", "print", "slot:/Logic/VAV_101");
  assert.match(zone.out, /Logic\/VAV_101 · 3 blocks · 4 links/);
  // A constant's value is on the sheet itself.
  assert.match(zone.out, /╭─ Occupied ─+╮[\s\S]*│ out +72\.0 ├─/);
  assert.match(zone.out, /Setpoint\.out → VAV_101\/ZoneSetpoint\.in10/);

  // The same for an air handler: a reset and a loop like AHU-1's, written out as a plan.
  const double = (encoded) => ({ typeSpec: "baja:Double", encoded: String(encoded) });
  const ahu2 = `${NET}/AHU_02/points`;
  writeFileSync(file, JSON.stringify({ changes: [
    { action: "create", parent: "slot:/Logic", name: "AHU_02", typeSpec: "baja:Folder", ref: "folder" },
    { action: "create", parent: "@folder", name: "SatReset", typeSpec: "kitControl:Reset", ref: "reset", properties: { "inputLowLimit/value": double(55), "inputHighLimit/value": double(80), "outputLowLimit/value": double(57), "outputHighLimit/value": double(54) } },
    { action: "create", parent: "@folder", name: "SatLoop", typeSpec: "kitControl:LoopPoint", ref: "loop", properties: { proportionalConstant: double(8), bias: double(55), facets: { typeSpec: "baja:Facets", encoded: "units=u:%|precision=i:1" } } },
    { action: "create_link", source: `${ahu2}/OutdoorAirTemp`, sourceSlot: "out", target: "@reset", targetSlot: "inA" },
    { action: "create_link", source: `${ahu2}/SupplyAirTemp`, sourceSlot: "out", target: "@loop", targetSlot: "controlledVariable" },
    { action: "create_link", source: "@reset", sourceSlot: "out", target: "@loop", targetSlot: "setpoint" },
    { action: "create_link", source: "@loop", sourceSlot: "out", target: `${ahu2}/CoolingValve`, targetSlot: "in10" }
  ] }));
  const applied = await bask(AGENT, "plan", file, "--apply", "--allow-writes", "-y", "--reason", "AHU-2 gets the same supply air reset as AHU-1");
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /✓ Made 7 changes\. +Check it: bask logic print slot:\/Logic\/AHU_02/);
  assert.deepEqual(new Link(station.url).get().show.kind, "logic");
  assert.equal(new Link(station.url).get().show.ord, "slot:/Logic/AHU_02");
  const [loopOut, valve] = (await client.read(["slot:/Logic/AHU_02/SatLoop", `${NET}/AHU_02/points/CoolingValve`])).map((p) => p.value);
  assert.ok(Math.abs(loopOut - valve) < 0.02 && loopOut > 20 && loopOut < 80, `${loopOut} and ${valve}`);
  const log = (await client.agentLog({ since: Date.now() - 60000 })).records.filter((r) => r.action === "apply_model_changes").pop();
  assert.deepEqual([log.agent, log.outcome], ["Claude Code", "completed"]);
  // The settings read back the same as the ones it was copied from.
  const settings = async (folder) => JSON.parse((await bask({}, "logic", "print", folder, "-o", "json")).out).blocks.filter((b) => !b.outside).map((b) => [b.name, b.settings.filter((x) => x.name !== "facets").map((x) => `${x.name} ${x.value}`).join(" · ")]);
  assert.deepEqual(await settings("slot:/Logic/AHU_02"), (await settings(LOGIC)).filter(([name]) => /^Sat/.test(name)));
  assert.deepEqual((await settings(LOGIC))[1], ["SatLoop", "loopEnable true · loopAction direct · proportionalConstant 8 · integralConstant 0 · derivativeConstant 0 · bias 55 · maximumOutput 100 · minimumOutput 0"]);

  const printed = await bask({}, "logic", "print", "slot:/Logic/AHU_02", "--trace", "SatLoop.setpoint");
  assert.equal(printed.code, 0, printed.out);
  assert.match(printed.out, /╭─ SatLoop ─+╮/);
  assert.match(printed.out, /Logic\/AHU_02 · 2 blocks · 4 links · \d+ x \d+ cells/);
  assert.match(printed.out, /  SatReset\.out → SatLoop\.setpoint\n/);
  assert.match(printed.out, /trace +AHU_02\/OutdoorAirTemp\.out \d\d\.\d °F → SatReset\.inA → SatReset\.out 5\d\.\d → SatLoop\.setpoint → SatLoop\.out \d\d\.\d % → AHU_02\/CoolingValve\.in10 \d\d\.\d %/);
  assert.match(printed.out, /settings\n +SatReset +.*inputLowLimit 55 · inputHighLimit 80 · outputLowLimit 57 · outputHighLimit 54\n +SatLoop +facets units=u:%\|precision=i:1 · loopEnable true · loopAction direct · proportionalConstant 8/);
  const json = JSON.parse((await bask({}, "logic", "print", "slot:/Logic/AHU_02", "-o", "json")).out);
  assert.deepEqual(json.blocks.filter((b) => !b.outside).map((b) => b.name), ["SatReset", "SatLoop"]);
  assert.match(json.blocks.find((b) => b.name === "SatLoop").slots.find((s) => s.name === "out").value, /^\d\d\.\d %$/);
  assert.match((await bask({}, "logic", "print", "slot:/Logic/AHU_02", "--trace", "Nope.out")).out, /No Nope\.out on this sheet\. Blocks: SatReset \(inA, out\)/);

  // Mistakes say what is there instead; a second link into one input, and a point command through a plan, are refused.
  const tryPlan = async (changes, env = AGENT) => {
    writeFileSync(file, JSON.stringify({ changes }));
    return (await bask(env, "plan", file)).out;
  };
  assert.match(await tryPlan([{ action: "create_link", source: "slot:/Logic/AHU_02/SatReset", sourceSlot: "out", target: "slot:/Logic/AHU_02/SatLoop", targetSlot: "setPoint" }]), /invalid_slot.*SatLoop \(kitControl:LoopPoint\) has no input "setPoint"\. It has: loopEnable, controlledVariable, setpoint\./);
  assert.match(await tryPlan([{ action: "create_link", source: "slot:/Logic/AHU_02/SatReset", sourceSlot: "out", target: "slot:/Logic/AHU_02/SatLoop", targetSlot: "setpoint" }]), /already has a link/);
  assert.match(await tryPlan([{ action: "create", parent: "slot:/Logic/AHU_02", name: "X", typeSpec: "kitControl:Nope" }]), /unknown_type/);
  assert.match(await tryPlan([{ action: "invoke", ord: `${NET}/AHU_02/points/CoolingValve`, slot: "override", parameter: { typeSpec: "baja:Double", encoded: "100" } }]), /agent_use_write/);
  assert.match(await tryPlan([]), /holds no changes/);

  // Changing a setting, taking a link out and deleting a block all follow through to the values.
  writeFileSync(file, JSON.stringify({ changes: [{ action: "update", ord: "slot:/Logic/AHU_02/SatLoop", properties: { bias: { typeSpec: "baja:Double", encoded: "70" } } }, { action: "delete_link", ord: "slot:/Logic/AHU_02/SatLoop", slot: "setpoint" }] }));
  assert.match((await bask({}, "plan", file, "--apply", "--allow-writes", "-y")).out, /✓ Made 2 changes/);
  assert.equal((await client.read(["slot:/Logic/AHU_02/SatLoop"]))[0].state, "null");
  writeFileSync(file, JSON.stringify([{ action: "delete", ord: "slot:/Logic/AHU_02", recursive: true }]));
  assert.match((await bask({}, "plan", file, "--apply", "--allow-writes", "-y")).out, /✓ Made the change/);
  assert.equal(station.state.nodes.has("slot:/Logic/AHU_02/SatLoop"), false);
  assert.match((await client.read([`${NET}/AHU_02/points/CoolingValve`]))[0].status, /@ 16$/);

  assert.match((await bask({}, "show", "--logic", "Logic/AHU_01")).out, /Logic\/AHU_01 will be opened as a wire sheet in Logic/);
  assert.match((await bask({}, "agent-brief")).out, /bask logic guide/);
  assert.deepEqual(buildLayout({ layout: "logic", profile: "demo", allowWrites: false, agent: { label: "Claude Code", shell: "claude", env: {} } }).map((p) => p.label), ["Logic", "Claude Code", "AI Activity"]);
});

test("the Logic view opens where the logic is, moves between slots, traces a value and follows what is built", async () => {
  // A station of its own: the one above has had more logic built on it by now.
  const own = await startStation();
  const { client } = own;
  const link = new Link(own.station.url, false);
  const app = mount(client, { view: "logic", link }, { columns: 180, rows: 32 });
  try {
    const frame = await app.until(/Logic · Logic\/AHU_01 ─+ 5 blocks · 9 links/);
    assert.match(frame, /L Logic/);
    await app.until(/▸┤ setpoint +5\d\.\d °F │/);
    for (const line of app.frame().split("\n")) assert.ok(len(line) <= 180, line);
    // The first block is picked, with what feeds its slot underneath.
    await app.until(/LowLimit\.inA \d\d\.\d °F +kitControl:LessThan · slot:\/Logic\/AHU_01\/LowLimit/);
    assert.match(app.frame(), /← AHU_01\/MixedAirTemp\.out/);
    await app.press("down", "down");
    await app.until(/LowLimit\.out false/);
    assert.match(app.frame(), /→ NotFreezing\.in/);
    // Across to the next block, and enter follows the value through.
    await app.press("right", "enter");
    const traced = await app.until(/tracing/);
    // The whole way through, from the sensor to the point it ends at (steps in the middle give way when the line is short).
    assert.match(traced, /AHU_01\/MixedAirTemp\.out \d\d\.\d °F → LowLimit\.inA → LowLimit\.out false → .* → AHU_01\/OccupiedCmd\.in10 \w+/);
    const before = app.frame();
    await settle(500);
    assert.notEqual(app.frame(), before, "the traced wires carry moving marks");
    await app.press("esc");
    // Up a folder: the one we came from is a block to open again.
    await app.press("u");
    await app.until(/Logic · Logic ─+ 1 block · 0 links/);
    assert.match(app.frame(), /╭─ ▸ AHU_01 ─*╮/);
    assert.match(app.frame(), /⏎ opens it/);
    await app.press("enter");
    await app.until(/Logic · Logic\/AHU_01/);

    // Something an agent builds shows up by itself.
    const plan = (await client.call("preview_model_changes", { changes: [{ action: "create", parent: LOGIC, name: "Hot", typeSpec: "kitControl:GreaterThan", ref: "hot" }, { action: "create_link", source: `${AHU}/OutdoorAirTemp`, sourceSlot: "out", target: "@hot", targetSlot: "inA" }] })).result;
    await client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: "k1" });
    await app.until(/6 blocks · 10 links/, 3000);
    assert.match(app.frame(), /╭─ Hot ─+╮/);

    // Asked to show a point, it opens the folder the point is in and picks it.
    link.update((shared) => void (shared.show = { n: 1, kind: "logic", ord: `${AHU}/CoolingValve`, from: 1 }));
    await app.until(/Logic · Drivers\/BacnetNetwork\/AHU_01 /);
    await app.until(/CoolingValve\.in10 \d\d\.\d % +control:NumericWritable/);
    assert.match(app.frame(), /← AHU_01\/SatLoop\.out/);
    // Enter on the far end of a link goes to where it lives.
    await app.press("left", "enter");
    await app.until(/Logic · Logic\/AHU_01/);
    await app.until(/SatLoop\.\w+ .*kitControl:LoopPoint/);
    // What is set on the block rather than wired is under it too.
    assert.match(app.frame(), /loopAction direct · proportionalConstant 8 · integralConstant 0/);
  } finally {
    app.unmount();
    await own.close();
  }
});

test("L in the Explorer opens the wire sheet of what is selected, and a narrow pane follows the pick", async () => {
  const app = mount(client, { view: "explorer" }, { columns: 100, rows: 26 });
  try {
    await app.until(/Drivers/);
    await app.press("down", "down", "down");
    await app.until(/Station ─+ 4\/4/);
    await app.press("L");
    await app.until(/Logic · Logic ─/);
    await app.press("enter");
    const frame = await app.until(/Logic · Logic\/AHU_01/);
    await app.until(/LowLimit\.inA/);
    for (const line of frame.split("\n")) assert.ok(len(line) <= 100, line);
    // The sheet is wider than the pane: moving right brings the next block into it.
    await app.press("right", "right", "right");
    await app.until(/╭─ Occupied ─+╮/);
  } finally {
    app.unmount();
  }
  // A station with nothing wired opens at its root.
  const bare = await startStation({ site: "eastgate" });
  const empty = mount(bare.client, { view: "logic" }, { columns: 110, rows: 20 });
  try {
    await empty.until(/Logic · station ─+ 3 blocks · 0 links/);
    assert.match(empty.frame(), /╭─ ▸ Drivers ─*╮/);
  } finally {
    empty.unmount();
    await bare.close();
  }
});
