// All stations at once: one card per station with its link, alarms, AI activity and a few live
// values, and the newest alarms from every station underneath. Enter opens a station's dashboard.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import type { AgentLogRecord, BaskStreamClient, Json } from "@basidekick/baskstream";
import { ago, alarmMessage, alarmState, fmtPoint, isUnacked, place, sparkline } from "../format.js";
import type { Link, Shared } from "../link.js";
import { App } from "./App.js";
import { inside, useKeyPump, useKeys, useMouse, type Rect } from "./input.js";
import { useAlarms, useLiveValues, useProposals, useStationName } from "./stores.js";
import { Badge, Hint, Panel, clip, padEnd, padStart, statusTone, theme, useTick } from "./ui.js";
import { outcomeLook } from "./views/Activity.js";
import { alarmColor } from "./views/Alarms.js";
import { equipmentOf, nameOf } from "./views/Watch.js";

export interface FleetEntry {
  /** The saved profile this station comes from. */
  profile: string;
  /** Shown until the station reports its own name. */
  label: string;
  host: string;
  /** Connects without asking for anything; rejects with what to do when it cannot. */
  connect: () => Promise<BaskStreamClient>;
  /** The watch list and other state shared with this station's other windows. */
  link: Link;
}

type Conn = { state: "connecting" | "live" | "failed"; client?: BaskStreamClient; error?: string };

interface Summary {
  name: string;
  link: "live" | "reconnecting" | "down";
  unacked: number;
  open: number;
  pending: number;
  /** The newest alarms, for the list across stations. */
  alarms: Json[];
}

export function Fleet(props: { entries: FleetEntry[]; allowWrites: boolean; mouse?: boolean; suspend?: (work: () => void) => void; terminal?: (data: string) => void }) {
  const { entries } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 120, rows: stdout.rows || 36 });
  const [conns, setConns] = useState<Conn[]>(() => entries.map(() => ({ state: "connecting" })));
  const [summaries, setSummaries] = useState<(Summary | undefined)[]>(() => entries.map(() => undefined));
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<number>();
  useKeyPump();
  useTick(30000);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  const connect = useCallback((index: number) => {
    setConns((list) => list.map((c, i) => (i === index ? { state: "connecting" } : c)));
    entries[index].connect().then(
      (client) => setConns((list) => list.map((c, i) => (i === index ? { state: "live", client } : c))),
      (error: Error) => setConns((list) => list.map((c, i) => (i === index ? { state: "failed", error: error.message } : c)))
    );
  }, [entries]);
  useEffect(() => {
    entries.forEach((_entry, index) => connect(index));
    for (const entry of entries) entry.link.start();
  }, []);
  useEffect(() => props.terminal?.(`\x1b]2;bask · ${entries.length} stations\x07`), [open]);

  const report = useCallback((index: number, summary: Summary) => setSummaries((list) => list.map((s, i) => (i === index ? summary : s))), []);

  // ---- Layout -------------------------------------------------------------------------------------
  const width = Math.max(40, size.columns);
  const height = Math.max(12, size.rows);
  const bodyHeight = height - 2;
  // As many columns as fit, but not a layout that leaves one card alone on the last row.
  const fits = Math.min(entries.length, width >= 200 ? 4 : width >= 150 ? 3 : width >= 96 ? 2 : 1);
  const columns = fits > 2 && entries.length % fits === 1 ? fits - 1 : fits;
  const rowCount = Math.ceil(entries.length / columns);
  const cardWidth = Math.floor(width / columns);
  const wantTicker = bodyHeight - rowCount * 10 >= 6;
  const tickerHeight = wantTicker ? Math.min(12, Math.max(6, bodyHeight - rowCount * 14)) : 0;
  const shownRows = Math.max(1, Math.min(rowCount, Math.floor((bodyHeight - tickerHeight) / 9)));
  const cardHeight = Math.max(8, Math.min(18, Math.floor((bodyHeight - tickerHeight) / shownRows)));
  const selectedRow = Math.floor(selected / columns);
  const firstRow = Math.max(0, Math.min(selectedRow - Math.floor(shownRows / 2), rowCount - shownRows));
  const rectOf = (index: number): Rect => ({ x: (index % columns) * cardWidth, y: 1 + (Math.floor(index / columns) - firstRow) * cardHeight, width: cardWidth, height: cardHeight });

  const openStation = (index: number) => {
    if (conns[index]?.client) setOpen(index);
    else if (conns[index]?.state === "failed") connect(index);
  };

  useKeys(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) return exit();
      const move = (delta: number) => setSelected((s) => Math.max(0, Math.min(entries.length - 1, s + delta)));
      if (key.leftArrow || input === "h") move(-1);
      else if (key.rightArrow || input === "l" || key.tab) move(1);
      else if (key.upArrow || input === "k") move(-columns);
      else if (key.downArrow || input === "j") move(columns);
      else if (key.return) openStation(selected);
      else if (input === "r") connect(selected);
      else if (/^[1-9]$/.test(input) && Number(input) <= entries.length) {
        setSelected(Number(input) - 1);
        openStation(Number(input) - 1);
      }
    },
    { isActive: open === undefined }
  );
  useMouse((e) => {
    if (e.kind !== "down") return;
    const index = entries.findIndex((_entry, i) => Math.floor(i / columns) >= firstRow && Math.floor(i / columns) < firstRow + shownRows && inside(e, rectOf(i)));
    if (index < 0) return;
    if (index === selected) openStation(index);
    else setSelected(index);
  }, open === undefined && !!props.mouse);

  if (open !== undefined && conns[open]?.client) {
    return <App client={conns[open].client!} profileName={entries[open].profile} allowWrites={props.allowWrites} link={entries[open].link} mouse={props.mouse} suspend={props.suspend} terminal={props.terminal} onBack={() => setOpen(undefined)} />;
  }

  // ---- Totals and the alarms from every station ---------------------------------------------------
  const known = summaries.filter((s): s is Summary => !!s);
  const live = conns.filter((c) => c.state === "live").length;
  const failed = conns.filter((c) => c.state === "failed").length;
  const unacked = known.reduce((n, s) => n + s.unacked, 0);
  const openAlarms = known.reduce((n, s) => n + s.open, 0);
  const pending = known.reduce((n, s) => n + s.pending, 0);
  const now = Date.now();
  const ticker = known.flatMap((s) => s.alarms.map((alarm) => ({ station: s.name, alarm }))).sort((a, b) => Number(b.alarm.timestamp ?? 0) - Number(a.alarm.timestamp ?? 0));
  const clock = `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;
  const stationWidth = Math.min(16, Math.max(8, ...known.map((s) => s.name.length)));

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end">
        <Text backgroundColor={theme.accent} color={theme.onAccent} bold>{" ◆ bask "}</Text>
        <Text bold>{"  All stations"}</Text>
        <Text color={theme.muted}>{`  ${entries.length} station${entries.length === 1 ? "" : "s"} · `}</Text>
        <Text color={live === entries.length ? theme.good : theme.warn}>{`${live} live`}</Text>
        {failed > 0 && <Text color={theme.bad}>{` · ${failed} unreachable`}</Text>}
        {"   "}
        {unacked > 0 ? <Badge text={`${unacked} unacked`} color={theme.bad} /> : <Text color={theme.good}>✓ no unacked alarms</Text>}
        <Text color={theme.muted}>{`  ${openAlarms} open  `}</Text>
        {pending > 0 && <Badge text={`${pending} waiting for approval`} color={theme.warn} />}
        <Text color={theme.muted}>{`  ${clock}`}</Text>
      </Text>
      <Box flexDirection="column" height={bodyHeight - tickerHeight}>
        {Array.from({ length: shownRows }, (_row, r) => (
          <Box key={r} height={cardHeight}>
            {entries.slice((firstRow + r) * columns, (firstRow + r + 1) * columns).map((entry, c) => {
              const index = (firstRow + r) * columns + c;
              return <StationCard key={entry.profile} entry={entry} conn={conns[index]} index={index} selected={index === selected} width={cardWidth} height={cardHeight} report={report} />;
            })}
          </Box>
        ))}
      </Box>
      {tickerHeight > 0 && (
        <Panel title="Newest alarms, all stations" meta={`${openAlarms} open across ${known.length} station${known.length === 1 ? "" : "s"}`} width={width} height={tickerHeight} focused={false}>
          {ticker.length === 0 ? (
            <Text color={theme.good}>✓ No open alarms on any station.</Text>
          ) : (
            ticker.slice(0, tickerHeight - 2).map(({ station, alarm }) => (
              <Text key={`${station}|${String(alarm.uuid)}`} wrap="truncate-end">
                <Text color={alarmColor(alarmState(alarm))}>● </Text>
                <Text color={theme.muted}>{padStart(ago(alarm.timestamp, now), 3)} </Text>
                <Text bold>{padEnd(station, stationWidth)} </Text>
                <Text color={isUnacked(alarm) ? theme.warn : theme.muted}>{padEnd(isUnacked(alarm) ? "unacked" : "acked", 8)}</Text>
                <Text color={theme.info}>{padEnd(place(String(((alarm.sources ?? []) as string[])[0] ?? "")), Math.min(30, Math.floor(width * 0.22)))} </Text>
                <Text>{clip(alarmMessage(alarm), Math.max(10, width - 20 - stationWidth - Math.min(30, Math.floor(width * 0.22))))}</Text>
              </Text>
            ))
          )}
        </Panel>
      )}
      <Text wrap="truncate-end">
        <Hint k="←↑↓→" label="choose" />
        <Hint k="⏎" label="open the station" />
        <Hint k="1-9" label="open by number" />
        <Hint k="r" label="reconnect" />
        <Hint k="q" label="quit" />
        {rowCount > shownRows && <Text color={theme.muted}>{`rows ${firstRow + 1}-${firstRow + shownRows} of ${rowCount}`}</Text>}
      </Text>
    </Box>
  );
}

function StationCard(props: { entry: FleetEntry; conn: Conn; index: number; selected: boolean; width: number; height: number; report: (index: number, summary: Summary) => void }) {
  const { entry, conn, index, selected, width, height } = props;
  if (conn.client) return <LiveCard {...props} client={conn.client} />;
  return (
    <Panel title={`${index + 1} ${entry.label}`} meta={conn.state === "connecting" ? "connecting…" : "✕ not connected"} metaColor={conn.state === "connecting" ? theme.muted : theme.bad} width={width} height={height} focused={selected}>
      <Text color={theme.muted} wrap="truncate-end">{entry.host}</Text>
      <Text> </Text>
      {conn.state === "connecting" ? <Text color={theme.faint}>Knocking on the station's front door…</Text> : <Text color={theme.bad} wrap="wrap">{conn.error}</Text>}
      {conn.state === "failed" && <Text color={theme.muted}>Press r to try again.</Text>}
    </Panel>
  );
}

function LiveCard(props: { entry: FleetEntry; client: BaskStreamClient; index: number; selected: boolean; width: number; height: number; report: (index: number, summary: Summary) => void }) {
  const { entry, client, index, selected, width, height, report } = props;
  const name = useStationName(client) ?? entry.label;
  const alarmStore = useAlarms(client);
  const proposalStore = useProposals(client);
  const [net, setNet] = useState<{ state: "live" | "reconnecting" | "down"; latency: number[] }>({ state: "live", latency: [] });
  const [last, setLast] = useState<AgentLogRecord>();
  const [watch, setWatch] = useState<string[]>(entry.link.get().watch);
  const trends = useRef(new Map<string, number[]>());

  // The link, a latency sample every 10 s, and the agent's most recent action.
  useEffect(() => {
    const ping = async () => {
      if (!client.connected) return;
      const started = Date.now();
      await client.ping().then(() => setNet((n) => ({ state: "live", latency: [...n.latency, Date.now() - started].slice(-20) })), () => {});
    };
    const agent = () => void client.agentLog({ since: Date.now() - 86400000, limit: 1 }).then((log) => setLast(log.records[0]), () => {});
    const onDown = () => setNet((n) => ({ ...n, state: "reconnecting" }));
    const onUp = () => setNet((n) => ({ ...n, state: "live" }));
    const onError = (error: Error & { code?: string }) => error.code === "session_expired" && setNet((n) => ({ ...n, state: "down" }));
    const onShared = (shared: Shared) => setWatch((list) => (list.join("\n") === shared.watch.join("\n") ? list : shared.watch));
    client.on("disconnected", onDown);
    client.on("reconnected", onUp);
    client.on("error", onError);
    client.on("proposal", agent);
    entry.link.on("change", onShared);
    void ping();
    agent();
    const timers = [setInterval(ping, 10000), setInterval(agent, 20000)];
    return () => {
      timers.forEach(clearInterval);
      client.off("disconnected", onDown);
      client.off("reconnected", onUp);
      client.off("error", onError);
      client.off("proposal", agent);
      entry.link.off("change", onShared);
    };
  }, [client]);

  const inner = width - 4;
  const rows = Math.max(0, height - 2);
  const alarmRows = rows >= 12 ? 3 : rows >= 9 ? 2 : 1;
  const watchRows = Math.max(0, rows - 4 - alarmRows);
  const shown = useMemo(() => watch.slice(0, watchRows), [watch, watchRows]);
  const values = useLiveValues(client, "bask-fleet", shown);
  // A short trend per point, kept as values arrive.
  for (const ord of shown) {
    const value = values.get(ord)?.value;
    const series = trends.current.get(ord) ?? [];
    const n = typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : undefined;
    if (n !== undefined && series[series.length - 1] !== n) trends.current.set(ord, [...series, n].slice(-30));
  }

  const open = [...alarmStore.alarms.values()].sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
  const unacked = open.filter(isUnacked);
  const pending = [...proposalStore.proposals.values()].filter((p) => p.status === "pending");
  const newest = unacked.length ? unacked : open;
  const key = `${name}|${net.state}|${unacked.length}|${open.length}|${pending.length}|${open.slice(0, 6).map((a) => `${String(a.uuid)}${String(a.ackState)}${String(a.sourceState)}`).join()}`;
  useEffect(() => report(index, { name, link: net.state, unacked: unacked.length, open: open.length, pending: pending.length, alarms: open.slice(0, 6) }), [key]);

  const now = Date.now();
  const latency = net.latency[net.latency.length - 1];
  const sourceWidth = Math.min(24, Math.floor(inner * 0.36));
  const lastLook = last ? outcomeLook({ kind: String(last.outcome ?? "").split(" ")[0] || "completed", source: "agent", outcome: last.outcome }) : undefined;
  const nameWidth = Math.min(30, Math.max(14, inner - 30));
  const trendWidth = Math.max(0, Math.min(24, inner - nameWidth - 16));

  return (
    <Panel
      title={`${index + 1} ${name}`}
      meta={net.state === "live" ? `● live${latency !== undefined ? ` ${latency} ms` : ""}` : net.state === "reconnecting" ? "◌ reconnecting" : "✕ session expired"}
      metaColor={net.state === "live" ? theme.good : net.state === "reconnecting" ? theme.warn : theme.bad}
      width={width} height={height} focused={selected}
    >
      <Text color={theme.muted} wrap="truncate-end">{clip(`${String(client.capabilities.authenticatedUser ?? "")}@${entry.host} · API ${String(client.capabilities.apiVersion ?? "?")}`, inner)}</Text>
      <Text wrap="truncate-end">
        {alarmStore.loadedAt === undefined ? (
          <Text color={theme.faint}>reading alarms…</Text>
        ) : open.length === 0 ? (
          <Text color={theme.good}>✓ no open alarms</Text>
        ) : (
          <>
            <Text bold color={unacked.length ? theme.bad : theme.good}>{unacked.length ? `▲ ${unacked.length} unacked` : "✓ all acknowledged"}</Text>
            <Text color={theme.muted}>{` · ${open.length} open`}</Text>
          </>
        )}
        <Text color={theme.faint}>{"   "}</Text>
        {pending.length > 0 ? <Text color={theme.warn} bold>{`◷ ${pending.length} waiting`}</Text> : <Text color={theme.muted}>AI: nothing waiting</Text>}
      </Text>
      {newest.slice(0, alarmRows).map((a) => (
        <Text key={String(a.uuid)} wrap="truncate-end">
          <Text color={alarmColor(alarmState(a))}>● </Text>
          <Text color={theme.muted}>{padStart(ago(a.timestamp, now), 3)} </Text>
          <Text color={theme.info}>{padEnd(place(String(((a.sources ?? []) as string[])[0] ?? "")), sourceWidth)} </Text>
          <Text>{clip(alarmMessage(a), inner - 7 - sourceWidth)}</Text>
        </Text>
      ))}
      {pending.length > 0 ? (
        <Text wrap="truncate-end">
          <Text color={theme.warn} bold>◷ {pending[0].id} </Text>
          <Text>{clip(pending[0].description, Math.floor(inner * 0.45))}</Text>
          <Text color={theme.info}> {clip(place(pending[0].point), Math.floor(inner * 0.35))}</Text>
        </Text>
      ) : last && lastLook ? (
        <Text wrap="truncate-end">
          <Text color={lastLook.color}>{lastLook.mark} </Text>
          <Text color={theme.muted}>{`AI ${ago(last.timestamp, now)} ago: `}</Text>
          <Text>{clip(`${lastLook.text} · ${last.change ?? last.action}`, inner - 16)}</Text>
        </Text>
      ) : (
        <Text color={theme.faint}>no AI activity in the last day</Text>
      )}
      {watchRows > 0 && <Text color={theme.faint}>{"─".repeat(inner)}</Text>}
      {shown.length === 0 && watchRows > 0 && <Text color={theme.muted} wrap="truncate-end">Nothing on this station's watch list yet.</Text>}
      {shown.map((ord) => {
        const s = values.get(ord);
        return (
          <Text key={ord} wrap="truncate-end">
            <Text color={statusTone(s?.status)}>● </Text>
            <Text color={theme.muted}>{clip(`${equipmentOf(ord)}/`, Math.max(0, nameWidth - nameOf(ord).length))}</Text>
            <Text>{padEnd(nameOf(ord), Math.max(nameOf(ord).length, nameWidth - Math.min(nameWidth, equipmentOf(ord).length + 1)))} </Text>
            <Text bold color={s?.statusOk === false ? statusTone(s?.status) : undefined}>{padStart(s ? fmtPoint(s) : "…", 12)} </Text>
            <Text color={theme.info}>{sparkline(trends.current.get(ord) ?? [], trendWidth)}</Text>
          </Text>
        );
      })}
    </Panel>
  );
}
