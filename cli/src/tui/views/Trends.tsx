import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { BaskStreamClient, Json } from "@basidekick/baskstream";
import { fmtDuration, fmtValue } from "../../format.js";
import { quip } from "../../quips.js";
import { bounds, brailleLine } from "../chart.js";
import { useKeys, type Rect } from "../input.js";
import { Empty, Panel, clip, padEnd, theme, useCursor, useUi } from "../ui.js";
import { equipmentOf, nameOf } from "./Watch.js";

const RANGES = [3600000, 6 * 3600000, 86400000, 3 * 86400000, 7 * 86400000, 30 * 86400000];
const INTERVALS = [60000, 300000, 900000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000];
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number, withDate: boolean) => {
  const d = new Date(ms);
  return `${withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` : ""}${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function TrendsView(props: { client: BaskStreamClient; active: boolean; rect: Rect; ord?: string; choices: string[]; onPick: (ord: string) => void }) {
  const { client, active, rect, ord, choices, onPick } = props;
  const ui = useUi();
  const [rangeIndex, setRangeIndex] = useState(2);
  const [endOffset, setEndOffset] = useState(0);
  const [data, setData] = useState<{ key: string; rollup?: Json; loading: boolean; line?: string; error?: string }>({ key: "", loading: false });
  const [minute, setMinute] = useState(0);

  const showList = rect.width >= 104 && choices.length > 0;
  const listWidth = showList ? Math.min(34, Math.max(26, Math.floor(rect.width * 0.24))) : 0;
  const chartWidth = rect.width - listWidth;
  const listSize = Math.max(1, rect.height - 2);
  const list = useCursor(choices.length, listSize, {
    active: active && showList,
    region: showList ? { x: rect.x + 2, y: rect.y + 1, width: listWidth - 4, height: listSize } : undefined,
    onEnter: (index) => onPick(choices[index])
  });
  // Moving through the list charts each point as it is selected (not on the first draw, which
  // would replace the point this view was opened for).
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return void (moved.current = true);
    if (showList && active && choices[list.cursor] && choices[list.cursor] !== ord) onPick(choices[list.cursor]);
  }, [list.cursor]);
  useEffect(() => {
    const index = ord ? choices.indexOf(ord) : -1;
    if (index >= 0 && index !== list.cursor) list.setCursor(index);
  }, [ord, choices.length]);
  // Nothing chosen yet: start with the first point on offer.
  useEffect(() => {
    if (active && !ord && choices.length > 0) onPick(choices[0]);
  }, [active, ord, choices.length]);

  const range = RANGES[rangeIndex];
  const plotCols = Math.max(16, chartWidth - 4 - 10);
  const interval = INTERVALS.find((i) => i >= range / (plotCols * 2)) ?? INTERVALS[INTERVALS.length - 1];
  const end = Math.ceil((Date.now() - endOffset) / interval) * interval;
  const start = end - range;
  const key = `${ord}|${range}|${endOffset}|${interval}|${minute}`;

  // While the chart ends at "now", refresh it each minute.
  useEffect(() => {
    if (!active || endOffset !== 0) return;
    const timer = setInterval(() => setMinute((m) => m + 1), 60000);
    return () => clearInterval(timer);
  }, [active, endOffset]);

  useEffect(() => {
    if (!ord || !active || data.key === key) return;
    setData((d) => ({ key, loading: true, rollup: d.key.split("|")[0] === ord ? d.rollup : undefined, line: quip("history") }));
    let cancelled = false;
    client.historyRollup(ord, { start, end, interval }).then(
      (rollup) => !cancelled && setData({ key, rollup, loading: false }),
      (error: Error) => !cancelled && setData({ key, loading: false, error: error.message })
    );
    return () => {
      cancelled = true;
    };
  }, [key, active]);

  useKeys(
    (input, k) => {
      if (input === "+" || input === "=" || input === "]") setRangeIndex((i) => Math.max(0, i - 1));
      else if (input === "-" || input === "[") setRangeIndex((i) => Math.min(RANGES.length - 1, i + 1));
      else if (k.leftArrow || input === "h") setEndOffset((o) => o + range / 2);
      else if (k.rightArrow || input === "l") setEndOffset((o) => Math.max(0, o - range / 2));
      else if (input === "n") setEndOffset(0);
      else if (input === "r") setData((d) => ({ ...d, key: "" }));
      else if (input === "w" && ord) ui.watch(ord);
      else if (input === "e" && ord) ui.reveal(ord);
    },
    { isActive: active }
  );

  const history = ((data.rollup?.histories ?? []) as Json[])[0];
  const buckets = useMemo(() => ((history?.buckets ?? []) as Json[]).filter((b) => typeof b.avg === "number" && Number(b.count ?? 1) > 0), [history]);
  const plotRows = Math.max(3, rect.height - 2 - 4);

  const chart = useMemo(() => {
    if (buckets.length === 0) return undefined;
    const slots = Math.max(1, Math.ceil(range / interval));
    const series = new Array<number | undefined>(slots).fill(undefined);
    for (const b of buckets) {
      const slot = Math.floor((Number(b.start) - start) / interval);
      if (slot >= 0 && slot < slots) series[slot] = Number(b.avg);
    }
    const [min, max] = bounds(buckets.flatMap((b) => [Number(b.min ?? b.avg), Number(b.max ?? b.avg)]));
    return { lines: brailleLine(series, plotCols, plotRows, min, max), min, max };
  }, [buckets, plotCols, plotRows, start, interval, range]);

  const title = ord ? `${nameOf(ord)}${equipmentOf(ord) ? ` · ${equipmentOf(ord)}` : ""}` : "Trends";
  const meta = ord ? `${fmtDuration(range)} · ${fmtDuration(interval)} buckets${endOffset ? ` · to ${clock(end, true)}` : " · live"}${data.loading ? " · loading" : ""}` : undefined;

  return (
    <Box height={rect.height}>
      {showList && (
        <Panel title="Points" meta={`${choices.length}`} width={listWidth} height={rect.height} focused={false}>
          {choices.slice(list.start, list.start + listSize).map((choice, i) => {
            const selected = list.start + i === list.cursor;
            return (
              <Text key={choice} backgroundColor={selected ? theme.selection : undefined} wrap="truncate-end">
                <Text bold={selected}>{padEnd(nameOf(choice), Math.max(8, listWidth - 4 - 10))}</Text>
                <Text color={theme.muted}>{padEnd(` ${equipmentOf(choice)}`, 10)}</Text>
              </Text>
            );
          })}
        </Panel>
      )}
      <Panel title={title} meta={meta} width={chartWidth} height={rect.height}>
        {!ord ? (
          <Empty title="No point selected.">
            <Text color={theme.muted} wrap="wrap">
              Select a point in <Text color={theme.accent}>Explorer</Text> or <Text color={theme.accent}>Watch</Text> and press <Text color={theme.accent} bold>t</Text>.
            </Text>
          </Empty>
        ) : data.error ? (
          <Text color={theme.bad} wrap="wrap">{data.error}</Text>
        ) : !chart ? (
          <Text color={theme.muted} wrap="wrap">{data.loading || !data.rollup ? data.line ?? "Loading…" : history ? "No numeric records in this window. Press - for a longer one." : "This point keeps no history (no history extension, or nothing readable)."}</Text>
        ) : (
          <>
            {chart.lines.map((line, r) => {
              const at = chart.max - ((chart.max - chart.min) * r) / Math.max(1, chart.lines.length - 1);
              const labelled = r === 0 || r === chart.lines.length - 1 || (chart.lines.length >= 7 && r === Math.floor((chart.lines.length - 1) / 2)) || (chart.lines.length >= 15 && (r === Math.floor((chart.lines.length - 1) / 4) || r === Math.floor(((chart.lines.length - 1) * 3) / 4)));
              return (
                <Text key={r} wrap="truncate-end">
                  <Text color={theme.muted}>{(labelled ? fmtValue(Math.round(at * 10) / 10) : "").padStart(8)} {labelled ? "┤" : "│"}</Text>
                  <Text color={theme.info}>{line}</Text>
                </Text>
              );
            })}
            <Text color={theme.faint} wrap="truncate-end">{" ".repeat(9)}└{"─".repeat(plotCols)}</Text>
            <Axis start={start} range={range} cols={plotCols} />
            <Stats buckets={buckets} history={history} width={chartWidth - 4} />
          </>
        )}
      </Panel>
    </Box>
  );
}

function Axis({ start, range, cols }: { start: number; range: number; cols: number }) {
  const withDate = range > 86400000;
  const count = Math.max(2, Math.min(7, Math.floor(cols / (withDate ? 16 : 10))));
  let text = "";
  for (let i = 0; i < count; i += 1) {
    const label = clock(start + (range * i) / (count - 1), withDate);
    const at = Math.round(((cols - label.length) * i) / (count - 1));
    text = text.padEnd(at) + label;
  }
  return <Text color={theme.muted} wrap="truncate-end">{" ".repeat(10)}{text}</Text>;
}

function Stats({ buckets, history, width }: { buckets: Json[]; history: Json; width: number }) {
  const count = buckets.reduce((n, b) => n + Number(b.count ?? 0), 0);
  const sum = buckets.reduce((n, b) => n + Number(b.sum ?? 0), 0);
  const min = Math.min(...buckets.map((b) => Number(b.min ?? b.avg)));
  const max = Math.max(...buckets.map((b) => Number(b.max ?? b.avg)));
  const last = buckets[buckets.length - 1].last ?? buckets[buckets.length - 1].avg;
  const stat = (label: string, value: unknown, color?: string) => (
    <Text>
      <Text color={theme.muted}>{label} </Text>
      <Text color={color} bold>{fmtValue(typeof value === "number" ? Math.round(value * 100) / 100 : value)}</Text>
      {"   "}
    </Text>
  );
  const coverage = typeof history.coverage === "number" ? ` · ${Math.round(history.coverage * 100)}% coverage` : "";
  return (
    <Text wrap="truncate-end">
      {stat("min", min, theme.info)}
      {stat("avg", count ? sum / count : undefined)}
      {stat("max", max, theme.warn)}
      {stat("last", last)}
      <Text color={theme.muted}>{clip(`${count} records${coverage}${history.truncated ? ` · truncated (${String(history.truncatedReason ?? "limit")})` : ""} · ${String(history.historyId ?? "")}`, Math.max(0, width - 52))}</Text>
    </Text>
  );
}
