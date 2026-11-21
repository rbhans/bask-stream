// The rest of bask model (docs/ROADMAP.md, F): a control point is never equipment and a proxy
// extension is never a point; what serves what is proposed from links, names and folders, marked as
// inferred; confirmed entries are written as tags and relations, and an unconfirmed guess never is;
// and the confirmed entries export as Brick.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildReview, haystackGrid, inferModel, inferServes, readEquipmentLinks, readEvidence } from "../dist/model.js";
import { BRICK_CLASSES, brickTurtle, planModelWrite, runModelWrite } from "../dist/model-write.js";
import { startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bask-model-more-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NET = "slot:/Drivers/BacnetNetwork";
const untag = (station) => void [...station.state.nodes.values()].forEach((node) => void (node.tags = []));

/** Everything read and inferred for a station: the review file bask model infer would write. */
async function review(client, earlier) {
  const { evidence } = await readEvidence(client, "slot:/");
  const equipment = inferModel(evidence);
  return buildReview(String(client.capabilities.station), "slot:/", equipment, earlier, inferServes(equipment, (await readEquipmentLinks(client, evidence)).links, evidence));
}

test("a lone control point is never equipment, and its proxy extension is never a point", async () => {
  // A station with almost no equipment, as the real Demo station is: one point in a folder, whose
  // proxy extension browse lists under it and calls a point too, and a second one with a history extension.
  const { station, client, close } = await startStation({ site: "eastgate" });
  try {
    const { nodes } = station.state;
    const add = (parent, name, typeSpec, kind, extra = {}) => {
      const ord = `${parent}/${name}`;
      nodes.set(ord, { ord, name, display: name, typeSpec, kind, children: [], ...extra });
      nodes.get(parent).children.push(ord);
      return ord;
    };
    const folder = add("slot:/Drivers", "Test", "baja:Folder", "container");
    const ramp = add(folder, "Ramp", "control:NumericWritable", "point", { vt: "numeric", units: "°F", writable: true, fallback: 70 });
    add(ramp, "proxyExt", "control:NullProxyExt", "point", { vt: "numeric", fallback: 70 });
    const sine = add(folder, "SineWave", "control:NumericPoint", "point", { vt: "numeric", fallback: 1 });
    add(sine, "proxyExt", "bacnet:BacnetNumericProxyExt", "point", { vt: "numeric", fallback: 1 });
    add(sine, "NumericInterval", "history:NumericIntervalHistoryExt", "component");

    const { evidence } = await readEvidence(client, "slot:/");
    assert.deepEqual(evidence.map((e) => [e.ord, e.points.map((p) => p.ord)]), [[folder, [ramp, sine]]]);
    const equipment = inferModel(evidence);
    // The folder is the only thing that could be equipment, and it is called unknown, not guessed.
    assert.deepEqual(equipment.map((e) => [e.ord, e.kind, e.points.map((p) => p.name).sort()]), [[folder, "unknown", ["Ramp", "SineWave"]]]);
    assert.ok(!equipment.some((e) => e.ord === ramp || e.ord === sine), "a control point is not equipment");
    assert.ok(!equipment.some((e) => e.points.some((p) => /proxyExt|NumericInterval/.test(p.ord))), "an extension is not a point");
    assert.ok(equipment[0].confidence <= 0.2);
  } finally {
    await close();
  }
});

test("what serves what: the only plant feeds the units with a valve for it; two air handlers nothing tells apart feed nothing", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    untag(station);
    const first = await review(client);
    // Each air handler has a cooling valve and there is one chilled water plant, in the same folder.
    assert.deepEqual(first.serves.map((s) => [s.fromName, s.toName, s.medium, s.inferred, s.confirmed]), [["CHW_Plant", "AHU_01", "chilledWater", true, false], ["CHW_Plant", "AHU_02", "chilledWater", true, false]]);
    assert.equal(first.serves[0].reason, "chilled water plant feeds air handler with chilled water; CHW_Plant is the only chilled water plant on the station; it has a cooling valve command (CoolingValve)");
    assert.ok(first.serves.every((s) => s.confidence > 0.3 && s.confidence < 0.7), "folder shape alone is a weak reason");
    // Eight VAV boxes and two air handlers in one folder, no link and no name that says which: no guess.
    assert.ok(!first.serves.some((s) => s.medium === "air"));
    assert.match(first.howTo, /every one marked "inferred": true is a proposal/);
  } finally {
    await close();
  }
});

test("what serves what: a link through logic says which air handler, and a confirmed entry is kept on the next run", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    untag(station);
    // AHU-2's fan follows the most open of two boxes' dampers: a static pressure reset, as logic.
    const P = (path) => `${NET}/${path.replace("/", "/points/")}`;
    const plan = (await client.call("preview_model_changes", { changes: [
      { action: "create", parent: "slot:/Logic", name: "AHU_02", typeSpec: "baja:Folder", ref: "f" },
      { action: "create", parent: "@f", name: "MostOpen", typeSpec: "kitControl:Maximum", ref: "max" },
      { action: "create_link", name: "Link", collision: "suffix", source: P("VAV_105/DamperPosition"), sourceSlot: "out", target: "@max", targetSlot: "inA" },
      { action: "create_link", name: "Link", collision: "suffix", source: P("VAV_106/DamperPosition"), sourceSlot: "out", target: "@max", targetSlot: "inB" },
      { action: "create_link", name: "Link", collision: "suffix", source: "@max", sourceSlot: "out", target: P("AHU_02/SupplyFanSpeed"), targetSlot: "in10" }
    ] })).result;
    await client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: randomUUID() });

    const { evidence } = await readEvidence(client, "slot:/");
    const { links, truncated } = await readEquipmentLinks(client, evidence);
    assert.equal(truncated, false);
    assert.deepEqual(links.map((l) => [l.a, l.b, l.via]).sort(), [
      [`${NET}/VAV_105`, `${NET}/AHU_02`, "VAV_105/DamperPosition → AHU_02/MostOpen → AHU_02/SupplyFanSpeed"],
      [`${NET}/VAV_106`, `${NET}/AHU_02`, "VAV_106/DamperPosition → AHU_02/MostOpen → AHU_02/SupplyFanSpeed"]
    ]);
    const first = await review(client);
    const air = first.serves.filter((s) => s.medium === "air");
    // The link runs from the box to the air handler; the kinds say which way the air goes.
    assert.deepEqual(air.map((s) => [s.fromName, s.toName, s.inferred]), [["AHU_02", "VAV_105", true], ["AHU_02", "VAV_106", true]]);
    assert.match(air[0].reason, /^air handler feeds VAV box with air; a link joins them \(VAV_105\/DamperPosition → AHU_02\/MostOpen → AHU_02\/SupplyFanSpeed\)$/);
    assert.ok(air[0].confidence > first.serves.find((s) => s.medium === "chilledWater").confidence, "a link is a better reason than a folder");
    // Uncertain first.
    assert.deepEqual(first.serves.map((s) => s.confidence), first.serves.map((s) => s.confidence).sort((a, b) => a - b));

    // A person confirms one and corrects another's source; a second run keeps both as they left them.
    const edited = structuredClone(first);
    edited.serves.find((s) => s.toName === "VAV_105").confirmed = true;
    Object.assign(edited.serves.find((s) => s.toName === "VAV_106"), { from: `${NET}/AHU_01`, fromName: "AHU_01", confirmed: true });
    const second = await review(client, edited);
    assert.deepEqual(second.serves.filter((s) => s.confirmed).map((s) => [s.fromName, s.toName]).sort(), [["AHU_01", "VAV_106"], ["AHU_02", "VAV_105"]]);
    assert.equal(second.serves.filter((s) => s.toName === "VAV_106").length, 1);
  } finally {
    await close();
  }
});

test("what serves what, on names alone: a box named for its air handler, and nothing where two fit equally", () => {
  const unit = (name, kind, label, roles = []) => ({ ord: `slot:/Drivers/Net/${name}`, name, kind, label, tags: [], confidence: 0.9, reason: "", confirmed: false, points: roles.map((role) => ({ ord: `slot:/Drivers/Net/${name}/points/${role}`, name: role, role, label: role, tags: [], confidence: 0.9, reason: "", confirmed: false })) });
  const equipment = [unit("AHU_1", "ahu", "air handler"), unit("AHU_2", "ahu", "air handler"), unit("AHU1_VAV_3", "vav", "VAV box"), unit("VAV_AHU02_7", "vav", "VAV box", ["reheatValve"]), unit("VAV_9", "vav", "VAV box"), unit("B_1", "boiler", "boiler"), unit("HW_Plant", "hotWaterPlant", "hot water plant")];
  const serves = inferServes(equipment);
  assert.deepEqual(serves.map((s) => `${s.fromName} > ${s.toName} (${s.medium})`).sort(), ["AHU_1 > AHU1_VAV_3 (air)", "AHU_2 > VAV_AHU02_7 (air)", "B_1 > HW_Plant (hotWater)", "HW_Plant > VAV_AHU02_7 (hotWater)"]);
  assert.match(serves.find((s) => s.toName === "AHU1_VAV_3").reason, /its name holds AHU_1$/);
  assert.ok(serves.every((s) => s.inferred && !s.confirmed && s.confidence > 0 && s.confidence <= 0.95));
  // VAV_9 could be on either air handler: no proposal. It has no reheat valve: the plant does not feed it.
  assert.ok(!serves.some((s) => s.toName === "VAV_9"));
});

test("model write: only confirmed entries become tags and relations, a preview is the default, and it is read back", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    untag(station);
    const file = await review(client);
    // Nothing confirmed: nothing to write.
    const empty = await planModelWrite(client, file);
    assert.deepEqual([empty.tags, empty.relations], [[], []]);
    assert.deepEqual(empty.unconfirmed, { equipment: 11, points: 78, serves: 2 });

    const ahu = file.equipment.find((e) => e.name === "AHU_01");
    const plant = file.equipment.find((e) => e.name === "CHW_Plant");
    const vav = file.equipment.find((e) => e.name === "VAV_101");
    ahu.confirmed = true;
    plant.confirmed = true;
    ahu.points.find((p) => p.name === "SupplyAirTemp").confirmed = true;
    // A confirmed point under equipment nobody confirmed is tagged, and not tied to the equipment.
    vav.points.find((p) => p.name === "ZoneTemp").confirmed = true;
    file.serves.find((s) => s.toName === "AHU_01").confirmed = true;
    plant.tags.push("Not A Tag");

    const before = { audit: station.state.audit.length };
    const plan = await planModelWrite(client, file);
    assert.deepEqual(station.state.audit.length, before.audit, "planning only reads");
    assert.deepEqual(plan.tags, [
      { ord: `${NET}/VAV_101/points/ZoneTemp`, set: ["hs:point", "hs:zone", "hs:air", "hs:temp", "hs:sensor"].map((id) => ({ id })), remove: [] },
      { ord: `${NET}/AHU_01`, set: [{ id: "hs:equip" }, { id: "hs:ahu" }], remove: [] },
      { ord: `${NET}/AHU_01/points/SupplyAirTemp`, set: ["hs:point", "hs:discharge", "hs:air", "hs:temp", "hs:sensor"].map((id) => ({ id })), remove: [] },
      { ord: `${NET}/CHW_Plant`, set: [{ id: "hs:equip" }, { id: "hs:chilledWaterPlant" }], remove: [] }
    ].sort((a, b) => plan.tags.findIndex((t) => t.ord === a.ord) - plan.tags.findIndex((t) => t.ord === b.ord)));
    assert.deepEqual(plan.relations.map((r) => [r.ord, r.add]).sort(), [
      [`${NET}/AHU_01`, [{ id: "hs:chilledWaterRef", endpoint: `${NET}/CHW_Plant` }]],
      [`${NET}/AHU_01/points/SupplyAirTemp`, [{ id: "hs:equipRef", endpoint: `${NET}/AHU_01` }]]
    ]);
    assert.deepEqual(plan.invalid, ["Not A Tag"]);
    assert.deepEqual(plan.unconfirmed, { equipment: 9, points: 76, serves: 1 });

    const written = await runModelWrite(client, plan);
    assert.deepEqual([written.written, written.failures, written.verified], [true, [], true]);
    const { nodes } = station.state;
    assert.deepEqual(nodes.get(`${NET}/AHU_01`).tags, ["hs:equip", "hs:ahu"]);
    assert.deepEqual(nodes.get(`${NET}/AHU_01`).relations, [{ id: "hs:chilledWaterRef", to: `${NET}/CHW_Plant` }]);
    // The unconfirmed guesses are not on the station: AHU_02 is as it was, and so is VAV_101 itself.
    assert.deepEqual([nodes.get(`${NET}/AHU_02`).tags, nodes.get(`${NET}/AHU_02`).relations, nodes.get(`${NET}/VAV_101`).tags], [[], undefined, []]);
    assert.equal(nodes.get(`${NET}/VAV_101/points/ZoneTemp`).relations, undefined);
    // A query by tag now finds them, and a second write has nothing to do.
    assert.deepEqual((await client.query({ neql: "hs:ahu" })).entities.map((e) => e.ord), [`${NET}/AHU_01`]);
    const again = await planModelWrite(client, file);
    assert.deepEqual([again.tags, again.relations, again.already], [[], [], 16]);

    // Inferring again takes what is now on the station as it is: tagged, related, and not marked inferred.
    const after_ = await review(client);
    const served = after_.serves.find((s) => s.toName === "AHU_01");
    assert.deepEqual([served.fromName, served.confidence, served.confirmed, served.inferred, served.reason], ["CHW_Plant", 1, true, false, "already related hs:chilledWaterRef"]);
    // The Haystack grid carries the confirmed "fed by" as a ref.
    assert.equal(haystackGrid(file).rows.find((row) => row.dis === "s:AHU_01").chilledWaterRef, "r:Drivers.BacnetNetwork.CHW_Plant CHW_Plant");

    // A review file made on one station is not written to another.
    await assert.rejects(planModelWrite(client, { ...file, station: "Riverside" }), /This review file is for Riverside; the station connected is Northgate\. Nothing is written to a different station\./);
    // A confirmed entry whose component has gone is named and left out.
    ahu.points.find((p) => p.name === "ReturnAirTemp").confirmed = true;
    nodes.delete(`${NET}/AHU_01/points/ReturnAirTemp`);
    assert.deepEqual((await planModelWrite(client, file)).missing, [`${NET}/AHU_01/points/ReturnAirTemp`]);
  } finally {
    await close();
  }
});

test("the Brick export: confirmed entries only, with their classes, points tied to equipment, and feeds", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    untag(station);
    const file = await review(client);
    assert.match(brickTurtle(file), /# Nothing in the review file is confirmed yet\.\n$/);
    for (const name of ["AHU_01", "CHW_Plant"]) file.equipment.find((e) => e.name === name).confirmed = true;
    const ahu = file.equipment.find((e) => e.name === "AHU_01");
    for (const name of ["SupplyAirTemp", "CoolingValve"]) ahu.points.find((p) => p.name === name).confirmed = true;
    Object.assign(ahu.points.find((p) => p.name === "FilterDP"), { confirmed: true, role: "somethingElse" });
    file.serves.find((s) => s.toName === "AHU_01").confirmed = true;
    const base = "urn:baskstream:Northgate:Drivers.BacnetNetwork";
    assert.equal(brickTurtle(file), `@prefix brick: <https://brickschema.org/schema/Brick#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<${base}.AHU_01> a brick:AHU ;
    rdfs:label "AHU_01" .
<${base}.AHU_01.points.CoolingValve> a brick:Valve_Position_Command ;
    rdfs:label "AHU_01 CoolingValve" ;
    brick:isPointOf <${base}.AHU_01> .
<${base}.AHU_01.points.FilterDP> a brick:Point ;
    rdfs:label "AHU_01 FilterDP" ;
    brick:isPointOf <${base}.AHU_01> .
<${base}.AHU_01.points.SupplyAirTemp> a brick:Supply_Air_Temperature_Sensor ;
    rdfs:label "AHU_01 SupplyAirTemp" ;
    brick:isPointOf <${base}.AHU_01> .
<${base}.CHW_Plant> a brick:Chilled_Water_System ;
    rdfs:label "CHW_Plant" ;
    brick:feeds <${base}.AHU_01> .
# AHU_01 FilterDP: role "somethingElse" has no Brick class here, written as brick:Point
`);
    // The unconfirmed AHU_02 and every unconfirmed point are absent.
    assert.doesNotMatch(brickTurtle(file), /AHU_02|ReturnAirTemp/);
    // Class names are Brick's own form: words joined by underscores, each starting with a capital or a digit.
    for (const cls of [...Object.values(BRICK_CLASSES.kinds), ...Object.values(BRICK_CLASSES.roles)]) assert.match(cls, /^[A-Z][A-Za-z0-9]*(_[A-Z0-9][A-Za-z0-9]*)*$/);
  } finally {
    await close();
  }
});

test("from the command line: infer lists what serves what, write previews then writes with --yes, export --format brick", async () => {
  const { station, close } = await startStation({ site: "northgate" });
  const env = { ...process.env, BASKSTREAM_CONFIG_DIR: dir, BASKSTREAM_PASSWORD: station.password, FORCE_COLOR: "0" };
  const bask = (...args) => run(process.execPath, [main, ...args], { env, cwd: dir, maxBuffer: 16 * 1024 * 1024 }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));
  try {
    untag(station);
    assert.equal((await bask("login", station.url, "-u", station.user, "--name", "write")).code, 0);
    const shown = await bask("model", "infer");
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /What serves what · 2 inferred, to confirm in the file/);
    assert.match(shown.out, /0\.\d\d +AHU_01 +CHW_Plant +inferred +chilled water plant feeds air handler with chilled water/);
    assert.match(shown.err, /then: bask model write Northgate-model\.json/);
    const file = join(dir, "Northgate-model.json");

    const nothing = await bask("model", "write", file);
    assert.equal(nothing.code, 0, nothing.err);
    assert.match(nothing.out, /Nothing is confirmed yet/);

    const doc = JSON.parse(readFileSync(file, "utf8"));
    for (const e of doc.equipment.filter((e) => e.kind === "vav")) e.confirmed = true;
    doc.equipment.find((e) => e.name === "VAV_101").points.find((p) => p.role === "zoneTemp").confirmed = true;
    writeFileSync(file, JSON.stringify(doc, null, 2));

    const before = station.state.audit.length;
    const preview = await bask("model", "write", file);
    assert.equal(preview.code, 0, preview.err);
    assert.match(preview.out, /Northgate {2}21 tags and 1 relation on 9 components · 0 already there/);
    assert.match(preview.out, /tag +Drivers\/BacnetNetwork\/VAV_103 +hs:equip, hs:vav/);
    assert.match(preview.out, /relate +VAV_101\/points\/ZoneTemp +hs:equipRef → Drivers\/BacnetNetwork\/VAV_101/);
    assert.match(preview.out, /Not confirmed, so not written: 3 equipment, 77 points, 2 of what serves what\./);
    assert.match(preview.out, /Nothing is written yet\. To write these, run again with --allow-writes --yes\./);
    assert.equal(station.state.audit.length, before);

    const refused = await bask("model", "write", file, "--yes");
    assert.equal(refused.code, 1);
    assert.match(refused.err, /Add --allow-writes to permit it/);
    assert.equal(station.state.audit.length, before);

    const written = await bask("model", "write", file, "--allow-writes", "--yes");
    assert.equal(written.code, 0, written.out + written.err);
    assert.match(written.out, /✓ Written, and read back from the station\./);
    assert.deepEqual(station.state.nodes.get(`${NET}/VAV_108`).tags, ["hs:equip", "hs:vav"]);
    assert.deepEqual(station.state.nodes.get(`${NET}/AHU_01`).tags, []);
    const again = await bask("model", "write", file, "--allow-writes", "--yes", "-o", "json");
    assert.deepEqual([JSON.parse(again.out).tags, JSON.parse(again.out).already], [[], 22]);

    const brick = await bask("model", "export", file, "--format", "brick");
    assert.equal(brick.code, 0, brick.err);
    assert.equal((brick.out.match(/ a brick:VAV ;/g) ?? []).length, 8);
    assert.match(brick.out, /VAV_101\.points\.ZoneTemp> a brick:Zone_Air_Temperature_Sensor ;\n {4}rdfs:label "VAV_101 ZoneTemp" ;\n {4}brick:isPointOf <urn:baskstream:Northgate:Drivers\.BacnetNetwork\.VAV_101> \./);
  } finally {
    await close();
  }
});
