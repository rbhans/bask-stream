// bask log: one list of what happened on a station, newest first. It is put together here, in the
// client, from four things any login that can read may ask for: the station's audit history (what
// people changed, and overrides with when they were released), the alarm database, the agent log
// (what AI agents asked for, did, and were refused) and the list of proposals and changes. Read-only.
import chalk from "chalk";
import { BaskStreamError, toSlotOrd, type AgentLogRecord, type BaskStreamClient, type Json, type Proposal } from "./core.js";
import { alarmMessage, alarmState, place, visibleLength } from "./format.js";

/** Every operation a log read sends. None of them changes the station. */
export const LOG_OPERATIONS = ["query", "describe_history", "read_history", "read_alarms", "read_agent_log", "list_changes", "list_proposals", "read"] as const;

export interface LogEvent {
  /** When it happened, in epoch milliseconds. */
  at: number;
  kind: "change" | "override" | "alarm" | "agent" | "proposal" | "note";
  /** The Niagara user, or the agent's name. */
  who?: string;
  /** True when an AI agent did it or asked for it. */
  agent?: boolean;
  /** The slot ORD it happened to, when known. */
  ord?: string;
  slot?: string;
  /** The old and the new value as text, when known. */
  from?: string;
  to?: string;
  /** One plain line saying what happened. */
  text: string;
  /** An override: when it was released or replaced. An alarm: when it went back to normal. Absent while it lasts. */
  until?: number;
  /** An override nobody released that is no longer in place (one set for a time, which ran out): `until` is not known. */
  ended?: boolean;
  /** The alarm's uuid, the proposal's id (P7) or the change's id. */
  id?: string;
  /** "note": written by a person or an agent with `bask note`, kept beside the station's own record. */
  source: "audit" | "alarm" | "agentLog" | "changes" | "note";
}

export interface LogOptions {
  /** Keep only what happened to this ORD or below it. */
  under?: string;
  since: number;
  until?: number;
  /** The most events to return, newest kept (default 2000). */
  limit?: number;
}

const MIN = 60000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** A time as "17 Nov 14:10". */
export function whenText(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** A length of time in words: "40 min", "2 h 15 min", "3 days 4 h". */
export function spanText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MIN));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
  const hours = Math.round(minutes / 60);
  return hours % 24 ? `${Math.floor(hours / 24)} days ${hours % 24} h` : `${hours / 24} days`;
}

/** A point or component as a slot ORD: "Drivers/Net/AHU_1" and "/Drivers/Net/AHU_1" are slot:/Drivers/Net/AHU_1. */
export function asSlotOrd(ord: string): string {
  const given = toSlotOrd(ord.trim());
  return /^[a-z]+:/i.test(given) ? given : `slot:/${given.replace(/^\/+/, "")}`;
}

/** Runs `work` on each item, at most `size` at a time, and keeps the order. */
export async function pooled<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  }));
  return out;
}

/** Failures that are about the connection, not about one thing that was asked for: these are not turned into a note. */
const LOST = ["connection_closed", "not_connected", "session_expired", "login_failed"];
export const isLost = (error: unknown) => error instanceof BaskStreamError && LOST.includes(error.code);

/** Why a read failed, in plain words. */
export function whyNot(error: unknown, op?: string): string {
  if (!(error instanceof BaskStreamError)) return error instanceof Error ? error.message : String(error);
  if (/unsupported|unknown_op/.test(error.code)) return `this station's baskStream does not have ${op ?? error.op ?? "that operation"}`;
  if (/forbidden|permission/.test(error.code)) return "this login may not read it";
  if (error.code === "timeout") return "the station did not answer in time";
  return `${error.code}: ${error.message}`;
}

// ---- The audit history ------------------------------------------------------------------------------

/** One record of the station's audit history, read from its text. */
export interface AuditEntry {
  at: number;
  user: string;
  /** Niagara's word for it: Changed, Invoked, Added, Removed, Renamed, Login… and baskStream's own Agent. */
  operation: string;
  /** What it was done to: a slot ORD where it is a component, else as the station wrote it (a file, a service). */
  target: string;
  slot: string;
  oldValue: string;
  value: string;
}

/** Niagara escapes characters in slot names as $xx; show them as typed. */
const plain = (name: string) => name.replace(/\$([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * Reads one audit record. The station sends it as text:
 *   value   "12-Nov-26 12:50 PM MST[admin] Invoked;slotName=override;oldValue=…;value=…"
 *   summary "12-Nov-26 12:50 PM MST Invoked /Drivers/… override <old> <new> admin"
 * The target only appears in the summary, between the operation and the slot name.
 */
export function parseAuditRecord(record: Json): AuditEntry | undefined {
  const text = String(record.value ?? "");
  const head = /^([^[]*)\[([^\]]*)\] ([^;]*)/.exec(text);
  if (!head || typeof record.timestamp !== "number") return undefined;
  const [whole, when, user, operation] = head;
  const rest = text.slice(whole.length);
  const part = (name: string, after: number) => {
    const at = rest.indexOf(`;${name}=`, after);
    return at < 0 ? undefined : { at, from: at + name.length + 2 };
  };
  const slot = rest.startsWith(";slotName=") ? { at: 0, from: 10 } : undefined;
  const old = part("oldValue", slot?.from ?? 0);
  const val = part("value", old?.from ?? slot?.from ?? 0);
  const until = (from: number, ...next: ({ at: number } | undefined)[]) => rest.slice(from, next.find((n) => n && n.at >= from)?.at ?? rest.length);
  const slotName = slot ? until(slot.from, old, val) : "";
  const oldValue = old ? until(old.from, val) : "";
  const value = val ? rest.slice(val.from) : "";
  const summary = String(record.summary ?? "");
  const prefix = `${when} ${operation} `;
  const suffix = ` ${slotName} ${oldValue} ${value} ${user}`;
  let target = summary.startsWith(prefix) && summary.endsWith(suffix) ? summary.slice(prefix.length, summary.length - suffix.length) : summary.startsWith(prefix) ? summary.slice(prefix.length).split(" ")[0] ?? "" : "";
  if (target.startsWith("/")) target = `slot:${target}`;
  return { at: record.timestamp, user, operation, target: toSlotOrd(target), slot: slotName, oldValue, value };
}

/**
 * Where the station's audit history is, as a history ORD. The audit history service is asked; a
 * station too old for queries, or a login that may not run one, falls back to the station's name
 * where the station gives it. Undefined when neither says.
 */
export async function auditHistoryOrd(client: BaskStreamClient): Promise<string | undefined> {
  try {
    const found = await client.query({ bql: "select historyConfig.id from history:AuditHistoryService" }, { limit: 1 });
    const id = (found.rows as unknown[][] | undefined)?.[0]?.[0];
    // A history id reads "/Station/AuditHistory".
    if (typeof id === "string" && /^\/[^/]+\/[^/]+/.test(id)) return `history:${id}`;
  } catch (error) {
    if (isLost(error)) throw error;
  }
  return client.capabilities.station ? `history:/${String(client.capabilities.station)}/AuditHistory` : undefined;
}

/** The most audit records one read goes through. */
const AUDIT_CAP = 20000;

/**
 * The audit records between two times, oldest first, with what could not be read said in `notes`.
 * The history comes oldest first and a reply holds only so many, so it is followed forward a page
 * at a time; a page the station calls too big is asked for again, smaller.
 */
export async function readAudit(client: BaskStreamClient, since: number, until: number): Promise<{ entries: AuditEntry[]; notes: string[] }> {
  const notes: string[] = [];
  const entries: AuditEntry[] = [];
  const ord = await auditHistoryOrd(client);
  if (!ord) return { entries, notes: ["No audit history was found on this station, so what people changed, and overrides, are not listed."] };
  try {
    const described = (((await client.call("describe_history", { ord })).history as Json | undefined)?.histories ?? []) as Json[];
    const first = Number(described[0]?.firstTimestamp);
    if (described[0] && Number(described[0].totalCount) === 0) notes.push("The audit log is empty.");
    else if (Number.isFinite(first) && first > since) notes.push(`The audit log starts ${whenText(first)}, after the ${whenText(since)} asked for: changes before that are gone.`);
  } catch (error) {
    if (isLost(error)) throw error;
    // How far back it reaches is a note, not a need: the read below says what there is.
  }
  let start = since;
  let limit = 500;
  let read = 0;
  for (;;) {
    let history: Json;
    try {
      history = await client.history(ord, { start, end: until, limit });
    } catch (error) {
      if (isLost(error)) throw error;
      if (error instanceof BaskStreamError && error.code === "response_too_large" && limit > 20) {
        limit = Math.floor(limit / 3);
        continue;
      }
      notes.push(`The audit log could not be read (${whyNot(error, "read_history")}), so what people changed, and overrides, are not listed.`);
      break;
    }
    const list = ((history.histories ?? []) as Json[])[0];
    const records = (list?.records ?? []) as Json[];
    if (!list && read === 0) notes.push("No audit history was found on this station, so what people changed, and overrides, are not listed.");
    let last = start;
    for (const record of records) {
      const entry = parseAuditRecord(record);
      if (typeof record.timestamp === "number") last = Math.max(last, record.timestamp);
      if (entry) entries.push(entry);
    }
    read += records.length;
    if (!list?.truncated || records.length === 0) break;
    if (read >= AUDIT_CAP) {
      notes.push(`The audit log has more than ${AUDIT_CAP} records in this time. It is read oldest first, so the newest are missing: ask for a shorter time.`);
      break;
    }
    start = last + 1;
  }
  return { entries: entries.sort((a, b) => a.at - b.at), notes };
}

// ---- Events -----------------------------------------------------------------------------------------

/** An event on its way to the list, with what is needed to match it against the other sources. */
type Draft = LogEvent & { action?: string; reason?: string; phase?: "asked" | "approved" | "decided" | "done" | "refused" | "reverted"; level?: 1 | 8 };

const slotOrdOf = (target: unknown) => {
  const ord = toSlotOrd(String(target ?? ""));
  return ord.startsWith("slot:") ? ord : undefined;
};
/** A short name for where something happened: "VAV_105/ZoneTemp" for a point, "AHU_01" for equipment on a network. */
export function whereText(ord: string | undefined, target = ""): string {
  if (!ord) return target.replace(/^file:/, "");
  const short = place(ord);
  const [first, ...rest] = short.split("/");
  return rest.length && /Network$|^Drivers$|^Config$/.test(first) ? rest.join("/") : short;
}
const where = whereText;
const sameAction = (a: string, b: string) => a.replace(/_/g, "").toLowerCase() === b.replace(/_/g, "").toLowerCase();
const OPENS = /^(emergency_?)?(override|active|inactive)$/i;
const RELEASES = /^(emergency_?)?auto$/i;

/** One event for each audit record that is a change, with each override given the time it was released. */
function auditEvents(entries: AuditEntry[], agentUsers: Set<string>): Draft[] {
  const events: Draft[] = [];
  /** The override still open at a point's level 8 (an operator's) or level 1 (an emergency). */
  const open = new Map<string, Draft>();
  for (const e of entries) {
    // The agent log carries baskStream's own records with their fields; a model plan's bookkeeping
    // repeats what Niagara's Added, Changed and Removed records beside it say; a login changes nothing.
    if (e.operation === "Agent" || /^model_/.test(e.operation) || /^log(in|out|ged)/i.test(e.operation)) continue;
    const ord = slotOrdOf(e.target);
    const slot = plain(e.slot);
    const at = where(ord, e.target);
    const base: Draft = { at: e.at, kind: "change", who: e.user, ...(agentUsers.has(e.user) ? { agent: true } : {}), ...(ord ? { ord } : {}), ...(slot ? { slot } : {}), ...(e.oldValue ? { from: e.oldValue } : {}), ...(e.value ? { to: e.value } : {}), text: "", source: "audit", action: slot };
    if (e.operation === "Invoked" && OPENS.test(slot)) {
      const level = /^emergency/i.test(slot) ? 1 : 8;
      const key = `${ord ?? e.target}|${level}`;
      // A second override at the same level takes the first one's place.
      const earlier = open.get(key);
      if (earlier) Object.assign(earlier, { until: e.at });
      const word = /override$/i.test(slot) ? "" : ` ${slot.replace(/^emergency_?/i, "").toLowerCase()}`;
      const event: Draft = { ...base, kind: "override", level, text: `${level === 1 ? "emergency override of" : "overrode"} ${at}${word}${e.value ? ` to ${e.value}` : ""}` };
      open.set(key, event);
      events.push(event);
    } else if (e.operation === "Invoked" && RELEASES.test(slot)) {
      const level = /^emergency/i.test(slot) ? 1 : 8;
      const held = open.get(`${ord ?? e.target}|${level}`);
      if (held) {
        Object.assign(held, { until: e.at });
        open.delete(`${ord ?? e.target}|${level}`);
      }
      events.push({ ...base, text: `released the ${level === 1 ? "emergency " : ""}override on ${at}${held ? `, in place ${spanText(e.at - held.at)}` : ""}` });
    } else if (e.operation === "Invoked") events.push({ ...base, text: slot === "set" ? `set ${at}${e.value ? ` to ${e.value}` : ""}` : `ran ${slot || "an action"} on ${at}${e.value ? ` (${e.value})` : ""}` });
    // Tags and relations are recorded with the slot "tag:<id>" or "relation:<id>"; a marker tag's value is M.
    else if (/^tag:/.test(slot)) events.push({ ...base, text: e.operation === "Removed" ? `removed the tag ${slot.slice(4)} from ${at}` : `tagged ${at} ${slot.slice(4)}${e.value && e.value !== "M" ? ` = ${e.value}` : ""}` });
    else if (/^relation:/.test(slot)) events.push({ ...base, text: e.operation === "Removed" ? `removed the relation ${slot.slice(9)} from ${at}` : `related ${at} to ${e.value ? whereText(slotOrdOf(e.value.startsWith("/") ? `slot:${e.value}` : e.value), e.value) : "another component"} (${slot.slice(9)})` });
    else if (e.operation === "Changed") events.push({ ...base, text: e.oldValue ? `changed ${at} ${slot} from ${e.oldValue} to ${e.value || "nothing"}` : `set ${at} ${slot}${e.value ? ` to ${e.value}` : ""}` });
    else if (e.operation === "Added") events.push({ ...base, text: `added ${slot || "a component"} to ${at}` });
    else if (e.operation === "Removed") events.push({ ...base, text: `removed ${slot || "a component"} from ${at}` });
    else if (e.operation === "Renamed") events.push({ ...base, text: `renamed ${e.oldValue || slot} to ${e.value} in ${at}` });
    else events.push({ ...base, text: [e.operation.replace(/_/g, " "), at, slot, e.value].filter(Boolean).join(" ") });
  }
  return events;
}

const OUTCOME = /^(proposed|approved|rejected|expired|failed|reverted|revert failed|check failed) (\S+)(?: by (.+))?$/;

/** One event for each record of the agent log. */
function agentEvents(records: AgentLogRecord[]): Draft[] {
  return records.filter((r) => typeof r.timestamp === "number").map((r): Draft => {
    const ord = slotOrdOf(r.target);
    const at = where(ord, String(r.target ?? ""));
    const name = r.agent || r.agentUser || r.user;
    const change = r.change ? String(r.change) : String(r.action ?? "");
    const why = r.reason ? `: ${r.reason}` : "";
    const base: Draft = { at: r.timestamp, kind: "agent", who: name, agent: true, ...(ord ? { ord } : {}), ...(r.action ? { slot: String(r.action) } : {}), text: "", source: "agentLog", action: String(r.action ?? ""), ...(r.reason ? { reason: String(r.reason) } : {}) };
    const outcome = String(r.outcome ?? "");
    const said = OUTCOME.exec(outcome);
    if (said) {
      const [, what, id, by] = said;
      if (what === "proposed") return { ...base, kind: "proposal", id, phase: "asked", text: `asked to ${change} on ${at} (${id})${why}` };
      // A decision is the decider's: the person who approved or rejected it, or nobody when it ran out.
      const person = by ?? (what === "expired" || what === "check failed" ? undefined : r.user);
      const words = what === "expired" ? `${id} ran out with nobody deciding` : what === "check failed" ? `the check after ${id} failed` : what === "revert failed" ? `could not put ${id} back` : what === "reverted" ? `put ${id} back` : `${what} ${id}`;
      return { ...base, kind: "proposal", id, who: person, phase: what === "reverted" || what === "revert failed" ? "reverted" : what === "approved" ? "approved" : "decided", text: `${words}: ${change} on ${at}, asked by ${name}` };
    }
    if (/^refused/.test(outcome)) return { ...base, phase: "refused", text: `was refused${r.code ? ` (${r.code})` : ""}: ${change} on ${at}${why}` };
    return { ...base, phase: "done", text: `${change} on ${at}${why}` };
  });
}

/** One event for each alarm record. */
function alarmEvents(alarms: Json[]): Draft[] {
  const seen = new Set<string>();
  const events: Draft[] = [];
  for (const alarm of alarms) {
    const id = String(alarm.uuid ?? "");
    if (typeof alarm.timestamp !== "number" || (id && seen.has(id))) continue;
    seen.add(id);
    const ord = slotOrdOf(((alarm.sources ?? []) as unknown[])[0]);
    const state = alarmState(alarm);
    const normal = typeof alarm.normalTime === "number" && alarm.normalTime >= alarm.timestamp ? alarm.normalTime : undefined;
    const cls = String(alarm.alarmClass ?? "");
    const now = normal !== undefined ? `back to normal ${whenText(normal)}` : state === "normal" ? "back to normal" : `still ${state === "offnormal" || !state ? "in alarm" : `in ${state}`}`;
    const acked = String(alarm.ackState ?? "").toLowerCase() === "acked" ? "acknowledged" : "not acknowledged";
    const source = ord ? place(ord) : String((alarm.data as Json | undefined)?.sourceName ?? "");
    events.push({ at: alarm.timestamp, kind: "alarm", ...(ord ? { ord } : {}), text: `${alarmMessage(alarm) || "alarm"}${source ? ` on ${source}` : ""} · ${[cls, now, acked].filter(Boolean).join(", ")}`, ...(normal !== undefined ? { until: normal } : {}), ...(id ? { id } : {}), source: "alarm" });
  }
  return events;
}

/** Said of a station too old to list the changes agents made. Nothing is missing from the log for it but their ids. */
export const NO_CHANGE_LIST = "This station's baskStream is older than API 1.14 and keeps no list of the changes agents made (list_changes): those come from the agent log, without the ids they could be put back by.";

/** How close two records' times must be to be the same change seen twice. */
const SAME = 5000;

/**
 * Events for the proposals and changes the station lists, leaving out what the agent log already
 * told. A change an agent made by itself is in the agent log without the id it can be put back by:
 * the id goes on that event (or on Niagara's record of it, when the two were made one).
 */
function listedEvents(listed: Proposal[], known: Draft[], folded: Map<Draft, Draft>): Draft[] {
  const told = new Set(known.filter((e) => e.id && e.phase).map((e) => `${e.id}|${e.phase === "approved" ? "decided" : e.phase}`));
  const out: Draft[] = [];
  for (const c of listed) {
    const ord = slotOrdOf(c.point);
    const at = where(ord, String(c.point ?? ""));
    const name = c.actor?.name || c.agentUser;
    const what = c.description || `${c.action} ${String(c.value ?? "")}`.trim();
    const why = c.reason ? `: ${c.reason}` : "";
    const base: Draft = { at: c.createdAt, kind: "proposal", who: name, agent: true, ...(ord ? { ord } : {}), ...(c.action ? { slot: c.action } : {}), text: "", id: c.id, source: "changes", action: c.action };
    if (c.direct) {
      // A change the agent made by itself. The agent log has it too, without the id it can be put back by.
      const twin = known.find((e) => e.phase === "done" && !e.id && Math.abs(e.at - c.createdAt) <= SAME && (e.ord ?? "") === (ord ?? ""));
      if (twin) (folded.get(twin) ?? twin).id = twin.id = c.id;
      else if (typeof c.createdAt === "number") out.push({ ...base, kind: "agent", phase: "done", text: `${what} on ${at}${why}` });
    } else if (typeof c.createdAt === "number" && !told.has(`${c.id}|asked`)) out.push({ ...base, phase: "asked", text: `asked to ${what} on ${at} (${c.id})${why}` });
    const waiting = known.find((e) => e.id === c.id && e.phase === "asked") ?? out.find((e) => e.id === c.id && e.phase === "asked");
    if (waiting && c.status === "pending") waiting.text += " · waiting for a person";
    if (!c.direct && typeof c.decidedAt === "number" && ["approved", "rejected", "expired", "failed", "reverted"].includes(c.status) && !told.has(`${c.id}|decided`)) {
      const words = c.status === "expired" ? `${c.id} ran out with nobody deciding` : c.status === "reverted" ? `approved ${c.id}` : `${c.status} ${c.id}`;
      out.push({ ...base, at: c.decidedAt, who: c.decidedBy || undefined, phase: "decided", text: `${words}: ${what} on ${at}, asked by ${name}` });
    }
    if (typeof c.revertedAt === "number" && !told.has(`${c.id}|reverted`)) out.push({ ...base, at: c.revertedAt, who: c.revertedBy || undefined, phase: "reverted", text: `put ${c.id} back: ${what} on ${at}, asked by ${name}` });
  }
  return out;
}

/**
 * What happened between two times, newest first, from the audit history, the alarms, the agent log
 * and the proposals and changes. `notes` says in plain words what could not be read or is not whole.
 */
export async function readLog(client: BaskStreamClient, options: LogOptions): Promise<{ events: LogEvent[]; notes: string[] }> {
  const now = Date.now();
  const { since } = options;
  const until = options.until ?? now;
  const notes: string[] = [];
  const guard = async <T>(read: () => Promise<T>, failed: (error: unknown) => string): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      if (isLost(error)) throw error;
      notes.push(failed(error));
      return undefined;
    }
  };

  // The audit history is read on to now, past `until`, so an override set inside the time asked for
  // and released after it is still known to be released.
  const [audit, alarms, agentLog, listed] = await Promise.all([
    readAudit(client, since, Math.max(until, now)),
    guard(() => client.alarms({ scope: "all", order: "newest", limit: 5000, filter: { since, until } }), (error) => `Alarms could not be read (${whyNot(error, "read_alarms")}).`),
    guard(() => client.agentLog({ since, limit: 1000 }), (error) => `The agent log could not be read (${whyNot(error, "read_agent_log")}), so what AI agents asked for and did is not listed.`),
    (async (): Promise<Proposal[] | undefined> => {
      try {
        return await client.changes();
      } catch (error) {
        if (isLost(error)) throw error;
        if (!(error instanceof BaskStreamError && /unsupported|unknown_op/.test(error.code))) return void notes.push(`The list of agent changes could not be read (${whyNot(error, "list_changes")}).`);
        notes.push(NO_CHANGE_LIST);
      }
      return guard(() => client.proposals(), (error) => `Proposals could not be read (${whyNot(error, "list_proposals")}).`);
    })()
  ]);
  notes.push(...audit.notes);
  if (alarms?.truncated === true) notes.push(`There are more alarms in this time than the ${((alarms.alarms ?? []) as Json[]).length} read: the oldest are missing.`);
  if (agentLog?.truncated) notes.push(`The agent log has more records in this time than the ${agentLog.records.length} read: the oldest are missing.`);

  const records = agentLog?.records ?? [];
  // An agent's own Niagara user is known from the agent log; what that user did in the audit history was an agent's doing.
  const agentUsers = new Set(records.flatMap((r) => (r.agentUser ? [r.agentUser] : r.agent ? [r.user] : [])));
  for (const c of listed ?? []) if (c.agentUser) agentUsers.add(c.agentUser);
  const fromAudit = auditEvents(audit.entries, agentUsers);
  const fromAgents = agentEvents(records);

  // A point command an agent asked for is in both: Niagara's record of the command (by the approver,
  // or by the agent's user) and the agent log's record beside it. They are one thing that happened, so
  // the agent's name, reason and proposal go on Niagara's record and the other is left out.
  const folded = new Map<Draft, Draft>();
  const taken = new Set<Draft>();
  for (const a of fromAgents) {
    if (!a.ord || !(a.phase === "done" || a.phase === "approved")) continue;
    const twin = fromAudit.find((e) => e.ord === a.ord && !taken.has(e) && Math.abs(e.at - a.at) <= SAME && sameAction(e.action ?? "", a.action ?? ""));
    if (!twin) continue;
    taken.add(twin);
    const asked = fromAgents.find((e) => e.id === a.id && e.phase === "asked");
    const name = asked?.who ?? (a.phase === "done" ? a.who : undefined) ?? "an AI agent";
    Object.assign(twin, { agent: true, ...(a.id ? { id: a.id } : {}) });
    twin.reason = a.phase === "approved" ? `approving ${a.id}, asked by ${name}` : `${name}${a.reason ? `: ${a.reason}` : ""}`;
    folded.set(a, twin);
  }
  const agents = fromAgents.filter((e) => !folded.has(e));
  const drafts: Draft[] = [...fromAudit, ...agents, ...alarmEvents(((alarms?.alarms ?? []) as Json[])), ...listedEvents(listed ?? [], fromAgents, folded)];

  // An override nobody released may still have ended: one set for a time runs out without a record.
  // The point itself says whether it is overridden now.
  const hanging = drafts.filter((e) => e.kind === "override" && e.until === undefined && e.ord);
  if (hanging.length) {
    const ords = [...new Set(hanging.map((e) => e.ord!))].slice(0, 500);
    const snaps = await guard(() => client.read(ords, { fields: ["point", "ok", "status"] }), (error) => `Whether each override is still in place could not be read (${whyNot(error, "read")}).`);
    const status = new Map((snaps ?? []).filter((snap) => !snap.code).map((snap) => [toSlotOrd(snap.point), String(snap.status ?? "")]));
    for (const e of hanging) {
      const read = status.get(e.ord!);
      if (read !== undefined && !/overridden/.test(read)) e.ended = true;
    }
  }
  for (const e of drafts) {
    if (e.kind === "override") {
      if (e.until !== undefined) e.text += ` · released ${whenText(e.until)}, in place ${spanText(e.until - e.at)}`;
      else e.text += e.ended ? " · no longer in place; the audit log does not say when it ended" : " · still in place";
    }
    // What an agent had to do with one of Niagara's own records: it asked for it, or it did it.
    if (e.source === "audit" && e.reason) e.text += ` · ${e.reason}`;
  }

  const branch = options.under ? asSlotOrd(options.under).replace(/\/+$/, "") : "";
  const under = branch && branch !== "slot:" ? branch : undefined;
  const kept = drafts
    .filter((e) => e.at >= since && e.at <= until && (!under || (e.ord !== undefined && (e.ord === under || e.ord.startsWith(`${under}/`)))))
    .sort((a, b) => b.at - a.at || (a.source < b.source ? -1 : 1));
  const limit = options.limit && options.limit > 0 ? options.limit : 2000;
  if (kept.length > limit) notes.push(`${kept.length - limit} older events are left out: only the newest ${limit} are listed.`);
  const events = kept.slice(0, limit).map((draft): LogEvent => {
    const { action: _action, reason: _reason, phase: _phase, level: _level, ...event } = draft;
    if (event.who === undefined) delete event.who;
    return event;
  });
  return { events, notes: [...new Set(notes)] };
}

// ---- Output -----------------------------------------------------------------------------------------

/** Who an event is by. An agent's own Niagara user is marked, so its change is not taken for a person's. */
export const whoText = (e: LogEvent) => (e.who ? `${e.who}${e.agent && e.source === "audit" && !e.id ? " (AI)" : ""}` : "");

const MARKS: Record<LogEvent["kind"], string> = { alarm: "▲", override: "◆", change: "•", agent: "◇", proposal: "?", note: "✎" };
const COLORS: Record<LogEvent["kind"], (text: string) => string> = { alarm: chalk.red, override: chalk.cyan, change: (text) => text, agent: chalk.magenta, proposal: chalk.yellow, note: chalk.green };

/** The events as lines, newest first: the time, a mark for the kind, who, and what happened. */
export function logText(events: LogEvent[], options: { width?: number } = {}): string {
  if (events.length === 0) return "Nothing happened in this time.";
  const sorted = [...events].sort((a, b) => b.at - a.at);
  const whoOf = whoText;
  const whoWidth = Math.min(18, Math.max(0, ...sorted.map((e) => whoOf(e).length)));
  const clip = (text: string, room: number) => ([...text].length <= room ? text : `${[...text].slice(0, Math.max(1, room - 1)).join("")}…`);
  return sorted.map((e) => {
    const head = `${whenText(e.at).padStart(12)}  ${COLORS[e.kind](MARKS[e.kind])}  ${clip(whoOf(e), whoWidth).padEnd(whoWidth)}${whoWidth ? "  " : ""}`;
    return `${chalk.dim(head.slice(0, 12))}${head.slice(12)}${options.width ? clip(e.text, Math.max(10, options.width - visibleLength(head))) : e.text}`;
  }).join("\n");
}

/** The marks `logText` uses, in a line. */
export const LOG_LEGEND = `${MARKS.change} change  ${MARKS.override} override  ${MARKS.alarm} alarm  ${MARKS.agent} AI agent  ${MARKS.proposal} asked, waiting or decided  ${MARKS.note} note`;
