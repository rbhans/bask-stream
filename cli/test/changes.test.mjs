// bask and the API 1.14 change list: a change that waits for a person, the list, putting one back, and resolve.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let note;
const bask = (...args) =>
  run(process.execPath, [main, ...args], { env: { ...process.env, BASKSTREAM_CONFIG_DIR: configDir, BASKSTREAM_PASSWORD: PASSWORD, FORCE_COLOR: "0" } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e) => ({ code: e.code, out: e.stdout + e.stderr })
  );

before(async () => {
  station = await startFakeStation();
  configDir = mkdtempSync(join(tmpdir(), "bask-changes-"));
  note = join(configDir, "note.txt");
  writeFileSync(note, "a note from an agent");
  assert.equal((await bask("login", station.url, "-u", USER, "--name", "fake")).code, 0);
});
after(async () => {
  await station.close();
  rmSync(configDir, { recursive: true, force: true });
});

test("a change that waits for a person prints 'proposed' and exits with code 2", async () => {
  const kept = await bask("put", note, "^ask/note.txt", "--allow-writes", "-y", "--agent", "Claude Code", "--reason", "a test");
  assert.equal(kept.code, 2, kept.out);
  assert.match(kept.out, /proposed P1: write_file \^ask\/note\.txt/);
  assert.match(kept.out, /Not made yet.*bask approve P1/s);
  assert.equal(station.state.files.has("^ask/note.txt"), false);
  const json = await bask("put", note, "^ask/other.txt", "--allow-writes", "-y", "--agent", "Claude Code", "--reason", "a test", "-o", "json");
  assert.equal(json.code, 2, json.out);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.outcome, "proposed");
  assert.equal(parsed.proposal.kind, "files");
});

test("changes lists it; a person approves it and puts it back", async () => {
  const waiting = await bask("changes", "--status", "pending");
  assert.equal(waiting.code, 0, waiting.out);
  assert.match(waiting.out, /P1\s+pending\s+files/);
  assert.equal((await bask("approve", "P1", "--allow-writes", "-y")).code, 0);
  assert.equal(station.state.files.get("^ask/note.txt"), "a note from an agent");
  const listed = await bask("changes", "--kind", "files", "-o", "json");
  const first = JSON.parse(listed.out).find((c) => c.id === "P1");
  assert.equal(first.status, "approved");
  assert.equal(first.canRevert, true);
  const agentReverts = await bask("revert", "P1", "--allow-writes", "-y", "--agent", "Claude Code", "--reason", "a test");
  assert.equal(agentReverts.code, 1);
  assert.match(agentReverts.out, /agent_cannot_approve/);
  const back = await bask("revert", "P1", "--allow-writes", "-y");
  assert.equal(back.code, 0, back.out);
  assert.match(back.out, /P1 put back/);
  assert.equal(station.state.files.has("^ask/note.txt"), false);
  const again = await bask("revert", "P1", "--allow-writes", "-y");
  assert.equal(again.code, 1);
  assert.match(again.out, /not_revertible/);
  assert.match((await bask("revert", "P99", "--allow-writes", "-y")).out, /proposal_not_found/);
});

test("revert needs --allow-writes", async () => {
  assert.equal((await bask("approve", "P2", "--allow-writes", "-y")).code, 0);
  const refused = await bask("revert", "P2");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /--allow-writes/);
  assert.equal(station.state.files.has("^ask/other.txt"), true, "nothing was put back");
});

test("resolve finds a point by its role, and says when no match is clearly best", async () => {
  const found = await bask("resolve", "Drivers/Net/VAV_01", "zone", "temp");
  assert.equal(found.code, 0, found.out);
  assert.match(found.out, /✓ slot:\/Drivers\/Net\/VAV_01\/points\/SpaceTemp/);
  const unsure = await bask("resolve", "Drivers/Net/VAV_01", "discharge", "zone", "temp");
  assert.equal(unsure.code, 1);
  assert.match(unsure.out, /No match is clearly best/);
});
