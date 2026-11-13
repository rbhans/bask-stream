import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { toSlotOrd, type BaskStreamClient, type BrowseNode, type Json } from "@basidekick/baskstream";
import { fmtValue } from "../../format.js";
import { useKeys, type Rect } from "../input.js";
import { Empty, Panel, clip, padEnd, theme, useCursor, useTick, useUi } from "../ui.js";

const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_OF_DATE = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "07:30", "07:30:00", "7:30 AM" or "24:00" as minutes after midnight. */
export function parseClock(text: unknown): number | undefined {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?$/i.exec(String(text ?? "").trim());
  if (!m) return undefined;
  let hour = Number(m[1]);
  if (m[3]) hour = (hour % 12) + (/p/i.test(m[3]) ? 12 : 0);
  return hour * 60 + Number(m[2]);
}

const outputText = (value: unknown) => {
  const v = value as Json | null | undefined;
  return v ? String(v.displayValue ?? fmtValue(v.value)) : "—";
};

export function SchedulesView(props: { client: BaskStreamClient; active: boolean; rect: Rect }) {
  const { client, active, rect } = props;
  const ui = useUi();
  const [schedules, setSchedules] = useState<BrowseNode[]>();
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<{ ord: string; schedule?: Json; events?: Json[]; error?: string }>();
  const [n, setN] = useState(0);
  useTick(30000, active);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const reply = await client.search("slot:/", "", { features: ["schedule"], depth: 64, limit: 300 });
        let nodes = (((reply.result ?? {}) as Json).nodes ?? []) as BrowseNode[];
        if (nodes.length === 0 && client.capabilities.workbench) {
          // Stations that do not mark schedules as a feature: ask for the type instead.
          const result = await client.query({ bql: "select slotPath, displayName, type from schedule:AbstractSchedule stop" }, { limit: 300 }).catch(() => undefined);
          nodes = (result?.rows ?? []).map((row) => ({ ord: String(row[0]), name: String(row[0]).split("/").pop() ?? "", display: String(row[1] ?? ""), typeSpec: String(row[2] ?? ""), kind: "schedule" }));
        }
        if (!cancelled) setSchedules(nodes.map((node) => ({ ...node, ord: toSlotOrd(node.ord) })));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, n]);

  const stacked = rect.width < 92;
  const listWidth = stacked ? rect.width : Math.min(34, Math.max(26, Math.floor(rect.width * 0.26)));
  const listHeight = stacked ? Math.min(7, Math.max(4, Math.floor(rect.height * 0.3))) : rect.height;
  const listSize = Math.max(1, listHeight - 2);
  const list = useCursor(schedules?.length ?? 0, listSize, { active, region: { x: rect.x + 2, y: rect.y + 1, width: listWidth - 4, height: listSize } });
  const selected = schedules?.[list.cursor];

  useEffect(() => {
    if (!selected || !active) return;
    const ord = selected.ord;
    if (detail?.ord !== ord) setDetail({ ord });
    const timer = setTimeout(async () => {
      try {
        const now = Date.now();
        const [schedule, events] = await Promise.all([client.schedule(ord), client.scheduleEvents(ord, { start: now, end: now + 7 * 86400000, limit: 40 })]);
        setDetail((d) => (d?.ord === ord ? { ord, schedule, events: (events.events ?? []) as Json[] } : d));
      } catch (e) {
        setDetail((d) => (d?.ord === ord ? { ord, error: (e as Error).message } : d));
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [selected?.ord, active, n]);

  useKeys(
    (input) => {
      if (input === "r") setN((v) => v + 1);
      else if (input === "e" && selected) ui.reveal(selected.ord);
      else if (input === "y" && selected) ui.copy(selected.ord, "ORD");
    },
    { isActive: active }
  );

  const detailWidth = stacked ? rect.width : rect.width - listWidth;
  const detailHeight = stacked ? rect.height - listHeight : rect.height;
  const current = detail?.ord === selected?.ord ? detail : undefined;

  return (
    <Box height={rect.height} flexDirection={stacked ? "column" : "row"}>
      <Panel title="Schedules" meta={schedules ? String(schedules.length) : undefined} width={listWidth} height={listHeight}>
        {error ? (
          <Text color={theme.bad} wrap="wrap">{error}</Text>
        ) : !schedules ? (
          <Text color={theme.muted}>Finding schedules…</Text>
        ) : schedules.length === 0 ? (
          <Empty title="No schedules found on this station." />
        ) : (
          schedules.slice(list.start, list.start + listSize).map((s, i) => {
            const isSelected = list.start + i === list.cursor;
            return (
              <Text key={s.ord} backgroundColor={isSelected ? theme.selection : undefined} wrap="truncate-end">
                <Text color={theme.accent2}>◷ </Text>
                <Text bold={isSelected}>{padEnd(s.display ?? s.name, listWidth - 6)}</Text>
              </Text>
            );
          })
        )}
      </Panel>
      <Panel title={selected ? selected.display ?? selected.name : "Schedule"} meta={selected ? String(selected.typeSpec ?? "").replace(/^schedule:/, "") : undefined} width={detailWidth} height={detailHeight} focused={false}>
        {!selected ? null : current?.error ? (
          <Text color={theme.bad} wrap="wrap">{current.error}</Text>
        ) : !current?.schedule ? (
          <Text color={theme.muted}>Reading the schedule…</Text>
        ) : (
          <Week schedule={current.schedule} events={current.events ?? []} width={detailWidth - 4} height={detailHeight - 2} />
        )}
      </Panel>
    </Box>
  );
}

function Week({ schedule, events, width, height }: { schedule: Json; events: Json[]; width: number; height: number }) {
  const week = (((schedule.tree ?? {}) as Json).week ?? {}) as Record<string, Json>;
  const days = Object.keys(week).length ? [...Object.keys(week)].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)) : [];
  const perHour = width >= 108 ? 4 : width >= 60 ? 2 : 1;
  const cols = 24 * perHour;
  const now = new Date();
  const today = DAY_OF_DATE[now.getDay()];
  const nowCol = Math.floor(((now.getHours() * 60 + now.getMinutes()) / 1440) * cols);

  // One colour per distinct output, in the order the week uses them.
  const palette = [theme.accent, theme.good, theme.warn, theme.accent2, theme.info, theme.bad];
  const colors = useMemo(() => {
    const map = new Map<string, string>();
    for (const day of days) for (const entry of ((week[day]?.day ?? []) as Json[])) {
      const text = outputText(entry.effectiveValue);
      if (!map.has(text)) map.set(text, palette[map.size % palette.length]);
    }
    return map;
  }, [schedule]);

  const cellsOf = (day: string): (string | undefined)[] => {
    const cells = new Array<string | undefined>(cols).fill(undefined);
    for (const entry of ((week[day]?.day ?? []) as Json[])) {
      const from = parseClock(entry.start) ?? 0;
      const to = parseClock(entry.finish) || 1440;
      for (let c = Math.floor((from / 1440) * cols); c < Math.ceil((to / 1440) * cols) && c < cols; c += 1) cells[c] = outputText(entry.effectiveValue);
    }
    return cells;
  };

  const ruler = Array.from({ length: 24 }, (_, hour) => (hour % (perHour === 1 ? 6 : perHour === 2 ? 3 : 2) === 0 ? pad(hour).padEnd(perHour) : " ".repeat(perHour))).join("");
  const next = events.find((e) => Number(e.time) > Date.now());
  const upcoming = events.filter((e) => Number(e.time) > Date.now()).slice(0, Math.max(0, height - days.length - 7));
  const when = (ms: number) => {
    const d = new Date(ms);
    return `${WEEKDAY[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={theme.muted}>now </Text>
        <Text bold color={colors.get(outputText(schedule.currentOutput)) ?? undefined}>{outputText(schedule.currentOutput ?? schedule.effectiveValue)}</Text>
        {next ? (
          <>
            <Text color={theme.muted}>  ·  next </Text>
            <Text>{when(Number(next.time))}</Text>
            <Text color={theme.muted}> → </Text>
            <Text bold>{outputText(next.value)}</Text>
          </>
        ) : null}
        <Text color={theme.muted}>{`  ·  ${String(schedule.status ?? "")}`}</Text>
      </Text>
      <Text> </Text>
      {days.length === 0 ? (
        <Text color={theme.muted} wrap="wrap">This schedule has no weekly table to draw ({String(schedule.typeSpec ?? "")}).</Text>
      ) : (
        <>
          <Text color={theme.muted} wrap="truncate-end">{"     "}{ruler}</Text>
          {days.map((day) => {
            const cells = cellsOf(day);
            const isToday = day === today;
            // Group equal neighbours so each run is one coloured piece of text.
            const runs: { text?: string; from: number; to: number }[] = [];
            cells.forEach((text, c) => {
              const last = runs[runs.length - 1];
              if (last && last.text === text && !(isToday && (c === nowCol || c === nowCol + 1))) last.to = c + 1;
              else runs.push({ text, from: c, to: c + 1 });
            });
            return (
              <Text key={day} wrap="truncate-end">
                <Text bold={isToday} color={isToday ? theme.accent : theme.muted}>{`${day.slice(0, 3)[0].toUpperCase()}${day.slice(1, 3)}  `}</Text>
                {runs.map((run) => {
                  const marker = isToday && run.from === nowCol;
                  return (
                    <Text key={run.from} color={marker ? undefined : run.text ? colors.get(run.text) : theme.faint} inverse={marker}>
                      {marker ? "▏" : (run.text ? "█" : "░").repeat(run.to - run.from)}
                    </Text>
                  );
                })}
              </Text>
            );
          })}
          <Text> </Text>
          <Text wrap="truncate-end">
            {[...colors.entries()].map(([text, color]) => (
              <Text key={text}>
                <Text color={color}>██ </Text>
                <Text>{text}   </Text>
              </Text>
            ))}
            <Text color={theme.faint}>░░ </Text>
            <Text color={theme.muted}>default {outputText(schedule.defaultOutput)}</Text>
          </Text>
        </>
      )}
      {upcoming.length > 0 && (
        <>
          <Text> </Text>
          <Text color={theme.muted}>Coming up</Text>
          {upcoming.map((e, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color={theme.muted}>{padEnd(when(Number(e.time)), 11)}</Text>
              <Text color={colors.get(outputText(e.value))}>● </Text>
              <Text>{clip(outputText(e.value), width - 14)}</Text>
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}
