// A large result through a pipe arrives whole (docs/ROADMAP.md, A2). The standalone bask is built
// with Bun, where the output used to stop at 65,536 bytes, so the built CLI runs under Bun too when
// Bun is installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startDemoStation } from "../dist/demo/station.js";

const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
let station;
let configDir;

/** Runs the built CLI with its output on pipes and returns all of it. */
const bask = (runtime, ...args) =>
  new Promise((resolve, reject) => {
    const child = spawn(runtime, [main, ...args], { env: { ...process.env, BASKSTREAM_CONFIG_DIR: configDir, BASKSTREAM_PASSWORD: station.password, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString("utf8") }));
  });

before(async () => {
  station = await startDemoStation({ live: false });
  configDir = mkdtempSync(join(tmpdir(), "bask-pipe-"));
  const login = await bask(process.execPath, "login", station.url, "-u", station.user, "--name", "pipe");
  assert.equal(login.code, 0, login.err);
});
after(async () => {
  await station.close();
  rmSync(configDir, { recursive: true, force: true });
});

for (const [name, runtime, skip] of [["node", process.execPath, false], ["bun", "bun", !hasBun]]) {
  test(`over 1 MB of -o json arrives whole through a pipe (${name})`, { skip: skip ? "bun is not installed" : false }, async () => {
    const { code, out, err } = await bask(runtime, "history", "Drivers/BacnetNetwork/AHU_01/points/SupplyAirTemp", "--since", "30d", "--limit", "20000", "-o", "json");
    assert.equal(code, 0, err);
    assert.ok(out.length > 1024 * 1024, `only ${out.length} bytes arrived`);
    const records = JSON.parse(out.toString("utf8")).histories[0].records;
    assert.equal(records.length, 8640, "30 days of five-minute records");
  });

  test(`an error message and exit code 1 still arrive through a pipe (${name})`, { skip: skip ? "bun is not installed" : false }, async () => {
    const { code, out, err } = await bask(runtime, "-p", "nosuch", "status");
    assert.equal(code, 1);
    assert.equal(out.length, 0);
    assert.match(err, /No profile named "nosuch"/);
  });
}
