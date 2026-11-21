// bask eval (docs/ROADMAP.md, H): the four jobs of the README's "Four things to show" are run with
// an agent command and scored from the simulated station as the agent left it. A scripted agent that
// does the same thing each time gets the same score each time.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EVAL_TASKS, runEval } from "../dist/eval.js";
import { startDemoStation } from "../dist/demo/station.js";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bask-eval-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NET = "Drivers/BacnetNetwork";

// A trivial agent: for each task it runs a fixed list of bask commands. It finds two of the five
// faults, draws nothing, adds the controllers but not their points, and builds AHU-2's logic whole.
const agent = join(dir, "agent.mjs");
writeFileSync(agent, `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const task = process.env.BASK_EVAL_TASK;
const bask = (...args) => execFileSync("bask", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const change = ["--allow-writes", "-y", "--reason", "scripted eval agent"];
if (!process.env.BASK_EVAL_PROMPT.includes("bask agent-brief")) process.exit(3);
bask("agent-brief");
if (task === "northgate-faults") {
  writeFileSync("faults.md", "slot:/${NET}/VAV_107: device down\\nslot:/${NET}/CHW_Plant/points/Chiller2Status: in fault\\n");
  bask("put", "faults.md", "^notes/faults.md", ...change);
} else if (task === "harbor-graphics") {
  bask("browse", "${NET}");
} else if (task === "eastgate-bringup") {
  bask("discover", "${NET}", "--add", ...change);
} else if (task === "northgate-ahu2-logic") {
  const P = (name) => "slot:/${NET}/AHU_02/points/" + name;
  writeFileSync("plan.json", JSON.stringify({ changes: [
    { action: "create", parent: "slot:/Logic", name: "AHU_02", typeSpec: "baja:Folder", ref: "f" },
    { action: "create", parent: "@f", name: "SatReset", typeSpec: "kitControl:Reset", ref: "reset", properties: { inputLowLimit: { encoded: "55" }, inputHighLimit: { encoded: "80" }, outputLowLimit: { encoded: "57" }, outputHighLimit: { encoded: "54" } } },
    { action: "create", parent: "@f", name: "SatLoop", typeSpec: "kitControl:LoopPoint", ref: "loop", properties: { proportionalConstant: { encoded: "8" }, bias: { encoded: "55" } } },
    { action: "create_link", source: P("OutdoorAirTemp"), sourceSlot: "out", target: "@reset", targetSlot: "inA" },
    { action: "create_link", source: P("SupplyAirTemp"), sourceSlot: "out", target: "@loop", targetSlot: "controlledVariable" },
    { action: "create_link", source: "@reset", sourceSlot: "out", target: "@loop", targetSlot: "setpoint" },
    { action: "create_link", source: "@loop", sourceSlot: "out", target: P("CoolingValve"), targetSlot: "in10" }
  ] }));
  bask("plan", "plan.json", "--apply", ...change);
  // A point write waits for a person, and a file outside the agent's folders is refused: both are counted.
  bask("write", P("SupplyAirSetpoint"), "override", "56", ...change);
  try { bask("put", "plan.json", "^px/plan.json", ...change); } catch {}
}
`);
const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(agent)}`;
// Inside this test "this program" is the test file, so the agent's bask is named.
const bask = [process.execPath, main];
/** A result without what is allowed to differ between runs: how long it took. */
const steady = (result) => ({ ...result, tasks: result.tasks.map(({ seconds, ...rest }) => rest) });

test("the four tasks are the README's four things to show, each on its building", () => {
  assert.deepEqual(EVAL_TASKS.map((task) => [task.id, task.site]), [["northgate-faults", "northgate"], ["harbor-graphics", "harbor"], ["eastgate-bringup", "eastgate"], ["northgate-ahu2-logic", "northgate"]]);
  assert.equal(EVAL_TASKS[1].prompt, "Draw graphics for this building: the freezers and coolers, and the compressor rack.");
  assert.equal(EVAL_TASKS[2].prompt, "Discover the BACnet network and add everything it finds, then draw the plants and the air handlers with their zones.");
  assert.equal(EVAL_TASKS[3].prompt, "Give AHU-2 the same supply air reset and cooling loop as AHU-1.");
});

test("a station nobody touched scores nothing, except for leaving it alone", async () => {
  for (const task of EVAL_TASKS) {
    const station = await startDemoStation({ site: task.site, live: false });
    try {
      const { state } = station;
      const before = { nodes: state.nodes.size, links: state.links.map((l) => `${l.source}.${l.sourceSlot} → ${l.target}.${l.targetSlot}`), writes: state.counters.writes, proposals: state.proposals.size };
      const checks = task.score(station, before);
      assert.deepEqual(checks.filter((c) => c.got > 0).map((c) => c.name), task.id === "northgate-faults" ? ["nothing else was changed"] : task.id === "northgate-ahu2-logic" ? ["AHU-1's own logic is as it was"] : [], task.id);
    } finally {
      await station.close();
    }
  }
});

test("a scripted agent is scored from what it left on each station, and gets the same score twice", async () => {
  const first = await runEval({ agent: command, bask });
  const byId = Object.fromEntries(first.tasks.map((t) => [t.id, t]));
  const passed = (id) => byId[id].checks.filter((c) => c.got === 1).map((c) => c.name);

  // Two of five faults named, in a note that is on the station, and nothing else touched: 7 of 12.
  assert.deepEqual(passed("northgate-faults"), ["the note is on the station", "it names the device that is down", "it names the chiller status in fault", "nothing else was changed"]);
  assert.equal(byId["northgate-faults"].score, 0.583);
  // It looked and drew nothing.
  assert.equal(byId["harbor-graphics"].score, 0);
  assert.deepEqual(byId["harbor-graphics"].commands, ["agent-brief", `browse ${NET}`]);
  // All 46 controllers, none of their points, no graphics: 4 of 10.
  assert.deepEqual(byId["eastgate-bringup"].checks.map((c) => [c.got, c.detail]), [[1, "46 of 46"], [0, "0 of 614"], [0, "not drawn: CHW_Plant, HW_Plant, AHU_01, AHU_02, AHU_03, AHU_04"]]);
  assert.equal(byId["eastgate-bringup"].score, 0.4);
  // The logic is all there. The point write became a proposal and the file outside its folders was refused.
  assert.equal(byId["northgate-ahu2-logic"].score, 1);
  assert.deepEqual([byId["northgate-ahu2-logic"].proposed, byId["northgate-ahu2-logic"].refused, byId["northgate-ahu2-logic"].commands.length], [1, 1, 4]);
  assert.match(byId["northgate-ahu2-logic"].commands[1], /^plan plan\.json --apply --allow-writes -y --reason scripted eval agent$/);
  assert.equal(first.score, 0.496);
  assert.ok(first.tasks.every((t) => t.exitCode === 0 && !t.timedOut && t.seconds >= 0));

  const second = await runEval({ agent: command, bask });
  assert.deepEqual(steady(second), steady(first));
});

test("an agent that says it did the work and did nothing scores nothing; one that fails or runs long is reported", async () => {
  const talker = await runEval({ agent: "echo 'All four faults found and written to ^notes/faults.md. Done.'", tasks: ["northgate-faults"], bask });
  assert.deepEqual(talker.tasks[0].checks.filter((c) => c.got > 0).map((c) => c.name), ["nothing else was changed"]);
  assert.deepEqual([talker.tasks[0].commands, talker.tasks[0].exitCode], [[], 0]);

  const broken = await runEval({ agent: "exit 7", tasks: ["harbor-graphics"], bask });
  assert.deepEqual([broken.tasks[0].score, broken.tasks[0].exitCode, broken.tasks[0].timedOut], [0, 7, false]);
  const slow = await runEval({ agent: "sleep 30", tasks: ["harbor-graphics"], timeoutMs: 300, bask });
  assert.deepEqual([slow.tasks[0].exitCode, slow.tasks[0].timedOut], [null, true]);
  // The job is on standard input, and {task} in the command is filled in.
  const reads = await runEval({ agent: `grep -q 'compressor rack' && test {task} = harbor-graphics`, tasks: ["harbor-graphics"], bask });
  assert.equal(reads.tasks[0].exitCode, 0);
  await assert.rejects(runEval({ agent: "true", tasks: ["nope"] }), /No task named nope\. The tasks are: northgate-faults, harbor-graphics, eastgate-bringup, northgate-ahu2-logic\./);
});

test("from the command line: --list, a table with each check, and JSON", async () => {
  const env = { ...process.env, BASKSTREAM_CONFIG_DIR: join(dir, "config"), FORCE_COLOR: "0" };
  const bask = (...args) => run(process.execPath, [main, ...args], { env, maxBuffer: 16 * 1024 * 1024 }).then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code, out: e.stdout, err: e.stderr }));
  const listed = await bask("eval", "--list");
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /northgate-ahu2-logic +northgate +Give AHU-2 the same supply air reset and cooling loop as AHU-1\./);

  const none = await bask("eval");
  assert.equal(none.code, 1);
  assert.match(none.err, /Name the agent command to test/);

  const shown = await bask("eval", "--agent", command, "--task", "northgate-ahu2-logic", "northgate-faults");
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.match(shown.out, /northgate-faults +0\.583 +[\d.]+ s +2 +0 +0/);
  assert.match(shown.out, /northgate-ahu2-logic +1\.000 +[\d.]+ s +4 +1 +1/);
  assert.match(shown.out, /✓ AHU-2's cooling valve follows a loop/);
  assert.match(shown.out, /✗ it names the fan left overridden/);
  assert.match(shown.out, /score 0\.792 · the mean of 2 tasks, each scored from the simulated station as the agent left it/);

  const json = await bask("eval", "--agent", command, "--task", "eastgate-bringup", "-o", "json");
  const result = JSON.parse(json.out);
  assert.deepEqual([result.score, result.tasks.length, result.tasks[0].id, result.tasks[0].commands], [0.4, 1, "eastgate-bringup", ["agent-brief", `discover ${NET} --add --allow-writes -y --reason scripted eval agent`]]);
});
