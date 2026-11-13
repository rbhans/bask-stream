import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { useKeys } from "./input.js";
import { Panel, TextInput, clip, padEnd, theme, windowStart } from "./ui.js";

export interface Command {
  title: string;
  /** Group shown dimly at the right, e.g. "View" or "Report". */
  group: string;
  keys?: string;
  run: () => void;
}

/** How well `text` matches a command: lower is better, undefined is no match. Words may match in any order. */
function score(command: Command, text: string): number | undefined {
  const hay = `${command.title} ${command.group}`.toLowerCase();
  let total = 0;
  for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = hay.indexOf(word);
    if (at < 0) return undefined;
    total += at + (hay[at - 1] === undefined || hay[at - 1] === " " ? 0 : 20);
  }
  return total;
}

/** The command palette: every action in the dashboard, filtered as you type. A typed ORD offers to go there. */
export function Palette(props: { commands: Command[]; width: number; height: number; onClose: () => void; onGoto: (ord: string) => void }) {
  const { commands, width, height, onClose, onGoto } = props;
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(() => {
    const typed = text.trim();
    const found = commands.map((command, i) => ({ command, rank: typed ? score(command, typed) : i })).filter((m): m is { command: Command; rank: number } => m.rank !== undefined).sort((a, b) => a.rank - b.rank).map((m) => m.command);
    if (/^(slot:|\/)/.test(typed)) found.unshift({ title: `Go to ${typed}`, group: "Explorer", run: () => onGoto(typed.startsWith("/") ? `slot:${typed}` : typed) });
    return found;
  }, [text, commands]);
  const at = Math.min(cursor, Math.max(0, matches.length - 1));

  useKeys((_input, key) => {
    if (key.upArrow) setCursor(Math.max(0, at - 1));
    else if (key.downArrow) setCursor(Math.min(matches.length - 1, at + 1));
    else if (key.pageDown) setCursor(Math.min(matches.length - 1, at + 8));
    else if (key.pageUp) setCursor(Math.max(0, at - 8));
  });

  const boxWidth = Math.min(width, 84);
  const boxHeight = Math.min(height, 22);
  const size = Math.max(1, boxHeight - 5);
  const start = windowStart(at, matches.length, size);
  const inner = boxWidth - 4;

  return (
    <Box width={width} height={height} justifyContent="center">
      <Panel title="Commands" meta={`${matches.length}`} width={boxWidth} height={boxHeight}>
        <Box>
          <Text color={theme.accent} bold>›{" "}</Text>
          <TextInput
            width={inner - 2}
            placeholder="type a command, a view, a report or an ORD"
            onChange={(value) => {
              setText(value);
              setCursor(0);
            }}
            onCancel={onClose}
            onSubmit={() => {
              const command = matches[at];
              onClose();
              command?.run();
            }}
          />
        </Box>
        <Text color={theme.faint}>{"─".repeat(inner)}</Text>
        {matches.slice(start, start + size).map((command, i) => {
          const selected = start + i === at;
          return (
            <Text key={`${command.group}|${command.title}`} backgroundColor={selected ? theme.selection : undefined} wrap="truncate-end">
              <Text color={selected ? theme.accent : theme.faint}>{selected ? "› " : "  "}</Text>
              <Text bold={selected}>{padEnd(clip(command.title, inner - 26), inner - 26)}</Text>
              <Text color={theme.muted}>{padEnd(command.group, 14)}</Text>
              <Text color={theme.accent}>{(command.keys ?? "").padStart(8)}</Text>
            </Text>
          );
        })}
        {matches.length === 0 && <Text color={theme.muted}>No command matches.</Text>}
        <Box flexGrow={1} />
        <Text color={theme.muted}>↑↓ move · enter run · esc close</Text>
      </Panel>
    </Box>
  );
}
