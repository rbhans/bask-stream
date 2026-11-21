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
/** What the station would do with a change, from `explain_change` (API 1.13). */
export interface ChangeExplanation {
  change: string;
  user: string;
  isAgent: boolean;
  /** The agent profile whose rules decided, or null for the service's own agent settings. */
  profile: string | null;
  outcome: "allow" | "ask" | "refuse";
  /** The setting that decided, such as "agentPointWrites" or "writesEnabled"; null when no rule limits it. */
  rule: string | null;
  message: string;
  /** With change "write" and a point: the value limit that names the point, or null. */
  limit?: string | null;
}

export interface Proposal {
  id: string;
  /** "applied" is a change the agent made directly; "approved" one a person approved. Both can be "reverted". */
  status: "pending" | "deciding" | "approved" | "applied" | "rejected" | "expired" | "failed" | "reverted";
  /** The kind of work (API 1.14). Absent from an older station, where every proposal is a point command. */
  kind?: "points" | "files" | "discovery" | "modelEdits" | "tags" | "schedules" | "alarms";
  /** The operation the change runs, such as "write" or "write_file". */
  operation?: string;
  /** True for a change the agent made without asking; only `changes()` lists those. */
  direct?: boolean;
  /** The target: a point, or for other kinds a component, a file path or a plan. */
  point: string;
  display?: string;
  action: string;
  value?: unknown;
  description: string;
  /** A plan's steps, one line each. */
  changes?: string[];
  reason?: string | null;
  agentUser: string;
  actor?: { kind: string; name?: string | null; model?: string | null; onBehalfOf?: string | null } | null;
  createdAt: number;
  expiresAt: number;
  decidedBy?: string | null;
  decidedAt?: number | null;
  note?: string | null;
  result?: Json | null;
  /** Whether `revertChange` can put it back now. */
  canRevert?: boolean;
  /** Why it cannot be put back at all. */
  notRevertible?: string;
  /** Steps that cannot be put back; the rest can, with `partial`. */
  notReverted?: string[];
  /** Said before approval: steps that could not be put back afterwards. */
  irreversible?: string[];
  revertedBy?: string | null;
  revertedAt?: number | null;
  /** What the station looked at after a point command, and what it found. */
  check?: { point: string; min?: number; max?: number; dueAt: number; state: "waiting" | "passed" | "failed" | "unknown" | "skipped"; found?: unknown; message?: string; checkedAt?: number };
}

/** The answer of `resolve`: the point that plays a role on a piece of equipment. Inferred. */
export interface RoleMatch {
  equip: string;
  role: string | null;
  tags?: string[];
  /** The best match when it is good and clearly ahead; null otherwise. */
  point: string | null;
  ambiguous: boolean;
  matches: Array<{ ord: string; name: string; typeSpec: string; units?: string; score: number; why: string[] }>;
  inferred: true;
  truncated?: boolean;
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

// ---- Graphics (API 1.12) ----------------------------------------------------------------------

/** Something a Px refers to. `binding` and `ordProperty` are data; the others are files and pages. */
export interface PxReference {
  kind: "binding" | "ordProperty" | "link" | "file" | "include" | "view";
  ord: string;
  /** The widget, as a path of element names: Type[name] or Type#n. */
  widget: string;
  property?: string;
  element: string;
  line: number;
}

export interface PxProblem {
  severity: "error" | "warning";
  code: string;
  message: string;
  line?: number;
}

/** A Px element and everything under it, as read_px returns it and write_px accepts it. */
export interface PxNode {
  element: string;
  typeSpec?: string;
  attributes: Record<string, string>;
  line?: number;
  text?: string;
  children: PxNode[];
}

export interface PxInfo {
  path?: string;
  version: string | null;
  media: string | null;
  imports: string[];
  elements: number;
  types: Record<string, number>;
  references: PxReference[];
  errors: number;
  warnings: number;
  problems: PxProblem[];
  truncated: boolean;
  /** validate_px and write_px: no errors. */
  valid?: boolean;
  /** read_px with tree: true. */
  tree?: PxNode;
}

/** Which components: slot ORDs, a pattern, or every component with a view of the Px. */
export interface PxTargets {
  targets?: string[];
  match?: { under?: string; name?: string; type?: string; depth?: number };
  views?: boolean;
}

export interface PxSuggestion {
  ord: string;
  /** The ORD to put in the Px, relative to the target. */
  relative: string;
  name: string;
  typeSpec: string;
  units?: string;
  score: number;
  why: string[];
}

export interface PxBindingCheck {
  path: string;
  relativeTo?: string;
  summary: { targets: number; bindings: number; relativeBindings: number; absoluteBindings: number; brokenAbsolute: number; okTargets: number; deviatingTargets: number };
  bindings: {
    index: number; ord: string; checked?: string; kind: string; relative: boolean; widgets: string[]; widgetCount: number;
    resolvedOn?: number; missingOn?: number; forbiddenOn?: number; types?: Record<string, number>;
    status?: string; reason?: string; typeSpec?: string;
  }[];
  targets: {
    ord: string; name: string; resolved: number; ok: boolean; cells?: string[];
    missing: { binding: number; ord: string; status: string; reason?: string; suggestions?: PxSuggestion[] }[];
    mismatched: { binding: number; ord: string; typeSpec: string; expected: string }[];
  }[];
  deviating: string[];
  targetErrors: { ord: string; code: string; message: string }[];
  truncated: boolean;
  pxErrors: number;
  note?: string;
}

export interface PxViewsResult {
  path: string;
  view: string | null;
  remove: boolean;
  default: boolean;
  dryRun?: boolean;
  summary: Record<string, number>;
  results: { ord: string; action: "added" | "updated" | "unchanged" | "removed" | "conflict" | "failed"; view?: string; views?: string[]; default?: boolean; defaultSet?: boolean; code?: string; message?: string }[];
  truncated: boolean;
}

export interface NavCheck {
  path?: string;
  nodes: { path: string; name: string; ord: string | null; icon?: string; depth: number; line: number; status: string; reason?: string }[];
  dead: number;
  problems: PxProblem[];
  valid: boolean;
  users?: string[];
}

export interface PunchItem {
  severity: "error" | "warning" | "info";
  kind: string;
  where: string;
  target?: string;
  message: string;
}

export interface GraphicsInventory {
  under: string;
  summary: Record<string, number>;
  punchList: PunchItem[];
  pxFiles: { path: string; size?: number; modified?: number | null; attachedTo: { ord: string; view: string; default: boolean }[]; includes: string[]; includedBy: string[]; linkedFrom: string[]; bindings?: number; relativeBindings?: number; errors?: number; imports?: string[] }[];
  navFiles: { path: string; nodes: number; dead: number; users: string[] }[];
  views: { ord: string; view: string; pxFile: string | null; default: boolean; file: string }[];
  users: { user: string; navFile: string | null }[];
  unusedFiles: string[];
  truncated: boolean;
}
