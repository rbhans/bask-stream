/** Loose JSON object, used where the protocol returns open-ended data. */
export type Json = Record<string, unknown>;

/** A point value snapshot, as returned by read and pushed in COV frames. */
export interface PointSnapshot {
  point: string;
  ok: boolean;
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

export type Weekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
