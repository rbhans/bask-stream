// A workspace on a real station: the person stays on their own login, and the AI agent gets the
// Niagara user made for it. Run here on a demo station, which lets any user in with its password
// and counts ai-claude as an agent, the way a station with agentUsers set does.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chooseAgentLogin, describeChoice, openAgentLogin } from "../dist/agent-login.js";
import { loadStore, putProfile, removeProfile, updateProfile } from "../dist/config.js";
import { buildLayout, writePaneScripts } from "../dist/workspace.js";
import { startStation } from "./harness.mjs";

const run = promisify(execFile);
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const configDir = mkdtempSync(join(tmpdir(), "bask-agent-"));
process.env.BASKSTREAM_CONFIG_DIR = configDir;
let station;
let closeStation;
const bask = (env, ...args) =>
  run(process.execPath, [main, ...args], { env: { ...process.env, BASKSTREAM_CONFIG_DIR: configDir, BASKSTREAM_PASSWORD: "demo", FORCE_COLOR: "0", ...env } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e) => ({ code: e.code, out: e.stdout + e.stderr })
  );

before(async () => {
  ({ station, close: closeStation } = await startStation());
  assert.equal((await bask({}, "login", station.url, "-u", "admin", "--name", "stat")).code, 0);
});
after(async () => {
  await closeStation();
  rmSync(configDir, { recursive: true, force: true });
});

test("the agent's login is the one named, else the one used last time, else a saved profile that looks like one", () => {
  // Nothing saved but the person's own login: the agent would share it.
  assert.equal(chooseAgentLogin("stat"), undefined);
  // A Niagara user is named: a new profile for it, called ai while that name is free.
  assert.deepEqual(chooseAgentLogin("stat", { user: "ai-claude" }), { profile: "ai", user: "ai-claude", how: "asked", create: true });
  assert.throws(() => chooseAgentLogin("stat", { user: "Admin" }), /Admin is your own login/);

  // An old profile whose name says agent is only a guess, and it is described as one.
  putProfile("agent", { station: station.url, username: "test" }, false);
  const guess = chooseAgentLogin("stat");
  assert.deepEqual(guess, { profile: "agent", user: "test", how: "guessed" });
  assert.equal(describeChoice(guess), 'the saved profile "agent" for this station, picked by its name');
  // A profile named ai wins over it, and a named user that is already saved is reused.
  putProfile("ai", { station: station.url, username: "ai-claude" }, false);
  assert.equal(chooseAgentLogin("stat").profile, "ai");
  assert.deepEqual(chooseAgentLogin("stat", { user: "TEST" }), { profile: "agent", user: "test", how: "asked" });
  assert.deepEqual(chooseAgentLogin("stat", { user: "robo" }), { profile: "stat-ai", user: "robo", how: "asked", create: true });
  // What was used last time comes before any guess.
  updateProfile("stat", { agent: "agent" });
  assert.deepEqual(chooseAgentLogin("stat"), { profile: "agent", user: "test", how: "remembered" });
  assert.equal(describeChoice(chooseAgentLogin("stat")), 'profile "agent", as last time');
  assert.deepEqual(chooseAgentLogin("stat", { profile: "ai" }), { profile: "ai", user: "ai-claude", how: "asked" });

  // Not the person's own profile or user, and not another station's.
  assert.equal(chooseAgentLogin("stat", { profile: "stat" }), undefined);
  putProfile("twin", { station: station.url, username: "admin" }, false);
  assert.throws(() => chooseAgentLogin("stat", { profile: "twin" }), /signs in as admin, which is your own login/);
  putProfile("elsewhere", { station: "https://10.0.0.9", username: "ai-claude" }, false);
  assert.throws(() => chooseAgentLogin("stat", { profile: "elsewhere" }), /is for https:\/\/10\.0\.0\.9, not for http:\/\/127\.0\.0\.1/);
  assert.equal(chooseAgentLogin("stat").profile, "agent");
  updateProfile("stat", { agent: undefined });
  for (const name of ["agent", "ai", "twin", "elsewhere"]) removeProfile(name);
  assert.deepEqual(Object.keys(loadStore().profiles), ["stat"]);
});

test("opening the agent's login asks for its own password, saves it, remembers it and says whether the station counts it as an agent", async () => {
  const saved = { BASKSTREAM_PASSWORD: process.env.BASKSTREAM_PASSWORD, BASKSTREAM_AGENT_PASSWORD: process.env.BASKSTREAM_AGENT_PASSWORD };
  try {
    // The person's password is in the environment; it is never tried for the agent.
    process.env.BASKSTREAM_PASSWORD = "demo";
    process.env.BASKSTREAM_AGENT_PASSWORD = "not-it";
    updateProfile("stat", { insecure: true });
    await assert.rejects(openAgentLogin("stat", { profile: "ai", user: "ai-claude", how: "asked", create: true }), (error) => {
      assert.match(error.message, /The agent's login as ai-claude \(a new saved login, profile "ai"\) was not accepted: Login failed: wrong username or password\./);
      // The command to run carries -k when the station's certificate needs it.
      assert.match(error.message, new RegExp(`Log it in again: +bask login ${station.url} -u ai-claude --name ai -k\\n`));
      assert.match(error.message, /bask workspace --agent-user <user>\n.*bask workspace --no-agent/);
      return true;
    });
    assert.equal(loadStore().profiles.ai, undefined);
    assert.equal(loadStore().profiles.stat.agent, undefined);

    process.env.BASKSTREAM_AGENT_PASSWORD = "demo";
    const login = await openAgentLogin("stat", { profile: "ai", user: "ai-claude", how: "asked", create: true });
    assert.deepEqual([login.profile, login.user, login.listed, login.approval, login.create], ["ai", "ai-claude", true, true, undefined]);
    const store = loadStore();
    assert.equal(store.profiles.ai.username, "ai-claude");
    assert.ok(store.profiles.ai.cookies.JSESSIONID);
    assert.equal(store.profiles.stat.agent, "ai");
    assert.equal(store.current, "stat");
    assert.deepEqual(chooseAgentLogin("stat"), { profile: "ai", user: "ai-claude", how: "remembered" });

    // A user the station does not list as an agent is still signed in, and the caller is told.
    const other = await openAgentLogin("stat", chooseAgentLogin("stat", { user: "robo" }));
    assert.deepEqual([other.profile, other.user, other.listed], ["stat-ai", "robo", false]);
    updateProfile("stat", { agent: "ai" });
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});

test("the two logins are separate on the station: the agent's is an agent without saying so", async () => {
  const mine = await bask({}, "-p", "stat", "status");
  assert.match(mine.out, /user\s+admin/);
  assert.match(mine.out, /acting as\s+a person/);
  const agent = await bask({ BASKSTREAM_PROFILE: "ai" }, "status");
  assert.match(agent.out, /user\s+ai-claude/);
  assert.match(agent.out, /acting as\s+an AI agent/);
  // Its write waits for the person, who approves it from their own login.
  const point = "Drivers/BacnetNetwork/VAV_101/points/ZoneSetpoint";
  const proposed = await bask({ BASKSTREAM_PROFILE: "ai" }, "write", point, "override", "71", "--allow-writes", "-y", "--reason", "Room 101 is warm");
  assert.match(proposed.out, /Proposed P\d+/);
  const id = /Proposed (P\d+)/.exec(proposed.out)[1];
  assert.match((await bask({ BASKSTREAM_PROFILE: "ai" }, "approve", id, "--allow-writes", "-y")).out, /agent_cannot_approve/);
  assert.equal((await bask({}, "-p", "stat", "approve", id, "--allow-writes", "-y")).code, 0);
  assert.match((await bask({}, "profiles")).out, /\* stat\s+\S+\s+admin\s+saved\s+ai \(ai-claude\)/);
});

test("workspace says which login the agent gets, and its pane keeps that login in use", async () => {
  // The default agent is claude, and without it on the PATH the workspace has no agent pane: a stand-in
  // keeps this test meaningful where Claude Code is not installed (the release workflow's runners).
  const bin = mkdtempSync(join(tmpdir(), "bask-claude-"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const withClaude = { PATH: `${bin}${delimiter}${process.env.PATH}` };
  const plan = await bask(withClaude, "workspace", "--dry-run", "--mux", "tmux", "--layout", "graphics");
  if (plan.code !== 0) return assert.match(plan.out, /tmux is not installed/);
  assert.match(plan.out, /# agent login: ai-claude \(profile "ai", as last time\)/);
  assert.match(plan.out, /# pane Graphics: .* -p stat tui --view graphics --pane/);
  const fresh = await bask(withClaude, "workspace", "--dry-run", "--mux", "tmux", "--agent-user", "night-shift");
  assert.match(fresh.out, /# agent login: night-shift \(a new saved login, profile "stat-ai-2"\), logged in and saved when this runs/);
  assert.match((await bask(withClaude, "workspace", "--dry-run", "--mux", "tmux", "--agent-profile", "stat")).out, /# agent login: admin, shared with you/);
  assert.match((await bask(withClaude, "workspace", "--dry-run", "--mux", "tmux", "--demo", "--agent-user", "ai-claude")).out, /A simulated building has one login/);
  rmSync(bin, { recursive: true, force: true });

  // The agent's pane starts the keep-alive before its command, tied to that command's process.
  const panes = buildLayout({ layout: "duo", profile: "stat", allowWrites: false, agent: { label: "Claude Code", shell: "claude", env: { BASKSTREAM_PROFILE: "ai" }, before: ["bask keep-alive --while $$ >/dev/null 2>&1 &"] } });
  const script = readFileSync(writePaneScripts("bask-test", panes).get("agent"), "utf8");
  assert.match(script, /export BASKSTREAM_PROFILE=ai\nbask keep-alive --while \$\$ >\/dev\/null 2>&1 &\nexec claude\n$/);
});

test("keep-alive touches the saved login and stops when the process it follows is gone", async () => {
  const follow = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"]);
  const started = Date.now();
  const kept = await bask({ BASKSTREAM_PROFILE: "ai" }, "keep-alive", "--while", String(follow.pid), "--every", "1s");
  assert.equal(kept.code, 0, kept.out);
  assert.ok(Date.now() - started >= 1200 && Date.now() - started < 8000, `${Date.now() - started} ms`);
  // The login it kept is still good.
  assert.match((await bask({ BASKSTREAM_PROFILE: "ai", BASKSTREAM_PASSWORD: "" }, "status")).out, /user\s+ai-claude/);
});
