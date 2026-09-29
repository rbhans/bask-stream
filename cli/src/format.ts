import chalk from "chalk";

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleLength = (text: string) => text.replace(ANSI, "").length;

/** A display string for any protocol value. */
export function fmtValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.display === "string") return object.display;
    if ("value" in object) return fmtValue(object.value);
  }
  return JSON.stringify(value);
}

/** The best display for a point snapshot: its display value, else value + units. */
export function fmtPoint(snapshot: Record<string, unknown>): string {
  if (snapshot.code) return String(snapshot.code); // an error entry; ok:false alone just means a non-ok status
  if (typeof snapshot.displayValue === "string") return snapshot.displayValue;
  const units = (snapshot.facets as Record<string, unknown> | undefined)?.units;
  return `${fmtValue(snapshot.value)}${units ? ` ${units}` : ""}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export function fmtTime(ms: unknown, withDate = true): string {
  if (typeof ms !== "number") return "—";
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}

export function ago(ms: unknown, now = Date.now()): string {
  if (typeof ms !== "number") return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

/** "90s", "15m", "24h", "7d", "2w" → milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(text.trim());
  if (!match) throw new Error(`Bad duration "${text}" (use e.g. 30s, 15m, 24h, 7d).`);
  return Math.round(Number(match[1]) * UNITS[match[2]]);
}

export function fmtDuration(ms: number): string {
  for (const unit of ["w", "d", "h", "m", "s"]) if (ms % UNITS[unit] === 0) return `${ms / UNITS[unit]}${unit}`;
  return `${ms}ms`;
}

/** "now", a duration ago ("24h"), an ISO date or epoch milliseconds → epoch milliseconds. */
export function parseTime(text: string, now = Date.now()): number {
  if (text === "now") return now;
  if (/^\d{11,}$/.test(text)) return Number(text);
  if (/^-?\d+(?:\.\d+)?(ms|s|m|h|d|w)$/.test(text)) return now - parseDuration(text.replace(/^-/, ""));
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`Bad time "${text}" (use now, 24h, 2026-09-01 or 2026-09-01T08:00).`);
  return parsed;
}

/** Parses a typed value: true/false, numbers, else the string. */
export function parseValue(text: string): boolean | number | string {
  if (/^(true|on|active)$/i.test(text)) return true;
  if (/^(false|off|inactive)$/i.test(text)) return false;
  if (text.trim() !== "" && !Number.isNaN(Number(text))) return Number(text);
  return text;
}

/** The last one or two path segments of an ORD, for compact labels. */
export function shortOrd(ord: string, segments = 2): string {
  const parts = ord.replace(/^.*slot:\//, "").split("/").filter(Boolean);
  return parts.slice(-segments).join("/") || ord;
}

/** Case-insensitive alarm state checks (stations report "Unacked", "Normal", …). */
export const isUnacked = (alarm: Record<string, unknown>) => String(alarm.ackState ?? "").toLowerCase() === "unacked";
export const alarmState = (alarm: Record<string, unknown>) => String(alarm.sourceState ?? "").toLowerCase();

/** An alarm's message text, with unresolved "%lexicon(module:key)%" references shown as the key. */
export function alarmMessage(alarm: Record<string, unknown>): string {
  const text = String(((alarm.data ?? {}) as Record<string, unknown>).msgText ?? alarm.summary ?? "");
  return text.replace(/%lexicon\([^:)]*:([^)]*)\)%/g, (_m, key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
}

const BARS = "▁▂▃▄▅▆▇█";
export function sparkline(values: number[], width = values.length): string {
  const data = values.slice(-width);
  if (data.length === 0) return "";
  const min = Math.min(...data);
  const max = Math.max(...data);
  return data.map((v) => BARS[max === min ? 3 : Math.round(((v - min) / (max - min)) * (BARS.length - 1))]).join("");
}

export function statusColor(status: unknown): (text: string) => string {
  const s = typeof status === "string" ? status : "";
  if (/alarm|unackedAlarm/.test(s)) return chalk.red;
  if (/fault|down/.test(s)) return chalk.magenta;
  if (/stale|disabled|null/.test(s)) return chalk.yellow;
  if (/overridden/.test(s)) return chalk.cyan;
  return chalk.green;
}

/** Plain aligned table with a dim header. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ""))));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c + " ".repeat(widths[i] - visibleLength(c)))).join("  ").trimEnd();
  return [chalk.dim(line(headers)), ...rows.map(line)].join("\n");
}

export function csv(headers: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    const text = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}
