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
    const frame = await deck.until(/set 72\.0° \+6\.\d/);
    for (const text of ["bask", "NORTHGATE", "whole site", "LENS", "comfort", "CHW_Plant", "AHU_01", "AHU_02", "SUPPLY", "LIVE", "NOW", "READ-ONLY"]) assert.ok(frame.includes(text), text);
    // Each box sits under the air handler that feeds it, in order.
    // The map is the left of the screen; the rail beside it names units too.
    const lines = frame.split("\n").map((line) => line.slice(0, 100));
    const rowOf = (text) => lines.findIndex((line) => line.includes(text));
    assert.ok(rowOf("AHU_01") < rowOf("101") && rowOf("101") < rowOf("AHU_02") && rowOf("AHU_02") < rowOf("105"), frame);
    assert.match(lines[rowOf("101")], /101.*102.*103.*104/);
    assert.match(lines[rowOf("105")], /105.*106.*107.*108/);
    // What needs a person is said in one line, and listed beside the map on a wide screen.
    assert.match(frame, /1 zone off setpoint/);
    assert.match(frame, /alarms?, \d+ not acknowledged/);
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
    const row = (text) => lines().find((line) => line.includes(text)) ?? "";
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

test("a change is shown first and waits for enter; a read-only window refuses", () =>
  withDeck({}, { columns: 150, rows: 42 }, async (deck) => {
    await deck.press(":", ..."override AHU_01 SupplyAirSetpoint 56", "enter");
    await deck.until(/read-only\. Press W twice/);
    await deck.press("W");
    await deck.until(/Press W again/);
    await deck.press("W");
    await deck.until(/CHANGES ON/);
    await deck.press(":", ..."override AHU_01 SupplyAirSetpoint 56 for 30m", "enter");
    let frame = await deck.until(/not made yet/);
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
  withDeck({}, { columns: 100, rows: 30 }, async (deck, client) => {
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
