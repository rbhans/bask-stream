// bask diff: what differs between two exports (docs/ROADMAP.md, E3). Each side is an export file or
// a live branch, which is exported first. The result is a flat list: components added and removed,
// and for a component on both sides its type, properties, links, tags and relations that changed.
import chalk from "chalk";
import type { ExportedComponent, ExportedValue, StationExport } from "./export.js";
import { csv, table } from "./format.js";

export interface Difference {
  /** The component, as a path under the exported root ("." is the root). */
  path: string;
  change: "added" | "removed" | "changed";
  what: "component" | "type" | "property" | "link" | "tag" | "relation";
  /** The property, tag, link or relation; absent for a component or its type. */
  name?: string;
  /** What the first side holds; absent when it was added. */
  from?: unknown;
  /** What the second side holds; absent when it was removed. */
  to?: unknown;
}

export interface DiffResult {
  a: string;
  b: string;
  same: boolean;
  summary: { added: number; removed: number; changed: number; components: { added: number; removed: number; changed: number } };
  differences: Difference[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The differences between two keyed sets, in key order. */
function keyed<T>(path: string, what: Difference["what"], a: Record<string, T>, b: Record<string, T>, out: Difference[]): void {
  for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(byText)) {
    if (!(name in b)) out.push({ path, change: "removed", what, name, from: a[name] });
    else if (!(name in a)) out.push({ path, change: "added", what, name, to: b[name] });
    else if (!equal(a[name], b[name])) out.push({ path, change: "changed", what, name, from: a[name], to: b[name] });
  }
}

const linkSet = (c: ExportedComponent) => Object.fromEntries((c.links ?? []).map((l) => [`${l.from}.${l.fromSlot} → ${l.toSlot}`, true]));
const relationSet = (c: ExportedComponent) => Object.fromEntries((c.relations ?? []).map((r) => [`${r.id} → ${r.to}`, true]));

/** Compares two exports component by component, by path under each one's root. */
export function diffExports(a: StationExport, b: StationExport, labels: { a: string; b: string } = { a: a.root, b: b.root }): DiffResult {
  const left = new Map(a.components.map((c) => [c.path, c]));
  const right = new Map(b.components.map((c) => [c.path, c]));
  const differences: Difference[] = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort(byText)) {
    const before = left.get(path);
    const after = right.get(path);
    if (!after) differences.push({ path, change: "removed", what: "component", from: before!.type });
    else if (!before) differences.push({ path, change: "added", what: "component", to: after.type });
    else {
      if (before.type !== after.type) differences.push({ path, change: "changed", what: "type", from: before.type, to: after.type });
      keyed<ExportedValue>(path, "property", before.properties ?? {}, after.properties ?? {}, differences);
      keyed(path, "link", linkSet(before), linkSet(after), differences);
      keyed(path, "tag", before.tags ?? {}, after.tags ?? {}, differences);
      keyed(path, "relation", relationSet(before), relationSet(after), differences);
    }
  }
  const count = (change: Difference["change"]) => differences.filter((d) => d.change === change).length;
  const whole = (change: Difference["change"]) => differences.filter((d) => d.what === "component" && d.change === change).length;
  const touched = new Set(differences.filter((d) => d.what !== "component").map((d) => d.path)).size;
  return { a: labels.a, b: labels.b, same: differences.length === 0, summary: { added: count("added"), removed: count("removed"), changed: count("changed"), components: { added: whole("added"), removed: whole("removed"), changed: touched } }, differences };
}

const show = (value: unknown) => (value === true ? "" : typeof value === "string" ? value : JSON.stringify(value));

/** One difference in words: "property fallback: 55.0 → 56.0". */
export function differenceText(d: Difference): string {
  if (d.what === "component") return `component ${show(d.change === "removed" ? d.from : d.to)}`;
  if (d.what === "type") return `type: ${show(d.from)} → ${show(d.to)}`;
  const label = `${d.what} ${d.name}`;
  if (d.change === "changed") return `${label}: ${show(d.from)} → ${show(d.to)}`;
  const value = show(d.change === "removed" ? d.from : d.to);
  return value ? `${label}: ${value}` : label;
}

const changeColor = (change: Difference["change"]) => (change === "added" ? chalk.green : change === "removed" ? chalk.red : chalk.yellow);

export function printDiff(result: DiffResult): void {
  const c = result.summary.components;
  const plural = (n: number) => `${n} component${n === 1 ? "" : "s"}`;
  console.log(`${chalk.bold(result.a)} → ${chalk.bold(result.b)}`);
  if (result.same) return console.log(chalk.green("No differences."));
  console.log(`${plural(c.added)} added, ${c.removed} removed, ${c.changed} changed ${chalk.dim(`(${result.differences.length} difference${result.differences.length === 1 ? "" : "s"})`)}`);
  console.log();
  console.log(table(["", "where", "what"], result.differences.map((d) => [changeColor(d.change)(d.change), d.path, differenceText(d)])));
}

export function diffCsv(result: DiffResult): string {
  return csv(["change", "path", "what", "name", "from", "to"], result.differences.map((d) => [d.change, d.path, d.what, d.name ?? "", d.from === undefined ? "" : show(d.from), d.to === undefined ? "" : show(d.to)]));
}
