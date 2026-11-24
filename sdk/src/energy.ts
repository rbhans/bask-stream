// bask energy: the power the station meters, now and so far today. It finds every point that reads
// in kilowatts, takes its history since midnight for the peak and the energy used, and the same
// stretch of yesterday to compare with. Read-only.
import chalk from "chalk";
import type { BaskStreamClient } from "./core.js";
import { csv, table } from "./format.js";
import { pooled } from "./log.js";
import { seriesFor } from "./past.js";

export const ENERGY_OPERATIONS = ["query", "read_history_rollup"] as const;

export interface PowerPoint {
  ord: string;
  /** The equipment it is on: the device or folder its points sit in. */
  on: string;
  name: string;
  /** kW now. */
  now: number;
  /** The one that looks like the whole site's meter. */
  main: boolean;
  /** Since local midnight: the highest quarter-hour average, when it was, and the energy used. */
  peak?: number;
  peakAt?: number;
  usedKwh?: number;
  /** The energy used yesterday up to the same time of day. */
  yesterdayKwh?: number;
}

export interface EnergyResult {
  station: string;
  at: number;
  points: PowerPoint[];
  /** kW points found beyond the ones listed. */
  more: number;
  notes: string[];
}

const MAIN = /(^|[_\W])(main|site|total|building|utility|service|incoming|whole)([_\W]|$)/i;
const QUARTER = 15 * 60_000;

/** True when a point's facets say it reads in kilowatts (not kWh, kVA or kvar). */
export function isKilowatts(facets: unknown): boolean {
  const text = typeof facets === "string" ? facets : JSON.stringify(facets ?? "");
  const unit = /units?["=:\s]+([^|;,"}]+)/i.exec(text)?.[1]?.trim() ?? "";
  return /^(kw|kilowatts?)$/i.test(unit) || /\bkilowatt\b(?!.?hour)/i.test(text);
}

/** The energy in a run of evenly spaced average powers, in kWh. */
export function energyOf(series: { at: number; value: number }[], bucketMs: number): number {
  return series.reduce((sum, s) => sum + s.value * (bucketMs / 3600_000), 0);
}

export async function readEnergy(client: BaskStreamClient, options: { under?: string; limit?: number; now?: number } = {}): Promise<EnergyResult> {
  const now = options.now ?? Date.now();
  const notes: string[] = [];
  const found = await client.query({ bql: "select slotPath, out.value, facets from control:NumericPoint" }, { limit: 5000 });
  if (found.truncated === true) notes.push("The station has more points than one query returns, so some meters may be missing.");
  const under = options.under && options.under !== "slot:/" ? options.under.replace(/\/+$/, "") : undefined;
  const all: PowerPoint[] = ((found.rows ?? []) as unknown[][])
    .filter((row) => typeof row[0] === "string" && typeof row[1] === "number" && Number.isFinite(row[1]) && isKilowatts(row[2]) && (!under || String(row[0]).startsWith(`${under}/`)))
    .map((row) => {
      const parts = String(row[0]).replace(/^slot:\/?/, "").split("/").filter((part) => part !== "points");
      const on = parts.length > 1 ? parts[parts.length - 2] : "";
      return { ord: String(row[0]), on, name: parts[parts.length - 1] ?? "", now: row[1] as number, main: false };
    });
  // The site's meter: the one whose name says so, else nothing is called the main one.
  const named = all.filter((p) => MAIN.test(p.on) || MAIN.test(p.name)).sort((a, b) => b.now - a.now)[0];
  if (named) named.main = true;
  const sorted = [...all].sort((a, b) => Number(b.main) - Number(a.main) || b.now - a.now);
  const points = sorted.slice(0, options.limit ?? 12);

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  const buckets = Math.max(1, Math.ceil((now - start) / QUARTER));
  await pooled(points, 4, async (point) => {
    const [today, yesterday] = await Promise.all([
      seriesFor(client, point.ord, start, start + buckets * QUARTER, buckets).catch(() => undefined),
      seriesFor(client, point.ord, start - 86400_000, start - 86400_000 + buckets * QUARTER, buckets).catch(() => undefined)
    ]);
    if (today?.length) {
      const top = today.reduce((a, b) => (b.value > a.value ? b : a));
      point.peak = top.value;
      point.peakAt = top.at;
      point.usedKwh = energyOf(today, QUARTER);
    }
    if (yesterday?.length) point.yesterdayKwh = energyOf(yesterday, QUARTER);
  });
  if (points.length && points.every((p) => p.peak === undefined)) notes.push("None of these points keeps a history, so there is no peak or energy to show: only what they read now.");
  return { station: String(client.capabilities.station ?? ""), at: now, points, more: sorted.length - points.length, notes };
}

const kw = (v: number) => `${v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1)} kW`;
const kwh = (v: number) => `${Math.round(v).toLocaleString("en-US")} kWh`;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function energyText(result: EnergyResult): string {
  if (!result.points.length) return "No point on this station reads in kilowatts, so there is no power to show.";
  const rows = result.points.map((p) => {
    const change = p.usedKwh !== undefined && p.yesterdayKwh !== undefined && p.yesterdayKwh > 1 ? ((p.usedKwh - p.yesterdayKwh) / p.yesterdayKwh) * 100 : undefined;
    const versus = change === undefined ? "" : `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(0)}%`;
    return [
      `${p.main ? chalk.bold(p.on || p.name) : p.on || p.name}${p.main ? chalk.dim("  site meter") : ""}`, p.on ? p.name : "", p.main ? chalk.bold(kw(p.now)) : kw(p.now),
      p.peak === undefined ? chalk.dim("no history") : `${kw(p.peak)} at ${clock(p.peakAt!)}`, p.usedKwh === undefined ? "" : kwh(p.usedKwh),
      p.yesterdayKwh === undefined ? "" : `${kwh(p.yesterdayKwh)}${versus ? `  ${Math.abs(change!) >= 10 ? chalk.yellow(versus) : chalk.dim(versus)}` : ""}`
    ];
  });
  const lines = [table(["on", "point", "now", "peak today", "used today", "yesterday by now"], rows)];
  if (result.more) lines.push(chalk.dim(`${result.more} smaller ${result.more === 1 ? "load is" : "loads are"} not listed.`));
  lines.push(chalk.dim("Today is since midnight on this computer. Peaks are quarter-hour averages; energy is worked out from the power history."));
  for (const note of result.notes) lines.push(chalk.yellow(`Note: ${note}`));
  return lines.join("\n");
}

export const energyCsv = (result: EnergyResult) =>
  csv(["ord", "on", "point", "main", "nowKw", "peakKw", "peakAt", "usedKwh", "yesterdayKwh"], result.points.map((p) => [p.ord, p.on, p.name, p.main, p.now, p.peak ?? "", p.peakAt ? new Date(p.peakAt).toISOString() : "", p.usedKwh ?? "", p.yesterdayKwh ?? ""]));
