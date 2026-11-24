// bask model write and the Brick export (docs/ROADMAP.md, F steps 3 and 4). `write` puts the
// confirmed entries of a review file on the station as Haystack tags and relations, with write_tags
// and write_relations. An entry that is not confirmed is never written. The default is a preview
// worked out here from read_tags: the station has no dry run for tag writes.
import chalk from "chalk";
import { toSlotOrd, type BaskStreamClient, type Json } from "./core.js";
import type { RelationWrite, TagWrite } from "./apply.js";
import { shortOrd } from "./format.js";
import { MEDIUM_REF, refOf, type ModelReview } from "./model.js";

/** A tag name that can be written as hs:<name>. */
const TAG = /^[a-z][A-Za-z0-9_]*$/;

export interface ModelWritePlan {
  station: string;
  /** Tags to add, by component. Only what is not there already. */
  tags: TagWrite[];
  /** Relations to add: a point to its equipment (hs:equipRef), a fed unit to what feeds it (hs:airRef and the like). */
  relations: RelationWrite[];
  /** Tags and relations the station already holds. */
  already: number;
  /** Confirmed entries whose component is not on the station now. */
  missing: string[];
  /** Entries left out because nobody confirmed them. */
  unconfirmed: { equipment: number; points: number; serves: number };
  /** Tag names in the file that are not valid Haystack names and were left out. */
  invalid: string[];
}

export interface ModelWriteOutcome extends ModelWritePlan {
  written: boolean;
  /** What the station refused, in words. */
  failures: string[];
  /** After writing: every tag and relation was read back from the station. */
  verified?: boolean;
}

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_v, i) => items.slice(i * size, (i + 1) * size));

async function held(client: BaskStreamClient, ords: string[]): Promise<Map<string, { tags: Set<string>; relations: Set<string> } | undefined>> {
  const out = new Map<string, { tags: Set<string>; relations: Set<string> } | undefined>();
  for (const some of chunks(ords, 100)) {
    const targets = ((await client.call("read_tags", { ords: some, dictionary: "hs", includeRelations: true })).targets ?? []) as Json[];
    // A station tagged with Haystack 4 holds the same tags under h4: they count as there already.
    const newer = await client.call("read_tags", { ords: some, dictionary: "h4", includeRelations: true }).then((reply) => (reply.targets ?? []) as Json[], () => [] as Json[]);
    const asHs = (id: unknown) => `hs:${String(id).split(":").pop()}`;
    for (const target of targets) {
      const ord = toSlotOrd(String(target.ord ?? ""));
      const also = newer.find((t) => toSlotOrd(String(t.ord ?? "")) === ord);
      out.set(ord, target.ok === false ? undefined : {
        tags: new Set([...((target.tags ?? []) as Json[]).map((tag) => String(tag.id)), ...((also?.tags ?? []) as Json[]).map((tag) => asHs(tag.id))]),
        relations: new Set([...((target.relations ?? []) as Json[]).filter((r) => r.direction !== "in").map((r) => `${String(r.id)} ${toSlotOrd(String(r.endpointOrd ?? ""))}`), ...((also?.relations ?? []) as Json[]).filter((r) => r.direction !== "in").map((r) => `${asHs(r.id)} ${toSlotOrd(String(r.endpointOrd ?? ""))}`)])
      });
    }
  }
  return out;
}

/** What writing a review file takes: the confirmed entries, less what the station already holds. Read-only. */
export async function planModelWrite(client: BaskStreamClient, review: ModelReview): Promise<ModelWritePlan> {
  const station = String(client.capabilities.station ?? client.http.url.host);
  if (review.station && review.station !== station) throw new Error(`This review file is for ${review.station}; the station connected is ${station}. Nothing is written to a different station.`);
  const wanted = new Map<string, { tags: string[]; relations: { id: string; endpoint: string }[] }>();
  const want = (ord: string) => wanted.get(ord) ?? wanted.set(ord, { tags: [], relations: [] }).get(ord)!;
  const invalid = new Set<string>();
  const ids = (tags: string[], always: string) => [...new Set([always, ...tags])].filter((tag) => (TAG.test(tag) ? true : (invalid.add(tag), false))).map((tag) => `hs:${tag}`);
  const unconfirmed = { equipment: 0, points: 0, serves: 0 };
  for (const e of review.equipment) {
    if (e.confirmed) want(e.ord).tags.push(...ids(e.tags ?? [], "equip"));
    else unconfirmed.equipment += 1;
    for (const p of e.points ?? []) {
      if (!p.confirmed) {
        unconfirmed.points += 1;
        continue;
      }
      want(p.ord).tags.push(...ids(p.tags ?? [], "point"));
      // A point is tied to its equipment only when the equipment is confirmed too.
      if (e.confirmed) want(p.ord).relations.push({ id: "hs:equipRef", endpoint: e.ord });
    }
  }
  for (const s of review.serves ?? []) {
    if (s.confirmed) want(s.to).relations.push({ id: `hs:${MEDIUM_REF[s.medium]}`, endpoint: s.from });
    else unconfirmed.serves += 1;
  }
  const now = await held(client, [...new Set([...wanted.keys(), ...[...wanted.values()].flatMap((w) => w.relations.map((r) => r.endpoint))])]);
  const plan: ModelWritePlan = { station, tags: [], relations: [], already: 0, missing: [], unconfirmed, invalid: [...invalid] };
  for (const [ord, w] of wanted) {
    const has = now.get(ord);
    if (!has) {
      plan.missing.push(ord);
      continue;
    }
    const set = w.tags.filter((id) => !has.tags.has(id)).map((id) => ({ id }));
    plan.already += w.tags.length - set.length;
    if (set.length) plan.tags.push({ ord, set, remove: [] });
    const add = w.relations.filter((r) => {
      if (!now.get(r.endpoint)) {
        if (!plan.missing.includes(r.endpoint)) plan.missing.push(r.endpoint);
        return false;
      }
      if (!has.relations.has(`${r.id} ${r.endpoint}`)) return true;
      plan.already += 1;
      return false;
    });
    if (add.length) plan.relations.push({ ord, add, remove: [] });
  }
  return plan;
}

const refusals = (targets: Json[]) => targets.flatMap((t) => (t.ok === false && !t.results ? [`${String(t.ord)}: ${String(t.code ?? "")} ${String(t.message ?? "")}`.trim()] : ((t.results ?? []) as Json[]).filter((r) => r.ok === false).map((r) => `${String(t.ord)} ${String(r.id)}: ${String(r.code ?? "")} ${String(r.message ?? "")}`.trim())));

/** Writes the plan, then reads the tags and relations back. */
export async function runModelWrite(client: BaskStreamClient, plan: ModelWritePlan, reason?: string): Promise<ModelWriteOutcome> {
  const why = reason ? { reason } : {};
  const failures: string[] = [];
  for (const some of chunks(plan.tags, 100)) failures.push(...refusals(((await client.call("write_tags", { targets: some, ...why })).targets ?? []) as Json[]));
  for (const some of chunks(plan.relations, 100)) failures.push(...refusals(((await client.call("write_relations", { targets: some, ...why })).targets ?? []) as Json[]));
  const now = await held(client, [...new Set([...plan.tags.map((t) => t.ord), ...plan.relations.map((r) => r.ord)])]);
  const verified = plan.tags.every((t) => t.set.every((tag) => now.get(t.ord)?.tags.has(tag.id))) && plan.relations.every((r) => r.add.every((a) => now.get(r.ord)?.relations.has(`${a.id} ${a.endpoint}`)));
  return { ...plan, written: true, failures, verified };
}

export function printModelWrite(outcome: ModelWritePlan & Partial<ModelWriteOutcome>): void {
  const tags = outcome.tags.reduce((n, t) => n + t.set.length, 0);
  const relations = outcome.relations.reduce((n, r) => n + r.add.length, 0);
  const places = new Set([...outcome.tags.map((t) => t.ord), ...outcome.relations.map((r) => r.ord)]).size;
  const left = outcome.unconfirmed;
  console.log(`${chalk.bold(outcome.station)}  ${chalk.dim(`${tags} tag${tags === 1 ? "" : "s"} and ${relations} relation${relations === 1 ? "" : "s"} on ${places} component${places === 1 ? "" : "s"} · ${outcome.already} already there`)}`);
  for (const t of outcome.tags) console.log(`  tag     ${chalk.bold(shortOrd(t.ord, 3))}  ${t.set.map((s) => s.id).join(", ")}`);
  for (const r of outcome.relations) console.log(`  relate  ${chalk.bold(shortOrd(r.ord, 3))}  ${r.add.map((a) => `${a.id} → ${shortOrd(a.endpoint, 3)}`).join(", ")}`);
  for (const ord of outcome.missing) console.log(`${chalk.yellow("!")} ${shortOrd(ord, 3)} is confirmed in the file and not on the station now: left out.`);
  if (outcome.invalid.length) console.log(`${chalk.yellow("!")} Left out, not Haystack tag names: ${outcome.invalid.join(", ")}.`);
  console.log(chalk.dim(`Not confirmed, so not written: ${left.equipment} equipment, ${left.points} point${left.points === 1 ? "" : "s"}, ${left.serves} of what serves what.`));
  for (const failure of outcome.failures ?? []) console.log(`${chalk.red("refused")}  ${failure}`);
  if (outcome.written) console.log(outcome.failures?.length ? chalk.red(`${outcome.failures.length} refused.`) : outcome.verified ? `${chalk.green("✓")} Written, and read back from the station.` : `${chalk.yellow("!")} Written, but not all of it read back: check with bask call read_tags.`);
  else if (tags + relations === 0) console.log(left.equipment + left.points + left.serves > 0 && outcome.already === 0 ? chalk.yellow('Nothing is confirmed yet. Set "confirmed": true on the entries that are right.') : chalk.green("Nothing to write: the station already holds every confirmed entry."));
  else console.log(chalk.dim("Nothing is written yet. To write these, run again with --allow-writes --yes."));
}

// ---- Brick -----------------------------------------------------------------------------------------

// Class names checked against Brick 1.3.0 (Brick.ttl). A kind or role with no class of its own is
// written as brick:Equipment or brick:Point and named in a comment, not given a class that is not there.
const BRICK_KIND: Record<string, string> = {
  ahu: "AHU", vav: "VAV", fcu: "Fan_Coil_Unit", crac: "CRAC", chilledWaterPlant: "Chilled_Water_System", hotWaterPlant: "Hot_Water_System", chiller: "Chiller", boiler: "Boiler",
  pump: "Pump", coolingTower: "Cooling_Tower", freezer: "Freezer", compressor: "Compressor", meter: "Electrical_Meter", room: "Room"
};
const BRICK_ROLE: Record<string, string> = {
  supplyAirTemp: "Supply_Air_Temperature_Sensor", returnAirTemp: "Return_Air_Temperature_Sensor", mixedAirTemp: "Mixed_Air_Temperature_Sensor", outsideAirTemp: "Outside_Air_Temperature_Sensor",
  supplyAirTempSp: "Supply_Air_Temperature_Setpoint", supplyAirHumidity: "Supply_Air_Humidity_Sensor", supplyAirPressure: "Supply_Air_Static_Pressure_Sensor", supplyAirPressureSp: "Supply_Air_Static_Pressure_Setpoint",
  supplyAirFlow: "Supply_Air_Flow_Sensor", supplyFanSpeed: "Fan_Speed_Command", supplyFanStatus: "Fan_Status", returnFanStatus: "Fan_Status", fanStatus: "Fan_Status", fanSpeed: "Fan_Speed_Command",
  coolingValve: "Valve_Position_Command", heatingValve: "Valve_Position_Command", reheatValve: "Valve_Position_Command", humidifierValve: "Valve_Position_Command",
  outsideDamper: "Damper_Position_Command", damper: "Damper_Position_Command", filterDp: "Filter_Differential_Pressure_Sensor", airflow: "Air_Flow_Sensor", airflowSp: "Air_Flow_Setpoint",
  zoneTemp: "Zone_Air_Temperature_Sensor", zoneTempSp: "Zone_Air_Temperature_Setpoint", zoneCoolingSp: "Zone_Air_Cooling_Temperature_Setpoint", zoneHeatingSp: "Zone_Air_Heating_Temperature_Setpoint",
  zoneHumidity: "Zone_Air_Humidity_Sensor", zonePressure: "Static_Pressure_Sensor", occupancyCmd: "Occupancy_Command", occupancyStatus: "Occupancy_Status",
  chwSupplyTemp: "Chilled_Water_Supply_Temperature_Sensor", chwReturnTemp: "Chilled_Water_Return_Temperature_Sensor", chwSupplyTempSp: "Chilled_Water_Temperature_Setpoint", chwFlow: "Chilled_Water_Flow_Sensor",
  hwSupplyTemp: "Hot_Water_Supply_Temperature_Sensor", hwReturnTemp: "Hot_Water_Return_Temperature_Sensor", hwSupplyTempSp: "Temperature_Setpoint", hwFlow: "Hot_Water_Flow_Sensor",
  leavingWaterTemp: "Leaving_Water_Temperature_Sensor", enteringWaterTemp: "Entering_Water_Temperature_Sensor", leavingWaterTempSp: "Leaving_Water_Temperature_Setpoint", waterFlow: "Water_Flow_Sensor",
  pumpSpeed: "Speed_Command", speedFeedback: "Speed_Sensor", runStatus: "Run_Status", enableCmd: "Enable_Command", enableStatus: "Enable_Status", alarmStatus: "Alarm",
  boxTemp: "Air_Temperature_Sensor", boxTempSp: "Air_Temperature_Setpoint", power: "Power_Sensor", current: "Current_Sensor", energy: "Energy_Sensor"
};
export const BRICK_CLASSES = { kinds: BRICK_KIND, roles: BRICK_ROLE };

const literal = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/**
 * The confirmed entries as a Brick model in Turtle: each equipment and point with its class, points
 * tied to their equipment (brick:isPointOf), and confirmed "feeds" between equipment. Unconfirmed
 * entries are left out.
 */
export function brickTurtle(review: ModelReview): string {
  const base = `urn:baskstream:${encodeURIComponent(review.station)}:`;
  const iri = (ord: string) => `<${base}${refOf(ord)}>`;
  const lines = ["@prefix brick: <https://brickschema.org/schema/Brick#> .", "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .", ""];
  const generic: string[] = [];
  const confirmed = new Set(review.equipment.filter((e) => e.confirmed).map((e) => e.ord));
  const byOrd = (a: { ord: string }, b: { ord: string }) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0);
  let subjects = 0;
  for (const e of [...review.equipment].sort(byOrd)) {
    if (e.confirmed) {
      const cls = BRICK_KIND[e.kind];
      if (!cls) generic.push(`${e.name}: kind "${e.kind}" has no Brick class here, written as brick:Equipment`);
      const feeds = (review.serves ?? []).filter((s) => s.confirmed && s.from === e.ord && confirmed.has(s.to)).map((s) => s.to).sort();
      lines.push(`${iri(e.ord)} a brick:${cls ?? "Equipment"} ;`, `    rdfs:label ${literal(e.name)}${feeds.length ? " ;" : " ."}`);
      if (feeds.length) lines.push(`    brick:feeds ${feeds.map(iri).join(" , ")} .`);
      subjects += 1;
    }
    for (const p of [...(e.points ?? [])].sort(byOrd)) {
      if (!p.confirmed) continue;
      const cls = BRICK_ROLE[p.role];
      if (!cls) generic.push(`${e.name} ${p.name}: role "${p.role}" has no Brick class here, written as brick:Point`);
      lines.push(`${iri(p.ord)} a brick:${cls ?? "Point"} ;`, `    rdfs:label ${literal(`${e.name} ${p.name}`)}${e.confirmed ? " ;" : " ."}`);
      if (e.confirmed) lines.push(`    brick:isPointOf ${iri(e.ord)} .`);
      subjects += 1;
    }
  }
  if (subjects === 0) lines.push("# Nothing in the review file is confirmed yet.");
  for (const note of generic) lines.push(`# ${note}`);
  return `${lines.join("\n")}\n`;
}
