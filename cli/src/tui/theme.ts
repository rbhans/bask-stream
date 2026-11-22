/** Colours for the dashboard. Text without a colour uses the terminal's own foreground. */
export interface Theme {
  name: "dark" | "light";
  accent: string;
  accent2: string;
  good: string;
  warn: string;
  bad: string;
  info: string;
  /** Secondary text. */
  muted: string;
  /** Borders, rules and placeholders. */
  faint: string;
  /** Background of the selected row. */
  selection: string;
  /** Background of the selected row in a panel that does not have the keyboard. */
  selectionDim: string;
  /** Text drawn on an accent background. */
  onAccent: string;
}

// BASidekick's colours (the brand's design tokens): Ink ground, Paper type, one hi-vis accent. Status
// colours belong to data. The map screen paints its own ground (deck/brand.ts); these views sit on
// the terminal's, so the accent here is the one that reads as text.
const DARK: Theme = {
  name: "dark",
  accent: "#d4ff3a",
  accent2: "#27b7ff",
  good: "#3fcf7f",
  warn: "#f0a000",
  bad: "#e5484d",
  info: "#27b7ff",
  muted: "#9ba2ac",
  faint: "#4a5058",
  selection: "#2b3305",
  selectionDim: "#1c2026",
  onAccent: "#0e1013"
};

const LIGHT: Theme = {
  name: "light",
  accent: "#5c7400",
  accent2: "#0b84c9",
  good: "#23a55a",
  warn: "#b87a00",
  bad: "#d23a40",
  info: "#0b84c9",
  muted: "#5b616a",
  faint: "#b9bcb3",
  selection: "#e3f59a",
  selectionDim: "#e6e8e1",
  onAccent: "#ffffff"
};

/** The active theme. Components read it while rendering, so `setTheme` takes effect on the next frame. */
export const theme: Theme = { ...DARK };

export function setTheme(name: "dark" | "light"): void {
  Object.assign(theme, name === "light" ? LIGHT : DARK);
}

/** What the environment says: BASK_THEME, else COLORFGBG's background (set by some terminals). */
export function themeFromEnvironment(): "dark" | "light" | undefined {
  const wanted = (process.env.BASK_THEME ?? "").toLowerCase();
  if (wanted === "light" || wanted === "dark") return wanted;
  if (!process.env.COLORFGBG) return undefined;
  const bg = Number(process.env.COLORFGBG.split(";").pop());
  return bg === 7 || bg === 15 ? "light" : "dark";
}

/**
 * Reads a terminal's answers to "what is your background colour" (OSC 11) and "is your colour
 * scheme light or dark" (CSI ? 996 n). The background wins when both come: it is what text sits on.
 */
export function themeFromReply(reply: string): "dark" | "light" | undefined {
  const bg = /\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (bg) {
    const [r, g, b] = bg.slice(1, 4).map((hex) => parseInt(hex, 16) / (16 ** hex.length - 1));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
  }
  const scheme = /\[\?997;([12])n/.exec(reply);
  return scheme ? (scheme[1] === "2" ? "light" : "dark") : undefined;
}

/** The answers themselves: a colour (ended by BEL or ESC backslash), a colour scheme report, device attributes. */
const ANSWERS = /\x1b\]1[01];[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\?[\d;]*[cn]/g;

/**
 * Asks the terminal whether it is light or dark. Every terminal answers the last question (device
 * attributes), so the wait ends as soon as that arrives; one that says nothing costs `timeoutMs`.
 */
export function askTerminalTheme(timeoutMs = 300): Promise<"dark" | "light" | undefined> {
  const stdin = process.stdin;
  const out = process.stdout;
  if (!stdin.isTTY || !out.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let reply = "";
    const wasRaw = stdin.isRaw;
    const finish = () => {
      clearTimeout(timer);
      stdin.off("readable", onReadable);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.unref();
      // Keys typed before the dashboard was up arrive mixed in with the answers: hand them back.
      const typed = reply.replace(ANSWERS, "");
      if (typed) stdin.unshift(Buffer.from(typed, "latin1"));
      resolve(themeFromReply(reply));
    };
    // Read the way Ink does (the "readable" event, never "data" or pause): the keyboard then
    // carries on working for Ink afterwards, also in the standalone build.
    const onReadable = () => {
      for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) reply += Buffer.from(chunk).toString("latin1");
      if (/\x1b\[\?[\d;]*c/.test(reply)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.setRawMode(true);
    stdin.ref();
    stdin.on("readable", onReadable);
    out.write("\x1b]11;?\x1b\\\x1b[?996n\x1b[c");
  });
}

export type Tone = "info" | "good" | "warn" | "bad";
export const toneColor = (tone: Tone) => ({ info: theme.info, good: theme.good, warn: theme.warn, bad: theme.bad })[tone];

/** A colour for a Niagara status string such as "{alarm,unackedAlarm}" or a one-word state. */
export function statusTone(status: unknown): string {
  const s = typeof status === "string" ? status : "";
  if (/alarm/i.test(s)) return theme.bad;
  if (/fault|down/i.test(s)) return theme.accent2;
  if (/stale|disabled|null|unsubscribed/i.test(s)) return theme.warn;
  if (/overridden/i.test(s)) return theme.info;
  return theme.good;
}
