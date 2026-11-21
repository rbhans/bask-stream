// A site recorded from a station with `bask record`, played back by the demo station: its tree, the
// values it had, its alarms, and a day of histories that repeats. The format is written by record.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Site, SiteName } from "./sites.js";

export const SITE_FORMAT = "bask-site";

export interface RecordedComponent {
  /** Where it is under slot:/, e.g. "Drivers/BacnetNetwork/AHU_01/points/SupplyAirTemp". */
  path: string;
  name: string;
  display?: string;
  type: string;
  kind: "container" | "component" | "point" | "schedule";
  /** A device or network that was not answering. */
  down?: boolean;
  /** Tags stored on it, e.g. "hs:ahu". */
  tags?: string[];
  // A point:
  valueType?: "numeric" | "boolean" | "enum";
  units?: string;
  precision?: number;
  texts?: [string, string];
  options?: string[];
  writable?: boolean;
  /** What it read when it was recorded. */
  value?: number | boolean | string | null;
  /** Status flags it had: fault, alarm, overridden. */
  status?: string[];
  /** Its history over the recorded hours: one average per interval, null where there was no record. */
  history?: { start: number; interval: number; values: (number | null)[] };
  // A schedule:
  week?: Record<string, { start: string; finish: string; value: unknown; text: string }[]>;
  defaultOutput?: { value: unknown; text: string };
}

export interface RecordedAlarm {
  /** The source's path under slot:/. */
  source: string;
  message: string;
  alarmClass: string;
  priority: number;
  sourceState: string;
  acked: boolean;
  /** How old it was when recorded. */
  ageMs: number;
}

export interface Recording {
  format: typeof SITE_FORMAT;
  version: 1;
  station: string;
  recordedAt: string;
  /** Names were replaced when it was written. */
  scrambled: boolean;
  /** How many hours of history each point holds. */
  hours: number;
  components: RecordedComponent[];
  alarms: RecordedAlarm[];
}

/** Reads a site file back, saying what is wrong with a file that is not one. */
export function parseRecording(text: string, from: string): Recording {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`${from} could not be read as JSON: ${(error as Error).message}`);
  }
  const d = doc as Partial<Recording> | null;
  if (!d || d.format !== SITE_FORMAT || !Array.isArray(d.components)) throw new Error(`${from} is not a recorded site (no "format": "${SITE_FORMAT}"). Make one with: bask record --out site.json`);
  if (d.version !== 1) throw new Error(`${from} is site version ${String(d.version)}; this bask reads version 1.`);
  return { ...d, alarms: d.alarms ?? [] } as Recording;
}

/** The recorded history as a value that repeats: the same hour of the recording at the same point in each cycle. */
export function playback(history: NonNullable<RecordedComponent["history"]>): ((t: number) => number) | undefined {
  const known = history.values.map((value, i) => ({ value, i })).filter((entry): entry is { value: number; i: number } => typeof entry.value === "number");
  if (known.length === 0 || history.interval <= 0) return undefined;
  const count = history.values.length;
  const span = count * history.interval;
  const at = (index: number) => {
    const i = ((index % count) + count) % count;
    const own = history.values[i];
    if (typeof own === "number") return own;
    // A gap takes the nearest record before it, else the first there is.
    return [...known].reverse().find((entry) => entry.i < i)?.value ?? known[0].value;
  };
  return (t: number) => {
    const phase = ((((t - history.start) % span) + span) % span) / history.interval;
    const low = Math.floor(phase);
    return at(low) + (at(low + 1) - at(low)) * (phase - low);
  };
}

/** A demo site built from a recording. */
export function siteFromRecording(recording: Recording): Site {
  const ordOf = (path: string) => `slot:/${path}`;
  return {
    key: "recorded" as SiteName,
    station: recording.station,
    title: `${recording.station}: recorded ${recording.recordedAt.slice(0, 10)}${recording.scrambled ? ", names replaced" : ""}`,
    shows: "As it was when recorded; its histories repeat",
    port: 47910,
    profile: "demo-recorded",
    bounds: [],
    watch: [],
    tree(c) {
      const recorded = new Set(recording.components.map((component) => ordOf(component.path)));
      const ensure = (ord: string): void => {
        if (ord === "slot:/" || c.nodes.has(ord)) return;
        const parent = ord.lastIndexOf("/") <= 5 ? "slot:/" : ord.slice(0, ord.lastIndexOf("/"));
        ensure(parent);
        c.add(parent, ord.slice(ord.lastIndexOf("/") + 1), "baja:Folder", "container");
      };
      for (const item of [...recording.components].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        const ord = ordOf(item.path);
        const existing = c.nodes.get(ord);
        if (existing) {
          Object.assign(existing, { typeSpec: item.type, kind: item.kind, display: item.display ?? existing.display, ...(item.tags ? { tags: item.tags } : {}), ...(item.down ? { down: true } : {}) });
          continue;
        }
        const parent = ord.lastIndexOf("/") <= 5 ? "slot:/" : ord.slice(0, ord.lastIndexOf("/"));
        ensure(parent);
        const extra: Record<string, any> = { display: item.display ?? item.name, ...(item.tags ? { tags: item.tags } : {}), ...(item.down ? { down: true } : {}) };
        if (item.kind === "point") {
          const flags = item.status ?? [];
          Object.assign(extra, {
            vt: item.valueType ?? "numeric", units: item.units, precision: item.precision ?? 1, texts: item.texts ?? ["true", "false"], options: item.options, writable: Boolean(item.writable), fallback: item.value,
            ...(item.history ? { hasHistory: true, sim: playback(item.history) } : {}),
            ...(flags.includes("fault") ? { fault: true } : {}), ...(flags.includes("alarm") ? { alarm: true } : {}), ...(flags.includes("overridden") ? { override: { value: item.value } } : {})
          });
        } else if (item.kind === "schedule") Object.assign(extra, { week: item.week ?? {}, defaultOutput: item.defaultOutput ?? { value: false, text: "false" } });
        else if (/Device$|Network$/.test(item.type)) Object.assign(extra, { actions: ["ping"], props: { enabled: { typeSpec: "baja:Boolean", encoded: "true", writable: true } } });
        c.add(parent, item.name, item.type, item.kind, extra);
      }
      // The demo station starts every site with a BACnet network and a schedules folder; a recording that has neither does not get them.
      for (const ord of ["slot:/Drivers/BacnetNetwork", "slot:/Schedules"]) {
        if (recorded.has(ord) || [...recorded].some((other) => other.startsWith(`${ord}/`))) continue;
        const parent = c.nodes.get(ord.lastIndexOf("/") <= 5 ? "slot:/" : ord.slice(0, ord.lastIndexOf("/")));
        if (parent) parent.children = parent.children.filter((child: string) => child !== ord);
        c.nodes.delete(ord);
      }
    },
    alarms(c) {
      for (const alarm of recording.alarms) c.raise(ordOf(alarm.source), alarm.message, { cls: alarm.alarmClass, priority: alarm.priority, state: alarm.sourceState, ago: alarm.ageMs, acked: alarm.acked });
    },
    history() {},
    files() {},
    agentMoves: () => [],
    alarmMoves: () => [],
    field: () => []
  };
}
