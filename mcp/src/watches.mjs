// Live values for callers that can only poll (an artifact page calling through the desktop app):
// one station subscription per set of points, a sequence cursor, and long polls that return as
// soon as anything changes.
import { toSlotOrd } from "@basidekick/baskstream"
import { toValue } from "./normalize.mjs"

const IDLE_MS = 2 * 60 * 1000
const LEASE_SEC = 120

/** A value the driver has actually polled: not stale, and the read itself worked. */
export const polled = (snapshot) => Boolean(snapshot) && snapshot.ok !== false && !String(snapshot.status ?? "").includes("stale")

export class Watches {
  constructor(station) {
    this.station = station
    this.entries = new Map()
    this.nextId = 0
    this.sweeper = setInterval(() => this.sweep(), 30 * 1000)
    this.sweeper.unref()
  }

  /**
   * Values for `points` that changed after `since` (all of them when `since` is missing or from
   * an older subscription), waiting up to `waitMs` for a change when there is none yet.
   */
  async poll(points, since, waitMs) {
    const ords = [...new Set(points.map((p) => toSlotOrd(String(p))))].sort()
    const entry = await this.entry(ords)
    entry.lastUsed = Date.now()
    const [id, seqText] = String(since ?? "").split(":")
    const fresh = id !== entry.id
    const after = fresh ? 0 : Number(seqText) || 0
    if (!fresh && entry.seq <= after && waitMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, waitMs)
        function done() {
          clearTimeout(timer)
          entry.waiters.delete(done)
          resolve()
        }
        entry.waiters.add(done)
      })
    }
    const changed = fresh ? ords : ords.filter((ord) => (entry.changedAt.get(ord) ?? 0) > after)
    return {
      cursor: `${entry.id}:${entry.seq}`,
      complete: fresh,
      connected: Boolean(this.station.client?.connected),
      points: changed.map((ord) => entry.values.get(ord)).filter(Boolean).map(toValue),
    }
  }

  /**
   * Values for points a snapshot read found unpolled (a driver polls a proxy point only while
   * something subscribes to it): subscribes, as a watch does, so they stay polled while in use,
   * and waits up to `waitMs` for each one's first good value. Returns what arrived, by ORD.
   */
  async fresh(points, waitMs) {
    const ords = [...new Set(points.map((p) => toSlotOrd(String(p))))].sort()
    const entry = await this.entry(ords)
    entry.lastUsed = Date.now()
    const deadline = Date.now() + waitMs
    while (!ords.every((ord) => polled(entry.values.get(ord))) && Date.now() < deadline) {
      await new Promise((resolve) => {
        const timer = setTimeout(wake, deadline - Date.now())
        function wake() {
          clearTimeout(timer)
          entry.waiters.delete(wake)
          resolve()
        }
        entry.waiters.add(wake)
      })
    }
    return new Map(ords.filter((ord) => polled(entry.values.get(ord))).map((ord) => [ord, entry.values.get(ord)]))
  }

  async entry(ords) {
    const key = ords.join("\n")
    let entry = this.entries.get(key)
    if (entry) return entry.ready
    entry = { id: `w${++this.nextId}`, seq: 0, values: new Map(), changedAt: new Map(), waiters: new Set(), lastUsed: Date.now(), watch: null }
    this.entries.set(key, entry)
    entry.ready = this.station
      .use(async (client) => {
        const watch = await client.watch([], { group: `mcp-${entry.id}`, leaseSec: LEASE_SEC })
        watch.on("change", (snapshot) => {
          entry.seq += 1
          entry.values.set(snapshot.point, snapshot)
          entry.changedAt.set(snapshot.point, entry.seq)
          for (const wake of [...entry.waiters]) wake()
        })
        entry.watch = watch
        await watch.update(ords)
        return entry
      })
      .catch((error) => {
        this.entries.delete(key)
        throw error
      })
    return entry.ready
  }

  sweep() {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsed < IDLE_MS || entry.waiters.size) continue
      this.entries.delete(key)
      void entry.watch?.close().catch(() => {})
    }
  }
}
