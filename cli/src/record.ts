// bask record: turns a station into a demo site file (docs/ROADMAP.md, H). It reads the tree with
// browse, what every point holds now with read, the open alarms, each schedule's week, the tags on
// the components, and a day of history for each numeric point as rollups. The file is played back
// by the demo station (demo/recorded.ts), so work can be tried away from the building. Read-only.
import { createHash, randomBytes } from "node:crypto";
import { toSlotOrd, type BaskStreamClient, type Json } from "@basidekick/baskstream";
import { walkTree } from "./check.js";
import { SITE_FORMAT, type RecordedAlarm, type RecordedComponent, type Recording } from "./demo/recorded.js";
import { MODEL_WORDS } from "./model.js";
import { isBasWord } from "./names.js";

/** Every operation a recording sends. None of them changes the station. */
export const RECORD_OPERATIONS = ["browse", "read", "read_alarms", "read_schedule", "read_tags", "read_history_rollup"] as const;

const HOUR = 3600000;

export interface RecordOptions {
  under?: string;
  /** Hours of history to keep for each point (default 24). */
  hours?: number;
  /** The length of one history step in milliseconds (default 15 minutes). */
  interval?: number;
  /** Replace names (see scrambler). */
  scramble?: boolean;
  /** For the name replacement; random when not given, so one recording's names cannot be matched to another's. */
  salt?: string;
}

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
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_v, i) => items.slice(i * size, (i + 1) * size));

// ---- Replacing names -------------------------------------------------------------------------------

/** Words that say what a thing is, not whose it is: kept when names are replaced, with the name matcher's BAS words and the words bask model knows roles and kinds by. */
const KEPT = new Set(("ahu rtu mau vav fcu crac crah chiller boiler tower plant chw hw hwp chwp cwp ct ups pdu generator gen meter freezer cooler rack compressor unit box loop coil economizer vfd " +
  "drivers services schedules logic config bacnet modbus snmp lon niagara network device devices points point folder alarm history user job service " +
  "cmd mode run on off open closed level load power current energy hours day night low high limit reset main critical maintenance default").split(" "));
const CONSONANTS = "bdfgklmnprstvz";
const VOWELS = "aeiou";

/**
 * Replaces names so a recording does not say whose building it is. In each name, digits and the
 * words that only say what a thing is (BAS words and their abbreviations, equipment kinds, Niagara's
 * own container names) are kept; every other word becomes a made-up word, the same one each time.
 */
export function scrambler(salt: string): (name: string) => string {
  const made = new Map<string, string>();
  const word = (original: string): string => {
    const lower = original.toLowerCase();
    if (KEPT.has(lower) || isBasWord(lower) || MODEL_WORDS.has(lower)) return original;
    if (!made.has(lower)) {
      const hash = createHash("sha256").update(`${salt}|${lower}`).digest();
      const length = Math.max(3, Math.min(8, lower.length));
      made.set(lower, Array.from({ length }, (_v, i) => (i % 2 === 0 ? CONSONANTS[hash[i] % CONSONANTS.length] : VOWELS[hash[i] % VOWELS.length])).join(""));
    }
    const fake = made.get(lower)!;
    // The same shape as the word it stands for: UPPER, Capital or lower.
    return original === original.toUpperCase() && /[A-Z]/.test(original) ? fake.toUpperCase() : /^[A-Z]/.test(original) ? fake[0].toUpperCase() + fake.slice(1) : fake;
  };
  return (name: string) => name.replace(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g, word);
}

// ---- Reading ---------------------------------------------------------------------------------------

const flagsOf = (status: unknown) => String(status ?? "").replace(/^\{|\}.*$/g, "").split(",").map((flag) => flag.trim()).filter((flag) => ["fault", "alarm", "overridden", "down"].includes(flag));

/** Reads a station into a site file. Nothing is changed on the station. */
export async function recordStation(client: BaskStreamClient, options: RecordOptions = {}): Promise<{ recording: Recording; truncated: boolean }> {
  const under = options.under ?? "slot:/";
  const hours = options.hours ?? 24;
  const interval = options.interval ?? 15 * 60000;
  const now = Date.now();
  const { nodes, truncated } = await walkTree(client, under);
  const isPoint = (ord: string) => nodes.get(ord)?.kind === "point";
  // A point's own parts (its proxy extension and the like) are not components of the site.
  const kept = [...nodes.values()].filter((node) => node.ord !== "slot:/" && !isPoint(node.parent));
  const points = kept.filter((node) => node.kind === "point");
  const limits = (client.capabilities.limits ?? {}) as Json;

  const values = new Map<string, Json>();
  await pooled(chunks(points.map((p) => p.ord), Math.max(1, Math.min(500, Number(limits.maxPointSnapshotPoints ?? 500) || 500))), 2, async (some) => {
    for (const snap of await client.read(some, { fresh: false }).catch(() => [])) values.set(toSlotOrd(snap.point), snap as unknown as Json);
  });

  const tags = new Map<string, string[]>();
  await pooled(chunks(kept.filter((node) => node.kind !== "point").map((node) => node.ord), 100), 4, async (some) => {
    const targets = await client.call("read_tags", { ords: some, includeRelations: false }).then((reply) => (reply.targets ?? []) as Json[], () => [] as Json[]);
    for (const target of targets) {
      const direct = ((target.tags ?? []) as Json[]).filter((tag) => tag.marker && tag.source !== "implied").map((tag) => String(tag.id));
      if (direct.length) tags.set(toSlotOrd(String(target.ord ?? "")), direct);
    }
  });

  const histories = new Map<string, NonNullable<RecordedComponent["history"]>>();
  const start = Math.floor((now - hours * HOUR) / interval) * interval;
  await pooled(points.filter((p) => values.get(p.ord)?.valueType === "numeric"), 6, async (point) => {
    const rollup = await client.historyRollup(point.ord, { start, end: now, interval }).catch(() => undefined);
    const buckets = ((((rollup?.histories ?? []) as Json[])[0]?.buckets ?? []) as Json[]);
    if (buckets.length === 0) return;
    const series = new Array<number | null>(Math.ceil((now - start) / interval)).fill(null);
    for (const bucket of buckets) {
      const at = Math.round((Number(bucket.start) - start) / interval);
      const value = Number(bucket.avg);
      if (at >= 0 && at < series.length && Number.isFinite(value)) series[at] = Math.round(value * 1000) / 1000;
    }
    if (series.some((value) => value !== null)) histories.set(point.ord, { start, interval, values: series });
  });

  const schedules = new Map<string, Pick<RecordedComponent, "week" | "defaultOutput">>();
  await pooled(kept.filter((node) => node.kind === "schedule"), 4, async (node) => {
    const schedule = await client.schedule(node.ord).catch(() => undefined);
    if (!schedule) return;
    const valueOf = (wire: Json | undefined) => ({ value: wire?.value ?? false, text: String(wire?.displayValue ?? wire?.value ?? "") });
    const week = Object.fromEntries(Object.entries((((schedule.tree ?? {}) as Json).week ?? {}) as Record<string, Json>).map(([day, entries]) => [day, ((entries?.day ?? []) as Json[]).map((entry) => ({ start: String(entry.start), finish: String(entry.finish), ...valueOf(entry.effectiveValue as Json | undefined) }))]));
    schedules.set(node.ord, { week, defaultOutput: valueOf(schedule.defaultOutput as Json | undefined) });
  });

  const alarmList = ((await client.alarms({ scope: "open", limit: 500 }).catch(() => ({ alarms: [] }))).alarms ?? []) as Json[];

  const rename = options.scramble ? scrambler(options.salt ?? randomBytes(16).toString("hex")) : (name: string) => name;
  // The station's top-level containers and its services keep their names: they are Niagara's own.
  const pathOf = (ord: string) => ord.replace(/^slot:\/?/, "").split("/").map((part, i, parts) => (i === 0 || (i === 1 && parts[0] === "Services") ? part : rename(part))).join("/");
  const taken = new Set<string>();
  const paths = new Map<string, string>();
  const components: RecordedComponent[] = [];
  for (const node of kept.sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0))) {
    // Under its parent's recorded path; two names that came out alike are told apart by a number.
    const above = node.parent || (node.ord.lastIndexOf("/") > 5 ? node.ord.slice(0, node.ord.lastIndexOf("/")) : "slot:/");
    const parent = paths.get(above) ?? pathOf(above);
    const renamed = above === "slot:/" || above === "slot:/Services" ? node.name : rename(node.name);
    let name = renamed;
    for (let n = 2; taken.has(`${parent}/${name}`); n += 1) name = `${renamed}_${n}`;
    const path = parent ? `${parent}/${name}` : name;
    taken.add(`${parent}/${name}`);
    paths.set(node.ord, path);
    const kind = node.kind === "point" || node.kind === "schedule" || node.kind === "container" || node.kind === "component" ? node.kind : node.children > 0 ? "container" : "component";
    const component: RecordedComponent = { path, name, ...(options.scramble || node.display === node.name ? {} : { display: node.display }), type: node.typeSpec, kind };
    if (/\bdown\b/.test(node.status) && node.kind !== "point") component.down = true;
    // Only standard tags stay when names are replaced: a site's own dictionary can name the site.
    const own = (tags.get(node.ord) ?? []).filter((id) => !options.scramble || /^(hs|n):/.test(id));
    if (own.length) component.tags = own;
    if (node.kind === "point") {
      const snap = values.get(node.ord);
      const facets = (snap?.facets ?? {}) as Json;
      const vt = snap?.valueType === "boolean" || snap?.valueType === "enum" || snap?.valueType === "numeric" ? snap.valueType : /Boolean/.test(node.typeSpec) ? "boolean" : /Enum/.test(node.typeSpec) ? "enum" : "numeric";
      const value = snap?.value;
      Object.assign(component, {
        valueType: vt, writable: node.writable || /Writable$/.test(node.typeSpec),
        value: typeof value === "number" ? (Number.isFinite(value) ? value : null) : typeof value === "boolean" || typeof value === "string" ? value : null,
        ...(typeof facets.units === "string" && facets.units ? { units: facets.units } : {}),
        ...(facets.precision !== undefined && Number.isFinite(Number(facets.precision)) ? { precision: Number(facets.precision) } : {}),
        ...(typeof facets.trueText === "string" && typeof facets.falseText === "string" ? { texts: [facets.trueText, facets.falseText] } : {}),
        ...(Array.isArray(snap?.enumOptions) ? { options: (snap.enumOptions as Json[]).map((option) => String(option.tag)) } : Array.isArray(facets.range) ? { options: (facets.range as unknown[]).map(String) } : {})
      });
      const flags = flagsOf(snap?.status).filter((flag) => flag !== "down");
      if (flags.length) component.status = flags;
      if (histories.has(node.ord)) component.history = histories.get(node.ord)!;
    } else if (node.kind === "schedule") Object.assign(component, schedules.get(node.ord) ?? {});
    components.push(component);
  }

  const alarms: RecordedAlarm[] = [];
  for (const alarm of alarmList) {
    const source = toSlotOrd(String(((alarm.sources ?? []) as unknown[])[0] ?? ""));
    const path = paths.get(source);
    // An alarm on something outside what was recorded has nowhere to go.
    if (!path) continue;
    const state = String(alarm.sourceState ?? "offnormal");
    alarms.push({
      source: path,
      // Alarm text is free text and the likeliest place for a name, so with names replaced it is rebuilt from what is known.
      message: options.scramble ? `${state[0].toUpperCase()}${state.slice(1)} alarm: ${path.split("/").slice(-3).filter((part) => part !== "points").join(" ")}` : String(alarm.message ?? ""),
      alarmClass: rename(String(alarm.alarmClass ?? "default")), priority: Number(alarm.priority ?? 120) || 120, sourceState: state, acked: alarm.ackState === "acked", ageMs: Math.max(0, now - Number(alarm.timestamp ?? now))
    });
  }
  const station = options.scramble ? "Recorded" : String(client.capabilities.station ?? client.http.url.hostname);
  return { recording: { format: SITE_FORMAT, version: 1, station, recordedAt: new Date(now).toISOString(), scrambled: Boolean(options.scramble), hours, components, alarms }, truncated };
}

/** What a recording holds, in a line. */
export function recordingSummary(recording: Recording): string {
  const points = recording.components.filter((c) => c.kind === "point");
  const withHistory = points.filter((c) => c.history).length;
  return `${recording.components.length} components, ${points.length} points (${withHistory} with ${recording.hours} hours of history), ${recording.components.filter((c) => c.kind === "schedule").length} schedules, ${recording.alarms.length} open alarms${recording.scrambled ? ", names replaced" : ""}`;
}
