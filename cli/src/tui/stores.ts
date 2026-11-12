import { useCallback, useEffect, useRef, useState } from "react";
import { toSlotOrd, type AgentLogRecord, type BaskStreamClient, type JobSummary, type Json, type PointSnapshot, type Proposal, type Watch } from "@basidekick/baskstream";
import type { Link, Shared } from "../link.js";

export interface WatchedPoint {
  ord: string;
  snapshot?: PointSnapshot;
  /** Recent numeric values (booleans as 0/1) for sparklines. */
  trend: number[];
  changedAt?: number;
}

const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "boolean" ? (value ? 1 : 0) : undefined;

/** Live values for a changing set of points through one subscription group. */
export function useLiveValues(client: BaskStreamClient, group: string, ords: string[], active = true): Map<string, PointSnapshot> {
  const [values, setValues] = useState(new Map<string, PointSnapshot>());
  const watchRef = useRef<Promise<Watch> | null>(null);
  const key = ords.join("\n");

  useEffect(() => {
    const ready = client.watch([], { group });
    watchRef.current = ready;
    let watch: Watch | undefined;
    const onChange = (snapshot: PointSnapshot) => setValues((map) => new Map(map).set(snapshot.point, snapshot));
    ready.then((w) => {
      watch = w;
      w.on("change", onChange);
    }, () => {});
    return () => {
      watch?.off("change", onChange);
      void watch?.close().catch(() => {});
    };
  }, [client, group]);

  // Follow the wanted set, after a short pause so scrolling does not resubscribe on every row.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      void watchRef.current?.then((w) => w.update(ords)).then((snapshots) => {
        if (snapshots?.length) setValues((map) => {
          const next = new Map(map);
          for (const s of snapshots) next.set(s.point, s);
          return next;
        });
      }, () => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [key, active]);

  return values;
}

/** The watch list: shared between windows on the same station, with live values and short trends. */
export function useWatchList(client: BaskStreamClient, link: Link, initial: string[]) {
  const watchRef = useRef<Promise<Watch> | null>(null);
  const start = [...new Set([...link.get().watch, ...initial.map(toSlotOrd)])];
  const [points, setPoints] = useState<WatchedPoint[]>(start.map((ord) => ({ ord, trend: [] })));
  const pointsRef = useRef(points);
  pointsRef.current = points;

  const apply = useCallback((next: string[]) => {
    const list = pointsRef.current;
    pointsRef.current = next.map((ord) => list.find((p) => p.ord === ord) ?? { ord, trend: [] });
    setPoints(pointsRef.current);
    return watchRef.current?.then((w) => w.update(next));
  }, []);

  useEffect(() => {
    const ready = client.watch(start, { group: "bask-watch" });
    watchRef.current = ready;
    let watch: Watch | undefined;
    const onChange = (snapshot: PointSnapshot) =>
      setPoints((list) =>
        list.map((p) => {
          if (p.ord !== snapshot.point) return p;
          const value = numeric(snapshot.value);
          const changed = p.snapshot !== undefined && (p.snapshot.value !== snapshot.value || p.snapshot.status !== snapshot.status);
          return { ...p, snapshot, trend: value === undefined ? p.trend : [...p.trend, value].slice(-60), changedAt: changed ? Date.now() : p.changedAt };
        })
      );
    ready.then((w) => {
      watch = w;
      w.on("change", onChange);
      for (const snapshot of w.values.values()) onChange(snapshot);
    }, () => {});
    if (initial.length) link.update((s) => void (s.watch = start));
    // Another window changed the list.
    const onShared = (shared: Shared) => {
      const mine = pointsRef.current.map((p) => p.ord);
      if (shared.watch.join("\n") !== mine.join("\n")) void apply(shared.watch);
    };
    link.on("change", onShared);
    return () => {
      link.off("change", onShared);
      watch?.off("change", onChange);
      void watch?.close().catch(() => {});
    };
  }, [client, link]);

  const setOrds = useCallback((next: string[]) => {
    next = [...new Set(next.map(toSlotOrd))];
    link.update((s) => void (s.watch = next));
    return apply(next);
  }, [link, apply]);

  const add = useCallback((ord: string) => {
    ord = toSlotOrd(ord);
    const current = pointsRef.current.map((p) => p.ord);
    return current.includes(ord) ? undefined : setOrds([...current, ord]);
  }, [setOrds]);

  const remove = useCallback((ord: string) => setOrds(pointsRef.current.map((p) => p.ord).filter((o) => o !== toSlotOrd(ord))), [setOrds]);

  return { points, add, remove };
}

/** The station's own name, from its capabilities or from the `n:station` tag every component carries. */
export function useStationName(client: BaskStreamClient): string | undefined {
  const [name, setName] = useState<string | undefined>(typeof client.capabilities.station === "string" ? client.capabilities.station : undefined);
  useEffect(() => {
    if (name) return;
    void client.describe("slot:/Services", "full").then((node) => {
      const tags = (((node.metadata ?? {}) as Json).tags ?? []) as Json[];
      const found = tags.find((t) => t.id === "n:station")?.value;
      if (typeof found === "string" && found) setName(found);
    }, () => {});
  }, [client]);
  return name;
}

export type AlarmMap = Map<string, Json>;

/** Open alarms, kept live from alarm events and reloaded on resync or reconnect. */
export function useAlarms(client: BaskStreamClient) {
  const [alarms, setAlarms] = useState<AlarmMap>(new Map());
  const [error, setError] = useState<string>();
  const [loadedAt, setLoadedAt] = useState<number>();
  /** When the newest alarm event arrived, for a brief highlight. */
  const [lastEventAt, setLastEventAt] = useState<number>();

  const reload = useCallback(async () => {
    try {
      let list = (await client.alarms({ scope: "open", limit: 500, order: "newest" })).alarms as Json[];
      // Modules built before the newest-order fix repeat one record; fall back to oldest-first.
      if (new Set(list.map((a) => a.uuid)).size < list.length) list = (await client.alarms({ scope: "open", limit: 500 })).alarms as Json[];
      setAlarms(new Map(list.map((a) => [String(a.uuid), a])));
      setLoadedAt(Date.now());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    const onAlarm = (frame: Json) => {
      const event = frame.event as Json | null;
      if (!event) {
        if (frame.refreshRecommended) void reload();
        return;
      }
      setLastEventAt(Date.now());
      setAlarms((map) => {
        const next = new Map(map);
        if (frame.inScope === false || event.isOpen === false) next.delete(String(event.uuid));
        else next.set(String(event.uuid), event);
        return next;
      });
    };
    const refresh = () => void reload();
    client.on("alarm", onAlarm);
    client.on("resync", refresh);
    client.on("reconnected", refresh);
    void reload();
    client.subscribeAlarms({ scope: "open", mode: "event" }).catch((e: Error) => setError(e.message));
    return () => {
      client.off("alarm", onAlarm);
      client.off("resync", refresh);
      client.off("reconnected", refresh);
    };
  }, [client, reload]);

  return { alarms, error, loadedAt, lastEventAt, reload };
}

/** Agent proposals this user may see, kept live from proposal notices and reloaded on reconnect. */
export function useProposals(client: BaskStreamClient) {
  const [proposals, setProposals] = useState<Map<string, Proposal>>(new Map());
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const list = await client.proposals();
      setProposals(new Map(list.map((p) => [p.id, p])));
      setError(undefined);
    } catch (e) {
      // Stations before API 1.8 have no proposals; leave the view empty.
      const code = (e as { code?: string }).code;
      setError(code === "unsupported_op" ? undefined : e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    const onProposal = (proposal: Proposal) => setProposals((map) => new Map(map).set(proposal.id, proposal));
    const refresh = () => void reload();
    client.on("proposal", onProposal);
    client.on("reconnected", refresh);
    void reload();
    return () => {
      client.off("proposal", onProposal);
      client.off("reconnected", refresh);
    };
  }, [client, reload]);

  return { proposals, error, reload };
}

// ---- AI activity ----------------------------------------------------------------------------------

/** One line of the AI activity feed: an agent record baskStream wrote, or one of Niagara's own audit records. */
export interface Activity {
  key: string;
  at: number;
  source: "agent" | "audit";
  /** Niagara user the record is filed under. */
  user: string;
  /** The agent's Niagara user, when the record is about an agent. */
  agentUser?: string;
  agent?: string;
  model?: string;
  for?: string;
  /** proposed, approved, rejected, expired, written, completed, refused, or the audit operation. */
  kind: string;
  outcome?: string;
  code?: string;
  action: string;
  target: string;
  change?: string;
  reason?: string;
  oldValue?: string;
  value?: string;
  /** Done by, or on behalf of, an AI agent. */
  ai: boolean;
}

const fromAgentRecord = (r: AgentLogRecord): Activity => {
  const outcome = String(r.outcome ?? "");
  return {
    key: `agent|${r.timestamp}|${r.user}|${r.target}|${r.action}|${outcome}`,
    at: r.timestamp, source: "agent", user: r.user, agentUser: r.agentUser ?? (r.agent ? r.user : undefined), agent: r.agent, model: r.model, for: r.for,
    kind: outcome.split(" ")[0] || "completed", outcome, code: r.code, action: r.action, target: r.target, change: r.change, reason: r.reason, ai: true
  };
};

/**
 * Reads one audit record. The station sends it as text:
 *   value   "12-Nov-26 12:50 PM MST[admin] Invoked;slotName=override;oldValue=…;value=…"
 *   summary "12-Nov-26 12:50 PM MST Invoked /Drivers/… override <old> <new> admin"
 * The target only appears in the summary, between the operation and the slot name.
 */
export function parseAudit(record: Json): Omit<Activity, "ai"> | undefined {
  const text = String(record.value ?? "");
  const head = /^([^[]*)\[([^\]]*)\] ([^;]*)/.exec(text);
  if (!head || typeof record.timestamp !== "number") return undefined;
  const [whole, when, user, operation] = head;
  const rest = text.slice(whole.length);
  const part = (name: string, after: number) => {
    const at = rest.indexOf(`;${name}=`, after);
    return at < 0 ? undefined : { at, from: at + name.length + 2 };
  };
  const slot = rest.startsWith(";slotName=") ? { at: 0, from: 10 } : undefined;
  const old = part("oldValue", slot?.from ?? 0);
  const val = part("value", old?.from ?? slot?.from ?? 0);
  const until = (from: number, ...next: ({ at: number } | undefined)[]) => rest.slice(from, next.find((n) => n && n.at >= from)?.at ?? rest.length);
  const slotName = slot ? until(slot.from, old, val) : "";
  const oldValue = old ? until(old.from, val) : "";
  const value = val ? rest.slice(val.from) : "";
  const summary = String(record.summary ?? "");
  const prefix = `${when} ${operation} `;
  const suffix = ` ${slotName} ${oldValue} ${value} ${user}`;
  let target = summary.startsWith(prefix) && summary.endsWith(suffix) ? summary.slice(prefix.length, summary.length - suffix.length) : summary.slice(prefix.length).split(" ")[0] ?? "";
  if (target.startsWith("/")) target = `slot:${target}`;
  if (operation === "Agent") return undefined; // the agent log carries these with their fields
  // baskStream's own bookkeeping for a model plan (preview, each step, the outcome) is long and
  // repeats what Niagara's Added / Changed / Removed records beside it already say.
  if (/^model_/.test(operation)) return undefined;
  return { key: `audit|${record.timestamp}|${user}|${operation}|${target}|${slotName}|${value.slice(0, 40)}`, at: record.timestamp, source: "audit", user, kind: operation, action: slotName, target, oldValue: oldValue || undefined, value: value || undefined };
}

/**
 * What AI agents did: the agent log (proposals, decisions, direct changes, refusals) merged with the
 * station's audit history, which adds Niagara's own record of each change made by an agent's user.
 * Reloads every few seconds while `enabled`, fetching only what is new.
 */
export function useActivity(client: BaskStreamClient, options: { enabled: boolean; station?: string; rangeMs: number; extraUsers?: string[] }) {
  const { enabled, station, rangeMs } = options;
  const [entries, setEntries] = useState<Activity[]>([]);
  const [state, setState] = useState<{ loaded: boolean; error?: string; auditNote?: string; lastNewAt?: number }>({ loaded: false });
  const store = useRef({ map: new Map<string, Activity>(), agentSince: 0, auditSince: 0, range: 0, busy: false, users: new Set<string>(options.extraUsers ?? []) });

  const reload = useCallback(async (full = false) => {
    const s = store.current;
    if (s.busy) return;
    s.busy = true;
    const now = Date.now();
    const floor = now - rangeMs;
    if (full || s.range !== rangeMs) {
      s.map = new Map();
      s.agentSince = floor;
      s.auditSince = floor;
      s.range = rangeMs;
    }
    let error: string | undefined;
    let auditNote: string | undefined;
    let added = 0;
    try {
      const log = await client.agentLog({ since: s.agentSince, limit: 1000 });
      for (const r of log.records) {
        const a = fromAgentRecord(r);
        if (a.agentUser) s.users.add(a.agentUser);
        if (!s.map.has(a.key)) added += 1;
        s.map.set(a.key, a);
        s.agentSince = Math.max(s.agentSince, r.timestamp);
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      error = code === "unsupported_op" ? "This station's baskStream is older than API 1.8, which added the agent log." : e instanceof Error ? e.message : String(e);
    }
    if (station) {
      try {
        // The history comes oldest first; follow it forward when one reply is not the whole window.
        // Audit values can be long, so pages are modest and shrink if the station says a reply is too big.
        let limit = 250;
        for (let page = 0; page < 12; page += 1) {
          let history: Json;
          try {
            history = await client.history(`history:/${station}/AuditHistory`, { start: s.auditSince, end: now, limit });
          } catch (e) {
            if ((e as { code?: string }).code !== "response_too_large" || limit <= 20) throw e;
            limit = Math.floor(limit / 3);
            continue;
          }
          const h = ((history.histories ?? []) as Json[])[0];
          const records = (h?.records ?? []) as Json[];
          for (const r of records) {
            const a = parseAudit(r);
            if (typeof r.timestamp === "number") s.auditSince = Math.max(s.auditSince, r.timestamp + 1);
            if (!a) continue;
            if (!s.map.has(a.key)) added += 1;
            s.map.set(a.key, { ...a, ai: false });
          }
          if (!h?.truncated || records.length === 0) break;
        }
      } catch (e) {
        auditNote = `Audit history not readable (${(e as { code?: string }).code ?? (e as Error).message}); showing the agent log only.`;
      }
    }
    for (const [key, a] of s.map) {
      if (a.at < floor) s.map.delete(key);
      else if (a.source === "audit") a.ai = s.users.has(a.user);
    }
    s.busy = false;
    setEntries([...s.map.values()].sort((a, b) => b.at - a.at));
    setState((prev) => ({ loaded: true, error, auditNote, lastNewAt: added > 0 && prev.loaded ? Date.now() : prev.lastNewAt }));
  }, [client, station, rangeMs]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const timer = setInterval(() => void reload(), 5000);
    let soon: NodeJS.Timeout | undefined;
    const onProposal = () => {
      clearTimeout(soon);
      soon = setTimeout(() => void reload(), 400);
    };
    client.on("proposal", onProposal);
    return () => {
      clearInterval(timer);
      clearTimeout(soon);
      client.off("proposal", onProposal);
    };
  }, [enabled, reload, client]);

  return { entries, ...state, agentUsers: [...store.current.users], reload: () => reload(true) };
}

/** The station's jobs, refreshed while `enabled` (faster while one is running). */
export function useJobs(client: BaskStreamClient, enabled: boolean) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [state, setState] = useState<{ loaded: boolean; error?: string }>({ loaded: false });
  const reload = useCallback(async () => {
    try {
      setJobs(await client.jobs());
      setState({ loaded: true });
    } catch (e) {
      setState({ loaded: true, error: (e as { code?: string }).code === "unsupported_op" ? "unsupported" : e instanceof Error ? e.message : String(e) });
    }
  }, [client]);
  const running = jobs.some((j) => !j.complete);
  useEffect(() => {
    if (!enabled) return;
    void reload();
    const timer = setInterval(() => void reload(), running ? 1000 : 4000);
    return () => clearInterval(timer);
  }, [enabled, reload, running]);
  return { jobs, ...state, reload };
}
