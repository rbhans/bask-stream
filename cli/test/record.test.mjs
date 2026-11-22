// bask record and bask replay (docs/ROADMAP.md, H): a station is read into a site file, and the demo
// station plays the file back: the same tree, the values it had, its alarms and schedules, and a day
// of history that repeats. With --scramble the names that say whose building it is are replaced.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BaskStreamClient, OPERATIONS } from "@basidekick/baskstream";
import { runCheck } from "../dist/check.js";
import { loadRules } from "../dist/check-rules.js";
import { parseRecording, playback } from "../dist/demo/recorded.js";
import { startDemoStation } from "../dist/demo/station.js";
import { inferModel, readEvidence } from "../dist/model.js";
import { RECORD_OPERATIONS, recordStation, recordingSummary, scrambler } from "../dist/record.js";
import { startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bask-record-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NET = "slot:/Drivers/BacnetNetwork";

/** Starts the demo station on a recording and connects to it. */
async function replay(recording) {
  const station = await startDemoStation({ live: false, recording });
  const client = await BaskStreamClient.connect({ station: station.url, username: station.user, password: station.password });
  return { station, client, async close() { client.close(); await station.close(); } };
}
const tree = async (client) => {
  const out = [];
  const walk = (node) => { out.push(`${node.ord} ${node.typeSpec} ${node.kind}`); for (const child of node.children ?? []) walk(child); };
  for (const top of (await client.browse("slot:/", { depth: 1 })).children) walk(await client.browse(top.ord, { depth: 4 }));
  return out.sort();
};

test("a recording played back is the station it was made from: tree, values, alarms, schedules and a day of history", async () => {
  // A live station, so its histories have a day's swing in them.
  const original = await startStation({ site: "northgate", live: true });
  let recording;
  try {
    const before = { audit: original.station.state.audit.length, writes: original.station.state.counters.writes };
    const sent = new Set();
    const call = original.client.call.bind(original.client);
    original.client.call = (op, ...rest) => (sent.add(op), call(op, ...rest));
    ({ recording } = await recordStation(original.client));
    // Recording only reads.
    for (const op of RECORD_OPERATIONS) assert.equal(OPERATIONS[op].gate, "none", op);
    assert.deepEqual([...sent].filter((op) => !RECORD_OPERATIONS.includes(op)), []);
    assert.deepEqual({ audit: original.station.state.audit.length, writes: original.station.state.counters.writes }, before);
    assert.deepEqual([recording.format, recording.version, recording.station, recording.scrambled, recording.hours], ["bask-site", 1, "Northgate", false, 24]);
    assert.match(recordingSummary(recording), /^\d+ components, 84 points \(6\d with 24 hours of history\), 3 schedules, 7 open alarms$/);

    const played = await replay(parseRecording(JSON.stringify(recording), "site.json"));
    try {
      assert.equal(played.station.station, "Northgate");
      // The same components, of the same types and kinds, in the same places.
      assert.deepEqual(await tree(played.client), await tree(original.client));
      // What is not moving reads as it did: setpoints, states, and the faults and overrides that were there.
      const steady = [`${NET}/VAV_101/points/ZoneSetpoint`, `${NET}/AHU_01/points/SupplyFanStatus`, `${NET}/VAV_106/points/OccupancyMode`, `${NET}/CHW_Plant/points/Chiller2Status`, `${NET}/AHU_02/points/SupplyFanSpeed`];
      const pick = (points) => points.map((p) => [p.value, p.displayValue, p.state, p.facets.units]);
      assert.deepEqual(pick(await played.client.read(steady)), pick(await original.client.read(steady)));
      assert.deepEqual((await played.client.read([`${NET}/CHW_Plant/points/Chiller2Status`, `${NET}/AHU_02/points/SupplyFanSpeed`])).map((p) => p.state), ["fault", "overridden"]);
      // The dead device is still dead, and its points with it.
      assert.equal((await played.client.browse(`${NET}/VAV_107`)).status, "{down}");
      // The same open alarms, as old as they were.
      const alarms = async (client) => (await client.alarms({ scope: "open", order: "oldest" })).alarms.map((a) => [a.sources[0], a.message, a.alarmClass, a.priority, a.ackState, a.sourceState]).sort();
      assert.deepEqual(await alarms(played.client), await alarms(original.client));
      // Schedules keep their week, and tags are where they were.
      const week = async (client) => (await client.schedule("slot:/Schedules/OfficeHours")).tree.week.monday.day.map((e) => e.display);
      assert.deepEqual(await week(played.client), await week(original.client));
      assert.deepEqual(played.station.state.nodes.get(`${NET}/AHU_01`).tags, ["hs:ahu", "hs:equip"]);

      // A day of history: a moving point is within a fraction of a degree of the original through the day, and it does move.
      const sat = `${NET}/AHU_01/points/SupplyAirTemp`;
      const end = Math.floor(Date.now() / 900000) * 900000;
      const series = async (client) => (await client.historyRollup(sat, { start: end - 20 * 3600000, end, interval: 900000 })).histories[0].buckets.map((b) => b.avg);
      const [was, is] = [await series(original.client), await series(played.client)];
      assert.equal(is.length, was.length);
      assert.ok(is.length >= 79);
      assert.ok(Math.max(...was.map((v, i) => Math.abs(v - is[i]))) < 0.5, "the played history follows the recorded one");
      assert.ok(Math.max(...is) - Math.min(...is) > 0.5, "and is not a flat line");

      // It is a station like any other: a check finds the faults that were recorded with it.
      const result = await runCheck(played.client, loadRules());
      const places = (rule) => result.findings.filter((f) => f.rule === rule).map((f) => f.where);
      assert.deepEqual(places("devices.down"), [`${NET}/VAV_107`]);
      assert.deepEqual(places("points.fault"), [`${NET}/CHW_Plant/points/Chiller2Status`]);
      assert.equal(places("points.overridden").length + places("points.overriddenLong").length, 1);
    } finally {
      await played.close();
    }
  } finally {
    await original.close();
  }
});

test("--scramble replaces the words that say whose building it is, the same way each time, and keeps what a thing is", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const { nodes } = station.state;
    // A building with its owner in its names.
    const rename = (ord, name) => {
      const node = nodes.get(ord);
      const parent = nodes.get(ord.slice(0, ord.lastIndexOf("/")));
      const to = `${parent.ord}/${name}`;
      for (const [key, value] of [...nodes]) {
        if (key !== ord && !key.startsWith(`${ord}/`)) continue;
        nodes.delete(key);
        value.ord = to + key.slice(ord.length);
        value.children = value.children.map((child) => to + child.slice(ord.length));
        nodes.set(value.ord, value);
      }
      Object.assign(node, { name, display: `Hartwell ${name}` });
      parent.children = parent.children.map((child) => (child === ord ? to : child));
    };
    rename(`${NET}/AHU_01`, "Hartwell_Annex_AHU_01");
    rename(`${NET}/VAV_101`, "HartwellLobby_VAV_101");
    nodes.get(`${NET}/Hartwell_Annex_AHU_01`).tags.push("hartwell:tenant");
    station.state.raise(`${NET}/HartwellLobby_VAV_101/points/ZoneTemp`, "Call Dana Hartwell on 555-0142: lobby too warm", { cls: "hartwellTenants" });

    const { recording } = await recordStation(client, { scramble: true, salt: "one" });
    const text = JSON.stringify(recording);
    assert.equal(recording.station, "Recorded");
    assert.equal(recording.scrambled, true);
    for (const secret of ["Hartwell", "hartwell", "Annex", "Lobby", "Dana", "555-0142", "Northgate"]) assert.ok(!text.includes(secret), `${secret}: ${text.slice(Math.max(0, text.indexOf(secret) - 80), text.indexOf(secret) + 60)}`);
    // What a thing is stays readable: the kind, the number, the point's role.
    const ahu = recording.components.find((c) => /_AHU_01$/.test(c.name));
    assert.match(ahu.name, /^[A-Z][a-z]+_[A-Z][a-z]+_AHU_01$/);
    assert.deepEqual(ahu.tags, ["hs:ahu", "hs:equip"]);
    const vav = recording.components.find((c) => /_VAV_101$/.test(c.name));
    // The same word is the same made-up word wherever it was.
    assert.equal(vav.name.slice(0, ahu.name.indexOf("_")), ahu.name.split("_")[0]);
    assert.ok(recording.components.some((c) => c.path === `Drivers/BacnetNetwork/${ahu.name}/points/SupplyAirTemp`));
    assert.ok(recording.components.some((c) => c.path === "Drivers/BacnetNetwork/VAV_102/points/ZoneTemp"));
    // Alarm text is free text: it is rebuilt, not copied.
    const alarm = recording.alarms.find((a) => a.source === `Drivers/BacnetNetwork/${vav.name}/points/ZoneTemp`);
    assert.equal(alarm.message, `Offnormal alarm: ${vav.name} ZoneTemp`);
    assert.doesNotMatch(alarm.alarmClass, /hartwell/i);

    // Another salt gives other words, so two recordings cannot be matched by their made-up names.
    const again = (await recordStation(client, { scramble: true, salt: "two" })).recording;
    assert.notEqual(again.components.find((c) => /_AHU_01$/.test(c.name)).name, ahu.name);
    assert.equal(again.components.length, recording.components.length);

    // The scrambled site still works as a station: the same number of components, and its equipment is still recognised by kind.
    const played = await replay(recording);
    try {
      // (One more than the original: the alarm class of the alarm raised above is a component here.)
      assert.equal(played.station.state.nodes.size, station.state.nodes.size + 1);
      for (const node of played.station.state.nodes.values()) node.tags = [];
      const kinds = inferModel((await readEvidence(played.client, "slot:/")).evidence).map((e) => e.kind).sort();
      assert.deepEqual([...new Set(kinds)], ["ahu", "chilledWaterPlant", "vav"]);
      assert.equal(kinds.length, 11);
    } finally {
      await played.close();
    }

    const fake = scrambler("s");
    assert.equal(fake("SupplyAirTemp"), "SupplyAirTemp");
    assert.equal(fake("AHU_01"), "AHU_01");
    assert.match(fake("MercyWest_RTU-3"), /^[A-Z][a-z]{4}[A-Z][a-z]{3}_RTU-3$/);
    assert.equal(fake("mercy"), fake("Mercy").toLowerCase());
    assert.equal(fake("MERCY"), fake("mercy").toUpperCase());
  } finally {
    await close();
  }
});

test("a recorded history repeats, and a gap in it takes the record before", () => {
  const sim = playback({ start: 0, interval: 1000, values: [10, 20, null, 40] });
  assert.equal(sim(0), 10);
  assert.equal(sim(500), 15);
  // The gap at the third step holds the second's value.
  assert.equal(sim(2000), 20);
  assert.equal(sim(3000), 40);
  // After the last step it starts again, and before the first it is the same day earlier.
  assert.equal(sim(4000), 10);
  assert.equal(sim(-1000), 40);
  assert.equal(playback({ start: 0, interval: 1000, values: [null, null] }), undefined);
  assert.throws(() => parseRecording('{"format": "bask-export"}', "x.json"), /x\.json is not a recorded site/);
});

test("from the command line: record a branch to a file, and replay --serve runs it as a station", async () => {
  const { station, close } = await startStation({ site: "harbor" });
  const env = { ...process.env, BASKSTREAM_CONFIG_DIR: dir, BASKSTREAM_PASSWORD: station.password, FORCE_COLOR: "0" };
  const bask = (...args) => run(process.execPath, [main, ...args], { env, cwd: dir, maxBuffer: 32 * 1024 * 1024 }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));
  let served;
  try {
    assert.equal((await bask("login", station.url, "-u", station.user, "--name", "harbor")).code, 0);
    // No --allow-writes: recording only reads.
    const made = await bask("record", "--hours", "6", "--interval", "30m");
    assert.equal(made.code, 0, made.err);
    assert.match(made.err, /✓ Harbor-site\.json: \d+ components, \d+ points \(\d+ with 6 hours of history\), \d+ schedules, \d+ open alarms\. Play it back with: bask replay Harbor-site\.json/);
    const whole = parseRecording(readFileSync(join(dir, "Harbor-site.json"), "utf8"), "Harbor-site.json");
    assert.ok([12, 13].includes(whole.components.find((c) => c.history).history.values.length));

    const branch = await bask("record", "--under", "Drivers/BacnetNetwork/Freezer_1", "--out", join(dir, "sites", "freezer.json"), "--scramble", "-o", "json");
    assert.equal(branch.code, 0, branch.err);
    assert.deepEqual([JSON.parse(branch.out).station, JSON.parse(branch.out).scrambled, JSON.parse(branch.out).components], ["Recorded", true, 8]);

    // The station runs until it is stopped; other commands use the profile it saves.
    served = spawn(process.execPath, [main, "replay", join(dir, "Harbor-site.json"), "--serve", "--port", "0"], { env, cwd: dir });
    const line = await new Promise((resolve, reject) => {
      let out = "";
      served.stdout.on("data", (chunk) => { out += chunk; if (out.includes("\n")) resolve(out); });
      served.once("exit", (code) => reject(new Error(`replay ended with code ${code}: ${out}`)));
    });
    assert.match(line, /✓ Harbor at http:\/\/127\.0\.0\.1:\d+ .*profile demo-recorded/);
    const read = await bask("-p", "demo-recorded", "read", "Drivers/BacnetNetwork/Freezer_1/points/BoxSetpoint", "-o", "json");
    assert.equal(read.code, 0, read.err);
    assert.equal(JSON.parse(read.out)[0].value, -10);
    const status = await bask("-p", "demo-recorded", "status", "-o", "json");
    assert.equal(JSON.parse(status.out).capabilities.station, "Harbor");

    const wrong = await bask("replay", join(dir, "sites", "nothing.json"), "--serve");
    assert.equal(wrong.code, 1);
  } finally {
    served?.kill("SIGINT");
    await close();
  }
});
