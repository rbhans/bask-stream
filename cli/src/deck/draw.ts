// Draws one frame of the screen from a DeckView. Nothing here reads the station or keeps state.
import type { PointSnapshot } from "@basidekick/baskstream";
import { ASCII_S, SIGNAL_MS, WORDMARK_ROWS, WORDMARK_WIDTH, decodeAt, ditherBand, drawAsciiS, drawFigures, drawMark, drawWordmark, figuresWidth, putGlitch } from "./art.js";
import { drawAnswer } from "./answer.js";
import { P, mix } from "./brand.js";
import { tileLabels, type Group, type Site, type SitePoint, type Unit, type WaterFed } from "./site.js";
import { Surface, type Rect, type Style } from "./surface.js";
import { LENSES, unitOf, type DeckEvent, type DeckView, type Hit, type Lens, type UnitMarks } from "./view.js";
import { bounds, brailleLine, resample } from "../tui/chart.js";
import { VERSION } from "../version.js";

/** Something the arrow keys can land on, and where it is. */
export interface Stop {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Frame {
  surface: Surface;
  hits: Hit[];
  stops: Stop[];
  /** Rows of map there are, and rows that fit: for scrolling. */
  mapRows: number;
  mapRoom: number;
  /** Where the time bar is, for the mouse. */
  timeBar?: Rect;
}

const TILE = 7;
const DAY = 86400000;

// ---- Readings ---------------------------------------------------------------------------------------

/** A reading as a tile shows it: short, with a degree sign for a temperature and no other unit. */
export function short(snapshot: PointSnapshot | undefined, point?: SitePoint): string {
  if (!snapshot || snapshot.ok === false) return "--";
  const value = snapshot.value;
  if (typeof value === "number") {
    const unit = String((snapshot.facets as { units?: unknown } | undefined)?.units ?? point?.unit ?? "");
    const precision = Number((snapshot.facets as { precision?: unknown } | undefined)?.precision);
    const text = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(Number.isFinite(precision) ? Math.max(0, Math.min(2, precision)) : 1);
    return /°/.test(unit) ? `${text}°` : /^%$/.test(unit) ? `${Math.round(value)}%` : text;
  }
  if (typeof value === "boolean") return String(snapshot.displayValue ?? (value ? "on" : "off")).toLowerCase().slice(0, TILE);
  return String(snapshot.displayValue ?? value ?? "--").slice(0, TILE);
}

/** A reading with its unit, for a list. */
export function full(snapshot: PointSnapshot | undefined): string {
  if (!snapshot || snapshot.ok === false) return "--";
  return String(snapshot.displayValue ?? snapshot.value ?? "--");
}

const numberOf = (snapshot: PointSnapshot | undefined) => (snapshot && typeof snapshot.value === "number" && Number.isFinite(snapshot.value) ? snapshot.value : undefined);
const stateOf = (snapshot: PointSnapshot | undefined) => String(snapshot?.state ?? (/(alarm|fault|down|stale|overridden|disabled)/i.exec(String(snapshot?.status ?? ""))?.[1] ?? "ok")).toLowerCase();
const isDown = (snapshot: PointSnapshot | undefined) => !!snapshot && (snapshot.ok === false || /fault|down|stale/.test(stateOf(snapshot)));

/** How far a unit's headline is from its setpoint, when it has both. */
export function deviation(view: DeckView, unit: Unit): number | undefined {
  const value = numberOf(unit.headline && view.values.get(unit.headline.ord));
  if (value === undefined) return undefined;
  // Between a heating and a cooling setpoint is where it should be: off only below the one or above the other.
  const low = numberOf(unit.band && view.values.get(unit.band.low.ord));
  const high = numberOf(unit.band && view.values.get(unit.band.high.ord));
  if (low !== undefined && high !== undefined) return value < low ? value - low : value > high ? value - high : 0;
  const target = numberOf(unit.setpoint && view.values.get(unit.setpoint.ord));
  return target === undefined ? undefined : value - target;
}

/** What a unit is held to, as a tile says it: "72°", or "70–74°" between a heating and a cooling setpoint. */
function heldTo(view: DeckView, unit: Unit): string | undefined {
  if (unit.band) {
    const low = view.values.get(unit.band.low.ord);
    const high = view.values.get(unit.band.high.ord);
    if (numberOf(low) !== undefined && numberOf(high) !== undefined) return `${short(low, unit.band.low).replace("°", "").replace(/\.0$/, "")}–${short(high, unit.band.high).replace(/\.0(?=°|$)/, "")}`;
  }
  const target = unit.setpoint ? view.values.get(unit.setpoint.ord) : undefined;
  return target ? short(target, unit.setpoint) : undefined;
}
const offBy = (dev: number) => `${dev >= 0 ? "+" : "−"}${Math.abs(dev).toFixed(1)}`;

/** The mark for a unit that is not running right: not an alarm, something its readings show. */
const OFF_MARK = "≠";
const NO_MARKS: UnitMarks = { open: 0, unacked: 0, active: 0, fault: false, overrides: 0, people: 0, agents: 0, waiting: 0 };

/** A tile's ground, the colour of its value, and a small mark, under the lens in use. */
function tileLook(view: DeckView, unit: Unit): { bg: string; fg: string; label: string; mark?: { text: string; fg: string }; bold?: boolean } {
  const marks = view.marks.get(unit.ord) ?? NO_MARKS;
  const calm = { bg: P.panel2, fg: P.ink2, label: P.ink3 };
  const on = (colour: string, strength: number) => {
    const bg = mix(P.panel2, colour, strength);
    return { bg, fg: P.ink, label: mix(P.ink, bg, 0.35), bold: strength >= 0.5 };
  };
  if (view.lens === "comfort") {
    const dev = deviation(view, unit);
    if (dev === undefined) return calm;
    const size = Math.abs(dev);
    if (size < 1) return { bg: mix(P.panel2, P.ok, 0.16), fg: P.ink, label: P.ink3 };
    return on(dev > 0 ? P.warm : P.cold, Math.min(0.78, 0.2 + 0.58 * Math.min(1, (size - 1) / 4)));
  }
  if (view.lens === "alarms") {
    if (marks.active) return { ...on(P.alarm, 0.7), mark: { text: `▲${marks.active}`, fg: P.ink } };
    if (marks.fault) return { ...on(P.fault, 0.45), mark: { text: "fault", fg: P.ink } };
    // Back to normal and only waiting to be acknowledged: marked, and quieter.
    if (marks.unacked) return { ...on(P.alarm, 0.22), mark: { text: `△${marks.unacked}`, fg: P.ink2 } };
    return calm;
  }
  if (view.lens === "overrides") return marks.overrides ? { ...on(P.hand, 0.55), mark: { text: `${marks.overrides} hand`, fg: P.ink } } : calm;
  if (view.lens === "changes") {
    const count = marks.people + marks.agents;
    if (!count) return calm;
    const age = marks.last ? (view.span.to - marks.last) / (view.span.to - view.span.from) : 1;
    return { ...on(P.accent, 0.12 + 0.3 * (1 - Math.min(1, age))), mark: { text: `${count} chg`, fg: P.ink } };
  }
  return marks.waiting ? { ...on(P.cyan, 0.5), mark: { text: `${marks.waiting} wait`, fg: P.ink } } : marks.agents ? { ...on(P.cyan, 0.2), mark: { text: `${marks.agents} chg`, fg: P.ink2 } } : calm;
}

// ---- Small pieces -----------------------------------------------------------------------------------

/** Text in pieces, one after another. Returns the cells used. */
function run(s: Surface, x: number, y: number, parts: [string, Style?][], maxWidth = Infinity): number {
  let used = 0;
  for (const [text, style] of parts) {
    if (used >= maxWidth) break;
    used += s.put(x + used, y, text, style ?? {}, maxWidth - used);
  }
  return used;
}
const lengthOf = (parts: [string, Style?][]) => parts.reduce((n, [text]) => n + [...text].length, 0);

/** A key as a little cap, then what it does. */
function keycap(s: Surface, x: number, y: number, key: string, label: string): number {
  let used = s.put(x, y, ` ${key} `, { fg: P.ink2, bg: P.name === "light" ? P.well : P.panel2 });
  used += s.put(x + used, y, ` ${label}`, { fg: P.ink3 });
  return used + 2;
}

const clock = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const dayLabel = (ms: number) => `${DAYS[new Date(ms).getDay()]} ${new Date(ms).getDate()}`;
export function agoText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** A value on screen, mid-decode while fresh readings are arriving. */
function reading(view: DeckView, text: string, index: number): string {
  if (view.fx.reduced || view.fx.decodeFrom === undefined) return text;
  const t = (view.now - view.fx.decodeFrom) / 1100;
  return t >= 1 ? text : decodeAt(text, t, Math.min(0.4, index * 0.015));
}

// ---- The frame --------------------------------------------------------------------------------------

export function drawDeck(view: DeckView): Frame {
  const s = new Surface(view.width, view.height, P.ink, P.chassis);
  const hits: Hit[] = [];
  const stops: Stop[] = [];
  const frame: Frame = { surface: s, hits, stops, mapRows: 0, mapRoom: 0 };
  if (!view.site) {
    drawSplash(s, view);
    return frame;
  }
  const roomy = view.height >= 30;
  const pad = view.width >= 100 ? 2 : 1;
  drawHeader(s, view, pad, hits);
  // From the bottom up: hints, the prompt, the time bar, the line of what is going on.
  const hintsY = view.height - 1;
  const promptY = hintsY - 1;
  const timeY = promptY - (roomy ? 4 : 3);
  const summaryY = timeY - (roomy ? 2 : 1);
  const top = roomy ? 2 : 1;
  const body: Rect = { x: pad, y: top, width: view.width - pad * 2, height: summaryY - top - (roomy ? 1 : 0) };
  frame.mapRoom = body.height;
  if (view.answer) drawAnswer(s, view, view.answer, body, hits);
  else if (view.zoom.level === "site") frame.mapRows = drawSite(s, view, body, hits, stops);
  else drawUnit(s, view, body, hits, stops);
  drawSummary(s, view, pad, summaryY);
  frame.timeBar = drawTimeBar(s, view, pad, timeY, hits);
  drawPrompt(s, view, pad, promptY, hits);
  drawHints(s, view, pad, hintsY);
  if (view.result) drawResult(s, view, body);
  if (view.ghost) drawGhost(s, view, body, hits);
  if (view.toast) {
    const tone = { info: P.cyan, good: P.ok, warn: P.fault, bad: P.alarm }[view.toast.tone];
    const text = ` ${view.toast.text.slice(0, view.width - pad * 2 - 4)} `;
    s.put(view.width - pad - [...text].length - 1, summaryY, "▌", { fg: tone, bg: P.panel2 });
    s.put(view.width - pad - [...text].length, summaryY, text, { fg: P.ink, bg: P.panel2 });
  }
  return frame;
}

// ---- Before the station has answered -------------------------------------------------------------------

function drawSplash(s: Surface, view: DeckView): void {
  const { width, height } = view;
  const age = view.now - view.fx.born;
  const big = width >= WORDMARK_WIDTH + 8 && height >= 20;
  const midY = Math.max(1, Math.floor(height / 2) - (big ? 6 : 2));
  if (big) {
    const x = Math.floor((width - WORDMARK_WIDTH) / 2);
    // The S tears once as the screen comes up, and settles.
    drawWordmark(s, x, midY, { tear: view.fx.reduced || age > 700 ? undefined : age });
    const line = view.problem ?? view.loading ?? "";
    s.putCentre(0, midY + WORDMARK_ROWS + 2, width, "B A S K", { fg: P.accentMark, bold: true });
    s.putCentre(0, midY + WORDMARK_ROWS + 4, width, line, { fg: view.problem ? P.alarm : P.ink3 });
  } else {
    const x = Math.max(0, Math.floor((width - 17) / 2));
    drawMark(s, x, midY, { glitch: !view.fx.reduced && age < 160 });
    s.putCentre(0, midY + 2, width, view.problem ?? view.loading ?? "", { fg: view.problem ? P.alarm : P.ink3 });
  }
  // The signal runs along the S while the station is being read.
  if (height >= 30 && width >= 40 && !view.problem) {
    const signal = view.fx.reduced ? undefined : (view.now - view.fx.born) % (SIGNAL_MS + 500);
    drawAsciiS(s, Math.floor((width - ASCII_S[0].length) / 2), midY + WORDMARK_ROWS + 7, { signal });
  }
  // The brand's ground: dither rising into a hi-vis band.
  const band = Math.min(5, Math.max(0, height - 26));
  if (band) ditherBand(s, 0, height - 1 - band, width, band, P.accent);
  s.fill({ x: 0, y: height - 1, width, height: 1 }, P.accent, P.accentInk);
  s.put(2, height - 1, "BASIDEKICK.COM", { fg: P.accentInk, bg: P.accent, bold: true });
  s.putRight(width - 2, height - 1, `bask ${VERSION}`, { fg: P.accentInk, bg: P.accent });
}

// ---- Header -----------------------------------------------------------------------------------------

function drawHeader(s: Surface, view: DeckView, pad: number, hits: Hit[]): void {
  const y = 0;
  let x = pad;
  // The mark flickers its ghosts for a moment when the link to the station drops.
  x += drawMark(s, x, y, { short: true, glitch: view.net.state !== "live" && !view.fx.reduced && view.now % 4200 > 3780 }) + 1;
  x += s.put(x, y, "bask", { fg: P.ink, bold: true }) + 2;
  const crumbs: { text: string; id: string }[] = [{ text: view.station.toUpperCase(), id: "crumb:0" }];
  const unit = view.zoom.level !== "site" ? unitOf(view.site, view.zoom.unit) : undefined;
  if (unit) crumbs.push({ text: unit.name, id: "crumb:1" });
  if (view.zoom.level === "point") crumbs.push({ text: unit?.points.find((p) => p.ord === (view.zoom as { point: string }).point)?.name ?? "point", id: "crumb:2" });
  crumbs.forEach((crumb, i) => {
    if (i) x += s.put(x, y, " ▸ ", { fg: P.ink3 });
    const last = i === crumbs.length - 1;
    hits.push({ x, y, width: crumb.text.length, height: 1, id: crumb.id });
    x += s.put(x, y, crumb.text, { fg: last ? P.ink : P.ink3, bold: i === 0 });
  });
  if (view.zoom.level === "site") x += s.put(x, y, ` ▸ whole site${view.site ? ` · by ${view.site.arrange === "feeds" ? "what feeds what" : view.site.arrange === "place" ? "building and floor" : "type"}` : ""}`, { fg: P.ink3 });

  // Right side, from the edge inward: the clock, changes on or off, live or the moment looked at.
  let right = view.width - pad;
  if (view.width >= 110) right -= s.putRight(right, y, clock(Date.now()), { fg: P.ink3 }) + 2;
  right -= view.writes ? s.putRight(right, y, "✎ CHANGES ON", { fg: P.fault, bold: true }) + 2 : view.width >= 96 ? s.putRight(right, y, "READ-ONLY", { fg: P.ink3 }) + 2 : 0;
  if (view.at !== undefined) {
    const text = ` ◷ ${dayLabel(view.at)} · ${clock(view.at)} `;
    right -= s.putRight(right, y, text, { fg: P.accentInk, bg: P.accent, bold: true }) + 2;
  } else if (view.net.state === "live") {
    const latency = view.net.latency !== undefined && view.width >= 100 ? ` ${view.net.latency} ms` : "";
    right -= s.putRight(right, y, latency, { fg: P.ink3 });
    right -= s.putRight(right, y, "● LIVE", { fg: P.ok, bold: true }) + 2;
  } else {
    right -= s.putRight(right, y, view.net.state === "reconnecting" ? "◌ RECONNECTING" : "✕ OFFLINE", { fg: view.net.state === "down" ? P.alarm : P.fault, bold: true }) + 2;
  }
  // The lenses. All of them when there is room, else the one in use.
  const all = LENSES.reduce((n, lens) => n + lens.length + 3, 0);
  const room = right - x - 3;
  const shown: Lens[] = room >= all + 5 ? LENSES : [view.lens];
  let at = right - shown.reduce((n, lens) => n + lens.length + 3, 0);
  if (shown.length > 1 || room >= view.lens.length + 9) s.putRight(at - 1, y, "LENS", { fg: P.ink3 });
  for (const lens of shown) {
    const on = lens === view.lens;
    hits.push({ x: at, y, width: lens.length + 2, height: 1, id: `lens:${lens}` });
    s.put(at, y, ` ${lens} `, on ? { fg: P.accentInk, bg: P.accent, bold: true } : { fg: P.ink3 });
    at += lens.length + 3;
  }
}

// ---- The site ---------------------------------------------------------------------------------------

/** What an air handler's title line says about itself: whether it runs, and its headline readings. */
function feederFacts(view: DeckView, unit: Unit): { state: [string, Style?][]; facts: [string, Style?][] } {
  const of = (role: string) => unit.points.find((p) => p.role === role);
  const snap = (point: SitePoint | undefined) => (point ? view.values.get(point.ord) : undefined);
  const status = snap(of("supplyFanStatus") ?? of("fanStatus") ?? of("runStatus") ?? of("enableStatus"));
  const speedPoint = of("supplyFanSpeed") ?? of("fanSpeed") ?? of("pumpSpeed");
  const speed = snap(speedPoint);
  const running = status ? status.value === true || /^(on|running|enabled|true)$/i.test(String(status.displayValue ?? "")) : numberOf(speed) !== undefined ? numberOf(speed)! > 1 : undefined;
  const state: [string, Style?][] = [];
  if (running === true) state.push(["▶ ", { fg: P.ok }], [speed ? short(speed, speedPoint) : "on", { fg: P.ok, bold: true }]);
  else if (running === false) state.push(["○ off", { fg: P.ink3 }]);
  const facts: [string, Style?][] = [];
  const add = (label: string, point: SitePoint | undefined) => {
    if (!point) return;
    const reading = snap(point);
    const bad = isDown(reading);
    facts.push([`${label} `, { fg: P.ink3 }], [`${short(reading, point)}${point.unit && !/°|%/.test(point.unit) ? ` ${point.unit}` : ""}  `, { fg: bad ? P.fault : P.ink2 }]);
  };
  if (unit.headline) add(/SupplyTemp$/i.test(unit.headline.role) ? "SUPPLY" : unit.headline.label.split(" ")[0].toUpperCase(), unit.headline);
  add("DUCT", of("supplyAirPressure"));
  return { state, facts };
}

/** A tile's size: small for a big site, growing into a card with figures and a chart when there is room. */
interface TileSize {
  name: "small" | "medium" | "large";
  width: number;
  height: number;
  gapX: number;
  gapY: number;
}
const SIZES: TileSize[] = [
  { name: "large", width: 20, height: 6, gapX: 2, gapY: 1 },
  { name: "medium", width: 12, height: 4, gapX: 1, gapY: 1 },
  { name: "small", width: TILE, height: 2, gapX: 1, gapY: 1 },
  { name: "small", width: TILE, height: 2, gapX: 1, gapY: 0 }
];

interface SitePlan {
  size: TileSize;
  columns: number;
  groupWidth: number;
  perRow: number;
  padTop: number;
  heightOf: (group: Group) => number;
  widthOf: (group: Group) => number;
  height: number;
}

/** The map's groups under a heading for each side of the building's systems, when the sides are known. */
function sectionsOf(site: Site): { title?: string; groups: Group[] }[] {
  const sides: [Group["side"], string][] = [["water", "WATER SIDE"], ["air", "AIR SIDE"], [undefined, "EVERYTHING ELSE"]];
  const made = sides.map(([side, title]) => ({ title, groups: site.groups.filter((g) => g.side === side) })).filter((section) => section.groups.length);
  return site.arrange === "feeds" && made.length > 1 ? made : [{ groups: site.groups }];
}

const KIND_WORDS: Record<string, [string, string]> = { ahu: ["air handler", "air handlers"], vav: ["VAV box", "VAV boxes"], fcu: ["fan coil", "fan coils"], crac: ["CRAC", "CRACs"] };
const waterHead = (fed: WaterFed) => `${fed.medium === "chilledWater" ? "CHILLED WATER" : "HOT WATER"} TO ${fed.units.length}${fed.guessed ? "  guessed" : ""}`;
/** The most lines of names under a plant before they give way to how many of each kind. */
const WATER_LINES = 3;

/** How what a plant sends water to is laid out in `room` columns: each unit by name over a few lines, else one line of counts. */
function waterPlan(fed: WaterFed, room: number): { rows: Unit[][]; indent: number } | undefined {
  const indent = waterHead(fed).length + 3;
  if (room - indent < 16) return undefined;
  const rows: Unit[][] = [[]];
  let used = 0;
  for (const unit of fed.units) {
    // A name, its valve ("100%") and the gap to the next.
    const width = unit.name.length + 8;
    if (used + width - 3 > room - indent && rows[rows.length - 1].length) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push(unit);
    used += width;
  }
  return rows.length <= WATER_LINES ? { rows, indent } : undefined;
}

/** The lines under a plant's name that say what it sends water to. */
const waterRows = (group: Group, room: number) => (group.by === "part" ? Math.max(1, (group.water ?? []).reduce((n, fed) => n + (waterPlan(fed, room)?.rows.length ?? 1), 0)) : 0);

/** How far open a unit's valve for this water is, when it has one that reads as a number. */
function valveOf(view: DeckView, unit: Unit, medium: WaterFed["medium"]): number | undefined {
  const roles = medium === "chilledWater" ? ["coolingValve"] : ["heatingValve", "reheatValve"];
  const point = unit.points.find((p) => roles.includes(p.role));
  return point ? numberOf(view.values.get(point.ord)) : undefined;
}

/** What a plant sends water to: each unit with its valve when they fit, else how many of each kind and how many are calling. Returns the lines used. */
function drawWater(s: Surface, view: DeckView, fed: WaterFed, x: number, y: number, room: number, visible: (row: number) => boolean): number {
  const colour = fed.medium === "chilledWater" ? P.cyan : P.warm;
  const head: [string, Style?][] = [[waterHead(fed).replace(/  guessed$/, ""), { fg: colour, bold: true }], [fed.guessed ? "  guessed" : "", { fg: P.ink3, italic: true }]];
  if (visible(y)) run(s, x, y, head, room);
  const plan = waterPlan(fed, room);
  // With no valve to show on any of them, the names sit closer.
  const pad = fed.units.some((unit) => valveOf(view, unit, fed.medium) !== undefined) ? 8 : 3;
  if (plan) {
    plan.rows.forEach((row, i) => {
      if (!visible(y + i)) return;
      run(s, x + plan.indent, y + i, row.flatMap((unit): [string, Style?][] => {
        const valve = valveOf(view, unit, fed.medium);
        const open = valve !== undefined && valve > 5;
        return [[unit.name, { fg: P.ink2 }], [(valve === undefined ? "" : ` ${Math.round(valve)}%`).padEnd(pad), { fg: open ? P.ink : P.ink3, bold: open }]];
      }), room - plan.indent);
    });
    return plan.rows.length;
  }
  const kinds = new Map<string, number>();
  for (const unit of fed.units) kinds.set(unit.kind, (kinds.get(unit.kind) ?? 0) + 1);
  const counts = [...kinds].map(([kind, n]) => {
    const label = fed.units.find((u) => u.kind === kind)!.label;
    return `${n} ${(KIND_WORDS[kind] ?? [label, `${label}s`])[n === 1 ? 0 : 1]}`;
  }).join(" · ");
  const valves = fed.units.map((unit) => valveOf(view, unit, fed.medium)).filter((v): v is number => v !== undefined);
  const calling = valves.filter((v) => v > 5).length;
  if (visible(y)) run(s, x + lengthOf(head) + 3, y, [[counts, { fg: P.ink2 }], ...(valves.length ? [["   "], [`${calling} calling`, { fg: calling ? P.ink : P.ink3, bold: calling > 0 }]] as [string, Style?][] : [])], room - lengthOf(head) - 3);
  return 1;
}

function planSite(site: Site, width: number, size: TileSize, plantRows: number): SitePlan {
  const gap = 2;
  const least = Math.min(width, Math.max(34, 3 * (size.width + size.gapX) - size.gapX + 4));
  const columns = Math.max(1, Math.min(site.groups.length, Math.floor((width + gap) / (least + gap)), width >= 170 ? 3 : 2));
  const groupWidth = Math.floor((width - gap * (columns - 1)) / columns);
  const fits = Math.max(1, Math.floor((groupWidth - 4 + size.gapX) / (size.width + size.gapX)));
  // No wider a row than the fullest group needs, and tiles widen to fill what is left.
  const perRow = Math.max(1, Math.min(fits, Math.max(...site.groups.map((g) => g.members.length), 1)));
  if (size.name !== "small") size = { ...size, width: Math.min(Math.round(size.width * 1.3), Math.floor((groupWidth - 4 + size.gapX) / perRow) - size.gapX) };
  const padTop = size.name === "small" ? 0 : 1;
  // A plant alone at the end of its row takes the empty room beside it, so what it sends water to can be named.
  const widths = new Map<Group, number>();
  for (const section of sectionsOf(site)) {
    for (let first = 0; first < section.groups.length; first += columns) {
      const row = section.groups.slice(first, first + columns);
      const last = row[row.length - 1];
      if (row.length < columns && last.by === "part") widths.set(last, (columns - row.length + 1) * (groupWidth + gap) - gap);
    }
  }
  const widthOf = (group: Group) => widths.get(group) ?? groupWidth;
  const heightOf = (group: Group) => {
    const rows = Math.ceil(group.members.length / perRow);
    const water = waterRows(group, widthOf(group) - 4);
    return padTop + 1 + water + (rows ? 1 + rows * size.height + (rows - 1) * size.gapY : water ? 0 : 1) + 1;
  };
  let height = plantRows;
  for (const section of sectionsOf(site)) {
    if (section.title) height += 1;
    for (let first = 0; first < section.groups.length; first += columns) height += Math.max(...section.groups.slice(first, first + columns).map(heightOf)) + 1;
  }
  return { size, columns, groupWidth, perRow, padTop, heightOf, widthOf, height: height - 1 };
}

function drawSite(s: Surface, view: DeckView, area: Rect, hits: Hit[], stops: Stop[]): number {
  const site = view.site!;
  // On a wide screen, what needs a person sits in a rail beside the map.
  const railWidth = area.width >= 128 ? Math.min(44, Math.floor(area.width * 0.3)) : 0;
  const body: Rect = { ...area, width: area.width - (railWidth ? railWidth + 2 : 0) };
  if (railWidth) drawRail(s, view, { x: area.x + area.width - railWidth, y: area.y, width: railWidth, height: area.height }, hits, stops);
  let y = body.y - view.scroll;
  const visible = (row: number, rows = 1) => row >= body.y && row + rows <= body.y + body.height;
  let index = 0;

  const plantTop = y;

  // Groups, side by side as many as fit. Tiles are as big as the room allows.
  const plan = SIZES.map((size) => planSite(site, body.width, size, y - plantTop)).find((p, i) => p.height <= body.height || i === SIZES.length - 1)!;
  const gap = 2;
  for (const section of sectionsOf(site)) {
    if (section.title) {
      if (visible(y)) {
        const used = s.put(body.x, y, section.title, { fg: P.ink2, bold: true });
        for (let i = used + 1; i < body.width; i += 1) s.put(body.x + i, y, "─", { fg: P.line2 });
      }
      y += 1;
    }
    for (let first = 0; first < section.groups.length; first += plan.columns) {
      const row = section.groups.slice(first, first + plan.columns);
      const tall = Math.max(...row.map(plan.heightOf));
      row.forEach((group, column) => {
        const x = body.x + column * (plan.groupWidth + gap);
        const rect = { x, y, width: plan.widthOf(group), height: tall };
        // The group's ground, only the part of it that is in view.
        const from = Math.max(rect.y, body.y);
        const to = Math.min(rect.y + rect.height, body.y + body.height);
        if (to > from) s.fill({ x, y: from, width: rect.width, height: to - from }, P.panel);
        index = drawGroup(s, view, group, rect, plan, visible, hits, stops, index);
      });
      y += tall + 1;
    }
  }
  const total = y - (body.y - view.scroll) - 1;
  // More above or below than fits: say so at the edge.
  if (view.scroll > 0) s.putCentre(body.x, body.y, body.width, " ▲ more above ", { fg: P.ink3, bg: P.chassis });
  if (total - view.scroll > body.height) s.putCentre(body.x, body.y + body.height - 1, body.width, " ▼ more below ", { fg: P.ink3, bg: P.chassis });
  return total;
}

const reading2 = reading;

function drawGroup(s: Surface, view: DeckView, group: Group, rect: Rect, plan: SitePlan, visible: (row: number, rows?: number) => boolean, hits: Hit[], stops: Stop[], start: number): number {
  let index = start;
  const size = plan.size;
  const x = rect.x + 2;
  const inner = rect.width - 4;
  const titleY = rect.y + plan.padTop;
  // The title: the unit that feeds the group, or the network it is wired to.
  if (group.feeder) {
    const unit = group.feeder;
    const focused = view.focus === unit.ord && view.keys === "map";
    const marks = view.marks.get(unit.ord) ?? NO_MARKS;
    const { state, facts } = feederFacts(view, unit);
    if (visible(titleY)) {
      let used = s.put(x, titleY, focused ? ` ${unit.name} ` : unit.name, focused ? { fg: P.accentInk, bg: P.accent, bold: true } : { fg: P.ink, bold: true });
      used += 1 + run(s, x + used + 1, titleY, state);
      if (marks.active || marks.fault) used += s.put(x + used + 1, titleY, `▲${marks.active || ""}`, { fg: marks.active ? P.alarm : P.fault, bold: true }) + 1;
      else if (marks.unacked) used += s.put(x + used + 1, titleY, `△${marks.unacked}`, { fg: P.ink3 }) + 1;
      if (marks.overrides) used += s.put(x + used + 1, titleY, `${marks.overrides} in hand`, { fg: P.hand }) + 1;
      if (view.off?.get(unit.ord)?.length) used += s.put(x + used + 1, titleY, OFF_MARK, { fg: P.warm, bold: true }) + 1;
      if (group.guessed) used += s.put(x + used + 1, titleY, "guessed", { fg: P.ink3, italic: true }) + 1;
      const room = inner - used - 2;
      const shown = lengthOf(facts) <= room ? facts : lengthOf(facts.slice(0, 2)) <= room ? facts.slice(0, 2) : [];
      run(s, x + inner - lengthOf(shown) + 2, titleY, shown);
      hits.push({ x: rect.x, y: titleY, width: rect.width, height: 1, id: `unit:${unit.ord}` });
    }
    stops.push({ id: unit.ord, x, y: titleY, width: unit.name.length, height: 1 });
  } else if (visible(titleY)) {
    const how = group.by === "place" ? "BY PLACE" : group.by === "kind" ? "BY TYPE" : "BY FOLDER";
    const count = ` · ${group.members.length}`;
    const used = s.put(x, titleY, group.title, { fg: P.ink, bold: true }, Math.max(4, inner - count.length));
    s.put(x + used, titleY, count, { fg: P.ink3 });
    if (used + count.length + how.length + 2 <= inner) s.putRight(x + inner, titleY, how, { fg: P.ink3 });
  }
  // Under a plant's name: what it sends water to. Those units keep their own tiles where their air comes from.
  const extra = waterRows(group, inner);
  if (extra) {
    if (!group.water?.length) {
      if (visible(titleY + 1)) s.put(x, titleY + 1, "what it sends water to is not known", { fg: P.ink3 });
    } else {
      let at = titleY + 1;
      for (const fed of group.water) at += drawWater(s, view, fed, x, at, inner, visible);
    }
  }
  if (group.members.length === 0) {
    if (visible(titleY + 1) && group.by === "serves") s.put(x, titleY + 1, "what it feeds is not known", { fg: P.ink3 });
    return index;
  }
  // A plant's own equipment is of several kinds, so each keeps its whole name.
  const labels = group.by === "part" ? new Map<string, string>() : tileLabels(group.members);
  group.members.forEach((unit, i) => {
    const tx = x + (i % plan.perRow) * (size.width + size.gapX);
    const ty = titleY + 2 + extra + Math.floor(i / plan.perRow) * (size.height + size.gapY);
    stops.push({ id: unit.ord, x: tx, y: ty, width: size.width, height: size.height });
    if (!visible(ty, size.height)) return;
    drawTile(s, view, unit, labels.get(unit.ord) ?? unit.name, { x: tx, y: ty, width: size.width, height: size.height }, size, index);
    index += 1;
    hits.push({ x: tx, y: ty, width: size.width, height: size.height, id: `unit:${unit.ord}` });
  });
  return index;
}

/** One unit as a tile: its name and reading, and when there is room its setpoint, how far off it is, and a small chart. */
function drawTile(s: Surface, view: DeckView, unit: Unit, label: string, rect: Rect, size: TileSize, index: number): void {
  const look = tileLook(view, unit);
  const marks = view.marks.get(unit.ord) ?? NO_MARKS;
  const snapshot = unit.headline ? view.values.get(unit.headline.ord) : undefined;
  const down = isDown(snapshot);
  const focused = view.focus === unit.ord && view.keys === "map";
  const bg = down ? mix(P.panel2, P.fault, 0.3) : look.bg;
  const quiet = down ? mix(P.ink, bg, 0.35) : look.label;
  const { x, y, width } = rect;
  s.fill(rect, bg);
  const small = size.name === "small";
  // The name: along the top, on the hi-vis fill when the cursor is here.
  if (focused) s.fill({ x, y, width, height: 1 }, P.accent);
  const nameStyle: Style = focused ? { fg: P.accentInk, bg: P.accent, bold: true } : { fg: quiet };
  if (small) s.putCentre(x, y, width, label, nameStyle);
  else {
    s.put(x + 1, y, label, nameStyle, width - 6);
    // What is wrong with it, as small marks at the right of the name.
    let right = x + width - 1;
    if (marks.waiting) right -= s.putRight(right, y, "◇", { fg: focused ? P.accentInk : P.cyan }) + 1;
    if (marks.overrides) right -= s.putRight(right, y, "━", { fg: focused ? P.accentInk : P.hand }) + 1;
    if (view.off?.get(unit.ord)?.length) right -= s.putRight(right, y, OFF_MARK, { fg: focused ? P.accentInk : P.warm, bold: true }) + 1;
    if (marks.active) right -= s.putRight(right, y, "▲", { fg: focused ? P.accentInk : P.alarm }) + 1;
    else if (marks.unacked) right -= s.putRight(right, y, "△", { fg: focused ? P.accentInk : mix(P.ink3, bg, 0.2) }) + 1;
  }
  const lensMark = look.mark && view.lens !== "comfort" ? look.mark : undefined;
  const value = down ? (snapshot?.ok === false ? "no data" : stateOf(snapshot)) : reading(view, short(snapshot, unit.headline), index);
  if (small) {
    if (down) {
      // A reading that disagrees with reality: the brand's glitch, kept for faults.
      putGlitch(s, x + Math.floor((width - value.length) / 2), y + 1, value, { fg: P.ink, bold: true }, view.fx.reduced ? undefined : view.now);
      s.tint({ x, y: y + 1, width, height: 1 }, bg);
    } else s.putCentre(x, y + 1, width, lensMark?.text ?? value, { fg: lensMark?.fg ?? look.fg, bold: look.bold ?? true });
    return;
  }
  const dev = deviation(view, unit);
  const target = heldTo(view, unit);
  const series = unit.headline ? view.series.get(unit.headline.ord) : undefined;
  if (size.name === "large") {
    // The reading in big figures, like an instrument.
    const wide = figuresWidth(value);
    if (!down && wide !== undefined && wide <= width - 2) drawFigures(s, x + 1, y + 1, value, look.fg);
    else if (down) {
      putGlitch(s, x + 1, y + 2, value.toUpperCase(), { fg: P.ink, bold: true }, view.fx.reduced ? undefined : view.now);
      s.tint({ x, y: y + 2, width, height: 1 }, bg);
    } else s.put(x + 1, y + 2, value, { fg: look.fg, bold: true }, width - 2);
    if (lensMark) s.putRight(x + width - 1, y + 2, lensMark.text, { fg: lensMark.fg, bold: true });
    const line = y + 4;
    if (target && !down) {
      const used = run(s, x + 1, line, [["set ", { fg: quiet }], [target, { fg: look.fg }]]);
      if (dev) s.put(x + 2 + used, line, offBy(dev), { fg: Math.abs(dev) < 1 ? quiet : look.fg, bold: Math.abs(dev) >= 2 });
    } else if (down) s.put(x + 1, line, "not answering", { fg: quiet });
    if (series && series.length > 1) s.put(x + 1, y + 5, spark(series, width - 2), { fg: mix(look.fg, bg, 0.45) });
    return;
  }
  // Medium: the reading in bold, how far off it is, a small chart.
  if (down) {
    putGlitch(s, x + 1, y + 1, value, { fg: P.ink, bold: true }, view.fx.reduced ? undefined : view.now);
    s.tint({ x, y: y + 1, width, height: 1 }, bg);
  } else s.put(x + 1, y + 1, lensMark?.text ?? value, { fg: lensMark?.fg ?? look.fg, bold: true }, width - 2);
  if (dev !== undefined && target && !down) s.put(x + 1, y + 2, dev || !unit.band ? `${offBy(dev)} of ${target}` : `in ${target}`, { fg: Math.abs(dev) < 1 ? quiet : look.fg }, width - 2);
  else if (down) s.put(x + 1, y + 2, "no answer", { fg: quiet });
  if (series && series.length > 1) s.put(x + 1, y + 3, spark(series, width - 2), { fg: mix(look.fg, bg, 0.45) });
}

/** Beside the map on a wide screen: what waits for a person, what is in alarm, what is in hand, what just happened. */
function drawRail(s: Surface, view: DeckView, rect: Rect, hits: Hit[], stops: Stop[]): void {
  const site = view.site!;
  s.fill(rect, P.panel);
  // Each line is something the cursor can land on; enter shows what can be done to it.
  const land = (id: string, y: number, rows = 1) => {
    stops.push({ id, x: rect.x, y, width: rect.width, height: rows });
    hits.push({ x: rect.x, y, width: rect.width, height: rows, id });
    const on = view.focus === id && view.keys === "map";
    if (on) {
      s.fill({ x: rect.x, y, width: rect.width, height: rows }, P.panel2);
      for (let i = 0; i < rows; i += 1) s.put(rect.x, y + i, "▌", { fg: P.accentMark, bg: P.panel2 });
    }
    return on ? P.panel2 : P.panel;
  };
  const x = rect.x + 2;
  const inner = rect.width - 4;
  let y = rect.y + 1;
  const end = rect.y + rect.height - 1;
  const nameFor = (ord: string | undefined) => {
    if (!ord) return "";
    const unit = site.units.find((u) => ord === u.ord || ord.startsWith(`${u.ord}/`));
    return unit ? unit.name : ord.split("/").pop() ?? "";
  };
  const section = (title: string, count: number, colour: string) => {
    if (y >= end) return false;
    s.put(x, y, title, { fg: P.ink3 });
    if (count) s.putRight(x + inner, y, String(count), { fg: colour, bold: true });
    y += 1;
    return true;
  };
  const waiting = view.events.filter((e) => e.kind === "proposal" && e.id);
  if (waiting.length && section("WAITS FOR YOU", waiting.length, P.cyan)) {
    for (const e of waiting.slice(0, 3)) {
      if (y + 1 >= end) break;
      const bg = land(`do:proposal ${e.id}`, y, 2);
      s.put(x, y, "◇", { fg: P.cyan, bg });
      s.put(x + 2, y, `${e.id}  ${nameFor(e.ord)}`, { fg: P.ink, bold: true, bg }, inner - 2);
      s.putClipped(x + 2, y + 1, e.text, { fg: P.ink2, bg }, inner - 2);
      y += 2;
    }
    y += 1;
  }
  // Alarms: the ones still in alarm first, then the ones back to normal that nobody has acknowledged.
  // The same alarm on the same thing many times over is one row with a count.
  const onUnit = (e: DeckEvent) => site.units.find((u) => e.ord === u.ord || e.ord?.startsWith(`${u.ord}/`));
  const alarmRows = (list: DeckEvent[]) => {
    const rows = new Map<string, { e: DeckEvent; count: number }>();
    for (const e of [...list].sort((a, b) => b.at - a.at)) {
      const key = `${e.ord}|${e.text}`;
      const row = rows.get(key);
      if (row) row.count += 1;
      else rows.set(key, { e, count: 1 });
    }
    // What is on a unit comes before the network's own comings and goings.
    return [...rows.values()].sort((a, b) => Number(!!onUnit(b.e)) - Number(!!onUnit(a.e)));
  };
  const alarmSection = (title: string, list: DeckEvent[], colour: string, mark: string, most: number) => {
    if (!list.length || !section(title, list.length, colour)) return;
    for (const { e, count } of alarmRows(list).slice(0, Math.max(1, Math.min(most, Math.floor((end - y) / 2) - 2)))) {
      if (y >= end) break;
      const when = agoText(view.span.to - e.at);
      const unit = onUnit(e);
      const point = unit?.points.find((p) => e.ord === p.ord || e.ord?.startsWith(`${p.ord}/`));
      const bg = e.id ? land(`do:alarm ${e.id}`, y) : P.panel;
      s.put(x, y, mark, { fg: colour, bg });
      const used = s.put(x + 2, y, nameFor(e.ord), { fg: P.ink, bold: true, bg }, inner - 2 - when.length - 1);
      s.putClipped(x + 3 + used, y, `${point ? point.name : e.text}${count > 1 ? ` ×${count}` : ""}`, { fg: P.ink3, bg }, inner - 4 - used - when.length);
      s.putRight(x + inner, y, when, { fg: P.ink3, bg });
      y += 1;
    }
    y += 1;
  };
  const alarms = view.events.filter((e) => e.kind === "alarm");
  alarmSection("IN ALARM", alarms.filter((e) => e.active), P.alarm, "▲", 5);
  alarmSection("TO ACKNOWLEDGE", alarms.filter((e) => !e.active && !e.acked), P.ink2, "△", 4);
  const hand = view.events.filter((e) => e.kind === "override" && e.until === undefined);
  if (hand.length && section("IN HAND", hand.length, P.hand)) {
    for (const e of hand.slice(0, 3)) {
      if (y >= end) break;
      const when = agoText(view.span.to - e.at);
      const bg = e.ord ? land(`do:point ${e.ord}`, y) : P.panel;
      s.put(x, y, "━", { fg: P.hand, bg });
      const used = s.put(x + 2, y, nameFor(e.ord), { fg: P.ink, bold: true, bg }, inner - 2 - when.length - 1);
      s.put(x + 3 + used, y, `by ${e.who ?? "someone"}`, { fg: P.ink3, bg }, inner - 4 - used - when.length);
      s.putRight(x + inner, y, when, { fg: P.ink3, bg });
      y += 1;
    }
    y += 1;
  }
  // Not an alarm: what the readings and their histories show. The same look `check --only behaviour` takes.
  const wrong = [...(view.off ?? [])].flatMap(([ord, list]) => list.map((f) => ({ ord, ...f })));
  if (wrong.length && y + 1 < end && section("NOT RUNNING RIGHT", wrong.length, P.warm)) {
    for (const f of wrong.slice(0, 4)) {
      if (y >= end) break;
      s.put(x, y, OFF_MARK, { fg: P.warm, bold: true });
      const used = s.put(x + 2, y, nameFor(f.ord), { fg: P.ink, bold: true }, inner - 2);
      s.putClipped(x + 3 + used, y, OFF_WORDS[f.kind] ?? f.message, { fg: P.ink3 }, inner - 3 - used);
      hits.push({ x: rect.x, y, width: rect.width, height: 1, id: `unit:${f.ord}` });
      y += 1;
    }
    y += 1;
  }
  const recent = view.events.filter((e) => e.kind === "change" || e.kind === "agent").sort((a, b) => b.at - a.at);
  if (recent.length && y + 1 < end && section("LATELY", 0, P.ink3)) {
    for (const e of recent) {
      if (y >= end) break;
      const when = agoText(view.span.to - e.at);
      s.put(x, y, e.agent ? "◆" : "●", { fg: e.agent ? P.cyan : P.ink });
      s.putClipped(x + 2, y, e.text, { fg: P.ink2 }, inner - 3 - when.length);
      s.putRight(x + inner, y, when, { fg: P.ink3 });
      y += 1;
    }
  }
  if (y === rect.y + 1) s.put(x, y, "Nothing needs you.", { fg: P.ink3 });
}

const OFF_WORDS: Record<string, string> = { heatAndCool: "heating and cooling together", offSetpoint: "held off its setpoint", hunting: "an output is hunting", flatline: "a sensor has stopped moving", notFollowing: "a command is not followed" };

// ---- The line of what is going on ---------------------------------------------------------------------

function drawSummary(s: Surface, view: DeckView, pad: number, y: number): void {
  const site = view.site!;
  let off = 0;
  let active = 0;
  let unacked = 0;
  let hand = 0;
  let waiting = 0;
  for (const unit of site.units) {
    const dev = unit.zone ? deviation(view, unit) : undefined;
    if (dev !== undefined && Math.abs(dev) >= 2) off += 1;
    const marks = view.marks.get(unit.ord);
    if (!marks) continue;

    hand += marks.overrides;
    waiting += marks.waiting;
  }
  // Every open alarm, the network's own included: the same count the list gives.
  for (const e of view.events) {
    if (e.kind !== "alarm") continue;
    if (e.active) active += 1;
    if (!e.acked) unacked += 1;
  }
  const oldest = view.events.filter((e) => e.kind === "override" && e.until === undefined).reduce((min, e) => Math.min(min, e.at), Infinity);
  const parts: [string, Style?][] = [];
  const add = (text: string, fg: string) => {
    if (parts.length) parts.push(["  ·  ", { fg: P.line2 }]);
    parts.push([text, { fg }]);
  };
  if (off) add(`${off} ${off === 1 ? "zone" : "zones"} off setpoint`, P.warm);
  const wrong = view.off?.size ?? 0;
  if (wrong) add(`${OFF_MARK} ${wrong} not running right`, P.warm);
  if (active) add(`${active} in alarm`, P.alarm);
  if (unacked) add(`${unacked} ${unacked === 1 ? "alarm" : "alarms"} to acknowledge`, P.ink2);
  if (hand) add(`${hand} in hand${Number.isFinite(oldest) ? `, the oldest for ${agoText(view.span.to - oldest)}` : ""}`, P.hand);
  if (waiting) add(`${waiting} ${waiting === 1 ? "change waits" : "changes wait"} for you`, P.cyan);
  const guesses = site.guesses.sure + site.guesses.unsure;
  if (guesses) add(`${guesses} ${guesses === 1 ? "guess" : "guesses"} about what feeds what`, P.ink3);
  if (!parts.length) parts.push(["all quiet", { fg: P.ok }]);
  // At the right, the site's meter: what it reads now, and today's highest quarter hour.
  const kw = (v: number) => `${v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1)} kW`;
  const meter: [string, Style?][] = view.power ? [["SITE ", { fg: P.ink3 }], [kw(numberOf(view.values.get(view.power.ord)) ?? view.power.now), { fg: P.ink, bold: true }], ...(view.power.peak !== undefined ? [[`  peak ${kw(view.power.peak)}${view.power.peakAt ? ` at ${clock(view.power.peakAt)}` : ""}`, { fg: P.ink3 }] as [string, Style?]] : [])] : [];
  const room = view.width - pad * 2 - (meter.length && lengthOf(parts) + lengthOf(meter) + 4 <= view.width - pad * 2 ? lengthOf(meter) + 4 : 0);
  run(s, pad, y, parts, room);
  if (room < view.width - pad * 2) run(s, view.width - pad - lengthOf(meter), y, meter);
}

// ---- The time bar -----------------------------------------------------------------------------------

function drawTimeBar(s: Surface, view: DeckView, pad: number, y: number, hits: Hit[]): Rect {
  const x = pad;
  const width = view.width - pad * 2;
  const { from, to } = view.span;
  const active = view.keys === "time";
  const xOf = (ms: number) => x + Math.max(0, Math.min(width - 1, Math.round(((ms - from) / (to - from)) * (width - 1))));
  // Day labels, each where its day begins.
  const firstDay = new Date(from);
  firstDay.setHours(0, 0, 0, 0);
  let lastLabel = -99;
  for (let day = firstDay.getTime(); day <= to; day += DAY) {
    if (day < from) continue;
    const at = xOf(day);
    if (at - lastLabel < 8 || at + 6 > x + width) continue;
    s.put(at, y, dayLabel(day), { fg: active ? P.ink2 : P.ink3 });
    lastLabel = at;
  }
  // The track, with what is in hand drawn along it.
  const trackY = y + 1;
  for (let i = 0; i < width; i += 1) s.put(x + i, trackY, "─", { fg: active ? P.ink3 : P.line2 });
  for (const e of view.events) {
    if (e.kind !== "override") continue;
    const a = xOf(Math.max(from, e.at));
    const b = xOf(Math.min(to, e.until ?? to));
    for (let i = a; i <= b; i += 1) s.put(i, trackY, "━", { fg: P.hand });
  }
  // Marks, the more urgent on top where two share a cell.
  const order: DeckEvent["kind"][] = ["change", "agent", "note", "proposal", "alarm"];
  for (const kind of order) {
    for (const e of view.events) {
      if (e.kind !== kind || e.at < from || e.at > to) continue;
      const [mark, fg] = kind === "alarm" ? ["▲", P.alarm] : kind === "note" ? ["✎", P.ok] : kind === "change" ? ["●", e.agent ? P.cyan : P.ink] : kind === "agent" ? ["◆", P.cyan] : ["◇", P.cyan];
      s.put(xOf(e.at), trackY, mark, { fg });
    }
  }
  if (view.turnAt !== undefined && view.turnAt >= from && view.turnAt <= to) {
    const at = xOf(view.turnAt);
    s.put(at, y, "▼ ", { fg: P.accentMark, bold: true });
    s.put(Math.min(at + 2, x + width - 12), y, "turned here ", { fg: P.accentMark, bold: true });
  }
  // The moment looked at.
  const cursor = xOf(view.at ?? to);
  s.put(cursor, trackY, "┃", { fg: P.accentMark, bold: true });
  if (view.at === undefined) s.putRight(x + width, y + 2, "NOW", { fg: P.accentMark, bold: true });
  else {
    const label = ` ${dayLabel(view.at)} · ${clock(view.at)} · ${agoText(to - view.at)} ago `;
    const at = Math.max(x, Math.min(x + width - label.length, cursor - Math.floor(label.length / 2)));
    s.put(at, y + 2, label, { fg: P.accentInk, bg: P.accent, bold: true });
  }
  if (view.height >= 30 && view.at === undefined) {
    run(s, x, y + 2, [["● ", { fg: P.ink }], ["person   ", { fg: P.ink3 }], ["◆ ", { fg: P.cyan }], ["agent   ", { fg: P.ink3 }], ["▲ ", { fg: P.alarm }], ["alarm   ", { fg: P.ink3 }], ["━ ", { fg: P.hand }], ["in hand", { fg: P.ink3 }]], width - 6);
  }
  hits.push({ x, y, width, height: 3, id: "time" });
  return { x, y: trackY, width, height: 1 };
}

// ---- The prompt and the keys ------------------------------------------------------------------------

function drawPrompt(s: Surface, view: DeckView, pad: number, y: number, hits: Hit[]): void {
  const x = pad;
  const width = view.width - pad * 2;
  const active = view.keys === "prompt";
  s.fill({ x, y, width, height: 1 }, active ? P.panel : P.well);
  s.put(x + 1, y, "›", { fg: P.accentMark, bold: true });
  if (!active && !view.prompt.text) s.put(x + 3, y, "type a command   needs · why · set · get · places · bask <command>", { fg: P.ink3 }, width - 4);
  else {
    const room = width - 5;
    const chars = [...view.prompt.text];
    const start = Math.max(0, view.prompt.cursor - room + 1);
    s.put(x + 3, y, chars.slice(start, start + room).join(""), { fg: P.ink });
    if (active) {
      const at = x + 3 + view.prompt.cursor - start;
      s.put(at, y, chars[view.prompt.cursor] ?? " ", { fg: P.accentInk, bg: P.accent });
    }
  }
  hits.push({ x, y, width, height: 1, id: "prompt" });
}

function drawHints(s: Surface, view: DeckView, pad: number, y: number): void {
  let x = pad;
  const keys: [string, string][] =
    view.ghost ? [["enter", view.writes ? "make it" : "allow changes from this window"], ["esc", "drop it"]]
    : view.answer ? [...(view.answer.undo ? ([["f", "put it back"]] as [string, string][]) : []), ["t", "go to when it turned"], ["↑↓", "scroll"], ["esc", "close"]]
    : view.result && view.keys !== "prompt" ? view.result.hint ?? (view.result.cursor !== undefined ? [["↑↓", "move"], ["enter", "choose"], ["esc", "close"]] : [["↑↓", "scroll"], ["esc", "close"]])
    : view.keys === "prompt" ? [["enter", "run"], ["tab", "complete"], ["↑↓", "earlier"], ["esc", "back"]]
    : view.keys === "time" ? [["← →", "move through time"], ["< >", "by event"], ["[ ]", "span"], ["n", "now"], ["tab", "map"]]
    : [["←↑↓→", "move"], ["enter", view.zoom.level === "site" && !view.focus?.startsWith("do:") ? "open" : "what can be done"], ["esc", "back"], ["i", "needs you"], ["l", "lens"], ...(view.zoom.level === "site" ? ([["g", "layout"]] as [string, string][]) : []), ["tab", "time"], [":", "command"], ...(view.site && view.site.guesses.sure + view.site.guesses.unsure ? ([["r", "review guesses"]] as [string, string][]) : []), ["?", "keys"], ["q", "quit"]];
  for (const [key, label] of keys) {
    if (x + key.length + label.length + 4 > view.width - pad) break;
    x += keycap(s, x, y, key, label);
  }
}

// ---- Inside a unit ----------------------------------------------------------------------------------

/** The readings a unit leads with, by what it is. */
const LEAD: Record<string, string[]> = {
  ahu: ["supplyAirTemp", "supplyAirPressure", "supplyFanSpeed", "mixedAirTemp", "coolingValve", "returnAirTemp"],
  vav: ["zoneTemp", "zoneTempSp", "airflow", "damper", "reheatValve"],
  fcu: ["zoneTemp", "zoneTempSp", "fanSpeed", "coolingValve", "heatingValve"],
  crac: ["returnAirTemp", "supplyAirTemp", "load", "fanSpeed"],
  chilledWaterPlant: ["chwSupplyTemp", "chwReturnTemp", "chwFlow", "pumpSpeed"],
  hotWaterPlant: ["hwSupplyTemp", "hwReturnTemp", "hwFlow", "pumpSpeed"],
  chiller: ["leavingWaterTemp", "enteringWaterTemp", "load", "waterFlow"],
  boiler: ["leavingWaterTemp", "enteringWaterTemp", "load"],
  coolingTower: ["leavingWaterTemp", "fanSpeed"],
  pump: ["pumpSpeed", "speedFeedback", "waterFlow"]
};
const LEAD_NAME: Record<string, string> = {
  supplyAirTemp: "SUPPLY AIR", supplyAirPressure: "DUCT PRESSURE", supplyFanSpeed: "SUPPLY FAN", mixedAirTemp: "MIXED AIR", returnAirTemp: "RETURN AIR", coolingValve: "COOLING VALVE", heatingValve: "HEATING VALVE",
  zoneTemp: "ZONE", zoneTempSp: "SETPOINT", airflow: "AIRFLOW", damper: "DAMPER", reheatValve: "REHEAT", chwSupplyTemp: "CHW SUPPLY", chwReturnTemp: "CHW RETURN", chwFlow: "CHW FLOW", hwSupplyTemp: "HW SUPPLY",
  hwReturnTemp: "HW RETURN", hwFlow: "HW FLOW", pumpSpeed: "PUMP", leavingWaterTemp: "LEAVING WATER", enteringWaterTemp: "ENTERING WATER", load: "LOAD", fanSpeed: "FAN", waterFlow: "FLOW", speedFeedback: "SPEED"
};

/** A thin line chart one or more rows high, in braille dots, so charts on neighbouring rows stay apart. */
function line(values: number[], cols: number, rows: number): string[] {
  const [min, max] = bounds(values);
  return brailleLine(resample(values, cols * 2), cols, rows, min, max);
}

function drawUnit(s: Surface, view: DeckView, body: Rect, hits: Hit[], stops: Stop[]): void {
  const site = view.site!;
  const zoom = view.zoom as { unit: string; point?: string };
  const unit = unitOf(site, zoom.unit);
  if (!unit) return void s.put(body.x, body.y, "That unit is no longer on the station.", { fg: P.ink3 });
  const marks = view.marks.get(unit.ord) ?? NO_MARKS;
  const side = body.width >= 100 ? Math.min(52, Math.floor(body.width * 0.38)) : 0;
  const left: Rect = { x: body.x, y: body.y, width: body.width - (side ? side + 2 : 0), height: body.height };
  s.fill(left, P.panel);
  const top = left.y + (left.height >= 20 ? 1 : 0);
  // Title: the name, what it is, what is wrong with it.
  let x = left.x + 2;
  x += s.put(x, top, unit.name, { fg: P.ink, bold: true }) + 2;
  x += s.put(x, top, unit.label.toUpperCase(), { fg: P.ink3 }) + 2;
  if (marks.active) x += s.put(x, top, ` ▲ ${marks.active} in alarm `, { fg: P.ink, bg: mix(P.panel, P.alarm, 0.7), bold: true }) + 1;
  if (marks.unacked) x += s.put(x, top, ` △ ${marks.unacked} to acknowledge `, { fg: P.ink, bg: mix(P.panel, P.alarm, 0.22) }) + 1;
  if (marks.overrides) x += s.put(x, top, ` ${marks.overrides} in hand `, { fg: P.ink, bg: mix(P.panel, P.hand, 0.6) }) + 1;
  if (marks.waiting) x += s.put(x, top, ` ${marks.waiting} waiting `, { fg: P.ink, bg: mix(P.panel, P.cyan, 0.5) }) + 1;
  const dev = deviation(view, unit);
  if (dev !== undefined) s.putRight(left.x + left.width - 2, top, unit.band ? (dev ? `${Math.abs(dev).toFixed(1)}° ${dev > 0 ? "above cooling" : "below heating"} setpoint` : `within ${heldTo(view, unit) ?? "its setpoints"}`) : `${offBy(dev)}° from setpoint`, { fg: Math.abs(dev) >= 2 ? (dev > 0 ? P.warm : P.cold) : dev === 0 && unit.band ? P.ok : P.ink3 });

  // Where it is: the building, the floor, the room.
  const placeRow = unit.place && left.height >= 12 ? 1 : 0;
  if (placeRow) s.put(left.x + 2, top + 1, unit.place!.path, { fg: P.ink2 }, left.width - 4);

  // What it leads with, as instruments: the reading in big figures over a line of the span.
  let listTop = top + 2 + placeRow;
  const lead = (LEAD[unit.kind] ?? []).map((role) => unit.points.find((p) => p.role === role)).filter((p): p is SitePoint => !!p);
  const cards = Math.min(lead.length, 5, Math.floor((left.width - 2) / 20));
  const cardWidth = cards ? Math.min(26, Math.floor((left.width - 4 + 2) / cards) - 2) : 0;
  if (cards >= 2 && left.height >= 24) {
    lead.slice(0, cards).forEach((point, i) => {
      const cx = left.x + 2 + i * (cardWidth + 2);
      const cy = top + 2 + placeRow;
      const snapshot = view.values.get(point.ord);
      const state = stateOf(snapshot);
      const colour = isDown(snapshot) ? P.fault : state === "alarm" ? P.alarm : state === "overridden" ? P.hand : P.ink;
      const focused = point.ord === view.focus && view.keys === "map";
      s.fill({ x: cx, y: cy, width: cardWidth, height: 7 }, P.panel2);
      if (focused) s.fill({ x: cx, y: cy, width: cardWidth, height: 1 }, P.accent);
      s.put(cx + 1, cy, LEAD_NAME[point.role] ?? point.name.toUpperCase(), focused ? { fg: P.accentInk, bg: P.accent, bold: true } : { fg: P.ink3 }, cardWidth - 2);
      if (state === "overridden") s.putRight(cx + cardWidth - 1, cy, "IN HAND", { fg: focused ? P.accentInk : P.hand, bold: true });
      else if (state === "alarm") s.putRight(cx + cardWidth - 1, cy, "ALARM", { fg: focused ? P.accentInk : P.alarm, bold: true });
      const text = reading(view, short(snapshot, point), i);
      const wide = figuresWidth(text);
      if (wide !== undefined && wide <= cardWidth - 2) drawFigures(s, cx + 1, cy + 2, text, colour);
      else s.put(cx + 1, cy + 3, full(snapshot), { fg: colour, bold: true }, cardWidth - 2);
      const unitText = String((snapshot?.facets as { units?: unknown } | undefined)?.units ?? point.unit ?? "");
      if (unitText && !/°|^%$/.test(unitText) && wide !== undefined) s.put(cx + 2 + wide, cy + 4, unitText, { fg: P.ink3 }, cardWidth - wide - 3);
      const series = view.series.get(point.ord);
      if (series && series.length > 1) s.put(cx + 1, cy + 6, line(series, cardWidth - 2, 1)[0], { fg: point.ord === unit.headline?.ord ? P.accent : P.ink3 });
      hits.push({ x: cx, y: cy, width: cardWidth, height: 7, id: `point:${point.ord}` });
    });
    listTop = top + 10 + placeRow;
  }

  // Its points: name, reading, a line of the span, and what state it is in.
  const rows = left.y + left.height - listTop - 1;
  const focusIndex = Math.max(0, unit.points.findIndex((p) => p.ord === view.focus));
  const first = Math.max(0, Math.min(unit.points.length - rows, focusIndex - Math.floor(rows / 2)));
  const nameWidth = Math.min(30, Math.max(14, Math.floor(left.width * 0.34)));
  const chartWidth = Math.max(0, Math.min(30, left.width - nameWidth - 17 - 19));
  const waiting = new Map<string, { active: number; unacked: number }>();
  // What the lens in use picks out, point by point: what to say about it and in which colour.
  const picked = new Map<string, { text: string; fg: string }>();
  const tally = new Map<string, { count: number; last: DeckEvent }>();
  for (const e of view.events) {
    if (!e.ord) continue;
    const point = unit.points.find((p) => e.ord === p.ord || e.ord!.startsWith(`${p.ord}/`));
    if (!point) continue;
    if (e.kind === "alarm") {
      const mine = waiting.get(point.ord) ?? waiting.set(point.ord, { active: 0, unacked: 0 }).get(point.ord)!;
      if (e.active) mine.active += 1;
      if (!e.acked) mine.unacked += 1;
    }
    const counts =
      view.lens === "overrides" ? e.kind === "override" && e.until === undefined
      : view.lens === "changes" ? (e.kind === "change" || e.kind === "agent") && e.at >= view.span.from
      : view.lens === "agents" ? e.kind === "proposal" || e.kind === "agent" || (e.kind === "change" && !!e.agent)
      : false;
    if (!counts) continue;
    const mine = tally.get(point.ord);
    if (!mine) tally.set(point.ord, { count: 1, last: e });
    else {
      mine.count += 1;
      if (e.at > mine.last.at) mine.last = e;
    }
  }
  const ago = (e: DeckEvent) => `${agoText(view.span.to - e.at)} ago`;
  for (const point of unit.points) {
    const alarmed = waiting.get(point.ord);
    const mine = tally.get(point.ord);
    if (view.lens === "alarms" && alarmed) picked.set(point.ord, alarmed.active ? { text: `▲ ${alarmed.active} in alarm`, fg: P.alarm } : { text: `△ ${alarmed.unacked} to acknowledge`, fg: P.ink });
    else if (view.lens === "overrides" && (mine || stateOf(view.values.get(point.ord)) === "overridden")) picked.set(point.ord, { text: mine ? `━ in hand by ${mine.last.who ?? "someone"}, ${agoText(view.span.to - mine.last.at)}` : "━ in hand", fg: P.hand });
    else if (view.lens === "changes" && mine) picked.set(point.ord, { text: `${mine.count} ${mine.count === 1 ? "change" : "changes"} · ${mine.last.who ?? (mine.last.agent ? "an agent" : "someone")} ${ago(mine.last)}`, fg: mine.last.agent ? P.cyan : P.ink });
    else if (view.lens === "agents" && mine) picked.set(point.ord, mine.last.kind === "proposal" ? { text: `◇ ${mine.last.id ?? "a change"} waits for you`, fg: P.cyan } : { text: `◆ ${mine.count} by an agent · ${ago(mine.last)}`, fg: P.cyan });
  }
  const sifting = view.lens !== "comfort";
  // The lens in words, where the list begins, so it is plain what it is showing here.
  if (sifting && listTop > top + 1) {
    const what = { alarms: "in alarm or waiting to be acknowledged", overrides: "in hand", changes: `changed in ${spanText(view.span.to - view.span.from).toLowerCase()}`, agents: "touched by an agent" }[view.lens as Exclude<Lens, "comfort">];
    run(s, left.x + 2, listTop - 1, [[`${view.lens.toUpperCase()}  `, { fg: P.accentMark, bold: true }], [picked.size ? `${picked.size} of ${unit.points.length} points ${what}` : `no point here is ${what}`, { fg: P.ink3 }]], left.width - 4);
  }
  unit.points.slice(first, first + rows).forEach((point, i) => {
    const y = listTop + i;
    const snapshot = view.values.get(point.ord);
    const state = stateOf(snapshot);
    const focused = point.ord === view.focus && view.keys === "map";
    const bg = focused ? P.panel2 : P.panel;
    if (focused) s.fill({ x: left.x, y, width: left.width, height: 1 }, bg);
    s.put(left.x, y, focused ? "▌" : " ", { fg: P.accentMark, bg });
    const mark = picked.get(point.ord);
    // Under a lens, what it picks out stands forward and the rest steps back.
    const dim = sifting && !mark && !focused;
    s.put(left.x + 2, y, point.name, { fg: mark ? P.ink : focused ? P.ink : dim ? P.ink3 : P.ink2, bg, bold: focused || !!mark }, nameWidth);
    const value = reading(view, full(snapshot), i);
    const colour = isDown(snapshot) ? P.fault : state === "alarm" ? P.alarm : state === "overridden" ? P.hand : dim ? P.ink3 : P.ink;
    s.putRight(left.x + 2 + nameWidth + 13, y, value.slice(0, 13), { fg: colour, bg, bold: true });
    const series = view.series.get(point.ord);
    if (chartWidth && series && series.length > 1 && !(mark && mark.text.length > 18)) s.put(left.x + nameWidth + 17, y, line(series, chartWidth, 1)[0], { fg: focused ? P.accent : P.ink3, bg });
    const alarmed = waiting.get(point.ord);
    const note = alarmed?.active ? "▲ in alarm" : state === "overridden" ? "in hand" : alarmed?.unacked ? `△ ${alarmed.unacked} to acknowledge` : state === "ok" ? (point.ord === unit.setpoint?.ord ? "setpoint" : point.writable ? "can be commanded" : "") : state;
    if (mark) s.putRight(left.x + left.width - 2, y, mark.text.slice(0, Math.max(10, left.width - nameWidth - 20)), { fg: mark.fg, bg, bold: true });
    else s.putRight(left.x + left.width - 2, y, note, { fg: alarmed?.active || state === "alarm" ? P.alarm : state === "overridden" ? P.hand : isDown(snapshot) ? P.fault : alarmed?.unacked ? P.ink2 : P.ink3, bg });
    stops.push({ id: point.ord, x: left.x, y, width: left.width, height: 1 });
    hits.push({ x: left.x, y, width: left.width, height: 1, id: `point:${point.ord}` });
  });
  if (unit.points.length > rows) s.putRight(left.x + left.width - 2, left.y + left.height - 1, `${first + 1} to ${Math.min(unit.points.length, first + rows)} of ${unit.points.length}`, { fg: P.ink3 });

  if (!side) return;
  // Beside it: the point under the cursor over the span, what feeds the unit and what it feeds, what happened to it.
  const sx = body.x + body.width - side;
  let y = body.y;
  const card = (title: string, rowsNeeded: number) => {
    s.fill({ x: sx, y, width: side, height: rowsNeeded + 3 }, P.panel);
    s.put(sx + 2, y + 1, title, { fg: P.ink3 });
    const at = y + 2;
    y += rowsNeeded + 4;
    return at;
  };
  const point = unit.points.find((p) => p.ord === view.focus);
  const series = point ? view.series.get(point.ord) : undefined;
  if (point && body.height >= 24) {
    const chartRows = 7;
    const at = card(`${point.name.toUpperCase()}  ·  ${spanText(view.span.to - view.span.from)}`, chartRows + 1);
    if (series && series.length > 1) {
      const [min, max] = bounds(series);
      const cols = side - 12;
      line(series, cols, chartRows).forEach((row, i) => s.put(sx + 2, at + i, row, { fg: P.accentMark }));
      s.put(sx + side - 9, at, max.toFixed(1).padStart(7), { fg: P.ink3 });
      s.put(sx + side - 9, at + chartRows - 1, min.toFixed(1).padStart(7), { fg: P.ink3 });
      // The moment looked at, as a line down the chart.
      if (view.at !== undefined) {
        const cx = sx + 2 + Math.round(((view.at - view.span.from) / (view.span.to - view.span.from)) * (cols - 1));
        for (let i = 0; i < chartRows; i += 1) s.put(cx, at + i, "│", { fg: P.ink });
      }
      s.put(sx + 2, at + chartRows, dayLabel(view.span.from), { fg: P.ink3 });
      s.putRight(sx + 2 + cols, at + chartRows, "NOW", { fg: P.ink3 });
    } else s.put(sx + 2, at + 3, "This point keeps no history.", { fg: P.ink3 });
  }
  const feeds = site.groups.find((g) => g.feeder?.ord === unit.ord);
  const fedBy = site.groups.find((g) => g.by === "serves" && g.members.some((m) => m.ord === unit.ord))?.feeder;
  // What feeds it: air from the unit above it on the map, and water from the plant, as the station or a person says.
  const water = (site.review.serves ?? []).filter((e) => e.to === unit.ord && e.medium !== "air" && (!e.inferred || e.confirmed)).map((e) => ({ unit: unitOf(site, e.from), medium: e.medium === "hotWater" ? "hot water" : "chilled water" })).filter((w): w is { unit: Unit; medium: string } => !!w.unit);
  if (fedBy || water.length) {
    let at = card("FED BY", (fedBy ? 1 : 0) + water.length);
    if (fedBy) {
      const { state, facts } = feederFacts(view, fedBy);
      const used = s.put(sx + 2, at, fedBy.name, { fg: P.ink, bold: true });
      run(s, sx + 3 + used, at, [["air  ", { fg: P.ink3 }], ...state, ["  "], ...facts], side - used - 5);
      hits.push({ x: sx, y: at, width: side, height: 1, id: `unit:${fedBy.ord}` });
      at += 1;
    }
    for (const w of water) {
      const { state } = feederFacts(view, w.unit);
      const used = s.put(sx + 2, at, w.unit.name, { fg: P.ink, bold: true });
      run(s, sx + 3 + used, at, [[`${w.medium}  `, { fg: P.ink3 }], ...state, ["  "], [w.unit.headline ? short(view.values.get(w.unit.headline.ord), w.unit.headline) : "", { fg: P.ink2 }]], side - used - 5);
      hits.push({ x: sx, y: at, width: side, height: 1, id: `unit:${w.unit.ord}` });
      at += 1;
    }
  } else if (unit.zone) {
    const at = card("FED BY", 1);
    s.put(sx + 2, at, "not known", { fg: P.ink3 });
  }
  if (feeds?.members.length) {
    const per = Math.max(1, Math.floor((side - 4 + 1) / (TILE + 1)));
    const tileRows = Math.min(2, Math.ceil(feeds.members.length / per));
    const at = card(`${feeds.by === "part" ? "MADE UP OF" : "FEEDS"} ${feeds.members.length}`, tileRows * 2);
    const labels = tileLabels(feeds.members);
    feeds.members.slice(0, per * tileRows).forEach((member, i) => {
      const tx = sx + 2 + (i % per) * (TILE + 1);
      const ty = at + Math.floor(i / per) * 2;
      const look = tileLook(view, member);
      s.fill({ x: tx, y: ty, width: TILE, height: 2 }, look.bg);
      s.putCentre(tx, ty, TILE, labels.get(member.ord) ?? member.name, { fg: look.label });
      s.putCentre(tx, ty + 1, TILE, short(member.headline ? view.values.get(member.headline.ord) : undefined, member.headline), { fg: look.fg, bold: true });
      hits.push({ x: tx, y: ty, width: TILE, height: 2, id: `unit:${member.ord}` });
    });
  }
  const wrong = view.off?.get(unit.ord) ?? [];
  if (wrong.length) {
    // The finding in full, over as many lines as it takes (three at most).
    const wrap = (text: string) => {
      const lines: string[] = [""];
      for (const word of text.split(" ")) {
        if (lines[lines.length - 1].length + word.length + 1 > side - 6 && lines[lines.length - 1]) lines.push("");
        lines[lines.length - 1] += `${lines[lines.length - 1] ? " " : ""}${word}`;
      }
      return lines.slice(0, 3);
    };
    const blocks = wrong.map((f) => ({ f, lines: wrap(f.message) }));
    let at = card("NOT RUNNING RIGHT", blocks.reduce((n, block) => n + 1 + block.lines.length, 0));
    for (const { f, lines } of blocks) {
      s.put(sx + 2, at, OFF_MARK, { fg: P.warm, bold: true });
      s.put(sx + 4, at, OFF_WORDS[f.kind] ?? "", { fg: P.ink, bold: true }, side - 6);
      lines.forEach((text, i) => s.putClipped(sx + 4, at + 1 + i, text, { fg: P.ink2 }, side - 6));
      hits.push({ x: sx, y: at, width: side, height: 1 + lines.length, id: `point:${f.point}` });
      at += 1 + lines.length;
    }
  }
  // A plant: what it sends water to, each with how far its valve is open.
  for (const fed of feeds?.water ?? []) {
    const per = Math.max(1, Math.floor((side - 4 + 1) / (TILE + 1)));
    const tileRows = Math.min(3, Math.ceil(fed.units.length / per));
    const at = card(`${fed.medium === "chilledWater" ? "CHILLED WATER" : "HOT WATER"} TO ${fed.units.length}${fed.guessed ? "  ·  guessed" : ""}`, tileRows * 2);
    const labels = tileLabels(fed.units);
    fed.units.slice(0, per * tileRows).forEach((member, i) => {
      const tx = sx + 2 + (i % per) * (TILE + 1);
      const ty = at + Math.floor(i / per) * 2;
      const valve = valveOf(view, member, fed.medium);
      const open = valve !== undefined && valve > 5;
      s.fill({ x: tx, y: ty, width: TILE, height: 2 }, P.panel2);
      s.putCentre(tx, ty, TILE, labels.get(member.ord) ?? member.name, { fg: P.ink2, bg: P.panel2 });
      s.putCentre(tx, ty + 1, TILE, valve === undefined ? "·" : `${Math.round(valve)}%`, { fg: open ? P.ink : P.ink3, bg: P.panel2, bold: open });
      hits.push({ x: tx, y: ty, width: TILE, height: 2, id: `unit:${member.ord}` });
    });
  }
  const mine = view.events.filter((e) => e.ord && (e.ord === unit.ord || e.ord.startsWith(`${unit.ord}/`))).sort((a, b) => b.at - a.at);
  const room = body.y + body.height - y - 4;
  if (room >= 1) {
    const at = card("WHAT HAPPENED", Math.max(1, Math.min(room, mine.length || 1)));
    if (!mine.length) s.put(sx + 2, at, "nothing in this span", { fg: P.ink3 });
    mine.slice(0, room).forEach((e, i) => {
      const [mark, fg] = e.kind === "alarm" ? ["▲", P.alarm] : e.kind === "override" ? ["━", P.hand] : e.kind === "note" ? ["✎", P.ok] : e.agent ? ["◆", P.cyan] : ["●", P.ink];
      s.put(sx + 2, at + i, mark, { fg });
      const when = `${agoText(view.span.to - e.at)} `;
      s.put(sx + 4, at + i, when, { fg: P.ink3 });
      s.putClipped(sx + 4 + when.length, at + i, e.text, { fg: P.ink2 }, side - 6 - when.length);
    });
  }
}

const spanText = (ms: number) => (ms <= DAY ? "THE LAST DAY" : ms <= 7 * DAY ? "THE LAST WEEK" : "THE LAST MONTH");

const BARS = "▁▂▃▄▅▆▇█";
/** A small chart of a series, `width` cells wide. */
function spark(values: number[], width: number): string {
  const step = values.length / width;
  const picked = Array.from({ length: Math.min(width, values.length) }, (_v, i) => values[Math.min(values.length - 1, Math.floor(i * Math.max(1, step)))]);
  const min = Math.min(...picked);
  const max = Math.max(...picked);
  return picked.map((v) => BARS[max === min ? 2 : Math.round(((v - min) / (max - min)) * (BARS.length - 1))]).join("");
}

// ---- An answer, and a change that waits -----------------------------------------------------------------

function drawResult(s: Surface, view: DeckView, body: Rect): void {
  const result = view.result!;
  const width = Math.min(body.width, 124);
  const x = body.x + Math.floor((body.width - width) / 2);
  const height = Math.min(body.height, Math.max(6, result.lines.length + 3));
  const y = body.y + Math.floor((body.height - height) / 2);
  s.fill({ x, y, width, height }, P.panel2);
  s.fill({ x, y, width, height: 1 }, P.accent, P.accentInk);
  s.put(x + 2, y, result.title, { fg: P.accentInk, bg: P.accent, bold: true }, width - 4);
  result.lines.slice(result.scroll, result.scroll + height - 2).forEach((line, i) => {
    const on = result.cursor === result.scroll + i;
    const bg = on ? mix(P.panel2, P.accent, 0.22) : P.panel2;
    if (on) {
      s.fill({ x, y: y + 1 + i, width, height: 1 }, bg);
      s.put(x, y + 1 + i, "▌", { fg: P.accentMark, bg });
    }
    run(s, x + 2, y + 2 + i - 1, line.parts.map((part) => [part.text, { fg: on && part.fg === P.ink2 ? P.ink : part.fg ?? P.ink2, bold: part.bold, bg }] as [string, Style]), width - 4);
  });
  if (result.lines.length > height - 2) s.putRight(x + width - 2, y + height - 1, `${result.scroll + 1} to ${Math.min(result.lines.length, result.scroll + height - 2)} of ${result.lines.length}`, { fg: P.ink3 });
}

function drawGhost(s: Surface, view: DeckView, body: Rect, hits: Hit[]): void {
  const ghost = view.ghost!;
  const width = Math.min(body.width, 104);
  const height = ghost.lines.length + (ghost.check ? 1 : 0) + (ghost.note ? 1 : 0) + (view.writes ? 0 : 1) + 4;
  const x = body.x + Math.floor((body.width - width) / 2);
  const y = body.y + body.height - height;
  const bg = mix(P.panel2, P.cyan, 0.08);
  s.fill({ x, y, width, height }, bg);
  // A dashed edge: it is not there yet.
  for (let i = 0; i < width; i += 1) {
    s.put(x + i, y, "╌", { fg: P.cyan });
    s.put(x + i, y + height - 1, "╌", { fg: P.cyan });
  }
  for (let i = 1; i < height - 1; i += 1) {
    s.put(x, y + i, "╎", { fg: P.cyan });
    s.put(x + width - 1, y + i, "╎", { fg: P.cyan });
  }
  const used = s.put(x + 2, y + 1, ghost.agent ? `proposed by ${ghost.from}` : "your change", { fg: P.cyan, bold: true });
  s.put(x + 2 + used, y + 1, "  ·  not made yet", { fg: P.ink3 });
  s.putRight(x + width - 2, y + 1, ghost.id, { fg: P.ink3 });
  ghost.lines.forEach((line, i) => {
    const parts: [string, Style?][] = [[`${line.verb.padEnd(5)} `, { fg: P.ink3 }], [line.what, { fg: P.ink, bold: true }]];
    if (line.before !== undefined || line.after !== undefined) parts.push(["   ", {}], [line.before ?? "", { fg: P.ink3 }], [" → ", { fg: P.ink3 }], [line.after ?? "", { fg: P.accentMark, bold: true }]);
    run(s, x + 2, y + 2 + i, parts, width - 4);
  });
  let at = y + 2 + ghost.lines.length;
  if (ghost.check) run(s, x + 2, at++, [["then  ", { fg: P.ink3 }], [ghost.check, { fg: P.ink2 }]], width - 4);
  if (ghost.note) s.put(x + 2, at++, ghost.note, { fg: P.ink3 }, width - 4);
  // The first change from a window: it has to be allowed here before it can be made.
  if (!view.writes) s.put(x + 2, at++, "This window has made no changes yet. Enter allows them from here on, then asks once more.", { fg: P.fault }, width - 4);
  const first = view.writes ? "make it" : "allow changes";
  const keys = x + width - 2 - 24 - first.length;
  keycap(s, keys, y + height - 2, "enter", first);
  keycap(s, keys + 10 + first.length, y + height - 2, "esc", "drop it");
  hits.push({ x, y, width, height, id: "ghost" });
}

export { WORDMARK_WIDTH };
