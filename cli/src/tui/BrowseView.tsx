import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { toSlotOrd, type BaskStreamClient, type BrowseNode, type Json, type PointSnapshot } from "@basidekick/baskstream";
import { ago, fmtPoint, fmtTime, fmtValue } from "../format.js";
import { quip } from "../quips.js";
import { Panel, clip, padEnd, statusTone, theme, useUi, windowStart } from "./ui.js";

interface Row {
  node: BrowseNode;
  level: number;
  /** Placeholder under an opened node that returned no children. */
  empty?: boolean;
}

const ICON: Record<string, string> = { point: "◉", schedule: "◷", container: "▣", component: "◇" };
const KIND_COLOR: Record<string, string> = { point: theme.info, schedule: theme.accent2, container: theme.accent, component: "white" };

export function BrowseView(props: {
  client: BaskStreamClient;
  active: boolean;
  width: number;
  height: number;
  watched: Set<string>;
  onWatch: (ord: string) => void;
  /** Open the tree down to this ORD and select it (n changes for each request). */
  reveal?: { ord: string; n: number };
}) {
  const { client, active, width, height, watched, onWatch, reveal } = props;
  const ui = useUi();
  const [nodes, setNodes] = useState(new Map<string, BrowseNode>());
  const [children, setChildren] = useState(new Map<string, string[]>());
  const [expanded, setExpanded] = useState(new Set<string>(["slot:/"]));
  const [loading, setLoading] = useState(new Set<string>());
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<{ ord: string; snapshot?: PointSnapshot; schedule?: Json }>();

  const load = async (ord: string) => {
    setLoading((s) => new Set(s).add(ord));
    const node = await ui.attempt(`browse ${ord}`, () => client.browse(ord, { depth: 1 }));
    setLoading((s) => {
      const next = new Set(s);
      next.delete(ord);
      return next;
    });
    if (!node) return;
    const kids = (node.children ?? []).map((c) => ({ ...c, ord: toSlotOrd(c.ord) }));
    setNodes((map) => {
      const next = new Map(map);
      for (const child of kids) next.set(child.ord, child);
      return next;
    });
    setChildren((map) => new Map(map).set(ord, kids.map((c) => c.ord)));
  };

  useEffect(() => void load("slot:/"), []);

  const childrenRef = useRef(children);
  childrenRef.current = children;
  const [pendingSelect, setPendingSelect] = useState<string>();

  // Load and open each parent folder of a revealed ORD, then select it once its row exists.
  useEffect(() => {
    if (!reveal) return;
    let cancelled = false;
    void (async () => {
      const parts = reveal.ord.replace(/^slot:\//, "").split("/").filter(Boolean);
      const ancestors = parts.slice(0, -1).map((_, i) => `slot:/${parts.slice(0, i + 1).join("/")}`);
      for (const ord of ["slot:/", ...ancestors]) {
        if (cancelled) return;
        if (!childrenRef.current.has(ord)) await load(ord);
      }
      if (cancelled) return;
      setExpanded((set) => new Set([...set, ...ancestors]));
      setPendingSelect(reveal.ord);
    })();
    return () => {
      cancelled = true;
    };
  }, [reveal?.n]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (ord: string, level: number) => {
      for (const child of children.get(ord) ?? []) {
        const node = nodes.get(child);
        if (!node) continue;
        out.push({ node, level });
        if (expanded.has(child)) {
          walk(child, level + 1);
          if (children.get(child)?.length === 0) out.push({ node, level: level + 1, empty: true });
        }
      }
    };
    walk("slot:/", 0);
    return out;
  }, [nodes, children, expanded]);

  useEffect(() => {
    if (!pendingSelect) return;
    const index = rows.findIndex((row) => !row.empty && row.node.ord === pendingSelect);
    if (index >= 0) {
      setCursor(index);
      setPendingSelect(undefined);
      return;
    }
    const timer = setTimeout(() => {
      setPendingSelect(undefined);
      ui.toast("Couldn't show that one in the tree (a parent may be hidden from this user).", "warn");
    }, 3000);
    return () => clearTimeout(timer);
  }, [rows, pendingSelect]);

  const selected = rows[Math.min(cursor, rows.length - 1)]?.node;

  // Live detail for the selected point or schedule, fetched shortly after the cursor settles.
  useEffect(() => {
    if (!selected || !active) return;
    const ord = selected.ord;
    setDetail({ ord });
    const timer = setTimeout(async () => {
      if (selected.kind === "point") {
        const [snapshot] = (await client.read([ord]).catch(() => [])) as PointSnapshot[];
        setDetail((d) => (d?.ord === ord ? { ord, snapshot } : d));
      } else if (selected.kind === "schedule") {
        const schedule = await client.schedule(ord).catch(() => undefined);
        setDetail((d) => (d?.ord === ord ? { ord, schedule } : d));
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [selected?.ord, active]);

  const toggle = (node: BrowseNode, open?: boolean) => {
    const isOpen = expanded.has(node.ord);
    const want = open ?? !isOpen;
    if (want === isOpen || !node.hasChildren) return;
    setExpanded((s) => {
      const next = new Set(s);
      if (want) next.add(node.ord);
      else next.delete(node.ord);
      return next;
    });
    if (want && !children.has(node.ord)) void load(node.ord);
  };

  const listHeight = height - 3;
  useInput(
    (input, key) => {
      if (!selected) return;
      if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j") setCursor((c) => Math.min(rows.length - 1, c + 1));
      else if (key.pageUp) setCursor((c) => Math.max(0, c - listHeight));
      else if (key.pageDown) setCursor((c) => Math.min(rows.length - 1, c + listHeight));
      else if (key.rightArrow || input === "l" || key.return) toggle(selected, true);
      else if (key.leftArrow || input === "h") {
        if (expanded.has(selected.ord) && selected.hasChildren) toggle(selected, false);
        else {
          const level = rows[cursor].level;
          for (let i = cursor - 1; i >= 0; i -= 1) if (rows[i].level < level) return setCursor(i);
        }
      } else if (input === "w" && selected.kind === "point") onWatch(selected.ord);
      else if (input === "H" || input === "t") ui.openHistory(selected.ord);
      else if (input === "r") {
        setChildren((map) => {
          const next = new Map(map);
          next.delete(selected.ord);
          return next;
        });
        void load(expanded.has(selected.ord) ? selected.ord : parentOf(selected.ord));
      }
    },
    { isActive: active }
  );

  const treeWidth = Math.max(30, Math.floor(width * 0.58));
  const start = windowStart(cursor, rows.length, listHeight);
  const visible = rows.slice(start, start + listHeight);
  const inner = treeWidth - 4;

  return (
    <Box height={height}>
      <Panel title={`Station  ${rows.length ? `${cursor + 1}/${rows.length}` : ""}`} width={treeWidth} height={height}>
        {rows.length === 0 && <Text color={theme.muted}>{loading.size ? quip("browsing") : "Nothing here."}</Text>}
        {visible.map(({ node, level, empty }, i) => {
          const index = start + i;
          const isSelected = index === cursor;
          if (empty) {
            return (
              <Text key={`${node.ord}#empty`} color={theme.muted} backgroundColor={isSelected ? theme.selection : undefined}>
                {padEnd(`${"  ".repeat(level)}  (empty or not readable)`, inner)}
              </Text>
            );
          }
          const kind = node.kind ?? "component";
          const arrow = node.hasChildren ? (loading.has(node.ord) ? "◌" : expanded.has(node.ord) ? "▾" : "▸") : " ";
          const label = `${"  ".repeat(level)}${arrow} ${ICON[kind] ?? "·"} ${node.display ?? node.name}`;
          const mark = watched.has(node.ord) ? " ★" : "";
          return (
            <Text key={node.ord} backgroundColor={isSelected ? theme.selection : undefined} wrap="truncate-end">
              <Text color={KIND_COLOR[kind]} bold={isSelected}>
                {padEnd(label, inner - mark.length)}
              </Text>
              <Text color={theme.warn}>{mark}</Text>
            </Text>
          );
        })}
      </Panel>
      <Panel title="Details" width={width - treeWidth} height={height} focused={false}>
        {selected ? <Details node={selected} detail={detail?.ord === selected.ord ? detail : undefined} width={width - treeWidth - 4} /> : null}
      </Panel>
    </Box>
  );
}

function Details({ node, detail, width }: { node: BrowseNode; detail?: { snapshot?: PointSnapshot; schedule?: Json }; width: number }) {
  const line = (label: string, value: unknown, color?: string) => (
    <Text wrap="truncate-end">
      <Text color={theme.muted}>{label.padEnd(9)}</Text>
      <Text color={color}>{clip(fmtValue(value), width - 10)}</Text>
    </Text>
  );
  const s = detail?.snapshot;
  const sched = detail?.schedule;
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent} wrap="truncate-end">
        {node.display ?? node.name}
      </Text>
      <Text color={theme.muted} wrap="truncate-end">
        {node.ord}
      </Text>
      <Text> </Text>
      {line("type", node.typeSpec)}
      {line("kind", node.kind, KIND_COLOR[node.kind ?? "component"])}
      {node.status !== undefined && line("status", node.status, statusTone(node.status))}
      {node.writable !== undefined && line("writable", node.writable ? "yes" : "no")}
      {node.features?.length ? line("features", node.features.join(", ")) : null}
      {s && (
        <>
          <Text> </Text>
          <Text>
            <Text color={theme.muted}>{"value".padEnd(9)}</Text>
            <Text bold color={s.code ? theme.bad : s.ok === false ? statusTone(s.status) : "white"}>
              {fmtPoint(s)}
            </Text>
          </Text>
          {line("status", s.status ?? s.message, statusTone(s.status))}
          {line("updated", `${fmtTime(s.timestamp)} (${ago(s.timestamp)} ago)`)}
        </>
      )}
      {sched && (
        <>
          <Text> </Text>
          {line("output", sched.currentOutput ?? sched.effectiveValue)}
          {line("next", fmtTime(sched.nextEvent))}
        </>
      )}
      <Text> </Text>
      <Text color={theme.muted}>
        {node.kind === "point" ? "w watch · t trend · " : "t trend · "}→ open · r refresh
      </Text>
    </Box>
  );
}

function parentOf(ord: string): string {
  const trimmed = ord.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= "slot:".length ? "slot:/" : trimmed.slice(0, index);
}
