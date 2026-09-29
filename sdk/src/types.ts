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

export type Weekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
