// bask px: Niagara Px graphics on the station. The station does the work (baskStream API 1.12);
// this file turns the command line into requests and the replies into something to read.
import chalk from "chalk";
import type { GraphicsInventory, NavCheck, PunchItem, PxBindingCheck, PxInfo, PxProblem, PxTargets, PxViewsResult } from "./core.js";
import { shortOrd, table } from "./format.js";

export interface TargetOptions {
  under?: string;
  name?: string;
  type?: string;
  depth?: string;
  views?: boolean;
}

/** The components a command names: ORDs, a pattern (--under, --name, --type), or --views. */
export function targetsOf(ords: string[], opts: TargetOptions): PxTargets {
  const targets: PxTargets = {};
  if (ords.length) targets.targets = ords;
  if (opts.under || opts.name || opts.type) {
    targets.match = {};
    if (opts.under) targets.match.under = opts.under;
    if (opts.name) targets.match.name = opts.name;
    if (opts.type) targets.match.type = opts.type;
    if (opts.depth) targets.match.depth = Number(opts.depth);
  }
  if (opts.views) targets.views = true;
  if (!targets.targets && !targets.match && !targets.views) {
    throw new Error("Say which components: their ORDs, or --under/--name/--type (e.g. --under slot:/Drivers --name 'VAV*'), or --views.");
  }
  return targets;
}

/** A station file path as bask writes it: ^px/VAV.px (a leading file: is dropped). */
export const pxPath = (path: string) => path.replace(/^file:/, "");

const severityColor = (severity: string) => (severity === "error" ? chalk.red : severity === "warning" ? chalk.yellow : chalk.dim);

export function problemLines(problems: PxProblem[]): string[] {
  return problems.map((p) => `${severityColor(p.severity)(p.severity.padEnd(7))} ${p.line ? chalk.dim(`line ${p.line}  `) : ""}${p.message}`);
}

export function printPxInfo(info: PxInfo, showRefs: boolean): void {
  const data = info.references.filter((r) => r.kind === "binding" || r.kind === "ordProperty");
  const relative = data.filter((r) => /^slot:(?!\/)/.test(r.ord)).length;
  console.log(`${chalk.bold(info.path ?? "Px")}  ${chalk.dim(`${info.elements} elements, media ${info.media ?? "?"}`)}`);
  console.log(`${chalk.dim("imports")}     ${info.imports.join(", ") || "none"}`);
  console.log(`${chalk.dim("bindings")}    ${data.length} (${relative} relative, ${data.length - relative} absolute)`);
  const others = ["link", "file", "include", "view"].map((kind) => [kind, info.references.filter((r) => r.kind === kind).length] as const).filter(([, n]) => n > 0);
  if (others.length) console.log(`${chalk.dim("also")}        ${others.map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`).join(", ")}`);
  if (showRefs && info.references.length) {
    console.log();
    console.log(table(["kind", "ord", "widget", "line"], info.references.map((r) => [r.kind, r.ord, `${r.widget}${r.property ? ` ${chalk.dim(r.property)}` : ""}`, String(r.line)])));
  }
  if (info.problems.length) {
    console.log();
    for (const line of problemLines(info.problems)) console.log(line);
  }
  const verdict = info.valid === undefined ? "" : info.valid ? chalk.green("✓ valid") : chalk.red(`✗ ${info.errors} error${info.errors === 1 ? "" : "s"}`);
  if (verdict) console.log(`\n${verdict}${info.warnings ? chalk.yellow(`, ${info.warnings} warning${info.warnings === 1 ? "" : "s"}`) : ""}`);
}

const mark = (status: string) => (status === "ok" ? chalk.green("✓") : status === "forbidden" ? chalk.yellow("!") : status === "not_checked" ? chalk.dim("·") : chalk.red("✗"));

export function printBindingCheck(check: PxBindingCheck, matrix: boolean): void {
  const s = check.summary;
  console.log(`${chalk.bold(check.path)}${check.relativeTo ? chalk.dim(` relative to ${check.relativeTo}`) : ""}`);
  console.log(`${s.targets} target${s.targets === 1 ? "" : "s"}, ${s.relativeBindings} relative and ${s.absoluteBindings} absolute binding${s.bindings === 1 ? "" : "s"}: `
    + `${chalk.green(`${s.okTargets} ok`)}, ${s.deviatingTargets ? chalk.red(`${s.deviatingTargets} deviating`) : "none deviating"}`
    + (s.brokenAbsolute ? chalk.red(`, ${s.brokenAbsolute} absolute broken`) : ""));
  if (check.note) console.log(chalk.dim(check.note));
  if (s.targets === 0) console.log(chalk.yellow("No components matched. --name takes * as its only wildcard (VAV_*), and matches names and display names."));
  console.log();
  console.log(table(["#", "binding", "on", "used by"], check.bindings.map((b) => [
    String(b.index),
    b.checked && b.checked !== b.ord ? `${b.checked} ${chalk.dim(`(${b.ord})`)}` : b.ord,
    b.relative ? `${b.resolvedOn === s.targets ? chalk.green(`${b.resolvedOn}/${s.targets}`) : chalk.yellow(`${b.resolvedOn}/${s.targets}`)}${b.types && Object.keys(b.types).length > 1 ? chalk.yellow(" mixed types") : ""}` : `${mark(b.status ?? "")} ${b.status}`,
    `${b.widgets[0] ?? ""}${b.widgetCount > 1 ? chalk.dim(` +${b.widgetCount - 1}`) : ""}`
  ])));
  if (matrix && check.targets.some((t) => t.cells)) {
    console.log();
    const header = check.bindings.map((b) => String(b.index % 10)).join("");
    console.log(table(["target", header], check.targets.map((t) => [shortOrd(t.ord, 2), (t.cells ?? []).map(mark).join("")])));
  }
  const bad = check.targets.filter((t) => !t.ok);
  if (bad.length) {
    console.log();
    console.log(chalk.bold("Deviating targets"));
    for (const t of bad) {
      console.log(`${chalk.red("✗")} ${t.ord} ${chalk.dim(`(${t.resolved} resolved)`)}`);
      for (const m of t.missing) {
        console.log(`    ${chalk.red(m.status.padEnd(9))} #${m.binding} ${m.ord}${m.reason ? chalk.dim(` ${m.reason}`) : ""}`);
        for (const sug of m.suggestions ?? []) console.log(`              ${chalk.cyan("→")} ${sug.relative}  ${chalk.dim(`${sug.score}  ${sug.why.join(", ")}`)}`);
        if (m.suggestions && m.suggestions.length === 0) console.log(chalk.dim("              no likely point under this target"));
      }
      for (const m of t.mismatched) console.log(`    ${chalk.yellow("type".padEnd(9))} #${m.binding} ${m.ord} is ${m.typeSpec}, elsewhere ${m.expected}`);
    }
  }
  for (const e of check.targetErrors) console.log(`${chalk.yellow("skipped")} ${e.ord}: ${e.message}`);
  if (check.truncated) console.log(chalk.yellow("Stopped at a limit (500 targets or the time limit); narrow the targets to see the rest."));
}

export function printViews(result: PxViewsResult): void {
  const verb = result.dryRun ? "would be" : "";
  const counts = Object.entries(result.summary).map(([action, n]) => `${n} ${verb ? `${verb} ` : ""}${action}`).join(", ");
  if (result.results.length === 0) console.log(chalk.yellow("No components matched. --name takes * as its only wildcard (VAV_*), and matches names and display names."));
  console.log(`${chalk.bold(result.path)}${result.view ? ` as view ${chalk.bold(result.view)}` : ""}: ${counts || "nothing to do"}`);
  const shown = result.results.filter((r) => r.action !== "unchanged" || r.defaultSet);
  if (shown.length) {
    console.log(table(["component", "action", "view", "note"], shown.map((r) => [
      r.ord, r.action === "failed" || r.action === "conflict" ? chalk.red(r.action) : r.action, r.view ?? (r.views ?? []).join(", "),
      r.message ?? (r.defaultSet ? "made default" : r.default ? "default" : "")
    ])));
  }
}

export function printNav(nav: NavCheck): void {
  console.log(`${chalk.bold(nav.path ?? "nav")}: ${nav.nodes.length} node${nav.nodes.length === 1 ? "" : "s"}, ${nav.dead ? chalk.red(`${nav.dead} dead`) : chalk.green("none dead")}`
    + (nav.users ? chalk.dim(`; used by ${nav.users.length ? nav.users.join(", ") : "no user"}`) : ""));
  console.log(table(["node", "ord", ""], nav.nodes.map((n) => [`${"  ".repeat(n.depth)}${n.name}`, n.ord ?? chalk.dim("(folder)"), n.status === "folder" ? "" : `${mark(n.status)}${n.reason ? chalk.dim(` ${n.reason}`) : ""}`])));
  for (const line of problemLines(nav.problems)) console.log(line);
}

export function printPunchList(inv: GraphicsInventory, all: boolean): void {
  const s = inv.summary;
  console.log(`${s.pxFiles} Px, ${s.navFiles} nav and ${s.images} image files; ${s.views} view${s.views === 1 ? "" : "s"} on ${s.componentsVisited} components under ${inv.under}`);
  console.log(`${s.errors ? chalk.red(`${s.errors} error${s.errors === 1 ? "" : "s"}`) : chalk.green("no errors")}, ${s.warnings ? chalk.yellow(`${s.warnings} warning${s.warnings === 1 ? "" : "s"}`) : "no warnings"}`
    + `, ${s.orphanPx} unused Px` + (s.brokenBindings !== undefined ? `, ${s.brokenBindings} broken binding${s.brokenBindings === 1 ? "" : "s"}` : ""));
  const items = all ? inv.punchList : inv.punchList.filter((p) => p.severity !== "info");
  if (items.length) {
    console.log();
    console.log(table(["", "kind", "where", "what"], items.map((p: PunchItem) => [severityColor(p.severity)(p.severity), p.kind, p.where, p.message])));
  }
  const hidden = inv.punchList.length - items.length;
  if (hidden > 0) console.log(chalk.dim(`\n${hidden} info item${hidden === 1 ? "" : "s"} (unused Px and image files) not shown; add --all.`));
  if (inv.truncated) console.log(chalk.yellow("Stopped at a limit; narrow it with --under."));
}

// ---- px snapshot: the page as a browser shows it (the SDK's snapshot(), on this computer) ---------

/** "1600x900" → [1600, 900]. */
export function parseSize(text: string): [number, number] {
  const match = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/i.exec(text.trim());
  if (!match) throw new Error(`Bad size "${text}" (use width x height, e.g. 1600x900).`);
  return [Number(match[1]), Number(match[2])];
}

/**
 * Where each frame goes: --out as given (or a name from the page: ahu.png, AHU_1-Graphic.png),
 * with -1, -2… before .png when there are several frames.
 */
export function snapshotFiles(ord: string, frames: number, out?: string): string[] {
  let base = out;
  if (!base) {
    const view = /\|view:([^|]+)/.exec(ord)?.[1];
    const last = ord.replace(/\|view:[^|]*/, "").split(/[|/^:]/).filter(Boolean).pop() ?? "page";
    base = `${[last.replace(/\.px$/i, ""), view].filter(Boolean).join("-").replace(/[^\w.-]+/g, "_") || "page"}.png`;
  }
  if (!/\.png$/i.test(base)) base += ".png";
  if (frames === 1) return [base];
  return Array.from({ length: frames }, (_, i) => base!.replace(/\.png$/i, `-${i + 1}.png`));
}

export interface SnapshotSummary {
  ord: string;
  url: string;
  title: string;
  httpStatus: number | null;
  width: number;
  height: number;
  loadMs: number;
  failedRequests: number;
  consoleErrors: string[];
  files: string[];
}

export function printSnapshot(s: SnapshotSummary): void {
  const status = s.httpStatus === null ? "no status" : s.httpStatus >= 400 ? chalk.red(`HTTP ${s.httpStatus}`) : `HTTP ${s.httpStatus}`;
  console.log(`${chalk.green("✓")} ${s.files.join(", ")} ${chalk.dim(`(${s.width}×${s.height})`)} from ${s.ord}`);
  console.log(chalk.dim(`  ${s.title || "(no title)"} · `) + status + chalk.dim(` · quiet after ${(s.loadMs / 1000).toFixed(1)} s`));
  if (s.failedRequests) console.log(chalk.yellow(`  ${s.failedRequests} request${s.failedRequests === 1 ? "" : "s"} failed (images, scripts or data the page asked for).`));
  for (const message of s.consoleErrors) console.log(`  ${chalk.yellow("console")} ${message}`);
}
