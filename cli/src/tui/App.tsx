import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { BaskStreamError, toSlotOrd, type BaskStreamClient } from "@basidekick/baskstream";
import { isUnacked } from "../format.js";
import { AlarmsView } from "./AlarmsView.js";
import { BrowseView } from "./BrowseView.js";
import { HistoryView } from "./HistoryView.js";
import { StatusView } from "./StatusView.js";
import { useAlarms, useWatchList } from "./stores.js";
import { Hint, ModalBox, UiContext, theme, toneColor, type Modal, type Tone, type Ui } from "./ui.js";
import { WatchView } from "./WatchView.js";
import { Finder } from "./Finder.js";

const VIEWS = ["browse", "watch", "alarms", "history", "status"] as const;
export type ViewName = (typeof VIEWS)[number];

const HINTS: Record<ViewName, [string, string][]> = {
  browse: [["↑↓", "move"], ["→←", "open/close"], ["w", "watch"], ["t", "trend"], ["r", "refresh"]],
  watch: [["↑↓", "move"], ["t", "trend"], ["d", "remove"], ["o", "override"], ["s", "set"], ["a", "auto"]],
  alarms: [["↑↓", "move"], ["⏎", "details"], ["a", "ack"], ["A", "ack all"], ["u", "unacked only"], ["t", "trend source"]],
  history: [["+ -", "zoom"], ["← →", "pan"], ["n", "now"], ["r", "reload"]],
  status: []
};

const FIND_HINTS: [string, string][] = [["↑↓", "move"], ["⏎", "show in tree"], ["tab", "watch point"], ["esc", "close"]];

export interface AppProps {
  client: BaskStreamClient;
  profileName: string;
  allowWrites: boolean;
  view?: ViewName;
  points?: string[];
}

export function App({ client, profileName, allowWrites, view: initialView, points: initialPoints = [] }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [view, setView] = useState<ViewName>(initialView ?? "browse");
  const [modal, setModal] = useState<Modal>();
  const [toast, setToast] = useState<{ text: string; tone: Tone; at: number }>();
  const [link, setLink] = useState<{ state: "live" | "reconnecting" | "down"; latency?: number; detail?: string }>({ state: "live" });
  const [historyOrd, setHistoryOrd] = useState<string>();
  const [showHelp, setShowHelp] = useState(false);
  const [finding, setFinding] = useState(false);
  const [reveal, setReveal] = useState<{ ord: string; n: number }>();

  const watchList = useWatchList(client, initialPoints);
  const alarmStore = useAlarms(client);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  // Connection state and a latency sample every 10 s.
  useEffect(() => {
    const ping = async () => {
      if (!client.connected) return;
      const started = Date.now();
      await client.ping().then(() => setLink((l) => (l.state === "live" ? { ...l, latency: Date.now() - started } : l)), () => {});
    };
    const onDown = () => setLink({ state: "reconnecting" });
    const onRetry = ({ delayMs }: { delayMs: number }) => setLink({ state: "reconnecting", detail: `retry in ${Math.round(delayMs / 1000)}s` });
    const onUp = () => {
      setLink({ state: "live" });
      showToast("Reconnected", "good");
    };
    const onError = (error: Error) => {
      if (error instanceof BaskStreamError && error.code === "session_expired") setLink({ state: "down", detail: "session expired" });
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
    const timer = setTimeout(() => setToast(undefined), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = useCallback((text: string, tone: Tone = "info") => setToast({ text, tone, at: Date.now() }), []);

  const ui = useMemo<Ui>(
    () => ({
      allowWrites,
      toast: showToast,
      confirm: (text, onYes) => setModal({ kind: "confirm", text, onYes }),
      prompt: (label, onSubmit, initial) => setModal({ kind: "input", label, onSubmit, initial }),
      attempt: async (label, work) => {
        try {
          return await work();
        } catch (error) {
          const code = error instanceof BaskStreamError ? ` [${error.code}]` : "";
          showToast(`${label} failed${code}: ${error instanceof Error ? error.message : String(error)}`, "bad");
          return undefined;
        }
      },
      openHistory: (ord) => {
        setHistoryOrd(toSlotOrd(ord));
        setView("history");
      }
    }),
    [allowWrites, showToast]
  );

  useInput(
    (input, key) => {
      if (showHelp) return setShowHelp(false);
      if (input === "q" || (key.ctrl && input === "c")) return exit();
      if (input === "?") return setShowHelp(true);
      if (input === "/") return setFinding(true);
      const index = Number(input);
      if (index >= 1 && index <= VIEWS.length) return setView(VIEWS[index - 1]);
      if (key.tab) setView((v) => VIEWS[(VIEWS.indexOf(v) + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length]);
    },
    { isActive: !modal && !finding }
  );

  const watchedSet = useMemo(() => new Set(watchList.points.map((p) => p.ord)), [watchList.points]);
  const unacked = [...alarmStore.alarms.values()].filter(isUnacked).length;

  // The sidekick points out unacknowledged alarms once, after the first alarm load.
  const greeted = useRef(false);
  useEffect(() => {
    if (greeted.current || alarmStore.loadedAt === undefined) return;
    greeted.current = true;
    if (unacked > 0 && view !== "alarms") showToast(`Found ${unacked} unacked alarm${unacked === 1 ? "" : "s"}. Press 3 to take a look.`, "info");
  }, [alarmStore.loadedAt]);
  // One row short of the terminal: a frame as tall as the screen makes Ink clear and redraw
  // everything on each update, which floods scrollback in some terminals.
  const height = Math.max(11, size.rows - 1);
  const bodyHeight = height - 3;
  const width = size.columns;
  const viewActive = !modal && !showHelp && !finding;
  const host = client.http.url.host;
  const user = String(client.capabilities.authenticatedUser ?? "");

  const addWatch = (ord: string) => {
    if (watchedSet.has(ord)) return showToast("Already watching", "info");
    void ui.attempt("watch", async () => {
      await watchList.add(ord);
      showToast(`Watching ${ord.split("/").pop()} · press 2 to see it`, "good");
    });
  };

  const tabs: [ViewName, string, string?][] = [
    ["browse", "Browse"],
    ["watch", "Watch", watchList.points.length ? String(watchList.points.length) : undefined],
    ["alarms", "Alarms", alarmStore.alarms.size ? String(alarmStore.alarms.size) : undefined],
    ["history", "History"],
    ["status", "Status"]
  ];

  return (
    <UiContext.Provider value={ui}>
      <Box flexDirection="column" width={width} height={height}>
        <Box justifyContent="space-between" width={width}>
          <Text wrap="truncate-end">
            <Text backgroundColor={theme.accent} color="black" bold>
              {" ◆ baskStream "}
            </Text>
            <Text color={theme.muted}>
              {"  "}
              {profileName} · {user ? `${user}@` : ""}
              {host}
            </Text>
          </Text>
          <Text>
            {link.state === "live" ? (
              <Text color={theme.good}>● live{link.latency !== undefined ? ` ${link.latency}ms` : ""}</Text>
            ) : link.state === "reconnecting" ? (
              <Text color={theme.warn}>◌ reconnecting{link.detail ? ` (${link.detail})` : ""}</Text>
            ) : (
              <Text color={theme.bad}>✕ {link.detail ?? "offline"}</Text>
            )}
            {allowWrites ? <Text color={theme.warn}>  ✎ writes on</Text> : <Text color={theme.muted}>  read-only</Text>}{" "}
          </Text>
        </Box>
        <Text wrap="truncate-end">
          {tabs.map(([name, label, badge], i) => {
            const on = view === name;
            const badgeColor = name === "alarms" && unacked ? theme.bad : theme.muted;
            return (
              <Text key={name}>
                <Text color={on ? "black" : theme.muted} backgroundColor={on ? theme.accent2 : undefined} bold={on}>
                  {` ${i + 1} ${label} `}
                </Text>
                {badge ? (
                  <Text color={badgeColor} bold={name === "alarms" && unacked > 0}>
                    {badge}
                  </Text>
                ) : null}
                {"  "}
              </Text>
            );
          })}
        </Text>

        <Box height={bodyHeight} flexDirection="column">
          {showHelp ? (
            <Help />
          ) : finding && !modal ? (
            <Finder
              client={client}
              width={width}
              height={bodyHeight}
              onClose={() => setFinding(false)}
              onReveal={(ord) => {
                setFinding(false);
                setView("browse");
                setReveal((r) => ({ ord, n: (r?.n ?? 0) + 1 }));
              }}
              onWatch={addWatch}
            />
          ) : modal ? (
            <Box height={bodyHeight} justifyContent="center" alignItems="center" flexDirection="column">
              <ModalBox modal={modal} close={() => setModal(undefined)} />
            </Box>
          ) : null}
          <Box display={showHelp || modal || finding ? "none" : "flex"} flexDirection="column">
            <Box display={view === "browse" ? "flex" : "none"}>
              <BrowseView client={client} active={viewActive && view === "browse"} width={width} height={bodyHeight} watched={watchedSet} onWatch={addWatch} reveal={reveal} />
            </Box>
            {view === "watch" && <WatchView client={client} active={viewActive} width={width} height={bodyHeight} points={watchList.points} onRemove={(ord) => void watchList.remove(ord)} />}
            {view === "alarms" && <AlarmsView client={client} active={viewActive} width={width} height={bodyHeight} alarms={alarmStore.alarms} error={alarmStore.error} loaded={alarmStore.loadedAt !== undefined} reload={alarmStore.reload} />}
            {view === "history" && <HistoryView client={client} active={viewActive} width={width} height={bodyHeight} ord={historyOrd} />}
            {view === "status" && <StatusView client={client} active={viewActive} width={width} height={bodyHeight} profileName={profileName} allowWrites={allowWrites} />}
          </Box>
        </Box>

        <Box width={width}>
          {toast ? (
            <Text color={toneColor(toast.tone)} wrap="truncate-end">
              {toast.tone === "bad" ? "✕ " : toast.tone === "good" ? "✓ " : "• "}
              {toast.text}
            </Text>
          ) : (
            <Text wrap="truncate-end">
              {(finding ? FIND_HINTS : HINTS[view]).map(([k, label]) => (
                <Hint key={k} k={k} label={label} />
              ))}
              {!finding && (
                <>
                  <Hint k="/" label="find" />
                  <Hint k="1-5" label="views" />
                  <Hint k="?" label="help" />
                  <Hint k="q" label="quit" />
                </>
              )}
            </Text>
          )}
        </Box>
      </Box>
    </UiContext.Provider>
  );
}

function Help() {
  const section = (title: string, rows: [string, string][]) => (
    <Box flexDirection="column" marginRight={4} marginBottom={1}>
      <Text bold color={theme.accent2}>
        {title}
      </Text>
      {rows.map(([k, label]) => (
        <Text key={k}>
          <Text color={theme.accent} bold>
            {k.padEnd(8)}
          </Text>
          {label}
        </Text>
      ))}
    </Box>
  );
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box flexWrap="wrap">
        {section("Everywhere", [["/", "find a point"], ["1-5", "switch view"], ["tab", "next view"], ["?", "this help"], ["q", "quit"]])}
        {section("Find", [["type", "search the station"], ["⏎", "show in tree"], ["tab", "watch point"], ["esc", "close"]])}
        {section("Browse", HINTS.browse)}
        {section("Watch", HINTS.watch)}
        {section("Alarms", HINTS.alarms)}
        {section("History", HINTS.history)}
      </Box>
      <Text color={theme.muted}>Commands that change the station need --allow-writes and ask before sending. Press any key to close.</Text>
    </Box>
  );
}
