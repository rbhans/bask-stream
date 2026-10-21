import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BaskStreamClient, Proposal } from "@basidekick/baskstream";
import { ago, fmtTime, shortOrd } from "../format.js";
import { Panel, clip, padEnd, theme, useUi, windowStart } from "./ui.js";

const STATUS_COLOR: Record<string, string> = {
  pending: theme.warn,
  deciding: theme.info,
  approved: theme.good,
  rejected: theme.muted,
  expired: theme.muted,
  failed: theme.bad
};

export const proposalActor = (p: Proposal) => {
  const name = p.actor?.name ?? p.agentUser;
  return p.actor?.onBehalfOf ? `${name} for ${p.actor.onBehalfOf}` : name;
};

/** Agent proposals: pending first, then recently decided. A person approves or rejects them here. */
export function ProposalsView(props: { client: BaskStreamClient; active: boolean; width: number; height: number; proposals: Map<string, Proposal>; error?: string }) {
  const { client, active, width, height, proposals, error } = props;
  const ui = useUi();
  const [cursor, setCursor] = useState(0);
  const [, tick] = useState(0);

  // Keep "expires in" current.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [active]);

  const list = useMemo(
    () =>
      [...proposals.values()].sort(
        (a, b) => Number(b.status === "pending") - Number(a.status === "pending") || (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt)
      ),
    [proposals]
  );
  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, list.length - 1))), [list.length]);
  const selected = list[cursor];

  const decide = (approve: boolean) => {
    if (!selected) return;
    if (selected.status !== "pending") return ui.toast(`${selected.id} is already ${selected.status}.`, "info");
    if (approve && !ui.allowWrites) return ui.toast("Read-only. Start bask with --allow-writes to approve proposals.", "warn");
    const what = `${selected.id}: ${selected.description} on ${shortOrd(selected.point, 3)}`;
    ui.confirm(`${approve ? "Approve" : "Reject"} ${what}?${approve ? " It runs with your permissions." : ""}`, async () => {
      const result = await ui.attempt(approve ? "approve" : "reject", () => (approve ? client.approveProposal(selected.id) : client.rejectProposal(selected.id)));
      if (!result) return;
      if (result.status === "failed") ui.toast(`${selected.id} failed: ${result.note ?? "the write was refused"}`, "bad");
      else ui.toast(`${selected.id} ${result.status}`, result.status === "approved" ? "good" : "info");
    });
  };

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j") setCursor((c) => Math.min(list.length - 1, c + 1));
      else if (input === "a") decide(true);
      else if (input === "x") decide(false);
    },
    { isActive: active }
  );

  const pending = list.filter((p) => p.status === "pending").length;
  const detailHeight = selected ? 6 : 0;
  const listHeight = height - 4 - detailHeight;
  const start = windowStart(cursor, list.length, listHeight);
  const inner = width - 4;
  const changeWidth = Math.max(14, Math.floor(inner * 0.24));
  const pointWidth = Math.max(16, Math.floor(inner * 0.26));
  const agentWidth = Math.max(12, Math.floor(inner * 0.18));
  const now = Date.now();

  const when = (p: Proposal) =>
    p.status === "pending" ? `in ${ago(now - (p.expiresAt - now), now)}` : p.decidedAt ? `${ago(p.decidedAt, now)} ago` : "";

  return (
    <Box flexDirection="column" height={height}>
      <Panel title={`Agent proposals${pending ? ` · ${pending} waiting` : ""}`} width={width} height={height - detailHeight}>
        {error && <Text color={theme.bad}>{error}</Text>}
        {list.length === 0 && !error ? (
          <Box flexDirection="column">
            <Text color={theme.good}>✓ Nothing waiting.</Text>
            <Text color={theme.muted}>When an AI agent proposes a point write, it shows up here for a person to approve. See docs/AI_AGENTS.md.</Text>
          </Box>
        ) : (
          <Text color={theme.muted}>
            {padEnd("id", 5)} {padEnd("status", 9)} {padEnd("change", changeWidth)} {padEnd("point", pointWidth)} {padEnd("agent", agentWidth)} when
          </Text>
        )}
        {list.slice(start, start + listHeight).map((p, i) => {
          const isSelected = start + i === cursor;
          return (
            <Text key={p.id} backgroundColor={isSelected ? theme.selection : undefined} wrap="truncate-end">
              <Text bold>{padEnd(p.id, 5)} </Text>
              <Text color={STATUS_COLOR[p.status] ?? "white"} bold={p.status === "pending"}>
                {padEnd(p.status, 9)}{" "}
              </Text>
              <Text>{padEnd(p.description, changeWidth)} </Text>
              <Text color={theme.info}>{padEnd(shortOrd(p.point, 3), pointWidth)} </Text>
              <Text color={theme.accent2}>{padEnd(proposalActor(p), agentWidth)} </Text>
              <Text color={theme.muted}>{when(p)}</Text>
            </Text>
          );
        })}
      </Panel>
      {selected && (
        <Panel title={selected.id} width={width} height={detailHeight} focused={false}>
          <Text wrap="truncate-end">
            <Text color={theme.muted}>reason </Text>
            {selected.reason ?? "(none given)"}
          </Text>
          <Text wrap="truncate-end">
            <Text color={theme.muted}>point </Text>
            {selected.point}
            <Text color={theme.muted}> · by </Text>
            {proposalActor(selected)}
            {selected.actor?.model ? <Text color={theme.muted}> ({selected.actor.model})</Text> : null}
          </Text>
          <Text wrap="truncate-end" color={theme.muted}>
            {selected.decidedBy
              ? `${selected.status} by ${selected.decidedBy} at ${fmtTime(selected.decidedAt ?? undefined)}${selected.note ? ` · ${clip(selected.note, inner - 40)}` : ""}`
              : `proposed ${fmtTime(selected.createdAt)} · expires ${fmtTime(selected.expiresAt, false)}`}
          </Text>
        </Panel>
      )}
    </Box>
  );
}
