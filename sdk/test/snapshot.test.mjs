// Pictures of pages (snapshot): ORD and URL forms always; the browser tests need Chrome, Chromium
// or Edge on this computer (or BASKSTREAM_BROWSER) and are skipped without one.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { inflateSync } from "node:zlib";
import { BaskStreamClient, BaskStreamError, StationHttp, findBrowser, pxPageOrd, pxPageUrl, snapshotPage } from "../dist/index.js";
import { PASSWORD, USER, startFakeStation } from "./fake-station.mjs";

let station;
before(async () => {
  station = await startFakeStation();
});
after(async () => {
  await station.close();
});

let browser = null;
try {
  browser = findBrowser();
} catch {}
const withBrowser = browser ? {} : { skip: "no Chrome, Chromium or Edge on this computer" };

/** Width, height and the first pixel's RGB of a PNG (the first row's first pixel is stored as is under every filter). */
function readPng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  let at = 8;
  let width, height, colorType;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") [width, height, colorType] = [body.readUInt32BE(0), body.readUInt32BE(4), body[9]];
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  assert.ok(colorType === 2 || colorType === 6, `RGB or RGBA (colour type ${colorType})`);
  return { width, height, firstPixel: [raw[1], raw[2], raw[3]] };
}

test("page ORDs: Px files, components with views, and full ORDs", () => {
  assert.equal(pxPageOrd("^px/ahu.px"), "file:^px/ahu.px");
  assert.equal(pxPageOrd("file:^px/Home.px"), "file:^px/Home.px");
  assert.equal(pxPageOrd("px/ahu.px"), "file:^px/ahu.px");
  assert.equal(pxPageOrd("slot:/Drivers/AHU_1", "Graphic"), "station:|slot:/Drivers/AHU_1|view:Graphic");
  assert.equal(pxPageOrd("/Drivers/AHU_1"), "station:|slot:/Drivers/AHU_1");
  assert.equal(pxPageOrd("local:|station:|slot:/Drivers/AHU_1|view:Graphic", "Other"), "station:|slot:/Drivers/AHU_1|view:Graphic");
  assert.throws(() => pxPageOrd("  "), TypeError);
  assert.equal(pxPageUrl(new URL("https://10.0.0.5"), "file:^a b/#1.px"), "https://10.0.0.5/ord?file:%5Ea%20b/%231.px");
  assert.equal(pxPageUrl(new URL("https://10.0.0.5/x"), "station:|slot:/A$20B|view:Graphic"), "https://10.0.0.5/ord?station:%7Cslot:/A$20B%7Cview:Graphic");
});

test("a browser that isn't there fails with browser_not_found", () => {
  assert.throws(() => findBrowser("/nowhere/chrome"), (error) => error instanceof BaskStreamError && error.code === "browser_not_found");
});

test("takes pictures of a page with the connection's session", withBrowser, async () => {
  const client = await BaskStreamClient.connect({ station: station.url, username: USER, password: PASSWORD });
  try {
    const shot = await client.snapshot("^px/Home.px", { width: 400, height: 300, settleMs: 100, frames: 2, intervalMs: 100 });
    assert.equal(shot.ord, "file:^px/Home.px");
    assert.equal(station.state.pages.at(-1), "file:^px/Home.px", "the station was asked for the page");
    assert.equal(shot.httpStatus, 200);
    assert.equal(shot.title, "Fake Px");
    assert.equal(shot.frames.length, 2);
    assert.ok(shot.frames[1].takenAt >= shot.frames[0].takenAt + 100, "frames are intervalMs apart");
    for (const frame of shot.frames) {
      const png = readPng(frame.png);
      assert.equal(png.width, 400);
      assert.equal(png.height, 300);
      png.firstPixel.forEach((value, i) => assert.ok(Math.abs(value - [0x22, 0xaa, 0x66][i]) <= 2, `pixel ${png.firstPixel} is the page's colour`));
    }
    assert.ok(shot.consoleErrors.some((text) => text.includes("fake widget warning")), "the page's console error is reported");
    assert.equal(shot.failedRequests, 0);
  } finally {
    client.close();
  }
});

test("a session the station doesn't accept fails with session_expired", withBrowser, async () => {
  const http = new StationHttp({ station: station.url, cookies: { JSESSIONID: "not-a-session" } });
  await assert.rejects(snapshotPage(http, "^px/Home.px", { width: 400, height: 300, settleMs: 0 }), (error) => error.code === "session_expired");
});

test("snapshot logs in again when the saved session has lapsed", withBrowser, async () => {
  const client = new BaskStreamClient({ station: station.url, username: USER, password: PASSWORD, cookies: { JSESSIONID: "lapsed" } });
  const logins = station.state.logins;
  const shot = await client.snapshot("slot:/Drivers/Net/VAV_01", { view: "Graphic", width: 320, height: 240, settleMs: 0 });
  assert.equal(station.state.logins, logins + 1);
  assert.equal(shot.ord, "station:|slot:/Drivers/Net/VAV_01|view:Graphic");
  assert.equal(station.state.pages.at(-1), "station:|slot:/Drivers/Net/VAV_01|view:Graphic");
});
