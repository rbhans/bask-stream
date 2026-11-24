// bask check on the simulated buildings: it finds the faults planted in them, the rules are data
// that a file can add to or change, and nothing it sends changes the station.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OPERATIONS } from "@basidekick/baskstream";
import { CHECK_OPERATIONS, checkHtml, evaluate, facetRange, nameStyle, runCheck } from "../dist/check.js";
import { STARTER_RULES, loadRules } from "../dist/check-rules.js";
import { startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bask-check-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NET = "slot:/Drivers/BacnetNetwork";

/** Runs the starter rules (or the given ones) on a site, after `plant` has changed the station. */
async function check(site, plant, rules = loadRules()) {
  const { station, client, close } = await startStation({ site });
  try {
    plant?.(station.state.nodes);
    return await runCheck(client, rules);
  } finally {
    await close();
  }
}
const found = (result, rule) => result.findings.filter((f) => f.rule === rule);
const places = (result, rule) => found(result, rule).map((f) => f.where);

test("Northgate: the dead VAV, the failed chiller and the forgotten override are found", async () => {
  const result = await check("northgate");
  assert.deepEqual(places(result, "devices.down"), [`${NET}/VAV_107`]);
  assert.equal(found(result, "devices.down")[0].severity, "error");
  assert.deepEqual(places(result, "points.fault"), [`${NET}/CHW_Plant/points/Chiller2Status`]);
  // The override is sixteen hours old, so it is listed once, as a long one.
  assert.deepEqual(places(result, "points.overriddenLong"), [`${NET}/AHU_02/points/SupplyFanSpeed`]);
  assert.equal(found(result, "points.overriddenLong")[0].severity, "warning");
  assert.deepEqual(places(result, "points.overridden"), []);
  assert.equal(result.rules.find((r) => r.id === "points.overridden").covered, 1);
  // The six points of the dead VAV are not listed again under "down" and "stale".
  assert.deepEqual(places(result, "points.down"), []);
  assert.deepEqual(places(result, "points.stale"), []);
  assert.equal(result.rules.find((r) => r.id === "points.down").covered, 6);
  // OfficeHours drives AHU-1's logic; the other two schedules drive nothing.
  assert.deepEqual(places(result, "schedules.unreferenced"), ["slot:/Schedules/LobbyLighting", "slot:/Schedules/ZoneSetback"]);
  // The admin account is named for review, and nothing was tried against it.
  assert.ok(places(result, "security.defaultAccounts").includes("admin"));
  assert.ok(found(result, "security.defaultAccounts").every((f) => f.severity === "review" && /did not test/.test(f.message)));
  assert.ok(!places(result, "security.defaultAccounts").includes("guest"), "a disabled account is left alone");
  assert.equal(result.summary.errors, 2);
  assert.equal(result.summary.errors, result.findings.filter((f) => f.severity === "error").length);
  // Errors come first.
  assert.deepEqual(result.findings.slice(0, 2).map((f) => f.severity), ["error", "error"]);
});

test("the other buildings: their planted faults are found too", async () => {
  const riverside = await check("riverside");
  assert.deepEqual(places(riverside, "points.fault"), [`${NET}/HW_Plant/points/Boiler2Status`]);

  const harbor = await check("harbor");
  assert.deepEqual(places(harbor, "points.fault"), [`${NET}/Rack_A/points/Compressor3Status`]);
  assert.deepEqual(places(harbor, "points.noUnits"), ["slot:/Drivers/ModbusNetwork/Meter_Main/points/PowerFactor"]);

  const summit = await check("summit");
  assert.deepEqual(places(summit, "devices.down"), [`${NET}/CRAC_3`]);
  assert.deepEqual(places(summit, "points.down"), []);

  // A new station: the BACnet network has no devices yet, and nothing is an error.
  const eastgate = await check("eastgate");
  assert.deepEqual(places(eastgate, "networks.empty"), [NET]);
  assert.equal(eastgate.summary.errors, 0);
});

test("faults planted for the test are found: addresses, names, missing points, histories and schedules", async () => {
  const result = await check("northgate", (nodes) => {
    nodes.get(`${NET}/VAV_102`).props.address.encoded = nodes.get(`${NET}/VAV_101`).props.address.encoded;
    nodes.get(`${NET}/VAV_108/points/ZoneTemp`).name = "ZnTmp";
    nodes.get(`${NET}/VAV_103/points/ZoneTemp`).hasHistory = false;
    nodes.get(`${NET}/VAV_104`).name = "Vav104Box";
    nodes.get(`${NET}/VAV_106/points`).children = [];
    nodes.get("slot:/Schedules/ZoneSetback").week = {};
  });
  assert.deepEqual(places(result, "devices.duplicateAddress"), [`${NET}/VAV_101`, `${NET}/VAV_102`]);
  assert.match(found(result, "devices.duplicateAddress")[0].message, /MSTP 2:11 is also on .*VAV_102/);

  const odd = found(result, "names.pointSet").find((f) => f.where === `${NET}/VAV_108`);
  assert.ok(odd, "VAV_108 lacks the ZoneTemp its siblings have");
  assert.match(odd.message, /has no ZoneTemp, which 5 of the 6 other VAV_\* devices have; it has ZnTmp, which none of them has/);

  assert.deepEqual(places(result, "histories.missing"), [`${NET}/VAV_103/points/ZoneTemp`]);
  assert.match(found(result, "histories.missing")[0].message, /6 of the 6 other points named ZoneTemp have one/);

  assert.deepEqual(places(result, "names.devices"), [`${NET}/VAV_104`]);
  assert.match(found(result, "names.devices")[0].message, /Vav104Box is written as joined words; 10 of its 10 siblings are written with underscores/);

  assert.deepEqual(places(result, "devices.noPoints"), [`${NET}/VAV_106`]);
  assert.deepEqual(places(result, "schedules.noEvents"), ["slot:/Schedules/ZoneSetback"]);
});

test("a check only reads: every operation it sends is ungated, and the demo's graphics rule is skipped with the reason", async () => {
  for (const op of CHECK_OPERATIONS) assert.equal(OPERATIONS[op].gate, "none", op);
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const sent = new Set();
    const call = client.call.bind(client);
    client.call = (op, ...rest) => (sent.add(op), call(op, ...rest));
    const before = { files: station.state.files.size, audit: station.state.audit.length, writes: station.state.counters.writes };
    const result = await runCheck(client, loadRules());
    assert.deepEqual([...sent].filter((op) => !CHECK_OPERATIONS.includes(op)), []);
    assert.deepEqual({ files: station.state.files.size, audit: station.state.audit.length, writes: station.state.counters.writes }, before);
    // The simulated station is API 1.11: it has no graphics inventory, and the check says so and goes on.
    const graphics = result.rules.find((r) => r.id === "graphics.qa");
    assert.match(graphics.skipped, /does not have graphics_inventory/);
    assert.equal(result.summary.skipped, 2); // graphics, and the one behaviour rule this building has no points for
  } finally {
    await close();
  }
});

test("a rule file adds rules, changes starter rules by id, turns them off, or replaces the set", async () => {
  const file = join(dir, "rules.json");
  writeFileSync(file, JSON.stringify({ rules: [
    { id: "points.overridden", severity: "error" },
    { id: "points.overriddenLong", off: true },
    { id: "security.defaultAccounts", off: true },
    { id: "site.hotZones", group: "Site standard", title: "Zone above 76 °F", severity: "warning", query: { bql: "select slotPath, out.value from control:NumericPoint where name = 'ZoneTemp'" }, test: { is: "compare", all: [{ field: "out.value", op: "above", value: 76 }] }, message: "reads {out.value}, above 76" }
  ] }));
  const rules = loadRules(file);
  assert.equal(rules.length, STARTER_RULES.length - 1);
  assert.equal(rules.find((r) => r.id === "points.overridden").severity, "error");
  assert.equal(rules.find((r) => r.id === "points.overridden").query.bql, STARTER_RULES.find((r) => r.id === "points.overridden").query.bql);
  const result = await check("northgate", undefined, rules);
  assert.equal(found(result, "points.overridden")[0].severity, "error");
  assert.deepEqual(places(result, "security.defaultAccounts"), []);
  assert.deepEqual(places(result, "site.hotZones"), [`${NET}/VAV_105/points/ZoneTemp`]);
  assert.match(found(result, "site.hotZones")[0].message, /^reads 7[89]\.\d+, above 76$/);

  writeFileSync(file, JSON.stringify({ replace: true, rules: [{ id: "only", group: "Mine", title: "Device down", severity: "error", query: { bql: "select slotPath from driver:Device where status.down" }, test: { is: "found" } }] }));
  const only = await check("northgate", undefined, loadRules(file));
  assert.equal(only.rules.length, 1);
  assert.deepEqual(only.findings.map((f) => [f.where, f.message]), [[`${NET}/VAV_107`, "Device down"]]);

  writeFileSync(file, JSON.stringify([{ id: "bad", group: "Mine", title: "No test", severity: "fatal", query: { bql: "select name from baja:Component" } }]));
  assert.throws(() => loadRules(file), /rule "bad" needs a severity: error, warning, review, info/);
  writeFileSync(file, "{ not json");
  assert.throws(() => loadRules(file), /could not be read as JSON/);
});

test("a rule the station refuses is skipped, and the rest still run", async () => {
  const rules = [...loadRules(), { id: "mine.bad", group: "Mine", title: "A type this station lacks", severity: "error", query: { bql: "select slotPath from lonworks:LonDevice" }, test: { is: "found" } }];
  const result = await check("northgate", undefined, rules);
  assert.match(result.rules.find((r) => r.id === "mine.bad").skipped, /bad_query/);
  assert.equal(places(result, "devices.down").length, 1);
});

test("the tests on rows: values outside their facets, and how a name joins its words", () => {
  assert.deepEqual(facetRange("units=u:percent;%;;;|precision=i:1|min=d:0.0|max=d:100.0"), { min: 0, max: 100 });
  assert.deepEqual(facetRange("units=u:fahrenheit;°F;(K);+459.67;*0.5555|min=d:-inf|max=d:+inf"), { min: undefined, max: undefined });
  const rule = STARTER_RULES.find((r) => r.id === "points.outsideFacets");
  const rows = [
    { slotPath: "slot:/A/Damper", "out.value": 104.2, facets: "units=u:percent|min=d:0.0|max=d:100.0" },
    { slotPath: "slot:/A/Valve", "out.value": 55, facets: "units=u:percent|min=d:0.0|max=d:100.0" },
    { slotPath: "slot:/A/Temp", "out.value": 55, facets: "units=u:fahrenheit|min=d:-inf|max=d:+inf" },
    { slotPath: "slot:/A/Speed", "out.value": -3, facets: "min=d:0.0|max=d:+inf" }
  ];
  assert.deepEqual(evaluate(rule, rows), [
    { where: "slot:/A/Damper", message: "reads 104.2, outside its facets (0 to 100)" },
    { where: "slot:/A/Speed", message: "reads -3, outside its facets (0 to no maximum)" }
  ]);
  assert.equal(nameStyle("Supply_Air_Temp"), "with underscores");
  assert.equal(nameStyle("SupplyAirTemp"), "as joined words");
  assert.equal(nameStyle("Airflow"), undefined);
});

test("from the command line: table, JSON and an HTML page, with exit code 1 when there are errors", async () => {
  const { station, close } = await startStation({ site: "northgate" });
  const env = { ...process.env, BASKSTREAM_CONFIG_DIR: dir, BASKSTREAM_PASSWORD: station.password, FORCE_COLOR: "0" };
  const bask = (...args) => run(process.execPath, [main, ...args], { env }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));
  try {
    assert.equal((await bask("login", station.url, "-u", station.user, "--name", "check")).code, 0);
    // No --allow-writes anywhere here.
    const shown = await bask("check");
    assert.equal(shown.code, 1, shown.err);
    assert.match(shown.out, /Northgate {2}slot:\/ · \d+ rules/);
    assert.match(shown.out, /2 errors, 3 warnings, \d+ to review, \d+ info/);
    assert.match(shown.out, /error +Devices +Drivers\/BacnetNetwork\/VAV_107 +down/);
    assert.match(shown.out, /skipped {2}graphics\.qa/);

    const page = join(dir, "out", "northgate.html");
    const json = await bask("check", "-o", "json", "--html", page);
    assert.equal(json.code, 1);
    const result = JSON.parse(json.out);
    assert.equal(result.station, "Northgate");
    assert.equal(result.summary.errors, 2);
    assert.equal(result.rules.length, STARTER_RULES.length);
    const html = readFileSync(page, "utf8");
    assert.match(html, /<h1>Station check: Northgate<\/h1>/);
    assert.match(html, /VAV_107/);
    assert.match(html, /Not checked: Graphics punch list/);
    // One file with nothing outside it.
    assert.doesNotMatch(html, /<script|<link|<img|src=|href=|url\(|@import/);
    assert.equal(html, checkHtml(result));

    const csv = await bask("check", "-o", "csv", "--under", "Drivers/BacnetNetwork/CHW_Plant");
    assert.equal(csv.code, 1);
    // (The simulated station lists its users whatever branch is asked for; a real one lists those under it.)
    assert.deepEqual(csv.out.trim().split("\n").filter((line) => !line.startsWith("review,")), ["severity,group,rule,where,message", "error,Points,points.fault,slot:/Drivers/BacnetNetwork/CHW_Plant/points/Chiller2Status,in fault: Off {fault}"]);

    // A branch with nothing wrong in it: exit code 0.
    const clean = await bask("check", "--under", "Drivers/BacnetNetwork/AHU_01");
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /no errors, no warnings/);

    const bad = await bask("check", "--rules", join(dir, "missing.json"));
    assert.equal(bad.code, 1);
    assert.match(bad.err, /missing\.json could not be read as JSON/);
  } finally {
    await close();
  }
});
