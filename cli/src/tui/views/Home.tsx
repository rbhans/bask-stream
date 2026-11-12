import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { BaskStreamClient, JobSummary, Json, Proposal } from "@basidekick/baskstream";
import { ago, alarmMessage, alarmState, fmtPoint, isUnacked, place, sparkline } from "../../format.js";
import type { Rect } from "../input.js";
import type { Activity, AlarmMap, WatchedPoint } from "../stores.js";
import { Badge, Field, Meter, Panel, clip, padEnd, padStart, statusTone, theme, useTick } from "../ui.js";
import { outcomeLook, whatOf, whoOf } from "./Activity.js";
import { alarmColor } from "./Alarms.js";
import { jobColor } from "./Jobs.js";
import { equipmentOf, nameOf } from "./Watch.js";

const WORDMARK = ["█▄▄ ▄▀█ █▀ █▄▀", "█▄█ █▀█ ▄█ █░█"];

export function HomeView(props: {
  client: BaskStreamClient;
  active: boolean;
  rect: Rect;
  profileName: string;
  station?: string;
  allowWrites: boolean;
  link: { state: string; latency: number[]; detail?: string };
  alarms: AlarmMap;
  alarmsLoaded: boolean;
  proposals: Map<string, Proposal>;
  activity: Activity[];
  activityLoaded: boolean;
  watch: WatchedPoint[];
  jobs: JobSummary[];
}) {
  const { client, active, rect, profileName, station, allowWrites, link, alarms, alarmsLoaded, proposals, activity, activityLoaded, watch, jobs } = props;
  const [caps, setCaps] = useState<Json>(client.capabilities);
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  useTick(5000, active);

  useEffect(() => {
    if (!active) return;
    const refresh = async () => {
      const text = await client.http.metrics().catch(() => "");
      setMetrics(Object.fromEntries(text.split("\n").map((line) => /^baskstream_(\w+?)(?:_total)? (\S+)/.exec(line)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]])));
      const reply = await client.call("capabilities").catch(() => undefined);
      if (reply?.capabilities) setCaps(reply.capabilities as Json);
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [active, client]);

  const now = Date.now();
  const two = rect.width >= 100;
  const leftWidth = two ? Math.floor(rect.width / 2) : rect.width;
  const rightWidth = two ? rect.width - leftWidth : rect.width;
  const topHeight = two ? Math.max(10, Math.min(12, Math.floor(rect.height * 0.36))) : Math.max(8, Math.min(10, Math.floor(rect.height * 0.3)));
  const bottomHeight = rect.height - topHeight;

  const limits = (caps.limits ?? {}) as Json;
  const model = (caps.modelEditing ?? {}) as Json;
  const rules = caps.agents as Json | undefined;
  const open = [...alarms.values()];
  const unacked = open.filter(isUnacked);
  const byState = ["offnormal", "fault", "alert", "normal"].map((state) => ({ state, count: open.filter((a) => alarmState(a) === state).length })).filter((s) => s.count > 0);
  const newest = [...(unacked.length ? unacked : open)].sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
  const pending = [...proposals.values()].filter((p) => p.status === "pending");
  const ai = activity.filter((e) => e.source === "agent");
  const running = jobs.filter((j) => !j.complete);
  const host = client.http.url.host;

  const stationCard = (width: number, height: number) => {
    const inner = width - 4;
    return (
      <Panel title="Station" meta={link.state === "live" ? "connected" : link.state} metaColor={link.state === "live" ? theme.good : theme.warn} width={width} height={height} focused={false}>
        <Box>
          <Box flexDirection="column" marginRight={2}>
            <Text color={theme.accent}>{WORDMARK[0]}</Text>
            <Text color={theme.accent2}>{WORDMARK[1]}</Text>
          </Box>
          <Box flexDirection="column">
            <Text bold wrap="truncate-end">{clip(station ?? profileName, inner - 18)}</Text>
            <Text color={theme.muted} wrap="truncate-end">{clip(`${String(caps.authenticatedUser ?? "")}@${host}`, inner - 18)}</Text>
          </Box>
        </Box>
        <Text> </Text>
        <Text wrap="truncate-end">
          <Text color={theme.muted}>{"link".padEnd(13)}</Text>
          <Text color={link.state === "live" ? theme.good : theme.warn}>● </Text>
          <Text>{link.latency.length ? `${link.latency[link.latency.length - 1]} ms ` : ""}</Text>
          <Text color={theme.info}>{sparkline(link.latency, Math.min(24, inner - 30))}</Text>
        </Text>
        <Field label="baskStream" labelWidth={13} value={`API ${String(caps.apiVersion ?? "?")}${caps.demo ? " · demo station" : ""}`} width={inner} />
        <Text wrap="truncate-end">
          <Text color={theme.muted}>{"connections".padEnd(13)}</Text>
          <Meter value={Number(limits.activeConnections ?? 0)} max={Number(limits.maxConnections ?? 10)} width={10} />
          <Text>{` ${String(limits.activeConnections ?? "?")} of ${String(limits.maxConnections ?? "?")}`}</Text>
          <Text color={theme.muted}>{`  ·  ${String(limits.totalSubscriptions ?? metrics.subscriptions ?? 0)} subscriptions`}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={theme.muted}>{"changes".padEnd(13)}</Text>
          <Text color={allowWrites ? theme.warn : theme.good}>{allowWrites ? "✎ on in this window" : "read-only window"}</Text>
          <Text color={theme.muted}>{`  ·  station writes ${caps.writesEnabled ? "on" : "off"} · model edits ${model.enabled ? "on" : "off"}`}</Text>
        </Text>
        <Field label="traffic" labelWidth={13} value={`${metrics.requests ?? "…"} request${metrics.requests === "1" ? "" : "s"} · ${metrics.errors ?? "0"} error${metrics.errors === "1" ? "" : "s"} · ${metrics.write_requests ?? "0"} write${metrics.write_requests === "1" ? "" : "s"}`} color={Number(metrics.errors ?? 0) > 0 ? theme.warn : undefined} width={inner} />
      </Panel>
    );
  };

  const alarmCard = (width: number, height: number) => {
    const inner = width - 4;
    const rows = Math.max(0, height - 5);
    return (
      <Panel title="Alarms" meta="press 4" width={width} height={height} focused={false} color={unacked.length ? theme.bad : undefined}>
        {!alarmsLoaded ? (
          <Text color={theme.faint}>…</Text>
        ) : open.length === 0 ? (
          <Text color={theme.good}>✓ No open alarms.</Text>
        ) : (
          <>
            <Text wrap="truncate-end">
              <Text bold color={unacked.length ? theme.bad : theme.good}>{unacked.length}</Text>
              <Text color={theme.muted}> unacknowledged   </Text>
              <Text bold>{open.length}</Text>
              <Text color={theme.muted}> open</Text>
            </Text>
            <Text wrap="truncate-end">
              {byState.map((s) => (
                <Text key={s.state}>
                  <Text color={alarmColor(s.state)}>{"█".repeat(Math.max(1, Math.round((s.count / open.length) * Math.min(30, inner - 40))))}</Text>
                  <Text color={theme.muted}>{` ${s.count} ${s.state}  `}</Text>
                </Text>
              ))}
            </Text>
            <Text> </Text>
            {newest.slice(0, rows).map((a) => (
              <Text key={String(a.uuid)} wrap="truncate-end">
                <Text color={alarmColor(alarmState(a))}>● </Text>
                <Text color={theme.muted}>{padStart(ago(a.timestamp, now), 3)} </Text>
                <Text color={theme.info}>{padEnd(place(String(((a.sources ?? []) as string[])[0] ?? "")), Math.min(26, Math.floor(inner * 0.36)))} </Text>
                <Text>{clip(alarmMessage(a), inner - 7 - Math.min(26, Math.floor(inner * 0.36)))}</Text>
              </Text>
            ))}
          </>
        )}
      </Panel>
    );
  };

  const agentCard = (width: number, height: number) => {
    const inner = width - 4;
    const rows = Math.max(0, height - 4 - Math.min(2, pending.length));
    return (
      <Panel title="AI activity" meta="press 0" width={width} height={height} focused={false} color={pending.length ? theme.warn : undefined}>
        {!rules ? (
          <Text color={theme.muted} wrap="wrap">Agent controls need baskStream API 1.8 on the station.</Text>
        ) : (
          <>
            <Text wrap="truncate-end">
              {pending.length > 0 ? <><Badge text={`${pending.length} waiting for you`} color={theme.warn} /><Text>  </Text></> : <Text color={theme.good}>✓ nothing waiting   </Text>}
              <Text color={theme.muted}>{rules.approvalRequired ? "writes need approval" : "agents write directly"} · {rules.maxChangesPerMinute ? `${String(rules.maxChangesPerMinute)}/min` : "no rate limit"}</Text>
            </Text>
            {pending.slice(0, 2).map((p) => (
              <Text key={p.id} wrap="truncate-end">
                <Text color={theme.warn} bold>◷ {p.id} </Text>
                <Text bold>{clip(p.description, Math.floor(inner * 0.4))}</Text>
                <Text color={theme.info}> {clip(place(p.point), Math.floor(inner * 0.4))}</Text>
              </Text>
            ))}
            <Text> </Text>
            {!activityLoaded ? (
              <Text color={theme.faint}>…</Text>
            ) : ai.length === 0 ? (
              <Text color={theme.muted}>No agent activity in this window.</Text>
            ) : (
              ai.slice(0, rows).map((e) => {
                const look = outcomeLook(e);
                return (
                  <Text key={e.key} wrap="truncate-end">
                    <Text color={look.color}>{look.mark} </Text>
                    <Text color={theme.muted}>{padStart(ago(e.at, now), 3)} </Text>
                    <Text color={look.color}>{padEnd(look.text, 13)}</Text>
                    <Text>{padEnd(whatOf(e), Math.max(10, Math.floor((inner - 20) * 0.5)))} </Text>
                    <Text color={theme.info}>{clip(place(e.target), Math.max(8, inner - 21 - Math.floor((inner - 20) * 0.5)))}</Text>
                    <Text color={theme.faint}>{inner > 110 ? `  ${whoOf(e)}` : ""}</Text>
                  </Text>
                );
              })
            )}
          </>
        )}
      </Panel>
    );
  };

  const watchCard = (width: number, height: number) => {
    const inner = width - 4;
    const jobRows = running.length ? Math.min(running.length, 2) + 1 : 0;
    const rows = Math.max(0, height - 2 - jobRows);
    const trendWidth = Math.max(0, Math.min(24, inner - 46));
    return (
      <Panel title="Watch" meta={watch.length ? `${watch.length} live · press 3` : "press 3"} width={width} height={height} focused={false}>
        {watch.length === 0 ? (
          <Text color={theme.muted} wrap="wrap">Nothing on the watch list. In the Explorer, select a point and press <Text color={theme.accent} bold>w</Text>, or press <Text color={theme.accent} bold>/</Text> to find one.</Text>
        ) : (
          watch.slice(0, rows).map((p) => (
            <Text key={p.ord} wrap="truncate-end">
              <Text color={statusTone(p.snapshot?.status)}>● </Text>
              <Text>{padEnd(nameOf(p.ord), Math.min(22, Math.floor(inner * 0.34)))} </Text>
              <Text color={theme.muted}>{padEnd(equipmentOf(p.ord), Math.min(12, Math.floor(inner * 0.2)))} </Text>
              <Text bold color={p.snapshot?.statusOk === false ? statusTone(p.snapshot?.status) : undefined}>{padStart(p.snapshot ? fmtPoint(p.snapshot) : "…", 12)} </Text>
              <Text color={theme.info}>{sparkline(p.trend, trendWidth)}</Text>
            </Text>
          ))
        )}
        {running.length > 0 && (
          <>
            <Box flexGrow={1} />
            <Text color={theme.muted}>Jobs running</Text>
            {running.slice(0, 2).map((j) => (
              <Text key={j.job ?? j.name} wrap="truncate-end">
                <Text color={jobColor(j.state)}>◐ </Text>
                <Text>{padEnd(j.display || j.name, Math.max(12, inner - 22))} </Text>
                <Meter value={j.progress} max={100} width={10} color={theme.warn} />
                <Text color={theme.muted}> {j.progress}%</Text>
              </Text>
            ))}
          </>
        )}
      </Panel>
    );
  };

  if (!two) {
    const third = Math.max(6, Math.floor(bottomHeight / 2));
    return (
      <Box flexDirection="column" height={rect.height}>
        {stationCard(rect.width, topHeight)}
        {alarmCard(rect.width, third)}
        {agentCard(rect.width, bottomHeight - third)}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" height={rect.height}>
      <Box height={topHeight}>
        {stationCard(leftWidth, topHeight)}
        {alarmCard(rightWidth, topHeight)}
      </Box>
      <Box height={bottomHeight}>
        {agentCard(leftWidth, bottomHeight)}
        {watchCard(rightWidth, bottomHeight)}
      </Box>
    </Box>
  );
}
