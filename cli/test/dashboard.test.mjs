// Renders the dashboard against the SDK's fake station and drives it with keys.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { BaskStreamClient } from "@basidekick/baskstream";
import { App } from "../dist/tui/App.js";
import { PASSWORD, USER, startFakeStation } from "../../sdk/test/fake-station.mjs";

const SPACE_TEMP = "slot:/Drivers/Net/VAV_01/points/SpaceTemp";
let station;
let client;
before(async () => {
  station = await startFakeStation();
  client = await BaskStreamClient.connect({ station: station.url, username: USER, password: PASSWORD });
});
after(async () => {
  client.close();
  await station.close();
});

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(frame, pattern, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(frame())) {
      // Ink re-binds key handlers in an effect after the frame is drawn; let that run
      // before the test presses the next key (slow CI runners otherwise race it).
      await settle(100);
      return frame();
    }
    await settle(25);
  }
  assert.fail(`timed out waiting for ${pattern}\n${frame()}`);
}

function mount(props = {}) {
  const view = render(React.createElement(App, { client, profileName: "fake", allowWrites: false, ...props }));
  // ink-testing-library's stdout is 100 columns; give the layout a fixed height.
  view.stdout.rows = 30;
  return view;
}

test("browse tree expands and watch collects points", async () => {
  const { lastFrame, stdin, unmount } = mount();
  try {
    await until(lastFrame, /Drivers/);
    stdin.write("\r"); // open Drivers
    await until(lastFrame, /▾ ▣ Drivers/);
    for (const step of ["\u001B[B", "\r", "\u001B[B", "\r", "\u001B[B", "\r", "\u001B[B"]) {
      stdin.write(step);
      await settle(60);
    }
    await until(lastFrame, /SpaceTemp/);
    stdin.write("w");
    await until(lastFrame, /Watching SpaceTemp/);
    stdin.write("2");
    const frame = await until(lastFrame, /72\.5/);
    assert.match(frame, /Watching 1/);
    station.push({ op: "cov", points: [{ point: SPACE_TEMP, ok: true, value: 68.25, status: "{ok}", timestamp: Date.now() }] });
    await until(lastFrame, /68\.25/);
    console.log(lastFrame());
  } finally {
    unmount();
  }
});

test("alarms view lists alarms and refuses ack when read-only", async () => {
  const { lastFrame, stdin, unmount } = mount();
  try {
    stdin.write("3");
    await until(lastFrame, /Space temp/);
    stdin.write("a");
    await until(lastFrame, /Read-only/);
    console.log(lastFrame());
  } finally {
    unmount();
  }
});

test("ack asks for confirmation when writes are allowed", async () => {
  const { lastFrame, stdin, unmount } = mount({ allowWrites: true, view: "alarms" });
  try {
    await until(lastFrame, /Space temp/);
    stdin.write("a");
    await until(lastFrame, /Acknowledge 1 alarm\?/);
    stdin.write("y");
    await until(lastFrame, /1 acknowledged/);
  } finally {
    unmount();
  }
});

test("history view draws a chart", async () => {
  const { lastFrame, stdin, unmount } = mount({ view: "watch", points: [SPACE_TEMP] });
  try {
    await until(lastFrame, /72\.5/);
    stdin.write("t");
    const frame = await until(lastFrame, /records/);
    assert.match(frame, /[▁▂▃▄▅▆▇█]/);
    console.log(frame);
  } finally {
    unmount();
  }
});

test("status view shows station and traffic", async () => {
  const { lastFrame, stdin, unmount } = mount({ view: "status" });
  try {
    const frame = await until(lastFrame, /requests/);
    assert.match(frame, /api version\s+1\.7/);
    stdin.write("?");
    await until(lastFrame, /Everywhere/);
  } finally {
    unmount();
  }
});

test("finder searches, reveals in the tree, and watches with tab", async () => {
  const { lastFrame, stdin, unmount } = mount();
  try {
    await until(lastFrame, /Drivers/);
    stdin.write("/");
    await until(lastFrame, /Find/);
    stdin.write("Space");
    await until(lastFrame, /1 found/);
    stdin.write("\t");
    await until(lastFrame, /Watching SpaceTemp/);
    stdin.write("\r");
    const frame = await until(lastFrame, /▾ ▣ points/);
    // The found point is selected in the tree (row 5 of 7) and shown in Details.
    assert.match(frame, /Station {2}5\/7/);
    assert.match(frame, /slot:\/Drivers\/Net\/VAV_01\/points\/SpaceT/);
    console.log(frame);
  } finally {
    unmount();
  }
});
