import { EventEmitter } from "node:events";
import { decode, encode } from "@msgpack/msgpack";
import WebSocket from "ws";
import { BaskStreamError, CLIENT_ERRORS } from "./errors.js";
import { StationHttp, type StationHttpOptions } from "./http.js";
import { OPERATIONS, type OperationName } from "./operations.js";
import type { AlarmFilter, BrowseNode, Json, PointSnapshot, ScheduleEntry, Weekday } from "./types.js";

export interface ClientOptions extends StationHttpOptions {
  username?: string;
  /** Password, or a function that supplies it. Only called when a (re)login is needed. */
  password?: string | (() => string | Promise<string>);
  /** Reconnect and restore watches and alarm subscriptions after the connection drops. Default true. */
  reconnect?: boolean;
  /** Called whenever the session cookies change, so an app can save the session. */
  onSession?: (cookies: Record<string, string>) => void;
  /** Keepalive ping interval. Default: the station's heartbeat interval, else 25 s. */
  keepAliveMs?: number;
}

export interface CallOptions {
  timeoutMs?: number;
}

interface Pending {
  op: string;
  resolve: (reply: Json) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * A connection to one station's baskStream service.
 *
 * Events:
 * - `value` (PointSnapshot): one point changed (from COV frames and resync reads).
 * - `cov`, `alarm`, `model`, `resync`, `revoked`, `notice` (Json): raw server-initiated frames.
 * - `disconnected` ({ code, reason }), `reconnecting` ({ attempt, delayMs }), `reconnected` ().
 * - `error` (Error): a failure outside any request, such as a failed reconnect.
 */
export class BaskStreamClient extends EventEmitter {
  readonly http: StationHttp;
  /** The station's capabilities, loaded when the connection opens. */
  capabilities: Json = {};

  private ws?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private keepAlive?: NodeJS.Timeout;
  private readonly watches = new Map<string, Watch>();
  private readonly alarmSubscriptions = new Map<string, Json>();

  constructor(private readonly options: ClientOptions) {
    super();
    this.http = new StationHttp(options);
  }

  /** Logs in if needed, opens the WebSocket and loads capabilities. */
  static async connect(options: ClientOptions): Promise<BaskStreamClient> {
    const client = new BaskStreamClient(options);
    await client.open();
    return client;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async open(): Promise<void> {
    this.closedByUser = false;
    await this.ensureLogin();
    await this.openSocket();
    const reply = await this.call("capabilities");
    this.capabilities = (reply.capabilities as Json) ?? {};
    this.startKeepAlive();
  }

  /** Closes the connection and stops reconnecting. */
  close(): void {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.stopKeepAlive();
    for (const watch of this.watches.values()) watch.stopRenewing();
    this.watches.clear();
    this.alarmSubscriptions.clear();
    this.ws?.close(1000, "client closed");
    this.ws = undefined;
  }

  /**
   * Sends one request and resolves with the reply. Rejects with BaskStreamError, whose `code` is
   * the protocol error code (or a client code such as "timeout").
   */
  call(op: OperationName | string, fields: Json = {}, options: CallOptions = {}): Promise<Json> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BaskStreamError(CLIENT_ERRORS.notConnected, "Not connected to the station.", op));
    }
    const id = `${op}-${++this.nextId}`;
    const expectsReply = (OPERATIONS as Record<string, { reply: string | null }>)[op]?.reply !== null;
    return new Promise<Json>((resolve, reject) => {
      if (expectsReply) {
        const timeoutMs = options.timeoutMs ?? this.http.timeoutMs;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new BaskStreamError(CLIENT_ERRORS.timeout, `${op} got no reply within ${timeoutMs} ms.`, op));
        }, timeoutMs);
        this.pending.set(id, { op, resolve, reject, timer });
      }
      ws.send(encode({ ...fields, op, id }), { binary: true }, (error) => {
        if (error) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
          }
          reject(new BaskStreamError(CLIENT_ERRORS.closed, error.message, op));
        } else if (!expectsReply) {
          resolve({});
        }
      });
    });
  }

  // ---- Convenience methods -------------------------------------------------------------------

  ping(): Promise<Json> {
    return this.call("ping");
  }

  async browse(base = "slot:/", options: { depth?: number; metadata?: "none" | "full" } = {}): Promise<BrowseNode> {
    return (await this.call("browse", { base, ...options })).node as BrowseNode;
  }

  async describe(ord: string, metadata: "none" | "full" = "full"): Promise<BrowseNode> {
    return (await this.call("describe", { ord, metadata })).node as BrowseNode;
  }

  search(base: string, query: string, options: Json = {}): Promise<Json> {
    return this.call("search", { base, query, ...options });
  }

  async read(points: string[], fields?: string[]): Promise<PointSnapshot[]> {
    return (await this.call("read", fields ? { points, fields } : { points })).points as PointSnapshot[];
  }

  async write(point: string, action: string, value?: unknown, options: Json = {}): Promise<PointSnapshot> {
    const reply = await this.call("write", { point, action, ...(value === undefined ? {} : { value }), ...options });
    return (reply.points as PointSnapshot[])[0];
  }

  describeWrite(points: string[]): Promise<Json> {
    return this.call("describe_write", { points });
  }

  async history(ord: string, options: { start?: number; end?: number; limit?: number } = {}): Promise<Json> {
    return (await this.call("read_history", { ord, ...options })).history as Json;
  }

  async historyRollup(ord: string, options: { start?: number; end?: number; interval: number; includeInvalid?: boolean }): Promise<Json> {
    return (await this.call("read_history_rollup", { ord, ...options })).rollup as Json;
  }

  async alarms(options: { scope?: "open" | "ack_pending" | "all"; limit?: number; order?: "newest" | "oldest"; filter?: AlarmFilter; source?: string } = {}): Promise<Json> {
    return (await this.call("read_alarms", options as Json)).alarms as Json;
  }

  async ackAlarms(target: { uuids: string[] } | { filter: AlarmFilter; scope?: string; limit?: number }, dryRun = false): Promise<Json> {
    return (await this.call("ack_alarms", { ...target, dryRun })).alarms as Json;
  }

  async clearAlarms(target: { uuids: string[] } | { filter: AlarmFilter; scope?: string; limit?: number }, dryRun = false): Promise<Json> {
    return (await this.call("clear_alarms", { ...target, dryRun })).alarms as Json;
  }

  async schedule(ord: string, at?: number): Promise<Json> {
    return (await this.call("read_schedule", at === undefined ? { ord } : { ord, at })).schedule as Json;
  }

  async scheduleEvents(ord: string, options: { start?: number; end?: number; limit?: number } = {}): Promise<Json> {
    return (await this.call("read_schedule_events", { ord, ...options })).schedule as Json;
  }

  async writeSchedule(ord: string, days: Partial<Record<Weekday, ScheduleEntry[]>>, dryRun = false): Promise<Json> {
    return (await this.call("write_schedule", { ord, days, dryRun })).schedule as Json;
  }

  subscriptionStatus(includePoints = false): Promise<Json> {
    return this.call("subscription_status", { includePoints });
  }

  /**
   * Subscribes to live values for a set of points. The watch renews its lease, is restored after
   * a reconnect, re-reads its points after a resync, and emits `change` with each new snapshot.
   */
  async watch(points: string[], options: { group?: string; leaseSec?: number } = {}): Promise<Watch> {
    const watch = new Watch(this, options.group ?? `watch-${++this.nextId}`, options.leaseSec ?? 120);
    this.watches.set(watch.group, watch);
    await watch.update(points);
    return watch;
  }

  /** Live alarm events (`alarm` event). The subscription is restored after a reconnect. */
  async subscribeAlarms(options: { scope?: string; mode?: "event" | "snapshot" | "both"; limit?: number; source?: string } = {}): Promise<Json> {
    const fields: Json = { scope: "open", mode: "event", ...options };
    const reply = await this.call("subscribe_alarms", fields);
    this.alarmSubscriptions.set(JSON.stringify(fields), fields);
    return reply;
  }

  /** @internal */
  forgetWatch(group: string): void {
    this.watches.delete(group);
  }

  // ---- Internals -------------------------------------------------------------------------------

  private async ensureLogin(): Promise<void> {
    if (await this.http.health()) return;
    const { username, password } = this.options;
    if (!username || password === undefined) {
      throw new BaskStreamError(CLIENT_ERRORS.sessionExpired, "Not logged in, and no username/password was provided.");
    }
    const secret = typeof password === "function" ? await password() : password;
    await this.http.login(username, secret);
    this.options.onSession?.(this.http.getCookies());
  }

  private openSocket(): Promise<void> {
    const url = new URL(this.http.url.toString());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/stream";
    url.search = "";
    const ws = new WebSocket(url, {
      headers: { Cookie: this.http.cookieHeader() },
      origin: this.http.url.origin,
      rejectUnauthorized: this.http.verifyTls,
      ca: this.http.ca,
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: this.http.timeoutMs
    });
    return new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        this.ws = ws;
        ws.removeAllListeners("error");
        ws.on("error", () => {}); // Close handling reports failures.
        ws.on("message", (data, isBinary) => this.onFrame(data, isBinary));
        ws.on("close", (code, reason) => this.onClose(ws, code, reason.toString()));
        resolve();
      });
      ws.once("unexpected-response", (request, response) => {
        request.destroy();
        const expired = response.statusCode === 302 || response.statusCode === 401 || response.statusCode === 403;
        reject(new BaskStreamError(expired ? CLIENT_ERRORS.sessionExpired : CLIENT_ERRORS.closed,
          `The station refused the WebSocket (HTTP ${response.statusCode}).`));
      });
      ws.once("error", (error) => reject(new BaskStreamError(CLIENT_ERRORS.closed, error.message)));
    });
  }

  private onFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (!isBinary) return;
    let frame: Json;
    try {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      frame = decode(bytes) as Json;
    } catch {
      this.emit("error", new BaskStreamError(CLIENT_ERRORS.badMessage, "The station sent a frame that is not valid MessagePack."));
      return;
    }
    const id = typeof frame.id === "string" ? frame.id : undefined;
    const waiting = id ? this.pending.get(id) : undefined;
    if (waiting && id) {
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      if (frame.op === "error") waiting.reject(new BaskStreamError(String(frame.code), String(frame.message ?? frame.code), waiting.op));
      else waiting.resolve(frame);
      return;
    }
    switch (frame.op) {
      case "cov":
        this.emit("cov", frame);
        for (const snapshot of (frame.points as PointSnapshot[]) ?? []) this.deliver(snapshot);
        break;
      case "alarm_cov":
        this.emit("alarm", frame);
        break;
      case "model_cov":
        this.emit("model", frame);
        break;
      case "resync_required":
        this.emit("resync", frame);
        for (const watch of this.watches.values()) void watch.refresh().catch((error) => this.emit("error", error));
        break;
      case "subscriptions_revoked":
        this.emit("revoked", frame);
        break;
      default:
        this.emit("notice", frame);
    }
  }

  private deliver(snapshot: PointSnapshot): void {
    this.emit("value", snapshot);
    for (const watch of this.watches.values()) watch.accept(snapshot);
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.stopKeepAlive();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BaskStreamError(CLIENT_ERRORS.closed, `Connection closed (${code}${reason ? `: ${reason}` : ""}).`, entry.op));
      this.pending.delete(id);
    }
    this.emit("disconnected", { code, reason });
    if (!this.closedByUser && this.options.reconnect !== false) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delayMs = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
    this.reconnectTimer = setTimeout(() => void this.reconnect(), delayMs);
  }

  private async reconnect(): Promise<void> {
    if (this.closedByUser) return;
    try {
      await this.open();
      for (const watch of this.watches.values()) await watch.restore();
      for (const fields of this.alarmSubscriptions.values()) await this.call("subscribe_alarms", fields);
      this.reconnectAttempt = 0;
      this.emit("reconnected");
    } catch (error) {
      this.emit("error", error);
      if (!this.connected) this.scheduleReconnect();
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    const heartbeatSec = Number((this.capabilities.limits as Json | undefined)?.heartbeatIntervalSec) || 25;
    const every = this.options.keepAliveMs ?? Math.max(5000, heartbeatSec * 1000 - 5000);
    this.keepAlive = setInterval(() => void this.call("ping").catch(() => {}), every);
    this.keepAlive.unref();
  }

  private stopKeepAlive(): void {
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
  }
}

/**
 * A named subscription group: the latest value of each point, lease renewal, and restoration
 * after reconnects. Emits `change` (PointSnapshot).
 */
export class Watch extends EventEmitter {
  readonly values = new Map<string, PointSnapshot>();
  private points: string[] = [];
  private renewTimer?: NodeJS.Timeout;

  constructor(private readonly client: BaskStreamClient, readonly group: string, readonly leaseSec: number) {
    super();
  }

  get pointOrds(): string[] {
    return [...this.points];
  }

  /** Replaces the watched points and reads their current values. */
  async update(points: string[]): Promise<PointSnapshot[]> {
    this.points = [...new Set(points)];
    await this.client.call("replace_subscriptions", { group: this.group, points: this.points, leaseSec: this.leaseSec });
    this.startRenewing();
    return this.refresh();
  }

  /** Re-reads every watched point (also done automatically after a resync). */
  async refresh(): Promise<PointSnapshot[]> {
    if (this.points.length === 0) return [];
    const snapshots = await this.client.read(this.points);
    for (const snapshot of snapshots) this.accept(snapshot);
    return snapshots;
  }

  /** Stops the watch and releases its subscriptions on the station. */
  async close(): Promise<void> {
    this.stopRenewing();
    this.client.forgetWatch(this.group);
    if (this.client.connected) await this.client.call("release_subscriptions", { group: this.group }).catch(() => {});
  }

  /** @internal */
  accept(snapshot: PointSnapshot): void {
    if (!this.points.includes(snapshot.point)) return;
    this.values.set(snapshot.point, snapshot);
    this.emit("change", snapshot);
  }

  /** @internal Re-creates the group after a reconnect. */
  async restore(): Promise<void> {
    await this.update(this.points);
  }

  /** @internal */
  stopRenewing(): void {
    clearInterval(this.renewTimer);
    this.renewTimer = undefined;
  }

  private startRenewing(): void {
    this.stopRenewing();
    if (this.leaseSec <= 0) return;
    this.renewTimer = setInterval(() => {
      this.client.call("renew_subscriptions", { group: this.group, leaseSec: this.leaseSec }).catch((error: BaskStreamError) => {
        // The lease lapsed (for example during a long disconnect): create the group again.
        if (error.code === "group_not_found") void this.restore().catch(() => {});
      });
    }, Math.max(1000, (this.leaseSec * 1000) / 2));
    this.renewTimer.unref();
  }
}
