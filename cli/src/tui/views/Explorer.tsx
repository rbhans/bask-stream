import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { toSlotOrd, type BaskStreamClient, type BrowseNode, type Json, type PointSnapshot } from "@basidekick/baskstream";
import { ago, fmtPoint, fmtTime, place, sparkline } from "../../format.js";
import { quip } from "../../quips.js";
import { commandPoint, nodeLook } from "../actions.js";
import { useKeys, type Rect } from "../input.js";
import { useLiveValues } from "../stores.js";
import { Field, Panel, Table, clip, clipStart, fit, padEnd, padStart, statusTone, theme, useCursor, useUi, type Column } from "../ui.js";

interface Row {
  node: BrowseNode;
  level: number;
  /** Placeholder under an opened node that returned no children. */
  empty?: boolean;
}

const parentOf = (ord: string): string => {
  const trimmed = ord.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= "slot:".length ? "slot:/" : trimmed.slice(0, index);
};

/** Niagara escapes characters in slot names as $xx; show them as typed. */
const unescape = (name: string) => name.replace(/\$([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const shortType = (type: unknown) => String(type ?? "").replace(/^baja:/, "");

/** The text shown for a slot's value in the property sheet. */
function slotText(slot: Json): string {
  if (slot.kind === "action") return slot.parameterType ? `(${shortType(slot.parameterType)})` : "()";
  const v = slot.value as Json | undefined;
  if (!v) return "";
  if (typeof v.encoded === "string") return v.encoded === "" ? "—" : v.encoded;
  if (v.expand) return "▸ open";
  const props = v.properties as Record<string, Json> | undefined;
  if (props) {
    if (props.value && typeof props.value.encoded === "string") return props.value.encoded;
    return Object.entries(props).map(([k, p]) => `${k}=${typeof p.encoded === "string" ? p.encoded : "…"}`).join("  ");
  }
  return "…";
}

export function ExplorerView(props: {
  client: BaskStreamClient;
  active: boolean;
  rect: Rect;
  watched: Set<string>;
  /** Open the tree down to this ORD and select it (n changes for each request). */
  reveal?: { ord: string; n: number };
  onSelect?: (ord: string) => void;
}) {
  const { client, active, rect, watched, reveal, onSelect } = props;
  const ui = useUi();
  const [nodes, setNodes] = useState(new Map<string, BrowseNode>());
  const [children, setChildren] = useState(new Map<string, string[]>());
  const [expanded, setExpanded] = useState(new Set<string>(["slot:/"]));
  const [loading, setLoading] = useState(new Set<string>());
  const [focus, setFocus] = useState<"tree" | "slots">("tree");
  const [detail, setDetail] = useState<{ ord: string; node?: BrowseNode; trend?: number[] }>();
  const [sheet, setSheet] = useState<{ ord: string; slots?: Json[]; error?: string; n: number }>();
  const [loadingLine] = useState(() => quip("browsing"));

  const load = async (ord: string) => {
    setLoading((s) => new Set(s).add(ord));
    const node = await ui.attempt(`browse ${place(ord)}`, () => client.browse(ord, { depth: 1 }));
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
      setFocus("tree");
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

  // Layout: tree and details side by side when there is room, stacked otherwise.
  const wide = rect.width >= 100;
  const treeWidth = wide ? Math.max(44, Math.min(74, Math.floor(rect.width * 0.47))) : rect.width;
  const detailWidth = wide ? rect.width - treeWidth : rect.width;
  const detailHeight = wide ? rect.height : Math.min(11, Math.max(7, Math.floor(rect.height * 0.4)));
  const sheetOnly = !wide && focus === "slots";
  const treeHeight = wide ? rect.height : rect.height - detailHeight;
  const listHeight = Math.max(1, treeHeight - 2);

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

  const treeActive = active && focus === "tree";
  const list = useCursor(rows.length, listHeight, {
    active: treeActive,
    region: sheetOnly ? undefined : { x: rect.x + 2, y: rect.y + 1, width: treeWidth - 4, height: listHeight },
    onEnter: (index) => {
      const row = rows[index];
      if (!row || row.empty) return;
      if (row.node.hasChildren && row.node.kind !== "point") toggle(row.node);
      else setFocus("slots");
    }
  });
  const selected = rows[list.cursor]?.empty ? undefined : rows[list.cursor]?.node;

  useEffect(() => {
    if (!pendingSelect) return;
    const index = rows.findIndex((row) => !row.empty && row.node.ord === pendingSelect);
    if (index >= 0) {
      list.setCursor(index);
      setPendingSelect(undefined);
      return;
    }
    const timer = setTimeout(() => {
      setPendingSelect(undefined);
      ui.toast("Couldn't show that one in the tree (a parent may be hidden from this user).", "warn");
    }, 3000);
    return () => clearTimeout(timer);
  }, [rows, pendingSelect]);

  useEffect(() => {
    if (selected) onSelect?.(selected.ord);
  }, [selected?.ord]);

  // Live values for the point rows on screen.
  const visible = rows.slice(list.start, list.start + listHeight);
  const visiblePoints = visible.filter((r) => !r.empty && r.node.kind === "point").map((r) => r.node.ord);
  const values = useLiveValues(client, "bask-explorer", visiblePoints, active);

  // Details for the selected node, fetched shortly after the cursor settles.
  useEffect(() => {
    if (!selected || !active) return;
    const ord = selected.ord;
    if (detail?.ord !== ord) setDetail({ ord });
    const timer = setTimeout(async () => {
      const node = await client.describe(ord, "full").catch(() => undefined);
      setDetail((d) => (d?.ord === ord ? { ...d, node } : d));
      const history = (node?.metadata as Json | undefined)?.history as Json | undefined;
      if (selected.kind !== "point" || !(history?.hasHistory || selected.features?.includes("history"))) return;
      const now = Date.now();
      const rollup = await client.historyRollup(ord, { start: now - 6 * 3600000, end: now, interval: 600000 }).catch(() => undefined);
      const buckets = ((((rollup?.histories ?? []) as Json[])[0]?.buckets ?? []) as Json[]).map((b) => Number(b.avg)).filter(Number.isFinite);
      setDetail((d) => (d?.ord === ord ? { ...d, trend: buckets } : d));
    }, 180);
    return () => clearTimeout(timer);
  }, [selected?.ord, active]);

  // The property sheet for the selected node, while it is open.
  const sheetOpen = focus === "slots";
  useEffect(() => {
    if (!selected || !sheetOpen) return;
    const ord = selected.ord;
    let cancelled = false;
    void client.call("describe_component", { ord }).then(
      (reply) => !cancelled && setSheet((s) => ({ ord, slots: ((reply.result as Json).slots as Json[]) ?? [], n: s?.n ?? 0 })),
      (error: Error) => !cancelled && setSheet((s) => ({ ord, error: error.message, n: s?.n ?? 0 }))
    );
    return () => {
      cancelled = true;
    };
  }, [selected?.ord, sheetOpen, sheet?.n]);

  const refreshParent = (ord: string) => {
    const parent = parentOf(ord);
    setChildren((map) => {
      const next = new Map(map);
      next.delete(parent);
      return next;
    });
    void load(parent);
  };

  useKeys(
    (input, key) => {
      if (!selected) return;
      const snapshot = values.get(selected.ord);
      if (key.rightArrow || input === "l") {
        if (selected.hasChildren && !expanded.has(selected.ord)) toggle(selected, true);
        else if (!selected.hasChildren) setFocus("slots");
      } else if (key.leftArrow || input === "h") {
        if (expanded.has(selected.ord) && selected.hasChildren) toggle(selected, false);
        else {
          const level = rows[list.cursor].level;
          for (let i = list.cursor - 1; i >= 0; i -= 1) if (rows[i].level < level) return list.setCursor(i);
        }
      } else if (input === "p") setFocus("slots");
      else if (input === "w" && selected.kind === "point") ui.watch(selected.ord);
      else if (input === "t") ui.openTrend(selected.ord);
      else if (input === "c") {
        if (selected.kind !== "point" || selected.writable === false) return ui.toast(`${selected.name} is not a writable point.`, "info");
        commandPoint(ui, client, selected.ord, snapshot);
      } else if (input === "y") ui.copy(selected.ord, "ORD");
      else if (input === "d") ui.discover(selected.ord);
      else if (input === "r") {
        setChildren((map) => {
          const next = new Map(map);
          next.delete(selected.ord);
          return next;
        });
        void load(expanded.has(selected.ord) ? selected.ord : parentOf(selected.ord));
      } else if (input === "R") {
        if (!ui.canWrite("rename components")) return;
        ui.prompt(`Rename ${selected.name} to`, (name) => {
          if (!name.trim() || name === selected.name) return;
          void ui.plan(`Rename ${selected.name}`, [{ action: "rename", ord: selected.ord, name: name.trim() }], [`${selected.ord} → ${name.trim()}`]).then((done) => done && refreshParent(selected.ord));
        }, { initial: selected.name });
      } else if (input === "D") {
        if (!ui.canWrite("delete components")) return;
        void ui.plan(`Delete ${selected.name}`, [{ action: "delete", ord: selected.ord, recursive: true }], [selected.ord, selected.hasChildren ? "Everything under it is deleted too." : ""].filter(Boolean)).then((done) => done && refreshParent(selected.ord));
      } else if (input === "n") {
        if (!ui.canWrite("add components")) return;
        const parent = selected.hasChildren || selected.kind === "container" ? selected.ord : parentOf(selected.ord);
        ui.prompt(`New component under ${place(parent)}: type`, (typeSpec) => {
          if (!typeSpec.trim()) return;
          ui.prompt(`Name for the new ${typeSpec.trim()}`, (name) => {
            if (!name.trim()) return;
            void ui.plan(`Add ${name.trim()}`, [{ action: "create", parent, name: name.trim(), typeSpec: typeSpec.trim() }], [`${typeSpec.trim()} under ${parent}`]).then((done) => {
              if (!done) return;
              setChildren((map) => {
                const next = new Map(map);
                next.delete(parent);
                return next;
              });
              setExpanded((s) => new Set(s).add(parent));
              void load(parent);
            });
          });
        }, { initial: "baja:Folder", hint: "e.g. baja:Folder, control:NumericWritable" });
      }
    },
    { isActive: treeActive }
  );

  const inner = treeWidth - 4;
  const valueWidth = inner >= 46 ? 13 : inner >= 34 ? 11 : 0;

  return (
    <Box height={rect.height} flexDirection={wide ? "row" : "column"}>
      {!sheetOnly && (
        <Panel title="Station" meta={rows.length ? `${list.cursor + 1}/${rows.length}` : undefined} width={treeWidth} height={treeHeight} focused={focus === "tree"}>
          {rows.length === 0 && <Text color={theme.muted}>{loading.size ? loadingLine : "Nothing here."}</Text>}
          {visible.map(({ node, level, empty }, i) => {
            const index = list.start + i;
            const isSelected = index === list.cursor;
            const background = isSelected ? (focus === "tree" ? theme.selection : theme.selectionDim) : undefined;
            if (empty) {
              return (
                <Text key={`${node.ord}#empty`} color={theme.faint} backgroundColor={background}>
                  {padEnd(`${"  ".repeat(level)}  (empty or not readable)`, inner)}
                </Text>
              );
            }
            const snapshot = node.kind === "point" ? values.get(node.ord) : undefined;
            const look = nodeLook({ ...node, status: snapshot?.status ?? node.status });
            const arrow = node.hasChildren ? (loading.has(node.ord) ? "◌" : expanded.has(node.ord) ? "▾" : "▸") : " ";
            const prefix = `${"  ".repeat(level)}${arrow} `;
            const mark = watched.has(node.ord) ? " ★" : "";
            const showValue = valueWidth > 0 && node.kind === "point";
            const nameWidth = inner - prefix.length - 2 - mark.length - (showValue ? valueWidth + 1 : 0);
            return (
              <Text key={node.ord} backgroundColor={background} wrap="truncate-end">
                <Text color={theme.muted}>{prefix}</Text>
                <Text color={look.color}>{look.icon} </Text>
                <Text bold={isSelected} color={node.kind === "point" || isSelected ? undefined : look.color}>
                  {clip(node.display ?? node.name, nameWidth)}
                </Text>
                <Text color={theme.warn}>{mark}</Text>
                <Text>{" ".repeat(Math.max(0, nameWidth - clip(node.display ?? node.name, nameWidth).length))}</Text>
                {showValue && (
                  <Text color={snapshot ? (snapshot.code ? theme.bad : snapshot.statusOk === false ? statusTone(snapshot.status) : undefined) : theme.faint} bold={!!snapshot}>
                    {" "}
                    {padStart(snapshot ? fmtPoint(snapshot) : "·", valueWidth)}
                  </Text>
                )}
              </Text>
            );
          })}
        </Panel>
      )}
      {focus === "slots" && selected ? (
        <Sheet
          client={client}
          node={selected}
          sheet={sheet?.ord === selected.ord ? sheet : undefined}
          active={active}
          rect={{ x: wide ? rect.x + treeWidth : rect.x, y: rect.y, width: detailWidth, height: sheetOnly ? rect.height : detailHeight }}
          onClose={() => setFocus("tree")}
          onChanged={() => setSheet((s) => (s ? { ...s, n: s.n + 1 } : s))}
          onOpenChild={(name) => ui.reveal(`${selected.ord}/${name}`)}
        />
      ) : (
        <Panel title="Details" width={detailWidth} height={detailHeight} focused={false}>
          {selected ? <Summary node={selected} described={detail?.ord === selected.ord ? detail.node : undefined} trend={detail?.ord === selected.ord ? detail.trend : undefined} snapshot={values.get(selected.ord)} width={detailWidth - 4} height={detailHeight - 2} /> : null}
        </Panel>
      )}
    </Box>
  );
}

function Summary({ node, described, trend, snapshot, width, height }: { node: BrowseNode; described?: BrowseNode; trend?: number[]; snapshot?: PointSnapshot; width: number; height: number }) {
  const meta = (described?.metadata ?? {}) as Json;
  const driver = meta.driver as Json | undefined;
  const point = meta.point as Json | undefined;
  const write = meta.write as Json | undefined;
  const history = ((meta.history as Json | undefined)?.histories as Json[] | undefined)?.[0];
  const tags = ((meta.tags ?? []) as Json[]).filter((t) => !String(t.id).startsWith("n:")).map((t) => (t.value && t.value !== "Marker" && String(t.value).length < 14 ? `${t.id}=${t.value}` : String(t.id)));
  const facets = (snapshot?.facets ?? point?.facets ?? {}) as Record<string, unknown>;
  const facetText = Object.entries(facets).filter(([, v]) => v !== undefined && v !== null && typeof v !== "object").map(([k, v]) => `${k} ${v}`).join(" · ");
  const dot = (status: unknown) => <Text color={statusTone(status)}>● </Text>;
  const lines: React.ReactNode[] = [];
  const push = (key: string, element: React.ReactNode) => lines.push(<React.Fragment key={key}>{element}</React.Fragment>);

  // With only a few rows (a stacked or small window) the value comes straight after the name.
  const compact = height < 9;
  const kindNote = node.kind === "point" ? <Text color={node.writable ? theme.warn : theme.muted}>{node.writable ? " · writable" : " · read-only"}</Text> : null;
  if (compact) {
    push("name", <Text wrap="truncate-end"><Text bold color={theme.accent}>{node.display ?? node.name}</Text><Text color={theme.muted}>{`  ${node.typeSpec ?? ""}`}</Text>{kindNote}</Text>);
  } else {
    push("name", <Text bold color={theme.accent} wrap="truncate-end">{node.display ?? node.name}</Text>);
    push("ord", <Text color={theme.muted} wrap="truncate-end">{clipStart(node.ord, width)}</Text>);
    push("type", <Text wrap="truncate-end"><Text color={theme.muted}>{node.typeSpec}</Text>{kindNote}</Text>);
    push("gap1", <Text> </Text>);
  }
  if (node.kind === "point") {
    push("value", (
      <Text wrap="truncate-end">
        <Text color={theme.muted}>{"value".padEnd(9)}</Text>
        {snapshot ? (
          <>
            <Text bold color={snapshot.code ? theme.bad : snapshot.statusOk === false ? statusTone(snapshot.status) : undefined}>{fmtPoint(snapshot)}</Text>
            <Text color={statusTone(snapshot.status)}>{`  ${snapshot.status ?? snapshot.message ?? ""}`}</Text>
          </>
        ) : <Text color={theme.faint}>reading…</Text>}
      </Text>
    ));
    if (trend && trend.length > 1) push("trend", <Text wrap="truncate-end"><Text color={theme.muted}>{"6 hours".padEnd(9)}</Text><Text color={theme.info}>{sparkline(trend, Math.min(trend.length, width - 10))}</Text></Text>);
    if (snapshot?.timestamp) push("updated", <Field label="updated" value={`${fmtTime(snapshot.timestamp, false)} (${ago(snapshot.timestamp)} ago)`} width={width} />);
    if (facetText) push("facets", <Field label="facets" value={facetText} width={width} />);
    if (write?.writable) push("level", <Field label="priority" value={`active level ${String(write.activeLevel ?? point?.activeLevel ?? "?")}`} width={width} />);
  } else if (node.status !== undefined) {
    push("status", <Text wrap="truncate-end"><Text color={theme.muted}>{"status".padEnd(9)}</Text>{dot(node.status)}<Text>{String(node.status)}</Text></Text>);
  }
  if (driver?.device && (driver.device as Json).ord !== node.ord) {
    const device = driver.device as Json;
    push("device", <Text wrap="truncate-end"><Text color={theme.muted}>{"device".padEnd(9)}</Text>{dot(device.status)}<Text>{clip(String(device.display ?? device.name), width - 20)}</Text><Text color={theme.muted}>{` ${String(device.status ?? "")}`}</Text></Text>);
  }
  if (driver?.network && (driver.network as Json).ord !== node.ord) {
    const network = driver.network as Json;
    push("network", <Text wrap="truncate-end"><Text color={theme.muted}>{"network".padEnd(9)}</Text>{dot(network.status)}<Text>{String(network.display ?? network.name)}</Text></Text>);
  }
  if (history) {
    const config = (history.config ?? {}) as Json;
    push("history", <Field label="history" value={[history.historyId, config.interval, config.capacity].filter(Boolean).join(" · ")} width={width} />);
  }
  if ((meta.alarm as Json | undefined)?.hasAlarm) push("alarm", <Field label="alarm" value="has an alarm extension" color={theme.warn} width={width} />);
  if (tags.length) push("tags", <Field label="tags" value={clip(tags.join("  "), width - 9)} color={theme.accent2} width={width} />);
  if (compact) push("ord", <Text color={theme.muted} wrap="truncate-end">{clipStart(node.ord, width)}</Text>);
  if (!described) push("loading", <Text color={theme.faint}>…</Text>);

  const hint = node.kind === "point" ? `w watch · t trend · ${node.writable === false ? "" : "c command · "}p properties` : "→ open · p properties · d discover · n new";
  const room = Math.max(1, compact ? height : height - 1);
  return (
    <Box flexDirection="column">
      {lines.slice(0, room)}
      {!compact && lines.length < room && <Text> </Text>}
      {!compact && lines.length + 1 < height && <Text color={theme.muted} wrap="truncate-end">{hint}</Text>}
    </Box>
  );
}

/** The property sheet: every slot of a component, with edits and action invokes through model plans. */
function Sheet(props: { client: BaskStreamClient; node: BrowseNode; sheet?: { slots?: Json[]; error?: string }; active: boolean; rect: Rect; onClose: () => void; onChanged: () => void; onOpenChild: (name: string) => void }) {
  const { node, sheet, active, rect, onClose, onChanged, onOpenChild } = props;
  const ui = useUi();
  const slots = useMemo(() => {
    const all = (sheet?.slots ?? []).filter((s) => !(Number(s.flags) & 4));
    return [...all.filter((s) => s.kind !== "action"), ...all.filter((s) => s.kind === "action")];
  }, [sheet?.slots]);
  const size = Math.max(1, rect.height - 4);

  const open = (index: number) => {
    const slot = slots[index];
    if (!slot) return;
    const name = String(slot.name);
    const value = slot.value as Json | undefined;
    if (slot.kind === "action") {
      if (!ui.canWrite("invoke actions")) return;
      const invoke = (parameter?: Json) =>
        void ui.plan(`Invoke ${unescape(name)}`, [{ action: "invoke", ord: node.ord, slot: name, ...(parameter ? { parameter } : {}), ...(Number(slot.flags) & 128 ? { confirm: true } : {}) }], [`${unescape(name)} on ${node.ord}${parameter ? ` with ${String(parameter.encoded)}` : ""}`]).then((done) => done && onChanged());
      if (!slot.parameterType) return invoke();
      const type = String(slot.parameterType);
      if (!/^baja:(Double|Float|Integer|Long|Boolean|String|RelTime|Ord)$/.test(type)) return ui.toast(`${unescape(name)} takes a ${type}; send it with bask call preview_model_changes.`, "info");
      const initial = String(((slot.parameterDefault as Json | undefined)?.encoded as string | undefined) ?? "");
      return ui.prompt(`${unescape(name)} (${shortType(type)})`, (text) => invoke({ typeSpec: type, encoded: text.trim() }), { initial });
    }
    if (value?.expand) return onOpenChild(name);
    if (!slot.writable || typeof value?.encoded !== "string") return ui.toast(`${unescape(name)} cannot be edited here${slot.writable ? " (structured value)" : " (read-only)"}.`, "info");
    if (!ui.canWrite("edit properties")) return;
    const apply = (encoded: string) => {
      if (encoded === value.encoded) return;
      void ui.plan(`Set ${unescape(name)}`, [{ action: "update", ord: node.ord, properties: { [name]: { encoded } } }], [`${node.ord}`, `${unescape(name)}: ${String(value.encoded) || "—"} → ${encoded || "—"}`]).then((done) => done && onChanged());
    };
    if (slot.typeSpec === "baja:Boolean") return ui.select(`${unescape(name)}`, [{ label: "true", value: "true" }, { label: "false", value: "false" }], apply);
    ui.prompt(`${unescape(name)} (${shortType(slot.typeSpec)})`, apply, { initial: String(value.encoded) });
  };

  const list = useCursor(slots.length, size, { active, region: { x: rect.x + 2, y: rect.y + 2, width: rect.width - 4, height: size }, onEnter: open });
  useKeys(
    (input, key) => {
      if (key.escape || key.leftArrow || input === "h" || input === "p") onClose();
      else if (input === "e") open(list.cursor);
      else if (input === "r") onChanged();
      else if (input === "y" && slots[list.cursor]) ui.copy(slotText(slots[list.cursor]), "value");
    },
    { isActive: active }
  );

  const [nameWidth, valueWidth, typeWidth] = fit(rect.width - 4, [{ min: 12, flex: 2, max: 26 }, { min: 14, flex: 5 }, { min: rect.width >= 70 ? 12 : 0, flex: 2, max: 24 }]);
  const columns: Column<Json>[] = [
    { title: "slot", width: nameWidth, cell: (s) => ({ text: `${s.kind === "action" ? "▶ " : s.dynamic ? "+ " : "  "}${unescape(String(s.name))}`, color: s.kind === "action" ? theme.accent2 : undefined }) },
    { title: "value", width: valueWidth, cell: (s) => ({ text: slotText(s), bold: s.kind !== "action" && !!s.writable, color: s.kind === "action" ? theme.muted : (s.value as Json | undefined)?.expand ? theme.accent : s.writable ? undefined : theme.muted }) },
    { title: "type", width: typeWidth, cell: (s) => ({ text: shortType(s.kind === "action" ? "action" : ((s.value as Json | undefined)?.typeSpec ?? s.typeSpec)), color: theme.muted }) }
  ];

  return (
    <Panel title={`Properties · ${node.display ?? node.name}`} meta={slots.length ? `${list.cursor + 1}/${slots.length}` : undefined} width={rect.width} height={rect.height}>
      {sheet?.error ? (
        <Text color={theme.bad} wrap="wrap">{sheet.error}</Text>
      ) : !sheet?.slots ? (
        <Text color={theme.muted}>Reading slots…</Text>
      ) : slots.length === 0 ? (
        <Text color={theme.muted}>No visible slots.</Text>
      ) : (
        <Table columns={columns} rows={slots} start={list.start} size={size} cursor={list.cursor} rowKey={(s) => String(s.name)} />
      )}
      <Box flexGrow={1} />
      <Text color={theme.muted} wrap="truncate-end">enter edit / invoke / open · y copy · r reread · esc back</Text>
    </Panel>
  );
}
