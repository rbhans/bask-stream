// Runs the built CLI against the SDK's fake station with a throwaway config folder.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PASSWORD, USER, startFakeStation } from "../../sdk/test/fake-station.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let station;
let configDir;
const bask = (...args) =>
  run(process.execPath, [main, ...args], { env: { ...process.env, BASKSTREAM_CONFIG_DIR: configDir, BASKSTREAM_PASSWORD: PASSWORD, FORCE_COLOR: "0" } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e) => ({ code: e.code, out: e.stdout + e.stderr })
  );

before(async () => {
  station = await startFakeStation();
  configDir = mkdtempSync(join(tmpdir(), "bask-test-"));
});
after(async () => {
  await station.close();
  rmSync(configDir, { recursive: true, force: true });
});

test("doctor without a profile says how to log in", async () => {
  const { code, out } = await bask("doctor");
  assert.equal(code, 1);
  assert.match(out, /✗ Profile/);
  assert.match(out, /bask login/);
});

test("doctor passes every check once logged in", async () => {
  assert.equal((await bask("login", station.url, "-u", USER, "--name", "fake")).code, 0);
  const { code, out } = await bask("doctor");
  assert.equal(code, 0, out);
  for (const check of ["Profile", "Reachable", "Login page", "Session", "baskStream", "WebSocket", "Access"]) assert.match(out, new RegExp(`✓ ${check}`));
  assert.match(out, /All good/);
});

test("doctor explains an unreachable station", async () => {
  const { code, out } = await bask("doctor", "http://127.0.0.1:9");
  assert.equal(code, 1);
  assert.match(out, /✗ Reachable/);
  assert.match(out, /Nothing is listening/);
});

test("doctor explains an expired session", async () => {
  station.expireSessions();
  const { code, out } = await bask("doctor");
  assert.equal(code, 1);
  assert.match(out, /✗ Session/);
});
