import React from "react";
import { Text } from "ink";
import type { BaskStreamClient } from "@basidekick/baskstream";
import { ago, fmtPoint, sparkline } from "../../format.js";
import { commandPoint } from "../actions.js";
import { useKeys, type Rect } from "../input.js";
import type { WatchedPoint } from "../stores.js";
import { Empty, Panel, Table, fit, statusTone, theme, useCursor, useTick, useUi, type Column } from "../ui.js";

/** The equipment a point belongs to: the folder above it, skipping a "points" container. */
export const equipmentOf = (ord: string) => {
  const parts = ord.replace(/^.*slot:\//, "").split("/").filter((p) => p && p !== "points");
  return parts.length > 1 ? parts[parts.length - 2] : "";
};
export const nameOf = (ord: string) => ord.split("/").pop() ?? ord;

export function WatchView(props: { client: BaskStreamClient; active: boolean; rect: Rect; points: WatchedPoint[]; onRemove: (ord: string) => void }) {
  const { client, active, rect, points, onRemove } = props;
  const ui = useUi();
  useTick(1000, active);
  const size = Math.max(1, rect.height - 3);
  const list = useCursor(points.length, size, { active, region: { x: rect.x + 2, y: rect.y + 2, width: rect.width - 4, height: size }, onEnter: (i) => ui.openTrend(points[i].ord) });
  const selected = points[list.cursor];

  useKeys(
    (input, key) => {
      if (!selected) return;
      if (input === "d" || input === "x" || key.delete || key.backspace) onRemove(selected.ord);
      else if (input === "t") ui.openTrend(selected.ord);
      else if (input === "e") ui.reveal(selected.ord);
      else if (input === "y") ui.copy(selected.ord, "ORD");
      else if (input === "c") commandPoint(ui, client, selected.ord, selected.snapshot);
      else if (input === "o") commandPoint(ui, client, selected.ord, selected.snapshot, "override");
      else if (input === "s") commandPoint(ui, client, selected.ord, selected.snapshot, "set");
      else if (input === "a") commandPoint(ui, client, selected.ord, selected.snapshot, "auto");
    },
    { isActive: active }
  );

  const inner = rect.width - 4;
  const now = Date.now();
  const [nameWidth, equipWidth, valueWidth, statusWidth, ageWidth, trendWidth] = fit(inner, [
    { min: 14, flex: 3, max: 30 },
    { min: inner >= 70 ? 10 : 0, flex: 2, max: 20 },
    { min: 12, flex: 1, max: 18 },
    { min: inner >= 60 ? 12 : 0, flex: 1, max: 22 },
    { min: inner >= 52 ? 4 : 0 },
    { min: inner >= 90 ? 12 : 0, flex: 3, max: 40 }
  ]);
  const columns: Column<WatchedPoint>[] = [
    { title: "point", width: nameWidth, cell: (p, i) => ({ text: nameOf(p.ord), bold: i === list.cursor }) },
    { title: "equipment", width: equipWidth, cell: (p) => ({ text: equipmentOf(p.ord), color: theme.muted }) },
    {
      title: "value", width: valueWidth, align: "right",
      cell: (p) => {
        const s = p.snapshot;
        const fresh = p.changedAt !== undefined && now - p.changedAt < 1500;
        return { text: s ? fmtPoint(s) : "…", bold: true, inverse: fresh, color: fresh ? theme.warn : s?.code ? theme.bad : s?.statusOk === false || s?.ok === false ? statusTone(s?.status) : undefined };
      }
    },
    { title: "status", width: statusWidth, cell: (p) => ({ text: String(p.snapshot?.status ?? p.snapshot?.message ?? ""), color: statusTone(p.snapshot?.status) }) },
    { title: "age", width: ageWidth, align: "right", cell: (p) => ({ text: p.snapshot ? ago(p.snapshot.timestamp, now) : "", color: theme.muted }) },
    { title: "trend", width: trendWidth, cell: (p) => ({ text: sparkline(p.trend, trendWidth), color: theme.info }) }
  ];

  return (
    <Panel title="Watch" meta={points.length ? `${points.length} live` : undefined} metaColor={theme.good} width={rect.width} height={rect.height}>
      {points.length === 0 ? (
        <Empty title="No points on the watch list yet.">
          <Text color={theme.muted} wrap="wrap">
            In <Text color={theme.accent}>Explorer</Text> select a point and press <Text color={theme.accent} bold>w</Text>, press <Text color={theme.accent} bold>/</Text> to find one by name, or run{" "}
            <Text color={theme.accent}>bask watch &lt;ords…&gt;</Text>. The list is saved and shared with other bask windows on this station.
          </Text>
        </Empty>
      ) : (
        <Table columns={columns} rows={points} start={list.start} size={size} cursor={list.cursor} rowKey={(p) => p.ord} />
      )}
    </Panel>
  );
}
