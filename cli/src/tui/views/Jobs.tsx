import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { randomUUID } from "node:crypto";
import type { BaskStreamClient, JobDetail, JobSummary, Json } from "@basidekick/baskstream";
import { ago, fmtTime, fmtValue, place } from "../../format.js";
import { useKeys, type Rect } from "../input.js";
import { Empty, Meter, Panel, Table, clip, fit, padEnd, padStart, theme, useCursor, useTick, useUi, type Column } from "../ui.js";

export const jobColor = (state: string) => (state === "success" ? theme.good : state === "failed" ? theme.bad : state === "running" || state === "canceling" ? theme.warn : theme.muted);
type Result = JobDetail["results"][number];
const valuesOf = (r: Result) => (r.values && typeof r.values === "object" ? r.values : {}) as Record<string, unknown>;

export function JobsView(props: {
  client: BaskStreamClient;
  active: boolean;
  rect: Rect;
  jobs: JobSummary[];
  loaded: boolean;
  error?: string;
  reload: () => Promise<void>;
  /** Where each discovery started this session was pointed, by job ORD. */
  targets: Map<string, string>;
  /** Select this job (n changes for each request). */
  focusJob?: { job: string; n: number };
  lastOrd?: string;
}) {
  const { client, active, rect, jobs, loaded, error, reload, targets, focusJob, lastOrd } = props;
  const ui = useUi();
  const [focus, setFocus] = useState<"jobs" | "results">("jobs");
  const [detail, setDetail] = useState<JobDetail>();
  const [picked, setPicked] = useState(new Set<string>());
  useTick(1000, active && jobs.some((j) => !j.complete));

  const wide = rect.width >= 100;
  const listWidth = wide ? Math.min(52, Math.max(42, Math.floor(rect.width * 0.36))) : rect.width;
  const listHeight = wide ? rect.height : Math.min(8, Math.max(5, Math.floor(rect.height * 0.3)));
  const listSize = Math.max(1, listHeight - 2);
  const list = useCursor(jobs.length, listSize, { active: active && focus === "jobs", region: { x: rect.x + 2, y: rect.y + 1, width: listWidth - 4, height: listSize }, onEnter: () => detail?.resultCount && setFocus("results") });
  const selected = jobs[list.cursor];

  useEffect(() => {
    if (!focusJob) return;
    const index = jobs.findIndex((j) => j.job === focusJob.job);
    if (index >= 0) list.setCursor(index);
  }, [focusJob?.n, jobs.length]);

  // The selected job's log and results; re-read each second until it finishes.
  const selectedOrd = selected?.job ?? undefined;
  const selectedDone = selected?.complete;
  useEffect(() => {
    if (!selectedOrd || !active) return;
    let cancelled = false;
    const read = () => client.job(selectedOrd, { limit: 1000 }).then((job) => !cancelled && setDetail(job), () => {});
    void read();
    const timer = selectedDone ? undefined : setInterval(read, 1000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [selectedOrd, selectedDone, active]);
  useEffect(() => {
    setPicked(new Set());
    setFocus("jobs");
  }, [selectedOrd]);

  const current = detail && detail.job === selectedOrd ? detail : undefined;
  const results = current?.results ?? [];
  const detailWidth = wide ? rect.width - listWidth : rect.width;
  const detailHeight = wide ? rect.height : rect.height - listHeight;
  const logHeight = Math.min(8, Math.max(4, Math.floor(detailHeight * 0.32)));
  const resultsHeight = detailHeight - logHeight;
  const resultsSize = Math.max(1, resultsHeight - 4);
  const detailX = wide ? rect.x + listWidth : rect.x;
  const detailY = wide ? rect.y : rect.y + listHeight;
  const rows = useCursor(results.length, resultsSize, {
    active: active && focus === "results",
    region: { x: detailX + 2, y: detailY + logHeight + 2, width: detailWidth - 4, height: resultsSize },
    onEnter: (index) => toggle(results[index]?.slot)
  });
  const toggle = (slot?: string) => {
    if (!slot) return;
    setPicked((set) => {
      const next = new Set(set);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  };

  const add = (slots: string[], parent?: string) => {
    if (!current?.job || slots.length === 0) return;
    if (slots.length > 100) return ui.toast(`${slots.length} selected; add up to 100 at a time.`, "warn");
    const where = parent ?? (current.discovery === "devices" ? targets.get(current.job) : undefined);
    if (current.discovery === "devices" && !where) {
      return ui.prompt("Add the devices under which network or folder?", (ord) => ord.trim() && add(slots, ord.trim()), { initial: lastOrd, hint: "ORD of the network" });
    }
    void ui.attempt("add", () => client.addDiscovered(current.job!, slots.map((slot) => ({ slot })), where ? { parent: where } : {})).then((plan) => {
      if (!plan) return;
      const items = (plan.items ?? []) as Json[];
      const lines = items.map((i) => `${padEnd(String(i.name), 26)} ${padEnd(String(i.typeSpec), 26)} ${i.facetsLearned === false ? "facets not learned" : ""}`);
      ui.confirm(`Add ${items.length} ${plan.discovery === "devices" ? `device${items.length === 1 ? "" : "s"}` : `point${items.length === 1 ? "" : "s"}`}${where ? ` under ${place(where)}` : ""}?`, async () => {
        const reply = await ui.attempt("apply", () => client.call("apply_model_changes", { planId: plan.planId, planHash: plan.planHash, idempotencyKey: randomUUID() }, { timeoutMs: 300000 }));
        const applied = reply?.result as Json | undefined;
        if (!applied) return;
        const failed = ((applied.results ?? []) as Json[]).filter((r) => r.ok === false);
        if (applied.state !== "applied" || failed.length) ui.toast(`The plan ended ${String(applied.state)}: ${failed.length} of ${items.length} failed${failed[0]?.message ? ` (${String(failed[0].message)})` : ""}`, "bad");
        else {
          ui.toast(`Added ${items.length}. Press 2 to see ${items.length === 1 ? "it" : "them"} in the Explorer.`, "good");
          setPicked(new Set());
        }
      }, { title: "Add to the station", lines });
    });
  };

  useKeys(
    (input, key) => {
      if (input === "r") void reload();
      else if (input === "d") ui.prompt("Discover on which BACnet network or device?", (ord) => ord.trim() && ui.discover(ord.trim()), { initial: lastOrd, hint: "ORD, e.g. slot:/Drivers/BacnetNetwork" });
      else if (input === "x" && selected?.job && !selected.complete) {
        if (!ui.canWrite("cancel jobs")) return;
        ui.confirm(`Cancel ${selected.display || selected.name}?`, () => void ui.attempt("cancel", () => client.cancelJob(selected.job!)).then((job) => job && (ui.toast(`${job.name} ${job.state}`, "info"), void reload())));
      } else if (focus === "jobs") {
        if ((key.rightArrow || input === "l") && results.length) setFocus("results");
      } else if (key.escape || key.leftArrow || input === "h") setFocus("jobs");
      else if (input === " ") toggle(results[rows.cursor]?.slot);
      else if (input === "A") setPicked((set) => (set.size === results.length ? new Set() : new Set(results.map((r) => r.slot))));
      else if (input === "a") {
        if (!ui.canWrite("add discovered items")) return;
        if (!current?.discovery) return ui.toast("Only discovery jobs have results that can be added.", "info");
        add(picked.size ? [...picked] : results[rows.cursor] ? [results[rows.cursor].slot] : []);
      }
    },
    { isActive: active }
  );

  const now = Date.now();
  const inner = detailWidth - 4;
  const [pickWidth, nameWidth, idWidth, noteWidth, valueWidth] = fit(inner, [{ min: 3 }, { min: 16, flex: 3, max: 34 }, { min: 14, flex: 1, max: 22 }, { min: inner >= 70 ? 14 : 0, flex: 4 }, { min: inner >= 90 ? 10 : 0, max: 14, flex: 1 }]);
  const columns: Column<Result>[] = [
    { title: "", width: pickWidth, cell: (r) => ({ text: picked.has(r.slot) ? "[✓]" : "[ ]", color: picked.has(r.slot) ? theme.good : theme.faint }) },
    { title: "name", width: nameWidth, cell: (r, i) => ({ text: String(valuesOf(r).objectName ?? valuesOf(r).deviceName ?? r.slot), bold: i === rows.cursor }) },
    { title: "id", width: idWidth, cell: (r) => ({ text: String(valuesOf(r).objectId ?? ""), color: theme.info }) },
    { title: "detail", width: noteWidth, cell: (r) => ({ text: String(valuesOf(r).description ?? valuesOf(r).modelName ?? valuesOf(r).address ?? ""), color: theme.muted }) },
    { title: "value", width: valueWidth, align: "right", cell: (r) => (valuesOf(r).value === undefined ? "" : fmtValue(valuesOf(r).value)) }
  ];

  if (error === "unsupported") {
    return (
      <Panel title="Jobs" width={rect.width} height={rect.height}>
        <Text color={theme.warn} wrap="wrap">Jobs and discovery need baskStream API 1.10 on the station (this one reports {String(client.capabilities.apiVersion ?? "an older version")}).</Text>
      </Panel>
    );
  }

  return (
    <Box height={rect.height} flexDirection={wide ? "row" : "column"}>
      <Panel title="Jobs" meta={jobs.length ? `${jobs.filter((j) => !j.complete).length} running · ${jobs.length} total` : undefined} width={listWidth} height={listHeight} focused={focus === "jobs"}>
        {error ? (
          <Text color={theme.bad} wrap="wrap">{error}</Text>
        ) : !loaded ? (
          <Text color={theme.muted}>Reading the job service…</Text>
        ) : jobs.length === 0 ? (
          <Empty title="No jobs on the station.">
            <Text color={theme.muted} wrap="wrap">Press <Text color={theme.accent} bold>d</Text> to discover BACnet devices or points, or select a network or device in the Explorer and press <Text color={theme.accent} bold>d</Text> there.</Text>
          </Empty>
        ) : (
          jobs.slice(list.start, list.start + listSize).map((job, i) => {
            const isSelected = list.start + i === list.cursor;
            const room = listWidth - 4;
            return (
              <Text key={job.job ?? job.name} backgroundColor={isSelected ? (focus === "jobs" ? theme.selection : theme.selectionDim) : undefined} wrap="truncate-end">
                <Text color={jobColor(job.state)}>{job.complete ? "● " : "◐ "}</Text>
                <Text bold={isSelected}>{padEnd(job.display || job.name, room - 2 - 14)} </Text>
                <Text color={jobColor(job.state)}>{padEnd(job.complete ? job.state : `${job.progress}%`, 9)}</Text>
                <Text color={theme.muted}>{padStart(job.startTime ? ago(job.startTime, now) : "", 4)}</Text>
              </Text>
            );
          })
        )}
      </Panel>
      <Box flexDirection="column" width={detailWidth} height={detailHeight}>
        <Panel title={selected ? `${selected.display || selected.name}` : "Job"} meta={selected ? `${selected.state}${selected.startTime ? ` · started ${fmtTime(selected.startTime, false)}` : ""}` : undefined} metaColor={selected ? jobColor(selected.state) : undefined} width={detailWidth} height={logHeight} focused={false}>
          {!selected ? null : !current ? (
            <Text color={theme.faint}>…</Text>
          ) : (
            <>
              {!current.complete && (
                <Text>
                  <Meter value={current.progress} max={100} width={Math.max(10, inner - 6)} color={theme.warn} /> <Text color={theme.muted}>{current.progress}%</Text>
                </Text>
              )}
              {current.log.slice(-(logHeight - 2 - (current.complete ? 0 : 1))).map((item, i) => (
                <Text key={i} wrap="truncate-end">
                  <Text color={theme.muted}>{item.timestamp ? `${fmtTime(item.timestamp, false)} ` : ""}</Text>
                  <Text color={/success/i.test(item.kind) ? theme.good : /fail|error/i.test(item.kind) ? theme.bad : /running/i.test(item.kind) ? theme.warn : theme.muted}>{padEnd(item.kind.toLowerCase(), 8)}</Text>
                  <Text>{clip(item.message, inner - 18)}</Text>
                </Text>
              ))}
            </>
          )}
        </Panel>
        <Panel title={current?.discovery ? `Found ${current.discovery}` : "Results"} meta={current ? `${current.resultCount}${picked.size ? ` · ${picked.size} selected` : ""}` : undefined} metaColor={picked.size ? theme.good : theme.muted} width={detailWidth} height={resultsHeight} focused={focus === "results"}>
          {!current ? null : results.length === 0 ? (
            <Text color={theme.muted}>{current.complete ? "This job left no results." : "Results appear when the job finishes."}</Text>
          ) : (
            <>
              <Table columns={columns} rows={results} start={rows.start} size={resultsSize} cursor={rows.cursor} rowKey={(r) => r.slot} focused={focus === "results"} />
              <Box flexGrow={1} />
              <Text color={theme.muted} wrap="truncate-end">{focus === "results" ? "space select · A all · a add to the station · esc back" : "→ to choose what to add"}</Text>
            </>
          )}
        </Panel>
      </Box>
    </Box>
  );
}
