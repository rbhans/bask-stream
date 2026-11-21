// More than one station in a run (docs/ROADMAP.md, E3 and E5): bask diff with a side on another
// saved profile, and bask fleet check / bask fleet diff, which run the check and the diff across
// saved profiles. Everything here reads; nothing is changed on any station.
import chalk from "chalk";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { toSlotOrd, type BaskStreamClient } from "@basidekick/baskstream";
import type { Rule } from "./check-rules.js";
import { runCheck, summaryText, type CheckResult } from "./check.js";
import { loadStore } from "./config.js";
import { diffExports, differenceText, type DiffResult } from "./diff.js";
import { exportBranch, parseExport, type StationExport } from "./export.js";
import { csv, shortOrd, table } from "./format.js";

/** An ORD as bask takes it: the slot:/ prefix may be left off. */
export function normalizeOrd(ord: string): string {
  ord = toSlotOrd(ord);
  if (/^(slot|hierarchy|history|station|local):/.test(ord)) return ord;
  return `slot:/${ord.replace(/^\/+/, "")}`;
}

const SCHEMES = ["slot", "hierarchy", "history", "station", "local", "file", "http", "https"];

export interface Side {
  /** An export file on this computer. */
  file?: string;
  /** The saved profile whose station holds the branch; absent for the current one. */
  profile?: string;
  /** The branch, for a side that is not a file. */
  ord?: string;
  /** What the side is called in the output. */
  label: string;
}

/** One side of a diff: a file that exists, `profile:branch` for a branch on another saved station, else a branch on the current one. */
export function parseSide(text: string, profiles: string[]): Side {
  if (existsSync(text)) return { file: text, label: text };
  const named = /^([^:/\\]+):(.+)$/.exec(text);
  if (named && profiles.includes(named[1]) && !SCHEMES.includes(named[1])) {
    const ord = normalizeOrd(named[2]);
    return { profile: named[1], ord, label: `${named[1]}:${ord}` };
  }
  const ord = normalizeOrd(text);
  return { ord, label: ord };
}

type Open = (profile?: string) => Promise<BaskStreamClient>;

/** Compares two sides: files, branches of the current station, or branches of two saved stations. Connections it opens are closed. */
export async function diffSides(a: string, b: string, open: Open): Promise<DiffResult> {
  const profiles = Object.keys(loadStore().profiles);
  const sides = [parseSide(a, profiles), parseSide(b, profiles)];
  const clients = new Map<string, Promise<BaskStreamClient>>();
  const clientFor = (profile?: string) => clients.get(profile ?? "") ?? clients.set(profile ?? "", open(profile)).get(profile ?? "")!;
  try {
    const read = async (side: Side) => (side.file ? parseExport(readFileSync(side.file, "utf8"), side.file) : exportBranch(await clientFor(side.profile), side.ord!));
    // One at a time: two exports of one station share a connection.
    const left = await read(sides[0]);
    const right = await read(sides[1]);
    return diffExports(left, right, { a: sides[0].label, b: sides[1].label });
  } finally {
    for (const client of clients.values()) await client.then((c) => c.close(), () => undefined);
  }
}

// ---- Fleets ----------------------------------------------------------------------------------------

/** The profiles a fleet command covers: the ones named, else every saved station once (the current profile's login where a station has several), demo profiles left out. */
export function fleetProfiles(names: string[]): string[] {
  const store = loadStore();
  if (names.length) {
    const unknown = names.filter((name) => !store.profiles[name]);
    if (unknown.length) throw new Error(`No profile named ${unknown.map((name) => `"${name}"`).join(", ")}. Saved profiles: ${Object.keys(store.profiles).join(", ") || "none"}.`);
    return names;
  }
  const byStation = new Map<string, string>();
  for (const name of [store.current, ...Object.keys(store.profiles)]) {
    const profile = name ? store.profiles[name] : undefined;
    if (name && profile && !/^demo(-|$)/.test(name) && !byStation.has(profile.station)) byStation.set(profile.station, name);
  }
  if (byStation.size === 0) throw new Error("No saved stations. Log in to some with bask login, or name the profiles to cover.");
  return [...byStation.values()];
}

async function eachStation<T>(profiles: string[], open: Open, work: (client: BaskStreamClient) => Promise<T>): Promise<{ profile: string; station?: string; error?: string; value?: T }[]> {
  const out: { profile: string; station?: string; error?: string; value?: T }[] = profiles.map((profile) => ({ profile }));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, profiles.length) }, async () => {
    while (next < profiles.length) {
      const entry = out[next++];
      let client: BaskStreamClient | undefined;
      try {
        client = await open(entry.profile);
        entry.station = String(client.capabilities.station ?? client.http.url.host);
        entry.value = await work(client);
      } catch (error) {
        entry.error = (error as Error).message;
      } finally {
        client?.close();
      }
    }
  }));
  return out;
}

export interface FleetCheck {
  stations: { profile: string; station?: string; error?: string; result?: CheckResult }[];
  /** Any station has an error finding, or could not be checked. */
  failed: boolean;
}

/** Runs the check on every profile. A station that cannot be reached is listed with the reason, and the rest still run. */
export async function fleetCheck(profiles: string[], open: Open, rules: Rule[], under?: string): Promise<FleetCheck> {
  const stations = (await eachStation(profiles, open, (client) => runCheck(client, rules, { under }))).map(({ value, ...rest }) => ({ ...rest, ...(value ? { result: value } : {}) }));
  return { stations, failed: stations.some((s) => s.error || (s.result?.summary.errors ?? 0) > 0) };
}

export function printFleetCheck(fleet: FleetCheck): void {
  console.log(table(["profile", "station", "errors", "warnings", "review", "info", ""], fleet.stations.map((s) => {
    const sum = s.result?.summary;
    return [s.profile, s.station ?? "", sum ? (sum.errors ? chalk.red(String(sum.errors)) : chalk.green("0")) : "", sum ? (sum.warnings ? chalk.yellow(String(sum.warnings)) : "0") : "", sum ? String(sum.review) : "", sum ? String(sum.info) : "", s.error ? chalk.red(`not checked: ${s.error}`) : sum?.skipped ? chalk.dim(`${sum.skipped} rule${sum.skipped === 1 ? "" : "s"} skipped`) : ""];
  })));
  const rows = fleet.stations.flatMap((s) => (s.result?.findings ?? []).filter((f) => f.severity === "error" || f.severity === "warning").map((f) => [f.severity === "error" ? chalk.red("error") : chalk.yellow("warning"), s.profile, f.group, f.where.startsWith("slot:/") ? shortOrd(f.where, 3) : f.where, f.message]));
  if (rows.length) console.log(`\n${table(["", "profile", "group", "where", "what"], rows)}`);
  console.log(chalk.dim(`\nErrors and warnings are listed. For everything on one station: bask -p <profile> check`));
}

export const fleetCheckCsv = (fleet: FleetCheck) => csv(["profile", "station", "severity", "group", "rule", "where", "message"], fleet.stations.flatMap((s) => (s.error ? [[s.profile, s.station ?? "", "error", "", "", "", `not checked: ${s.error}`]] : (s.result?.findings ?? []).map((f) => [s.profile, s.station ?? "", f.severity, f.group, f.rule, f.where, f.message]))));

/** The export files of a standard: the file given, or every .json export in the folder (others are named and left out). */
export function standardFiles(against: string): { files: { name: string; doc: StationExport }[]; ignored: string[] } {
  if (!existsSync(against)) throw new Error(`${against} is not there. --against takes a folder of export files (bask export <ord> > standard/ahu.json), or one such file.`);
  const names = statSync(against).isDirectory() ? readdirSync(against).filter((name) => name.endsWith(".json")).sort().map((name) => path.join(against, name)) : [against];
  const files: { name: string; doc: StationExport }[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    try {
      files.push({ name, doc: parseExport(readFileSync(name, "utf8"), name) });
    } catch {
      ignored.push(name);
    }
  }
  if (files.length === 0) throw new Error(`${against} holds no export files. Make one with: bask export <ord> > ${path.join(against, "standard.json")}`);
  return { files, ignored };
}

export interface FleetDiff {
  against: string;
  stations: { profile: string; station?: string; error?: string; files?: { file: string; root: string; error?: string; result?: DiffResult }[] }[];
  /** Any station departs from the standard, or could not be compared. */
  differs: boolean;
}

/** Compares every profile's station with each export file of the standard: the file's own branch, as it is on that station. */
export async function fleetDiff(profiles: string[], open: Open, against: string): Promise<FleetDiff> {
  const { files } = standardFiles(against);
  const stations = (await eachStation(profiles, open, async (client) => {
    const out: NonNullable<FleetDiff["stations"][number]["files"]> = [];
    for (const { name, doc } of files) {
      try {
        out.push({ file: name, root: doc.root, result: diffExports(doc, await exportBranch(client, doc.root), { a: name, b: doc.root }) });
      } catch (error) {
        out.push({ file: name, root: doc.root, error: (error as Error).message });
      }
    }
    return out;
  })).map(({ value, ...rest }) => ({ ...rest, ...(value ? { files: value } : {}) }));
  return { against, stations, differs: stations.some((s) => s.error || s.files?.some((f) => f.error || !f.result?.same)) };
}

export function printFleetDiff(fleet: FleetDiff): void {
  console.log(table(["profile", "station", "standard", "branch", ""], fleet.stations.flatMap((s) => (s.error ? [[s.profile, s.station ?? "", "", "", chalk.red(`not compared: ${s.error}`)]] : (s.files ?? []).map((f) => {
    const c = f.result?.summary.components;
    return [s.profile, s.station ?? "", path.basename(f.file), shortOrd(f.root, 3), f.error ? chalk.red(`not compared: ${f.error}`) : f.result!.same ? chalk.green("same") : chalk.yellow(`${f.result!.differences.length} difference${f.result!.differences.length === 1 ? "" : "s"}: ${c!.added} added, ${c!.removed} removed, ${c!.changed} changed`)];
  })))));
  const rows = fleet.stations.flatMap((s) => (s.files ?? []).flatMap((f) => (f.result?.differences ?? []).map((d) => [s.profile, path.basename(f.file), d.change === "added" ? chalk.green(d.change) : d.change === "removed" ? chalk.red(d.change) : chalk.yellow(d.change), d.path, differenceText(d)])));
  if (rows.length) console.log(`\n${table(["profile", "standard", "", "where", "what"], rows)}`);
  console.log(chalk.dim(`\n"added" is on the station and not in the standard; "removed" is in the standard and not on the station.`));
}

export const fleetDiffCsv = (fleet: FleetDiff) => csv(["profile", "station", "standard", "change", "path", "what", "name", "from", "to"], fleet.stations.flatMap((s) => (s.files ?? []).flatMap((f) => (f.result?.differences ?? []).map((d) => [s.profile, s.station ?? "", f.file, d.change, d.path, d.what, d.name ?? "", d.from === undefined ? "" : typeof d.from === "string" ? d.from : JSON.stringify(d.from), d.to === undefined ? "" : typeof d.to === "string" ? d.to : JSON.stringify(d.to)]))));
