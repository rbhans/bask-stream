// A simulated station for `bask demo` and the dashboard tests: Niagara's SCRAM login, /stream/health
// and the /stream WebSocket, backed by a small building (two air handlers, eight VAV boxes, a chilled
// water plant) whose values drift, alarms come and go, and an AI agent proposes and makes changes.
// It speaks the same protocol as the baskStream module, so the dashboard runs on it unchanged.
/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import http from "node:http";
import { decode, encode } from "@msgpack/msgpack";
import { WebSocketServer, type WebSocket } from "ws";

import { DEMO_SITES, type SiteContext, type SiteName } from "./sites.js";

export { DEMO_SITES, SITE_NAMES, type SiteName } from "./sites.js";
export const DEMO_USER = "admin";
export const DEMO_PASSWORD = "demo";
const AGENT_USER = "ai-claude";
const AGENT = { kind: "agent", name: "Claude Code", model: "claude-fable-5-2", onBehalfOf: "ben" };

type Kind = "container" | "component" | "point" | "schedule";
interface Node {
  ord: string;
  name: string;
  display: string;
  typeSpec: string;
  kind: Kind;
  children: string[];
  vt?: "numeric" | "boolean" | "enum";
  units?: string;
  precision?: number;
  texts?: [string, string];
  options?: string[];
  writable?: boolean;
  sim?: (t: number) => number | boolean | string;
  fallback?: unknown;
  override?: { value: unknown; until?: number };
  emergency?: unknown;
  alarm?: boolean;
  fault?: boolean;
  down?: boolean;
  hasHistory?: boolean;
  props?: Record<string, { typeSpec: string; encoded: string; writable?: boolean }>;
  actions?: string[];
  tags?: string[];
  week?: Record<string, { start: string; finish: string; value: unknown; text: string }[]>;
  defaultOutput?: { value: unknown; text: string };
}

export interface DemoStation {
  url: string;
  site: SiteName;
  /** The station's name, as its capabilities report it. */
  station: string;
  user: string;
  password: string;
  state: any;
  push(frame: Record<string, unknown>): void;
  dropAll(): void;
  close(): Promise<void>;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MIN = 60000;
const HOUR = 3600000;

const noise = (seed: number, t: number) => {
  const x = Math.sin(seed * 12.9898 + Math.floor(t / MIN) * 78.233) * 43758.5453;
  return x - Math.floor(x) - 0.5;
};
/**
 * A value that moves around `base` the way building data does: a swing over the day, a slower drift
 * of a few hours, and a small quick ripple so live values keep ticking. `periodMin` sets the ripple.
 */
const wave = (base: number, amp: number, periodMin: number, seed: number) => (t: number) => {
  const d = new Date(t);
  const hour = d.getHours() + d.getMinutes() / 60;
  const day = Math.sin(((hour - 8 + (seed % 5)) / 24) * 2 * Math.PI);
  const drift = Math.sin((2 * Math.PI * t) / ((170 + (seed % 7) * 35) * MIN) + seed);
  const ripple = Math.sin((2 * Math.PI * t) / ((periodMin / 6) * MIN) + seed * 1.7);
  return base + amp * (0.55 * day + 0.3 * drift + 0.12 * ripple) + noise(seed, t) * amp * 0.06;
};
/** Outdoor air: one cycle a day, warmest mid-afternoon local time. */
const outdoor = (t: number) => {
  const d = new Date(t);
  const hour = d.getHours() + d.getMinutes() / 60;
  return 66 + 13 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + noise(7, t) * 0.8;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Niagara's audit timestamp text, e.g. "12-Nov-26 12:50 PM MST". */
const stamp = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(2)} ${h % 12 || 12}:${pad2(d.getMinutes())} ${h < 12 ? "AM" : "PM"} MST`;
};

export async function startDemoStation(options: { live?: boolean; port?: number; site?: SiteName } = {}): Promise<DemoStation> {
  const live = options.live !== false;
  const site = DEMO_SITES[options.site ?? "northgate"];
  const stationName = site.station;
  const started = Date.now();
  /** Simulation time: frozen when not live so tests see steady values. */
  const clock = () => (live ? Date.now() : started);

  // ---- The station tree ---------------------------------------------------------------------------
  const nodes = new Map<string, Node>();
  nodes.set("slot:/", { ord: "slot:/", name: "Config", display: "Config", typeSpec: "baja:Station", kind: "container", children: [], actions: ["save"] });
  const add = (parent: string, name: string, typeSpec: string, kind: Kind, extra: Partial<Node> = {}): string => {
    const ord = parent === "slot:/" ? `slot:/${name}` : `${parent}/${name}`;
    nodes.set(ord, { ord, name, display: name, typeSpec, kind, children: [], ...extra });
    nodes.get(parent)!.children.push(ord);
    return ord;
  };
  let seed = 1;
  const num = (parent: string, name: string, units: string, sim: (t: number) => number, extra: Partial<Node> = {}) =>
    add(parent, name, "control:NumericPoint", "point", { vt: "numeric", units, precision: 1, sim, hasHistory: true, ...extra });
  const numW = (parent: string, name: string, units: string, value: number, extra: Partial<Node> = {}) =>
    add(parent, name, "control:NumericWritable", "point", { vt: "numeric", units, precision: 1, writable: true, fallback: value, hasHistory: true, ...extra });
  const bool = (parent: string, name: string, texts: [string, string], value: boolean, extra: Partial<Node> = {}) =>
    add(parent, name, extra.writable ? "control:BooleanWritable" : "control:BooleanPoint", "point", { vt: "boolean", texts, fallback: value, ...extra });
  const enumW = (parent: string, name: string, optionTags: string[], value: string, extra: Partial<Node> = {}) =>
    add(parent, name, "control:EnumWritable", "point", { vt: "enum", options: optionTags, writable: true, fallback: value, ...extra });

  const services = add("slot:/", "Services", "baja:ServiceContainer", "container");
  for (const [name, type] of [["AlarmService", "alarm:AlarmService"], ["HistoryService", "history:HistoryService"], ["JobService", "baja:JobService"], ["UserService", "baja:UserService"], ["BASkStreamService", "baskStream:BaskStreamService"]])
    add(services, name, type, "component");
  const drivers = add("slot:/", "Drivers", "driver:DriverContainer", "container");
  const network = add(drivers, "BacnetNetwork", "bacnet:BacnetNetwork", "container", {
    actions: ["ping", "submitDeviceManagerJob"],
    props: { enabled: { typeSpec: "baja:Boolean", encoded: "true", writable: true }, health: { typeSpec: "baja:String", encoded: "Ok [12-Nov-26 2:04 PM MST]" } }
  });
  const addNetwork = (name: string, typeSpec: string) =>
    add(drivers, name, typeSpec, "container", { actions: ["ping"], props: { enabled: { typeSpec: "baja:Boolean", encoded: "true", writable: true }, health: { typeSpec: "baja:String", encoded: "Ok [12-Nov-26 2:04 PM MST]" } } });
  const device = (name: string, instance: number, address: string, extra: Partial<Node> = {}, parent = network) => {
    const ord = add(parent, name, "bacnet:BacnetDevice", "container", {
      actions: ["ping", "upload"],
      props: {
        enabled: { typeSpec: "baja:Boolean", encoded: "true", writable: true },
        address: { typeSpec: "baja:String", encoded: address, writable: true },
        objectId: { typeSpec: "bacnet:BacnetObjectIdentifier", encoded: `device:${instance}`, writable: true },
        pollFrequency: { typeSpec: "driver:PollFrequency", encoded: "normal", writable: true },
        health: { typeSpec: "baja:String", encoded: extra.down ? "Fail [12-Nov-26 1:41 PM MST] No response to ping" : "Ok [12-Nov-26 2:04 PM MST]" }
      },
      ...extra
    });
    return add(ord, "points", String(nodes.get(ord)!.typeSpec).replace(/Device$/, "PointDeviceExt"), "container", { display: "Points" });
  };

  const point = (path: string, net = network) => `${net}/${path.replace("/", "/points/")}`;
  const schedules = add("slot:/", "Schedules", "baja:Folder", "container");
  const weekdays = (entries: any[], weekend: any[] = []) =>
    Object.fromEntries(DAYS.map((day) => [day, day === "saturday" || day === "sunday" ? weekend : entries]));
  // What the site builds with. The rest is filled in below as each piece is defined.
  const c = { add, num, numW, bool, enumW, device, network: addNetwork, point, net: network, nodes, schedules, weekdays, wave, outdoor, agentUser: AGENT_USER, past: (minutesAgo: number) => Date.now() - minutesAgo * MIN } as unknown as SiteContext;
  site.tree(c);

  // ---- Values -------------------------------------------------------------------------------------
  const deviceOf = (ord: string): Node | undefined => {
    for (let at = ord; at.lastIndexOf("/") > 5; at = at.slice(0, at.lastIndexOf("/"))) {
      const n = nodes.get(at);
      if (n && /Device$/.test(n.typeSpec)) return n;
    }
    return undefined;
  };
  const effective = (p: Node, t: number): { value: unknown; level?: number } => {
    if (p.emergency !== undefined) return { value: p.emergency, level: 1 };
    if (p.override && (!p.override.until || p.override.until > t)) return { value: p.override.value, level: 8 };
    if (p.sim) return { value: p.sim(t), level: p.writable ? 16 : undefined };
    return { value: p.fallback, level: p.writable ? 17 : undefined };
  };
  const display = (p: Node, value: unknown) => {
    if (p.vt === "numeric") return `${Number(value).toFixed(p.precision ?? 1)} ${p.units ?? ""}`.trim();
    if (p.vt === "boolean") return value ? p.texts?.[0] ?? "true" : p.texts?.[1] ?? "false";
    return String(value);
  };
  const facetsOf = (p: Node) =>
    p.vt === "numeric" ? { units: p.units, precision: String(p.precision ?? 1) } : p.vt === "boolean" ? { trueText: p.texts?.[0], falseText: p.texts?.[1] } : { range: p.options };
  const snapshot = (ord: string, t = clock()): any => {
    const p = nodes.get(ord);
    if (!p || p.kind !== "point") return { point: ord, ok: false, code: "invalid_point", message: ord.replace(/^slot:/, "") };
    const eff = effective(p, t);
    const flags: string[] = [];
    if (deviceOf(ord)?.down) flags.push("down", "stale");
    if (p.fault) flags.push("fault");
    if (p.alarm) flags.push("alarm");
    if (eff.level === 8 || eff.level === 1) flags.push("overridden");
    const digits = (p.precision ?? 1) + 1;
    const value = p.vt === "numeric" ? Math.round(Number(eff.value) * 10 ** digits) / 10 ** digits : eff.value;
    return {
      point: ord, ok: true, statusOk: flags.length === 0, state: flags[0] ?? "ok", display: p.display, valueType: p.vt, value,
      displayValue: display(p, value), status: `{${flags.join(",") || "ok"}}${p.writable ? ` @ ${eff.level === 17 ? "def" : eff.level}` : ""}`,
      timestamp: Date.now(), facets: facetsOf(p), ...(p.writable ? { activeLevel: eff.level === 17 ? "def" : String(eff.level) } : {}),
      ...(p.vt === "enum" ? { enumTag: String(value), enumOptions: (p.options ?? []).map((tag, ordinal) => ({ ordinal, tag, display: tag })) } : {})
    };
  };

  // ---- Alarms -------------------------------------------------------------------------------------
  const alarms = new Map<string, any>();
  let alarmSeq = 0;
  const raise = (source: string, message: string, o: { cls?: string; priority?: number; state?: string; ago?: number; acked?: boolean } = {}) => {
    // An alarm that is already open is not raised a second time.
    const existing = [...alarms.values()].find((a) => a.isOpen && a.sources[0] === source && a.message === message);
    if (existing) return existing;
    const uuid = `a${String(++alarmSeq).padStart(3, "0")}-${crypto.randomBytes(3).toString("hex")}`;
    const alarm = {
      uuid, timestamp: Date.now() - (o.ago ?? 0), sourceState: o.state ?? "offnormal", ackState: o.acked ? "acked" : "unacked", ackRequired: true, isOpen: true,
      alarmClass: o.cls ?? "default", alarmClassDisplay: o.cls ?? "default", priority: o.priority ?? 120, sources: [source], message,
      data: { msgText: message, sourceName: source.split("/").slice(-3).join(" ") }, transition: o.state ?? "offnormal"
    };
    alarms.set(uuid, alarm);
    return alarm;
  };
  Object.assign(c, { raise, alarms });
  site.alarms(c);

  // ---- AI agents: proposals, the agent log and the station's audit history -----------------------
  const proposals = new Map<string, any>();
  const agentLog: any[] = [];
  const audit: any[] = [];
  const auditAdd = (at: number, user: string, operation: string, target: string, slotName = "", oldValue = "", value = "") => {
    const text = `${stamp(at)}[${user}] ${operation}${slotName ? `;slotName=${slotName}` : ""}${oldValue ? `;oldValue=${oldValue}` : ""}${value ? `;value=${value}` : ""}`;
    audit.push({ timestamp: at, recordType: "history:AuditRecord", summary: `${stamp(at)} ${operation} ${target} ${slotName} ${oldValue} ${value} ${user}`, value: text, valueType: "history:AuditRecord" });
    if (audit.length > 600) audit.shift();
  };
  const agentRecord = (at: number, user: string, target: string, action: string, fields: Record<string, unknown>) => {
    const record = { timestamp: at, user, target, action, ...fields };
    agentLog.push(record);
    const text = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join("; ");
    auditAdd(at, user, "Agent", target.replace(/^slot:/, ""), action, "", text);
    return record;
  };
  const who = { agentUser: AGENT_USER, agent: AGENT.name, model: AGENT.model, for: AGENT.onBehalfOf };
  let proposalSeq = 0;
  const propose = (ord: string, action: string, value: unknown, reason: string, at = Date.now(), minutes?: number) => {
    const p = nodes.get(ord)!;
    const id = `P${++proposalSeq}`;
    const description = action === "auto" ? "auto (release override)" : `${action} ${display(p, value)}${minutes ? ` for ${minutes} min` : ""}`;
    const proposal = {
      id, status: "pending", point: ord, display: p.display, action, value, description, reason, agentUser: AGENT_USER, actor: AGENT,
      createdAt: at, expiresAt: at + 15 * MIN, decidedBy: null, decidedAt: null, note: null, result: null, durationSec: minutes ? minutes * 60 : undefined
    };
    proposals.set(id, proposal);
    agentRecord(at, AGENT_USER, ord, action, { outcome: `proposed ${id}`, ...who, change: description, reason });
    return proposal;
  };
  const decide = (proposal: any, status: string, by: string, at = Date.now(), note: string | null = null) => {
    Object.assign(proposal, { status, decidedBy: by, decidedAt: at, note });
    agentRecord(at, by, proposal.point, proposal.action, { outcome: `${status} ${proposal.id}${status === "expired" ? "" : ` by ${by}`}`, ...who, change: proposal.description, reason: proposal.reason });
  };
  const pendingCount = () => [...proposals.values()].filter((p) => p.status === "pending").length;

  // A day of history so the activity page has something to show before the first live event.
  Object.assign(c, { propose, decide, agentRecord, auditAdd, who, pendingCount });
  site.history(c);

  // ---- Files and jobs -----------------------------------------------------------------------------
  const files = new Map<string, { text: string; modified: number }>();
  const file = (path: string, text: string, hoursAgo = 30) => files.set(path, { text, modified: Date.now() - hoursAgo * HOUR });
  Object.assign(c, { file });
  site.files(c);

  const jobs = new Map<string, any>();
  let jobSeq = 0;
  const startJob = (kind: "devices" | "points", target: string) => {
    const name = `${kind === "devices" ? "BacnetDiscoverDevicesJob" : "BacnetDiscoverPointsJob"}${jobSeq ? jobSeq : ""}`;
    jobSeq += 1;
    const job = `slot:/Services/JobService/${name}`;
    const results = kind === "devices"
      ? [["VAV_109", 2009, "MSTP 2:19", "Zone controller"], ["VAV_110", 2010, "MSTP 2:20", "Zone controller"], ["RTU_03", 1003, "192.168.10.13", "Rooftop unit"], ["Lighting_Panel_A", 4001, "192.168.10.40", "Lighting controller"]].map(
          ([deviceName, id, address, modelName], i) => ({ slot: `DiscoveryDevice${i || ""}`, typeSpec: "bacnet:DiscoveryDevice", values: { deviceName, objectId: `device:${id}`, address, modelName } }))
      : [["ZoneTemp", "analogInput:1", "Zone temperature", 72.4], ["ZoneSetpoint", "analogValue:1", "Zone temperature setpoint", 72], ["Airflow", "analogInput:2", "Supply airflow", 455], ["DamperPosition", "analogOutput:1", "Damper command", 48], ["ReheatValve", "analogOutput:2", "Reheat valve command", 0],
          ["OccupancyMode", "multiStateValue:1", "Occupancy mode", "occupied"], ["FanStatus", "binaryInput:1", "Fan status", "active"], ["ZoneCO2", "analogInput:3", "Zone CO₂", 612], ["ZoneHumidity", "analogInput:4", "Zone relative humidity", 41.5], ["DischargeAirTemp", "analogInput:5", "Discharge air temperature", 58.2]].map(
          ([objectName, objectId, description, value], i) => ({ slot: `dc${i}`, typeSpec: "bacnet:DiscoveryPoint", values: { objectName, objectId, description, value } }));
    jobs.set(job, { job, name, display: kind === "devices" ? "Bacnet Discover Devices" : "Bacnet Discover Points", typeSpec: `bacnet:${name.replace(/\d+$/, "")}`, kind, target, startedAt: Date.now(), duration: live ? 6000 : 0, results, canceled: false });
    return job;
  };
  const jobWire = (j: any, detail = false, offset = 0, limit = 1000) => {
    const elapsed = Date.now() - j.startedAt;
    const done = elapsed >= j.duration;
    const state = j.canceled ? "canceled" : done ? "success" : "running";
    const complete = state !== "running";
    const summary = { job: j.job, name: j.name, display: j.display, typeSpec: j.typeSpec, state, complete, progress: complete ? 100 : Math.round((elapsed / j.duration) * 100), startTime: j.startedAt, endTime: complete ? j.startedAt + j.duration : null };
    if (!detail) return summary;
    const steps = j.kind === "devices"
      ? [["Running", "Finding BACnet Devices..."], ["Message", "Who-Is: Global Broadcast, All Devices"], ["Message", `Found ${j.results.length} BACnet devices`], ["Message", "Reading device parameters"], ["Success", "Device discovery complete."]]
      : [["Running", "Beginning object discovery..."], ["Message", `Object list size: ${j.results.length}`], ["Message", "Reading Object_Names..."], ["Message", "Reading Object properties..."], ["Success", "Object discovery complete."]];
    const shown = complete ? steps.length : Math.max(1, Math.floor((elapsed / j.duration) * steps.length));
    const log = steps.slice(0, shown).map(([kind, message], i) => ({ kind, timestamp: j.startedAt + Math.round((i / steps.length) * j.duration), message }));
    const results = state === "success" ? j.results : [];
    return { ...summary, log, logItems: log.length, results: results.slice(offset, offset + limit), resultCount: results.length, nextOffset: offset + limit < results.length ? offset + limit : null, discovery: j.kind };
  };

  // ---- Model plans --------------------------------------------------------------------------------
  const plans = new Map<string, { hash: string; changes: any[]; apply: () => any[] }>();
  const refuse = (code: string, message: string) => Object.assign(new Error(message), { code });
  const need = (ord: string) => {
    const n = nodes.get(ord);
    if (!n) throw refuse("invalid_component", `No component at ${ord}.`);
    return n;
  };
  const rekey = (from: string, to: string) => {
    for (const [ord, n] of [...nodes]) {
      if (ord !== from && !ord.startsWith(`${from}/`)) continue;
      nodes.delete(ord);
      n.ord = to + ord.slice(from.length);
      n.children = n.children.map((c) => to + c.slice(from.length));
      nodes.set(n.ord, n);
    }
  };
  const parentOf = (ord: string) => (ord.lastIndexOf("/") <= 5 ? "slot:/" : ord.slice(0, ord.lastIndexOf("/")));
  const planFor = (user: string, changes: any[]) => {
    if (!Array.isArray(changes) || changes.length === 0) throw refuse("bad_request", "changes must be a nonempty array.");
    const steps = changes.map((c, index) => {
      switch (c.action) {
        case "update": {
          const n = need(c.ord);
          for (const name of Object.keys(c.properties ?? {})) if (!n.props?.[name] && !(name === "fallback" && n.writable) && name !== "displayName") throw refuse("invalid_slot", `${n.name} has no property "${name}".`);
          return { wire: { action: "update", ord: c.ord, properties: Object.fromEntries(Object.entries(c.properties ?? {}).map(([k, v]: [string, any]) => [k, { before: n.props?.[k]?.encoded ?? null, after: v.encoded }])) },
            run: () => {
              for (const [name, v] of Object.entries<any>(c.properties ?? {})) {
                const before = n.props?.[name]?.encoded ?? "";
                if (name === "displayName") n.display = v.encoded;
                else if (name === "fallback") n.fallback = n.vt === "numeric" ? Number(v.encoded) : n.vt === "boolean" ? v.encoded === "true" : v.encoded;
                else n.props![name].encoded = String(v.encoded);
                if (name === "enabled" && /Device$/.test(n.typeSpec)) n.down = v.encoded !== "true";
                auditAdd(Date.now(), user, "Changed", c.ord.replace(/^slot:/, ""), name, before, String(v.encoded));
              }
              return { index, action: "update", ord: c.ord, ok: true };
            } };
        }
        case "rename": {
          const n = need(c.ord);
          const to = `${parentOf(c.ord)}/${c.name}`.replace("slot://", "slot:/");
          if (nodes.has(to)) throw refuse("name_collision", `${c.name} already exists.`);
          return { wire: { action: "rename", ord: c.ord, name: c.name, newOrd: to }, run: () => {
            const parent = nodes.get(parentOf(c.ord))!;
            parent.children = parent.children.map((o) => (o === c.ord ? to : o));
            const old = n.name;
            n.name = c.name;
            if (n.display === old) n.display = c.name;
            rekey(c.ord, to);
            auditAdd(Date.now(), user, "Renamed", parentOf(c.ord).replace(/^slot:/, ""), old, old, c.name);
            return { index, action: "rename", ord: to, ok: true };
          } };
        }
        case "delete": {
          const n = need(c.ord);
          if (n.children.length && !c.recursive) throw refuse("bad_request", `${n.name} has children; send recursive: true to delete them too.`);
          return { wire: { action: "delete", ord: c.ord, recursive: Boolean(c.recursive) }, run: () => {
            const parent = nodes.get(parentOf(c.ord))!;
            parent.children = parent.children.filter((o) => o !== c.ord);
            for (const ord of [...nodes.keys()]) if (ord === c.ord || ord.startsWith(`${c.ord}/`)) nodes.delete(ord);
            auditAdd(Date.now(), user, "Removed", parentOf(c.ord).replace(/^slot:/, ""), n.name);
            return { index, action: "delete", deletedOrd: c.ord, ok: true };
          } };
        }
        case "create": {
          need(c.parent);
          const ord = `${c.parent}/${c.name}`.replace("slot://", "slot:/");
          if (nodes.has(ord)) throw refuse("name_collision", `${c.name} already exists.`);
          return { wire: { action: "create", parent: c.parent, name: c.name, ord, typeSpec: c.typeSpec }, run: () => {
            const isPoint = /^control:/.test(c.typeSpec);
            const vt = /Boolean/.test(c.typeSpec) ? "boolean" : /Enum/.test(c.typeSpec) ? "enum" : "numeric";
            add(c.parent, c.name, c.typeSpec, isPoint ? "point" : /Device$/.test(c.typeSpec) ? "container" : "component", isPoint
              ? { vt, writable: /Writable/.test(c.typeSpec), units: c.units, precision: 1, texts: ["Active", "Inactive"], options: ["occupied", "unoccupied", "standby"], fallback: c.value ?? (vt === "numeric" ? 0 : vt === "boolean" ? false : "occupied"), sim: c.sim }
              : { actions: /Device$/.test(c.typeSpec) ? ["ping"] : [], props: /Device$/.test(c.typeSpec) ? { enabled: { typeSpec: "baja:Boolean", encoded: "true", writable: true }, address: { typeSpec: "baja:String", encoded: c.address ?? "", writable: true } } : {} });
            if (/Device$/.test(c.typeSpec)) add(ord, "points", "bacnet:BacnetPointDeviceExt", "container", { display: "Points" });
            auditAdd(Date.now(), user, "Added", c.parent.replace(/^slot:/, ""), c.name, "", c.typeSpec);
            return { index, action: "create", ord, ok: true };
          } };
        }
        case "invoke": {
          const n = need(c.ord);
          if (!n.actions?.includes(c.slot) && !(n.kind === "point")) throw refuse("invalid_slot", `${n.name} has no action "${c.slot}".`);
          return { wire: { action: "invoke", ord: c.ord, slot: c.slot, parameter: c.parameter ?? null }, run: () => {
            auditAdd(Date.now(), user, "Invoked", c.ord.replace(/^slot:/, "") || "/", c.slot, "", c.parameter?.encoded ?? "");
            return { index, action: "invoke", ord: c.ord, slot: c.slot, ok: true, outcome: c.slot === "save" ? "completed" : "submitted" };
          } };
        }
        default:
          throw refuse("bad_request", `The demo station does not support "${c.action}" changes.`);
      }
    });
    const planId = crypto.randomUUID();
    const hash = crypto.createHash("sha256").update(JSON.stringify(steps.map((s) => s.wire))).digest("hex");
    plans.set(planId, { hash, changes: steps.map((s) => s.wire), apply: () => steps.map((s) => s.run()) });
    return { planId, planHash: hash, state: "preview", expiresAt: Date.now() + 300000, changes: steps.map((s) => s.wire), results: [], atomic: false, unattempted: steps.length };
  };

  // ---- Wire shapes --------------------------------------------------------------------------------
  const wire = (n: Node, depth = 0): any => ({
    ord: n.ord, slotPath: n.ord, name: n.name, display: n.display, typeSpec: n.typeSpec, kind: n.kind, hasChildren: n.children.length > 0,
    ...(n.kind === "point" ? { status: snapshot(n.ord).status, writable: Boolean(n.writable), features: ["point", ...(n.hasHistory ? ["history"] : [])] } : {}),
    ...(/Device$|Network$/.test(n.typeSpec) ? { status: n.down ? "{down}" : "{ok}", ok: !n.down } : {}),
    ...(n.kind === "schedule" ? { features: ["schedule"] } : {}),
    ...(depth > 0 ? { children: n.children.map((c) => wire(nodes.get(c)!, depth - 1)) } : {})
  });
  const brief = (n: Node) => ({ ord: n.ord, slotPath: n.ord, name: n.name, display: n.display, typeSpec: n.typeSpec });
  const describe = (n: Node) => {
    const dev = deviceOf(n.ord);
    const ancestors: any[] = [];
    for (let at = parentOf(n.ord); ; at = parentOf(at)) {
      ancestors.unshift(brief(nodes.get(at)!));
      if (at === "slot:/") break;
    }
    const isPoint = n.kind === "point";
    const snap = isPoint ? snapshot(n.ord) : undefined;
    const tags = [{ id: "n:name", value: n.name }, { id: "n:type", value: n.typeSpec }, { id: "n:station", value: stationName }, ...(isPoint ? [{ id: "n:point", value: "Marker" }] : []), ...(n.hasHistory ? [{ id: "n:history", value: `/${stationName}/${n.ord.split("/").slice(-3).filter((s) => s !== "points").join("_")}` }] : []), ...(n.tags ?? []).map((id) => ({ id, value: "Marker" }))];
    return {
      ...wire(n), description: n.typeSpec,
      metadata: {
        classification: { isComponent: true, isControlPoint: isPoint, isWritablePoint: Boolean(n.writable), isDriverDevice: /Device$/.test(n.typeSpec), isDriverNetwork: /Network$/.test(n.typeSpec), isSchedule: n.kind === "schedule", hasHistory: Boolean(n.hasHistory), hasAlarm: Boolean(n.alarm) },
        parent: n.ord === "slot:/" ? null : brief(nodes.get(parentOf(n.ord))!),
        ancestors: n.ord === "slot:/" ? [] : ancestors,
        ...(dev ? { driver: { isDriverBacked: true, network: { ...brief(nodes.get(parentOf(dev.ord))!), status: "{ok}" }, device: { ...brief(dev), status: dev.down ? "{down}" : "{ok}" }, ...(isPoint ? { proxyExtType: `bacnet:Bacnet${n.vt === "numeric" ? "Numeric" : n.vt === "boolean" ? "Boolean" : "Enum"}ProxyExt`, readWriteMode: n.writable ? "RW" : "RO", tuningPolicyName: "defaultPolicy" } : {}) } } : {}),
        ...(isPoint ? {
          point: { recognizedAsPoint: true, writable: Boolean(n.writable), facets: facetsOf(n), hasHistoryExt: Boolean(n.hasHistory), hasAlarmExt: Boolean(n.alarm), activeLevel: snap.activeLevel },
          write: n.writable ? { writable: true, valueKind: n.vt, actions: ["set", "override", "auto", "emergency_override", "emergency_auto"], supportsDuration: true, activeLevel: snap.activeLevel } : { writable: false },
          history: n.hasHistory ? { hasHistory: true, count: 1, histories: [{ historyId: tags.find((t) => t.id === "n:history")!.value, enabled: true, config: { capacity: "2016 records", interval: "5 minutes", fullPolicy: "Roll" } }] } : { hasHistory: false, count: 0, histories: [] },
          alarm: { hasAlarm: Boolean(n.alarm), count: n.alarm ? 1 : 0 },
          facets: facetsOf(n)
        } : {}),
        tags
      }
    };
  };
  const typed = (typeSpec: string, encoded: string) => ({ typeSpec, encoded });
  const slotsOf = (n: Node) => {
    const slots: any[] = [];
    const prop = (name: string, typeSpec: string, value: any, writable = false) => slots.push({ name, kind: "property", dynamic: false, flags: writable ? 0 : 1, facets: "", typeSpec, writable, value });
    const action = (name: string, parameterType: string | null = null) => slots.push({ name, kind: "action", dynamic: false, flags: 0, facets: "", parameterType, returnType: null, parameterDefault: parameterType ? typed(parameterType, parameterType === "baja:Boolean" ? "false" : "0.0") : null, invokable: true });
    if (n.kind === "point") {
      const snap = snapshot(n.ord);
      const vtType = n.vt === "numeric" ? "baja:Double" : n.vt === "boolean" ? "baja:Boolean" : "baja:DynamicEnum";
      const statusType = `baja:Status${n.vt === "numeric" ? "Numeric" : n.vt === "boolean" ? "Boolean" : "Enum"}`;
      prop("facets", "baja:Facets", typed("baja:Facets", n.vt === "numeric" ? `units=u:${n.units}|precision=i:${n.precision ?? 1}` : n.vt === "boolean" ? `trueText=s:${n.texts?.[0]}|falseText=s:${n.texts?.[1]}` : `range=E:{${(n.options ?? []).join(",")}}`), true);
      prop("proxyExt", "control:AbstractProxyExt", { typeSpec: `bacnet:Bacnet${n.vt === "numeric" ? "Numeric" : n.vt === "boolean" ? "Boolean" : "Enum"}ProxyExt`, expand: true });
      prop("out", statusType, { typeSpec: statusType, properties: { status: typed("baja:Status", snap.status), value: typed(vtType, String(snap.value)) } });
      if (n.writable) {
        prop("fallback", statusType, { typeSpec: statusType, properties: { status: typed("baja:Status", "{ok}"), value: typed(vtType, String(n.fallback)) } }, true);
        for (const name of ["emergencyOverride", "override", "set"]) action(name, vtType);
        for (const name of ["emergencyAuto", "auto"]) action(name);
      }
    }
    if (n.kind !== "point") prop("displayName", "baja:String", typed("baja:String", n.display), true);
    for (const [name, p] of Object.entries(n.props ?? {})) prop(name, p.typeSpec, typed(p.typeSpec, p.encoded), Boolean(p.writable));
    for (const name of n.actions ?? []) action(name);
    for (const child of n.children) {
      const c = nodes.get(child)!;
      if (c.kind !== "point") prop(c.name, c.typeSpec, { typeSpec: c.typeSpec, expand: true });
    }
    return slots;
  };

  // Schedules: the output at a time, and when it changes over a window.
  const outputAt = (s: Node, t: number) => {
    const d = new Date(t);
    const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const entry = (s.week?.[DAYS[d.getDay()]] ?? []).find((e) => e.start <= hhmm && hhmm < e.finish);
    return entry ? { value: entry.value, text: entry.text } : s.defaultOutput!;
  };
  const valueWire = (o: { value: unknown; text: string }) => ({ ok: true, valueType: typeof o.value === "boolean" ? "baja:Boolean" : typeof o.value === "number" ? "baja:Double" : "baja:DynamicEnum", value: o.value, displayValue: o.text, status: "{ok}" });
  const eventsOf = (s: Node, start: number, end: number) => {
    const events: any[] = [{ time: start, value: valueWire(outputAt(s, start)) }];
    const day = new Date(start);
    day.setHours(0, 0, 0, 0);
    for (let t = day.getTime(); t < end; t += 24 * HOUR) {
      for (const e of s.week?.[DAYS[new Date(t).getDay()]] ?? []) {
        for (const [time, isStart] of [[e.start, true], [e.finish, false]] as [string, boolean][]) {
          const [h, m] = time.split(":").map(Number);
          const at = t + h * HOUR + m * MIN;
          if (at > start && at < end) events.push({ time: at, value: valueWire(isStart ? { value: e.value, text: e.text } : outputAt(s, at)) });
        }
      }
    }
    return events.sort((a, b) => a.time - b.time).filter((e, i, list) => i === 0 || e.value.displayValue !== list[i - 1].value.displayValue);
  };

  // A small BQL: select <columns> from <type> [where <flag or comparison>].
  const TYPE_MATCH: Record<string, (n: Node) => boolean> = {
    "control:ControlPoint": (n) => n.kind === "point", "control:NumericPoint": (n) => n.vt === "numeric", "control:NumericWritable": (n) => n.vt === "numeric" && !!n.writable,
    "control:BooleanPoint": (n) => n.vt === "boolean", "control:BooleanWritable": (n) => n.vt === "boolean" && !!n.writable, "control:EnumPoint": (n) => n.vt === "enum", "control:EnumWritable": (n) => n.vt === "enum" && !!n.writable,
    "driver:Device": (n) => /Device$/.test(n.typeSpec), "bacnet:BacnetDevice": (n) => /Device$/.test(n.typeSpec), "driver:DeviceNetwork": (n) => /Network$/.test(n.typeSpec), "bacnet:BacnetNetwork": (n) => /Network$/.test(n.typeSpec),
    "schedule:AbstractSchedule": (n) => n.kind === "schedule", "schedule:WeeklySchedule": (n) => n.kind === "schedule", "baja:Component": () => true, "baja:Folder": (n) => n.typeSpec === "baja:Folder",
    "history:HistoryExt": (n) => !!n.hasHistory, "alarm:AlarmSourceExt": (n) => !!n.alarm || !!n.fault, "control:IWritablePoint": (n) => !!n.writable, "baja:User": () => false
  };
  const column = (n: Node, name: string): unknown => {
    const snap = n.kind === "point" ? snapshot(n.ord) : undefined;
    const dev = /Device$|Network$/.test(n.typeSpec);
    switch (name) {
      case "name": return n.name;
      case "displayName": case "toDisplayName": return n.display;
      case "slotPath": return n.ord;
      case "type": return n.typeSpec;
      case "parent.slotPath": return n.ord;
      case "historyConfig.id": return n.hasHistory ? `/${stationName}/${n.ord.split("/").slice(-3).filter((s) => s !== "points").join("_")}` : null;
      case "historyConfig.capacity": return n.hasHistory ? "2016 records" : null;
      case "alarmClass": return n.alarm ? "critical" : n.fault ? "critical" : null;
      case "activeLevel": return snap?.activeLevel ?? null;
      case "parent.name": return nodes.get(parentOf(n.ord))?.name;
      case "parent.parent.name": return nodes.get(parentOf(parentOf(n.ord)))?.name;
      case "out": return snap ? `${snap.displayValue} ${snap.status}` : null;
      case "out.value": return snap ? snap.value : null;
      case "out.status": case "status": return snap ? snap.status : dev ? (n.down ? "{down}" : "{ok}") : null;
      case "facets": return snap ? Object.entries(snap.facets).map(([k, v]) => `${k}=${v}`).join("|") : null;
      case "enabled": return n.props?.enabled?.encoded ?? (n.hasHistory ? "true" : null);
      case "address": case "health": return n.props?.[name]?.encoded ?? null;
      case "fallback.value": return n.writable ? n.fallback : null;
      default: return n.props?.[name]?.encoded ?? null;
    }
  };
  const bql = (text: string, base: string, limit: number) => {
    const m = /^\s*select\s+(.+?)\s+from\s+([\w:]+)(?:\s+where\s+(.+?))?(?:\s+stop)?\s*$/i.exec(text);
    if (!m) throw refuse("bad_query", "BqlException: expected select <columns> from <type> [where <condition>]");
    const match = TYPE_MATCH[m[2]];
    if (!match) throw refuse("bad_query", `BqlException: unknown type ${m[2]}`);
    if (m[2] === "baja:User") {
      return { language: "bql", ord: base, columns: ["name", "fullName", "enabled", "roles"].map((name) => ({ name, display: name, typeSpec: "baja:String" })), rows: [["admin", "Administrator", true, "admin"], ["ben", "Ben Hansen", true, "admin"], [AGENT_USER, "AI agent (Claude)", true, "aiOperator"], ["operator", "Front desk", true, "operator"], ["guest", "", false, "viewer"]], count: 5, hidden: 0, truncated: false };
    }
    const columns = m[1] === "*" ? ["name", "type", "slotPath"] : m[1].split(",").map((c) => c.trim().replace(/\s+as\s+.+$/i, ""));
    const where = (m[3] ?? "").trim();
    const flag = /status\.(?:is)?(\w+?)(?:\(\))?(?:\s*=\s*'?true'?)?$/i.exec(where)?.[1]?.toLowerCase();
    const compare = /^([\w.]+)\s*(>=|<=|>|<|=|like)\s*'?([^']+)'?$/i.exec(where);
    const keep = (n: Node) => {
      if (!where) return true;
      if (flag) return String(column(n, "status") ?? "").includes(flag === "overridden" ? "overridden" : flag);
      if (!compare) return true;
      const left = column(n, compare[1]);
      const right = compare[3];
      if (compare[2].toLowerCase() === "like") return new RegExp(`^${right.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i").test(String(left));
      if (compare[2] === "=") return String(left) === right;
      const a = Number(left), b = Number(right);
      return compare[2] === ">" ? a > b : compare[2] === "<" ? a < b : compare[2] === ">=" ? a >= b : a <= b;
    };
    const matched = [...nodes.values()].filter((n) => n.ord !== "slot:/" && (base === "slot:/" || n.ord.startsWith(`${base}/`)) && match(n) && keep(n));
    return { language: "bql", ord: base, columns: columns.map((name) => ({ name, display: name, typeSpec: "baja:String" })), rows: matched.slice(0, limit).map((n) => columns.map((c) => column(n, c))), count: Math.min(matched.length, limit), hidden: 0, truncated: matched.length > limit, ...(matched.length > limit ? { stoppedBy: "limit" } : {}) };
  };

  // ---- Protocol -----------------------------------------------------------------------------------
  const sockets = new Set<any>();
  const counters = { requests: 0, errors: 0, writes: 0 };
  const send = (ws: any, frame: Record<string, unknown>) => ws.send(encode(frame));
  const broadcast = (frame: Record<string, unknown>) => {
    for (const ws of sockets) send(ws, frame);
  };
  const isAgent = (ws: any) => Boolean(ws.actor && ws.actor.kind !== "person");
  const rules = (ws: any) => ({ isAgent: isAgent(ws), actor: ws.actor ?? null, agentUsersConfigured: true, approvalRequired: true, reasonRequired: true, maxChangesPerMinute: 10, allowEmergency: false, bounds: site.bounds, pointLimitsFromFacets: true, proposalMinutes: 15, pendingProposals: pendingCount() });
  const pushProposal = (proposal: any) => broadcast({ op: "proposal_cov", timestamp: Date.now(), proposal, pendingProposals: pendingCount() });
  const pushAlarm = (alarm: any) => {
    for (const ws of sockets) if (ws.alarmEvents) send(ws, { op: "alarm_cov", timestamp: Date.now(), inScope: alarm.isOpen, event: alarm });
  };
  const pushValue = (ord: string) => {
    for (const ws of sockets) for (const points of ws.groups.values()) if (points.includes(ord)) return void send(ws, { op: "cov", points: [snapshot(ord)] });
  };
  const applyWrite = (ord: string, action: string, value: unknown, durationSec?: number) => {
    const p = need(ord);
    if (p.kind !== "point" || !p.writable) throw refuse("point_not_writable", `${p.name} is not writable.`);
    const coerce = (v: unknown) => (p.vt === "numeric" ? Number(v) : p.vt === "boolean" ? v === true || /^(true|on|active)$/i.test(String(v)) : String(v));
    if (action !== "auto" && action !== "emergency_auto" && (value === undefined || (p.vt === "numeric" && !Number.isFinite(Number(value))))) throw refuse("invalid_value", `${action} needs a ${p.vt} value.`);
    if (action === "override") p.override = { value: coerce(value), until: durationSec ? Date.now() + durationSec * 1000 : undefined };
    else if (action === "auto") p.override = undefined;
    else if (action === "set") { p.fallback = coerce(value); if (!p.override && p.sim) p.sim = undefined; }
    else if (action === "emergency_override") p.emergency = coerce(value);
    else if (action === "emergency_auto") p.emergency = undefined;
    else throw refuse("invalid_action", `Unknown action ${action}.`);
    counters.writes += 1;
    pushValue(ord);
    return snapshot(ord);
  };

  const CAPS = (ws: any) => ({
    apiVersion: "1.10", module: "baskStream", transport: "websocket-msgpack", serverTime: Date.now(), authenticatedUser: DEMO_USER, station: stationName, demo: true,
    writesEnabled: true, agents: rules(ws),
    modelEditing: { enabled: true, actions: ["create", "update", "rename", "delete", "invoke"], maxChanges: 100, previewRequired: true, atomic: false },
    limits: { maxConnections: 10, maxConnectionsPerUser: 0, maxMessageBytes: 1048576, activeConnections: sockets.size, maxSubscriptionsPerClient: 500, maxPointSnapshotPoints: 1000, totalSubscriptions: [...sockets].reduce((n, s) => n + [...s.groups.values()].flat().length, 0), heartbeatIntervalSec: 30, subscriptionLeaseSec: 300, covBatchWindowMillis: 100, defaultBrowseDepth: 1, maxBrowseDepth: 4, defaultSearchDepth: 32, maxSearchDepth: 64 },
    workbench: { query: { bql: true, neql: true, maxRows: 5000 }, files: { root: "^", maxReadBytes: 4194304, write: true }, jobs: true, discovery: { drivers: ["bacnet"], addNeedsModelEdits: true }, securityEdits: false },
    policy: { allowedPathPatterns: "slot:/*", slotBrowseOnly: true, hierarchyBrowse: true, historyOrdReads: true }
  });

  const handlers: Record<string, (ws: any, r: any) => Record<string, unknown> | void> = {
    ping: () => ({ op: "pong" }),
    capabilities: (ws) => ({ op: "capabilities_result", capabilities: CAPS(ws) }),
    declare_actor: (ws, r) => {
      ws.actor = { kind: r.kind ?? "agent", name: r.name, model: r.model, onBehalfOf: r.onBehalfOf };
      return { op: "actor_declared", agents: rules(ws) };
    },
    browse: (_ws, r) => {
      const n = need(r.base ?? "slot:/");
      return { op: "browse_result", node: wire(n, Math.min(4, Math.max(1, Number(r.depth ?? 1)))) };
    },
    describe: (_ws, r) => ({ op: "describe_result", metadata: r.metadata ?? "full", node: describe(need(r.ord)) }),
    search: (_ws, r) => {
      const text = String(r.query ?? "").toLowerCase().trim();
      const base = r.base ?? "slot:/";
      const words = text.split(/\s+/).filter(Boolean);
      const found = [...nodes.values()].filter((n) => n.ord !== "slot:/" && (base === "slot:/" || n.ord.startsWith(`${base}/`)) && (!r.kind || n.kind === r.kind) && (!r.features || r.features.every((f: string) => (f === "point" ? n.kind === "point" : f === "schedule" ? n.kind === "schedule" : f === "history" ? n.hasHistory : true)))
        && words.every((w) => `${n.ord} ${n.display}`.toLowerCase().includes(w)));
      const limit = Number(r.limit ?? 500);
      return { op: "search_result", result: { base, count: Math.min(found.length, limit), truncated: found.length > limit, truncatedReasons: found.length > limit ? ["limit"] : [], nodes: found.slice(0, limit).map((n) => wire(n)) } };
    },
    read: (_ws, r) => ({ op: "read_result", points: (r.points ?? []).map((p: string) => snapshot(p)) }),
    replace_subscriptions: (ws, r) => {
      ws.groups.set(r.group, r.points ?? []);
      return { op: "subscriptions_replaced", group: r.group, points: r.points, leaseSec: r.leaseSec, values: (r.points ?? []).map((p: string) => snapshot(p)) };
    },
    renew_subscriptions: (ws, r) => {
      if (!ws.groups.has(r.group)) throw refuse("group_not_found", "Subscription group not found.");
      return { op: "subscriptions_renewed", group: r.group };
    },
    release_subscriptions: (ws, r) => {
      ws.groups.delete(r.group);
      return { op: "subscriptions_released", group: r.group };
    },
    subscription_status: (ws) => ({ op: "subscription_status_result", session: { pointSubscriptions: [...ws.groups.values()].flat().length, subscriptionGroups: ws.groups.size }, limits: {}, groups: [] }),
    write: (ws, r) => {
      const ord = r.point;
      if (isAgent(ws)) {
        if (!r.reason) throw refuse("reason_required", "Agents must say why: add a 'reason' to the request.");
        need(ord);
        const proposal = propose(ord, r.action ?? "set", r.value, r.reason, Date.now(), r.durationSec ? Math.round(r.durationSec / 60) : undefined);
        proposal.actor = ws.actor;
        pushProposal(proposal);
        return { op: "write_result", points: [{ point: ord, ok: true, outcome: "proposed", proposal }] };
      }
      const result = applyWrite(ord, r.action ?? "set", r.value, r.durationSec);
      auditAdd(Date.now(), DEMO_USER, "Invoked", ord.replace(/^slot:/, ""), r.action ?? "set", "", r.value === undefined ? "" : String(r.value));
      return { op: "write_result", points: [{ ...result, outcome: "written" }] };
    },
    read_alarms: (_ws, r) => {
      let list = [...alarms.values()].filter((a) => (r.scope === "all" ? true : a.isOpen));
      if (r.filter?.ackState) list = list.filter((a) => a.ackState === r.filter.ackState);
      if (r.source) list = list.filter((a) => a.sources.includes(r.source));
      list.sort((a, b) => (r.order === "newest" ? b.timestamp - a.timestamp : a.timestamp - b.timestamp));
      return { op: "alarms_result", alarms: { count: list.length, alarms: list.slice(0, Number(r.limit ?? 100)) } };
    },
    subscribe_alarms: (ws) => {
      ws.alarmEvents = true;
      return { op: "alarms_subscribed", alarms: { count: alarms.size, alarms: [] } };
    },
    ack_alarms: (_ws, r) => {
      const targets = (r.uuids ?? [...alarms.values()].filter((a) => a.isOpen && a.ackState === "unacked").map((a) => a.uuid)) as string[];
      const results = targets.map((uuid) => {
        const alarm = alarms.get(uuid);
        if (!alarm) return { uuid, ok: false, code: "alarm_not_found", message: "No such alarm." };
        if (!r.dryRun) {
          alarm.ackState = "acked";
          if (alarm.sourceState === "normal") alarm.isOpen = false;
          pushAlarm(alarm);
          if (!alarm.isOpen) alarms.delete(uuid);
        }
        return { uuid, ok: true };
      });
      if (!r.dryRun && results.length) auditAdd(Date.now(), DEMO_USER, "Invoked", "/Services/AlarmService", "ackAlarms", "", `${results.length} alarms`);
      return { op: "alarm_action_result", alarms: { action: "ack", matched: results.length, count: results.length, dryRun: Boolean(r.dryRun), alarms: results } };
    },
    read_history_rollup: (_ws, r) => {
      const n = nodes.get(r.ord);
      if (!n?.hasHistory) return { op: "history_rollup_result", rollup: { interval: r.interval, histories: [] } };
      const now = Date.now();
      const buckets: any[] = [];
      const value = (t: number) => Number(n.sim ? n.sim(t) : n.fallback);
      for (let t = r.start; t < r.end && buckets.length < 2000; t += r.interval) {
        if (t > now) break;
        const samples = [0.1, 0.35, 0.6, 0.85].map((f) => value(t + r.interval * f));
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        buckets.push({ start: t, count: Math.max(1, Math.round(r.interval / 300000)), min: Math.min(...samples), max: Math.max(...samples), sum: avg * Math.max(1, Math.round(r.interval / 300000)), avg, first: samples[0], last: samples[3] });
      }
      return { op: "history_rollup_result", rollup: { interval: r.interval, histories: [{ historyId: `/${stationName}/${n.ord.split("/").slice(-3).filter((s) => s !== "points").join("_")}`, buckets, bucketCount: buckets.length, coverage: 1, longestGapMillis: 0, truncated: false }] } };
    },
    read_history: (_ws, r) => {
      const start = Number(r.start ?? Date.now() - 24 * HOUR), end = Number(r.end ?? Date.now()), limit = Number(r.limit ?? 1000);
      if (/AuditHistory$/.test(r.ord)) {
        const records = audit.filter((a) => a.timestamp >= start && a.timestamp <= end).sort((a, b) => a.timestamp - b.timestamp);
        return { op: "history_result", history: { requestOrd: r.ord, start, end, limit, histories: [{ historyId: `/${stationName}/AuditHistory`, recordType: "history:AuditRecord", totalCount: audit.length, records: records.slice(0, limit), truncated: records.length > limit, count: Math.min(records.length, limit) }] } };
      }
      const n = nodes.get(r.ord);
      if (!n?.hasHistory) return { op: "history_result", history: { requestOrd: r.ord, start, end, limit, histories: [] } };
      const records: any[] = [];
      for (let t = Math.ceil(start / 300000) * 300000; t <= Math.min(end, Date.now()) && records.length < limit; t += 300000) records.push({ timestamp: t, value: Number(n.sim ? n.sim(t) : n.fallback), status: "{ok}" });
      return { op: "history_result", history: { requestOrd: r.ord, start, end, limit, histories: [{ historyId: `/${stationName}/${n.name}`, records, count: records.length, truncated: false }] } };
    },
    read_schedule: (_ws, r) => {
      const s = need(r.ord);
      if (s.kind !== "schedule") throw refuse("invalid_schedule", `${s.name} is not a schedule.`);
      const at = Number(r.at ?? Date.now());
      const next = eventsOf(s, at, at + 7 * 24 * HOUR)[1];
      return { op: "schedule_result", schedule: {
        ord: s.ord, slotPath: s.ord, name: s.name, display: s.display, typeSpec: s.typeSpec, kind: "schedule", at, status: "{ok}", effectiveNow: true,
        currentOutput: valueWire(outputAt(s, at)), defaultOutput: valueWire(s.defaultOutput!), nextEvent: next?.time ?? null,
        tree: { typeSpec: s.typeSpec, name: s.name, week: Object.fromEntries(DAYS.map((d) => [d, { name: d, day: (s.week?.[d] ?? []).map((e) => ({ start: e.start, finish: e.finish, effectiveValue: valueWire(e), display: `${e.start} - ${e.finish}: ${e.text}` })) }])), specialEvents: [] }
      } };
    },
    read_schedule_events: (_ws, r) => {
      const s = need(r.ord);
      const start = Number(r.start ?? Date.now()), end = Number(r.end ?? start + 7 * 24 * HOUR);
      const events = eventsOf(s, start, end).slice(0, Number(r.limit ?? 100));
      return { op: "schedule_events_result", schedule: { ord: s.ord, start, end, events, count: events.length, truncated: false } };
    },
    list_proposals: (_ws, r) => ({ op: "proposals_result", proposals: [...proposals.values()].reverse().filter((p) => (!r.status || p.status === r.status) && (p.status === "pending" || Date.now() - (p.decidedAt ?? 0) < HOUR)), pendingProposals: pendingCount() }),
    approve_proposal: (ws, r) => decideRequest(ws, r, true),
    reject_proposal: (ws, r) => decideRequest(ws, r, false),
    read_agent_log: (_ws, r) => {
      const since = Number(r.since ?? Date.now() - 7 * 24 * HOUR), limit = Number(r.limit ?? 100);
      const records = agentLog.filter((a) => a.timestamp >= since).sort((a, b) => b.timestamp - a.timestamp);
      return { op: "agent_log_result", log: { since, count: Math.min(records.length, limit), truncated: records.length > limit, records: records.slice(0, limit) } };
    },
    query: (_ws, r) => {
      const base = r.ord ?? "slot:/";
      if (r.neql !== undefined) {
        const text = String(r.neql).toLowerCase();
        const found = [...nodes.values()].filter((n) => (base === "slot:/" || n.ord.startsWith(`${base}/`)) && text.split(/\s+and\s+/).every((tag) => (tag === "n:point" ? n.kind === "point" : tag === "n:device" ? /Device$/.test(n.typeSpec) : tag === "n:history" ? n.hasHistory : tag === "n:schedule" ? n.kind === "schedule" : (n.tags ?? []).map((t) => t.toLowerCase()).includes(tag))));
        const limit = Number(r.limit ?? 500);
        return { op: "query_result", result: { language: "neql", ord: base, entities: found.slice(0, limit).map((n) => ({ ord: n.ord, name: n.name, display: n.display, typeSpec: n.typeSpec })), count: Math.min(found.length, limit), hidden: 0, truncated: found.length > limit, ...(found.length > limit ? { stoppedBy: "limit" } : {}) } };
      }
      return { op: "query_result", result: bql(String(r.bql ?? ""), base, Number(r.limit ?? 500)) };
    },
    list_files: (_ws, r) => {
      const folder = String(r.path ?? "^").replace(/\/+$/, "") || "^";
      const prefix = folder === "^" ? "^" : `${folder}/`;
      const seen = new Map<string, any>();
      for (const [path, f] of files) {
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length).split("/")[0];
        const isFile = path === prefix + name;
        const entry = seen.get(name);
        if (isFile) seen.set(name, { path, name, directory: false, size: Buffer.byteLength(f.text), modified: f.modified, readonly: false });
        else if (!entry) seen.set(name, { path: prefix + name, name, directory: true, modified: f.modified, readonly: false });
        else if (entry.directory) entry.modified = Math.max(entry.modified, f.modified);
      }
      if (seen.size === 0 && folder !== "^" && !files.has(folder)) throw refuse("file_not_found", `No such folder: ${folder}`);
      const entries = [...seen.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      return { op: "files_result", folder: { path: folder, entries, truncated: false } };
    },
    read_file: (_ws, r) => {
      const f = files.get(r.path);
      if (!f) throw refuse("file_not_found", `No such file: ${r.path}`);
      return { op: "file_result", file: { path: r.path, name: r.path.split("/").pop(), directory: false, size: Buffer.byteLength(f.text), modified: f.modified, readonly: false, encoding: "text", text: f.text } };
    },
    write_file: (_ws, r) => {
      const exists = files.has(r.path);
      if (!/^\^[^^]/.test(r.path) || r.path.includes("..")) throw refuse("forbidden_file", "Only the station file space is reachable: paths start with ^.");
      if (exists && !r.overwrite) throw refuse("file_exists", `${r.path} already exists; send overwrite: true to replace it.`);
      const text = r.text ?? Buffer.from(r.base64 ?? "", "base64").toString("utf8");
      if (!r.dryRun) {
        files.set(r.path, { text, modified: Date.now() });
        auditAdd(Date.now(), DEMO_USER, "file_write", `file:${r.path}`, "", "", `${Buffer.byteLength(text)} bytes`);
      }
      return { op: "file_written", file: { path: r.path, size: Buffer.byteLength(text), created: !exists, ...(r.dryRun ? { dryRun: true } : {}) } };
    },
    delete_file: (_ws, r) => {
      const doomed = [...files.keys()].filter((p) => p === r.path || p.startsWith(`${r.path}/`));
      if (doomed.length === 0) throw refuse("file_not_found", `No such file or folder: ${r.path}`);
      if (!files.has(r.path) && !r.recursive) throw refuse("bad_request", `${r.path} is a folder; send recursive: true to delete it and its contents.`);
      if (!r.dryRun) {
        for (const p of doomed) files.delete(p);
        auditAdd(Date.now(), DEMO_USER, "file_delete", `file:${r.path}`, "", "", `${doomed.length} entries`);
      }
      return { op: "file_deleted", file: { path: r.path, deleted: doomed, ...(r.dryRun ? { dryRun: true } : {}) } };
    },
    list_jobs: () => ({ op: "jobs_result", jobs: [...jobs.values()].reverse().map((j) => jobWire(j)) }),
    read_job: (_ws, r) => {
      const j = jobs.get(r.job);
      if (!j) throw refuse("invalid_job", `Not a job: ${r.job}`);
      return { op: "job_result", job: jobWire(j, true, Number(r.offset ?? 0), Number(r.limit ?? 1000)) };
    },
    cancel_job: (_ws, r) => {
      const j = jobs.get(r.job);
      if (!j) throw refuse("invalid_job", `Not a job: ${r.job}`);
      if (Date.now() - j.startedAt < j.duration) j.canceled = true;
      return { op: "job_result", job: jobWire(j, true) };
    },
    discover: (_ws, r) => {
      const n = need(r.ord);
      const kind = !/^bacnet:/.test(n.typeSpec) ? undefined : /Network$/.test(n.typeSpec) ? "devices" : /Device$|PointDeviceExt$/.test(n.typeSpec) ? "points" : undefined;
      if (!kind) throw refuse("discovery_unsupported", `No built-in discovery for ${n.typeSpec}. Try a BACnet network or device.`);
      auditAdd(Date.now(), DEMO_USER, "Invoked", r.ord.replace(/^slot:/, ""), kind === "devices" ? "submitDeviceManagerJob" : "submitPointDiscoveryJob");
      return { op: "discovery_started", discovery: { job: startJob(kind, /Device$/.test(n.typeSpec) ? `${r.ord}/points` : r.ord), kind, driver: "bacnet", target: r.ord } };
    },
    add_discovered: (_ws, r) => {
      const j = jobs.get(r.job);
      if (!j) throw refuse("invalid_job", `Not a job: ${r.job}`);
      const parent = r.parent ?? j.target;
      const picked = (r.items ?? []).map((item: any) => ({ item, found: j.results.find((x: any) => x.slot === item.slot) }));
      const missing = picked.find((p: any) => !p.found);
      if (missing) throw refuse("bad_request", `No discovery result ${missing.item.slot}.`);
      const changes = picked.map(({ item, found }: any) => {
        const v = found.values;
        if (j.kind === "devices") return { action: "create", parent, name: item.name ?? v.deviceName, typeSpec: "bacnet:BacnetDevice", address: v.address };
        const type = String(v.objectId).split(":")[0];
        const vt = /^analog/.test(type) ? "Numeric" : /^binary/.test(type) ? "Boolean" : "Enum";
        const writable = /Output|Value/.test(type);
        const base = Number(v.value);
        return { action: "create", parent, name: item.name ?? v.objectName, typeSpec: `control:${vt}${writable ? "Writable" : "Point"}`, value: vt === "Numeric" ? base : vt === "Boolean" ? v.value === "active" : v.value, units: /Temp|Setpoint/.test(v.objectName) ? "°F" : /Airflow/.test(v.objectName) ? "cfm" : /CO2/.test(v.objectName) ? "ppm" : "%", sim: vt === "Numeric" && !writable ? wave(base, Math.max(0.4, base * 0.02), 25, seed++) : undefined };
      });
      const plan = planFor(DEMO_USER, changes);
      return { op: "model_result", operation: "add_discovered", result: { ...plan, compact: true, discovery: j.kind, items: picked.map(({ item, found }: any, i: number) => ({ slot: item.slot, objectId: found.values.objectId, name: changes[i].name, typeSpec: changes[i].typeSpec, parent, facetsLearned: j.kind === "points" ? !/^binary/.test(String(found.values.objectId)) : undefined })) } };
    },
    describe_component: (_ws, r) => {
      const n = need(r.ord);
      return { op: "model_result", operation: "describe_component", result: { ord: n.ord, typeSpec: n.typeSpec, name: n.name, slots: slotsOf(n), writesEnabled: true, modelEditsEnabled: true } };
    },
    preview_model_changes: (_ws, r) => ({ op: "model_result", operation: "preview_model_changes", result: planFor(DEMO_USER, r.changes) }),
    apply_model_changes: (_ws, r) => {
      const plan = plans.get(r.planId);
      if (!plan || plan.hash !== r.planHash) throw refuse("plan_not_found", "No such plan, or it has changed; preview again.");
      if (!r.idempotencyKey) throw refuse("bad_request", "Missing idempotencyKey");
      plans.delete(r.planId);
      const results = plan.apply();
      return { op: "model_result", operation: "apply_model_changes", result: { planId: r.planId, planHash: r.planHash, state: "applied", changes: plan.changes, results, atomic: false, unattempted: 0 } };
    }
  };
  for (const [op, action] of [["update_component_properties", "update"], ["rename_component", "rename"], ["delete_components", "delete"], ["create_components", "create"]])
    handlers[op] = (_ws, r) => ({ op: "model_result", operation: op, result: planFor(DEMO_USER, (r.changes ?? [r]).map((c: any) => ({ ...c, action }))) });

  function decideRequest(ws: any, r: any, approve: boolean) {
    if (isAgent(ws)) throw refuse("agent_cannot_approve", "Agents cannot approve or reject proposals; a person decides.");
    const proposal = proposals.get(String(r.proposal).toUpperCase().replace(/^(\d)/, "P$1"));
    if (!proposal) throw refuse("proposal_not_found", `No proposal ${r.proposal}.`);
    if (proposal.status !== "pending") throw refuse("proposal_closed", `Proposal ${proposal.id} is already ${proposal.status}.`);
    if (approve) {
      try {
        proposal.result = applyWrite(proposal.point, proposal.action, proposal.value, proposal.durationSec);
        decide(proposal, "approved", DEMO_USER);
        auditAdd(Date.now(), DEMO_USER, "Invoked", proposal.point.replace(/^slot:/, ""), proposal.action, "", proposal.description.replace(/^\w+ /, ""));
      } catch (error) {
        decide(proposal, "failed", DEMO_USER, Date.now(), (error as Error).message);
      }
    } else decide(proposal, "rejected", DEMO_USER, Date.now(), r.note ?? null);
    pushProposal(proposal);
    return { op: "proposal_result", proposal };
  }

  function handle(ws: any, request: any) {
    counters.requests += 1;
    const handler = handlers[request.op];
    try {
      if (!handler) throw refuse("unsupported_op", `Unsupported op: ${request.op}`);
      const reply = handler(ws, request);
      if (reply) send(ws, { ...reply, id: request.id });
    } catch (error) {
      counters.errors += 1;
      const e = error as Error & { code?: string };
      send(ws, { op: "error", id: request.id, code: e.code ?? "internal_error", message: e.message });
    }
  }

  // ---- HTTP: SCRAM login, health and metrics ------------------------------------------------------
  const SALT = crypto.randomBytes(16);
  const ITERATIONS = 4096;
  const salted = crypto.pbkdf2Sync(DEMO_PASSWORD, SALT, ITERATIONS, 32, "sha256");
  const hmac = (key: crypto.BinaryLike, text: string) => crypto.createHmac("sha256", key).update(text).digest();
  const sessions = new Set<string>();
  const scram = new Map<string, any>();
  const cookieOf = (req: http.IncomingMessage) => /JSESSIONID=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let sid = cookieOf(req);
    if (!sid) {
      sid = crypto.randomUUID();
      res.setHeader("Set-Cookie", `JSESSIONID=${sid}; Path=/; HttpOnly`);
    }
    if (req.url === "/stream/health") {
      if (!sessions.has(sid)) return void res.writeHead(302, { Location: "/prelogin" }).end();
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, apiVersion: "1.10" }));
    }
    if (req.url === "/stream/metrics") {
      if (!sessions.has(sid)) return void res.writeHead(302).end();
      const subs = [...sockets].reduce((n, s) => n + [...s.groups.values()].flat().length, 0);
      return void res.writeHead(200).end(`baskstream_requests_total ${counters.requests}\nbaskstream_errors_total ${counters.errors}\nbaskstream_write_requests_total ${counters.writes}\nbaskstream_active_connections ${sockets.size}\nbaskstream_subscriptions ${subs}\nbaskstream_resyncs_total 0\nbaskstream_request_timeouts_total 0\n# EOF\n`);
    }
    if (req.url === "/prelogin") return void res.writeHead(200).end("<html>login</html>");
    if (req.url === "/login") return void res.writeHead(200).end('<form action="j_security_check">');
    if (req.url === "/j_security_check/" && req.method === "GET") {
      if (scram.get(sid)?.done) sessions.add(sid);
      return void res.writeHead(200).end("ok");
    }
    if (req.url === "/j_security_check/") {
      const params = new URLSearchParams(body.replace(/\+/g, "%2B"));
      if (params.get("action") === "sendClientFirstMessage") {
        const bare = params.get("clientFirstMessage")!.slice(3);
        const clientNonce = /r=([^,]+)/.exec(bare)![1];
        const serverFirst = `r=${clientNonce}${crypto.randomBytes(12).toString("base64")},s=${SALT.toString("base64")},i=${ITERATIONS}`;
        scram.set(sid, { bare, serverFirst });
        return void res.writeHead(200).end(serverFirst);
      }
      const pending = scram.get(sid);
      const final = params.get("clientFinalMessage") ?? "";
      if (!pending) return void res.writeHead(403).end("e=no-handshake");
      const withoutProof = final.slice(0, final.lastIndexOf(",p="));
      const proof = Buffer.from(final.slice(final.lastIndexOf(",p=") + 3), "base64");
      const auth = `${pending.bare},${pending.serverFirst},${withoutProof}`;
      const clientKey = hmac(salted, "Client Key");
      const signature = hmac(crypto.createHash("sha256").update(clientKey).digest(), auth);
      const expected = Buffer.alloc(32);
      for (let i = 0; i < 32; i += 1) expected[i] = clientKey[i] ^ signature[i];
      if (!proof.equals(expected)) return void res.writeHead(403).end("e=invalid-proof");
      pending.done = true;
      return void res.writeHead(200).end(`v=${hmac(hmac(salted, "Server Key"), auth).toString("base64")}`);
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const sid = cookieOf(req);
    if (req.url !== "/stream" || !sid || !sessions.has(sid)) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const client = ws as any;
      client.groups = new Map<string, string[]>();
      client.last = new Map<string, unknown>();
      sockets.add(client);
      ws.on("close", () => sockets.delete(client));
      ws.on("message", (data: Uint8Array) => handle(client, decode(data)));
    });
  });

  // ---- Life: values drift, alarms come and go, and the agent keeps working -----------------------
  const timers: NodeJS.Timeout[] = [];
  if (live) {
    timers.push(setInterval(() => {
      for (const ws of sockets) {
        const changed: any[] = [];
        for (const ord of new Set<string>([...ws.groups.values()].flat())) {
          const snap = snapshot(ord);
          const key = `${snap.displayValue}|${snap.status}`;
          if (ws.last.get(ord) !== key) {
            if (ws.last.has(ord)) changed.push(snap);
            ws.last.set(ord, key);
          }
        }
        if (changed.length) send(ws, { op: "cov", points: changed });
      }
    }, 2000));

    Object.assign(c, { snapshot, pushProposal, pushAlarm });
    const agentMoves = site.agentMoves(c);
    let move = 0;
    timers.push(setInterval(() => agentMoves[move++ % agentMoves.length](), 23000));
    timers.push(setInterval(() => {
      for (const p of proposals.values()) {
        if (p.status === "pending" && p.expiresAt < Date.now()) {
          decide(p, "expired", "");
          pushProposal(p);
        }
      }
    }, 5000));

    const alarmMoves = site.alarmMoves(c);
    let alarmMove = 0;
    timers.push(setInterval(() => {
      if ([...alarms.values()].filter((a) => a.isOpen).length < 14) alarmMoves[alarmMove++ % alarmMoves.length]();
    }, 41000));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      for (const timer of timers) clearInterval(timer);
      reject(error);
    });
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    site: site.key,
    station: stationName,
    user: DEMO_USER,
    password: DEMO_PASSWORD,
    state: { nodes, alarms, proposals, agentLog, audit, files, jobs, sockets, counters, propose, pushProposal, raise, pushAlarm, agentRecord, auditAdd, snapshot, point },
    push: broadcast,
    dropAll() {
      for (const ws of sockets) ws.terminate();
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const ws of sockets) ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
