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
  /** "note": left by a person or an agent with `note`, not something the station did. */
  kind: "change" | "override" | "alarm" | "agent" | "proposal" | "note";
  who?: string;
  agent?: boolean;
  ord?: string;
  text: string;
  /** An override: when it was released; absent while it is still in place. */
  until?: number;
  id?: string;
  /** An alarm: still in alarm (not back to normal), and whether someone has acknowledged it. */
  active?: boolean;
  acked?: boolean;
}

export interface UnitMarks {
  /** Alarms that are open, and of those the ones nobody has acknowledged. */
  open: number;
  unacked: number;
  /** Of the open ones, those still in alarm: not back to normal. */
  active: number;
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
  /** A line the cursor can sit on: the command enter runs, and the commands other keys run. */
  run?: string;
  keys?: Record<string, string>;
}

export interface Result {
  title: string;
  lines: ResultLine[];
  scroll: number;
  /** The line the cursor is on, when any line can be chosen. */
  cursor?: number;
  /** Keys that work on the whole list, and what the bottom line says about them. */
  keys?: Record<string, string>;
  hint?: [string, string][];
  /** The command that made the list, run again after a change so the list is current. */
  again?: string;
  /** The list this was opened from: esc goes back to it. */
  back?: string;
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
  result?: Result;
  /** The answer to "why", in place of the map while it is open. */
  answer?: Answer;
  /** When the value being explained turned, marked on the time bar. */
  turnAt?: number;
  ghost?: Ghost;
  toast?: { text: string; tone: "info" | "good" | "warn" | "bad" };
  /** How far the map is scrolled, in rows. */
  scroll: number;
  /** What looks wrong in how a unit runs now (the same look `check --only behaviour` takes), by the unit's ORD. */
  off?: Map<string, { kind: string; point: string; message: string }[]>;
  /** The site's meter, when the station has one: what it reads now and today's highest quarter hour. */
  power?: { ord: string; now: number; peak?: number; peakAt?: number };
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
