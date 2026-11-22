// What the map is drawn from: the station's equipment, what each piece is, and what feeds what.
// It comes from what the station holds (the tree, tags, relations) plus guesses from names, the same
// ones `bask model infer` writes to a review file. Where nothing says what feeds a unit, it is grouped
// the way the station is wired: by the network or folder it sits in.
import type { BaskStreamClient } from "./core.js";
import { shortOrd } from "./format.js";
import { UNSURE, buildReview, inferModel, inferServes, readEvidence, type ModelEquipment, type ModelReview, type ModelServes } from "./model.js";

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
  /** A terminal unit: a room's box, drawn as a tile under whatever feeds it. */
  zone: boolean;
  /** The network or folder it sits in, by name and ORD. */
  wiring: string;
  wiringOrd: string;
}

export interface Group {
  key: string;
  title: string;
  /** The unit that feeds the members, for a group made from what serves what. */
  feeder?: Unit;
  members: Unit[];
  by: "serves" | "wiring";
  /** Made from a guess a person has not confirmed. */
  guessed: boolean;
}

export interface Site {
  station: string;
  units: Unit[];
  /** Plant: what makes hot or chilled water, drawn as a strip above the groups. */
  plant: Unit[];
  groups: Group[];
  review: ModelReview;
  /** Guesses about what feeds what that a person has not confirmed. */
  guesses: { sure: number; unsure: number };
  truncated: boolean;
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

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const parentOf = (ord: string) => ord.slice(0, Math.max(ord.lastIndexOf("/"), "slot:".length));

function unitOf(e: ModelEquipment, tiles: Record<string, string> = {}): Unit {
  const points: SitePoint[] = e.points.map((p) => ({ ord: p.ord, name: p.name, role: p.role, label: p.label, unit: p.unit, writable: p.tags.includes("cmd") || p.tags.includes("sp") })).sort((a, b) => natural.compare(a.name, b.name));
  const byRole = (roles: string[] | undefined) => (roles ?? []).map((role) => points.find((p) => p.role === role)).find(Boolean);
  // A person's choice for this unit, or for its kind, comes before the usual reading.
  const chosen = tiles[e.ord] ?? tiles[e.kind];
  const picked = chosen ? points.find((p) => p.name.toLowerCase() === chosen.toLowerCase()) : undefined;
  const headline = picked ?? byRole(HEADLINE[e.kind]) ?? byRole(["zoneTemp", "supplyAirTemp", "leavingWaterTemp", "boxTemp"]);
  // Units that are folders inside a controller's "points" are wired where the controller is.
  const above = parentOf(e.ord);
  const wiringOrd = /\/points$/i.test(above) ? parentOf(above) : above;
  return {
    ord: e.ord, name: e.name, kind: e.kind, label: e.label, points, headline, setpoint: headline ? byRole(SETPOINT[headline.role]) : undefined,
    zone: ZONE.has(e.kind) || (e.kind === "unknown" && headline?.role === "zoneTemp"), wiring: shortOrd(wiringOrd, 1), wiringOrd
  };
}

/** A serving entry good enough to draw from: on the station already, confirmed by a person, or a guess that is fairly sure. */
const usable = (s: ModelServes) => !s.inferred || s.confirmed || s.confidence >= UNSURE;

/** The map's model from a review document. Pure. */
export function buildSite(review: ModelReview, truncated = false, tiles: Record<string, string> = {}): Site {
  // Something with points that is no kind of equipment and has no reading to lead with (a folder of
  // test points, a schedule's helpers) is left off the map. It is still on the station.
  const units = review.equipment.filter((e) => e.points.length > 0).map((e) => unitOf(e, tiles)).filter((u) => u.kind !== "unknown" || u.headline).sort((a, b) => natural.compare(a.name, b.name));
  const byOrd = new Map(units.map((u) => [u.ord, u]));
  const serves = review.serves ?? [];
  const air = serves.filter((s) => s.medium === "air" && usable(s) && byOrd.has(s.from) && byOrd.has(s.to));
  const fedBy = new Map(air.map((s) => [s.to, s]));
  const groups: Group[] = [];
  const placed = new Set<string>();
  // Everything that feeds air gets a group, and so does every air handler, fed zones known or not.
  const feeders = units.filter((u) => air.some((s) => s.from === u.ord) || u.kind === "ahu");
  for (const feeder of feeders) {
    const mine = air.filter((s) => s.from === feeder.ord);
    const members = mine.map((s) => byOrd.get(s.to)!).sort((a, b) => natural.compare(a.name, b.name));
    groups.push({ key: feeder.ord, title: feeder.name, feeder, members, by: "serves", guessed: mine.some((s) => s.inferred && !s.confirmed) });
    placed.add(feeder.ord);
    for (const m of members) placed.add(m.ord);
  }
  const plant = units.filter((u) => !placed.has(u.ord) && PLANT.has(u.kind));
  for (const p of plant) placed.add(p.ord);
  // What is left sits where it is wired.
  const wired = new Map<string, Unit[]>();
  for (const u of units) if (!placed.has(u.ord) && !fedBy.has(u.ord)) wired.set(u.wiringOrd, [...(wired.get(u.wiringOrd) ?? []), u]);
  for (const [ord, members] of [...wired].sort((a, b) => natural.compare(a[0], b[0]))) groups.push({ key: ord, title: shortOrd(ord, 1), members, by: "wiring", guessed: false });
  const open = serves.filter((s) => s.inferred && !s.confirmed);
  return { station: review.station, units, plant, groups, review, guesses: { sure: open.filter((s) => s.confidence >= UNSURE).length, unsure: open.filter((s) => s.confidence < UNSURE).length }, truncated };
}

/** Reads the station and builds the map's model, keeping what a person confirmed in an earlier review. */
export async function readSite(client: BaskStreamClient, station: string, earlier?: ModelReview, under = "slot:/", tiles: Record<string, string> = {}): Promise<Site> {
  const { evidence, truncated } = await readEvidence(client, under);
  const equipment = inferModel(evidence);
  // A point is writable when the station says so; the review's tags do not always carry it.
  const writable = new Set(evidence.flatMap((item) => item.points.filter((p) => p.writable).map((p) => p.ord)));
  const site = buildSite(buildReview(station, under, equipment, earlier, inferServes(equipment, [], evidence)), truncated, tiles);
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
