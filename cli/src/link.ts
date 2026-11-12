// What bask windows on the same station share: the watch list, recent queries, which windows are
// open, and "show this" requests. It lives in one small file per station, so separate panes of a
// multiplexer (and `bask show`, run by a person or an AI agent) stay in step without a server.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";

export interface ShowRequest {
  /** Rises with each request, so the same ORD can be shown twice. */
  n: number;
  kind: "reveal" | "trend";
  ord: string;
  /** Process that asked. */
  from: number;
}

export interface Shared {
  watch: string[];
  queries: string[];
  trends: string[];
  show?: ShowRequest;
  /** Open dashboards by process id: the view each one is on, and when it last said so. */
  panes: Record<string, { view: string; at: number }>;
}

const EMPTY: Shared = { watch: [], queries: [], trends: [], panes: {} };
const ALIVE_MS = 12000;

export const linkFile = (station: string) => path.join(configDir(), "state", `${new URL(station).host.replace(/[^\w.-]/g, "_")}.json`);

export class Link extends EventEmitter {
  private state: Shared = { ...EMPTY };
  private seen = "";
  private timer?: NodeJS.Timeout;
  private readonly file?: string;

  /** `station` is the station URL; pass `persist: false` to keep everything in memory (tests, the demo). */
  constructor(station: string, persist = true) {
    super();
    this.file = persist ? linkFile(station) : undefined;
    this.load();
  }

  get(): Shared {
    return this.state;
  }

  private load(): boolean {
    if (!this.file) return false;
    try {
      const text = fs.readFileSync(this.file, "utf8");
      if (text === this.seen) return false;
      this.seen = text;
      this.state = { ...EMPTY, ...(JSON.parse(text) as Partial<Shared>) };
      return true;
    } catch {
      return false;
    }
  }

  /** Applies a change on top of the newest saved state and saves it. */
  update(change: (state: Shared) => void): void {
    this.load();
    const next: Shared = JSON.parse(JSON.stringify(this.state));
    change(next);
    const now = Date.now();
    for (const [pid, pane] of Object.entries(next.panes)) if (now - pane.at > ALIVE_MS * 5) delete next.panes[pid];
    this.state = next;
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const text = JSON.stringify(next);
        const temp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, text, { mode: 0o600 });
        fs.renameSync(temp, this.file);
        this.seen = text;
      } catch {
        // Sharing is a convenience; the dashboard works without it.
      }
    }
    this.emit("change", this.state);
  }

  /** Starts noticing changes other windows make. */
  start(): void {
    if (!this.file || this.timer) return;
    this.timer = setInterval(() => {
      if (this.load()) this.emit("change", this.state);
    }, 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.update((s) => void delete s.panes[String(process.pid)]);
  }

  /** Tells other windows which view this one is showing. */
  announce(view: string): void {
    this.update((s) => void (s.panes[String(process.pid)] = { view, at: Date.now() }));
  }

  /** Another open window is on `view`, so a request can be sent there instead of switching this one. */
  otherShowing(view: string): boolean {
    const now = Date.now();
    return Object.entries(this.state.panes).some(([pid, pane]) => pid !== String(process.pid) && pane.view === view && now - pane.at < ALIVE_MS);
  }

  /** Any dashboard is open on this station. */
  anyOpen(): boolean {
    const now = Date.now();
    return Object.values(this.state.panes).some((pane) => now - pane.at < ALIVE_MS);
  }

  /** Asks every window to show an ORD in its Explorer or Trends view. */
  show(kind: ShowRequest["kind"], ord: string): void {
    this.update((s) => void (s.show = { n: (s.show?.n ?? 0) + 1, kind, ord, from: process.pid }));
  }
}
