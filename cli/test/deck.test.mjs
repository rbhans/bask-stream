// The map screen: the site on one screen, a bar of time, and a command line.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mountDeck, settle, startStation } from "./harness.mjs";

const NET = "slot:/Drivers/BacnetNetwork";
// What a person settles about the map is kept in bask's own folder: a throwaway one here.
process.env.BASKSTREAM_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "bask-deck-"));

async function withDeck(props, size, work, station = {}) {
  const { client, close } = await startStation(station);
  const deck = mountDeck(client, props, size);
  try {
    await deck.until(/AHU_01/);
    await work(deck, client);
  } finally {
    deck.unmount();
    await close();
  }
}

test("the map shows the plant, each air handler and the zones it feeds", () =>
  withDeck({}, { columns: 150, rows: 42 }, async (deck) => {
    // On a screen this size the readings are big figures; the hot zone's distance from its setpoint is in words.
    const frame = await deck.until(/set 72\.0° \+[67]\.\d/);
    for (const text of ["bask", "NORTHGATE", "whole site", "LENS", "comfort", "CHW_Plant", "AHU_01", "AHU_02", "SUPPLY", "LIVE", "NOW", "READ-ONLY"]) assert.ok(frame.includes(text), text);
    // Each box sits under the air handler that feeds it, in order.
    // The map is the left of the screen; the rail beside it names units too.
    // The plant has a group of its own on the water side, and under its name what it sends water to, each with its valve.
    assert.match(frame, /WATER SIDE[\s\S]*CHW_Plant[\s\S]*CHILLED WATER TO 2\s+AHU_01 \d+%\s+AHU_02 \d+%[\s\S]*AIR SIDE/);
    const lines = frame.split("\n").map((line) => line.slice(0, 100)).filter((line) => !line.includes("WATER TO"));
    const rowOf = (text) => lines.findIndex((line) => line.includes(text));
    assert.ok(rowOf("AHU_01") < rowOf("101") && rowOf("101") < rowOf("AHU_02") && rowOf("AHU_02") < rowOf("105"), frame);
    assert.match(lines[rowOf("101")], /101.*102.*103.*104/);
    assert.match(lines[rowOf("105")], /105.*106.*107.*108/);
    // What needs a person is said in one line, and listed beside the map on a wide screen.
    assert.match(frame, /1 zone off setpoint/);
    assert.match(frame, /\d+ in alarm/);
    assert.match(frame, /IN ALARM/);
    assert.match(frame, /IN HAND/);
    // The unit that is down says so in place of a reading.
    assert.match(frame, /DOWN|down/);
  }));

test("every frame fills the window exactly, at any size", async () => {
  for (const [columns, rows] of [[80, 24], [100, 30], [120, 36], [150, 42], [200, 55], [60, 20]]) {
    await withDeck({}, { columns, rows }, async (deck) => {
      for (const keys of [[], ["down", "enter"], ["l"], [","]]) {
        if (keys.length) await deck.press(...keys);
        await settle(200);
        const lines = deck.frame().split("\n");
        assert.equal(lines.length, rows, `${columns}x${rows} after ${keys.join(" ")}: ${lines.length} rows`);
        for (const line of lines) assert.ok([...line].length <= columns, `${columns}x${rows} after ${keys.join(" ")}: "${line}" is ${[...line].length} wide`);
      }
    });
  }
});

test("the arrows move over the map, enter opens a unit and esc comes back", () =>
  withDeck({}, { columns: 150, rows: 42 }, async (deck) => {
    // From the first air handler: down to its first box, right to the next, and in.
    await deck.press("down", "right", "enter");
    let frame = await deck.until(/▸ VAV_102/);
    assert.match(frame, /VAV_102\s+VAV BOX/);
    for (const text of ["ZONE", "SETPOINT", "AIRFLOW", "DAMPER", "ZoneTemp", "ZoneSetpoint", "FED BY", "AHU_01", "WHAT HAPPENED"]) assert.ok(frame.includes(text), text);
    // Up and down move through its points; the one under the cursor is charted beside the list.
    await deck.press("down");
    frame = await deck.until(/THE LAST WEEK/);
    await deck.press("esc");
    frame = await deck.until(/whole site/);
    assert.ok(!/▸ VAV_102/.test(frame));
  }));

test("a lens recolours the same map: alarms, what is in hand, changes, agents", () =>
  withDeck({}, { columns: 150, rows: 42 }, async (deck) => {
    await deck.press("l");
    let frame = await deck.until(/▲\d/);
    const lines = () => deck.frame().split("\n").map((line) => line.slice(0, 100));
    const row = (text) => lines().find((line) => line.includes(text) && !line.includes("WATER TO")) ?? "";
    // The zone in alarm shows its count where its reading was.
    assert.match(lines().slice(0, 30).join("\n"), /▲1/);
    await deck.press("l");
    frame = await deck.until(/LENS\s+comfort\s+alarms\s+overrides/);
    assert.match(row("AHU_02"), /1 in hand/);
    await deck.press("l");
    frame = await deck.until(/\d chg/);
    await deck.press("1");
    frame = await deck.until(/set 72\.0°/);
    assert.ok(row("101").length > 0, frame);
  }));

test("a lens works inside a unit too: it says what it picks out and marks those points", () =>
  withDeck({}, { columns: 150, rows: 42 }, async (deck) => {
    await deck.press(":", ..."AHU_02", "enter");
    await deck.until(/▸ AHU_02/);
    await deck.press("3");
    const frame = await deck.until(/OVERRIDES\s+1 of \d+ points in hand/);
    assert.match(frame, /SupplyFanSpeed.*━ in hand/);
    await deck.press("2");
    await deck.until(/ALARMS\s+(no point here is|\d+ of \d+ points) in alarm or waiting to be acknowledged/);
  }));

test("the command line: a unit's name goes to it, get and log answer, an unknown word says so", () =>
  withDeck({}, { columns: 150, rows: 42 }, async (deck) => {
    await deck.press(":", ..."AHU_02", "enter");
    let frame = await deck.until(/▸ AHU_02/);
    assert.match(frame, /AHU_02\s+AIR HANDLER/);
    assert.match(frame, /SUPPLY AIR/);
    assert.match(frame, /IN HAND/);
    await deck.press(":", ..."get", "enter");
    frame = await deck.until(/SupplyFanSpeed\s+85\.0 %/);
    await deck.press("esc");
    await deck.press(":", ..."log", "enter");
    frame = await deck.until(/What happened to AHU_02/);
    assert.match(frame, /in hand/);
    await deck.press("esc");
    await deck.press(":", ..."frobnicate", "enter");
    frame = await deck.until(/not a unit on the map or a word bask knows/);
    // Tab finishes a name.
    await deck.press(":", ..."VAV_10", "tab");
    await deck.press("5", "tab", "enter");
    await deck.until(/▸ VAV_105/);
  }));

test("time: a step back shows the readings of that moment, and n comes back to now", () =>
  withDeck({}, { columns: 100, rows: 30 }, async (deck) => {
    assert.match(await deck.until(/NOW/), /● LIVE/);
    await deck.press(":", ..."at 6d", "enter");
    let frame = await deck.until(/◷ \w{3} \d+ · \d+:\d\d [AP]M/);
    assert.match(frame, /6 days ago/);
    assert.ok(!frame.includes("● LIVE"));
    // Six days ago the hot zone had not turned yet: it reads like its neighbours.
    const hot = (text) => /7[89]\.\d°/.test(text.split("\n").slice(0, 28).join("\n"));
    await deck.until(/7[12]\.\d°/);
    await settle(1500);
    assert.ok(!hot(deck.frame()), deck.frame());
    await deck.press("n");
    frame = await deck.until(/● LIVE/);
    assert.ok(hot(frame), frame);
  }));

test("a change is shown first and waits for enter; the first one from a window allows changes there, on the same card", () =>
  withDeck({}, { columns: 150, rows: 42 }, async (deck) => {
    await deck.press(":", ..."override AHU_01 SupplyAirSetpoint 56 for 30m", "enter");
    let frame = await deck.until(/not made yet/);
    // Nothing has been allowed from this window: the card says so, and enter allows it without making the change.
    assert.match(frame, /READ-ONLY/);
    assert.match(frame, /This window has made no changes yet/);
    assert.match(frame, /enter\s+allow changes/);
    await deck.press("enter");
    frame = await deck.until(/CHANGES ON/);
    assert.match(frame, /not made yet/);
    assert.match(frame, /enter\s+make it/);
    assert.match(frame, /override\s+AHU_01 SupplyAirSetpoint/);
    assert.match(frame, /55\.0 °F\s+→\s+56 °F/);
    assert.match(frame, /for 30m, then released by the station/);
    // Esc drops it and nothing is written.
    await deck.press("esc");
    await deck.until(/Dropped\. Nothing was changed/);
    await deck.press(":", ..."override AHU_01 SupplyAirSetpoint 56 for 30m", "enter");
    await deck.until(/not made yet/);
    await deck.press("enter");
    frame = await deck.until(/now reads 56\.0 °F/);
    await deck.press(":", ..."release AHU_01 SupplyAirSetpoint", "enter");
    await deck.until(/not made yet/);
    await deck.press("enter");
    await deck.until(/now reads 55\.0 °F/);
  }));

test("the mouse: a press on a tile moves there, a second opens it; a lens and the time bar answer too", () =>
  withDeck({ mouse: true }, { columns: 150, rows: 42 }, async (deck) => {
    const frame = await deck.until(/set 72\.0°/);
    const lines = frame.split("\n");
    const y = lines.findIndex((line) => line.includes("106"));
    const x = lines[y].indexOf("106");
    await deck.mouse("down", x + 1, y + 1);
    await deck.mouse("down", x + 1, y + 1);
    await deck.until(/▸ VAV_106/);
    await deck.press("esc");
    const head = deck.frame().split("\n")[0];
    await deck.mouse("down", head.indexOf("agents") + 2, 0);
    await deck.until(/\d wait/);
    const bar = deck.frame().split("\n").findIndex((line) => /SUN|MON|TUE|WED|THU|FRI|SAT/.test(line));
    await deck.mouse("down", 40, bar + 1);
    await deck.until(/days? ago|h ago/);
  }));

test("why: the chain from a reading back to what changed beside it, and one key to put that back", () =>
  withDeck({ allowWrites: true }, { columns: 150, rows: 42 }, async (deck, client) => {
    await deck.press(":", ..."why VAV_105 ZoneTemp", "enter");
    let frame = await deck.until(/could be put back/, 15000);
    assert.match(frame, / WHY  VAV_105 ZoneTemp reads 7[89]\.\d °F/);
    assert.match(frame, /turned \w{3} \d+, \d+:\d\d [AP]M/);
    assert.match(frame, /changed \d+ min before, on the same unit/);
    assert.match(frame, /VAV_105 MaxAirflow\s+310 cfm\s+● 620 cfm → 310 cfm\s+by operator/);
    assert.match(frame, /turned \d+ min before, on the same unit\s*\n\s*VAV_105 Airflow/);
    assert.match(frame, /fed air by AHU_02/);
    assert.match(frame, /AHU_02 SupplyFanSpeed\s+85\.0 %.*in hand/);
    assert.match(frame, /CHW_Plant Chiller2Status\s+Off.*fault/);
    // The time bar marks when it turned.
    assert.match(frame, /▼ turned here/);
    // f shows the change that would put it back, and enter makes it.
    await deck.press("f");
    frame = await deck.until(/not made yet/);
    assert.match(frame, /set\s+VAV_105 MaxAirflow\s+310 cfm\s+→\s+620 cfm/);
    await deck.press("enter");
    await deck.until(/MaxAirflow now reads 620/);
    assert.equal((await client.read([`${NET}/VAV_105/points/MaxAirflow`]))[0].value, 620);
  }));

test("setting the map up without AI: say what feeds what, choose what a tile shows; it is kept on this computer", () =>
  withDeck({}, { columns: 100, rows: 38 }, async (deck, client) => {
    // Move two boxes from one air handler to the other.
    await deck.press(":", ..."feeds AHU_01 VAV_105..VAV_106", "enter");
    let frame = await deck.until(/AHU_01 feeds 2 units\. Saved on this computer/);
    // They now sit in AHU_01's group, after its own four, and AHU_02 keeps the other two.
    await deck.until(/104\s.*105\s.*106/);
    assert.ok(deck.frame().split("\n").some((line) => /107\s.*108/.test(line) && !/105|106/.test(line)), deck.frame());
    // Every VAV box shows its airflow in place of its temperature.
    await deck.press(":", ..."show Airflow on vav", "enter");
    frame = await deck.until(/Every VAV box now shows Airflow/);
    await deck.until(/\d{3}\b(?!\.\d°)/);
    const file = path.join(process.env.BASKSTREAM_CONFIG_DIR, "sites", `${client.http.url.host.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    assert.ok(existsSync(file), file);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.tiles.vav, "Airflow");
    assert.ok(saved.review.serves.some((e) => e.toName === "VAV_105" && e.fromName === "AHU_01" && e.confirmed));
    // Nothing was written to the station: its own relation still says AHU_02.
    const tags = await client.call("read_tags", { ords: [`${NET}/VAV_105`], dictionary: "hs", includeRelations: true });
    assert.match(JSON.stringify(tags.targets[0].relations ?? []), /AHU_02/);
  }));

test("what waits beside the map can be landed on: right from the map reaches it, enter shows what can be done, left comes back", () =>
  withDeck({}, { columns: 150, rows: 42 }, async (deck) => {
    // From the first air handler, right along its title's row and on into the list beside the map.
    await deck.until(/WAITS FOR YOU/);
    await deck.press("right", "right");
    let frame = await deck.until(/▌ [◇▲△━]/);
    assert.match(frame, /enter\s+what can be done/);
    await deck.press("up", "up", "up", "up", "enter");
    frame = await deck.until(/Change P\d+ waits for you/);
    await deck.press("esc");
    await deck.press("left", "enter");
    await deck.until(/▸ (AHU_\d+|VAV_\d+|CHW_Plant)/);
  }));

test("what needs you: one list of the change that waits, the alarms and what is in hand; each opens what can be done, and acknowledging goes through the one card", () =>
  withDeck({}, { columns: 150, rows: 36 }, async (deck, client) => {
    // The line under the map counts the two apart.
    assert.match(deck.frame(), /\d+ in alarm\s+·\s+\d+ alarms? to acknowledge/);
    // One list of what needs a person: the change that waits, the alarms, what is in hand.
    await deck.press("i");
    let frame = await deck.until(/What needs you\s+·\s+1 change waiting\s+·\s+\d+ in alarm\s+·\s+\d+ to acknowledge\s+·\s+1 in hand/);
    for (const text of ["WAITS FOR YOU", "IN ALARM", "TO ACKNOWLEDGE", "IN HAND"]) assert.ok(frame.includes(text), text);
    assert.match(frame, /▲ .*VAV_105\s+ZoneTemp\s+Zone temperature high/, "the unit, the point and what it says");
    // Enter on the first line: the change an agent asked for, with what it would do and what can be done about it.
    await deck.press("enter");
    frame = await deck.until(/Change P\d+ waits for you/);
    assert.match(frame, /asked for this .* ago\. Nothing has been changed/);
    assert.match(frame, /ZoneSetpoint reads\s+72\.0 °F\s+would be\s+70/);
    assert.match(frame, /y\s+Approve it/);
    assert.match(frame, /n\s+Reject it/);
    // Esc goes back to the list, with the cursor where it was; down to the first alarm, and enter.
    await deck.press("esc");
    await deck.until(/What needs you/);
    await deck.press("down", "enter");
    frame = await deck.until(/Alarm\s+·\s+VAV_105\s+·\s+ZoneTemp/);
    assert.match(frame, /▲ still in alarm\s+nobody has acknowledged it/);
    // Its letter shows the acknowledgement; the first enter allows changes from this window, the second makes it.
    const unacked = async () => (await client.alarms({ scope: "open", limit: 500 })).alarms.filter((x) => String(x.ackState).toLowerCase() === "unacked").length;
    const before = await unacked();
    await deck.press("a");
    await deck.until(/Acknowledges 1 alarm as you/);
    await deck.press("enter");
    await deck.until(/CHANGES ON/);
    await deck.press("enter");
    await deck.until(/1 alarm acknowledged/);
    assert.equal(await unacked(), before - 1);
    // The card is made again from what the station now says, and g goes to the point.
    frame = await deck.until(/▲ still in alarm\s+acknowledged/);
    await deck.press("g");
    frame = await deck.until(/▌ ZoneTemp/);
    assert.match(frame, /▸ VAV_105/);
  }));

test("a point: enter shows what can be done to it, and setting a value goes through the same card as every change", () =>
  withDeck({ allowWrites: true }, { columns: 150, rows: 42 }, async (deck) => {
    await deck.press(":", ..."goto slot:/Drivers/BacnetNetwork/AHU_01/points/SupplyAirSetpoint", "enter");
    await deck.until(/▌ SupplyAirSetpoint/);
    await deck.press("enter");
    let frame = await deck.until(/AHU_01\s+·\s+SupplyAirSetpoint/);
    for (const text of ["Set a value…", "Put in hand…", "Why it reads this"]) assert.ok(frame.includes(text), text);
    assert.ok(!frame.includes("Release to automatic"), "nothing to release on a point that is not in hand");
    // s puts the words on the command line and waits for the value.
    await deck.press("s");
    await deck.until(/› set AHU_01 SupplyAirSetpoint/);
    await deck.press(..."56", "enter");
    frame = await deck.until(/not made yet/);
    assert.match(frame, /55\.0 °F\s+→\s+56 °F/);
    await deck.press("enter");
    await deck.until(/now reads 56\.0 °F/);
    // A point the station only reads offers no change.
    await deck.press(":", ..."goto slot:/Drivers/BacnetNetwork/AHU_01/points/SupplyAirTemp", "enter");
    await deck.until(/▌ SupplyAirTemp/);
    await deck.press("enter");
    frame = await deck.until(/cannot be commanded/);
    assert.ok(!frame.includes("Set a value…"));
  }));

test("the map lays out by what feeds what, by type, or by place; places says when the station holds none", () =>
  withDeck({}, { columns: 150, rows: 36 }, async (deck) => {
    assert.match(deck.frame(), /whole site · by what feeds what/);
    await deck.press(":", ..."arrange kind", "enter");
    const frame = await deck.until(/whole site · by type/);
    assert.match(frame, /VAV boxes · 8\s+BY TYPE/);
    assert.match(frame, /air handlers · 2\s+BY TYPE/);
    await deck.press(":", ..."arrange feeds", "enter");
    await deck.until(/whole site · by what feeds what/);
  }));

test("any bask command runs from the command line and its answer is shown; one that changes the station is shown first like any change", () =>
  withDeck({}, { columns: 150, rows: 36 }, async (deck) => {
    await deck.press(":", ..."bask put a b", "enter");
    const frame = await deck.until(/This command changes the station/);
    assert.match(frame, /run\s+bask put a b/);
    assert.match(frame, /enter\s+allow changes/);
    await deck.press("esc");
    await deck.until(/Dropped\. Nothing was changed/);
    await deck.press(":", ..."bask tui", "enter");
    await deck.until(/takes the whole terminal/);
  }));

test("what is not running right shows on the map: a mark on the unit, a line beside the map, a count under it, and the finding inside the unit", () =>
  withDeck({}, { columns: 160, rows: 44 }, async (deck) => {
    // The look reads histories, so it comes a few seconds after the map.
    const frame = await deck.until(/≠ 1 not running right/, 9000);
    assert.match(frame, /NOT RUNNING RIGHT\s+1\s*\n.*≠ VAV_105 held off its setpoint/);
    assert.match(frame.split("\n").find((line) => /^\s+105\s/.test(line.slice(0, 110))) ?? "", /≠/);
    await deck.press(":", ..."VAV_105", "enter");
    const inside = await deck.until(/≠ held off its setpoint/, 5000);
    assert.match(inside, /NOT RUNNING RIGHT/);
    assert.match(inside, /above its\s+setpoint|above\s+its setpoint|above its setpoint/);
  }));

test("a site with a main meter shows what it reads and today's peak at the end of the line under the map", async () => {
  const { client, close } = await startStation({ site: "harbor" });
  const deck = mountDeck(client, {}, { columns: 160, rows: 44 });
  try {
    await deck.until(/SITE \d[\d,.]* kW {2}peak \d[\d,.]* kW at \d+:\d\d/, 12000);
  } finally {
    deck.unmount();
    await close();
  }
});
