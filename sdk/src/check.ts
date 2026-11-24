// bask check: a read-only punch list for a station (docs/ROADMAP.md, E1). It is worked out here, in
// the client, from operations any login that can read may use: query, browse, describe_component,
// read_schedule, read_history (the audit history), describe_history, read_alarms and the graphics
// inventory behind bask px qa. The rules are data (check-rules.ts).
import chalk from "chalk";
import { BaskStreamError, toSlotOrd, type BaskStreamClient, type BrowseNode, type Json } from "./core.js";
import { findBehaviour, type BehaviourResult } from "./behaviour.js";
import type { Condition, Rule, Severity } from "./check-rules.js";
import { csv, shortOrd, table } from "./format.js";

/** Every operation a check sends. None of them changes the station. */
export const CHECK_OPERATIONS = ["query", "browse", "describe_component", "read_schedule", "read_history", "read_history_rollup", "read", "read_tags", "describe_history", "read_alarms", "graphics_inventory"] as const;

export type Row = Record<string, unknown>;

export interface Finding {
  rule: string;
  group: string;
  severity: Severity;
  title: string;
  /** The component, file or account it is about. */
  where: string;
  message: string;
}

export interface RuleOutcome {
  id: string;
  group: string;
  title: string;
  severity?: Severity;
  /** How many rows the rule looked at. */
  rows: number;
  findings: number;
  /** Findings left out because another rule already reported the place (the rule's "unless"). */
  covered?: number;
  /** The source stopped at a limit, so there may be more. */
  truncated?: boolean;
  /** Why the rule could not run on this station. */
  skipped?: string;
}

export interface CheckResult {
  station: string;
  under: string;
  checkedAt: string;
  summary: { errors: number; warnings: number; review: number; info: number; findings: number; rules: number; skipped: number };
  findings: Finding[];
  rules: RuleOutcome[];
}

/** A component of the walked tree. */
export interface WalkNode {
  ord: string;
  name: string;
  display: string;
  typeSpec: string;
  kind: string;
  status: string;
  parent: string;
  /** A point that can be commanded. */
  writable: boolean;
  /** Components directly under it. */
  children: number;
  /** Control points anywhere under it. */
  points: number;
  /** The names of those points. */
  pointNames: string[];
}

const WALK_CAP = 20000;
const QUERY_LIMIT = 5000;
const HOUR = 3600000;
/** How far back the audit history is read for when a point was overridden. */
const AUDIT_LOOKBACK = 7 * 24 * HOUR;
const AUDIT_LIMIT = 5000;
/** The most histories one check asks about, one request each. */
const HISTORY_CAP = 2000;
const ALARM_LIMIT = 1000;

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

/** Niagara escapes characters in slot names as $xx; compare and show them as typed. */
const plain = (name: string) => name.replace(/\$([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const parentOf = (ord: string) => (ord.lastIndexOf("/") > 5 ? ord.slice(0, ord.lastIndexOf("/")) : "slot:/");

/** Reads the tree under `under` with browse, as deep as it goes, up to `cap` components. */
export async function walkTree(client: BaskStreamClient, under: string, cap = WALK_CAP): Promise<{ nodes: Map<string, WalkNode>; truncated: boolean }> {
  const limits = (client.capabilities.limits ?? {}) as Json;
  const depth = Math.max(1, Math.min(4, Number(limits.maxBrowseDepth ?? 4) || 4));
  const nodes = new Map<string, WalkNode>();
  let truncated = false;
  const put = (node: BrowseNode, parent: string): string => {
    const ord = toSlotOrd(node.ord);
    // A real station sends some nodes without a name (seen on N4.15); the last part of the path is the name.
    const name = typeof node.name === "string" && node.name ? node.name : ord.slice(ord.lastIndexOf("/") + 1);
    nodes.set(ord, { ord, name: plain(name), display: plain(String(node.display ?? name)), typeSpec: String(node.typeSpec ?? ""), kind: String(node.kind ?? ""), status: String(node.status ?? ""), parent, writable: node.writable === true, children: 0, points: 0, pointNames: [] });
    return ord;
  };
  let wave = [under];
  let first = true;
  while (wave.length && !truncated) {
    const next: string[] = [];
    const visit = (node: BrowseNode, ord: string, level: number) => {
      for (const child of node.children ?? []) {
        if (nodes.size >= cap) return void (truncated = true);
        const at = put(child, ord);
        if (child.children) visit(child, at, level + 1);
        else if (child.hasChildren) next.push(at);
      }
    };
    const branches = await pooled(wave, 4, (ord) => client.browse(ord, { depth }).catch((error: unknown) => {
      // A branch this login may not read is left out; anything else is a real failure.
      if (error instanceof BaskStreamError && /forbidden|permission|not_found|invalid/.test(error.code) && !first) return undefined;
      throw error;
    }));
    branches.forEach((branch, i) => {
      if (!branch) return;
      if (first) put(branch, "");
      visit(branch, wave[i], 1);
    });
    first = false;
    wave = next;
  }
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parent);
    if (parent) parent.children += 1;
    if (node.kind !== "point") continue;
    for (let up = nodes.get(node.parent); up; up = nodes.get(up.parent)) {
      up.points += 1;
      if (!up.pointNames.includes(node.name)) up.pointNames.push(node.name);
    }
  }
  return { nodes, truncated };
}

/** A length of time in words: "16 hours", "3 days". */
export function ago(ms: number): string {
  const hours = ms / HOUR;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}
const hoursOf = (ms: number) => Math.round((ms / HOUR) * 10) / 10;
const shortDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * The overrides in audit records, newest per point. A record's text is
 * "12-Nov-26 12:50 PM MST[admin] Invoked;slotName=override;value=…" and its summary
 * "12-Nov-26 12:50 PM MST Invoked /Drivers/… override … admin": the point is the word after the operation.
 */
export function overridesIn(records: Json[]): Map<string, { at: number; user: string }> {
  const latest = new Map<string, { at: number; user: string }>();
  for (const record of records) {
    const head = /^([^[]*)\[([^\]]*)\] ([^;]*);slotName=([^;]*)/.exec(String(record.value ?? ""));
    if (!head || typeof record.timestamp !== "number" || head[3] !== "Invoked" || !/^(emergency_?)?override$/i.test(head[4])) continue;
    const summary = String(record.summary ?? "");
    const after = summary.indexOf(` ${head[3]} `);
    const target = after < 0 ? "" : summary.slice(after + head[3].length + 2).split(" ")[0];
    if (!target.startsWith("/")) continue;
    const ord = `slot:${target}`;
    if (!latest.has(ord) || latest.get(ord)!.at < record.timestamp) latest.set(ord, { at: record.timestamp, user: head[2] });
  }
  return latest;
}

/** A history's interval in milliseconds from its text ("15 minutes"), or undefined when it does not record on one (change of value). */
export function intervalMs(text: string): number | undefined {
  const found = /(\d+(?:\.\d+)?)\s*(ms|millis|sec|min|hour|hr|day)/i.exec(text);
  if (!found) return undefined;
  const unit = found[2].toLowerCase();
  const ms = Number(found[1]) * (unit.startsWith("m") && unit !== "min" ? 1 : unit === "sec" ? 1000 : unit === "min" ? 60000 : unit === "day" ? 24 * HOUR : HOUR);
  return ms > 0 ? ms : undefined;
}

/**
 * When a schedule's special event is over for good, or undefined when that cannot be said: its dates
 * (a date, or the start and end of a range) must each name a year. A date that cannot be read
 * counts as the last day of its year.
 */
export function exceptionEnd(event: Json): number | undefined {
  const texts: string[] = [];
  const gather = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(gather);
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "date" || key === "start" || key === "end") && typeof inner === "string" && inner) texts.push(inner);
      else gather(inner);
    }
  };
  gather(event.days);
  if (texts.length === 0 && typeof event.display === "string") texts.push(event.display);
  let end = -Infinity;
  for (const text of texts) {
    const year = /\b((?:19|20)\d\d)\b/.exec(text)?.[1];
    if (!year) return undefined;
    const parsed = Date.parse(text);
    const day = Number.isNaN(parsed) ? new Date(Number(year), 11, 31).getTime() : new Date(parsed).setHours(0, 0, 0, 0);
    end = Math.max(end, day + 24 * HOUR);
  }
  return Number.isFinite(end) ? end : undefined;
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

/** A cell as text, for comparing. */
const text = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));

function holds(row: Row, c: Condition): boolean {
  const left = text(row[c.field]);
  switch (c.op) {
    case "equals": return left === text(c.value);
    case "notEquals": return left !== text(c.value);
    case "matches": return new RegExp(text(c.value), "i").test(left);
    case "notMatches": return !new RegExp(text(c.value), "i").test(left);
    case "above": return left !== "" && Number(left) > Number(c.value);
    case "below": return left !== "" && Number(left) < Number(c.value);
    case "empty": return left === "";
    case "notEmpty": return left !== "";
  }
}

/** How a name joins its words. A single word says nothing about that. */
export function nameStyle(name: string): string | undefined {
  if (name.includes("_")) return "with underscores";
  if (name.includes("-")) return "with hyphens";
  if (name.includes(" ")) return "with spaces";
  if (name.includes(".")) return "with dots";
  if (/[a-z]/.test(name) && /[a-z0-9][A-Z]/.test(name)) return "as joined words";
  return undefined;
}

/** The min and max in a facets string as BQL gives it: "units=u:…|min=d:0.0|max=d:100.0". */
export function facetRange(facets: string): { min?: number; max?: number } {
  const bound = (name: string) => {
    const found = new RegExp(`(?:^|\\|)${name}=(?:[a-zA-Z]:)?([^|;]+)`).exec(facets)?.[1];
    if (found === undefined || /inf|nan/i.test(found)) return undefined;
    const n = Number(found);
    return Number.isFinite(n) ? n : undefined;
  };
  return { min: bound("min"), max: bound("max") };
}

const whereOf = (rule: Rule, row: Row) => {
  const field = rule.where ?? ["slotPath", "parent.slotPath", "ord"].find((name) => name in row) ?? Object.keys(row)[0];
  return text(row[field]);
};

const fill = (template: string, row: Row, extra: Row) => template.replace(/\{([\w.]+)\}/g, (whole, name: string) => (name in extra ? text(extra[name]) : name in row ? text(row[name]) : whole));

/**
 * The rows of a rule that are findings, each with what to say about it. `having` is the set a
 * missingAmongAlike test compares against.
 */
export function evaluate(rule: Rule, rows: Row[], having?: Set<string>, more: Row = {}): { where: string; message: string }[] {
  const test = rule.test;
  if (!test) return [];
  const found: { row: Row; extra: Row }[] = [];
  const byField = (field: string) => {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = text(row[field]);
      if (key !== "") groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return groups;
  };
  if (test.is === "found") for (const row of rows) found.push({ row, extra: {} });
  else if (test.is === "compare") {
    for (const row of rows) if (test.all.every((c) => holds(row, c))) found.push({ row, extra: {} });
  } else if (test.is === "duplicate") {
    for (const group of byField(test.field).values()) {
      if (group.length < 2) continue;
      for (const row of group) found.push({ row, extra: { others: group.filter((other) => other !== row).map((other) => shortOrd(whereOf(rule, other), 2)).join(", ") } });
    }
  } else if (test.is === "outsideFacets") {
    for (const row of rows) {
      const value = row[test.value];
      const { min, max } = facetRange(text(row[test.facets]));
      if (typeof value !== "number" || !Number.isFinite(value) || (min === undefined && max === undefined)) continue;
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) found.push({ row, extra: { min: min ?? "no minimum", max: max ?? "no maximum" } });
    }
  } else if (test.is === "missingAmongAlike") {
    const has = having ?? new Set<string>();
    for (const group of byField(test.alike).values()) {
      if (group.length < (test.atLeast ?? 4)) continue;
      const with_ = group.filter((row) => has.has(text(row[test.key]))).length;
      for (const row of group) {
        if (has.has(text(row[test.key]))) continue;
        if (with_ / (group.length - 1) >= (test.share ?? 0.75)) found.push({ row, extra: { have: with_, others: group.length - 1 } });
      }
    }
  } else if (test.is === "notNamedBy") {
    const used = having ?? new Set<string>();
    for (const row of rows) if (text(row[test.key]) !== "" && !used.has(text(row[test.key]))) found.push({ row, extra: more });
  } else if (test.is === "nameStyle") {
    for (const group of byField("parent").values()) {
      const styled = group.map((row) => ({ row, style: nameStyle(text(row.name)) })).filter((entry) => entry.style);
      if (styled.length < (test.atLeast ?? 5)) continue;
      const counts = new Map<string, number>();
      for (const entry of styled) counts.set(entry.style!, (counts.get(entry.style!) ?? 0) + 1);
      const [usual, same] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (same / styled.length < (test.share ?? 0.8)) continue;
      for (const entry of styled) if (entry.style !== usual) found.push({ row: entry.row, extra: { style: entry.style, usual, same, siblings: styled.length - 1 } });
    }
  } else if (test.is === "pointSet") {
    const families = new Map<string, Row[]>();
    for (const row of rows) {
      const family = `${text(row.parent)}/${text(row.name).replace(/\d+/g, "*")}`;
      families.set(family, [...(families.get(family) ?? []), row]);
    }
    for (const [family, group] of families) {
      if (group.length < (test.atLeast ?? 4)) continue;
      const namesOf = (row: Row) => (Array.isArray(row.pointNames) ? (row.pointNames as string[]) : []);
      for (const row of group) {
        const others = group.filter((other) => other !== row);
        const mine = new Set(namesOf(row));
        const counts = new Map<string, number>();
        for (const other of others) for (const name of namesOf(other)) counts.set(name, (counts.get(name) ?? 0) + 1);
        const missing = [...counts].filter(([name, n]) => !mine.has(name) && n / others.length >= (test.share ?? 0.8));
        if (missing.length === 0) continue;
        const only = [...mine].filter((name) => !counts.has(name));
        found.push({ row, extra: { missing: missing.map(([name]) => name).join(", "), have: Math.min(...missing.map(([, n]) => n)), others: others.length, family: family.slice(family.lastIndexOf("/") + 1), extra: only.length ? `; it has ${only.join(", ")}, which none of them has` : "" } });
      }
    }
  }
  return found.map(({ row, extra }) => ({ where: whereOf(rule, row), message: fill(rule.message ?? rule.title, row, extra) }));
}

const ORD_FIELD = /(^|\.)(slotPath|ord)$/;
/** A query's rows by column name, with slot paths in the one form bask uses (slot:/…). */
function rowsOf(result: { columns?: { name: string }[]; rows?: unknown[][]; entities?: { ord: string; name: string; display: string; typeSpec: string }[] }): Row[] {
  if (result.entities) return result.entities.map((e) => ({ ord: toSlotOrd(e.ord), slotPath: toSlotOrd(e.ord), name: e.name, display: e.display, typeSpec: e.typeSpec }));
  const names = (result.columns ?? []).map((column) => column.name);
  return (result.rows ?? []).map((cells) => Object.fromEntries(names.map((name, i) => {
    const cell = cells[i];
    if (typeof cell !== "string" || !ORD_FIELD.test(name)) return [name, cell];
    return [name, cell.startsWith("/") ? `slot:${cell}` : toSlotOrd(cell)];
  })));
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, review: 2, info: 3 };

/** Why a rule could not run, or undefined when the error is not about the rule. */
function skipReason(error: unknown, op: string): string | undefined {
  if (!(error instanceof BaskStreamError)) return undefined;
  if (["connection_closed", "session_expired", "login_failed", "timeout"].includes(error.code)) return undefined;
  if (/unsupported|unknown_op/.test(error.code)) return `this station's baskStream does not have ${op}`;
  return `${error.code}: ${error.message}`;
}

/** Runs the rules against a station. Nothing is changed. */
export async function runCheck(client: BaskStreamClient, rules: Rule[], options: { under?: string } = {}): Promise<CheckResult> {
  const under = options.under ?? "slot:/";
  // A query or a walk that several rules share runs once.
  const queries = new Map<string, Promise<{ rows: Row[]; truncated: boolean }>>();
  const query = (q: { bql: string } | { neql: string }) => {
    const key = JSON.stringify(q);
    if (!queries.has(key)) queries.set(key, client.query(q, { ord: under, limit: QUERY_LIMIT, timeoutMillis: 60000 }).then((result) => ({ rows: rowsOf(result), truncated: result.truncated })));
    return queries.get(key)!;
  };
  let walked: ReturnType<typeof walkTree> | undefined;
  const walk = () => (walked ??= walkTree(client, under));
  const described = new Map<string, Promise<Json | undefined>>();
  const describe = (ord: string) => {
    if (!described.has(ord)) described.set(ord, client.call("describe_component", { ord }).then((reply) => reply.result as Json));
    return described.get(ord)!;
  };

  // The audit history, read once: the newest override of each point, how far back it reaches, and whether it was cut short.
  let audited: Promise<{ overrides: Map<string, { at: number; user: string }>; oldest?: number; truncated: boolean }> | undefined;
  // Where the audit history is. A real station does not name itself in capabilities, so its audit service is asked.
  const auditOrd = async (): Promise<string> => {
    if (client.capabilities.station) return `history:/${String(client.capabilities.station)}/AuditHistory`;
    const found = await client.query({ bql: "select historyConfig.id from history:AuditHistoryService" }, { limit: 1 });
    const id = (found.rows as unknown[][] | undefined)?.[0]?.[0];
    if (typeof id !== "string" || !id) throw new Error("This station has no audit history service to read overrides from.");
    return `history:${id}`;
  };
  const auditOverrides = () => (audited ??= auditOrd().then((ord) => client.history(ord, { start: Date.now() - AUDIT_LOOKBACK, end: Date.now(), limit: AUDIT_LIMIT })).then((history) => {
    const lists = ((history.histories ?? []) as Json[]);
    const records = lists.flatMap((h) => (h.records ?? []) as Json[]);
    const times = records.map((record) => Number(record.timestamp)).filter(Number.isFinite);
    return { overrides: overridesIn(records), oldest: times.length ? Math.min(...times) : undefined, truncated: lists.some((h) => h.truncated === true) };
  }));

  // Every behaviour rule shares one look at the equipment.
  let behaved: Promise<BehaviourResult> | undefined;
  const behaviour = () => (behaved ??= findBehaviour(client, under));

  const run = async (rule: Rule): Promise<{ outcome: RuleOutcome; findings: Finding[] }> => {
    const outcome: RuleOutcome = { id: rule.id, group: rule.group, title: rule.title, ...(rule.severity ? { severity: rule.severity } : {}), rows: 0, findings: 0 };
    const finding = (severity: Severity, where: string, message: string): Finding => ({ rule: rule.id, group: rule.group, severity, title: rule.title, where, message });
    let op = "query";
    try {
      if (rule.behaviour) {
        op = "read_history_rollup";
        const result = await behaviour();
        const mine = result.findings.filter((item) => item.kind === rule.behaviour);
        outcome.rows = result.looked[rule.behaviour];
        if (result.truncated) outcome.truncated = true;
        if (!outcome.rows) outcome.skipped = result.units ? "no unit here has the points this needs" : "no equipment was recognised here";
        outcome.findings = mine.length;
        return { outcome, findings: mine.map((item) => finding(rule.severity ?? "warning", item.where, item.message)) };
      }
      if (rule.graphics) {
        op = "graphics_inventory";
        const inventory = await client.graphicsInventory({ ...(under === "slot:/" ? {} : { under }), checkBindings: true });
        outcome.rows = inventory.punchList.length;
        if (inventory.truncated) outcome.truncated = true;
        const found = inventory.punchList.map((item) => finding(item.severity === "error" || item.severity === "warning" ? item.severity : "info", item.where, `${item.kind}: ${item.message}`));
        outcome.findings = found.length;
        return { outcome, findings: found };
      }
      let rows: Row[];
      if (rule.walk) {
        op = "browse";
        const spec = rule.walk;
        const tree = await walk();
        if (tree.truncated) outcome.truncated = true;
        const type = spec.type ? glob(spec.type) : undefined;
        const name = spec.name ? glob(spec.name) : undefined;
        const picked = [...tree.nodes.values()].filter((node) => (!type || type.test(node.typeSpec)) && (!spec.kind || node.kind === spec.kind) && (!name || name.test(node.name)));
        rows = await pooled(picked, 6, async (node): Promise<Row> => {
          const row: Row = { ...node, slotPath: node.ord, type: node.typeSpec, parentName: tree.nodes.get(node.parent)?.name ?? "" };
          if (spec.describe) {
            op = "describe_component";
            const links = ((await describe(node.ord))?.links ?? []) as Json[];
            row.linksIn = links.filter((link) => link.direction === "in").length;
            row.linksOut = links.filter((link) => link.direction === "out").length;
          }
          if (spec.schedule) {
            op = "read_schedule";
            const tree_ = ((await client.schedule(node.ord)).tree ?? {}) as Json;
            const week = Object.values((tree_.week ?? {}) as Record<string, Json>).reduce((n, day) => n + (Array.isArray(day?.day) ? day.day.length : 0), 0);
            const special = (Array.isArray(tree_.specialEvents) ? tree_.specialEvents : []) as Json[];
            row.events = week + special.length;
            const over = special.filter((event) => (exceptionEnd(event) ?? Infinity) < Date.now());
            row.pastExceptions = over.length;
            row.pastExceptionNames = over.map((event) => `${String(event.name ?? "")}${event.display ? ` (${String(event.display)})` : ""}`).join(", ");
          }
          return row;
        });
      } else {
        const result = await query(rule.query!);
        rows = result.rows;
        if (result.truncated) outcome.truncated = true;
        if (rule.add === "overrideAge") {
          op = "read_history";
          const audit = await auditOverrides();
          rows = rows.map((row) => {
            const since = audit.overrides.get(text(row.slotPath));
            if (since) return { ...row, overriddenHours: hoursOf(Date.now() - since.at), overriddenFor: `for ${ago(Date.now() - since.at)} (since ${shortDate(since.at)}, by ${since.user})` };
            // No override of it in what was read: it is at least as old as that reaches, when all of it was read.
            if (audit.truncated || audit.oldest === undefined) return row;
            return { ...row, overriddenHours: hoursOf(Date.now() - audit.oldest), overriddenFor: `for more than ${ago(Date.now() - audit.oldest)} (the audit history has no override of it since ${shortDate(audit.oldest)})` };
          });
          if (audit.truncated) outcome.truncated = true;
        } else if (rule.add === "historyAge") {
          op = "describe_history";
          const field = ["parent.slotPath", "slotPath", "ord"].find((name) => rows[0] && name in rows[0]) ?? "parent.slotPath";
          const points = [...new Set(rows.map((row) => text(row[field])).filter(Boolean))];
          if (points.length > HISTORY_CAP) outcome.truncated = true;
          rows = (await pooled(points.slice(0, HISTORY_CAP), 6, async (ord): Promise<Row> => {
            const histories = (((await client.call("describe_history", { ord })).history as Json | undefined)?.histories ?? []) as Json[];
            // The history that has been quiet longest, among those that record on an interval.
            let worst: Row | undefined;
            for (const history of histories) {
              const interval = intervalMs(String((history.config as Json | undefined)?.interval ?? ""));
              const last = Number(history.lastTimestamp);
              if (!interval || !Number.isFinite(last) || last <= 0) continue;
              const quiet = Date.now() - last;
              if (quiet <= 3 * interval || (worst && Number(worst.lastRecordHours) >= hoursOf(quiet))) continue;
              worst = { lastRecordHours: hoursOf(quiet), lastRecordFor: ago(quiet), historyId: String(history.historyId ?? (history.config as Json | undefined)?.id ?? ""), historyInterval: String((history.config as Json).interval) };
            }
            return { slotPath: ord, [field]: ord, histories: histories.length, ...worst };
          }));
        }
      }
      outcome.rows = rows.length;
      let having: Set<string> | undefined;
      if (rule.test?.is === "missingAmongAlike") {
        const other = await query({ bql: rule.test.having.bql });
        if (other.truncated) outcome.truncated = true;
        having = new Set(other.rows.map((row) => text(row[(rule.test as { having: { field: string } }).having.field])));
      }
      let more: Row = {};
      if (rule.test?.is === "notNamedBy") {
        const by = rule.test.by;
        const other = await query({ bql: by.bql });
        if (other.truncated) outcome.truncated = true;
        having = new Set(other.rows.map((row) => text(row[by.field])).filter(Boolean));
        if (rule.test.alarms) {
          op = "read_alarms";
          const alarms = (((await client.alarms({ scope: "all", limit: ALARM_LIMIT })).alarms ?? []) as Json[]);
          for (const alarm of alarms) if (alarm.alarmClass) having.add(String(alarm.alarmClass));
          more = { alarmsRead: alarms.length };
        }
      }
      const found = evaluate(rule, rows, having, more).map((f) => finding(rule.severity!, f.where, f.message));
      outcome.findings = found.length;
      return { outcome, findings: found };
    } catch (error) {
      const reason = skipReason(error, op);
      if (reason === undefined) throw error;
      outcome.skipped = reason;
      return { outcome, findings: [] };
    }
  };

  const results = await pooled(rules, 4, run);
  // "unless": what another rule already reported is not listed twice (a down device, then each of its points).
  const before = new Map(results.map((r) => [r.outcome.id, r.findings]));
  rules.forEach((rule, i) => {
    const places = (rule.unless ?? []).flatMap((id) => before.get(id) ?? []).map((f) => f.where);
    if (places.length === 0) return;
    const kept = results[i].findings.filter((f) => !places.some((where) => f.where === where || f.where.startsWith(`${where}/`)));
    if (kept.length === results[i].findings.length) return;
    results[i].outcome.covered = results[i].findings.length - kept.length;
    results[i].outcome.findings = kept.length;
    results[i].findings = kept;
  });
  const groupOrder = [...new Set(rules.map((rule) => rule.group))];
  const findings = results.flatMap((r) => r.findings).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.rule.localeCompare(b.rule) || a.where.localeCompare(b.where));
  const count = (severity: Severity) => findings.filter((f) => f.severity === severity).length;
  return {
    station: String(client.capabilities.station ?? client.http.url.host),
    under,
    checkedAt: new Date().toISOString(),
    summary: { errors: count("error"), warnings: count("warning"), review: count("review"), info: count("info"), findings: findings.length, rules: rules.length, skipped: results.filter((r) => r.outcome.skipped).length },
    findings,
    rules: results.map((r) => r.outcome)
  };
}

// ---- Output ---------------------------------------------------------------------------------------

const severityColor = (severity: Severity) => (severity === "error" ? chalk.red : severity === "warning" ? chalk.yellow : severity === "review" ? chalk.cyan : chalk.dim);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const place = (where: string) => (where.startsWith("slot:/") ? shortOrd(where, 3) : where);

export function summaryText(result: CheckResult): string {
  const s = result.summary;
  return [plural(s.errors, "error"), plural(s.warnings, "warning"), `${s.review} to review`, `${s.info} info`].join(", ");
}

export function printCheck(result: CheckResult): void {
  const s = result.summary;
  console.log(`${chalk.bold(result.station)}  ${chalk.dim(`${result.under} · ${plural(s.rules, "rule")}`)}`);
  console.log(`${s.errors ? chalk.red(plural(s.errors, "error")) : chalk.green("no errors")}, ${s.warnings ? chalk.yellow(plural(s.warnings, "warning")) : "no warnings"}, ${s.review} to review, ${s.info} info`);
  if (result.findings.length) {
    console.log();
    console.log(table(["", "group", "where", "what"], result.findings.map((f) => [severityColor(f.severity)(f.severity), f.group, place(f.where), f.message])));
  }
  const cut = result.rules.filter((r) => r.truncated && !r.skipped);
  const skipped = result.rules.filter((r) => r.skipped);
  if (cut.length || skipped.length) console.log();
  for (const r of cut) console.log(chalk.yellow(`${r.id} stopped at a limit: there may be more. Narrow it with --under.`));
  for (const r of skipped) console.log(chalk.dim(`skipped  ${r.id}: ${r.skipped}`));
}

export function checkCsv(result: CheckResult): string {
  return csv(["severity", "group", "rule", "where", "message"], result.findings.map((f) => [f.severity, f.group, f.rule, f.where, f.message]));
}

const esc = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The check as one page with nothing outside it: styles inline, no scripts, no images. */
export function checkHtml(result: CheckResult): string {
  const s = result.summary;
  const groups = [...new Set(result.rules.map((r) => r.group))];
  const when = new Date(result.checkedAt);
  const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const section = (group: string) => {
    const found = result.findings.filter((f) => f.group === group);
    const rules = result.rules.filter((r) => r.group === group);
    const clean = rules.filter((r) => !r.skipped && r.findings === 0);
    const skipped = rules.filter((r) => r.skipped);
    const cut = rules.filter((r) => r.truncated && !r.skipped);
    return `<section>
<h2>${esc(group)} <span class="count">${found.length ? plural(found.length, "item") : "nothing found"}</span></h2>
${found.length ? `<table>
<thead><tr><th></th><th>Where</th><th>What</th><th>Check</th></tr></thead>
<tbody>
${found.map((f) => `<tr><td><span class="sev ${f.severity}">${esc(f.severity)}</span></td><td class="where">${esc(place(f.where))}</td><td>${esc(f.message)}</td><td class="rule">${esc(f.title)}</td></tr>`).join("\n")}
</tbody>
</table>` : ""}
${clean.length ? `<p class="note">Checked and found nothing: ${clean.map((r) => esc(r.title)).join("; ")}.</p>` : ""}
${cut.map((r) => `<p class="note">${esc(r.title)} stopped at a limit, so there may be more.</p>`).join("\n")}
${skipped.map((r) => `<p class="note">Not checked: ${esc(r.title)} (${esc(r.skipped)}).</p>`).join("\n")}
</section>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Station check: ${esc(result.station)}</title>
<style>
:root { --ink: #1c2330; --soft: #5b6676; --line: #dde2ea; --paper: #ffffff; --wash: #f5f7fa; --error: #b42318; --warning: #9a6700; --review: #175cd3; --info: #5b6676; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px 48px; background: var(--wash); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 4px; }
.meta { color: var(--soft); margin: 0 0 20px; }
.totals { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 28px; padding: 0; list-style: none; }
.totals li { flex: 1 1 140px; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; }
.totals b { display: block; font-size: 28px; line-height: 1.2; }
.totals .error b { color: var(--error); } .totals .warning b { color: var(--warning); } .totals .review b { color: var(--review); }
section { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; margin: 0 0 16px; overflow-x: auto; }
h2 { font-size: 18px; margin: 0 0 10px; }
.count { color: var(--soft); font-weight: normal; font-size: 14px; margin-left: 6px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; color: var(--soft); font-weight: 600; font-size: 13px; border-bottom: 1px solid var(--line); padding: 6px 10px 6px 0; }
td { vertical-align: top; border-bottom: 1px solid var(--line); padding: 7px 10px 7px 0; }
tr:last-child td { border-bottom: 0; }
.where { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; white-space: nowrap; }
.rule { color: var(--soft); font-size: 13px; }
.sev { display: inline-block; min-width: 62px; text-align: center; border-radius: 4px; padding: 1px 8px; font-size: 12px; font-weight: 600; color: #fff; background: var(--info); }
.sev.error { background: var(--error); } .sev.warning { background: var(--warning); } .sev.review { background: var(--review); }
.note { color: var(--soft); font-size: 13px; margin: 8px 0 0; }
footer { color: var(--soft); font-size: 13px; margin-top: 24px; }
@media print { body { background: #fff; padding: 0; } section, .totals li { break-inside: avoid; } }
</style>
</head>
<body>
<main>
<h1>Station check: ${esc(result.station)}</h1>
<p class="meta">${esc(date)} · ${esc(result.under === "slot:/" ? "whole station" : result.under)} · ${plural(s.rules, "check")}${s.skipped ? `, ${s.skipped} not run` : ""}</p>
<ul class="totals">
<li class="error"><b>${s.errors}</b>${s.errors === 1 ? "error" : "errors"}</li>
<li class="warning"><b>${s.warnings}</b>${s.warnings === 1 ? "warning" : "warnings"}</li>
<li class="review"><b>${s.review}</b>to review</li>
<li><b>${s.info}</b>info</li>
</ul>
${groups.map(section).join("\n")}
<footer>Read-only: this check changed nothing on the station. Made with bask check.</footer>
</main>
</body>
</html>
`;
}

