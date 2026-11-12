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

/** BASK_THEME wins; otherwise COLORFGBG's background (set by many terminals) decides, and dark is the default. */
export function detectTheme(): "dark" | "light" {
  const wanted = (process.env.BASK_THEME ?? "").toLowerCase();
  if (wanted === "light" || wanted === "dark") return wanted;
  const bg = Number((process.env.COLORFGBG ?? "").split(";").pop());
  return bg === 7 || bg === 15 ? "light" : "dark";
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
