// bask apply on the simulated buildings (docs/ROADMAP.md, E4 and E5): an export applied to an empty
// folder and exported again gives no difference; nothing is changed without --yes; program: objects,
// protected services and platform settings are reported and never applied; and a template with a
// CSV file stamps out one copy per row.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LIMITS, applyCommand, fillTemplate, gapsIn, parseCsv, planApply, protectedWhy, runApply, typedOf } from "../dist/apply.js";
import { diffExports } from "../dist/diff.js";
import { exportBranch, exportText } from "../dist/export.js";
import { startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bask-apply-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NET = "slot:/Drivers/BacnetNetwork";

/** Makes an empty folder the way bask plan would. */
async function emptyFolder(client, name) {
  const plan = (await client.call("preview_model_changes", { changes: [{ action: "create", parent: "slot:/", name, typeSpec: "baja:Folder" }] })).result;
  await client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: randomUUID() });
  return `slot:/${name}`;
}
const actions = (plan) => plan.plans.flat().map((c) => c.action);

test("an export applied to an empty folder and exported again gives no difference", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const file = await exportBranch(client, "slot:/Logic");
    const target = await emptyFolder(client, "Scratch");
    const before = station.state.nodes.size;
    const plan = await planApply(client, file, target);
    assert.equal(plan.createsTarget, false);
    assert.deepEqual(plan.notApplied, []);
    // Six components, then the seven links between them and from the points that feed them.
    assert.deepEqual(plan.plans.map((changes) => changes.map((c) => c.action)), [Array(6).fill("create"), Array(7).fill("create_link")]);

    // The default is a preview: the station checks the first plan, and nothing is changed.
    const preview = await runApply(client, plan, { file });
    assert.deepEqual([preview.ok, preview.applied, preview.remaining], [true, false, undefined]);
    assert.equal(preview.steps[0].checked, true);
    assert.match(preview.steps[1].waitsFor, /only once that is applied/);
    assert.equal(station.state.nodes.size, before);

    const applied = await runApply(client, plan, { apply: true, file });
    assert.deepEqual([applied.ok, applied.applied, applied.remaining], [true, true, []]);
    assert.equal(station.state.nodes.size, before + 6);
    const again = await exportBranch(client, target);
    assert.equal(diffExports(file, again).same, true);
    assert.deepEqual(again.components, file.components);
    // It is the logic, not a picture of it: the copy's loop works out what the original's does.
    const [original, copy] = await client.read(["slot:/Logic/AHU_01/SatLoop", "slot:/Scratch/AHU_01/SatLoop"]);
    assert.equal(copy.value, original.value);
    assert.ok(Number.isFinite(copy.value));

    // A second run has nothing to do.
    const second = await planApply(client, file, target);
    assert.deepEqual([second.differences, second.plans, second.tags], [[], [], []]);
  } finally {
    await close();
  }
});

test("a device that is not there is added with its points, properties, links and tags, in the order the station can take them", async () => {
  const { client, close } = await startStation({ site: "northgate" });
  try {
    const file = await exportBranch(client, `${NET}/AHU_01`);
    const plan = await planApply(client, file, `${NET}/AHU_09`);
    assert.equal(plan.createsTarget, true);
    // The device first; its points folder comes with it, so the points wait for the next plan; then what is set and linked.
    assert.deepEqual(plan.plans.map((changes) => [...new Set(changes.map((c) => c.action))].join("+")), ["create", "create", "update+create_link"]);
    assert.deepEqual(plan.plans[0].map((c) => [c.parent, c.name, c.typeSpec, Object.keys(c.properties)]), [[NET, "AHU_09", "bacnet:BacnetDevice", ["address", "enabled", "objectId", "pollFrequency"]]]);
    assert.ok(!plan.plans.flat().some((c) => c.action === "create" && c.name === "points"), "the points folder is not created a second time");
    assert.deepEqual(plan.tags, [{ ord: `${NET}/AHU_09`, set: [{ id: "hs:ahu" }, { id: "hs:equip" }], remove: [] }]);
    const applied = await runApply(client, plan, { apply: true, file });
    assert.deepEqual([applied.ok, applied.remaining], [true, []]);
    assert.equal(exportText({ ...(await exportBranch(client, `${NET}/AHU_09`)), root: file.root }), exportText(file));
    const [fan] = await client.read([`${NET}/AHU_09/points/SupplyFanSpeed`]);
    assert.deepEqual([fan.value, fan.facets.units], [70, "%"]);
  } finally {
    await close();
  }
});

test("what changed in the file is applied: a property, a tag, a link, a new point; a removed one only with --prune", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const file = await exportBranch(client, NET);
    const at = (path) => file.components.find((c) => c.path === path);
    at("VAV_102").properties.address = "MSTP 2:99";
    at("VAV_103").tags["hs:zone"] = true;
    at("VAV_103").tags["demo:floor"] = 3;
    delete at("CHW_Plant").tags["hs:chilledWaterPlant"];
    at("VAV_103").relations = [{ id: "hs:airRef", to: "AHU_01" }];
    delete at("AHU_01/points/OccupiedCmd").links;
    at("AHU_02/points/CoolingValve").links = [{ from: "slot:/Logic/AHU_01/SatLoop", fromSlot: "out", toSlot: "in10" }];
    file.components = file.components.filter((c) => !c.path.startsWith("VAV_108"));
    file.components.push({ path: "VAV_101/points/DischargeAirTemp", type: "control:NumericPoint", properties: { facets: "units=u:°F|precision=i:1" } });
    file.components.sort((a, b) => (a.path < b.path ? -1 : 1));

    const plan = await planApply(client, file, NET);
    assert.deepEqual(actions(plan).sort(), ["create", "create_link", "delete_link", "update"]);
    assert.deepEqual(plan.plans.flat().find((c) => c.action === "update"), { action: "update", ord: `${NET}/VAV_102`, properties: { address: { encoded: "MSTP 2:99" } } });
    // A link is removed by the slot that holds it, which the station names.
    const held = (await client.call("describe_component", { ord: `${NET}/AHU_01/points/OccupiedCmd` })).result.slots.find((slot) => slot.typeSpec === "baja:Link").name;
    assert.deepEqual(plan.plans.flat().find((c) => c.action === "delete_link"), { action: "delete_link", ord: `${NET}/AHU_01/points/OccupiedCmd`, slot: held });
    assert.deepEqual(plan.tags, [{ ord: `${NET}/CHW_Plant`, set: [], remove: ["hs:chilledWaterPlant"] }, { ord: `${NET}/VAV_103`, set: [{ id: "demo:floor", value: 3 }, { id: "hs:zone" }], remove: [] }]);
    assert.deepEqual(plan.relations, [{ ord: `${NET}/VAV_103`, add: [{ id: "hs:airRef", endpoint: `${NET}/AHU_01` }], remove: [] }]);
    // VAV_108 is on the station and not in the file: one line for the device, and it is left alone.
    assert.deepEqual(plan.notApplied.map((n) => [n.difference.path, n.why]), [["VAV_108", "on the station and not in the file (--prune deletes it, and what is under it)"]]);

    const applied = await runApply(client, plan, { apply: true, file });
    assert.equal(applied.ok, true, JSON.stringify(applied.steps));
    assert.ok(applied.remaining.length > 0 && applied.remaining.every((d) => d.path.startsWith("VAV_108")));
    assert.ok(station.state.nodes.has(`${NET}/VAV_108/points/ZoneTemp`));
    assert.deepEqual(station.state.nodes.get(`${NET}/VAV_103`).relations, [{ id: "hs:airRef", to: `${NET}/AHU_01` }]);

    const pruned = await planApply(client, file, NET, { prune: true });
    assert.deepEqual(pruned.plans, [[{ action: "delete", ord: `${NET}/VAV_108`, recursive: true }]]);
    const after_ = await runApply(client, pruned, { apply: true, file });
    assert.deepEqual([after_.ok, after_.remaining], [true, []]);
    assert.ok(!station.state.nodes.has(`${NET}/VAV_108`));
  } finally {
    await close();
  }
});

test("program: objects, protected services and platform settings are reported as differences and never applied", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const file = await exportBranch(client, "slot:/");
    const add = (path, type, properties) => file.components.push({ path, type, ...(properties ? { properties } : {}) });
    add("Logic/AHU_01/Sequence", "program:Program", { code: "x" });
    add("Logic/AHU_01/Sequence/Helper", "baja:Folder");
    add("Services/UserService/intruder", "baja:User", { fullName: "x" });
    add("Services/PlatformServices", "platform:PlatformServiceContainer");
    add("Services/PlatformServices/TcpIpService", "platform:TcpIpPlatformService", { hostName: "x" });
    add("Services/ProgramService", "program:ProgramService");
    add("Services/Notes", "baja:Folder");
    file.components.find((c) => c.path === "Services/BASkStreamService").properties = { writesEnabled: "false" };
    file.components.find((c) => c.path === "Logic/AHU_01/SatLoop").type = "kitControl:Tstat";
    file.components.sort((a, b) => (a.path < b.path ? -1 : 1));

    const plan = await planApply(client, file, "slot:/");
    assert.deepEqual(plan.notApplied.map((n) => `${n.difference.path}: ${n.why}`), [
      "Logic/AHU_01/SatLoop: a component's type cannot be changed in place: delete it and apply again",
      "Logic/AHU_01/Sequence: a program: object",
      "Logic/AHU_01/Sequence/Helper: inside a program: object",
      "Services/BASkStreamService: a protected service",
      "Services/PlatformServices: a platform setting",
      "Services/PlatformServices/TcpIpService: a platform setting",
      "Services/ProgramService: a protected service",
      "Services/UserService/intruder: a protected service"
    ]);
    // The one ordinary difference is the only change planned.
    assert.deepEqual(plan.plans, [[{ action: "create", parent: "slot:/Services", name: "Notes", typeSpec: "baja:Folder", ref: "n0" }]]);
    const before = station.state.nodes.size;
    const applied = await runApply(client, plan, { apply: true, file });
    assert.equal(applied.ok, true);
    assert.equal(station.state.nodes.size, before + 1);
    // They are still differences afterwards: reported, not hidden.
    assert.equal(applied.remaining.length, 8);
    assert.match(LIMITS, /program: objects, protected services .* and platform settings are reported as differences and never applied/);

    assert.equal(protectedWhy("baja:UserService", "slot:/Services/UserService"), "a protected service");
    assert.equal(protectedWhy("baja:Folder", "slot:/Services/WebService/x"), "a protected service");
    assert.equal(protectedWhy("platCrypto:CertManagerService", "slot:/x"), "a platform setting");
    assert.equal(protectedWhy("kitControl:Add", "slot:/Logic/Add"), undefined);
    assert.deepEqual(typedOf({ status: "{ok}", value: "38" }), { properties: { status: { encoded: "{ok}" }, value: { encoded: "38" } } });
  } finally {
    await close();
  }
});

test("a plan the station refuses is reported, and nothing after it is tried", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const file = await exportBranch(client, "slot:/Logic");
    file.components.push({ path: "AHU_01/Mystery", type: "kitControl:NoSuchBlock" });
    const before = station.state.nodes.size;
    const outcome = await runApply(client, await planApply(client, file, "slot:/Logic"), { apply: true, file });
    assert.equal(outcome.ok, false);
    assert.match(outcome.steps[0].error, /unknown_type: The demo station has no kitControl:NoSuchBlock/);
    assert.equal(station.state.nodes.size, before);
  } finally {
    await close();
  }
});

test("a template with named gaps is stamped out once per CSV row", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    // A template is an export with the parts that differ per unit replaced by ${name}.
    const template = exportText(await exportBranch(client, `${NET}/VAV_101`))
      .replace(`"root": "${NET}/VAV_101"`, `"root": "${NET}/\${device}"`).replace('"MSTP 2:11"', '"${address}"').replace('"device:2001"', '"device:${instance}"').replace('"hs:vav": true', '"hs:vav": true, "demo:room": "${room}"');
    assert.deepEqual(gapsIn(template), ["device", "address", "instance", "room"]);
    const rows = parseCsv('device,address,instance,room\r\nVAV_201,MSTP 3:1,2201,"Lab 2, east"\nVAV_202,MSTP 3:2,2202,"The ""quiet"" room"\n\n', "units.csv");
    assert.deepEqual(rows[1], { device: "VAV_202", address: "MSTP 3:2", instance: "2202", room: 'The "quiet" room' });
    const files = { "vav.yaml": template, "units.csv": "device,address,instance,room\nVAV_201,MSTP 3:1,2201,\"Lab 2, east\"\nVAV_202,MSTP 3:2,2202,\"The \"\"quiet\"\" room\"\n" };
    const options = { read: (name) => files[name], normalizeOrd: (ord) => ord };

    const preview = await applyCommand(client, { template: "vav.yaml", each: "units.csv" }, { ...options, apply: false });
    assert.deepEqual(preview.map((o) => [o.target, o.createsTarget, o.applied]), [[`${NET}/VAV_201`, true, false], [`${NET}/VAV_202`, true, false]]);
    assert.ok(!station.state.nodes.has(`${NET}/VAV_201`));

    const applied = await applyCommand(client, { template: "vav.yaml", each: "units.csv" }, { ...options, apply: true });
    assert.deepEqual(applied.map((o) => [o.ok, o.remaining]), [[true, []], [true, []]]);
    const made = station.state.nodes.get(`${NET}/VAV_202`);
    assert.deepEqual([made.props.address.encoded, made.props.objectId.encoded, made.tags, made.tagValues], ["MSTP 3:2", "device:2202", ["hs:equip", "hs:vav"], { "demo:room": 'The "quiet" room' }]);
    assert.equal(station.state.nodes.get(`${NET}/VAV_201`).tagValues["demo:room"], "Lab 2, east");
    assert.deepEqual(station.state.nodes.get(`${NET}/VAV_201/points`).children.length, 6);

    // A gap the CSV has no column for is named, and nothing is applied.
    assert.throws(() => fillTemplate(template, { device: "X" }, "vav.yaml"), /vav\.yaml has gaps with no value: \$\{address\}, \$\{instance\}, \$\{room\}\. The values given are for: device\./);
    await assert.rejects(applyCommand(client, { template: "vav.yaml" }, { ...options, apply: true }), /has gaps with no value/);
    await assert.rejects(applyCommand(client, { each: "units.csv" }, { ...options, apply: false }), /--each needs --template/);
    // --to takes gaps too: the same template stamped somewhere else.
    const moved = await applyCommand(client, { template: "vav.yaml", each: "units.csv", to: "slot:/Drivers/BacnetNetwork/Spare_${instance}" }, { ...options, apply: false });
    assert.deepEqual(moved.map((o) => o.target), [`${NET}/Spare_2201`, `${NET}/Spare_2202`]);
  } finally {
    await close();
  }
});

test("from the command line: a preview by default, --yes with --allow-writes applies, and the limits are stated", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  const env = { ...process.env, BASKSTREAM_CONFIG_DIR: dir, BASKSTREAM_PASSWORD: station.password, FORCE_COLOR: "0" };
  const bask = (...args) => run(process.execPath, [main, ...args], { env, maxBuffer: 16 * 1024 * 1024 }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));
  try {
    assert.equal((await bask("login", station.url, "-u", station.user, "--name", "apply")).code, 0);
    const file = join(dir, "logic.json");
    writeFileSync(file, (await bask("export", "Logic")).out);
    await emptyFolder(client, "Copy");
    const before = { nodes: station.state.nodes.size, audit: station.state.audit.length };

    const preview = await bask("apply", file, "--to", "Copy");
    assert.equal(preview.code, 0, preview.err);
    assert.match(preview.out, /logic\.json → slot:\/Copy {2}Northgate/);
    assert.match(preview.out, /6 differences: 13 changes to make in 2 plans, 0 reported only/);
    assert.match(preview.out, /plan 1 of 2 {2}the station accepts it\n {2}add {5}Copy\/AHU_01 {2}baja:Folder/);
    assert.match(preview.out, /link {4}Copy\/AHU_01\/SatReset\.out → Copy\/AHU_01\/SatLoop\.setpoint/);
    assert.ok(preview.out.includes(LIMITS));
    assert.match(preview.out, /Nothing is changed yet\. To make these changes, run again with --allow-writes --yes\./);
    assert.deepEqual({ nodes: station.state.nodes.size, audit: station.state.audit.length }, before);

    // --yes is not enough by itself, and neither is --allow-writes.
    const noPermit = await bask("apply", file, "--to", "Copy", "--yes");
    assert.equal(noPermit.code, 1);
    assert.match(noPermit.err, /Add --allow-writes to permit it/);
    assert.equal((await bask("apply", file, "--to", "Copy", "--allow-writes")).code, 0);
    assert.equal(station.state.nodes.size, before.nodes);

    const applied = await bask("apply", file, "--to", "Copy", "--allow-writes", "--yes");
    assert.equal(applied.code, 0, applied.out + applied.err);
    assert.match(applied.out, /plan 2 of 2 {2}applied/);
    assert.match(applied.out, /✓ Read back: the branch now matches the file\./);
    assert.equal(station.state.nodes.size, before.nodes + 6);

    // Exported again, the copy is the file: bask diff finds nothing, and a second apply has nothing to do.
    const same = await bask("diff", file, "Copy");
    assert.equal(same.code, 0, same.out);
    assert.match(same.out, /No differences\./);
    const again = await bask("apply", file, "--to", "Copy", "-o", "json");
    assert.deepEqual([JSON.parse(again.out).differences, JSON.parse(again.out).plans], [[], []]);

    // A template and a CSV file, from files.
    const template = join(dir, "vav.yaml");
    writeFileSync(template, (await bask("export", "Drivers/BacnetNetwork/VAV_101")).out.replace(`${NET}/VAV_101`, `${NET}/\${name}`).replace("MSTP 2:11", "${address}"));
    writeFileSync(join(dir, "units.csv"), "name,address\nVAV_301,MSTP 4:1\nVAV_302,MSTP 4:2\n");
    const stamped = await bask("apply", "--template", template, "--each", join(dir, "units.csv"), "--allow-writes", "-y");
    assert.equal(stamped.code, 0, stamped.out + stamped.err);
    assert.equal((stamped.out.match(/✓ Read back: the branch now matches the file\./g) ?? []).length, 2);
    assert.equal(station.state.nodes.get(`${NET}/VAV_302`).props.address.encoded, "MSTP 4:2");

    const wrong = await bask("apply", join(dir, "units.csv"));
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /units\.csv could not be read as JSON/);
  } finally {
    await close();
  }
});
