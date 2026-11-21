// bask model: on the simulated buildings with their tags taken away, inference finds the equipment
// kinds the tags named and what the points are for; the review file keeps what a person confirmed;
// and only confirmed entries reach the Haystack grid. Nothing is written to the station.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildReview, haystackGrid, inferModel, readEvidence } from "../dist/model.js";
import { nameScore, tokens } from "../dist/names.js";
import { startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bask-model-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NET = "slot:/Drivers/BacnetNetwork";

/** Takes the Haystack tags off a simulated station and returns what they were, by ORD. */
function untag(station) {
  const truth = new Map();
  for (const node of station.state.nodes.values()) {
    if (node.tags?.length) truth.set(node.ord, node.tags.map((tag) => tag.replace("hs:", "")));
    node.tags = [];
  }
  return truth;
}

/** Adds everything BACnet discovery finds, the way bask discover --add does: Eastgate starts empty. */
async function bringUp(client) {
  const addAll = async (target, parent) => {
    const found = await client.discover(target);
    const slots = (await client.job(found.job, { limit: 1000 })).results.map((r) => ({ slot: r.slot }));
    for (let at = 0; at < slots.length; at += 100) {
      const plan = await client.addDiscovered(found.job, slots.slice(at, at + 100), parent ? { parent } : {});
      await client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: randomUUID() });
    }
  };
  await addAll(NET, NET);
  for (const device of (await client.browse(NET, { depth: 1 })).children) await addAll(device.ord);
}

const lowest = (e) => Math.min(e.confidence, ...e.points.map((p) => p.confidence));

test("the name matcher splits names into words and spells out BAS abbreviations", () => {
  assert.deepEqual(tokens("SAT_Stpt"), ["supply", "air", "temp", "setpoint"]);
  assert.deepEqual(tokens("ZnTmp"), ["space", "temp"]);
  assert.deepEqual(tokens("DischargeAirTemp"), ["supply", "air", "temp"]);
  assert.deepEqual(tokens("VAVBox12"), ["vav", "box", "12"]);
  assert.equal(nameScore(tokens("ZnTmp"), "ZnTmp", tokens("ZoneTemp"), "ZoneTemp"), 1);
  assert.ok(nameScore(tokens("ZoneTemp"), "ZoneTemp", tokens("ZoneSetpoint"), "ZoneSetpoint") < 0.6);
  // Digits must agree: Fan1 is not Fan2.
  assert.equal(nameScore(tokens("Fan1"), "Fan1", tokens("Fan1"), "Fan1"), 1);
  assert.ok(nameScore(tokens("Fan1"), "Fan1", tokens("Fan2"), "Fan2") < 0.35);
});

test("with the tags taken away, the equipment kinds they named are found again from names and points", async () => {
  const kinds = {};
  for (const site of ["northgate", "riverside", "harbor", "summit"]) {
    const { station, client, close } = await startStation({ site });
    try {
      const truth = untag(station);
      const equipment = inferModel((await readEvidence(client, "slot:/")).evidence);
      assert.equal(equipment.length, truth.size, site);
      for (const e of equipment) {
        const [kind] = truth.get(e.ord).filter((tag) => tag !== "equip");
        // Equipment the station only called "equip" (a dock, a medical gas panel) has no kind to find.
        if (kind) assert.equal(e.kind, kind, `${site} ${e.name}: ${e.reason}`);
        assert.ok(e.confidence > 0 && e.confidence < 1 && e.reason.length > 10 && e.confirmed === false, `${e.name} ${e.confidence}`);
        for (const p of e.points) assert.ok(p.confidence >= 0 && p.confidence < 1 && p.reason.length > 5 && p.confirmed === false, `${e.name}/${p.name}`);
        (kinds[site] ??= new Set()).add(e.kind);
      }
      // Uncertain entries first.
      assert.deepEqual(equipment.map(lowest), equipment.map(lowest).sort((a, b) => a - b));
    } finally {
      await close();
    }
  }
  assert.deepEqual([...kinds.northgate].sort(), ["ahu", "chilledWaterPlant", "vav"]);
  assert.deepEqual([...kinds.riverside].sort(), ["ahu", "cooler", "hotWaterPlant", "room", "unknown"]);
  assert.deepEqual([...kinds.harbor].sort(), ["compressor", "cooler", "freezer", "meter", "room"]);
  assert.deepEqual([...kinds.summit].sort(), ["chiller", "crac", "generator", "pdu", "room", "ups"]);
});

test("Northgate, untagged: each kind's reason and each point's role", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    untag(station);
    const equipment = inferModel((await readEvidence(client, "slot:/")).evidence);
    const by = (name) => equipment.find((e) => e.name === name);
    const roles = (name) => Object.fromEntries(by(name).points.map((p) => [p.name, p.role]));
    assert.equal(by("AHU_01").label, "air handler");
    assert.match(by("AHU_01").reason, /name says ahu; has supply air temperature, mixed air temperature, supply fan speed command; 1 sibling agrees/);
    assert.match(by("VAV_103").reason, /name says vav; has zone temperature, damper command; 7 siblings agree/);
    assert.ok(by("VAV_103").confidence > by("AHU_01").confidence, "more siblings, more confidence");
    assert.deepEqual(roles("AHU_01"), {
      SupplyAirTemp: "supplyAirTemp", ReturnAirTemp: "returnAirTemp", MixedAirTemp: "mixedAirTemp", OutdoorAirTemp: "outsideAirTemp", SupplyAirSetpoint: "supplyAirTempSp", SupplyFanSpeed: "supplyFanSpeed",
      SupplyFanStatus: "supplyFanStatus", DuctStaticPressure: "supplyAirPressure", CoolingValve: "coolingValve", FilterDP: "filterDp", OccupiedCmd: "occupancyCmd"
    });
    assert.deepEqual(roles("VAV_101"), { ZoneTemp: "zoneTemp", ZoneSetpoint: "zoneTempSp", Airflow: "airflow", DamperPosition: "damper", ReheatValve: "reheatValve", OccupancyMode: "occupancyCmd" });
    assert.deepEqual(roles("CHW_Plant"), { ChwSupplyTemp: "chwSupplyTemp", ChwReturnTemp: "chwReturnTemp", ChwFlow: "chwFlow", ChwSupplySetpoint: "chwSupplyTempSp", ChwPump1Speed: "pumpSpeed", Chiller1Status: "runStatus", Chiller2Status: "runStatus", PlantEnable: "enableCmd" });
    const sat = by("AHU_01").points.find((p) => p.name === "SupplyAirTemp");
    assert.match(sat.reason, /name 1\.00, units °F, read-only, same on 1 sibling/);
    assert.deepEqual(sat.tags, ["discharge", "air", "temp", "sensor", "point"]);
    assert.deepEqual([sat.unit, sat.valueKind], ["°F", "Number"]);
    // The logic blocks under slot:/Logic read like points but are not equipment.
    assert.ok(!equipment.some((e) => e.ord.startsWith("slot:/Logic")));
  } finally {
    await close();
  }
});

test("Eastgate, discovered and untagged: all 46 controllers are named for what they are", async () => {
  const { station, client, close } = await startStation({ site: "eastgate" });
  try {
    await bringUp(client);
    const truth = untag(station);
    assert.equal(truth.size, 46);
    const equipment = inferModel((await readEvidence(client, "slot:/")).evidence);
    assert.equal(equipment.length, 46);
    for (const e of equipment) assert.equal(e.kind, truth.get(e.ord).find((tag) => tag !== "equip"), `${e.name}: ${e.reason}`);
    const counts = {};
    for (const e of equipment) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    assert.deepEqual(counts, { chilledWaterPlant: 1, hotWaterPlant: 1, chiller: 2, boiler: 2, pump: 4, ahu: 4, vav: 32 });
    const vav = equipment.find((e) => e.name === "VAV_12");
    assert.match(vav.reason, /31 siblings agree/);
    const roles = Object.fromEntries(vav.points.map((p) => [p.name, p.role]));
    assert.equal(roles.Space_Temp, "zoneTemp");
    assert.equal(roles.Damper_Command, "damper");
    assert.equal(roles.Occupied_Cooling_Setpoint, "zoneCoolingSp");
    assert.equal(roles.Reheat_Valve_Command, "reheatValve");
    // A short abbreviation says less than a word: B_01 is a boiler, with less confidence than AHU_01 an air handler.
    const boiler = equipment.find((e) => e.name === "B_01");
    assert.match(boiler.reason, /name says b \(0\.5\); has leaving water temperature, entering water temperature, load/);
    assert.ok(boiler.confidence < equipment.find((e) => e.name === "AHU_01").confidence);
  } finally {
    await close();
  }
});

test("thirty VAV boxes named three different ways are all found, with their zone temperatures", () => {
  const styles = [
    (i) => ({ name: `VAV-${i}`, points: [["ZN-T", "°F", false], ["ZN-SP", "°F", true], ["DMPR-POS", "%", true], ["CFM", "cfm", false], ["RHT-VLV", "%", true]] }),
    (i) => ({ name: `Vav_${i}`, points: [["SpaceTemp", "°F", false], ["SpaceTempSetpoint", "°F", true], ["DamperCmd", "%", true], ["Airflow", "cfm", false]] }),
    (i) => ({ name: `VAVBox${i}`, points: [["RmTemp", "°F", false], ["RmStpt", "°F", true], ["DprPos", "%", true], ["AirFlow", "cfm", false]] })
  ];
  const evidence = Array.from({ length: 30 }, (_v, k) => {
    const { name, points } = styles[k % 3](k + 1);
    const ord = `slot:/Drivers/Net/${name}`;
    return { ord, name, typeSpec: "bacnet:BacnetDevice", tags: [], points: points.map(([point, units, writable]) => ({ ord: `${ord}/points/${point}`, name: point, typeSpec: writable ? "control:NumericWritable" : "control:NumericPoint", writable, units, valueType: "numeric", tags: [] })) };
  });
  const equipment = inferModel(evidence);
  assert.equal(equipment.length, 30);
  for (const e of equipment) {
    assert.equal(e.kind, "vav", `${e.name}: ${e.reason}`);
    assert.match(e.reason, /9 siblings agree/);
    const roles = e.points.map((p) => p.role).sort();
    assert.deepEqual(roles.filter((role) => ["zoneTemp", "zoneTempSp", "damper", "airflow"].includes(role)), ["airflow", "damper", "zoneTemp", "zoneTempSp"], `${e.name}: ${e.points.map((p) => `${p.name}=${p.role}`).join(" ")}`);
  }
});

test("tags already on the station are taken as they are; the review file keeps what a person confirmed", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const tagged = inferModel((await readEvidence(client, "slot:/")).evidence);
    const ahu = tagged.find((e) => e.name === "AHU_01");
    assert.deepEqual([ahu.kind, ahu.confidence, ahu.confirmed, ahu.reason], ["ahu", 1, true, "already tagged hs:ahu, hs:equip"]);

    untag(station);
    const infer = async () => inferModel((await readEvidence(client, "slot:/")).evidence);
    const first = buildReview("Northgate", "slot:/", await infer());
    assert.deepEqual([first.format, first.version, first.station], ["bask-model", 1, "Northgate"]);
    assert.match(first.howTo, /"confirmed": true/);
    assert.ok(first.equipment.every((e) => !e.confirmed && e.points.every((p) => !p.confirmed)));
    // A person corrects one entry and confirms two; a second run keeps exactly that.
    const edited = structuredClone(first);
    const plant = edited.equipment.find((e) => e.name === "CHW_Plant");
    Object.assign(plant, { kind: "plant", label: "central plant", tags: ["chilled", "plant", "equip"], confirmed: true });
    Object.assign(plant.points.find((p) => p.name === "ChwFlow"), { confirmed: true });
    const second = buildReview("Northgate", "slot:/", await infer(), edited);
    const kept = second.equipment.find((e) => e.name === "CHW_Plant");
    assert.deepEqual([kept.kind, kept.label, kept.tags, kept.confirmed], ["plant", "central plant", ["chilled", "plant", "equip"], true]);
    assert.deepEqual(kept.points.filter((p) => p.confirmed).map((p) => p.name), ["ChwFlow"]);
    assert.equal(second.equipment.filter((e) => e.confirmed).length, 1);

    // Only confirmed entries reach the grid; a marker is "m:", a ref "r:", a string "s:".
    assert.deepEqual(haystackGrid(first).rows, []);
    const grid = haystackGrid(second);
    assert.deepEqual(grid.meta, { ver: "3.0", dis: "s:Northgate" });
    assert.deepEqual(grid.rows, [
      { id: "r:Drivers.BacnetNetwork.CHW_Plant CHW_Plant", dis: "s:CHW_Plant", equip: "m:", chilled: "m:", plant: "m:", axSlotPath: `s:${NET}/CHW_Plant` },
      {
        id: "r:Drivers.BacnetNetwork.CHW_Plant.points.ChwFlow CHW_Plant ChwFlow", dis: "s:CHW_Plant ChwFlow", point: "m:", chilled: "m:", water: "m:", flow: "m:", sensor: "m:",
        equipRef: "r:Drivers.BacnetNetwork.CHW_Plant CHW_Plant", kind: "s:Number", unit: "s:gpm", axSlotPath: `s:${NET}/CHW_Plant/points/ChwFlow`
      }
    ]);
    assert.deepEqual(grid.cols.map((c) => c.name), ["id", "dis", "equip", "chilled", "plant", "axSlotPath", "point", "water", "flow", "sensor", "equipRef", "kind", "unit"]);
  } finally {
    await close();
  }
});

test("from the command line: infer writes the review file, a second run keeps what was confirmed, export writes the grid", async () => {
  const { station, close } = await startStation({ site: "northgate" });
  const env = { ...process.env, BASKSTREAM_CONFIG_DIR: dir, BASKSTREAM_PASSWORD: station.password, FORCE_COLOR: "0" };
  const bask = (...args) => run(process.execPath, [main, ...args], { env, cwd: dir, maxBuffer: 16 * 1024 * 1024 }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));
  try {
    untag(station);
    assert.equal((await bask("login", station.url, "-u", station.user, "--name", "model")).code, 0);
    const before = { audit: station.state.audit.length, writes: station.state.counters.writes, files: station.state.files.size };
    // No --allow-writes: infer only reads.
    const shown = await bask("model", "infer", "--under", "Drivers/BacnetNetwork");
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Northgate {2}slot:\/Drivers\/BacnetNetwork · 11 equipment, 78 points/);
    assert.match(shown.out, /0\.\d\d +BacnetNetwork\/VAV_101 +VAV box +name says vav; has zone temperature, damper command; 7 siblings agree · 6 points/);
    assert.match(shown.err, /✓ Northgate-model\.json\. Edit it/);
    const file = join(dir, "Northgate-model.json");
    const review = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(review.equipment.length, 11);

    // The default file name, or --out; -o json prints what the file holds.
    const out = join(dir, "reviews", "ng.json");
    const json = await bask("model", "infer", "--out", out, "-o", "json");
    assert.equal(json.code, 0, json.err);
    assert.equal(json.out, readFileSync(out, "utf8"));

    const nothing = await bask("model", "export", file, "--format", "haystack");
    assert.equal(nothing.code, 0);
    assert.deepEqual(JSON.parse(nothing.out).rows, []);
    assert.match(nothing.err, /Nothing in .* is confirmed yet/);

    // A person confirms every VAV box and its zone temperature.
    for (const e of review.equipment.filter((e) => e.kind === "vav")) {
      e.confirmed = true;
      e.points.find((p) => p.role === "zoneTemp").confirmed = true;
    }
    writeFileSync(file, JSON.stringify(review, null, 2));
    const again = await bask("model", "infer", "--under", "Drivers/BacnetNetwork");
    assert.match(again.err, /updated; what was confirmed in it is kept/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).equipment.filter((e) => e.confirmed).length, 8);

    const exported = await bask("model", "export", file, "--format", "haystack");
    assert.equal(exported.code, 0, exported.err);
    const grid = JSON.parse(exported.out);
    assert.equal(grid.rows.length, 16);
    assert.deepEqual(grid.rows.filter((row) => row.equip).map((row) => row.dis), [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `s:VAV_10${i}`));
    assert.ok(grid.rows.filter((row) => row.point).every((row) => row.zone === "m:" && row.temp === "m:" && row.sensor === "m:" && /^r:Drivers\.BacnetNetwork\.VAV_10\d VAV_10\d$/.test(row.equipRef)));

    assert.equal((await bask("model", "export", file, "--format", "owl")).code, 1);
    writeFileSync(join(dir, "plan.json"), '{"changes": []}');
    const wrong = await bask("model", "export", join(dir, "plan.json"));
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /is not a bask model review file/);
    // Nothing was written to the station.
    assert.deepEqual({ audit: station.state.audit.length, writes: station.state.counters.writes, files: station.state.files.size }, before);
  } finally {
    await close();
  }
});
