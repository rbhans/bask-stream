/** Loose JSON object, used where the protocol returns open-ended data. */
export type Json = Record<string, unknown>;

/** A point value snapshot, as returned by read and pushed in COV frames. */
export interface PointSnapshot {
  point: string;
  /** The read worked (API 1.9+). On older stations false also meant a non-ok status; check `code` for a failed read. */
  ok: boolean;
  /** The point's own status is ok (API 1.9+). */
  statusOk?: boolean;
  /** One word for the status (API 1.9+): ok, alarm, fault, down, stale, unsubscribed, overridden, disabled, null. */
  state?: string;
  /** The point was leased by a `fresh` read. */
  fresh?: boolean;
  display?: string;
  valueType?: string;
  value?: unknown;
  displayValue?: string;
  status?: string;
  timestamp?: number;
  facets?: Json;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/** A node from browse, describe or search. */
export interface BrowseNode {
  ord: string;
  slotPath?: string;
  name: string;
  display?: string;
  typeSpec?: string;
  kind?: string;
  hasChildren?: boolean;
  writable?: boolean;
  features?: string[];
  operations?: string[];
  children?: BrowseNode[];
  metadata?: Json;
  [key: string]: unknown;
}

/** An alarm record. */
export interface AlarmRecord {
  uuid: string;
  timestamp?: number;
  sourceState?: string;
  ackState?: string;
  alarmClass?: string;
  priority?: number;
  sources?: string[];
  [key: string]: unknown;
}

/** Narrowing for read_alarms and filtered ack/clear. */
export interface AlarmFilter {
  alarmClass?: string | string[];
  minPriority?: number;
  maxPriority?: number;
  ackState?: "acked" | "unacked";
  since?: number;
  until?: number;
}

/** One entry of a weekly schedule day for write_schedule. */
export interface ScheduleEntry {
  start: string;
  finish: string;
  value: boolean | number | string;
}

/** Who is behind a connection. Recorded as claims next to the Niagara user. */
export interface Actor {
  /** Default "agent". */
  kind?: "agent" | "person";
  /** Agent or tool name, e.g. "Claude Code". */
  name?: string;
  model?: string;
  /** The person who launched the agent. */
  onBehalfOf?: string;
}

/** A point write an agent proposed, waiting for (or decided by) a person. */
export interface Proposal {
  id: string;
  status: "pending" | "deciding" | "approved" | "rejected" | "expired" | "failed";
  point: string;
  display?: string;
  action: string;
  value?: unknown;
  description: string;
  reason?: string | null;
  agentUser: string;
  actor?: { kind: string; name?: string | null; model?: string | null; onBehalfOf?: string | null } | null;
  createdAt: number;
  expiresAt: number;
  decidedBy?: string | null;
  decidedAt?: number | null;
  note?: string | null;
  result?: Json | null;
}

/** One "Agent" record from the station's audit history. */
export interface AgentLogRecord {
  timestamp: number;
  user: string;
  target: string;
  action: string;
  outcome?: string;
  code?: string;
  agentUser?: string;
  agent?: string;
  model?: string;
  for?: string;
  change?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface AgentLog {
  since: number;
  count: number;
  truncated: boolean;
  records: AgentLogRecord[];
}

/** The reply to a `query`: a BQL table (`columns`, `rows`) or NEQL `entities`. */
export interface QueryResult {
  language: "bql" | "neql";
  ord: string;
  columns?: { name: string; display: string; typeSpec: string | null }[];
  rows?: unknown[][];
  entities?: { ord: string; name: string; display: string; typeSpec: string }[];
  count: number;
  /** Rows dropped because the user may not see them. */
  hidden: number;
  truncated: boolean;
  stoppedBy?: "limit" | "timeout";
}

export interface FileEntry {
  /** Station file path, e.g. "^px/Home.px". */
  path: string;
  name: string;
  directory: boolean;
  size?: number;
  modified: number | null;
  readonly: boolean;
}

export interface FileContent extends FileEntry {
  encoding: "text" | "base64";
  text?: string;
  base64?: string;
}

export interface JobSummary {
  job: string | null;
  name: string;
  display: string;
  typeSpec: string;
  state: "unknown" | "running" | "canceling" | "canceled" | "success" | "failed";
  complete: boolean;
  progress: number;
  startTime: number | null;
  endTime: number | null;
}

export interface JobDetail extends JobSummary {
  log: { kind: string; timestamp: number | null; message: string; details?: string }[];
  logItems: number;
  /** What the job left on itself, such as discovered devices or points, in plain form. */
  results: { slot: string; typeSpec: string; values: unknown }[];
  resultCount: number;
  nextOffset: number | null;
  /** Set on discovery jobs baskStream can add from. */
  discovery?: "devices" | "points";
}

export interface Discovery {
  job: string;
  kind: "devices" | "points";
  driver: string;
  target: string;
}

/** One discovery result to add: `slot` comes from the job's `results`. */
export interface DiscoveredItem {
  slot: string;
  name?: string;
  parent?: string;
  collision?: "fail" | "suffix";
  writable?: boolean;
  typeSpec?: string;
  properties?: Record<string, unknown>;
}

export type Weekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
