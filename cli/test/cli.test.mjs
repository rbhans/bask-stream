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

test("query, station files, discovery and add (API 1.10)", async () => {
  const rows = await bask("query", "select slotPath, out.value from control:NumericPoint", "-o", "json");
  assert.equal(rows.code, 0, rows.out);
  assert.equal(JSON.parse(rows.out).rows[0][1], 72.5);
  assert.match((await bask("query", "--neql", "hs:vav")).out, /VAV 01/);

  assert.match((await bask("files", "^px")).out, /\^px\/Home\.px/);
  assert.equal((await bask("cat", "^px/Home.px")).out, "<px/>");
  const refused = await bask("put", main, "^px/Home.px");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /--allow-writes/);
  assert.match((await bask("put", main, "^px/Main.js", "--allow-writes", "--yes")).out, /Created \^px\/Main\.js/);
  assert.match((await bask("rm", "^px/Main.js", "--allow-writes", "--yes")).out, /Deleted/);

  const found = await bask("discover", "Drivers/Net/VAV_01", "--allow-writes", "--yes");
  assert.equal(found.code, 0, found.out);
  assert.match(found.out, /analogInput_3\s+SpaceTemp\s+analogInput:3/);
  const job = /bask add (\S+)/.exec(found.out)[1];
  assert.match((await bask("jobs")).out, /success/);
  const plan = await bask("add", job, "analogInput_3");
  assert.match(plan.out, /Nothing added yet/);
  assert.match((await bask("add", job, "all", "--apply", "--allow-writes", "--yes")).out, /Added 1/);
});

test("show leaves a request for the open dashboards", async () => {
  const trend = await bask("show", "Drivers/Net/VAV_01/points/SpaceTemp", "--trend");
  assert.equal(trend.code, 0, trend.out);
  assert.match(trend.out, /No bask window is open on 127\.0\.0\.1/);
  assert.match(trend.out, /VAV_01\/points\/SpaceTemp will be charted in Trends/);
  assert.match((await bask("show", "Drivers/Net/VAV_01/points/SpaceTemp", "--watch")).out, /added to the watch list/);
  const { Link } = await import("../dist/link.js");
  process.env.BASKSTREAM_CONFIG_DIR = configDir;
  const shared = new Link(station.url).get();
  assert.deepEqual(shared.watch, ["slot:/Drivers/Net/VAV_01/points/SpaceTemp"]);
  assert.deepEqual({ kind: shared.show.kind, ord: shared.show.ord }, { kind: "trend", ord: "slot:/Drivers/Net/VAV_01/points/SpaceTemp" });
});

test("agent-brief tells an agent how to work on this station", async () => {
  const { code, out } = await bask("agent-brief");
  assert.equal(code, 0, out);
  assert.match(out, /signed in as the Niagara user "test" \(bask profile "fake"\)/);
  assert.match(out, /--allow-writes -y --reason/);
  assert.match(out, /bask show --trend <ord>/);
  assert.match(out, /bask discover <network ord> --points --add/);
});

test("workspace plans its panes for Rex and tmux without starting anything", async () => {
  const { buildLayout, launch, shq } = await import("../dist/workspace.js");
  const agent = { label: "Claude Code", shell: "claude", env: { BASK_AGENT: "Claude Code" } };
  const ops = buildLayout({ layout: "ops", profile: "fake", allowWrites: false, agent });
  assert.deepEqual(ops.map((p) => p.label), ["Explorer", "Claude Code", "Alarms", "AI Activity"]);
  assert.match(ops[0].shell, /-p fake tui --view explorer --pane$/);
  assert.deepEqual(buildLayout({ layout: "ops", profile: "fake", allowWrites: true }).map((p) => p.label), ["Explorer", "Watch", "Alarms", "AI Activity"]);
  assert.match(buildLayout({ layout: "duo", profile: "fake", allowWrites: true, agent })[0].shell, /--allow-writes tui --view home$/);
  // Bringing a station up: the tree and the jobs, what gets drawn, the agent's record, and the agent.
  const build = buildLayout({ layout: "build", profile: "fake", allowWrites: false, agent, demo: "eastgate" });
  assert.deepEqual(build.map((p) => p.label), ["Explorer", "Claude Code", "Graphics", "Jobs", "AI Activity"]);
  assert.match(build[3].shell, /demo --site eastgate --view jobs --pane$/);
  assert.deepEqual(buildLayout({ layout: "build", profile: "fake", allowWrites: false }).map((p) => p.label), ["Explorer", "Graphics", "Jobs", "AI Activity"]);

  const rex = launch("rex", "bask-fake", ops, { rex: "rex", dryRun: true }).commands;
  assert.match(rex[0], /^rex new bask-fake --window Explorer --json -- sh .*explorer\.sh$/);
  assert.equal(rex.filter((c) => c.startsWith("rex split ")).length, 3);
  assert.match(rex[1], /--split=right --ratio 42 --label 'Claude Code'/);

  const tmux = launch("tmux", "bask-fake", ops, { dryRun: true });
  assert.match(tmux.commands[0], /^tmux new-session -d -s bask-fake /);
  assert.equal(tmux.commands.filter((c) => c.startsWith("tmux split-window ")).length, 3);
  assert.deepEqual(tmux.attach?.slice(0, 2), ["tmux", process.env.TMUX ? "switch-client" : "attach-session"]);
  assert.equal(shq("it's here"), `'it'\\''s here'`);
});

test("workspace --dry-run on the demo station prints the plan", async () => {
  const { code, out } = await bask("workspace", "--demo", "--dry-run", "--mux", "rex", "--no-agent", "--layout", "monitor");
  // Rex's command-line tool may not be installed where the tests run.
  if (code !== 0) return assert.match(out, /Rex's command-line tool was not found/);
  assert.match(out, /session bask-demo, layout monitor/);
  assert.match(out, /pane Home: .* demo --site northgate --view home --pane/);
  assert.equal((out.match(/ split -s /g) ?? []).length, 3);
});

test("demo --list names the simulated buildings, and each gets its own workspace", async () => {
  const list = await bask("demo", "--list");
  assert.equal(list.code, 0, list.out);
  for (const site of ["northgate", "riverside", "harbor", "summit", "eastgate"]) assert.match(list.out, new RegExp(`${site}\\s+\\w+\\s+47[89]\\d\\d`));
  assert.match(list.out, /northgate\s+Finished: a graphic for every piece of equipment/);
  assert.match(list.out, /harbor\s+No graphics yet/);
  assert.match(list.out, /eastgate\s+New station, nothing added/);
  const plan = await bask("workspace", "--demo", "--site", "all", "--dry-run", "--mux", "rex");
  if (plan.code !== 0) return assert.match(plan.out, /Rex's command-line tool was not found/);
  for (const session of ["bask-demo", "bask-demo-riverside", "bask-demo-harbor", "bask-demo-summit", "bask-demo-eastgate"]) assert.match(plan.out, new RegExp(`session ${session},`));
  assert.match(plan.out, /demo --site harbor --view explorer --pane/);
  // One agent per building is opt-in.
  assert.doesNotMatch(plan.out, /pane Claude Code/);
  // Another agent's command can be named, and the build layout has a pane for the jobs and one for the graphics.
  const build = await bask("workspace", "--demo", "--site", "eastgate", "--layout", "build", "--agent", "sh", "--dry-run", "--mux", "rex");
  assert.match(build.out, /# pane sh: sh/);
  assert.match(build.out, /demo --site eastgate --view jobs --pane/);
  assert.match(build.out, /demo --site eastgate --view graphics --pane/);
});

test("fleet needs a terminal and says so", async () => {
  const { code, out } = await bask("fleet", "--demo");
  assert.equal(code, 1);
  assert.match(out, /needs a terminal/);
});
