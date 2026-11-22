// The answer to "why": the chain from a reading back to what is driving it, drawn as rows with their
// small charts, most likely cause first. It states what was found and what was not; it does not guess.
import { P, mix } from "./brand.js";
import { bounds, brailleLine, resample } from "../tui/chart.js";
import type { Surface, Rect, Style } from "./surface.js";
import type { DeckView, Hit } from "./view.js";
import type { Why, WhyChange } from "../why.js";

export interface Answer {
  why: Why;
  /** The change nearest the turn that a person made and that can be put back: the point, and its value before. */
  undo?: { ord: string; name: string; from: string; to: string; value: string; by?: string; at: number };
  scroll: number;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${DAYS[d.getDay()]} ${d.getDate()}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const gap = (ms: number) => {
  const minutes = Math.round(Math.abs(ms) / 60000);
  const text = minutes < 1 ? "the same minute" : minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  return minutes < 1 ? text : `${text} ${ms < 0 ? "before" : "after"}`;
};
const short = (ord: string) => ord.split("/").filter((part) => part !== "points").slice(-2).join(" ");

/** The change a person made beside the turn that could be put back: it has a value before and after, on a point. */
export function undoOf(why: Why): Answer["undo"] {
  const near = (why.changes ?? []).filter((c: WhyChange) => c.near && !c.event.agent && c.event.kind === "change" && c.event.ord && c.event.from && c.event.to);
  const pick = near.sort((a, b) => Math.abs(a.gapMs ?? 0) - Math.abs(b.gapMs ?? 0))[0];
  if (!pick) return undefined;
  const value = /-?\d+(?:\.\d+)?/.exec(pick.event.from!)?.[0] ?? pick.event.from!;
  return { ord: pick.event.ord!, name: short(pick.event.ord!), from: pick.event.from!, to: pick.event.to!, value, by: pick.event.who, at: pick.event.at };
}

interface Row {
  /** A dim line that says how this row hangs off the one above. */
  link?: string;
  name?: string;
  value?: string;
  valueFg?: string;
  /** The points's ORD, to chart it when its history is at hand. */
  chart?: string;
  mid?: [string, Style?][];
  note?: [string, Style?][];
  /** A whole line of words in place of the columns. */
  text?: [string, Style?][];
}

function rowsOf(why: Why): Row[] {
  const rows: Row[] = [];
  const stateFg = (state: string | undefined) => (state === "alarm" ? P.alarm : state === "overridden" ? P.hand : /fault|down|stale/.test(state ?? "") ? P.fault : P.ink);
  rows.push({
    name: why.name.replace("/", " "), value: why.value?.display ?? "--", valueFg: stateFg(why.value?.state), chart: why.ord,
    note: why.turn ? [["turned ", { fg: P.ink3 }], [when(why.turn.at), { fg: P.ink, bold: true }], [`  ${why.turn.beforeText} → ${why.turn.afterText}`, { fg: P.ink2 }]] : why.steady ? [["held its level over the span", { fg: P.ink3 }]] : [["no history to look back over", { fg: P.ink3 }]]
  });
  const forced = why.command && (why.command.held === "override" || why.command.held === "emergency") ? why.command : undefined;
  if (forced) rows.push({ link: "↑ held there by", name: forced.held === "emergency" ? "an emergency override" : "an override", value: forced.display, valueFg: P.hand, note: [[forced.by ? `set by ${forced.by}` : "who set it is not in the audit log", { fg: P.ink2 }], [forced.since ? `, ${when(forced.since)}` : "", { fg: P.ink3 }]] });
  for (const c of (why.changes ?? []).filter((x) => x.near)) {
    rows.push({
      link: `↑ changed ${gap(c.gapMs ?? 0)}, on the same unit`, name: c.event.ord ? short(c.event.ord) : c.event.text, value: c.event.to ?? "",
      mid: c.event.from && c.event.to ? [["● ", { fg: c.event.agent ? P.cyan : P.ink }], [c.event.from, { fg: P.ink3 }], [" → ", { fg: P.ink3 }], [c.event.to, { fg: P.accentMark, bold: true }]] : [[c.event.text, { fg: P.ink2 }]],
      note: [["by ", { fg: P.ink3 }], [c.event.who ?? "someone", { fg: c.event.agent ? P.cyan : P.ink, bold: true }], [`, ${when(c.event.at)}`, { fg: P.ink3 }]]
    });
  }
  if (why.turn && why.changes && !why.changes.some((c) => c.near)) rows.push({ link: "↑ nothing was changed on the same unit within 30 minutes of that" });
  for (const s of why.siblings ?? []) rows.push({ link: `↑ turned ${gap(s.gapMs)}, on the same unit`, name: short(s.ord), value: s.afterText, chart: s.ord, note: [[`${s.beforeText} → ${s.afterText}`, { fg: P.ink2 }]] });
  if (why.command && !forced) rows.push({ link: "↑ commanded by", name: why.command.source?.name ?? (why.command.held === "fallback" ? "its own set value" : `level ${why.command.level}`), value: why.command.display, note: [[why.command.held === "fallback" ? "no input or override is active" : `through ${why.command.slot}`, { fg: P.ink3 }]] });
  for (const feed of (why.feeds ?? []).filter((f) => f.depth > 1 || !why.command?.source)) rows.push({ link: `${"  ".repeat(feed.depth - 1)}↑ through a link`, name: feed.name, value: feed.display, valueFg: stateFg(feed.state) });
  for (const unit of why.upstream ?? []) {
    const head = `↑ ${unit.depth === 1 ? "fed" : `${unit.feedsName} is fed`} ${unit.medium === "air" ? "air" : unit.medium === "chilledWater" ? "chilled water" : "hot water"} by ${unit.name}${unit.confirmed ? "" : " (a guess nobody has confirmed)"}`;
    if (!unit.issues.length) rows.push({ link: `${head}: nothing wrong on its ${unit.points} points` });
    unit.issues.forEach((issue, i) => rows.push({
      link: i === 0 ? head : undefined, name: short(issue.ord), value: issue.display, valueFg: stateFg(issue.states[0]), chart: issue.turn ? issue.ord : undefined,
      note: [[issue.states.map((state) => (state === "overridden" ? "in hand" : state)).join(", "), { fg: stateFg(issue.states[0]) }], [issue.turn ? `   turned ${gap(issue.turn.gapMs)}` : "", { fg: P.ink3 }]]
    }));
  }
  if (!why.upstream) rows.push({ link: "↑ what feeds this unit is not known, so nothing upstream was looked at" });
  for (const note of why.notes) rows.push({ text: [["not known  ", { fg: P.ink3 }], [note, { fg: P.ink3 }]] });
  return rows;
}

function put(s: Surface, x: number, y: number, parts: [string, Style?][], width: number, bg: string): void {
  let used = 0;
  for (const [text, style] of parts) {
    if (used >= width) break;
    used += s.put(x + used, y, text, { ...style, bg }, width - used);
  }
}

/** Draws the answer over the map's place. Returns nothing; the keys are in the hints row. */
export function drawAnswer(s: Surface, view: DeckView, answer: Answer, body: Rect, hits: Hit[]): void {
  const { why } = answer;
  s.fill(body, P.panel);
  const x = body.x + 2;
  const width = body.width - 4;
  let y = body.y + (body.height >= 20 ? 1 : 0);
  s.put(x, y, " WHY ", { fg: P.accentInk, bg: P.accent, bold: true });
  s.put(x + 6, y, `${why.name.replace("/", " ")} reads ${why.value?.display ?? "--"}`, { fg: P.ink, bold: true }, width - 30);
  s.putRight(x + width, y, why.live ? "as it is now" : `as it was ${when(why.at)}`, { fg: P.ink3 });
  y += 2;
  const rows = rowsOf(why);
  const nameW = Math.min(30, Math.max(18, Math.floor(width * 0.24)));
  const valueW = 12;
  const midW = Math.max(14, Math.min(30, Math.floor(width * 0.22)));
  const noteX = x + nameW + valueW + midW + 3;
  const room = body.y + body.height - y - (answer.undo ? 5 : 1);
  // Each row takes a line, plus one for the words that hang it off the row above.
  let line = 0;
  let drawn = 0;
  for (const row of rows.slice(answer.scroll)) {
    const needs = (row.link ? 1 : 0) + (row.name || row.text ? 1 : 0);
    if (line + needs > room) break;
    if (row.link) s.putClipped(x + 2, y + line++, row.link, { fg: P.ink3, bg: P.panel }, width - 2);
    if (row.text) put(s, x, y + line++, row.text, width, P.panel);
    else if (row.name) {
      const at = y + line++;
      s.put(x, at, row.name, { fg: P.ink, bg: P.panel, bold: true }, nameW);
      s.put(x + nameW + 1, at, row.value ?? "", { fg: row.valueFg ?? P.ink, bg: P.panel, bold: true }, valueW);
      const series = row.chart ? view.series.get(row.chart) : undefined;
      if (row.mid) put(s, x + nameW + valueW + 2, at, row.mid, midW, P.panel);
      else if (series && series.length > 1) {
        const [min, max] = bounds(series);
        s.put(x + nameW + valueW + 2, at, brailleLine(resample(series, midW * 2), midW, 1, min, max)[0], { fg: row.valueFg && row.valueFg !== P.ink ? row.valueFg : P.accentMark, bg: P.panel });
        // Where it turned, as a tick on its chart.
        if (why.turn) {
          const k = (why.turn.at - view.span.from) / (view.span.to - view.span.from);
          if (k > 0 && k < 1) s.put(x + nameW + valueW + 2 + Math.round(k * (midW - 1)), at, "╎", { fg: P.ink, bg: P.panel });
        }
      }
      if (row.note) put(s, noteX, at, row.note, x + width - noteX, P.panel);
    }
    drawn += 1;
  }
  if (answer.scroll + drawn < rows.length) s.putRight(x + width, body.y + body.height - 1, `${rows.length - answer.scroll - drawn} more below`, { fg: P.ink3, bg: P.panel });
  // What could be put back, as an offer. It is a fact about what changed, not a diagnosis.
  if (answer.undo) {
    const u = answer.undo;
    const top = body.y + body.height - 4;
    const bg = mix(P.panel2, P.cyan, 0.08);
    s.fill({ x, y: top, width, height: 3 }, bg);
    for (let i = 0; i < width; i += 1) s.put(x + i, top, "╌", { fg: P.cyan, bg });
    put(s, x + 2, top + 1, [["could be put back  ", { fg: P.cyan, bold: true }], [u.name, { fg: P.ink, bold: true }], ["   ", {}], [u.to, { fg: P.ink3 }], [" → ", { fg: P.ink3 }], [u.from, { fg: P.accentMark, bold: true }]], width - 22, bg);
    s.put(x + width - 18, top + 1, " f ", { fg: P.ink2, bg: P.name === "light" ? P.well : P.chassis });
    s.put(x + width - 14, top + 1, "put it back", { fg: P.ink3, bg });
    s.putClipped(x + 2, top + 2, `It was changed by ${u.by ?? "someone"} ${when(u.at)}. Whether that was meant is for you to say.`, { fg: P.ink3, bg }, width - 4);
    hits.push({ x, y: top, width, height: 3, id: "undo" });
  }
}
