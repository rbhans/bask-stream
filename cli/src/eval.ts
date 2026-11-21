// bask eval: a test bench for agents (docs/ROADMAP.md, H). Each task starts a fresh simulated
// building, hands an agent command the job in words, lets it work through bask, and then scores the
// station as the agent left it. The score reads the simulated station (its components, links, files
// and what it logged), never what the agent says it did. The stations do not move while a task runs
// (their values are frozen and the scripted agent is off), so the same commands give the same score.
import chalk from "chalk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StationHttp } from "@basidekick/baskstream";
import type { DemoStation } from "./demo/station.js";
import type { SiteName } from "./demo/sites.js";
import { table } from "./format.js";
import { checkGraphic } from "./tui/symbols/graphic.js";
import { selfArgv, shq } from "./workspace.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface EvalCheck {
  name: string;
  /** 0 to 1: how much of this check the station's end state meets. */
  got: number;
  /** How much the check counts in the task's score. */
  weight: number;
  detail?: string;
}

export interface EvalTask {
  id: string;
  site: SiteName;
  title: string;
  /** What the agent is asked, in words. */
  prompt: string;
  /** Reads the station the agent worked on. */
  score(station: DemoStation, before: Baseline): EvalCheck[];
}

/** What a station held before the agent started, for checks that ask what changed. */
interface Baseline {
  nodes: number;
  links: string[];
  writes: number;
  proposals: number;
}

export interface EvalResult {
  id: string;
  site: SiteName;
  title: string;
  /** 0 to 1. */
  score: number;
  checks: EvalCheck[];
  seconds: number;
  /** The bask commands the agent ran, in order. */
  commands: string[];
  /** Changes the station refused the agent. */
  refused: number;
  /** Point writes that became proposals waiting for a person. */
  proposed: number;
  /** The agent command's exit code; null when it was stopped at the time limit. */
  exitCode: number | null;
  timedOut: boolean;
}

const NET = "slot:/Drivers/BacnetNetwork";
const check = (name: string, got: number | boolean, weight = 1, detail?: string): EvalCheck => ({ name, got: typeof got === "boolean" ? (got ? 1 : 0) : Math.max(0, Math.min(1, got)), weight, ...(detail ? { detail } : {}) });
const fileText = (station: DemoStation, file: string): string => (station.state.files.get(file)?.text as string | undefined) ?? "";
const linkKey = (l: any) => `${l.source}.${l.sourceSlot} → ${l.target}.${l.targetSlot}`;

/** How many of the named pieces of equipment a graphic saved on the station draws: a file that is a graphic with no errors and binds to that equipment's points. */
function drawn(station: DemoStation, equipment: string[]): { count: number; missing: string[] } {
  const good: string[] = [];
  for (const [file, entry] of station.state.files as Map<string, { text: string }>) {
    if (!/^\^bask\/graphics\/[^/]+\.json$/.test(file)) continue;
    try {
      if (!checkGraphic(JSON.parse(entry.text)).problems.some((p) => p.level === "error")) good.push(entry.text);
    } catch {
      // Not JSON: not a graphic.
    }
  }
  const missing = equipment.filter((name) => !good.some((text) => text.includes(`/${name}/`)));
  return { count: equipment.length - missing.length, missing };
}

/** The four jobs of the CLI README's "Four things to show", each with how the station is scored afterwards. */
export const EVAL_TASKS: EvalTask[] = [
  {
    id: "northgate-faults", site: "northgate", title: "A finished station: find what is wrong on it",
    prompt: "This is Northgate, a finished station. Find what is wrong on it now: devices that are down, points in fault or alarm, anything left overridden, any history that stopped recording. Write what you find to the station file ^notes/faults.md, one line for each fault, naming the component by its path. Change nothing else on the station.",
    score(station, before) {
      const note = fileText(station, "^notes/faults.md");
      const names = (...parts: string[]) => parts.every((part) => note.includes(part));
      return [
        check("the note is on the station", note.trim().length > 0, 1, "^notes/faults.md"),
        check("it names the device that is down", names("VAV_107"), 2),
        check("it names the chiller status in fault", names("Chiller2Status"), 2),
        check("it names the fan left overridden", names("AHU_02", "SupplyFanSpeed"), 2),
        check("it names the zone in alarm", names("VAV_105"), 1),
        check("it names the history that stopped", names("VAV_106", "Airflow"), 2),
        check("nothing else was changed", station.state.nodes.size === before.nodes && station.state.counters.writes === before.writes && station.state.proposals.size === before.proposals && station.state.links.length === before.links.length, 2)
      ];
    }
  },
  {
    id: "harbor-graphics", site: "harbor", title: "An agent draws the graphics",
    prompt: "Draw graphics for this building: the freezers and coolers, and the compressor rack.",
    score(station) {
      const cold = drawn(station, ["Freezer_1", "Freezer_2", "Freezer_3", "Freezer_4", "Cooler_1", "Cooler_2"]);
      const rack = drawn(station, ["Rack_A"]);
      return [
        check("the freezers and coolers are drawn", cold.count / 6, 6, cold.missing.length ? `not drawn: ${cold.missing.join(", ")}` : undefined),
        check("the compressor rack is drawn", rack.count, 2)
      ];
    }
  },
  {
    id: "eastgate-bringup", site: "eastgate", title: "An agent brings a station up",
    prompt: "Discover the BACnet network and add everything it finds, then draw the plants and the air handlers with their zones.",
    score(station) {
      const nodes = [...station.state.nodes.values()] as any[];
      const devices = nodes.filter((n) => n.ord.startsWith(`${NET}/`) && /Device$/.test(n.typeSpec));
      const points = nodes.filter((n) => n.ord.startsWith(`${NET}/`) && n.kind === "point");
      const graphics = drawn(station, ["CHW_Plant", "HW_Plant", "AHU_01", "AHU_02", "AHU_03", "AHU_04"]);
      return [
        check("the 46 controllers are in the station", devices.length / 46, 4, `${devices.length} of 46`),
        check("their 614 points are in the station", points.length / 614, 4, `${points.length} of 614`),
        check("the plants and air handlers are drawn", graphics.count / 6, 2, graphics.missing.length ? `not drawn: ${graphics.missing.join(", ")}` : undefined)
      ];
    }
  },
  {
    id: "northgate-ahu2-logic", site: "northgate", title: "An agent builds logic",
    prompt: "Give AHU-2 the same supply air reset and cooling loop as AHU-1.",
    score(station, before) {
      const { nodes, links } = station.state as { nodes: Map<string, any>; links: any[] };
      const P = (name: string) => `${NET}/AHU_02/points/${name}`;
      const feeds = (target: string, slot: string) => nodes.get(links.find((l) => l.target === target && l.targetSlot === slot)?.source ?? "");
      const from = (target: string | undefined, slot: string) => (target ? links.find((l) => l.target === target && l.targetSlot === slot)?.source : undefined);
      const loop = feeds(P("CoolingValve"), "in10");
      const isLoop = loop?.typeSpec === "kitControl:LoopPoint";
      const reset = isLoop ? feeds(loop.ord, "setpoint") : undefined;
      const isReset = reset?.typeSpec === "kitControl:Reset";
      const same = (block: any, like: string, slots: string[]) => Boolean(block) && slots.every((slot) => block.slots?.[slot] === nodes.get(like)?.slots?.[slot]);
      const mine = new Set(before.links);
      return [
        check("AHU-2's cooling valve follows a loop", isLoop, 2),
        check("the loop reads AHU-2's supply air temperature", isLoop && from(loop.ord, "controlledVariable") === P("SupplyAirTemp"), 2),
        check("its setpoint comes from a reset block", isReset, 2),
        check("the reset reads AHU-2's outdoor air temperature", isReset && from(reset.ord, "inA") === P("OutdoorAirTemp"), 2),
        check("the reset has AHU-1's limits", isReset && same(reset, "slot:/Logic/AHU_01/SatReset", ["inputLowLimit", "inputHighLimit", "outputLowLimit", "outputHighLimit"]), 1),
        check("the loop has AHU-1's tuning", isLoop && same(loop, "slot:/Logic/AHU_01/SatLoop", ["proportionalConstant", "bias", "loopAction"]), 1),
        check("AHU-1's own logic is as it was", before.links.every((key) => links.some((l) => linkKey(l) === key)) && links.filter((l) => !mine.has(linkKey(l))).every((l) => !String(l.target).startsWith(`${NET}/AHU_01/`) && !String(l.target).startsWith("slot:/Logic/AHU_01/")), 2)
      ];
    }
  }
];

const scoreOf = (checks: EvalCheck[]) => {
  const total = checks.reduce((n, c) => n + c.weight, 0);
  return total === 0 ? 0 : Math.round((checks.reduce((n, c) => n + c.weight * c.got, 0) / total) * 1000) / 1000;
};

export interface EvalOptions {
  /** The agent command, run through the shell. {prompt} and {task} in it are replaced; the prompt is also on its standard input. */
  agent: string;
  /** Task ids to run (default all). */
  tasks?: string[];
  /** The longest one task may take, in milliseconds (default 30 minutes). */
  timeoutMs?: number;
  /** Called as each task starts. */
  progress?: (text: string) => void;
  /** How to start bask for the agent (default: this program). */
  bask?: string[];
}

/** Runs one task: a fresh station, the agent, then the score. */
async function runTask(task: EvalTask, options: EvalOptions): Promise<EvalResult> {
  const { startDemoStation, DEMO_PASSWORD } = await import("./demo/station.js");
  const station = await startDemoStation({ site: task.site, live: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bask-eval-${task.id}-`));
  try {
    // The agent's own login: the station's agent user, so its rules apply and what is refused is logged.
    const agentUser = "ai-claude";
    const http = new StationHttp({ station: station.url });
    await http.login(agentUser, DEMO_PASSWORD);
    const config = path.join(dir, "config");
    fs.mkdirSync(config, { mode: 0o700 });
    fs.writeFileSync(path.join(config, "profiles.json"), JSON.stringify({ current: "eval", profiles: { eval: { station: station.url, username: agentUser, cookies: http.getCookies() } } }, null, 2), { mode: 0o600 });
    // `bask` on the agent's PATH is this bask, and writes down each command it is given.
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "commands.log");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "bask"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shq(log)}\nexec ${(options.bask ?? selfArgv()).map(shq).join(" ")} "$@"\n`, { mode: 0o755 });
    const work = path.join(dir, "work");
    fs.mkdirSync(work);

    const state = station.state as any;
    const before: Baseline = { nodes: state.nodes.size, links: state.links.map(linkKey), writes: state.counters.writes, proposals: state.proposals.size };
    const logged = state.agentLog.length;
    const prompt = `${task.prompt}\n\nWork through the bask command, which is on your PATH and already logged in to this station. Start with: bask agent-brief`;
    const command = options.agent.replace(/\{prompt\}/g, shq(prompt)).replace(/\{task\}/g, shq(task.id));
    const started = Date.now();
    const { exitCode, timedOut } = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(command, {
        shell: true, cwd: work, stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, BASKSTREAM_CONFIG_DIR: config, BASKSTREAM_PASSWORD: DEMO_PASSWORD, BASKSTREAM_PROFILE: "eval", BASK_AGENT: process.env.BASK_AGENT ?? "bask eval", BASK_EVAL_TASK: task.id, BASK_EVAL_PROMPT: prompt, FORCE_COLOR: "0" }
      });
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        child.kill("SIGKILL");
      }, options.timeoutMs ?? 30 * 60000);
      child.once("error", (error) => (clearTimeout(timer), reject(error)));
      child.once("close", (code) => (clearTimeout(timer), resolve({ exitCode: late ? null : code, timedOut: late })));
      child.stdin.on("error", () => undefined);
      child.stdin.end(`${prompt}\n`);
    });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const checks = task.score(station, before);
    const records = (state.agentLog as any[]).slice(logged);
    return {
      id: task.id, site: task.site, title: task.title, score: scoreOf(checks), checks, seconds,
      commands: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
      refused: records.filter((r) => r.outcome === "refused").length, proposed: state.proposals.size - before.proposals, exitCode, timedOut
    };
  } finally {
    await station.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the tasks one after another and returns each one's score. */
export async function runEval(options: EvalOptions): Promise<{ agent: string; score: number; tasks: EvalResult[] }> {
  if (process.platform === "win32") throw new Error("bask eval starts the agent through a POSIX shell, which Windows does not have. Run it under WSL.");
  const unknown = (options.tasks ?? []).filter((id) => !EVAL_TASKS.some((task) => task.id === id));
  if (unknown.length) throw new Error(`No task named ${unknown.join(", ")}. The tasks are: ${EVAL_TASKS.map((task) => task.id).join(", ")}.`);
  const chosen = EVAL_TASKS.filter((task) => !options.tasks?.length || options.tasks.includes(task.id));
  const tasks: EvalResult[] = [];
  for (const task of chosen) {
    options.progress?.(`${task.id}: ${task.title}`);
    tasks.push(await runTask(task, options));
  }
  return { agent: options.agent, score: Math.round((tasks.reduce((n, t) => n + t.score, 0) / Math.max(1, tasks.length)) * 1000) / 1000, tasks };
}

export function printEval(result: { agent: string; score: number; tasks: EvalResult[] }): void {
  const color = (score: number) => (score >= 0.9 ? chalk.green : score >= 0.5 ? chalk.yellow : chalk.red);
  console.log(table(["task", "score", "time", "commands", "refused", "proposed", ""], result.tasks.map((t) => [t.id, color(t.score)(t.score.toFixed(3)), `${t.seconds} s`, String(t.commands.length), String(t.refused), String(t.proposed), t.timedOut ? chalk.red("stopped at the time limit") : t.exitCode ? chalk.yellow(`the agent command ended with code ${t.exitCode}`) : ""])));
  for (const t of result.tasks) {
    console.log(`\n${chalk.bold(t.id)}  ${chalk.dim(t.title)}`);
    for (const c of t.checks) console.log(`  ${c.got === 1 ? chalk.green("✓") : c.got === 0 ? chalk.red("✗") : chalk.yellow("~")} ${c.name}${c.got > 0 && c.got < 1 ? chalk.dim(` (${Math.round(c.got * 100)}%)`) : ""}${c.detail ? chalk.dim(`  ${c.detail}`) : ""}`);
  }
  console.log(`\n${chalk.bold("score")} ${color(result.score)(result.score.toFixed(3))} ${chalk.dim(`· the mean of ${result.tasks.length} task${result.tasks.length === 1 ? "" : "s"}, each scored from the simulated station as the agent left it`)}`);
}
