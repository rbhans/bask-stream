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

const DARK: Theme = {
  name: "dark",
  accent: "#7aa2f7",
  accent2: "#bb9af7",
  good: "#9ece6a",
  warn: "#e0af68",
  bad: "#f7768e",
  info: "#7dcfff",
  muted: "#8a90a8",
  faint: "#4b5068",
  selection: "#2c3a66",
  selectionDim: "#252a3d",
  onAccent: "#0f111a"
};

const LIGHT: Theme = {
  name: "light",
  accent: "#2f5fd0",
  accent2: "#7b4bc4",
  good: "#3a7d1f",
  warn: "#9a6200",
  bad: "#c8324f",
  info: "#0b7a99",
  muted: "#666c85",
  faint: "#b3b8cc",
  selection: "#cfdaf8",
  selectionDim: "#e6e9f3",
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
