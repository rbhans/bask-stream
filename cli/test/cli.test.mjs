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

test("an agent's write becomes a proposal that a person approves", async () => {
  const point = "Drivers/Net/VAV_01/points/SpaceTemp";
  const refused = await bask("write", point, "override", "72", "--allow-writes", "-y", "--agent", "Claude Code");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /reason_required/);

  const proposed = await bask("write", point, "override", "72", "--allow-writes", "-y", "--agent", "Claude Code", "--on-behalf-of", "ben", "--reason", "Room 204 is too cold");
  assert.equal(proposed.code, 0, proposed.out);
  const id = /Proposed (P\d+)/.exec(proposed.out)?.[1];
  assert.ok(id, proposed.out);

  const listed = await bask("proposals");
  assert.match(listed.out, new RegExp(`${id}\\s+pending`));
  assert.match(listed.out, /Claude Code for ben/);

  const agentApproves = await bask("approve", id, "--allow-writes", "-y", "--agent", "Claude Code");
  assert.equal(agentApproves.code, 1);
  assert.match(agentApproves.out, /agent_cannot_approve/);

  const approved = await bask("approve", id, "--allow-writes", "-y");
  assert.equal(approved.code, 0, approved.out);
  assert.match(approved.out, new RegExp(`${id} approved`));

  const log = await bask("agent-log");
  assert.match(log.out, new RegExp(`approved ${id} by`));
  assert.match(log.out, new RegExp(`proposed ${id}`));
});

test("doctor shows the agent rules", async () => {
  const { out } = await bask("doctor");
  assert.match(out, /✓ AI agents\s+this login is a person/);
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
