import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { Json } from "@basidekick/baskstream";
import { inside, useKeys, useMouse, type Rect } from "./input.js";
import { theme, toneColor, type Tone } from "./theme.js";

export { theme, toneColor, statusTone, type Tone } from "./theme.js";
export type { Rect } from "./input.js";

export const VIEWS = ["home", "explorer", "watch", "alarms", "trends", "schedules", "query", "files", "jobs", "activity", "graphics", "logic"] as const;
export type ViewName = (typeof VIEWS)[number];
export const VIEW_LABEL: Record<ViewName, string> = {
  home: "Home", explorer: "Explorer", watch: "Watch", alarms: "Alarms", trends: "Trends", schedules: "Schedules", query: "Query", files: "Files", jobs: "Jobs", activity: "AI Activity", graphics: "Graphics", logic: "Logic"
};

export interface Choice<T = string> {
  label: string;
  value: T;
  hint?: string;
}

export type Modal =
  | { kind: "confirm"; title?: string; text: string; lines?: string[]; danger?: boolean; onYes: () => void; onCancel?: () => void }
  | { kind: "input"; label: string; initial?: string; hint?: string; onSubmit: (value: string) => void }
  | { kind: "select"; label: string; options: Choice<unknown>[]; onSelect: (value: unknown) => void };

/** Shared dashboard services for the views. */
export interface Ui {
  toast(text: string, tone?: Tone): void;
  confirm(text: string, onYes: () => void, options?: { title?: string; lines?: string[]; danger?: boolean; onCancel?: () => void }): void;
  prompt(label: string, onSubmit: (value: string) => void, options?: { initial?: string; hint?: string }): void;
  select<T>(label: string, options: Choice<T>[], onSelect: (value: T) => void): void;
  /** Runs a station call, turning a failure into a red toast. */
  attempt<T>(label: string, work: () => Promise<T>): Promise<T | undefined>;
  /** Whether this session may change the station. */
  allowWrites: boolean;
  /** True when changes are on; otherwise says how to turn them on and returns false. */
  canWrite(what: string): boolean;
  /** Previews model changes, asks, applies them, and reports the outcome. */
  plan(title: string, changes: Json[], lines?: string[]): Promise<boolean>;
  goto(view: ViewName): void;
  openTrend(ord: string): void;
  reveal(ord: string): void;
  watch(ord: string): void;
  discover(ord: string): void;
  runQuery(query: { bql?: string; neql?: string }): void;
  /** Copies text to the system clipboard through the terminal. */
  copy(text: string, what?: string): void;
  /** A view is taking typed text, so single-key shortcuts are off. */
  typing(on: boolean): void;
  /** Hands the screen to another program (an editor) and redraws afterwards. */
  suspend(work: () => void): void;
}

export const UiContext = createContext<Ui | null>(null);
export const useUi = () => useContext(UiContext)!;

// ---- Text helpers ---------------------------------------------------------------------------------

export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
/** Keeps the end of a path, which is the part that tells points apart. */
export const clipStart = (text: string, width: number) => (width <= 0 ? "" : text.length <= width ? text : `…${text.slice(text.length - width + 1)}`);
export const padEnd = (text: string, width: number) => clip(text, width).padEnd(Math.max(0, width));
export const padStart = (text: string, width: number) => clip(text, width).padStart(Math.max(0, width));

/** Keeps the cursor row inside a scrolling window of `size` rows. */
export function windowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.min(Math.max(0, cursor - Math.floor(size / 2)), total - size);
}

/**
 * Column widths for a table `total` wide (one space between columns). Each column takes at least
 * `min`; what is left goes to columns with `flex`, up to their `max`.
 */
export function fit(total: number, columns: { min: number; max?: number; flex?: number }[]): number[] {
  // A column with `min: 0` is hidden: it takes no width and no separator.
  const widths = columns.map((c) => c.min);
  let spare = total - (columns.filter((c) => c.min > 0).length - 1) - widths.reduce((a, b) => a + b, 0);
  for (let pass = 0; pass < 4 && spare > 0; pass += 1) {
    const open = columns.map((c, i) => (c.min > 0 && c.flex && widths[i] < (c.max ?? Infinity) ? i : -1)).filter((i) => i >= 0);
    const weight = open.reduce((n, i) => n + (columns[i].flex ?? 0), 0);
    if (!weight) break;
    let used = 0;
    for (const i of open) {
      const add = Math.min(Math.floor((spare * (columns[i].flex ?? 0)) / weight), (columns[i].max ?? Infinity) - widths[i]);
      widths[i] += add;
      used += add;
    }
    if (used === 0) break;
    spare -= used;
  }
  return widths;
}

// ---- Panels ---------------------------------------------------------------------------------------

/** A rounded panel with its title, and an optional note at the right, drawn into the top border. */
export function Panel(props: { title: string; meta?: string; metaColor?: string; width: number; height: number; children?: React.ReactNode; focused?: boolean; color?: string }) {
  const { title, meta, width, height, children, focused = true } = props;
  const color = props.color ?? (focused ? theme.accent : theme.faint);
  const room = Math.max(0, width - 6);
  const note = meta && meta.length + title.length + 4 <= room ? meta : undefined;
  const label = clip(title, room - (note ? note.length + 3 : 0));
  const fill = Math.max(0, width - 5 - label.length - (note ? note.length + 2 : 0));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end">
        <Text color={color}>{"╭─ "}</Text>
        <Text bold color={focused ? undefined : theme.muted}>
          {label}
        </Text>
        <Text color={color}>{` ${"─".repeat(fill)}`}</Text>
        {note ? <Text color={props.metaColor ?? theme.muted}>{` ${note} `}</Text> : null}
        <Text color={color}>╮</Text>
      </Text>
      <Box flexDirection="column" borderStyle="round" borderTop={false} borderColor={color} height={height - 1} paddingX={1} overflow="hidden">
        {/* Content taller than the panel is cut off at the bottom rather than squeezed together. */}
        <Box flexDirection="column" flexShrink={0} minHeight={Math.max(0, height - 2)}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}

/** A dim label and its value on one line. */
export function Field({ label, value, color, width, labelWidth = 9, bold }: { label: string; value: React.ReactNode; color?: string; width?: number; labelWidth?: number; bold?: boolean }) {
  return (
    <Text wrap="truncate-end">
      <Text color={theme.muted}>{label.padEnd(labelWidth)}</Text>
      <Text color={color} bold={bold}>
        {typeof value === "string" && width ? clip(value, width - labelWidth) : value}
      </Text>
    </Text>
  );
}

/** A small filled label, such as a count or a state. */
export function Badge({ text, color, dim }: { text: string; color: string; dim?: boolean }) {
  return dim ? <Text color={color}>{` ${text} `}</Text> : <Text backgroundColor={color} color={theme.onAccent} bold>{` ${text} `}</Text>;
}

/** Key hint for the footer: a bold key and a dim label. */
export function Hint({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color={theme.accent} bold>
        {k}
      </Text>
      <Text color={theme.muted}> {label}   </Text>
    </Text>
  );
}

/** A horizontal meter: filled part in `color`, the rest faint. */
export function Meter({ value, max, width, color }: { value: number; max: number; width: number; color?: string }) {
  const filled = Math.max(0, Math.min(width, Math.round((value / (max || 1)) * width)));
  return (
    <Text>
      <Text color={color ?? theme.accent}>{"━".repeat(filled)}</Text>
      <Text color={theme.faint}>{"━".repeat(width - filled)}</Text>
    </Text>
  );
}

// ---- Lists and tables -----------------------------------------------------------------------------

/**
 * A cursor over `count` rows shown `page` at a time: arrow keys, j/k, page keys, home/end, the mouse
 * wheel, and a click on a row inside `region` (the rows' place on the screen). Clicking the selected
 * row, or pressing Enter, calls `onEnter`.
 */
export function useCursor(count: number, page: number, options: { active: boolean; region?: Rect; onEnter?: (index: number) => void; letters?: boolean }) {
  const { active, region, onEnter, letters = true } = options;
  const [cursor, setCursor] = useState(0);
  const max = Math.max(0, count - 1);
  const at = Math.min(cursor, max);
  const move = (delta: number) => setCursor((c) => Math.max(0, Math.min(max, Math.min(c, max) + delta)));
  useKeys(
    (input, key) => {
      if (key.upArrow || (letters && input === "k")) move(-1);
      else if (key.downArrow || (letters && input === "j")) move(1);
      else if (key.pageUp) move(-Math.max(1, page - 1));
      else if (key.pageDown) move(Math.max(1, page - 1));
      else if (key.home) setCursor(0);
      else if (key.end) setCursor(max);
      else if (key.return && count > 0) onEnter?.(at);
    },
    { isActive: active }
  );
  const start = windowStart(at, count, Math.max(1, page));
  useMouse((e) => {
    if (!region || !inside(e, region)) return;
    if (e.kind === "wheelUp") move(-3);
    else if (e.kind === "wheelDown") move(3);
    else if (e.kind === "down") {
      const index = start + (e.y - region.y);
      if (index < 0 || index >= count) return;
      if (index === at) onEnter?.(index);
      else setCursor(index);
    }
  }, active && !!region);
  return { cursor: at, setCursor, start, move };
}

export interface Cell {
  text: string;
  color?: string;
  bold?: boolean;
  inverse?: boolean;
}

export interface Column<T> {
  title: string;
  width: number;
  align?: "right";
  cell: (row: T, index: number) => Cell | string;
}

/** A header and `size` rows starting at `start`, with the cursor row highlighted. */
export function Table<T>(props: { columns: Column<T>[]; rows: T[]; start: number; size: number; cursor?: number; rowKey: (row: T, index: number) => string; focused?: boolean; header?: boolean }) {
  const { columns, rows, start, size, cursor, rowKey, focused = true, header = true } = props;
  const shown = columns.filter((c) => c.width > 0);
  const pad = (text: string, c: Column<T>) => (c.align === "right" ? padStart(text, c.width) : padEnd(text, c.width));
  return (
    <>
      {header && (
        <Text color={theme.muted} wrap="truncate-end">
          {shown.map((c) => pad(c.title, c)).join(" ")}
        </Text>
      )}
      {rows.slice(start, start + size).map((row, i) => {
        const index = start + i;
        const selected = index === cursor;
        return (
          <Text key={rowKey(row, index)} backgroundColor={selected ? (focused ? theme.selection : theme.selectionDim) : undefined} wrap="truncate-end">
            {shown.map((c, n) => {
              const value = c.cell(row, index);
              const cell = typeof value === "string" ? { text: value } : value;
              return (
                <Text key={n} color={cell.color} bold={cell.bold} inverse={cell.inverse}>
                  {pad(cell.text, c)}
                  {n < shown.length - 1 ? " " : ""}
                </Text>
              );
            })}
          </Text>
        );
      })}
    </>
  );
}

// ---- Text entry and dialogs -----------------------------------------------------------------------

/**
 * One editable line: arrows, home/end (or ctrl+a / ctrl+e), ctrl+u to clear, ctrl+w to drop a word.
 * `history` is offered with the up and down arrows.
 */
export function TextInput(props: { initial?: string; placeholder?: string; onSubmit: (value: string) => void; onCancel?: () => void; onChange?: (value: string) => void; active?: boolean; width?: number; history?: string[] }) {
  const { initial = "", placeholder, onSubmit, onCancel, onChange, active = true, width = 60, history } = props;
  const [state, setState] = useState({ value: initial, at: initial.length, recall: -1 });
  const stateRef = useRef(state);
  stateRef.current = state;
  const set = (value: string, at: number, recall = -1) => {
    setState({ value, at, recall });
    if (value !== stateRef.current.value) onChange?.(value);
  };
  useKeys(
    (input, key) => {
      const { value, at, recall } = stateRef.current;
      if (key.return) onSubmit(value);
      else if (key.escape) onCancel?.();
      else if (key.leftArrow) set(value, Math.max(0, at - 1), recall);
      else if (key.rightArrow) set(value, Math.min(value.length, at + 1), recall);
      else if (key.home || (key.ctrl && input === "a")) set(value, 0, recall);
      else if (key.end || (key.ctrl && input === "e")) set(value, value.length, recall);
      else if (key.ctrl && input === "u") set("", 0);
      else if (key.ctrl && input === "w") {
        const head = value.slice(0, at).replace(/\S+\s*$/, "");
        set(head + value.slice(at), head.length);
      } else if (key.backspace || key.delete) {
        if (at > 0) set(value.slice(0, at - 1) + value.slice(at), at - 1);
      } else if ((key.upArrow || key.downArrow) && history?.length) {
        const next = Math.max(-1, Math.min(history.length - 1, recall + (key.upArrow ? 1 : -1)));
        const text = next < 0 ? "" : history[next];
        set(text, text.length, next);
      } else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown) {
        const text = input.replace(/[\r\n]+/g, " ");
        set(value.slice(0, at) + text + value.slice(at), at + text.length);
      }
    },
    { isActive: active }
  );
  const { value, at } = state;
  // Scroll long text so the cursor stays in view.
  const from = Math.max(0, Math.min(at - width + 2, value.length - width + 1));
  const view = value.slice(from, from + width - 1);
  const pos = at - from;
  if (!value && placeholder && !active) return <Text color={theme.faint}>{clip(placeholder, width)}</Text>;
  return (
    <Text>
      {view.slice(0, pos)}
      <Text inverse={active}>{view[pos] ?? " "}</Text>
      {view.slice(pos + 1)}
      {!value && placeholder ? <Text color={theme.faint}>{clip(placeholder, width - 2)}</Text> : null}
    </Text>
  );
}

export function ModalBox({ modal, close, width }: { modal: Modal; close: () => void; width: number }) {
  const boxWidth = Math.max(40, Math.min(width - 4, 86));
  const inner = boxWidth - 6;
  const options = modal.kind === "select" ? modal.options : [];
  const list = useCursor(options.length, 12, {
    active: modal.kind === "select",
    letters: false,
    onEnter: (index) => {
      if (modal.kind !== "select") return;
      close();
      modal.onSelect(options[index].value);
    }
  });
  useKeys(
    (input, key) => {
      if (modal.kind === "confirm") {
        if (input === "y" || input === "Y") {
          close();
          modal.onYes();
        } else if (key.escape || input === "n" || input === "N" || key.return) {
          close();
          modal.onCancel?.();
        }
      } else if (modal.kind === "select") {
        if (key.escape) return close();
        const quick = options.findIndex((o) => o.label[0]?.toLowerCase() === input.toLowerCase());
        if (input && quick >= 0 && options.filter((o) => o.label[0]?.toLowerCase() === input.toLowerCase()).length === 1) {
          close();
          modal.onSelect(options[quick].value);
        }
      }
    },
    { isActive: modal.kind !== "input" }
  );
  const color = modal.kind === "confirm" ? (modal.danger ? theme.bad : theme.warn) : theme.accent;
  return (
    <Box borderStyle="round" borderColor={color} paddingX={2} flexDirection="column" alignSelf="center" width={boxWidth}>
      {modal.kind === "confirm" ? (
        <>
          <Text bold color={color}>
            {modal.title ?? "Confirm"}
          </Text>
          <Text wrap="wrap">{modal.text}</Text>
          {(modal.lines ?? []).slice(0, 12).map((line, i) => (
            <Text key={i} color={theme.muted} wrap="truncate-end">
              {clip(line, inner)}
            </Text>
          ))}
          {(modal.lines?.length ?? 0) > 12 && <Text color={theme.muted}>… and {modal.lines!.length - 12} more</Text>}
          <Text> </Text>
          <Text color={theme.muted}>
            <Text color={theme.good} bold>
              y
            </Text>{" "}
            yes{"    "}
            <Text bold>n</Text> / esc cancel
          </Text>
        </>
      ) : modal.kind === "input" ? (
        <>
          <Text bold color={color} wrap="truncate-end">
            {modal.label}
          </Text>
          <Box>
            <Text color={color}>› </Text>
            <TextInput
              initial={modal.initial}
              width={inner - 2}
              onCancel={close}
              onSubmit={(value) => {
                close();
                modal.onSubmit(value);
              }}
            />
          </Box>
          <Text color={theme.muted} wrap="truncate-end">
            {modal.hint ? `${modal.hint} · ` : ""}enter ok · esc cancel
          </Text>
        </>
      ) : (
        <>
          <Text bold color={color} wrap="truncate-end">
            {modal.label}
          </Text>
          {options.slice(list.start, list.start + 12).map((option, i) => {
            const selected = list.start + i === list.cursor;
            return (
              <Text key={i} backgroundColor={selected ? theme.selection : undefined} wrap="truncate-end">
                <Text color={selected ? theme.accent : theme.faint}>{selected ? "› " : "  "}</Text>
                <Text bold={selected}>{padEnd(option.label, Math.min(34, inner - 2))}</Text>
                <Text color={theme.muted}>{clip(option.hint ?? "", Math.max(0, inner - 38))}</Text>
              </Text>
            );
          })}
          <Text color={theme.muted}>↑↓ move · enter choose · esc cancel</Text>
        </>
      )}
    </Box>
  );
}

/** A line that says what to do when a view has nothing to show. */
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{title}</Text>
      {children}
    </Box>
  );
}

/** Re-renders the caller every `ms` while `active`, for ages and countdowns. */
export function useTick(ms: number, active = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(timer);
  }, [ms, active]);
  return n;
}

/** The tone a toast should take for an error code-free message. */
export const tone = (t: Tone) => toneColor(t);
