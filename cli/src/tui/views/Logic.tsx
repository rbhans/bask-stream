import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import { toSlotOrd, type BaskStreamClient } from "@basidekick/baskstream";
import { place } from "../../format.js";
import { drawSheet, loadSheet, planSheet, slotOrd, traceOf, traceText, valueRoom, type PlacedBlock, type Sheet } from "../../logic.js";
import { quip } from "../../quips.js";
import { commandPoint } from "../actions.js";
import { inside, useKeys, useMouse, type Rect } from "../input.js";
import { useLiveValues } from "../stores.js";
import { Art, useFrame } from "../symbols/Gallery.js";
import { Empty, Panel, clip, theme, useUi } from "../ui.js";

const parentOf = (ord: string) => (ord.lastIndexOf("/") <= "slot:".length ? "slot:/" : ord.slice(0, ord.lastIndexOf("/")));
/** The most slot values one sheet keeps live, under the station's subscriptions-per-client limit. */
const MAX_LIVE = 400;

interface Loaded {
  folder: string;
  sheet?: Sheet;
  error?: string;
}

/**
 * Logic: one folder of the station as a wire sheet. Its components are blocks with their slots'
 * live values, the links between them are drawn, and a slot can be followed to everything that
 * feeds it and everything it drives. It is read here, not drawn: an agent or Workbench builds it,
 * and the sheet follows as they do.
 */
export function LogicView(props: { client: BaskStreamClient; active: boolean; rect: Rect; show?: { ord: string; n: number } }) {
  const { client, active, rect } = props;
  const ui = useUi();
  const supported = Boolean(client.capabilities.modelEditing);
  const [folder, setFolder] = useState<string>();
  const [loaded, setLoaded] = useState<Loaded>();
  const [room, setRoom] = useState(0);
  const [picked, setPicked] = useState<{ ord: string; slot?: string }>();
  const [tracing, setTracing] = useState(false);
  const [loadingLine] = useState(() => quip("browsing"));
  const frame = useFrame(active && tracing);
  /** The block to land on after moving to another folder. */
  const landOn = useRef<string | undefined>(undefined);

  const go = (target: string, land?: string) => {
    landOn.current = land;
    setTracing(false);
    setFolder(target);
  };

  // Where to start: the folder asked for, else the first place that has something wired, looking
  // in a top-level Logic folder first. A station with neither opens at its root.
  useEffect(() => {
    if (!supported || !active || folder) return;
    let cancelled = false;
    void (async () => {
      let at = "slot:/";
      try {
        const root = await client.browse("slot:/", { depth: 1 });
        const logic = (root.children ?? []).find((child) => /^logic$/i.test(child.name));
        if (logic) {
          at = toSlotOrd(logic.ord);
          // A folder holding a single folder is only a step on the way.
          for (let depth = 0; depth < 4; depth += 1) {
            const children = (await client.browse(at, { depth: 1 })).children ?? [];
            if (children.length !== 1 || children[0].kind !== "container") break;
            at = toSlotOrd(children[0].ord);
          }
        }
      } catch {
        // The root is still a place to start.
      }
      if (!cancelled) setFolder((current) => current ?? at);
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, active, folder]);

  // Asked to show something: a folder opens as its own sheet, anything else as the sheet it sits on.
  useEffect(() => {
    if (!props.show) return;
    const ord = toSlotOrd(props.show.ord);
    let cancelled = false;
    void client.describe(ord, "none").then(
      (node) => !cancelled && (node.kind === "container" ? go(ord) : go(parentOf(ord), ord)),
      () => !cancelled && go(ord)
    );
    return () => {
      cancelled = true;
    };
  }, [props.show?.n]);

  const loading = useRef(false);
  const reload = useCallback(async (target: string) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const sheet = await loadSheet(client, target);
      setLoaded((old) => (old?.folder === target && old.sheet && JSON.stringify(old.sheet) === JSON.stringify(sheet) ? old : { folder: target, sheet }));
    } catch (error) {
      setLoaded((old) => (old?.folder === target && old.sheet ? old : { folder: target, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      loading.current = false;
    }
  }, [client]);

  // Read the folder, then keep reading it: at once when the station says its model changed, and
  // every few seconds anyway, since a link added between two blocks changes no list of names.
  useEffect(() => {
    if (!supported || !active || !folder) return;
    setRoom(0);
    void reload(folder);
    const timer = setInterval(() => void reload(folder), 4000);
    let soon: NodeJS.Timeout | undefined;
    const onModel = () => {
      clearTimeout(soon);
      soon = setTimeout(() => void reload(folder), 250);
    };
    client.on("model", onModel);
    void client.call("subscribe_model", { base: folder, depth: 2 }).catch(() => undefined);
    return () => {
      clearInterval(timer);
      clearTimeout(soon);
      client.off("model", onModel);
      void client.call("unsubscribe_model", { base: folder }).catch(() => undefined);
    };
  }, [supported, active, folder, reload]);

  const mine = loaded && loaded.folder === folder ? loaded : undefined;
  const sheet = mine?.sheet;
  const innerWidth = rect.width - 4;
  const artHeight = Math.max(1, rect.height - 2 - 3);
  const plan = useMemo(() => (sheet ? planSheet(sheet, { valueWidth: room, maxWidth: Math.max(60, innerWidth) }) : undefined), [sheet, room, innerWidth]);
  const values = useLiveValues(client, "logic", plan ? plan.points.slice(0, MAX_LIVE) : [], active && !!plan);
  const lookup = (ord: string) => values.get(ord);

  // A value longer than the room kept for it: lay the sheet out again with room for it.
  useEffect(() => {
    if (!plan) return;
    const needed = valueRoom(plan, lookup);
    if (needed > room) setRoom(needed);
  }, [plan, values]);

  // Keep the pick on something that is there: where it was, else what we came for, else the first block.
  const blocks = plan?.blocks ?? [];
  const current: PlacedBlock | undefined = blocks.find((p) => p.block.ord === picked?.ord);
  useEffect(() => {
    if (!plan || !sheet) return;
    const wanted = landOn.current ? blocks.find((p) => p.block.ord === landOn.current) : undefined;
    if (wanted) {
      landOn.current = undefined;
      return setPicked({ ord: wanted.block.ord, slot: wanted.block.slots[0] });
    }
    if (current && (!picked?.slot || current.block.slots.includes(picked.slot))) return;
    const first = [...blocks].filter((p) => !p.block.outside).sort((a, b) => a.y - b.y || a.x - b.x)[0] ?? blocks[0];
    setPicked(first ? { ord: first.block.ord, slot: first.block.slots[0] } : undefined);
  }, [plan]);

  const trace = useMemo(() => (tracing && sheet && picked?.slot ? traceOf(sheet, picked.ord, picked.slot) : undefined), [tracing, sheet, picked?.ord, picked?.slot]);

  // The part of the sheet that shows: all of it when it fits, else a window that follows the pick.
  const pan = useRef({ x: 0, y: 0 });
  if (plan) {
    const cx = current ? current.x + Math.floor(current.w / 2) : 0;
    const cy = current ? current.y + Math.floor(current.h / 2) : 0;
    pan.current = {
      x: plan.width <= innerWidth ? 0 : Math.min(Math.max(0, cx - Math.floor(innerWidth / 2)), plan.width - innerWidth),
      y: plan.height <= artHeight ? 0 : Math.min(Math.max(0, cy - Math.floor(artHeight / 2)), plan.height - artHeight)
    };
  }
  const left = plan ? Math.max(0, Math.floor((innerWidth - plan.width) / 2)) : 0;
  const top = plan ? Math.max(0, Math.floor((artHeight - plan.height) / 2)) : 0;

  /** The nearest block in a direction from the picked one, weighing the sideways distance double. */
  const toward = (dx: number, dy: number): PlacedBlock | undefined => {
    if (!current) return blocks[0];
    const cx = current.x + current.w / 2;
    const cy = current.y + current.h / 2;
    let best: PlacedBlock | undefined;
    let bestCost = Infinity;
    for (const p of blocks) {
      if (p === current) continue;
      const ox = p.x + p.w / 2 - cx;
      const oy = p.y + p.h / 2 - cy;
      const ahead = dx ? ox * dx : oy * dy;
      if (ahead <= 0) continue;
      const cost = dx ? ahead + Math.abs(oy) * 4 : ahead * 2 + Math.abs(ox);
      if (cost < bestCost) {
        best = p;
        bestCost = cost;
      }
    }
    return best;
  };

  useKeys(
    (input, key) => {
      if (!folder) return;
      if (input === "u" || key.backspace || key.delete) {
        if (folder !== "slot:/") go(parentOf(folder), folder);
        return;
      }
      if (input === "r") return void reload(folder);
      if (!current || !picked) return;
      const { block } = current;
      const at = picked.slot ? block.slots.indexOf(picked.slot) : -1;
      const ord = picked.slot ? slotOrd(block.ord, picked.slot) : block.ord;
      if (key.leftArrow || key.rightArrow) {
        const next = toward(key.rightArrow ? 1 : -1, 0);
        if (next) setPicked({ ord: next.block.ord, slot: next.block.slots[0] });
      } else if (key.downArrow || input === "j") {
        if (at >= 0 && at < block.slots.length - 1) return setPicked({ ord: block.ord, slot: block.slots[at + 1] });
        const next = toward(0, 1);
        if (next) setPicked({ ord: next.block.ord, slot: next.block.slots[0] });
      } else if (key.upArrow || input === "k") {
        if (at > 0) return setPicked({ ord: block.ord, slot: block.slots[at - 1] });
        const next = toward(0, -1);
        if (next) setPicked({ ord: next.block.ord, slot: next.block.slots[next.block.slots.length - 1] });
      } else if (key.return) {
        if (block.container) go(block.ord);
        else if (block.outside) go(parentOf(block.ord), block.ord);
        else setTracing((on) => !on);
      } else if (key.escape) setTracing(false);
      else if (input === "e") ui.reveal(block.ord);
      else if (input === "y") ui.copy(ord, "ORD");
      else if (input === "w" && !block.container) ui.watch(block.point && picked.slot === "out" ? block.ord : ord);
      else if (input === "t") {
        if (block.point) ui.openTrend(block.ord);
        else ui.toast(`${block.name} is not a point, so it keeps no history to chart.`, "info");
      } else if (input === "c") {
        if (!block.point || !block.writable) return ui.toast(`${block.name} is not a writable point.`, "info");
        commandPoint(ui, client, block.ord, values.get(slotOrd(block.ord, "out")));
      }
    },
    { isActive: active && supported }
  );

  // A click picks the slot under it.
  useMouse((e) => {
    if (e.kind !== "down" || !inside(e, rect) || !plan) return;
    const x = e.x - (rect.x + 2) - left + pan.current.x;
    const y = e.y - (rect.y + 1) - top + pan.current.y;
    const hit = blocks.find((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
    if (hit) setPicked({ ord: hit.block.ord, slot: hit.block.slots[Math.min(hit.block.slots.length - 1, Math.max(0, y - hit.y - 1))] });
  }, active && supported);

  if (!supported) {
    return (
      <Panel title="Logic" width={rect.width} height={rect.height}>
        <Text color={theme.warn} wrap="wrap">A wire sheet is read through model editing, which needs baskStream API 1.6 on the station (this one reports {String(client.capabilities.apiVersion ?? "an older version")}).</Text>
      </Panel>
    );
  }

  const inFolder = sheet ? sheet.blocks.filter((b) => !b.outside).length : 0;
  const undrawn = plan ? plan.routes.filter((route) => !route).length : 0;
  const meta = !sheet ? undefined : `${inFolder} block${inFolder === 1 ? "" : "s"} · ${sheet.links.length} link${sheet.links.length === 1 ? "" : "s"}${sheet.hidden ? ` · ${sheet.hidden} more not shown` : ""}${undrawn ? ` · ${undrawn} not drawn` : ""}${tracing ? " · tracing" : ""}`;
  const rows = plan ? drawSheet(plan, lookup, frame, { picked, trace }).render() : [];
  const shown = rows.slice(pan.current.y, pan.current.y + artHeight).map((runs) => cut(runs, pan.current.x, innerWidth));

  return (
    <Panel title={`Logic · ${folder ? (folder === "slot:/" ? "station" : place(folder, 3)) : ""}`} meta={meta} width={rect.width} height={rect.height} focused>
      {mine?.error ? (
        <Text color={theme.bad} wrap="wrap">{mine.error}</Text>
      ) : !sheet || !plan ? (
        <Text color={theme.muted}>{loadingLine}</Text>
      ) : sheet.blocks.length === 0 ? (
        <Empty title="Nothing in this folder.">
          <Text color={theme.muted} wrap="wrap">Logic an agent or Workbench builds here shows as blocks joined by their links, with live values. Press u to go up, or open another folder from the Explorer with L.</Text>
        </Empty>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="column" height={artHeight} paddingTop={top} paddingLeft={left}>
            <Art rows={shown} />
          </Box>
          <Text color={theme.faint}>{"─".repeat(Math.max(0, innerWidth))}</Text>
          {footer(sheet, current, picked?.slot, trace ? traceText(sheet, trace, lookup, innerWidth) : undefined, lookup, innerWidth)}
        </Box>
      )}
    </Panel>
  );
}

/** One row of the drawing from a column on, `width` cells of it. */
function cut(runs: ReturnType<ReturnType<typeof drawSheet>["render"]>[number], from: number, width: number) {
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

/** Two lines under the sheet: what is picked and where it is, then the trace, or what the picked slot is wired to. */
function footer(sheet: Sheet, current: PlacedBlock | undefined, slot: string | undefined, trace: string | undefined, values: (ord: string) => { displayValue?: string; ok?: boolean } | undefined, width: number): React.ReactNode {
  if (!current) return <Text color={theme.muted}>Nothing picked.</Text>;
  const { block } = current;
  const names = new Map(sheet.blocks.map((b) => [b.ord, b.name]));
  const value = slot ? values(slotOrd(block.ord, slot)) : undefined;
  const feeding = slot ? sheet.links.filter((l) => l.target === block.ord && l.targetSlot === slot).map((l) => `${names.get(l.source) ?? place(l.source)}.${l.sourceSlot}`) : [];
  const driving = slot ? sheet.links.filter((l) => l.source === block.ord && l.sourceSlot === slot).map((l) => `${names.get(l.target) ?? place(l.target)}.${l.targetSlot}`) : [];
  const wiring = block.container ? "⏎ opens it" : block.outside ? "in another folder · ⏎ goes there" : [feeding.length ? `← ${feeding.join(", ")}` : "", driving.length ? `→ ${driving.join(", ")}` : ""].filter(Boolean).join("   ") || "not linked";
  // What is set on the block rather than wired to it, after the wiring.
  const set = block.settings.map((item) => `${item.name} ${item.value}`).join(" · ");
  const second = trace ?? (set ? `${wiring}   ·   ${set}` : wiring);
  const head = `${block.name}${slot ? `.${slot}` : ""}`;
  const reading = value?.ok && value.displayValue ? ` ${value.displayValue}` : "";
  return (
    <>
      <Text wrap="truncate-end">
        <Text bold>{head}</Text>
        <Text color={theme.info}>{reading}</Text>
        <Text color={theme.muted}>{clip(`   ${block.typeSpec || "elsewhere"} · ${block.ord}`, Math.max(0, width - head.length - reading.length))}</Text>
      </Text>
      <Text wrap="truncate-end" color={trace ? theme.accent : theme.muted}>{clip(second, width)}</Text>
    </>
  );
}
