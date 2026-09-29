import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BaskStreamClient, Json } from "@basidekick/baskstream";
import { alarmMessage, alarmState, fmtTime, fmtValue, isUnacked, shortOrd } from "../format.js";
import type { AlarmMap } from "./stores.js";
import { Panel, clip, padEnd, theme, useUi, windowStart } from "./ui.js";

const stateColor = (state: string) => (state === "normal" ? theme.good : state === "fault" ? theme.accent2 : theme.bad);
const message = alarmMessage;
const source = (a: Json) => shortOrd(String(((a.sources ?? []) as string[])[0] ?? ""), 3);

export function AlarmsView(props: { client: BaskStreamClient; active: boolean; width: number; height: number; alarms: AlarmMap; error?: string; reload: () => Promise<void> }) {
  const { client, active, width, height, alarms, error, reload } = props;
  const ui = useUi();
  const [cursor, setCursor] = useState(0);
  const [unackedOnly, setUnackedOnly] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  const list = useMemo(
    () => [...alarms.values()].filter((a) => !unackedOnly || isUnacked(a)).sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0)),
    [alarms, unackedOnly]
  );
  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, list.length - 1))), [list.length]);
  const selected = list[cursor];

  const ack = (uuids: string[]) => {
    if (!ui.allowWrites) return ui.toast("Read-only. Start bask with --allow-writes to acknowledge alarms.", "warn");
    if (uuids.length === 0) return ui.toast("Nothing to acknowledge.", "info");
    ui.confirm(`Acknowledge ${uuids.length} alarm${uuids.length === 1 ? "" : "s"}?`, async () => {
      const result = await ui.attempt("ack", () => client.ackAlarms({ uuids }));
      if (!result) return;
      const failed = ((result.alarms ?? []) as Json[]).filter((a) => a.ok === false);
      ui.toast(failed.length ? `${uuids.length - failed.length} acknowledged, ${failed.length} failed (${failed[0].code})` : `${uuids.length} acknowledged`, failed.length ? "warn" : "good");
    });
  };

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j") setCursor((c) => Math.min(list.length - 1, c + 1));
      else if (input === "u") setUnackedOnly((v) => !v);
      else if (input === "r") void reload().then(() => ui.toast("Alarms reloaded", "info"));
      else if (key.return) setShowDetail((v) => !v);
      else if (input === "a" && selected) ack(isUnacked(selected) ? [String(selected.uuid)] : []);
      else if (input === "A") ack(list.filter(isUnacked).map((a) => String(a.uuid)));
      else if (input === "t" && selected && (selected.sources as string[] | undefined)?.[0]) ui.openHistory((selected.sources as string[])[0]);
    },
    { isActive: active }
  );

  const detailHeight = showDetail && selected ? 8 : 0;
  const listHeight = height - 4 - detailHeight - (error ? 1 : 0);
  const start = windowStart(cursor, list.length, listHeight);
  const inner = width - 4;
  const msgWidth = Math.max(10, inner - 72);
  const unacked = list.filter(isUnacked).length;

  return (
    <Box flexDirection="column" height={height}>
      <Panel title={`Open alarms ${list.length}${unacked ? ` · ${unacked} unacked` : ""}${unackedOnly ? " · filter: unacked" : ""}`} width={width} height={height - detailHeight}>
        {error && <Text color={theme.bad}>{error}</Text>}
        {list.length === 0 && !error ? (
          <Text color={theme.good}>✓ No open alarms{unackedOnly ? " awaiting acknowledgement" : ""}.</Text>
        ) : (
          <Text color={theme.muted}>
            {padEnd("time", 14)} {padEnd("pri", 3)} {padEnd("class", 12)} {padEnd("state", 9)} {padEnd("ack", 7)} {padEnd("source", 20)} message
          </Text>
        )}
        {list.slice(start, start + listHeight).map((a, i) => {
          const isSelected = start + i === cursor;
          const unackedRow = isUnacked(a);
          return (
            <Text key={String(a.uuid)} backgroundColor={isSelected ? theme.selection : undefined} wrap="truncate-end">
              <Text color={theme.muted}>{padEnd(fmtTime(a.timestamp).slice(5), 14)} </Text>
              <Text bold={Number(a.priority) < 100}>{padEnd(fmtValue(a.priority), 3)} </Text>
              <Text>{padEnd(String(a.alarmClassDisplay ?? a.alarmClass ?? ""), 12)} </Text>
              <Text color={stateColor(alarmState(a))} bold>
                {padEnd(alarmState(a), 9)}{" "}
              </Text>
              <Text color={unackedRow ? theme.warn : theme.muted} bold={unackedRow}>
                {padEnd(String(a.ackState ?? "").toLowerCase(), 7)}{" "}
              </Text>
              <Text color={theme.info}>{padEnd(source(a), 20)} </Text>
              <Text>{clip(message(a), msgWidth)}</Text>
            </Text>
          );
        })}
      </Panel>
      {showDetail && selected && (
        <Panel title="Alarm" width={width} height={detailHeight} focused={false}>
          <Text wrap="truncate-end">
            <Text color={theme.muted}>uuid </Text>
            {String(selected.uuid)}
            <Text color={theme.muted}> · transition </Text>
            {String(selected.transition ?? "")}
            <Text color={theme.muted}> · ack required </Text>
            {String(selected.ackRequired ?? "")}
          </Text>
          <Text wrap="truncate-end">
            <Text color={theme.muted}>source </Text>
            {((selected.sources ?? []) as string[]).join(", ")}
          </Text>
          <Text wrap="truncate-end">{message(selected)}</Text>
          <Text wrap="truncate-end" color={theme.muted}>
            {Object.entries((selected.data ?? {}) as Json)
              .filter(([k]) => k !== "msgText")
              .map(([k, v]) => `${k}=${fmtValue(v)}`)
              .join("  ")}
          </Text>
        </Panel>
      )}
    </Box>
  );
}
