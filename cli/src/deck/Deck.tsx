// The screen: one map of the site, a bar of time under it, and a line that takes a command. This
// component gathers what the station says and what the person is doing into a DeckView; draw.ts turns
// that into a frame.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, useApp, useStdout } from "ink";
import { toSlotOrd, type BaskStreamClient, type Json, type PointSnapshot } from "@basidekick/baskstream";
import { isUnacked } from "../format.js";
import { mouseMode, useKeyPump, useKeys, useMouse } from "../tui/input.js";
import { useActivity, useAlarms, useLiveValues, useProposals, useStationName, type Activity } from "../tui/stores.js";
import { P, setPalette } from "./brand.js";
import { drawDeck, type Frame, type Stop } from "./draw.js";
import { undoOf, type Answer } from "./answer.js";
import { runCommand, complete, type CommandContext } from "./commands.js";
import { loadSaved, saveSite } from "./saved.js";
import { readSite, rebuildSite, type Site, type Unit } from "./site.js";
import { LENSES, unitOf, type DeckEvent, type DeckView, type Ghost, type Lens, type ResultLine, type UnitMarks, type Zoom } from "./view.js";

export interface DeckProps {
  client: BaskStreamClient;
  profileName: string;
  allowWrites: boolean;
  mouse?: boolean;
  theme?: "dark" | "light";
  /** No tear, signal, decode or glitch: for tests, and for people who want a still screen. */
  still?: boolean;
  /** Sends a control sequence (mouse mode, window title, clipboard) straight to the terminal. */
  terminal?: (data: string) => void;
  /** Opens the older dashboard with its twelve views. */
  onClassic?: () => void;
  /** A site model made elsewhere, to draw from instead of reading the station (tests, pictures). */
  site?: Site;
}

const HOUR = 3600000;
const DAY = 24 * HOUR;
const SPANS = [DAY, 7 * DAY, 30 * DAY];
/** The most points followed live at once; the station's own limit is usually 500. */
const LIVE_CAP = 450;

/** A change by a person or an agent, an override, as the time bar and the lists show it. */
function eventsOf(activity: Activity[], alarms: Map<string, Json>, proposals: { id: string; status: string; point: string; description: string; createdAt: number; agentUser: string }[], inHand: (ord: string) => boolean | undefined): DeckEvent[] {
  const out: DeckEvent[] = [];
  const overrides = new Map<string, DeckEvent>();
  for (const a of [...activity].sort((x, y) => x.at - y.at)) {
    const ord = a.target.startsWith("slot:") ? a.target : undefined;
    if (a.source === "audit") {
      if (a.kind === "Invoked" && /^(override|emergencyOverride)$/.test(a.action) && ord) {
        const event: DeckEvent = { at: a.at, kind: "override", who: a.user, agent: a.ai, ord, text: `${a.user} put ${nameOf(ord)} in hand at ${a.value ?? ""}`.trim() };
        overrides.get(ord)?.until ?? (overrides.get(ord) && (overrides.get(ord)!.until = a.at));
        overrides.set(ord, event);
        out.push(event);
      } else if (a.kind === "Invoked" && /^(auto|emergencyAuto)$/.test(a.action) && ord) {
        const open = overrides.get(ord);
        if (open && open.until === undefined) open.until = a.at;
        overrides.delete(ord);
      } else if (/^(Changed|Added|Removed|Renamed|Reordered|Invoked)$/.test(a.kind) && ord) {
        const what = a.kind === "Changed" ? `${a.user} changed ${nameOf(ord)}${a.action ? ` ${a.action}` : ""}${a.oldValue || a.value ? ` ${a.oldValue ?? ""} → ${a.value ?? ""}` : ""}` : `${a.user} ${a.kind.toLowerCase()} ${nameOf(ord)}${a.action ? ` ${a.action}` : ""}`;
        out.push({ at: a.at, kind: "change", who: a.user, agent: a.ai, ord, text: what });
      }
    } else if (a.kind === "proposed") out.push({ at: a.at, kind: "proposal", who: a.agent ?? a.user, agent: true, ord, text: `${a.agent ?? a.user} asked: ${a.change ?? a.action}` });
    else if (/^(completed|written|approved)$/.test(a.kind)) out.push({ at: a.at, kind: "agent", who: a.agent ?? a.user, agent: true, ord, text: `${a.agent ?? a.user}: ${a.change ?? a.action}` });
  }
  // An override with a time limit ends without a record of its own. One whose point is no longer in
  // hand has ended: when its limit ran out, where the record gives one.
  for (const [ord, event] of overrides) {
    if (event.until !== undefined || inHand(ord) !== false) continue;
    const limit = /(\d+) ?min/.exec(event.text);
    event.until = limit ? event.at + Number(limit[1]) * 60000 : event.at;
  }
  for (const alarm of alarms.values()) {
    const at = Number(alarm.timestamp ?? 0);
    const source = String(((alarm.sources ?? []) as string[])[0] ?? "");
    if (at) out.push({ at, kind: "alarm", ord: source ? toSlotOrd(source) : undefined, text: String(alarm.message ?? alarm.msgText ?? "alarm"), id: String(alarm.uuid ?? "") });
  }
  for (const p of proposals) if (p.status === "pending" && !out.some((e) => e.kind === "proposal" && Math.abs(e.at - p.createdAt) < 2000)) out.push({ at: p.createdAt, kind: "proposal", who: p.agentUser, agent: true, ord: p.point.startsWith("slot:") ? p.point : undefined, text: p.description, id: p.id });
  return out;
}
const nameOf = (ord: string) => ord.split("/").filter((part) => part !== "points").slice(-2).join(" ");

/** Which unit an ORD belongs to: the unit itself, or one of its points. */
function ownerOf(site: Site, ord: string | undefined): Unit | undefined {
  if (!ord) return undefined;
  return site.units.find((u) => ord === u.ord || ord.startsWith(`${u.ord}/`));
}

export function Deck(props: DeckProps) {
  const { client } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  useKeyPump(true);
  const [size, setSize] = useState({ columns: stdout.columns || 120, rows: stdout.rows || 36 });
  const tagged = useStationName(client);
  // A station that does not say its name in a tag still names its histories after itself.
  const [named, setNamed] = useState<string>();
  useEffect(() => {
    if (tagged) return;
    void import("../log.js").then(({ auditHistoryOrd }) => auditHistoryOrd(client)).then((ord) => {
      const found = /\/([^/]+)\/[^/]+$/.exec(String(ord ?? ""))?.[1];
      if (found) setNamed(found);
    }, () => {});
  }, [client, tagged]);
  const station = tagged ?? named;
  const [site, setSite] = useState<Site | undefined>(props.site);
  const [loading, setLoading] = useState<string>("reading the station");
  const [problem, setProblem] = useState<string>();
  const [zoom, setZoom] = useState<Zoom>({ level: "site" });
  const [focus, setFocus] = useState<string>();
  const [lens, setLens] = useState<Lens>("comfort");
  const [keys, setKeys] = useState<DeckView["keys"]>("map");
  const [prompt, setPrompt] = useState({ text: "", cursor: 0 });
  const [earlier, setEarlier] = useState<{ lines: string[]; at: number }>({ lines: [], at: -1 });
  const [scroll, setScroll] = useState(0);
  const [at, setAt] = useState<number>();
  const [spanIndex, setSpanIndex] = useState(1);
  const [result, setResult] = useState<DeckView["result"]>();
  const [tiles, setTiles] = useState<Record<string, string>>({});
  const [answer, setAnswer] = useState<Answer>();
  const [extra, setExtra] = useState(new Map<string, number[]>());
  const [ghost, setGhost] = useState<(Ghost & { make: () => Promise<string | void> }) | undefined>();
  const [toast, setToast] = useState<DeckView["toast"] & { until: number }>();
  const [writes, setWrites] = useState(props.allowWrites);
  const [armed, setArmed] = useState(0);
  const [mouseOn] = useState(props.mouse ?? false);
  const [net, setNet] = useState<DeckView["net"]>({ state: "live" });
  const [now, setNow] = useState(Date.now());
  const born = useRef(Date.now());
  const [decodeFrom, setDecodeFrom] = useState<number>();
  const [states, setStates] = useState(new Map<string, PointSnapshot>());
  const [past, setPast] = useState<{ key: string; values: Map<string, PointSnapshot>; series: Map<string, number[]> }>({ key: "", values: new Map(), series: new Map() });
  const frameRef = useRef<Frame | undefined>(undefined);
  const still = props.still ?? /^(off|0|none|reduce)$/i.test(process.env.BASK_MOTION ?? "");

  useMemo(() => setPalette(props.theme ?? "dark"), [props.theme]);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);
  useEffect(() => props.terminal?.(mouseMode(mouseOn)), [mouseOn]);
  useEffect(() => props.terminal?.(`\x1b]2;bask · ${station ?? client.http.url.host}\x07`), [station]);

  const say = useCallback((text: string, tone: "info" | "good" | "warn" | "bad" = "info") => setToast({ text, tone, until: Date.now() + 5000 }), []);

  // ---- The site -----------------------------------------------------------------------------------
  useEffect(() => {
    if (props.site) return;
    let cancelled = false;
    const kept = loadSaved(client.http.url.host);
    setTiles(kept.tiles);
    readSite(client, station ?? client.http.url.host, kept.review, "slot:/", kept.tiles).then(
      (read) => {
        if (cancelled) return;
        setSite(read);
        setDecodeFrom(Date.now());
        if (!read.units.length) setProblem("No equipment with points was found on this station.");
      },
      (error: Error) => !cancelled && setProblem(`The station could not be read: ${error.message}`)
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  useEffect(() => {
    if (site && station && site.station !== station) setSite({ ...site, station });
  }, [station]);
  useEffect(() => {
    if (site && !focus) setFocus((site.groups.flatMap((g) => [...(g.feeder ? [g.feeder] : []), ...g.members])[0] ?? site.units[0])?.ord);
  }, [site]);

  // ---- Connection ---------------------------------------------------------------------------------
  useEffect(() => {
    const ping = async () => {
      if (!client.connected) return;
      const started = Date.now();
      await client.ping().then(() => setNet((n) => (n.state === "live" ? { state: "live", latency: Date.now() - started } : n)), () => {});
    };
    const onDown = () => setNet({ state: "reconnecting" });
    const onUp = () => setNet({ state: "live" });
    client.on("disconnected", onDown);
    client.on("reconnected", onUp);
    void ping();
    const timer = setInterval(ping, 10000);
    return () => {
      clearInterval(timer);
      client.off("disconnected", onDown);
      client.off("reconnected", onUp);
    };
  }, [client]);

  // ---- What is read --------------------------------------------------------------------------------
  const zoomUnit = zoom.level === "site" ? undefined : unitOf(site, zoom.unit);
  const wanted = useMemo(() => {
    if (!site) return [];
    if (zoomUnit) {
      const fedBy = site.groups.find((g) => g.by === "serves" && g.members.some((m) => m.ord === zoomUnit.ord))?.feeder;
      const feeds = site.groups.find((g) => g.feeder?.ord === zoomUnit.ord)?.members ?? [];
      return [...new Set([...zoomUnit.points.map((p) => p.ord), ...(fedBy?.points ?? []).map((p) => p.ord), ...feeds.flatMap((m) => [m.headline?.ord, m.setpoint?.ord].filter((o): o is string => !!o))])].slice(0, LIVE_CAP);
    }
    const header = (u: Unit) => u.points.filter((p) => /^(supplyFanStatus|fanStatus|runStatus|enableStatus|supplyFanSpeed|fanSpeed|pumpSpeed|supplyAirPressure)$/.test(p.role)).map((p) => p.ord);
    const ords = site.units.flatMap((u) => [u.headline?.ord, u.setpoint?.ord, ...(u.zone ? [] : header(u))].filter((o): o is string => !!o));
    return [...new Set(ords)].slice(0, LIVE_CAP);
  }, [site, zoomUnit?.ord]);
  const live = useLiveValues(client, "deck", wanted, !!site);
  const alarmStore = useAlarms(client);
  const proposalStore = useProposals(client);
  const span = SPANS[spanIndex];
  const activity = useActivity(client, { enabled: !!site, station, rangeMs: span });

  // Every point's state, read now and then: what is in hand or faulted on units whose values are not followed live.
  useEffect(() => {
    if (!site) return;
    let cancelled = false;
    const all = site.units.flatMap((u) => u.points.map((p) => p.ord));
    const read = async () => {
      const next = new Map<string, PointSnapshot>();
      for (let i = 0; i < all.length && !cancelled; i += 400) for (const snap of await client.read(all.slice(i, i + 400), { fresh: false }).catch(() => [] as PointSnapshot[])) next.set(toSlotOrd(snap.point), snap);
      if (!cancelled) setStates(next);
    };
    void read();
    const timer = setInterval(read, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [site]);

  // History: the small charts of the unit being looked at, and every tile's reading at a moment in the past.
  const to = useMemo(() => Math.ceil(now / 60000) * 60000, [Math.floor(now / 60000)]);
  const from = to - span;
  useEffect(() => {
    if (!site) return;
    // Inside a unit: every point. On the map: each tile's reading, for its small chart and for looking at the past.
    const ords = zoomUnit ? zoomUnit.points.map((p) => p.ord) : at !== undefined || site.units.length <= 120 ? wanted : [];
    const key = `${zoomUnit?.ord ?? "site"}|${spanIndex}|${ords.length}`;
    if (!ords.length || past.key === key) return;
    let cancelled = false;
    const buckets = 96;
    const series = new Map<string, number[]>();
    void (async () => {
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < ords.length && !cancelled) {
          const ord = ords[next++];
          const rollup = await client.historyRollup(ord, { start: Date.now() - span, end: Date.now(), interval: Math.round(span / buckets) }).catch(() => undefined);
          const rows = (((rollup?.histories ?? []) as Json[])[0]?.buckets ?? []) as Json[];
          const values = rows.map((b) => (typeof b.avg === "number" && Number(b.count ?? 1) > 0 ? b.avg : undefined));
          // Carry the last reading across empty steps, so a moment between two records still has a value.
          let last: number | undefined;
          const filled = values.map((v) => (last = v ?? last));
          if (filled.some((v) => v !== undefined)) series.set(ord, filled.map((v) => v ?? filled.find((x) => x !== undefined)!) as number[]);
        }
      }));
      if (!cancelled) setPast({ key, values: new Map(), series });
    })();
    return () => {
      cancelled = true;
    };
  }, [site, zoomUnit?.ord, spanIndex, at === undefined, wanted.length]);

  // ---- What the lenses and the summary read ---------------------------------------------------------
  const proposals = useMemo(() => [...proposalStore.proposals.values()], [proposalStore.proposals]);
  const events = useMemo(() => {
    const inHand = (ord: string) => {
      const snapshot = live.get(ord) ?? states.get(ord);
      return snapshot ? snapshot.state === "overridden" || /overridden/.test(String(snapshot.status ?? "")) : undefined;
    };
    // An alarm that is still open stays, however long ago it came in; the time bar draws what falls in its span.
    return eventsOf(activity.entries, alarmStore.alarms, proposals, inHand).filter((e) => e.at >= from - DAY || e.kind === "alarm" || (e.kind === "override" && e.until === undefined));
  }, [activity.entries, alarmStore.alarms, proposals, from, live, states]);
  const marks = useMemo(() => {
    const out = new Map<string, UnitMarks>();
    if (!site) return out;
    const of = (unit: Unit) => out.get(unit.ord) ?? out.set(unit.ord, { open: 0, unacked: 0, fault: false, overrides: 0, people: 0, agents: 0, waiting: 0 }).get(unit.ord)!;
    for (const alarm of alarmStore.alarms.values()) {
      const unit = ownerOf(site, toSlotOrd(String(((alarm.sources ?? []) as string[])[0] ?? "")));
      if (!unit) continue;
      const m = of(unit);
      m.open += 1;
      if (isUnacked(alarm)) m.unacked += 1;
      if (/fault/i.test(String(alarm.sourceState ?? ""))) m.fault = true;
    }
    for (const unit of site.units) {
      for (const point of unit.points) {
        const state = String((live.get(point.ord) ?? states.get(point.ord))?.state ?? "");
        if (state === "overridden") of(unit).overrides += 1;
        if (/fault|down/.test(state)) of(unit).fault = true;
      }
    }
    for (const e of events) {
      if (e.at < from || (e.kind !== "change" && e.kind !== "agent")) continue;
      const unit = ownerOf(site, e.ord);
      if (!unit) continue;
      const m = of(unit);
      if (e.agent) m.agents += 1;
      else m.people += 1;
      m.last = Math.max(m.last ?? 0, e.at);
    }
    for (const p of proposals) {
      const unit = p.status === "pending" ? ownerOf(site, p.point) : undefined;
      if (unit) of(unit).waiting += 1;
    }
    return out;
  }, [site, alarmStore.alarms, live, states, events, proposals, from]);

  // The readings on screen: live, or as they were at the moment looked at.
  const values = useMemo(() => {
    const merged = new Map<string, PointSnapshot>([...states, ...live]);
    if (at === undefined) return merged;
    const out = new Map<string, PointSnapshot>();
    for (const [ord, snapshot] of merged) {
      const series = past.series.get(ord);
      if (!series) {
        // No history: a setpoint mostly. Its value now is the best there is.
        out.set(ord, snapshot);
        continue;
      }
      const value = series[Math.max(0, Math.min(series.length - 1, Math.floor(((at - from) / span) * series.length)))];
      const precision = Number((snapshot.facets as { precision?: unknown } | undefined)?.precision ?? 1) || 1;
      const unit = String((snapshot.facets as { units?: unknown } | undefined)?.units ?? "");
      out.set(ord, { ...snapshot, ok: true, state: "ok", status: "{ok}", value, displayValue: `${value.toFixed(precision)}${unit ? ` ${unit}` : ""}` });
    }
    return out;
  }, [states, live, at, past, from, span]);

  // ---- The clock for what moves ---------------------------------------------------------------------
  const anyFault = useMemo(() => [...marks.values()].some((m) => m.fault), [marks]);
  useEffect(() => {
    if (still) return;
    const busy = !site || (decodeFrom !== undefined && Date.now() - decodeFrom < 1300);
    if (busy) {
      const timer = setInterval(() => setNow(Date.now()), 60);
      return () => clearInterval(timer);
    }
    // A fault's glitch: two frames every 4.2 s. Wake for those and sleep between.
    if (!anyFault) return;
    let timers: NodeJS.Timeout[] = [];
    const cycle = () => {
      const phase = Date.now() % 4200;
      const wait = (3780 - phase + 4200) % 4200;
      timers = [0, 90, 215].map((after) => setTimeout(() => setNow(Date.now()), wait + after));
      timers.push(setTimeout(cycle, wait + 400));
    };
    cycle();
    return () => timers.forEach(clearTimeout);
  }, [still, !site, decodeFrom, anyFault, now > (decodeFrom ?? 0) + 1300]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), Math.max(0, toast.until - Date.now()));
    return () => clearTimeout(timer);
  }, [toast]);

  // ---- Moving about ---------------------------------------------------------------------------------
  const openUnit = useCallback((ord: string) => {
    const unit = unitOf(site, ord);
    if (!unit) return;
    setZoom({ level: "unit", unit: ord });
    setFocus((unit.headline ?? unit.points[0])?.ord);
    setScroll(0);
    setDecodeFrom(Date.now());
  }, [site]);
  const back = useCallback(() => {
    if (zoom.level === "site") return;
    setFocus(zoom.unit);
    setZoom({ level: "site" });
    setDecodeFrom(Date.now());
  }, [zoom]);

  const move = (dx: number, dy: number) => {
    const stops = frameRef.current?.stops ?? [];
    const current = stops.find((stop) => stop.id === focus) ?? stops[0];
    if (!current) return;
    const centre = (stop: Stop) => ({ x: stop.x + stop.width / 2, y: stop.y + stop.height / 2 });
    const here = centre(current);
    // The nearest row (or column) in that direction first; within it, whatever is most in line.
    const ahead: { stop: Stop; along: number; off: number }[] = [];
    for (const stop of stops) {
      if (stop === current) continue;
      const there = centre(stop);
      const across = there.x - here.x;
      const down = there.y - here.y;
      if (dx && Math.sign(across) !== dx) continue;
      if (dy && Math.sign(Math.round(down)) !== dy) continue;
      if (dx && Math.abs(down) > 1.5) continue; // left and right stay on the row
      ahead.push({ stop, along: Math.abs(dx ? across : down), off: Math.abs(dx ? down : across) });
    }
    const nearest = Math.min(...ahead.map((a) => a.along));
    const best = ahead.filter((a) => a.along <= nearest + (dy ? 1 : 0)).sort((a, b) => a.off - b.off || a.along - b.along)[0]?.stop;
    if (best) setFocus(best.id);
  };

  // Keep the cursor in view.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || zoom.level !== "site") return;
    const stop = frame.stops.find((s) => s.id === focus);
    if (!stop) return;
    const top = size.rows >= 30 ? 2 : 1;
    if (stop.y < top) setScroll((n) => Math.max(0, n - (top - stop.y) - 1));
    else if (stop.y + stop.height > top + frame.mapRoom) setScroll((n) => n + stop.y + stop.height - top - frame.mapRoom + 1);
  }, [focus, size.rows]);

  const stepTime = (cells: number) => {
    const width = Math.max(10, size.columns - 4);
    const step = span / width;
    setAt((current) => {
      const next = (current ?? to) + cells * step;
      return next >= to - step / 2 ? undefined : Math.max(from, next);
    });
    setDecodeFrom(Date.now());
  };
  const jumpEvent = (direction: number) => {
    const here = at ?? to;
    const times = events.map((e) => e.at).filter((t) => t >= from && t <= to).sort((a, b) => a - b);
    const next = direction < 0 ? [...times].reverse().find((t) => t < here - 1000) : times.find((t) => t > here + 1000);
    if (next === undefined) return direction > 0 ? setAt(undefined) : undefined;
    setAt(next);
    setDecodeFrom(Date.now());
  };

  // ---- Commands -------------------------------------------------------------------------------------
  const context: CommandContext = {
    client, site, zoom, focus, writes, lens,
    say,
    show: (title: string, lines: ResultLine[]) => setResult({ title, lines, scroll: 0 }),
    propose: (next) => setGhost(next),
    tiles,
    settle: (review, nextTiles) => {
      setTiles(nextTiles);
      if (site) setSite(rebuildSite(site, review, nextTiles));
      return saveSite(client.http.url.host, { review, tiles: nextTiles });
    },
    answer: (why) => {
      setToast(undefined);
      setAnswer({ why, undo: undoOf(why), scroll: 0 });
      // The small charts of the points in the answer that are not on screen already.
      const ords = [why.ord, ...(why.siblings ?? []).map((sib) => sib.ord), ...(why.upstream ?? []).flatMap((u) => u.issues.filter((i) => i.turn).map((i) => i.ord))].filter((ord) => !past.series.has(ord) && !extra.has(ord));
      void Promise.all(ords.map(async (ord) => {
        const rollup = await client.historyRollup(ord, { start: Date.now() - span, end: Date.now(), interval: Math.round(span / 96) }).catch(() => undefined);
        const rows = (((rollup?.histories ?? []) as Json[])[0]?.buckets ?? []) as Json[];
        let last: number | undefined;
        const filled = rows.map((b) => (last = typeof b.avg === "number" && Number(b.count ?? 1) > 0 ? b.avg : last));
        return [ord, filled.map((v) => v ?? filled.find((x) => x !== undefined) ?? 0)] as const;
      })).then((got) => setExtra((map) => new Map([...map, ...got.filter(([, values]) => values.length > 1)])));
    },
    open: openUnit,
    back,
    setLens,
    setAt: (ms) => {
      setAt(ms);
      setDecodeFrom(Date.now());
    },
    quit: exit,
    classic: props.onClassic,
    values, events, span: { from, to }, at
  };

  const submit = (text: string) => {
    const line = text.trim();
    setPrompt({ text: "", cursor: 0 });
    setKeys("map");
    if (!line) return;
    setEarlier((e) => ({ lines: [...e.lines.filter((l) => l !== line), line].slice(-50), at: -1 }));
    void runCommand(line, context).catch((error: Error) => say(error.message, "bad"));
  };

  useKeys((input, key) => {
    if (key.ctrl && input === "c") return exit();
    if (ghost) {
      if (key.return) {
        const mine = ghost;
        setGhost(undefined);
        void mine.make().then((done) => done && say(done, "good"), (error: Error) => say(error.message, "bad"));
      } else if (key.escape) {
        setGhost(undefined);
        say("Dropped. Nothing was changed.");
      }
      return;
    }
    if (answer && keys !== "prompt") {
      if (key.escape || input === "q") return setAnswer(undefined);
      if (key.upArrow || input === "k") return setAnswer({ ...answer, scroll: Math.max(0, answer.scroll - 1) });
      if (key.downArrow || input === "j") return setAnswer({ ...answer, scroll: answer.scroll + 1 });
      if (input === "t" && answer.why.turn) {
        setAt(Math.max(from, answer.why.turn.at - span / 200));
        return setDecodeFrom(Date.now());
      }
      if (input === "f" && answer.undo) {
        const u = answer.undo;
        if (!writes) return say("This window is read-only. Press W twice to allow changes, then f again.", "warn");
        return setGhost({
          id: "", from: "you", agent: false,
          lines: [{ verb: "set", what: u.name, before: u.to, after: u.from }],
          note: `Puts back what ${u.by ?? "someone"} changed. Nothing is written until you press enter.`,
          make: async () => {
            const done = await client.write(u.ord, "set", Number.isNaN(Number(u.value)) ? u.value : Number(u.value), { reason: "put back from the bask screen" } as Json);
            setAnswer(undefined);
            return `${u.name} now reads ${String(done.displayValue ?? done.value ?? "")}.`;
          }
        });
      }
      if (input === ":" || input === "/") return setKeys("prompt");
      if (input === "W") {
        if (writes) return setWrites(false);
        if (Date.now() - armed < 6000) {
          setWrites(true);
          setArmed(0);
          return say("Changes are on in this window. Each one still shows first and asks.", "warn");
        }
        setArmed(Date.now());
        return say("Press W again to allow changes from this window.", "warn");
      }
      return;
    }
    if (result) {
      if (key.escape || key.return || input === "q") return setResult(undefined);
      const by = key.upArrow || input === "k" ? -1 : key.downArrow || input === "j" ? 1 : key.pageUp ? -10 : key.pageDown || input === " " ? 10 : 0;
      if (by) setResult({ ...result, scroll: Math.max(0, Math.min(Math.max(0, result.lines.length - 4), result.scroll + by)) });
      return;
    }
    if (keys === "prompt") {
      if (key.escape) return setKeys("map");
      if (key.return) return submit(prompt.text);
      if (key.tab) {
        const done = complete(prompt.text, context);
        if (done) setPrompt({ text: done, cursor: [...done].length });
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (!earlier.lines.length) return;
        const index = key.upArrow ? (earlier.at < 0 ? earlier.lines.length - 1 : Math.max(0, earlier.at - 1)) : earlier.at < 0 ? -1 : earlier.at + 1 >= earlier.lines.length ? -1 : earlier.at + 1;
        const text = index < 0 ? "" : earlier.lines[index];
        setEarlier({ ...earlier, at: index });
        return setPrompt({ text, cursor: [...text].length });
      }
      const chars = [...prompt.text];
      if (key.leftArrow) return setPrompt({ ...prompt, cursor: Math.max(0, prompt.cursor - 1) });
      if (key.rightArrow) return setPrompt({ ...prompt, cursor: Math.min(chars.length, prompt.cursor + 1) });
      if (key.backspace || key.delete) {
        if (prompt.cursor === 0) return chars.length === 0 ? setKeys("map") : undefined;
        chars.splice(prompt.cursor - 1, 1);
        return setPrompt({ text: chars.join(""), cursor: prompt.cursor - 1 });
      }
      if (input && !key.ctrl && !key.meta) {
        const typed = [...input.replace(/[\r\n]/g, "")];
        chars.splice(prompt.cursor, 0, ...typed);
        setPrompt({ text: chars.join(""), cursor: prompt.cursor + typed.length });
      }
      return;
    }
    if (input === "q") return zoom.level === "site" ? exit() : back();
    if (input === ":" || input === "/" || input === ">") return setKeys("prompt");
    if (key.tab) return setKeys(keys === "map" ? "time" : "map");
    if (input === "l") return setLens(LENSES[(LENSES.indexOf(lens) + 1) % LENSES.length]);
    if (input === "L") return setLens(LENSES[(LENSES.indexOf(lens) + LENSES.length - 1) % LENSES.length]);
    if (/^[1-5]$/.test(input)) return setLens(LENSES[Number(input) - 1]);
    if (input === "n" || key.end) {
      setAt(undefined);
      return setDecodeFrom(Date.now());
    }
    if (input === ",") return stepTime(-1);
    if (input === ".") return stepTime(1);
    if (input === "<") return jumpEvent(-1);
    if (input === ">") return jumpEvent(1);
    if (input === "[") return setSpanIndex((i) => Math.max(0, i - 1));
    if (input === "]") return setSpanIndex((i) => Math.min(SPANS.length - 1, i + 1));
    if (input === "W") {
      if (writes) {
        setWrites(false);
        return say("This window is read-only again.");
      }
      if (Date.now() - armed < 6000) {
        setWrites(true);
        setArmed(0);
        return say("Changes are on in this window. Each one still shows first and asks. W turns them off.", "warn");
      }
      setArmed(Date.now());
      return say(`Press W again to allow changes to ${station ?? "this station"} from this window.`, "warn");
    }
    if (input === "?") return void runCommand("keys", context);
    if (input === "r") return void runCommand("review", context);
    if (input === "c" && props.onClassic) return props.onClassic();
    if (keys === "time") {
      if (key.escape) return setKeys("map");
      if (key.leftArrow || input === "h") return stepTime(key.shift ? -8 : -1);
      if (key.rightArrow) return stepTime(key.shift ? 8 : 1);
      return;
    }
    if (key.escape || key.backspace || key.delete) return back();
    if (key.return) {
      if (zoom.level === "site" && focus) return openUnit(focus);
      if (zoom.level !== "site" && focus) return void runCommand(`why ${focus}`, context).catch((error: Error) => say(error.message, "bad"));
      return;
    }
    if (key.leftArrow || input === "h") return zoom.level === "site" ? move(-1, 0) : back();
    if (key.rightArrow) return zoom.level === "site" ? move(1, 0) : undefined;
    if (key.upArrow || input === "k") return move(0, -1);
    if (key.downArrow || input === "j") return move(0, 1);
    if (key.pageDown) return setScroll((n) => n + 6);
    if (key.pageUp) return setScroll((n) => Math.max(0, n - 6));
    if (input === "w" && focus && zoom.level !== "site") return void runCommand(`why ${focus}`, context).catch((error: Error) => say(error.message, "bad"));
    if (input === "s" && focus && zoom.level !== "site") {
      setPrompt({ text: `set ${focus.split("/").pop()} `, cursor: [...`set ${focus.split("/").pop()} `].length });
      return setKeys("prompt");
    }
  });

  useMouse((e) => {
    const frame = frameRef.current;
    if (!frame || ghost || result) return;
    if (answer && e.kind === "down") {
      const hit = [...frame.hits].reverse().find((h) => e.x >= h.x && e.x < h.x + h.width && e.y >= h.y && e.y < h.y + h.height);
      if (hit?.id !== "undo" && hit?.id !== "time") return setAnswer(undefined);
    }
    if (e.kind === "wheelUp" || e.kind === "wheelDown") {
      const overTime = frame.timeBar && e.y >= frame.timeBar.y - 1 && e.y <= frame.timeBar.y + 1;
      if (overTime) return stepTime(e.kind === "wheelUp" ? -2 : 2);
      return setScroll((n) => Math.max(0, Math.min(Math.max(0, frame.mapRows - frame.mapRoom), n + (e.kind === "wheelUp" ? -3 : 3))));
    }
    if (e.kind !== "down") return;
    const hit = [...frame.hits].reverse().find((h) => e.x >= h.x && e.x < h.x + h.width && e.y >= h.y && e.y < h.y + h.height);
    if (!hit) return;
    const [kind, ...rest] = hit.id.split(":");
    const id = rest.join(":");
    if (kind === "lens") return setLens(id as Lens);
    if (kind === "prompt") return setKeys("prompt");
    if (kind === "crumb") return id === "0" ? (setFocus(zoom.level === "site" ? focus : zoom.unit), setZoom({ level: "site" })) : undefined;
    if (kind === "time" && frame.timeBar) {
      setKeys("time");
      const k = Math.max(0, Math.min(1, (e.x - frame.timeBar.x) / Math.max(1, frame.timeBar.width - 1)));
      setAt(k >= 0.995 ? undefined : from + k * span);
      return setDecodeFrom(Date.now());
    }
    if (kind === "unit") {
      setKeys("map");
      if (zoom.level === "site" && focus !== id) return setFocus(id);
      return openUnit(id);
    }
    if (kind === "point") {
      setKeys("map");
      if (focus !== id) return setFocus(id);
      return void runCommand(`why ${id}`, context).catch((error: Error) => say(error.message, "bad"));
    }
  }, mouseOn);

  // ---- The frame ------------------------------------------------------------------------------------
  const view: DeckView = {
    width: Math.max(40, size.columns), height: Math.max(14, size.rows),
    station: station ?? site?.station ?? props.profileName, user: String(client.capabilities.authenticatedUser ?? ""),
    site: problem && !site?.units.length ? undefined : site, loading: site ? undefined : loading, problem,
    zoom, focus, lens, values, series: extra.size ? new Map([...past.series, ...extra]) : past.series, marks, events, answer, turnAt: answer?.why.turn?.at,
    span: { from, to }, at, keys, prompt, net, writes, now,
    fx: { born: born.current, decodeFrom, reduced: still },
    result, ghost, toast, scroll
  };
  const frame = drawDeck(view);
  frameRef.current = frame;
  void setLoading;
  void P;
  return <Text>{frame.surface.lines().join("\n")}</Text>;
}
