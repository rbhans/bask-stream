// The symbol gallery (`bask symbols`): every symbol in the library, moving, with keys to try its
// states, and a second page with example assemblies. It needs no station.
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import { useKeyPump, useKeys, useMouse } from "../input.js";
import { Hint, Panel, clip, theme } from "../ui.js";
import { Canvas, type Run } from "./canvas.js";
import { EXAMPLES } from "./examples.js";
import { GROUPS, MEDIA, STATUSES, SYMBOLS, drawSymbol, paint, sizeOf, type SymbolDef, type SymbolState } from "./library.js";

const CELL_WIDTH = 18;
const CELL_HEIGHT = 8;
/** Frames a second. Slow enough to read, fast enough to look alive. */
const FPS = 8;

/** Rows of styled runs, as text. */
export function Art({ rows }: { rows: Run[][] }) {
  return (
    <>
      {rows.map((runs, y) => (
        <Text key={y} wrap="truncate-end">
          {runs.map((run, i) => (
            <Text key={i} color={run.style.color} bold={run.style.bold} dimColor={run.style.dim} inverse={run.style.inverse}>
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

/** A frame counter that advances while `running`. */
export function useFrame(running: boolean, fps = FPS): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setFrame((f) => f + 1), Math.round(1000 / fps));
    return () => clearInterval(timer);
  }, [running, fps]);
  return frame;
}

export function Gallery(props: { mouse?: boolean; terminal?: (data: string) => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 120, rows: stdout.rows || 36 });
  const [page, setPage] = useState<"symbols" | "examples">("symbols");
  const [selected, setSelected] = useState(0);
  const [example, setExample] = useState(0);
  const [running, setRunning] = useState(true);
  const [states, setStates] = useState<Record<string, SymbolState>>(() => Object.fromEntries(SYMBOLS.map((s) => [s.id, { ...s.sample }])));
  const frame = useFrame(running);
  useKeyPump();

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);
  useEffect(() => props.terminal?.("\x1b]2;bask · symbols\x07"), []);

  const width = Math.max(40, size.columns);
  const height = Math.max(14, size.rows);
  const columns = Math.max(1, Math.floor(width / CELL_WIDTH));
  const detailHeight = height >= 30 ? 11 : height >= 22 ? 8 : 0;
  const bodyHeight = height - 2 - detailHeight;

  // Where each symbol sits on the tall sheet that the window scrolls over.
  const layout = useMemo(() => {
    const cells: { def: SymbolDef; index: number; x: number; y: number }[] = [];
    const headings: { y: number; title: string }[] = [];
    let y = 0;
    let index = 0;
    for (const group of GROUPS) {
      const members = SYMBOLS.filter((s) => s.group === group);
      headings.push({ y, title: group });
      y += 2;
      members.forEach((def, i) => {
        cells.push({ def, index, x: (i % columns) * CELL_WIDTH, y: y + Math.floor(i / columns) * CELL_HEIGHT });
        index += 1;
      });
      y += Math.ceil(members.length / columns) * CELL_HEIGHT;
    }
    return { cells, headings, height: y };
  }, [columns]);

  const current = layout.cells[Math.min(selected, layout.cells.length - 1)];
  // Keep the selected symbol in view, with its group heading when it is in the first row of a group.
  const scroll = Math.max(0, Math.min(layout.height - bodyHeight, current.y - Math.max(2, Math.floor((bodyHeight - CELL_HEIGHT) / 2))));

  const change = (id: string, patch: (state: SymbolState) => SymbolState) => setStates((all) => ({ ...all, [id]: patch(all[id]) }));

  useKeys((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (key.tab || input === "e") return setPage((p) => (p === "symbols" ? "examples" : "symbols"));
    if (input === " ") return setRunning((r) => !r);
    if (page === "examples") {
      if (key.upArrow || key.leftArrow || input === "k") setExample((n) => Math.max(0, n - 1));
      else if (key.downArrow || key.rightArrow || input === "j") setExample((n) => Math.min(EXAMPLES.length - 1, n + 1));
      return;
    }
    const def = current.def;
    const move = (to: number) => setSelected(Math.max(0, Math.min(layout.cells.length - 1, to)));
    // Up and down go to the nearest symbol in the next row, which may be in another group.
    const vertical = (direction: 1 | -1) => {
      const rows = [...new Set(layout.cells.map((c) => c.y))].sort((a, b) => a - b);
      const target = rows[rows.indexOf(current.y) + direction];
      if (target === undefined) return;
      const row = layout.cells.filter((c) => c.y === target);
      move(row.reduce((best, c) => (Math.abs(c.x - current.x) < Math.abs(best.x - current.x) ? c : best)).index);
    };
    if (key.leftArrow || input === "h") move(selected - 1);
    else if (key.rightArrow || input === "l") move(selected + 1);
    else if (key.upArrow || input === "k") vertical(-1);
    else if (key.downArrow || input === "j") vertical(1);
    else if (input === "s") change(def.id, (s) => ({ ...s, status: STATUSES[(STATUSES.indexOf(s.status ?? "ok") + 1) % STATUSES.length] }));
    else if (input === "[" || input === "-") change(def.id, (s) => ({ ...s, value: Math.max(0, (s.value ?? 50) - 10) }));
    else if (input === "]" || input === "+" || input === "=") change(def.id, (s) => ({ ...s, value: Math.min(100, (s.value ?? 50) + 10) }));
    else if (input === "m") change(def.id, (s) => ({ ...s, medium: MEDIA[(MEDIA.indexOf(s.medium ?? "air") + 1) % MEDIA.length] }));
    else if (input === "o") change(def.id, (s) => ({ ...s, open: !s.open }));
    else if (input === "f") change(def.id, (s) => ({ ...s, flow: s.flow === -1 ? 1 : -1 }));
    else if (input === "p") change(def.id, (s) => ({ ...s, on: s.on === false }));
    else if (input === "r") change(def.id, () => ({ ...def.sample }));
  });
  useMouse((e) => {
    if (page !== "symbols" || e.y < 1 || e.y >= 1 + bodyHeight) return;
    if (e.kind === "wheelUp") return setSelected((s) => Math.max(0, s - columns));
    if (e.kind === "wheelDown") return setSelected((s) => Math.min(layout.cells.length - 1, s + columns));
    if (e.kind !== "down") return;
    const y = e.y - 1 + scroll;
    const hit = layout.cells.find((c) => e.x >= c.x && e.x < c.x + CELL_WIDTH && y >= c.y && y < c.y + CELL_HEIGHT);
    if (hit) setSelected(hit.index);
  }, !!props.mouse);

  // ---- The sheet of symbols -----------------------------------------------------------------------
  const sheet = useMemo(() => {
    const canvas = new Canvas(width, Math.max(layout.height, bodyHeight));
    for (const heading of layout.headings) {
      canvas.text(1, heading.y, heading.title, { bold: true, color: theme.accent2 });
      canvas.text(heading.title.length + 2, heading.y, "─".repeat(Math.max(0, width - heading.title.length - 4)), { color: theme.faint });
    }
    for (const cell of layout.cells) {
      const state = states[cell.def.id];
      const sprite = drawSymbol(cell.def.id, state, frame);
      const [w, h] = sizeOf(sprite);
      // Symbols stand on a common baseline, centred in their cell.
      canvas.sprite(cell.x + Math.floor((CELL_WIDTH - w) / 2), cell.y + (CELL_HEIGHT - 2 - h), sprite, (letter) => paint(letter, state));
      const isSelected = cell.index === selected;
      canvas.center(cell.x + Math.floor(CELL_WIDTH / 2), cell.y + CELL_HEIGHT - 2, isSelected ? ` ${cell.def.title} ` : cell.def.title, isSelected ? { color: theme.accent, bold: true, inverse: true } : { color: theme.muted });
    }
    return canvas.render();
  }, [frame, states, selected, layout, width, bodyHeight]);

  const def = current.def;
  const state = states[def.id];
  const describe = [
    state.status && state.status !== "ok" ? state.status : state.on === false ? "stopped" : "running",
    def.value ? `value ${state.value ?? "—"}` : "",
    def.uses.includes("medium") ? `medium ${state.medium ?? "air"}` : "",
    def.uses.includes("open") ? (state.open ? "open" : "closed") : ""
  ].filter(Boolean).join(" · ");

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end">
        <Text backgroundColor={theme.accent} color={theme.onAccent} bold>{" ◆ bask symbols "}</Text>
        {"  "}
        {(["symbols", "examples"] as const).map((name) => (
          <Text key={name}>
            <Text color={page === name ? theme.onAccent : theme.muted} backgroundColor={page === name ? theme.accent2 : undefined} bold={page === name}>{` ${name === "symbols" ? `Symbols ${SYMBOLS.length}` : `Examples ${EXAMPLES.length}`} `}</Text>
            {"  "}
          </Text>
        ))}
        <Text color={running ? theme.good : theme.warn}>{running ? "● moving" : "◌ paused"}</Text>
      </Text>
      {page === "symbols" ? (
        <>
          <Box flexDirection="column" height={bodyHeight} overflow="hidden">
            <Art rows={sheet.slice(scroll, scroll + bodyHeight)} />
          </Box>
          {detailHeight > 0 && <Detail def={def} state={state} describe={describe} frame={frame} width={width} height={detailHeight} />}
        </>
      ) : (
        <Examples frame={frame} width={width} height={height - 2} selected={example} />
      )}
      <Text wrap="truncate-end">
        {page === "symbols" ? (
          <>
            <Hint k="←↑↓→" label="choose" />
            <Hint k="s" label="status" />
            {def.value && <Hint k="[ ]" label="value" />}
            {def.uses.includes("on") && <Hint k="p" label="start/stop" />}
            {def.uses.includes("medium") && <Hint k="m" label="medium" />}
            {def.uses.includes("flow") && <Hint k="f" label="direction" />}
            {def.uses.includes("open") && <Hint k="o" label="door" />}
            <Hint k="r" label="reset" />
          </>
        ) : (
          <Hint k="↑↓" label="example" />
        )}
        <Hint k="space" label={running ? "pause" : "play"} />
        <Hint k="tab" label={page === "symbols" ? "examples" : "symbols"} />
        <Hint k="q" label="quit" />
      </Text>
    </Box>
  );
}

/** The selected symbol: what it is, what it reads, and how it looks in each status. */
function Detail({ def, state, describe, frame, width, height }: { def: SymbolDef; state: SymbolState; describe: string; frame: number; width: number; height: number }) {
  const inner = width - 4;
  const [w, h] = sizeOf(drawSymbol(def.id, state, frame));
  const textWidth = Math.max(30, Math.min(64, Math.floor(inner * 0.45)));
  const stripWidth = inner - textWidth - 2;
  const strip = useMemo(() => {
    const rows = Math.max(1, height - 2);
    const canvas = new Canvas(Math.max(1, stripWidth), rows);
    const each = Math.max(w + 2, 11);
    const shown = (["ok", "off", "alarm", "fault", "overridden"] as const).slice(0, Math.max(1, Math.floor(stripWidth / each)));
    shown.forEach((status, i) => {
      const variant: SymbolState = { ...state, status, on: status !== "off" };
      const sprite = drawSymbol(def.id, variant, frame);
      const [sw, sh] = sizeOf(sprite);
      canvas.sprite(i * each + Math.floor((each - sw) / 2), Math.max(0, rows - 2 - sh), sprite, (letter) => paint(letter, variant));
      canvas.center(i * each + Math.floor(each / 2), rows - 1, status === "ok" ? "running" : status, { color: theme.muted });
    });
    return canvas.render();
  }, [def.id, state, frame, stripWidth, height, w]);
  const reads = [def.value ? `value: ${def.value}` : "", def.aux ? `aux: ${def.aux}` : "", def.uses.includes("text") ? "text" : "", def.uses.includes("title") ? "title" : ""].filter(Boolean).join(" · ");

  return (
    <Panel title={def.title} meta={`${def.id} · ${w} x ${h}`} width={width} height={height} focused={false}>
      <Box>
        <Box flexDirection="column" width={textWidth} marginRight={2}>
          <Text wrap="wrap">{clip(def.note, textWidth * Math.max(1, height - 5))}</Text>
          <Text> </Text>
          <Text color={theme.muted} wrap="truncate-end">now: <Text color={theme.accent}>{describe}</Text></Text>
          {reads ? <Text color={theme.muted} wrap="truncate-end">reads: {clip(reads, textWidth - 7)}</Text> : null}
          {def.ports ? <Text color={theme.muted} wrap="truncate-end">connects at: {clip(Object.keys(def.ports).join(", "), textWidth - 13)}</Text> : null}
        </Box>
        <Box flexDirection="column" width={Math.max(1, stripWidth)}>
          <Art rows={strip} />
        </Box>
      </Box>
    </Panel>
  );
}

function Examples({ frame, width, height, selected }: { frame: number; width: number; height: number; selected: number }) {
  // As many examples as fit, starting from the selected one.
  const order = [...EXAMPLES.slice(selected), ...EXAMPLES.slice(0, selected)];
  let room = height;
  const shown = order.filter((example) => {
    const needs = example.height + 3;
    if (needs > room) return false;
    room -= needs;
    return true;
  });
  if (shown.length === 0 || EXAMPLES.some((e) => e.width + 4 > width)) {
    return (
      <Box height={height} flexDirection="column" paddingX={1}>
        <Text color={theme.warn} wrap="wrap">The examples need a window at least {Math.max(...EXAMPLES.map((e) => e.width)) + 4} columns wide and {Math.min(...EXAMPLES.map((e) => e.height)) + 3} rows tall. Make this one larger.</Text>
      </Box>
    );
  }
  return (
    <Box height={height} flexDirection="column">
      {shown.map((example) => (
        <Panel key={example.id} title={example.title} width={width} height={example.height + 3} focused={example === EXAMPLES[selected]}>
          <Art rows={example.draw(frame).render()} />
        </Panel>
      ))}
    </Box>
  );
}
