import { useCallback, useEffect, useRef, useState } from "react";
import { toSlotOrd, type BaskStreamClient, type Json, type PointSnapshot, type Proposal, type Watch } from "@basidekick/baskstream";

export interface WatchedPoint {
  ord: string;
  snapshot?: PointSnapshot;
  /** Recent numeric values (booleans as 0/1) for sparklines. */
  trend: number[];
  changedAt?: number;
}

const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "boolean" ? (value ? 1 : 0) : undefined;

/** The dashboard's watch list: one subscription group, live values and short trends. */
export function useWatchList(client: BaskStreamClient, initial: string[]) {
  const watchRef = useRef<Promise<Watch> | null>(null);
  initial = initial.map(toSlotOrd);
  const [points, setPoints] = useState<WatchedPoint[]>(initial.map((ord) => ({ ord, trend: [] })));
  const pointsRef = useRef(points);
  pointsRef.current = points;

  useEffect(() => {
    const ready = client.watch(initial, { group: "bask-tui" });
    watchRef.current = ready;
    let watch: Watch | undefined;
    const onChange = (snapshot: PointSnapshot) =>
      setPoints((list) =>
        list.map((p) => {
          if (p.ord !== snapshot.point) return p;
          const value = numeric(snapshot.value);
          const changed = p.snapshot?.value !== snapshot.value || p.snapshot?.status !== snapshot.status;
          return { ...p, snapshot, trend: value === undefined ? p.trend : [...p.trend, value].slice(-60), changedAt: changed ? Date.now() : p.changedAt };
        })
      );
    ready.then((w) => {
      watch = w;
      w.on("change", onChange);
      for (const snapshot of w.values.values()) onChange(snapshot);
    }, () => {});
    return () => {
      watch?.off("change", onChange);
      void watch?.close();
    };
  }, [client]);

  const setOrds = useCallback((next: string[]) => {
    next = next.map(toSlotOrd);
    const list = pointsRef.current;
    pointsRef.current = next.map((ord) => list.find((p) => p.ord === ord) ?? { ord, trend: [] });
    setPoints(pointsRef.current);
    return watchRef.current?.then((w) => w.update(next));
  }, []);

  const add = useCallback((ord: string) => {
    ord = toSlotOrd(ord);
    const current = pointsRef.current.map((p) => p.ord);
    return current.includes(ord) ? undefined : setOrds([...current, ord]);
  }, [setOrds]);

  const remove = useCallback((ord: string) => setOrds(pointsRef.current.map((p) => p.ord).filter((o) => o !== toSlotOrd(ord))), [setOrds]);

  return { points, add, remove };
}

export type AlarmMap = Map<string, Json>;

/** Open alarms, kept live from alarm events and reloaded on resync or reconnect. */
export function useAlarms(client: BaskStreamClient) {
  const [alarms, setAlarms] = useState<AlarmMap>(new Map());
  const [error, setError] = useState<string>();
  const [loadedAt, setLoadedAt] = useState<number>();

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

  return { alarms, error, loadedAt, reload };
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
