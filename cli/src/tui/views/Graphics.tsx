import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { BaskStreamClient } from "@basidekick/baskstream";
import { place } from "../../format.js";
import { deleteGraphic, graphicPath, listGraphics, loadGraphic, type GraphicEntry } from "../../graphics.js";
import { commandPoint } from "../actions.js";
import { useKeys, useMouse, inside, type Rect } from "../input.js";
import { useLiveValues } from "../stores.js";
import { Art, useFrame } from "../symbols/Gallery.js";
import { drawGraphic, partNow, readGraphic, roomNeeded, type Placed, type Plan, type Problem, type Room } from "../symbols/graphic.js";
import { Empty, Panel, clip, theme, useUi, windowStart } from "../ui.js";

interface Loaded {
  name: string;
  raw?: unknown;
  error?: string;
}

/**
 * Graphics: drawings of the station's equipment made from the symbol library, moving, with live
 * values. They are files on the station (see graphics.ts) that a person or an AI agent writes with
 * `bask graphic`.
 */
export function GraphicsView(props: { client: BaskStreamClient; active: boolean; rect: Rect; show?: { name: string; n: number } }) {
  const { client, active, rect } = props;
  const ui = useUi();
  const supported = Boolean(client.capabilities.workbench);
  const [list, setList] = useState<{ entries?: GraphicEntry[]; error?: string }>({});
  const [name, setName] = useState<string>();
  const [loaded, setLoaded] = useState<Loaded>();
  const [room, setRoom] = useState<Room>({});
  const [picked, setPicked] = useState(0);
  const [running, setRunning] = useState(true);
  const [n, setN] = useState(0);
  const frame = useFrame(active && running);

  // The list, again whenever something asks to show a graphic (it may have just been saved).
  useEffect(() => {
    if (!supported || !active) return;
    let cancelled = false;
    listGraphics(client).then(
      (entries) => !cancelled && setList({ entries }),
      (error: Error) => !cancelled && setList({ error: error.message })
    );
    return () => {
      cancelled = true;
    };
  }, [supported, active, n, props.show?.n]);
  useEffect(() => {
    if (props.show) setName(props.show.name);
  }, [props.show?.n]);

  const entries = list.entries ?? [];
  const current = entries.find((entry) => entry.name === name) ?? entries[0];
  useEffect(() => {
    if (!current || !active) return;
    let cancelled = false;
    setRoom({});
    setPicked(0);
    loadGraphic(client, current.name).then(
      (raw) => !cancelled && setLoaded({ name: current.name, raw }),
      (error: Error) => !cancelled && setLoaded({ name: current.name, error: error.message })
    );
    return () => {
      cancelled = true;
    };
  }, [current?.name, current?.modified, active, n, props.show?.n]);

  const mine = loaded && current && loaded.name === current.name ? loaded : undefined;
  const read = useMemo<{ plan?: Plan; problems: Problem[] }>(() => (mine?.raw === undefined ? { problems: [] } : readGraphic(mine.raw, room)), [mine?.raw, room]);
  const plan = read.plan;
  const values = useLiveValues(client, "graphic", plan?.points ?? [], active && !!plan);
  const lookup = (ord: string) => values.get(ord);

  // A reading that came out longer than the room kept for it: lay the drawing out once more with room for it.
  useEffect(() => {
    if (!plan) return;
    const grown = roomNeeded(plan, lookup);
    if (grown) setRoom((r) => ({ ...r, ...grown }));
  }, [plan, values]);

  // Parts that read a point can be picked, to act on that point.
  const pickable = useMemo(() => (plan ? plan.parts.filter((p) => p.points.length > 0).sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2) || a.box.x - b.box.x) : []), [plan]);
  const part: Placed | undefined = pickable[Math.min(picked, pickable.length - 1)];
  const ord = part?.points[0];

  const wide = rect.width >= 100 && entries.length > 1;
  const listWidth = wide ? Math.min(30, Math.max(20, ...entries.map((entry) => entry.name.length + 6))) : 0;
  const artWidth = rect.width - listWidth;
  const innerWidth = artWidth - 4;
  const innerHeight = rect.height - 2;
  const artHeight = Math.max(1, innerHeight - 2);
  const index = Math.max(0, entries.findIndex((entry) => entry.name === current?.name));
  const step = (by: number) => entries.length && setName(entries[(index + by + entries.length) % entries.length].name);

  // The part of the drawing that shows: all of it when it fits, else a window that follows the picked part.
  const pan = useRef({ x: 0, y: 0 });
  if (plan) {
    const fitX = plan.width <= innerWidth;
    const fitY = plan.height <= artHeight;
    const cx = part ? part.box.x + Math.floor(part.box.w / 2) : 0;
    const cy = part ? part.box.y + Math.floor(part.box.h / 2) : 0;
    pan.current = {
      x: fitX ? 0 : Math.min(Math.max(0, cx - Math.floor(innerWidth / 2)), plan.width - innerWidth),
      y: fitY ? 0 : Math.min(Math.max(0, cy - Math.floor(artHeight / 2)), plan.height - artHeight)
    };
  }
  const left = plan ? Math.max(0, Math.floor((innerWidth - plan.width) / 2)) : 0;
  const top = plan ? Math.max(0, Math.floor((artHeight - plan.height) / 2)) : 0;

  useKeys(
    (input, key) => {
      if (key.upArrow || input === "k") step(-1);
      else if (key.downArrow || input === "j") step(1);
      else if (key.leftArrow) setPicked((i) => (pickable.length ? (Math.min(i, pickable.length - 1) + pickable.length - 1) % pickable.length : 0));
      else if (key.rightArrow) setPicked((i) => (pickable.length ? (Math.min(i, pickable.length - 1) + 1) % pickable.length : 0));
      else if (input === " ") setRunning((r) => !r);
      else if (input === "r") setN((v) => v + 1);
      else if ((key.return || input === "e") && ord) ui.reveal(ord);
      else if (input === "t" && ord) ui.openTrend(ord);
      else if (input === "w" && ord) ui.watch(ord);
      else if (input === "c" && ord) commandPoint(ui, client, ord, values.get(ord));
      else if (input === "y" && current) ui.copy(graphicPath(current.name), "file path");
      else if (input === "D" && current) {
        if (!ui.canWrite("delete a graphic")) return;
        ui.confirm(`Delete the graphic "${current.name}" from the station? This cannot be undone.`, async () => {
          const done = await ui.attempt("delete", () => deleteGraphic(client, current.name));
          if (!done) return;
          ui.toast(`Deleted ${current.name}`, "good");
          setName(undefined);
          setN((v) => v + 1);
        }, { title: "Delete graphic", danger: true });
      }
    },
    { isActive: active && supported }
  );

  // A click picks the part under it, or a graphic in the list.
  useMouse((e) => {
    if (e.kind !== "down" || !inside(e, rect)) return;
    if (wide && e.x < rect.x + listWidth) {
      const row = e.y - rect.y - 1;
      const start = windowStart(index, entries.length, innerHeight);
      if (row >= 0 && entries[start + row]) setName(entries[start + row].name);
      return;
    }
    if (!plan) return;
    const x = e.x - (rect.x + listWidth + 2) - left + pan.current.x;
    const y = e.y - (rect.y + 1) - top + pan.current.y;
    const hit = pickable.findIndex((p) => (x >= p.box.x && x < p.box.x + p.box.w && y >= p.box.y && y < p.box.y + p.box.h) || (p.label && y >= p.label.y && y <= p.label.y + 1 && Math.abs(x - p.label.x) <= p.label.width / 2));
    if (hit >= 0) setPicked(hit);
  }, active && supported);

  if (!supported) {
    return (
      <Panel title="Graphics" width={rect.width} height={rect.height}>
        <Text color={theme.warn} wrap="wrap">Graphics are kept in the station's files, which need baskStream API 1.10 on the station (this one reports {String(client.capabilities.apiVersion ?? "an older version")}).</Text>
      </Panel>
    );
  }

  const errors = read.problems.filter((p) => p.level === "error");
  const title = plan?.doc.title ?? current?.name ?? "Graphics";
  const meta = !current ? undefined : `${entries.length > 1 && !wide ? `${index + 1} of ${entries.length} · ` : ""}${plan ? `${plan.width} x ${plan.height}` : ""}${running ? "" : " · paused"}`;
  const rows = plan ? drawGraphic(plan, lookup, frame, { selected: part?.at }).render() : [];
  const shown = rows.slice(pan.current.y, pan.current.y + artHeight).map((runs) => cut(runs, pan.current.x, innerWidth));
  const start = windowStart(index, entries.length, innerHeight);

  return (
    <Box height={rect.height} flexDirection="row">
      {wide && (
        <Panel title="Graphics" meta={String(entries.length)} width={listWidth} height={rect.height}>
          {entries.slice(start, start + innerHeight).map((entry, i) => (
            <Text key={entry.name} wrap="truncate-end" backgroundColor={start + i === index ? theme.selection : undefined} bold={start + i === index}>
              {` ${clip(entry.name, listWidth - 6).padEnd(listWidth - 5)}`}
            </Text>
          ))}
        </Panel>
      )}
      <Panel title={title} meta={meta} width={artWidth} height={rect.height} focused>
        {list.error ? (
          <Text color={theme.bad} wrap="wrap">{list.error}</Text>
        ) : !list.entries ? (
          <Text color={theme.muted}>Reading the station's graphics…</Text>
        ) : !current ? (
          <Empty title="No graphics on this station yet.">
            <Text color={theme.muted} wrap="wrap">A graphic is a drawing of equipment in the terminal, moving, with live values. Ask the AI agent in this workspace for one ("draw AHU-1"), or write one yourself:</Text>
            <Text> </Text>
            <Text><Text color={theme.accent} bold>bask graphic guide</Text><Text color={theme.muted}>   how to write one, and the symbols</Text></Text>
            <Text><Text color={theme.accent} bold>bask symbols</Text><Text color={theme.muted}>         the symbol library, moving</Text></Text>
          </Empty>
        ) : mine?.error ? (
          <Text color={theme.bad} wrap="wrap">{mine.error}</Text>
        ) : !mine ? (
          <Text color={theme.muted}>Reading {current.name}…</Text>
        ) : !plan || errors.length ? (
          <Box flexDirection="column">
            <Text color={theme.bad} bold>{current.name} cannot be drawn:</Text>
            {(errors.length ? errors : read.problems).slice(0, Math.max(1, innerHeight - 3)).map((p, i) => (
              <Text key={i} wrap="truncate-end"><Text color={theme.muted}>{p.at ? `${p.at}: ` : ""}</Text>{p.message}</Text>
            ))}
            <Text color={theme.muted}>Fix the file and save it again: bask graphic print {current.name}</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="column" height={artHeight} paddingTop={top} paddingLeft={left}>
              <Art rows={shown} />
            </Box>
            <Text color={theme.faint}>{"─".repeat(Math.max(0, innerWidth))}</Text>
            <Text wrap="truncate-end">{footer(part, lookup, innerWidth)}</Text>
          </Box>
        )}
      </Panel>
    </Box>
  );
}

/** One row of the drawing from a column on, `width` cells of it. */
function cut(runs: ReturnType<ReturnType<typeof drawGraphic>["render"]>[number], from: number, width: number) {
  const out: typeof runs = [];
  let x = 0;
  for (const run of runs) {
    const chars = [...run.text];
    const a = Math.max(0, from - x);
    const b = Math.min(chars.length, from + width - x);
    if (b > a) out.push({ text: chars.slice(a, b).join(""), style: run.style });
    x += chars.length;
  }
  return out;
}

/** The picked part: its name, then each of its points with what it reads now. */
function footer(part: Placed | undefined, values: (ord: string) => { displayValue?: string; value?: unknown; state?: string } | undefined, width: number): React.ReactNode {
  if (!part) return <Text color={theme.muted}>Nothing here reads a point.</Text>;
  const now = partNow(part, values);
  const name = part.doc.label ?? part.def?.title ?? "Part";
  const status = now.state.status && now.state.status !== "ok" ? ` ${now.state.status}` : "";
  const points = part.points.map((ord) => {
    const point = values(ord);
    return `${place(ord, 1)} ${point ? point.displayValue ?? String(point.value ?? "—") : "…"}`;
  });
  return (
    <>
      <Text bold>{name}</Text>
      <Text color={now.state.status === "alarm" ? theme.bad : theme.warn}>{status}</Text>
      <Text color={theme.muted}>{clip(`  ${points.join("  ·  ")}`, Math.max(0, width - name.length - status.length))}</Text>
    </>
  );
}
