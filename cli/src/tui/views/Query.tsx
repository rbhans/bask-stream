import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { BaskStreamClient, QueryResult } from "@basidekick/baskstream";
import { csv } from "../../format.js";
import { useKeys, type Rect } from "../input.js";
import { Panel, TextInput, clip, clipStart, padEnd, theme, useCursor, useUi } from "../ui.js";

/** Ready-made queries for everyday questions. The BQL follows the Niagara Developer Guide's examples. */
export const REPORTS: { title: string; hint: string; bql?: string; neql?: string }[] = [
  { title: "Points in alarm", hint: "every control point with the alarm status bit set", bql: "select slotPath, out from control:ControlPoint where status.alarm" },
  { title: "Overridden points", hint: "points held by an operator or emergency override", bql: "select slotPath, out from control:ControlPoint where status.overridden" },
  { title: "Points down", hint: "points whose device is not answering", bql: "select slotPath, out from control:ControlPoint where status.down" },
  { title: "Points in fault", hint: "points reporting a fault", bql: "select slotPath, out from control:ControlPoint where status.fault" },
  { title: "Stale points", hint: "points that have not updated in time", bql: "select slotPath, out from control:ControlPoint where status.stale" },
  { title: "Devices", hint: "every driver device with its status", bql: "select slotPath, status, enabled from driver:Device" },
  { title: "Networks", hint: "every driver network with its status", bql: "select slotPath, status, enabled from driver:DeviceNetwork" },
  { title: "All points", hint: "slot path and current output of every point", bql: "select slotPath, out from control:ControlPoint" },
  { title: "Writable points", hint: "numeric points that can be commanded", bql: "select slotPath, out from control:NumericWritable" },
  { title: "Schedules", hint: "each schedule and what it outputs now", bql: "select slotPath, out from schedule:AbstractSchedule stop" },
  { title: "Histories", hint: "points that collect history, with capacity", bql: "select parent.slotPath, historyConfig.id, historyConfig.capacity, enabled from history:HistoryExt" },
  { title: "Alarm sources", hint: "points that can raise alarms, with their class", bql: "select parent.slotPath, alarmClass from alarm:AlarmSourceExt" },
  { title: "Users", hint: "station users", bql: "select name, fullName, enabled from baja:User" },
  { title: "Tagged: points", hint: "NEQL: everything tagged as a point", neql: "n:point" },
  { title: "Tagged: devices", hint: "NEQL: everything tagged as a device", neql: "n:device" }
];

const cellText = (value: unknown): string =>
  value === null || value === undefined ? "" : typeof value === "number" ? String(Math.round(value * 1000) / 1000) : typeof value === "object" ? JSON.stringify(value) : String(value);

interface Grid {
  headers: string[];
  rows: string[][];
  /** Column that holds each row's ORD, for jumping to it. */
  ordColumn: number;
}

function toGrid(result: QueryResult): Grid {
  if (result.entities) return { headers: ["ord", "name", "type"], rows: result.entities.map((e) => [e.ord, e.display || e.name, e.typeSpec]), ordColumn: 0 };
  const headers = (result.columns ?? []).map((c) => c.name);
  const rows = (result.rows ?? []).map((row) => row.map(cellText));
  const ordColumn = headers.findIndex((_h, i) => rows.length > 0 && rows.slice(0, 20).every((r) => /^(slot:|station:|local:)/.test(r[i] ?? "")));
  return { headers, rows, ordColumn };
}

export function QueryView(props: { client: BaskStreamClient; active: boolean; rect: Rect; history: string[]; onRan: (text: string) => void; run?: { n: number; bql?: string; neql?: string } }) {
  const { client, active, rect, history, onRan, run } = props;
  const ui = useUi();
  const [mode, setMode] = useState<"reports" | "input" | "results">("reports");
  const [text, setText] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [state, setState] = useState<{ running: boolean; result?: QueryResult; error?: string; ranAt?: number; took?: number }>({ running: false });
  const [colStart, setColStart] = useState(0);
  const supported = Boolean(client.capabilities.workbench);

  useEffect(() => {
    ui.typing(active && mode === "input");
    return () => ui.typing(false);
  }, [active, mode]);

  const execute = (query: string) => {
    const q = query.trim();
    if (!q) return;
    setText(q);
    setInputKey((k) => k + 1);
    setMode("results");
    setColStart(0);
    setState((s) => ({ ...s, running: true, error: undefined }));
    const started = Date.now();
    const isBql = /^\s*select\b/i.test(q);
    client.query(isBql ? { bql: q } : { neql: q }, { limit: 2000 }).then(
      (result) => {
        setState({ running: false, result, ranAt: Date.now(), took: Date.now() - started });
        onRan(q);
      },
      (error: Error & { code?: string }) => setState({ running: false, error: `${error.code ? `[${error.code}] ` : ""}${error.message}` })
    );
  };

  useEffect(() => {
    if (run) execute(run.bql ?? run.neql ?? "");
  }, [run?.n]);

  const grid = useMemo(() => (state.result ? toGrid(state.result) : undefined), [state.result]);
  const bodyHeight = rect.height - 3;
  const size = Math.max(1, bodyHeight - 3);
  const inner = rect.width - 4;

  const reports = useCursor(REPORTS.length, bodyHeight - 3, {
    active: active && mode === "reports" && supported,
    region: { x: rect.x + 2, y: rect.y + 5, width: inner, height: bodyHeight - 3 },
    onEnter: (index) => execute(REPORTS[index].bql ?? REPORTS[index].neql ?? "")
  });
  const rows = useCursor(grid?.rows.length ?? 0, size, {
    active: active && mode === "results",
    region: { x: rect.x + 2, y: rect.y + 5, width: inner, height: size },
    onEnter: (index) => {
      const ord = grid && grid.ordColumn >= 0 ? grid.rows[index]?.[grid.ordColumn] : undefined;
      if (ord) ui.reveal(ord);
      else ui.toast("This row has no ORD column to jump to.", "info");
    }
  });

  // Column widths from the data, and how many fit starting at the scroll position.
  const widths = useMemo(() => (grid ? grid.headers.map((h, i) => Math.min(i === grid.ordColumn ? 64 : 40, Math.max(h.length, ...grid.rows.slice(0, 300).map((r) => (r[i] ?? "").length)))) : []), [grid]);
  const shown: number[] = [];
  for (let i = Math.min(colStart, Math.max(0, widths.length - 1)), used = 0; i < widths.length; i += 1) {
    if (shown.length > 0 && used + widths[i] + 1 > inner) break;
    shown.push(i);
    used += widths[i] + 1;
  }

  useKeys(
    (input, key) => {
      if (mode === "input") return;
      if (input === "i" || input === "e") setMode("input");
      else if (mode === "reports") {
        if (key.escape && grid) setMode("results");
        return;
      } else if (input === "b" || key.escape) setMode("reports");
      else if (input === "r") execute(text);
      else if (key.leftArrow || input === "h") setColStart((c) => Math.max(0, c - 1));
      else if (key.rightArrow || input === "l") setColStart((c) => Math.min(Math.max(0, widths.length - 1), c + 1));
      else if (grid) {
        const ord = grid.ordColumn >= 0 ? grid.rows[rows.cursor]?.[grid.ordColumn] : undefined;
        if (input === "w" && ord) ui.watch(ord);
        else if (input === "t" && ord) ui.openTrend(ord);
        else if (input === "y") ui.copy(ord ?? grid.rows[rows.cursor]?.join("\t") ?? "", ord ? "ORD" : "row");
        else if (input === "s") {
          const file = path.resolve(`bask-query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`);
          try {
            writeFileSync(file, `${csv(grid.headers, grid.rows)}\n`);
            ui.toast(`Saved ${grid.rows.length} rows to ${file}`, "good");
          } catch (e) {
            ui.toast(`Could not save: ${(e as Error).message}`, "bad");
          }
        }
      }
    },
    { isActive: active }
  );

  const language = /^\s*select\b/i.test(text) || !text ? "BQL" : "NEQL";
  const result = state.result;
  const meta = state.running ? "running…" : result ? `${result.count} row${result.count === 1 ? "" : "s"}${result.truncated ? ` · stopped by ${result.stoppedBy ?? "limit"}` : ""}${result.hidden ? ` · ${result.hidden} hidden` : ""}${state.took !== undefined ? ` · ${state.took} ms` : ""}` : undefined;

  return (
    <Box flexDirection="column" height={rect.height}>
      <Panel title="Query" meta={language} metaColor={language === "BQL" ? theme.accent : theme.accent2} width={rect.width} height={3} focused={mode === "input"}>
        <Box>
          <Text color={mode === "input" ? theme.accent : theme.faint} bold>› </Text>
          <TextInput key={inputKey} initial={text} active={active && mode === "input"} width={inner - 2} history={history} placeholder='select slotPath, out from control:NumericPoint   ·   or a tag query such as hs:ahu' onChange={setText} onSubmit={execute} onCancel={() => setMode(grid ? "results" : "reports")} />
        </Box>
      </Panel>
      <Panel title={mode === "reports" ? "Reports" : "Results"} meta={mode === "reports" ? "enter runs" : meta} metaColor={result?.truncated ? theme.warn : theme.muted} width={rect.width} height={bodyHeight} focused={mode !== "input"}>
        {!supported ? (
          <Text color={theme.warn} wrap="wrap">Queries need baskStream API 1.10 on the station (this one reports {String(client.capabilities.apiVersion ?? "an older version")}).</Text>
        ) : mode === "reports" || (!grid && !state.error && !state.running) ? (
          <>
            <Text color={theme.muted} wrap="truncate-end">Pick a report, or press <Text color={theme.accent} bold>i</Text> to type BQL or a tag query.</Text>
            {REPORTS.slice(reports.start, reports.start + Math.max(1, bodyHeight - 3)).map((report, i) => {
              const selected = reports.start + i === reports.cursor && mode === "reports";
              return (
                <Text key={report.title} backgroundColor={selected ? theme.selection : undefined} wrap="truncate-end">
                  <Text color={report.neql ? theme.accent2 : theme.accent}>{selected ? "› " : "  "}</Text>
                  <Text bold={selected}>{padEnd(report.title, 20)}</Text>
                  <Text color={theme.muted}>{padEnd(clip(inner >= 110 ? `${report.hint}  ·  ${report.bql ?? report.neql}` : report.hint, inner - 22), inner - 22)}</Text>
                </Text>
              );
            })}
          </>
        ) : state.error ? (
          <>
            <Text color={theme.bad} wrap="wrap">{state.error}</Text>
            <Text color={theme.muted}>Press i to edit the query, or b for the reports.</Text>
          </>
        ) : !grid ? (
          <Text color={theme.muted}>Running the query…</Text>
        ) : grid.rows.length === 0 ? (
          <Text color={theme.good}>✓ Nothing matches.</Text>
        ) : (
          <>
            <Text color={theme.muted} wrap="truncate-end">
              {shown.map((i) => padEnd(grid.headers[i], widths[i])).join(" ")}
              {shown[shown.length - 1] < widths.length - 1 ? "  →" : ""}
            </Text>
            {grid.rows.slice(rows.start, rows.start + size).map((row, r) => {
              const index = rows.start + r;
              const selected = index === rows.cursor;
              return (
                <Text key={index} backgroundColor={selected ? (mode === "results" ? theme.selection : theme.selectionDim) : undefined} wrap="truncate-end">
                  {shown.map((i, n) => (
                    <Text key={i} color={i === grid.ordColumn ? theme.info : undefined} bold={selected && i !== grid.ordColumn}>
                      {(i === grid.ordColumn ? clipStart(row[i] ?? "", widths[i]) : clip(row[i] ?? "", widths[i])).padEnd(widths[i])}
                      {n < shown.length - 1 ? " " : ""}
                    </Text>
                  ))}
                </Text>
              );
            })}
          </>
        )}
      </Panel>
    </Box>
  );
}
