// Notes a person or an AI agent leaves about a station ("replaced the belt on AHU-2"), and the moment
// the log was last looked at. They are kept on this computer, one file per station, so every login to
// the same station (yours and the agent's) shares them. Nothing here is sent to the station.
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";
import type { LogEvent } from "./log.js";

export interface Note {
  at: number;
  who: string;
  agent?: boolean;
  /** The component it is about, when one was named. */
  ord?: string;
  text: string;
}

/** The station's part of a file name: its host and port. */
export function stationKey(station: string): string {
  let host = station;
  try {
    host = new URL(station).host;
  } catch {
    // not a URL: use it as it is
  }
  return host.replace(/[^\w.-]/g, "_") || "station";
}

const file = (station: string, ext: string) => path.join(configDir(), "notes", `${stationKey(station)}.${ext}`);

export function addNote(station: string, note: Note): void {
  fs.mkdirSync(path.dirname(file(station, "jsonl")), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file(station, "jsonl"), `${JSON.stringify(note)}\n`, { mode: 0o600 });
}

export function readNotes(station: string): Note[] {
  let text = "";
  try {
    text = fs.readFileSync(file(station, "jsonl"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const note = JSON.parse(line) as Note;
      return typeof note.at === "number" && typeof note.text === "string" ? [note] : [];
    } catch {
      return [];
    }
  });
}

/** Notes as log events, for the time asked for and (when given) the branch. */
export function noteEvents(station: string, options: { since: number; until?: number; under?: string }): LogEvent[] {
  const under = options.under && options.under !== "slot:/" ? options.under.replace(/\/+$/, "") : undefined;
  return readNotes(station)
    .filter((n) => n.at >= options.since && n.at <= (options.until ?? Infinity) && (!under || (n.ord !== undefined && (n.ord === under || n.ord.startsWith(`${under}/`)))))
    .map((n): LogEvent => ({ at: n.at, kind: "note", who: n.who, ...(n.agent ? { agent: true } : {}), ...(n.ord ? { ord: n.ord } : {}), text: n.ord ? `${n.text}  (${n.ord.replace(/^slot:\/?/, "").split("/").slice(-2).join("/")})` : n.text, source: "note" }));
}

/** When this station's log was last looked at with `bask log --new`. */
export function lastLooked(station: string): number | undefined {
  try {
    const at = Number(fs.readFileSync(file(station, "seen"), "utf8"));
    return Number.isFinite(at) && at > 0 ? at : undefined;
  } catch {
    return undefined;
  }
}

export function markLooked(station: string, at = Date.now()): void {
  fs.mkdirSync(path.dirname(file(station, "seen")), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(station, "seen"), String(at), { mode: 0o600 });
}
