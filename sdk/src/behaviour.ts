// What looks wrong in how the equipment is running, as opposed to how the station is set up: heating
// and cooling at once, a zone held off its setpoint, an output swinging back and forth, a sensor that
// has stopped moving, a command nothing followed. It works from the same model the map is drawn from
// (what each unit is, what each of its points is for), what the points read now, and their histories.
// Read-only.
import type { BaskStreamClient } from "./core.js";
import { toSlotOrd } from "./core.js";
import { pooled } from "./log.js";
import { seriesFor } from "./past.js";
import { readSite, type SitePoint, type Unit } from "./site.js";

export type BehaviourKind = "heatAndCool" | "offSetpoint" | "hunting" | "flatline" | "notFollowing";

export interface BehaviourFinding {
  kind: BehaviourKind;
  /** The unit it is about, by ORD. */
  where: string;
  /** The point to open first. */
  point: string;
  message: string;
}

export interface BehaviourResult {
  findings: BehaviourFinding[];
  /** Units looked at, and how many of them had the points a rule needs. */
  units: number;
  looked: Record<BehaviourKind, number>;
  truncated: boolean;
}

const HOUR = 3600_000;
const role = (unit: Unit, ...ids: string[]): SitePoint | undefined => ids.map((id) => unit.points.find((p) => p.role === id)).find(Boolean);
const round = (v: number, digits = 1) => String(Math.round(v * 10 ** digits) / 10 ** digits);
/** A temperature difference that counts, in the point's own units. */
const tempBand = (point: SitePoint) => (/c/i.test(point.unit ?? "") && !/f/i.test(point.unit ?? "") ? 1.7 : 3);

/** Times a series turns round, counting only swings of at least `swing`. */
export function reversals(values: number[], swing: number): number {
  let turns = 0;
  let anchor = values[0];
  let direction = 0;
  for (const v of values.slice(1)) {
    if (direction >= 0 && v <= anchor - swing) {
      if (direction > 0) turns += 1;
      direction = -1;
      anchor = v;
    } else if (direction <= 0 && v >= anchor + swing) {
      if (direction < 0) turns += 1;
      direction = 1;
      anchor = v;
    } else if ((direction > 0 && v > anchor) || (direction < 0 && v < anchor)) anchor = v;
  }
  return turns;
}

const SENSOR = /Temp$|Humidity$|Pressure$|Flow$|^airflow$|^filterDp$|^waterFlow$/;
const OUTPUT = ["coolingValve", "heatingValve", "reheatValve", "outsideDamper", "damper", "supplyFanSpeed", "fanSpeed", "pumpSpeed"];

/** What a look needs to know: what a point reads now, and its past as evenly spaced averages. */
export interface Readings {
  now(ord: string): number | boolean | undefined;
  /** The averages of `buckets` equal stretches of the last `hours`; undefined when the point keeps no history. */
  past(ord: string, hours: number, buckets: number): Promise<number[] | undefined>;
}

/** Looks at every unit under `under`. `now` is for tests. */
export async function findBehaviour(client: BaskStreamClient, under = "slot:/", now = Date.now()): Promise<BehaviourResult> {
  const site = await readSite(client, String(client.capabilities.station ?? ""), undefined, under);
  const units = site.units.filter((u) => u.kind !== "unknown");
  // What every point of interest reads now, in a few requests.
  const reads = new Map<string, number | boolean>();
  const ords = [...new Set(units.flatMap((unit) => unit.points.map((point) => point.ord)))];
  for (let i = 0; i < ords.length; i += 400) {
    for (const snap of await client.read(ords.slice(i, i + 400), { fresh: false }).catch(() => [])) {
      if (!snap.code && (typeof snap.value === "number" || typeof snap.value === "boolean")) reads.set(toSlotOrd(snap.point), snap.value);
    }
  }
  const result = await behaviourOf(units, {
    now: (ord) => reads.get(ord),
    past: async (ord, hours, buckets) => (await seriesFor(client, ord, now - hours * HOUR, now, buckets).catch(() => undefined))?.map((s) => s.value)
  });
  return { ...result, truncated: site.truncated };
}

/** The same look, given the units and a way to read them. */
export async function behaviourOf(units: Unit[], readings: Readings): Promise<BehaviourResult> {
  const looked: BehaviourResult["looked"] = { heatAndCool: 0, offSetpoint: 0, hunting: 0, flatline: 0, notFollowing: 0 };
  const findings: BehaviourFinding[] = [];
  const say = (kind: BehaviourKind, unit: Unit, point: SitePoint, message: string) => findings.push({ kind, where: unit.ord, point: point.ord, message });
  const reads = { get: (ord: string) => readings.now(ord) };
  const number = (point: SitePoint | undefined) => (point && typeof reads.get(point.ord) === "number" ? (reads.get(point.ord) as number) : undefined);
  const on = (point: SitePoint | undefined) => (point === undefined ? undefined : typeof reads.get(point.ord) === "boolean" ? (reads.get(point.ord) as boolean) : typeof reads.get(point.ord) === "number" ? (reads.get(point.ord) as number) > 0 : undefined);
  const series = (point: SitePoint, hours: number, buckets: number) => readings.past(point.ord, hours, buckets);
  const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);

  await pooled(units, 6, async (unit) => {
    const running = on(role(unit, "supplyFanStatus", "fanStatus", "runStatus", "enableStatus"));

    // ---- Heating and cooling at once.
    const cool = role(unit, "coolingValve");
    const heat = role(unit, "heatingValve", "reheatValve");
    if (cool && heat) {
      looked.heatAndCool += 1;
      const [c, h] = await Promise.all([series(cool, 1, 4), series(heat, 1, 4)]);
      const both = c?.length && h?.length ? { c: mean(c), h: mean(h), span: "over the last hour" } : number(cool) !== undefined && number(heat) !== undefined ? { c: number(cool)!, h: number(heat)!, span: "now" } : undefined;
      if (both && both.c > 15 && both.h > 15) say("heatAndCool", unit, cool, `heating and cooling together ${both.span}: ${heat.label} ${round(both.h, 0)}%, ${cool.label} ${round(both.c, 0)}%`);
    }

    // ---- Held off its setpoint.
    if (unit.headline && (unit.setpoint || unit.band) && running !== false) {
      looked.offSetpoint += 1;
      const low = number(unit.band?.low ?? unit.setpoint);
      const high = number(unit.band?.high ?? unit.setpoint);
      const past = await series(unit.headline, 2, 8);
      if (low !== undefined && high !== undefined && past && past.length >= 6) {
        const band = /temp/i.test(unit.headline.role) ? tempBand(unit.headline) : Math.max(Math.abs(high) * 0.15, 0.01);
        const off = past.map((v) => (v > high + band ? v - high : v < low - band ? v - low : 0));
        const above = off.filter((d) => d > 0).length;
        const below = off.filter((d) => d < 0).length;
        if (Math.max(above, below) >= Math.ceil(past.length * 0.75)) {
          const latest = past[past.length - 1];
          const by = above > below ? latest - high : low - latest;
          say("offSetpoint", unit, unit.headline, `${unit.headline.label} ${round(latest)} has been ${round(Math.abs(by))} ${above > below ? "above" : "below"} its setpoint (${round(above > below ? high : low)}) for most of the last 2 hours`);
        }
      }
    }

    // ---- An output swinging back and forth.
    for (const point of unit.points.filter((p) => OUTPUT.includes(p.role))) {
      looked.hunting += 1;
      const past = await series(point, 2, 24);
      if (!past || past.length < 12) continue;
      const turns = reversals(past, 8);
      if (turns >= 6) say("hunting", unit, point, `${point.label} turned round ${turns} times in 2 hours, between ${round(Math.min(...past), 0)}% and ${round(Math.max(...past), 0)}%`);
    }

    // ---- A sensor that has stopped moving.
    for (const point of unit.points.filter((p) => SENSOR.test(p.role) && !p.writable)) {
      looked.flatline += 1;
      const past = await series(point, 24, 24);
      if (!past || past.length < 12) continue;
      if (Math.max(...past) - Math.min(...past) < 1e-9 && running !== false) say("flatline", unit, point, `${point.label} has read exactly ${round(past[0], 2)} for the last ${past.length} hours`);
    }

    // ---- A command nothing followed.
    const pairs: [SitePoint | undefined, SitePoint | undefined][] = [
      [role(unit, "supplyFanSpeed"), role(unit, "supplyFanStatus")], [role(unit, "fanSpeed"), role(unit, "fanStatus")], [role(unit, "enableCmd"), role(unit, "enableStatus", "runStatus")], [role(unit, "pumpSpeed"), role(unit, "speedFeedback")]
    ];
    for (const [command, proof] of pairs) {
      if (!command || !proof) continue;
      looked.notFollowing += 1;
      const asked = reads.get(command.ord);
      const got = reads.get(proof.ord);
      if (asked === undefined || got === undefined) continue;
      if (typeof asked === "number" && typeof got === "number") {
        if (Math.abs(asked - got) <= 15) continue;
        // Still apart a quarter of an hour ago: not just a ramp.
        const [a, g] = await Promise.all([series(command, 0.25, 1), series(proof, 0.25, 1)]);
        if (a?.length && g?.length && Math.abs(a[0] - g[0]) <= 15) continue;
        say("notFollowing", unit, proof, `${command.label} is ${round(asked, 0)}% and ${proof.label} is ${round(got, 0)}%`);
      } else {
        const wants = typeof asked === "boolean" ? asked : asked > 10;
        const has = typeof got === "boolean" ? got : got > 0;
        if (!wants || has) continue;
        const proofPast = await series(proof, 0.25, 1);
        if (proofPast?.length && proofPast[0] > 0.2) continue;
        say("notFollowing", unit, proof, `${command.label} is ${typeof asked === "boolean" ? "on" : `${round(asked, 0)}%`} and ${proof.label} is off`);
      }
    }
  });
  findings.sort((a, b) => (a.where < b.where ? -1 : a.where > b.where ? 1 : 0));
  return { findings, units: units.length, looked, truncated: false };
}
