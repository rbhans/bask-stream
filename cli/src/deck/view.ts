// What the screen is drawn from. The component gathers it; drawing reads it and nothing else, so a
// frame is a plain function of this and can be tested and pictured without a terminal.
import type { PointSnapshot } from "@basidekick/baskstream";
import type { Answer } from "./answer.js";
import type { Site, Unit } from "./site.js";

export type Lens = "comfort" | "alarms" | "overrides" | "changes" | "agents";
export const LENSES: Lens[] = ["comfort", "alarms", "overrides", "changes", "agents"];

export type Zoom = { level: "site" } | { level: "unit"; unit: string } | { level: "point"; unit: string; point: string };

/** Something that happened, for the time bar and the lists. */
export interface DeckEvent {
  at: number;
  kind: "change" | "override" | "alarm" | "agent" | "proposal";
  who?: string;
  agent?: boolean;
  ord?: string;
  text: string;
  /** An override: when it was released; absent while it is still in place. */
  until?: number;
  id?: string;
}

export interface UnitMarks {
  /** Alarms that are open, and of those the ones nobody has acknowledged. */
  open: number;
  unacked: number;
  fault: boolean;
  /** Points in hand. */
  overrides: number;
  /** Changes in the time bar's span, by people and by agents, and the newest. */
  people: number;
  agents: number;
  last?: number;
  /** Changes an agent asked for that wait for a person. */
  waiting: number;
}

export interface Ghost {
  id: string;
  from: string;
  agent: boolean;
  lines: { verb: string; what: string; before?: string; after?: string }[];
  check?: string;
  note?: string;
}

export interface ResultLine {
  parts: { text: string; fg?: string; bold?: boolean }[];
}

export interface DeckView {
  width: number;
  height: number;
  station: string;
  user: string;
  site?: Site;
  /** What is being read, while the site is not there yet. */
  loading?: string;
  problem?: string;
  zoom: Zoom;
  /** The unit (at site level) or point (inside a unit) the cursor is on. */
  focus?: string;
  lens: Lens;
  values: Map<string, PointSnapshot>;
  /** Recent numbers for a point, oldest first, for the small charts. */
  series: Map<string, number[]>;
  marks: Map<string, UnitMarks>;
  events: DeckEvent[];
  /** The time bar's span, and the moment looked at (absent: now, live). */
  span: { from: number; to: number };
  at?: number;
  /** Where the keyboard is. */
  keys: "map" | "time" | "prompt";
  prompt: { text: string; cursor: number };
  net: { state: "live" | "reconnecting" | "down"; latency?: number };
  writes: boolean;
  /** The clock for anything that moves, in ms. */
  now: number;
  /** When the screen came up and when the values last arrived fresh, for the tear and the decode. */
  fx: { born: number; decodeFrom?: number; tearFrom?: number; signalFrom?: number; reduced: boolean };
  result?: { title: string; lines: ResultLine[]; scroll: number };
  /** The answer to "why", in place of the map while it is open. */
  answer?: Answer;
  /** When the value being explained turned, marked on the time bar. */
  turnAt?: number;
  ghost?: Ghost;
  toast?: { text: string; tone: "info" | "good" | "warn" | "bad" };
  /** How far the map is scrolled, in rows. */
  scroll: number;
}

/** A place on the screen that answers to the mouse, and what it stands for. */
export interface Hit {
  x: number;
  y: number;
  width: number;
  height: number;
  /** "unit:<ord>", "point:<ord>", "lens:<name>", "time", "prompt", "crumb:<n>". */
  id: string;
}

export const unitOf = (site: Site | undefined, ord: string | undefined): Unit | undefined => (ord ? site?.units.find((u) => u.ord === ord) : undefined);
