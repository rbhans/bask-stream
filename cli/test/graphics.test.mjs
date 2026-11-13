// Graphics: the document an agent writes, its layout and pipe routing, how values drive it, the
// demo buildings' own graphics, the `bask graphic` commands and the Graphics view.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEMO_GRAPHICS } from "../dist/demo/graphics.js";
import { GRAPHICS_FOLDER, graphicName, graphicPath, listGraphics, loadGraphic } from "../dist/graphics.js";
import { Link } from "../dist/link.js";
import { checkGraphic, drawGraphic, graphicGuide, isSection, partNow, planGraphic, readGraphic, resolvePoint, roomNeeded } from "../dist/tui/symbols/graphic.js";
import { SYMBOLS } from "../dist/tui/symbols/library.js";
import { mount, settle, startStation } from "./harness.mjs";

const len = (text) => [...text].length;
const BASE = "slot:/Drivers/BacnetNetwork/AHU_01/points";
const ahu = () => ({
  title: "AHU-1",
  base: BASE,
  rows: [{
    air: [
      { symbol: "louver" },
      { symbol: "damper", label: "OA damper", value: "OaDamper" },
      { symbol: "cooling-coil", label: "Cooling", value: "CoolingValve" },
      { symbol: "fan", label: "Supply fan", value: "SupplyFanSpeed", on: "SupplyFanStatus" },
      { symbol: "sensor", label: "Supply air", text: "T", reading: "SupplyAirTemp" }
    ],
    from: { label: "OA", reading: "OutdoorAirTemp" },
    to: "SA"
  }]
});
const plant = () => ({
  rows: [{
    parts: [
      { id: "tower", symbol: "cooling-tower", label: "Tower", value: 60 },
      [{ id: "ch1", symbol: "chiller", label: "Chiller 1", value: 70 }, { id: "ch2", symbol: "chiller", label: "Chiller 2", value: 0 }],
      { id: "p1", symbol: "pump", label: "Pump", value: 65 },
      [{ id: "supply", label: "CHW supply", note: "44.1 °F", medium: "chw" }, { id: "return", label: "CHW return", note: "54.6 °F", medium: "chw" }]
    ]
  }],
  pipes: [
    { from: "tower.out", to: "ch1.cwIn", medium: "cw" },
    { from: "ch1.cwOut", to: "tower.in", medium: "cw" },
    { from: "ch1.chwOut", to: "p1.in", medium: "chw" },
    { from: "ch2.chwOut", to: "p1.in", medium: "chw" },
    { from: "p1", to: "supply", medium: "chw" },
    { from: "return", to: "ch1.chwIn", medium: "chw" },
    { from: "return", to: "ch2.chwIn", medium: "chw" }
  ]
});
const point = (value, displayValue, state = "ok") => ({ ok: true, value, displayValue, state });
const values = (map) => (ord) => map[ord.slice(BASE.length + 1)];

test("a document's mistakes are found, each with where it is and what to do", () => {
  const errors = (doc) => checkGraphic(doc).problems.filter((p) => p.level === "error").map((p) => `${p.at}: ${p.message}`).join("\n");
  assert.match(errors("nope"), /JSON object/);
  assert.match(errors({}), /rows: A graphic needs "rows"/);
  assert.match(errors({ rows: [{ air: [{ symbol: "coolng-coil" }] }] }), /rows\[0\]\.air\[0\]\.symbol: No symbol "coolng-coil"\. Did you mean "cooling-coil"\?/);
  assert.match(errors({ rows: [{ air: [{ symbol: "chiller" }] }] }), /"chiller" stands on its own: put it in a "parts" row/);
  assert.match(errors({ rows: [{ parts: [{ symbol: "fan" }] }] }), /"fan" is an air-handler section: put it in an "air" row/);
  assert.match(errors({ rows: [{ parts: [{ symbol: "pump", value: "Speed" }] }] }), /rows\[0\]\.parts\[0\]\.value: "Speed" is a relative point path, and the graphic has no "base"/);
  assert.match(errors({ rows: [{ parts: [{ id: "a", symbol: "pump" }, { id: "a", symbol: "pump" }] }] }), /The id "a" is already used at rows\[0\]\.parts\[0\]/);
  assert.match(errors({ rows: [{ parts: [{ symbol: "pump", value: { point: "slot:/a", min: 5, max: 5 } }] }] }), /min and max are the same/);
  assert.match(errors({ rows: [{ parts: [{ symbol: "pump", medium: "beer" }] }] }), /No medium "beer"/);
  assert.match(errors({ rows: [{ parts: [{}] }] }), /A part with no symbol is a text tag and needs a label/);
  assert.match(errors({ rows: [{ parts: [{ symbol: "pump" }], air: [{ symbol: "fan" }] }] }), /A row is \{"air"/);
  assert.match(errors({ rows: [{ parts: [{ symbol: "pump" }] }], pipes: [{ from: "a" }] }), /pipes\[0\]\.to: "to" names a part and a port/);

  // A misspelt key is only a warning, and says what was meant; the document still draws.
  const typo = checkGraphic({ rows: [{ parts: [{ symbol: "pump", lable: "P1" }] }] });
  assert.ok(typo.doc);
  assert.match(typo.problems[0].message, /Unknown key "lable"\. Did you mean "label"\?/);

  // Pipes to things that are not there are found when it is laid out.
  const lost = readGraphic({ rows: [{ parts: [{ id: "p1", symbol: "pump" }, { id: "t1", symbol: "tank" }] }], pipes: [{ from: "p2.out", to: "t1.in" }, { from: "p1.outlet", to: "t1" }] });
  assert.match(lost.problems[0].message, /No part has the id "p2"\. Did you mean "p1"\?/);
  assert.match(lost.problems[1].message, /"p1" \(pump\) has no port "outlet"\. It has: left, right, top, bottom, in, out/);
  assert.equal(checkGraphic(ahu()).problems.length, 0);
  assert.equal(resolvePoint("Fan", "station:|slot:/A/points/"), "slot:/A/points/Fan");
  assert.equal(resolvePoint("station:|slot:/B/C"), "slot:/B/C");
});

test("an air row joins its sections into one casing, with air between them and piping under a coil", () => {
  const plan = planGraphic(ahu());
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.points.sort(), ["CoolingValve", "OaDamper", "OutdoorAirTemp", "SupplyAirTemp", "SupplyFanSpeed", "SupplyFanStatus"].map((p) => `${BASE}/${p}`).sort());
  const now = values({ OaDamper: point(40, "40 %"), CoolingValve: point(55, "55 %"), SupplyFanSpeed: point(72, "72 %"), SupplyFanStatus: point(true, "On"), SupplyAirTemp: point(55.4, "55.4 °F"), OutdoorAirTemp: point(78.9, "78.9 °F") });
  const text = drawGraphic(plan, now, 0).toString();
  const rows = text.split("\n");
  assert.equal(rows.length, plan.height);
  for (const row of rows) assert.ok(len(row) <= plan.width, row);
  assert.match(text, /OA damper\s+Cooling\s+Supply fan\s+Supply air/);
  assert.match(text, /40 %\s+55 %\s+72 %\s+55\.4 °F/);
  assert.match(text, /╭─+╮\nOA\s+│≡≡/);
  assert.match(text, /78\.9 °F │≡≡/);
  assert.match(text, /─┬──┬─/);
  assert.match(text, /▽\n.*△/);
  assert.match(text, /\n\s+CHW$/);
  // The fan turns and the air moves while it runs, and both stop with it.
  assert.notEqual(drawGraphic(plan, now, 3).toString(), text);
  const stopped = values({ SupplyFanSpeed: point(0, "0 %"), SupplyFanStatus: point(false, "Off"), CoolingValve: point(0, "0 %") });
  assert.equal(drawGraphic(plan, stopped, 3).toString(), drawGraphic(plan, stopped, 0).toString());
  assert.match(drawGraphic(plan, stopped, 0).toString(), /▼\n.*▲/);

  // A coil that pipes reach is left to them: no piping of its own under it.
  const piped = ahu();
  piped.rows[0].air[2].id = "cc";
  piped.rows.push({ parts: [{ id: "chws", label: "CHWS" }, { id: "chwr", label: "CHWR" }] });
  piped.pipes = [{ from: "chws", to: "cc.supply", medium: "chw" }, { from: "cc.return", to: "chwr", medium: "chw" }];
  const pipedPlan = planGraphic(piped);
  assert.deepEqual(pipedPlan.problems, []);
  assert.doesNotMatch(drawGraphic(pipedPlan, now, 0).toString(), /\n\s+CHW\n/);
});

test("pipes find their own way: straight where they can, round the equipment, branching from a shared port", () => {
  const plan = planGraphic(plant());
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.routes.length, 7);
  // No pipe runs through a part or its name.
  const boxes = plan.parts.flatMap((p) => [p.box, ...(p.label ? [{ x: p.label.x - Math.floor(p.label.width / 2), y: p.label.y, w: p.label.width, h: p.label.reading && p.doc.label ? 2 : 1 }] : [])]);
  for (const route of plan.routes) for (let i = 0; i < route.points.length - 1; i += 1) {
    const [[x0, y0], [x1, y1]] = [route.points[i], route.points[i + 1]];
    assert.ok(x0 === x1 || y0 === y1, "legs are straight");
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
      // A cooling tower's ports sit in the blank corners of its own box.
      const hit = boxes.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      assert.ok(!hit || (hit.w === 9 && hit.h === 6), `${route.doc.from} to ${route.doc.to} crosses a part at ${x},${y}`);
    }
  }
  // The pump stands level with the chiller outlet it is fed from, so that pipe is straight.
  assert.equal(plan.routes[3].points.length, 2);
  const text = drawGraphic(plan, () => undefined, 0).toString();
  assert.match(text, /├─+[▸─┴]*─┤[◐◓◑◒]├/);
  assert.match(text, /CHW supply\n.*44\.1 °F/);
  // The two returns leave the tag as one pipe and split: a tee, not two lines side by side.
  assert.match(text, /[├┬┴┤]/);
  // Shared stretches carry one set of marks, never two in neighbouring cells.
  for (let frame = 0; frame < 8; frame += 1) assert.doesNotMatch(drawGraphic(plan, () => undefined, frame).toString(), /▸▸|◂◂/);
  // The margins kept for pipes are cut off again where none went.
  assert.ok(drawGraphic(plan, () => undefined, 0).toString().split("\n").every((row, y, all) => y > 0 || row.trim().length > 0));
  assert.ok(plan.width < 90, `plant is ${plan.width} wide`);

  // Two boxes with nothing between them: the pipe is a straight line from port to port.
  const straight = planGraphic({ rows: [{ parts: [{ id: "a", symbol: "pump" }, { id: "b", symbol: "pump" }] }], pipes: [{ from: "a", to: "b" }] });
  assert.equal(drawGraphic(straight, () => undefined, 0, {}).toString(), "╭─╮      ╭─╮\n┤◐├─▸────┤◐├\n╰─╯      ╰─╯");
});

test("the points drive it: values, running, status, readings, scaling", () => {
  const doc = { base: BASE, rows: [{ parts: [
    { id: "p", symbol: "pump", label: "Pump", value: "Speed" },
    { symbol: "tank", label: "Tank", value: { point: "Level", min: 0, max: 20 } },
    { symbol: "plate", label: "Zone", reading: "ZoneTemp" },
    { symbol: "cold-room", label: "Freezer", reading: "BoxTemp", open: "Door" },
    { symbol: "valve", label: "Valve", value: "Missing" }
  ] }] };
  const plan = planGraphic(doc);
  const [pump, tank, plate, room, valve] = plan.parts;
  const now = values({ Speed: point(65, "65 %"), Level: point(5, "5.0 ft"), ZoneTemp: point(78.6, "78.6 °F", "alarm"), BoxTemp: point(-9.4, "-9.4 °F", "overridden"), Door: point(true, "Open"), Missing: { ok: false } });
  assert.deepEqual(partNow(pump, now), { state: { value: 65, aux: undefined, on: true, open: undefined, status: undefined, medium: undefined, text: undefined, title: "Pump", width: undefined }, reading: "65 %" });
  assert.equal(partNow(pump, values({ Speed: point(0, "0 %") })).state.on, false);
  assert.equal(partNow(tank, now).state.value, 25);
  assert.equal(partNow(tank, now).reading, "5.0 ft");
  assert.equal(partNow(plate, now).state.status, "alarm");
  assert.match(partNow(plate, now).state.text, /^78\.6 °F\s*$/);
  assert.equal(partNow(room, now).state.status, "overridden");
  assert.equal(partNow(room, now).state.open, true);
  assert.equal(partNow(room, now).state.text, "-9.4 °F");
  assert.equal(partNow(valve, now).reading, "?");
  assert.equal(partNow(valve, now).state.status, "stale");
  assert.equal(partNow(pump, () => undefined).reading, "…");
  const text = drawGraphic(plan, now, 0).toString();
  assert.match(text, /╭─ Zone ─+╮/);
  assert.match(text, /│ -9\.4 °F │/);
  assert.match(text, /╰──╱ {3}───╯/);

  // A reading longer than the room kept for it gets the room, once: nothing is cut short and nothing moves again.
  const long = values({ Speed: point(65, "65.25 percent of full speed") });
  assert.match(drawGraphic(plan, long, 0).toString(), /65\.25 p…/);
  const room1 = roomNeeded(plan, long);
  assert.deepEqual(room1, { "rows[0].parts[0]": 27 });
  const wider = planGraphic(doc, room1);
  assert.match(drawGraphic(wider, long, 0).toString(), /65\.25 percent of full speed/);
  assert.equal(roomNeeded(wider, long), undefined);
  assert.equal(roomNeeded(wider, now), undefined);
});

test("every symbol can be used, and the guide lists them all with their ports", () => {
  const guide = graphicGuide();
  for (const def of SYMBOLS) {
    assert.match(guide, new RegExp(`\\| ${def.id} \\|`), def.id);
    const row = isSection(def) ? { air: [{ symbol: def.id, label: "Name", value: 50 }] } : { parts: [{ id: "x", symbol: def.id, label: "Name", value: 50 }] };
    const read = readGraphic({ rows: [row] });
    assert.deepEqual(read.problems, [], def.id);
    const text = drawGraphic(read.plan, () => undefined, 2).toString();
    assert.ok(text.split("\n").length === read.plan.height, def.id);
  }
  // Each port says which side it is on, so parts can be placed where their pipes run straight.
  assert.match(guide, /\| chiller \| 14 x 5 \| load \| cwOut \(right, upper\), cwIn \(left, upper\), chwOut \(right, lower\), chwIn \(left, lower\) \|/);
  assert.match(guide, /\| cooling-coil \| 6 x 5 \| valve position \| supply \(bottom, left\), return \(bottom, right\) \|/);
  assert.match(guide, /\| boiler \| 9 x 5 \| firing rate \| supply \(bottom, left\), return \(bottom, right\) \|/);
  assert.match(guide, /\| pump \| 3 x 3 \| speed \| in \(left\), out \(right\) \|/);
  assert.match(guide, /bask graphic print/);
  // The examples in the guide are real: they check and lay out without a problem.
  const blocks = [...guide.matchAll(/```json\n(\{[\s\S]*?\n\})\n```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(blocks.length, 2);
  for (const doc of blocks) assert.deepEqual(readGraphic(doc).problems, []);
});

// ---- Against the demo buildings -------------------------------------------------------------------

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const configDir = mkdtempSync(join(tmpdir(), "bask-graphics-"));
process.env.BASKSTREAM_CONFIG_DIR = configDir;
let station;
let client;
let closeStation;
const bask = (...args) =>
  run(process.execPath, [main, ...args], { env: { ...process.env, BASKSTREAM_CONFIG_DIR: configDir, BASKSTREAM_PASSWORD: station.password, FORCE_COLOR: "0" } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e) => ({ code: e.code, out: e.stdout + e.stderr })
  );
before(async () => {
  ({ station, client, close: closeStation } = await startStation());
  assert.equal((await bask("login", station.url, "-u", station.user, "--name", "demo")).code, 0);
});
after(async () => {
  await closeStation();
  rmSync(configDir, { recursive: true, force: true });
});

test("each demo building's graphics draw without a problem, from points that exist, and fit a pane", async () => {
  for (const [site, docs] of Object.entries(DEMO_GRAPHICS)) {
    const { station: building, client: reader, close } = site === "northgate" ? { station, client, close: async () => {} } : await startStation({ site });
    try {
      assert.deepEqual((await listGraphics(reader)).map((g) => g.name), Object.keys(docs).sort(), site);
      for (const name of Object.keys(docs)) {
        const read = readGraphic(await loadGraphic(reader, name));
        assert.deepEqual(read.problems, [], `${site}/${name}`);
        const snapshots = await reader.read(read.plan.points);
        assert.deepEqual(snapshots.filter((s) => !s.ok).map((s) => s.point), [], `${site}/${name} reads points that exist`);
        const now = new Map(snapshots.map((s) => [s.point, s]));
        const plan = planGraphic(read.plan.doc, roomNeeded(read.plan, (ord) => now.get(ord)) ?? {});
        assert.deepEqual(plan.problems, [], `${site}/${name}`);
        assert.ok(plan.width <= 100 && plan.height <= 26, `${site}/${name} is ${plan.width} x ${plan.height}`);
        assert.doesNotMatch(drawGraphic(plan, (ord) => now.get(ord), 0).toString(), /…|\?/, `${site}/${name} cuts nothing short`);
      }
      assert.ok(building.url);
    } finally {
      await close();
    }
  }
});

test("bask graphic: guide, print, save, list, get, show and rm", async () => {
  const guide = await bask("graphic", "guide");
  assert.equal(guide.code, 0);
  assert.match(guide.out, /# Drawing a graphic for bask/);

  // A saved graphic prints as text with the station's values.
  const saved = await bask("graphic", "print", "chw-plant");
  assert.equal(saved.code, 0, saved.out);
  assert.match(saved.out, /Chiller 1/);
  assert.match(saved.out, /CHW supply\n.*4[345]\.\d °F/);
  assert.match(saved.out, /Chilled water plant · \d+ x \d+ cells · 6 points/);

  // A file with a mistake says where, and is not saved.
  const file = join(configDir, "zone-105.json");
  const doc = { title: "VAV 105", base: "slot:/Drivers/BacnetNetwork/VAV_105/points", rows: [{ parts: [{ symbol: "vav", label: "VAV 105", value: "DamperPosition", aux: "ReheatValve", reading: "ZoneTemp" }, { symbol: "thermometr", label: "Zone", value: { point: "ZoneTemp", min: 60, max: 90 } }] }] };
  writeFileSync(file, JSON.stringify(doc));
  const wrong = await bask("graphic", "print", file, "--offline");
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /error\s+rows\[0\]\.parts\[1\]\.symbol: No symbol "thermometr"\. Did you mean "thermometer"\?/);
  const refused = await bask("graphic", "save", file, "--allow-writes", "-y");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /Not saved: fix the error above/);

  // Fixed, with one point that does not exist: it prints, and says which point.
  doc.rows[0].parts[1].symbol = "thermometer";
  doc.rows[0].parts.push({ symbol: "gauge", label: "Flow", value: "AirflowSetpoint" });
  writeFileSync(file, JSON.stringify(doc));
  const printed = await bask("graphic", "print", file);
  assert.equal(printed.code, 0, printed.out);
  assert.match(printed.out, /VAV 105\s+Zone\s+Flow/);
  assert.match(printed.out, /78\.\d °F/);
  assert.match(printed.out, /warning\s+slot:\/Drivers\/BacnetNetwork\/VAV_105\/points\/AirflowSetpoint could not be read/);
  const asJson = JSON.parse((await bask("graphic", "print", file, "-o", "json")).out);
  assert.equal(asJson.drawn, true);
  assert.equal(asJson.points.find((p) => p.point.endsWith("AirflowSetpoint")).ok, false);
  assert.ok(asJson.text.includes("VAV 105"));

  // Saving needs --allow-writes, stores it in the station's files and tells open windows to show it.
  doc.rows[0].parts[2].value = "Airflow";
  writeFileSync(file, JSON.stringify(doc));
  assert.match((await bask("graphic", "save", file)).out, /--allow-writes/);
  const save = await bask("graphic", "save", file, "--allow-writes", "-y", "--reason", "Zone 105 runs hot");
  assert.equal(save.code, 0, save.out);
  assert.match(save.out, /✓ Saved zone-105 at \^bask\/graphics\/zone-105\.json \(4 points\)/);
  assert.equal(station.state.files.has("^bask/graphics/zone-105.json"), true);
  assert.deepEqual(new Link(station.url).get().show, { n: 1, kind: "graphic", ord: "zone-105", from: new Link(station.url).get().show.from });
  assert.match((await bask("graphic", "save", file, "--allow-writes", "-y", "--name", "Zone 105")).out, /✓ Replaced zone-105/);

  const list = await bask("graphic", "list");
  assert.match(list.out, /ahu-01\s+\^bask\/graphics\/ahu-01\.json/);
  assert.match(list.out, /zone-105/);
  assert.deepEqual(JSON.parse((await bask("graphic", "get", "zone-105")).out), doc);
  assert.match((await bask("graphic", "show", "ahu-01")).out, /ahu-01/);
  const removed = await bask("graphic", "rm", "zone-105", "--allow-writes", "-y");
  assert.equal(removed.code, 0, removed.out);
  assert.equal(station.state.files.has("^bask/graphics/zone-105.json"), false);

  assert.equal(graphicName("AHU 01.json"), "ahu-01");
  assert.equal(graphicPath("Chw Plant"), `${GRAPHICS_FOLDER}/chw-plant.json`);
  assert.throws(() => graphicName("///"), /does not make a graphic name/);
  assert.match((await bask("agent-brief")).out, /bask graphic guide/);
});

test("the Graphics view lists the station's graphics, draws the picked one live, and acts on a part's point", async () => {
  const app = mount(client, { view: "graphics" }, { columns: 130, rows: 36 });
  try {
    const frame = await app.until(/AHU-1 and its zones/);
    assert.match(frame, /Graphics ─+ 12/);
    assert.match(frame, /ahu-01/);
    assert.match(frame, /chw-plant/);
    await app.until(/Supply fan/);
    const drawn = await app.until(/\d\d\.\d °F\s+\d\d\.\d %\s+\d\d\.\d %/);
    assert.match(drawn, /VAV 101\s+VAV 102\s+VAV 103\s+VAV 104/);
    assert.match(drawn, /OA\s+│≡≡/);
    // The picked part and its points, under the drawing.
    assert.match(drawn, /Filter\s+FilterDP 0\.\d+ inH₂O/);
    await app.press("right", "right", "right");
    await app.until(/Supply fan\s+SupplyFanSpeed \d+\.\d %\s+·\s+SupplyFanStatus On/);
    // It moves.
    const before = app.frame();
    await settle(400);
    assert.notEqual(app.frame(), before);
    await app.press("space");
    await app.until(/paused/);
    // Down the list to the plant; enter shows the picked part's point in the Explorer.
    await app.press("down", "down", "down");
    const plantFrame = await app.until(/Chilled water plant/);
    assert.match(plantFrame, /CHW supply/);
    await app.until(/Chiller 1\s+Chiller1Status Running/);
    await app.press("enter");
    await app.until(/Explorer/);
    await app.until(/Chiller1Status/);
  } finally {
    app.unmount();
  }
});

test("g opens Graphics, a narrow pane shows just the drawing, and a show request picks a graphic", async () => {
  const app = mount(client, {}, { columns: 84, rows: 30 });
  try {
    await app.until(/Northgate/);
    await app.press("g");
    const frame = await app.until(/AHU-1 and its zones/);
    assert.match(frame, /1 of 12/);
    for (const line of frame.split("\n")) assert.ok(len(line) <= 84, line);
    await app.press("down", "down", "down");
    await app.until(/Chilled water plant ─+ 4 of 12/);
  } finally {
    app.unmount();
  }
  // `bask graphic save` and `bask graphic show` ask open windows to show a graphic: one on another view switches to it.
  const link = new Link(station.url, false);
  const asked = mount(client, { view: "alarms", link }, { columns: 120, rows: 30 });
  try {
    await asked.until(/Alarms/);
    link.update((s) => void (s.show = { n: (s.show?.n ?? 0) + 1, kind: "graphic", ord: "chw-plant", from: 1 }));
    await asked.until(/Chilled water plant/);
    await asked.until(/CHW supply/);
  } finally {
    asked.unmount();
  }
  // Harbor starts with nothing drawn.
  const empty = await startStation({ site: "harbor" });
  const bare = mount(empty.client, { view: "graphics" }, { columns: 110, rows: 24 });
  try {
    const frame = await bare.until(/No graphics on this station yet/);
    assert.match(frame, /bask graphic guide/);
  } finally {
    bare.unmount();
    await empty.close();
  }
});
