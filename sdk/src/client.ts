import { EventEmitter } from "node:events";
import { decode, encode } from "@msgpack/msgpack";
import WebSocket from "ws";
import { BunSocket } from "./bun-socket.js";
import { BaskStreamError, ChangeProposedError, CLIENT_ERRORS } from "./errors.js";
import { StationHttp, type StationHttpOptions } from "./http.js";
import { OPERATIONS, type OperationName } from "./operations.js";
import { toSlotOrd } from "./ords.js";
import { snapshotPage, type PxSnapshot, type SnapshotOptions } from "./snapshot.js";
import type { Actor, AgentLog, AlarmFilter, ChangeExplanation, BrowseNode, DiscoveredItem, Discovery, FileContent, FileEntry, JobDetail, JobSummary, Json, PointSnapshot, Proposal, QueryResult, RoleMatch, ScheduleEntry, Weekday,
  GraphicsInventory, NavCheck, PxBindingCheck, PxInfo, PxNode, PxTargets, PxViewsResult } from "./types.js";

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
  /**
   * Declares who is behind this connection (for AI agents) each time it connects. The station then
   * applies its agent rules: changes need a reason, and point writes may become proposals.
   */
  actor?: Actor;
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
 * - `proposal` (Proposal, frame): an agent proposal was created or decided.
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
    if (this.options.actor) await this.call("declare_actor", { ...this.options.actor });
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
    this.failPending("Connection closed by the client.");
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
    const frame = encode({ ...fields, op, id });
    // The station closes the connection on a request over its limit, so say so here instead.
    const limit = Number((this.capabilities.limits as Json | undefined)?.maxMessageBytes) || 0;
    if (limit > 0 && frame.byteLength > limit) {
      return Promise.reject(new BaskStreamError(CLIENT_ERRORS.messageTooLarge, `This ${op} request is ${frame.byteLength} bytes, and the station takes at most ${limit} (maxMessageBytes on BASkStreamService).`, op));
    }
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
      ws.send(frame, { binary: true }, (error) => {
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
    return (await this.call("browse", { base: toSlotOrd(base), ...options })).node as BrowseNode;
  }

  async describe(ord: string, metadata: "none" | "full" = "full"): Promise<BrowseNode> {
    return (await this.call("describe", { ord: toSlotOrd(ord), metadata })).node as BrowseNode;
  }

  search(base: string, query: string, options: Json = {}): Promise<Json> {
    return this.call("search", { base: toSlotOrd(base), query, ...options });
  }

  /**
   * Current values. `fresh: true` (API 1.9+) leases points nothing is subscribed to, such as proxy
   * points only polled while watched, and waits up to `freshWaitMillis` (default 3000) for a value.
   * A string array as the second argument is `fields`, as before.
   */
  async read(points: string[], options?: string[] | { fields?: string[]; fresh?: boolean; freshWaitMillis?: number }): Promise<PointSnapshot[]> {
    const ords = points.map(toSlotOrd);
    const opts = Array.isArray(options) ? { fields: options } : options ?? {};
    const fields: Json = { points: ords };
    if (opts.fields) fields.fields = opts.fields;
    if (opts.fresh) fields.fresh = true;
    if (opts.freshWaitMillis !== undefined) fields.freshWaitMillis = opts.freshWaitMillis;
    return (await this.call("read", fields)).points as PointSnapshot[];
  }

  /**
   * Writes one point. Pass `{ reason }` in options when acting as an agent. For agents the result
   * has `outcome`: "proposed" (with a `proposal` a person must approve) or "written".
   */
  async write(point: string, action: string, value?: unknown, options: Json & { reason?: string } = {}): Promise<PointSnapshot> {
    const reply = await this.call("write", { point: toSlotOrd(point), action, ...(value === undefined ? {} : { value }), ...options });
    return (reply.points as PointSnapshot[])[0];
  }

  describeWrite(points: string[]): Promise<Json> {
    return this.call("describe_write", { points: points.map(toSlotOrd) });
  }

  async history(ord: string, options: { start?: number; end?: number; limit?: number } = {}): Promise<Json> {
    return (await this.call("read_history", { ord: toSlotOrd(ord), ...options })).history as Json;
  }

  /** Time buckets. Since API 1.9 empty buckets come back with count 0 (includeEmpty: false to drop them), plus coverage and longestGapMillis per history. */
  async historyRollup(ord: string, options: { start?: number; end?: number; interval: number; includeInvalid?: boolean; includeEmpty?: boolean }): Promise<Json> {
    return (await this.call("read_history_rollup", { ord: toSlotOrd(ord), ...options })).rollup as Json;
  }

  async alarms(options: { scope?: "open" | "ack_pending" | "all"; limit?: number; order?: "newest" | "oldest"; filter?: AlarmFilter; source?: string } = {}): Promise<Json> {
    return (await this.call("read_alarms", options as Json)).alarms as Json;
  }

  async ackAlarms(target: { uuids: string[] } | { filter: AlarmFilter; scope?: string; limit?: number }, dryRun = false, reason?: string): Promise<Json> {
    return (await this.call("ack_alarms", { ...target, dryRun, ...(reason ? { reason } : {}) })).alarms as Json;
  }

  async clearAlarms(target: { uuids: string[] } | { filter: AlarmFilter; scope?: string; limit?: number }, dryRun = false, reason?: string): Promise<Json> {
    return (await this.call("clear_alarms", { ...target, dryRun, ...(reason ? { reason } : {}) })).alarms as Json;
  }

  async schedule(ord: string, at?: number): Promise<Json> {
    const target = toSlotOrd(ord);
    return (await this.call("read_schedule", at === undefined ? { ord: target } : { ord: target, at })).schedule as Json;
  }

  async scheduleEvents(ord: string, options: { start?: number; end?: number; limit?: number } = {}): Promise<Json> {
    return (await this.call("read_schedule_events", { ord: toSlotOrd(ord), ...options })).schedule as Json;
  }

  async writeSchedule(ord: string, days: Partial<Record<Weekday, ScheduleEntry[]>>, dryRun = false, reason?: string): Promise<Json> {
    return (await this.call("write_schedule", { ord: toSlotOrd(ord), days, dryRun, ...(reason ? { reason } : {}) })).schedule as Json;
  }

  /** Says who is behind this connection; returns the agent rules that now apply. */
  async declareActor(actor: Actor): Promise<Json> {
    return (await this.call("declare_actor", { ...actor })).agents as Json;
  }

  /** Proposals this connection may see (an agent sees its own), newest first. */
  async proposals(status?: Proposal["status"]): Promise<Proposal[]> {
    return (await this.call("list_proposals", status ? { status } : {})).proposals as Proposal[];
  }

  /** Approves a proposal; the write runs with this user's permissions. People only. */
  async approveProposal(id: string): Promise<Proposal> {
    return (await this.call("approve_proposal", { proposal: id })).proposal as Proposal;
  }

  /** Rejects a proposal, with an optional note for the agent. People only. */
  async rejectProposal(id: string, note?: string): Promise<Proposal> {
    return (await this.call("reject_proposal", note ? { proposal: id, note } : { proposal: id })).proposal as Proposal;
  }

  /**
   * Every change agents asked for or made, newest first, including the ones they made directly
   * (API 1.14). An agent sees its own.
   */
  async changes(options: { status?: Proposal["status"]; kind?: NonNullable<Proposal["kind"]> } = {}): Promise<Proposal[]> {
    return (await this.call("list_changes", options as Json)).changes as Proposal[];
  }

  /**
   * Puts a change back, with this user's permissions (API 1.14). People only. Refused with
   * `change_conflict` when the target has changed since, unless `force`; a change with steps that
   * cannot be put back needs `partial`.
   */
  async revertChange(id: string, options: { force?: boolean; partial?: boolean; reason?: string } = {}): Promise<Proposal> {
    return (await this.call("revert_change", { change: id, ...options })).change as Proposal;
  }

  /**
   * The point that plays a role on a piece of equipment, from its tags and name (API 1.14):
   * `resolve("slot:/Drivers/BacnetNetwork/AHU_1", { role: "discharge air temp" })`. Inferred;
   * `point` is null when no match is clearly best.
   */
  async resolve(equip: string, want: { role?: string; tags?: string[]; limit?: number }): Promise<RoleMatch> {
    return (await this.call("resolve", { equip: toSlotOrd(equip), ...want })) as unknown as RoleMatch;
  }

  /**
   * What the station would do with a change, and which setting decides, without making it (API 1.13).
   * `change` is an operation name such as "write" or "write_file". A person may pass `user` to ask
   * about any Niagara user. Niagara roles are not judged.
   */
  async explainChange(change: string, fields: { user?: string; point?: string; path?: string; planId?: string } = {}): Promise<ChangeExplanation> {
    return (await this.call("explain_change", { change, ...fields })).explanation as ChangeExplanation;
  }

  /** "Agent" records from the station's audit history, newest first. */
  async agentLog(options: { since?: number; limit?: number } = {}): Promise<AgentLog> {
    return (await this.call("read_agent_log", options as Json)).log as AgentLog;
  }

  // ---- Headless Workbench (API 1.10+): queries, station files, jobs and discovery ----

  /** One read-only BQL select or NEQL tag query. BQL returns columns and rows; NEQL returns entities. */
  async query(query: { bql: string } | { neql: string }, options: { ord?: string; limit?: number; timeoutMillis?: number } = {}): Promise<QueryResult> {
    const fields: Json = { ...query, ...options };
    if (options.ord) fields.ord = toSlotOrd(options.ord);
    return (await this.call("query", fields, { timeoutMs: (options.timeoutMillis ?? 10000) + 20000 })).result as QueryResult;
  }

  /** A folder of the station file space, e.g. "^px". */
  async listFiles(path = "^"): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
    return (await this.call("list_files", { path })).folder as { path: string; entries: FileEntry[]; truncated: boolean };
  }

  /** A station file. UTF-8 files come back with `text`, others with `base64`, unless `encoding` says which. */
  async readFile(path: string, options: { encoding?: "text" | "base64"; maxBytes?: number } = {}): Promise<FileContent> {
    return (await this.call("read_file", { path, ...options })).file as FileContent;
  }

  /** Creates a station file, or replaces one with `overwrite: true`. A replaced Px, nav or image file is backed up first unless `backup: false`. */
  async writeFile(path: string, content: { text: string } | { base64: string }, options: { overwrite?: boolean; createDirs?: boolean; backup?: boolean; dryRun?: boolean; reason?: string } = {}): Promise<Json> {
    return (await this.call("write_file", { path, ...content, ...options })).file as Json;
  }

  /**
   * Writes a station file of any size up to 16 MiB. Content that fits one message goes as
   * `write_file`; larger content is sent in pieces (API 1.14) and committed, which is the same
   * write with the same checks. On a station before 1.14, larger content is refused with
   * `message_too_large`.
   */
  async putFile(path: string, bytes: Uint8Array, options: { overwrite?: boolean; createDirs?: boolean; backup?: boolean; reason?: string } = {}): Promise<Json> {
    const limit = Number((this.capabilities.limits as Json | undefined)?.maxMessageBytes) || 1024 * 1024;
    // base64 is a third larger than the bytes; leave room for the request's other fields.
    if (bytes.byteLength * 4 / 3 + 2048 < limit) {
      return this.writeFile(path, { base64: Buffer.from(bytes).toString("base64") }, options);
    }
    if (!(OPERATIONS as Record<string, unknown>).begin_upload || !((this.capabilities.operations as string[] | undefined) ?? []).includes("begin_upload")) {
      throw new BaskStreamError(CLIENT_ERRORS.messageTooLarge, `${path} is ${bytes.byteLength} bytes, more than one message holds (${limit}), and this station cannot take a file in pieces (it needs API 1.14).`, "write_file");
    }
    const piece = Math.max(16 * 1024, Math.min(limit - 4096, 512 * 1024));
    const started = await this.call("begin_upload", { path, overwrite: options.overwrite === true });
    for (let offset = 0; offset < bytes.byteLength; offset += piece) {
      await this.call("append_upload", { upload: started.upload, bytes: bytes.subarray(offset, Math.min(bytes.byteLength, offset + piece)) });
    }
    return (await this.call("commit_upload", { upload: started.upload, size: bytes.byteLength, ...options }, { timeoutMs: 120000 })).file as Json;
  }

  /** Deletes a station file, or a folder and its contents with `recursive: true`. */
  async deleteFile(path: string, options: { recursive?: boolean; dryRun?: boolean; reason?: string } = {}): Promise<Json> {
    return (await this.call("delete_file", { path, ...options })).file as Json;
  }

  // ---- Graphics (API 1.12) ----

  /** A Px file as data: imports, types, references and problems; with `tree: true` the element tree too. */
  async readPx(path: string, options: { tree?: boolean } = {}): Promise<PxInfo> {
    return (await this.call("read_px", { path, ...options })).px as PxInfo;
  }

  /** Checks a Px on the station (a path), or Px XML or a tree before it is written. */
  async validatePx(px: string | { text: string } | { tree: PxNode }): Promise<PxInfo> {
    const fields: Json = typeof px === "string" ? { path: px } : { ...px };
    return (await this.call("validate_px", fields)).validation as PxInfo;
  }

  /** Validates and writes a Px; refused with px_invalid when it has errors. A replaced file is backed up first. */
  async writePx(path: string, px: { text: string } | { tree: PxNode }, options: { overwrite?: boolean; backup?: boolean; createDirs?: boolean; dryRun?: boolean; reason?: string } = {}): Promise<{ file: Json; validation: PxInfo }> {
    const reply = await this.call("write_px", { path, ...px, ...options });
    return { file: reply.file as Json, validation: reply.validation as PxInfo };
  }

  /** Resolves a Px's bindings on many components at once; `suggest: true` ranks candidates for missing ones. */
  async checkPxBindings(path: string, targets: PxTargets, options: { relativeTo?: string; suggest?: boolean; cells?: boolean; timeoutMillis?: number } = {}): Promise<PxBindingCheck> {
    const fields: Json = { path, ...pxTargets(targets), ...options };
    if (options.relativeTo) fields.relativeTo = toSlotOrd(options.relativeTo);
    return (await this.call("check_px_bindings", fields, { timeoutMs: (options.timeoutMillis ?? 30000) + 20000 })).check as PxBindingCheck;
  }

  /** Adds (or with `remove: true` removes) a Px view on components, and makes it their default view. */
  async attachPxView(path: string, targets: PxTargets, options: { view?: string; default?: boolean; remove?: boolean; dryRun?: boolean; reason?: string } = {}): Promise<PxViewsResult> {
    return (await this.call("attach_px_view", { path, ...pxTargets(targets), ...options }, { timeoutMs: 60000 })).views as PxViewsResult;
  }

  /** Checks a nav file on the station (a path), or nav XML before it is written. */
  async checkNav(nav: string | { text: string }): Promise<NavCheck> {
    const fields: Json = typeof nav === "string" ? { path: nav } : { ...nav };
    return (await this.call("check_nav", fields)).nav as NavCheck;
  }

  /** Every Px and nav file, every view and what links them, with a punch list. */
  async graphicsInventory(options: { under?: string; checkBindings?: boolean; maxComponents?: number; timeoutMillis?: number } = {}): Promise<GraphicsInventory> {
    const fields: Json = { ...options };
    if (options.under) fields.under = toSlotOrd(options.under);
    return (await this.call("graphics_inventory", fields, { timeoutMs: (options.timeoutMillis ?? 30000) + 30000 })).inventory as GraphicsInventory;
  }

  /**
   * Pictures of a page as a person sees it in a web browser, with live values: a Px file
   * (`^folder/Page.px`) or a component and view. Opens it in headless Chrome, Chromium or Edge on
   * this computer with this connection's session (logging in again first if it has expired) and
   * returns PNG frames. Nothing runs on the station beyond the page loading as it would for a person.
   */
  async snapshot(page: string, options: SnapshotOptions = {}): Promise<PxSnapshot> {
    await this.ensureLogin();
    return snapshotPage(this.http, page, options);
  }

  async jobs(): Promise<JobSummary[]> {
    return (await this.call("list_jobs")).jobs as JobSummary[];
  }

  /** A job's state, log and results (discovered devices or points, for example), paged. */
  async job(job: string, options: { offset?: number; limit?: number } = {}): Promise<JobDetail> {
    return (await this.call("read_job", { job: toSlotOrd(job), ...options })).job as JobDetail;
  }

  async cancelJob(job: string, reason?: string): Promise<JobSummary> {
    return (await this.call("cancel_job", { job: toSlotOrd(job), ...(reason ? { reason } : {}) })).job as JobSummary;
  }

  /** Starts discovery on a BACnet network (devices) or device (its points). Follow the returned job with `job()`. */
  async discover(ord: string, options: { lowLimit?: number; highLimit?: number; reason?: string } = {}): Promise<Discovery> {
    return (await this.call("discover", { ord: toSlotOrd(ord), ...options }, { timeoutMs: 60000 })).discovery as Discovery;
  }

  /**
   * Turns chosen results of a discovery job into a model plan preview. Nothing is added until the
   * plan is applied with `call("apply_model_changes", { planId, planHash, idempotencyKey })`.
   */
  async addDiscovered(job: string, items: DiscoveredItem[], options: { parent?: string; verbose?: boolean } = {}): Promise<Json> {
    const fields: Json = { job: toSlotOrd(job), items: items as unknown as Json[], ...options };
    if (options.parent) fields.parent = toSlotOrd(options.parent);
    return (await this.call("add_discovered", fields, { timeoutMs: 120000 })).result as Json;
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
    const ws: WebSocket = process.versions.bun
      ? (new BunSocket(url.toString(), {
          headers: { Cookie: this.http.cookieHeader(), Origin: this.http.url.origin },
          rejectUnauthorized: this.http.verifyTls,
          ca: this.http.ca
        }) as unknown as WebSocket)
      : new WebSocket(url, {
          headers: { Cookie: this.http.cookieHeader() },
          origin: this.http.url.origin,
          rejectUnauthorized: this.http.verifyTls,
          ca: this.http.ca,
          maxPayload: 16 * 1024 * 1024,
          handshakeTimeout: this.http.timeoutMs
        });
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      // Kept for the socket's whole life: an unhandled 'error' event would crash the process.
      ws.on("error", (error: Error) => {
        if (!opened) reject(new BaskStreamError(CLIENT_ERRORS.closed, `WebSocket connection to ${url} failed: ${error.message}`));
      });
      ws.once("open", () => {
        opened = true;
        this.ws = ws;
        ws.on("message", (data, isBinary) => this.onFrame(data, isBinary));
        ws.on("close", (code, reason) => this.onClose(ws, code, reason.toString()));
        resolve();
      });
      ws.once("close", (code) => {
        if (!opened) reject(new BaskStreamError(CLIENT_ERRORS.closed, `WebSocket connection to ${url} closed during the handshake (${code}).`));
      });
      // Bun has no 'unexpected-response'; the health check before connecting catches expired sessions.
      if (!process.versions.bun) ws.once("unexpected-response", (request, response) => {
        request.destroy();
        const expired = response.statusCode === 302 || response.statusCode === 401 || response.statusCode === 403;
        reject(new BaskStreamError(expired ? CLIENT_ERRORS.sessionExpired : CLIENT_ERRORS.closed,
          `The station refused the WebSocket (HTTP ${response.statusCode}).`));
      });
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
      if (frame.op === "error" && frame.code === "change_proposed" && frame.proposal) {
        waiting.reject(new ChangeProposedError(String(frame.message ?? frame.code), waiting.op, frame.proposal as Proposal));
      } else if (frame.op === "error") waiting.reject(new BaskStreamError(String(frame.code), String(frame.message ?? frame.code), waiting.op));
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
      case "proposal_cov":
        this.emit("proposal", frame.proposal as Proposal, frame);
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
    this.failPending(`Connection closed (${code}${reason ? `: ${reason}` : ""}).`);
    this.emit("disconnected", { code, reason });
    if (!this.closedByUser && this.options.reconnect !== false) this.scheduleReconnect();
  }

  private failPending(message: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BaskStreamError(CLIENT_ERRORS.closed, message, entry.op));
      this.pending.delete(id);
    }
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
    const previous = this.points;
    this.points = [...new Set(points.map(toSlotOrd))];
    for (const point of this.values.keys()) if (!this.points.includes(point)) this.values.delete(point);
    if (this.points.length === 0) {
      // An empty group is released on the station, so there is no lease to renew.
      this.stopRenewing();
      if (previous.length > 0) await this.client.call("release_subscriptions", { group: this.group }).catch(() => {});
      return [];
    }
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
    if (this.points.length > 0) await this.update(this.points);
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

/** The target fields of a graphics request, with ORDs in slot form. */
function pxTargets(targets: PxTargets): Json {
  const fields: Json = {};
  if (targets.targets) fields.targets = targets.targets.map((ord) => toSlotOrd(ord));
  if (targets.match) fields.match = { ...targets.match, ...(targets.match.under ? { under: toSlotOrd(targets.match.under) } : {}) };
  if (targets.views) fields.views = true;
  return fields;
}
