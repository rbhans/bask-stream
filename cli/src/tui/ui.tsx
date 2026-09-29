import React, { createContext, useContext, useState } from "react";
import { Box, Text, useInput } from "ink";

export const theme = {
  accent: "#7aa2f7",
  accent2: "#bb9af7",
  good: "#9ece6a",
  warn: "#e0af68",
  bad: "#f7768e",
  info: "#7dcfff",
  muted: "gray",
  selection: "#283457"
};

export type Tone = "info" | "good" | "warn" | "bad";
export const toneColor = (tone: Tone) => ({ info: theme.info, good: theme.good, warn: theme.warn, bad: theme.bad })[tone];

export function statusTone(status: unknown): string {
  const s = typeof status === "string" ? status : "";
  if (/alarm/.test(s)) return theme.bad;
  if (/fault|down/.test(s)) return theme.accent2;
  if (/stale|disabled|null/.test(s)) return theme.warn;
  if (/overridden/.test(s)) return theme.info;
  return theme.good;
}

export type Modal =
  | { kind: "confirm"; text: string; onYes: () => void }
  | { kind: "input"; label: string; initial?: string; onSubmit: (value: string) => void };

/** Shared dashboard services for the views. */
export interface Ui {
  toast(text: string, tone?: Tone): void;
  confirm(text: string, onYes: () => void): void;
  prompt(label: string, onSubmit: (value: string) => void, initial?: string): void;
  /** Runs a station call, turning a failure into a red toast. */
  attempt<T>(label: string, work: () => Promise<T>): Promise<T | undefined>;
  openHistory(ord: string): void;
  allowWrites: boolean;
}

export const UiContext = createContext<Ui | null>(null);
export const useUi = () => useContext(UiContext)!;

/** Keyboard-editable single line of text. */
export function TextInput({ initial = "", onSubmit, onCancel }: { initial?: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  useInput((input, key) => {
    if (key.return) onSubmit(value);
    else if (key.escape) onCancel();
    else if (key.backspace || key.delete) setValue((v) => v.slice(0, -1));
    else if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) setValue((v) => v + input);
  });
  return (
    <Text>
      {value}
      <Text inverse> </Text>
    </Text>
  );
}

export function ModalBox({ modal, close }: { modal: Modal; close: () => void }) {
  useInput(
    (input, key) => {
      if (modal.kind !== "confirm") return;
      if (input === "y" || input === "Y") {
        close();
        modal.onYes();
      } else if (key.escape || input === "n" || input === "N" || key.return) close();
    },
    { isActive: modal.kind === "confirm" }
  );
  return (
    <Box borderStyle="round" borderColor={modal.kind === "confirm" ? theme.warn : theme.accent} paddingX={2} paddingY={0} flexDirection="column" alignSelf="center" minWidth={50}>
      {modal.kind === "confirm" ? (
        <>
          <Text bold color={theme.warn}>
            Confirm
          </Text>
          <Text>{modal.text}</Text>
          <Text color={theme.muted}>
            <Text color={theme.good} bold>
              y
            </Text>{" "}
            yes{"   "}
            <Text bold>n</Text>/esc cancel
          </Text>
        </>
      ) : (
        <>
          <Text bold color={theme.accent}>
            {modal.label}
          </Text>
          <Box>
            <Text color={theme.accent}>› </Text>
            <TextInput
              initial={modal.initial}
              onCancel={close}
              onSubmit={(value) => {
                close();
                modal.onSubmit(value);
              }}
            />
          </Box>
          <Text color={theme.muted}>enter send · esc cancel</Text>
        </>
      )}
    </Box>
  );
}

/** Key hint for the footer: a bold key and a dim label. */
export function Hint({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color={theme.accent} bold>
        {k}
      </Text>
      <Text color={theme.muted}> {label}  </Text>
    </Text>
  );
}

/** A bordered panel with its title drawn into the top border. */
export function Panel({ title, width, height, children, focused = true }: { title: string; width: number; height: number; children: React.ReactNode; focused?: boolean }) {
  const color = focused ? theme.accent : theme.muted;
  const label = clip(title, Math.max(0, width - 6));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={color}>
        {"╭─ "}
        <Text bold>{label}</Text>
        {` ${"─".repeat(Math.max(0, width - label.length - 5))}╮`}
      </Text>
      <Box flexDirection="column" borderStyle="round" borderTop={false} borderColor={color} height={height - 1} paddingX={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}

/** Keeps the cursor row inside a scrolling window of `size` rows. */
export function windowStart(cursor: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.min(Math.max(0, cursor - Math.floor(size / 2)), total - size);
}

export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export const padEnd = (text: string, width: number) => clip(text, width).padEnd(width);
