// bask export and bask diff on the simulated buildings: an export is the same bytes every time the
// branch is unchanged, it leaves out what only runs (values, health, overrides), secrets and
// handles, and a diff of two exports names exactly what was changed between them.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { diffExports, differenceText } from "../dist/diff.js";
import { exportBranch, exportText, parseExport } from "../dist/export.js";
import { settle, startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bask-export-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NET = "slot:/Drivers/BacnetNetwork";
const at = (doc, path) => doc.components.find((c) => c.path === path);

test("two exports of an unchanged station are byte-identical, while its values move", async () => {
  // A live station: every value drifts with the clock between the two exports.
  const { client, close } = await startStation({ site: "northgate", live: true });
  try {
    const flows = [1, 2, 3, 4, 5, 6, 8].map((i) => `${NET}/VAV_10${i}/points/Airflow`);
    const values = async () => (await client.read(flows)).map((p) => p.value);
    const first = exportText(await exportBranch(client, "slot:/"));
    const before = await values();
    await settle(1000);
    assert.notDeepEqual(await values(), before, "the values did move");
    const second = exportText(await exportBranch(client, "slot:/"));
    assert.equal(second, first);
    assert.ok(first.length > 20000 && first.endsWith("}\n"));
    // Commanding a point is not a change to the station's configuration.
    await client.write(`${NET}/VAV_101/points/ZoneSetpoint`, "override", 70);
    assert.equal(exportText(await exportBranch(client, "slot:/")), first);
  } finally {
    await close();
  }
});

test("what an export holds: types, set properties, links, tags; paths in order", async () => {
  const { client, close } = await startStation({ site: "northgate" });
  try {
    const doc = await exportBranch(client, "slot:/");
    assert.deepEqual([doc.format, doc.version, doc.root], ["bask-export", 1, "slot:/"]);
    const paths = doc.components.map((c) => c.path);
    assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(paths[0], ".");

    assert.deepEqual(at(doc, "Drivers/BacnetNetwork/AHU_01"), {
      path: "Drivers/BacnetNetwork/AHU_01", type: "bacnet:BacnetDevice",
      properties: { address: "192.168.10.11", enabled: "true", objectId: "device:1001", pollFrequency: "normal" },
      tags: { "hs:ahu": true, "hs:equip": true }
    });
    // A link is kept where it arrives; its source is a path under the root.
    assert.deepEqual(at(doc, "Drivers/BacnetNetwork/AHU_01/points/CoolingValve").links, [{ from: "Logic/AHU_01/SatLoop", fromSlot: "out", toSlot: "in10" }]);
    // Only what differs from a new block of the type: the loop's gain and bias, not its untouched settings.
    const loop = at(doc, "Logic/AHU_01/SatLoop");
    assert.equal(loop.type, "kitControl:LoopPoint");
    assert.equal(loop.properties.proportionalConstant, "8");
    assert.equal(loop.properties.bias, "55");
    for (const untouched of ["integralConstant", "derivativeConstant", "maximumOutput", "minimumOutput", "loopAction"]) assert.ok(!(untouched in loop.properties), untouched);
    // Inputs a link feeds, live outputs and priority inputs are not configuration.
    assert.ok(!("controlledVariable" in loop.properties) && !("out" in loop.properties));
    const fan = at(doc, "Drivers/BacnetNetwork/AHU_02/points/SupplyFanSpeed");
    assert.deepEqual(Object.keys(fan.properties), ["facets", "fallback"]);

    // A branch exports with paths from its own root, so two like branches can be compared.
    const branch = await exportBranch(client, `${NET}/AHU_01`);
    assert.equal(branch.root, `${NET}/AHU_01`);
    assert.deepEqual(at(branch, "points/CoolingValve").links, [{ from: "slot:/Logic/AHU_01/SatLoop", fromSlot: "out", toSlot: "in10" }]);
    assert.deepEqual(at(branch, ".").properties, at(doc, "Drivers/BacnetNetwork/AHU_01").properties);
  } finally {
    await close();
  }
});

test("secrets, handles and times are left out", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    Object.assign(station.state.nodes.get(`${NET}/AHU_01`).props, {
      password: { typeSpec: "baja:Password", encoded: "hunter2-password", writable: true },
      apiToken: { typeSpec: "baja:String", encoded: "tok-9f31", writable: true },
      login: { typeSpec: "baja:UsernameAndPassword", encoded: "svc:pw-7c2", writable: true },
      siteRef: { typeSpec: "baja:Ord", encoded: "h:2c45e", writable: true },
      notes: { typeSpec: "baja:String", encoded: "roof unit", writable: true }
    });
    const text = exportText(await exportBranch(client, "slot:/"));
    for (const secret of ["hunter2", "tok-9f31", "pw-7c2", "password", "apiToken"]) assert.ok(!text.includes(secret), secret);
    assert.doesNotMatch(text, /h:2c45e/);
    // Health carries the time of the last ping: it is state, not configuration.
    assert.doesNotMatch(text, /health|\bMST\b|Ok \[|\d{4}-\d\d-\d\dT/);
    assert.match(text, /"notes": "roof unit"/);
  } finally {
    await close();
  }
});

test("a diff of two exports names exactly what changed between them", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const { nodes } = station.state;
    const before = await exportBranch(client, NET);
    nodes.get(`${NET}/VAV_102`).props.address.encoded = "MSTP 2:99";
    nodes.get(`${NET}/VAV_103`).tags.push("hs:zone");
    nodes.get(`${NET}/CHW_Plant`).tags = ["hs:equip"];
    const points = nodes.get(`${NET}/VAV_108/points`);
    points.children = points.children.filter((ord) => !ord.endsWith("/ReheatValve"));
    const copy = { ...nodes.get(`${NET}/VAV_108/points/Airflow`), ord: `${NET}/VAV_108/points/DischargeAirTemp`, name: "DischargeAirTemp", display: "DischargeAirTemp", units: "°F" };
    nodes.set(copy.ord, copy);
    points.children.push(copy.ord);
    const after_ = await exportBranch(client, NET);

    const result = diffExports(before, after_);
    assert.equal(result.same, false);
    assert.deepEqual(result.differences.map((d) => `${d.change} ${d.path}: ${differenceText(d)}`), [
      "removed CHW_Plant: tag hs:chilledWaterPlant",
      "changed VAV_102: property address: MSTP 2:12 → MSTP 2:99",
      "added VAV_103: tag hs:zone",
      "added VAV_108/points/DischargeAirTemp: component control:NumericPoint",
      "removed VAV_108/points/ReheatValve: component control:NumericWritable"
    ]);
    assert.deepEqual(result.summary, { added: 2, removed: 2, changed: 1, components: { added: 1, removed: 1, changed: 3 } });
    assert.deepEqual(result.differences[1], { path: "VAV_102", change: "changed", what: "property", name: "address", from: "MSTP 2:12", to: "MSTP 2:99" });
    // The same export against itself, and the other way round.
    assert.equal(diffExports(before, before).same, true);
    assert.deepEqual(diffExports(after_, before).differences.map((d) => d.change), ["added", "changed", "removed", "removed", "added"]);
  } finally {
    await close();
  }
});

test("a diff also covers a component's type, links and relations", () => {
  const doc = (components) => ({ format: "bask-export", version: 1, root: "slot:/Logic", components });
  const a = doc([
    { path: "Reset", type: "kitControl:Reset", links: [{ from: "slot:/Drivers/N/AHU/points/Oat", fromSlot: "out", toSlot: "inA" }], relations: [{ id: "hs:siteRef", to: "slot:/Site" }] },
    { path: "Sw", type: "kitControl:NumericSwitch", properties: { inTrue: { status: "{ok}", value: "55.0" } } }
  ]);
  const b = doc([
    { path: "Reset", type: "kitControl:Reset", links: [{ from: "slot:/Drivers/N/AHU/points/Mat", fromSlot: "out", toSlot: "inA" }] },
    { path: "Sw", type: "kitControl:BooleanSwitch", properties: { inTrue: { status: "{ok}", value: "57.0" } } }
  ]);
  assert.deepEqual(diffExports(a, b).differences.map((d) => `${d.change} ${d.path}: ${differenceText(d)}`), [
    "added Reset: link slot:/Drivers/N/AHU/points/Mat.out → inA",
    "removed Reset: link slot:/Drivers/N/AHU/points/Oat.out → inA",
    "removed Reset: relation hs:siteRef → slot:/Site",
    "changed Sw: type: kitControl:NumericSwitch → kitControl:BooleanSwitch",
    'changed Sw: property inTrue: {"status":"{ok}","value":"55.0"} → {"status":"{ok}","value":"57.0"}'
  ]);
  assert.throws(() => parseExport('{"changes": []}', "plan.json"), /plan\.json is not a bask export/);
  assert.throws(() => parseExport("nope", "x.json"), /x\.json could not be read as JSON/);
});

test("from the command line: export to a file, diff files and live branches, exit code 1 when they differ", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  const env = { ...process.env, BASKSTREAM_CONFIG_DIR: dir, BASKSTREAM_PASSWORD: station.password, FORCE_COLOR: "0" };
  const bask = (...args) => run(process.execPath, [main, ...args], { env, maxBuffer: 16 * 1024 * 1024 }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));
  try {
    assert.equal((await bask("login", station.url, "-u", station.user, "--name", "export")).code, 0);
    // No --allow-writes: exporting and comparing only read.
    const exported = await bask("export", "Drivers/BacnetNetwork");
    assert.equal(exported.code, 0, exported.err);
    assert.equal(exported.out, exportText(await exportBranch(client, NET)));
    const a = join(dir, "a.json");
    writeFileSync(a, exported.out);

    const same = await bask("diff", a, "Drivers/BacnetNetwork");
    assert.equal(same.code, 0, same.out + same.err);
    assert.match(same.out, /No differences\./);

    station.state.nodes.get(`${NET}/VAV_102`).props.address.encoded = "MSTP 2:99";
    const b = join(dir, "b.json");
    writeFileSync(b, (await bask("export", "Drivers/BacnetNetwork")).out);

    const live = await bask("diff", a, "Drivers/BacnetNetwork");
    assert.equal(live.code, 1);
    assert.match(live.out, /0 components added, 0 removed, 1 changed \(1 difference\)/);
    assert.match(live.out, /changed +VAV_102 +property address: MSTP 2:12 → MSTP 2:99/);

    const json = await bask("diff", a, b, "-o", "json");
    assert.equal(json.code, 1);
    const result = JSON.parse(json.out);
    assert.deepEqual([result.a, result.b, result.same], [a, b, false]);
    assert.deepEqual(result.differences, [{ path: "VAV_102", change: "changed", what: "property", name: "address", from: "MSTP 2:12", to: "MSTP 2:99" }]);

    // Two branches of the live station: the two air handlers differ in address and in what logic drives them.
    const branches = await bask("diff", "Drivers/BacnetNetwork/AHU_01", "Drivers/BacnetNetwork/AHU_02", "-o", "csv");
    assert.equal(branches.code, 1);
    assert.deepEqual(branches.out.trim().split("\n"), [
      "change,path,what,name,from,to",
      "changed,.,property,address,192.168.10.11,192.168.10.12",
      "changed,.,property,objectId,device:1001,device:1002",
      "removed,points/CoolingValve,link,slot:/Logic/AHU_01/SatLoop.out → in10,,",
      "removed,points/OccupiedCmd,link,slot:/Logic/AHU_01/Occupied.out → in10,,"
    ]);

    // Two files need no station at all: a config folder with no profile in it.
    const offline = await run(process.execPath, [main, "diff", a, b], { env: { ...env, BASKSTREAM_CONFIG_DIR: join(dir, "empty") } }).then((r) => ({ code: 0, out: r.stdout }), (e) => ({ code: e.code, out: e.stdout }));
    assert.equal(offline.code, 1);
    assert.match(offline.out, /property address/);
  } finally {
    await close();
  }
});
