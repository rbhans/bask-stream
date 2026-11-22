// bask why: what is driving a value, as facts read from the station. No AI and no guessing: each
// part is there only when it was found, and what could not be worked out is said in `notes`.
//
// It looks at five things: what commands the point (its priority levels), what reaches it through
// links, when its history last changed character and what was changed on the same equipment beside
// that moment, the alarms on it, and what feeds its equipment. Read-only.
import { toSlotOrd, type BaskStreamClient, type BrowseNode, type Json, type PointSnapshot } from "./core.js";
import { NO_CHANGE_LIST, asSlotOrd, isLost, pooled, readLog, spanText, whenText, whereText, whoText, whyNot, type LogEvent } from "./log.js";
import { loadSheet, slotOrd, traceOf, type Sheet } from "./logic.js";
import type { Medium, ModelServes } from "./model.js";
import { pastDisplay, seriesFor, valuesAt } from "./past.js";

/** Every operation an explanation sends, with those readLog sends. None of them changes the station. */
export const WHY_OPERATIONS = ["describe", "read", "browse", "describe_write", "describe_component", "describe_history", "read_history", "read_history_rollup", "query", "read_alarms", "read_agent_log", "list_changes", "list_proposals"] as const;

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** How close in time two things must be to be called beside each other. */
export const NEAR = 30 * MIN;

/** What commands a writable point: the priority level in control and what holds it. */
export interface WhyCommand {
  /** The priority level in control, 1 to 16, or "fallback" when every level is empty. */
  level: number | "fallback";
  /** The slot that holds it: in1 to in16, or fallback. */
  slot: string;
  /** Level 1 is an emergency override, level 8 an operator's override, any other level an input. */
  held: "emergency" | "override" | "input" | "fallback";
  /** What that level holds, as text. */
  display?: string;
  /** For an input a link feeds: where the link comes from. */
  source?: { ord: string; slot: string; name: string };
  /** For an override: who set it and when, from the audit log. */
  by?: string;
  since?: number;
  /** An AI agent set it or asked for it. */
  agent?: boolean;
  /** The proposal it was approved as. */
  id?: string;
  /** When an override set for a time runs out. */
  expires?: number;
}

/** One link on the way to the point, with what its source reads now. */
export interface WhyFeed {
  /** 1 for a link that arrives at the point itself, 2 for one that feeds that link's source, and so on. */
  depth: number;
  source: string;
  sourceSlot: string;
  target: string;
  targetSlot: string;
  /** A short name for the source. */
  name: string;
  display?: string;
  state?: string;
  /** It arrives at the priority level in control. */
  active?: boolean;
}

/** When a point's history last changed character. */
export interface WhyTurn {
  /** When the value left its earlier level. */
  at: number;
  /** The level before and after: the mean of the stretch on each side. */
  before: number;
  after: number;
  beforeText: string;
  afterText: string;
}

export interface WhyChange {
  event: LogEvent;
  /** Its time less the turn's: negative when it came first. Absent when no turn was found. */
  gapMs?: number;
  /** Within 30 minutes of the turn. */
  near: boolean;
}

export interface WhySibling extends WhyTurn {
  ord: string;
  name: string;
  gapMs: number;
}

/** A point of an upstream unit that is not as it should be, or turned beside the explained point. */
export interface WhyIssue {
  ord: string;
  name: string;
  display?: string;
  /** alarm, fault, down, overridden: what its status says now. */
  states: string[];
  turn?: WhyTurn & { gapMs: number };
}

export interface WhyUpstream {
  /** The equipment that feeds. */
  ord: string;
  name: string;
  /** What it feeds: the explained point's equipment at depth 1, the unit one step nearer at depth 2 and 3. */
  feeds: string;
  feedsName: string;
  medium: Medium;
  depth: number;
  /** A person confirmed it, or the station holds it as a relation. False for a proposal nobody confirmed. */
  confirmed: boolean;
  inferred: boolean;
  issues: WhyIssue[];
  /** How many of its points were looked at. */
  points: number;
}

export interface Why {
  ord: string;
  /** A short name: "VAV_105/ZoneTemp". */
  name: string;
  /** The moment explained: now, unless a time was asked for. */
  at: number;
  /** True when it is about now. */
  live: boolean;
  window: { since: number; until: number };
  /** What the point reads now, or what its history holds for the time asked for. */
  value?: { display: string; value?: unknown; state?: string; at?: number };
  /** The equipment the point belongs to: the device above it, or its folder. */
  equipment?: { ord: string; name: string };
  command?: WhyCommand;
  /** The links on the way to the point. Empty when it was looked for and nothing feeds it. */
  feeds?: WhyFeed[];
  turn?: WhyTurn;
  /** True when its history was read over the window and showed no turn: the value held its level. */
  steady?: boolean;
  /** What was changed on the same equipment in the window, those nearest the turn first. */
  changes?: WhyChange[];
  /** Other points of the same equipment whose history turned within 30 minutes of this one's. */
  siblings?: WhySibling[];
  /** Alarms on the point or its equipment in the window, newest first. */
  alarms?: LogEvent[];
  /** What feeds the equipment, nearest first, from a model review file. */
  upstream?: WhyUpstream[];
  /** What could not be read or worked out, in plain words. */
  notes: string[];
}

export interface WhyOptions {
  /** Explain the value at this time rather than now. */
  at?: number;
  /** How far back to look (default 7 days). */
  windowMs?: number;
  /** What serves what, from a model review file (bask model infer). */
  serves?: ModelServes[];
  /** The ORD of the equipment the point belongs to, when the caller knows it; otherwise the device above it, or its folder. */
  equipment?: string;
}

// ---- When a series turned -----------------------------------------------------------------------------

export interface Turn {
  /** The time between the last value at the earlier level and the first at the later one. */
  at: number;
  before: number;
  after: number;
  /** The ordinary spread of the values before the turn (their standard deviation). */
  spread: number;
}

/**
 * When a series last changed character: its most recent sustained shift of level.
 *
 * The rule. Take a stretch of the series on each side of every point in turn (a day long, so that
 * the swing every building has over a day cancels out; a third of the series when it is shorter
 * than three days) and compare the mean of the two. The noise is the spread of the values inside
 * the two stretches about their own means. A point is a turn when:
 *   - the two means differ by at least 4 times that noise (8 times when the stretches are shorter
 *     than a day, where a daily swing can look like a shift),
 *   - no point within half a stretch of it scores higher, and
 *   - the shift lasts: the mean of the last stretch of the whole series is still at least half
 *     the shift away from the earlier level, on the same side.
 * The latest such point is reported, with the mean before and after it. A value that never
 * shifted has none, and that is a normal answer.
 */
export function findTurn(series: { at: number; value: number }[], options: { spanMs?: number } = {}): Turn | undefined {
  const n = series.length;
  if (n < 12) return undefined;
  const gaps = series.slice(1).map((p, i) => p.at - series[i].at).sort((a, b) => a - b);
  const step = gaps[Math.floor(gaps.length / 2)];
  const total = series[n - 1].at - series[0].at;
  if (!(step > 0) || !(total > 0)) return undefined;
  const spanMs = options.spanMs ?? Math.min(DAY, total / 3);
  const k = Math.max(4, Math.round(spanMs / step));
  if (n < 2 * k + 1) return undefined;
  const need = spanMs >= DAY ? 4 : 8;
  // Running sums, so the mean and the spread of any stretch cost nothing.
  const sum = new Float64Array(n + 1);
  const squares = new Float64Array(n + 1);
  let low = Infinity, high = -Infinity;
  series.forEach((p, i) => {
    sum[i + 1] = sum[i] + p.value;
    squares[i + 1] = squares[i] + p.value * p.value;
    low = Math.min(low, p.value);
    high = Math.max(high, p.value);
  });
  if (!(high > low)) return undefined;
  const mean = (from: number, to: number) => (sum[to] - sum[from]) / (to - from);
  const variance = (from: number, to: number) => Math.max(0, (squares[to] - squares[from]) / (to - from) - mean(from, to) ** 2);
  // A series that is flat on each side of a step has no noise to divide by: a fiftieth of its range stands in.
  const floor = (high - low) / 50;
  const score = new Float64Array(n);
  for (let i = k; i <= n - k; i += 1) score[i] = Math.abs(mean(i, i + k) - mean(i - k, i)) / Math.max(floor, Math.sqrt((variance(i - k, i) + variance(i, i + k)) / 2));
  const tail = mean(n - k, n);
  const half = Math.floor(k / 2);
  for (let i = n - k; i >= k; i -= 1) {
    if (score[i] < need) continue;
    let peak = true;
    for (let j = Math.max(k, i - half); j <= Math.min(n - k, i + half) && peak; j += 1) if (score[j] > score[i]) peak = false;
    if (!peak) continue;
    const [before, after] = [mean(i - k, i), mean(i, i + k)];
    if ((tail - before) * Math.sign(after - before) < Math.abs(after - before) / 2) continue;
    return { at: (series[i - 1].at + series[i].at) / 2, before, after, spread: Math.sqrt(variance(i - k, i)) };
  }
  return undefined;
}

/**
 * A turn's time, from a finer series around it: when the value first left its earlier level and
 * stayed away. "Left" is a quarter of the shift, or two and a half times the earlier spread where
 * that is more, towards the later level; "stayed" is three values in a row. When the finer series
 * does not show it, the time is left as it was.
 */
export function refineTurn(fine: { at: number; value: number }[], turn: Turn): Turn {
  if (fine.length < 4) return turn;
  const side = Math.sign(turn.after - turn.before);
  const away = Math.max(Math.abs(turn.after - turn.before) / 4, 2.5 * turn.spread);
  // A band wider than the shift itself would never be left.
  if (away >= Math.abs(turn.after - turn.before)) return turn;
  const left = (p: { value: number }) => (p.value - turn.before) * side >= away;
  for (let i = 0; i < fine.length; i += 1) {
    if (!left(fine[i]) || !fine.slice(i, i + 3).every(left)) continue;
    // Already away at the start of the finer series: it began before this stretch, which cannot place it.
    if (i === 0) return turn;
    return { ...turn, at: (fine[i - 1].at + fine[i].at) / 2 };
  }
  return turn;
}

/** The buckets a window is cut into for the first look: half an hour each over a week. */
const BUCKETS = 336;
const numbersText = (value: number, facets: Json | undefined, twoState: boolean) =>
  twoState ? `${Math.round(value * 100)}% of the time ${String(facets?.trueText ?? "on")}` : pastDisplay(value, facets);

/** A point's last turn in a window, placed with a finer second read. Undefined when it has no history, or did not turn. */
async function turnOf(client: BaskStreamClient, ord: string, since: number, until: number, about?: number): Promise<{ turn?: Turn; history: boolean; values: number }> {
  const series = await seriesFor(client, ord, since, until, BUCKETS);
  if (!series) return { history: false, values: 0 };
  const coarse = findTurn(series);
  if (!coarse) return { history: true, values: series.length };
  const step = (until - since) / BUCKETS;
  // Not worth a second read when it is nowhere near the time that matters.
  if (about !== undefined && Math.abs(coarse.at - about) > NEAR + 2 * step) return { turn: coarse, history: true, values: series.length };
  const reach = Math.max(3 * HOUR, 2 * step);
  const [from, to] = [Math.max(since, coarse.at - reach), Math.min(until, coarse.at + reach)];
  const fine = to - from > 10 * MIN ? await seriesFor(client, ord, from, to, Math.max(12, Math.min(400, Math.round((to - from) / (5 * MIN))))) : undefined;
  return { turn: fine ? refineTurn(fine, coarse) : coarse, history: true, values: series.length };
}

// ---- What commands a point ----------------------------------------------------------------------------

interface LinkEnd {
  source: string;
  sourceSlot: string;
  target: string;
  targetSlot: string;
}

/** The links that arrive at a component, from a describe_component reply. */
function linksInto(described: Json | undefined, ord: string): LinkEnd[] {
  return (((described?.links ?? []) as Json[]))
    .filter((l) => typeof l.source === "string" && typeof l.target === "string" && typeof l.sourceSlot === "string" && typeof l.targetSlot === "string")
    .map((l) => ({ source: toSlotOrd(String(l.source)), sourceSlot: String(l.sourceSlot), target: toSlotOrd(String(l.target)), targetSlot: String(l.targetSlot) }))
    .filter((l) => l.target === ord);
}

/** A priority level from however a reply names it: 8, "8", "level_8", {ordinal, tag, display}; "def" and "fallback" are the fallback. */
function levelOf(value: unknown): number | "fallback" | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object") {
    const named = value as Json;
    return levelOf(named.tag) ?? levelOf(named.display) ?? levelOf(named.ordinal);
  }
  const text = String(value).trim().toLowerCase();
  if (/^(def|default|fallback)$/.test(text)) return "fallback";
  const found = /^(?:level_?|in)?(\d{1,2})$/.exec(text);
  const level = found ? Number(found[1]) : NaN;
  return level >= 1 && level <= 16 ? level : level === 17 ? "fallback" : undefined;
}

/**
 * The priority level in control of a writable point and what holds it, from the replies of
 * describe_write and describe_component and the point's own snapshot. Undefined for a point
 * that is not writable, or when none of them says which level is in control.
 */
export function commandOf(write: Json | undefined, snapshot: PointSnapshot | undefined, described: Json | undefined, ord: string): WhyCommand | undefined {
  if (write?.writable === false) return undefined;
  const levels = Array.isArray(write?.levels) ? (write.levels as Json[]) : [];
  const input = (level: number) => levels.find((entry) => Number(entry.level) === level)?.input as Json | undefined;
  const held = (entry: Json | undefined) => !!entry && entry.ok !== false && !/null/.test(String(entry.status ?? ""));
  // Which level is in control: as the write description says, else the snapshot ("{overridden} @ 8"),
  // else the highest level that holds a value.
  const level = levelOf(write?.activeLevel) ?? levelOf(snapshot?.activeLevel) ?? levelOf(/@\s*(\w+)\s*$/.exec(String(snapshot?.status ?? ""))?.[1])
    ?? (levels.length ? levels.map((entry) => Number(entry.level)).filter((n) => held(input(n))).sort((a, b) => a - b)[0] ?? "fallback" : undefined);
  if (level === undefined) return undefined;
  const tidy = (text: unknown) => (typeof text === "string" && text ? text.replace(/\s*\{[^}]*\}\s*$/, "").trim() || undefined : undefined);
  if (level === "fallback") return { level, slot: "fallback", held: "fallback", display: tidy((write?.fallback as Json | undefined)?.display) ?? snapshot?.displayValue };
  const slot = `in${level}`;
  const link = linksInto(described, ord).find((l) => l.targetSlot === slot);
  const expires = Number((write?.overrideExpiration as Json | undefined)?.timestamp);
  return {
    level, slot, held: level === 1 ? "emergency" : level === 8 ? "override" : "input",
    // The level in control is what the point puts out, so its own reading says what the level holds.
    display: tidy(input(level)?.display) ?? snapshot?.displayValue,
    ...(link ? { source: { ord: link.source, slot: link.sourceSlot, name: whereText(link.source) } } : {}),
    ...(level === 8 && Number.isFinite(expires) && expires > 0 ? { expires } : {})
  };
}

// ---- Reading the station ------------------------------------------------------------------------------

const parentOf = (ord: string) => (ord.lastIndexOf("/") > 5 ? ord.slice(0, ord.lastIndexOf("/")) : "slot:/");
const lastOf = (ord: string) => ord.slice(ord.lastIndexOf("/") + 1);
const flagsOf = (snap: PointSnapshot | undefined) => ["alarm", "fault", "down", "overridden"].filter((flag) => new RegExp(`\\b${flag}\\b`).test(String(snap?.status ?? "")) || snap?.state === flag);
const stateOf = (snap: PointSnapshot | undefined) => snap?.state ?? flagsOf(snap)[0];
const isControlPoint = (node: BrowseNode) => node.kind === "point" && !/Ext$/.test(String(node.typeSpec ?? ""));

/**
 * The equipment a point belongs to, as bask model picks it: the device above it, else the folder it
 * is in, and the folder above that when its own is just called "points".
 */
async function ownerOf(client: BaskStreamClient, ord: string, node: BrowseNode | undefined): Promise<string> {
  let above = ((node?.metadata?.ancestors ?? []) as Json[]).map((a) => ({ ord: toSlotOrd(String(a.ord ?? a.slotPath ?? "")), typeSpec: String(a.typeSpec ?? ""), name: String(a.name ?? "") })).filter((a) => a.ord.startsWith("slot:"));
  if (above.length === 0) {
    // A station that does not list a component's ancestors is asked about each in turn, nearest first.
    const chain: string[] = [];
    for (let at = parentOf(ord); at !== "slot:/" && chain.length < 12; at = parentOf(at)) chain.unshift(at);
    above = await pooled(chain, 4, async (at) => {
      const found = await client.describe(at, "none").catch((error: unknown) => {
        if (isLost(error)) throw error;
        return undefined;
      });
      return { ord: at, typeSpec: String(found?.typeSpec ?? ""), name: String(found?.name ?? lastOf(at)) };
    });
  }
  const device = [...above].reverse().find((a) => /Device$/.test(a.typeSpec));
  if (device) return device.ord;
  const folder = parentOf(ord);
  return /^points$/i.test(lastOf(folder)) && folder !== "slot:/" && parentOf(folder) !== "slot:/" ? parentOf(folder) : folder;
}

/** The control points under a piece of equipment, by browse. */
async function pointsUnder(client: BaskStreamClient, equipment: string): Promise<string[]> {
  const found: string[] = [];
  const visit = (node: BrowseNode) => {
    for (const child of node.children ?? []) {
      if (isControlPoint(child)) found.push(toSlotOrd(child.ord));
      // A point's own parts (its proxy extension, a history extension) are not points of the equipment.
      else if (child.kind !== "point" && found.length < 400) visit(child);
    }
  };
  visit(await client.browse(equipment, { depth: 3 }));
  return found;
}

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_v, i) => items.slice(i * size, (i + 1) * size));

async function snapshots(client: BaskStreamClient, ords: string[]): Promise<Map<string, PointSnapshot>> {
  const out = new Map<string, PointSnapshot>();
  const limits = (client.capabilities.limits ?? {}) as Json;
  await pooled(chunks([...new Set(ords)], Math.max(1, Math.min(500, Number(limits.maxPointSnapshotPoints ?? 500) || 500))), 2, async (some) => {
    for (const snap of await client.read(some)) if (!snap.code) out.set(toSlotOrd(snap.point), snap);
  });
  return out;
}

/** The most links followed, the most steps back from the point, and the most wire sheets opened for it. */
const FEED_CAP = 30;
const FEED_DEPTH = 5;
const SHEET_CAP = 3;

/**
 * What reaches a point through links: each link that arrives at it, then, in the wire sheet each
 * of those comes from, the links that feed its source, a few steps back.
 */
async function feedsOf(client: BaskStreamClient, ord: string, direct: LinkEnd[], notes: string[]): Promise<WhyFeed[]> {
  const feeds: WhyFeed[] = direct.map((l) => ({ depth: 1, ...l, name: whereText(l.source) }));
  const seen = new Set(feeds.map((f) => `${f.source}|${f.sourceSlot}|${f.target}|${f.targetSlot}`));
  const folders = [...new Set(direct.map((l) => parentOf(l.source)))];
  if (folders.length > SHEET_CAP) notes.push(`Links reach this point from ${folders.length} folders: only the first ${SHEET_CAP} were followed further back.`);
  const sheets = await pooled(folders.slice(0, SHEET_CAP), 2, async (folder): Promise<Sheet | undefined> => {
    try {
      return await loadSheet(client, folder);
    } catch (error) {
      if (isLost(error)) throw error;
      notes.push(`What feeds ${whereText(folder)} could not be followed further back (${whyNot(error)}).`);
      return undefined;
    }
  });
  let cut = false;
  for (const [index, sheet] of sheets.entries()) {
    if (!sheet) continue;
    for (const link of direct.filter((l) => parentOf(l.source) === folders[index])) {
      // Everything the trace holds that arrives at the source, and at what feeds the source, and so on back.
      const trace = traceOf(sheet, link.source, link.sourceSlot);
      const upstream = [...trace.links].map((i) => sheet.links[i]);
      const queue = [{ block: link.source, depth: 1 }];
      const walked = new Set([link.source, ord]);
      while (queue.length) {
        const { block, depth } = queue.shift()!;
        for (const l of upstream.filter((candidate) => candidate.target === block && candidate.source !== ord)) {
          const key = `${l.source}|${l.sourceSlot}|${l.target}|${l.targetSlot}`;
          if (seen.has(key)) continue;
          if (depth >= FEED_DEPTH || feeds.length >= FEED_CAP) {
            cut = true;
            continue;
          }
          seen.add(key);
          feeds.push({ depth: depth + 1, ...l, name: whereText(l.source) });
          if (!walked.has(l.source)) {
            walked.add(l.source);
            queue.push({ block: l.source, depth: depth + 1 });
          }
        }
      }
    }
  }
  if (cut) notes.push("More links feed this point than are listed: the walk back stopped at its limit.");
  // Each link is followed by the ones that feed its source, so the list reads as a tree.
  const ordered: WhyFeed[] = [];
  const place = (feed: WhyFeed) => {
    if (ordered.includes(feed)) return;
    ordered.push(feed);
    for (const next of feeds.filter((other) => other.depth === feed.depth + 1 && other.target === feed.source)) place(next);
  };
  for (const feed of feeds.filter((f) => f.depth === 1)) place(feed);
  for (const feed of feeds) place(feed);
  feeds.splice(0, feeds.length, ...ordered);
  // What each source reads now. Any slot of any component reads like a point.
  try {
    const values = await snapshots(client, feeds.map((f) => slotOrd(f.source, f.sourceSlot)));
    for (const feed of feeds) {
      const snap = values.get(slotOrd(feed.source, feed.sourceSlot));
      if (snap?.displayValue !== undefined) feed.display = snap.displayValue;
      const state = stateOf(snap);
      if (state && state !== "ok") feed.state = state;
    }
  } catch (error) {
    if (isLost(error)) throw error;
    notes.push(`What the links carry now could not be read (${whyNot(error, "read")}).`);
  }
  return feeds;
}

/** Every piece of equipment looked at for one explanation, and the most points read on each. */
const UPSTREAM_DEPTH = 3;
const POINT_CAP = 60;

// ---- The explanation ----------------------------------------------------------------------------------

/**
 * What is driving a point's value, as facts: what commands it, what feeds it, when it last turned
 * and what changed beside that, its alarms, and what is wrong upstream. Nothing is changed.
 */
export async function explain(client: BaskStreamClient, ord: string, options: WhyOptions = {}): Promise<Why> {
  const point = asSlotOrd(ord);
  const now = Date.now();
  const at = Math.min(options.at ?? now, now);
  const live = options.at === undefined || at >= now - 2 * MIN;
  const window = { since: at - (options.windowMs ?? 7 * DAY), until: at };
  const why: Why = { ord: point, name: whereText(point), at, live, window, notes: [] };
  const { notes } = why;
  /** Runs one part. What goes wrong with it is a note; a lost connection is not. */
  const part = async <T>(what: string, op: string | undefined, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      if (isLost(error)) throw error;
      notes.push(`${what} could not be read (${whyNot(error, op)}).`);
      return undefined;
    }
  };

  const [snaps, node] = await Promise.all([client.read([point]), part("Where the point sits", "describe", () => client.describe(point))]);
  const snap = snaps[0];
  if (!snap || snap.code) throw new Error(`There is no point at ${point}${snap?.message ? ` (${snap.code}: ${snap.message})` : ""}.`);
  const facets = snap.facets;
  const twoState = snap.valueType === "boolean";
  if (live) why.value = { display: snap.displayValue ?? String(snap.value ?? ""), value: snap.value, ...(stateOf(snap) ? { state: stateOf(snap) } : {}) };
  else {
    const then = (await part("Its value at that time", "read_history", () => valuesAt(client, [point], at)))?.get(point);
    if (then?.ok) why.value = { display: then.display, value: then.value, at: then.at };
    else if (then) notes.push(`What it read at ${whenText(at)} is not known. ${then.why}`);
  }
  // The caller may know the equipment better than the tree says: one controller can hold several units,
  // each in a folder, and the map's model has already worked out which folder is a unit.
  const owner = options.equipment ?? (await part("Which equipment the point belongs to", "describe", () => ownerOf(client, point, node)));
  if (owner) why.equipment = { ord: owner, name: whereText(owner) };
  const windowText = spanText(window.until - window.since);

  // What happened on the equipment, the turn of the point's own history, and what is on the wire sheet.
  const writable = node?.writable === true || snap.activeLevel !== undefined || /Writable$/.test(String(node?.typeSpec ?? ""));
  const [log, turned, described, write, mine] = await Promise.all([
    owner ? part(`What happened on ${whereText(owner)}`, undefined, () => readLog(client, { under: owner, since: window.since, until: window.until })) : undefined,
    part("Its history", "read_history_rollup", () => turnOf(client, point, window.since, window.until)),
    part("Its links", "describe_component", async () => (await client.call("describe_component", { ord: point })).result as Json),
    writable && live ? part("What commands it", "describe_write", async () => ((await client.describeWrite([point])).points as Json[] | undefined)?.[0]) : undefined,
    owner ? part(`The points of ${whereText(owner)}`, "browse", () => pointsUnder(client, owner)) : undefined
  ]);
  // The log's note about a station with no change list is about ids, which nothing here needs.
  for (const note of log?.notes ?? []) if (note !== NO_CHANGE_LIST) notes.push(note);
  const events = log?.events ?? [];

  // ---- What commands it
  const overrides = events.filter((e) => e.kind === "override" && e.ord === point).sort((a, b) => b.at - a.at);
  if (writable && live) {
    const command = commandOf(write && !write.code ? write : undefined, snap, described, point);
    if (command) {
      if (command.held === "override" || command.held === "emergency") {
        const set = overrides.find((e) => e.until === undefined && !e.ended && /^emergency/i.test(e.slot ?? "") === (command.held === "emergency"));
        if (set) Object.assign(command, { ...(set.who ? { by: set.who } : {}), since: set.at, ...(set.agent ? { agent: true } : {}), ...(set.id ? { id: set.id } : {}) });
        else if (log) notes.push(`Who set this override is not known: the audit log has no record of it in the last ${windowText}.`);
      }
      why.command = command;
    } else if (write?.writable !== false) notes.push("Which priority level is in control could not be read from the station.");
  } else if (writable) {
    // Priority levels are only known as they are now. An override is the one thing the audit log dates.
    const then = overrides.find((e) => e.at <= at && (e.until === undefined ? !e.ended : e.until > at));
    if (then) {
      const emergency = /^emergency/i.test(then.slot ?? "");
      why.command = { level: emergency ? 1 : 8, slot: emergency ? "in1" : "in8", held: emergency ? "emergency" : "override", ...(then.to ? { display: then.to } : {}), ...(then.who ? { by: then.who } : {}), since: then.at, ...(then.agent ? { agent: true } : {}), ...(then.id ? { id: then.id } : {}) };
    } else notes.push(`Which priority level was in control at ${whenText(at)} is not recorded. The audit log shows no override of it in place then.`);
  }

  // ---- What reaches it through links
  if (described) {
    const direct = linksInto(described, point);
    why.feeds = direct.length ? await feedsOf(client, point, direct, notes) : [];
    for (const feed of why.feeds) if (feed.depth === 1 && why.command && feed.targetSlot === why.command.slot) feed.active = true;
    if (!live && why.feeds.length) notes.push("The links, and what they carry, are as they are now.");
  }

  // ---- When it turned
  const asTurn = (turn: Turn, pointFacets: Json | undefined, isTwoState: boolean): WhyTurn => ({ at: turn.at, before: turn.before, after: turn.after, beforeText: numbersText(turn.before, pointFacets, isTwoState), afterText: numbersText(turn.after, pointFacets, isTwoState) });
  if (turned && !turned.history) notes.push("It keeps no history, so when its value last turned cannot be told.");
  else if (turned && turned.values < 12) notes.push(`Its history holds too little of the last ${windowText} to tell when its value turned.`);
  else if (turned?.turn) why.turn = asTurn(turned.turn, facets, twoState);
  else if (turned) why.steady = true;
  const turn = why.turn;

  // ---- What changed on the same equipment, nearest the turn first
  if (log) {
    const changes = events.filter((e) => e.kind !== "alarm").map((event): WhyChange => (turn ? { event, gapMs: event.at - turn.at, near: Math.abs(event.at - turn.at) <= NEAR } : { event, near: false }));
    why.changes = turn ? changes.sort((a, b) => Math.abs(a.gapMs!) - Math.abs(b.gapMs!)) : changes;
    why.alarms = events.filter((e) => e.kind === "alarm");
  }

  // ---- Other points of the equipment that turned with it
  const others = (mine ?? []).filter((other) => other !== point);
  const turnsNear = async (ords: string[], about: number): Promise<{ ord: string; turn: Turn }[]> => {
    if (ords.length > POINT_CAP) notes.push(`${whereText(parentOf(ords[0]))} has ${ords.length} points: only the first ${POINT_CAP} were checked for a turn.`);
    const found = await pooled(ords.slice(0, POINT_CAP), 6, async (other) => {
      try {
        const { turn: theirs } = await turnOf(client, other, window.since, window.until, about);
        return theirs && Math.abs(theirs.at - about) <= NEAR ? { ord: other, turn: theirs } : undefined;
      } catch (error) {
        if (isLost(error)) throw error;
        return undefined;
      }
    });
    return found.filter((entry): entry is { ord: string; turn: Turn } => !!entry);
  };
  let ownSnaps: Map<string, PointSnapshot> | undefined;
  if (turn && others.length) {
    const near = await part("The histories of the equipment's other points", "read_history_rollup", () => turnsNear(others, turn.at));
    if (near) {
      ownSnaps = near.length ? await part("The equipment's other points", "read", () => snapshots(client, near.map((entry) => entry.ord))) : undefined;
      why.siblings = near.map(({ ord: other, turn: theirs }) => ({ ord: other, name: lastOf(other), gapMs: theirs.at - turn.at, ...asTurn(theirs, ownSnaps?.get(other)?.facets, ownSnaps?.get(other)?.valueType === "boolean") })).sort((a, b) => Math.abs(a.gapMs) - Math.abs(b.gapMs));
    }
  }

  // ---- What feeds the equipment
  if (owner && !options.serves) notes.push(`What feeds ${whereText(owner)} is not known: no model review file was given (bask model infer makes one).`);
  else if (owner && options.serves) {
    const serves = options.serves.map((s) => ({ ...s, from: toSlotOrd(s.from), to: toSlotOrd(s.to) }));
    const upstream: WhyUpstream[] = [];
    const visited = new Set([owner]);
    let wave = [owner];
    for (let depth = 1; depth <= UPSTREAM_DEPTH && wave.length; depth += 1) {
      const next: string[] = [];
      for (const fed of wave) {
        for (const s of serves.filter((entry) => entry.to === fed && !visited.has(entry.from))) {
          visited.add(s.from);
          next.push(s.from);
          upstream.push({ ord: s.from, name: s.fromName || whereText(s.from), feeds: fed, feedsName: whereText(fed), medium: s.medium, depth, confirmed: s.confirmed === true, inferred: s.inferred === true, issues: [], points: 0 });
        }
      }
      wave = next;
    }
    if (upstream.length === 0) notes.push(`The model review file names nothing that feeds ${whereText(owner)}.`);
    await pooled(upstream, 2, async (unit) => {
      const theirs = await part(`The points of ${unit.name}`, "browse", () => pointsUnder(client, unit.ord));
      if (!theirs) return;
      unit.points = theirs.length;
      const [values, turns] = await Promise.all([
        part(`The values of ${unit.name}`, "read", () => snapshots(client, theirs)),
        turn ? part(`The histories of ${unit.name}`, "read_history_rollup", () => turnsNear(theirs, turn.at)) : undefined
      ]);
      for (const other of theirs) {
        const value = values?.get(other);
        const states = flagsOf(value);
        const theirTurn = turns?.find((entry) => entry.ord === other)?.turn;
        if (states.length === 0 && !theirTurn) continue;
        unit.issues.push({ ord: other, name: lastOf(other), ...(value?.displayValue !== undefined ? { display: value.displayValue } : {}), states, ...(theirTurn && turn ? { turn: { ...asTurn(theirTurn, value?.facets, value?.valueType === "boolean"), gapMs: theirTurn.at - turn.at } } : {}) });
      }
    });
    why.upstream = upstream;
  }
  why.notes = [...new Set(notes)];
  return why;
}

// ---- Output -----------------------------------------------------------------------------------------

const MEDIUM_WORDS: Record<Medium, string> = { air: "air", chilledWater: "chilled water", hotWater: "hot water" };
const STATE_WORDS: Record<string, string> = { alarm: "in alarm", fault: "in fault", down: "down", overridden: "overridden", stale: "stale", null: "no value", disabled: "disabled" };
const gapText = (gapMs: number) => (Math.abs(gapMs) < MIN ? "at the same time" : `${spanText(Math.abs(gapMs))} ${gapMs < 0 ? "before" : "after"}`);
const levelText = (command: WhyCommand) => (command.level === "fallback" ? "the fallback" : `level ${command.level}`);

/** What commands the point, in a line. */
function commandText(command: WhyCommand, now: number): string {
  const holds = command.display ? ` at ${command.display}` : "";
  if (command.held === "fallback") return `Nothing commands it: every priority level is empty, so it sits at its fallback${holds}.`;
  if (command.held === "input") return `Priority ${levelText(command)} (${command.slot}) is in control${holds}${command.source ? `, fed by a link from ${command.source.name}.${command.source.slot}` : ", with no link to it"}.`;
  const who = command.by ? ` by ${command.by}${command.agent ? (command.id ? ` (approving ${command.id}, which an AI agent asked for)` : " (an AI agent)") : ""}` : "";
  const since = command.since !== undefined ? ` since ${whenText(command.since)} (${spanText(now - command.since)})` : "";
  const ends = command.expires ? `, until ${whenText(command.expires)}` : command.since !== undefined ? ", with no end set" : "";
  return `It is held by ${command.held === "emergency" ? "an emergency override" : "an override"}${holds} (priority ${levelText(command)}), set${who}${since}${ends}.`;
}

/**
 * The explanation as a short chain a controls technician can read: what holds the value by hand
 * first, then the turn and what changed beside it, then what feeds it, what is wrong upstream,
 * the alarms, and last what was not found. Lines under a heading start with └, │ or ↑.
 */
export function whyText(why: Why, options: { width?: number } = {}): string {
  const width = options.width && options.width > 20 ? options.width : undefined;
  const clip = (text: string) => (width && [...text].length > width ? `${[...text].slice(0, width - 1).join("")}…` : text);
  const lines: string[] = [];
  const say = (text: string) => lines.push(clip(text));
  const equipment = why.equipment?.name ?? "the same equipment";
  const windowText = spanText(why.window.until - why.window.since);
  const inWindow = why.live ? `in the last ${windowText}` : `in the ${windowText} before`;
  const state = why.value?.state && why.value.state !== "ok" ? `, ${STATE_WORDS[why.value.state] ?? why.value.state}` : "";
  say(`${why.name}${why.value ? ` reads ${why.value.display}${state}` : ""}${why.live ? "" : ` at ${whenText(why.value?.at ?? why.at)}`}`);

  const forced = why.command && (why.command.held === "override" || why.command.held === "emergency") ? why.command : undefined;
  if (forced) say(commandText(forced, why.at));

  if (why.turn) {
    say(`Its value turned ${whenText(why.turn.at)}, ${spanText(why.at - why.turn.at)} ${why.live ? "ago" : "earlier"}: from about ${why.turn.beforeText} to about ${why.turn.afterText}.`);
    const near = (why.changes ?? []).filter((c) => c.near);
    for (const c of near) say(`  └ ${gapText(c.gapMs ?? 0)}: ${c.event.who ? `${whoText(c.event)} ` : ""}${c.event.text}`);
    if (why.changes && near.length === 0) say(`  └ nothing was changed on ${equipment} within ${spanText(NEAR)} of that`);
    for (const s of why.siblings ?? []) say(`  └ ${s.name} turned ${gapText(s.gapMs)}: from about ${s.beforeText} to about ${s.afterText}`);
    if (why.siblings && why.siblings.length === 0) say(`  └ no other point of ${equipment} turned within ${spanText(NEAR)} of that`);
  } else if (why.steady) say(`Its value did not turn ${inWindow}: it held its level.`);

  if (why.command && !forced) say(commandText(why.command, why.at));
  if (why.feeds?.length) {
    say("What reaches it through links:");
    for (const feed of why.feeds) say(`  ${"  ".repeat(feed.depth - 1)}└ ${feed.name}.${feed.sourceSlot}${feed.display !== undefined ? ` ${feed.display}` : ""}${feed.state ? ` (${STATE_WORDS[feed.state] ?? feed.state})` : ""} → ${feed.depth === 1 ? feed.targetSlot : `${lastOf(feed.target)}.${feed.targetSlot}`}${feed.active ? ", the level in control" : ""}`);
  } else if (why.feeds) say("No link feeds it.");

  for (const unit of why.upstream ?? []) {
    const sure = unit.confirmed ? "" : " (a proposal nobody has confirmed)";
    const head = `↑ ${unit.name} feeds ${unit.depth === 1 ? "it" : unit.feedsName} ${MEDIUM_WORDS[unit.medium] ?? unit.medium}${sure}`;
    if (unit.issues.length === 0) say(`${head}: none of its ${unit.points} points is in alarm, in fault or overridden${why.turn ? ", and none turned then" : ""}`);
    else {
      say(`${head}:`);
      for (const issue of unit.issues) {
        const parts = [issue.states.map((flag) => STATE_WORDS[flag] ?? flag).join(", "), issue.turn ? `turned ${gapText(issue.turn.gapMs)}, from about ${issue.turn.beforeText} to about ${issue.turn.afterText}` : ""].filter(Boolean);
        say(`    ↑ ${issue.name}${issue.display !== undefined ? ` ${issue.display}` : ""}: ${parts.join("; ")}`);
      }
    }
  }

  if (why.alarms?.length) {
    say(`Alarms on ${equipment} ${inWindow}:`);
    for (const alarm of why.alarms.slice(0, 6)) say(`  │ ${whenText(alarm.at)} ${alarm.text}`);
    if (why.alarms.length > 6) say(`  │ and ${why.alarms.length - 6} more`);
  }
  const rest = (why.changes ?? []).filter((c) => !c.near && !(forced && c.event.kind === "override" && c.event.at === forced.since));
  if (rest.length) {
    say(`${why.turn ? "Other changes" : "Changes"} on ${equipment} ${inWindow}:`);
    for (const c of rest.slice(0, 6)) say(`  │ ${whenText(c.event.at)} ${c.event.who ? `${whoText(c.event)} ` : ""}${c.event.text}`);
    if (rest.length > 6) say(`  │ and ${rest.length - 6} more`);
  } else if (why.changes && !why.changes.length) say(`Nothing was changed on ${equipment} ${inWindow}.`);

  if (why.notes.length) {
    say("Not known:");
    for (const note of why.notes) say(`  │ ${note}`);
  }
  return lines.join("\n");
}
