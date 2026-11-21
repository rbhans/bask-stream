// bask apply: writes an export file back (docs/ROADMAP.md, E4 and E5). The branch on the station is
// exported and compared with the file; the differences become model plans (create, update, links,
// and with --prune deletes), which the station checks with preview_model_changes and makes with
// apply_model_changes. Tags and relations are not plan operations, so they go through write_tags
// and write_relations after the plans. Some things are reported and never applied: see LIMITS.
//
// A template is an export with named gaps (${name}); a CSV file fills them, one row per copy.
import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { BaskStreamError, type BaskStreamClient, type Json } from "@basidekick/baskstream";
import { diffExports, differenceText, type Difference } from "./diff.js";
import { EXPORT_FORMAT, exportBranch, parseExport, type ExportedComponent, type ExportedValue, type StationExport } from "./export.js";
import { shortOrd } from "./format.js";

export const LIMITS = "Limits: program: objects, protected services (users, roles, authentication, categories, security, Fox, Web, audit history, programs, baskStream itself) and platform settings are reported as differences and never applied.";

export interface TagWrite {
  ord: string;
  set: { id: string; value?: string | number | boolean }[];
  remove: string[];
}

export interface RelationWrite {
  ord: string;
  add: { id: string; endpoint: string }[];
  remove: { id: string; endpoint: string }[];
}

export interface ApplyPlan {
  /** What the file is called in the output. */
  file: string;
  /** The branch of the station it is applied to. */
  target: string;
  /** The branch is not there yet: it is created. */
  createsTarget: boolean;
  /** Every difference between the station (first) and the file (second). */
  differences: Difference[];
  /** Model plans, in the order they are applied. Each holds at most the station's limit of changes. */
  plans: Json[][];
  tags: TagWrite[];
  relations: RelationWrite[];
  /** Differences that are reported and not applied, each with the reason. */
  notApplied: { difference: Difference; why: string }[];
}

export interface ApplyOutcome extends ApplyPlan {
  station: string;
  /** One entry per model plan. `checked` is the station's answer to the preview; absent when it could not be asked yet. */
  steps: { changes: Json[]; checked?: boolean; applied?: boolean; waitsFor?: string; error?: string }[];
  applied: boolean;
  /** After applying: what still differs between the station and the file. */
  remaining?: Difference[];
  ok: boolean;
}

const PROTECTED_TYPE = /^(baja:(User|Role|Authentication|Category)Service$|\w+:SecurityService$|fox:FoxService$|web:WebService$|history:AuditHistoryService$|baskStream:)/;
const PLATFORM_TYPE = /^plat\w*:/;
const PROTECTED_PLACE = /^slot:\/Services\/(UserService|RoleService|AuthenticationService|CategoryService|SecurityService|FoxService|WebService|AuditHistoryService|ProgramService|BASkStreamService|BaskStreamService)(\/|$)/;
const PLATFORM_PLACE = /^slot:\/Services\/PlatformServices(\/|$)/;

/** Why a component of this type, at this place, is left alone; undefined when it may be changed. */
export function protectedWhy(type: string, ord: string): string | undefined {
  if (/^program:/.test(type)) return type === "program:ProgramService" ? "a protected service" : "a program: object";
  if (PLATFORM_TYPE.test(type) || PLATFORM_PLACE.test(ord)) return "a platform setting";
  if (PROTECTED_TYPE.test(type) || PROTECTED_PLACE.test(ord)) return "a protected service";
  return undefined;
}

const parentPath = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
const parentOrd = (ord: string) => (ord.lastIndexOf("/") <= 5 ? "slot:/" : ord.slice(0, ord.lastIndexOf("/")));
const lastOf = (text: string) => text.slice(text.lastIndexOf("/") + 1);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** An exported value as a plan's typed value: Niagara's encoded text, or for a struct its fields the same way. */
export function typedOf(value: ExportedValue): Json {
  if (typeof value === "string") return { encoded: value };
  return { properties: Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, typedOf(inner)])) };
}

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_v, i) => items.slice(i * size, (i + 1) * size));

/**
 * Works out what applying `file` to the branch at `target` takes. Read-only: the branch is exported,
 * and the station is asked what a new component of each added type already holds.
 */
export async function planApply(client: BaskStreamClient, file: StationExport, target: string, options: { prune?: boolean; label?: string } = {}): Promise<ApplyPlan> {
  let current: StationExport;
  let createsTarget = false;
  try {
    current = await exportBranch(client, target);
  } catch (error) {
    // No such branch yet: everything in the file is new, starting with the branch itself.
    if (!(error instanceof BaskStreamError) || !/invalid|not_found/.test(error.code)) throw error;
    current = { format: EXPORT_FORMAT, version: 1, root: target, components: [] };
    createsTarget = true;
  }
  const { differences } = diffExports(current, file, { a: target, b: options.label ?? file.root });
  const ordAt = (path: string) => (path === "." ? target : path.startsWith("slot:") ? path : `${target === "slot:/" ? "slot:/" : `${target}/`}${path}`);
  const onStation = new Map(current.components.map((c) => [c.path, c]));
  const inFile = new Map(file.components.map((c) => [c.path, c]));
  const typeAt = (path: string) => inFile.get(path)?.type ?? onStation.get(path)?.type ?? "";

  /** The reason a path is left alone: itself or something above it is protected. */
  const guarded = (path: string): string | undefined => {
    for (let at = path; ; at = parentPath(at)) {
      const why = protectedWhy(typeAt(at), ordAt(at)) ?? (onStation.has(at) && inFile.has(at) ? protectedWhy(onStation.get(at)!.type, ordAt(at)) : undefined);
      if (why) return at === path ? why : `inside ${why}`;
      if (at === ".") return undefined;
    }
  };

  // What a new component of a type holds: its frozen child components (they come with it and are
  // not created again) and its default values (to put back a property the file leaves at its default).
  const described = new Map<string, Promise<{ children: Set<string>; defaults: Map<string, Json> } | undefined>>();
  const typeInfo = (typeSpec: string) => {
    if (!described.has(typeSpec)) {
      described.set(typeSpec, client.call("describe_component_types", { typeSpec }).then((reply) => {
        const slots = (((reply.result as Json | undefined)?.slots ?? []) as Json[]).filter((slot) => slot.kind === "property");
        return {
          children: new Set(slots.filter((slot) => (slot.value as Json | undefined)?.expand && slot.typeSpec !== "baja:Link").map((slot) => String(slot.name))),
          defaults: new Map(slots.filter((slot) => slot.value && !(slot.value as Json).expand).map((slot) => [String(slot.name), slot.value as Json]))
        };
      }, () => undefined));
    }
    return described.get(typeSpec)!;
  };

  const notApplied: ApplyPlan["notApplied"] = [];
  const creates: { path: string; change: Json }[] = [];
  const updates = new Map<string, Record<string, Json>>();
  const unlink: Json[] = [];
  const link: Json[] = [];
  const deletes: Json[] = [];
  const tags = new Map<string, TagWrite>();
  const relations = new Map<string, RelationWrite>();
  const tagAt = (ord: string) => tags.get(ord) ?? tags.set(ord, { ord, set: [], remove: [] }).get(ord)!;
  const relationAt = (ord: string) => relations.get(ord) ?? relations.set(ord, { ord, add: [], remove: [] }).get(ord)!;
  const setProperty = (path: string, name: string, value: Json) => void updates.set(path, { ...updates.get(path), [name]: value });

  // Components first: which are created, which come with their parent, which are deleted.
  const added = new Set(differences.filter((d) => d.what === "component" && d.change === "added").map((d) => d.path));
  const removed = new Set(differences.filter((d) => d.what === "component" && d.change === "removed").map((d) => d.path));
  /** Added components that a parent created in this run brings with it. */
  const comesWithParent = new Set<string>();
  for (const path of [...added].sort(byText)) {
    const parent = parentPath(path);
    if (path === "." || !added.has(parent)) continue;
    if ((await typeInfo(typeAt(parent)))?.children.has(lastOf(path))) comesWithParent.add(path);
  }

  /** Links, tags and relations of a component that is in the file and not (yet) on the station. */
  const attach = (component: ExportedComponent) => {
    const ord = ordAt(component.path);
    for (const l of component.links ?? []) link.push({ action: "create_link", source: ordAt(l.from), sourceSlot: l.fromSlot, target: ord, targetSlot: l.toSlot });
    for (const [id, value] of Object.entries(component.tags ?? {})) tagAt(ord).set.push(value === true ? { id } : { id, value });
    for (const r of component.relations ?? []) relationAt(ord).add.push({ id: r.id, endpoint: ordAt(r.to) });
  };

  const linkSlots = new Map<string, Promise<Map<string, string> | undefined>>();
  /** The slot that holds each link arriving at a component, by "source.sourceSlot → targetSlot"; undefined when it cannot be told safely. */
  const linkSlotsOf = (ord: string) => {
    if (!linkSlots.has(ord)) {
      linkSlots.set(ord, client.call("describe_component", { ord }).then((reply) => {
        const result = (reply.result ?? {}) as Json;
        const slots = ((result.slots ?? []) as Json[]).filter((slot) => slot.typeSpec === "baja:Link").map((slot) => String(slot.name));
        const arriving = ((result.links ?? []) as Json[]).filter((l) => l.direction === "in");
        // The station lists links and their slots in the same order. When a link is hidden from this login the two lists differ, and no slot is guessed.
        if (slots.length !== arriving.length) return undefined;
        return new Map(arriving.map((l, i) => [`${String(l.source)}.${String(l.sourceSlot)} → ${String(l.targetSlot)}`, slots[i]]));
      }, () => undefined));
    }
    return linkSlots.get(ord)!;
  };

  for (const d of differences) {
    const why = guarded(d.path);
    if (why) {
      notApplied.push({ difference: d, why });
      continue;
    }
    const ord = ordAt(d.path);
    if (d.what === "component" && d.change === "added") {
      const component = inFile.get(d.path)!;
      if (component.unreadable) {
        notApplied.push({ difference: d, why: "the file holds only its place and type: it could not be read when it was exported" });
        continue;
      }
      if (comesWithParent.has(d.path)) {
        // It is there as soon as its parent is: only what is set on it is applied.
        for (const [name, value] of Object.entries(component.properties ?? {})) setProperty(d.path, name, typedOf(value));
      } else {
        const properties = Object.fromEntries(Object.entries(component.properties ?? {}).map(([name, value]) => [name, typedOf(value)]));
        creates.push({ path: d.path, change: { action: "create", parent: d.path === "." ? parentOrd(target) : ordAt(parentPath(d.path)), name: lastOf(ord), typeSpec: component.type, ...(Object.keys(properties).length ? { properties } : {}) } });
      }
      attach(component);
    } else if (d.what === "component") {
      // Removed: on the station and not in the file. What is under another removed component goes with it.
      if ([...removed].some((other) => other !== d.path && d.path.startsWith(`${other}/`))) continue;
      if (!options.prune) notApplied.push({ difference: d, why: "on the station and not in the file (--prune deletes it, and what is under it)" });
      else if (d.path === ".") notApplied.push({ difference: d, why: "the branch itself is not deleted" });
      else deletes.push({ action: "delete", ord, recursive: true });
    } else if (d.what === "type") notApplied.push({ difference: d, why: "a component's type cannot be changed in place: delete it and apply again" });
    else if (d.what === "property") {
      if (d.change !== "removed") setProperty(d.path, d.name!, typedOf(d.to as ExportedValue));
      else {
        // The file leaves it at the type's default. It is put back when the station says what that is.
        const fallback = (await typeInfo(typeAt(d.path)))?.defaults.get(d.name!);
        const encoded = fallback && typeof fallback.encoded === "string" ? { encoded: fallback.encoded } : fallback?.properties ? { properties: fallback.properties as Json } : undefined;
        if (encoded) setProperty(d.path, d.name!, encoded);
        else notApplied.push({ difference: d, why: "the file leaves it at its default, and the station does not say what the default is" });
      }
    } else if (d.what === "link") {
      const file_ = (d.change === "added" ? inFile : onStation).get(d.path)!.links!.find((l) => `${l.from}.${l.fromSlot} → ${l.toSlot}` === d.name)!;
      if (d.change === "added") link.push({ action: "create_link", source: ordAt(file_.from), sourceSlot: file_.fromSlot, target: ord, targetSlot: file_.toSlot });
      else {
        const slot = (await linkSlotsOf(ord))?.get(`${ordAt(file_.from)}.${file_.fromSlot} → ${file_.toSlot}`);
        if (slot) unlink.push({ action: "delete_link", ord, slot });
        else notApplied.push({ difference: d, why: "the slot that holds this link could not be told from the station's reply, so it is not removed" });
      }
    } else if (d.what === "tag") {
      if (d.change === "removed") tagAt(ord).remove.push(d.name!);
      else tagAt(ord).set.push(d.to === true ? { id: d.name! } : { id: d.name!, value: d.to as string | number | boolean });
    } else if (d.what === "relation") {
      const [id, to] = d.name!.split(" → ");
      relationAt(ord)[d.change === "removed" ? "remove" : "add"].push({ id, endpoint: ordAt(to) });
    }
  }

  // Plans. A component created in the same plan as its parent names the parent by a reference; anything
  // that touches what an earlier plan creates is in a later plan, by ORD.
  const max = Math.max(1, Math.min(100, Number(((client.capabilities.modelEditing ?? {}) as Json).maxChanges ?? 100) || 100));
  const plans: Json[][] = [];
  // A component under one that comes with its parent (a new device's points folder) can only be
  // added once that parent is there, so it waits for a later round of plans.
  const created = new Set(creates.map((item) => item.path));
  const rounds = new Map<string, number>();
  const roundOf = (path: string): number => {
    if (rounds.has(path)) return rounds.get(path)!;
    const parent = parentPath(path);
    const round = path === "." ? 0 : created.has(parent) ? roundOf(parent) : comesWithParent.has(parent) ? roundOf(parent) + 1 : 0;
    rounds.set(path, round);
    return round;
  };
  creates.sort((a, b) => roundOf(a.path) - roundOf(b.path) || byText(a.path, b.path));
  for (const round of [...new Set(creates.map((item) => roundOf(item.path)))]) {
    for (const group of chunks(creates.filter((item) => roundOf(item.path) === round), max)) {
      const refs = new Map(group.map((item, i) => [item.path, `n${i}`]));
      plans.push(group.map((item) => {
        const parent = item.path === "." ? undefined : refs.get(parentPath(item.path));
        return { ...item.change, ...(parent ? { parent: `@${parent}` } : {}), ref: refs.get(item.path)! };
      }));
    }
  }
  const rest: Json[] = [
    ...[...updates].sort((a, b) => byText(a[0], b[0])).map(([path, properties]) => ({ action: "update", ord: ordAt(path), properties })),
    ...unlink, ...link, ...deletes
  ];
  plans.push(...chunks(rest, max));
  return { file: options.label ?? file.root, target, createsTarget, differences, plans, tags: [...tags.values()].filter((t) => t.set.length || t.remove.length), relations: [...relations.values()].filter((r) => r.add.length || r.remove.length), notApplied };
}

const errorText = (error: unknown) => (error instanceof BaskStreamError ? `${error.code}: ${error.message}` : (error as Error).message);
const failed = (results: Json[]) => results.filter((r) => r.ok === false).map((r) => `${String(r.id ?? r.ord ?? "")} ${String(r.code ?? "")} ${String(r.message ?? "")}`.trim());

/**
 * Previews a plan on the station, and with `apply` makes it: each model plan is checked and then
 * applied in turn, then tags, then relations, and the branch is read back and compared again.
 * Without `apply` nothing is changed: a plan that needs what an earlier one adds cannot be checked yet, and says so.
 */
export async function runApply(client: BaskStreamClient, plan: ApplyPlan, options: { apply?: boolean; reason?: string; file?: StationExport } = {}): Promise<ApplyOutcome> {
  const reason = options.reason ? { reason: options.reason } : {};
  const steps: ApplyOutcome["steps"] = [];
  let ok = true;
  // The places earlier plans create: a later plan that names one cannot be checked before they exist.
  const coming: string[] = [];
  const touches = (change: Json) => [change.ord, change.parent, change.source, change.target].filter((v): v is string => typeof v === "string" && !v.startsWith("@")).some((ord) => coming.some((made) => ord === made || ord.startsWith(`${made}/`)));
  for (const changes of plan.plans) {
    const step: ApplyOutcome["steps"][number] = { changes };
    steps.push(step);
    const waits = !options.apply && changes.some(touches);
    // (A component whose parent is a reference is under one of these.)
    for (const change of changes) if (change.action === "create" && !String(change.parent).startsWith("@")) coming.push(`${String(change.parent) === "slot:/" ? "slot:" : String(change.parent)}/${String(change.name)}`);
    if (!ok) continue;
    if (waits) {
      step.waitsFor = "it changes what an earlier plan adds, so the station can check it only once that is applied";
      continue;
    }
    try {
      const preview = (await client.call("preview_model_changes", { changes }, { timeoutMs: 120000 })).result as Json;
      step.checked = true;
      // The station's own account of each change, with the references filled in.
      if (Array.isArray(preview.changes) && preview.changes.length === changes.length) step.changes = preview.changes as Json[];
      for (const change of step.changes) if (change.action === "create" && typeof change.ord === "string") coming.push(change.ord);
      if (!options.apply) continue;
      const applied = (await client.call("apply_model_changes", { planId: preview.planId, planHash: preview.planHash, idempotencyKey: randomUUID(), ...reason }, { timeoutMs: 300000 })).result as Json;
      const bad = ((applied.results ?? []) as Json[]).filter((r) => r.ok === false);
      if (applied.state !== "applied" || bad.length) throw new Error(`the plan ended ${String(applied.state)}: ${bad.map((r) => `change ${Number(r.index) + 1} ${String(r.message ?? r.code ?? "refused")}`).join("; ") || "not all of it was made"}`);
      step.applied = true;
    } catch (error) {
      step.checked ??= false;
      step.error = errorText(error);
      ok = false;
    }
  }
  const outcome: ApplyOutcome = { ...plan, station: String(client.capabilities.station ?? client.http.url.host), steps, applied: false, ok };
  if (!options.apply || !ok) return outcome;
  try {
    for (const some of chunks(plan.tags, 100)) {
      const bad = failed((((await client.call("write_tags", { targets: some, ...reason })).targets ?? []) as Json[]).flatMap((t) => (t.ok === false && !t.results ? [t] : ((t.results ?? []) as Json[]))));
      if (bad.length) throw new Error(`tags: ${bad.join("; ")}`);
    }
    for (const some of chunks(plan.relations, 100)) {
      const bad = failed((((await client.call("write_relations", { targets: some, ...reason })).targets ?? []) as Json[]).flatMap((t) => (t.ok === false && !t.results ? [t] : ((t.results ?? []) as Json[]))));
      if (bad.length) throw new Error(`relations: ${bad.join("; ")}`);
    }
    outcome.applied = true;
  } catch (error) {
    outcome.ok = false;
    steps.push({ changes: [], error: errorText(error) });
  }
  // Read back: what the station holds now, against the file.
  if (options.file) outcome.remaining = diffExports(await exportBranch(client, plan.target), options.file).differences;
  return outcome;
}

/** One line for a change in a plan. */
function changeLine(change: Json): string {
  const where = (ord: unknown) => (String(ord).startsWith("@") ? String(ord) : shortOrd(String(ord ?? ""), 3));
  const names = Object.keys((change.properties ?? {}) as object);
  switch (change.action) {
    case "create": return `add     ${chalk.bold(where(change.ord ?? `${String(change.parent)}/${String(change.name)}`))}  ${chalk.dim(String(change.typeSpec ?? ""))}${names.length ? chalk.dim(`  ${names.join(", ")}`) : ""}`;
    case "update": return `set     ${chalk.bold(where(change.ord))}  ${chalk.dim(names.join(", "))}`;
    case "create_link": return `link    ${chalk.bold(`${where(change.source)}.${String(change.sourceSlot)}`)} → ${chalk.bold(`${where(change.target)}.${String(change.targetSlot)}`)}`;
    case "delete_link": return `unlink  ${chalk.bold(where(change.ord))}  ${chalk.dim(String(change.slot ?? ""))}`;
    case "delete": return `delete  ${chalk.bold(where(change.ord))}${chalk.dim("  and everything under it")}`;
    default: return `${String(change.action)}  ${where(change.ord)}`;
  }
}

export const changeCount = (plan: ApplyPlan) => plan.plans.reduce((n, changes) => n + changes.length, 0) + plan.tags.reduce((n, t) => n + t.set.length + t.remove.length, 0) + plan.relations.reduce((n, r) => n + r.add.length + r.remove.length, 0);

export function printApply(outcome: ApplyOutcome): void {
  const count = changeCount(outcome);
  console.log(`${chalk.bold(outcome.file)} → ${chalk.bold(outcome.target)}  ${chalk.dim(outcome.station)}`);
  if (outcome.differences.length === 0) console.log(chalk.green("No differences: the station already holds what the file does."));
  else console.log(`${outcome.differences.length} difference${outcome.differences.length === 1 ? "" : "s"}: ${count} change${count === 1 ? "" : "s"} to make${outcome.plans.length > 1 ? ` in ${outcome.plans.length} plans` : ""}, ${outcome.notApplied.length} reported only${outcome.createsTarget ? chalk.dim("  (the branch is not there yet: it is added)") : ""}`);
  outcome.steps.forEach((step, i) => {
    if (step.changes.length === 0) return;
    const state = step.applied ? chalk.green("applied") : step.error ? chalk.red("refused") : step.checked ? chalk.green("the station accepts it") : chalk.yellow("not checked yet");
    console.log(`\n${chalk.dim(`plan ${i + 1} of ${outcome.plans.length}`)}  ${state}`);
    for (const change of step.changes) console.log(`  ${changeLine(change)}`);
    if (step.waitsFor) console.log(chalk.dim(`  (${step.waitsFor})`));
  });
  if (outcome.tags.length || outcome.relations.length) {
    console.log(`\n${chalk.dim("tags and relations")}  ${outcome.applied ? chalk.green("written") : chalk.dim("written after the plans; the station has no preview for them")}`);
    for (const t of outcome.tags) console.log(`  tag     ${chalk.bold(shortOrd(t.ord, 3))}  ${[...t.set.map((s) => (s.value === undefined ? s.id : `${s.id}=${String(s.value)}`)), ...t.remove.map((id) => `remove ${id}`)].join(", ")}`);
    for (const r of outcome.relations) console.log(`  relate  ${chalk.bold(shortOrd(r.ord, 3))}  ${[...r.add.map((a) => `${a.id} → ${shortOrd(a.endpoint, 3)}`), ...r.remove.map((a) => `remove ${a.id} → ${shortOrd(a.endpoint, 3)}`)].join(", ")}`);
  }
  if (outcome.notApplied.length) {
    console.log(`\n${chalk.yellow("reported, not applied")}`);
    for (const item of outcome.notApplied) console.log(`  ${item.difference.change.padEnd(7)} ${chalk.bold(item.difference.path)}  ${differenceText(item.difference)}  ${chalk.dim(`· ${item.why}`)}`);
  }
  for (const step of outcome.steps) if (step.error) console.log(`\n${chalk.red("error")}  ${step.error}`);
  console.log(`\n${chalk.dim(LIMITS)}`);
  if (outcome.remaining) {
    const reported = outcome.remaining.every((left) => outcome.notApplied.some((item) => item.difference.path === left.path || left.path.startsWith(`${item.difference.path}/`)));
    console.log(outcome.remaining.length === 0 ? `${chalk.green("✓")} Read back: the branch now matches the file.` : `${chalk.yellow("!")} Read back: ${outcome.remaining.length} difference${outcome.remaining.length === 1 ? "" : "s"} left between the branch and the file${reported ? " (the ones reported above)" : ""}.`);
  }
  else if (!outcome.applied && count > 0 && outcome.ok) console.log(chalk.dim("Nothing is changed yet. To make these changes, run again with --allow-writes --yes."));
}

// ---- Templates -------------------------------------------------------------------------------------

/** The names of the gaps in a template: ${name}. */
export function gapsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{([A-Za-z_][\w.-]*)\}/g)].map((m) => m[1]))];
}

/** Fills a template's gaps from one row. The text is JSON, so each value is written as it must be inside a JSON string. */
export function fillTemplate(text: string, row: Record<string, string>, from: string): string {
  const missing = gapsIn(text).filter((name) => !(name in row));
  if (missing.length) throw new Error(`${from} has ${missing.length === 1 ? "a gap" : "gaps"} with no value: ${missing.map((name) => `\${${name}}`).join(", ")}. The values given are for: ${Object.keys(row).join(", ") || "nothing"}.`);
  return text.replace(/\$\{([A-Za-z_][\w.-]*)\}/g, (_whole, name: string) => JSON.stringify(row[name]).slice(1, -1));
}

/** Rows of a CSV file by column name. Quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string, from: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i += 1;
      record.push(field);
      field = "";
      if (record.some((cell) => cell !== "")) records.push(record);
      record = [];
    } else field += ch;
  }
  record.push(field);
  if (record.some((cell) => cell !== "")) records.push(record);
  if (records.length === 0) throw new Error(`${from} is empty. Its first line names the columns.`);
  const [header, ...rows] = records;
  const names = header.map((name) => name.trim());
  return rows.map((cells) => Object.fromEntries(names.map((name, i) => [name, (cells[i] ?? "").trim()])));
}

/** A template stamped out once per row: each copy as an export and where it goes. */
export function stampTemplate(template: string, rows: Record<string, string>[], from: string, to?: string): { doc: StationExport; target: string; label: string }[] {
  return rows.map((row, i) => {
    const label = `${from} row ${i + 1}`;
    const doc = parseExport(fillTemplate(template, row, from), label);
    return { doc, target: to ? fillTemplate(to, row, "--to") : doc.root, label };
  });
}

// ---- The command ------------------------------------------------------------------------------------

export interface ApplyInput {
  file?: string;
  template?: string;
  each?: string;
  to?: string;
  prune?: boolean;
}

/** What bask apply does with its arguments: reads the file or stamps the template, then previews (or applies) each. Returns the outcomes. */
export async function applyCommand(client: BaskStreamClient, input: ApplyInput, options: { apply: boolean; reason?: string; read: (file: string) => string; normalizeOrd: (ord: string) => string }): Promise<ApplyOutcome[]> {
  if (input.file && input.template) throw new Error("Give an export file or --template, not both.");
  if (input.each && !input.template) throw new Error("--each needs --template: the CSV fills the gaps of a template.");
  let items: { doc: StationExport; target: string; label: string }[];
  if (input.template) {
    const text = options.read(input.template);
    const rows = input.each ? parseCsv(options.read(input.each), input.each) : [{}];
    if (input.each && rows.length === 0) throw new Error(`${input.each} has a header and no rows.`);
    items = stampTemplate(text, rows, input.template, input.to).map((item, i) => ({ ...item, label: input.each ? `${input.template} · ${Object.values(rows[i]).join(", ")}` : input.template! }));
  } else if (input.file) {
    const doc = parseExport(options.read(input.file), input.file);
    items = [{ doc, target: input.to ?? doc.root, label: input.file }];
  } else throw new Error("Nothing to apply. Give an export file (bask export <ord> > file.json), or --template with --each.");
  const outcomes: ApplyOutcome[] = [];
  for (const item of items) {
    const target = options.normalizeOrd(item.target);
    const plan = await planApply(client, item.doc, target, { prune: input.prune, label: item.label });
    outcomes.push(await runApply(client, plan, { apply: options.apply, reason: options.reason, file: item.doc }));
  }
  return outcomes;
}
