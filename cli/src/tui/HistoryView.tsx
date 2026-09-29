import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BaskStreamClient, Json } from "@basidekick/baskstream";
import { fmtDuration, fmtTime, fmtValue, shortOrd } from "../format.js";
import { Panel, theme, useUi } from "./ui.js";

const RANGES = [3600000, 6 * 3600000, 86400000, 3 * 86400000, 7 * 86400000, 30 * 86400000];
const INTERVALS = [60000, 300000, 900000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000];
const BARS = "▁▂▃▄▅▆▇█";

export function HistoryView(props: { client: BaskStreamClient; active: boolean; width: number; height: number; ord?: string }) {
  const { client, active, width, height, ord } = props;
  const ui = useUi();
  const [rangeIndex, setRangeIndex] = useState(2);
  const [endOffset, setEndOffset] = useState(0);
  const [data, setData] = useState<{ key: string; rollup?: Json; loading: boolean }>({ key: "", loading: false });

  const range = RANGES[rangeIndex];
  const chartWidth = Math.max(20, width - 14);
  const interval = INTERVALS.find((i) => i >= range / chartWidth) ?? INTERVALS[INTERVALS.length - 1];
  const end = Math.ceil((Date.now() - endOffset) / interval) * interval;
  const start = end - range;
  const key = `${ord}|${range}|${endOffset}|${interval}`;

  useEffect(() => {
    if (!ord || !active || data.key === key) return;
    setData({ key, loading: true, rollup: data.rollup });
    void ui.attempt("history", () => client.historyRollup(ord, { start, end, interval })).then((rollup) => setData({ key, rollup, loading: false }));
  }, [key, active]);

  useInput(
    (input, key) => {
      if (input === "+" || input === "=" || input === "]") setRangeIndex((i) => Math.max(0, i - 1));
      else if (input === "-" || input === "[") setRangeIndex((i) => Math.min(RANGES.length - 1, i + 1));
      else if (key.leftArrow || input === "h") setEndOffset((o) => o + range / 2);
      else if (key.rightArrow || input === "l") setEndOffset((o) => Math.max(0, o - range / 2));
      else if (input === "n") setEndOffset(0);
      else if (input === "r") setData((d) => ({ ...d, key: "" }));
    },
    { isActive: active }
  );

  if (!ord) {
    return (
      <Panel title="History" width={width} height={height}>
        <Text color={theme.muted}>
          Select a point in <Text color={theme.accent}>1 Browse</Text> or <Text color={theme.accent}>2 Watch</Text> and press <Text color={theme.accent}>t</Text>.
        </Text>
      </Panel>
    );
  }

  const history = ((data.rollup?.histories ?? []) as Json[])[0];
  const buckets = ((history?.buckets ?? []) as Json[]).filter((b) => typeof b.avg === "number");
  const title = `${shortOrd(ord, 3)} · ${fmtDuration(range)} · ${fmtDuration(interval)} buckets${endOffset ? ` · ending ${fmtTime(end)}` : ""}${data.loading ? " · loading…" : ""}`;
  const chartHeight = Math.max(4, height - 8);

  return (
    <Panel title={title} width={width} height={height}>
      {!history && !data.loading ? (
        <Text color={theme.muted}>No history for this point (no history extension, or nothing readable).</Text>
      ) : buckets.length === 0 ? (
        <Text color={theme.muted}>{data.loading ? "Loading…" : "No numeric records in this window."}</Text>
      ) : (
        <Chart buckets={buckets} start={start} interval={interval} columns={chartWidth} rows={chartHeight} range={range} />
      )}
      {buckets.length > 0 && <Stats buckets={buckets} history={history} />}
    </Panel>
  );
}

function Chart({ buckets, start, interval, columns, rows, range }: { buckets: Json[]; start: number; interval: number; columns: number; rows: number; range: number }) {
  // One slot per bucket interval, stretched across the panel width.
  const slots = Math.max(1, Math.ceil(range / interval));
  const width = Math.max(slots, columns);
  const values = new Array<number | undefined>(slots).fill(undefined);
  for (const b of buckets) {
    const slot = Math.floor((Number(b.start) - start) / interval);
    if (slot >= 0 && slot < slots) values[slot] = Number(b.avg);
  }
  let min = Math.min(...buckets.map((b) => Number(b.min ?? b.avg)));
  let max = Math.max(...buckets.map((b) => Number(b.max ?? b.avg)));
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const label = (v: number) => fmtValue(v).padStart(8).slice(-8);
  const lines: React.ReactNode[] = [];
  for (let r = 0; r < rows; r += 1) {
    const fromBottom = rows - 1 - r;
    let text = "";
    for (let c = 0; c < width; c += 1) {
      const v = values[Math.floor((c * slots) / width)];
      let ch = " ";
      if (v !== undefined) {
        const level = ((v - min) / (max - min)) * rows * 8;
        const fill = Math.max(0, Math.min(8, Math.round(level - fromBottom * 8)));
        ch = fill === 0 ? (fromBottom === 0 ? "▁" : " ") : BARS[fill - 1];
      }
      text += ch;
    }
    const axis = r === 0 ? label(max) : r === rows - 1 ? label(min) : r === Math.floor(rows / 2) ? label((max + min) / 2) : " ".repeat(8);
    lines.push(
      <Text key={r} wrap="truncate-end">
        <Text color={theme.muted}>{axis} ┤</Text>
        <Text color={theme.info}>{text}</Text>
      </Text>
    );
  }
  const left = fmtTime(start);
  const right = fmtTime(start + range);
  return (
    <Box flexDirection="column">
      {lines}
      <Text color={theme.muted} wrap="truncate-end">
        {" ".repeat(10)}
        {left}
        {" ".repeat(Math.max(1, width - left.length - right.length))}
        {right}
      </Text>
    </Box>
  );
}

function Stats({ buckets, history }: { buckets: Json[]; history: Json }) {
  const count = buckets.reduce((n, b) => n + Number(b.count ?? 0), 0);
  const sum = buckets.reduce((n, b) => n + Number(b.sum ?? 0), 0);
  const min = Math.min(...buckets.map((b) => Number(b.min)));
  const max = Math.max(...buckets.map((b) => Number(b.max)));
  const last = buckets[buckets.length - 1].last;
  const stat = (label: string, value: unknown, color = "white") => (
    <Text>
      <Text color={theme.muted}>{label} </Text>
      <Text color={color} bold>
        {fmtValue(value)}
      </Text>
      {"   "}
    </Text>
  );
  return (
    <Box marginTop={1}>
      {stat("min", min, theme.info)}
      {stat("avg", count ? sum / count : undefined)}
      {stat("max", max, theme.warn)}
      {stat("last", last)}
      {stat("records", count)}
      {history.truncated ? <Text color={theme.warn}>truncated ({String(history.truncatedReason)})</Text> : null}
      <Text color={theme.muted}>{String(history.historyId ?? "")}</Text>
    </Box>
  );
}
