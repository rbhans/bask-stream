// The station's rules for AI agents, as its capabilities report them, and what they leave an agent
// free to do by itself. From API 1.11 the station says so in `agents.direct`; before that an agent
// could only propose point writes while approval was required. From API 1.13 each kind of work has
// its own setting and `pointWrites` says what a point command does; before that, approval off meant
// every change went straight through.

export interface AgentRules {
  isAgent?: boolean;
  actor?: { name?: string; model?: string; onBehalfOf?: string } | null;
  agentUsersConfigured?: boolean;
  /** True when a point command becomes a proposal. From API 1.13 that is all it says. */
  approvalRequired?: boolean;
  /** What a point command does (API 1.13). */
  pointWrites?: "refuse" | "ask" | "allow";
  /** The same for a point no value limit names; it only makes a command stricter (API 1.13). */
  unlistedPoints?: "refuse" | "ask" | "allow";
  /** The agent profile whose rules these are, or null for the station's default agent rules (API 1.13). */
  profile?: string | null;
  /** Why the profile allows nothing: "is turned off" or "ended on ..." (API 1.13). */
  profileOff?: string;
  /** The profile's narrower reach, as slot path patterns (API 1.13). */
  pathPatterns?: string | null;
  reasonRequired?: boolean;
  maxChangesPerMinute?: number;
  allowEmergency?: boolean;
  bounds?: string[];
  pendingProposals?: number;
  /** Each kind of work as refuse, ask or allow (API 1.14). "ask" means the change waits for a person. For files, allow means under the paths in direct.files. */
  kinds?: Partial<Record<"points" | "files" | "discovery" | "modelEdits" | "tags" | "schedules" | "alarms", "refuse" | "ask" | "allow">>;
  /** What happens to a station file outside the paths in direct.files: it waits for a person, or is refused (API 1.14). */
  filesElsewhere?: "refuse" | "ask";
  /** What agents may change without a person right now (API 1.11). */
  direct?: { pointWrites?: boolean; files?: string[]; discovery?: boolean; modelEdits?: boolean; tags?: boolean; schedules?: boolean; alarms?: boolean };
}

export interface DirectWork {
  /** False on a station older than API 1.11, which does not say what is direct. */
  known: boolean;
  /** Before API 1.13, approval off: every change goes straight through, point writes included. */
  all: boolean;
  /** The kinds of work an agent may do by itself, in words. */
  kinds: string[];
}

/** What the rules let an agent do without a person. */
export function directWork(rules?: AgentRules): DirectWork {
  if (!rules) return { known: false, all: false, kinds: [] };
  if (rules.approvalRequired === false && rules.pointWrites === undefined) return { known: true, all: true, kinds: ["every change its Niagara role allows"] };
  const direct = rules.direct;
  if (!direct) return { known: false, all: false, kinds: [] };
  const kinds: string[] = [];
  if (pointMode(rules) === "allow") kinds.push(rules.unlistedPoints === "allow" || rules.unlistedPoints === undefined ? "point commands" : "point commands on points with a value limit");
  if (direct.files?.length) kinds.push(`station files under ${direct.files.join(", ")}`);
  if (direct.discovery) kinds.push("discovery");
  if (direct.modelEdits) kinds.push("model edits");
  if (direct.tags) kinds.push("tags");
  if (direct.schedules) kinds.push("schedules");
  if (direct.alarms) kinds.push("alarms");
  return { known: true, all: false, kinds };
}

/** What a point command from an agent does here: refused, a proposal, or written. */
export function pointMode(rules?: AgentRules): "refuse" | "ask" | "allow" {
  return rules?.pointWrites ?? (rules?.approvalRequired === false ? "allow" : "ask");
}

/** The same in a sentence part: "point writes wait for a person's approval". */
export function pointWritesText(rules?: AgentRules): string {
  const mode = pointMode(rules);
  return mode === "ask" ? "point writes wait for a person's approval" : mode === "refuse" ? "point writes are refused" : "point writes go straight through";
}

/** The same for a status chip. */
export function pointWritesShort(rules?: AgentRules): string {
  const mode = pointMode(rules);
  return mode === "ask" ? "writes need approval" : mode === "refuse" ? "writes refused" : "agents write directly";
}

/** The same, as the few words that fit a status chip: "files, discovery". */
export function directShort(rules?: AgentRules): string | undefined {
  const work = directWork(rules);
  if (!work.known || work.all) return undefined;
  const direct = rules!.direct!;
  const words = [direct.files?.length ? "files" : "", direct.discovery ? "discovery" : "", direct.modelEdits ? "model edits" : "", direct.tags ? "tags" : "", direct.schedules ? "schedules" : "", direct.alarms ? "alarms" : ""].filter(Boolean);
  return words.length ? `direct: ${words.join(", ")}` : "nothing else direct";
}

/** The kinds of work, other than point commands, that wait for a person instead of being refused (API 1.14). */
export function askedWork(rules?: AgentRules): string[] {
  const kinds = rules?.kinds;
  if (!kinds) return [];
  const words: Array<[keyof NonNullable<AgentRules["kinds"]>, string]> = [["files", rules?.direct?.files?.length ? "other station files" : "station files"],
    ["discovery", "discovery"], ["modelEdits", "model edits"], ["tags", "tags"], ["schedules", "schedules"], ["alarms", "alarms"]];
  return words.filter(([kind]) => kinds[kind] === "ask" || (kind === "files" && rules?.filesElsewhere === "ask")).map(([, word]) => word);
}

/** Whether an agent may write this station file by itself; undefined when the station does not say. */
export function mayWriteFile(rules: AgentRules | undefined, path: string): boolean | undefined {
  const work = directWork(rules);
  if (!work.known) return undefined;
  if (work.all) return true;
  return (rules!.direct!.files ?? []).some((pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`))}$`).test(path));
}
