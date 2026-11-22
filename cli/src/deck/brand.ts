// BASidekick's colours, as the brand's design tokens give them: Ink ground, Paper type, one hi-vis
// accent used as a fill. Status and temperature colours belong to data and are never decoration.

export interface Palette {
  name: "dark" | "light";
  /** The ground everything sits on. */
  chassis: string;
  /** A raised area: a card, a group. */
  panel: string;
  /** A second step up: a tile, a chip. */
  panel2: string;
  /** A sunk area: an input, a track. */
  well: string;
  /** Text, then quieter, then quietest. */
  ink: string;
  ink2: string;
  ink3: string;
  /** Hairlines: the ordinary one, and one a step stronger. */
  line: string;
  line2: string;
  /** Hi-vis. A fill with `accentInk` on it; as text only on the dark ground. */
  accent: string;
  accentInk: string;
  /** The accent for a mark on the light ground, where the fill itself would not read. */
  accentMark: string;
  /** The second drawing colour: AI agents, a second trace, the glitch's blue ghost. */
  cyan: string;
  ok: string;
  fault: string;
  alarm: string;
  /** In hand: overridden by a person. */
  hand: string;
  cold: string;
  warm: string;
}

export const DARK: Palette = {
  name: "dark",
  chassis: "#0e1013", panel: "#171a1f", panel2: "#1c2026", well: "#0b0d10",
  ink: "#f3f4ef", ink2: "#c9cdd3", ink3: "#9ba2ac",
  line: "#212326", line2: "#30333a",
  accent: "#d4ff3a", accentInk: "#0e1013", accentMark: "#d4ff3a",
  cyan: "#27b7ff", ok: "#3fcf7f", fault: "#f0a000", alarm: "#e5484d", hand: "#6f8bff", cold: "#4f7bff", warm: "#ff6a1f"
};

export const LIGHT: Palette = {
  name: "light",
  chassis: "#f3f4ef", panel: "#ffffff", panel2: "#f7f8f4", well: "#e6e8e1",
  ink: "#0e1013", ink2: "#4a5058", ink3: "#5b616a",
  line: "#dfe0db", line2: "#cdcfc9",
  accent: "#d4ff3a", accentInk: "#0e1013", accentMark: "#6f8c00",
  cyan: "#0b84c9", ok: "#23a55a", fault: "#b87a00", alarm: "#d23a40", hand: "#3b63f7", cold: "#2f62ff", warm: "#e2560f"
};

/** The palette in use. Drawing code reads it each frame, so `setPalette` shows on the next one. */
export const P: Palette = { ...DARK };

export function setPalette(name: "dark" | "light"): void {
  Object.assign(P, name === "light" ? LIGHT : DARK);
}

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** `a` with `t` (0 to 1) of `b` mixed in. The brand has no gradients; this is for a tint on a ground. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return `#${hex2(ar + (br - ar) * t)}${hex2(ag + (bg - ag) * t)}${hex2(ab + (bb - ab) * t)}`;
}

/** The glitch's two ghosts: the alarm red and the cyan, either side of what tears. */
export const GHOST_RED = "#e5484d";
export const GHOST_BLUE = "#27b7ff";
