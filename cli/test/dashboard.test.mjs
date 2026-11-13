// Renders the dashboard against the built-in demo station (values frozen) and drives it with keys.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { mount, mountFleet, settle, startFleet, startStation } from "./harness.mjs";

const NET = "slot:/Drivers/BacnetNetwork";
const SAT = `${NET}/AHU_01/points/SupplyAirTemp`;
const SETPOINT = `${NET}/AHU_01/points/SupplyAirSetpoint`;
const configDir = mkdtempSync(join(tmpdir(), "bask-dash-"));
process.env.BASKSTREAM_CONFIG_DIR = configDir;

let station;
let client;
let closeStation;
before(async () => {
  ({ station, client, close: closeStation } = await startStation());
});
after(async () => {
  await closeStation();
  rmSync(configDir, { recursive: true, force: true });
});

/** Runs a test body on a mounted dashboard and always unmounts it. */
const withApp = (props, size, body) => withStation(client, props, size, body);
async function withStation(client, props, size, body) {
  const app = mount(client, props, size);
  try {
    await body(app);
  } finally {
    app.unmount();
  }
}

test("home shows the station, its alarms and what the agent is waiting on", () =>
  withApp({}, { columns: 140, rows: 40 }, async (app) => {
    const frame = await app.until(/waiting for you/);
    assert.match(frame, /Northgate/);
    assert.match(frame, /API 1\.11 · demo station/);
    assert.match(frame, /5 unacknowledged\s+7 open/);
    assert.match(frame, /P5 override 70\.0 °F/);
    assert.match(frame, /refused\s+override 60\.0 %/);
  }));

test("explorer opens the tree with live values, and watching a point follows its changes", () =>
  withApp({ view: "explorer" }, { columns: 130, rows: 34 }, async (app) => {
    await app.until(/Drivers/);
    await app.press("down", "right");
    await app.until(/BacnetNetwork/);
    await app.press("down", "right");
    await app.until(/AHU_01/);
    await app.press("down", "right");
    await app.until(/Points/);
    await app.press("down", "right");
    await app.until(/SupplyAirTemp\s+\d+\.\d °F/);
    await app.press("down");
    const details = await app.until(/history\s+\/Northgate\/AHU_01_SupplyAirTemp/);
    assert.match(details, /control:NumericPoint · read-only/);
    assert.match(details, /device\s+● AHU_01/);
    await app.press("w");
    await app.until(/Watching AHU_01\/SupplyAirTemp/);
    await app.press("3");
    await app.until(/1 live/);
    station.push({ op: "cov", points: [{ point: SAT, ok: true, statusOk: true, value: 61.25, displayValue: "61.3 °F", status: "{ok}", timestamp: Date.now() }] });
    await app.until(/61\.3 °F/);
  }));

test("commanding a point needs changes turned on, then asks for a value, a duration and a yes", () =>
  withApp({ view: "watch", points: [SETPOINT] }, { columns: 120, rows: 24 }, async (app) => {
    await app.until(/SupplyAirSetpoint\s+AHU_01\s+55\.0 °F/);
    await app.press("o");
    await app.until(/read-only\. Press W/);
    await app.press("W");
    await app.until(/Allow changes from this window\?/);
    await app.press("y");
    await app.until(/changes on/);
    await app.press("o");
    await app.until(/Override AHU_01\/SupplyAirSetpoint to/);
    await app.press("back", "back", "back", "back", "5", "8", "enter");
    await app.until(/Hold the override for/);
    await app.press("down", "down", "enter");
    await app.until(/Override AHU_01\/SupplyAirSetpoint = 58 for 30 min\?/);
    await app.press("y");
    const frame = await app.until(/58\.0 °F\s+\{overridden\}/);
    assert.match(frame, /SupplyAirSetpoint/);
    await app.press("a");
    await app.until(/Auto AHU_01\/SupplyAirSetpoint\?/);
    await app.press("y");
    await app.until(/55\.0 °F\s+\{ok\}/);
  }));

test("alarms list, filter and acknowledge", () =>
  withApp({ view: "alarms", allowWrites: true }, { columns: 130, rows: 26 }, async (app) => {
    const frame = await app.until(/Zone temperature high/);
    assert.match(frame, /7 open · 5 unacked/);
    assert.match(frame, /BacnetNetwork\/VAV_107\s+Device down/);
    await app.press("u");
    await app.until(/5 open · 5 unacked · unacked only/);
    await app.press("a");
    await app.until(/Acknowledge 1 alarm\?/);
    await app.press("y");
    await app.until(/1 acknowledged/);
    await app.until(/4 open · 4 unacked/);
  }));

test("trends draws a line chart with axes and statistics", () =>
  withApp({ view: "watch", points: [SAT] }, { columns: 120, rows: 28 }, async (app) => {
    await app.until(/SupplyAirTemp/);
    await app.press("t");
    const frame = await app.until(/records · 100% coverage/);
    assert.match(frame, /SupplyAirTemp · AHU_01/);
    assert.match(frame, /[⠁-⣿]{3}/);
    assert.match(frame, /min \d+(\.\d+)?\s+avg \d+(\.\d+)?\s+max \d+/);
    await app.press("-");
    await app.until(/3d · /);
  }));

test("schedules shows the week and what is coming up", () =>
  withApp({ view: "schedules" }, { columns: 130, rows: 28 }, async (app) => {
    const frame = await app.until(/Coming up/);
    assert.match(frame, /◷ OfficeHours/);
    assert.match(frame, /Mon\s+░+█+/);
    assert.match(frame, /default Unoccupied/);
    await app.press("down");
    await app.until(/72\.0 °F/);
  }));

test("query runs a report and jumps from a row to the Explorer", () =>
  withApp({ view: "query" }, { columns: 130, rows: 28 }, async (app) => {
    await app.until(/Points in alarm/);
    await app.press("enter");
    const frame = await app.until(/1 row/);
    assert.match(frame, /select slotPath, out from control:ControlPoint where status\.alarm/);
    assert.match(frame, /VAV_105\/points\/ZoneTemp\s+\d+\.\d °F \{alarm\}/);
    await app.press("enter");
    const tree = await app.until(/▾ □ Points/);
    assert.match(tree, /VAV_105/);
    assert.match(tree, /Details/);
  }));

test("a typed query reports the station's error", () =>
  withApp({ view: "query" }, { columns: 120, rows: 24 }, async (app) => {
    await app.until(/Points in alarm/);
    await app.press("i");
    await app.press("select name from nothing:Here", "enter");
    await app.until(/\[bad_query\] BqlException: unknown type/);
  }));

test("files browses folders and previews text", () =>
  withApp({ view: "files" }, { columns: 130, rows: 24 }, async (app) => {
    const root = await app.until(/▸ px\//);
    assert.match(root, /Files · \^/);
    // The folders are bask, config, images, nav, notes, px.
    await app.press("down", "down", "down", "down", "right");
    await app.until(/Files · \^notes/);
    const preview = await app.until(/1 # Commissioning notes/);
    assert.match(preview, /commissioning\.md/);
    await app.press("left");
    await app.until(/Files · \^ /);
  }));

test("jobs runs a discovery and adds what it found", () =>
  withApp({ view: "jobs", allowWrites: true }, { columns: 130, rows: 26 }, async (app) => {
    await app.until(/No jobs on the station/);
    await app.press("d");
    await app.until(/Discover on which BACnet network or device\?/);
    await app.press(NET, "enter");
    await app.until(/Start discovery on Drivers\/BacnetNetwork\?/);
    await app.press("y");
    const found = await app.until(/Found devices/);
    assert.match(found, /VAV_109\s+device:2009/);
    await app.press("right", "space", "a");
    await app.until(/Add 1 device under Drivers\/BacnetNetwork\?/);
    await app.press("y");
    await app.until(/Added 1\./);
    assert.ok(station.state.nodes.has(`${NET}/VAV_109`));
  }));

test("AI activity merges the agent log with the audit history and approves a proposal", () =>
  withApp({ view: "activity", allowWrites: true }, { columns: 150, rows: 36 }, async (app) => {
    const frame = await app.until(/waiting P5/);
    assert.match(frame, /writes need approval/);
    assert.match(frame, /users: ai-claude/);
    assert.match(frame, /refused\s+override 60\.0 %\s+AHU_02\/SupplyFanSpeed/);
    // Niagara's own audit record of the agent's file write sits beside the agent's record.
    assert.match(frame, /ai-claude\s+· file write\s+1432 bytes/);
    assert.match(frame, /why\s+Room 105 is in high-temperature alarm/);
    await app.press("a");
    await app.until(/Approve P5: override 70\.0 °F for 30 min on VAV_105\/ZoneSetpoint\?/);
    await app.press("y");
    await app.until(/P5 approved/);
    assert.equal(station.state.proposals.get("P5").status, "approved");
    await app.until(/✓ approved P5/);
  }));

test("the command palette finds views, reports and ORDs", () =>
  withApp({}, { columns: 120, rows: 30 }, async (app) => {
    await app.until(/Northgate/);
    await app.press(":");
    await app.until(/Commands/);
    await app.press("sched");
    await app.until(/› Schedules\s+View/);
    await app.press("enter");
    await app.until(/◷ OfficeHours/);
    await app.press("ctrl+k");
    await app.until(/Commands/);
    await app.press(`${NET}/CHW_Plant`, "enter");
    await app.until(/▣ CHW_Plant/);
  }));

test("find searches the station, watches with tab and reveals with enter", () =>
  withApp({}, { columns: 120, rows: 30 }, async (app) => {
    await app.until(/Northgate/);
    await app.press("/");
    await app.until(/Find/);
    await app.press("ChwFlow");
    await app.until(/1 found/);
    await app.press("tab");
    await app.until(/Watching CHW_Plant\/ChwFlow/);
    await app.press("enter");
    const frame = await app.until(/▾ □ Points/);
    assert.match(frame, /ChwFlow/);
  }));

test("the property sheet edits a property through a model plan", () =>
  withApp({ allowWrites: true }, { columns: 130, rows: 30 }, async (app) => {
    await app.until(/Northgate/);
    await app.press(":");
    await app.press(`${NET}/VAV_106`, "enter");
    await app.until(/▣ VAV_106/);
    await app.press("p");
    await app.until(/Properties · VAV_106/);
    await app.until(/enabled\s+true/);
    await app.press("down", "enter");
    await app.until(/enabled/);
    await app.press("down", "enter");
    await app.until(/Apply this change to the station\?/);
    await app.press("y");
    await app.until(/Set enabled: done/);
    assert.equal(station.state.nodes.get(`${NET}/VAV_106`).props.enabled.encoded, "false");
    await app.until(/enabled\s+false/);
  }));

test("the mouse switches tabs and selects rows", () =>
  withApp({ mouse: true }, { columns: 140, rows: 30 }, async (app) => {
    const home = await app.until(/Northgate/);
    const tabs = home.split("\n")[1];
    await app.mouse("down", tabs.indexOf("4 Alarms") + 2, 1);
    await app.until(/Alarms ─+ \d open/);
    await app.mouse("down", 10, 6);
    await app.press("enter");
    await app.until(/Alarm · AHU_01\/DuctStaticPressure/);
    await app.mouse("wheelDown", 10, 6);
    await app.until(/Alarm · AHU_02\/FilterDP/);
  }));

test("keys that arrive together each act on the screen the one before left", () =>
  withApp({ view: "explorer" }, { columns: 120, rows: 30 }, async (app) => {
    await app.until(/Drivers/);
    // One chunk, as fast typing or key repeat delivers it: down to Drivers, then open it.
    await app.press("\u001B[B\u001B[C");
    const frame = await app.until(/▾ □ Drivers/);
    assert.match(frame, /▸ ◆ Services/);
  }));

test("every view fits narrow windows without wrapping", async () => {
  for (const [columns, rows, pane] of [[80, 24, false], [58, 18, true], [200, 50, false]]) {
    for (const view of ["home", "explorer", "watch", "alarms", "trends", "schedules", "query", "files", "jobs", "activity"]) {
      await withApp({ view, pane, points: [SAT] }, { columns, rows }, async (app) => {
        await settle(500);
        const lines = app.frame().split("\n");
        assert.ok(lines.length <= rows, `${view} at ${columns}x${rows}: ${lines.length} lines`);
        for (const line of lines) assert.ok(line.length <= columns, `${view} at ${columns}x${rows}: "${line}"`);
      });
    }
  }
});

test("windows on the same station share the watch list and answer show requests", async () => {
  const { Link } = await import("../dist/link.js");
  const link = new Link(station.url);
  const other = new Link(station.url);
  await withApp({ link }, { columns: 130, rows: 30 }, async (app) => {
    await app.until(/Northgate/);
    // What `bask show <ord>` from another process writes.
    other.update((s) => void (s.show = { n: (s.show?.n ?? 0) + 1, kind: "reveal", ord: `${NET}/CHW_Plant/points/ChwSupplyTemp`, from: 1 }));
    await app.until(/ChwSupplyTemp\s+\d+\.\d °F/);
    other.update((s) => void (s.watch = [`${NET}/CHW_Plant/points/ChwReturnTemp`]));
    await app.press("3");
    await app.until(/ChwReturnTemp\s+CHW_Plant/);
    other.update((s) => void (s.show = { n: (s.show?.n ?? 0) + 1, kind: "trend", ord: `${NET}/CHW_Plant/points/ChwFlow`, from: 1 }));
    await app.until(/ChwFlow · CHW_Plant/);
  });
});

test("audit records are read from the station's text form", async () => {
  const { parseAudit } = await import("../dist/tui/stores.js");
  const changed = parseAudit({
    timestamp: 1794500915679,
    summary: "12-Nov-26 9:28 AM MST Changed /Drivers/Net/VAV_01 enabled true false ai-claude",
    value: "12-Nov-26 9:28 AM MST[ai-claude] Changed;slotName=enabled;oldValue=true;value=false"
  });
  assert.deepEqual({ user: changed.user, kind: changed.kind, action: changed.action, target: changed.target, oldValue: changed.oldValue, value: changed.value }, { user: "ai-claude", kind: "Changed", action: "enabled", target: "slot:/Drivers/Net/VAV_01", oldValue: "true", value: "false" });
  const invoked = parseAudit({
    timestamp: 1794513039783,
    summary: "12-Nov-26 12:50 PM MST Invoked /Services/JobService submitAction  Bacnet Discover Devices admin",
    value: "12-Nov-26 12:50 PM MST[admin] Invoked;slotName=submitAction;value=Bacnet Discover Devices"
  });
  assert.equal(invoked.target, "slot:/Services/JobService");
  assert.equal(invoked.value, "Bacnet Discover Devices");
  const file = parseAudit({ timestamp: 1, summary: "12-Nov-26 12:50 PM MST file_write file:^bask-check/check.txt   16 bytes admin", value: "12-Nov-26 12:50 PM MST[admin] file_write;value=16 bytes" });
  assert.equal(file.target, "file:^bask-check/check.txt");
  assert.equal(parseAudit({ timestamp: 1, summary: "12-Nov-26 12:57 PM MST model_preview slot:/Services/BASkStreamService 8096  [{action=delete}] admin", value: "12-Nov-26 12:57 PM MST[admin] model_preview;slotName=8096;value=[{action=delete}]" }), undefined);
  // Agent records come from the agent log instead, with their fields.
  assert.equal(parseAudit({ timestamp: 1, summary: "x", value: "12-Nov-26 12:50 PM MST[ai-claude] Agent;slotName=override;value=outcome=refused" }), undefined);
});

test("each demo site is its own building with its own alarms and agent history", async () => {
  const expected = {
    riverside: [/Riverside/, /Isolation room pressure low/, /AHU_OR\/SupplyFanSpeed/],
    harbor: [/Harbor/, /Freezer 2 box temperature high/, /Freezer_2\/BoxSetpoint/],
    summit: [/Summit/, /Hot aisle temperature high/, /CRAC_4\/FanSpeed/]
  };
  for (const [site, patterns] of Object.entries(expected)) {
    const { client, close } = await startStation({ site });
    try {
      await withStation(client, {}, { columns: 150, rows: 36 }, async (app) => {
        const frame = await app.until(/waiting for you/);
        for (const pattern of patterns) assert.match(frame, pattern);
        // A second driver network shows up where the site has one.
        if (site !== "riverside") {
          await app.press("2");
          await app.until(/Drivers/);
          await app.press("down", "right");
          await app.until(site === "harbor" ? /ModbusNetwork/ : /SnmpNetwork/);
        }
      });
    } finally {
      await close();
    }
  }
});

test("the all-stations view shows every station, their alarms together, and opens one", async () => {
  const fleet = await startFleet();
  const app = mountFleet(fleet.entries, {}, { columns: 170, rows: 46 });
  try {
    const frame = await app.until(/5 stations · 5 live/);
    for (const name of ["1 Northgate", "2 Riverside", "3 Harbor", "4 Summit", "5 Eastgate"]) assert.match(frame, new RegExp(name));
    // The new station has nothing in it yet, and its card says so.
    assert.match(frame, /no open alarms\s+AI: nothing waiting/);
    assert.match(frame, /Nothing on this station's watch list yet/);
    await app.until(/18 unacked\s+24 open\s+4 waiting for approval/);
    const all = await app.until(/Newest alarms, all stations ─+ 24 open across 5 stations/);
    assert.match(all, /Summit\s+unacked Hall_A\/HotAisleTemp/);
    assert.match(all, /Harbor\s+unacked Freezer_2\/BoxTemp/);
    assert.match(all, /Freezer_2\/BoxTemp\s+[345]\.\d °F/);
    await app.press("right", "enter");
    const station = await app.until(/Riverside · admin@/);
    assert.match(station, /1 Home\s+2 Explorer/);
    await app.press("4");
    await app.until(/Isolation room pressure low/);
    await app.press("q");
    await app.until(/All stations/);
    await app.press("3");
    await app.until(/Harbor · admin@/);
  } finally {
    app.unmount();
    await fleet.close();
  }
});

test("the all-stations view fits small and large windows, and says why a station is unreachable", async () => {
  const fleet = await startFleet(["northgate", "harbor"]);
  const broken = { profile: "gone", label: "Old plant", host: "10.0.0.9", link: fleet.entries[0].link, connect: () => Promise.reject(new Error("The saved login expired. Run: bask login https://10.0.0.9 -u ops --name gone")) };
  try {
    for (const [columns, rows] of [[80, 24], [60, 18], [210, 56]]) {
      const app = mountFleet([...fleet.entries, broken], {}, { columns, rows });
      try {
        await app.until(/2 live/);
        await settle(400);
        const lines = app.frame().split("\n");
        assert.ok(lines.length <= rows, `${columns}x${rows}: ${lines.length} lines`);
        for (const line of lines) assert.ok(line.length <= columns, `${columns}x${rows}: "${line}"`);
        if (columns === 210) assert.match(app.frame(), /The saved login expired\. Run: bask login https:\/\/10\.0\.0\.9/);
      } finally {
        app.unmount();
      }
    }
  } finally {
    await fleet.close();
  }
});
