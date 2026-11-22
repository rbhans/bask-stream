// bask test: point-to-point and functional checkout from a plain document (docs/CHECKOUT.md).
//
// The document is markdown a technician can read and write: each "## " heading is a step, and the
// list lines under it command a point, wait, and say what the feedback has to show. Run without
// permission to change the station it is a rehearsal: every point is looked up, each commanded point
// is checked for being writable, and what would be commanded is listed. Run for real, a command is
// an operator override with a time limit (so the station lets go by itself if bask dies), and every
// point a step overrode is released when the step ends, however it ends.
import chalk from "chalk";
import { BaskStreamError, ChangeProposedError, toSlotOrd, type BaskStreamClient, type Json, type PointSnapshot, type Watch } from "./core.js";
import { fmtPoint, fmtTime, parseValue, place, sparkline } from "./format.js";

// ---- The document ---------------------------------------------------------------------------------

export type CheckoutValue = boolean | number | string;

/** What an `expect` line asks of a reading. */
export type Comparison =
  | { kind: "is"; value: CheckoutValue; text: string }
  | { kind: "isNot"; value: CheckoutValue; text: string }
  | { kind: "above"; value: number }
  | { kind: "below"; value: number }
  /** within `tolerance` of `value` */
  | { kind: "near"; value: number; tolerance: number }
  /** at least `by` above (or below) where it was noted, or where it stood when the check began */
  | { kind: "rises"; by: number }
  | { kind: "falls"; by: number };

interface LineBase {
  /** The line of the document it came from. */
  line: number;
  /** The line as written, with `{value}` filled in. */
  text: string;
  /** Inside a `for`: the value this copy of the line was written out for. */
  loop?: string;
}
interface PointRef {
  /** The point's slot ORD. */
  point: string;
  /** The point as the document names it. */
  name: string;
}
export type CheckoutLine =
  | (LineBase & PointRef & { kind: "set"; value: CheckoutValue; valueText: string; /** `for <duration>`: the station lets go after this long. */ forMs?: number })
  | (LineBase & PointRef & { kind: "release" })
  | (LineBase & PointRef & { kind: "expect"; comparison: Comparison; /** How long to keep looking; 0 looks once. */ withinMs: number })
  | (LineBase & { kind: "wait"; ms: number })
  | (LineBase & PointRef & { kind: "note" });

export interface CheckoutStep {
  title: string;
  line: number;
  /** Text under the heading that is not a list line, as written. */
  text: string[];
  /** What to do, in order. A `for` is written out: one copy of its lines per value. */
  lines: CheckoutLine[];
}

export interface Checkout {
  title: string;
  /** Where the document came from (a file name), for messages and the report. */
  from: string;
  /** From a `station:` line above the first step: the station this document is for. A run on another station does not start. */
  station?: string;
  stationLine?: number;
  /** Text before the first step, as written. */
  text: string[];
  steps: CheckoutStep[];
  /** Every point the document names, once each. */
  points: string[];
}

/** The document could not be read. Every problem is listed, each with its line. */
export class CheckoutParseError extends Error {
  constructor(readonly from: string, readonly problems: { line: number; message: string }[]) {
    super(problems.map((p) => `${from}:${p.line}: ${p.message}`).join("\n"));
    this.name = "CheckoutParseError";
  }
}

const VERBS = ["set", "release", "expect", "wait", "note", "for"];
const UNIT_MS: Record<string, number> = {
  ms: 1, msec: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000
};
/** Words of the grammar: never taken for a point name or a unit. */
const WORDS = new Set(["is", "not", "to", "of", "for", "within", "above", "over", "below", "under", "rises", "rise", "falls", "fall", "by", "at", "least", "equals", "=", "==", "!=", ">", "<"]);
const NUMBER = /^[-+]?\d+(?:\.\d+)?$/;
/** The place a `for` puts each of its values. */
const VALUE = /\{\s*value\s*\}/i;

interface Token { text: string; quoted: boolean }

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(/"([^"]*)"|“([^”]*)”|'([^']*)'|(\S+)/g)) {
    const quoted = m[1] ?? m[2] ?? m[3];
    tokens.push(quoted === undefined ? { text: m[4], quoted: false } : { text: quoted, quoted: true });
  }
  return tokens;
}

const word = (token: Token | undefined) => (token && !token.quoted ? token.text.toLowerCase() : "");

/** "30s", "2m", "1.5h", or a number and a unit as two words ("5 minutes"). */
function takeDuration(tokens: Token[], at: number): { ms: number; next: number } {
  const first = tokens[at]?.text ?? "";
  const joined = /^(\d+(?:\.\d+)?)([a-zA-Z]+)$/.exec(first);
  if (joined && UNIT_MS[joined[2].toLowerCase()]) return { ms: Math.round(Number(joined[1]) * UNIT_MS[joined[2].toLowerCase()]), next: at + 1 };
  if (/^\d+(?:\.\d+)?$/.test(first)) {
    const unit = UNIT_MS[word(tokens[at + 1])];
    if (unit) return { ms: Math.round(Number(first) * unit), next: at + 2 };
    throw new Error(`"${first}" needs a unit of time: write ${first}s, ${first}m or ${first}h.`);
  }
  throw new Error(first ? `"${first}" is not a length of time. Write it like 30s, 2m or 1h.` : "A length of time is missing. Write it like 30s, 2m or 1h.");
}

/** A number, with its unit attached ("50%", "2°F") or as the next word ("2 °F"). The unit is not used. */
function takeNumber(tokens: Token[], at: number, what: string): { value: number; next: number } {
  const text = tokens[at]?.text;
  const m = /^([-+]?\d+(?:\.\d+)?)(\D\S*)?$/.exec(text ?? "");
  if (!m || tokens[at].quoted) throw new Error(text === undefined ? `"${what}" needs a number after it.` : `"${what}" needs a number, and "${text}" is not one.`);
  return { value: Number(m[1]), next: skipUnit(tokens, at + 1, Boolean(m[2])) };
}

/** Steps over one word after a number when it is a unit: not a word of the grammar, and not a number. */
function skipUnit(tokens: Token[], at: number, hadUnit: boolean): number {
  const next = tokens[at];
  if (hadUnit || !next || next.quoted || WORDS.has(next.text.toLowerCase()) || /^[-+]?\d/.test(next.text)) return at;
  return at + 1;
}

/** A value to command or to compare with: on/off/true/false, a number (a "%" or "°…" on it is dropped), else the text. */
function takeValue(tokens: Token[], at: number, what: string): { value: CheckoutValue; text: string; next: number } {
  const token = tokens[at];
  if (!token) throw new Error(`"${what}" needs a value after it.`);
  if (token.quoted) return { value: token.text, text: token.text, next: at + 1 };
  const unit = /^([-+]?\d+(?:\.\d+)?)(%|°\S*)$/.exec(token.text);
  const value = unit ? Number(unit[1]) : parseValue(token.text);
  return { value, text: unit ? unit[1] : token.text, next: typeof value === "number" ? skipUnit(tokens, at + 1, Boolean(unit)) : at + 1 };
}

function takePoint(tokens: Token[], at: number, verb: string, equipment: string | undefined): PointRef {
  const token = tokens[at];
  if (!token || (!token.quoted && WORDS.has(token.text.toLowerCase()))) throw new Error(`"${verb}" needs a point name after it.`);
  const raw = token.text;
  if (/(^|\|)slot:\//.test(raw)) {
    const point = toSlotOrd(raw).replace(/\/+$/, "");
    return { point, name: place(point) };
  }
  if (/^[a-z][a-z0-9]*:/i.test(raw)) throw new Error(`"${raw}" is not a point bask can test. Use a point name under the equipment, or a full slot:/ ORD.`);
  if (NUMBER.test(raw)) throw new Error(`"${verb}" needs a point name after it, and "${raw}" is a number.`);
  if (!equipment) throw new Error(`"${raw}" needs an "equipment:" line above it, or write the point's full slot:/ ORD.`);
  return { point: `${equipment}/${raw.replace(/^\/+|\/+$/g, "")}`, name: raw };
}

function nothingLeft(tokens: Token[], at: number): void {
  if (at < tokens.length) throw new Error(`Did not understand "${tokens.slice(at).map((t) => t.text).join(" ")}" at the end of the line.`);
}

function parseComparison(tokens: Token[], start: number): { comparison: Comparison; next: number } {
  let at = start;
  let said = "";
  if (["is", "=", "==", "equals"].includes(word(tokens[at]))) {
    said = tokens[at].text;
    at += 1;
  }
  const key = word(tokens[at]);
  if (key === "!=" || (said && key === "not")) {
    const v = takeValue(tokens, at + 1, said ? `${said} not` : "!=");
    return { comparison: { kind: "isNot", value: v.value, text: v.text }, next: v.next };
  }
  if (key === "above" || key === "over" || key === ">" || key === "below" || key === "under" || key === "<") {
    const n = takeNumber(tokens, at + 1, key);
    return { comparison: { kind: key === "above" || key === "over" || key === ">" ? "above" : "below", value: n.value }, next: n.next };
  }
  if (key === "within") {
    const tolerance = takeNumber(tokens, at + 1, "within");
    if (word(tokens[tolerance.next]) !== "of") throw new Error(`A check with "within" is written "within 3 of 50". To give a time limit, put the check first: "is on within 30s".`);
    const target = takeNumber(tokens, tolerance.next + 1, "of");
    return { comparison: { kind: "near", value: target.value, tolerance: Math.abs(tolerance.value) }, next: target.next };
  }
  if (["rises", "rise", "falls", "fall"].includes(key)) {
    let from = at + 1;
    if (word(tokens[from]) === "by") from += 1;
    if (word(tokens[from]) === "at" && word(tokens[from + 1]) === "least") from += 2;
    const n = takeNumber(tokens, from, `${key} at least`);
    return { comparison: { kind: key.startsWith("rise") ? "rises" : "falls", by: Math.abs(n.value) }, next: n.next };
  }
  if (said) {
    const v = takeValue(tokens, at, said);
    return { comparison: { kind: "is", value: v.value, text: v.text }, next: v.next };
  }
  throw new Error(`"expect" needs a check after the point: is, is not, above, below, within N of V, rises at least N or falls at least N.`);
}

/** One list line (without its bullet) as a step line. Throws with what is wrong; the caller adds the line number. */
function parseLine(body: string, line: number, equipment: string | undefined, loop?: string): CheckoutLine {
  const tokens = tokenize(body);
  const verb = word(tokens[0]);
  const base = { line, text: body, ...(loop === undefined ? {} : { loop }) };
  switch (verb) {
    case "set": {
      const ref = takePoint(tokens, 1, "set", equipment);
      let at = 2;
      if (word(tokens[at]) === "to" || word(tokens[at]) === "=") at += 1;
      if (word(tokens[at]) === "for") throw new Error(`"set" needs a value before "for".`);
      const v = takeValue(tokens, at, `set ${ref.name}`);
      at = v.next;
      let forMs: number | undefined;
      if (word(tokens[at]) === "for") {
        const d = takeDuration(tokens, at + 1);
        if (d.ms < 1000) throw new Error("An override lasts a second at least.");
        forMs = d.ms;
        at = d.next;
      }
      nothingLeft(tokens, at);
      return { ...base, ...ref, kind: "set", value: v.value, valueText: v.text, ...(forMs === undefined ? {} : { forMs }) };
    }
    case "release": {
      const ref = takePoint(tokens, 1, "release", equipment);
      nothingLeft(tokens, 2);
      return { ...base, ...ref, kind: "release" };
    }
    case "note": {
      const ref = takePoint(tokens, 1, "note", equipment);
      nothingLeft(tokens, 2);
      return { ...base, ...ref, kind: "note" };
    }
    case "wait": {
      const d = takeDuration(tokens, word(tokens[1]) === "for" ? 2 : 1);
      nothingLeft(tokens, d.next);
      return { ...base, kind: "wait", ms: d.ms };
    }
    case "expect": {
      const ref = takePoint(tokens, 1, "expect", equipment);
      const c = parseComparison(tokens, 2);
      let at = c.next;
      let withinMs = 0;
      if (word(tokens[at]) === "within") {
        const d = takeDuration(tokens, at + 1);
        withinMs = d.ms;
        at = d.next;
      }
      nothingLeft(tokens, at);
      return { ...base, ...ref, kind: "expect", comparison: c.comparison, withinMs };
    }
    default:
      throw new Error(`Cannot read "${body}". A step line starts with set, release, expect, wait, note or for.`);
  }
}

/** Markdown that changes nothing: code ticks, bold marks and a full stop at the end. */
const plain = (text: string) => text.replace(/`/g, "").replace(/\*\*/g, "").trim().replace(/[.;,]$/, "").trim();

const fileTitle = (from: string) => from.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "Checkout";

function equipmentOrd(text: string): string {
  const ord = toSlotOrd(plain(text).replace(/^["']|["']$/g, ""));
  return (ord.startsWith("slot:") ? ord : `slot:/${ord.replace(/^\/+/, "")}`).replace(/\/+$/, "");
}

/**
 * Reads a checkout document. `from` names it (a file name) in messages and in the report. Throws
 * CheckoutParseError listing every line that could not be read, so nothing is commanded from a
 * document that is half understood.
 */
export function parseCheckout(text: string, from: string): Checkout {
  const problems: { line: number; message: string }[] = [];
  const problem = (line: number, message: string) => {
    if (!problems.some((p) => p.line === line && p.message === message)) problems.push({ line, message });
  };
  const checkout: Checkout = { title: "", from, text: [], steps: [], points: [] };
  let equipment: string | undefined;
  let step: CheckoutStep | undefined;
  let fenced = false;
  let loop: { line: number; indent: number; values: string[]; lines: { line: number; body: string }[]; equipment: string | undefined } | undefined;

  const carry = (line: string) => (step ? step.text : checkout.text).push(line);
  const add = (body: string, line: number, value?: string) => {
    try {
      const filled = value === undefined ? body : body.replace(new RegExp(VALUE, "gi"), () => value);
      if (value === undefined && VALUE.test(body)) throw new Error(`{value} is only filled in on the lines under a "for".`);
      step!.lines.push(parseLine(filled, line, loop && value !== undefined ? loop.equipment : equipment, value));
    } catch (error) {
      problem(line, (error as Error).message);
    }
  };
  const endLoop = () => {
    if (!loop) return;
    if (loop.lines.length === 0) problem(loop.line, `This "for" has nothing under it. Indent the lines it repeats beneath it.`);
    for (const value of loop.values) for (const inner of loop.lines) add(inner.body, inner.line, value);
    loop = undefined;
  };

  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  rows.forEach((row, index) => {
    const line = index + 1;
    if (/^\s*(```|~~~)/.test(row)) {
      endLoop();
      fenced = !fenced;
      return void carry(row);
    }
    if (fenced) return void carry(row);
    if (row.trim() === "") return void carry("");

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(row);
    if (heading) {
      endLoop();
      if (heading[1].length === 1 && !checkout.title && checkout.steps.length === 0) return void (checkout.title = plain(heading[2]));
      if (heading[1].length === 2) {
        step = { title: plain(heading[2]) || `Step ${checkout.steps.length + 1}`, line, text: [], lines: [] };
        return void checkout.steps.push(step);
      }
      return void carry(row);
    }

    const bullet = /^\s*([-*_])(\s*\1){2,}\s*$/.test(row) ? null : /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(row);
    if (bullet) {
      const indent = bullet[1].replace(/\t/g, "    ").length;
      const body = plain(bullet[2]);
      if (loop && indent > loop.indent) {
        if (/^for\b/i.test(body)) return void problem(line, `A "for" inside a "for" is not supported. Write the inner lines out.`);
        return void loop.lines.push({ line, body });
      }
      endLoop();
      if (!step) {
        try {
          if (!/^for\b/i.test(body)) parseLine(body, line, equipment);
        } catch {
          return void carry(row);
        }
        return void problem(line, `This line is not under a step, so it would not run. Start each step with a "## " heading.`);
      }
      const each = /^for\s+(?:each\s+(?:of\s+)?)?(.*?)\s*:?$/i.exec(body);
      if (each) {
        const list = each[1].includes(",") ? each[1].split(/\s*,\s*|\s+and\s+/) : each[1].split(/\s+/);
        const values = list.map((v) => v.trim().replace(/^["'“]|["'”]$/g, "")).filter(Boolean);
        if (values.length === 0) return void problem(line, `"for" needs its values: "for 25, 50, 75, 100:".`);
        loop = { line, indent, values, lines: [], equipment };
        return;
      }
      return void add(body, line);
    }

    endLoop();
    const setting = /^\s*(equipment|station)\s*[:=]\s*(.+?)\s*$/i.exec(row);
    if (setting && setting[1].toLowerCase() === "equipment") return void (equipment = equipmentOrd(setting[2]));
    if (setting && !step) return void Object.assign(checkout, { station: plain(setting[2]).replace(/^["']|["']$/g, ""), stationLine: line });
    // A step line written without its dash would be carried into the report and never run.
    if (step && VERBS.includes(word(tokenize(row)[0])) && !VALUE.test(row)) {
      try {
        parseLine(plain(row), line, equipment);
        return void problem(line, `This reads as a step line but has no "- " in front, so it would not run. Start it with "- ".`);
      } catch {
        // Ordinary text that happens to start with one of the words.
      }
    }
    carry(row);
  });
  endLoop();

  if (!checkout.title) checkout.title = fileTitle(from);
  if (checkout.steps.length === 0) problem(1, `No steps found. Start each step with a "## " heading and list what to do under it.`);
  for (const s of checkout.steps) if (s.lines.length === 0 && !problems.some((p) => p.line > s.line)) problem(s.line, `Step "${s.title}" has nothing to do under it. List its lines with "- ".`);
  if (problems.length) throw new CheckoutParseError(from, problems.sort((a, b) => a.line - b.line));

  const trim = (lines: string[]) => {
    const kept = lines.filter((l, i) => l.trim() !== "" || (i > 0 && lines[i - 1].trim() !== ""));
    while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
    return kept;
  };
  checkout.text = trim(checkout.text);
  for (const s of checkout.steps) s.text = trim(s.text);
  checkout.points = [...new Set(checkout.steps.flatMap((s) => s.lines.flatMap((l) => ("point" in l ? [l.point] : []))))];
  return checkout;
}

// ---- What the lines mean ---------------------------------------------------------------------------

const DEFAULT_HOLD_MS = 15 * 60000;
const HOLD_MARGIN_MS = 2 * 60000;
/** Time allowed for a line that does not wait: the command and its reply. */
const LINE_ALLOWANCE_MS = 5000;

/**
 * How long an override in this step is asked to last, in seconds: 15 minutes, or longer when the
 * step's own waits add up to more (those waits plus two minutes). The station lets go by itself
 * after it, which is what covers a bask that died before it could release.
 */
export function holdSeconds(step: CheckoutStep): number {
  const waits = step.lines.reduce((ms, l) => ms + LINE_ALLOWANCE_MS + (l.kind === "wait" ? l.ms : l.kind === "expect" ? l.withinMs : 0), 0);
  return Math.ceil(Math.max(DEFAULT_HOLD_MS, waits + HOLD_MARGIN_MS) / 1000);
}

const trimNumber = (n: number) => String(Math.round(n * 1000) / 1000);

/** A length of time for people: 0.4s, 12s, 2m, 1m 30s, 1h 5m. */
export function span(ms: number): string {
  if (ms < 10000) return `${trimNumber(Math.round(ms / 100) / 10)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
  const m = Math.round(s / 60);
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}

function expectedText(c: Comparison, from?: number): string {
  if (c.kind === "is" || c.kind === "isNot") return `${c.kind === "is" ? "is" : "is not"} ${c.text}`;
  if (c.kind === "above" || c.kind === "below") return `${c.kind} ${trimNumber(c.value)}`;
  if (c.kind === "near") return `within ${trimNumber(c.tolerance)} of ${trimNumber(c.value)}`;
  return `${c.kind} at least ${trimNumber(c.by)}${from === undefined ? "" : ` from ${trimNumber(from)}`}`;
}

/** The check as it reads after a point's name: "is on", "is above 50", "rises at least 2". */
const checkText = (c: Comparison) => (c.kind === "above" || c.kind === "below" || c.kind === "near" ? `is ${expectedText(c)}` : expectedText(c));

/** The check as what was hoped for: "be on", "be above 50", "rise at least 2 from 55". */
function toBe(expected: string): string {
  if (expected.startsWith("is ")) return `be ${expected.slice(3)}`;
  if (/^(above|below|within) /.test(expected)) return `be ${expected}`;
  return expected.replace(/^rises/, "rise").replace(/^falls/, "fall");
}

/** Status words that mean the value on show proves nothing: it is old, missing, or the device is not answering. */
const UNPROVEN = ["down", "fault", "stale", "null", "disabled", "unsubscribed"];

function statusWords(snapshot: PointSnapshot): string[] {
  const words = new Set<string>();
  if (typeof snapshot.state === "string") words.add(snapshot.state);
  const braces = /\{([^}]*)\}/.exec(String(snapshot.status ?? ""));
  for (const w of braces ? braces[1].split(",") : []) words.add(w.trim());
  return [...words].filter(Boolean);
}

/** Why a reading cannot prove anything, or undefined when it can. */
function unproven(snapshot: PointSnapshot): string | undefined {
  if (snapshot.code) return `could not be read: ${String(snapshot.message ?? snapshot.code)}`;
  return statusWords(snapshot).find((w) => UNPROVEN.includes(w));
}

const isOverridden = (snapshot: PointSnapshot) => statusWords(snapshot).includes("overridden");

/** A reading as a person reads it: the value with its units, and its status when that is in the way. */
function shown(snapshot: PointSnapshot): string {
  if (snapshot.code) return `could not be read (${snapshot.code})`;
  const why = unproven(snapshot);
  return why ? `${fmtPoint(snapshot)} (${why})` : fmtPoint(snapshot);
}

const numberOf = (snapshot: PointSnapshot): number | undefined => (typeof snapshot.value === "number" && Number.isFinite(snapshot.value) ? snapshot.value : undefined);

/** A reading as a number for the trend: on and off as 1 and 0, an enum as its ordinal. */
function trendValue(snapshot: PointSnapshot): number | undefined {
  if (snapshot.code) return undefined;
  if (typeof snapshot.value === "boolean") return snapshot.value ? 1 : 0;
  return numberOf(snapshot) ?? (typeof snapshot.enumOrdinal === "number" ? snapshot.enumOrdinal : undefined);
}

/** Half of the last digit the point shows: "is 55" passes on a reading shown as 55.0. */
function roundingOf(snapshot: PointSnapshot): number {
  const precision = Number((snapshot.facets as Json | undefined)?.precision);
  return Number.isFinite(precision) && precision >= 0 && precision <= 10 ? 0.5 * 10 ** -precision : 1e-6;
}

function same(value: CheckoutValue, text: string, snapshot: PointSnapshot): boolean {
  const have = snapshot.value;
  if (typeof value === "boolean") {
    if (typeof have === "boolean") return have === value;
    if (typeof have === "number") return (have !== 0) === value;
  }
  if (typeof value === "number") {
    if (typeof have === "number") return Math.abs(have - value) <= roundingOf(snapshot);
    if (typeof snapshot.enumOrdinal === "number") return snapshot.enumOrdinal === value;
    if (typeof have === "boolean") return value === 1 ? have : value === 0 ? !have : false;
  }
  const want = text.trim().toLowerCase();
  return [have, snapshot.displayValue, snapshot.enumTag, snapshot.enumDisplay].some((v) => typeof v === "string" && v.trim().toLowerCase() === want);
}

/** Whether a reading meets the check. A reading that proves nothing never does. `from` is where a rise or fall is counted from. */
function meets(c: Comparison, snapshot: PointSnapshot, from?: number): boolean {
  if (unproven(snapshot)) return false;
  if (c.kind === "is") return same(c.value, c.text, snapshot);
  if (c.kind === "isNot") return !same(c.value, c.text, snapshot);
  const n = numberOf(snapshot);
  if (n === undefined) return false;
  switch (c.kind) {
    case "above": return n > c.value;
    case "below": return n < c.value;
    case "near": return Math.abs(n - c.value) <= c.tolerance;
    case "rises": return from !== undefined && n - from >= c.by;
    default: return from !== undefined && from - n >= c.by;
  }
}

const needsNumber = (c: Comparison) => c.kind !== "is" && c.kind !== "isNot";

// ---- Rehearsal ------------------------------------------------------------------------------------

export interface CheckoutProblem {
  /** An error means a run would not start. A warning is something to know before running. */
  severity: "error" | "warning";
  /** The document line it is about, when it is about one. */
  line?: number;
  point?: string;
  message: string;
}

/** One command a run would send, in the order it would send them. */
export interface PlannedCommand {
  /** Index of the step in the document. */
  step: number;
  /** The document line that asks for it; for a release at the end of a step, the step's heading. */
  line: number;
  point: string;
  name: string;
  /** "override" holds the point at a value; "auto" lets it go. */
  action: "override" | "auto";
  value?: CheckoutValue;
  valueText?: string;
  /** How long the station is asked to hold an override before letting go by itself. */
  durationSec?: number;
  /** "set" and "release" are lines of the document; "step end" is the release every step makes. */
  why: "set" | "release" | "step end";
}

export interface RehearsalLine {
  kind: CheckoutLine["kind"];
  line: number;
  text: string;
  point?: string;
  name?: string;
  /** What a run would do for this line, in words. */
  does: string;
  /** What the point reads now. */
  now?: string;
}

export interface RehearsalStep {
  index: number;
  title: string;
  line: number;
  /** How long an override in this step is asked to last, in seconds. */
  holdSec: number;
  lines: RehearsalLine[];
  /** Points released when the step ends, by ORD. */
  releases: string[];
}

export interface Rehearsal {
  kind: "rehearsal";
  title: string;
  from: string;
  station: string;
  user: string;
  at: number;
  /** No errors: a run would start. */
  ok: boolean;
  steps: RehearsalStep[];
  /** Exactly what a run would command, in order, releases included. */
  commands: PlannedCommand[];
  problems: CheckoutProblem[];
}

const stationOf = (client: BaskStreamClient) => String(client.capabilities.station ?? client.http.url.host);
const userOf = (client: BaskStreamClient) => String(client.capabilities.authenticatedUser ?? "");

function apiAtLeast(client: BaskStreamClient, major: number, minor: number): boolean {
  const [a, b] = String(client.capabilities.apiVersion ?? "0.0").split(".").map(Number);
  return a > major || (a === major && (b || 0) >= minor);
}

async function readAll(client: BaskStreamClient, points: string[], fresh: boolean): Promise<Map<string, PointSnapshot>> {
  const found = new Map<string, PointSnapshot>();
  const most = Math.max(1, Number((client.capabilities.limits as Json | undefined)?.maxPointSnapshotPoints) || 500);
  for (let at = 0; at < points.length; at += most) {
    const part = points.slice(at, at + most);
    // `fresh` has the station poll points nothing is watching; stations before API 1.9 do not know it.
    const snapshots = await client.read(part, fresh && apiAtLeast(client, 1, 9) ? { fresh: true } : undefined);
    part.forEach((point, i) => found.set(point, snapshots?.[i] ?? { point, ok: false, code: "read_failed", message: "The station sent no reading for it." }));
  }
  return found;
}

const linesOf = (checkout: Checkout, point: string) => [...new Set(checkout.steps.flatMap((s) => s.lines.filter((l) => "point" in l && l.point === point).map((l) => l.line)))];

function notReadable(name: string, snapshot: PointSnapshot): string {
  if (snapshot.code === "invalid_point") return `${name} was not found on the station. Check the name and the "equipment:" line.`;
  if (snapshot.code === "forbidden_point") return `${name} cannot be read with this login.`;
  return `${name} could not be read: ${String(snapshot.message ?? snapshot.code)}`;
}

/** What a writable point of this kind takes, when the value on the line is not one. */
function wrongKind(kind: unknown, value: CheckoutValue, text: string): string | undefined {
  const k = String(kind ?? "").toLowerCase();
  if (/^(num|double|float|int)/.test(k) && typeof value !== "number") return `takes a number, and "${text}" is not one`;
  if (/^bool/.test(k) && typeof value !== "boolean" && value !== 0 && value !== 1) return `takes on or off, and "${text}" is neither`;
  return undefined;
}

/**
 * Looks at the station without commanding anything: every point the document names is read, every
 * point it would command is checked for being writable (describe_write), and what a run would send
 * is listed in order. `problems` holds everything found; with an error in it a run does not start.
 */
export async function rehearseCheckout(client: BaskStreamClient, checkout: Checkout): Promise<Rehearsal> {
  const problems: CheckoutProblem[] = [];
  const station = stationOf(client);
  if (checkout.station && checkout.station.toLowerCase() !== station.toLowerCase()) {
    problems.push({ severity: "error", line: checkout.stationLine, message: `This document is for ${checkout.station}; the station connected is ${station}. Nothing is commanded on a different station.` });
  }
  if (client.capabilities.writesEnabled === false) problems.push({ severity: "error", message: "Changes are turned off on this station (writesEnabled on BASkStreamService), so nothing can be commanded." });

  const lineOf = (point: string) => linesOf(checkout, point)[0];
  const nameOf = new Map<string, string>();
  for (const s of checkout.steps) for (const l of s.lines) if ("point" in l && !nameOf.has(l.point)) nameOf.set(l.point, l.name);

  let readings = new Map<string, PointSnapshot>();
  try {
    readings = await readAll(client, checkout.points, true);
  } catch (error) {
    problems.push({ severity: "error", message: `The points could not be read: ${(error as Error).message}` });
  }
  for (const [point, snapshot] of readings) {
    if (snapshot.code) problems.push({ severity: "error", line: lineOf(point), point, message: notReadable(nameOf.get(point) ?? point, snapshot) });
  }

  const commanded = [...new Set(checkout.steps.flatMap((s) => s.lines.flatMap((l) => (l.kind === "set" || l.kind === "release" ? [l.point] : []))))];
  const writable = new Map<string, Json>();
  const known = commanded.filter((point) => !readings.get(point)?.code);
  if (known.length) {
    try {
      (((await client.describeWrite(known)).points as Json[] | undefined) ?? []).forEach((entry, i) => writable.set(typeof entry.point === "string" ? toSlotOrd(entry.point) : known[i], entry));
    } catch (error) {
      const code = error instanceof BaskStreamError ? error.code : "";
      problems.push(code === "unsupported_op"
        ? { severity: "warning", message: "This station cannot say which points are writable before a command (it has no describe_write), so that is not checked here." }
        : { severity: "error", message: `The station could not say which points are writable: ${(error as Error).message}` });
    }
  }
  for (const point of known) {
    const entry = writable.get(point);
    if (!entry) continue;
    const name = nameOf.get(point) ?? point;
    const actions = Array.isArray(entry.actions) ? (entry.actions as unknown[]).map(String) : undefined;
    if (entry.code || entry.writable !== true) {
      problems.push({ severity: "error", line: lineOf(point), point, message: entry.code && entry.code !== "not_writable" ? `${name} cannot be commanded: ${String(entry.message ?? entry.code)}` : `${name} cannot be commanded: it is not a writable point.` });
      continue;
    }
    if (actions && !(actions.includes("override") && actions.includes("auto"))) {
      problems.push({ severity: "error", line: lineOf(point), point, message: `${name} cannot be overridden and released with this login (the station allows: ${actions.join(", ") || "nothing"}).` });
    }
    if (entry.supportsDuration === false) {
      problems.push({ severity: "warning", line: lineOf(point), point, message: `${name} does not take a time limit on an override. If bask stops before the step ends, it stays overridden until someone releases it.` });
    }
    const now = readings.get(point);
    if (now && isOverridden(now)) {
      problems.push({ severity: "warning", line: lineOf(point), point, message: `${name} is overridden now (${fmtPoint(now)}). The test replaces that override and releases the point when the step ends; it does not put the old override back.` });
    }
  }

  const agents = client.capabilities.agents as Json | undefined;
  const sends = checkout.steps.reduce((n, s) => n + s.lines.filter((l) => l.kind === "set" || l.kind === "release").length + new Set(s.lines.flatMap((l) => (l.kind === "set" ? [l.point] : []))).size, 0);
  if (agents?.isAgent && sends > 0) {
    const mode = typeof agents.pointWrites === "string" ? agents.pointWrites : agents.approvalRequired ? "ask" : "allow";
    if (mode === "refuse") problems.push({ severity: "error", message: "This login is an AI agent, and this station refuses an agent's point commands (agentPointWrites on BASkStreamService)." });
    else if (mode === "ask") problems.push({ severity: "warning", message: "This login is an AI agent, and this station keeps an agent's point commands for a person to approve. A run stops at its first command." });
    const perMinute = Number(agents.maxChangesPerMinute ?? 0);
    if (mode === "allow" && perMinute > 0 && sends > perMinute) problems.push({ severity: "warning", message: `This station lets an agent make ${perMinute} changes a minute, and this test sends ${sends} commands: it waits between them.` });
  }

  const commands: PlannedCommand[] = [];
  const steps = checkout.steps.map((step, index): RehearsalStep => {
    const holdSec = holdSeconds(step);
    const held: string[] = [];
    const lines = step.lines.map((l): RehearsalLine => {
      const reading = "point" in l ? readings.get(l.point) : undefined;
      const now = reading && !reading.code ? shown(reading) : undefined;
      const row = { kind: l.kind, line: l.line, text: l.text, ...("point" in l ? { point: l.point, name: l.name } : {}), ...(now === undefined ? {} : { now }) };
      switch (l.kind) {
        case "set": {
          const durationSec = l.forMs === undefined ? holdSec : Math.ceil(l.forMs / 1000);
          commands.push({ step: index, line: l.line, point: l.point, name: l.name, action: "override", value: l.value, valueText: l.valueText, durationSec, why: "set" });
          if (!held.includes(l.point)) held.push(l.point);
          const wrong = writable.get(l.point)?.writable === true ? wrongKind(writable.get(l.point)?.valueKind, l.value, l.valueText) : undefined;
          if (wrong) problems.push({ severity: "error", line: l.line, point: l.point, message: `${l.name} ${wrong}.` });
          return { ...row, does: `override ${l.name} to ${l.valueText}, held for ${l.forMs === undefined ? "up to " : ""}${span(durationSec * 1000)}` };
        }
        case "release":
          commands.push({ step: index, line: l.line, point: l.point, name: l.name, action: "auto", why: "release" });
          if (held.includes(l.point)) held.splice(held.indexOf(l.point), 1);
          return { ...row, does: `release ${l.name}` };
        case "expect":
          if (needsNumber(l.comparison) && reading && !reading.code && reading.value !== null && reading.value !== undefined && numberOf(reading) === undefined) {
            problems.push({ severity: "error", line: l.line, point: l.point, message: `${l.name} reads ${fmtPoint(reading)}, which is not a number, so "${checkText(l.comparison)}" cannot be checked.` });
          }
          return { ...row, does: `check that ${l.name} ${checkText(l.comparison)}${l.withinMs ? `, looking for up to ${span(l.withinMs)}` : ", looking once"}` };
        case "wait":
          return { ...row, does: `wait ${span(l.ms)}` };
        default:
          return { ...row, does: `write down what ${l.name} reads` };
      }
    });
    for (const point of [...held].reverse()) commands.push({ step: index, line: step.line, point, name: nameOf.get(point) ?? point, action: "auto", why: "step end" });
    return { index, title: step.title, line: step.line, holdSec, lines, releases: [...held].reverse() };
  });

  problems.sort((a, b) => (a.severity === b.severity ? (a.line ?? 0) - (b.line ?? 0) : a.severity === "error" ? -1 : 1));
  return { kind: "rehearsal", title: checkout.title, from: checkout.from, station, user: userOf(client), at: Date.now(), ok: !problems.some((p) => p.severity === "error"), steps, commands, problems };
}

// ---- The run --------------------------------------------------------------------------------------

export type LineStatus = "done" | "pass" | "fail" | "error" | "stopped" | "not-run";
export type StepStatus = "pass" | "fail" | "error" | "stopped" | "not-run";

export interface LineResult {
  kind: CheckoutLine["kind"];
  /** The document line. */
  line: number;
  text: string;
  point?: string;
  name?: string;
  loop?: string;
  /** A set: the value it commanded, as written. */
  commanded?: string;
  /** "done" for a command, a wait or a note that went through; "pass" or "fail" for a check. */
  status: LineStatus;
  /** A check: what was expected, in words. */
  expected?: string;
  /** What the point read: after a command, when noted, or the last reading of a check. */
  seen?: string;
  /** Why it is an error or was stopped, or something to know about a line that went through. */
  message?: string;
  tookMs: number;
  /** A check that waited: the readings it saw as numbers, oldest first (on and off as 1 and 0). */
  readings?: number[];
}

/** A point the test overrode and could not release. */
export interface LeftOverridden {
  point: string;
  name: string;
  /** The step that overrode it. */
  step: string;
  /** What it was overridden to. */
  value: string;
  /** Why the release did not go through. */
  why: string;
  /** When the station lets go of the override by itself. */
  until?: number;
}

export interface StepResult {
  index: number;
  title: string;
  line: number;
  text: string[];
  status: StepStatus;
  /** Why it failed, errored or stopped, in a sentence. */
  message?: string;
  /** The check that failed: what was expected and what was seen. */
  expected?: string;
  seen?: string;
  /** What was commanded, for the report: "SupplyFanSpeed 25, 50, 75, 100". */
  commanded: string;
  /** What the checks saw, for the report: "SupplyFanSpeedFbk 24.8 %, 50.1 %". */
  observed: string;
  /** The readings of the check that failed, else of the last check that waited. */
  readings: number[];
  startedAt: number;
  tookMs: number;
  lines: LineResult[];
  /** Points released when the step ended, by ORD. */
  released: string[];
  leftOverridden: LeftOverridden[];
}

/** A value recorded with a `note` line. */
export interface CheckoutNote {
  step: number;
  stepTitle: string;
  point: string;
  name: string;
  value: string;
  at: number;
}

export interface CheckoutResult {
  kind: "result";
  title: string;
  from: string;
  station: string;
  user: string;
  /** The reason sent with every command, as the station's audit history has it. */
  reason: string;
  startedAt: number;
  finishedAt: number;
  tookMs: number;
  /**
   * passed: every step passed and nothing is left overridden. failed: a step failed or errored, or
   * a point is left overridden. stopped: the run ended early (a command waits for a person, or a
   * command was refused without keepGoing). aborted: the signal fired. not-started: the look at the
   * station beforehand found errors (`problems`), and nothing was commanded.
   */
  outcome: "passed" | "failed" | "stopped" | "aborted" | "not-started";
  ok: boolean;
  /** One sentence saying how it went. */
  summary: string;
  counts: { steps: number; passed: number; failed: number; errors: number; notRun: number };
  text: string[];
  steps: StepResult[];
  notes: CheckoutNote[];
  /** Every point still overridden when the run ended. Empty when all were released. */
  leftOverridden: LeftOverridden[];
  /** A command the station kept for a person to approve instead of making it; the run stopped there. */
  proposal?: { id: string; description: string; point: string; expiresAt?: number };
  problems: CheckoutProblem[];
}

/** What a run tells a screen as it goes. `step` and `line` are indexes into the document's steps and a step's lines. */
export type CheckoutEvent =
  | { type: "step-started"; step: number; title: string; lines: number }
  | { type: "line-started"; step: number; line: number; kind: CheckoutLine["kind"]; text: string; point?: string; name?: string; /** How long this line may wait. */ waitMs?: number }
  | { type: "reading"; step: number; line: number; point: string; name: string; value: unknown; display: string; elapsedMs: number; /** The check's readings so far as numbers, oldest first. */ readings: number[] }
  | { type: "line-finished"; step: number; line: number; result: LineResult }
  | { type: "step-finished"; step: number; result: StepResult };

export interface RunOptions {
  /** Sent with every command and kept in the station's audit history. Default: the document's title and the step. */
  reason?: string;
  /** Go on to the next step after a command was refused. A failed check never stops the run. */
  keepGoing?: boolean;
  onEvent?: (event: CheckoutEvent) => void;
  /** Abort to stop: the step in hand releases what it overrode, and the rest are not run. */
  signal?: AbortSignal;
  /** How often a point being waited on is read, on top of the changes the station sends. Default one second. */
  pollMs?: number;
}

const MAX_READINGS = 120;
const RETRY_CODES = ["timeout", "connection_closed", "not_connected"];
/** Client-side failures after which the station may have made the command anyway. */
const UNSURE_CODES = ["timeout", "connection_closed"];

/** Resolves after `ms`, or at once when the signal fires. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

type Sent =
  | { how: "made"; snapshot: PointSnapshot }
  | { how: "proposed"; proposal: NonNullable<CheckoutResult["proposal"]> }
  | { how: "refused"; code: string; message: string; unsure: boolean };

/**
 * Runs the document: for each step its lines in order, then a release of every point the step
 * overrode, whether it passed, failed, hit an error or was aborted. It looks at the station first
 * (as rehearseCheckout does) and commands nothing if that finds an error. A command the station
 * keeps for a person to approve stops the run; a refused command ends its step, and the run goes on
 * to the next one only with `keepGoing`; a failed check ends its step and the run goes on.
 */
export async function runCheckout(client: BaskStreamClient, checkout: Checkout, options: RunOptions = {}): Promise<CheckoutResult> {
  const startedAt = Date.now();
  const { signal } = options;
  const emit = (event: CheckoutEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A screen that fails to draw must not leave a point overridden.
    }
  };
  const pollMs = Math.max(50, options.pollMs ?? 1000);
  const steps: StepResult[] = [];
  const notes: CheckoutNote[] = [];
  const left: LeftOverridden[] = [];
  let proposal: CheckoutResult["proposal"];
  let halted = false;

  const finish = (outcome: CheckoutResult["outcome"], problems: CheckoutProblem[], summary?: string, more = ""): CheckoutResult => {
    const counts = { steps: checkout.steps.length, passed: 0, failed: 0, errors: 0, notRun: 0 };
    for (const s of steps) {
      if (s.status === "pass") counts.passed += 1;
      else if (s.status === "fail") counts.failed += 1;
      else if (s.status === "not-run") counts.notRun += 1;
      else counts.errors += 1;
    }
    const finishedAt = Date.now();
    const tally = [`${counts.passed} of ${counts.steps} ${counts.steps === 1 ? "step" : "steps"} passed`, counts.failed ? `${counts.failed} failed` : "", counts.errors ? `${counts.errors} could not be finished` : "", counts.notRun ? `${counts.notRun} not run` : ""].filter(Boolean).join(", ");
    const still = left.length ? ` ${left.length === 1 ? "1 point is" : `${left.length} points are`} still overridden.` : "";
    return {
      kind: "result", title: checkout.title, from: checkout.from, station: stationOf(client), user: userOf(client), reason: options.reason ?? `Checkout: ${checkout.title}`,
      startedAt, finishedAt, tookMs: finishedAt - startedAt, outcome, ok: outcome === "passed", summary: summary ?? `${tally}.${more}${still}`, counts, text: checkout.text, steps, notes, leftOverridden: left, ...(proposal ? { proposal } : {}), problems
    };
  };

  const rehearsal = await rehearseCheckout(client, checkout);
  if (!rehearsal.ok) {
    for (const [index, step] of checkout.steps.entries()) steps.push(notRun(step, index));
    return finish("not-started", rehearsal.problems, "Not started: nothing was commanded. Fix what is listed and run it again.");
  }

  // Watching the points keeps the station polling them, and brings each change as it happens.
  let watch: Watch | undefined;
  let hear: ((snapshot: PointSnapshot) => void) | undefined;
  try {
    watch = await client.watch(checkout.points, { leaseSec: 120 });
    watch.on("change", (snapshot: PointSnapshot) => hear?.(snapshot));
  } catch {
    watch = undefined;
  }
  const readNow = async (point: string): Promise<PointSnapshot> => {
    try {
      const [snapshot] = await client.read([point], !watch && apiAtLeast(client, 1, 9) ? { fresh: true } : undefined);
      return snapshot ?? { point, ok: false, code: "read_failed", message: "The station sent no reading." };
    } catch (error) {
      return { point, ok: false, code: error instanceof BaskStreamError ? error.code : "read_failed", message: (error as Error).message };
    }
  };

  // An agent may make only so many changes a minute: wait for a turn rather than be refused part way.
  const agents = client.capabilities.agents as Json | undefined;
  const perMinute = agents?.isAgent ? Number(agents.maxChangesPerMinute ?? 0) : 0;
  const sentAt: number[] = [];
  const turn = async (stop?: AbortSignal) => {
    while (perMinute > 0 && !stop?.aborted) {
      const now = Date.now();
      while (sentAt.length && now - sentAt[0] >= 61000) sentAt.shift();
      if (sentAt.length < perMinute) return void sentAt.push(now);
      await pause(sentAt[0] + 61000 - now, stop);
    }
  };

  const send = async (point: string, action: "override" | "auto", reason: string, value?: CheckoutValue, durationSec?: number): Promise<Sent> => {
    // Stopping the run stops a new override from going out. A release always goes out.
    const stop = action === "override" ? signal : undefined;
    for (let tries = 0; ; tries += 1) {
      await turn(stop);
      if (stop?.aborted) return { how: "refused", code: "stopped", message: "Stopped before the command was sent.", unsure: false };
      try {
        const entry = await client.write(point, action, value, { ...(durationSec === undefined ? {} : { durationSec }), reason });
        if (!entry) return { how: "refused", code: "write_failed", message: "The station answered without a result for this point.", unsure: true };
        if (entry.outcome === "proposed") return { how: "proposed", proposal: briefOf(entry.proposal as Json | undefined, point, action, value) };
        if (entry.ok === false || entry.code) {
          if (entry.code === "agent_rate_limited" && tries < 3) {
            await pause(20000, stop);
            continue;
          }
          return { how: "refused", code: String(entry.code ?? "write_failed"), message: String(entry.message ?? entry.code ?? "The station refused the command."), unsure: false };
        }
        return { how: "made", snapshot: entry };
      } catch (error) {
        if (error instanceof ChangeProposedError) return { how: "proposed", proposal: briefOf(error.proposal as unknown as Json, point, action, value) };
        const code = error instanceof BaskStreamError ? error.code : "error";
        if (code === "agent_rate_limited" && tries < 3) {
          await pause(20000, stop);
          continue;
        }
        // Letting go is safe to send twice, and too important to give up on at a dropped connection.
        if (action === "auto" && RETRY_CODES.includes(code) && tries < 3) {
          await pause([1000, 3000, 6000][tries]);
          continue;
        }
        return { how: "refused", code, message: (error as Error).message, unsure: !(error instanceof BaskStreamError) || UNSURE_CODES.includes(code) };
      }
    }
  };

  /** Releases a point; returns why it is still overridden, or undefined when it was let go. */
  const letGo = async (point: string, reason: string): Promise<string | undefined> => {
    const sent = await send(point, "auto", reason);
    if (sent.how === "proposed") return `the station kept the release for a person to approve (${sent.proposal.id})`;
    if (sent.how === "refused") return `the release did not go through: ${sent.message} [${sent.code}]`;
    return undefined;
  };

  try {
    for (const [index, step] of checkout.steps.entries()) {
      if (halted || signal?.aborted) {
        steps.push(notRun(step, index));
        continue;
      }
      const stepStarted = Date.now();
      emit({ type: "step-started", step: index, title: step.title, lines: step.lines.length });
      const reason = (options.reason ?? `Checkout: ${checkout.title} (${step.title})`).slice(0, 300);
      const holdSec = holdSeconds(step);
      /** Points this step overrode and has not released, with what the report needs if one stays that way. */
      const held = new Map<string, { name: string; value: string; until: number }>();
      /** Values written down with `note`: where a rise or fall is counted from. */
      const noted = new Map<string, number>();
      const lines: LineResult[] = [];
      let status: StepStatus = "pass";
      let message: string | undefined;

      const runLine = async (l: CheckoutLine, at: number): Promise<LineResult> => {
        const began = Date.now();
        const base = lineOf(l);
        const took = () => Date.now() - began;
        switch (l.kind) {
          case "set": {
            const durationSec = l.forMs === undefined ? holdSec : Math.ceil(l.forMs / 1000);
            const before = held.get(l.point);
            // Counted as overridden from before the command goes out: a reply that never came does not mean it was not made.
            held.set(l.point, { name: l.name, value: l.valueText, until: Date.now() + durationSec * 1000 });
            const sent = await send(l.point, "override", reason, l.value, durationSec);
            if (sent.how === "made") {
              const level = Number(sent.snapshot.activeLevel);
              const outranked = Number.isFinite(level) && level < 8;
              return { ...base, status: "done", seen: shown(sent.snapshot), tookMs: took(), ...(outranked ? { message: `Commanded, but priority level ${level} is in control of ${l.name}, above an operator override: it reads ${fmtPoint(sent.snapshot)}.` } : {}) };
            }
            if (!(sent.how === "refused" && sent.unsure)) {
              if (before) held.set(l.point, before);
              else held.delete(l.point);
            }
            if (sent.how === "proposed") {
              proposal = sent.proposal;
              return { ...base, status: "stopped", tookMs: took(), message: `The station did not make this command. It kept it for a person to approve, as ${sent.proposal.id}.` };
            }
            if (sent.code === "stopped") return { ...base, status: "stopped", tookMs: took(), message: sent.message };
            return { ...base, status: "error", tookMs: took(), message: sent.unsure ? `No answer to the command: ${sent.message} [${sent.code}]` : `The station refused the command: ${sent.message} [${sent.code}]` };
          }
          case "release": {
            const sent = await send(l.point, "auto", reason);
            if (sent.how === "made") {
              held.delete(l.point);
              return { ...base, status: "done", seen: shown(sent.snapshot), tookMs: took() };
            }
            if (sent.how === "proposed") {
              proposal = sent.proposal;
              return { ...base, status: "stopped", tookMs: took(), message: `The station did not release it. It kept the release for a person to approve, as ${sent.proposal.id}.` };
            }
            return { ...base, status: "error", tookMs: took(), message: `The station refused the release: ${sent.message} [${sent.code}]` };
          }
          case "wait": {
            await pause(l.ms, signal);
            return signal?.aborted ? { ...base, status: "stopped", tookMs: took(), message: "Stopped during the wait." } : { ...base, status: "done", tookMs: took() };
          }
          case "note": {
            const snapshot = await readNow(l.point);
            if (snapshot.code) return { ...base, status: "error", tookMs: took(), message: notReadable(l.name, snapshot) };
            const n = numberOf(snapshot);
            if (n !== undefined && !unproven(snapshot)) noted.set(l.point, n);
            notes.push({ step: index, stepTitle: step.title, point: l.point, name: l.name, value: shown(snapshot), at: Date.now() });
            return { ...base, status: "done", seen: shown(snapshot), tookMs: took() };
          }
          default: {
            const c = l.comparison;
            const moving = c.kind === "rises" || c.kind === "falls";
            let from = moving ? noted.get(l.point) : undefined;
            const readings: number[] = [];
            let last: PointSnapshot | undefined;
            const waiting: PointSnapshot[] = [];
            let wake: (() => void) | undefined;
            hear = (snapshot) => {
              if (snapshot.point !== l.point) return;
              waiting.push(snapshot);
              wake?.();
            };
            /** Takes one reading in; true when it meets the check. */
            const take = (snapshot: PointSnapshot): boolean => {
              last = snapshot;
              const n = numberOf(snapshot);
              if (moving && from === undefined && n !== undefined && !unproven(snapshot)) from = n;
              const t = trendValue(snapshot);
              if (t !== undefined) {
                readings.push(t);
                // Keep the shape of a long wait without keeping every reading.
                if (readings.length > MAX_READINGS) readings.splice(0, readings.length, ...readings.filter((_v, i) => i % 2 === 0 || i === readings.length - 1));
              }
              emit({ type: "reading", step: index, line: at, point: l.point, name: l.name, value: snapshot.value, display: shown(snapshot), elapsedMs: took(), readings: [...readings] });
              return meets(c, snapshot, from);
            };
            /** Until the station sends a reading, `ms` have gone by, or the run is stopped. */
            const nextReading = (ms: number) => new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", done);
                wake = undefined;
                resolve();
              };
              const timer = setTimeout(done, Math.max(0, ms));
              wake = done;
              if (signal?.aborted) done();
              else signal?.addEventListener("abort", done, { once: true });
            });
            const deadline = began + l.withinMs;
            let met = false;
            try {
              for (;;) {
                met = take(await readNow(l.point));
                while (!met && waiting.length) met = take(waiting.shift()!);
                if (met || signal?.aborted || Date.now() >= deadline) break;
                // Between asks, take what the station sends by itself.
                const until = Math.min(deadline, Date.now() + pollMs);
                while (!met && !signal?.aborted && Date.now() < until) {
                  await nextReading(until - Date.now());
                  while (!met && waiting.length) met = take(waiting.shift()!);
                }
                if (met || signal?.aborted) break;
              }
            } finally {
              hear = undefined;
            }
            const moved = moving && from !== undefined && last && numberOf(last) !== undefined ? ` (${numberOf(last)! >= from ? "up" : "down"} ${trimNumber(Math.abs(numberOf(last)! - from))} from ${trimNumber(from)})` : "";
            const result = { ...base, expected: expectedText(c, from), seen: `${last ? shown(last) : "no reading"}${moved}`, tookMs: took(), readings };
            if (met) return { ...result, status: "pass" };
            if (signal?.aborted) return { ...result, status: "stopped", message: "Stopped while waiting for it." };
            return { ...result, status: "fail" };
          }
        }
      };

      try {
        for (const [at, l] of step.lines.entries()) {
          if (signal?.aborted) {
            status = "stopped";
            message = "Stopped before it finished.";
            break;
          }
          emit({ type: "line-started", step: index, line: at, kind: l.kind, text: l.text, ...("point" in l ? { point: l.point, name: l.name } : {}), ...(l.kind === "wait" ? { waitMs: l.ms } : l.kind === "expect" && l.withinMs ? { waitMs: l.withinMs } : {}) });
          const result = await runLine(l, at);
          lines.push(result);
          emit({ type: "line-finished", step: index, line: at, result });
          if (result.status === "done" || result.status === "pass") continue;
          status = result.status === "fail" ? "fail" : result.status === "error" ? "error" : "stopped";
          message = result.status === "fail" ? `${result.name} was expected to ${toBe(result.expected ?? "")}${l.kind === "expect" && l.withinMs ? ` within ${span(l.withinMs)}` : ""}, and read ${result.seen}.` : result.message;
          break;
        }
      } catch (error) {
        // Nothing above is meant to throw; if something does, the step still releases what it holds.
        status = "error";
        message = `bask hit a problem of its own: ${(error as Error).message}`;
      }
      for (const l of step.lines.slice(lines.length)) lines.push({ ...lineOf(l), status: "not-run", tookMs: 0 });

      // Whatever happened above, let go of every point this step overrode, last one first.
      const released: string[] = [];
      const stuck: LeftOverridden[] = [];
      for (const [point, was] of [...held].reverse()) {
        const why = await letGo(point, reason);
        if (why) stuck.push({ point, name: was.name, step: step.title, value: was.value, why, until: was.until });
        else released.push(point);
      }
      left.push(...stuck);

      if (status === "stopped" && proposal) halted = true;
      if (status === "error" && !options.keepGoing) halted = true;
      const failed = lines.find((r) => r.status === "fail");
      const trend = failed ?? [...lines].reverse().find((r) => r.kind === "expect" && (r.readings?.length ?? 0) > 1) ?? [...lines].reverse().find((r) => r.kind === "expect" && r.readings?.length);
      const result: StepResult = {
        index, title: step.title, line: step.line, text: step.text, status, ...(message ? { message } : {}), ...(failed ? { expected: failed.expected, seen: failed.seen } : {}),
        commanded: grouped(lines.filter((r) => r.kind === "set" && r.status !== "not-run").map((r) => [r.name ?? "", r.commanded ?? ""])),
        observed: grouped(lines.filter((r) => r.kind === "expect" && r.seen !== undefined && r.status !== "not-run").map((r) => [r.name ?? "", r.seen ?? ""])),
        readings: trend?.readings ?? [], startedAt: stepStarted, tookMs: Date.now() - stepStarted, lines, released, leftOverridden: stuck
      };
      steps.push(result);
      emit({ type: "step-finished", step: index, result });
    }
  } finally {
    hear = undefined;
    await watch?.close().catch(() => undefined);
  }

  if (proposal) {
    return finish("stopped", rehearsal.problems, `Stopped: the station kept "${proposal.description}" on ${place(proposal.point)} for a person to approve (${proposal.id}). It was not made, and the test did not go on. Approving it later makes that one command by itself, not the rest of the test.`);
  }
  if (signal?.aborted) return finish("aborted", rehearsal.problems, undefined, " Stopped before the end.");
  if (halted) return finish("stopped", rehearsal.problems, undefined, " The run stopped at the command the station refused; to go on to the next step anyway, add --keep-going.");
  return finish(steps.every((s) => s.status === "pass") && left.length === 0 ? "passed" : "failed", rehearsal.problems);
}

/** [["Fan", "25"], ["Fan", "50"], ["Valve", "0"]] → "Fan 25, 50; Valve 0". */
function grouped(pairs: string[][]): string {
  const by = new Map<string, string[]>();
  for (const [name, value] of pairs) by.set(name, [...(by.get(name) ?? []), value]);
  return [...by].map(([name, values]) => `${name} ${values.join(", ")}`).join("; ");
}

/** What every result of a line starts from: the line itself. */
function lineOf(l: CheckoutLine) {
  return { kind: l.kind, line: l.line, text: l.text, ...("point" in l ? { point: l.point, name: l.name } : {}), ...(l.loop === undefined ? {} : { loop: l.loop }), ...(l.kind === "set" ? { commanded: l.valueText } : {}) };
}

function notRun(step: CheckoutStep, index: number): StepResult {
  return {
    index, title: step.title, line: step.line, text: step.text, status: "not-run", commanded: "", observed: "", readings: [], startedAt: 0, tookMs: 0, released: [], leftOverridden: [],
    lines: step.lines.map((l): LineResult => ({ ...lineOf(l), status: "not-run", tookMs: 0 }))
  };
}

function briefOf(proposal: Json | undefined, point: string, action: string, value: CheckoutValue | undefined): NonNullable<CheckoutResult["proposal"]> {
  return {
    id: String(proposal?.id ?? "?"),
    description: String(proposal?.description ?? (action === "auto" ? "release" : `override ${String(value)}`)),
    point: String(proposal?.point ?? point),
    ...(typeof proposal?.expiresAt === "number" ? { expiresAt: proposal.expiresAt } : {})
  };
}

/** The exit code for a run or a rehearsal: 0 it passed (or would start), 2 a command waits for a person, 1 anything else. */
export function checkoutExitCode(result: CheckoutResult | Rehearsal): number {
  if (result.kind === "rehearsal") return result.ok ? 0 : 1;
  return result.outcome === "passed" ? 0 : result.proposal ? 2 : 1;
}

// ---- The report and the terminal ------------------------------------------------------------------

const STATUS_WORD: Record<StepStatus, string> = { pass: "Pass", fail: "FAIL", error: "Error", stopped: "Stopped", "not-run": "Not run" };
const STATUS_SAID: Record<StepStatus, string> = { pass: "passed", fail: "failed", error: "could not be finished", stopped: "stopped", "not-run": "not run" };
const TREND_WIDTH = 24;

/** The readings as a small trend. One reading, or none, draws nothing. */
const trendOf = (readings: number[] | undefined) => (readings && readings.length > 1 ? sparkline(readings, TREND_WIDTH) : "");

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function leftLine(l: LeftOverridden): string {
  return `${l.point} (overridden to ${l.value} in "${l.step}"): ${l.why}.${l.until ? ` The station lets go of it by itself at ${fmtTime(l.until, false)}.` : ""}`;
}

/** What a line came to, in words, for the report and the terminal. */
function lineOutcome(r: LineResult): string {
  switch (r.status) {
    case "not-run": return "not run";
    case "error": return `error: ${r.message ?? ""}`;
    case "stopped": return `stopped: ${r.message ?? ""}`;
    case "pass": return `passed in ${span(r.tookMs)}, read ${r.seen}`;
    case "fail": return `FAILED after ${span(r.tookMs)}: expected to ${toBe(r.expected ?? "")}, read ${r.seen}`;
    default:
      if (r.kind === "wait") return "done";
      return `${r.kind === "note" ? "read" : "done, reads"} ${r.seen ?? ""}${r.message ? `. ${r.message}` : ""}`;
  }
}

/** The checkout report: plain markdown that can be handed to a customer. */
export function checkoutReport(result: CheckoutResult): string {
  const out: string[] = [];
  const verdict = { passed: "Passed", failed: "Failed", stopped: "Stopped before the end", aborted: "Stopped by the person running it", "not-started": "Not started" }[result.outcome];
  out.push(`# ${result.title}`, "", "Checkout report", "");
  out.push("| | |", "| --- | --- |");
  out.push(`| Result | **${verdict}**: ${cell(result.summary)} |`);
  out.push(`| Station | ${cell(result.station)} |`);
  if (result.user) out.push(`| Run by | ${cell(result.user)} |`);
  out.push(`| Started | ${fmtTime(result.startedAt)} |`);
  out.push(`| Took | ${span(result.tookMs)} |`);
  out.push(`| Document | ${cell(result.from)} |`, "");
  if (result.text.length) out.push(...result.text, "");

  if (result.problems.length) {
    out.push(result.outcome === "not-started" ? "## Why it did not start" : "## Found before it started", "");
    for (const p of result.problems) out.push(`- ${p.severity === "error" ? "Error" : "Note"}${p.line ? ` (line ${p.line})` : ""}: ${p.message}`);
    out.push("");
  }

  out.push("## Steps", "");
  out.push("| # | Step | Result | Commanded | Seen | Took | Trend |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of result.steps) {
    const seen = s.status === "fail" ? `expected to ${toBe(s.expected ?? "")}, read ${s.seen}` : s.status === "error" || s.status === "stopped" ? s.message ?? "" : s.observed;
    out.push(`| ${s.index + 1} | ${cell(s.title)} | ${s.status === "fail" || s.status === "error" ? `**${STATUS_WORD[s.status]}**` : STATUS_WORD[s.status]} | ${cell(s.commanded) || "—"} | ${cell(seen) || "—"} | ${s.status === "not-run" ? "—" : span(s.tookMs)} | ${trendOf(s.readings) || "—"} |`);
  }
  out.push("");

  out.push("## Step by step", "");
  for (const s of result.steps) {
    out.push(`### ${s.index + 1}. ${s.title}: ${STATUS_SAID[s.status]}`, "");
    if (s.text.length) out.push(...s.text, "");
    if (s.message) out.push(s.message, "");
    for (const r of s.lines) {
      const trend = r.status === "pass" || r.status === "fail" ? trendOf(r.readings) : "";
      out.push(`- ${r.text}: ${lineOutcome(r)}${trend ? `  ${trend}` : ""}`);
    }
    if (s.released.length) out.push(`- released when the step ended: ${s.released.map((point) => place(point)).join(", ")}`);
    for (const l of s.leftOverridden) out.push(`- **still overridden:** ${leftLine(l)}`);
    out.push("");
  }

  if (result.notes.length) {
    out.push("## Notes", "", "Values written down during the test.", "", "| Step | Point | Read | At |", "| --- | --- | --- | --- |");
    for (const n of result.notes) out.push(`| ${n.step + 1}. ${cell(n.stepTitle)} | ${cell(n.name)} | ${cell(n.value)} | ${fmtTime(n.at, false)} |`);
    out.push("");
  }

  out.push("## Left overridden", "");
  if (result.leftOverridden.length === 0) out.push(result.steps.some((s) => s.released.length) ? "Nothing. Every point the test overrode was released." : "Nothing. The test overrode no points.");
  else {
    out.push("**These points are still overridden. Release them by hand.**", "");
    for (const l of result.leftOverridden) out.push(`- ${leftLine(l)}`);
  }
  if (result.proposal) out.push("", `The station kept "${result.proposal.description}" on ${result.proposal.point} for a person to approve, as ${result.proposal.id}. It was not made. Reject it unless that one command is wanted by itself.`);
  if (result.steps.some((s) => s.commanded)) out.push("", `Each command was an operator override with a time limit, recorded on the station with the reason "${result.reason}"${result.reason === `Checkout: ${result.title}` ? " and the step's name" : ""}.`);
  out.push("");
  return out.join("\n");
}

const MARK: Record<StepStatus | LineStatus, string> = { pass: chalk.green("✓"), done: chalk.dim("·"), fail: chalk.red("✗"), error: chalk.red("!"), stopped: chalk.yellow("■"), "not-run": chalk.dim("–") };

function problemsText(problems: CheckoutProblem[]): string[] {
  return problems.map((p) => `  ${p.severity === "error" ? chalk.red("error  ") : chalk.yellow("warning")}  ${p.line ? chalk.dim(`line ${p.line}: `) : ""}${p.message}`);
}

/** What the terminal prints for a rehearsal or a finished run. */
export function checkoutText(result: CheckoutResult | Rehearsal): string {
  const out: string[] = [];
  const where = chalk.dim([result.station, result.user, result.from].filter(Boolean).join(" · "));
  if (result.kind === "rehearsal") {
    out.push(`${chalk.bold(`Rehearsal: ${result.title}`)}  ${where}`, chalk.dim("Nothing was commanded. This is what a run would do."), "");
    for (const s of result.steps) {
      out.push(`${chalk.bold(String(s.index + 1).padStart(2))}  ${chalk.bold(s.title)}`);
      for (const l of s.lines) out.push(`      ${l.does}${l.now === undefined ? "" : chalk.dim(`  (reads ${l.now} now)`)}`);
      if (s.releases.length) out.push(chalk.dim(`      then release ${s.releases.map((point) => place(point)).join(", ")}, however the step ends`));
    }
    const overrides = result.commands.filter((c) => c.action === "override");
    const points = new Set(overrides.map((c) => c.point));
    out.push("", overrides.length
      ? `A run would send ${overrides.length} ${overrides.length === 1 ? "override" : "overrides"} to ${points.size} ${points.size === 1 ? "point" : "points"}: ${[...points].map((point) => place(point)).join(", ")}.`
      : "A run would command nothing: this document only reads.");
    if (result.problems.length) out.push("", ...problemsText(result.problems));
    out.push("", result.ok ? `${chalk.green("Ready.")} To run it for real: add --allow-writes --yes.` : chalk.red("Not ready: a run would not start. Fix the errors above first."));
    return out.join("\n");
  }

  out.push(`${chalk.bold(result.title)}  ${where}`, "");
  if (result.outcome === "not-started") out.push(...problemsText(result.problems), "");
  else {
    for (const s of result.steps) {
      out.push(`${MARK[s.status]} ${chalk.bold(String(s.index + 1).padStart(2))}  ${chalk.bold(s.title)}${s.status === "not-run" ? chalk.dim("  not run") : chalk.dim(`  ${span(s.tookMs)}`)}`);
      for (const r of s.lines) {
        if (r.status === "not-run") continue;
        const trend = r.status === "pass" || r.status === "fail" ? trendOf(r.readings) : "";
        const text = lineOutcome(r);
        out.push(`     ${MARK[r.status]} ${r.text}${chalk.dim(":")} ${r.status === "fail" || r.status === "error" ? chalk.red(text) : r.status === "stopped" ? chalk.yellow(text) : text}${trend ? `  ${chalk.cyan(trend)}` : ""}`);
      }
    }
    out.push("");
    const warnings = result.problems.filter((p) => p.severity === "warning");
    if (warnings.length) out.push(...problemsText(warnings), "");
  }
  out.push(result.outcome === "passed" ? chalk.green(result.summary) : result.outcome === "failed" || result.outcome === "not-started" ? chalk.red(result.summary) : chalk.yellow(result.summary));
  if (result.leftOverridden.length) {
    out.push("", chalk.red.bold("STILL OVERRIDDEN. Release these by hand:"));
    for (const l of result.leftOverridden) out.push(chalk.red(`  ${leftLine(l)}`));
  } else if (result.steps.some((s) => s.released.length)) out.push(chalk.dim("Every point the test overrode was released."));
  return out.join("\n");
}
