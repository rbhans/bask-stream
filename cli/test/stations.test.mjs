// More than one station in a run (docs/ROADMAP.md, E3 and E5): bask diff between two saved
// stations, and bask fleet check and bask fleet diff across saved profiles. All of it only reads.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fleetProfiles, parseSide, standardFiles } from "../dist/stations.js";
import { startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bask-stations-"));
const NET = "slot:/Drivers/BacnetNetwork";
let north, south, harbor;
const env = () => ({ ...process.env, BASKSTREAM_CONFIG_DIR: dir, BASKSTREAM_PASSWORD: north.station.password, FORCE_COLOR: "0" });
const bask = (...args) => run(process.execPath, [main, ...args], { env: env(), maxBuffer: 32 * 1024 * 1024 }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));

before(async () => {
  // Two copies of one building, the second changed a little, and a different building.
  [north, south, harbor] = await Promise.all([startStation({ site: "northgate" }), startStation({ site: "northgate" }), startStation({ site: "harbor" })]);
  south.station.state.nodes.get(`${NET}/VAV_102`).props.address.encoded = "MSTP 2:99";
  south.station.state.nodes.get(`${NET}/AHU_02/points/SupplyFanSpeed`).override = undefined;
  for (const [name, started] of [["north", north], ["south", south], ["harbor", harbor]]) assert.equal((await bask("login", started.station.url, "-u", started.station.user, "--name", name)).code, 0);
  assert.equal((await bask("use", "north")).code, 0);
});
after(async () => {
  await Promise.all([north, south, harbor].map((started) => started?.close()));
  rmSync(dir, { recursive: true, force: true });
});

test("bask diff compares two saved stations in one run, and a station with an export file", async () => {
  const same = await bask("diff", "north:Drivers/BacnetNetwork/AHU_01", "south:Drivers/BacnetNetwork/AHU_01");
  assert.equal(same.code, 0, same.out + same.err);
  assert.match(same.out, /north:slot:\/Drivers\/BacnetNetwork\/AHU_01 → south:slot:\/Drivers\/BacnetNetwork\/AHU_01\nNo differences\./);

  const differ = await bask("diff", "north:Drivers/BacnetNetwork", "south:slot:/Drivers/BacnetNetwork", "-o", "json");
  assert.equal(differ.code, 1);
  const result = JSON.parse(differ.out);
  assert.deepEqual([result.a, result.b], [`north:${NET}`, `south:${NET}`]);
  assert.deepEqual(result.differences, [{ path: "VAV_102", change: "changed", what: "property", name: "address", from: "MSTP 2:12", to: "MSTP 2:99" }]);

  // One side with no profile is the current station (north); the same branch on two stations, either way round.
  const mixed = await bask("diff", "south:Drivers/BacnetNetwork", "Drivers/BacnetNetwork", "-o", "csv");
  assert.deepEqual(mixed.out.trim().split("\n"), ["change,path,what,name,from,to", "changed,VAV_102,property,address,MSTP 2:99,MSTP 2:12"]);

  // A station against an export file, and the file against a different station.
  const file = join(dir, "north-net.json");
  writeFileSync(file, (await bask("export", "Drivers/BacnetNetwork")).out);
  assert.equal((await bask("diff", file, "north:Drivers/BacnetNetwork")).code, 0);
  const other = await bask("diff", file, "south:Drivers/BacnetNetwork");
  assert.equal(other.code, 1);
  assert.match(other.out, /changed +VAV_102 +property address: MSTP 2:12 → MSTP 2:99/);

  // Different buildings differ by whole devices.
  const far = await bask("diff", "north:Drivers/BacnetNetwork", "harbor:Drivers/BacnetNetwork", "-o", "json");
  assert.equal(far.code, 1);
  assert.ok(JSON.parse(far.out).summary.components.removed >= 11);
  // Nothing was changed on either station.
  assert.equal(north.station.state.counters.writes + south.station.state.counters.writes, 0);
});

test("a side is a file, profile:branch, or a branch of the current station", () => {
  const profiles = ["north", "slot", "my site"];
  assert.deepEqual(parseSide("north:Drivers/Net", profiles), { profile: "north", ord: "slot:/Drivers/Net", label: "north:slot:/Drivers/Net" });
  assert.deepEqual(parseSide("north:slot:/Drivers", profiles), { profile: "north", ord: "slot:/Drivers", label: "north:slot:/Drivers" });
  // An ORD's own scheme is never taken for a profile, even when a profile has that name.
  assert.deepEqual(parseSide("slot:/Drivers", profiles), { ord: "slot:/Drivers", label: "slot:/Drivers" });
  assert.deepEqual(parseSide("nowhere:Drivers", profiles), { ord: "slot:/nowhere:Drivers", label: "slot:/nowhere:Drivers" });
  assert.deepEqual(parseSide("my site:Drivers", profiles).profile, "my site");
  const file = join(dir, "side.json");
  writeFileSync(file, "{}");
  assert.deepEqual(parseSide(file, profiles), { file, label: file });
});

test("bask fleet check runs the check on every saved station and lists where each has errors and warnings", async () => {
  const shown = await bask("fleet", "check");
  assert.equal(shown.code, 1, shown.err);
  assert.match(shown.out, /north +Northgate +2 +2 +\d+ +\d+ +1 rule skipped/);
  assert.match(shown.out, /south +Northgate +2 +1 +\d+ +\d+/);
  assert.match(shown.out, /harbor +Harbor +1 +\d+ +\d+ +\d+/);
  assert.match(shown.out, /error +north +Devices +Drivers\/BacnetNetwork\/VAV_107 +down/);
  // Where one departs: the forgotten override is on north and not on south.
  assert.match(shown.out, /warning +north +Points +AHU_02\/points\/SupplyFanSpeed +overridden for 16 hours/);
  assert.doesNotMatch(shown.out, /warning +south +Points +AHU_02/);

  const json = JSON.parse((await bask("fleet", "check", "north", "harbor", "-o", "json")).out);
  assert.deepEqual(json.stations.map((s) => [s.profile, s.station, s.result.summary.errors]), [["north", "Northgate", 2], ["harbor", "Harbor", 1]]);
  assert.equal(json.failed, true);

  // A branch with nothing wrong on either: exit code 0. A rule file applies to all of them.
  const clean = await bask("fleet", "check", "north", "south", "--under", "Drivers/BacnetNetwork/AHU_01");
  assert.equal(clean.code, 0, clean.out);
  const rules = join(dir, "rules.json");
  writeFileSync(rules, JSON.stringify({ replace: true, rules: [{ id: "only", group: "Mine", title: "Device down", severity: "error", query: { bql: "select slotPath from driver:Device where status.down" }, test: { is: "found" } }] }));
  const csv = await bask("fleet", "check", "north", "south", "--rules", rules, "-o", "csv");
  assert.deepEqual(csv.out.trim().split("\n"), ["profile,station,severity,group,rule,where,message", `north,Northgate,error,Mine,only,${NET}/VAV_107,Device down`, `south,Northgate,error,Mine,only,${NET}/VAV_107,Device down`]);

  const unknown = await bask("fleet", "check", "nowhere");
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /No profile named "nowhere"\. Saved profiles: north, south, harbor\./);
});

test("a station that cannot be reached is listed with the reason, and the others are still checked", async () => {
  const gone = await startStation({ site: "summit" });
  assert.equal((await bask("login", gone.station.url, "-u", gone.station.user, "--name", "gone")).code, 0);
  await gone.close();
  try {
    const shown = await bask("fleet", "check", "north", "gone", "-o", "json");
    assert.equal(shown.code, 1);
    const result = JSON.parse(shown.out);
    assert.equal(result.stations[0].result.summary.errors, 2);
    assert.ok(result.stations[1].error && !result.stations[1].result);
  } finally {
    await bask("logout", "--remove", "-p", "gone");
  }
});

test("bask fleet diff compares every station with a folder of export files", async () => {
  const standard = join(dir, "standard");
  mkdirSync(standard);
  writeFileSync(join(standard, "ahu.json"), (await bask("export", "Drivers/BacnetNetwork/AHU_01")).out);
  writeFileSync(join(standard, "vav.json"), (await bask("export", "Drivers/BacnetNetwork/VAV_102")).out);
  writeFileSync(join(standard, "notes.json"), '{"not": "an export"}');
  writeFileSync(join(standard, "readme.txt"), "the standard");
  assert.deepEqual(standardFiles(standard).files.map((f) => f.doc.root), [`${NET}/AHU_01`, `${NET}/VAV_102`]);
  assert.deepEqual(standardFiles(standard).ignored, [join(standard, "notes.json")]);

  const same = await bask("fleet", "diff", "north", "--against", standard);
  assert.equal(same.code, 0, same.out + same.err);
  assert.match(same.out, /north +Northgate +ahu\.json +\S*BacnetNetwork\/AHU_01 +same/);

  const shown = await bask("fleet", "diff", "north", "south", "harbor", "--against", standard);
  assert.equal(shown.code, 1);
  assert.match(shown.out, /south +Northgate +ahu\.json +\S*BacnetNetwork\/AHU_01 +same/);
  assert.match(shown.out, /south +Northgate +vav\.json +\S*BacnetNetwork\/VAV_102 +1 difference: 0 added, 0 removed, 1 changed/);
  assert.match(shown.out, /south +vav\.json +changed +\. +property address: MSTP 2:12 → MSTP 2:99/);
  // Harbor has neither branch: each is reported as not compared, not as empty.
  assert.match(shown.out, /harbor +Harbor +ahu\.json +\S*BacnetNetwork\/AHU_01 +not compared: /);

  const json = JSON.parse((await bask("fleet", "diff", "north", "south", "--against", join(standard, "vav.json"), "-o", "json")).out);
  assert.deepEqual(json.stations.map((s) => [s.profile, s.files.map((f) => f.result.same)]), [["north", [true]], ["south", [false]]]);
  assert.equal(json.differs, true);

  const none = await bask("fleet", "diff", "--against", join(dir, "nowhere"));
  assert.equal(none.code, 1);
  assert.match(none.err, /is not there\. --against takes a folder of export files/);
  // With no profiles named, every saved station is covered once, the current one first.
  process.env.BASKSTREAM_CONFIG_DIR = dir;
  assert.deepEqual(fleetProfiles([]), ["north", "south", "harbor"]);
  delete process.env.BASKSTREAM_CONFIG_DIR;
});

test("the all-stations view is still what bask fleet alone opens", async () => {
  const shown = await bask("fleet");
  assert.equal(shown.code, 1);
  assert.match(shown.err, /The all-stations view needs a terminal\./);
  const help = await bask("fleet", "--help");
  assert.match(help.out, /check \[options\] \[profiles\.\.\.\]/);
  assert.match(help.out, /diff \[options\] \[profiles\.\.\.\]/);
  assert.match(help.out, /--demo/);
});
