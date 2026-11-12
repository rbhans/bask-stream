import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { toSlotOrd, type BaskStreamClient, type BrowseNode, type Json } from "@basidekick/baskstream";
import { quip } from "../quips.js";
import { nodeLook } from "./actions.js";
import { useKeys } from "./input.js";
import { Panel, TextInput, clip, clipStart, padEnd, theme, windowStart } from "./ui.js";

/** Station-wide search: type to find, enter shows it in the tree, tab watches a point, ctrl+t charts it. */
export function Finder(props: { client: BaskStreamClient; width: number; height: number; onClose: () => void; onReveal: (ord: string) => void; onWatch: (ord: string) => void; onTrend: (ord: string) => void }) {
  const { client, width, height, onClose, onReveal, onWatch, onTrend } = props;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BrowseNode[]>([]);
  const [state, setState] = useState<{ phase: "idle" | "searching" | "done" | "error"; note?: string; line?: string }>({ phase: "idle" });
  const [cursor, setCursor] = useState(0);
  const sequence = useRef(0);
  const maxDepth = useMemo(() => Number((client.capabilities.limits as Json | undefined)?.maxSearchDepth) || 32, [client]);

  useEffect(() => {
    const text = query.trim();
    const n = ++sequence.current;
    if (text.length < 2) {
      setResults([]);
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "searching", line: quip("searching") });
    // Wait for a pause in typing, and ignore replies to older queries.
    const timer = setTimeout(async () => {
      try {
        const reply = await client.search("slot:/", text, { depth: maxDepth, limit: 100 });
        if (n !== sequence.current) return;
        const result = (reply.result ?? {}) as Json;
        // Points first, then schedules, then everything else; the station's order within each.
        const rank = (node: BrowseNode) => (node.kind === "point" ? 0 : node.kind === "schedule" ? 1 : 2);
        const nodes = ((result.nodes ?? []) as BrowseNode[]).map((node, i) => ({ ...node, ord: toSlotOrd(node.ord), i }));
        setResults(nodes.sort((a, b) => rank(a) - rank(b) || a.i - b.i));
        setCursor(0);
        const reasons = (result.truncatedReasons ?? []) as string[];
        setState({ phase: "done", note: result.truncated ? `stopped early (${reasons.join(", ") || "limit"}); type more to narrow it` : undefined });
      } catch (error) {
        if (n === sequence.current) setState({ phase: "error", note: (error as Error).message });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useKeys((input, key) => {
    const selected = results[cursor];
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(results.length - 1, c + 1));
    else if (key.tab && selected?.kind === "point") onWatch(selected.ord);
    else if (key.ctrl && input === "t" && selected) onTrend(selected.ord);
  });

  const listHeight = Math.max(1, height - 6);
  const start = windowStart(cursor, results.length, listHeight);
  const inner = width - 4;
  const nameWidth = Math.min(36, Math.floor(inner * 0.4));

  return (
    <Panel title="Find" meta={state.phase === "done" ? `${results.length} found` : undefined} width={width} height={height}>
      <Box>
        <Text color={theme.accent} bold>›{" "}</Text>
        <TextInput width={inner - 2} placeholder="part of a name, e.g. zone temp or AHU_01" onChange={setQuery} onCancel={onClose} onSubmit={() => results[cursor] && onReveal(results[cursor].ord)} />
      </Box>
      <Text color={state.phase === "error" ? theme.bad : theme.muted} wrap="truncate-end">
        {state.phase === "searching" ? state.line : state.phase === "done" ? state.note ?? " " : state.phase === "error" ? state.note : " "}
      </Text>
      {results.slice(start, start + listHeight).map((node, i) => {
        const selected = start + i === cursor;
        const look = nodeLook(node);
        return (
          <Text key={node.ord} backgroundColor={selected ? theme.selection : undefined} wrap="truncate-end">
            <Text color={look.color}>{look.icon} </Text>
            <Text bold={selected}>{padEnd(node.display ?? node.name, nameWidth)}</Text>{" "}
            <Text color={theme.muted}>{clipStart(node.ord.replace(/^slot:\//, ""), inner - nameWidth - 4)}</Text>
          </Text>
        );
      })}
      {state.phase === "done" && results.length === 0 && <Text color={theme.muted}>{clip(`Nothing matching "${query.trim()}".`, inner)}</Text>}
      <Box flexGrow={1} />
      <Text color={theme.muted} wrap="truncate-end">↑↓ move · enter show in the Explorer · tab watch · ctrl+t trend · esc close</Text>
    </Panel>
  );
}
