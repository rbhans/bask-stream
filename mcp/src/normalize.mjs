// Shapes the station's replies for tools: nodes, point values and alarms, plus readable errors.
// Adapted from Brick/BAS's baskStream bridge (scripts/baskstream-bridge.mjs).
import { BaskStreamError, toSlotOrd } from "@basidekick/baskstream"

const str = (value) => (typeof value === "string" && value ? value : null)
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null)

/** A browse, describe or search node. */
export function toNode(node) {
  return {
    ord: toSlotOrd(node.ord),
    name: node.name,
    display: str(node.display) ?? node.name,
    kind: str(node.kind) ?? "component",
    typeSpec: str(node.typeSpec) ?? "",
    hasChildren: Boolean(node.hasChildren),
    writable: Boolean(node.writable),
    ...(str(node.status) ? { status: node.status } : {}),
  }
}

/**
 * The one status a graphic shows for a Niagara status string such as "{alarm,unackedAlarm}" or
 * "{overridden} @ 8", in Niagara's priority order: disabled, fault, down, alarm, stale,
 * overridden. "ok" when none applies; "error" when the read itself failed.
 */
export function stateOf(status, ok = true) {
  if (!ok) return "error"
  const s = String(status ?? "").toLowerCase()
  if (s.includes("disabled")) return "disabled"
  if (s.includes("fault")) return "fault"
  if (s.includes("down")) return "down"
  if (s.includes("alarm")) return "alarm"
  if (s.includes("stale")) return "stale"
  if (s.includes("overridden")) return "overridden"
  return "ok"
}

/** A point value as read or pushed by COV. */
export function toValue(snapshot) {
  const facets = snapshot.facets ?? {}
  const ok = Boolean(snapshot.ok)
  return {
    point: toSlotOrd(snapshot.point),
    ok,
    value: snapshot.value ?? null,
    display: str(snapshot.displayValue) ?? (snapshot.value === undefined || snapshot.value === null ? "--" : String(snapshot.value)),
    status: str(snapshot.status) ?? (ok ? "{ok}" : "{unknown}"),
    state: stateOf(snapshot.status, ok),
    units: str(facets.units),
    valueType: str(snapshot.valueType),
    timestamp: num(snapshot.timestamp),
    ...(ok ? {} : { error: str(snapshot.message) ?? str(snapshot.code) ?? "read failed" }),
  }
}

export function toAlarm(alarm) {
  return {
    uuid: String(alarm.uuid),
    timestamp: num(alarm.timestamp),
    priority: num(alarm.priority),
    alarmClass: str(alarm.alarmClass),
    sourceState: str(alarm.sourceState),
    ackState: str(alarm.ackState),
    source: Array.isArray(alarm.sources) && alarm.sources[0] ? toSlotOrd(String(alarm.sources[0])) : str(alarm.source),
    message: str(alarm.data?.msgText) ?? str(alarm.message) ?? "Alarm",
  }
}

/** Rollup buckets [{t, avg, min, max}] and their overall stats. */
export function toHistory(rollup) {
  const history = (rollup?.rollup?.histories ?? rollup?.histories ?? [])[0]
  const buckets = (history?.buckets ?? []).map((b) => ({ t: Number(b.start), avg: num(b.avg), min: num(b.min), max: num(b.max) }))
  const values = buckets.map((b) => b.avg).filter((v) => v !== null)
  const round = (v) => (v === null ? null : Math.round(v * 1000) / 1000)
  const stats = values.length
    ? { min: round(Math.min(...values)), max: round(Math.max(...values)), average: round(values.reduce((a, b) => a + b, 0) / values.length), first: round(values[0]), last: round(values[values.length - 1]) }
    : null
  return { buckets, stats }
}

/** A message a person can act on, for any failure. */
export function friendly(error) {
  if (error instanceof BaskStreamError) {
    switch (error.code) {
      case "login_failed": return "The station refused the login. Check the username and password in the baskStream extension's settings."
      case "session_expired":
        if (/login page/.test(error.message)) return "The station sent the browser to its login page, so this session can't open web pages. Check that the Niagara user may use the station's web interface."
        return "The station session expired and there is no password to log in again. Set the password in the baskStream extension's settings."
      case "browser_not_found": case "snapshot_failed": return error.message
      case "timeout": return `The station didn't answer in time (${error.op ?? "request"}).`
      case "not_connected": case "connection_closed": return "Not connected to the station. It reconnects on its own; try again shortly."
      default: return error.code && error.message && error.message !== error.code ? `${error.code}: ${error.message}` : error.message || error.code
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = String(error?.code ?? error?.cause?.code ?? "")
  if (/CERT|SELF_SIGNED/.test(code) || /self[- ]signed certificate in|unable to verify the first certificate/i.test(message)) return "The station's certificate isn't trusted. Turn on \"Allow self-signed certificate\" in the extension's settings if you trust this station."
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH/.test(message)) return `Can't reach the station (${message.match(/E[A-Z]+/)?.[0]}).`
  return message
}
