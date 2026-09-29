import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BaskStreamClient } from "@basidekick/baskstream";
import { ago, fmtPoint, parseValue, shortOrd, sparkline } from "../format.js";
import type { WatchedPoint } from "./stores.js";
import { Panel, padEnd, statusTone, theme, useUi, windowStart } from "./ui.js";

export function WatchView(props: { client: BaskStreamClient; active: boolean; width: number; height: number; points: WatchedPoint[]; onRemove: (ord: string) => void }) {
  const { client, active, width, height, points, onRemove } = props;
  const ui = useUi();
  const [cursor, setCursor] = useState(0);
  const [, tick] = useState(0);

  // Re-render each second so "age" columns and change highlights stay current.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, points.length - 1))), [points.length]);
  const selected = points[cursor];

  const write = (action: string, value?: unknown) => {
    const ord = selected.ord;
    const text = `${action} ${shortOrd(ord, 3)}${value === undefined ? "" : ` = ${value}`}`;
    ui.confirm(`${text}?`, async () => {
      const result = await ui.attempt(action, () => client.write(ord, action, value));
      if (!result) return;
      if (result.ok === false) ui.toast(`${text}: ${result.code} ${result.message ?? ""}`, "bad");
      else ui.toast(`${text} → ${result.status ?? "ok"}${result.activeLevel ? ` @ ${result.activeLevel}` : ""}`, "good");
    });
  };

  useInput(
    (input, key) => {
      if (!selected) return;
      if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j") setCursor((c) => Math.min(points.length - 1, c + 1));
      else if (input === "d" || key.delete) onRemove(selected.ord);
      else if (input === "t" || key.return) ui.openHistory(selected.ord);
      else if (input === "o" || input === "s" || input === "a") {
        if (!ui.allowWrites) return ui.toast("Read-only. Start bask with --allow-writes to command points.", "warn");
        if (input === "a") write("auto");
        else ui.prompt(`${input === "o" ? "Override" : "Set fallback of"} ${shortOrd(selected.ord, 3)} to`, (value) => write(input === "o" ? "override" : "set", parseValue(value)));
      }
    },
    { isActive: active }
  );

  const listHeight = height - 4;
  const start = windowStart(cursor, points.length, listHeight);
  const inner = width - 4;
  const trendWidth = Math.max(8, Math.min(30, inner - 70));
  const nameWidth = Math.max(16, inner - 18 - 14 - 6 - trendWidth - 4);
  const now = Date.now();

  return (
    <Panel title={`Watching ${points.length}`} width={width} height={height}>
      {points.length === 0 ? (
        <Box flexDirection="column">
          <Text color={theme.muted}>No points yet.</Text>
          <Text color={theme.muted}>
            Go to <Text color={theme.accent}>1 Browse</Text>, select a point and press <Text color={theme.accent}>w</Text>, or run{" "}
            <Text color={theme.accent}>bask watch &lt;ords…&gt;</Text>.
          </Text>
        </Box>
      ) : (
        <>
          <Text color={theme.muted}>
            {padEnd("point", nameWidth)} {padEnd("value", 18)} {padEnd("status", 14)} {padEnd("age", 6)} trend
          </Text>
          {points.slice(start, start + listHeight).map((p, i) => {
            const isSelected = start + i === cursor;
            const fresh = p.changedAt !== undefined && now - p.changedAt < 1500;
            const s = p.snapshot;
            return (
              <Text key={p.ord} backgroundColor={isSelected ? theme.selection : undefined} wrap="truncate-end">
                <Text bold={isSelected}>{padEnd(shortOrd(p.ord, 3), nameWidth)} </Text>
                <Text bold color={fresh ? theme.warn : s?.ok === false ? theme.bad : "white"} inverse={fresh}>
                  {padEnd(s ? fmtPoint(s) : "…", 18)}
                </Text>
                <Text> </Text>
                <Text color={statusTone(s?.status)}>{padEnd(String(s?.status ?? s?.message ?? ""), 14)}</Text>
                <Text color={theme.muted}> {padEnd(s ? ago(s.timestamp, now) : "", 6)} </Text>
                <Text color={theme.info}>{sparkline(p.trend, trendWidth)}</Text>
              </Text>
            );
          })}
        </>
      )}
    </Panel>
  );
}
