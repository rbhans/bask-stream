// Draws one frame of the screen from a DeckView. Nothing here reads the station or keeps state.
import type { PointSnapshot } from "@basidekick/baskstream";
import { ASCII_S, SIGNAL_MS, WORDMARK_ROWS, WORDMARK_WIDTH, decodeAt, ditherBand, drawAsciiS, drawFigures, drawMark, drawWordmark, figuresWidth, putGlitch } from "./art.js";
import { drawAnswer } from "./answer.js";
import { P, mix } from "./brand.js";
import { tileLabels, type Group, type Site, type SitePoint, type Unit } from "./site.js";
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
  const target = numberOf(unit.setpoint && view.values.get(unit.setpoint.ord));
  return value === undefined || target === undefined ? undefined : value - target;
}

const NO_MARKS: UnitMarks = { open: 0, unacked: 0, fault: false, overrides: 0, people: 0, agents: 0, waiting: 0 };

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
    if (size < 1) return { bg: mix(P.panel2, P.ok, 0.1), fg: P.ink, label: P.ink3 };
    return on(dev > 0 ? P.warm : P.cold, Math.min(0.78, 0.2 + 0.58 * Math.min(1, (size - 1) / 4)));
  }
  if (view.lens === "alarms") {
    if (marks.unacked) return { ...on(P.alarm, 0.7), mark: { text: `▲${marks.unacked}`, fg: P.ink } };
    if (marks.fault) return { ...on(P.fault, 0.45), mark: { text: "fault", fg: P.ink } };
    if (marks.open) return { ...on(P.alarm, 0.25), mark: { text: `▲${marks.open}`, fg: P.ink2 } };
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
  if (view.zoom.level === "site") x += s.put(x, y, " ▸ whole site", { fg: P.ink3 });

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
  if (unit.headline) add(unit.headline.role === "supplyAirTemp" ? "SUPPLY" : unit.headline.label.split(" ")[0].toUpperCase(), unit.headline);
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
  height: number;
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
  const heightOf = (group: Group) => {
    const rows = Math.ceil(group.members.length / perRow);
    return padTop + 1 + (rows ? 1 + rows * size.height + (rows - 1) * size.gapY : 1) + 1;
  };
  let height = plantRows;
  for (let first = 0; first < site.groups.length; first += columns) height += Math.max(...site.groups.slice(first, first + columns).map(heightOf)) + 1;
  return { size, columns, groupWidth, perRow, padTop, heightOf, height: height - 1 };
}

function drawSite(s: Surface, view: DeckView, area: Rect, hits: Hit[], stops: Stop[]): number {
  const site = view.site!;
  // On a wide screen, what needs a person sits in a rail beside the map.
  const railWidth = area.width >= 128 ? Math.min(44, Math.floor(area.width * 0.3)) : 0;
  const body: Rect = { ...area, width: area.width - (railWidth ? railWidth + 2 : 0) };
  if (railWidth) drawRail(s, view, { x: area.x + area.width - railWidth, y: area.y, width: railWidth, height: area.height }, hits);
  let y = body.y - view.scroll;
  const visible = (row: number, rows = 1) => row >= body.y && row + rows <= body.y + body.height;
  let index = 0;

  // Plant, as a strip of chips.
  const plantTop = y;
  if (site.plant.length) {
    let x = body.x;
    for (const unit of site.plant) {
      const reading = unit.headline ? view.values.get(unit.headline.ord) : undefined;
      const { state } = feederFacts(view, unit);
      const marks = view.marks.get(unit.ord) ?? NO_MARKS;
      const focused = view.focus === unit.ord && view.keys === "map";
      const value = unit.headline ? reading2(view, short(reading, unit.headline), index++) : "";
      const parts: [string, Style?][] = [[` ${unit.name} `, focused ? { fg: P.accentInk, bg: P.accent, bold: true } : { fg: P.ink2, bg: P.panel2 }]];
      if (state.length) parts.push([" ", { bg: P.panel2 }], ...state.map(([text, style]) => [text, { ...style, bg: P.panel2 }] as [string, Style]));
      if (value) parts.push([` ${value}`, { fg: P.ink, bg: P.panel2, bold: true }]);
      if (marks.unacked || marks.fault) parts.push([" ▲", { fg: marks.unacked ? P.alarm : P.fault, bg: P.panel2 }]);
      parts.push([" ", { bg: P.panel2 }]);
      const width = lengthOf(parts);
      if (x + width > body.x + body.width) {
        x = body.x;
        y += 2;
      }
      if (visible(y)) {
        run(s, x, y, parts);
        hits.push({ x, y, width, height: 1, id: `unit:${unit.ord}` });
      }
      stops.push({ id: unit.ord, x, y, width, height: 1 });
      x += width + 1;
    }
    y += 2;
  }

  // Groups, side by side as many as fit. Tiles are as big as the room allows.
  const plan = SIZES.map((size) => planSite(site, body.width, size, y - plantTop)).find((p, i) => p.height <= body.height || i === SIZES.length - 1)!;
  const gap = 2;
  for (let first = 0; first < site.groups.length; first += plan.columns) {
    const row = site.groups.slice(first, first + plan.columns);
    const tall = Math.max(...row.map(plan.heightOf));
    row.forEach((group, column) => {
      const x = body.x + column * (plan.groupWidth + gap);
      const rect = { x, y, width: plan.groupWidth, height: tall };
      // The group's ground, only the part of it that is in view.
      const from = Math.max(rect.y, body.y);
      const to = Math.min(rect.y + rect.height, body.y + body.height);
      if (to > from) s.fill({ x, y: from, width: plan.groupWidth, height: to - from }, P.panel);
      index = drawGroup(s, view, group, rect, plan, visible, hits, stops, index);
    });
    y += tall + 1;
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
      if (marks.unacked || marks.fault) used += s.put(x + used + 1, titleY, `▲${marks.unacked || ""}`, { fg: marks.unacked ? P.alarm : P.fault, bold: true }) + 1;
      if (marks.overrides) used += s.put(x + used + 1, titleY, `${marks.overrides} in hand`, { fg: P.hand }) + 1;
      if (group.guessed) used += s.put(x + used + 1, titleY, "guessed", { fg: P.ink3, italic: true }) + 1;
      const room = inner - used - 2;
      const shown = lengthOf(facts) <= room ? facts : lengthOf(facts.slice(0, 2)) <= room ? facts.slice(0, 2) : [];
      run(s, x + inner - lengthOf(shown) + 2, titleY, shown);
      hits.push({ x: rect.x, y: titleY, width: rect.width, height: 1, id: `unit:${unit.ord}` });
    }
    stops.push({ id: unit.ord, x, y: titleY, width: unit.name.length, height: 1 });
  } else if (visible(titleY)) {
    const used = s.put(x, titleY, group.title, { fg: P.ink, bold: true });
    s.put(x + used, titleY, ` · ${group.members.length} ${group.members.length === 1 ? "unit" : "units"}`, { fg: P.ink3 });
    s.putRight(x + inner, titleY, "AS WIRED", { fg: P.ink3 });
  }
  if (group.members.length === 0) {
    if (visible(titleY + 1)) s.put(x, titleY + 1, "what it feeds is not known", { fg: P.ink3 });
    return index;
  }
  const labels = tileLabels(group.members);
  group.members.forEach((unit, i) => {
    const tx = x + (i % plan.perRow) * (size.width + size.gapX);
    const ty = titleY + 2 + Math.floor(i / plan.perRow) * (size.height + size.gapY);
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
    if (marks.unacked || marks.open) right -= s.putRight(right, y, "▲", { fg: focused ? P.accentInk : marks.unacked ? P.alarm : mix(P.alarm, bg, 0.4) }) + 1;
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
  const target = unit.setpoint ? view.values.get(unit.setpoint.ord) : undefined;
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
      const used = run(s, x + 1, line, [["set ", { fg: quiet }], [short(target, unit.setpoint), { fg: look.fg }]]);
      if (dev !== undefined) s.put(x + 2 + used, line, `${dev >= 0 ? "+" : "−"}${Math.abs(dev).toFixed(1)}`, { fg: Math.abs(dev) < 1 ? quiet : look.fg, bold: Math.abs(dev) >= 2 });
    } else if (down) s.put(x + 1, line, "not answering", { fg: quiet });
    if (series && series.length > 1) s.put(x + 1, y + 5, spark(series, width - 2), { fg: mix(look.fg, bg, 0.45) });
    return;
  }
  // Medium: the reading in bold, how far off it is, a small chart.
  if (down) {
    putGlitch(s, x + 1, y + 1, value, { fg: P.ink, bold: true }, view.fx.reduced ? undefined : view.now);
    s.tint({ x, y: y + 1, width, height: 1 }, bg);
  } else s.put(x + 1, y + 1, lensMark?.text ?? value, { fg: lensMark?.fg ?? look.fg, bold: true }, width - 2);
  if (dev !== undefined && !down) s.put(x + 1, y + 2, `${dev >= 0 ? "+" : "−"}${Math.abs(dev).toFixed(1)} of ${short(target, unit.setpoint)}`, { fg: Math.abs(dev) < 1 ? quiet : look.fg }, width - 2);
  else if (down) s.put(x + 1, y + 2, "no answer", { fg: quiet });
  if (series && series.length > 1) s.put(x + 1, y + 3, spark(series, width - 2), { fg: mix(look.fg, bg, 0.45) });
}

/** Beside the map on a wide screen: what waits for a person, what is in alarm, what is in hand, what just happened. */
function drawRail(s: Surface, view: DeckView, rect: Rect, hits: Hit[]): void {
  const site = view.site!;
  s.fill(rect, P.panel);
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
      s.put(x, y, "◇", { fg: P.cyan });
      s.put(x + 2, y, `${e.id}  ${nameFor(e.ord)}`, { fg: P.ink, bold: true }, inner - 2);
      s.putClipped(x + 2, y + 1, e.text, { fg: P.ink2 }, inner - 2);
      y += 2;
    }
    y += 1;
  }
  const alarms = view.events.filter((e) => e.kind === "alarm").sort((a, b) => b.at - a.at);
  if (alarms.length && section("IN ALARM", alarms.length, P.alarm)) {
    for (const e of alarms.slice(0, Math.max(1, Math.min(4, Math.floor((end - y) / 2) - 2)))) {
      if (y >= end) break;
      const when = agoText(view.span.to - e.at);
      s.put(x, y, "▲", { fg: P.alarm });
      const used = s.put(x + 2, y, nameFor(e.ord), { fg: P.ink, bold: true }, inner - 2 - when.length - 1);
      s.putClipped(x + 3 + used, y, e.text, { fg: P.ink3 }, inner - 4 - used - when.length);
      s.putRight(x + inner, y, when, { fg: P.ink3 });
      if (e.ord) hits.push({ x: rect.x, y, width: rect.width, height: 1, id: `unit:${site.units.find((u) => e.ord === u.ord || e.ord!.startsWith(`${u.ord}/`))?.ord ?? ""}` });
      y += 1;
    }
    y += 1;
  }
  const hand = view.events.filter((e) => e.kind === "override" && e.until === undefined);
  if (hand.length && section("IN HAND", hand.length, P.hand)) {
    for (const e of hand.slice(0, 3)) {
      if (y >= end) break;
      const when = agoText(view.span.to - e.at);
      s.put(x, y, "━", { fg: P.hand });
      const used = s.put(x + 2, y, nameFor(e.ord), { fg: P.ink, bold: true }, inner - 2 - when.length - 1);
      s.put(x + 3 + used, y, `by ${e.who ?? "someone"}`, { fg: P.ink3 }, inner - 4 - used - when.length);
      s.putRight(x + inner, y, when, { fg: P.ink3 });
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

// ---- The line of what is going on ---------------------------------------------------------------------

function drawSummary(s: Surface, view: DeckView, pad: number, y: number): void {
  const site = view.site!;
  let off = 0;
  let open = 0;
  let unacked = 0;
  let hand = 0;
  let waiting = 0;
  for (const unit of site.units) {
    const dev = unit.zone ? deviation(view, unit) : undefined;
    if (dev !== undefined && Math.abs(dev) >= 2) off += 1;
    const marks = view.marks.get(unit.ord);
    if (!marks) continue;
    open += marks.open;
    unacked += marks.unacked;
    hand += marks.overrides;
    waiting += marks.waiting;
  }
  const oldest = view.events.filter((e) => e.kind === "override" && e.until === undefined).reduce((min, e) => Math.min(min, e.at), Infinity);
  const parts: [string, Style?][] = [];
  const add = (text: string, fg: string) => {
    if (parts.length) parts.push(["  ·  ", { fg: P.line2 }]);
    parts.push([text, { fg }]);
  };
  if (off) add(`${off} ${off === 1 ? "zone" : "zones"} off setpoint`, P.warm);
  if (open) add(`${open} ${open === 1 ? "alarm" : "alarms"}${unacked ? `, ${unacked} not acknowledged` : ""}`, unacked ? P.alarm : P.ink2);
  if (hand) add(`${hand} in hand${Number.isFinite(oldest) ? `, the oldest for ${agoText(view.span.to - oldest)}` : ""}`, P.hand);
  if (waiting) add(`${waiting} ${waiting === 1 ? "change waits" : "changes wait"} for you`, P.cyan);
  const guesses = site.guesses.sure + site.guesses.unsure;
  if (guesses) add(`${guesses} ${guesses === 1 ? "guess" : "guesses"} about what feeds what`, P.ink3);
  if (!parts.length) parts.push(["all quiet", { fg: P.ok }]);
  run(s, pad, y, parts, view.width - pad * 2);
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
  const order: DeckEvent["kind"][] = ["change", "agent", "proposal", "alarm"];
  for (const kind of order) {
    for (const e of view.events) {
      if (e.kind !== kind || e.at < from || e.at > to) continue;
      const [mark, fg] = kind === "alarm" ? ["▲", P.alarm] : kind === "change" ? ["●", e.agent ? P.cyan : P.ink] : kind === "agent" ? ["◆", P.cyan] : ["◇", P.cyan];
      s.put(xOf(e.at), trackY, mark, { fg });
    }
  }
  if (view.turnAt !== undefined && view.turnAt >= from && view.turnAt <= to) {
    const at = xOf(view.turnAt);
    s.put(at, y, "▼", { fg: P.accentMark, bold: true });
    s.put(Math.min(at + 2, x + width - 12), y, "turned here", { fg: P.accentMark, bold: true });
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
  if (!active && !view.prompt.text) s.put(x + 3, y, "type a command or a question   why · log · set · get · diff", { fg: P.ink3 }, width - 4);
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
    view.ghost ? [["enter", "make it"], ["esc", "drop it"]]
    : view.answer ? [...(view.answer.undo ? ([["f", "put it back"]] as [string, string][]) : []), ["t", "go to when it turned"], ["↑↓", "scroll"], ["esc", "close"]]
    : view.result ? [["↑↓", "scroll"], ["esc", "close"]]
    : view.keys === "prompt" ? [["enter", "run"], ["tab", "complete"], ["↑↓", "earlier"], ["esc", "back"]]
    : view.keys === "time" ? [["← →", "move through time"], ["< >", "by event"], ["[ ]", "span"], ["n", "now"], ["tab", "map"]]
    : [["←↑↓→", "move"], ["enter", "open"], ["esc", "back"], ["l", "lens"], ["tab", "time"], [":", "command"], ...(view.site && view.site.guesses.sure + view.site.guesses.unsure ? ([["r", "review guesses"]] as [string, string][]) : []), ["W", "changes"], ["?", "keys"], ["q", "quit"]];
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
  if (marks.unacked) x += s.put(x, top, ` ▲ ${marks.unacked} `, { fg: P.ink, bg: mix(P.panel, P.alarm, 0.7), bold: true }) + 1;
  if (marks.overrides) x += s.put(x, top, ` ${marks.overrides} in hand `, { fg: P.ink, bg: mix(P.panel, P.hand, 0.6) }) + 1;
  if (marks.waiting) x += s.put(x, top, ` ${marks.waiting} waiting `, { fg: P.ink, bg: mix(P.panel, P.cyan, 0.5) }) + 1;
  const dev = deviation(view, unit);
  if (dev !== undefined) s.putRight(left.x + left.width - 2, top, `${dev >= 0 ? "+" : "−"}${Math.abs(dev).toFixed(1)}° from setpoint`, { fg: Math.abs(dev) >= 2 ? (dev > 0 ? P.warm : P.cold) : P.ink3 });

  // What it leads with, as instruments: the reading in big figures over a line of the span.
  let listTop = top + 2;
  const lead = (LEAD[unit.kind] ?? []).map((role) => unit.points.find((p) => p.role === role)).filter((p): p is SitePoint => !!p);
  const cards = Math.min(lead.length, 5, Math.floor((left.width - 2) / 20));
  const cardWidth = cards ? Math.min(26, Math.floor((left.width - 4 + 2) / cards) - 2) : 0;
  if (cards >= 2 && left.height >= 24) {
    lead.slice(0, cards).forEach((point, i) => {
      const cx = left.x + 2 + i * (cardWidth + 2);
      const cy = top + 2;
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
    listTop = top + 10;
  }

  // Its points: name, reading, a line of the span, and what state it is in.
  const rows = left.y + left.height - listTop - 1;
  const focusIndex = Math.max(0, unit.points.findIndex((p) => p.ord === view.focus));
  const first = Math.max(0, Math.min(unit.points.length - rows, focusIndex - Math.floor(rows / 2)));
  const nameWidth = Math.min(30, Math.max(14, Math.floor(left.width * 0.34)));
  const chartWidth = Math.max(0, Math.min(30, left.width - nameWidth - 17 - 19));
  unit.points.slice(first, first + rows).forEach((point, i) => {
    const y = listTop + i;
    const snapshot = view.values.get(point.ord);
    const state = stateOf(snapshot);
    const focused = point.ord === view.focus && view.keys === "map";
    const bg = focused ? P.panel2 : P.panel;
    if (focused) s.fill({ x: left.x, y, width: left.width, height: 1 }, bg);
    s.put(left.x, y, focused ? "▌" : " ", { fg: P.accentMark, bg });
    s.put(left.x + 2, y, point.name, { fg: focused ? P.ink : P.ink2, bg, bold: focused }, nameWidth);
    const value = reading(view, full(snapshot), i);
    const colour = isDown(snapshot) ? P.fault : state === "alarm" ? P.alarm : state === "overridden" ? P.hand : P.ink;
    s.putRight(left.x + 2 + nameWidth + 13, y, value.slice(0, 13), { fg: colour, bg, bold: true });
    const series = view.series.get(point.ord);
    if (chartWidth && series && series.length > 1) s.put(left.x + nameWidth + 17, y, line(series, chartWidth, 1)[0], { fg: focused ? P.accent : P.ink3, bg });
    const note = state === "overridden" ? "in hand" : state === "ok" ? (point.ord === unit.setpoint?.ord ? "setpoint" : point.writable ? "can be commanded" : "") : state;
    s.putRight(left.x + left.width - 2, y, note, { fg: state === "overridden" ? P.hand : state === "alarm" ? P.alarm : isDown(snapshot) ? P.fault : P.ink3, bg });
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
  if (fedBy) {
    const at = card("FED BY", 1);
    const { state, facts } = feederFacts(view, fedBy);
    const used = s.put(sx + 2, at, fedBy.name, { fg: P.ink, bold: true });
    run(s, sx + 3 + used, at, [...state, ["  "], ...facts], side - used - 5);
    hits.push({ x: sx, y: at, width: side, height: 1, id: `unit:${fedBy.ord}` });
  } else if (unit.zone) {
    const at = card("FED BY", 1);
    s.put(sx + 2, at, "not known", { fg: P.ink3 });
  }
  if (feeds?.members.length) {
    const per = Math.max(1, Math.floor((side - 4 + 1) / (TILE + 1)));
    const tileRows = Math.min(2, Math.ceil(feeds.members.length / per));
    const at = card(`FEEDS ${feeds.members.length}`, tileRows * 2);
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
  const mine = view.events.filter((e) => e.ord && (e.ord === unit.ord || e.ord.startsWith(`${unit.ord}/`))).sort((a, b) => b.at - a.at);
  const room = body.y + body.height - y - 4;
  if (room >= 1) {
    const at = card("WHAT HAPPENED", Math.max(1, Math.min(room, mine.length || 1)));
    if (!mine.length) s.put(sx + 2, at, "nothing in this span", { fg: P.ink3 });
    mine.slice(0, room).forEach((e, i) => {
      const [mark, fg] = e.kind === "alarm" ? ["▲", P.alarm] : e.kind === "override" ? ["━", P.hand] : e.agent ? ["◆", P.cyan] : ["●", P.ink];
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
  const width = Math.min(body.width, 110);
  const x = body.x + Math.floor((body.width - width) / 2);
  const height = Math.min(body.height, Math.max(6, result.lines.length + 3));
  const y = body.y + Math.floor((body.height - height) / 2);
  s.fill({ x, y, width, height }, P.panel2);
  s.fill({ x, y, width, height: 1 }, P.accent, P.accentInk);
  s.put(x + 2, y, result.title, { fg: P.accentInk, bg: P.accent, bold: true }, width - 4);
  result.lines.slice(result.scroll, result.scroll + height - 2).forEach((line, i) => {
    run(s, x + 2, y + 2 + i - 1, line.parts.map((part) => [part.text, { fg: part.fg ?? P.ink2, bold: part.bold }] as [string, Style]), width - 4);
  });
  if (result.lines.length > height - 2) s.putRight(x + width - 2, y + height - 1, `${result.scroll + 1} to ${Math.min(result.lines.length, result.scroll + height - 2)} of ${result.lines.length}`, { fg: P.ink3 });
}

function drawGhost(s: Surface, view: DeckView, body: Rect, hits: Hit[]): void {
  const ghost = view.ghost!;
  const width = Math.min(body.width, 84);
  const height = ghost.lines.length + (ghost.check ? 1 : 0) + (ghost.note ? 1 : 0) + 4;
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
  const keys = x + width - 2 - 30;
  keycap(s, keys, y + height - 2, "enter", "make it");
  keycap(s, keys + 17, y + height - 2, "esc", "drop it");
  hits.push({ x, y, width, height, id: "ghost" });
}

export { WORDMARK_WIDTH };
