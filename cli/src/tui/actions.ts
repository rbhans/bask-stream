import type { BaskStreamClient, BrowseNode, PointSnapshot } from "@basidekick/baskstream";
import { fmtValue, place } from "../format.js";
import { statusTone, theme } from "./theme.js";
import type { Choice, Ui } from "./ui.js";

/** What kind of value a point holds, from a snapshot. */
export function valueKind(s: PointSnapshot | undefined): "boolean" | "enum" | "numeric" | "text" {
  if (!s) return "numeric";
  const options = (s.enumOptions as { tag: string }[] | undefined) ?? [];
  const tags = options.map((o) => o.tag).sort().join(",");
  if (typeof s.value === "boolean" || /bool/i.test(String(s.valueType ?? "")) || tags === "false,true") return "boolean";
  if (options.length > 0 || /enum/i.test(String(s.valueType ?? ""))) return "enum";
  if (typeof s.value === "number" || /numeric|double|float|int|long/i.test(String(s.valueType ?? ""))) return "numeric";
  return "text";
}

const DURATIONS: Choice<number>[] = [
  { label: "Until released", value: 0 },
  { label: "15 minutes", value: 900 },
  { label: "30 minutes", value: 1800 },
  { label: "1 hour", value: 3600 },
  { label: "2 hours", value: 7200 },
  { label: "4 hours", value: 14400 },
  { label: "8 hours", value: 28800 }
];

/** Asks for a value that suits the point: a choice for booleans and enums, typed text otherwise. */
function askValue(ui: Ui, label: string, snapshot: PointSnapshot | undefined, onValue: (value: unknown) => void): void {
  const kind = valueKind(snapshot);
  const facets = (snapshot?.facets ?? {}) as Record<string, unknown>;
  if (kind === "boolean") {
    return ui.select(label, [
      { label: String(facets.trueText ?? "true"), value: true as unknown, hint: "true" },
      { label: String(facets.falseText ?? "false"), value: false as unknown, hint: "false" }
    ], onValue);
  }
  if (kind === "enum") {
    const options = ((snapshot?.enumOptions ?? []) as { tag: string; display?: string; ordinal?: number }[]).map((o) => ({ label: o.display ?? o.tag, value: o.tag as unknown, hint: o.ordinal === undefined ? "" : String(o.ordinal) }));
    if (options.length) return ui.select(label, options, onValue);
  }
  ui.prompt(label, (text) => {
    const trimmed = text.trim();
    if (trimmed === "") return ui.toast("No value entered.", "warn");
    if (kind === "numeric" && Number.isNaN(Number(trimmed))) return ui.toast(`"${trimmed}" is not a number.`, "bad");
    onValue(kind === "numeric" ? Number(trimmed) : trimmed);
  }, { initial: kind === "numeric" && typeof snapshot?.value === "number" ? String(Math.round(snapshot.value * 100) / 100) : "", hint: facets.units ? `in ${String(facets.units)}` : undefined });
}

/** Override, set, release or emergency-command a writable point, asking for each detail in turn. */
export function commandPoint(ui: Ui, client: BaskStreamClient, ord: string, snapshot?: PointSnapshot, only?: string): void {
  if (!ui.canWrite("command points")) return;
  const name = place(ord);
  const send = (action: string, value?: unknown, durationSec = 0) => {
    const what = `${action.replace("_", " ")} ${name}${value === undefined ? "" : ` = ${fmtValue(value)}`}${durationSec ? ` for ${durationSec / 60} min` : ""}`;
    ui.confirm(`${what[0].toUpperCase()}${what.slice(1)}?`, async () => {
      const result = await ui.attempt(action, () => client.write(ord, action, value, durationSec ? { durationSec } : {}));
      if (!result) return;
      if (result.ok === false) ui.toast(`${what}: ${result.code} ${result.message ?? ""}`, "bad");
      else if (result.outcome === "proposed") ui.toast(`${what}: proposed, waiting for a person to approve`, "warn");
      else ui.toast(`${what} → ${result.displayValue ?? fmtValue(result.value)} ${result.status ?? ""}`, "good");
    }, { title: "Command point" });
  };
  const run = (action: string) => {
    if (action === "auto" || action === "emergency_auto") return send(action);
    askValue(ui, `${action === "set" ? "Set fallback of" : action === "override" ? "Override" : "Emergency override"} ${name} to`, snapshot, (value) => {
      if (action === "override") ui.select("Hold the override for", DURATIONS, (seconds) => send(action, value, seconds));
      else send(action, value);
    });
  };
  if (only) return run(only);
  ui.select(`Command ${name}`, [
    { label: "Override…", value: "override", hint: "hold a value at operator priority" },
    { label: "Set…", value: "set", hint: "change the fallback value" },
    { label: "Auto", value: "auto", hint: "release the override" },
    { label: "Emergency override…", value: "emergency_override", hint: "priority 1" },
    { label: "Release emergency", value: "emergency_auto", hint: "back to normal control" }
  ], run);
}

/** A glyph and colour for a station node, from its kind and type. */
export function nodeLook(node: Pick<BrowseNode, "kind" | "typeSpec" | "writable"> & { status?: unknown }): { icon: string; color?: string } {
  const type = node.typeSpec ?? "";
  if (node.kind === "point") return { icon: node.writable ? "◉" : "●", color: node.status === undefined ? theme.info : statusTone(node.status) };
  if (node.kind === "schedule") return { icon: "◷", color: theme.accent2 };
  if (/Network$/.test(type)) return { icon: "◈", color: theme.accent };
  if (/Device$/.test(type)) return { icon: "▣", color: /down|fault/.test(String(node.status ?? "")) ? theme.bad : theme.accent };
  if (/Service$|ServiceContainer$/.test(type)) return { icon: "◆", color: theme.muted };
  if (node.kind === "container") return { icon: "□", color: theme.accent };
  return { icon: "◇" };
}
