// bask export: a branch of the station as text (docs/ROADMAP.md, E2). One JSON document listing
// every component under an ORD with its type, the properties that are set on it, the links that
// arrive at it, and its own tags and relations. It holds nothing that changes while the station
// only runs (values, statuses, health, times), no handles and no secrets, and everything is in a
// fixed order, so two exports of an unchanged branch are the same bytes.
import { toSlotOrd, type BaskStreamClient, type Json } from "./core.js";
import { walkTree } from "./check.js";

export const EXPORT_FORMAT = "bask-export";

/** A property's value: Niagara's string encoding, or for a struct its fields the same way. */
export type ExportedValue = string | { [field: string]: ExportedValue };

export interface ExportedComponent {
  /** Where it is, relative to the root: "." is the root, "AHU_01/points/SupplyAirTemp" a point under it. */
  path: string;
  type: string;
  /** Configuration that differs from the type's defaults, by slot name. */
  properties?: Record<string, ExportedValue>;
  /** Links arriving here. `from` is a path under the root, or a slot ORD when it is outside the branch. */
  links?: { from: string; fromSlot: string; toSlot: string }[];
  /** Tags stored on the component (not the ones a dictionary implies). A marker is true. */
  tags?: Record<string, string | number | boolean>;
  /** Relations stored on the component that leave it. */
  relations?: { id: string; to: string }[];
  /** The login could not read it: only its place and type are known. */
  unreadable?: true;
}

export interface StationExport {
  format: typeof EXPORT_FORMAT;
  version: 1;
  /** The ORD that was exported. */
  root: string;
  components: ExportedComponent[];
}

/** Slot flags, from javax.baja.sys.Flags. */
const READONLY = 1;
const TRANSIENT = 2;
const MAX_COMPONENTS = 20000;
/** How far below a browsed component its unbrowsed parts (extensions and the like) are followed. */
const MAX_PART_DEPTH = 3;

const SECRET_NAME = /pass(word|wd|phrase)|secret|token|api_?key|credential|private_?key/i;
const SECRET_TYPE = /password|secret|credential|privatekey|certificate/i;
/** A handle ORD: it names a component by a number that is not kept from one station to the next. */
const HANDLE = /(^|\|)h:[0-9a-f]+/i;

const plain = (name: string) => name.replace(/\$([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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

/** A slot's value as it is exported, or undefined when there is nothing to write down. */
function valueOf(value: Json | undefined): ExportedValue | undefined {
  if (!value || value.redacted) return undefined;
  if (typeof value.encoded === "string") return HANDLE.test(value.encoded) ? undefined : value.encoded;
  if (value.properties && typeof value.properties === "object") {
    const fields: Record<string, ExportedValue> = {};
    for (const name of Object.keys(value.properties as object).sort(byText)) {
      if (SECRET_NAME.test(name)) continue;
      const inner = valueOf((value.properties as Record<string, Json>)[name]);
      if (inner !== undefined) fields[name] = inner;
    }
    return Object.keys(fields).length ? fields : undefined;
  }
  return undefined;
}

const same = (a: ExportedValue | undefined, b: ExportedValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** Exports the branch at `root`. Read-only: browse, describe_component, describe_component_types and read_tags. */
export async function exportBranch(client: BaskStreamClient, root: string): Promise<StationExport> {
  const { nodes, truncated } = await walkTree(client, root, MAX_COMPONENTS);
  if (truncated) throw new Error(`${root} holds more than ${MAX_COMPONENTS} components. Export a smaller branch.`);
  const relative = (ord: string) => {
    const slot = toSlotOrd(ord);
    return slot === root ? "." : slot.startsWith(root === "slot:/" ? root : `${root}/`) ? slot.slice(root === "slot:/" ? root.length : root.length + 1) : slot;
  };

  // What a new component of each type holds, to leave defaults out. A station that cannot say
  // (an older module, or a type it will not describe) gets every property written instead.
  const defaults = new Map<string, Promise<Map<string, ExportedValue | undefined> | undefined>>();
  const defaultsOf = (typeSpec: string) => {
    if (!defaults.has(typeSpec)) {
      defaults.set(typeSpec, client.call("describe_component_types", { typeSpec }).then(
        (reply) => new Map((((reply.result as Json | undefined)?.slots ?? []) as Json[]).map((slot) => [String(slot.name), valueOf(slot.value as Json | undefined)])),
        () => undefined
      ));
    }
    return defaults.get(typeSpec)!;
  };

  const components = new Map<string, ExportedComponent>();
  /** Reads one component; returns the parts of it that browse did not list, to read next. */
  const read = async (ord: string, typeSpec: string): Promise<{ ord: string; typeSpec: string }[]> => {
    const component: ExportedComponent = { path: relative(ord), type: typeSpec };
    let described: Json;
    try {
      described = (await client.call("describe_component", { ord })).result as Json;
    } catch {
      // A component browse listed is kept with its place and type; a part nothing can describe is not a component.
      if (nodes.has(ord)) components.set(ord, { ...component, unreadable: true });
      return [];
    }
    components.set(ord, component);
    if (typeof described.typeSpec === "string" && described.typeSpec) component.type = described.typeSpec;
    const slots = ((described.slots ?? []) as Json[]).filter((slot) => slot.kind === "property");
    const names = new Set(slots.map((slot) => String(slot.name)));
    const links = ((described.links ?? []) as Json[])
      .filter((link) => link.direction === "in" && typeof link.source === "string")
      .map((link) => ({ from: relative(String(link.source)), fromSlot: String(link.sourceSlot ?? ""), toSlot: String(link.targetSlot ?? "") }))
      .sort((a, b) => byText(a.toSlot, b.toSlot) || byText(a.from, b.from) || byText(a.fromSlot, b.fromSlot));
    if (links.length) component.links = links;
    const fed = new Set(links.map((link) => link.toSlot));
    // A writable point's priority inputs hold what is commanded now (an override, what a link sends), not configuration.
    const isWritablePoint = names.has("fallback") && names.has("out");
    const typeDefaults = await defaultsOf(component.type);
    const properties: Record<string, ExportedValue> = {};
    const parts: { ord: string; typeSpec: string }[] = [];
    for (const slot of slots) {
      const name = String(slot.name);
      const value = slot.value as Json | undefined;
      const slotType = String(slot.typeSpec ?? value?.typeSpec ?? "");
      if (slotType === "baja:Link") continue;
      if (value?.expand) {
        // A component inside this one that browse did not list (an extension, say) is exported in its own right.
        const part = ord === "slot:/" ? `slot:/${name}` : `${ord}/${name}`;
        if (!nodes.has(part)) parts.push({ ord: part, typeSpec: String(value.typeSpec ?? slotType) });
        continue;
      }
      const flags = Number(slot.flags ?? 0);
      if ((flags & (READONLY | TRANSIENT)) !== 0) continue;
      if (SECRET_NAME.test(name) || SECRET_TYPE.test(slotType) || SECRET_TYPE.test(String(value?.typeSpec ?? ""))) continue;
      if (fed.has(name) || (isWritablePoint && /^in([1-9]|1[0-6])$/.test(name))) continue;
      // Tags are slots too; they are listed as tags.
      if (/^baja:(Marker|Relation)$/.test(slotType)) continue;
      const exported = valueOf(value);
      if (exported === undefined) continue;
      if (name === "displayName" && (exported === plain(ord.slice(ord.lastIndexOf("/") + 1)) || exported === nodes.get(ord)?.name)) continue;
      if (typeDefaults && typeDefaults.has(name) && same(typeDefaults.get(name), exported)) continue;
      properties[name] = exported;
    }
    if (Object.keys(properties).length) component.properties = Object.fromEntries(Object.keys(properties).sort(byText).map((name) => [name, properties[name]]));
    return parts;
  };

  let wave = [...nodes.values()].map((node) => ({ ord: node.ord, typeSpec: node.typeSpec }));
  for (let depth = 0; wave.length && depth <= MAX_PART_DEPTH; depth += 1) {
    const found = (await pooled(wave, 8, (item) => read(item.ord, item.typeSpec))).flat();
    wave = found.filter((item, i) => !components.has(item.ord) && found.findIndex((other) => other.ord === item.ord) === i);
    if (components.size + wave.length > MAX_COMPONENTS) throw new Error(`${root} holds more than ${MAX_COMPONENTS} components. Export a smaller branch.`);
  }

  // Tags and relations, a hundred components a request. A station without tag reading exports none.
  const ords = [...components.keys()].filter((ord) => !components.get(ord)!.unreadable);
  const batch = Math.max(1, Math.min(100, Number(((client.capabilities.tags ?? {}) as Json).maxTargetsPerRequest ?? 100) || 100));
  const batches = Array.from({ length: Math.ceil(ords.length / batch) }, (_v, i) => ords.slice(i * batch, (i + 1) * batch));
  const tagged = await pooled(batches, 4, (some) => client.call("read_tags", { ords: some, includeRelations: true }).then((reply) => (reply.targets ?? []) as Json[], () => [] as Json[]));
  for (const target of tagged.flat()) {
    const component = components.get(toSlotOrd(String(target.ord ?? "")));
    if (!component || target.ok === false) continue;
    const tags: Record<string, string | number | boolean> = {};
    for (const tag of ((target.tags ?? []) as Json[]).filter((t) => t.source !== "implied")) {
      const value = tag.marker ? true : tag.value;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") tags[String(tag.id)] = value;
    }
    if (Object.keys(tags).length) component.tags = Object.fromEntries(Object.keys(tags).sort(byText).map((id) => [id, tags[id]]));
    const relations = ((target.relations ?? []) as Json[])
      .filter((r) => r.source !== "implied" && r.direction !== "in" && typeof r.endpointOrd === "string" && !HANDLE.test(String(r.endpointOrd)))
      .map((r) => ({ id: String(r.id), to: relative(String(r.endpointOrd)) }))
      .sort((a, b) => byText(a.id, b.id) || byText(a.to, b.to));
    if (relations.length) component.relations = relations;
    // A tag's own slot is not a property as well.
    if (component.properties) {
      for (const name of Object.keys(component.properties)) if (plain(name) in tags) delete component.properties[name];
      if (Object.keys(component.properties).length === 0) delete component.properties;
    }
  }

  // One key order for every component, whatever was found first.
  const ordered = [...components.values()].sort((a, b) => byText(a.path, b.path)).map((c) => ({
    path: c.path, type: c.type,
    ...(c.unreadable ? { unreadable: true as const } : {}),
    ...(c.properties ? { properties: c.properties } : {}),
    ...(c.links ? { links: c.links } : {}),
    ...(c.tags ? { tags: c.tags } : {}),
    ...(c.relations ? { relations: c.relations } : {})
  }));
  return { format: EXPORT_FORMAT, version: 1, root, components: ordered };
}

/** The export as the text bask writes: two-space JSON with a final newline. */
export const exportText = (doc: StationExport) => `${JSON.stringify(doc, null, 2)}\n`;

/** Reads an export back, saying what is wrong with a file that is not one. */
export function parseExport(text: string, from: string): StationExport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`${from} could not be read as JSON: ${(error as Error).message}`);
  }
  const d = doc as Partial<StationExport> | null;
  if (!d || d.format !== EXPORT_FORMAT || !Array.isArray(d.components)) throw new Error(`${from} is not a bask export (no "format": "${EXPORT_FORMAT}"). Make one with: bask export <ord> > file.json`);
  if (d.version !== 1) throw new Error(`${from} is export version ${String(d.version)}; this bask reads version 1.`);
  return d as StationExport;
}
