// A wire sheet in text: the components of one folder as blocks, the links between their slots as
// lines, and each slot's live value inside its block. It is for reading and watching logic, not
// for drawing it: the layout is worked out here, left to right the way the values flow.
//
// Everything comes from operations the station already has: browse for the folder, describe_component
// for each block's slots and links, and ordinary point reads for the slot values (any slot of any
// component reads like a point, e.g. slot:/Logic/Reset/inA).
import { toSlotOrd, type BaskStreamClient, type Json } from "./core.js";
import { place } from "./format.js";

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

export const len = (text: string) => [...text].length;
export const clip = (text: string, width: number) => (len(text) <= width ? text : `${[...text].slice(0, Math.max(0, width - 1)).join("")}…`);
export const nameOf = (ord: string) => ord.slice(ord.lastIndexOf("/") + 1);
const shortType = (typeSpec: string) => typeSpec.slice(typeSpec.indexOf(":") + 1);
/** Niagara escapes characters in slot names as $xx; show them as typed. */
export const plain = (name: string) => name.replace(/\$([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
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

