// The station's rules for AI agents, as its capabilities report them, and what they leave an agent
// free to do by itself. From API 1.11 the station says so in `agents.direct`; before that an agent
// could only propose point writes while approval was required.

export interface AgentRules {
  isAgent?: boolean;
  actor?: { name?: string; model?: string; onBehalfOf?: string } | null;
  agentUsersConfigured?: boolean;
  approvalRequired?: boolean;
  reasonRequired?: boolean;
  maxChangesPerMinute?: number;
  allowEmergency?: boolean;
  bounds?: string[];
  pendingProposals?: number;
  /** What agents may change without a person right now (API 1.11). */
  direct?: { pointWrites?: boolean; files?: string[]; discovery?: boolean; modelEdits?: boolean; tags?: boolean; schedules?: boolean; alarms?: boolean };
}

export interface DirectWork {
  /** False on a station older than API 1.11, which does not say what is direct. */
  known: boolean;
  /** Approval is off: every change goes straight through, point writes included. */
  all: boolean;
  /** The kinds of work an agent may do by itself, in words. */
  kinds: string[];
}

/** What the rules let an agent do without a person. */
export function directWork(rules?: AgentRules): DirectWork {
  if (!rules) return { known: false, all: false, kinds: [] };
  if (rules.approvalRequired === false) return { known: true, all: true, kinds: ["every change its Niagara role allows"] };
  const direct = rules.direct;
  if (!direct) return { known: false, all: false, kinds: [] };
  const kinds: string[] = [];
  if (direct.files?.length) kinds.push(`station files under ${direct.files.join(", ")}`);
  if (direct.discovery) kinds.push("discovery");
  if (direct.modelEdits) kinds.push("model edits");
  if (direct.tags) kinds.push("tags");
  if (direct.schedules) kinds.push("schedules");
  if (direct.alarms) kinds.push("alarms");
  return { known: true, all: false, kinds };
}

/** The same, as the few words that fit a status chip: "files, discovery". */
export function directShort(rules?: AgentRules): string | undefined {
  const work = directWork(rules);
  if (!work.known || work.all) return undefined;
  const direct = rules!.direct!;
  const words = [direct.files?.length ? "files" : "", direct.discovery ? "discovery" : "", direct.modelEdits ? "model edits" : "", direct.tags ? "tags" : "", direct.schedules ? "schedules" : "", direct.alarms ? "alarms" : ""].filter(Boolean);
  return words.length ? `direct: ${words.join(", ")}` : "nothing else direct";
}

/** Whether an agent may write this station file by itself; undefined when the station does not say. */
export function mayWriteFile(rules: AgentRules | undefined, path: string): boolean | undefined {
  const work = directWork(rules);
  if (!work.known) return undefined;
  if (work.all) return true;
  return (rules!.direct!.files ?? []).some((pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`))}$`).test(path));
}
