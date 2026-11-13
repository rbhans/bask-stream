// A wire sheet in text: the components of one folder as blocks, the links between their slots as
// lines, and each slot's live value inside its block. It is for reading and watching logic, not
// for drawing it: the layout is worked out here, left to right the way the values flow.
//
// Everything comes from operations the station already has: browse for the folder, describe_component
// for each block's slots and links, and ordinary point reads for the slot values (any slot of any
// component reads like a point, e.g. slot:/Logic/Reset/inA).
import { toSlotOrd, type BaskStreamClient, type Json } from "@basidekick/baskstream";
import { place } from "./format.js";
import { Canvas, type Style } from "./tui/symbols/canvas.js";
import { E, W, findWay, type PointValue, type Port, type Values } from "./tui/symbols/graphic.js";
import { theme } from "./tui/theme.js";

export interface SheetBlock {
  ord: string;
  name: string;
  /** The type without its module: "Reset" for kitControl:Reset. */
  type: string;
  typeSpec: string;
  /** A folder, device or other container: drawn small, and opened rather than traced. */
  container: boolean;
  /** Not in this folder: the far end of a link that leaves or enters it. */
  outside: boolean;
  /** The slots shown, inputs first and "out" last. */
  slots: string[];
  /** It is a control point (its value can be trended, watched and, if writable, commanded). */
  point: boolean;
  writable: boolean;
  /** What is set on it rather than wired: its settings, and inputs given a fixed value. Not rows on the sheet. */
  settings: { name: string; value: string }[];
}

export interface SheetLink {
  source: string;
  sourceSlot: string;
  target: string;
  targetSlot: string;
}

export interface Sheet {
  folder: string;
  blocks: SheetBlock[];
  links: SheetLink[];
  /** Components in the folder beyond the number a sheet shows. */
  hidden: number;
}

/** Slot flags, from javax.baja.sys.Flags. */
const READONLY = 1;
const HIDDEN = 4;
const SUMMARY = 8;
/** The most components one sheet shows, and the most slot rows in one block. */
export const MAX_BLOCKS = 80;
const MAX_ROWS = 8;

const len = (text: string) => [...text].length;
const clip = (text: string, width: number) => (len(text) <= width ? text : `${[...text].slice(0, Math.max(0, width - 1)).join("")}…`);
const nameOf = (ord: string) => ord.slice(ord.lastIndexOf("/") + 1);
const shortType = (typeSpec: string) => typeSpec.slice(typeSpec.indexOf(":") + 1);
/** Niagara escapes characters in slot names as $xx; show them as typed. */
const plain = (name: string) => name.replace(/\$([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
export const slotOrd = (block: string, slot: string) => `${block}/${slot}`;
export const linkKey = (link: SheetLink) => `${link.source}|${link.sourceSlot}|${link.target}|${link.targetSlot}`;

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

/** The links a describe_component reply carries: both ways from API 1.11, only the ones leaving before that. */
function linksOf(described: Json | undefined): SheetLink[] {
  if (!described) return [];
  const both = described.links as Json[] | undefined;
  const leaving = (((described.dependencies as Json | undefined)?.knownReferences ?? []) as Json[]).filter((r) => r.kind === "incoming_link");
  return (both ?? leaving)
    .filter((l) => typeof l.source === "string" && typeof l.target === "string" && typeof l.sourceSlot === "string" && typeof l.targetSlot === "string")
    .map((l) => ({ source: toSlotOrd(String(l.source)), sourceSlot: String(l.sourceSlot), target: toSlotOrd(String(l.target)), targetSlot: String(l.targetSlot) }));
}

/** Reads one folder as a sheet: its components, the slots worth showing on each, and every link that touches them. */
export async function loadSheet(client: BaskStreamClient, folder: string): Promise<Sheet> {
  const node = await client.browse(folder, { depth: 1 });
  const kids = (node.children ?? []).map((child) => ({ ...child, ord: toSlotOrd(child.ord) }));
  const shown = kids.slice(0, MAX_BLOCKS);
  const described = await pooled(shown, 6, (kid) => (kid.kind === "container" ? Promise.resolve(undefined) : client.call("describe_component", { ord: kid.ord }).then((reply) => reply.result as Json, () => undefined)));

  const links = new Map<string, SheetLink>();
  for (const result of described) for (const link of linksOf(result)) links.set(linkKey(link), link);
  const inside = new Set(shown.map((kid) => kid.ord));
  const linked = new Map<string, Set<string>>();
  const touch = (ord: string, slot: string) => linked.set(ord, (linked.get(ord) ?? new Set()).add(slot));
  for (const link of links.values()) {
    touch(link.source, link.sourceSlot);
    touch(link.target, link.targetSlot);
  }

  const blocks: SheetBlock[] = shown.map((kid, index) => {
    const typeSpec = String(kid.typeSpec ?? "");
    const container = kid.kind === "container";
    const slots = ((described[index]?.slots ?? []) as Json[]).filter((slot) => slot.kind === "property");
    const mine = linked.get(kid.ord) ?? new Set<string>();
    // Linked slots always show. Then "out", then the ones Niagara itself puts on a wire sheet glyph
    // (the summary flag), as far as there is room. Child components and links are not values.
    const value = (slot: Json) => slot.typeSpec !== "baja:Link" && !(slot.value as Json | undefined)?.expand && (Number(slot.flags ?? 0) & HIDDEN) === 0;
    const known = slots.map((slot) => String(slot.name));
    const wanted = [...known.filter((name) => mine.has(name)), ...[...mine].filter((name) => !known.includes(name))];
    for (const slot of slots) {
      const name = String(slot.name);
      if (wanted.length >= MAX_ROWS) break;
      if (!wanted.includes(name) && value(slot) && (name === "out" || (Number(slot.flags ?? 0) & SUMMARY) !== 0)) wanted.push(name);
    }
    const ordered = [...wanted.filter((name) => name !== "out"), ...wanted.filter((name) => name === "out")];
    // What is set rather than wired: writable plain values, and status inputs that hold a value of
    // their own (their status reads ok, which Niagara encodes as 0). These are what a copy has to carry.
    const settings: { name: string; value: string }[] = [];
    for (const slot of slots) {
      const name = String(slot.name);
      if (container || ordered.includes(name) || !value(slot) || (Number(slot.flags ?? 0) & READONLY) !== 0 || name === "displayName") continue;
      const held = slot.value as Json | undefined;
      const inside = (held?.properties as Json | undefined)?.value as Json | undefined;
      const status = String(((held?.properties as Json | undefined)?.status as Json | undefined)?.encoded ?? "");
      const text = typeof held?.encoded === "string" ? held.encoded : inside && typeof inside.encoded === "string" && /^(\{ok\}|0)$/.test(status) ? inside.encoded : undefined;
      if (text !== undefined && text !== "" && settings.length < 14) settings.push({ name, value: text });
    }
    return { ord: kid.ord, name: plain(kid.display ?? kid.name), type: shortType(typeSpec), typeSpec, container, outside: false, slots: container ? [] : ordered, point: kid.kind === "point", writable: kid.writable === true, settings };
  });

  // The far ends of links that leave the folder, as blocks of their own so the wire has somewhere to go.
  for (const [ord, slots] of linked) {
    if (inside.has(ord)) continue;
    blocks.push({ ord, name: place(ord), type: "elsewhere", typeSpec: "", container: false, outside: true, slots: [...slots].sort((a, b) => Number(a === "out") - Number(b === "out")), point: false, writable: false, settings: [] });
  }
  return { folder, blocks, links: [...links.values()], hidden: kids.length - shown.length };
}

// ---- Layout -----------------------------------------------------------------------------------------

export interface PlacedBlock {
  block: SheetBlock;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row of each shown slot, in sheet cells. */
  rows: Map<string, number>;
  layer: number;
}

export interface SheetPlan {
  sheet: Sheet;
  width: number;
  height: number;
  blocks: PlacedBlock[];
  /** A route per link, in the sheet's link order; undefined where no way through was found. */
  routes: ([number, number][] | undefined)[];
  /** The slot ORDs whose values the sheet shows. */
  points: string[];
}

const MARGIN_X = 2;
const MARGIN_Y = 1;
const VALUE = 9;

function sizeOf(block: SheetBlock, valueWidth: number): { w: number; h: number } {
  if (block.container) return { w: Math.max(len(block.name) + 6, len(block.type) + 6), h: 3 };
  const rows = Math.max(1, block.slots.length);
  const inner = Math.max(len(block.name) + 2, len(block.type) + 2, ...block.slots.map((slot) => len(plain(slot)) + 1 + valueWidth));
  return { w: inner + 4, h: rows + 2 };
}

/**
 * Places the blocks and finds a way for every link. Blocks that feed others sit to their left, in
 * columns; a block with no links goes in rows underneath. `maxWidth` is where those rows wrap.
 */
export function planSheet(sheet: Sheet, options: { valueWidth?: number; maxWidth?: number } = {}): SheetPlan {
  const valueWidth = Math.max(VALUE, options.valueWidth ?? 0);
  const maxWidth = options.maxWidth ?? 110;
  const index = new Map(sheet.blocks.map((block, i) => [block.ord, i]));
  const edges = sheet.links.map((link) => ({ from: index.get(link.source), to: index.get(link.target) })).map((e, i) => ({ ...e, i })).filter((e): e is { from: number; to: number; i: number } => e.from !== undefined && e.to !== undefined && e.from !== e.to);
  const count = sheet.blocks.length;
  const out: number[][] = Array.from({ length: count }, () => []);
  const into: number[][] = Array.from({ length: count }, () => []);

  // Links that close a loop (feedback) do not decide the columns; they are still drawn.
  const state = new Uint8Array(count);
  const forward: { from: number; to: number }[] = [];
  const adjacent: number[][] = Array.from({ length: count }, () => []);
  for (const e of edges) adjacent[e.from].push(e.to);
  const visit = (start: number) => {
    const stack: [number, number][] = [[start, 0]];
    state[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = adjacent[top[0]][top[1]];
      if (next === undefined) {
        state[top[0]] = 2;
        stack.pop();
        continue;
      }
      top[1] += 1;
      if (state[next] === 1) continue; // back to something still open: a loop
      forward.push({ from: top[0], to: next });
      if (state[next] === 0) {
        state[next] = 1;
        stack.push([next, 0]);
      }
    }
  };
  for (let i = 0; i < count; i += 1) if (state[i] === 0) visit(i);
  for (const e of forward) {
    out[e.from].push(e.to);
    into[e.to].push(e.from);
  }

  // Columns: a block sits one past the furthest of what feeds it, and a pure source sits just before what it feeds.
  const layer = new Int32Array(count).fill(-1);
  const order: number[] = [];
  const waiting = into.map((list) => list.length);
  const ready = [...Array(count).keys()].filter((i) => waiting[i] === 0);
  while (ready.length) {
    const i = ready.shift()!;
    order.push(i);
    layer[i] = Math.max(0, ...into[i].map((p) => layer[p] + 1));
    for (const next of out[i]) if ((waiting[next] -= 1) === 0) ready.push(next);
  }
  for (const i of [...order].reverse()) if (into[i].length === 0 && out[i].length > 0) layer[i] = Math.max(0, Math.min(...out[i].map((n) => layer[n])) - 1);
  const linkedBlocks = [...Array(count).keys()].filter((i) => into[i].length + out[i].length > 0);
  const loose = [...Array(count).keys()].filter((i) => into[i].length + out[i].length === 0);

  const sizes = sheet.blocks.map((block) => sizeOf(block, valueWidth));
  const columns: number[][] = [];
  for (const i of linkedBlocks) (columns[layer[i]] ??= []).push(i);
  for (let l = 0; l < columns.length; l += 1) columns[l] ??= [];

  // Fewer crossings: order each column by where its neighbours in the column before sit, twice over.
  const position = new Float64Array(count);
  columns.forEach((column) => column.forEach((i, at) => (position[i] = at)));
  const settle = (column: number[], neighbours: (i: number) => number[]) => {
    const weight = (i: number) => {
      const near = neighbours(i);
      return near.length ? near.reduce((sum, n) => sum + position[n], 0) / near.length : position[i];
    };
    const sorted = [...column].sort((a, b) => weight(a) - weight(b) || a - b);
    sorted.forEach((i, at) => (position[i] = at));
    return sorted;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (let l = 1; l < columns.length; l += 1) columns[l] = settle(columns[l], (i) => into[i]);
    for (let l = columns.length - 2; l >= 0; l -= 1) columns[l] = settle(columns[l], (i) => out[i]);
  }

  // Across: each column as wide as its widest block, with room between for the wires that pass.
  const placed: PlacedBlock[] = sheet.blocks.map((block, i) => ({ block, x: 0, y: 0, w: sizes[i].w, h: sizes[i].h, rows: new Map(), layer: layer[i] }));
  let x = MARGIN_X;
  columns.forEach((column, l) => {
    for (const i of column) placed[i].x = x;
    const crossing = forward.filter((e) => layer[e.from] <= l && layer[e.to] > l).length;
    x += Math.max(0, ...column.map((i) => sizes[i].w)) + Math.min(16, Math.max(6, 4 + crossing));
  });
  const rowOf = (i: number, slot: string) => {
    const at = sheet.blocks[i].slots.indexOf(slot);
    return 1 + Math.max(0, at);
  };
  // Down: a block lines its input up with the output that feeds it where the block above leaves room.
  const wanted = (i: number, feeding: boolean): number | undefined => {
    const rows = sheet.links
      .filter((link) => (feeding ? index.get(link.target) === i && index.has(link.source) : index.get(link.source) === i && index.has(link.target)))
      .map((link) => {
        const other = feeding ? index.get(link.source)! : index.get(link.target)!;
        if (layer[other] < 0 || (feeding ? layer[other] >= layer[i] : layer[other] <= layer[i])) return undefined;
        return placed[other].y + rowOf(other, feeding ? link.sourceSlot : link.targetSlot) - rowOf(i, feeding ? link.targetSlot : link.sourceSlot);
      })
      .filter((row): row is number => row !== undefined);
    return rows.length ? Math.round(rows.reduce((sum, row) => sum + row, 0) / rows.length) : undefined;
  };
  const stack = (column: number[], feeding: boolean) => {
    let cursor = MARGIN_Y;
    for (const i of column) {
      placed[i].y = Math.max(cursor, wanted(i, feeding) ?? cursor);
      cursor = placed[i].y + placed[i].h + 1;
    }
  };
  columns.forEach((column) => stack(column, true));
  for (let l = columns.length - 2; l >= 0; l -= 1) if (columns[l].every((i) => into[i].length === 0)) stack(columns[l], false);

  // Blocks with no links: rows underneath, wrapping at the width given.
  let bottom = Math.max(MARGIN_Y, ...linkedBlocks.map((i) => placed[i].y + placed[i].h));
  let cx = MARGIN_X;
  let cy = linkedBlocks.length ? bottom + 2 : MARGIN_Y;
  let rowHeight = 0;
  for (const i of loose) {
    if (cx > MARGIN_X && cx + placed[i].w > maxWidth) {
      cx = MARGIN_X;
      cy += rowHeight + 1;
      rowHeight = 0;
    }
    placed[i].x = cx;
    placed[i].y = cy;
    cx += placed[i].w + 2;
    rowHeight = Math.max(rowHeight, placed[i].h);
  }
  placed.forEach((p) => p.block.slots.forEach((slot, at) => p.rows.set(slot, p.y + 1 + at)));
  bottom = Math.max(...placed.map((p) => p.y + p.h), MARGIN_Y);
  const width = Math.max(...placed.map((p) => p.x + p.w), MARGIN_X) + MARGIN_X + 2;
  // Two spare rows below: a loop's wire goes back underneath.
  const height = bottom + MARGIN_Y + (edges.length > forward.length ? 2 : 0);

  // Wires: out of the right of the source slot, into the left of the target slot.
  const blocked = new Uint8Array(width * height);
  for (const p of placed) for (let by = p.y; by < p.y + p.h; by += 1) for (let bx = p.x; bx < p.x + p.w; bx += 1) blocked[by * width + bx] = 1;
  const ends = sheet.links.map((link) => {
    const from = index.get(link.source);
    const to = index.get(link.target);
    if (from === undefined || to === undefined || from === to) return undefined;
    const fromRow = placed[from].rows.get(link.sourceSlot);
    const toRow = placed[to].rows.get(link.targetSlot);
    if (fromRow === undefined || toRow === undefined) return undefined;
    return {
      from: { x: placed[from].x + placed[from].w, y: fromRow, heading: E } as Port, fromKey: `${link.source}|${link.sourceSlot}`,
      to: { x: placed[to].x - 1, y: toRow, heading: W } as Port, toKey: `${link.target}|${link.targetSlot}`
    };
  });
  // The cell at each port, and the one beyond it, are kept for that port's own wires.
  const keys = [...new Set(ends.flatMap((e) => (e ? [`>${e.fromKey}`, `<${e.toKey}`] : [])))];
  const kept = new Int16Array(width * height);
  for (const e of ends) {
    if (!e) continue;
    for (const [port, key, dx] of [[e.from, `>${e.fromKey}`, 1], [e.to, `<${e.toKey}`, -1]] as [Port, string, number][]) {
      for (let n = 0; n < 2; n += 1) {
        const px = port.x + dx * n;
        if (px < 0 || px >= width || blocked[port.y * width + px]) break;
        if (!kept[port.y * width + px]) kept[port.y * width + px] = keys.indexOf(key) + 1;
      }
    }
  }
  const beside = new Uint8Array(width * height);
  for (let by = 0; by < height; by += 1) for (let bx = 0; bx < width; bx += 1) {
    const cell = by * width + bx;
    if (blocked[cell] || kept[cell]) continue;
    if ((bx > 0 && blocked[cell - 1]) || (bx < width - 1 && blocked[cell + 1]) || (by > 0 && blocked[cell - width]) || (by < height - 1 && blocked[cell + width])) beside[cell] = 1;
  }
  const alongH = new Int16Array(width * height);
  const alongV = new Int16Array(width * height);
  const routes: ([number, number][] | undefined)[] = sheet.links.map(() => undefined);
  // Short, level wires first: they take the straight runs, and longer ones go round them.
  const sequence = ends.map((e, i) => ({ e, i })).filter((item): item is { e: NonNullable<(typeof ends)[number]>; i: number } => !!item.e)
    .sort((a, b) => Math.abs(a.e.to.x - a.e.from.x) + 4 * Math.abs(a.e.to.y - a.e.from.y) - (Math.abs(b.e.to.x - b.e.from.x) + 4 * Math.abs(b.e.to.y - b.e.from.y)) || a.i - b.i);
  for (const { e, i } of sequence) {
    const mine = [keys.indexOf(`>${e.fromKey}`) + 1, keys.indexOf(`<${e.toKey}`) + 1];
    const open = (cell: number) => !blocked[cell] && (kept[cell] === 0 || mine.includes(kept[cell]));
    // Wires from the same output run together until they part.
    const shares = (other: number) => ends[other]?.fromKey === e.fromKey;
    const cells = findWay(width, height, open, beside, alongH, alongV, i, shares, e.from, e.to);
    if (!cells) continue;
    cells.forEach(([px, py], at) => {
      const before = cells[at - 1];
      const after = cells[at + 1];
      if (((before && before[1] === py) || (after && after[1] === py)) && !alongH[py * width + px]) alongH[py * width + px] = i + 1;
      if (((before && before[0] === px) || (after && after[0] === px)) && !alongV[py * width + px]) alongV[py * width + px] = i + 1;
    });
    routes[i] = cells.filter(([px], at) => at === 0 || at === cells.length - 1 || (cells[at - 1][0] === px) !== (cells[at + 1][0] === px));
  }

  const points = placed.flatMap((p) => (p.block.container ? [] : p.block.slots.map((slot) => slotOrd(p.block.ord, slot))));
  return { sheet, width, height, blocks: placed, routes, points };
}

// ---- Following a value ------------------------------------------------------------------------------

export interface Trace {
  /** Indexes of the sheet's links the value travels along. */
  links: Set<number>;
  /** ORDs of the blocks on the way. */
  blocks: Set<string>;
  /** One way through, upstream to downstream: "Block.slot" steps. */
  chain: { ord: string; slot: string }[];
}

/**
 * Everything that feeds a slot's value and everything it drives, within the sheet. A block is
 * taken to pass all of its linked inputs on to all of its outputs.
 */
export function traceOf(sheet: Sheet, ord: string, slot: string): Trace {
  const links = new Set<number>();
  const blocks = new Set<string>([ord]);
  const arriving = (block: string, at?: string) => sheet.links.map((link, i) => ({ link, i })).filter(({ link }) => link.target === block && (at === undefined || link.targetSlot === at));
  const leaving = (block: string, at?: string) => sheet.links.map((link, i) => ({ link, i })).filter(({ link }) => link.source === block && (at === undefined || link.sourceSlot === at));

  // Upstream: what arrives at this slot, or at the block when the slot is one of its outputs.
  const startIn = arriving(ord, slot);
  const up = startIn.length ? startIn : arriving(ord);
  const upSeen = new Set<string>();
  for (const queue = [...up]; queue.length; ) {
    const { link, i } = queue.shift()!;
    links.add(i);
    blocks.add(link.source);
    if (upSeen.has(link.source)) continue;
    upSeen.add(link.source);
    queue.push(...arriving(link.source));
  }
  // Downstream: what leaves this slot, or the block when the slot is one of its inputs.
  const startOut = leaving(ord, slot);
  const down = startOut.length ? startOut : leaving(ord);
  const downSeen = new Set<string>();
  for (const queue = [...down]; queue.length; ) {
    const { link, i } = queue.shift()!;
    links.add(i);
    blocks.add(link.target);
    if (downSeen.has(link.target)) continue;
    downSeen.add(link.target);
    queue.push(...leaving(link.target));
  }

  // One readable way through it: back along the first link each time, then forward the same way.
  const chain: { ord: string; slot: string }[] = [{ ord, slot }];
  const walked = new Set<string>([ord]);
  for (let step = up[0]; step; ) {
    chain.unshift({ ord: step.link.target, slot: step.link.targetSlot });
    chain.unshift({ ord: step.link.source, slot: step.link.sourceSlot });
    if (walked.has(step.link.source)) break;
    walked.add(step.link.source);
    step = arriving(step.link.source)[0];
  }
  for (let step = down[0]; step; ) {
    chain.push({ ord: step.link.source, slot: step.link.sourceSlot });
    chain.push({ ord: step.link.target, slot: step.link.targetSlot });
    if (walked.has(step.link.target)) break;
    walked.add(step.link.target);
    step = leaving(step.link.target)[0];
  }
  const tidy = chain.filter((item, i) => i === 0 || item.ord !== chain[i - 1].ord || item.slot !== chain[i - 1].slot);
  return { links, blocks, chain: tidy };
}

/** A trace as one line of text, with the value at each output on the way. Given a width, steps in the middle are left out so both ends show. */
export function traceText(sheet: Sheet, trace: Trace, values: Values, width?: number): string {
  const names = new Map(sheet.blocks.map((block) => [block.ord, block.name]));
  const parts = trace.chain
    .map((step, i) => {
      const value = values(slotOrd(step.ord, step.slot));
      const shows = value?.ok && value.displayValue && (i === trace.chain.length - 1 || trace.chain[i + 1].ord !== step.ord);
      return `${names.get(step.ord) ?? nameOf(step.ord)}.${plain(step.slot)}${shows ? ` ${value!.displayValue}` : ""}`;
    });
  const steps = [...trace.chain.keys()].map((i) => i);
  const text = (kept: number[]) => kept.map((i, at) => (at > 0 && kept[at - 1] !== i - 1 ? `… → ${parts[i]}` : parts[i])).join(" → ");
  // Too long for the line: drop steps from the middle, one at a time, until what is left fits.
  while (width !== undefined && steps.length > 2 && len(text(steps)) > width) steps.splice(Math.floor(steps.length / 2), 1);
  return text(steps);
}

// ---- Drawing ----------------------------------------------------------------------------------------

export interface Picked {
  ord: string;
  slot?: string;
}

const valueText = (value: PointValue | undefined) => (!value ? "…" : !value.ok ? "?" : value.displayValue ?? String(value.value ?? ""));
const valueStyle = (value: PointValue | undefined, lit: boolean): Style => {
  if (!value || !value.ok) return { color: theme.faint };
  const state = value.state ?? "ok";
  if (state === "alarm") return { color: theme.bad, bold: true };
  if (state === "fault" || state === "down") return { color: theme.accent2, bold: true };
  if (state === "stale" || state === "null" || state === "disabled") return { color: theme.warn };
  if (state === "overridden") return { color: theme.info, bold: true };
  return lit ? { bold: true } : { color: theme.muted };
};

/**
 * One frame of the sheet. With a trace, what the value travels through is lit and carries moving
 * marks, and the rest is dimmed.
 */
export function drawSheet(plan: SheetPlan, values: Values, frame: number, options: { picked?: Picked; trace?: Trace } = {}): Canvas {
  const canvas = new Canvas(plan.width, plan.height);
  const { trace, picked } = options;
  const incoming = new Set(plan.sheet.links.map((link) => `${link.target}|${link.targetSlot}`));
  const outgoing = new Set(plan.sheet.links.map((link) => `${link.source}|${link.sourceSlot}`));

  plan.routes.forEach((route, i) => {
    if (!route) return;
    const lit = trace?.links.has(i);
    const color = lit ? theme.accent : trace ? theme.faint : theme.muted;
    canvas.route(route, { color, flow: lit ? { direction: 1, frame: Math.floor(frame / 2), spacing: 5, color: theme.accent } : undefined });
    const [ex, ey] = route[route.length - 1];
    canvas.set(ex, ey, "▸", { color, bold: lit });
  });

  for (const p of plan.blocks) {
    const { block } = p;
    const chosen = picked?.ord === block.ord;
    const lit = !trace || trace.blocks.has(block.ord);
    const frameStyle: Style = chosen ? { color: theme.accent, bold: true } : { color: block.outside || !lit ? theme.faint : theme.muted };
    const inner = p.w - 2;
    const h = block.outside ? "┄" : "─";
    const title = clip(block.container ? `▸ ${block.name}` : block.name, inner - 2);
    canvas.text(p.x, p.y, `╭${h} `, frameStyle);
    canvas.text(p.x + 3, p.y, title, chosen ? { color: theme.accent, bold: true } : lit && !block.outside ? { bold: true } : { color: theme.muted });
    canvas.text(p.x + 3 + len(title), p.y, ` ${h.repeat(Math.max(0, inner - 3 - len(title)))}╮`, frameStyle);
    // The type sits in the bottom edge, so a block with one slot is still one row tall.
    const kind = block.container || block.outside ? "" : clip(block.type, inner - 4);
    canvas.text(p.x, p.y + p.h - 1, `╰${h}${kind ? " " : h}`, frameStyle);
    canvas.text(p.x + 3, p.y + p.h - 1, kind, { color: theme.faint });
    canvas.text(p.x + 3 + len(kind), p.y + p.h - 1, `${kind ? " " : ""}${h.repeat(Math.max(0, inner - 2 - len(kind) - (kind ? 1 : 0)))}╯`, frameStyle);
    for (let row = p.y + 1; row < p.y + p.h - 1; row += 1) {
      canvas.set(p.x, row, "│", frameStyle);
      canvas.set(p.x + p.w - 1, row, "│", frameStyle);
    }
    if (block.container) {
      canvas.text(p.x + 2, p.y + 1, clip(block.type, inner - 2), { color: theme.faint });
      continue;
    }
    if (block.slots.length === 0) canvas.text(p.x + 2, p.y + 1, clip("no values", inner - 2), { color: theme.faint });
    block.slots.forEach((slot, at) => {
      const row = p.y + 1 + at;
      const value = values(slotOrd(block.ord, slot));
      const text = clip(valueText(value), Math.max(1, inner - 3 - Math.min(len(plain(slot)), inner - 6)));
      const name = clip(plain(slot), inner - 3 - len(text));
      const here = chosen && picked?.slot === slot;
      const base: Style = here ? { inverse: true, bold: true } : {};
      if (here) canvas.text(p.x + 1, row, " ".repeat(inner), base);
      canvas.text(p.x + 2, row, name, here ? base : { color: lit ? undefined : theme.faint });
      canvas.text(p.x + p.w - 2 - len(text), row, text, here ? base : lit ? valueStyle(value, true) : { color: theme.faint });
      if (incoming.has(`${block.ord}|${slot}`)) canvas.set(p.x, row, "┤", frameStyle);
      if (outgoing.has(`${block.ord}|${slot}`)) canvas.set(p.x + p.w - 1, row, "├", frameStyle);
    });
  }
  return canvas;
}

/** The longest value on the sheet now, so a plan can keep that much room for values. */
export function valueRoom(plan: SheetPlan, values: Values): number {
  return Math.max(VALUE, ...plan.points.map((ord) => len(valueText(values(ord)))));
}
