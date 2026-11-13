// What each demo building is for: Northgate is finished (a graphic for every piece of equipment),
// Harbor has nothing drawn (an agent draws it), and Eastgate is a new station whose BACnet network
// an agent discovers and adds. The agent's work is done through the bask commands, as an agent.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listGraphics, loadGraphic } from "../dist/graphics.js";
import { Link } from "../dist/link.js";
import { readGraphic } from "../dist/tui/symbols/graphic.js";
import { mount, startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const configDir = mkdtempSync(join(tmpdir(), "bask-sites-"));
process.env.BASKSTREAM_CONFIG_DIR = configDir;
after(() => rmSync(configDir, { recursive: true, force: true }));

/** Runs bask on a profile, as a person or (with `agent`) as an AI agent. */
const baskOn = (profile, agent) => (...args) =>
  run(process.execPath, [main, "-p", profile, ...args], { env: { ...process.env, BASKSTREAM_CONFIG_DIR: configDir, BASKSTREAM_PASSWORD: "demo", FORCE_COLOR: "0", ...(agent ? { BASK_AGENT: agent, BASK_ON_BEHALF_OF: "pat" } : {}) } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e) => ({ code: e.code, out: e.stdout + e.stderr })
  );
const NET = "slot:/Drivers/BacnetNetwork";

test("Northgate is finished: every device is in a graphic", async () => {
  const { station, client, close } = await startStation({ site: "northgate" });
  try {
    const names = (await listGraphics(client)).map((g) => g.name);
    assert.equal(names.length, 12);
    const drawn = new Set();
    for (const name of names) for (const ord of readGraphic(await loadGraphic(client, name)).plan.points) drawn.add(ord.split("/").slice(0, 4).join("/"));
    const devices = [...station.state.nodes.values()].filter((n) => n.typeSpec === "bacnet:BacnetDevice").map((n) => n.ord);
    assert.equal(devices.length, 11);
    assert.deepEqual(devices.filter((ord) => !drawn.has(ord)), []);
  } finally {
    await close();
  }
});

test("Harbor starts with nothing drawn; an agent draws it, and the work shows as the agent's", async () => {
  const { station, client, close } = await startStation({ site: "harbor" });
  try {
    assert.deepEqual(await listGraphics(client), []);
    const bask = baskOn("harbor", "Claude Code");
    assert.equal((await bask("login", station.url, "-u", station.user, "--name", "harbor")).code, 0);
    const room = (kind, n) => ({ symbol: "cold-room", label: `${kind} ${n}`, reading: `${kind}_${n}/points/BoxTemp`, open: `${kind}_${n}/points/DoorStatus` });
    const docs = {
      "cold-rooms": { title: "Cold rooms", base: NET, rows: [{ parts: [1, 2, 3, 4].map((n) => room("Freezer", n)) }, { parts: [room("Cooler", 1), room("Cooler", 2), { symbol: "plate", label: "Ammonia", reading: "Dock/points/AmmoniaLevel" }] }] },
      "rack-a": {
        title: "Compressor rack A",
        base: `${NET}/Rack_A/points`,
        rows: [{ parts: [{ id: "suction", label: "Suction", reading: "SuctionPressure", medium: "refrigerant" }, [1, 2, 3].map((n) => ({ id: `c${n}`, symbol: "compressor", label: `Compressor ${n}`, on: `Compressor${n}Status` })), { id: "discharge", label: "Discharge", reading: "DischargePressure", medium: "refrigerant" }] }],
        pipes: [...[1, 2, 3].map((n) => ({ from: "suction", to: `c${n}.suction`, medium: "refrigerant" })), ...[1, 2, 3].map((n) => ({ from: `c${n}.discharge`, to: "discharge", medium: "refrigerant" }))]
      }
    };
    for (const [name, doc] of Object.entries(docs)) {
      const file = join(configDir, `${name}.json`);
      writeFileSync(file, JSON.stringify(doc));
      const printed = await bask("graphic", "print", file);
      assert.equal(printed.code, 0, printed.out);
      assert.doesNotMatch(printed.out, /warning|error/);
      // Text has no colour: the parts a pane would colour are named under the drawing.
      assert.match(printed.out, name === "rack-a" ? /status\s+Compressor 3 fault \(coloured in the pane\)/ : /status\s+Freezer 2 alarm/);
      // An agent has to say why.
      const silent = await bask("graphic", "save", file, "--allow-writes", "-y");
      assert.equal(silent.code, 1);
      assert.match(silent.out, /reason_required/);
      const saved = await bask("graphic", "save", file, "--allow-writes", "-y", "--reason", `Drawing ${doc.title} for the operators`);
      assert.equal(saved.code, 0, saved.out);
    }
    assert.deepEqual((await listGraphics(client)).map((g) => g.name), ["cold-rooms", "rack-a"]);
    const log = (await client.agentLog({ since: Date.now() - 60000 })).records.filter((r) => r.action === "write_file");
    assert.equal(log.length, 2);
    assert.deepEqual([log[0].agent, log[0].for, log[0].outcome], ["Claude Code", "pat", "completed"]);
    assert.match(log.map((r) => r.reason).join(" "), /Drawing Cold rooms for the operators/);
    assert.equal(log.find((r) => /rack-a/.test(r.target)).target, "file:^bask/graphics/rack-a.json");
  } finally {
    await close();
  }
});

test("Eastgate is a new station: an agent discovers the BACnet network, adds the controllers and their points", async () => {
  const { station, client, close } = await startStation({ site: "eastgate" });
  try {
    assert.deepEqual(await listGraphics(client), []);
    assert.equal((await client.browse(NET, { depth: 1 })).children.length, 0);
    assert.match((await client.readFile("^config/equipment-schedule.csv", { encoding: "text" })).text, /VAV-32,VAV_32,VAV box with reheat,AHU-04,Room 132/);
    const bask = baskOn("eastgate", "Claude Code");
    assert.equal((await bask("login", station.url, "-u", station.user, "--name", "eastgate")).code, 0);

    // Looking first adds nothing.
    const looked = await bask("discover", NET, "--allow-writes", "-y", "--reason", "See what is on the network");
    assert.equal(looked.code, 0, looked.out);
    assert.match(looked.out, /DiscoveryDevice45\s+VAV_32\s+device:410232\s+VAV controller/);
    assert.match(looked.out, /Add them all: bask discover slot:\/Drivers\/BacnetNetwork --add/);
    assert.equal((await client.browse(NET, { depth: 1 })).children.length, 0);
    // The station takes a hundred results at a time; the command takes care of that.
    const job = /bask add (\S+)/.exec(looked.out)[1];
    await assert.rejects(client.addDiscovered(job, Array.from({ length: 101 }, (_v, i) => ({ slot: `DiscoveryDevice${i || ""}` })), { parent: NET }), /1 to 100/);

    const devices = await bask("discover", NET, "--add", "--allow-writes", "-y", "--reason", "Add the controllers on the mechanical schedule");
    assert.equal(devices.code, 0, devices.out);
    assert.match(devices.out, /✓ Found 46 devices on Drivers\/BacnetNetwork: added 46\./);
    assert.match(devices.out, /Next, their points: bask discover slot:\/Drivers\/BacnetNetwork --points --add/);
    assert.equal(new Link(station.url).get().show.ord, `${NET}/CHW_Plant`);

    const points = await bask("discover", NET, "--points", "--add", "--allow-writes", "-y", "--reason", "Add every controller's points");
    assert.equal(points.code, 0, points.out);
    assert.match(points.out, /BacnetNetwork\/AHU_03\s+18 points found, 18 added/);
    assert.match(points.out, /✓ Found 614 points on 46 devices: added 614\./);
    assert.equal([...station.state.nodes.values()].filter((n) => n.kind === "point").length, 614);

    // What was added reads like the equipment it is, and a second pass adds nothing twice.
    const [sat, hot, lag, fan] = await client.read([`${NET}/AHU_01/points/Supply_Air_Temp`, `${NET}/VAV_12/points/Space_Temp`, `${NET}/CH_02/points/Run_Status`, `${NET}/AHU_02/points/Supply_Fan_Speed_Command`]);
    assert.match(sat.displayValue, /^5\d\.\d °F$/);
    assert.match(hot.displayValue, /^7[78]\.\d °F$/);
    assert.equal(lag.displayValue, "Off");
    assert.match(fan.displayValue, /^\d+ %$/);
    assert.equal((await client.describe(`${NET}/AHU_02/points/Supply_Fan_Speed_Command`, "full")).writable, true);
    const again = await bask("discover", NET, "--add", "--allow-writes", "-y", "--reason", "Check for anything new", "-o", "json");
    assert.deepEqual(JSON.parse(again.out).map((o) => [o.found, o.added, o.alreadyThere]), [[46, 0, 46]]);
    const one = await bask("discover", `${NET}/VAV_07`, "--add", "--allow-writes", "-y", "--reason", "Check VAV 7");
    assert.match(one.out, /Found 14 points on Drivers\/BacnetNetwork\/VAV_07: added 0, 14 already there\./);

    // It is all the agent's, in the agent log and in the station's audit history.
    const log = (await client.agentLog({ since: Date.now() - 120000, limit: 1000 })).records;
    assert.equal(log.filter((r) => r.action === "discover" && r.change === "discover BACnet devices").length, 3);
    assert.equal(log.filter((r) => r.action === "discover" && r.change === "discover BACnet points").length, 47);
    assert.ok(log.some((r) => r.action === "apply_model_changes" && r.change === "add 46 discovered devices" && r.target === NET && r.reason === "Add the controllers on the mechanical schedule" && r.agent === "Claude Code"));
    assert.ok(log.some((r) => r.action === "apply_model_changes" && r.change === "add 18 discovered points" && r.target === `${NET}/AHU_01/points`));
    assert.ok(station.state.audit.some((a) => /\[ai-claude\] Added;slotName=Reheat_Valve_Command;value=control:NumericWritable/.test(a.value) && /VAV_32\/points/.test(a.summary)));

    // The agent can see the rules it works under, read tags, and narrow a query with and / or.
    const status = await bask("status");
    assert.match(status.out, /acting as\s+an AI agent: Claude Code for pat/);
    assert.match(status.out, /agent rules\s+point writes wait for a person's approval · every change needs --reason · 10 changes a minute · no emergency overrides/);
    const tags = JSON.parse((await bask("call", "read_tags", JSON.stringify({ ords: [`${NET}/VAV_05`] }))).out);
    assert.deepEqual(tags.targets[0].tags.filter((t) => t.dictionary === "hs").map((t) => t.id), ["hs:vav", "hs:equip"]);
    const rows = JSON.parse((await bask("query", "select slotPath from control:NumericPoint where name = 'Supply_Airflow' or name = 'Airflow' and parent.parent.name = 'VAV_03'", "-o", "json")).out).rows;
    assert.deepEqual(rows.map((r) => r[0].split("/").slice(3).join("/")), ["AHU_01/points/Supply_Airflow", "AHU_02/points/Supply_Airflow", "AHU_03/points/Supply_Airflow", "AHU_04/points/Supply_Airflow", "VAV_03/points/Airflow"]);
    assert.match((await bask("query", "select name from control:NumericPoint where name in ('a')")).out, /does not understand "name in \('a'\)"/);

    // The graphics view is ready for it: a drawing of what was just added checks out.
    const file = join(configDir, "ahu-01.json");
    writeFileSync(file, JSON.stringify({ title: "AHU-01", base: `${NET}/AHU_01/points`, rows: [{ air: [{ symbol: "louver" }, { symbol: "damper", label: "OA damper", value: "Outdoor_Air_Damper_Command" }, { symbol: "cooling-coil", label: "Cooling", value: "Cooling_Valve_Command" }, { symbol: "fan", label: "Supply fan", value: "Supply_Fan_Speed_Command", on: "Supply_Fan_Status" }, { symbol: "sensor", label: "Supply air", text: "T", reading: "Supply_Air_Temp" }], from: { label: "OA", reading: "Outdoor_Air_Temp" }, to: "SA" }] }));
    const printed = await bask("graphic", "print", file);
    assert.equal(printed.code, 0, printed.out);
    assert.doesNotMatch(printed.out, /warning|error/);
    assert.match(printed.out, /Supply fan\s+Supply air/);
    assert.match(printed.out, /Nothing wrong with it\./);
  } finally {
    await close();
  }
});

test("discovery on the other buildings finds controllers like the ones they have", async () => {
  const { station, client, close } = await startStation({ site: "harbor" });
  try {
    const discovery = await client.discover(NET);
    const found = await client.job(discovery.job);
    assert.deepEqual(found.results.map((r) => r.values.deviceName), ["Freezer_5", "Cooler_3"]);
    const plan = await client.addDiscovered(discovery.job, [{ slot: "DiscoveryDevice" }], { parent: NET });
    await client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: "k1" });
    const objects = await client.job((await client.discover(`${NET}/Freezer_5`)).job);
    assert.deepEqual(objects.results.map((r) => r.values.objectName), ["BoxTemp", "BoxSetpoint", "CoilTemp", "DefrostActive", "EvapFanStatus", "DoorStatus"]);
    assert.deepEqual(objects.results.slice(0, 4).map((r) => r.values.objectId), ["analogInput:1", "analogValue:1", "analogInput:2", "binaryInput:1"]);
    // A device that was there all along lists the points it has.
    const known = await client.job((await client.discover(`${NET}/Rack_A`)).job);
    assert.equal(known.results.length, 8);
    assert.ok(station.state.nodes.get(`${NET}/Freezer_5`).tags.includes("hs:freezer"));
  } finally {
    await close();
  }
});

test("the Explorer shows what is added behind its back, and keeps its place", async () => {
  const { station, client, close } = await startStation({ site: "eastgate" });
  const link = new Link(station.url, false);
  const app = mount(client, { view: "explorer", link }, { columns: 120, rows: 30 });
  try {
    await app.until(/Drivers/);
    await app.press("down", "right");
    await app.until(/BacnetNetwork/);
    const discovery = await client.discover(NET);
    const plan = await client.addDiscovered(discovery.job, [{ slot: "DiscoveryDevice" }, { slot: "DiscoveryDevice10" }], { parent: NET });
    await client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: "k1" });
    // The network had nothing under it, so it could not be opened: a show request opens the way to the new device.
    link.update((shared) => void (shared.show = { n: 1, kind: "reveal", ord: `${NET}/CHW_Plant`, from: 1 }));
    const shown = await app.until(/CHW_Plant/);
    assert.match(shown, /AHU_01/);
    // One more arrives with nobody asking: the open folder is read again by itself, and the selection stays put.
    const more = await client.addDiscovered(discovery.job, [{ slot: "DiscoveryDevice2" }], { parent: NET });
    await client.call("apply_model_changes", { planId: more.planId, planHash: more.planHash, idempotencyKey: "k2" });
    const later = await app.until(/CH_01/, 8000);
    assert.match(later, /Station ─+ 4\/7/);
  } finally {
    app.unmount();
    await close();
  }
});
