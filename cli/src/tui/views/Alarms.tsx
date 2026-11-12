import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { BaskStreamClient, Json } from "@basidekick/baskstream";
import { ago, alarmMessage, alarmState, fmtTime, fmtValue, isUnacked, place } from "../../format.js";
import { quip } from "../../quips.js";
import { useKeys, type Rect } from "../input.js";
import type { AlarmMap } from "../stores.js";
import { Panel, Table, clip, fit, theme, useCursor, useTick, useUi, type Column } from "../ui.js";

export const alarmColor = (state: string) => (state === "normal" ? theme.good : state === "fault" ? theme.accent2 : state === "alert" ? theme.warn : theme.bad);
const sourceOf = (a: Json) => String(((a.sources ?? []) as string[])[0] ?? "");

export function AlarmsView(props: { client: BaskStreamClient; active: boolean; rect: Rect; alarms: AlarmMap; error?: string; loaded: boolean; lastEventAt?: number; reload: () => Promise<void> }) {
  const { client, active, rect, alarms, error, loaded, reload } = props;
  const [loadingLine] = useState(() => quip("alarms"));
  const ui = useUi();
  const [unackedOnly, setUnackedOnly] = useState(false);
  const [classFilter, setClassFilter] = useState<string>();
  const [showDetail, setShowDetail] = useState(false);
  useTick(5000, active);

  const classes = useMemo(() => [...new Set([...alarms.values()].map((a) => String(a.alarmClass ?? "")))].filter(Boolean).sort(), [alarms]);
  const list = useMemo(
    () => [...alarms.values()].filter((a) => (!unackedOnly || isUnacked(a)) && (!classFilter || a.alarmClass === classFilter)).sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0)),
    [alarms, unackedOnly, classFilter]
  );

  const detailHeight = showDetail && list.length ? Math.min(9, Math.max(7, Math.floor(rect.height * 0.35))) : 0;
  const size = Math.max(1, rect.height - detailHeight - 3 - (error ? 1 : 0));
  const cursor = useCursor(list.length, size, { active, region: { x: rect.x + 2, y: rect.y + 2 + (error ? 1 : 0), width: rect.width - 4, height: size }, onEnter: () => setShowDetail((v) => !v) });
  const selected = list[cursor.cursor];

  const ack = (uuids: string[]) => {
    if (!ui.canWrite("acknowledge alarms")) return;
    if (uuids.length === 0) return ui.toast("Nothing to acknowledge.", "info");
    ui.confirm(`Acknowledge ${uuids.length} alarm${uuids.length === 1 ? "" : "s"}?`, async () => {
      const result = await ui.attempt("ack", () => client.ackAlarms({ uuids }));
      if (!result) return;
      const failed = ((result.alarms ?? []) as Json[]).filter((a) => a.ok === false);
      ui.toast(failed.length ? `${uuids.length - failed.length} acknowledged, ${failed.length} failed (${failed[0].code})` : `${uuids.length} acknowledged`, failed.length ? "warn" : "good");
    }, { title: "Acknowledge" });
  };

  useKeys(
    (input) => {
      if (input === "u") setUnackedOnly((v) => !v);
      else if (input === "f") setClassFilter((c) => (c === undefined ? classes[0] : classes[classes.indexOf(c) + 1]));
      else if (input === "r") void reload().then(() => ui.toast("Alarms reloaded", "info"));
      else if (input === "a" && selected) ack(isUnacked(selected) ? [String(selected.uuid)] : []);
      else if (input === "A") ack(list.filter(isUnacked).map((a) => String(a.uuid)));
      else if (input === "t" && selected && sourceOf(selected)) ui.openTrend(sourceOf(selected));
      else if (input === "e" && selected && sourceOf(selected)) ui.reveal(sourceOf(selected));
      else if (input === "y" && selected) ui.copy(sourceOf(selected), "source ORD");
    },
    { isActive: active }
  );

  const inner = rect.width - 4;
  const now = Date.now();
  const unacked = list.filter(isUnacked).length;
  const [timeWidth, priWidth, classWidth, stateWidth, ackWidth, sourceWidth, messageWidth] = fit(inner, [
    { min: inner >= 96 ? 14 : 5 },
    { min: 3 },
    { min: inner >= 84 ? 11 : 0 },
    { min: 11 },
    { min: 7 },
    { min: 16, flex: 2, max: 34 },
    { min: 12, flex: 5 }
  ]);
  const columns: Column<Json>[] = [
    { title: inner >= 96 ? "time" : "age", width: timeWidth, cell: (a) => ({ text: inner >= 96 ? fmtTime(a.timestamp).slice(5) : ago(a.timestamp, now), color: theme.muted }) },
    { title: "pri", width: priWidth, align: "right", cell: (a) => ({ text: fmtValue(a.priority), bold: Number(a.priority) < 100, color: Number(a.priority) < 50 ? theme.bad : undefined }) },
    { title: "class", width: classWidth, cell: (a) => String(a.alarmClassDisplay ?? a.alarmClass ?? "") },
    { title: "state", width: stateWidth, cell: (a) => ({ text: `● ${alarmState(a)}`, color: alarmColor(alarmState(a)), bold: true }) },
    { title: "ack", width: ackWidth, cell: (a) => ({ text: isUnacked(a) ? "unacked" : String(a.ackState ?? "").toLowerCase(), color: isUnacked(a) ? theme.warn : theme.muted, bold: isUnacked(a) }) },
    { title: "source", width: sourceWidth, cell: (a) => ({ text: place(sourceOf(a)), color: theme.info }) },
    { title: "message", width: messageWidth, cell: (a) => alarmMessage(a) }
  ];
  const filters = [unackedOnly ? "unacked only" : "", classFilter ? `class ${classFilter}` : ""].filter(Boolean).join(" · ");

  return (
    <Box flexDirection="column" height={rect.height}>
      <Panel title="Alarms" meta={`${list.length} open${unacked ? ` · ${unacked} unacked` : ""}${filters ? ` · ${filters}` : ""}`} metaColor={unacked ? theme.warn : theme.muted} width={rect.width} height={rect.height - detailHeight}>
        {error && <Text color={theme.bad} wrap="truncate-end">{error}</Text>}
        {!loaded && !error ? (
          <Text color={theme.muted}>{loadingLine}</Text>
        ) : list.length === 0 && !error ? (
          <Text color={theme.good}>✓ No open alarms{filters ? ` matching ${filters}` : ""}.</Text>
        ) : (
          <Table columns={columns} rows={list} start={cursor.start} size={size} cursor={cursor.cursor} rowKey={(a) => String(a.uuid)} />
        )}
      </Panel>
      {detailHeight > 0 && selected && (
        <Panel title={`Alarm · ${place(sourceOf(selected))}`} width={rect.width} height={detailHeight} focused={false}>
          <Text wrap="truncate-end" bold>{alarmMessage(selected)}</Text>
          <Text wrap="truncate-end">
            <Text color={theme.muted}>source </Text>
            {clip(((selected.sources ?? []) as string[]).join(", "), inner - 7)}
          </Text>
          <Text wrap="truncate-end">
            <Text color={theme.muted}>raised </Text>
            {fmtTime(selected.timestamp)} ({ago(selected.timestamp, now)} ago)
            <Text color={theme.muted}> · class </Text>
            {String(selected.alarmClass ?? "")}
            <Text color={theme.muted}> · priority </Text>
            {fmtValue(selected.priority)}
            <Text color={theme.muted}> · ack required </Text>
            {String(selected.ackRequired ?? "")}
          </Text>
          <Text wrap="truncate-end" color={theme.muted}>
            {Object.entries((selected.data ?? {}) as Json).filter(([k]) => k !== "msgText").map(([k, v]) => `${k}=${fmtValue(v)}`).join("  ")}
          </Text>
          <Text wrap="truncate-end" color={theme.faint}>uuid {String(selected.uuid)}</Text>
        </Panel>
      )}
    </Box>
  );
}
