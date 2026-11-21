// bask check: the rules. A rule is data: where its rows come from (a query, a walk of the station
// tree, or the graphics punch list), a test that picks the rows that are findings, and a severity.
// The starter set below ships with bask; a rule file (--rules) adds to it or replaces parts of it.
import { readFileSync } from "node:fs";

export type Severity = "error" | "warning" | "review" | "info";
export const SEVERITIES: Severity[] = ["error", "warning", "review", "info"];

/** One comparison on a row's field. `value` is text; matches and notMatches take a regular expression (case ignored). */
export interface Condition {
  field: string;
  op: "equals" | "notEquals" | "matches" | "notMatches" | "above" | "below" | "empty" | "notEmpty";
  value?: string | number | boolean;
}

export type Test =
  /** Every row the source returns is a finding. */
  | { is: "found" }
  /** A row is a finding when every condition holds. */
  | { is: "compare"; all: Condition[] }
  /** Rows that share a value of `field` with another row (empty values are left out). */
  | { is: "duplicate"; field: string }
  /** A number outside the min and max of its own facets. */
  | { is: "outsideFacets"; value: string; facets: string }
  /**
   * "This one lacks what its kind usually has": rows are grouped by `alike` (a field, e.g. the point
   * name); a row is a finding when its `key` is not among the values `having` returns, while at
   * least `share` of the other rows of its group are. Groups under `atLeast` rows are left alone.
   */
  | { is: "missingAmongAlike"; key: string; alike: string; having: { bql: string; field: string }; share?: number; atLeast?: number }
  /**
   * "Nothing uses this": a row is a finding when its `key` is not among the values `by` returns.
   * With `alarms`, a value that is the alarm class of an alarm in the station's alarm database counts as used too.
   */
  | { is: "notNamedBy"; key: string; by: { bql: string; field: string }; alarms?: boolean }
  /** Walk rows only: a name whose separators (_ - space or none) differ from what `share` of its siblings use. */
  | { is: "nameStyle"; share?: number; atLeast?: number }
  /**
   * Walk rows only, for devices: among devices whose names differ only in their digits, one that
   * lacks a point name `share` of the others have.
   */
  | { is: "pointSet"; share?: number; atLeast?: number };

/** Which components of the walked tree are a rule's rows. `*` is the wildcard in `type` and `name`. */
export interface WalkSpec {
  type?: string;
  kind?: string;
  name?: string;
  /** Also ask describe_component for each: adds linksIn and linksOut. */
  describe?: boolean;
  /**
   * Also read each as a schedule: adds events (the number of entries in its week and special events),
   * pastExceptions (special events whose dates name a year and are all over) and pastExceptionNames.
   */
  schedule?: boolean;
}

export interface Rule {
  id: string;
  /** The heading it is listed under, e.g. "Points". */
  group: string;
  title: string;
  /** Left out for the graphics source, whose items carry their own severity. */
  severity?: Severity;
  query?: { bql: string } | { neql: string };
  /**
   * More to read about each row of a query. "overrideAge": from the audit history, how long ago the row's
   * point was overridden (overriddenHours, overriddenFor). "historyAge": from describe_history, how long
   * ago the point's history last recorded (lastRecordHours, lastRecordFor, historyId, historyInterval).
   */
  add?: "overrideAge" | "historyAge";
  walk?: WalkSpec;
  graphics?: boolean;
  test?: Test;
  /** The field that says where a finding is (default: slotPath, parent.slotPath or ord, else the first column). */
  where?: string;
  /** What is wrong, with {field} filled in from the row. */
  message?: string;
  /** Leave out what these rules already found: a finding at, or under, a place one of them reported. */
  unless?: string[];
  /** In a rule file: turn a starter rule off. */
  off?: boolean;
}

const DEFAULT_ACCOUNTS = "^(admin|administrator|guest|test|demo|user|operator|default|niagara|tridium|root|service)$";

/** The rules that ship with bask. */
export const STARTER_RULES: Rule[] = [
  { id: "points.fault", group: "Points", title: "Point in fault", severity: "error", query: { bql: "select slotPath, out from control:ControlPoint where status.fault" }, test: { is: "found" }, message: "in fault: {out}" },
  { id: "points.down", group: "Points", title: "Point down", severity: "error", query: { bql: "select slotPath, out from control:ControlPoint where status.down" }, test: { is: "found" }, message: "down: its device is not answering", unless: ["devices.down"] },
  { id: "points.stale", group: "Points", title: "Point stale", severity: "warning", query: { bql: "select slotPath, out from control:ControlPoint where status.stale" }, test: { is: "found" }, message: "stale: {out}", unless: ["devices.down", "points.down"] },
  {
    id: "points.overriddenLong", group: "Points", title: "Point overridden for more than 8 hours", severity: "warning", query: { bql: "select slotPath, out from control:ControlPoint where status.overridden" }, add: "overrideAge",
    test: { is: "compare", all: [{ field: "overriddenHours", op: "above", value: 8 }] }, message: "overridden {overriddenFor}: {out}"
  },
  { id: "points.overridden", group: "Points", title: "Point overridden", severity: "warning", query: { bql: "select slotPath, out from control:ControlPoint where status.overridden" }, test: { is: "found" }, message: "overridden: {out}", unless: ["points.overriddenLong"] },
  {
    id: "points.noUnits", group: "Points", title: "Numeric point with no units", severity: "info", query: { bql: "select slotPath, facets from control:NumericPoint" },
    test: { is: "compare", all: [{ field: "facets", op: "notMatches", value: "(^|\\|)units=(u:)?(?!null\\b)[^|;]+" }] }, message: "has no units"
  },
  {
    id: "points.outsideFacets", group: "Points", title: "Value outside the point's own range", severity: "warning", query: { bql: "select slotPath, out.value, facets from control:NumericPoint" },
    test: { is: "outsideFacets", value: "out.value", facets: "facets" }, message: "reads {out.value}, outside its facets ({min} to {max})"
  },
  {
    id: "histories.missing", group: "Histories and alarms", title: "No history where points of this name usually have one", severity: "warning", query: { bql: "select slotPath, name from control:ControlPoint" },
    test: { is: "missingAmongAlike", key: "slotPath", alike: "name", having: { bql: "select parent.slotPath from history:HistoryExt", field: "parent.slotPath" } },
    message: "has no history; {have} of the {others} other points named {name} have one"
  },
  {
    id: "alarms.missing", group: "Histories and alarms", title: "No alarm extension where points of this name usually have one", severity: "warning", query: { bql: "select slotPath, name from control:ControlPoint" },
    test: { is: "missingAmongAlike", key: "slotPath", alike: "name", having: { bql: "select parent.slotPath from alarm:AlarmSourceExt", field: "parent.slotPath" } },
    message: "has no alarm extension; {have} of the {others} other points named {name} have one"
  },
  {
    id: "histories.stopped", group: "Histories and alarms", title: "History that stopped recording", severity: "warning", query: { bql: "select parent.slotPath from history:HistoryExt" }, add: "historyAge",
    test: { is: "compare", all: [{ field: "lastRecordHours", op: "above", value: 24 }] }, message: "its history has no record for {lastRecordFor}; it records every {historyInterval}", unless: ["devices.down"]
  },
  {
    id: "alarms.unusedClasses", group: "Histories and alarms", title: "Alarm class nothing uses", severity: "info", query: { bql: "select slotPath, name from alarm:AlarmClass" },
    test: { is: "notNamedBy", key: "name", by: { bql: "select alarmClass from alarm:AlarmSourceExt", field: "alarmClass" }, alarms: true }, message: "no alarm extension names {name}, and none of the {alarmsRead} alarms read is in it"
  },
  { id: "names.devices", group: "Names", title: "Device name written differently from its siblings", severity: "info", walk: { type: "*Device" }, test: { is: "nameStyle" }, message: "{name} is written {style}; {same} of its {siblings} siblings are written {usual}" },
  { id: "names.points", group: "Names", title: "Point name written differently from its siblings", severity: "info", walk: { kind: "point" }, test: { is: "nameStyle" }, message: "{name} is written {style}; {same} of its {siblings} siblings are written {usual}" },
  { id: "names.pointSet", group: "Names", title: "Device missing a point its siblings have", severity: "warning", walk: { type: "*Device" }, test: { is: "pointSet" }, message: "has no {missing}, which {have} of the {others} other {family} devices have{extra}" },
  { id: "devices.down", group: "Devices", title: "Device down", severity: "error", query: { bql: "select slotPath, status from driver:Device where status.down" }, test: { is: "found" }, message: "down" },
  { id: "devices.duplicateAddress", group: "Devices", title: "Devices with the same address", severity: "error", query: { bql: "select slotPath, address from bacnet:BacnetDevice" }, test: { is: "duplicate", field: "address" }, message: "address {address} is also on {others}" },
  { id: "devices.noPoints", group: "Devices", title: "Device with no points", severity: "warning", walk: { type: "*Device" }, test: { is: "compare", all: [{ field: "points", op: "equals", value: 0 }] }, message: "has no points" },
  { id: "networks.empty", group: "Devices", title: "Network with no devices", severity: "warning", walk: { type: "*Network" }, test: { is: "compare", all: [{ field: "children", op: "equals", value: 0 }] }, message: "has no devices" },
  { id: "schedules.unreferenced", group: "Schedules", title: "Schedule nothing is linked to", severity: "info", walk: { kind: "schedule", describe: true }, test: { is: "compare", all: [{ field: "linksOut", op: "equals", value: 0 }] }, message: "no link leaves it: nothing follows this schedule" },
  { id: "schedules.noEvents", group: "Schedules", title: "Schedule with no events", severity: "warning", walk: { kind: "schedule", schedule: true }, test: { is: "compare", all: [{ field: "events", op: "equals", value: 0 }] }, message: "has no events in its week and no special events" },
  {
    id: "schedules.pastExceptions", group: "Schedules", title: "Schedule exception in the past", severity: "info", walk: { kind: "schedule", schedule: true },
    test: { is: "compare", all: [{ field: "pastExceptions", op: "above", value: 0 }] }, message: "special events whose dates are over: {pastExceptionNames}"
  },
  { id: "graphics.qa", group: "Graphics", title: "Graphics punch list", graphics: true },
  {
    id: "security.defaultAccounts", group: "Security posture", title: "Account with a default-looking name", severity: "review", query: { bql: "select name, fullName, enabled from baja:User" }, where: "name",
    test: { is: "compare", all: [{ field: "name", op: "matches", value: DEFAULT_ACCOUNTS }, { field: "enabled", op: "equals", value: true }] },
    message: "user {name} is enabled and has a common default name: review that it is needed. bask did not test it"
  }
];

const TESTS = ["found", "compare", "duplicate", "outsideFacets", "missingAmongAlike", "notNamedBy", "nameStyle", "pointSet"];
const ADDS = ["overrideAge", "historyAge"];
const OPS = ["equals", "notEquals", "matches", "notMatches", "above", "below", "empty", "notEmpty"];

/** Says what is wrong with a rule, or returns it. */
function checked(rule: Rule, from: string): Rule {
  const bad = (what: string) => new Error(`${from}: rule ${rule.id ? `"${rule.id}"` : "(no id)"} ${what}.`);
  if (!rule.id || typeof rule.id !== "string") throw bad("needs an id");
  if (!rule.group || !rule.title) throw bad("needs a group and a title");
  const sources = [rule.query, rule.walk, rule.graphics].filter(Boolean).length;
  if (sources !== 1) throw bad("needs exactly one of query, walk or graphics");
  if (rule.query && typeof (rule.query as { bql?: unknown }).bql !== "string" && typeof (rule.query as { neql?: unknown }).neql !== "string") throw bad("has a query with neither bql nor neql");
  if (rule.graphics) {
    if (rule.severity && !SEVERITIES.includes(rule.severity)) throw bad(`has severity "${rule.severity}"; use ${SEVERITIES.join(", ")}`);
    return rule;
  }
  if (!rule.severity || !SEVERITIES.includes(rule.severity)) throw bad(`needs a severity: ${SEVERITIES.join(", ")}`);
  const test = rule.test;
  if (!test || !TESTS.includes(test.is)) throw bad(`needs a test; "is" is one of ${TESTS.join(", ")}`);
  if (test.is === "compare") {
    if (!Array.isArray(test.all) || test.all.length === 0) throw bad('has a compare test with no conditions ("all": [{"field", "op", "value"}])');
    for (const c of test.all) {
      if (!c.field || !OPS.includes(c.op)) throw bad(`has a condition whose op is not one of ${OPS.join(", ")}`);
      if (c.op === "matches" || c.op === "notMatches") {
        try {
          new RegExp(String(c.value ?? ""));
        } catch (error) {
          throw bad(`has a pattern that is not a regular expression: ${(error as Error).message}`);
        }
      }
    }
  }
  if (test.is === "duplicate" && !test.field) throw bad("has a duplicate test with no field");
  if (test.is === "outsideFacets" && (!test.value || !test.facets)) throw bad("has an outsideFacets test that does not name the value and facets fields");
  if (test.is === "missingAmongAlike" && (!test.key || !test.alike || typeof test.having?.bql !== "string" || !test.having.field)) throw bad("has a missingAmongAlike test without key, alike and having {bql, field}");
  if (test.is === "notNamedBy" && (!test.key || typeof test.by?.bql !== "string" || !test.by.field)) throw bad("has a notNamedBy test without key and by {bql, field}");
  if (rule.add !== undefined && (!ADDS.includes(rule.add) || !rule.query)) throw bad(`has "add": "${String(rule.add)}"; it is one of ${ADDS.join(", ")}, on a rule with a query`);
  if (rule.unless !== undefined && (!Array.isArray(rule.unless) || rule.unless.some((id) => typeof id !== "string"))) throw bad('has an "unless" that is not a list of rule ids');
  if ((test.is === "nameStyle" || test.is === "pointSet") && !rule.walk) throw bad(`has a ${test.is} test, which needs a walk`);
  return rule;
}

/**
 * The rules a check runs: the starter set, changed by a rule file when one is given. The file is
 * {"rules": [...]} or the array itself. A rule whose id is in the starter set replaces the fields
 * it gives ({"id": "points.stale", "severity": "error"}, or "off": true to drop it); any other is
 * added. {"replace": true, "rules": [...]} leaves the starter set out.
 */
export function loadRules(file?: string): Rule[] {
  if (!file) return STARTER_RULES.map((rule) => checked(rule, "starter rules"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} could not be read as JSON: ${(error as Error).message}`);
  }
  const given = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(given)) throw new Error(`${file} holds no rules. It should be {"rules": [...]} or an array of rules.`);
  const replace = !Array.isArray(parsed) && (parsed as { replace?: unknown }).replace === true;
  const rules = new Map<string, Rule>(replace ? [] : STARTER_RULES.map((rule) => [rule.id, rule]));
  for (const entry of given as Rule[]) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") throw new Error(`${file}: every rule needs an id.`);
    const merged = { ...rules.get(entry.id), ...entry };
    // A rule that names a new source does not keep the old one beside it.
    if (entry.query || entry.walk || entry.graphics) for (const source of ["query", "walk", "graphics"] as const) if (!entry[source]) delete merged[source];
    if (merged.off) rules.delete(entry.id);
    else rules.set(entry.id, checked(merged, file));
  }
  return [...rules.values()];
}
