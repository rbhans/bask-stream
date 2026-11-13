#!/usr/bin/env node
import chalk from "chalk";
import { Command, Option } from "commander";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BaskStreamError, OPERATIONS, StationHttp, toSlotOrd, type Actor, type AlarmFilter, type BrowseNode, type JobDetail, type Json, type Proposal } from "@basidekick/baskstream";
import { configDir, getProfile, loadStore, putProfile, removeProfile, setCurrent, updateProfile } from "./config.js";
import { alarmMessage, alarmState, csv, fmtDuration, isUnacked, fmtPoint, fmtTime, fmtValue, parseDuration, parseTime, parseValue, shortOrd, sparkline, statusColor, table } from "./format.js";
import { confirm, promptHidden } from "./prompt.js";
import { connect, type Connection } from "./session.js";
import { VERSION } from "./version.js";
import { splash, spinner } from "./splash.js";
import { DEMO_SITES, SITE_NAMES, type SiteName } from "./demo/sites.js";
import { Link } from "./link.js";
import { agentBrief, buildLayout, detectMux, launch, sessionExists, shq, writeShim, type LayoutName } from "./workspace.js";

const VIEW_NAMES = ["home", "explorer", "watch", "alarms", "trends", "schedules", "query", "files", "jobs", "activity", "graphics"] as const;
type ViewName = (typeof VIEW_NAMES)[number];

type Output = "table" | "json" | "csv";
interface Globals {
  profile?: string;
  output: Output;
  allowWrites?: boolean;
  yes?: boolean;
  agent?: string;
  model?: string;
  onBehalfOf?: string;
  reason?: string;
}

const program = new Command()
  .name("bask")
  .description("Browse, watch and work on Niagara stations over baskStream.\nRun with no command in a terminal to open the dashboard, bask workspace for a multi-pane workspace, or bask demo to try it without a station.")
  .version(VERSION)
  .option("-p, --profile <name>", "saved station profile (default: current)")
  .addOption(new Option("-o, --output <format>", "output format").choices(["table", "json", "csv"]).default("table"))
  .option("--allow-writes", "permit commands that change the station")
  .option("-y, --yes", "skip confirmation prompts (with --allow-writes)")
  .option("--reason <text>", "why: recorded with the change (agents must give one)")
  .option("--agent <name>", "act as an AI agent with this name (or set BASK_AGENT)")
  .option("--model <id>", "the agent's model (or BASK_MODEL)")
  .option("--on-behalf-of <person>", "who the agent acts for (or BASK_ON_BEHALF_OF)");

/** The AI agent this run declares, from options or environment; undefined for a person. */
function actorFrom(g: Globals): Actor | undefined {
  const name = g.agent ?? process.env.BASK_AGENT;
  if (!name) return undefined;
  return { kind: "agent", name, model: g.model ?? process.env.BASK_MODEL, onBehalfOf: g.onBehalfOf ?? process.env.BASK_ON_BEHALF_OF };
}

const reasonOf = (g: Globals) => (g.reason ? { reason: g.reason } : {});

const globals = (cmd: Command) => cmd.optsWithGlobals() as Globals & Record<string, unknown>;

/** Runs a command body with a connection, closing it afterwards. */
async function withClient<T>(cmd: Command, body: (conn: Connection, g: Globals & Record<string, unknown>) => Promise<T>): Promise<T> {
  const g = globals(cmd);
  const conn = await connect(g.profile, { actor: actorFrom(g) });
  try {
    return await body(conn, g);
  } finally {
    conn.client.close();
  }
}

function emit(g: Globals, headers: string[], rows: unknown[][], json: unknown, plain?: (row: unknown[]) => string[]): void {
  if (g.output === "json") console.log(JSON.stringify(json, null, 2));
  else if (g.output === "csv") console.log(csv(headers, rows));
  else console.log(table(headers, rows.map((r) => (plain ? plain(r) : r.map((c) => (typeof c === "string" ? c : fmtValue(c)))))));
}

async function requireWrite(g: Globals, question: string): Promise<void> {
  if (!g.allowWrites) throw new Error("This changes the station. Add --allow-writes to permit it.");
  if (g.yes) return;
  if (!(await confirm(question))) throw new Error("Cancelled.");
}

// ---- Profiles -------------------------------------------------------------------------------------

program
  .command("login")
  .description("log in to a station and save the session (the password is never stored)")
  .argument("<station>", "station URL, e.g. https://192.168.0.126")
  .requiredOption("-u, --user <username>", "Niagara username")
  .option("--name <profile>", "profile name (default: the station host)")
  .option("-k, --insecure", "accept a self-signed certificate")
  .action(async (station: string, opts: { user: string; name?: string; insecure?: boolean }) => {
    const url = new URL(/^https?:\/\//.test(station) ? station : `https://${station}`);
    const name = opts.name ?? url.hostname;
    const http = new StationHttp({ station: url.origin, verifyTls: !opts.insecure });
    const password = process.env.BASKSTREAM_PASSWORD ?? (await promptHidden(`Password for ${opts.user}@${url.host}: `));
    const health = await http.login(opts.user, password);
    putProfile(name, { station: url.origin, username: opts.user, insecure: opts.insecure || undefined, cookies: http.getCookies() });
    console.log(`${chalk.green("✓")} Logged in to ${url.host} as ${opts.user} (profile ${chalk.bold(name)}, API ${health.apiVersion ?? "?"}).`);
  });

program
  .command("logout")
  .description("forget the saved session (or the whole profile with --remove)")
  .option("--remove", "delete the profile too")
  .action((opts: { remove?: boolean }, cmd: Command) => {
    const { name } = getProfile(globals(cmd).profile);
    if (opts.remove) removeProfile(name);
    else updateProfile(name, { cookies: undefined });
    console.log(`${chalk.green("✓")} ${opts.remove ? "Removed" : "Logged out of"} ${name}.`);
  });

program
  .command("profiles")
  .description("list saved stations")
  .action(() => {
    const store = loadStore();
    const rows = Object.entries(store.profiles).map(([name, p]) => [name === store.current ? chalk.green(`* ${name}`) : `  ${name}`, p.station, p.username ?? "", p.cookies ? "saved" : "—"]);
    console.log(rows.length ? table(["  profile", "station", "user", "session"], rows) : "No profiles. Run: bask login <station> -u <user>");
  });

program
  .command("use")
  .description("switch the current profile")
  .argument("<profile>")
  .action((name: string) => {
    setCurrent(name);
    console.log(`${chalk.green("✓")} Using ${name}.`);
  });

program
  .command("doctor")
  .description("check everything bask needs, step by step, and say how to fix what fails")
  .argument("[station]", "check a station URL without a saved profile")
  .option("-k, --insecure", "with a station URL: accept a self-signed certificate")
  .action(async (station: string | undefined, opts: { insecure?: boolean }, cmd: Command) => {
    const { runDoctor } = await import("./doctor.js");
    console.log();
    const ok = await runDoctor(globals(cmd).profile, station, !!opts.insecure);
    if (!ok) process.exitCode = 1;
  });

// ---- Reading ----------------------------------------------------------------------------------------

program
  .command("status")
  .description("station, user, service limits and traffic")
  .action((_opts, cmd: Command) =>
    withClient(cmd, async ({ client, profileName }, g) => {
      const started = Date.now();
      await client.ping();
      const latency = Date.now() - started;
      const caps = client.capabilities;
      const metrics = await client.http.metrics().catch(() => "");
      if (g.output === "json") return console.log(JSON.stringify({ profile: profileName, latencyMs: latency, capabilities: caps, metrics }, null, 2));
      const limits = (caps.limits ?? {}) as Json;
      const model = (caps.modelEditing ?? {}) as Json;
      const rows = [
        ["station", client.http.url.origin],
        ["profile", profileName],
        ["user", String(caps.authenticatedUser ?? "?")],
        ["api", String(caps.apiVersion ?? "?")],
        ["latency", `${latency} ms`],
        ["writes", caps.writesEnabled ? chalk.yellow("enabled") : "disabled"],
        ["model edits", model.enabled ? chalk.yellow("enabled") : "disabled"],
        ["connections", `${limits.activeConnections ?? "?"} / ${limits.maxConnections ?? "?"}`],
        ["subscriptions", `${limits.totalSubscriptions ?? "?"} (max ${limits.maxSubscriptionsPerClient ?? "?"} per client)`]
      ];
      const agents = caps.agents as (Json & { actor?: Json; bounds?: string[] }) | undefined;
      if (agents?.isAgent) {
        rows.push(["acting as", `an AI agent${agents.actor?.name ? `: ${agents.actor.name}` : ""}${agents.actor?.onBehalfOf ? ` for ${agents.actor.onBehalfOf}` : ""}`]);
        rows.push(["agent rules", [agents.approvalRequired ? "point writes wait for a person's approval" : "point writes go straight through", agents.reasonRequired ? "every change needs --reason" : "", agents.maxChangesPerMinute ? `${agents.maxChangesPerMinute} changes a minute` : "", agents.allowEmergency ? "" : "no emergency overrides"].filter(Boolean).join(" · ")]);
        if (agents.bounds?.length) rows.push(["value limits", agents.bounds.join(" · ")]);
      } else if (agents) rows.push(["acting as", "a person"]);
      for (const line of metrics.split("\n")) {
        const match = /^baskstream_(\w+?)(?:_total)? (\d+)/.exec(line);
        if (match) rows.push([match[1].replace(/_/g, " "), match[2]]);
      }
      console.log(table(["", ""], rows).split("\n").slice(1).join("\n"));
    })
  );

program
  .command("browse")
  .description("list a station branch")
  .argument("[ord]", "slot:/ or hierarchy: ORD", "slot:/")
  .option("-d, --depth <n>", "levels to expand", "1")
  .action((ord: string, opts: { depth: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const node = await client.browse(normalizeOrd(ord), { depth: Number(opts.depth) });
      const rows: unknown[][] = [];
      const walk = (n: BrowseNode, level: number) => {
        for (const child of n.children ?? []) {
          rows.push([`${"  ".repeat(level)}${child.hasChildren ? "▸ " : "  "}${child.name}`, child.kind ?? "", child.typeSpec ?? "", child.status ?? "", child.ord]);
          walk(child, level + 1);
        }
      };
      walk(node, 0);
      emit(g, ["name", "kind", "type", "status", "ord"], rows, node, (r) => [kindColor(String(r[1]))(String(r[0])), String(r[1]), chalk.dim(String(r[2])), String(r[3]), chalk.dim(String(r[4]))]);
    })
  );

program
  .command("search")
  .description("find components by name/display text")
  .argument("<query>")
  .option("--base <ord>", "where to search", "slot:/")
  .option("--kind <kind>", "point, schedule, container or component")
  .option("--limit <n>", "maximum results", "100")
  .action((query: string, opts: { base: string; kind?: string; limit: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const reply = await client.search(normalizeOrd(opts.base), query, { kind: opts.kind, limit: Number(opts.limit), depth: 32 });
      const result = (reply.result ?? {}) as Json;
      const nodes = (result.nodes ?? []) as BrowseNode[];
      emit(g, ["name", "kind", "type", "ord"], nodes.map((n) => [n.name, n.kind ?? "", n.typeSpec ?? "", n.ord]), result);
    })
  );

program
  .command("read")
  .description("read current point values")
  .argument("<ords...>", "point ORDs (slot:/ prefix optional)")
  .option("--no-fresh", "don't wait for points nothing is subscribed to (e.g. unpolled proxy points)")
  .action((ords: string[], opts: { fresh: boolean }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const points = await client.read(ords.map(normalizeOrd), { fresh: opts.fresh });
      emit(g, ["point", "value", "status", "time"], points.map((p) => [p.point, fmtPoint(p), p.status ?? p.message ?? "", fmtTime(p.timestamp)]), points, (r) => [
        String(r[0]),
        chalk.bold(String(r[1])),
        statusColor(r[2])(String(r[2])),
        chalk.dim(String(r[3]))
      ]);
    })
  );

program
  .command("watch")
  .description("stream live values (opens the dashboard's watch view in a terminal unless --plain)")
  .argument("<ords...>", "point ORDs")
  .option("--plain", "print one line per change instead of the dashboard")
  .action(async (ords: string[], opts: { plain?: boolean }, cmd: Command) => {
    const g = globals(cmd);
    if (!opts.plain && g.output === "table" && process.stdout.isTTY) return runTui(g, { view: "watch", points: ords.map(normalizeOrd) });
    const conn = await connect(g.profile, { actor: actorFrom(g) });
    const { client } = conn;
    const watch = await client.watch(ords.map(normalizeOrd), { group: "bask-cli" });
    const print = (p: Json) => {
      if (g.output === "json") console.log(JSON.stringify(p));
      else if (g.output === "csv") console.log(csv([], [[p.timestamp, p.point, p.value, p.status]]).replace(/^\n/, ""));
      else console.log(`${chalk.dim(fmtTime(p.timestamp as number, false))}  ${shortOrd(String(p.point))}  ${chalk.bold(fmtPoint(p))}  ${statusColor(p.status)(String(p.status ?? ""))}`);
    };
    for (const p of watch.values.values()) print(p);
    watch.on("change", print);
    client.on("reconnecting", ({ delayMs }) => console.error(chalk.yellow(`connection lost; retrying in ${delayMs / 1000}s`)));
    client.on("reconnected", () => console.error(chalk.green("reconnected")));
    client.on("error", (error: Error) => console.error(chalk.red(error.message)));
    await new Promise<void>((resolve) => process.once("SIGINT", resolve));
    await watch.close();
    client.close();
  });

program
  .command("history")
  .description("history records, or time-bucketed rollups with --rollup")
  .argument("<ord>", "point ORD or history: ORD")
  .option("--since <time>", "start: 24h, 7d, an ISO date or epoch ms", "24h")
  .option("--until <time>", "end", "now")
  .option("--rollup <interval>", "bucket width, e.g. 15m, 1h, 1d")
  .option("--limit <n>", "maximum raw records", "1000")
  .action((ord: string, opts: { since: string; until: string; rollup?: string; limit: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const start = parseTime(opts.since);
      const end = parseTime(opts.until);
      if (opts.rollup) {
        const rollup = await client.historyRollup(normalizeOrd(ord), { start, end, interval: parseDuration(opts.rollup) });
        for (const h of (rollup.histories ?? []) as Json[]) {
          const buckets = (h.buckets ?? []) as Json[];
          const coverage = typeof h.coverage === "number" ? ` · ${Math.round(h.coverage * 100)}% coverage` : "";
          const gap = Number(h.longestGapMillis) > 0 ? ` · longest gap ${fmtDuration(Number(h.longestGapMillis))}` : "";
          if (g.output === "table") console.log(chalk.bold(String(h.historyId)), chalk.dim(`${buckets.length} buckets of ${opts.rollup}${coverage}${gap}`), sparkline(buckets.map((b) => Number(b.avg)).filter(Number.isFinite), 60));
          emit(g, ["start", "count", "min", "avg", "max", "last"], buckets.map((b) => [fmtTime(b.start), b.count, b.min, b.avg, b.max, b.last]), rollup);
          if (h.truncated) console.error(chalk.yellow(`truncated (${h.truncatedReason})`));
        }
        return;
      }
      const history = await client.history(normalizeOrd(ord), { start, end, limit: Number(opts.limit) });
      for (const h of (history.histories ?? []) as Json[]) {
        const records = (h.records ?? []) as Json[];
        if (g.output === "table") console.log(chalk.bold(String(h.historyId)), chalk.dim(`${records.length} records`), sparkline(records.map((r) => Number(r.value)).filter(Number.isFinite), 60));
        emit(g, ["time", "value", "status"], records.map((r) => [fmtTime(r.timestamp), r.value ?? r.summary, r.status ?? ""]), history);
        if (h.truncated) console.error(chalk.yellow("truncated: raise --limit or use --rollup"));
      }
    })
  );

program
  .command("alarms")
  .description("list alarms (newest first); --follow streams new events")
  .addOption(new Option("--scope <scope>", "which alarms").choices(["open", "ack_pending", "all"]).default("open"))
  .option("--class <names>", "alarm class name(s), comma separated")
  .option("--unacked", "only unacknowledged")
  .option("--since <time>", "only alarms after this time")
  .option("--source <ord>", "only alarms from this source")
  .option("--limit <n>", "maximum alarms", "100")
  .option("-f, --follow", "keep streaming alarm events")
  .action((opts: AlarmOptions & { follow?: boolean; limit: string; source?: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const reply = await client.alarms({ scope: opts.scope, limit: Number(opts.limit), order: "newest", filter: alarmFilter(opts), source: opts.source && normalizeOrd(opts.source) });
      const alarms = (reply.alarms ?? []) as Json[];
      emit(g, ["time", "pri", "class", "state", "ack", "source", "message", "uuid"], alarms.map(alarmRow), reply, alarmPlain);
      if (!opts.follow) return;
      await client.subscribeAlarms({ scope: "all", mode: "event", source: opts.source && normalizeOrd(opts.source) });
      client.on("alarm", (frame: Json) => {
        const event = frame.event as Json | null;
        if (!event) return;
        if (g.output === "json") console.log(JSON.stringify(event));
        else console.log(alarmPlain(alarmRow(event)).join("  "));
      });
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
    })
  );

interface AlarmOptions {
  scope: "open" | "ack_pending" | "all";
  class?: string;
  unacked?: boolean;
  since?: string;
}

function alarmFilter(opts: AlarmOptions): AlarmFilter | undefined {
  const filter: AlarmFilter = {};
  if (opts.class) filter.alarmClass = opts.class.split(",").map((s) => s.trim());
  if (opts.unacked) filter.ackState = "unacked";
  if (opts.since) filter.since = parseTime(opts.since);
  return Object.keys(filter).length ? filter : undefined;
}

const alarmRow = (a: Json): unknown[] => [fmtTime(a.timestamp), a.priority, a.alarmClass, alarmState(a), isUnacked(a) ? "unacked" : String(a.ackState ?? "").toLowerCase(), shortOrd(String(((a.sources ?? []) as string[])[0] ?? ""), 3), alarmMessage(a), a.uuid];
const alarmPlain = (r: unknown[]): string[] => {
  const state = String(r[3]);
  const colour = state === "normal" ? chalk.green : state === "fault" ? chalk.magenta : chalk.red;
  return [chalk.dim(String(r[0])), String(r[1]), String(r[2]), colour(state), r[4] === "unacked" ? chalk.bold.yellow("unacked") : chalk.dim(String(r[4])), String(r[5]), String(r[6]), chalk.dim(String(r[7]))];
};

for (const action of ["ack", "clear"] as const) {
  program
    .command(action)
    .description(action === "ack" ? "acknowledge alarms by UUID or by filter" : "force-clear alarms by UUID or by filter (admin)")
    .argument("[uuids...]", "alarm UUIDs; omit to use the filter options")
    .addOption(new Option("--scope <scope>", "which alarms the filter applies to").choices(["open", "ack_pending", "all"]).default("open"))
    .option("--class <names>", "alarm class name(s), comma separated")
    .option("--unacked", "only unacknowledged")
    .option("--since <time>", "only alarms after this time")
    .option("--dry-run", "show what would change")
    .action((uuids: string[], opts: AlarmOptions & { dryRun?: boolean }, cmd: Command) =>
      withClient(cmd, async ({ client }, g) => {
        const filter = alarmFilter(opts);
        if (uuids.length === 0 && !filter) throw new Error("Give alarm UUIDs or at least one filter (--class, --unacked, --since).");
        const target = uuids.length ? { uuids } : { filter: filter!, scope: opts.scope, limit: 1000 };
        const run = (dryRun: boolean) => (action === "ack" ? client.ackAlarms(target, dryRun, g.reason) : client.clearAlarms(target, dryRun, g.reason));
        const preview = await run(true);
        const count = Number(preview.matched ?? preview.count ?? uuids.length);
        if (opts.dryRun) return emit(g, ["uuid", "ok"], ((preview.alarms ?? []) as Json[]).map((a) => [a.uuid, a.ok]), preview);
        if (count === 0) return console.log("No matching alarms.");
        await requireWrite(g, `${action === "ack" ? "Acknowledge" : "Clear"} ${count} alarm(s)?`);
        const result = await run(false);
        const results = (result.alarms ?? []) as Json[];
        const failed = results.filter((a) => a.ok === false);
        console.log(`${chalk.green("✓")} ${results.length - failed.length} ${action === "ack" ? "acknowledged" : "cleared"}${failed.length ? chalk.red(`, ${failed.length} failed`) : ""}.`);
        for (const f of failed) console.log(chalk.red(`  ${f.uuid}: ${f.code} ${f.message}`));
      })
    );
}

program
  .command("write")
  .description("command a writable point: set, override, auto, emergency_override, emergency_auto")
  .argument("<ord>", "point ORD")
  .argument("<action>", "set | override | auto | emergency_override | emergency_auto")
  .argument("[value]", "value for set/override: number, true/false or text")
  .option("--for <duration>", "override duration, e.g. 30m")
  .action((ord: string, action: string, value: string | undefined, opts: { for?: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const point = normalizeOrd(ord);
      const parsed = value === undefined ? undefined : parseValue(value);
      await requireWrite(g, `${action} ${shortOrd(point, 3)}${parsed === undefined ? "" : ` = ${parsed}`}${opts.for ? ` for ${opts.for}` : ""}?`);
      const result = await client.write(point, action, parsed, { ...(opts.for ? { durationSec: Math.round(parseDuration(opts.for) / 1000) } : {}), ...reasonOf(g) });
      if (g.output === "json") return console.log(JSON.stringify(result, null, 2));
      if (result.ok === false) throw new BaskStreamError(String(result.code), String(result.message), "write");
      if (result.outcome === "proposed") {
        const proposal = result.proposal as Proposal;
        return console.log(`${chalk.yellow("◷")} Proposed ${chalk.bold(proposal.id)}: ${proposal.description} on ${shortOrd(point, 3)}. Waiting for a person to approve (expires ${fmtTime(proposal.expiresAt, false)}).`);
      }
      console.log(`${chalk.green("✓")} ${shortOrd(point, 3)}: ${fmtValue(result.value)} ${statusColor(result.status)(String(result.status ?? ""))}${result.activeLevel ? chalk.dim(` (active level ${result.activeLevel})`) : ""}`);
    })
  );

program
  .command("schedule")
  .description("a schedule's current output and upcoming changes")
  .argument("<ord>", "schedule ORD")
  .option("--days <n>", "how far ahead to list changes", "7")
  .action((ord: string, opts: { days: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const schedule = await client.schedule(normalizeOrd(ord));
      const now = Date.now();
      const events = await client.scheduleEvents(normalizeOrd(ord), { start: now, end: now + Number(opts.days) * 86400000 });
      if (g.output === "json") return console.log(JSON.stringify({ schedule, events }, null, 2));
      console.log(`${chalk.bold(String(schedule.display ?? schedule.name))}  now ${chalk.bold(fmtValue(schedule.currentOutput ?? schedule.effectiveValue))}  ${chalk.dim(String(schedule.status ?? ""))}`);
      emit(g, ["time", "output"], ((events.events ?? []) as Json[]).map((e) => [fmtTime(e.time), fmtValue(e.value)]), events);
    })
  );

program
  .command("call")
  .description("send any operation with a JSON body, e.g. bask call describe '{\"ord\":\"slot:/Drivers\"}'")
  .argument("<op>", `one of: ${Object.keys(OPERATIONS).join(", ")}`)
  .argument("[json]", "request fields as JSON", "{}")
  .action((op: string, body: string, _opts, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const gate = (OPERATIONS as Record<string, { gate: string }>)[op]?.gate;
      const fields = JSON.parse(body) as Json;
      if (gate && gate !== "none" && fields.dryRun !== true) await requireWrite(g, `Send ${op}?`);
      if (g.reason && fields.reason === undefined) fields.reason = g.reason;
      console.log(JSON.stringify(await client.call(op, fields), null, 2));
    })
  );

// ---- AI agents (docs/AI_AGENTS.md) ----------------------------------------------------------------

const proposalRow = (p: Proposal): unknown[] => [
  p.id,
  p.status,
  p.description,
  p.point,
  p.actor?.name ? `${p.actor.name}${p.actor.onBehalfOf ? ` for ${p.actor.onBehalfOf}` : ""}` : p.agentUser,
  p.reason ?? "",
  p.status === "pending" ? `expires ${fmtTime(p.expiresAt, false)}` : `${p.decidedBy ?? ""} ${fmtTime(p.decidedAt ?? undefined, false)}`.trim()
];
const proposalPlain = (r: unknown[]): string[] => [
  chalk.bold(String(r[0])),
  r[1] === "pending" ? chalk.yellow(String(r[1])) : r[1] === "approved" ? chalk.green(String(r[1])) : r[1] === "failed" ? chalk.red(String(r[1])) : chalk.dim(String(r[1])),
  String(r[2]),
  chalk.cyan(shortOrd(String(r[3]), 3)),
  String(r[4]),
  String(r[5]),
  chalk.dim(String(r[6]))
];

program
  .command("proposals")
  .description("point writes AI agents proposed, waiting for a person (--all includes the last hour's decisions)")
  .option("--all", "include approved, rejected, failed and expired proposals")
  .action((opts: { all?: boolean }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const list = await client.proposals(opts.all ? undefined : "pending");
      if (list.length === 0 && g.output === "table") return console.log(opts.all ? "No proposals in the last hour." : "Nothing waiting.");
      emit(g, ["id", "status", "change", "point", "agent", "reason", "when"], list.map(proposalRow), list, proposalPlain);
    })
  );

for (const decision of ["approve", "reject"] as const) {
  program
    .command(decision)
    .description(decision === "approve" ? "approve an agent's proposal; the write runs with your permissions" : "reject an agent's proposal")
    .argument("<id>", "proposal id, e.g. P7")
    .option("--note <text>", "a note for the agent (reject)")
    .action((id: string, opts: { note?: string }, cmd: Command) =>
      withClient(cmd, async ({ client }, g) => {
        const wanted = /^\d+$/.test(id) ? `P${id}` : id.toUpperCase();
        const proposal = (await client.proposals()).find((p) => p.id === wanted);
        if (!proposal) throw new BaskStreamError("proposal_not_found", `No proposal ${wanted} that you can see.`);
        const question = `${decision === "approve" ? "Approve" : "Reject"} ${proposal.id}: ${proposal.description} on ${shortOrd(proposal.point, 3)}${proposal.reason ? ` ("${proposal.reason}")` : ""}?`;
        if (decision === "approve") await requireWrite(g, question);
        else if (!g.yes && !(await confirm(question))) throw new Error("Cancelled.");
        const result = decision === "approve" ? await client.approveProposal(proposal.id) : await client.rejectProposal(proposal.id, opts.note);
        if (g.output === "json") return console.log(JSON.stringify(result, null, 2));
        if (result.status === "failed") throw new Error(`${result.id} was approved but the write failed: ${result.note}`);
        console.log(`${chalk.green("✓")} ${result.id} ${result.status}.`);
      })
    );
}

program
  .command("agent-log")
  .description("what AI agents did: proposals, decisions, direct changes and refusals, from the station's audit history")
  .option("--since <time>", "start: 24h, 7d, an ISO date or epoch ms", "24h")
  .option("--limit <n>", "maximum records", "100")
  .action((opts: { since: string; limit: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const log = await client.agentLog({ since: parseTime(opts.since), limit: Number(opts.limit) });
      emit(g, ["time", "user", "outcome", "change", "target", "agent", "reason"],
        log.records.map((r) => [fmtTime(r.timestamp), r.user, r.outcome ?? "", r.change ?? r.action, r.target, [r.agent, r.for && `for ${r.for}`].filter(Boolean).join(" "), r.reason ?? ""]),
        log, (r) => [chalk.dim(String(r[0])), String(r[1]), String(r[2]), String(r[3]), chalk.cyan(shortOrd(String(r[4]), 3)), String(r[5]), String(r[6])]);
      if (log.truncated) console.error(chalk.yellow("More records exist: narrow --since or raise --limit."));
    })
  );

// ---- Headless Workbench (docs/HEADLESS_WORKBENCH.md) ----------------------------------------------

program
  .command("query")
  .description("run a BQL select, or a NEQL tag query with --neql, e.g. bask query \"select slotPath, out.value from control:NumericPoint\"")
  .argument("<text>", "the query, without the bql: or neql: prefix")
  .option("--neql", "the text is NEQL (tags), e.g. \"hs:ahu and hs:equip\"")
  .option("--base <ord>", "where the query starts", "slot:/")
  .option("--limit <n>", "maximum rows", "500")
  .action((text: string, opts: { neql?: boolean; base: string; limit: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const result = await client.query(opts.neql ? { neql: text } : { bql: text }, { ord: normalizeOrd(opts.base), limit: Number(opts.limit) });
      if (result.entities) {
        emit(g, ["ord", "name", "type"], result.entities.map((e) => [e.ord, e.display || e.name, e.typeSpec]), result, (r) => [chalk.cyan(String(r[0])), String(r[1]), chalk.dim(String(r[2]))]);
      } else {
        const cell = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
        emit(g, (result.columns ?? []).map((c) => c.name), (result.rows ?? []).map((row) => row.map(cell)), result);
      }
      if (result.truncated) console.error(chalk.yellow(`Stopped by the ${result.stoppedBy ?? "limit"} after ${result.count} rows.`));
      if (result.hidden) console.error(chalk.dim(`${result.hidden} rows you may not see were left out.`));
    })
  );

program
  .command("files")
  .description("list a folder of the station's files, e.g. bask files ^px")
  .argument("[path]", "folder in the station file space", "^")
  .action((path: string, _opts, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const folder = await client.listFiles(path);
      emit(g, ["path", "size", "modified"], folder.entries.map((e) => [e.directory ? `${e.path}/` : e.path, e.directory ? "" : e.size ?? "", e.modified ? fmtTime(e.modified) : ""]),
        folder, (r) => [String(r[0]).endsWith("/") ? chalk.cyan(String(r[0])) : String(r[0]), String(r[1]), chalk.dim(String(r[2]))]);
    })
  );

program
  .command("cat")
  .description("print a station file, or save it with --out")
  .argument("<path>", "file in the station file space, e.g. ^px/Home.px")
  .option("--out <file>", "save to a local file instead of printing")
  .action((path: string, opts: { out?: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const file = await client.readFile(path);
      const bytes = file.encoding === "text" ? Buffer.from(file.text ?? "", "utf8") : Buffer.from(file.base64 ?? "", "base64");
      if (opts.out) {
        writeFileSync(opts.out, bytes);
        return console.error(`${chalk.green("✓")} ${path} → ${opts.out} (${bytes.length} bytes)`);
      }
      if (g.output === "json") return console.log(JSON.stringify(file, null, 2));
      if (file.encoding !== "text") throw new Error(`${path} is not text; save it with --out <file>.`);
      process.stdout.write(file.text ?? "");
    })
  );

program
  .command("put")
  .description("upload a local file to the station's files, e.g. bask put Home.px ^px/Home.px")
  .argument("<file>", "local file")
  .argument("<path>", "destination in the station file space")
  .option("--overwrite", "replace the file if it exists")
  .action((local: string, path: string, opts: { overwrite?: boolean }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const bytes = readFileSync(local);
      await requireWrite(g, `Write ${bytes.length} bytes to ${path}?`);
      const file = await client.writeFile(path, { base64: bytes.toString("base64") }, { overwrite: Boolean(opts.overwrite), ...reasonOf(g) });
      if (g.output === "json") return console.log(JSON.stringify(file, null, 2));
      console.log(`${chalk.green("✓")} ${file.created ? "Created" : "Replaced"} ${path} (${bytes.length} bytes).`);
    })
  );

program
  .command("rm")
  .description("delete a station file, or a folder and its contents with --recursive")
  .argument("<path>", "file or folder in the station file space")
  .option("--recursive", "delete a folder together with its contents")
  .action((path: string, opts: { recursive?: boolean }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const preview = await client.deleteFile(path, { recursive: Boolean(opts.recursive), dryRun: true });
      const doomed = (preview.deleted ?? []) as string[];
      await requireWrite(g, `Delete ${doomed.length === 1 ? path : `${path} and ${doomed.length - 1} entries under it`}?`);
      const file = await client.deleteFile(path, { recursive: Boolean(opts.recursive), ...reasonOf(g) });
      if (g.output === "json") return console.log(JSON.stringify(file, null, 2));
      console.log(`${chalk.green("✓")} Deleted ${doomed.length === 1 ? path : `${doomed.length} entries`}.`);
    })
  );

const jobState = (state: string) => (state === "success" ? chalk.green(state) : state === "failed" ? chalk.red(state) : state === "running" ? chalk.yellow(state) : chalk.dim(state));

program
  .command("jobs")
  .description("the station's jobs, with state and progress")
  .action((_opts, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const jobs = await client.jobs();
      if (jobs.length === 0 && g.output === "table") return console.log("No jobs.");
      emit(g, ["job", "state", "progress", "started", "type"], jobs.map((j) => [j.job ?? j.name, j.state, `${j.progress}%`, j.startTime ? fmtTime(j.startTime) : "", j.typeSpec]),
        jobs, (r) => [chalk.cyan(shortOrd(String(r[0]), 2)), jobState(String(r[1])), String(r[2]), chalk.dim(String(r[3])), chalk.dim(String(r[4]))]);
    })
  );

const resultRow = (r: JobDetail["results"][number]): unknown[] => {
  const values = (r.values && typeof r.values === "object" ? r.values : {}) as Record<string, unknown>;
  return [r.slot, values.objectName ?? values.deviceName ?? "", values.objectId ?? "", values.description ?? values.modelName ?? ""];
};

async function showJob(client: Connection["client"], g: Globals, ord: string): Promise<JobDetail> {
  const job = await client.job(ord, { limit: 1000 });
  if (g.output === "json") {
    console.log(JSON.stringify(job, null, 2));
    return job;
  }
  console.log(`${chalk.cyan(job.job ?? job.name)}  ${jobState(job.state)}  ${job.progress}%`);
  for (const item of job.log.slice(-10)) console.log(`  ${chalk.dim(item.timestamp ? fmtTime(item.timestamp) : "")}  ${item.kind}  ${item.message}`);
  if (job.resultCount > 0) {
    console.log("");
    emit(g, ["slot", "name", "id", "detail"], job.results.map(resultRow), job, (r) => [chalk.bold(String(r[0])), String(r[1]), String(r[2]), chalk.dim(String(r[3]))]);
    if (job.nextOffset !== null) console.error(chalk.yellow(`Showing ${job.results.length} of ${job.resultCount} results.`));
  }
  return job;
}

program
  .command("job")
  .description("one job: state, log and what it found (discovered devices or points)")
  .argument("<ord>", "the job's ORD, from bask jobs or bask discover")
  .option("--cancel", "cancel the job")
  .action((ord: string, opts: { cancel?: boolean }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      if (opts.cancel) {
        await requireWrite(g, `Cancel ${ord}?`);
        const job = await client.cancelJob(normalizeOrd(ord), g.reason);
        return console.log(g.output === "json" ? JSON.stringify(job, null, 2) : `${chalk.green("✓")} ${job.name} ${job.state}.`);
      }
      await showJob(client, g, normalizeOrd(ord));
    })
  );

/** Every result of a job, a page at a time. */
async function jobResults(client: Connection["client"], job: string): Promise<JobDetail["results"]> {
  const all: JobDetail["results"] = [];
  for (let offset = 0; ; ) {
    const page = await client.job(job, { offset, limit: 1000 });
    all.push(...page.results);
    if (page.nextOffset === null || page.nextOffset === undefined || page.results.length === 0) return all;
    offset = page.nextOffset;
  }
}

/** Waits for a job to finish. */
async function jobDone(client: Connection["client"], job: string, timeout: string): Promise<void> {
  const deadline = Date.now() + parseDuration(timeout);
  for (let wait = 400; ; wait = Math.min(1000, wait + 200)) {
    if ((await client.job(job, { limit: 1 })).complete) return;
    if (Date.now() > deadline) throw new Error(`Still running after ${timeout}: bask job ${job}`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** A name with Niagara's $xx escapes undone and everything but letters and digits dropped, for comparing. */
const looseName = (name: unknown) => String(name ?? "").replace(/\$([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))).toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Makes and applies the plan that adds some results of a discovery job, 100 at a time. Returns the ORDs added. */
async function addResults(client: Connection["client"], g: Globals, job: string, slots: string[], parent?: string): Promise<string[]> {
  const added: string[] = [];
  for (let at = 0; at < slots.length; at += 100) {
    const plan = await client.addDiscovered(job, slots.slice(at, at + 100).map((slot) => ({ slot })), parent ? { parent } : {});
    const applied = (await client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: randomUUID(), ...reasonOf(g) }, { timeoutMs: 300000 })).result as Json;
    const results = (applied.results ?? []) as Json[];
    const failed = results.filter((r) => r.ok === false);
    if (applied.state !== "applied" || failed.length > 0) throw new Error(`The plan ended ${applied.state}: ${failed.length} of ${results.length} changes failed. bask call model_plan_status '{"planId":"${plan.planId}"}'`);
    added.push(...results.map((r) => String(r.ord ?? "")).filter(Boolean));
  }
  return added;
}

/** Runs `work` over `items`, a few at a time, keeping the order of the results. */
async function pooled<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  }));
  return out;
}

program
  .command("discover")
  .description("discover BACnet devices on a network, or the points of devices, and show what was found; --add adds it")
  .argument("<ords...>", "a BACnet network, or one or more devices")
  .option("--points", "for a network: discover the points of every device on it")
  .option("--add", "add everything found that is not already there")
  .option("--no-wait", "start the job and return its ORD without waiting")
  .option("--timeout <duration>", "how long to wait for each job", "2m")
  .action((ords: string[], opts: { points?: boolean; add?: boolean; wait: boolean; timeout: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      let targets = ords.map(normalizeOrd);
      if (opts.points) {
        // The devices under each network; a device named directly stays as it is.
        const devices: string[] = [];
        for (const ord of targets) {
          const node = await client.browse(ord, { depth: 1 });
          const under = (node.children ?? []).filter((child) => /Device$/.test(String(child.typeSpec ?? ""))).map((child) => toSlotOrd(child.ord));
          if (under.length) devices.push(...under);
          else if (/Device$/.test(String(node.typeSpec ?? ""))) devices.push(ord);
        }
        if (devices.length === 0) throw new Error(`No devices under ${ords.join(", ")} yet. Discover and add them first: bask discover ${ords[0]} --add`);
        targets = devices;
      }
      const simple = targets.length === 1 && !opts.add;
      if (!opts.wait && !simple) throw new Error("--no-wait starts one job and returns its ORD; it does not go with --add or several devices.");
      await requireWrite(g, `Start discovery on ${targets.length === 1 ? shortOrd(targets[0], 3) : `${targets.length} devices`}${opts.add ? " and add what it finds" : ""}? This puts traffic on the driver's network.`);

      if (simple) {
        const discovery = await client.discover(targets[0], reasonOf(g));
        if (!opts.wait) return console.log(g.output === "json" ? JSON.stringify(discovery, null, 2) : discovery.job);
        const spin = g.output === "table" ? spinner("discovering") : undefined;
        try {
          await jobDone(client, discovery.job, opts.timeout);
        } finally {
          spin?.stop();
        }
        const job = await showJob(client, g, discovery.job);
        if (g.output === "table" && job.resultCount > 0) {
          console.error(chalk.dim(`\nAdd some: bask add ${discovery.job} <slot> [<slot>...]${discovery.kind === "devices" ? " --parent <network>" : ""} --apply`));
          console.error(chalk.dim(`Add them all: bask discover ${ords.join(" ")}${opts.points ? " --points" : ""} --add`));
        }
        return;
      }

      // Several devices, or adding: one line as each finishes, then the totals.
      const outcomes = await pooled(targets, 6, async (target) => {
        const discovery = await client.discover(target, reasonOf(g));
        await jobDone(client, discovery.job, opts.timeout);
        const results = await jobResults(client, discovery.job);
        const names = results.map((r) => String((r.values as Json | undefined)?.objectName ?? (r.values as Json | undefined)?.deviceName ?? r.slot));
        let added: string[] = [];
        let skipped = 0;
        if (opts.add && results.length) {
          // Devices go under the network that was searched; points go where the station puts them (the device's points).
          const parent = discovery.kind === "devices" ? target : undefined;
          const where = parent ?? (/\/points$/.test(target) ? target : `${target}/points`);
          const there = new Set(((await client.browse(where, { depth: 1 }).catch(() => undefined))?.children ?? []).map((child) => looseName(child.name)));
          const fresh = results.filter((_r, i) => !there.has(looseName(names[i])));
          skipped = results.length - fresh.length;
          added = await addResults(client, g, discovery.job, fresh.map((r) => r.slot), parent);
        }
        if (g.output === "table") {
          const count = `${results.length} ${discovery.kind === "devices" ? "device" : "point"}${results.length === 1 ? "" : "s"}`;
          console.error(`  ${chalk.green("✓")} ${chalk.bold(shortOrd(target, 2))}  ${count} found${opts.add ? `, ${added.length} added${skipped ? chalk.dim(`, ${skipped} already there`) : ""}` : ""}`);
        }
        return { target, job: discovery.job, kind: discovery.kind, found: results.length, names, added, skipped };
      });

      const found = outcomes.reduce((n, o) => n + o.found, 0);
      const added = outcomes.flatMap((o) => o.added);
      const skipped = outcomes.reduce((n, o) => n + o.skipped, 0);
      if (added.length) new Link(client.http.url.origin).show("reveal", added[0]);
      if (g.output !== "table") return console.log(JSON.stringify(outcomes.map((o) => ({ target: o.target, job: o.job, kind: o.kind, found: o.found, added: o.added.length, alreadyThere: o.skipped, names: o.names })), null, 2));
      const kind = outcomes[0]?.kind === "devices" ? "device" : "point";
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
      if (outcomes.length === 1 && outcomes[0].names.length) console.log(outcomes[0].names.join("  "));
      const where = outcomes.length === 1 ? shortOrd(outcomes[0].target, 3) : plural(outcomes.length, "device");
      if (!opts.add) return console.log(`Found ${plural(found, kind)} on ${where}. Nothing added: run again with --add, or pick some with bask add <job> <slot>... --apply.`);
      console.log(`${chalk.green("✓")} Found ${plural(found, kind)} on ${where}: added ${added.length}${skipped ? `, ${skipped} already there` : ""}.`);
      if (kind === "device" && added.length) console.log(chalk.dim(`  Next, their points: bask discover ${ords.join(" ")} --points --add`));
    })
  );

program
  .command("add")
  .description("add discovered devices or points: shows the plan, and --apply makes the changes")
  .argument("<job>", "the discovery job's ORD")
  .argument("<slots...>", "result slots from bask job, or \"all\"")
  .option("--parent <ord>", "where to add (required for devices: the network or a device folder)")
  .option("--apply", "apply the plan after showing it")
  .action((jobOrd: string, slots: string[], opts: { parent?: string; apply?: boolean }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const job = normalizeOrd(jobOrd);
      const parent = opts.parent ? normalizeOrd(opts.parent) : undefined;
      const wanted = slots.length === 1 && slots[0] === "all" ? (await jobResults(client, job)).map((r) => r.slot) : slots;
      if (wanted.length === 0) throw new Error("That job found nothing to add.");
      if (!opts.apply) {
        // The plan for the first hundred is enough to see what adding would do.
        const plan = await client.addDiscovered(job, wanted.slice(0, 100).map((slot) => ({ slot })), parent ? { parent } : {});
        const items = (plan.items ?? []) as Json[];
        if (g.output !== "table") return console.log(JSON.stringify(plan, null, 2));
        emit(g, ["slot", "name", "type", "facets"], items.map((i) => [i.slot, i.name, i.typeSpec, i.facetsLearned === false ? "not learned" : i.facetsLearned ? "learned" : ""]), plan,
          (r) => [String(r[0]), chalk.bold(String(r[1])), chalk.dim(String(r[2])), r[3] === "not learned" ? chalk.yellow(String(r[3])) : chalk.dim(String(r[3]))]);
        return console.error(chalk.dim(`\nNothing added yet${wanted.length > 100 ? ` (the first 100 of ${wanted.length} are shown)` : ""}. Run again with --apply to add ${wanted.length === 1 ? "it" : `these ${wanted.length}`}.`));
      }
      await requireWrite(g, `Add ${wanted.length} discovered ${wanted.length === 1 ? "result" : "results"}?`);
      const added = await addResults(client, g, job, wanted, parent);
      if (added.length) new Link(client.http.url.origin).show("reveal", added[0]);
      if (g.output !== "table") return console.log(JSON.stringify({ added }, null, 2));
      console.log(`${chalk.green("✓")} Added ${wanted.length}.`);
    })
  );

program
  .command("metrics")
  .description("print the service's OpenMetrics text")
  .action(async (_opts, cmd: Command) => {
    const { profile } = getProfile(globals(cmd).profile);
    const http = new StationHttp({ station: profile.station, verifyTls: !profile.insecure, cookies: profile.cookies });
    process.stdout.write(await http.metrics());
  });

interface TuiOptions {
  view?: ViewName;
  pane?: boolean;
  mouse?: boolean;
  theme?: "dark" | "light";
}
const tuiOptions = (cmd: Command) =>
  cmd
    .addOption(new Option("--view <name>", "the view to open").choices([...VIEW_NAMES]))
    .option("--pane", "one view per window, for a multiplexer pane (no tab row)")
    .option("--no-mouse", "leave the mouse to the terminal (text selection)")
    .addOption(new Option("--theme <name>", "colours (default: from the terminal, or BASK_THEME)").choices(["dark", "light"]));

tuiOptions(program.command("tui", { isDefault: true }))
  .description("open the full-screen dashboard (default when run in a terminal)")
  .action(async (opts: TuiOptions, cmd: Command) => {
    const g = globals(cmd);
    if (!process.stdout.isTTY) return program.help();
    await runTui(g, opts);
  });

async function runTui(g: Globals, start: TuiOptions & { points?: string[]; shared?: boolean }): Promise<void> {
  if (!start.pane) process.stderr.write(`${splash()}\n`);
  const spin = spinner("connecting");
  let conn: Connection;
  try {
    conn = await connect(g.profile, { beforePrompt: spin.stop, actor: actorFrom(g) });
  } catch (error) {
    spin.stop();
    throw error;
  }
  const caps = conn.client.capabilities;
  spin.done(`  ${chalk.green("✓")} Connected to ${chalk.bold(conn.client.http.url.host)} as ${caps.authenticatedUser ?? "?"} ${chalk.dim(`· API ${caps.apiVersion ?? "?"}`)}`);
  conn.stopPrompting();
  const { runDashboard } = await import("./tui/run.js");
  await runDashboard(conn, { allowWrites: !!g.allowWrites, ...start });
}

// ---- Demo station and workspaces ------------------------------------------------------------------

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

/**
 * Makes sure a demo site's station is running and saved as a profile. The first window to ask hosts
 * it; later ones (other panes, an agent's bask) join it. Returns the station when this process hosts it.
 */
async function ensureDemo(siteKey: SiteName, portOverride?: number) {
  const { startDemoStation, DEMO_PASSWORD, DEMO_USER } = await import("./demo/station.js");
  const site = DEMO_SITES[siteKey];
  const port = portOverride ?? site.port;
  const url = `http://127.0.0.1:${port}`;
  const station = (await portOpen(port)) ? undefined : await startDemoStation({ port, site: siteKey }).catch((error: Error & { code?: string }) => (error.code === "EADDRINUSE" ? undefined : Promise.reject(error)));
  for (let tries = 0; !station && tries < 40 && !(await portOpen(port)); tries += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  putProfile(site.profile, { station: url, username: DEMO_USER }, false);
  process.env.BASKSTREAM_PASSWORD = DEMO_PASSWORD;
  // A few points to watch, the first time this site is opened.
  const link = new Link(url);
  if (link.get().watch.length === 0) link.update((shared) => void (shared.watch = site.watch.map((path) => `slot:/Drivers/BacnetNetwork/${path.replace("/", "/points/")}`)));
  return { site, port, url, station, password: DEMO_PASSWORD, user: DEMO_USER };
}

const siteOption = () => new Option("--site <name>", `which simulated building: ${SITE_NAMES.join(", ")}`).choices(SITE_NAMES).default("northgate");

tuiOptions(program.command("demo"))
  .description("try the dashboard on a built-in simulated building: no station needed")
  .addOption(siteOption())
  .option("--fleet", "all the simulated buildings at once, in the all-stations view")
  .option("--port <n>", "port for the demo station (default: each site has its own)")
  .option("--serve", "only run the demo station (other windows connect with bask demo)")
  .option("--list", "list the simulated buildings")
  .action(async (opts: TuiOptions & { site: SiteName; fleet?: boolean; port?: string; serve?: boolean; list?: boolean }, cmd: Command) => {
    if (opts.list) {
      console.log(table(["site", "station", "port", "profile", "what it is"], SITE_NAMES.map((key) => [key, DEMO_SITES[key].station, String(DEMO_SITES[key].port), DEMO_SITES[key].profile, DEMO_SITES[key].title])));
      return console.log(`\n${table(["site", "how it starts"], SITE_NAMES.map((key) => [key, DEMO_SITES[key].shows]))}`);
    }
    if (opts.fleet) return fleet(globals(cmd), [], { demo: true, mouse: opts.mouse, theme: opts.theme });
    const demo = await ensureDemo(opts.site, opts.port ? Number(opts.port) : undefined);
    if (opts.serve) {
      if (!demo.station) throw new Error(`Port ${demo.port} is already in use. A demo station may be running; try bask demo --site ${opts.site}.`);
      console.log(`${chalk.green("✓")} ${demo.site.station} demo station at ${demo.url} (user ${demo.user}, password ${demo.password}). Open it with: bask demo --site ${opts.site}   ·   ctrl+c stops it.`);
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      return demo.station.close();
    }
    if (!process.stdout.isTTY) throw new Error("bask demo opens the dashboard, which needs a terminal.");
    try {
      await runTui({ ...globals(cmd), profile: demo.site.profile, allowWrites: true }, { view: opts.view, pane: opts.pane, mouse: opts.mouse, theme: opts.theme });
    } finally {
      await demo.station?.close();
    }
  });

/** The all-stations view over saved profiles, or over every demo site. */
async function fleet(g: Globals, profiles: string[], opts: { demo?: boolean; mouse?: boolean; theme?: "dark" | "light" }): Promise<void> {
  if (!process.stdout.isTTY) throw new Error("The all-stations view needs a terminal.");
  const hosted: { close(): Promise<void> }[] = [];
  let names = profiles;
  let password: string | undefined;
  const labels = new Map<string, string>();
  if (opts.demo) {
    for (const key of SITE_NAMES) {
      const demo = await ensureDemo(key);
      if (demo.station) hosted.push(demo.station);
      password = demo.password;
      labels.set(demo.site.profile, demo.site.station);
    }
    names = SITE_NAMES.map((key) => DEMO_SITES[key].profile);
  } else if (names.length === 0) {
    // Every saved station once: the current profile's login where a station has several.
    const store = loadStore();
    const byStation = new Map<string, string>();
    for (const name of [store.current, ...Object.keys(store.profiles)]) {
      const profile = name ? store.profiles[name] : undefined;
      if (name && profile && !/^demo(-|$)/.test(name) && !byStation.has(profile.station)) byStation.set(profile.station, name);
    }
    names = [...byStation.values()];
  }
  if (names.length === 0) throw new Error("No saved stations to show. Log in to some with bask login, or try: bask fleet --demo");

  const clients: Connection["client"][] = [];
  const { runFleet } = await import("./tui/run.js");
  const entries = names.map((name) => {
    const { profile } = getProfile(name);
    return {
      profile: name,
      label: labels.get(name) ?? name,
      host: new URL(profile.station).host,
      link: new Link(profile.station),
      connect: async () => {
        const conn = await connect(name, { prompt: false, password, actor: actorFrom(g) });
        clients.push(conn.client);
        return conn.client;
      }
    };
  });
  try {
    await runFleet(entries, { allowWrites: !!g.allowWrites || !!opts.demo, mouse: opts.mouse, theme: opts.theme });
  } finally {
    for (const client of clients) client.close();
    for (const entry of entries) entry.link.stop();
    for (const station of hosted) await station.close();
  }
}

program
  .command("fleet")
  .description("watch several stations at once: a card per station with its alarms, AI activity and live values; enter opens one")
  .argument("[profiles...]", "saved profiles to show (default: every saved station)")
  .option("--demo", "the simulated buildings instead of saved stations")
  .option("--no-mouse", "leave the mouse to the terminal (text selection)")
  .addOption(new Option("--theme <name>", "colours (default: from the terminal, or BASK_THEME)").choices(["dark", "light"]))
  .action((profiles: string[], opts: { demo?: boolean; mouse?: boolean; theme?: "dark" | "light" }, cmd: Command) => fleet(globals(cmd), profiles, opts));

program
  .command("workspace")
  .alias("ws")
  .description("lay out a station workspace in Rex or tmux: station panes plus an AI agent session")
  .addOption(new Option("--layout <name>", "ops: explorer, alarms, AI activity and the agent · graphics: the station's graphics, AI activity and the agent · build: explorer, jobs, graphics, AI activity and the agent, for bringing a station up · monitor: home, alarms, watch, AI activity · duo: dashboard and the agent").choices(["ops", "graphics", "build", "monitor", "duo"]).default("ops"))
  .addOption(new Option("--mux <name>", "which multiplexer").choices(["auto", "rex", "tmux"]).default("auto"))
  .option("--agent <command>", "the AI agent to start in its pane", "claude")
  .option("--no-agent", "station panes only")
  .option("--agent-profile <name>", "profile the agent connects with (default: an agent profile for this station, else the same profile)")
  .option("--session <name>", "name for the multiplexer session")
  .option("--demo", "use a built-in simulated building instead of a station")
  .option("--site <name>", `with --demo: which building (${SITE_NAMES.join(", ")}), or all for a session each`, "northgate")
  .option("--dry-run", "print what would be started, and start nothing")
  .option("--no-attach", "tmux: create the session without switching to it")
  .action(async (opts: { layout: LayoutName; mux: string; agent: string | false; agentProfile?: string; session?: string; demo?: boolean; site: string; dryRun?: boolean; attach: boolean }, cmd: Command) => {
    const g = globals(cmd);
    // "--agent <x>" is also a global option (the name bask itself acts under), and the global one
    // takes the value wherever it is written. Here it means the agent's command.
    if (cmd.getOptionValueSource("agent") === "default" && program.getOptionValueSource("agent") === "cli") opts.agent = String(program.opts().agent);
    const found = detectMux(opts.mux === "auto" ? undefined : opts.mux);
    if (!found.mux) throw new Error(found.why);
    if (opts.demo && opts.site !== "all" && !SITE_NAMES.includes(opts.site as SiteName)) throw new Error(`No demo site "${opts.site}". Choose one of: ${SITE_NAMES.join(", ")}, or all.`);
    const sites: (SiteName | undefined)[] = !opts.demo ? [undefined] : opts.site === "all" ? SITE_NAMES : [opts.site as SiteName];
    // One agent per building is a lot of agents: with --site all they are left out unless asked for.
    if (sites.length > 1 && cmd.getOptionValueSource("agent") === "default") opts.agent = false;
    for (const siteKey of sites) await launchOne(siteKey);

   async function launchOne(siteKey: SiteName | undefined): Promise<void> {
    const mux = found.mux!;
    const site = siteKey ? DEMO_SITES[siteKey] : undefined;

    // The station, and a working session for it (the password is asked for here, once, if needed).
    let profile = site?.profile ?? "demo";
    let info = { station: `${site?.station ?? "Northgate"} (demo)`, host: `127.0.0.1:${site?.port ?? 47899}`, user: "admin" };
    const env: Record<string, string> = {};
    if (site) {
      const { DEMO_PASSWORD } = await import("./demo/station.js");
      env.BASKSTREAM_PASSWORD = DEMO_PASSWORD;
    } else {
      const chosen = getProfile(g.profile);
      profile = chosen.name;
      info = { station: chosen.name, host: new URL(chosen.profile.station).host, user: chosen.profile.username ?? "" };
      if (!opts.dryRun) {
        const conn = await connect(profile);
        if (typeof conn.client.capabilities.station === "string") info.station = conn.client.capabilities.station;
        conn.client.close();
      }
    }

    // The agent: its command, the profile it connects with, and a briefing on how to use bask here.
    let agentProfile = site ? profile : opts.agentProfile ?? profile;
    if (!site && !opts.agentProfile) {
      const store = loadStore();
      const mine = store.profiles[profile];
      // A profile for the same station under another user that looks like an AI's: "ai" first, then agent.
      const rank = (name: string, user: string) => (/^ai$/i.test(name) ? 4 : /^ai[-_ ]|[-_ ]ai$/i.test(name) || /^ai[-_]/i.test(user) ? 3 : /claude|codex|gpt|gemini/i.test(`${name} ${user}`) ? 2 : /agent/i.test(`${name} ${user}`) ? 1 : 0);
      const candidate = Object.entries(store.profiles)
        .filter(([name, p]) => name !== profile && p.station === mine.station && p.username !== mine.username)
        .map(([name, p]) => ({ name, rank: rank(name, p.username ?? "") }))
        .sort((x, y) => y.rank - x.rank)[0];
      if (candidate && candidate.rank > 0) agentProfile = candidate.name;
    }
    let session = opts.session ?? `bask-${profile.replace(/[^\w-]/g, "-")}`;
    if (!opts.dryRun) for (let n = 2; sessionExists(mux, session, found.rex); n += 1) session = `${(opts.session ?? `bask-${profile.replace(/[^\w-]/g, "-")}`)}-${n}`;

    let agent: Parameters<typeof buildLayout>[0]["agent"];
    const notes: string[] = [];
    if (opts.agent) {
      const program_ = opts.agent.trim().split(/\s+/)[0];
      const installed = spawnSync("sh", ["-c", `command -v ${shq(program_)}`], { stdio: "ignore" }).status === 0;
      if (!installed) notes.push(`${program_} was not found, so the workspace has no agent pane. Install it, or name another with --agent <command>.`);
      else {
        if (agentProfile !== profile && !opts.dryRun) {
          const conn = await connect(agentProfile).catch((error: Error) => {
            throw new Error(`The agent's profile "${agentProfile}" could not connect (${error.message}). Run: bask login ${getProfile(agentProfile).profile.station} -u ${getProfile(agentProfile).profile.username} --name ${agentProfile}`);
          });
          conn.client.close();
        }
        const agentUser = site ? "admin" : getProfile(agentProfile).profile.username ?? info.user;
        const dir = path.join(configDir(), "workspaces", session.replace(/[^\w.-]/g, "_"));
        const brief = path.join(dir, "STATION.md");
        if (!opts.dryRun) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          writeFileSync(brief, agentBrief({ ...info, user: agentUser, profile: agentProfile, demo: !!site }));
        }
        const isClaude = /(^|\/)claude$/.test(program_);
        agent = {
          label: isClaude ? "Claude Code" : path.basename(program_),
          shell: isClaude ? `${opts.agent} --append-system-prompt "$(cat ${shq(brief)})"` : opts.agent,
          cwd: process.cwd(),
          env: { BASKSTREAM_PROFILE: agentProfile, BASK_AGENT: isClaude ? "Claude Code" : path.basename(program_), BASK_ON_BEHALF_OF: os.userInfo().username, BASK_STATION_BRIEF: brief, PATH: `${opts.dryRun ? path.join(configDir(), "bin") : writeShim()}${path.delimiter}${process.env.PATH ?? ""}` }
        };
        if (!isClaude) notes.push(`${agent.label} is not told about the station automatically: point it at the briefing in $BASK_STATION_BRIEF (${brief}).`);
        if (agentProfile === profile && !site) notes.push(`The agent shares your login (${info.user}). For its own Niagara user, save a profile for it and pass --agent-profile <name>.`);
      }
    }

    const panes = buildLayout({ layout: opts.layout, profile, allowWrites: !!g.allowWrites, env, agent, demo: siteKey });
    const result = launch(mux, session, panes, { rex: found.rex, dryRun: opts.dryRun });
    if (opts.dryRun) {
      console.log(chalk.dim(`# ${mux} (${found.why}), session ${session}, layout ${opts.layout}`));
      for (const pane of panes) console.log(chalk.dim(`# pane ${pane.label}: ${pane.shell.replace(/"\$\(cat [^)]*\)"/, '"<station briefing>"')}`));
      for (const line of result.commands) console.log(line);
      for (const note of notes) console.error(chalk.yellow(note));
      return;
    }
    console.log(`${chalk.green("✓")} Workspace ${chalk.bold(session)} is up in ${mux === "rex" ? "Rex" : "tmux"}: ${panes.map((p) => p.label).join(" · ")}.`);
    if (mux === "rex" && !process.env.REX_SESSION) console.log(chalk.dim(`  Switch to the "${session}" session in Rex to see it.`));
    for (const note of notes) console.log(chalk.yellow(`  ${note}`));
    console.log(chalk.dim(`  In any station pane: 1-0 switch view, / find, : commands, W allow changes, ? help.${agent ? " The agent's changes show up in the AI Activity pane; approve with a, reject with x." : ""}`));
    if (result.attach && opts.attach && process.stdout.isTTY && sites.length === 1) spawnSync(result.attach[0], result.attach.slice(1), { stdio: "inherit" });
    else if (result.attach) console.log(chalk.dim(`  Open it with: ${result.attach.join(" ")}`));
   }
  });

program
  .command("symbols")
  .description("browse the terminal symbol library: equipment drawn in text, moving, with its states and example assemblies")
  .option("--list", "print the symbols and their sizes instead of opening the gallery")
  .option("--no-mouse", "leave the mouse to the terminal (text selection)")
  .addOption(new Option("--theme <name>", "colours (default: from the terminal, or BASK_THEME)").choices(["dark", "light"]))
  .action(async (opts: { list?: boolean; mouse?: boolean; theme?: "dark" | "light" }) => {
    if (opts.list || !process.stdout.isTTY) {
      const { SYMBOLS, sizeOf } = await import("./tui/symbols/library.js");
      return console.log(table(["symbol", "size", "group", "what it draws"], SYMBOLS.map((s) => [s.id, sizeOf(s.draw(s.sample, 0)).join(" x "), s.group, s.note])));
    }
    const { runGallery } = await import("./tui/run.js");
    await runGallery({ mouse: opts.mouse, theme: opts.theme });
  });

// ---- Graphics --------------------------------------------------------------------------------------

const graphic = program
  .command("graphic")
  .description("drawings of the station's equipment made from the symbol library: write one as a small JSON file, print it, save it on the station");

graphic
  .command("guide")
  .description("how to write a graphic: the file format, every symbol and its ports, and an example")
  .action(async () => {
    const { graphicGuide } = await import("./tui/symbols/graphic.js");
    process.stdout.write(graphicGuide());
  });

/** A graphic from a local JSON file, or by name from the station when no such file exists. */
async function graphicSource(target: string, client?: Connection["client"]): Promise<{ raw: unknown; from: string }> {
  const { existsSync } = await import("node:fs");
  if (existsSync(target)) {
    try {
      return { raw: JSON.parse(readFileSync(target, "utf8")), from: target };
    } catch (error) {
      throw new Error(`${target} is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (/[\\/]|\.json$/i.test(target) || !client) throw new Error(`No such file: ${target}`);
  const { graphicPath, loadGraphic } = await import("./graphics.js");
  return { raw: await loadGraphic(client, target), from: graphicPath(target) };
}

const problemLine = (p: { level: string; at: string; message: string }) => `${p.level === "error" ? chalk.red("error") : chalk.yellow("warning")}  ${p.at ? `${chalk.bold(p.at)}: ` : ""}${p.message}`;

/** Draws a graphic once as text with the points' values now; reports what is wrong with it. */
async function printGraphic(raw: unknown, from: string, g: Globals, client: Connection["client"] | undefined, frame: number): Promise<{ ok: boolean; unreadable: string[]; size?: string; points: number }> {
  const { drawGraphic, partNow, readGraphic, roomNeeded } = await import("./tui/symbols/graphic.js");
  let read = readGraphic(raw);
  if (!read.plan) {
    if (g.output === "json") console.log(JSON.stringify({ from, drawn: false, problems: read.problems }, null, 2));
    else for (const p of read.problems) console.log(problemLine(p));
    return { ok: false, unreadable: [], points: 0 };
  }
  const values = new Map<string, { ok?: boolean; value?: unknown; displayValue?: string; state?: string }>();
  if (client && read.plan.points.length) for (const point of await client.read(read.plan.points, { fresh: true })) values.set(point.point, point);
  else if (!client) for (const ord of read.plan.points) values.set(ord, { ok: true, value: 50, displayValue: "50", state: "ok" });
  const lookup = (ord: string) => values.get(ord);
  // Readings longer than the room first kept for them: lay it out once more so nothing is cut short.
  const room = roomNeeded(read.plan, lookup);
  if (room) read = readGraphic(raw, room);
  const plan = read.plan!;
  const text = drawGraphic(plan, lookup, frame).toString();
  const unreadable = plan.points.filter((ord) => values.get(ord)?.ok === false || !values.has(ord));
  const errors = read.problems.filter((p) => p.level === "error");
  // Text has no colour, so the parts a pane would colour are named.
  const flagged = !client ? [] : plan.parts.map((p) => ({ part: p.doc.label ?? p.doc.id ?? p.def?.title ?? p.at, status: partNow(p, lookup).state.status })).filter((p) => p.status && !["ok", "off"].includes(p.status));
  if (g.output === "json") {
    console.log(JSON.stringify({ from, drawn: true, width: plan.width, height: plan.height, text, problems: read.problems, status: flagged, points: plan.points.map((ord) => ({ point: ord, ok: values.get(ord)?.ok !== false && values.has(ord), value: values.get(ord)?.displayValue })) }, null, 2));
  } else {
    console.log(text);
    console.log("");
    console.log(chalk.dim(`${plan.doc.title ?? from} · ${plan.width} x ${plan.height} cells · ${plan.points.length} point${plan.points.length === 1 ? "" : "s"}${client ? "" : " (not read: placeholder values)"}`));
    for (const p of read.problems) console.log(problemLine(p));
    for (const ord of unreadable) console.log(`${chalk.yellow("warning")}  ${chalk.bold(ord)} could not be read: it shows as "?". Check the name with bask search.`);
    if (plan.width > 100) console.log(`${chalk.yellow("warning")}  It is ${plan.width} cells wide: a pane narrower than that scrolls it. Split it into two graphics or two rows.`);
    if (flagged.length) console.log(`${chalk.cyan("status")}   ${flagged.map((p) => `${p.part} ${p.status}`).join(" · ")} ${chalk.dim("(coloured in the pane)")}`);
    if (read.problems.length === 0 && unreadable.length === 0 && plan.width <= 100) console.log(chalk.dim("Nothing wrong with it."));
  }
  return { ok: errors.length === 0, unreadable, size: `${plan.width} x ${plan.height}`, points: plan.points.length };
}

graphic
  .command("print")
  .description("draw a graphic once as text, with the points' values now, and list anything wrong with it")
  .argument("<file-or-name>", "a local JSON file, or the name of a graphic saved on the station")
  .option("--offline", "do not connect: check the file and draw it with placeholder values")
  .option("--frame <n>", "which frame of the animation to draw", "0")
  .action(async (target: string, opts: { offline?: boolean; frame: string }, cmd: Command) => {
    const g = globals(cmd);
    const run = async (client?: Connection["client"]) => {
      const { raw, from } = await graphicSource(target, client);
      const result = await printGraphic(raw, from, g, client, Number(opts.frame) || 0);
      if (!result.ok) process.exitCode = 1;
    };
    if (opts.offline) return run();
    await withClient(cmd, ({ client }) => run(client));
  });

graphic
  .command("save")
  .description("check a graphic and store it on the station, where every bask on that station shows it")
  .argument("<file>", "the local JSON file")
  .option("--name <name>", "the name to save it under (default: the file's name)")
  .action((file: string, opts: { name?: string }, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const { graphicName, graphicPath, saveGraphic } = await import("./graphics.js");
      const { raw } = await graphicSource(file);
      const name = graphicName(opts.name ?? file);
      const { readGraphic } = await import("./tui/symbols/graphic.js");
      const read = readGraphic(raw);
      const errors = read.problems.filter((p) => p.level === "error");
      if (errors.length) {
        for (const p of read.problems) console.error(problemLine(p));
        throw new Error(`Not saved: fix ${errors.length === 1 ? "the error" : `the ${errors.length} errors`} above. bask graphic print ${file} shows the drawing.`);
      }
      const points = read.plan!.points;
      const unreadable = points.length ? (await client.read(points, { fresh: true })).filter((p) => !p.ok).map((p) => p.point) : [];
      await requireWrite(g, `Save the graphic "${name}" to ${graphicPath(name)} on the station?`);
      const written = await saveGraphic(client, name, raw, reasonOf(g));
      const link = new Link(client.http.url.origin);
      link.show("graphic", name);
      if (g.output === "json") return console.log(JSON.stringify({ name, path: graphicPath(name), created: written.created, points: points.length, unreadable }, null, 2));
      console.log(`${chalk.green("✓")} ${written.created ? "Saved" : "Replaced"} ${chalk.bold(name)} at ${graphicPath(name)} (${points.length} point${points.length === 1 ? "" : "s"}).`);
      for (const ord of unreadable) console.log(`${chalk.yellow("warning")}  ${ord} could not be read: it shows as "?".`);
      console.log(link.anyOpen() ? chalk.dim("  Shown in the open Graphics window.") : chalk.dim("  Open bask and press g to see it."));
    })
  );

graphic
  .command("list")
  .description("the graphics saved on the station")
  .action((_opts, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const { listGraphics } = await import("./graphics.js");
      const entries = await listGraphics(client);
      if (g.output === "table" && entries.length === 0) return console.log(chalk.dim("No graphics on this station yet. bask graphic guide says how to write one."));
      emit(g, ["name", "path", "modified"], entries.map((e) => [e.name, e.path, e.modified ? fmtTime(e.modified) : ""]), entries);
    })
  );

graphic
  .command("get")
  .description("print a saved graphic's JSON, to change it and save it again")
  .argument("<name>", "the graphic's name")
  .action((name: string, _opts, cmd: Command) =>
    withClient(cmd, async ({ client }) => {
      const { loadGraphic } = await import("./graphics.js");
      console.log(JSON.stringify(await loadGraphic(client, name), null, 2));
    })
  );

graphic
  .command("show")
  .description("open a saved graphic in the Graphics view of the open bask windows")
  .argument("<name>", "the graphic's name")
  .action(async (name: string, _opts, cmd: Command) => {
    const { graphicName } = await import("./graphics.js");
    const { profile } = getProfile(globals(cmd).profile);
    const link = new Link(profile.station);
    link.show("graphic", graphicName(name));
    console.log(link.anyOpen() ? `${chalk.green("✓")} ${graphicName(name)} shown in Graphics.` : `${chalk.yellow("!")} No bask window is open on ${new URL(profile.station).host}; ${graphicName(name)} opens when one is.`);
  });

graphic
  .command("rm")
  .description("delete a saved graphic from the station")
  .argument("<name>", "the graphic's name")
  .action((name: string, _opts, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const { deleteGraphic, graphicName, graphicPath } = await import("./graphics.js");
      await requireWrite(g, `Delete the graphic "${graphicName(name)}" (${graphicPath(name)}) from the station?`);
      await deleteGraphic(client, name, reasonOf(g));
      if (g.output === "json") return console.log(JSON.stringify({ name: graphicName(name), deleted: true }, null, 2));
      console.log(`${chalk.green("✓")} Deleted ${graphicName(name)}.`);
    })
  );

program
  .command("show")
  .description("show something in the open bask windows: select an ORD in the Explorer, chart it, or add it to the watch list")
  .argument("<ord>", "a component or point")
  .option("--trend", "chart it in Trends")
  .option("--watch", "add it to the watch list")
  .action((ord: string, opts: { trend?: boolean; watch?: boolean }, cmd: Command) => {
    const { profile } = getProfile(globals(cmd).profile);
    const link = new Link(profile.station);
    const target = normalizeOrd(ord);
    if (opts.watch) link.update((s) => void (s.watch = [...new Set([...s.watch, target])]));
    if (opts.trend || !opts.watch) link.show(opts.trend ? "trend" : "reveal", target);
    const what = [opts.watch ? "added to the watch list" : "", opts.trend ? "charted in Trends" : opts.watch ? "" : "selected in the Explorer"].filter(Boolean).join(" and ");
    console.log(link.anyOpen() ? `${chalk.green("✓")} ${shortOrd(target, 3)} ${what}.` : `${chalk.yellow("!")} No bask window is open on ${new URL(profile.station).host}; ${shortOrd(target, 3)} will be ${what} when one is.`);
  });

program
  .command("agent-brief")
  .description("print the briefing bask workspace gives an AI agent: how to read and change this station through bask")
  .action((_opts, cmd: Command) => {
    const { name, profile } = getProfile(globals(cmd).profile);
    process.stdout.write(agentBrief({ station: name, host: new URL(profile.station).host, user: profile.username ?? "", profile: name }));
  });

function normalizeOrd(ord: string): string {
  ord = toSlotOrd(ord);
  if (/^(slot|hierarchy|history|station|local):/.test(ord)) return ord;
  return `slot:/${ord.replace(/^\/+/, "")}`;
}

function kindColor(kind: string): (text: string) => string {
  return kind === "point" ? chalk.cyan : kind === "schedule" ? chalk.magenta : kind === "container" ? chalk.bold : (t: string) => t;
}

program.parseAsync().catch((error: unknown) => {
  if (error instanceof BaskStreamError) {
    console.error(`${chalk.red("error")} ${chalk.dim(`[${error.code}]`)} ${error.message}`);
    if (error.code === "session_expired") console.error(chalk.dim("Run: bask login <station> -u <user>"));
    else if (error.code === "connection_closed" || error.code === "login_failed" || error.code === "timeout") console.error(chalk.dim("Run bask doctor to see where it breaks."));
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${chalk.red("error")} ${message}`);
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|certificate|TLS|socket hang up/i.test(message)) console.error(chalk.dim("Run bask doctor to see where it breaks."));
  }
  process.exit(1);
});

