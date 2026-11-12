// A graphic: a drawing of equipment made from the symbol library and tied to a station's points.
//
// It is described without coordinates, so a person or an AI agent can write one from a list of the
// equipment: rows of parts, air paths whose sections join into one casing, and pipes named by the
// ports they join. This file checks such a document, lays it out, finds a way through for each pipe,
// and draws it for a frame with the points' current values.
import { theme } from "../theme.js";
import { Canvas, type Sprite, type Style } from "./canvas.js";
import { MEDIA, STATUSES, SYMBOL, SYMBOLS, mediumColor, moving, paint, sizeOf, type Medium, type Status, type SymbolDef, type SymbolState } from "./library.js";

// ---- The document ---------------------------------------------------------------------------------

/** A fixed number or true/false, a point (an ORD, or a path under the graphic's `base`), or a point scaled from `min`..`max` to 0..100. */
export type Binding = number | boolean | string | { point: string; min?: number; max?: number };

export interface PartDoc {
  /** A name pipes use to reach this part. */
  id?: string;
  /** A symbol id from the library. Without one the part is a text tag: the end of a pipe that leaves the drawing. */
  symbol?: string;
  /** The name printed with it. */
  label?: string;
  /** 0 to 100: what the symbol's `value` means (a position, speed, load or level). */
  value?: Binding;
  aux?: Binding;
  /** Running. Left out, a part with a value runs while the value is above zero. */
  on?: Binding;
  open?: Binding;
  /** What is printed as its reading. Left out, it is the value's point. */
  reading?: Binding;
  /** Fixed text printed in place of a reading. */
  note?: string;
  /** A point whose status colours the part, or a fixed status word. Left out, it is the worst status of the part's points. */
  status?: string;
  medium?: Medium;
  /** The symbol's own text: the letter on a sensor. */
  text?: string;
  /** Cells wide, for a stretch of duct (the airflow symbol). */
  width?: number;
}

/** The end of an air path: a name, and optionally a reading or fixed text under it. */
export type EndDoc = string | { label: string; reading?: Binding; note?: string };

/** An air path: sections side by side in one casing, with air moving between them. */
export interface AirRowDoc {
  id?: string;
  air: PartDoc[];
  from?: EndDoc;
  to?: EndDoc;
  /** Whether the air moves. Left out, it moves while a fan in the row runs. */
  flow?: Binding;
}

/** Equipment side by side. An array inside `parts` is a column: its parts stack top to bottom. */
export interface PartsRowDoc {
  parts: (PartDoc | PartDoc[])[];
}

export interface PipeDoc {
  /** "id.port", or just "id" for its outlet. */
  from: string;
  /** "id.port", or just "id" for its inlet. */
  to: string;
  medium?: Medium;
  /** A pipe is a single line, a duct a double one. */
  kind?: "pipe" | "duct";
  /** Whether the marks move. Left out, they move unless a part at either end is stopped. */
  flow?: Binding;
}

export interface GraphicDoc {
  title?: string;
  /** Where relative point paths start, e.g. slot:/Drivers/BacnetNetwork/AHU_01/points. */
  base?: string;
  rows: (AirRowDoc | PartsRowDoc)[];
  pipes?: PipeDoc[];
}

export interface Problem {
  level: "error" | "warning";
  /** Where in the document, e.g. rows[0].air[2].symbol. */
  at: string;
  message: string;
}

/** What a point is doing now: the part of a station's point snapshot a graphic needs. */
export interface PointValue {
  ok?: boolean;
  value?: unknown;
  displayValue?: string;
  /** One word for the point's status: ok, alarm, fault, down, stale, overridden, disabled. */
  state?: string;
}
export type Values = (ord: string) => PointValue | undefined;

// ---- Sizes the layout uses ------------------------------------------------------------------------

const MARGIN_X = 3;
const MARGIN_Y = 2;
/** Between parts in a row: room for pipes to pass, and less where the row has none. */
const GAP_X = 6;
const GAP_X_PLAIN = 3;
/** Between rows. */
const GAP_Y = 2;
/** Room kept for a reading until its real length is known (see `roomNeeded`). */
const READING = 8;
const SECTION_READING = 7;
/** Rows above an air casing for names and readings, the casing itself, and the piping drawn under a coil. */
const AIR_HEAD = 3;
const CASING = 5;
const COIL_PIPING = 6;
const STUB = 6;

const len = (text: string) => [...text].length;
const clipTo = (text: string, width: number) => (len(text) <= width ? text : `${[...text].slice(0, Math.max(0, width - 1)).join("")}…`);

/** An air-handler section: five rows whose top row is casing wall. Other symbols stand on their own. */
export const isSection = (def: SymbolDef): boolean => {
  const sprite = def.draw(def.sample, 0);
  return sprite.rows.length === CASING && /^─+$/.test(sprite.rows[0]);
};
/** Symbols that print their reading inside themselves. */
const READS_INSIDE = new Set(["plate", "cold-room"]);
const COILS = new Set(["cooling-coil", "heating-coil"]);

// ---- Checking a document --------------------------------------------------------------------------

const PART_KEYS = ["id", "symbol", "label", "value", "aux", "on", "open", "reading", "note", "status", "medium", "text", "width"];
const AIR_KEYS = ["id", "air", "from", "to", "flow"];
const PIPE_KEYS = ["from", "to", "medium", "kind", "flow"];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** How many single-character edits separate two words, to suggest the one that was meant. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}
const nearest = (word: string, known: string[]): string => {
  const best = known.map((k) => ({ k, d: distance(word.toLowerCase(), k.toLowerCase()) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(2, Math.floor(word.length / 3)) ? ` Did you mean "${best.k}"?` : "";
};

/** The point a reference names: an ORD as it is, anything else as a path under `base`. */
export function resolvePoint(ref: string, base?: string): string | undefined {
  if (/^(station:\|)?(slot|h):/.test(ref)) return ref.replace(/^station:\|/, "");
  if (!base) return undefined;
  return `${base.replace(/^station:\|/, "").replace(/\/+$/, "")}/${ref.replace(/^\/+/, "")}`;
}

type Ref = { fixed: number | boolean } | { ord: string; min?: number; max?: number };

/** Reads a document that came from JSON: what is wrong with it, and the document when nothing stops it being drawn. */
export function checkGraphic(input: unknown): { doc?: GraphicDoc; problems: Problem[] } {
  const problems: Problem[] = [];
  const error = (at: string, message: string) => void problems.push({ level: "error", at, message });
  const warn = (at: string, message: string) => void problems.push({ level: "warning", at, message });
  if (!isObject(input)) return { problems: [{ level: "error", at: "", message: "A graphic is a JSON object with \"rows\"." }] };
  for (const key of Object.keys(input)) if (!["title", "base", "rows", "pipes"].includes(key)) warn(key, `Unknown key "${key}".${nearest(key, ["title", "base", "rows", "pipes"])}`);
  if (input.title !== undefined && typeof input.title !== "string") error("title", "The title is text.");
  if (input.base !== undefined && (typeof input.base !== "string" || !/^(station:\|)?slot:/.test(input.base))) error("base", "The base is an ORD such as slot:/Drivers/BacnetNetwork/AHU_01/points.");
  const base = typeof input.base === "string" ? input.base : undefined;

  const binding = (value: unknown, at: string) => {
    if (value === undefined || typeof value === "number" || typeof value === "boolean") return;
    const ref = typeof value === "string" ? value : isObject(value) && typeof value.point === "string" ? value.point : undefined;
    if (ref === undefined) return error(at, "Give a number, true or false, a point, or {\"point\": ..., \"min\": ..., \"max\": ...}.");
    if (ref.trim() === "") return error(at, "The point is empty.");
    if (!resolvePoint(ref, base)) error(at, `"${ref}" is a relative point path, and the graphic has no "base" to start it from.`);
    if (isObject(value)) {
      for (const key of Object.keys(value)) if (!["point", "min", "max"].includes(key)) warn(`${at}.${key}`, `Unknown key "${key}".`);
      if ((value.min !== undefined && typeof value.min !== "number") || (value.max !== undefined && typeof value.max !== "number")) error(at, "min and max are numbers.");
      else if (value.min !== undefined && value.max !== undefined && value.min === value.max) error(at, "min and max are the same.");
    }
  };
  const ids = new Map<string, string>();
  const claim = (id: unknown, at: string) => {
    if (id === undefined) return;
    if (typeof id !== "string" || !/^[A-Za-z][\w-]*$/.test(id)) return error(`${at}.id`, "An id starts with a letter and has only letters, digits, - and _.");
    if (ids.has(id)) return error(`${at}.id`, `The id "${id}" is already used at ${ids.get(id)}.`);
    ids.set(id, at);
  };
  const part = (value: unknown, at: string, inAir: boolean) => {
    if (!isObject(value)) return error(at, "A part is an object such as {\"symbol\": \"fan\", \"label\": \"Supply fan\"}.");
    for (const key of Object.keys(value)) if (!PART_KEYS.includes(key)) warn(`${at}.${key}`, `Unknown key "${key}".${nearest(key, PART_KEYS)}`);
    claim(value.id, at);
    for (const key of ["label", "note", "text"]) if (value[key] !== undefined && typeof value[key] !== "string") error(`${at}.${key}`, `${key} is text.`);
    for (const key of ["value", "aux", "on", "open", "reading"]) binding(value[key], `${at}.${key}`);
    if (value.status !== undefined) {
      if (typeof value.status !== "string") error(`${at}.status`, "The status is a point, or one of the status words.");
      else if (!(STATUSES as string[]).includes(value.status)) binding(value.status, `${at}.status`);
    }
    if (value.medium !== undefined && !(MEDIA as unknown[]).includes(value.medium)) error(`${at}.medium`, `No medium "${String(value.medium)}". Known: ${[...MEDIA].join(", ")}.`);
    if (value.width !== undefined && (typeof value.width !== "number" || value.width < 1 || value.width > 40)) error(`${at}.width`, "The width is a number of cells from 1 to 40.");
    if (value.symbol === undefined) {
      if (inAir) return error(`${at}.symbol`, "A part of an air path needs a symbol.");
      if (typeof value.label !== "string" || !value.label) error(`${at}.label`, "A part with no symbol is a text tag and needs a label.");
      return;
    }
    const def = typeof value.symbol === "string" ? SYMBOL.get(value.symbol) : undefined;
    if (!def) return error(`${at}.symbol`, `No symbol "${String(value.symbol)}".${nearest(String(value.symbol), SYMBOLS.map((s) => s.id))} Run "bask graphic guide" for the list.`);
    if (inAir && !isSection(def)) error(`${at}.symbol`, `"${def.id}" stands on its own: put it in a "parts" row. An air path takes ${SYMBOLS.filter(isSection).map((s) => s.id).join(", ")}.`);
    if (!inAir && isSection(def)) error(`${at}.symbol`, `"${def.id}" is an air-handler section: put it in an "air" row.`);
  };
  const end = (value: unknown, at: string) => {
    if (value === undefined || typeof value === "string") return;
    if (!isObject(value) || typeof value.label !== "string") return error(at, "Give a name, or {\"label\": ..., \"reading\": ...}.");
    binding(value.reading, `${at}.reading`);
    if (value.note !== undefined && typeof value.note !== "string") error(`${at}.note`, "note is text.");
  };

  if (!Array.isArray(input.rows) || input.rows.length === 0) error("rows", "A graphic needs \"rows\": a list with at least one row.");
  else input.rows.forEach((row: unknown, r: number) => {
    const at = `rows[${r}]`;
    if (!isObject(row) || (Array.isArray(row.air) ? 1 : 0) + (Array.isArray(row.parts) ? 1 : 0) !== 1) return error(at, "A row is {\"air\": [...]} for an air path or {\"parts\": [...]} for equipment side by side.");
    if (Array.isArray(row.air)) {
      for (const key of Object.keys(row)) if (!AIR_KEYS.includes(key)) warn(`${at}.${key}`, `Unknown key "${key}".${nearest(key, AIR_KEYS)}`);
      claim(row.id, at);
      if (row.air.length === 0) error(`${at}.air`, "An air path needs at least one section.");
      row.air.forEach((p: unknown, i: number) => part(p, `${at}.air[${i}]`, true));
      end(row.from, `${at}.from`);
      end(row.to, `${at}.to`);
      binding(row.flow, `${at}.flow`);
    } else {
      for (const key of Object.keys(row)) if (key !== "parts") warn(`${at}.${key}`, `Unknown key "${key}".`);
      const parts = row.parts as unknown[];
      if (parts.length === 0) error(`${at}.parts`, "A row needs at least one part.");
      parts.forEach((p, i) => {
        if (!Array.isArray(p)) return part(p, `${at}.parts[${i}]`, false);
        if (p.length === 0) error(`${at}.parts[${i}]`, "A column needs at least one part.");
        p.forEach((q, j) => part(q, `${at}.parts[${i}][${j}]`, false));
      });
    }
  });

  if (input.pipes !== undefined && !Array.isArray(input.pipes)) error("pipes", "\"pipes\" is a list.");
  else ((input.pipes ?? []) as unknown[]).forEach((pipe, i) => {
    const at = `pipes[${i}]`;
    if (!isObject(pipe)) return error(at, "A pipe is {\"from\": \"id.port\", \"to\": \"id.port\"}.");
    for (const key of Object.keys(pipe)) if (!PIPE_KEYS.includes(key)) warn(`${at}.${key}`, `Unknown key "${key}".${nearest(key, PIPE_KEYS)}`);
    for (const side of ["from", "to"]) if (typeof pipe[side] !== "string" || !pipe[side]) error(`${at}.${side}`, `"${side}" names a part and a port, such as "pump1.out".`);
    if (pipe.medium !== undefined && !(MEDIA as unknown[]).includes(pipe.medium)) error(`${at}.medium`, `No medium "${String(pipe.medium)}". Known: ${[...MEDIA].join(", ")}.`);
    if (pipe.kind !== undefined && pipe.kind !== "pipe" && pipe.kind !== "duct") error(`${at}.kind`, "kind is \"pipe\" or \"duct\".");
    binding(pipe.flow, `${at}.flow`);
  });

  return problems.some((p) => p.level === "error") ? { problems } : { doc: input as unknown as GraphicDoc, problems };
}

// ---- Laying it out --------------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A part with its place in the drawing. */
export interface Placed {
  /** Where it is in the document. */
  at: string;
  doc: PartDoc;
  /** The symbol; none for a text tag. */
  def?: SymbolDef;
  box: Box;
  /** The centre column and row of its name; the reading goes on the row below. */
  label?: { x: number; y: number; width: number; reading: boolean };
  /** Cells kept for its reading. */
  room: number;
  refs: { value?: Ref; aux?: Ref; on?: Ref; open?: Ref; reading?: Ref; status?: string };
  /** The ORDs it reads, the one that matters most first. */
  points: string[];
}

interface End {
  at: string;
  label: string;
  x: number;
  ref?: Ref;
  note?: string;
  width: number;
}

interface AirRow {
  doc: AirRowDoc;
  /** The casing's top-left corner (its left end cap) and the column of its right end cap. */
  top: number;
  left: number;
  right: number;
  sections: Placed[];
  /** Stretches of duct put between the sections. */
  spacers: { x: number; width: number }[];
  /** Coils whose piping the row draws itself, because no pipe reaches them. */
  coils: Placed[];
  from?: End;
  to?: End;
  flow?: Ref;
  /** Everything the row draws, which pipes keep out of. */
  box: Box;
}

interface Route {
  doc: PipeDoc;
  points: [number, number][];
  flow?: Ref;
  /** The parts at its ends: the marks stop when one of them is stopped. */
  ends: Placed[];
}

/** A document laid out: where everything goes and the way each pipe takes. It does not change with the values. */
export interface Plan {
  doc: GraphicDoc;
  width: number;
  height: number;
  parts: Placed[];
  airRows: AirRow[];
  routes: Route[];
  /** Every ORD the drawing reads. */
  points: string[];
  problems: Problem[];
}

const E = 0;
const S = 1;
const W = 2;
const N = 3;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

interface Port {
  x: number;
  y: number;
  /** The way a pipe leaves it. */
  heading: number;
}

function refOf(value: Binding | undefined, base: string | undefined): Ref | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return { fixed: value };
  const ord = resolvePoint(typeof value === "string" ? value : value.point, base);
  if (!ord) return undefined;
  return typeof value === "string" ? { ord } : { ord, min: value.min, max: value.max };
}
const ordOf = (ref: Ref | undefined) => (ref && "ord" in ref ? ref.ord : undefined);

/** The room kept for readings, by place in the document. A plan made with more room than the default never needs to move again. */
export type Room = Record<string, number>;

function place(doc: PartDoc, at: string, base: string | undefined, reserve: Room): Placed {
  const def = doc.symbol ? SYMBOL.get(doc.symbol) : undefined;
  const refs = {
    value: refOf(doc.value, base), aux: refOf(doc.aux, base), on: refOf(doc.on, base), open: refOf(doc.open, base), reading: refOf(doc.reading, base),
    status: doc.status && !(STATUSES as string[]).includes(doc.status) ? resolvePoint(doc.status, base) : undefined
  };
  const points = [...new Set([ordOf(refs.reading), ordOf(refs.value), ordOf(refs.on), ordOf(refs.aux), ordOf(refs.open), refs.status].filter((o): o is string => !!o))];
  const room = Math.max(reserve[at] ?? 0, doc.note !== undefined ? len(doc.note) : def && isSection(def) ? SECTION_READING : READING);
  let w: number;
  let h: number;
  // The sprite a part is laid out with: its size does not change with the values afterwards.
  if (def) [w, h] = sizeOf(def.draw({ text: def.id === "plate" ? " ".repeat(room) : doc.text, title: doc.label, width: doc.width, medium: doc.medium }, 0));
  else {
    // A text tag: its name, and a reading under it when it has one.
    const reading = refs.reading !== undefined || doc.note !== undefined;
    w = Math.max(len(doc.label ?? ""), reading ? room : 0);
    h = reading ? 2 : 1;
  }
  return { at, doc, def, box: { x: 0, y: 0, w, h }, room, refs, points };
}

/** Whether a part prints a reading beside its name. */
const showsReading = (p: Placed) => !!p.def && !READS_INSIDE.has(p.def.id) && (p.refs.reading !== undefined || p.doc.note !== undefined || p.refs.value !== undefined);
const showsLabel = (p: Placed) => !!p.def && p.def.id !== "plate" && (!!p.doc.label || showsReading(p));

/** The ports of a placed part: the symbol's own, and the middle of each side. */
function portsOf(p: Placed): Record<string, Port> {
  const { x, y, w, h } = p.box;
  const ports: Record<string, Port> = {};
  if (!p.def) {
    // A tag takes pipes at the row of its reading (or its name), on either side.
    ports.left = { x: x - 1, y: y + h - 1, heading: W };
    ports.right = { x: x + w, y: y + h - 1, heading: E };
    ports.in = ports.left;
    ports.out = ports.right;
    return ports;
  }
  ports.left = { x: x - 1, y: y + Math.floor(h / 2), heading: W };
  ports.right = { x: x + w, y: y + Math.floor(h / 2), heading: E };
  ports.top = { x: x + Math.floor(w / 2), y: y - 1, heading: N };
  ports.bottom = { x: x + Math.floor(w / 2), y: y + h, heading: S };
  for (const [name, [px, py]] of Object.entries(p.def.ports ?? {})) {
    const heading = py >= h ? S : py < 0 ? N : px < 0 ? W : px >= w ? E : px < w / 2 ? W : E;
    ports[name] = { x: x + px, y: y + py, heading };
  }
  return ports;
}

/** The port a pipe end uses: the one it names, else the outlet or inlet, and for a text tag the side that faces the other end. */
function pickPort(p: Placed, named: string | undefined, side: "from" | "to", other?: { box: Box }): (Port & { name: string }) | undefined {
  const ports = portsOf(p);
  const facing = other && other.box.x + other.box.w / 2 < p.box.x + p.box.w / 2 ? "left" : "right";
  const name = named ?? (!p.def && other ? facing : side === "from" ? (ports.out ? "out" : "right") : ports.in ? "in" : "left");
  return ports[name] ? { ...ports[name], name } : undefined;
}

const endOf = (value: EndDoc | undefined, at: string, base: string | undefined, reserve: Room): End | undefined => {
  if (value === undefined) return undefined;
  const label = typeof value === "string" ? value : value.label;
  const ref = typeof value === "string" ? undefined : refOf(value.reading, base);
  const note = typeof value === "string" ? undefined : value.note;
  return { at, label, ref, note, x: 0, width: Math.max(len(label), note !== undefined ? len(note) : ref ? Math.max(SECTION_READING, reserve[at] ?? 0) : 0) };
};

/**
 * Lays a checked document out and routes its pipes. Problems it finds (a pipe with no way through)
 * come back with the plan. `reserve` widens the room kept for readings that turned out longer.
 */
export function planGraphic(doc: GraphicDoc, reserve: Room = {}): Plan {
  const problems: Problem[] = [];
  const base = doc.base;
  const parts: Placed[] = [];
  const airRows: AirRow[] = [];
  const byId = new Map<string, { part?: Placed; air?: AirRow }>();

  // Which parts have a pipe on a port that points down: their names go above them, out of the pipe's way.
  const pipes = doc.pipes ?? [];
  const split = (end: string): [string, string | undefined] => {
    const dot = end.indexOf(".");
    return dot < 0 ? [end, undefined] : [end.slice(0, dot), end.slice(dot + 1)];
  };
  const piped = new Map<string, Set<string>>();
  for (const pipe of pipes) for (const side of [pipe.from, pipe.to]) {
    const [id, port] = split(side);
    if (!piped.has(id)) piped.set(id, new Set());
    if (port) piped.get(id)!.add(port);
  }
  const pipedDown = (p: Placed) => !!p.doc.id && !!p.def && [...(piped.get(p.doc.id) ?? [])].some((name) => name === "bottom" || (p.def!.ports?.[name]?.[1] ?? -1) >= p.box.h);

  // ---- Each row on its own, from its own top-left corner ----
  interface RowPlan {
    width: number;
    height: number;
    parts: Placed[];
    air?: AirRow;
    /** Areas pipes keep out of, besides the parts themselves. */
    solid: Box[];
  }
  const rows: RowPlan[] = doc.rows.map((row, r) => {
    if ("air" in row) {
      const sections = row.air.map((p, i) => place(p, `rows[${r}].air[${i}]`, base, reserve));
      const from = endOf(row.from, `rows[${r}].from`, base, reserve);
      const to = endOf(row.to, `rows[${r}].to`, base, reserve);
      const labelWidth = (p: Placed) => (showsLabel(p) ? Math.max(len(p.doc.label ?? ""), showsReading(p) ? p.room : 0) : 0);
      // The inlet: the name, a stub of duct, then the casing's end cap.
      const stubStart = from ? len(from.label) + 1 : 0;
      const left = Math.max(stubStart + STUB - 1, from ? from.width + 1 : 0);
      let x = left + 1;
      const spacers: { x: number; width: number }[] = [];
      sections.forEach((p, i) => {
        const before = sections[i - 1];
        if (before) {
          // Air between two sections, and more of it when their names would run into each other.
          const explicit = p.def!.id === "airflow" || before.def!.id === "airflow";
          const need = labelWidth(before) && labelWidth(p) ? Math.ceil((labelWidth(before) + labelWidth(p)) / 2 + 1 - (before.box.w + p.box.w) / 2) : 0;
          const width = explicit ? 0 : Math.max(before.def!.id === "louver" ? 0 : 3, need);
          if (width > 0) spacers.push({ x, width });
          x += width;
        }
        p.box.x = x;
        p.box.y = AIR_HEAD;
        if (showsLabel(p)) p.label = { x: x + Math.floor(p.box.w / 2), y: 0, width: Math.max(labelWidth(p), p.box.w), reading: showsReading(p) };
        x += p.box.w;
      });
      if (sections[sections.length - 1].def!.id !== "airflow") {
        spacers.push({ x, width: 4 });
        x += 4;
      }
      const right = x;
      if (to) to.x = right + STUB + 3;
      const coils = sections.filter((p) => COILS.has(p.def!.id) && !(p.doc.id && piped.get(p.doc.id)?.size));
      const anyPiping = sections.some((p) => COILS.has(p.def!.id));
      const width = right + STUB + 2 + (to ? 1 + to.width : 0);
      const height = AIR_HEAD + CASING + (anyPiping ? COIL_PIPING : 0);
      const air: AirRow = { doc: row, top: AIR_HEAD, left, right, sections, spacers, coils, from, to, flow: refOf(row.flow, base), box: { x: 0, y: 0, w: width, h: AIR_HEAD + CASING } };
      const solid: Box[] = [air.box, ...coils.map((p) => ({ x: p.box.x, y: AIR_HEAD + CASING, w: p.box.w, h: COIL_PIPING }))];
      return { width, height, parts: sections, air, solid };
    }
    // Equipment side by side; an array is a column. Equipment stands on one floor line, names under it.
    const columns = row.parts.map((item, i) => (Array.isArray(item) ? item.map((p, j) => place(p, `rows[${r}].parts[${i}][${j}]`, base, reserve)) : [place(item, `rows[${r}].parts[${i}]`, base, reserve)]));
    const blockOf = (p: Placed) => {
      const lines = showsLabel(p) ? (showsReading(p) ? 2 : 1) : 0;
      const width = Math.max(p.box.w, showsLabel(p) ? Math.max(len(p.doc.label ?? ""), showsReading(p) ? p.room : 0) : 0);
      return { lines, width, above: lines > 0 && pipedDown(p) };
    };
    const local = new Map<string, Placed>();
    const solid: Box[] = [];
    const gap = columns.flat().some((p) => p.doc.id && piped.has(p.doc.id)) ? GAP_X : GAP_X_PLAIN;
    let x = 0;
    const floating: Placed[][] = [];
    for (const column of columns) {
      const width = Math.max(...column.map((p) => blockOf(p).width));
      // Stack the column upwards from the floor (row 0): the last part stands on it.
      let floor = 0;
      for (const p of [...column].reverse()) {
        const block = blockOf(p);
        p.box.x = x + Math.floor((width - p.box.w) / 2);
        const below = block.above ? 0 : block.lines;
        // Names under the floor line for the part that stands on it; higher parts make room for theirs.
        const bottom = floor === 0 ? 0 : floor - below;
        p.box.y = bottom - p.box.h;
        if (block.lines) p.label = { x: x + Math.floor(width / 2), y: block.above ? p.box.y - block.lines : p.box.y + p.box.h, width, reading: block.lines === 2 };
        floor = p.box.y - (block.above ? block.lines : 0) - 1;
        if (p.doc.id) local.set(p.doc.id, p);
      }
      if (column.every((p) => !p.def)) floating.push(column);
      x += width + gap;
    }
    // A column of text tags has no floor to stand on: it moves up or down until its first piped tag
    // is level with the port at the other end of that pipe.
    for (const column of floating) {
      for (const tag of column) {
        const pipe = pipes.find((q) => split(q.from)[0] === tag.doc.id || split(q.to)[0] === tag.doc.id);
        if (!pipe || !tag.doc.id) continue;
        const tagIsFrom = split(pipe.from)[0] === tag.doc.id;
        const [otherId, otherPort] = split(tagIsFrom ? pipe.to : pipe.from);
        const other = local.get(otherId);
        if (!other || column.includes(other)) continue;
        const port = pickPort(other, otherPort, tagIsFrom ? "to" : "from", tag);
        if (!port) continue;
        const shift = port.y - (tag.box.y + tag.box.h - 1);
        for (const p of column) p.box.y += shift;
        break;
      }
    }
    for (const p of columns.flat()) if (p.label) solid.push({ x: p.label.x - Math.floor(p.label.width / 2), y: p.label.y, w: p.label.width, h: p.label.reading && p.doc.label ? 2 : 1 });
    // Row coordinates start at the highest thing in it.
    const all = columns.flat();
    const top = Math.min(...all.map((p) => Math.min(p.box.y, p.label?.y ?? p.box.y)));
    const bottom = Math.max(...all.map((p) => Math.max(p.box.y + p.box.h, p.label ? p.label.y + (p.label.reading && p.doc.label ? 2 : 1) : 0)));
    for (const p of all) {
      p.box.y -= top;
      if (p.label) p.label.y -= top;
    }
    for (const box of solid) box.y -= top;
    return { width: x - gap, height: bottom - top, parts: all, solid };
  });

  // ---- The rows stacked, each centred ----
  const inner = Math.max(...rows.map((row) => row.width));
  const width = inner + MARGIN_X * 2;
  let y = MARGIN_Y;
  const solid: Box[] = [];
  const used: Box[] = [];
  for (const row of rows) {
    const dx = MARGIN_X + Math.floor((inner - row.width) / 2);
    used.push({ x: dx, y, w: row.width, h: row.height });
    for (const p of row.parts) {
      p.box.x += dx;
      p.box.y += y;
      if (p.label) {
        p.label.x += dx;
        p.label.y += y;
      }
      parts.push(p);
      if (p.doc.id) byId.set(p.doc.id, { part: p });
    }
    for (const box of row.solid) solid.push({ ...box, x: box.x + dx, y: box.y + y });
    if (row.air) {
      const air = row.air;
      air.box = { ...air.box, x: air.box.x + dx, y: air.box.y + y };
      air.top += y;
      air.left += dx;
      air.right += dx;
      for (const spacer of air.spacers) spacer.x += dx;
      if (air.from) air.from.x += dx;
      if (air.to) air.to.x += dx;
      airRows.push(air);
      if (air.doc.id) byId.set(air.doc.id, { air });
    }
    y += row.height + GAP_Y;
  }
  const height = y - GAP_Y + MARGIN_Y;

  // ---- Pipes: a way through for each, around the equipment and the text ----
  const blocked = new Uint8Array(width * height);
  const block = (box: Box, value: number) => {
    for (let by = Math.max(0, box.y); by < Math.min(height, box.y + box.h); by += 1) for (let bx = Math.max(0, box.x); bx < Math.min(width, box.x + box.w); bx += 1) blocked[by * width + bx] = value;
  };
  for (const p of parts) if (!airRows.some((air) => air.sections.includes(p))) block(p.box, 1);
  for (const box of solid) block(box, 1);

  const portAt = (end: string, side: "from" | "to", at: string, otherEnd: string): { port: Port; part?: Placed; own: Box; key: string } | undefined => {
    const [id, named] = split(end);
    const target = byId.get(id);
    if (!target) return void problems.push({ level: "error", at, message: `No part has the id "${id}".${nearest(id, [...byId.keys()])}` });
    if (target.air) {
      const air = target.air;
      const name = named ?? (side === "from" ? "out" : "in");
      const mid = air.top + 2;
      const ports: Record<string, Port> = { in: { x: air.left - STUB, y: mid, heading: W }, out: { x: air.right + STUB + 1, y: mid, heading: E } };
      if (!ports[name]) return void problems.push({ level: "error", at, message: `An air path has the ports in and out, not "${name}". Its coils have their own: give the coil an id and use its supply and return.` });
      return { port: ports[name], own: air.box, key: `${id}.${name}` };
    }
    const p = target.part!;
    const other = byId.get(split(otherEnd)[0]);
    const port = pickPort(p, named, side, other?.part ?? other?.air);
    if (!port) return void problems.push({ level: "error", at, message: `"${id}" (${p.def?.id ?? "a text tag"}) has no port "${named}". It has: ${Object.keys(portsOf(p)).join(", ")}.` });
    return { port, part: p, own: p.box, key: `${id}.${port.name}` };
  };

  // Both ends of every pipe, then the two cells in front of each port kept for the pipes that use
  // it: otherwise one pipe turning a corner there shuts its neighbour's port in.
  const ends = pipes.map((pipe, index) => ({ from: portAt(pipe.from, "from", `pipes[${index}].from`, pipe.to), to: portAt(pipe.to, "to", `pipes[${index}].to`, pipe.from) }));
  const portKeys = [...new Set(ends.flatMap((e) => [e.from?.key, e.to?.key]).filter((k): k is string => !!k))];
  const kept = new Int16Array(width * height);
  for (const end of ends.flatMap((e) => [e.from, e.to])) {
    if (!end) continue;
    // A port inside its own symbol's box (a cooling tower's basin, an air path's inlet) opens a way out to the edge.
    const within = (px: number, py: number) => px >= end.own.x && py >= end.own.y && px < end.own.x + end.own.w && py < end.own.y + end.own.h;
    let px = end.port.x;
    let py = end.port.y;
    for (; within(px, py); px += DX[end.port.heading], py += DY[end.port.heading]) blocked[py * width + px] = 0;
    for (let n = 0; n < 2; n += 1, px += DX[end.port.heading], py += DY[end.port.heading]) {
      const cell = py * width + px;
      if (px >= 0 && py >= 0 && px < width && py < height && !blocked[cell] && !kept[cell]) kept[cell] = portKeys.indexOf(end.key) + 1;
    }
  }

  // Cells right beside equipment or text cost a little more, so a pipe keeps a cell's distance when it can.
  const beside = new Uint8Array(width * height);
  for (let cy = 0; cy < height; cy += 1) for (let cx = 0; cx < width; cx += 1) {
    const cell = cy * width + cx;
    if (blocked[cell] || kept[cell]) continue;
    if ((cx > 0 && blocked[cell - 1]) || (cx < width - 1 && blocked[cell + 1]) || (cy > 0 && blocked[cell - width]) || (cy < height - 1 && blocked[cell + width])) beside[cell] = 1;
  }

  // Cells other pipes already run along, by direction, as the pipe's number plus one.
  const alongH = new Int16Array(width * height);
  const alongV = new Int16Array(width * height);
  const routes: Route[] = [];
  pipes.forEach((pipe, index) => {
    const { from, to } = ends[index];
    if (!from || !to) return;
    const mine = [portKeys.indexOf(from.key) + 1, portKeys.indexOf(to.key) + 1];
    const open = (cell: number) => !blocked[cell] && (kept[cell] === 0 || mine.includes(kept[cell]));
    const kind = pipe.kind ?? "pipe";
    const shares = (other: number) => (pipes[other].kind ?? "pipe") === kind && (ends[other].from?.key === from.key || ends[other].to?.key === to.key);
    const cells = findWay(width, height, open, beside, alongH, alongV, index, shares, from.port, to.port);
    if (!cells) return void problems.push({ level: "error", at: `pipes[${index}]`, message: `No way through from ${pipe.from} to ${pipe.to}. Put the two parts in neighbouring columns or rows, or list this pipe earlier.` });
    cells.forEach(([cx, cy], i) => {
      const before = cells[i - 1];
      const after = cells[i + 1];
      const horizontal = (before && before[1] === cy) || (after && after[1] === cy);
      const vertical = (before && before[0] === cx) || (after && after[0] === cx);
      if (horizontal && !alongH[cy * width + cx]) alongH[cy * width + cx] = index + 1;
      if (vertical && !alongV[cy * width + cx]) alongV[cy * width + cx] = index + 1;
    });
    // Only the corners, which is what a route is drawn from.
    const points = cells.filter(([cx, cy], i) => i === 0 || i === cells.length - 1 || (cells[i - 1][0] === cx) !== (cells[i + 1][0] === cx));
    routes.push({ doc: pipe, points, flow: refOf(pipe.flow, base), ends: [from.part, to.part].filter((p): p is Placed => !!p) });
  });

  // The margins were room for pipes to go round. What no pipe used is cut off again.
  for (const route of routes) for (const [px, py] of route.points) used.push({ x: px, y: py, w: 1, h: 1 });
  const x0 = Math.min(...used.map((box) => box.x));
  const y0 = Math.min(...used.map((box) => box.y));
  const move = (box: Box) => {
    box.x -= x0;
    box.y -= y0;
  };
  for (const p of parts) {
    move(p.box);
    if (p.label) move(p.label as unknown as Box);
  }
  for (const air of airRows) {
    move(air.box);
    air.top -= y0;
    air.left -= x0;
    air.right -= x0;
    for (const spacer of air.spacers) spacer.x -= x0;
    if (air.from) air.from.x -= x0;
    if (air.to) air.to.x -= x0;
  }
  for (const route of routes) route.points = route.points.map(([px, py]) => [px - x0, py - y0]);
  const cropped = { width: Math.max(...used.map((box) => box.x + box.w)) - x0, height: Math.max(...used.map((box) => box.y + box.h)) - y0 };

  const points = new Set<string>();
  for (const p of parts) for (const ord of p.points) points.add(ord);
  for (const air of airRows) for (const ord of [ordOf(air.flow), ordOf(air.from?.ref), ordOf(air.to?.ref)]) if (ord) points.add(ord);
  for (const route of routes) if (ordOf(route.flow)) points.add(ordOf(route.flow)!);
  return { doc, width: cropped.width, height: cropped.height, parts, airRows, routes, points: [...points], problems };
}

/**
 * The cheapest way from one port to another, as cells: straight steps cost one and a turn four
 * more, so it takes few bends. It leaves and arrives straight, keeps out of blocked cells, may
 * cross another pipe but not run along it, unless both start or end at the same port (a branch).
 */
function findWay(width: number, height: number, open: (cell: number) => boolean, beside: Uint8Array, alongH: Int16Array, alongV: Int16Array, self: number, shares: (other: number) => boolean, from: Port, to: Port): [number, number][] | undefined {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inside(from.x, from.y) || !inside(to.x, to.y) || !open(from.y * width + from.x) || !open(to.y * width + to.x)) return undefined;
  // Whole doubles: a rounded-off cost would look out of date next to the one queued for it.
  const cost = new Float64Array(width * height * 4).fill(Infinity);
  const previous = new Int32Array(width * height * 4).fill(-1);
  const start = (from.y * width + from.x) * 4 + from.heading;
  const arriving = (to.heading + 2) % 4;
  const goal = (to.y * width + to.x) * 4 + arriving;
  cost[start] = 0;
  // A small binary heap of [cost, state].
  const heap: [number, number][] = [[0, start]];
  const push = (item: [number, number]) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const a = i * 2 + 1;
        const b = a + 1;
        let least = i;
        if (a < heap.length && heap[a][0] < heap[least][0]) least = a;
        if (b < heap.length && heap[b][0] < heap[least][0]) least = b;
        if (least === i) break;
        [heap[least], heap[i]] = [heap[i], heap[least]];
        i = least;
      }
    }
    return top;
  };
  const taken = (cell: number, horizontal: boolean) => {
    const other = (horizontal ? alongH : alongV)[cell];
    return other !== 0 && other - 1 !== self && !shares(other - 1);
  };
  /** A stretch a branch of the same pipe already runs along: cheaper, so branches stay together as long as they can. */
  const trunk = (cell: number, horizontal: boolean) => (horizontal ? alongH : alongV)[cell] !== 0;
  while (heap.length) {
    const [c, state] = pop();
    if (c > cost[state]) continue;
    if (state === goal) break;
    const d = state % 4;
    const cell = (state - d) / 4;
    const x = cell % width;
    const y = (cell - x) / width;
    for (let nd = 0; nd < 4; nd += 1) {
      if (nd === (d + 2) % 4) continue;
      // Leave the port straight, and do not bend on top of another pipe.
      if (nd !== d && (state === start || taken(cell, true) || taken(cell, false))) continue;
      const nx = x + DX[nd];
      const ny = y + DY[nd];
      if (!inside(nx, ny)) continue;
      const next = ny * width + nx;
      if (!open(next)) continue;
      const horizontal = nd === E || nd === W;
      if (taken(next, horizontal)) continue;
      // Reach the far port only in the direction that meets it.
      if (nx === to.x && ny === to.y && nd !== arriving) continue;
      const step = (trunk(next, horizontal) ? 0.5 : 1 + beside[next] * 0.6) + (nd !== d ? 4 : 0) + (taken(next, !horizontal) ? 6 : 0);
      const nextState = next * 4 + nd;
      if (c + step < cost[nextState]) {
        cost[nextState] = c + step;
        previous[nextState] = state;
        push([c + step, nextState]);
      }
    }
  }
  if (cost[goal] === Infinity) return undefined;
  const cells: [number, number][] = [];
  for (let state = goal; state !== -1; state = previous[state]) {
    const cell = (state - (state % 4)) / 4;
    cells.unshift([cell % width, (cell - (cell % width)) / width]);
  }
  return cells;
}

// ---- Drawing it for a frame -----------------------------------------------------------------------

const truthy = (value: unknown): boolean => (typeof value === "boolean" ? value : typeof value === "number" ? value > 0 : typeof value === "string" ? /^(true|on|active|running|open|1)$/i.test(value) : false);

function numberOf(ref: Ref | undefined, values: Values): number | undefined {
  if (!ref) return undefined;
  const raw = "fixed" in ref ? ref.fixed : values(ref.ord)?.value;
  if (typeof raw === "boolean") return raw ? 100 : 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if ("ord" in ref && ref.min !== undefined && ref.max !== undefined) return Math.max(0, Math.min(100, ((raw - ref.min) / (ref.max - ref.min)) * 100));
  return raw;
}
const flagOf = (ref: Ref | undefined, values: Values): boolean | undefined => (!ref ? undefined : "fixed" in ref ? truthy(ref.fixed) : values(ref.ord) ? truthy(values(ref.ord)!.value) : undefined);

function textOf(ref: Ref | undefined, values: Values): string | undefined {
  if (!ref) return undefined;
  if ("fixed" in ref) return typeof ref.fixed === "number" ? `${Math.round(ref.fixed * 10) / 10}` : ref.fixed ? "On" : "Off";
  const point = values(ref.ord);
  if (!point) return "…";
  if (point.ok === false) return "?";
  return point.displayValue ?? (point.value === undefined || point.value === null ? "—" : String(point.value));
}

/** The worst status among a part's points; a point that cannot be read counts as stale. */
const RANK: Record<string, number> = { alarm: 5, fault: 4, down: 3, stale: 2, overridden: 1 };
function statusOf(ords: string[], values: Values): Status | undefined {
  let worst: Status | undefined;
  for (const ord of ords) {
    const point = values(ord);
    if (!point) continue;
    const state = point.ok === false || point.state === "disabled" ? "stale" : point.state ?? "ok";
    if (RANK[state] && RANK[state] > (worst ? RANK[worst] : 0)) worst = state as Status;
  }
  return worst;
}

/** What a part looks like now: the state its symbol is drawn in, and the reading printed with it. */
export function partNow(p: Placed, values: Values): { state: SymbolState; reading?: string } {
  const value = numberOf(p.refs.value, values);
  const reading = p.doc.note ?? textOf(p.refs.reading, values) ?? (p.refs.value && "fixed" in p.refs.value && typeof p.refs.value.fixed === "number" ? `${Math.round(p.refs.value.fixed)} %` : textOf(p.refs.value, values));
  const fixedStatus = p.doc.status && (STATUSES as string[]).includes(p.doc.status) ? (p.doc.status as Status) : undefined;
  const state: SymbolState = {
    value,
    aux: numberOf(p.refs.aux, values),
    on: flagOf(p.refs.on, values) ?? (value !== undefined && p.def?.uses.includes("on") ? value > 0 : undefined),
    open: flagOf(p.refs.open, values),
    status: fixedStatus ?? statusOf(p.refs.status ? [p.refs.status] : p.points, values),
    medium: p.doc.medium,
    text: p.doc.text,
    title: p.doc.label,
    width: p.doc.width
  };
  if (p.def?.id === "plate") state.text = clipTo(reading ?? "", p.room).padEnd(p.room);
  else if (p.def?.id === "cold-room" && state.text === undefined) state.text = reading ?? "";
  return { state, reading };
}

/** Readings that are longer than the room the plan kept for them: plan again with these and they fit. */
export function roomNeeded(plan: Plan, values: Values): Room | undefined {
  const grown: Room = {};
  for (const p of plan.parts) {
    if (p.doc.note !== undefined) continue;
    const needed = len(partNow(p, values).reading ?? "");
    if (needed > p.room) grown[p.at] = needed;
  }
  for (const air of plan.airRows) for (const end of [air.from, air.to]) {
    const needed = end && end.note === undefined ? len(textOf(end.ref, values) ?? "") : 0;
    if (end && needed > end.width) grown[end.at] = needed;
  }
  return Object.keys(grown).length ? grown : undefined;
}

const CAP_LEFT: Sprite = { rows: ["╭", "│", " ", "│", "╰"], paint: ["f", "f", " ", "f", "f"] };
const CAP_RIGHT: Sprite = { rows: ["╮", "│", " ", "│", "╯"], paint: ["f", "f", " ", "f", "f"] };
const TAG: Partial<Record<Medium, string>> = { chw: "CHW", hw: "HW", cw: "CW", steam: "STM", refrigerant: "REF" };

/** The drawing for one frame, with the points' values as they are now. `selected` is a part's place in the document. */
export function drawGraphic(plan: Plan, values: Values, frame: number, options: { selected?: string } = {}): Canvas {
  const canvas = new Canvas(plan.width, plan.height);
  const muted: Style = { color: theme.muted };
  const now = new Map(plan.parts.map((p) => [p, partNow(p, values)]));
  const label = (p: Placed) => {
    if (!p.label) return;
    const { state, reading } = now.get(p)!;
    const picked = options.selected === p.at;
    if (p.doc.label) canvas.center(p.label.x, p.label.y, clipTo(p.doc.label, p.label.width), picked ? { inverse: true, bold: true } : muted);
    if (p.label.reading) canvas.center(p.label.x, p.label.y + (p.doc.label ? 1 : 0), clipTo(reading ?? "", p.label.width), { bold: true, color: state.status === "alarm" ? theme.bad : state.status === "stale" || state.status === "down" ? theme.warn : undefined });
  };

  // Pipes first, so equipment and text sit on top of them.
  for (const route of plan.routes) {
    const medium = route.doc.medium ?? (route.doc.kind === "duct" ? "air" : undefined);
    const flowing = flagOf(route.flow, values) ?? route.ends.every((p) => !p.def || moving(now.get(p)!.state));
    canvas.route(route.points, { kind: route.doc.kind, color: theme.faint, flow: flowing ? { direction: 1, frame: Math.floor(frame / 2), spacing: 4, color: mediumColor(medium) } : undefined });
  }

  for (const air of plan.airRows) {
    const fans = air.sections.filter((p) => p.def!.id === "fan");
    const flowing = flagOf(air.flow, values) ?? (fans.length === 0 || fans.some((p) => moving(now.get(p)!.state)));
    const mid = air.top + 2;
    const duct = { kind: "duct" as const, color: theme.faint, flow: flowing ? { direction: 1 as const, frame, spacing: 3, color: mediumColor("air") } : undefined };
    canvas.route([[air.left - STUB + 1, mid], [air.left, mid]], duct);
    canvas.sprite(air.left, air.top, CAP_LEFT, (letter) => paint(letter, {}));
    for (const spacer of air.spacers) canvas.sprite(spacer.x, air.top, SYMBOL.get("airflow")!.draw({ width: spacer.width, on: flowing }, frame), (letter) => paint(letter, { on: flowing }));
    for (const p of air.sections) {
      const state = p.def!.id === "airflow" ? { ...now.get(p)!.state, on: now.get(p)!.state.on ?? flowing } : now.get(p)!.state;
      canvas.sprite(p.box.x, p.box.y, p.def!.draw(state, frame), (letter) => paint(letter, state));
      label(p);
    }
    canvas.sprite(air.right, air.top, CAP_RIGHT, (letter) => paint(letter, {}));
    canvas.route([[air.right + 1, mid], [air.right + STUB, mid]], duct);
    for (const [end, x] of [[air.from, air.from?.x ?? 0], [air.to, air.to?.x ?? 0]] as const) {
      if (!end) continue;
      canvas.text(x, air.top + 1, end.label, { bold: true });
      const under = end.note ?? textOf(end.ref, values);
      if (under) canvas.text(x, air.top + 3, clipTo(under, end.width), muted);
    }
    // Each coil nothing is piped to: supply up one leg, return down the other through a valve.
    for (const p of air.coils) {
      const state = now.get(p)!.state;
      const medium = state.medium ?? (p.def!.id === "heating-coil" ? "hw" : "chw");
      const color = mediumColor(medium);
      const open = moving(state) && (state.value ?? 0) > 0;
      const supply = p.box.x + 1;
      const back = p.box.x + 4;
      const bottom = air.top + CASING;
      const flow = open ? { direction: 1 as const, frame: Math.floor(frame / 2), spacing: 3, color } : undefined;
      canvas.route([[supply, bottom + 4], [supply, bottom - 1]], { color: theme.faint, flow });
      canvas.route([[back, bottom - 1], [back, bottom + 4]], { color: theme.faint, flow });
      const valve = { value: state.value, medium, status: state.status, vertical: true };
      canvas.sprite(back, bottom + 1, SYMBOL.get("valve")!.draw(valve, frame), (letter) => paint(letter, valve));
      canvas.center(supply + 1, bottom + 5, TAG[medium] ?? medium.toUpperCase(), { color });
    }
  }

  for (const p of plan.parts) {
    if (plan.airRows.some((air) => air.sections.includes(p))) continue;
    const { state, reading } = now.get(p)!;
    if (p.def) {
      canvas.sprite(p.box.x, p.box.y, p.def.draw(state, frame), (letter) => paint(letter, state));
      label(p);
    } else {
      // A text tag: its name, then its reading in the colour of what the pipe carries.
      canvas.text(p.box.x, p.box.y, p.doc.label ?? "", options.selected === p.at ? { inverse: true, bold: true } : { bold: true });
      if (p.box.h > 1) canvas.text(p.box.x, p.box.y + 1, clipTo(reading ?? "", p.box.w), { color: state.status === "alarm" ? theme.bad : mediumColor(p.doc.medium) });
    }
  }
  return canvas;
}

/** Checks, lays out and (when nothing stops it) returns the plan for a document that came from JSON. */
export function readGraphic(input: unknown, reserve: Room = {}): { plan?: Plan; problems: Problem[] } {
  const checked = checkGraphic(input);
  if (!checked.doc) return { problems: checked.problems };
  const plan = planGraphic(checked.doc, reserve);
  return { plan, problems: [...checked.problems, ...plan.problems] };
}

// ---- The guide an agent reads before drawing one ---------------------------------------------------

/** How to write a graphic, with the symbol list taken from the library so it is never out of date. */
export function graphicGuide(): string {
  const row = (def: SymbolDef) => {
    const [w, h] = sizeOf(def.draw(def.sample, 0));
    const ports = isSection(def) ? Object.keys(def.ports ?? {}) : ["left", "right", "top", "bottom", ...Object.keys(def.ports ?? {})];
    return `| ${def.id} | ${w} x ${h} | ${def.value ?? ""}${def.aux ? `; aux: ${def.aux}` : ""} | ${ports.join(", ")} | ${def.note} |`;
  };
  const table = (defs: SymbolDef[]) => ["| symbol | size | value means | ports | what it draws |", "| --- | --- | --- | --- | --- |", ...defs.map(row)].join("\n");
  return `# Drawing a graphic for bask

A graphic is a small JSON file: equipment from the symbol library, tied to the station's points. It is
drawn in the terminal, moving, with live values. You write no coordinates: bask places the parts and
finds the way for each pipe.

## Steps
1. Find the points: \`bask search "<name>"\`, \`bask browse <ord>\`.
2. Write the file, e.g. ahu-01.json.
3. \`bask graphic print ahu-01.json\` prints the drawing as text with the live values, and lists anything wrong. Read it and fix the file until it looks right.
4. \`bask graphic save ahu-01.json --allow-writes -y --reason "<why>"\` stores it on the station (${"`^bask/graphics/ahu-01.json`"}) and opens it in the person's Graphics pane.
Also: \`bask graphic list\`, \`bask graphic get <name>\` (the saved JSON), \`bask graphic show <name>\`, \`bask graphic rm <name>\`.

## The file
\`\`\`json
{
  "title": "AHU-1",
  "base": "slot:/Drivers/BacnetNetwork/AHU_01/points",
  "rows": [
    { "air": [
        { "symbol": "louver" },
        { "symbol": "damper", "label": "OA damper", "value": "OaDamperCmd" },
        { "symbol": "filter", "label": "Filter", "reading": "FilterDP" },
        { "symbol": "cooling-coil", "label": "Cooling", "value": "CoolingValve" },
        { "symbol": "fan", "label": "Supply fan", "value": "SupplyFanSpeed", "on": "SupplyFanStatus" },
        { "symbol": "sensor", "label": "Supply air", "text": "T", "reading": "SupplyAirTemp" }
      ],
      "from": { "label": "OA", "reading": "OutdoorAirTemp" }, "to": "SA" }
  ]
}
\`\`\`
- \`rows\` stack top to bottom. A row is either \`{"air": [...]}\` or \`{"parts": [...]}\`.
- **An air row** is an air path: its sections join into one casing, air marks are put between them, and each coil gets its supply and return legs with a valve. \`from\` and \`to\` name the two ends (a name, or \`{"label", "reading"}\`). The air moves while a fan in the row runs. It takes only the section symbols.
- **A parts row** is equipment side by side. An array inside \`parts\` is a column: its parts stack top to bottom (two pumps in parallel, a supply tag over a return tag). It takes the symbols that stand on their own.
- **A part with no symbol** is a text tag (a name and a reading): the end of a pipe that leaves the drawing.

## What a part can say
| key | meaning |
| --- | --- |
| symbol | a symbol id from the tables below |
| id | a name, needed only for parts that pipes join |
| label | the name printed with it |
| value | 0 to 100: the symbol's position, speed, load or level |
| on | whether it runs. Left out, a part with a value runs while the value is above zero |
| reading | what is printed under the name. Left out, it is the value's point |
| note | fixed text printed instead of a reading |
| aux, open | a second 0 to 100 value (a VAV box's reheat), a door that is open |
| status | a point whose status colours the part. Left out, it is the worst status among the part's points |
| medium | ${[...MEDIA].join(", ")}: the colour of what flows |
| text | the symbol's own text, such as the letter on a sensor |

\`value\`, \`on\`, \`reading\`, \`aux\` and \`open\` each take a number or true/false (fixed), or a point: a full ORD
(\`slot:/...\`) or a path under \`base\`. A point that is not a percentage can be scaled for \`value\`:
\`{"point": "ChwSupplyTemp", "min": 40, "max": 60}\`. Alarm, fault, down, stale and overridden come from the
points by themselves, and so do units and number formats.

## Pipes
\`\`\`json
"pipes": [
  { "from": "ch1.chwOut", "to": "p1.in", "medium": "chw" },
  { "from": "p1", "to": "supply", "medium": "chw" }
]
\`\`\`
\`from\` and \`to\` are \`id.port\`. With no port, \`from\` uses the part's \`out\` (or right side) and \`to\` its \`in\`
(or left side). Every part has \`left\`, \`right\`, \`top\` and \`bottom\`; symbols add the ports in the tables.
An air row with an id has \`in\` and \`out\`; a coil with an id has \`supply\` and \`return\`, and then bask leaves
its piping to you. \`"kind": "duct"\` draws a duct. The marks move unless a part at either end is stopped, or
give \`flow\` a point. Two pipes from the same port share their first stretch, as a branch. If print says
there is no way through, put the parts in neighbouring columns or rows, or change the order of the pipes.

## Symbols for an air row
${table(SYMBOLS.filter(isSection))}

## Symbols for a parts row
${table(SYMBOLS.filter((def) => !isSection(def)))}

## A plant, as an example
\`\`\`json
{
  "title": "Chilled water plant",
  "base": "slot:/Drivers/BacnetNetwork/CHW_Plant/points",
  "rows": [
    { "parts": [
        { "id": "tower", "symbol": "cooling-tower", "label": "Tower", "value": "TowerFanSpeed" },
        { "id": "ch1", "symbol": "chiller", "label": "Chiller 1", "value": "Chiller1Load", "on": "Chiller1Status" },
        { "id": "p1", "symbol": "pump", "label": "CHW pump", "value": "ChwPump1Speed" },
        [ { "id": "supply", "label": "CHW supply", "reading": "ChwSupplyTemp", "medium": "chw" },
          { "id": "return", "label": "CHW return", "reading": "ChwReturnTemp", "medium": "chw" } ]
    ] }
  ],
  "pipes": [
    { "from": "tower.out", "to": "ch1.cwIn", "medium": "cw" },
    { "from": "ch1.cwOut", "to": "tower.in", "medium": "cw" },
    { "from": "ch1.chwOut", "to": "p1.in", "medium": "chw" },
    { "from": "p1.out", "to": "supply", "medium": "chw" },
    { "from": "return.left", "to": "ch1.chwIn", "medium": "chw" }
  ]
}
\`\`\`

## Keep in mind
- Use only points that exist: print marks a missing one with "?" and lists it.
- Keep a graphic to one piece of equipment or one system; it should fit a pane about 100 columns wide. Print says how big it came out.
- Names are short: they are clipped to the part's width.
`;
}
