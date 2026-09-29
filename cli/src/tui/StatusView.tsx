import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { BaskStreamClient, Json } from "@basidekick/baskstream";
import { fmtValue } from "../format.js";
import { Panel, theme } from "./ui.js";

export function StatusView({ client, active, width, height, profileName, allowWrites }: { client: BaskStreamClient; active: boolean; width: number; height: number; profileName: string; allowWrites: boolean }) {
  const [metrics, setMetrics] = useState<[string, string][]>([]);
  const [subs, setSubs] = useState<Json>();

  useEffect(() => {
    if (!active) return;
    const refresh = async () => {
      const text = await client.http.metrics().catch(() => "");
      setMetrics(
        text
          .split("\n")
          .map((line) => /^baskstream_(\w+?)(?:_total)? (\S+)/.exec(line))
          .filter((m): m is RegExpExecArray => !!m)
          .map((m) => [m[1].replace(/_/g, " "), m[2]])
      );
      setSubs(await client.subscriptionStatus().catch(() => undefined));
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [active]);

  const caps = client.capabilities;
  const limits = (caps.limits ?? {}) as Json;
  const model = (caps.modelEditing ?? {}) as Json;
  const session = (subs?.session ?? {}) as Json;
  const row = (label: string, value: unknown, color?: string) => (
    <Text key={label} wrap="truncate-end">
      <Text color={theme.muted}>{label.padEnd(22)}</Text>
      <Text color={color}>{fmtValue(value)}</Text>
    </Text>
  );
  const half = Math.floor(width / 2);

  return (
    <Box height={height}>
      <Panel title="Station" width={half} height={height}>
        {row("station", client.http.url.origin)}
        {row("profile", profileName)}
        {row("user", caps.authenticatedUser)}
        {row("api version", caps.apiVersion)}
        {row("service writes", caps.writesEnabled ? "enabled" : "disabled", caps.writesEnabled ? theme.warn : theme.good)}
        {row("model edits", model.enabled ? "enabled" : "disabled", model.enabled ? theme.warn : theme.good)}
        {row("this dashboard", allowWrites ? "writes allowed" : "read-only", allowWrites ? theme.warn : theme.good)}
        <Text> </Text>
        {row("connections", `${fmtValue(limits.activeConnections)} / ${fmtValue(limits.maxConnections)}`)}
        {row("per user", limits.maxConnectionsPerUser)}
        {row("heartbeat", `${fmtValue(limits.heartbeatIntervalSec)} s`)}
        {row("cov batch window", `${fmtValue(limits.covBatchWindowMillis)} ms`)}
        {row("max points / read", limits.maxPointSnapshotPoints)}
      </Panel>
      <Panel title="Traffic" width={width - half} height={height} focused={false}>
        {metrics.length === 0 && <Text color={theme.muted}>Loading metrics…</Text>}
        {metrics.map(([label, value]) => row(label, value, /error|timeout|resync/.test(label) && value !== "0" ? theme.warn : undefined))}
        {subs && (
          <>
            <Text> </Text>
            {row("my point subscriptions", session.pointSubscriptions ?? session.points)}
            {row("my groups", session.subscriptionGroups ?? session.groups)}
            {row("station subscriptions", limits.totalSubscriptions)}
          </>
        )}
      </Panel>
    </Box>
  );
}
