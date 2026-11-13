// What an AI agent may do by itself while its point writes wait for approval: the station's
// agentDirect settings (API 1.11), as the demo station applies them and as bask reports them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BaskStreamClient } from "@basidekick/baskstream";
import { directShort, directWork, mayWriteFile } from "../dist/agent-rules.js";
import { startStation } from "./harness.mjs";

const NET = "slot:/Drivers/BacnetNetwork";
let station;
let person;
let agent;
let closeStation;
const code = (work) => work.then(() => "ok", (error) => error.code);

before(async () => {
  ({ station, client: person, close: closeStation } = await startStation({ site: "harbor" }));
  agent = await BaskStreamClient.connect({ station: station.url, username: "ai-claude", password: station.password });
});
after(async () => {
  agent.close();
  await closeStation();
});

test("what the rules leave an agent free to do is read from capabilities, and an older station is not guessed at", () => {
  const rules = agent.capabilities.agents;
  // Signed in as the agent's own user, it is an agent without saying so.
  assert.equal(rules.isAgent, true);
  assert.deepEqual(rules.direct, { pointWrites: false, files: ["^bask/*", "^notes/*"], discovery: true, modelEdits: true, tags: true, schedules: false, alarms: false });
  assert.deepEqual(directWork(rules), { known: true, all: false, kinds: ["station files under ^bask/*, ^notes/*", "discovery", "model edits", "tags"] });
  assert.equal(directShort(rules), "direct: files, discovery, model edits, tags");
  assert.equal(mayWriteFile(rules, "^bask/graphics/ahu-01.json"), true);
  assert.equal(mayWriteFile(rules, "^px/Home.px"), false);
  assert.equal(mayWriteFile(rules, "^baskets/x.json"), false);

  // Before API 1.11 the station does not say: with approval on, only point-write proposals.
  const older = { isAgent: true, approvalRequired: true };
  assert.deepEqual(directWork(older), { known: false, all: false, kinds: [] });
  assert.equal(directShort(older), undefined);
  assert.equal(mayWriteFile(older, "^bask/graphics/ahu-01.json"), undefined);
  // Approval off: everything goes straight through.
  assert.deepEqual(directWork({ approvalRequired: false }), { known: true, all: true, kinds: ["every change its Niagara role allows"] });
  assert.equal(mayWriteFile({ approvalRequired: false }, "^px/Home.px"), true);
  // Nothing turned on.
  assert.equal(directShort({ approvalRequired: true, direct: { files: [] } }), "nothing else direct");
  assert.equal(person.capabilities.agents.isAgent, false);
});

test("an agent does the kinds of work that are turned on, and is told which setting a refused one needs", async () => {
  const reason = "Drawing the cold rooms";
  // Files: under the listed paths only.
  assert.equal(await code(agent.writeFile("^bask/graphics/x.json", { text: "{}" }, { reason })), "ok");
  assert.equal(await code(agent.writeFile("^notes/today.md", { text: "ok" }, { reason })), "ok");
  await assert.rejects(agent.writeFile("^px/Home.px", { text: "<px/>" }, { overwrite: true, reason }), (error) => {
    assert.equal(error.code, "approval_required");
    assert.match(error.message, /only under the paths in agentDirectFiles \(now \[\^bask\/\*, \^notes\/\*\]\), and \^px\/Home\.px is not under one\. A person can change that on BASkStreamService/);
    return true;
  });
  assert.equal(await code(agent.deleteFile("^px/Home.px", { reason })), "approval_required");
  assert.match(station.state.files.get("^px/Home.px").text, /Harbor Cold Storage/);
  // Looking is never a change: a dry run and a read go through.
  assert.equal(await code(agent.writeFile("^px/Home.px", { text: "<px/>" }, { overwrite: true, dryRun: true })), "ok");
  assert.equal(await code(agent.readFile("^px/Home.px")), "ok");

  // Alarms are left to people on this station; discovery and model plans are on.
  const alarm = [...station.state.alarms.values()].find((a) => a.ackState === "unacked");
  await assert.rejects(agent.ackAlarms({ uuids: [alarm.uuid] }, false, reason), (error) => {
    assert.equal(error.code, "approval_required");
    assert.match(error.message, /agents cannot ack_alarms directly unless agentDirectAlarms is on; it is off\./);
    return true;
  });
  assert.equal(alarm.ackState, "unacked");
  assert.equal(await code(agent.discover(NET, { reason })), "ok");
  assert.equal(await code(agent.discover(NET)), "reason_required");
  const plan = (await agent.call("preview_model_changes", { changes: [{ action: "rename", ord: `${NET}/Dock`, name: "Loading_Dock" }] })).result;
  assert.equal(await code(agent.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: "k1", reason })), "ok");
  assert.ok(station.state.nodes.has(`${NET}/Loading_Dock`));

  // Each refusal and each change is in the agent log.
  const log = (await person.agentLog({ since: Date.now() - 60000 })).records;
  assert.ok(log.some((r) => r.action === "write_file" && r.target === "file:^px/Home.px" && r.outcome === "refused" && r.code === "approval_required"));
  assert.ok(log.some((r) => r.action === "ack_alarms" && r.outcome === "refused"));
  assert.ok(log.some((r) => r.action === "write_file" && r.target === "file:^bask/graphics/x.json" && r.outcome === "completed" && r.reason === reason));
  // A person is not held to any of it.
  assert.equal(await code(person.writeFile("^px/Home.px", { text: "<px/>" }, { overwrite: true })), "ok");
  assert.equal(await code(person.ackAlarms({ uuids: [alarm.uuid] })), "ok");
});

test("a model plan is not a way round approval: an agent commands points with write", async () => {
  const point = `${NET}/Freezer_1/points/BoxSetpoint`;
  for (const change of [{ action: "invoke", ord: point, slot: "override", parameter: { typeSpec: "baja:Double", encoded: "5" } }, { action: "update", ord: point, properties: { fallback: { typeSpec: "baja:Double", encoded: "5" } } }]) {
    await assert.rejects(agent.call("preview_model_changes", { changes: [change] }), (error) => {
      assert.equal(error.code, "agent_use_write");
      assert.match(error.message, /Agents command points with the write operation/);
      return true;
    });
    // A person's plan may.
    assert.equal(await code(person.call("preview_model_changes", { changes: [change] })), "ok");
  }
  const written = await agent.call("write", { point, action: "override", value: -12, reason: "Colder for the delivery" });
  assert.equal(written.points[0].outcome, "proposed");
  // Other actions on the same point's device are still an agent's to invoke.
  assert.equal(await code(agent.call("preview_model_changes", { changes: [{ action: "invoke", ord: `${NET}/Freezer_1`, slot: "ping" }] })), "ok");
});

test("an agent's changes and proposals count against the station's limit per minute", async () => {
  const fresh = await startStation({ site: "summit" });
  const busy = await BaskStreamClient.connect({ station: fresh.station.url, username: "ai-claude", password: fresh.station.password });
  try {
    assert.equal(busy.capabilities.agents.maxChangesPerMinute, 120);
    for (let i = 0; i < 120; i += 1) await busy.writeFile(`^bask/tmp/${i}.txt`, { text: "x" }, { reason: "Filling the minute" });
    await assert.rejects(busy.writeFile("^bask/tmp/120.txt", { text: "x" }, { reason: "One too many" }), (error) => {
      assert.equal(error.code, "agent_rate_limited");
      assert.match(error.message, /120 changes or proposals per minute \(agentMaxChangesPerMinute\)/);
      return true;
    });
    // A person on the same station is not counted.
    await fresh.client.writeFile("^bask/tmp/person.txt", { text: "x" });
  } finally {
    busy.close();
    await fresh.close();
  }
});
