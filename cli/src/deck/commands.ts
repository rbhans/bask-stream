// What the line at the bottom understands. A handful of words that work on anything: a unit or a
// point by name, here or at a moment in the past. Whatever changes the station is shown first and
// waits for enter.
import { ChangeProposedError, type BaskStreamClient, type Json, type PointSnapshot } from "@basidekick/baskstream";
import { parseDuration, parseTime, parseValue } from "../format.js";
import { P } from "./brand.js";
import { agoText, full } from "./draw.js";
import { ARRANGES, ARRANGE_KEY, type Arrange, type Site, type SitePoint, type Unit } from "./site.js";
import { SHELL_COMMANDS, SHELL_OWN_WINDOW, changes, runBask, words } from "./shell.js";
import { LENSES, unitOf, type DeckEvent, type Ghost, type Lens, type Result, type ResultLine, type Zoom } from "./view.js";
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
  show(title: string, lines: ResultLine[], more?: Pick<Result, "keys" | "hint" | "again">): void;
  /** Puts words on the command line and the cursor after them, for a command that still needs a value. */
  ask(text: string): void;
  /** The card that is open has nothing left to show: back to the list it came from, or closed. */
  done(): void;
  setWrites(on: boolean): void;
  /** The saved station this window is on, for commands run as their own bask process. */
  profile: string;
  /** Keeps what a person settled about the map (on this computer) and redraws from it. */
  settle(review: ModelReview, tiles: Record<string, string>): string;
  tiles: Record<string, string>;
  /** Opens the answer to "why" in place of the map. */
  answer(why: Why): void;
  propose(ghost: Ghost & { make: () => Promise<string | void> }): void;
  /** Opens a unit; with a point, puts the cursor on it. */
  open(ord: string, point?: string): void;
  back(): void;
  setLens(lens: Lens): void;
  setAt(ms: number | undefined): void;
  quit(): void;
  classic?: () => void;
}

export const VERBS = ["why", "log", "get", "ls", "set", "override", "release", "go", "at", "now", "lens", "needs", "alarms", "ack", "clear", "readonly", "places", "where", "arrange", "approve", "reject", "review", "accept", "feeds", "show", "bask", "keys", "classic", "quit"];

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
    const [mark, fg] = e.kind === "alarm" ? ["▲", P.alarm] : e.kind === "override" ? ["━", P.hand] : e.kind === "note" ? ["✎", P.ok] : e.agent ? ["◆", P.cyan] : ["●", P.ink];
    const when = new Date(e.at);
    const stamp = `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][when.getDay()]} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    return { parts: [{ text: `${stamp}  `, fg: P.ink3 }, { text: `${mark} `, fg }, { text: e.text, fg: P.ink2 }, { text: e.kind === "override" && e.until === undefined ? `  still in hand, ${agoText(now - e.at)}` : "", fg: P.hand }] };
  });
}

const KEYS: [string, string][] = [
  ["← ↑ ↓ →", "move over the map, and onto what waits beside it"], ["enter", "open what the cursor is on: a unit's page, or what can be done to a point, an alarm or a change that waits"], ["esc", "back out"],
  ["i", "what needs you, in one list: changes that wait, alarms, points in hand"], ["l  1-5", "change the lens"],
  ["tab", "the time bar: ← → move, < > jump to the next thing that happened"], [", .", "step through time from anywhere"], ["[ ]", "a day, a week or a month of time"], ["n", "back to now"],
  ["g", "lay the map out by what feeds what, by building and floor, or by type"],
  [":", "the command line"], ["c", "the older dashboard with its twelve views"], ["q", "quit"]
];
const WORDS: [string, string][] = [
  ["AHU_02", "a unit's name goes to it"], ["why <point>", "what is driving a value: what commands it, what changed, when it turned"], ["log [unit]", "people, agents, alarms and overrides in one list"],
  ["get <unit>", "its readings, now or at the moment the time bar is on"], ["set <point> <value>", "shows the change, then asks"], ["override <point> <value> [for 30m]", "put a point in hand"], ["release <point>", "back to automatic"],
  ["at tue 2pm", "look at a moment; now comes back"], ["approve P7 · reject P7", "a change an agent asked for"],
  ["needs [unit] · alarms [unit]", "what needs you as a list; enter on a line shows what can be done"], ["ack AHU_03 · ack all", "acknowledge a unit's alarms, or every one"],
  ["readonly", "stop allowing changes from this window; the next change asks again"],
  ["places · where VAV_01", "the buildings, floors and rooms, and what is in each"], ["arrange place", "lay the map out by feeds, place or kind"],
  ["bask <anything>", "any bask command, run here: bask history …, bask check, bask query …, bask px …"],
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
  // "alarms" alone is the list of alarms; the lens of that name is "lens alarms" or the 2 key.
  if (word === "lens" || ((LENSES as string[]).includes(word) && word !== "alarms")) {
    const lens = (word === "lens" ? rest.toLowerCase() : word) as Lens;
    if (!LENSES.includes(lens)) return ctx.say(`The lenses are ${LENSES.join(", ")}.`, "warn");
    return ctx.setLens(lens);
  }
  if (word === "back" || word === "up" || word === "site") return ctx.back();
  if (word === "go" || word === "open") {
    const unit = findUnit(site, rest);
    return unit ? ctx.open(unit.ord) : ctx.say(`Nothing on the map is called "${rest}".`, "warn");
  }
  if (word === "goto") {
    // An ORD: the unit it belongs to, with the cursor on the point.
    const unit = site?.units.find((u) => rest === u.ord || rest.startsWith(`${u.ord}/`));
    if (!unit) return ctx.say("That is not on the map. It may be the device or the network itself.", "warn");
    return ctx.open(unit.ord, unit.points.find((p) => rest === p.ord || rest.startsWith(`${p.ord}/`))?.ord);
  }

  // ---- Alarms: the list, and acknowledging -------------------------------------------------------------
  const owner = (ord: string | undefined) => (ord ? site?.units.find((u) => ord === u.ord || ord.startsWith(`${u.ord}/`)) : undefined);
  const alarmsFor = (which: string): { list: DeckEvent[]; unit?: Unit; label: string } | undefined => {
    const all = ctx.events.filter((e) => e.kind === "alarm" && e.id);
    const w = which.toLowerCase();
    if (!w || w === "all") return { list: all, label: "all" };
    if (w === "active") return { list: all.filter((e) => e.active), label: "active" };
    if (w === "normal") return { list: all.filter((e) => !e.active), label: "normal" };
    // As the cards name them: every alarm on one point, or every one like a given alarm.
    if (which.startsWith("point:")) return { list: all.filter((e) => e.ord === which.slice(6) || e.ord?.startsWith(`${which.slice(6)}/`)), label: which };
    if (which.startsWith("same:")) {
      const one = all.find((e) => e.id === which.slice(5));
      return { list: one ? all.filter((e) => e.ord === one.ord && e.text === one.text) : [], label: which };
    }
    const unit = findUnit(site, which);
    return unit ? { list: all.filter((e) => owner(e.ord) === unit), unit, label: unit.name } : undefined;
  };
  const pointAt = (ord: string | undefined) => owner(ord)?.points.find((p) => ord === p.ord || ord!.startsWith(`${p.ord}/`));
  const whereOf = (ord: string | undefined) => owner(ord)?.name ?? (ord ?? "").split("/").filter((part) => part !== "points").slice(-1)[0] ?? "";
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  /** One line a card can do: its key, what it does, and the command it runs. */
  const action = (key: string, label: string, run: string, note = ""): ResultLine & { key: string } => ({ key, run, parts: [{ text: ` ${key}  `, fg: P.accentMark, bold: true }, { text: label, fg: P.ink, bold: true }, { text: note ? `   ${note}` : "", fg: P.ink3 }] });
  const card = (title: string, about: ResultLine[], actions: (ResultLine & { key: string })[]) =>
    ctx.show(title, [...about, plain(""), ...actions], { again: line, keys: Object.fromEntries(actions.map((a) => [a.key, a.run!])), hint: [["↑↓", "move"], ["enter", "do it"], [actions.map((a) => a.key).join(" "), "or its letter"], ["esc", "back"]] });

  // ---- What needs a person: changes that wait, alarms, points in hand. One list. -------------------------
  if (word === "needs" || word === "alarms" || word === "inbox") {
    const found = alarmsFor(rest);
    if (!found) return ctx.say(`Nothing on the map is called "${rest}". Try ${word}, ${word} active or ${word} AHU_03.`, "warn");
    const mine = (e: DeckEvent) => !found.unit || owner(e.ord) === found.unit;
    const others = word !== "alarms" && (found.label === "all" || !!found.unit);
    const waiting = others ? ctx.events.filter((e) => e.kind === "proposal" && e.id && mine(e)) : [];
    const hand = others ? ctx.events.filter((e) => e.kind === "override" && e.until === undefined && e.ord && mine(e)) : [];
    // The same alarm on the same point many times over is one line with a count.
    const grouped = (list: DeckEvent[]) => {
      const rows = new Map<string, { e: DeckEvent; n: number }>();
      for (const e of [...list].sort((a, b) => b.at - a.at)) {
        const row = rows.get(`${e.ord}|${e.text}`);
        if (row) row.n += 1;
        else rows.set(`${e.ord}|${e.text}`, { e, n: 1 });
      }
      return [...rows.values()].sort((a, b) => Number(!!owner(b.e.ord)) - Number(!!owner(a.e.ord)));
    };
    const active = found.list.filter((e) => e.active);
    const normal = found.list.filter((e) => !e.active && !e.acked);
    const lines: ResultLine[] = [];
    const section = (title: string, n: number, rows: ResultLine[]) => {
      if (!rows.length) return;
      if (lines.length) lines.push(plain(""));
      lines.push({ parts: [{ text: title, fg: P.ink3 }, { text: `  ${n}`, fg: P.ink3 }] }, ...rows);
    };
    const row = (mark: string, fg: string, e: DeckEvent, text: string, run: string): ResultLine => ({
      run, parts: [{ text: `${mark} `, fg }, { text: agoText(now - e.at).padEnd(9), fg: P.ink3 }, { text: whereOf(e.ord).slice(0, 18).padEnd(19), fg: P.ink, bold: true }, { text: (pointAt(e.ord)?.name ?? "").slice(0, 26).padEnd(27), fg: P.ink2 }, { text, fg: P.ink2 }]
    });
    section("WAITS FOR YOU", waiting.length, waiting.map((e) => row("◇", P.cyan, e, `${e.id}  ${e.text}`, `do proposal ${e.id}`)));
    section("IN ALARM", active.length, grouped(active).map(({ e, n }) => row("▲", P.alarm, e, `${e.text}${n > 1 ? `  ×${n}` : ""}`, `do alarm ${e.id}`)));
    section("TO ACKNOWLEDGE", normal.length, grouped(normal).map(({ e, n }) => row("△", P.ink3, e, `${e.text}${n > 1 ? `  ×${n}` : ""}`, `do alarm ${e.id}`)));
    section("IN HAND", hand.length, hand.map((e) => row("━", P.hand, e, `by ${e.who ?? "someone"}`, `do point ${e.ord}`)));
    const parts = [waiting.length ? `${count(waiting.length, "change")} waiting` : "", active.length ? `${active.length} in alarm` : "", normal.length ? `${normal.length} to acknowledge` : "", hand.length ? `${hand.length} in hand` : ""].filter(Boolean);
    const title = `${word === "alarms" ? "Alarms" : "What needs you"}${found.unit ? ` on ${found.unit.name}` : ""}${parts.length ? `  ·  ${parts.join("  ·  ")}` : ""}`;
    if (!lines.length) return ctx.show(title, [plain(found.unit ? "Nothing on this unit needs you." : "Nothing needs you.", P.ink3)], { again: line });
    return ctx.show(title, lines, { again: line, hint: [["↑↓", "move"], ["enter", "what can be done"], ["esc", "close"]] });
  }

  // ---- What can be done to one thing: a point, an alarm, a change that waits ----------------------------
  if (word === "ask") return ctx.ask(`${rest} `);
  if (word === "readonly" || word === "lock") {
    ctx.setWrites(false);
    return ctx.say("This window no longer makes changes. The next one asks first.");
  }
  if (word === "do") {
    const kind = (args[0] ?? "").toLowerCase();
    const id = args.slice(1).join(" ");
    if (kind === "point") {
      const unit = owner(id);
      const point = unit?.points.find((p) => p.ord === id);
      if (!unit || !point) return ctx.done();
      const snapshot = ctx.values.get(point.ord);
      const inHand = String(snapshot?.state ?? "") === "overridden" || /overridden/.test(String(snapshot?.status ?? ""));
      const alarms = ctx.events.filter((e) => e.kind === "alarm" && e.id && pointAt(e.ord) === point);
      const toAck = alarms.filter((e) => !e.acked).length;
      const proposal = ctx.events.find((e) => e.kind === "proposal" && e.id && pointAt(e.ord) === point);
      const name = `${unit.name} ${point.name}`;
      const about: ResultLine[] = [{ parts: [{ text: "reads  ", fg: P.ink3 }, { text: full(snapshot), fg: P.ink, bold: true }, { text: inHand ? "   in hand" : "", fg: P.hand }, { text: point.label !== "unknown" ? `   ${point.label}` : "", fg: P.ink3 }] }];
      if (alarms.length) about.push({ parts: [{ text: alarms.some((e) => e.active) ? "▲ in alarm" : `△ ${count(toAck, "alarm")} to acknowledge`, fg: alarms.some((e) => e.active) ? P.alarm : P.ink2 }] });
      if (!point.writable) about.push(plain("This point is read by the station and cannot be commanded.", P.ink3));
      const actions = [
        ...(proposal ? [action("p", `See the change ${proposal.id} that waits on it`, `do proposal ${proposal.id}`)] : []),
        ...(point.writable ? [action("s", "Set a value…", `ask set ${name}`, "its own value; an override still wins"), action("h", "Put in hand…", `ask override ${name}`, "add \"for 30m\" to have it released")] : []),
        ...(point.writable && inHand ? [action("r", "Release to automatic", `release ${point.ord}`)] : []),
        ...(toAck ? [action("a", `Acknowledge its ${count(toAck, "alarm")}`, `ack point:${point.ord}`)] : []),
        action("w", "Why it reads this", `why ${point.ord}`, "what commands it, what changed, when it turned")
      ];
      return card(`${unit.name}  ·  ${point.name}`, about, actions);
    }
    if (kind === "alarm") {
      const all = ctx.events.filter((e) => e.kind === "alarm" && e.id);
      const one = all.find((e) => e.id === id);
      if (!one) return ctx.done();
      const unit = owner(one.ord);
      const point = pointAt(one.ord);
      const same = all.filter((e) => e.ord === one.ord && e.text === one.text && !e.acked).length;
      const onUnit = unit ? all.filter((e) => owner(e.ord) === unit && !e.acked).length : 0;
      const everywhere = all.filter((e) => !e.acked).length;
      const about: ResultLine[] = [
        { parts: [{ text: one.active ? "▲ still in alarm" : "△ back to normal", fg: one.active ? P.alarm : P.ink2, bold: true }, { text: one.acked ? "   acknowledged" : "   nobody has acknowledged it", fg: P.ink3 }, { text: `   ${agoText(now - one.at)} ago`, fg: P.ink3 }] },
        plain(one.text, P.ink2),
        ...(point ? [{ parts: [{ text: `${point.name} reads  `, fg: P.ink3 }, { text: full(ctx.values.get(point.ord)), fg: P.ink, bold: true }] }] : [])
      ];
      const actions = [
        ...(one.acked ? [] : [action("a", "Acknowledge it", `ack id:${one.id}`)]),
        ...(same > 1 ? [action("s", `Acknowledge all ${same} the same`, `ack same:${one.id}`)] : []),
        ...(unit && onUnit > same ? [action("u", `Acknowledge all ${onUnit} on ${unit.name}`, `ack ${unit.name}`)] : []),
        ...(everywhere > Math.max(same, onUnit) ? [action("e", `Acknowledge every one, all ${everywhere}`, "ack all")] : []),
        ...(unit && one.ord ? [action("g", point ? "Go to the point" : `Go to ${unit.name}`, `goto ${one.ord}`)] : []),
        ...(point ? [action("w", "Why it reads this", `why ${point.ord}`)] : [])
      ];
      if (!actions.length) about.push(plain("It is acknowledged, and it is not on a unit on the map.", P.ink3));
      return card(`Alarm  ·  ${whereOf(one.ord)}${point ? `  ·  ${point.name}` : ""}`, about, actions);
    }
    if (kind === "proposal") {
      const proposal = (await ctx.client.proposals()).find((p) => p.id.toUpperCase() === id.toUpperCase() && p.status === "pending");
      if (!proposal) return ctx.done();
      const unit = owner(proposal.point);
      const point = pointAt(proposal.point);
      const about: ResultLine[] = [
        { parts: [{ text: `${proposal.actor?.name ?? proposal.agentUser}`, fg: P.cyan, bold: true }, { text: ` asked for this ${agoText(now - proposal.createdAt)} ago. Nothing has been changed.`, fg: P.ink3 }] },
        plain(""), plain(proposal.description, P.ink, true),
        ...(proposal.changes ?? []).slice(0, 12).map((change) => plain(`  ${change}`, P.ink2)),
        ...(point ? [{ parts: [{ text: `${point.name} reads  `, fg: P.ink3 }, { text: full(ctx.values.get(point.ord)), fg: P.ink, bold: true }, { text: proposal.value !== undefined && proposal.value !== null ? "   would be  " : "", fg: P.ink3 }, { text: proposal.value !== undefined && proposal.value !== null ? String(proposal.value) : "", fg: P.accentMark, bold: true }] }] : []),
        ...(proposal.reason ? [{ parts: [{ text: "its reason  ", fg: P.ink3 }, { text: proposal.reason, fg: P.ink2 }] }] : []),
        ...(proposal.expiresAt > now ? [plain(`It lapses in ${agoText(proposal.expiresAt - now)} if nobody answers.`, P.ink3)] : [])
      ];
      const actions = [
        action("y", "Approve it", `approve ${proposal.id}`, "the station makes the change as asked"),
        action("n", "Reject it", `reject ${proposal.id}`, "nothing is changed"),
        ...(unit ? [action("g", point ? "Go to the point" : `Go to ${unit.name}`, `goto ${proposal.point}`)] : []),
        ...(point ? [action("w", "Why it reads what it does now", `why ${point.ord}`)] : [])
      ];
      return card(`Change ${proposal.id} waits for you${unit ? `  ·  ${unit.name}` : ""}`, about, actions);
    }
    return ctx.say("That is not something on the screen.", "warn");
  }
  if (word === "ack" || word === "clear") {
    // One alarm by its id, as the list gives it ("id:…"), or a UUID typed out.
    const ids = args.filter((a) => a.startsWith("id:") || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(a)).map((a) => a.replace(/^id:/, ""));
    const found = ids.length ? undefined : alarmsFor(rest || (ctx.zoom.level === "site" ? "" : unitOf(site, ctx.zoom.unit)?.name ?? ""));
    if (!ids.length && !found) return ctx.say(`Nothing on the map is called "${rest}". Try ${word} all, ${word} normal or ${word} AHU_03.`, "warn");
    const all = ctx.events.filter((e) => e.kind === "alarm" && e.id);
    const picked = (ids.length ? all.filter((e) => ids.includes(e.id!)) : found!.list).filter((e) => word === "clear" || !e.acked);
    if (!picked.length) return ctx.say(word === "ack" ? "Nothing there is waiting to be acknowledged." : "No alarms there.", "info");
    const shown = picked.slice(0, 6).map((e) => ({ verb: word === "ack" ? "ack" : "clear", what: `${owner(e.ord)?.name ?? (e.ord ?? "").split("/").pop() ?? ""}  ${e.text}`.trim() }));
    return ctx.propose({
      id: "", from: "you", agent: false,
      lines: picked.length > 6 ? [...shown, { verb: "", what: `and ${picked.length - 6} more` }] : shown,
      note: word === "ack" ? `Acknowledges ${picked.length} ${picked.length === 1 ? "alarm" : "alarms"} as you. An alarm that is back to normal then leaves the list.` : `Force-clears ${picked.length} ${picked.length === 1 ? "alarm" : "alarms"}: they are closed whatever state the point is in. This needs an admin.`,
      make: async () => {
        const uuids = picked.map((e) => e.id!);
        for (let i = 0; i < uuids.length; i += 200) {
          if (word === "ack") await ctx.client.ackAlarms({ uuids: uuids.slice(i, i + 200) }, false, "acknowledged from the bask screen");
          else await ctx.client.clearAlarms({ uuids: uuids.slice(i, i + 200) }, false, "cleared from the bask screen");
        }
        return `${picked.length} ${picked.length === 1 ? "alarm" : "alarms"} ${word === "ack" ? "acknowledged" : "cleared"}.`;
      }
    });
  }

  // ---- Where things are ------------------------------------------------------------------------------
  if (word === "where") {
    const unit = rest ? findUnit(site, rest) : unitOf(site, ctx.zoom.level === "site" ? ctx.focus : ctx.zoom.unit);
    if (!unit) return ctx.say(rest ? `Nothing on the map is called "${rest}".` : "Name a unit: where VAV_01.", "warn");
    return ctx.say(unit.place ? `${unit.name} is in ${unit.place.path}.` : `The station does not say where ${unit.name} is: it has no site or space relation.`, unit.place ? "info" : "warn");
  }
  if (word === "places" || word === "place" || word === "building") {
    if (!site) return;
    const somewhere = site.units.filter((u) => u.place);
    if (!somewhere.length) return ctx.say("The station does not say where its equipment is: no unit has a site or space relation.", "warn");
    const lines: ResultLine[] = [];
    const sites = [...new Set(somewhere.map((u) => u.place!.site ?? ""))];
    for (const name of sites) {
      const here = somewhere.filter((u) => (u.place!.site ?? "") === name);
      lines.push({ parts: [{ text: name || "No building named", fg: P.ink, bold: true }, { text: `   ${here.length} units`, fg: P.ink3 }] });
      // A floor, or a space with no floor above it (a roof, a plant room).
      const areaOf = (u: Unit) => u.place!.floor ?? u.place!.room ?? "";
      for (const area of [...new Set(here.map(areaOf))]) {
        const on = here.filter((u) => areaOf(u) === area);
        lines.push({ parts: [{ text: `  ${area || "No floor or room"}`, fg: P.accentMark, bold: true }, { text: `   ${on.length}`, fg: P.ink3 }] });
        for (const unit of on) lines.push({ parts: [{ text: `    ${unit.name.padEnd(16)}`, fg: P.ink }, { text: (unit.place!.floor ? unit.place!.room ?? "" : "").padEnd(34), fg: P.ink2 }, { text: unit.label, fg: P.ink3 }], run: `go ${unit.ord}` });
      }
    }
    const nowhere = site.units.length - somewhere.length;
    if (nowhere) lines.push(plain(""), plain(`${nowhere} ${nowhere === 1 ? "unit has" : "units have"} no place on the station.`, P.ink3));
    return ctx.show("Where things are", lines, { hint: [["↑↓", "move"], ["enter", "go to the unit"], ["g", "lay the map out this way"], ["esc", "close"]], keys: { g: "arrange place" } });
  }
  if (word === "arrange" || word === "group") {
    if (!site) return;
    const names: Record<string, Arrange> = { feeds: "feeds", fed: "feeds", air: "feeds", place: "place", building: "place", floor: "place", location: "place", kind: "kind", type: "kind" };
    const next = rest ? names[rest.toLowerCase()] : ARRANGES[(ARRANGES.indexOf(site.arrange) + 1) % ARRANGES.length];
    if (!next) return ctx.say("The map can be laid out by feeds, place or kind.", "warn");
    const to = next === "place" && !site.placed ? (rest ? undefined : "kind") : next;
    if (!to) return ctx.say("The station does not say where its equipment is, so there is nothing to lay out by place.", "warn");
    ctx.settle(site.review, { ...ctx.tiles, [ARRANGE_KEY]: to });
    return ctx.say({ feeds: "Laid out by what feeds what.", place: "Laid out by building and floor.", kind: "Laid out by type of equipment." }[to], "good");
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
    const open = (site?.review.serves ?? []).filter((e) => e.inferred && !e.confirmed);
    if (!open.length) return ctx.say("No guesses are waiting. Say what feeds what with: feeds AHU_01 VAV_101..VAV_108", "info");
    const feeders = [...new Set(open.map((e) => e.fromName))];
    const lines: ResultLine[] = [
      plain("These are guesses from names, folders and links. Nothing here is written to the station.", P.ink3), plain(""),
      ...feeders.flatMap((feeder) => {
        const mine = open.filter((e) => e.fromName === feeder);
        const sure = mine.filter((e) => e.confidence >= UNSURE).length;
        return [
          { parts: [{ text: feeder.padEnd(18), fg: P.ink, bold: true }, { text: `feeds ${mine.length}${mine[0].medium === "air" ? "" : mine[0].medium === "hotWater" ? " hot water" : " chilled water"}`, fg: P.ink2 }, { text: `   ${sure} fairly sure, ${mine.length - sure} unsure`, fg: P.ink3 }] },
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
    // What it sends follows what it is: a hot water plant or boiler sends hot water, a chilled water plant or chiller chilled water, anything else air.
    const medium: ModelServes["medium"] = /^(hotWaterPlant|boiler)$/.test(feeder.kind) ? "hotWater" : /^(chilledWaterPlant|chiller)$/.test(feeder.kind) ? "chilledWater" : "air";
    const mine: ModelServes[] = fed.map((unit) => ({ from: feeder.ord, fromName: feeder.name, to: unit.ord, toName: unit.name, medium, confidence: 1, reason: "a person said so", confirmed: true, inferred: true }));
    const serves = [...(site.review.serves ?? []).filter((e) => !(e.medium === medium && targets.has(e.to))), ...mine];
    const file = ctx.settle({ ...site.review, serves }, ctx.tiles);
    return ctx.say(`${feeder.name} feeds ${fed.length} ${fed.length === 1 ? "unit" : "units"}${medium === "air" ? "" : medium === "hotWater" ? " hot water" : " chilled water"}. Saved on this computer in ${file}`, "good");
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

  // ---- Anything else bask can do: run as its own process, shown here -----------------------------------
  // A line that starts with a command's word is that command, unless the whole line is a unit's name
  // (a unit called "Status"). Words inside it that happen to be on the map ("note … the rack …") do not send it there.
  const forced = word === "bask" || line.startsWith("!");
  const shell = forced ? words(word === "bask" ? rest : line.slice(1)) : SHELL_COMMANDS.includes(word) && !site?.units.some((u) => flat(u.name) === flat(line)) ? words(line) : undefined;
  if (shell) {
    if (!shell.length) return ctx.say("Name a command: bask check, bask history <point>, bask query <text>. bask help lists them.", "warn");
    if (SHELL_OWN_WINDOW.includes(shell[0])) return ctx.say(`bask ${shell[0]} takes the whole terminal: run it in a shell of its own.`, "warn");
    const title = `bask ${shell.join(" ")}`;
    const run = async (allow: boolean) => {
      ctx.say(`Running ${title}…`);
      const { code, lines } = await runBask(shell.filter((a) => a !== "--allow-writes" && a !== "--yes" && a !== "-y"), ctx.profile, allow);
      ctx.show(code ? `${title}  ·  ended with ${code}` : title, lines.length && lines.some((l) => l.trim()) ? lines.map((text) => plain(text, /^(error|✗)/i.test(text) ? P.alarm : P.ink2)) : [plain("It printed nothing.", P.ink3)]);
    };
    if (!changes(shell)) return run(false);
    return ctx.propose({
      id: "", from: "you", agent: false, lines: [{ verb: "run", what: title }],
      note: "This command changes the station. It is run with changes allowed and without asking again.",
      make: async () => void (await run(true))
    });
  }

  // Not a word it knows: a unit's name goes to it; anything longer is a question.
  const unit = findUnit(site, line);
  if (unit) return ctx.open(unit.ord);
  if (args.length >= 2 || /\?$/.test(line)) return ctx.say("That is not a word bask knows here. Try why <point>, needs, get <unit>, or bask <command>; press ? for the list.", "warn");
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
