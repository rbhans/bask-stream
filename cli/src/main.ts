#!/usr/bin/env node
import chalk from "chalk";
import { Command, Option } from "commander";
import { BaskStreamError, OPERATIONS, StationHttp, type AlarmFilter, type BrowseNode, type Json } from "@basidekick/baskstream";
import { getProfile, loadStore, putProfile, removeProfile, setCurrent, updateProfile } from "./config.js";
import { csv, fmtPoint, fmtTime, fmtValue, parseDuration, parseTime, parseValue, shortOrd, sparkline, statusColor, table } from "./format.js";
import { confirm, promptHidden } from "./prompt.js";
import { connect, type Connection } from "./session.js";

type Output = "table" | "json" | "csv";
interface Globals {
  profile?: string;
  output: Output;
  allowWrites?: boolean;
  yes?: boolean;
}

const program = new Command()
  .name("bask")
  .description("Browse, watch and query Niagara stations over baskStream.\nRun with no command in a terminal to open the dashboard.")
  .version("0.1.0")
  .option("-p, --profile <name>", "saved station profile (default: current)")
  .addOption(new Option("-o, --output <format>", "output format").choices(["table", "json", "csv"]).default("table"))
  .option("--allow-writes", "permit commands that change the station")
  .option("-y, --yes", "skip confirmation prompts (with --allow-writes)");

const globals = (cmd: Command) => cmd.optsWithGlobals() as Globals & Record<string, unknown>;

/** Runs a command body with a connection, closing it afterwards. */
async function withClient<T>(cmd: Command, body: (conn: Connection, g: Globals & Record<string, unknown>) => Promise<T>): Promise<T> {
  const g = globals(cmd);
  const conn = await connect(g.profile);
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
  .action((ords: string[], _opts, cmd: Command) =>
    withClient(cmd, async ({ client }, g) => {
      const points = await client.read(ords.map(normalizeOrd));
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
    const conn = await connect(g.profile);
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
          if (g.output === "table") console.log(chalk.bold(String(h.historyId)), chalk.dim(`${buckets.length} buckets of ${opts.rollup}`), sparkline(buckets.map((b) => Number(b.avg)).filter(Number.isFinite), 60));
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

const alarmMessage = (a: Json) => String(((a.data ?? {}) as Json).msgText ?? a.summary ?? "");
const alarmRow = (a: Json): unknown[] => [fmtTime(a.timestamp), a.priority, a.alarmClass, a.sourceState, a.ackState, shortOrd(String(((a.sources ?? []) as string[])[0] ?? ""), 3), alarmMessage(a), a.uuid];
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
        const run = (dryRun: boolean) => (action === "ack" ? client.ackAlarms(target, dryRun) : client.clearAlarms(target, dryRun));
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
      const result = await client.write(point, action, parsed, opts.for ? { durationSec: Math.round(parseDuration(opts.for) / 1000) } : {});
      if (g.output === "json") return console.log(JSON.stringify(result, null, 2));
      if (result.ok === false) throw new BaskStreamError(String(result.code), String(result.message), "write");
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
      console.log(JSON.stringify(await client.call(op, fields), null, 2));
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

program
  .command("tui", { isDefault: true })
  .description("open the full-screen dashboard (default when run in a terminal)")
  .action(async (_opts, cmd: Command) => {
    const g = globals(cmd);
    if (!process.stdout.isTTY) return program.help();
    await runTui(g, {});
  });

async function runTui(g: Globals, start: { view?: "watch"; points?: string[] }): Promise<void> {
  const conn = await connect(g.profile);
  conn.stopPrompting();
  const { runDashboard } = await import("./tui/run.js");
  await runDashboard(conn, { allowWrites: !!g.allowWrites, ...start });
}

function normalizeOrd(ord: string): string {
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
  } else {
    console.error(`${chalk.red("error")} ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
});

