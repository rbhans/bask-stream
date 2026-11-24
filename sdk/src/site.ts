// What the map is drawn from: the station's equipment, what each piece is, and what feeds what.
// It comes from what the station holds (the tree, tags, relations) plus guesses from names, the same
// ones `bask model infer` writes to a review file. Where nothing says what feeds a unit, it is grouped
// the way the station is wired: by the network or folder it sits in.
import type { BaskStreamClient } from "./core.js";
import { shortOrd } from "./format.js";
import { UNSURE, buildReview, inferModel, inferServes, readEvidence, type ModelEquipment, type ModelPlace, type ModelReview, type ModelServes } from "./model.js";

export interface SitePoint {
  ord: string;
  name: string;
  role: string;
  label: string;
  unit?: string;
  writable: boolean;
}

export interface Unit {
  ord: string;
  name: string;
  /** ahu, vav, chilledWaterPlant… or "unknown". */
  kind: string;
  label: string;
  points: SitePoint[];
  /** The one value its tile shows, when there is one to show. */
  headline?: SitePoint;
  /** What the headline is held to, when the unit has it. */
  setpoint?: SitePoint;
  /** Its heating and cooling setpoints, when it has both: anywhere between them is where it should be. */
  band?: { low: SitePoint; high: SitePoint };
  /** The plant or system it is a part of, by ORD, when the station says. */
  partOf?: string;
  /** A terminal unit: a room's box, drawn as a tile under whatever feeds it. */
  zone: boolean;
  /** The network or folder it sits in, by name and ORD. */
  wiring: string;
  wiringOrd: string;
  /** Where it is, when the station says: the building, the floor and the room, each by name. */
  place?: Place;
  /** The station's own tags say what it is (not a guess from its name). */
  tagged: boolean;
}

export interface Place {
  site?: string;
  floor?: string;
  room?: string;
  /** "Northgate Office › Level 1 › 101 Reception", as much of it as is known. */
  path: string;
  /** What units in the same part of the building share: the building and floor. */
  key: string;
  title: string;
}

/** How the map is laid out: by what feeds what, by where things are, or by what they are. */
export type Arrange = "feeds" | "place" | "kind";
export const ARRANGES: Arrange[] = ["feeds", "place", "kind"];
/** The key the choice is kept under, beside the tile choices. */
export const ARRANGE_KEY = "@arrange";

export interface Group {
  key: string;
  title: string;
  /** The unit that feeds the members, for a group made from what serves what. */
  feeder?: Unit;
  members: Unit[];
  /** What put the members together: what feeds them, where they are, what they are, or the folder they sit in. */
  by: "serves" | "part" | "place" | "kind" | "wiring";
  /** Which side of the building's systems it belongs to, when that is known. */
  side?: "air" | "water";
  /** Made from a guess a person has not confirmed. */
  guessed: boolean;
  /** A plant's group: the units it sends water to, by what it sends. They keep their own place on the map. */
  water?: WaterFed[];
}

/** What a plant sends one kind of water to. */
export interface WaterFed {
  medium: "chilledWater" | "hotWater";
  units: Unit[];
  /** Any of it is a guess a person has not confirmed. */
  guessed: boolean;
}

export interface Site {
  station: string;
  units: Unit[];
  /** Plant equipment that is in no group. Empty now that every plant has a group of its own; kept for callers that read it. */
  plant: Unit[];
  groups: Group[];
  review: ModelReview;
  /** Guesses about what feeds what that a person has not confirmed. */
  guesses: { sure: number; unsure: number };
  truncated: boolean;
  arrange: Arrange;
  /** True when any unit's place is known, so the map can be laid out by building and floor. */
  placed: boolean;
  /** The points the station says can be commanded, kept so the map can be rebuilt without reading again. */
  writable?: Set<string>;
}

/** The same site with a changed review or tile choices: what a person settled, applied without reading the station again. */
export function rebuildSite(site: Site, review: ModelReview, tiles: Record<string, string>): Site {
  const next = buildSite(review, site.truncated, tiles);
  next.writable = site.writable;
  if (site.writable) for (const unit of next.units) for (const point of unit.points) point.writable = site.writable.has(point.ord);
  return next;
}

const HEADLINE: Record<string, string[]> = {
  vav: ["zoneTemp"], fcu: ["zoneTemp"], ahu: ["supplyAirTemp"], crac: ["returnAirTemp", "supplyAirTemp"],
  chilledWaterPlant: ["chwSupplyTemp"], hotWaterPlant: ["hwSupplyTemp"], chiller: ["leavingWaterTemp", "chwSupplyTemp"], boiler: ["leavingWaterTemp", "hwSupplyTemp"],
  pump: ["pumpSpeed", "speedFeedback"], coolingTower: ["leavingWaterTemp", "fanSpeed"]
};
const SETPOINT: Record<string, string[]> = {
  zoneTemp: ["zoneTempSp", "zoneCoolingSp"], supplyAirTemp: ["supplyAirTempSp"], chwSupplyTemp: ["chwSupplyTempSp"], hwSupplyTemp: ["hwSupplyTempSp"], leavingWaterTemp: ["leavingWaterTempSp"], boxTemp: ["boxTempSp"]
};
const PLANT = new Set(["chilledWaterPlant", "hotWaterPlant", "chiller", "boiler", "pump", "coolingTower"]);
const ZONE = new Set(["vav", "fcu"]);
const AIR = new Set(["ahu", "rtu", "doas", "vav", "fcu", "crac", "fan", "exhaustFan"]);
const sideOf = (kind: string): Group["side"] => (PLANT.has(kind) ? "water" : AIR.has(kind) ? "air" : undefined);

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const parentOf = (ord: string) => ord.slice(0, Math.max(ord.lastIndexOf("/"), "slot:".length));

/** Where a piece of equipment is, read up from its room to its floor and building. */
function placeOf(e: ModelEquipment, places: Record<string, ModelPlace> = {}): Place | undefined {
  const chain: ModelPlace[] = [];
  for (let at = e.space ? places[e.space] : undefined; at && chain.length < 6 && !chain.includes(at); at = at.parent ? places[at.parent] : undefined) chain.unshift(at);
  const site = places[e.site ?? ""] ?? places[chain[0]?.site ?? ""];
  if (!site && !chain.length) return undefined;
  const floor = chain.find((p) => p.kind === "floor") ?? (chain.length > 1 ? chain[0] : undefined);
  const room = chain.length && chain[chain.length - 1] !== floor ? chain[chain.length - 1] : undefined;
  const names = [site?.name, ...chain.map((p) => p.name)].filter((name): name is string => !!name);
  // Something on the roof or in a plant room with no floor above it is grouped by that space.
  const area = floor ?? room;
  return { site: site?.name, floor: floor?.name, room: room?.name, path: names.join(" › "), key: `${site?.ord ?? ""}|${area?.ord ?? ""}`, title: [site?.name, area?.name].filter(Boolean).join(" · ") };
}

const plural = (label: string) => (/(x|s|ch)$/i.test(label) ? `${label}es` : `${label}s`);

function unitOf(e: ModelEquipment, tiles: Record<string, string> = {}, places?: Record<string, ModelPlace>): Unit {
  const points: SitePoint[] = e.points.map((p) => ({ ord: p.ord, name: p.name, role: p.role, label: p.label, unit: p.unit, writable: p.tags.includes("cmd") || p.tags.includes("sp") })).sort((a, b) => natural.compare(a.name, b.name));
  const byRole = (roles: string[] | undefined) => (roles ?? []).map((role) => points.find((p) => p.role === role)).find(Boolean);
  // A person's choice for this unit, or for its kind, comes before the usual reading.
  const chosen = tiles[e.ord] ?? tiles[e.kind];
  const picked = chosen ? points.find((p) => p.name.toLowerCase() === chosen.toLowerCase()) : undefined;
  const headline = picked ?? byRole(HEADLINE[e.kind]) ?? byRole(["zoneTemp", "supplyAirTemp", "leavingWaterTemp", "boxTemp"]);
  // Units that are folders inside a controller's "points" are wired where the controller is.
  const above = parentOf(e.ord);
  const wiringOrd = /\/points$/i.test(above) ? parentOf(above) : above;
  // A zone held between a heating and a cooling setpoint is right anywhere between the two.
  const low = points.find((p) => p.role === "zoneHeatingSp");
  const high = points.find((p) => p.role === "zoneCoolingSp");
  const single = headline?.role === "zoneTemp" ? points.find((p) => p.role === "zoneTempSp") : undefined;
  return {
    ord: e.ord, name: e.name, kind: e.kind, label: e.label, points, headline, setpoint: single ?? (headline ? byRole(SETPOINT[headline.role]) : undefined),
    band: headline?.role === "zoneTemp" && !single && low && high ? { low, high } : undefined, partOf: e.partOf,
    zone: ZONE.has(e.kind) || (e.kind === "unknown" && headline?.role === "zoneTemp"), wiring: shortOrd(wiringOrd, 1), wiringOrd,
    place: placeOf(e, places), tagged: e.confidence === 1 && e.kind !== "unknown"
  };
}

/** A serving entry good enough to draw from: on the station already, confirmed by a person, or a guess that is fairly sure. */
const usable = (s: ModelServes) => !s.inferred || s.confirmed || s.confidence >= UNSURE;

/** The map's model from a review document. Pure. */
export function buildSite(review: ModelReview, truncated = false, tiles: Record<string, string> = {}): Site {
  // Something with points that is no kind of equipment and has no reading to lead with (a folder of
  // test points, a schedule's helpers) is left off the map. It is still on the station.
  const units = review.equipment.filter((e) => e.points.length > 0).map((e) => unitOf(e, tiles, review.places)).filter((u) => u.kind !== "unknown" || u.headline).sort((a, b) => natural.compare(a.name, b.name));
  const byOrd = new Map(units.map((u) => [u.ord, u]));
  const serves = review.serves ?? [];
  const air = serves.filter((s) => s.medium === "air" && usable(s) && byOrd.has(s.from) && byOrd.has(s.to));
  const fedBy = new Map(air.map((s) => [s.to, s]));
  const placed = units.some((u) => u.place);
  // With one building on the station its name on every group says nothing: the floor or room is enough.
  if (new Set(units.filter((u) => u.place).map((u) => u.place!.site ?? "")).size <= 1) for (const u of units) if (u.place) u.place = { ...u.place, title: u.place.floor ?? u.place.room ?? u.place.title };
  const wanted = tiles[ARRANGE_KEY] as Arrange | undefined;
  const arrange: Arrange = wanted === "kind" || (wanted === "place" && placed) ? wanted : "feeds";
  const groups: Group[] = [];
  const done = new Set<string>();
  /** Groups of whatever is not placed yet, by something each unit has; the rest is left for the next way. */
  const gather = (by: Group["by"], keyOf: (u: Unit) => [string, string] | undefined) => {
    const made = new Map<string, Group>();
    for (const u of units) {
      const found = done.has(u.ord) ? undefined : keyOf(u);
      if (!found) continue;
      const group = made.get(found[0]) ?? made.set(found[0], { key: `${by}:${found[0]}`, title: found[1], members: [], by, side: by === "kind" ? sideOf(u.kind) : undefined, guessed: false }).get(found[0])!;
      group.members.push(u);
      done.add(u.ord);
    }
    // In a group of mixed equipment, what serves comes before the rooms it serves.
    for (const group of made.values()) group.members.sort((a, b) => Number(a.zone) - Number(b.zone) || natural.compare(a.name, b.name));
    groups.push(...[...made.values()].sort((a, b) => natural.compare(a.title, b.title)));
  };
  const byKind = (u: Unit): [string, string] | undefined => (u.kind === "unknown" ? undefined : [u.kind, plural(u.label)]);
  const byFolder = (u: Unit): [string, string] => [u.wiringOrd, shortOrd(u.wiringOrd, 1)];
  let plant: Unit[] = [];
  if (arrange === "place") {
    gather("place", (u) => (u.place ? [u.place.key, u.place.title] : undefined));
    gather("kind", byKind);
    gather("wiring", byFolder);
  } else if (arrange === "kind") {
    gather("kind", byKind);
    gather("wiring", byFolder);
  } else {
    // Everything that feeds air gets a group, and so does every air handler, fed zones known or not.
    const feeders = units.filter((u) => air.some((s) => s.from === u.ord) || u.kind === "ahu");
    for (const feeder of feeders) {
      const mine = air.filter((s) => s.from === feeder.ord);
      const members = mine.map((s) => byOrd.get(s.to)!).sort((a, b) => natural.compare(a.name, b.name));
      groups.push({ key: feeder.ord, title: feeder.name, feeder, members, by: "serves", side: "air", guessed: mine.some((s) => s.inferred && !s.confirmed) });
      done.add(feeder.ord);
      for (const m of members) done.add(m.ord);
    }
    // The water side: each plant with the chillers, boilers and pumps that are part of it, and the
    // units it sends water to. A plant on its own still gets a group, so it is not lost above the map.
    const water = serves.filter((s) => s.medium !== "air" && usable(s) && byOrd.has(s.from) && byOrd.has(s.to));
    const isPlant = (u: Unit) => /Plant$/.test(u.kind);
    // What a unit is part of: what the station says, else the plant a chiller or boiler sends its water to.
    const headOf = (u: Unit) => (u.partOf && byOrd.has(u.partOf) ? u.partOf : PLANT.has(u.kind) && !isPlant(u) ? water.find((s) => s.from === u.ord && isPlant(byOrd.get(s.to)!))?.to : undefined);
    const parts = units.filter((u) => !done.has(u.ord) && headOf(u) && !done.has(headOf(u)!));
    const sends = (u: Unit) => water.some((s) => s.from === u.ord && !PLANT.has(byOrd.get(s.to)!.kind));
    const heads = units.filter((u) => !done.has(u.ord) && !parts.includes(u) && (parts.some((p) => headOf(p) === u.ord) || isPlant(u) || (PLANT.has(u.kind) && sends(u))));
    for (const head of heads) {
      const members = parts.filter((p) => headOf(p) === head.ord);
      const from = new Set([head.ord, ...members.map((m) => m.ord)]);
      const fed = (["chilledWater", "hotWater"] as const).map((medium): WaterFed => {
        const mine = water.filter((s) => s.medium === medium && from.has(s.from) && !from.has(s.to) && !PLANT.has(byOrd.get(s.to)!.kind));
        return { medium, units: [...new Set(mine.map((s) => byOrd.get(s.to)!))].sort((a, b) => Number(a.zone) - Number(b.zone) || natural.compare(a.name, b.name)), guessed: mine.some((s) => s.inferred && !s.confirmed) };
      }).filter((w) => w.units.length);
      groups.push({ key: head.ord, title: head.name, feeder: head, members, by: "part", side: sideOf(head.kind), guessed: false, water: fed });
      done.add(head.ord);
      for (const m of members) done.add(m.ord);
    }
    // What nothing is known to feed: with others of its kind, and by the folder it sits in only when what it is is not known either.
    gather("kind", byKind);
    gather("wiring", byFolder);
  }
  void fedBy;
  const open = serves.filter((s) => s.inferred && !s.confirmed);
  return { station: review.station, units, plant, groups, review, guesses: { sure: open.filter((s) => s.confidence >= UNSURE).length, unsure: open.filter((s) => s.confidence < UNSURE).length }, truncated, arrange, placed };
}

/** Reads the station and builds the map's model, keeping what a person confirmed in an earlier review. */
export async function readSite(client: BaskStreamClient, station: string, earlier?: ModelReview, under = "slot:/", tiles: Record<string, string> = {}): Promise<Site> {
  const { evidence, truncated, places } = await readEvidence(client, under);
  const equipment = inferModel(evidence);
  // A point is writable when the station says so; the review's tags do not always carry it.
  const writable = new Set(evidence.flatMap((item) => item.points.filter((p) => p.writable).map((p) => p.ord)));
  const site = buildSite(buildReview(station, under, equipment, earlier, inferServes(equipment, [], evidence), places), truncated, tiles);
  site.writable = writable;
  for (const unit of site.units) for (const point of unit.points) point.writable = writable.has(point.ord);
  return site;
}

/** A tile's label: the unit's name without what every member of its group starts with ("VAV_101" as "101"). */
export function tileLabels(members: Unit[]): Map<string, string> {
  const names = members.map((m) => m.name);
  let prefix = names[0] ?? "";
  for (const name of names) while (prefix && !name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  // Cut at a break in the name, and never down to nothing.
  const cut = prefix.search(/[^A-Za-z]*$/) >= 0 && names.length > 1 ? prefix.replace(/[0-9]+$/, "") : "";
  const strip = cut.length >= 2 && names.every((name) => name.length > cut.length) ? cut.length : 0;
  return new Map(members.map((m) => [m.ord, m.name.slice(strip)]));
}
