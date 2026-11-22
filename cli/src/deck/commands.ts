// What the line at the bottom understands. A handful of words that work on anything: a unit or a
// point by name, here or at a moment in the past. Whatever changes the station is shown first and
// waits for enter.
import { ChangeProposedError, type BaskStreamClient, type Json, type PointSnapshot } from "@basidekick/baskstream";
import { parseDuration, parseTime, parseValue } from "../format.js";
import { P } from "./brand.js";
import { agoText, full } from "./draw.js";
import type { Site, SitePoint, Unit } from "./site.js";
import { LENSES, unitOf, type DeckEvent, type Ghost, type Lens, type ResultLine, type Zoom } from "./view.js";
import { explain, type Why } from "../why.js";
import { UNSURE, type ModelReview, type ModelServes } from "../model.js";

export interface CommandContext {
  client: BaskStreamClient;
  site?: Site;
  zoom: Zoom;
  focus?: string;
  writes: boolean;
  lens: Lens;
  values: Map<string, PointSnapshot>;
  events: DeckEvent[];
  span: { from: number; to: number };
  at?: number;
  say(text: string, tone?: "info" | "good" | "warn" | "bad"): void;
  show(title: string, lines: ResultLine[]): void;
  /** Keeps what a person settled about the map (on this computer) and redraws from it. */
  settle(review: ModelReview, tiles: Record<string, string>): string;
  tiles: Record<string, string>;
  /** Opens the answer to "why" in place of the map. */
  answer(why: Why): void;
  propose(ghost: Ghost & { make: () => Promise<string | void> }): void;
  open(ord: string): void;
  back(): void;
  setLens(lens: Lens): void;
  setAt(ms: number | undefined): void;
  quit(): void;
  classic?: () => void;
}

export const VERBS = ["why", "log", "get", "ls", "set", "override", "release", "diff", "go", "at", "now", "lens", "approve", "reject", "review", "accept", "feeds", "show", "keys", "classic", "quit"];

const plain = (text: string, fg?: string, bold?: boolean): ResultLine => ({ parts: [{ text, fg, bold }] });
const flat = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The unit a name means: exact first, then one that starts with it, then one that holds it. */
export function findUnit(site: Site | undefined, name: string): Unit | undefined {
  if (!site || !name) return undefined;
  const want = flat(name);
  const exact = site.units.find((u) => u.ord === name || flat(u.name) === want);
  if (exact) return exact;
  const starts = site.units.filter((u) => flat(u.name).startsWith(want));
  if (starts.length === 1) return starts[0];
  const holds = site.units.filter((u) => flat(u.name).includes(want));
  return holds.length === 1 ? holds[0] : undefined;
}

/** The point some words mean: a full ORD, "unit/point", "unit point", or a point of the unit being looked at. */
export function findPoint(ctx: CommandContext, words: string[]): { unit: Unit; point: SitePoint } | undefined {
  const site = ctx.site;
  if (!site || !words.length) return undefined;
  const text = words.join(" ");
  for (const unit of site.units) {
    const point = unit.points.find((p) => p.ord === text);
    if (point) return { unit, point };
  }
  const inUnit = (unit: Unit | undefined, name: string) => {
    if (!unit || !name) return undefined;
    const want = flat(name);
    const point = unit.points.find((p) => flat(p.name) === want) ?? unit.points.find((p) => flat(p.label) === want) ?? (() => {
      const some = unit.points.filter((p) => flat(p.name).includes(want) || flat(p.label).includes(want));
      return some.length === 1 ? some[0] : undefined;
    })();
    return point ? { unit, point } : undefined;
  };
  const here = ctx.zoom.level === "site" ? unitOf(site, ctx.focus) : unitOf(site, ctx.zoom.unit);
  const split = text.split(/[\/ ]+/);
  for (let i = split.length - 1; i >= 1; i -= 1) {
    const found = inUnit(findUnit(site, split.slice(0, i).join(" ")), split.slice(i).join(" "));
    if (found) return found;
  }
  return inUnit(here, text);
}

/** "3h", "yesterday", "mon", "tue 2pm", an ISO date: a moment, at or before now. */
export function parseMoment(text: string, now = Date.now()): number {
  const t = text.trim().toLowerCase().replace(/^@/, "");
  const clockOf = (word: string | undefined): [number, number] | undefined => {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(word ?? "");
    if (!m) return undefined;
    let h = Number(m[1]);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return [h, Number(m[2] ?? 0)];
  };
  const [first, ...rest] = t.split(/[\s-]+/);
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const day = days.findIndex((d) => first.startsWith(d));
  const base = new Date(now);
  if (first === "yesterday" || first === "today" || day >= 0) {
    if (first === "yesterday") base.setDate(base.getDate() - 1);
    else if (day >= 0) base.setDate(base.getDate() - (((base.getDay() - day + 7) % 7) || (rest.length ? 0 : 7)));
    const time = clockOf(rest.join("")) ?? [12, 0];
    base.setHours(time[0], time[1], 0, 0);
    if (base.getTime() > now) base.setDate(base.getDate() - 7);
    return base.getTime();
  }
  const time = clockOf(t.replace(/\s/g, ""));
  if (time && /am|pm|:/.test(t)) {
    base.setHours(time[0], time[1], 0, 0);
    if (base.getTime() > now) base.setDate(base.getDate() - 1);
    return base.getTime();
  }
  return parseTime(t, now);
}

function eventLines(events: DeckEvent[], now: number): ResultLine[] {
  if (!events.length) return [plain("Nothing in this span.", P.ink3)];
  return [...events].sort((a, b) => b.at - a.at).slice(0, 200).map((e) => {
    const [mark, fg] = e.kind === "alarm" ? ["▲", P.alarm] : e.kind === "override" ? ["━", P.hand] : e.agent ? ["◆", P.cyan] : ["●", P.ink];
    const when = new Date(e.at);
    const stamp = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][when.getDay()]} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    return { parts: [{ text: `${stamp}  `, fg: P.ink3 }, { text: `${mark} `, fg }, { text: e.text, fg: P.ink2 }, { text: e.kind === "override" && e.until === undefined ? `  still in hand, ${agoText(now - e.at)}` : "", fg: P.hand }] };
  });
}

const KEYS: [string, string][] = [
  ["← ↑ ↓ →", "move over the map"], ["enter", "open what the cursor is on; on a point, ask why"], ["esc", "back out"], ["l  1-5", "change the lens"],
  ["tab", "the time bar: ← → move, < > jump to the next thing that happened"], [", .", "step through time from anywhere"], ["[ ]", "a day, a week or a month of time"], ["n", "back to now"],
  [":", "the command line"], ["W", "allow changes from this window (twice)"], ["c", "the older dashboard with its twelve views"], ["q", "quit"]
];
const WORDS: [string, string][] = [
  ["AHU_02", "a unit's name goes to it"], ["why <point>", "what is driving a value: what commands it, what changed, when it turned"], ["log [unit]", "people, agents, alarms and overrides in one list"],
  ["get <unit>", "its readings, now or at the moment the time bar is on"], ["set <point> <value>", "shows the change, then asks"], ["override <point> <value> [for 30m]", "put a point in hand"], ["release <point>", "back to automatic"],
  ["at tue 2pm", "look at a moment; now comes back"], ["approve P7 · reject P7", "a change an agent asked for"],
  ["review · accept", "look at, and keep, the guesses about what feeds what"], ["feeds AHU_01 VAV_101..VAV_108", "say what feeds what yourself"], ["show Airflow on vav", "choose the reading a kind of unit shows on its tile"]
];

export async function runCommand(line: string, ctx: CommandContext): Promise<void> {
  const [verb, ...args] = line.trim().split(/\s+/);
  const rest = args.join(" ");
  const word = verb.toLowerCase();
  const site = ctx.site;
  const now = ctx.span.to;

  if (word === "q" || word === "quit" || word === "exit") return ctx.quit();
  if (word === "keys" || word === "help" || word === "?") {
    return ctx.show("Keys and words", [
      ...KEYS.map(([key, what]) => ({ parts: [{ text: key.padEnd(12), fg: P.ink, bold: true }, { text: what, fg: P.ink2 }] })),
      plain(""), plain("ON THE COMMAND LINE", P.ink3),
      ...WORDS.map(([key, what]) => ({ parts: [{ text: key.padEnd(36), fg: P.accentMark }, { text: what, fg: P.ink2 }] }))
    ]);
  }
  if (word === "classic") return ctx.classic ? ctx.classic() : ctx.say("The older dashboard is not available here: run bask tui.", "warn");
  if (word === "now") return ctx.setAt(undefined);
  if (word === "at" || verb.startsWith("@")) {
    const at = parseMoment(word === "at" ? rest : line, now);
    if (at < ctx.span.from) return ctx.say("That is before the time bar's span. Press ] for a longer one.", "warn");
    return ctx.setAt(at >= now ? undefined : at);
  }
  if (word === "lens" || (LENSES as string[]).includes(word)) {
    const lens = (word === "lens" ? rest.toLowerCase() : word) as Lens;
    if (!LENSES.includes(lens)) return ctx.say(`The lenses are ${LENSES.join(", ")}.`, "warn");
    return ctx.setLens(lens);
  }
  if (word === "back" || word === "up" || word === "site") return ctx.back();
  if (word === "go" || word === "open") {
    const unit = findUnit(site, rest);
    return unit ? ctx.open(unit.ord) : ctx.say(`Nothing on the map is called "${rest}".`, "warn");
  }

  if (word === "log") {
    const unit = rest ? findUnit(site, rest) : ctx.zoom.level === "site" ? undefined : unitOf(site, ctx.zoom.unit);
    if (rest && !unit) return ctx.say(`Nothing on the map is called "${rest}".`, "warn");
    const events = ctx.events.filter((e) => e.at >= ctx.span.from && (!unit || (e.ord && (e.ord === unit.ord || e.ord.startsWith(`${unit.ord}/`)))));
    return ctx.show(unit ? `What happened to ${unit.name}` : "What happened", eventLines(events, now));
  }

  if (word === "get" || word === "ls") {
    const unit = rest ? findUnit(site, rest) : unitOf(site, ctx.zoom.level === "site" ? ctx.focus : ctx.zoom.unit);
    if (!unit) return ctx.say(rest ? `Nothing on the map is called "${rest}".` : "Name a unit: get AHU_01.", "warn");
    const width = Math.max(...unit.points.map((p) => p.name.length), 8);
    return ctx.show(`${unit.name}${ctx.at !== undefined ? `, as it was ${agoText(now - ctx.at)} ago` : ""}`, unit.points.map((p) => ({ parts: [{ text: p.name.padEnd(width + 2), fg: P.ink2 }, { text: full(ctx.values.get(p.ord)).padEnd(14), fg: P.ink, bold: true }, { text: p.label === "unknown" ? "" : p.label, fg: P.ink3 }] })));
  }

  if (word === "why") {
    const found = findPoint(ctx, args) ?? (() => {
      const unit = findUnit(site, rest);
      return unit?.headline ? { unit, point: unit.headline } : undefined;
    })();
    if (!found) return ctx.say(rest ? `No point matches "${rest}".` : "Name a point: why VAV_105 ZoneTemp.", "warn");
    ctx.say(`Working out what is driving ${found.unit.name} ${found.point.name}…`);
    return ctx.answer(await explain(ctx.client, found.point.ord, { at: ctx.at, serves: ctx.site?.review.serves, equipment: found.unit.ord }));
  }

  if (word === "set" || word === "override" || word === "release" || word === "auto") {
    const release = word === "release" || word === "auto";
    const forAt = args.findIndex((a) => a.toLowerCase() === "for");
    const duration = forAt > 0 && args[forAt + 1] ? parseDuration(args[forAt + 1]) : undefined;
    const body = forAt > 0 ? args.slice(0, forAt) : args;
    const valueText = release ? undefined : body[body.length - 1];
    const found = findPoint(ctx, release ? body : body.slice(0, -1));
    if (!found || (!release && valueText === undefined)) return ctx.say(release ? "Name the point to release: release SupplyFanSpeed." : `Name a point and a value: ${word} ZoneSetpoint 71.`, "warn");
    if (!found.point.writable) return ctx.say(`${found.point.name} is not a point that can be commanded.`, "warn");
    if (!ctx.writes) return ctx.say("This window is read-only. Press W twice to allow changes, then try again.", "warn");
    const value = release ? undefined : parseValue(valueText!);
    const before = full(ctx.values.get(found.point.ord));
    const action = release ? "auto" : word;
    return ctx.propose({
      id: "", from: "you", agent: false,
      lines: [{ verb: release ? "release" : word, what: `${found.unit.name} ${found.point.name}`, before, after: release ? "automatic" : `${String(value)}${found.point.unit ? ` ${found.point.unit}` : ""}` }],
      note: release ? "The point goes back to whatever commands it automatically." : word === "override" ? `In hand${duration ? ` for ${args[forAt + 1]}, then released by the station` : " until someone releases it"}.` : "Sets the point's own value. A higher priority, such as an override, still wins.",
      make: async () => {
        try {
          const done = await ctx.client.write(found.point.ord, action, value, { ...(duration ? { durationSec: Math.round(duration / 1000) } : {}), reason: `${word} from the bask screen` } as Json);
          return `${found.unit.name} ${found.point.name} now reads ${full(done)}.`;
        } catch (error) {
          if (error instanceof ChangeProposedError) return `That change waits for a person to approve it${error.proposal?.id ? ` (${error.proposal.id})` : ""}.`;
          throw error;
        }
      }
    });
  }

  if (word === "approve" || word === "reject") {
    const id = (args[0] ?? "").toUpperCase();
    if (!id) return ctx.say(`Which one? ${word} P7.`, "warn");
    if (!ctx.writes) return ctx.say("This window is read-only. Press W twice to allow changes, then try again.", "warn");
    const proposal = (await ctx.client.proposals()).find((p) => p.id.toUpperCase() === id);
    if (!proposal) return ctx.say(`No change called ${id} is waiting.`, "warn");
    return ctx.propose({
      id: proposal.id, from: proposal.actor?.name ?? proposal.agentUser, agent: true,
      lines: [{ verb: word, what: proposal.description }],
      note: proposal.reason ? `Its reason: ${proposal.reason}` : undefined,
      make: async () => {
        if (word === "approve") await ctx.client.approveProposal(proposal.id);
        else await ctx.client.rejectProposal(proposal.id, args.slice(1).join(" ") || undefined);
        return word === "approve" ? `${proposal.id} approved and made.` : `${proposal.id} rejected.`;
      }
    });
  }

  // ---- Setting the map up: what feeds what, and what each tile shows. Kept on this computer. ----------
  if (word === "review" || word === "guesses") {
    const open = (site?.review.serves ?? []).filter((e) => e.inferred && !e.confirmed && e.medium === "air");
    if (!open.length) return ctx.say("No guesses are waiting. Say what feeds what with: feeds AHU_01 VAV_101..VAV_108", "info");
    const feeders = [...new Set(open.map((e) => e.fromName))];
    const lines: ResultLine[] = [
      plain("These are guesses from names, folders and links. Nothing here is written to the station.", P.ink3), plain(""),
      ...feeders.flatMap((feeder) => {
        const mine = open.filter((e) => e.fromName === feeder);
        const sure = mine.filter((e) => e.confidence >= UNSURE).length;
        return [
          { parts: [{ text: feeder.padEnd(18), fg: P.ink, bold: true }, { text: `feeds ${mine.length}`, fg: P.ink2 }, { text: `   ${sure} fairly sure, ${mine.length - sure} unsure`, fg: P.ink3 }] },
          plain(`  ${mine.map((e) => e.toName).join("  ")}`, P.ink2), plain(`  ${mine[0].reason}`, P.ink3)
        ];
      }),
      plain(""), plain("accept", P.accentMark, true), plain("  keeps the ones that are fairly sure", P.ink3), plain("accept all  ·  accept AHU_02", P.accentMark, true), plain("  keeps every guess, or every guess about one unit", P.ink3),
      plain("feeds AHU_01 VAV_101..VAV_108", P.accentMark, true), plain("  says it yourself: a unit, a list of units, or a run of them", P.ink3)
    ];
    return ctx.show(`${open.length} guesses about what feeds what`, lines);
  }
  if (word === "accept") {
    if (!site) return;
    const which = rest.toLowerCase();
    const feeder = which && which !== "all" ? findUnit(site, rest) : undefined;
    if (which && which !== "all" && !feeder) return ctx.say(`Nothing on the map is called "${rest}".`, "warn");
    let kept = 0;
    const serves = (site.review.serves ?? []).map((e) => {
      const take = e.inferred && !e.confirmed && (feeder ? e.from === feeder.ord : which === "all" || e.confidence >= UNSURE);
      if (take) kept += 1;
      return take ? { ...e, confirmed: true } : e;
    });
    if (!kept) return ctx.say(which ? "No guess matched." : "None of the guesses is sure enough to keep without a look: try review.", "warn");
    const file = ctx.settle({ ...site.review, serves }, ctx.tiles);
    return ctx.say(`Kept ${kept}. Saved on this computer in ${file}`, "good");
  }
  if (word === "feeds") {
    if (!site) return;
    const feeder = findUnit(site, args[0] ?? "");
    if (!feeder || args.length < 2) return ctx.say("Name what feeds, then what it feeds: feeds AHU_01 VAV_101..VAV_108", "warn");
    const fed: Unit[] = [];
    for (const token of args.slice(1)) {
      const [a, b] = token.split("..");
      if (b === undefined) {
        const unit = findUnit(site, a);
        if (!unit) return ctx.say(`Nothing on the map is called "${a}".`, "warn");
        fed.push(unit);
        continue;
      }
      // A run: every unit between the two names, in name order.
      const first = findUnit(site, a);
      const last = findUnit(site, b) ?? findUnit(site, a.replace(/\d+$/, "") + b);
      const i = first ? site.units.indexOf(first) : -1;
      const j = last ? site.units.indexOf(last) : -1;
      if (i < 0 || j < 0) return ctx.say(`"${token}" is not a run of units on the map.`, "warn");
      fed.push(...site.units.slice(Math.min(i, j), Math.max(i, j) + 1));
    }
    const targets = new Set(fed.map((u) => u.ord));
    const mine: ModelServes[] = fed.map((unit) => ({ from: feeder.ord, fromName: feeder.name, to: unit.ord, toName: unit.name, medium: "air", confidence: 1, reason: "a person said so", confirmed: true, inferred: true }));
    const serves = [...(site.review.serves ?? []).filter((e) => !(e.medium === "air" && targets.has(e.to))), ...mine];
    const file = ctx.settle({ ...site.review, serves }, ctx.tiles);
    return ctx.say(`${feeder.name} feeds ${fed.length} ${fed.length === 1 ? "unit" : "units"}. Saved on this computer in ${file}`, "good");
  }
  if (word === "show") {
    if (!site) return;
    // show Airflow on vav · show Airflow (for the kind of unit the cursor is on)
    const on = args.findIndex((a) => a.toLowerCase() === "on");
    const pointName = (on > 0 ? args.slice(0, on) : args).join("");
    const here = unitOf(site, ctx.zoom.level === "site" ? ctx.focus : ctx.zoom.unit);
    const target = on > 0 ? args.slice(on + 1).join(" ") : here?.kind ?? "";
    const kind = site.units.find((u) => u.kind.toLowerCase() === target.toLowerCase() || flat(u.label) === flat(target))?.kind;
    const one = kind ? undefined : findUnit(site, target);
    const sample = kind ? site.units.find((u) => u.kind === kind) : one;
    const point = sample?.points.find((p) => flat(p.name) === flat(pointName)) ?? sample?.points.find((p) => flat(p.label) === flat(pointName));
    if (!sample || !point) return ctx.say("Name a point and a kind of unit: show Airflow on vav. The kinds here are " + [...new Set(site.units.map((u) => u.kind))].join(", ") + ".", "warn");
    const tiles = { ...ctx.tiles, [kind ?? one!.ord]: point.name };
    const file = ctx.settle(site.review, tiles);
    return ctx.say(`${kind ? `Every ${sample.label}` : sample.name} now shows ${point.name}. Saved on this computer in ${file}`, "good");
  }

  if (word === "diff" || word === "test" || word === "apply") {
    return ctx.say(`${word} runs from the shell for now: bask ${line}`, "info");
  }

  // Not a word it knows: a unit's name goes to it; anything longer is a question.
  const unit = findUnit(site, line);
  if (unit) return ctx.open(unit.ord);
  if (args.length >= 2 || /\?$/.test(line)) return ctx.say("No AI is connected to this window. Try why <point>, log <unit> or get <unit>; press ? for the list.", "warn");
  ctx.say(`"${line}" is not a unit on the map or a word bask knows. Press ? for the list.`, "warn");
}

/** Finishes the word being typed: a verb first, then a unit's or a point's name. */
export function complete(text: string, ctx: CommandContext): string | undefined {
  const words = text.split(/\s+/);
  const last = words[words.length - 1] ?? "";
  const names = words.length === 1
    ? [...VERBS, ...LENSES, ...(ctx.site?.units.map((u) => u.name) ?? [])]
    : [...(ctx.site?.units.map((u) => u.name) ?? []), ...(unitOf(ctx.site, ctx.zoom.level === "site" ? ctx.focus : ctx.zoom.unit)?.points.map((p) => p.name) ?? [])];
  const want = last.toLowerCase();
  const some = [...new Set(names.filter((name) => name.toLowerCase().startsWith(want)))];
  if (!some.length) return undefined;
  let common = some[0];
  for (const name of some) while (!name.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1);
  if (common.length <= last.length && some.length > 1) return undefined;
  return [...words.slice(0, -1), some.length === 1 ? `${some[0]} ` : common].join(" ");
}
