// bask model: what the station's components mean (docs/ROADMAP.md, F). `infer` proposes which
// components are equipment and of what kind, what each point under them is for, and which equipment
// feeds which, each with a confidence between 0 and 1 and the reason in words. The result is a file
// a person corrects and confirms. Nothing is written to the station here: model-write.ts writes the
// confirmed entries as tags and relations, and exports them as Brick. `export` in this file writes
// them as a Haystack grid.
import chalk from "chalk";
import { toSlotOrd, type BaskStreamClient, type Json } from "./core.js";
import { walkTree, type WalkNode } from "./check.js";
import { csv, shortOrd, table } from "./format.js";
import { nameScore, tokens } from "./names.js";

export const MODEL_FORMAT = "bask-model";
/** Below this an entry is called uncertain: it is listed in the table and comes first in the file. */
export const UNSURE = 0.7;

export interface ModelPoint {
  ord: string;
  name: string;
  /** What the point is for, e.g. supplyAirTemp; "unknown" when nothing fits. */
  role: string;
  label: string;
  /** The Haystack marker tags the role stands for. Edit these to change what is exported. */
  tags: string[];
  confidence: number;
  reason: string;
  /** Set by a person. Only confirmed entries are exported. */
  confirmed: boolean;
  /** Engineering units, when the point has them. */
  unit?: string;
  /** Number, Bool or Str. */
  valueKind?: string;
}

export interface ModelEquipment {
  ord: string;
  name: string;
  /** ahu, vav, chilledWaterPlant…; "unknown" when nothing fits. */
  kind: string;
  label: string;
  tags: string[];
  confidence: number;
  reason: string;
  confirmed: boolean;
  points: ModelPoint[];
  /** Where it is, from the station's siteRef and spaceRef relations: ORDs that are keys of the review's places. */
  site?: string;
  space?: string;
  /** The equipment it is part of, from an equipRef to other equipment (a chiller in its plant). */
  partOf?: string;
}

/** A building, floor or room the station holds, that equipment points at. */
export interface ModelPlace {
  ord: string;
  /** Its display name ("Level 1"), or the component's name. */
  name: string;
  kind: "site" | "floor" | "room" | "space";
  /** The space it is in (a room's floor), and its building. */
  parent?: string;
  site?: string;
}

/** What flows from one piece of equipment to another. */
export type Medium = "air" | "chilledWater" | "hotWater";

/** A proposal that one piece of equipment feeds another: an air handler its VAV boxes, a plant its coils. */
export interface ModelServes {
  /** The equipment that feeds. */
  from: string;
  fromName: string;
  /** The equipment that is fed. */
  to: string;
  toName: string;
  medium: Medium;
  confidence: number;
  reason: string;
  /** Set by a person. Only confirmed entries are exported or written. */
  confirmed: boolean;
  /** True for a proposal worked out here; false for a relation the station already holds. */
  inferred: boolean;
}

export interface ModelReview {
  format: typeof MODEL_FORMAT;
  version: 1;
  station: string;
  under: string;
  howTo: string;
  equipment: ModelEquipment[];
  /** What serves what. Absent in a file written before bask proposed it. */
  serves?: ModelServes[];
  /** The buildings, floors and rooms equipment points at, by ORD. */
  places?: Record<string, ModelPlace>;
}

/** What is read from the station about one group of points before anything is inferred. */
export interface Evidence {
  ord: string;
  name: string;
  typeSpec: string;
  /** Its Haystack marker tags already on the station, from either dictionary (hs: or h4:), without the prefix. */
  tags: string[];
  /** Haystack relations that leave it on the station already: "airRef" to another component. */
  relations?: { name: string; to: string }[];
  points: { ord: string; name: string; typeSpec: string; writable: boolean; units?: string; valueType?: string; tags: string[] }[];
}

// ---- What points are for ----------------------------------------------------------------------------

type UnitFamily = "temp" | "percent" | "rh" | "pressure" | "airflow" | "waterflow" | "power" | "current" | "energy" | "bool";
const FAMILIES: Record<Exclude<UnitFamily, "bool">, RegExp> = {
  temp: /°|deg ?[fck]\b|fahrenheit|celsius|kelvin/i,
  percent: /^%$|^percent$/i,
  rh: /%\s?rh|^rh$/i,
  pressure: /inH|in\.?\/?wc|psi|\bk?pa\b|bar\b|inHg/i,
  airflow: /cfm|l\/s|m³\/h|cmh/i,
  waterflow: /gpm|l\/s|l\/min|m³\/h/i,
  power: /^[km]?w$/i,
  current: /^m?a$|^amps?$/i,
  energy: /^[km]?wh$/i
};

interface Role {
  id: string;
  label: string;
  /** The names it goes by, in plain words; the matcher spells out abbreviations on both sides. */
  phrases: string[];
  tags: string[];
  units?: UnitFamily;
  /** A command or setpoint (something written) rather than a reading. */
  written?: boolean;
}

const ROLES: Role[] = [
  { id: "supplyAirTemp", label: "supply air temperature", phrases: ["supply air temp"], tags: ["discharge", "air", "temp", "sensor"], units: "temp" },
  { id: "returnAirTemp", label: "return air temperature", phrases: ["return air temp"], tags: ["return", "air", "temp", "sensor"], units: "temp" },
  { id: "mixedAirTemp", label: "mixed air temperature", phrases: ["mixed air temp"], tags: ["mixed", "air", "temp", "sensor"], units: "temp" },
  { id: "outsideAirTemp", label: "outside air temperature", phrases: ["outside air temp"], tags: ["outside", "air", "temp", "sensor"], units: "temp" },
  { id: "supplyAirTempSp", label: "supply air temperature setpoint", phrases: ["supply air temp setpoint", "supply air setpoint"], tags: ["discharge", "air", "temp", "sp"], units: "temp", written: true },
  { id: "supplyAirHumidity", label: "supply air humidity", phrases: ["supply air humidity"], tags: ["discharge", "air", "humidity", "sensor"], units: "rh" },
  { id: "supplyAirPressure", label: "supply air static pressure", phrases: ["duct static pressure", "supply air static pressure", "static pressure"], tags: ["discharge", "air", "pressure", "sensor"], units: "pressure" },
  { id: "supplyAirPressureSp", label: "supply air static pressure setpoint", phrases: ["duct static pressure setpoint", "supply static pressure setpoint", "static pressure setpoint"], tags: ["discharge", "air", "pressure", "sp"], units: "pressure", written: true },
  { id: "supplyAirFlow", label: "supply airflow", phrases: ["supply airflow", "supply air flow"], tags: ["discharge", "air", "flow", "sensor"], units: "airflow" },
  { id: "supplyFanSpeed", label: "supply fan speed command", phrases: ["supply fan speed", "supply fan speed command"], tags: ["discharge", "fan", "speed", "cmd"], units: "percent", written: true },
  { id: "supplyFanStatus", label: "supply fan status", phrases: ["supply fan status"], tags: ["discharge", "fan", "run", "sensor"], units: "bool" },
  { id: "returnFanStatus", label: "return fan status", phrases: ["return fan status"], tags: ["return", "fan", "run", "sensor"], units: "bool" },
  { id: "fanStatus", label: "fan status", phrases: ["fan status", "evap fan status"], tags: ["fan", "run", "sensor"], units: "bool" },
  { id: "fanSpeed", label: "fan speed command", phrases: ["fan speed", "condenser fan speed"], tags: ["fan", "speed", "cmd"], units: "percent", written: true },
  { id: "coolingValve", label: "cooling valve command", phrases: ["cool valve", "cool valve command"], tags: ["cool", "valve", "cmd"], units: "percent", written: true },
  { id: "heatingValve", label: "heating valve command", phrases: ["heat valve", "heat valve command"], tags: ["heat", "valve", "cmd"], units: "percent", written: true },
  { id: "reheatValve", label: "reheat valve command", phrases: ["reheat valve", "reheat valve command"], tags: ["reheat", "valve", "cmd"], units: "percent", written: true },
  { id: "humidifierValve", label: "humidifier valve command", phrases: ["humidifier valve"], tags: ["humidifier", "valve", "cmd"], units: "percent", written: true },
  { id: "outsideDamper", label: "outside air damper command", phrases: ["outside air damper", "outside air damper command", "outside damper"], tags: ["outside", "damper", "cmd"], units: "percent", written: true },
  { id: "damper", label: "damper command", phrases: ["damper position", "damper command", "damper"], tags: ["damper", "cmd"], units: "percent", written: true },
  { id: "filterDp", label: "filter pressure drop", phrases: ["filter dp", "hepa filter dp"], tags: ["filter", "pressure", "sensor"], units: "pressure" },
  { id: "airflow", label: "airflow", phrases: ["airflow", "air flow", "exhaust flow"], tags: ["air", "flow", "sensor"], units: "airflow" },
  { id: "airflowSp", label: "airflow setpoint", phrases: ["airflow setpoint"], tags: ["air", "flow", "sp"], units: "airflow", written: true },
  { id: "zoneTemp", label: "zone temperature", phrases: ["zone temp"], tags: ["zone", "air", "temp", "sensor"], units: "temp" },
  { id: "zoneTempSp", label: "zone temperature setpoint", phrases: ["zone setpoint", "zone temp setpoint"], tags: ["zone", "air", "temp", "sp"], units: "temp", written: true },
  { id: "zoneCoolingSp", label: "zone cooling setpoint", phrases: ["occupied cool setpoint", "cool setpoint"], tags: ["zone", "air", "temp", "cooling", "sp"], units: "temp", written: true },
  { id: "zoneHeatingSp", label: "zone heating setpoint", phrases: ["occupied heat setpoint", "heat setpoint"], tags: ["zone", "air", "temp", "heating", "sp"], units: "temp", written: true },
  { id: "zoneHumidity", label: "zone humidity", phrases: ["zone humidity", "humidity"], tags: ["zone", "air", "humidity", "sensor"], units: "rh" },
  { id: "zonePressure", label: "room pressure", phrases: ["zone pressure"], tags: ["zone", "air", "pressure", "sensor"], units: "pressure" },
  { id: "occupancyCmd", label: "occupancy command", phrases: ["occupied command", "occupied mode"], tags: ["occupied", "cmd"], written: true },
  { id: "occupancyStatus", label: "occupancy status", phrases: ["occupied status", "occupied"], tags: ["occupied", "sensor"], units: "bool" },
  { id: "chwSupplyTemp", label: "chilled water supply temperature", phrases: ["chilled water supply temp", "chilled supply temp"], tags: ["chilled", "water", "leaving", "temp", "sensor"], units: "temp" },
  { id: "chwReturnTemp", label: "chilled water return temperature", phrases: ["chilled water return temp", "chilled return temp"], tags: ["chilled", "water", "entering", "temp", "sensor"], units: "temp" },
  { id: "chwSupplyTempSp", label: "chilled water supply temperature setpoint", phrases: ["chilled water supply temp setpoint", "chilled supply temp setpoint", "chilled supply setpoint"], tags: ["chilled", "water", "leaving", "temp", "sp"], units: "temp", written: true },
  { id: "chwFlow", label: "chilled water flow", phrases: ["chilled water flow", "chilled flow", "chilled header flow"], tags: ["chilled", "water", "flow", "sensor"], units: "waterflow" },
  { id: "hwSupplyTemp", label: "hot water supply temperature", phrases: ["hot water supply temp", "hw supply temp"], tags: ["hot", "water", "leaving", "temp", "sensor"], units: "temp" },
  { id: "hwReturnTemp", label: "hot water return temperature", phrases: ["hot water return temp", "hw return temp"], tags: ["hot", "water", "entering", "temp", "sensor"], units: "temp" },
  { id: "hwSupplyTempSp", label: "hot water supply temperature setpoint", phrases: ["hot water supply temp setpoint", "hw supply temp setpoint", "hw supply setpoint"], tags: ["hot", "water", "leaving", "temp", "sp"], units: "temp", written: true },
  { id: "hwFlow", label: "hot water flow", phrases: ["hot water flow", "hw flow", "hw header flow"], tags: ["hot", "water", "flow", "sensor"], units: "waterflow" },
  { id: "leavingWaterTemp", label: "leaving water temperature", phrases: ["leaving water temp"], tags: ["water", "leaving", "temp", "sensor"], units: "temp" },
  { id: "enteringWaterTemp", label: "entering water temperature", phrases: ["entering water temp"], tags: ["water", "entering", "temp", "sensor"], units: "temp" },
  { id: "leavingWaterTempSp", label: "leaving water temperature setpoint", phrases: ["leaving water temp setpoint"], tags: ["water", "leaving", "temp", "sp"], units: "temp", written: true },
  { id: "waterFlow", label: "water flow", phrases: ["flow", "water flow", "evaporator flow"], tags: ["water", "flow", "sensor"], units: "waterflow" },
  { id: "pumpSpeed", label: "pump speed command", phrases: ["pump speed", "speed command", "pump speed command"], tags: ["pump", "speed", "cmd"], units: "percent", written: true },
  { id: "speedFeedback", label: "speed feedback", phrases: ["speed feedback"], tags: ["speed", "sensor"], units: "percent" },
  { id: "runStatus", label: "run status", phrases: ["run status", "unit status", "chiller status", "boiler status", "pump status", "compressor status"], tags: ["run", "sensor"], units: "bool" },
  { id: "enableCmd", label: "enable command", phrases: ["enable command", "plant enable", "enable"], tags: ["enable", "cmd"], units: "bool", written: true },
  { id: "enableStatus", label: "enable status", phrases: ["enable status"], tags: ["enable", "sensor"], units: "bool" },
  { id: "alarmStatus", label: "alarm status", phrases: ["alarm status", "alarm", "master alarm"], tags: ["alarm", "sensor"], units: "bool" },
  { id: "doorStatus", label: "door status", phrases: ["door status"], tags: ["door", "sensor"], units: "bool" },
  { id: "boxTemp", label: "box temperature", phrases: ["box temp"], tags: ["air", "temp", "sensor"], units: "temp" },
  { id: "boxTempSp", label: "box temperature setpoint", phrases: ["box setpoint", "box temp setpoint"], tags: ["air", "temp", "sp"], units: "temp", written: true },
  { id: "power", label: "electrical power", phrases: ["power", "output power"], tags: ["elec", "power", "sensor"], units: "power" },
  { id: "current", label: "electrical current", phrases: ["current"], tags: ["elec", "current", "sensor"], units: "current" },
  { id: "energy", label: "electrical energy", phrases: ["energy", "energy today"], tags: ["elec", "energy", "sensor"], units: "energy" },
  { id: "load", label: "load", phrases: ["load", "load percent", "cool load", "heat load", "cool output"], tags: ["load", "sensor"], units: "percent" }
];
/** The least a point's name must score against a role's name for the role to be proposed. */
const NAME_FLOOR = 0.65;
const ROLE_WORDS = ROLES.map((role) => role.phrases.map((phrase) => tokens(phrase)));

/** A proposal is never certain: only what is already tagged on the station is 1. */
const round = (n: number) => Math.round(Math.max(0, Math.min(0.95, n)) * 100) / 100;
const noDigits = (words: string[]) => words.filter((word) => !/^\d+$/.test(word));

function unitFit(role: Role, units: string | undefined, valueType: string | undefined): { fit: number; why: string } {
  const isBool = /bool/i.test(valueType ?? "");
  if (!role.units) return { fit: 0.5, why: "" };
  if (role.units === "bool") return isBool ? { fit: 1, why: "two-state" } : { fit: valueType ? 0 : 0.5, why: valueType ? `not two-state (${valueType})` : "" };
  if (isBool) return { fit: 0, why: "two-state, not a number" };
  if (!units) return { fit: 0.5, why: "no units" };
  return FAMILIES[role.units].test(units) ? { fit: 1, why: `units ${units}` } : { fit: 0, why: `units ${units} do not fit` };
}

/** The role a point's name, units and type point to. */
function inferRole(point: Evidence["points"][number]): { role: Role | undefined; confidence: number; reason: string } {
  const words = noDigits(tokens(point.name));
  const raw = point.name.replace(/\d+/g, "");
  let best: { role: Role; name: number; total: number; why: string[] } | undefined;
  let nearest = { name: 0, label: "" };
  ROLES.forEach((role, i) => {
    const name = Math.max(...ROLE_WORDS[i].map((phrase) => nameScore(words, raw, phrase, "")));
    if (name > nearest.name) nearest = { name, label: role.label };
    // A name this far from a role's is more often something else than that role.
    if (name < NAME_FLOOR) return;
    const units = unitFit(role, point.units, point.valueType);
    const typed = role.written ? (point.writable ? 1 : 0.3) : point.writable ? 0.5 : 1;
    const total = 0.75 * name + 0.15 * units.fit + 0.1 * typed;
    if (!best || total > best.total) best = { role, name, total, why: [`name ${name.toFixed(2)}`, units.why, role.written ? (point.writable ? "writable" : "not writable") : point.writable ? "writable" : "read-only"].filter(Boolean) };
  });
  if (!best) {
    // A name that says nothing, on a point the station has tagged: the role whose tags it carries, the fullest first.
    const have = new Set(point.tags);
    const byTags = ROLES.filter((role) => role.tags.length >= 2 && role.tags.every((tag) => have.has(tag))).sort((x, y) => y.tags.length - x.tags.length)[0];
    if (byTags) return { role: byTags, confidence: 0.9, reason: `tagged ${byTags.tags.join(", ")}` };
  }
  if (!best) return { role: undefined, confidence: 0.5 * nearest.name, reason: nearest.name ? `the nearest role is ${nearest.label}, name ${nearest.name.toFixed(2)}: too far to propose` : `no role has a name like "${point.name}"` };
  return { role: best.role, confidence: best.total, reason: best.why.join(", ") };
}

// ---- What equipment is ------------------------------------------------------------------------------

interface Kind {
  id: string;
  label: string;
  tags: string[];
  /** Words in a name that say this kind, each with how much it says (short abbreviations say less). */
  names: [string, number][];
  /** Roles its points usually include: one group counts when any role in it is there. */
  has: string[][];
}

const KINDS: Kind[] = [
  { id: "ahu", label: "air handler", tags: ["ahu", "equip"], names: [["ahu", 1], ["rtu", 1], ["mau", 1], ["air handler", 1], ["rooftop", 0.8]], has: [["supplyAirTemp"], ["mixedAirTemp", "returnAirTemp", "outsideAirTemp"], ["supplyFanSpeed", "supplyFanStatus", "coolingValve", "heatingValve"]] },
  { id: "vav", label: "VAV box", tags: ["vav", "equip"], names: [["vav", 1], ["terminal unit", 0.8]], has: [["zoneTemp"], ["damper", "airflow", "reheatValve"]] },
  { id: "fcu", label: "fan coil unit", tags: ["fcu", "equip"], names: [["fcu", 1], ["fan coil", 1]], has: [["zoneTemp"], ["fanStatus", "fanSpeed"], ["coolingValve", "heatingValve"]] },
  { id: "crac", label: "computer room air conditioner", tags: ["crac", "equip"], names: [["crac", 1], ["crah", 1]], has: [["supplyAirTemp"], ["returnAirTemp"], ["runStatus", "load", "fanSpeed"]] },
  { id: "chilledWaterPlant", label: "chilled water plant", tags: ["chilledWaterPlant", "equip"], names: [["chilled plant", 1], ["chilled water plant", 1], ["chiller plant", 1]], has: [["chwSupplyTemp"], ["chwReturnTemp", "chwFlow"]] },
  { id: "hotWaterPlant", label: "hot water plant", tags: ["hotWaterPlant", "equip"], names: [["hw plant", 1], ["hot water plant", 1], ["heat water plant", 1], ["boiler plant", 1]], has: [["hwSupplyTemp"], ["hwReturnTemp", "hwFlow"]] },
  { id: "chiller", label: "chiller", tags: ["chiller", "equip"], names: [["chiller", 1], ["ch", 0.6]], has: [["leavingWaterTemp", "chwSupplyTemp"], ["enteringWaterTemp", "chwReturnTemp"], ["load", "runStatus"]] },
  { id: "boiler", label: "boiler", tags: ["boiler", "equip"], names: [["boiler", 1], ["b", 0.5]], has: [["leavingWaterTemp", "hwSupplyTemp"], ["enteringWaterTemp", "hwReturnTemp"], ["load", "runStatus"]] },
  { id: "pump", label: "pump", tags: ["pump", "equip"], names: [["pump", 1], ["chwp", 0.9], ["hwp", 0.9], ["cwp", 0.9]], has: [["pumpSpeed", "speedFeedback"], ["runStatus", "waterFlow"]] },
  { id: "coolingTower", label: "cooling tower", tags: ["coolingTower", "equip"], names: [["cool tower", 1], ["tower", 0.8], ["ct", 0.6]], has: [["fanSpeed", "fanStatus"], ["leavingWaterTemp"]] },
  { id: "freezer", label: "freezer", tags: ["freezer", "equip"], names: [["freezer", 1]], has: [["boxTemp"]] },
  { id: "cooler", label: "cooler", tags: ["cooler", "equip"], names: [["cooler", 1], ["fridge", 0.9], ["refrigerator", 1]], has: [["boxTemp"]] },
  { id: "compressor", label: "compressor rack", tags: ["compressor", "equip"], names: [["compressor", 1], ["rack", 0.8]], has: [["runStatus"], ["fanSpeed"]] },
  { id: "meter", label: "electric meter", tags: ["meter", "elec", "equip"], names: [["meter", 1]], has: [["power"], ["current", "energy"]] },
  { id: "ups", label: "UPS", tags: ["ups", "equip"], names: [["ups", 1]], has: [["load"], ["power"]] },
  { id: "pdu", label: "power distribution unit", tags: ["pdu", "equip"], names: [["pdu", 1]], has: [["power"], ["current", "load"]] },
  { id: "generator", label: "generator", tags: ["generator", "equip"], names: [["generator", 1], ["genset", 1], ["gen", 0.7]], has: [] },
  { id: "room", label: "room", tags: ["room", "equip"], names: [["room", 0.8], ["hall", 0.6]], has: [["zoneTemp", "zonePressure"], ["zoneHumidity", "zonePressure", "doorStatus", "occupancyStatus"]] }
];
const KIND_WORDS = KINDS.map((kind) => kind.names.map(([phrase, weight]) => [tokens(phrase), weight] as const));
/** Every word the roles and kinds are written in, in lower case: the words in a name that say what a thing is. */
export const MODEL_WORDS = new Set([...ROLES.flatMap((role) => [...role.phrases, role.label, ...role.tags]), ...KINDS.flatMap((kind) => [...kind.names.map(([phrase]) => phrase), kind.label, ...kind.tags])].flatMap((text) => text.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/)).map((word) => word.toLowerCase()).filter(Boolean));

/** How strongly a name says a kind: every word of one of the kind's names is among the name's words. */
function nameSays(words: string[], kind: number): { score: number; word: string } {
  let best = { score: 0, word: "" };
  for (const [phrase, weight] of KIND_WORDS[kind]) {
    if (phrase.every((word) => words.includes(word)) && weight > best.score) best = { score: weight, word: phrase.join(" ") };
  }
  return best;
}

const family = (name: string) => name.replace(/\d+/g, "*");
const HOW_TO = 'Review this file, uncertain entries first. Where a proposal is right, set "confirmed": true. Where it is wrong, change "kind" or "role", "label" and "tags" (the Haystack marker tags that will be exported), then confirm it. Under "serves", each entry says one piece of equipment feeds another; every one marked "inferred": true is a proposal, so confirm it, correct its "from", or leave it. Entries left unconfirmed are never exported or written. Running bask model infer again keeps what you confirmed.';

/** The proposals for the evidence read from a station, uncertain ones first. Pure: nothing is read here. */
export function inferModel(evidence: Evidence[]): ModelEquipment[] {
  const drafts = evidence.map((item) => {
    const points = item.points.map((point) => ({ point, ...inferRole(point) }));
    const roles = new Set(points.map((p) => p.role?.id).filter(Boolean));
    const words = tokens(item.name);
    const tagged = KINDS.find((kind) => item.tags.includes(kind.tags[0]));
    let best: { kind: Kind; score: number; why: string[] } | undefined;
    KINDS.forEach((kind, i) => {
      const name = nameSays(words, i);
      // Each group needs a role of its own: one point does not stand for two things.
      const used = new Set<string>();
      for (const group of kind.has) {
        const role = group.find((id) => roles.has(id) && !used.has(id));
        if (role) used.add(role);
      }
      const shape = kind.has.length ? used.size / kind.has.length : 0;
      const score = 1 - (1 - 0.6 * name.score) * (1 - 0.6 * shape);
      if (score <= 0 || (best && score <= best.score)) return;
      const have = [...used].map((id) => ROLES.find((role) => role.id === id)!.label);
      best = { kind, score, why: [name.score ? `name says ${name.word}${name.score < 1 ? ` (${name.score.toFixed(1)})` : ""}` : "", have.length ? `has ${have.join(", ")}` : kind.has.length ? "none of its usual points" : ""].filter(Boolean) };
    });
    return { item, points, tagged, best: best as { kind: Kind; score: number; why: string[] } | undefined };
  });

  // Siblings: equipment named alike (VAV_101, VAV_102…) that came out the same kind back each other up,
  // and so do points of the same name across them.
  const kindOf = (draft: (typeof drafts)[number]) => draft.tagged?.id ?? draft.best?.kind.id ?? "unknown";
  const alike = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const key = `${draft.item.ord.slice(0, draft.item.ord.lastIndexOf("/"))}/${family(draft.item.name)}|${kindOf(draft)}`;
    alike.set(key, [...(alike.get(key) ?? []), draft]);
  }
  const equipment: ModelEquipment[] = [];
  for (const group of alike.values()) {
    const others = group.length - 1;
    const roleCounts = new Map<string, number>();
    for (const draft of group) for (const p of draft.points) if (p.role) roleCounts.set(`${p.point.name}|${p.role.id}`, (roleCounts.get(`${p.point.name}|${p.role.id}`) ?? 0) + 1);
    for (const draft of group) {
      const agree = others ? `${others} sibling${others === 1 ? "" : "s"} agree${others === 1 ? "s" : ""}` : "";
      const points: ModelPoint[] = draft.points.map(({ point, role, confidence, reason }) => {
        const extra = { ...(point.units ? { unit: point.units } : {}), ...(point.valueType ? { valueKind: /bool/i.test(point.valueType) ? "Bool" : /num/i.test(point.valueType) ? "Number" : "Str" } : {}) };
        if (point.tags.length) return { ord: point.ord, name: point.name, role: role?.id ?? "tagged", label: role?.label ?? "already tagged", tags: point.tags, confidence: 1, reason: `already tagged ${point.tags.join(", ")}`, confirmed: true, ...extra };
        if (!role) return { ord: point.ord, name: point.name, role: "unknown", label: "unknown", tags: ["point"], confidence: round(confidence), reason, confirmed: false, ...extra };
        const same = (roleCounts.get(`${point.name}|${role.id}`) ?? 1) - 1;
        return { ord: point.ord, name: point.name, role: role.id, label: role.label, tags: [...role.tags, "point"], confidence: round(confidence + Math.min(0.05, same * 0.01)), reason: [reason, same ? `same on ${same} sibling${same === 1 ? "" : "s"}` : ""].filter(Boolean).join(", "), confirmed: false, ...extra };
      }).sort((a, b) => a.confidence - b.confidence || (a.ord < b.ord ? -1 : 1));
      const { item, tagged, best } = draft;
      const to = (name: string) => item.relations?.find((r) => r.name === name)?.to;
      const base = { ord: item.ord, name: item.name, ...(to("siteRef") ? { site: to("siteRef") } : {}), ...(to("spaceRef") ? { space: to("spaceRef") } : {}), ...(to("equipRef") ? { partOf: to("equipRef") } : {}) };
      if (tagged) equipment.push({ ...base, kind: tagged.id, label: tagged.label, tags: item.tags, confidence: 1, reason: `already tagged ${item.tags.join(", ")}`, confirmed: true, points });
      else if (!best) equipment.push({ ...base, kind: "unknown", label: "unknown", tags: ["equip"], confidence: 0.2, reason: `neither the name "${item.name}" nor its points say what it is`, confirmed: false, points });
      else equipment.push({ ...base, kind: best.kind.id, label: best.kind.label, tags: best.kind.tags, confidence: round(best.score + Math.min(0.1, others * 0.02)), reason: [...best.why, agree].filter(Boolean).join("; "), confirmed: false, points });
    }
  }
  const lowest = (e: ModelEquipment) => Math.min(e.confidence, ...e.points.map((p) => p.confidence));
  return equipment.sort((a, b) => lowest(a) - lowest(b) || (a.ord < b.ord ? -1 : 1));
}

// ---- Reading the station ---------------------------------------------------------------------------

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
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_v, i) => items.slice(i * size, (i + 1) * size));

/**
 * Reads what inference goes on: the tree (names, types, folder shape) with browse, each point's units
 * and value type with a read, and Haystack tags already there with read_tags. Points are grouped under
 * the device they belong to, or the folder they are in when there is no device above them.
 */
/** The Haystack dictionaries a station is tagged with: the older one and Haystack 4. */
const DICTIONARIES = ["hs", "h4"];

/**
 * What the station's Haystack tags say about some components, from both dictionaries: marker tags
 * (the ones set on the component where there are any, otherwise the ones a tag rule implies), the
 * relations that leave it, and its display name.
 */
async function readHaystack(client: BaskStreamClient, ords: string[]): Promise<{ ord: string; display: string; dis: string; tags: string[]; relations: { name: string; to: string }[] }[]> {
  const out = new Map<string, { ord: string; display: string; dis: string; direct: Set<string>; implied: Set<string>; relations: Map<string, { name: string; to: string }> }>();
  await Promise.all(DICTIONARIES.map(async (dictionary) => {
    // A station without that dictionary answers with an error: it has nothing to add.
    const targets = await client.call("read_tags", { ords, dictionary, includeRelations: true }).then((reply) => (reply.targets ?? []) as Json[], () => [] as Json[]);
    for (const target of targets) {
      const ord = toSlotOrd(String(target.ord ?? ""));
      const mine = out.get(ord) ?? out.set(ord, { ord, display: String(target.display ?? ""), dis: "", direct: new Set(), implied: new Set(), relations: new Map() }).get(ord)!;
      for (const tag of (target.tags ?? []) as Json[]) {
        if (tag.marker) (tag.source === "implied" ? mine.implied : mine.direct).add(String(tag.name));
        else if (tag.name === "dis" && typeof tag.value === "string" && tag.value) mine.dis = tag.value;
      }
      for (const r of (target.relations ?? []) as Json[]) {
        if (r.direction === "in" || typeof r.endpointOrd !== "string") continue;
        const to = toSlotOrd(r.endpointOrd);
        const name = String(r.name ?? String(r.id).split(":")[1]);
        if (/^slot:/.test(to)) mine.relations.set(`${name} ${to}`, { name, to });
      }
    }
  }));
  return [...out.values()].map((t) => ({ ord: t.ord, display: t.display, dis: t.dis, tags: [...(t.direct.size ? t.direct : t.implied)], relations: [...t.relations.values()] }));
}

export async function readEvidence(client: BaskStreamClient, under: string): Promise<{ evidence: Evidence[]; truncated: boolean; places: Record<string, ModelPlace> }> {
  const { nodes, truncated } = await walkTree(client, under);
  // Control points only: a logic block reads like a point but is not equipment's own. A point's own
  // parts (its proxy extension, an alarm or history extension) are listed under it and can read like
  // points too: a proxy extension is never a point, and neither is anything inside a control point.
  const isControlPoint = (node: WalkNode | undefined) => !!node && node.kind === "point" && node.typeSpec.startsWith("control:") && !/Ext$/.test(node.typeSpec);
  const points = [...nodes.values()].filter((node) => isControlPoint(node) && !isControlPoint(nodes.get(node.parent)));
  const owners = new Map<string, string[]>();
  for (const point of points) {
    // Equipment is what holds points. A component that is itself a control point is never equipment.
    let owner = point.parent;
    for (let up = nodes.get(point.parent); up; up = nodes.get(up.parent)) {
      if (/Device$/.test(up.typeSpec)) {
        owner = up.ord;
        break;
      }
    }
    if (owner === point.parent && /^points$/i.test(nodes.get(owner)?.name ?? "") && nodes.get(owner)?.parent) owner = nodes.get(owner)!.parent;
    owners.set(owner, [...(owners.get(owner) ?? []), point.ord]);
  }
  // One controller can hold several pieces of equipment, each in a folder of its own (a simulator, a
  // large plant controller). Folders that hold the same kind of thing look alike: their points share
  // names, or the folders are named for equipment. Then each folder is the equipment, not the controller.
  // Folders that only sort one unit's points (Setpoints, Status) share no names and stay one unit.
  for (const [owner, mine] of [...owners]) {
    if (!/Device$/.test(nodes.get(owner)?.typeSpec ?? "")) continue;
    const folders = new Map<string, string[]>();
    for (const ord of mine) {
      const parent = nodes.get(ord)!.parent;
      const holder = nodes.get(parent);
      if (!holder || parent === owner || (/^points$/i.test(holder.name) && holder.parent === owner)) continue;
      folders.set(parent, [...(folders.get(parent) ?? []), ord]);
    }
    if (folders.size < 2) continue;
    const namesIn = new Map([...folders].map(([folder, ords]) => [folder, new Set(ords.map((ord) => nodes.get(ord)!.name))]));
    const alike = [...namesIn].filter(([folder, names]) => [...namesIn].some(([other, theirs]) => other !== folder && [...names].filter((name) => theirs.has(name)).length >= 0.6 * Math.min(names.size, theirs.size)));
    const named = [...folders.keys()].filter((folder) => KINDS.some((_kind, i) => nameSays(tokens(nodes.get(folder)!.name), i).score >= 0.8));
    if (alike.length < Math.max(2, folders.size / 2) && named.length < 2) continue;
    const moved = new Set<string>();
    for (const [folder, ords] of folders) {
      owners.set(folder, ords);
      for (const ord of ords) moved.add(ord);
    }
    const left = mine.filter((ord) => !moved.has(ord));
    if (left.length) owners.set(owner, left);
    else owners.delete(owner);
  }
  const limits = (client.capabilities.limits ?? {}) as Json;
  const values = new Map<string, Json>();
  await pooled(chunks(points.map((p) => p.ord), Math.max(1, Math.min(500, Number(limits.maxPointSnapshotPoints ?? 500) || 500))), 2, async (some) => {
    for (const snap of await client.read(some, { fresh: false }).catch(() => [])) values.set(toSlotOrd(snap.point), snap as unknown as Json);
  });
  const tags = new Map<string, string[]>();
  const relations = new Map<string, { name: string; to: string }[]>();
  await pooled(chunks([...owners.keys(), ...points.map((p) => p.ord)], 100), 4, async (some) => {
    for (const target of await readHaystack(client, some)) {
      if (target.tags.length) tags.set(target.ord, target.tags);
      if (target.relations.length) relations.set(target.ord, target.relations);
    }
  });
  // The buildings, floors and rooms the equipment points at, and what those are in, a few levels up.
  const places: Record<string, ModelPlace> = {};
  let wanted = [...new Set([...relations.values()].flat().filter((r) => r.name === "siteRef" || r.name === "spaceRef").map((r) => r.to))];
  for (let level = 0; level < 4 && wanted.length; level += 1) {
    const next = new Set<string>();
    for (const some of chunks(wanted.slice(0, 2000), 100)) {
      for (const target of await readHaystack(client, some)) {
        const to = (name: string) => target.relations.find((r) => r.name === name)?.to;
        const kind = target.tags.includes("site") ? "site" : target.tags.includes("floor") ? "floor" : target.tags.includes("room") ? "room" : "space";
        places[target.ord] = { ord: target.ord, name: target.dis || target.display || shortOrd(target.ord, 1), kind, ...(to("spaceRef") ? { parent: to("spaceRef") } : {}), ...(to("siteRef") ? { site: to("siteRef") } : {}) };
        for (const up of [to("spaceRef"), to("siteRef")]) if (up && !places[up]) next.add(up);
      }
    }
    wanted = [...next].filter((ord) => !places[ord]);
  }
  const evidence = [...owners].map(([ord, mine]) => {
    const node = nodes.get(ord);
    return {
      ord, name: node?.name ?? shortOrd(ord, 1), typeSpec: node?.typeSpec ?? "", tags: tags.get(ord) ?? [], ...(relations.has(ord) ? { relations: relations.get(ord)! } : {}),
      points: mine.map((pointOrd) => {
        const point = nodes.get(pointOrd)!;
        const snap = values.get(pointOrd);
        const units = (snap?.facets as Json | undefined)?.units;
        return { ord: pointOrd, name: point.name, typeSpec: point.typeSpec, writable: point.writable || /Writable$/.test(point.typeSpec), units: typeof units === "string" && units ? units : undefined, valueType: typeof snap?.valueType === "string" ? snap.valueType : /Boolean/.test(point.typeSpec) ? "boolean" : /Numeric/.test(point.typeSpec) ? "numeric" : /Enum/.test(point.typeSpec) ? "enum" : undefined, tags: tags.get(pointOrd) ?? [] };
      })
    };
  });
  return { evidence, truncated, places };
}

/** The review document for a station, keeping what a person confirmed in an earlier one. */
export function buildReview(station: string, under: string, equipment: ModelEquipment[], earlier?: ModelReview, serves?: ModelServes[], places?: Record<string, ModelPlace>): ModelReview {
  const kept = new Map((earlier?.equipment ?? []).filter((e) => e.confirmed).map((e) => [e.ord, e]));
  const keptPoints = new Map((earlier?.equipment ?? []).flatMap((e) => e.points ?? []).filter((p) => p.confirmed).map((p) => [p.ord, p]));
  const merged = equipment.map((e) => {
    const mine = kept.get(e.ord);
    return {
      ...e, ...(mine ? { kind: mine.kind, label: mine.label, tags: mine.tags, confirmed: true } : {}),
      points: e.points.map((p) => {
        const was = keptPoints.get(p.ord);
        return was ? { ...p, role: was.role, label: was.label, tags: was.tags, confirmed: true } : p;
      })
    };
  });
  const where = places && Object.keys(places).length ? { places } : {};
  if (!serves) return { format: MODEL_FORMAT, version: 1, station, under, howTo: HOW_TO, equipment: merged, ...where };
  // What a person confirmed about what serves what is kept as they left it, including a "from" they corrected.
  // A relation the station holds comes before a guess that was accepted on this computer. What a person
  // said outright ("feeds AHU_01 …") is kept: it is their correction.
  const onStation = new Set(serves.filter((s) => !s.inferred).map((s) => `${s.to}|${s.medium}`));
  const confirmedServes = (earlier?.serves ?? []).filter((s) => s.confirmed && s.inferred && (s.reason === "a person said so" || !onStation.has(`${s.to}|${s.medium}`)));
  const settled = new Set(confirmedServes.map((s) => `${s.to}|${s.medium}`));
  return { format: MODEL_FORMAT, version: 1, station, under, howTo: HOW_TO, equipment: merged, serves: [...serves.filter((s) => !settled.has(`${s.to}|${s.medium}`)), ...confirmedServes].sort((a, b) => a.confidence - b.confidence || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)), ...where };
}

// ---- What serves what -------------------------------------------------------------------------------

/** Two pieces of equipment a chain of links joins, and the chain in words. */
export interface EquipmentLink {
  a: string;
  b: string;
  via: string;
}

const MEDIUM_WORDS: Record<Medium, string> = { air: "air", chilledWater: "chilled water", hotWater: "hot water" };
/** The Haystack relation each medium is written as, on the equipment that is fed. */
export const MEDIUM_REF: Record<Medium, string> = { air: "airRef", chilledWater: "chilledWaterRef", hotWater: "hotWaterRef" };

/** Which kinds feed which, and what a fed unit must have for it to count (a plant feeds a unit with a valve for its water). */
const FEEDS: { from: string[]; to: string[]; medium: Medium; needs?: string[] }[] = [
  { from: ["ahu"], to: ["vav"], medium: "air" },
  { from: ["chilledWaterPlant"], to: ["ahu", "fcu", "crac"], medium: "chilledWater", needs: ["coolingValve"] },
  { from: ["hotWaterPlant"], to: ["ahu", "fcu", "vav"], medium: "hotWater", needs: ["heatingValve", "reheatValve"] },
  { from: ["chiller"], to: ["chilledWaterPlant"], medium: "chilledWater" },
  { from: ["boiler"], to: ["hotWaterPlant"], medium: "hotWater" }
];

const folderOf = (ord: string) => (ord.lastIndexOf("/") > 5 ? ord.slice(0, ord.lastIndexOf("/")) : "slot:/");
/** A name's words with numbers as numbers: "AHU_01" and "ahu1" are both ahu, 1. */
const nameWords = (name: string) => tokens(name).map((word) => (/^\d+$/.test(word) ? String(Number(word)) : word));
/** `inner`'s words appear in `outer`, in order and side by side: "AHU1_VAV_3" holds "AHU_01". */
function holdsName(outer: string, inner: string): boolean {
  const [big, small] = [nameWords(outer), nameWords(inner)];
  // A name of one word (or none) says too little: "AHU" is in every air handler's name.
  if (small.length < 2 || small.length >= big.length) return false;
  for (let at = 0; at + small.length <= big.length; at += 1) if (small.every((word, i) => big[at + i] === word)) return true;
  return false;
}

/**
 * Proposes what serves what from the equipment kinds, links between their points, their names and
 * the folders they are in. Every proposal is marked inferred, with a confidence and the reason; a
 * relation the station already holds is taken as it is. Where two units could equally be the
 * source and nothing tells them apart, nothing is proposed. Pure: nothing is read here.
 */
export function inferServes(equipment: ModelEquipment[], links: EquipmentLink[] = [], evidence: Evidence[] = []): ModelServes[] {
  const byOrd = new Map(equipment.map((e) => [e.ord, e]));
  const out: ModelServes[] = [];
  const linked = (a: string, b: string) => links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  // Relations already on the station.
  const held = new Set<string>();
  for (const item of evidence) {
    for (const relation of item.relations ?? []) {
      const medium = (Object.keys(MEDIUM_REF) as Medium[]).find((m) => MEDIUM_REF[m] === relation.name);
      const [to, from] = [byOrd.get(item.ord), byOrd.get(relation.to)];
      if (!medium || !to || !from) continue;
      held.add(`${to.ord}|${medium}`);
      out.push({ from: from.ord, fromName: from.name, to: to.ord, toName: to.name, medium, confidence: 1, reason: `the station relates them (${relation.name})`, confirmed: true, inferred: false });
    }
  }
  for (const rule of FEEDS) {
    const sources = equipment.filter((e) => rule.from.includes(e.kind));
    if (sources.length === 0) continue;
    for (const unit of equipment.filter((e) => rule.to.includes(e.kind))) {
      if (held.has(`${unit.ord}|${rule.medium}`)) continue;
      const need = rule.needs ? unit.points.find((p) => rule.needs!.includes(p.role)) : undefined;
      if (rule.needs && !need) continue;
      const scored = sources.filter((source) => source.ord !== unit.ord).map((source) => {
        const why: [number, string][] = [];
        const link = linked(source.ord, unit.ord);
        if (link) why.push([0.85, `a link joins them (${link.via})`]);
        if (holdsName(unit.name, source.name)) why.push([0.75, `its name holds ${source.name}`]);
        const here = sources.filter((other) => folderOf(other.ord) === folderOf(unit.ord));
        if (here.length === 1 && here[0] === source) why.push([sources.length === 1 ? 0.6 : 0.5, `${source.name} is the only ${source.label} ${sources.length === 1 ? "on the station" : `in ${shortOrd(folderOf(unit.ord), 1)}`}`]);
        else if (sources.length === 1) why.push([0.45, `${source.name} is the only ${source.label} on the station`]);
        return { source, score: 1 - why.reduce((left, [s]) => left * (1 - s), 1), why: why.map(([, text]) => text) };
      }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
      // Two that fit equally well: nothing tells them apart, so nothing is proposed.
      if (scored.length === 0 || (scored[1] && scored[1].score >= scored[0].score)) continue;
      const best = scored[0];
      // The certainty of the two ends limits it: a guess about a guess is no surer than either.
      const confidence = round(best.score * Math.min(1, 0.5 + 0.5 * Math.min(best.source.confidence, unit.confidence)));
      out.push({
        from: best.source.ord, fromName: best.source.name, to: unit.ord, toName: unit.name, medium: rule.medium, confidence,
        reason: [`${best.source.label} feeds ${unit.label} with ${MEDIUM_WORDS[rule.medium]}`, ...best.why, need ? `it has a ${need.label} (${need.name})` : ""].filter(Boolean).join("; "), confirmed: false, inferred: true
      });
    }
  }
  return out.sort((a, b) => a.confidence - b.confidence || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** The most components asked for their links in one run. */
const LINK_CAP = 4000;

/**
 * Reads the links at the points of the equipment, follows them through logic (up to three blocks
 * deep), and returns the pairs of equipment a chain joins. One describe_component a point.
 */
export async function readEquipmentLinks(client: BaskStreamClient, evidence: Evidence[]): Promise<{ links: EquipmentLink[]; truncated: boolean }> {
  const owner = new Map(evidence.flatMap((item) => item.points.map((point) => [point.ord, item.ord] as const)));
  const edges = new Map<string, Set<string>>();
  const seen = new Set<string>();
  let truncated = false;
  let wave = [...owner.keys()];
  for (let hop = 0; hop < 4 && wave.length; hop += 1) {
    if (seen.size + wave.length > LINK_CAP) {
      truncated = true;
      wave = wave.slice(0, Math.max(0, LINK_CAP - seen.size));
    }
    for (const ord of wave) seen.add(ord);
    const found = await pooled(wave, 8, (ord) => client.call("describe_component", { ord }).then((reply) => (((reply.result as Json | undefined)?.links ?? []) as Json[]), () => [] as Json[]));
    const next = new Set<string>();
    for (const link of found.flat()) {
      const [source, target] = [toSlotOrd(String(link.source ?? "")), toSlotOrd(String(link.target ?? ""))];
      if (!source || !target) continue;
      edges.set(source, (edges.get(source) ?? new Set()).add(target));
      for (const end of [source, target]) if (!seen.has(end) && !owner.has(end)) next.add(end);
    }
    wave = [...next];
  }
  const short = (ord: string) => ord.replace(/^slot:\/?/, "").replace("/points/", "/").split("/").slice(-2).join("/");
  const pairs = new Map<string, EquipmentLink>();
  for (const [start, from] of owner) {
    // Forward from each point, through components that are no equipment's, to another equipment's point.
    const queue: { ord: string; path: string[] }[] = [{ ord: start, path: [start] }];
    const visited = new Set([start]);
    while (queue.length) {
      const { ord, path } = queue.shift()!;
      for (const target of edges.get(ord) ?? []) {
        if (visited.has(target) || path.length > 4) continue;
        visited.add(target);
        const to = owner.get(target);
        if (to === undefined) queue.push({ ord: target, path: [...path, target] });
        else if (to !== from) {
          const key = [from, to].sort().join("|");
          if (!pairs.has(key)) pairs.set(key, { a: from, b: to, via: [...path, target].map(short).join(" → ") });
        }
      }
    }
  }
  return { links: [...pairs.values()], truncated };
}

/** Reads a review file back, saying what is wrong with a file that is not one. */
export function parseReview(text: string, from: string): ModelReview {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`${from} could not be read as JSON: ${(error as Error).message}`);
  }
  const d = doc as Partial<ModelReview> | null;
  if (!d || d.format !== MODEL_FORMAT || !Array.isArray(d.equipment)) throw new Error(`${from} is not a bask model review file (no "format": "${MODEL_FORMAT}"). Make one with: bask model infer`);
  return d as ModelReview;
}

// ---- Output ---------------------------------------------------------------------------------------

const confColor = (confidence: number) => (confidence >= 0.85 ? chalk.green : confidence >= UNSURE ? chalk.yellow : chalk.red);

/** One row per equipment and per point, in the file's order. */
export function modelRows(review: ModelReview): unknown[][] {
  return [
    ...review.equipment.flatMap((e) => [
      [e.confidence, "equipment", e.ord, e.kind, e.label, e.confirmed, e.reason],
      ...e.points.map((p) => [p.confidence, "point", p.ord, p.role, p.label, p.confirmed, p.reason])
    ]),
    ...(review.serves ?? []).map((s) => [s.confidence, s.inferred ? "serves (inferred)" : "serves", s.to, MEDIUM_REF[s.medium], `fed by ${s.fromName}`, s.confirmed, s.reason])
  ];
}

export const modelCsv = (review: ModelReview) => csv(["confidence", "what", "ord", "proposed", "label", "confirmed", "reason"], modelRows(review));

export function printModel(review: ModelReview): void {
  const points = review.equipment.flatMap((e) => e.points);
  const unsure = [...review.equipment, ...points].filter((entry) => !entry.confirmed && entry.confidence < UNSURE).length;
  console.log(`${chalk.bold(review.station)}  ${chalk.dim(`${review.under} · ${review.equipment.length} equipment, ${points.length} point${points.length === 1 ? "" : "s"}`)}`);
  console.log(unsure ? chalk.yellow(`${unsure} proposal${unsure === 1 ? "" : "s"} under ${UNSURE} to look at first`) : chalk.green(`every proposal is ${UNSURE} or better`));
  if (review.equipment.length === 0) return;
  console.log();
  const rows: string[][] = [];
  for (const e of review.equipment) {
    const low = e.points.filter((p) => !p.confirmed && p.confidence < UNSURE);
    rows.push([confColor(e.confidence)(e.confidence.toFixed(2)), chalk.bold(shortOrd(e.ord, 2)), `${e.label}${e.confirmed ? chalk.green(" ✓") : ""}`, `${e.reason} ${chalk.dim(`· ${e.points.length} point${e.points.length === 1 ? "" : "s"}`)}`]);
    for (const p of low) rows.push([confColor(p.confidence)(p.confidence.toFixed(2)), `  ${p.name}`, p.label, p.reason]);
  }
  console.log(table(["conf", "where", "proposed", "why"], rows));
  console.log(chalk.dim(`\nPoints at ${UNSURE} or better are in the file, not listed here.`));
  const serves = review.serves ?? [];
  if (serves.length === 0) return;
  console.log(`\n${chalk.bold("What serves what")} ${chalk.dim(`· ${serves.filter((s) => s.inferred).length} inferred, to confirm in the file`)}`);
  console.log(table(["conf", "fed", "by", "", "why"], serves.map((s) => [confColor(s.confidence)(s.confidence.toFixed(2)), `${s.toName}${s.confirmed ? chalk.green(" ✓") : ""}`, s.fromName, s.inferred ? chalk.yellow("inferred") : "on the station", s.reason])));
}

// ---- Haystack ---------------------------------------------------------------------------------------

/** A Haystack ref id from a slot ORD: letters, digits and . only. */
export const refOf = (ord: string) => ord.replace(/^slot:\/?/, "").replace(/\$([0-9a-fA-F]{2})/g, "_").replace(/\//g, ".").replace(/[^A-Za-z0-9_.~-]/g, "_") || "station";

/**
 * The confirmed entries as a Haystack grid in its JSON encoding (version 3.0: "m:" is a marker,
 * "r:" a ref, "s:" a string). A confirmed point under unconfirmed equipment is written without an equipRef.
 */
export function haystackGrid(review: ModelReview): { meta: Record<string, string>; cols: { name: string }[]; rows: Record<string, string>[] } {
  const rows: Record<string, string>[] = [];
  const marker = (tags: string[]) => Object.fromEntries(tags.filter((tag) => /^[a-z][A-Za-z0-9_]*$/.test(tag)).map((tag) => [tag, "m:"]));
  const confirmed = new Map(review.equipment.filter((e) => e.confirmed).map((e) => [e.ord, e]));
  // A confirmed "fed by" is a ref on the equipment that is fed, when both ends are confirmed equipment.
  const fedBy = (ord: string) => Object.fromEntries((review.serves ?? []).filter((s) => s.confirmed && s.to === ord && confirmed.has(s.from)).map((s) => [MEDIUM_REF[s.medium], `r:${refOf(s.from)} ${confirmed.get(s.from)!.name}`]));
  for (const e of [...review.equipment].sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0))) {
    if (e.confirmed) rows.push({ id: `r:${refOf(e.ord)} ${e.name}`, dis: `s:${e.name}`, equip: "m:", ...marker(e.tags ?? []), ...fedBy(e.ord), axSlotPath: `s:${e.ord}` });
    for (const p of [...(e.points ?? [])].sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0))) {
      if (!p.confirmed) continue;
      rows.push({
        id: `r:${refOf(p.ord)} ${e.name} ${p.name}`, dis: `s:${e.name} ${p.name}`, point: "m:", ...marker(p.tags ?? []),
        ...(e.confirmed ? { equipRef: `r:${refOf(e.ord)} ${e.name}` } : {}), ...(p.valueKind ? { kind: `s:${p.valueKind}` } : {}), ...(p.unit ? { unit: `s:${p.unit}` } : {}), axSlotPath: `s:${p.ord}`
      });
    }
  }
  const cols = [...new Set(["id", "dis", ...rows.flatMap((row) => Object.keys(row))])].map((name) => ({ name }));
  return { meta: { ver: "3.0", dis: `s:${review.station}` }, cols, rows };
}
