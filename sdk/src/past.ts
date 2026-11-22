// Values at a moment in the past, from each point's own history: the last record at or before the
// time asked for. A point with no history, or one that was not recording then, is said to have no
// value rather than given one. Also the evenly spaced series a chart, or a search for when a value
// turned, is made from. Read-only: describe_history, read_history, read_history_rollup and read.
import { BaskStreamError, toSlotOrd, type BaskStreamClient, type Json } from "./core.js";
import { intervalMs } from "./check.js";
import { parseDuration } from "./format.js";
import { asSlotOrd, isLost, pooled, spanText, whenText, whyNot } from "./log.js";

/** Every operation these reads send. None of them changes the station. */
export const PAST_OPERATIONS = ["read", "describe_history", "read_history", "read_history_rollup"] as const;

export type PastValue = { ok: true; value: number | boolean | string; display: string; at: number; ageMs: number } | { ok: false; why: string };

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- A time, as typed ---------------------------------------------------------------------------------

const FORMS = "Use a length of time ago (3h, 2d), a day and a time (tue-2pm, yesterday-14:10, mon), a time today (9am), or a date (2026-11-17, 2026-11-17T14:10).";
const WEEKDAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

/** "2pm", "2:30pm", "14:10", "noon" or "midnight" as hours and minutes, or undefined when it is not a time of day. */
function timeOfDay(text: string): { hours: number; minutes: number } | undefined {
  if (text === "noon") return { hours: 12, minutes: 0 };
  if (text === "midnight") return { hours: 0, minutes: 0 };
  const found = /^(\d{1,2})(?::(\d\d))?\s*(am|pm)?$/.exec(text);
  if (!found || (!found[2] && !found[3])) return undefined;
  const [hours, minutes] = [Number(found[1]), Number(found[2] ?? 0)];
  if (minutes > 59) return undefined;
  if (found[3]) return hours >= 1 && hours <= 12 ? { hours: (hours % 12) + (found[3] === "pm" ? 12 : 0), minutes } : undefined;
  return hours <= 23 ? { hours, minutes } : undefined;
}

/**
 * A moment as a person types it, in the station user's own clock: "3h" is three hours ago,
 * "yesterday" and "mon" are this time of day then, "tue-2pm" is the last Tuesday at 14:00, "9am" is
 * the last time it was nine in the morning, and a date with no time is the start of that day.
 */
export function parseMoment(text: string, now = Date.now()): number {
  const typed = text.trim();
  const bad = () => new Error(`Bad time "${text}". ${FORMS}`);
  const past = (at: number) => {
    if (!Number.isFinite(at)) throw bad();
    if (at > now + MIN) throw new Error(`"${text}" has not come yet: the past is all that can be read.`);
    return Math.min(at, now);
  };
  const lower = typed.toLowerCase();
  if (lower === "now" || lower === "today") return now;
  if (/^\d{11,}$/.test(typed)) return past(Number(typed));
  if (/^\d+(?:\.\d+)?(ms|s|m|h|d|w)$/.test(lower)) return now - parseDuration(lower);
  const date = /^(\d{4})-(\d\d)-(\d\d)(?:[t _](\d{1,2}):(\d\d)(?::(\d\d))?)?$/.exec(lower);
  if (date) {
    const [year, month, day, hours, minutes, seconds] = date.slice(1).map((part) => Number(part ?? 0));
    const made = new Date(year, month - 1, day, hours, minutes, seconds);
    if (made.getMonth() !== month - 1 || made.getDate() !== day || hours > 23 || minutes > 59) throw bad();
    return past(made.getTime());
  }
  // A date that names its own zone ("…Z", "…+01:00") is read as written.
  if (/^\d{4}-\d\d-\d\dt[\d:.]+(z|[+-]\d\d:?\d\d)$/.test(lower)) return past(Date.parse(typed));

  const words = lower.split(/[-_\s]+/).filter(Boolean);
  const named = words[0] === "yesterday" || words[0] === "today" || words[0] in WEEKDAYS ? words.shift()! : undefined;
  const time = words.length ? timeOfDay(words.join("")) : undefined;
  if ((words.length && !time) || (!named && !time)) throw bad();
  const today = new Date(now);
  const on = (daysBack: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBack, time ? time.hours : today.getHours(), time ? time.minutes : today.getMinutes(), time ? 0 : today.getSeconds()).getTime();
  if (named === "today") return past(on(0));
  if (named === "yesterday") return past(on(1));
  // The last time it was that day, or that time of day: today when that has passed, else the one before.
  let back = named ? (today.getDay() - WEEKDAYS[named] + 7) % 7 : 0;
  if (on(back) > now || (named && !time && back === 0)) back += named ? 7 : 1;
  return past(on(back));
}

/**
 * A point with a moment after it: "slot:/…/AHU_2@tue-2pm", "@yesterday", "@2026-11-17T14:10",
 * "@3h" (three hours ago), "@mon". With no @ it is the point alone, and the time is now.
 */
export function parseAt(text: string, now = Date.now()): { ord: string; at?: number } {
  const cut = text.lastIndexOf("@");
  if (cut < 0) return { ord: text.trim() };
  const when = text.slice(cut + 1).trim();
  if (!when) throw new Error(`"${text}" ends in @ with no time after it. ${FORMS}`);
  return { ord: text.slice(0, cut).trim(), at: parseMoment(when, now) };
}

// ---- Values at a moment -------------------------------------------------------------------------------

/** A record whose status says its value is not to be trusted. */
const BAD_STATUS = /\b(down|fault|null|stale|disabled)\b/;
/** How far back a point that records on change of value is searched for its last record. */
const SEARCH = 30 * DAY;
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_v, i) => items.slice(i * size, (i + 1) * size));
const numberOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A history value as a point would show it, from the point's facets. */
export function pastDisplay(value: number | boolean | string, facets: Json | undefined): string {
  if (typeof value === "number") {
    const precision = Number(facets?.precision);
    const digits = Number.isInteger(precision) && precision >= 0 && precision <= 10 ? precision : Number.isInteger(value) ? 0 : 2;
    const units = typeof facets?.units === "string" && facets.units && facets.units !== "null" ? ` ${facets.units}` : "";
    return `${value.toFixed(digits)}${units}`;
  }
  if (typeof value === "boolean") return String((value ? facets?.trueText : facets?.falseText) ?? value);
  return value;
}

interface Held {
  id: string;
  first?: number;
  last?: number;
  /** Undefined for a history that records on change of value. */
  interval?: number;
  lastRecord?: Json;
}

/** The records of one history in a read_history reply: the one asked for, or the only one. */
const recordsOf = (history: Json, id: string) => {
  const lists = (history.histories ?? []) as Json[];
  const list = lists.find((h) => String(h.historyId ?? "") === id) ?? lists[0];
  return { records: ((list?.records ?? []) as Json[]).filter((r) => typeof r.timestamp === "number"), truncated: list?.truncated === true };
};

/** The last record of a history at or before `at`, or undefined when none is found. */
async function lastRecordAt(client: BaskStreamClient, ord: string, held: Held, at: number): Promise<Json | undefined> {
  const latest = (records: Json[]) => records.filter((r) => Number(r.timestamp) <= at).pop();
  // A history that records on an interval has its record just before the time, if it was recording.
  if (held.interval) {
    const near = latest(recordsOf(await client.history(ord, { start: at - Math.max(3 * held.interval, 2 * MIN), end: at, limit: 100 }), held.id).records);
    if (near) return near;
  }
  // Everything it holds is older than the time asked for: its newest record is the one.
  if (held.last !== undefined && held.last <= at && typeof held.lastRecord?.timestamp === "number" && held.lastRecord.timestamp <= at) return held.lastRecord;
  // Otherwise look back for the last stretch that has records, then read that stretch. A history
  // comes oldest first and a reply holds only so many, so a full reply is followed forward.
  const from = Math.max(held.first ?? 0, at - SEARCH);
  if (from >= at) return undefined;
  const step = Math.max(1000, Math.ceil((at - from) / 200));
  let start = from;
  try {
    const rollup = await client.historyRollup(ord, { start: from, end: at, interval: step, includeEmpty: false });
    const lists = (rollup.histories ?? []) as Json[];
    const filled = (((lists.find((h) => String(h.historyId ?? "") === held.id) ?? lists[0])?.buckets ?? []) as Json[]).filter((b) => Number(b.count) > 0);
    if (filled.length === 0) return undefined;
    start = Number(filled[filled.length - 1].start);
  } catch (error) {
    if (isLost(error) || !(error instanceof BaskStreamError && /unsupported|unknown_op/.test(error.code))) throw error;
  }
  let found: Json | undefined;
  for (let page = 0; page < 20; page += 1) {
    const { records, truncated } = recordsOf(await client.history(ord, { start, end: at, limit: 5000 }), held.id);
    found = latest(records) ?? found;
    if (!truncated || records.length === 0) break;
    start = Number(records[records.length - 1].timestamp) + 1;
  }
  return found;
}

async function valueAt(client: BaskStreamClient, ord: string, at: number, facets: Json | undefined): Promise<PastValue> {
  const described = ((((await client.call("describe_history", { ord })).history as Json | undefined)?.histories ?? []) as Json[]);
  if (described.length === 0) return { ok: false, why: "It keeps no history." };
  const all: Held[] = described.map((h) => ({ id: String(h.historyId ?? ""), first: numberOf(h.firstTimestamp), last: numberOf(h.lastTimestamp), interval: intervalMs(String((h.config as Json | undefined)?.interval ?? "")), lastRecord: h.lastRecord as Json | undefined }));
  const starts = all.map((h) => h.first).filter((first): first is number => first !== undefined);
  if (starts.length === 0) return { ok: false, why: "Its history holds no records." };
  // The history that covers the time; when none reaches it, the one that got nearest.
  const holding = all.filter((h) => h.first !== undefined && h.first <= at).sort((a, b) => Number((b.last ?? 0) >= at) - Number((a.last ?? 0) >= at) || (b.last ?? 0) - (a.last ?? 0));
  if (holding.length === 0) return { ok: false, why: `Its history starts ${whenText(Math.min(...starts))}, after the time asked for.` };
  const held = holding[0];
  const record = await lastRecordAt(client, ord, held, at);
  if (!record) return { ok: false, why: `Its history has no record in the ${spanText(Math.min(SEARCH, at - (held.first ?? 0)))} before ${whenText(at)}.` };
  const stamp = Number(record.timestamp);
  const age = at - stamp;
  if (held.interval && age > Math.max(3 * held.interval, 2 * MIN)) return { ok: false, why: `Its nearest record is from ${whenText(stamp)}, ${spanText(age)} before the time asked for. It records every ${spanText(held.interval)}, so it was not recording then.` };
  if (BAD_STATUS.test(String(record.status ?? ""))) return { ok: false, why: `Its record at ${whenText(stamp)} is marked ${String(record.status)}, so there is no good value for that time.` };
  const value = record.value;
  if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") return { ok: false, why: `Its record at ${whenText(stamp)} holds no value.` };
  if (typeof value === "number" && !Number.isFinite(value)) return { ok: false, why: `Its record at ${whenText(stamp)} is not a number.` };
  return { ok: true, value, display: pastDisplay(value, facets), at: stamp, ageMs: age };
}

/**
 * What each point held at a moment: the last record of its history at or before it. The answer is
 * keyed by the ORDs as they were given. A point with no history, one whose history starts later,
 * and one that was not recording then each get `{ ok: false, why }` in plain words.
 */
export async function valuesAt(client: BaskStreamClient, ords: string[], at: number): Promise<Map<string, PastValue>> {
  const out = new Map<string, PastValue>();
  const unique = [...new Set(ords)];
  // Units, precision and on/off words come from the points as they are now: a record holds a bare value.
  const facets = new Map<string, Json>();
  const limits = (client.capabilities.limits ?? {}) as Json;
  await pooled(chunks(unique.map(asSlotOrd), Math.max(1, Math.min(500, Number(limits.maxPointSnapshotPoints ?? 500) || 500))), 2, async (some) => {
    try {
      for (const snap of await client.read(some, { fields: ["point", "ok", "facets"] })) if (snap.facets && !snap.code) facets.set(toSlotOrd(snap.point), snap.facets);
    } catch (error) {
      if (isLost(error)) throw error;
    }
  });
  await pooled(unique, 6, async (given) => {
    const ord = asSlotOrd(given);
    try {
      out.set(given, await valueAt(client, ord, at, facets.get(ord)));
    } catch (error) {
      if (isLost(error)) throw error;
      const code = error instanceof BaskStreamError ? error.code : "";
      out.set(given, { ok: false, why: /invalid_point|invalid_component/.test(code) ? "There is no such point." : code === "history_failed" ? "It keeps no history that can be read." : `Its history could not be read: ${whyNot(error)}.` });
    }
  });
  return out;
}

// ---- A series -----------------------------------------------------------------------------------------

/**
 * A point's history as evenly spaced numbers: the average of each of `buckets` equal stretches
 * between two times, each placed at the middle of its stretch. A stretch with no records is left
 * out, so a gap in the history is a gap in the list. A two-state point averages to the share of
 * the time it was on. Undefined when the point has no history; empty when its history holds no
 * numbers in that time.
 */
export async function seriesFor(client: BaskStreamClient, ord: string, since: number, until: number, buckets: number): Promise<{ at: number; value: number }[] | undefined> {
  if (!(until > since)) return [];
  // A reply holds at most 5000 buckets, and none shorter than a second.
  const interval = Math.max(1000, Math.ceil((until - since) / Math.max(1, Math.min(4000, Math.floor(buckets)))));
  let rollup: Json;
  try {
    rollup = await client.historyRollup(asSlotOrd(ord), { start: since, end: until, interval, includeEmpty: false });
  } catch (error) {
    // A station answers a point with no history extension with history_failed.
    if (error instanceof BaskStreamError && error.code === "history_failed") return undefined;
    throw error;
  }
  const lists = (rollup.histories ?? []) as Json[];
  if (lists.length === 0) return undefined;
  const numbers = (list: Json) => ((list.buckets ?? []) as Json[]).filter((b) => Number(b.count) > 0 && typeof b.avg === "number" && Number.isFinite(b.avg) && typeof b.start === "number");
  // A point with two histories: the one that holds the most of this time.
  const best = lists.map(numbers).sort((a, b) => b.length - a.length)[0];
  return best.map((b) => ({ at: Number(b.start) + interval / 2, value: Number(b.avg) }));
}
