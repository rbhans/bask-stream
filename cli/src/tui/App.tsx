import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import { randomUUID } from "node:crypto";
import { BaskStreamError, toSlotOrd, type BaskStreamClient, type Json, type Proposal } from "@basidekick/baskstream";
import { isUnacked, place } from "../format.js";
import { Link, type Shared } from "../link.js";
import { Finder } from "./Finder.js";
import { mouseMode, useKeyPump, useKeys, useMouse } from "./input.js";
import { Palette, type Command } from "./Palette.js";
import { useActivity, useAlarms, useJobs, useProposals, useStationName, useWatchList } from "./stores.js";
import { setTheme } from "./theme.js";
import { Hint, ModalBox, UiContext, VIEWS, VIEW_LABEL, clip, theme, toneColor, type Modal, type Rect, type Tone, type Ui, type ViewName } from "./ui.js";
import { ACTIVITY_RANGES, ActivityView, proposalActor } from "./views/Activity.js";
import { AlarmsView } from "./views/Alarms.js";
import { ExplorerView } from "./views/Explorer.js";
import { FilesView } from "./views/Files.js";
import { GraphicsView } from "./views/Graphics.js";
import { LogicView } from "./views/Logic.js";
import { HomeView } from "./views/Home.js";
import { JobsView } from "./views/Jobs.js";
import { QueryView, REPORTS } from "./views/Query.js";
import { SchedulesView } from "./views/Schedules.js";
import { TrendsView } from "./views/Trends.js";
import { WatchView } from "./views/Watch.js";

export type { ViewName } from "./ui.js";

const HINTS: Record<ViewName, [string, string][]> = {
  home: [],
  explorer: [["↑↓", "move"], ["→←", "open/close"], ["w", "watch"], ["t", "trend"], ["c", "command"], ["p", "properties"], ["d", "discover"], ["n", "new"], ["R", "rename"], ["D", "delete"], ["y", "copy ORD"]],
  watch: [["↑↓", "move"], ["t", "trend"], ["o", "override"], ["s", "set"], ["a", "auto"], ["c", "command"], ["e", "explorer"], ["d", "remove"]],
  alarms: [["↑↓", "move"], ["⏎", "details"], ["a", "ack"], ["A", "ack all"], ["u", "unacked"], ["f", "class"], ["e", "source"], ["t", "trend"]],
  trends: [["↑↓", "point"], ["+ -", "zoom"], ["← →", "pan"], ["n", "now"], ["w", "watch"], ["e", "explorer"]],
  schedules: [["↑↓", "move"], ["e", "explorer"], ["r", "reload"]],
  query: [["↑↓", "move"], ["⏎", "run / go to"], ["i", "type a query"], ["b", "reports"], ["← →", "columns"], ["w", "watch"], ["s", "save CSV"]],
  files: [["↑↓", "move"], ["→←", "open/up"], ["e", "edit"], ["n", "new"], ["u", "upload"], ["s", "save copy"], ["D", "delete"]],
  jobs: [["↑↓", "move"], ["d", "discover"], ["→", "results"], ["space", "select"], ["a", "add"], ["x", "cancel"]],
  activity: [["↑↓", "move"], ["a", "approve"], ["x", "reject"], ["⏎", "details"], ["f", "filter"], ["u", "all users"], ["[ ]", "window"], ["e", "explorer"]],
  graphics: [["↑↓", "graphic"], ["← →", "part"], ["⏎", "explorer"], ["t", "trend"], ["c", "command"], ["w", "watch"], ["space", "pause"], ["r", "reload"], ["D", "delete"]],
  logic: [["←↑↓→", "block and slot"], ["⏎", "trace / open"], ["u", "up"], ["e", "explorer"], ["t", "trend"], ["w", "watch"], ["c", "command"], ["y", "copy ORD"], ["r", "reload"]]
};

/** The key that opens each view: 1 to 9, then 0, then g for Graphics and L for Logic. */
const KEY_OF = (index: number) => (index < 10 ? String((index + 1) % 10) : VIEWS[index] === "logic" ? "L" : "g");

export interface AppProps {
  client: BaskStreamClient;
  profileName: string;
  allowWrites: boolean;
  /** Shared state with other bask windows on this station; kept in memory when not given. */
  link?: Link;
  view?: ViewName;
  points?: string[];
  /** One view per window, for a multiplexer pane: no tab row. */
  pane?: boolean;
  mouse?: boolean;
  /** Hands the terminal to another program and redraws afterwards. */
  suspend?: (work: () => void) => void;
  /** Sends a control sequence (mouse mode, window title, clipboard) straight to the terminal. */
  terminal?: (data: string) => void;
  /** Opened from the all-stations view: q and F go back there, and that view reads the keyboard. */
  onBack?: () => void;
}

export function App(props: AppProps) {
  const { client, profileName, view: initialView, points: initialPoints = [], pane = false } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  useKeyPump(!props.onBack);
  const leave = props.onBack ?? exit;
  const link = useMemo(() => props.link ?? new Link(client.http.url.origin, false), []);
  const [size, setSize] = useState({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [view, setView] = useState<ViewName>(initialView ?? "home");
  const [visited, setVisited] = useState(new Set<ViewName>([initialView ?? "home"]));
  const [modal, setModal] = useState<Modal>();
  const [toast, setToast] = useState<{ text: string; tone: Tone; at: number }>();
  const [net, setNet] = useState<{ state: "live" | "reconnecting" | "down"; latency: number[]; detail?: string }>({ state: "live", latency: [] });
  const [writes, setWrites] = useState(props.allowWrites);
  const [overlay, setOverlay] = useState<"help" | "find" | "palette">();
  const [typing, setTyping] = useState(false);
  const [trendOrd, setTrendOrd] = useState<string>();
  const [reveal, setReveal] = useState<{ ord: string; n: number }>();
  const [queryRun, setQueryRun] = useState<{ n: number; bql?: string; neql?: string }>();
  const [focusJob, setFocusJob] = useState<{ job: string; n: number }>();
  const [graphic, setGraphic] = useState<{ name: string; n: number }>();
  const [logic, setLogic] = useState<{ ord: string; n: number }>();
  const [rangeIndex, setRangeIndex] = useState(1);
  // The station's name, for the header and to find its audit history.
  const station = useStationName(client);
  const [shared, setShared] = useState<Shared>(link.get());
  const [mouseOn, setMouseOn] = useState(props.mouse ?? false);
  const [, repaint] = useState(0);
  const lastOrd = useRef<string | undefined>(undefined);
  const targets = useRef(new Map<string, string>());

  const watchList = useWatchList(client, link, initialPoints);
  const alarmStore = useAlarms(client);
  const proposalStore = useProposals(client);
  const activity = useActivity(client, { enabled: view === "home" || view === "activity", station, rangeMs: ACTIVITY_RANGES[rangeIndex] });
  const jobStore = useJobs(client, view === "jobs" || view === "home");

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  useEffect(() => setVisited((set) => (set.has(view) ? set : new Set(set).add(view))), [view]);

  // Connection state and a latency sample every 10 s.
  useEffect(() => {
    const ping = async () => {
      if (!client.connected) return;
      const started = Date.now();
      await client.ping().then(() => setNet((l) => (l.state === "live" ? { ...l, latency: [...l.latency, Date.now() - started].slice(-30) } : l)), () => {});
    };
    const onDown = () => setNet((l) => ({ ...l, state: "reconnecting", detail: undefined }));
    const onRetry = ({ delayMs }: { delayMs: number }) => setNet((l) => ({ ...l, state: "reconnecting", detail: `retry in ${Math.round(delayMs / 1000)}s` }));
    const onUp = () => {
      setNet((l) => ({ ...l, state: "live", detail: undefined }));
      showToast("Reconnected", "good");
    };
    const onError = (error: Error) => {
      if (error instanceof BaskStreamError && error.code === "session_expired") setNet((l) => ({ ...l, state: "down", detail: "session expired" }));
    };
    const onResync = () => showToast("Station dropped events; views refreshed", "warn");
    client.on("disconnected", onDown);
    client.on("reconnecting", onRetry);
    client.on("reconnected", onUp);
    client.on("error", onError);
    client.on("resync", onResync);
    void ping();
    const timer = setInterval(ping, 10000);
    return () => {
      clearInterval(timer);
      client.off("disconnected", onDown);
      client.off("reconnecting", onRetry);
      client.off("reconnected", onUp);
      client.off("error", onError);
      client.off("resync", onResync);
    };
  }, [client]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = useCallback((text: string, tone: Tone = "info") => setToast({ text, tone, at: Date.now() }), []);

  // ---- Other bask windows on this station ---------------------------------------------------------
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    link.start();
    let seen = link.get().show?.n ?? 0;
    const onShared = (next: Shared) => {
      setShared(next);
      const show = next.show;
      if (!show || show.n <= seen) return;
      seen = show.n;
      if (show.from === process.pid) return;
      const target: ViewName = show.kind === "trend" ? "trends" : show.kind === "graphic" ? "graphics" : show.kind === "logic" ? "logic" : "explorer";
      // A pane answers only for the view it is showing; a full dashboard steps in when no window is on it.
      if (viewRef.current !== target && (pane || link.otherShowing(target))) return;
      if (show.kind === "trend") setTrendOrd(toSlotOrd(show.ord));
      else if (show.kind === "graphic") setGraphic((g) => ({ name: show.ord, n: (g?.n ?? 0) + 1 }));
      else if (show.kind === "logic") setLogic((l) => ({ ord: toSlotOrd(show.ord), n: (l?.n ?? 0) + 1 }));
      else setReveal((r) => ({ ord: toSlotOrd(show.ord), n: (r?.n ?? 0) + 1 }));
      setView(target);
    };
    link.on("change", onShared);
    return () => {
      link.off("change", onShared);
      link.stop();
    };
  }, [link]);
  useEffect(() => {
    link.announce(view);
    const timer = setInterval(() => link.announce(viewRef.current), 5000);
    return () => clearInterval(timer);
  }, [view, link]);

  useEffect(() => props.terminal?.(mouseMode(mouseOn)), [mouseOn]);

  // The window title, which multiplexers show on the pane or tab.
  useEffect(() => props.terminal?.(`\x1b]2;${pane ? VIEW_LABEL[view] : `bask · ${station ?? client.http.url.host}`}\x07`), [view, station, pane]);

  const ui = useMemo<Ui>(() => {
    const attempt: Ui["attempt"] = async (label, work) => {
      try {
        return await work();
      } catch (error) {
        const code = error instanceof BaskStreamError ? ` [${error.code}]` : "";
        showToast(`${label} failed${code}: ${error instanceof Error ? error.message : String(error)}`, "bad");
        return undefined;
      }
    };
    const canWrite = (what: string) => {
      if (writes) return true;
      showToast(`This window is read-only. Press W to allow changes, then ${what}.`, "warn");
      return false;
    };
    return {
      allowWrites: writes,
      toast: showToast,
      confirm: (text, onYes, options) => setModal({ kind: "confirm", text, onYes, ...options }),
      prompt: (label, onSubmit, options) => setModal({ kind: "input", label, onSubmit, ...options }),
      select: (label, options, onSelect) => setModal({ kind: "select", label, options: options as never, onSelect: onSelect as (value: unknown) => void }),
      attempt,
      canWrite,
      plan: (title, changes, lines) =>
        new Promise<boolean>((resolve) => {
          void (async () => {
            if (!((client.capabilities.modelEditing ?? {}) as Json).enabled) {
              showToast("Model edits are off on the station: turn on modelEditsEnabled on the BASkStreamService.", "warn");
              return resolve(false);
            }
            const preview = (await attempt(title, () => client.call("preview_model_changes", { changes })))?.result as Json | undefined;
            if (!preview) return resolve(false);
            const detail = lines ?? ((preview.changes ?? []) as Json[]).map((c) => `${String(c.action)} ${String(c.ord ?? c.name ?? "")}`);
            setModal({
              kind: "confirm", title, text: `Apply ${changes.length === 1 ? "this change" : `these ${changes.length} changes`} to the station?`, lines: detail,
              onCancel: () => {
                void client.call("cancel_model_plan", { planId: preview.planId }).catch(() => {});
                resolve(false);
              },
              onYes: async () => {
                const applied = (await attempt(title, () => client.call("apply_model_changes", { planId: preview.planId, planHash: preview.planHash, idempotencyKey: randomUUID() }, { timeoutMs: 120000 })))?.result as Json | undefined;
                const failed = ((applied?.results ?? []) as Json[]).filter((r) => r.ok === false);
                if (!applied) return resolve(false);
                if (applied.state !== "applied" || failed.length) {
                  showToast(`${title}: the plan ended ${String(applied.state)}${failed[0]?.message ? ` (${String(failed[0].message)})` : ""}`, "bad");
                  return resolve(false);
                }
                showToast(`${title}: done`, "good");
                resolve(true);
              }
            });
          })();
        }),
      goto: setView,
      openTrend: (raw) => {
        const ord = toSlotOrd(raw);
        link.update((s) => void (s.trends = [ord, ...s.trends.filter((o) => o !== ord)].slice(0, 12)));
        if (pane && view !== "trends" && link.otherShowing("trends")) {
          link.show("trend", ord);
          return showToast(`Charted ${place(ord)} in the Trends window`, "info");
        }
        setTrendOrd(ord);
        setView("trends");
      },
      reveal: (raw) => {
        const ord = toSlotOrd(raw);
        if (pane && view !== "explorer" && link.otherShowing("explorer")) {
          link.show("reveal", ord);
          return showToast(`Shown ${place(ord)} in the Explorer window`, "info");
        }
        setReveal((r) => ({ ord, n: (r?.n ?? 0) + 1 }));
        setView("explorer");
      },
      watch: (raw) => {
        const ord = toSlotOrd(raw);
        if (watchList.points.some((p) => p.ord === ord)) return showToast("Already on the watch list", "info");
        void attempt("watch", async () => {
          await watchList.add(ord);
          showToast(`Watching ${place(ord)}${view === "watch" ? "" : " · press 3 to see it"}`, "good");
        });
      },
      discover: (raw) => {
        if (!canWrite("start a discovery")) return;
        const ord = toSlotOrd(raw);
        setModal({
          kind: "confirm", title: "Discover", text: `Start discovery on ${place(ord)}?`, lines: ["A network finds its devices; a device finds its points.", "This puts traffic on the driver's network."],
          onYes: async () => {
            const discovery = await attempt("discover", () => client.discover(ord));
            if (!discovery) return;
            targets.current.set(discovery.job, discovery.kind === "devices" ? ord : "");
            setFocusJob((f) => ({ job: discovery.job, n: (f?.n ?? 0) + 1 }));
            setView("jobs");
            void jobStore.reload();
          }
        });
      },
      runQuery: (query) => {
        setQueryRun((q) => ({ n: (q?.n ?? 0) + 1, ...query }));
        setView("query");
      },
      copy: (text, what = "text") => {
        if (!text) return;
        props.terminal?.(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
        showToast(`Copied the ${what}: ${clip(text, 60)}`, "good");
      },
      typing: setTyping,
      suspend: (work) => (props.suspend ? props.suspend(work) : work())
    };
  }, [writes, showToast, view, pane, watchList.points, client, link]);

  const toggleWrites = () => {
    if (writes) {
      setWrites(false);
      return showToast("This window is read-only again.", "info");
    }
    setModal({
      kind: "confirm", title: "Allow changes", text: `Allow changes from this window?`,
      lines: [`Point commands, acknowledgements, file and model edits will go to ${station ?? client.http.url.host}`, `as ${String(client.capabilities.authenticatedUser ?? "this user")}. Each one still asks before it is sent.`],
      onYes: () => {
        setWrites(true);
        showToast("Changes are allowed in this window. Press W to turn them off.", "warn");
      }
    });
  };

  const commands = useMemo<Command[]>(
    () => [
      ...VIEWS.map((name, i) => ({ title: VIEW_LABEL[name], group: "View", keys: KEY_OF(i), run: () => setView(name) })),
      { title: "Find a point or component…", group: "Search", keys: "/", run: () => setOverlay("find") },
      { title: writes ? "Make this window read-only" : "Allow changes from this window", group: "Safety", keys: "W", run: toggleWrites },
      { title: "Discover devices or points…", group: "Driver", run: () => setModal({ kind: "input", label: "Discover on which BACnet network or device?", initial: lastOrd.current, hint: "ORD", onSubmit: (ord) => ord.trim() && ui.discover(ord.trim()) }) },
      ...REPORTS.map((report) => ({ title: report.title, group: "Report", run: () => ui.runQuery(report.bql ? { bql: report.bql } : { neql: report.neql }) })),
      { title: "Save station", group: "Station", run: () => ui.canWrite("save the station") && void ui.plan("Save station", [{ action: "invoke", ord: "slot:/", slot: "save" }], ["Writes the running configuration to the station's config.bog."]) },
      { title: "Acknowledge every unacknowledged alarm", group: "Alarms", run: () => {
        const uuids = [...alarmStore.alarms.values()].filter(isUnacked).map((a) => String(a.uuid));
        if (!ui.canWrite("acknowledge alarms")) return;
        if (uuids.length === 0) return showToast("Nothing to acknowledge.", "info");
        ui.confirm(`Acknowledge ${uuids.length} alarm${uuids.length === 1 ? "" : "s"}?`, () => void ui.attempt("ack", () => client.ackAlarms({ uuids })).then((r) => r && showToast(`${uuids.length} acknowledged`, "good")));
      } },
      { title: "Copy the selected ORD", group: "Explorer", keys: "y", run: () => lastOrd.current && ui.copy(lastOrd.current, "ORD") },
      { title: `Use the ${theme.name === "dark" ? "light" : "dark"} theme`, group: "Look", run: () => {
        setTheme(theme.name === "dark" ? "light" : "dark");
        repaint((n) => n + 1);
      } },
      ...(!props.terminal ? [] : [{ title: mouseOn ? "Turn the mouse off (to select text)" : "Turn the mouse on", group: "Look", run: () => setMouseOn((on) => !on) }]),
      { title: "Help", group: "bask", keys: "?", run: () => setOverlay("help") },
      ...(props.onBack ? [{ title: "All stations", group: "bask", keys: "F", run: () => props.onBack!() }] : []),
      { title: "Quit", group: "bask", keys: props.onBack ? "" : "q", run: () => exit() }
    ],
    [writes, ui, mouseOn, alarmStore.alarms]
  );

  useKeys((input, key) => {
    if (key.ctrl && input === "c") return exit();
    if (modal || overlay) return;
    if (key.ctrl && input === "k") return setOverlay("palette");
    if (typing) return;
    if (input === "q" || (input === "F" && props.onBack)) return leave();
    if (input === ":") return setOverlay("palette");
    if (input === "?") return setOverlay("help");
    if (input === "/") return setOverlay("find");
    if (input === "W") return toggleWrites();
    if (/^[0-9]$/.test(input)) return setView(VIEWS[(Number(input) + 9) % 10]);
    if (input === "g") return setView("graphics");
    if (input === "L") {
      // From the Explorer, the wire sheet of what is selected there: the folder itself, or the one a point sits in.
      if (view === "explorer" && lastOrd.current) setLogic((l) => ({ ord: lastOrd.current!, n: (l?.n ?? 0) + 1 }));
      return setView("logic");
    }
    if (key.tab) setView((v) => VIEWS[(VIEWS.indexOf(v) + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length]);
  });

  const unacked = [...alarmStore.alarms.values()].filter(isUnacked).length;
  const pendingProposals = [...proposalStore.proposals.values()].filter((p) => p.status === "pending").length;
  const runningJobs = jobStore.jobs.filter((j) => !j.complete).length;

  // The sidekick mentions each new proposal while you're looking at something else.
  useEffect(() => {
    const onProposal = (p: Proposal) => {
      // A workspace with an AI Activity window already shows it there.
      if (p.status === "pending" && viewRef.current !== "activity" && !(pane && link.otherShowing("activity"))) showToast(`New proposal ${p.id} from ${proposalActor(p)}: ${p.description}. Press 0 to review.`, "warn");
    };
    client.on("proposal", onProposal);
    return () => void client.off("proposal", onProposal);
  }, [client]);

  const width = Math.max(40, size.columns);
  const height = Math.max(12, size.rows);
  const headRows = pane ? 1 : 2;
  const bodyHeight = height - headRows - 1;
  const rect = useMemo<Rect>(() => ({ x: 0, y: headRows, width, height: bodyHeight }), [width, bodyHeight, headRows]);
  const viewActive = !modal && !overlay;
  const host = client.http.url.host;
  const user = String(client.capabilities.authenticatedUser ?? "");
  const watchedSet = useMemo(() => new Set(watchList.points.map((p) => p.ord)), [watchList.points]);
  const trendChoices = useMemo(() => [...new Set([...(trendOrd ? [trendOrd] : []), ...watchList.points.map((p) => p.ord), ...shared.trends])], [trendOrd, watchList.points, shared.trends]);

  // ---- Header -------------------------------------------------------------------------------------
  const badges: Partial<Record<ViewName, { text: string; color: string }>> = {
    watch: watchList.points.length ? { text: String(watchList.points.length), color: theme.muted } : undefined,
    alarms: alarmStore.alarms.size ? { text: String(unacked || alarmStore.alarms.size), color: unacked ? theme.bad : theme.muted } : undefined,
    jobs: runningJobs ? { text: String(runningJobs), color: theme.warn } : undefined,
    activity: pendingProposals ? { text: String(pendingProposals), color: theme.warn } : undefined
  };
  const fullTabs = VIEWS.reduce((n, name, i) => n + VIEW_LABEL[name].length + 4 + (badges[name] ? badges[name]!.text.length + 1 : 0) + (i ? 1 : 0), 0) <= width;
  const tabs: { name: ViewName; text: string; from: number; to: number }[] = [];
  let column = 0;
  VIEWS.forEach((name, i) => {
    const text = fullTabs || name === view ? ` ${KEY_OF(i)} ${VIEW_LABEL[name]} ` : ` ${KEY_OF(i)} `;
    const length = text.length + (badges[name] ? (fullTabs || name === view ? badges[name]!.text.length : 1) + 1 : 0) + 1;
    tabs.push({ name, text, from: column, to: column + length });
    column += length;
  });
  useMouse((e) => {
    if (e.kind !== "down" || e.y !== 1 || pane) return;
    const tab = tabs.find((t) => e.x >= t.from && e.x < t.to);
    if (tab) setView(tab.name);
  }, viewActive && mouseOn);

  const clockText = (() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  })();
  const latency = net.latency[net.latency.length - 1];
  const title = pane ? ` ◆ ${VIEW_LABEL[view]} ` : " ◆ bask ";
  const name = station ?? profileName;
  // The right side of the header gives way as the window narrows: the clock goes first, then the
  // read-only note, then the words beside each mark.
  type Part = { id: string; text: string; short?: string; color: string; filled?: boolean };
  let right: Part[] = [
    ...(unacked > 0 && view !== "alarms" ? [{ id: "alarms", text: ` ${unacked} unacked `, short: ` ${unacked}▲ `, color: theme.bad, filled: true }] : []),
    ...(pendingProposals > 0 && view !== "activity" ? [{ id: "waiting", text: ` ${pendingProposals} waiting `, short: ` ${pendingProposals}◷ `, color: theme.warn, filled: true }] : []),
    net.state === "live" ? { id: "link", text: `● live${latency !== undefined ? ` ${latency} ms` : ""}`, short: "●", color: theme.good } : net.state === "reconnecting" ? { id: "link", text: `◌ reconnecting${net.detail ? ` (${net.detail})` : ""}`, short: "◌", color: theme.warn } : { id: "link", text: `✕ ${net.detail ?? "offline"}`, short: "✕", color: theme.bad },
    writes ? { id: "mode", text: "✎ changes on", short: "✎", color: theme.warn } : { id: "mode", text: "read-only", color: theme.muted },
    { id: "clock", text: clockText, color: theme.muted }
  ];
  const lengthOf = (parts: Part[]) => parts.reduce((n, p) => n + p.text.length + 2, 0);
  const fits = (parts: Part[]) => title.length + 2 + Math.min(name.length, 10) + 1 + lengthOf(parts) <= width;
  if (!fits(right) || width < 96) right = right.filter((p) => p.id !== "clock");
  if (!fits(right)) right = right.filter((p) => p.id !== "mode" || writes);
  if (!fits(right)) right = right.map((p) => (p.short ? { ...p, text: p.short } : p));
  const leftRoom = Math.max(0, width - title.length - lengthOf(right) - 3);
  const shownName = clip(name, Math.min(30, leftRoom));
  const shownIdentity = clip(` · ${user ? `${user}@` : ""}${host}`, Math.max(0, leftRoom - shownName.length));
  const headerGap = Math.max(1, width - title.length - 2 - shownName.length - (shownIdentity.length > 4 ? shownIdentity.length : 0) - lengthOf(right));

  // Footer hints: the ones that work everywhere always show; the view's own fill what is left.
  const everywhere: [string, string][] = overlay || typing ? [] : [["/", "find"], [":", "commands"], ...(pane ? ([["1-0", "views"]] as [string, string][]) : []), ["?", "help"], ["q", props.onBack ? "all stations" : "quit"]];
  const hintLength = ([k, label]: [string, string]) => k.length + label.length + 4;
  let hintRoom = width - everywhere.reduce((n, h) => n + hintLength(h), 0);
  const hints = (overlay ? [] : HINTS[view]).filter((h) => (hintRoom -= hintLength(h)) >= 0);

  return (
    <UiContext.Provider value={ui}>
      <Box flexDirection="column" width={width} height={height}>
        <Text wrap="truncate-end">
          <Text backgroundColor={theme.accent} color={theme.onAccent} bold>{title}</Text>
          <Text bold>{`  ${shownName}`}</Text>
          <Text color={theme.muted}>{shownIdentity.length > 4 ? shownIdentity : ""}</Text>
          {" ".repeat(headerGap)}
          {right.map((p) => (
            <Text key={p.id}>
              {p.filled ? <Text backgroundColor={p.color} color={theme.onAccent} bold>{p.text}</Text> : <Text color={p.color}>{p.text}</Text>}
              {"  "}
            </Text>
          ))}
        </Text>
        {!pane && (
          <Text wrap="truncate-end">
            {tabs.map(({ name, text }) => {
              const on = view === name;
              const badge = badges[name];
              return (
                <Text key={name}>
                  <Text color={on ? theme.onAccent : theme.muted} backgroundColor={on ? theme.accent2 : undefined} bold={on}>{text}</Text>
                  {badge ? <Text color={badge.color} bold>{fullTabs || on ? badge.text : "●"} </Text> : null}{" "}
                </Text>
              );
            })}
          </Text>
        )}

        <Box height={bodyHeight} flexDirection="column">
          {overlay === "help" ? (
            <Help width={width} height={bodyHeight} view={view} close={() => setOverlay(undefined)} />
          ) : overlay === "find" && !modal ? (
            <Finder client={client} width={width} height={bodyHeight} onClose={() => setOverlay(undefined)} onReveal={(ord) => (setOverlay(undefined), ui.reveal(ord))} onWatch={ui.watch} onTrend={(ord) => (setOverlay(undefined), ui.openTrend(ord))} />
          ) : overlay === "palette" && !modal ? (
            <Palette commands={commands} width={width} height={bodyHeight} onClose={() => setOverlay(undefined)} onGoto={(ord) => ui.reveal(ord)} />
          ) : modal ? (
            <Box height={bodyHeight} justifyContent="center" alignItems="center" flexDirection="column">
              <ModalBox modal={modal} close={() => setModal(undefined)} width={width} />
            </Box>
          ) : null}
          <Box display={modal || overlay ? "none" : "flex"} flexDirection="column">
            {visited.has("home") && (
              <Box display={view === "home" ? "flex" : "none"}>
                <HomeView client={client} active={viewActive && view === "home"} rect={rect} profileName={profileName} station={station} allowWrites={writes} link={net} alarms={alarmStore.alarms} alarmsLoaded={alarmStore.loadedAt !== undefined} proposals={proposalStore.proposals} activity={activity.entries} activityLoaded={activity.loaded} watch={watchList.points} jobs={jobStore.jobs} />
              </Box>
            )}
            {visited.has("explorer") && (
              <Box display={view === "explorer" ? "flex" : "none"}>
                <ExplorerView client={client} active={viewActive && view === "explorer"} rect={rect} watched={watchedSet} reveal={reveal} onSelect={(ord) => void (lastOrd.current = ord)} />
              </Box>
            )}
            {view === "watch" && <WatchView client={client} active={viewActive} rect={rect} points={watchList.points} onRemove={(ord) => void watchList.remove(ord)} />}
            {view === "alarms" && <AlarmsView client={client} active={viewActive} rect={rect} alarms={alarmStore.alarms} error={alarmStore.error} loaded={alarmStore.loadedAt !== undefined} lastEventAt={alarmStore.lastEventAt} reload={alarmStore.reload} />}
            {visited.has("trends") && (
              <Box display={view === "trends" ? "flex" : "none"}>
                <TrendsView client={client} active={viewActive && view === "trends"} rect={rect} ord={trendOrd} choices={trendChoices} onPick={setTrendOrd} />
              </Box>
            )}
            {visited.has("schedules") && (
              <Box display={view === "schedules" ? "flex" : "none"}>
                <SchedulesView client={client} active={viewActive && view === "schedules"} rect={rect} />
              </Box>
            )}
            {visited.has("query") && (
              <Box display={view === "query" ? "flex" : "none"}>
                <QueryView client={client} active={viewActive && view === "query"} rect={rect} history={shared.queries} onRan={(text) => link.update((s) => void (s.queries = [text, ...s.queries.filter((q) => q !== text)].slice(0, 30)))} run={queryRun} />
              </Box>
            )}
            {visited.has("files") && (
              <Box display={view === "files" ? "flex" : "none"}>
                <FilesView client={client} active={viewActive && view === "files"} rect={rect} />
              </Box>
            )}
            {visited.has("jobs") && (
              <Box display={view === "jobs" ? "flex" : "none"}>
                <JobsView client={client} active={viewActive && view === "jobs"} rect={rect} jobs={jobStore.jobs} loaded={jobStore.loaded} error={jobStore.error} reload={jobStore.reload} targets={targets.current} focusJob={focusJob} lastOrd={lastOrd.current} />
              </Box>
            )}
            {visited.has("graphics") && (
              <Box display={view === "graphics" ? "flex" : "none"}>
                <GraphicsView client={client} active={viewActive && view === "graphics"} rect={rect} show={graphic} />
              </Box>
            )}
            {visited.has("logic") && (
              <Box display={view === "logic" ? "flex" : "none"}>
                <LogicView client={client} active={viewActive && view === "logic"} rect={rect} show={logic} />
              </Box>
            )}
            {view === "activity" && (
              <ActivityView client={client} active={viewActive} rect={rect} entries={activity.entries} proposals={proposalStore.proposals} loaded={activity.loaded} error={activity.error} auditNote={activity.auditNote} lastNewAt={activity.lastNewAt} agentUsers={activity.agentUsers} rangeIndex={rangeIndex} setRangeIndex={setRangeIndex} reload={activity.reload} />
            )}
          </Box>
        </Box>

        <Box width={width}>
          {toast ? (
            <Text color={toneColor(toast.tone)} wrap="truncate-end">
              {toast.tone === "bad" ? "✕ " : toast.tone === "good" ? "✓ " : toast.tone === "warn" ? "! " : "• "}
              {toast.text}
            </Text>
          ) : (
            <Text wrap="truncate-end">
              {hints.map(([k, label]) => (
                <Hint key={k} k={k} label={label} />
              ))}
              {everywhere.map(([k, label]) => (
                <Hint key={k} k={k} label={label} />
              ))}
              {typing && <Text color={theme.muted}>enter run · esc leave the query line · ↑↓ earlier queries · ctrl+k commands</Text>}
            </Text>
          )}
        </Box>
      </Box>
    </UiContext.Provider>
  );
}

function Help({ width, height, view, close }: { width: number; height: number; view: ViewName; close: () => void }) {
  useKeys(() => close());
  const everywhere: [string, string][] = [["1 … 0", "switch view"], ["tab", "next view"], ["/", "find by name"], [": ctrl+k", "every command"], ["W", "allow changes / read-only"], ["?", "this help"], ["q", "quit"]];
  // This view's keys come first; the others follow for as long as there is room.
  const sections: { title: string; rows: [string, string][] }[] = [
    { title: "Everywhere", rows: everywhere },
    ...[view, ...VIEWS.filter((name) => name !== view)].filter((name) => HINTS[name].length).map((name) => ({ title: VIEW_LABEL[name], rows: HINTS[name] }))
  ];
  const columnWidth = 34;
  const columnCount = Math.max(1, Math.floor((width - 4) / columnWidth));
  const room = Math.max(4, height - 3);
  const columns: (typeof sections)[] = [[]];
  let used = 0;
  let left = sections.length;
  for (const section of sections) {
    const tall = section.rows.length + 2;
    if (used + tall > room && columns[columns.length - 1].length > 0) {
      if (columns.length === columnCount) break;
      columns.push([]);
      used = 0;
    }
    if (used + tall > room) break;
    columns[columns.length - 1].push(section);
    used += tall;
    left -= 1;
  }
  return (
    <Box flexDirection="column" paddingX={2} width={width} height={height} overflow="hidden">
      <Box height={room}>
        {columns.map((column, i) => (
          <Box key={i} flexDirection="column" width={columnWidth}>
            {column.map((section) => (
              <Box key={section.title} flexDirection="column" marginBottom={1}>
                <Text bold color={section.title === VIEW_LABEL[view] ? theme.accent : theme.accent2}>{section.title}</Text>
                {section.rows.map(([k, label]) => (
                  <Text key={k} wrap="truncate-end">
                    <Text color={theme.accent} bold>{k.padEnd(9)}</Text>
                    {clip(label, columnWidth - 11)}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <Text color={theme.muted} wrap="truncate-end">
        {left > 0 ? "More views' keys fit in a larger window. " : ""}Changes need W and each one asks first. The mouse works: click tabs and rows, scroll with the wheel. Any key closes.
      </Text>
    </Box>
  );
}
