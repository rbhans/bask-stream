import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { BaskStreamClient, Json, Proposal } from "@basidekick/baskstream";
import { ago, fmtDuration, fmtTime, place, sparkline } from "../../format.js";
import { useKeys, type Rect } from "../input.js";
import type { Activity } from "../stores.js";
import { Badge, Panel, Table, clip, fit, theme, useCursor, useTick, useUi, type Column } from "../ui.js";

export const ACTIVITY_RANGES = [3600000, 86400000, 7 * 86400000, 30 * 86400000];

export const proposalActor = (p: Proposal) => {
  const name = p.actor?.name ?? p.agentUser;
  return p.actor?.onBehalfOf ? `${name} for ${p.actor.onBehalfOf}` : name;
};

/** A mark, a word and a colour for an activity entry's outcome. */
export function outcomeLook(a: Pick<Activity, "kind" | "source" | "outcome">): { mark: string; text: string; color: string } {
  if (a.source === "audit") return { mark: "·", text: a.kind.replace(/_/g, " ").toLowerCase(), color: theme.muted };
  const id = /\bP\d+\b/.exec(a.outcome ?? "")?.[0];
  switch (a.kind) {
    case "proposed": return { mark: "◷", text: `proposed${id ? ` ${id}` : ""}`, color: theme.warn };
    case "approved": return { mark: "✓", text: `approved${id ? ` ${id}` : ""}`, color: theme.good };
    case "rejected": return { mark: "✕", text: `rejected${id ? ` ${id}` : ""}`, color: theme.accent2 };
    case "expired": return { mark: "○", text: `expired${id ? ` ${id}` : ""}`, color: theme.muted };
    case "refused": return { mark: "✕", text: "refused", color: theme.bad };
    case "failed": return { mark: "✕", text: `failed${id ? ` ${id}` : ""}`, color: theme.bad };
    case "written": return { mark: "✓", text: "written", color: theme.good };
    default: return { mark: "✓", text: a.kind || "done", color: theme.good };
  }
}

export const whoOf = (a: Activity) => (a.kind === "approved" || a.kind === "rejected" ? a.user : a.agent ? a.agent : a.user);
export const whatOf = (a: Activity) =>
  a.source === "audit" ? [a.action, a.oldValue !== undefined || a.value !== undefined ? `${a.oldValue !== undefined ? `${a.oldValue} → ` : ""}${a.value ?? ""}` : ""].filter(Boolean).join(": ") : a.change ?? a.action;
const targetText = (target: string) => (/^slot:/.test(target) ? place(target) : target.replace(/^file:/, ""));

type Row = { key: string; proposal: Proposal } | { key: string; entry: Activity };
const FILTERS = ["everything", "changes", "proposals", "refusals"] as const;

export function ActivityView(props: {
  client: BaskStreamClient;
  active: boolean;
  rect: Rect;
  entries: Activity[];
  proposals: Map<string, Proposal>;
  loaded: boolean;
  error?: string;
  auditNote?: string;
  lastNewAt?: number;
  agentUsers: string[];
  rangeIndex: number;
  setRangeIndex: (index: number) => void;
  reload: () => void;
}) {
  const { client, active, rect, entries, proposals, loaded, error, auditNote, agentUsers, rangeIndex, setRangeIndex, reload } = props;
  const ui = useUi();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("everything");
  const [everyone, setEveryone] = useState(false);
  const [showAudit, setShowAudit] = useState(true);
  const [detailOpen, setDetailOpen] = useState(rect.height >= 26);
  useTick(5000, active);

  const range = ACTIVITY_RANGES[rangeIndex];
  const now = Date.now();
  const pending = useMemo(() => [...proposals.values()].filter((p) => p.status === "pending").sort((a, b) => a.createdAt - b.createdAt), [proposals]);
  const ai = useMemo(() => entries.filter((e) => e.source === "agent"), [entries]);

  const rows = useMemo<Row[]>(() => {
    const keep = (e: Activity) => {
      if (e.source === "audit" && (!showAudit || (!everyone && !e.ai))) return false;
      if (filter === "changes") return e.source === "audit" || ["approved", "written", "completed"].includes(e.kind);
      if (filter === "proposals") return ["proposed", "approved", "rejected", "expired", "failed"].includes(e.kind);
      if (filter === "refusals") return e.kind === "refused" || e.kind === "rejected" || e.kind === "failed";
      return true;
    };
    return [...(filter === "everything" || filter === "proposals" ? pending.map((proposal) => ({ key: `pending-${proposal.id}`, proposal })) : []), ...entries.filter(keep).map((entry) => ({ key: entry.key, entry }))];
  }, [entries, pending, filter, everyone, showAudit]);

  // Counts and an hour-by-hour (or day-by-day) picture of what agents did in the window.
  const stats = useMemo(() => {
    const count = (kind: string) => ai.filter((e) => e.kind === kind).length;
    const buckets = new Array<number>(Math.min(48, Math.max(24, rect.width - 60))).fill(0);
    for (const e of ai) {
      const slot = Math.floor(((e.at - (now - range)) / range) * buckets.length);
      if (slot >= 0 && slot < buckets.length) buckets[slot] += 1;
    }
    return { proposed: count("proposed"), approved: count("approved"), rejected: count("rejected"), expired: count("expired"), refused: count("refused"), direct: count("completed") + count("written"), buckets };
  }, [ai, range, rect.width]);

  const headHeight = 4;
  const wantDetail = detailOpen && rows.length > 0;
  const detailHeight = wantDetail ? Math.min(9, Math.max(6, Math.floor(rect.height * 0.3))) : 0;
  const listHeight = rect.height - headHeight - detailHeight;
  const notes = [error, auditNote].filter(Boolean) as string[];
  const size = Math.max(1, listHeight - 3 - notes.length);
  const list = useCursor(rows.length, size, { active, region: { x: rect.x + 2, y: rect.y + headHeight + 2 + notes.length, width: rect.width - 4, height: size }, onEnter: () => setDetailOpen((v) => !v) });
  const selected = rows[list.cursor];

  const proposalOf = (row: Row | undefined): Proposal | undefined => {
    if (!row) return undefined;
    if ("proposal" in row) return row.proposal;
    const id = /\bP\d+\b/.exec(row.entry.outcome ?? "")?.[0];
    return id ? proposals.get(id) : undefined;
  };
  const targetOf = (row: Row | undefined) => (!row ? undefined : "proposal" in row ? row.proposal.point : /^slot:/.test(row.entry.target) ? row.entry.target : undefined);

  const decide = (approve: boolean) => {
    const proposal = proposalOf(selected);
    if (!proposal) return ui.toast("Select a proposal that is waiting.", "info");
    if (proposal.status !== "pending") return ui.toast(`${proposal.id} is already ${proposal.status}.`, "info");
    if (approve && !ui.canWrite("approve proposals")) return;
    const what = `${proposal.id}: ${proposal.description} on ${place(proposal.point)}`;
    const send = (note?: string) =>
      void ui.attempt(approve ? "approve" : "reject", () => (approve ? client.approveProposal(proposal.id) : client.rejectProposal(proposal.id, note))).then((result) => {
        if (!result) return;
        if (result.status === "failed") ui.toast(`${proposal.id} failed: ${result.note ?? "the write was refused"}`, "bad");
        else ui.toast(`${proposal.id} ${result.status}`, result.status === "approved" ? "good" : "info");
        reload();
      });
    if (approve) ui.confirm(`Approve ${what}?`, () => send(), { title: "Approve the agent's change", lines: [`Why: ${proposal.reason ?? "(no reason given)"}`, `From ${proposalActor(proposal)}${proposal.actor?.model ? ` (${proposal.actor.model})` : ""}. It runs with your permissions.`] });
    else ui.prompt(`Reject ${proposal.id}: a note for the agent (optional)`, (note) => send(note.trim() || undefined), { hint: "enter with no text rejects without a note" });
  };

  useKeys(
    (input) => {
      if (input === "a") decide(true);
      else if (input === "x") decide(false);
      else if (input === "f") setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]);
      else if (input === "u") setEveryone((v) => !v);
      else if (input === "v") setShowAudit((v) => !v);
      else if (input === "[" || input === "-") setRangeIndex(Math.max(0, rangeIndex - 1));
      else if (input === "]" || input === "+" || input === "=") setRangeIndex(Math.min(ACTIVITY_RANGES.length - 1, rangeIndex + 1));
      else if (input === "r") {
        reload();
        ui.toast("Activity reloaded", "info");
      } else if (input === "e") {
        const target = targetOf(selected);
        if (target) ui.reveal(target);
        else ui.toast("This entry has no station component to show.", "info");
      } else if (input === "t" && targetOf(selected)) ui.openTrend(targetOf(selected)!);
      else if (input === "y" && selected) ui.copy("proposal" in selected ? selected.proposal.point : selected.entry.target, "target");
    },
    { isActive: active }
  );

  const rules = client.capabilities.agents as Json | undefined;
  const inner = rect.width - 4;
  const longTime = inner >= 120;
  const [timeWidth, whoWidth, outcomeWidth, whatWidth, targetWidth, reasonWidth] = fit(inner, [
    { min: longTime ? 14 : 5 },
    { min: inner >= 76 ? 13 : 0, flex: 1, max: 18 },
    { min: 14 },
    { min: 16, flex: 3, max: 34 },
    { min: 16, flex: 3, max: 34 },
    { min: inner >= 104 ? 20 : 0, flex: 8 }
  ]);
  const when = (at: number) => (longTime ? fmtTime(at).slice(5) : ago(at, now));
  const columns: Column<Row>[] = [
    { title: longTime ? "time" : "age", width: timeWidth, cell: (r) => ({ text: when("proposal" in r ? r.proposal.createdAt : r.entry.at), color: theme.muted }) },
    { title: "who", width: whoWidth, cell: (r) => ("proposal" in r ? { text: r.proposal.actor?.name ?? r.proposal.agentUser, color: theme.accent2 } : { text: whoOf(r.entry), color: r.entry.source === "audit" ? theme.muted : r.entry.kind === "approved" || r.entry.kind === "rejected" ? undefined : theme.accent2 }) },
    {
      title: "outcome", width: outcomeWidth,
      cell: (r) => {
        if ("proposal" in r) return { text: `◷ waiting ${r.proposal.id}`, color: theme.warn, bold: true };
        const look = outcomeLook(r.entry);
        return { text: `${look.mark} ${look.text}`, color: look.color, bold: r.entry.kind === "refused" };
      }
    },
    { title: "change", width: whatWidth, cell: (r) => ("proposal" in r ? { text: r.proposal.description, bold: true } : { text: whatOf(r.entry), color: r.entry.source === "audit" ? theme.muted : undefined }) },
    { title: "target", width: targetWidth, cell: (r) => ({ text: targetText("proposal" in r ? r.proposal.point : r.entry.target), color: theme.info }) },
    { title: "reason", width: reasonWidth, cell: (r) => ({ text: "proposal" in r ? r.proposal.reason ?? "" : r.entry.reason ?? (r.entry.code ? `[${r.entry.code}]` : ""), color: "proposal" in r ? undefined : theme.muted }) }
  ];

  const chip = (text: string, color: string) => (
    <Text key={text}>
      <Text color={color}>● </Text>
      <Text>{text}</Text>
      <Text color={theme.faint}>{"   "}</Text>
    </Text>
  );
  const scope = `${fmtDuration(range)} · ${filter}${everyone ? " · all users" : ""}${showAudit ? "" : " · audit hidden"}`;

  return (
    <Box flexDirection="column" height={rect.height}>
      <Panel title="AI agents" meta={agentUsers.length ? `users: ${agentUsers.join(", ")}` : undefined} width={rect.width} height={headHeight} focused={false}>
        {!rules ? (
          <Text color={theme.warn} wrap="truncate-end">This station's baskStream is older than API 1.8, which added agent controls and the agent log.</Text>
        ) : (
          <>
            <Text wrap="truncate-end">
              {chip(rules.approvalRequired ? "writes need approval" : "agents write directly", rules.approvalRequired ? theme.good : theme.warn)}
              {chip(rules.reasonRequired ? "reason required" : "reason optional", rules.reasonRequired ? theme.good : theme.warn)}
              {chip(rules.maxChangesPerMinute ? `${String(rules.maxChangesPerMinute)} changes / min` : "no rate limit", rules.maxChangesPerMinute ? theme.good : theme.warn)}
              {chip(rules.allowEmergency ? "emergency allowed" : "emergency blocked", rules.allowEmergency ? theme.warn : theme.good)}
              {chip(`${((rules.bounds as unknown[]) ?? []).length} value limit${((rules.bounds as unknown[]) ?? []).length === 1 ? "" : "s"}`, theme.info)}
            </Text>
            <Text wrap="truncate-end">
              <Text color={theme.accent2}>{sparkline(stats.buckets, stats.buckets.length)}</Text>
              <Text color={theme.muted}>{`  ${fmtDuration(range)}   `}</Text>
              {pending.length > 0 && <><Badge text={`${pending.length} waiting`} color={theme.warn} /><Text> </Text></>}
              <Text color={theme.good}>{stats.approved} approved</Text>
              <Text color={theme.muted}> · </Text>
              <Text>{stats.direct} direct</Text>
              <Text color={theme.muted}> · </Text>
              <Text color={stats.rejected ? theme.accent2 : theme.muted}>{stats.rejected} rejected</Text>
              <Text color={theme.muted}> · </Text>
              <Text color={stats.refused ? theme.bad : theme.muted}>{stats.refused} refused</Text>
              <Text color={theme.muted}> · {stats.expired} expired</Text>
            </Text>
          </>
        )}
      </Panel>
      <Panel title="Activity" meta={`${rows.length} · ${scope}`} metaColor={pending.length ? theme.warn : theme.muted} width={rect.width} height={listHeight}>
        {notes.map((note) => (
          <Text key={note} color={note === error ? theme.bad : theme.warn} wrap="truncate-end">{note}</Text>
        ))}
        {!loaded ? (
          <Text color={theme.muted}>Reading the audit history…</Text>
        ) : rows.length === 0 ? (
          <Text color={theme.muted} wrap="wrap">Nothing from AI agents in the last {fmtDuration(range)}{filter !== "everything" ? ` matching "${filter}"` : ""}. Press ] for a longer window.</Text>
        ) : (
          <Table columns={columns} rows={rows} start={list.start} size={size} cursor={list.cursor} rowKey={(r) => r.key} />
        )}
      </Panel>
      {wantDetail && selected && <Detail row={selected} proposal={proposalOf(selected)} width={rect.width} height={detailHeight} now={now} />}
    </Box>
  );
}

function Detail({ row, proposal, width, height, now }: { row: Row; proposal?: Proposal; width: number; height: number; now: number }) {
  const inner = width - 4;
  const label = (text: string) => <Text color={theme.muted}>{text.padEnd(8)}</Text>;
  if ("proposal" in row || (proposal && proposal.status === "pending")) {
    const p = proposal ?? ("proposal" in row ? row.proposal : undefined)!;
    return (
      <Panel title={`${p.id} · ${p.status}`} meta={p.status === "pending" ? `expires in ${ago(now - (p.expiresAt - now), now)}` : undefined} metaColor={theme.warn} width={width} height={height} focused={false} color={p.status === "pending" ? theme.warn : undefined}>
        <Text wrap="truncate-end">{label("change")}<Text bold>{p.description}</Text></Text>
        <Text wrap="truncate-end">{label("point")}<Text color={theme.info}>{clip(p.point, inner - 8)}</Text></Text>
        <Text wrap="truncate-end">{label("from")}<Text color={theme.accent2}>{proposalActor(p)}</Text><Text color={theme.muted}>{p.actor?.model ? ` · ${p.actor.model}` : ""} · Niagara user {p.agentUser} · {fmtTime(p.createdAt, false)}</Text></Text>
        <Box>
          {label("why")}
          <Box width={inner - 8} height={Math.max(1, height - 6)} overflow="hidden"><Text wrap="wrap">{p.reason ?? "(no reason given)"}</Text></Box>
        </Box>
        <Box flexGrow={1} />
        <Text color={theme.muted}><Text color={theme.good} bold>a</Text> approve   <Text color={theme.bad} bold>x</Text> reject   <Text color={theme.accent} bold>e</Text> show the point   <Text color={theme.accent} bold>t</Text> trend</Text>
      </Panel>
    );
  }
  const a = row.entry;
  const look = outcomeLook(a);
  return (
    <Panel title={`${look.text} · ${fmtTime(a.at)}`} width={width} height={height} focused={false}>
      <Text wrap="truncate-end">{label("change")}<Text bold>{clip(whatOf(a) || a.action, inner - 8)}</Text>{a.code ? <Text color={theme.bad}>{`  [${a.code}]`}</Text> : null}</Text>
      <Text wrap="truncate-end">{label("target")}<Text color={theme.info}>{clip(a.target, inner - 8)}</Text></Text>
      <Text wrap="truncate-end">
        {label("who")}
        {a.agent ? <Text color={theme.accent2}>{a.agent}{a.for ? ` for ${a.for}` : ""}</Text> : null}
        <Text color={theme.muted}>{a.agent ? " · " : ""}{a.model ? `${a.model} · ` : ""}Niagara user {a.user}{a.source === "audit" ? " · from the station's audit history" : ""}</Text>
      </Text>
      {a.source === "agent" ? (
        <Box>
          {label("why")}
          <Box width={inner - 8} height={Math.max(1, height - 5)} overflow="hidden"><Text wrap="wrap">{a.reason ?? "(no reason given)"}</Text></Box>
        </Box>
      ) : (
        <Text wrap="truncate-end">{label("value")}<Text>{clip(`${a.oldValue !== undefined ? `${a.oldValue} → ` : ""}${a.value ?? "—"}`, inner - 8)}</Text></Text>
      )}
    </Panel>
  );
}
