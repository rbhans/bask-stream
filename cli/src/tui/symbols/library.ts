// The terminal symbol library: equipment drawn in text, with moving parts and status colours.
//
// A symbol is a function of its state and a frame number that returns a sprite: rows of characters
// and, for each character, a paint letter that says how to colour it. Air-handler sections are five
// rows tall (wall, three rows of interior, wall) so they sit side by side as one casing; other
// equipment draws its own outline. `ports` say where a pipe or duct attaches, as a cell just outside
// the sprite. Only box-drawing, block and geometric characters are used, which every terminal font has.
import { theme } from "../theme.js";
import type { Sprite, Style } from "./canvas.js";

export type Status = "ok" | "off" | "alarm" | "fault" | "down" | "overridden" | "stale";
export type Medium = "air" | "chw" | "hw" | "cw" | "steam" | "refrigerant" | "power";
export const STATUSES: Status[] = ["ok", "off", "alarm", "fault", "overridden", "down", "stale"];
export const MEDIA: Medium[] = ["chw", "hw", "cw", "steam", "refrigerant", "air", "power"];

export interface SymbolState {
  /** Running (animated). Off, faulted and unreachable equipment stands still whatever this says. */
  on?: boolean;
  /** 0 to 100: a position, speed, load or level, depending on the symbol. */
  value?: number;
  /** A second 0 to 100 value for symbols that have one (a VAV box's reheat valve). */
  aux?: number;
  status?: Status;
  medium?: Medium;
  /** Text the symbol shows: a reading on a plate, the letter on a sensor. */
  text?: string;
  title?: string;
  /** A door or access panel is open. */
  open?: boolean;
  /** Which way the flow marks travel. */
  flow?: 1 | -1;
  /** How many cells wide to draw a stretch of duct (the airflow symbol). */
  width?: number;
  /** Draw for a pipe that runs up and down (the valve symbol). */
  vertical?: boolean;
}

export const GROUPS = ["Air handling", "Water and plant", "Refrigeration and critical rooms", "Power", "Indicators"] as const;
export type Group = (typeof GROUPS)[number];

export interface SymbolDef {
  id: string;
  title: string;
  group: Group;
  /** What it draws and what moves. */
  note: string;
  /** What `value` means here, when the symbol uses it. */
  value?: string;
  /** What `aux` means here. */
  aux?: string;
  uses: ("on" | "value" | "aux" | "text" | "title" | "open" | "medium" | "flow")[];
  /** A state that shows the symbol at its best, for the gallery. */
  sample: SymbolState;
  /** Where lines attach: a cell just outside the sprite, relative to its top-left corner. */
  ports?: Record<string, [number, number]>;
  draw(state: SymbolState, frame: number): Sprite;
}

// ---- Colour ---------------------------------------------------------------------------------------

const HOT = "#ff9e64";

export const statusColor = (state: SymbolState): string => {
  switch (state.status) {
    case "alarm": return theme.bad;
    case "fault": return theme.accent2;
    case "down": case "stale": return theme.warn;
    case "overridden": return theme.info;
    case "off": return theme.faint;
    default: return state.on === false ? theme.faint : theme.good;
  }
};

export const mediumColor = (medium: Medium | undefined): string => {
  switch (medium) {
    case "chw": return theme.accent;
    case "hw": return theme.bad;
    case "cw": return theme.good;
    case "steam": return theme.name === "dark" ? "#c0caf5" : "#4a5070";
    case "refrigerant": return theme.accent2;
    case "power": return theme.warn;
    default: return theme.info;
  }
};

/** The style for one paint letter. A blank letter is the equipment's outline. */
export function paint(letter: string, state: SymbolState): Style {
  switch (letter) {
    case "f": return { color: theme.faint };
    case "s": return { color: statusColor(state), bold: state.status === "alarm" };
    case "m": return { color: mediumColor(state.medium) };
    case "a": return { color: theme.accent };
    case "h": return { color: HOT };
    case "r": return { color: theme.bad };
    case "w": return { color: theme.warn };
    case "c": return { color: theme.info };
    case "g": return { color: theme.good };
    case "b": return { color: theme.bad, bold: true };
    case "t": return {};
    case "T": return { bold: true };
    case "d": return { color: theme.muted };
    default: return { color: theme.muted };
  }
}

// ---- Drawing helpers ------------------------------------------------------------------------------

/** Whether the moving parts move. */
export const moving = (s: SymbolState) => s.on !== false && s.status !== "off" && s.status !== "fault" && s.status !== "down";
const pct = (s: SymbolState, fallback = 0) => Math.max(0, Math.min(100, s.value ?? fallback));
const mod = (n: number, m: number) => ((n % m) + m) % m;
/** A frame counter that runs faster the higher the value (a fan at 90% spins faster than at 30%). */
const paced = (frame: number, value: number) => Math.floor(frame / (value >= 70 ? 1 : value >= 35 ? 2 : 3));
const rep = (ch: string, n: number) => ch.repeat(Math.max(0, n));
const fit = (text: string, width: number) => {
  const cut = [...text].slice(0, width).join("");
  const left = Math.floor((width - [...cut].length) / 2);
  return rep(" ", left) + cut + rep(" ", width - left - [...cut].length);
};

/** An air-handler section: three interior rows between the casing's top and bottom walls. */
function section(interior: string[], paintRows: string[], bottom?: string): Sprite {
  const width = [...interior[0]].length;
  return { rows: [rep("─", width), ...interior, bottom ?? rep("─", width)], paint: [rep("f", width), ...paintRows, rep("f", width)] };
}

/** Marks travelling through a stretch of duct: bright along the middle, faint above and below. */
function airstream(width: number, frame: number, state: SymbolState): { rows: string[]; paint: string[] } {
  const direction = state.flow ?? 1;
  const run = moving(state);
  const at = (x: number, offset: number, every: number) => mod(direction > 0 ? x - (run ? frame : 0) + offset : x + (run ? frame : 0) + offset, every) === 0;
  const row = (offset: number, every: number, mark: string) => Array.from({ length: width }, (_v, x) => (at(x, offset, every) ? mark : " ")).join("");
  const main = row(0, 3, direction > 0 ? "▸" : "◂");
  return { rows: [row(1, 6, "·"), main, row(4, 6, "·")], paint: [rep("f", width), rep(run ? "m" : "f", width), rep("f", width)] };
}

const FAN_PLUS = ["  │  ", "──●──", "  │  "];
const FAN_X = [" ╲ ╱ ", "  ●  ", " ╱ ╲ "];
/** The blade that catches the light on each of the eight steps of a turn, as [x, y] cells of the 5 x 3 fan. */
const FAN_BRIGHT: [number, number][][] = [[[2, 0]], [[3, 0]], [[3, 1], [4, 1]], [[3, 2]], [[2, 2]], [[1, 2]], [[0, 1], [1, 1]], [[1, 0]]];
/** A four-blade fan turning clockwise: the shape alternates between + and x while one blade stays bright. */
function fanBlades(frame: number, state: SymbolState): { rows: string[]; paint: string[] } {
  const step = moving(state) ? mod(paced(frame, pct(state, 60)), 8) : 0;
  const rows = step % 2 === 0 ? FAN_PLUS : FAN_X;
  const bright = moving(state) ? FAN_BRIGHT[step] : [];
  return { rows, paint: rows.map((row, y) => [...row].map((ch, x) => (ch === " " ? " " : bright.some(([bx, by]) => bx === x && by === y) ? "T" : "s")).join("")) };
}

/** The serpentine of a water coil, in the order the water runs through it, as [x, y] cells. */
const COIL = [" ╭╮╭╮ ", " ││││ ", " │╰╯│ "];
const COIL_PATH: [number, number][] = [[1, 2], [1, 1], [1, 0], [2, 0], [2, 1], [2, 2], [3, 2], [3, 1], [3, 0], [4, 0], [4, 1], [4, 2]];
function coil(state: SymbolState, frame: number): Sprite {
  const flowing = moving(state) && pct(state) > 0;
  const paintRows: string[][] = COIL.map((row) => [...row].map((ch) => (ch === " " ? " " : flowing ? "f" : "d")));
  // A pulse of colour runs along the tubes while the valve is open.
  if (flowing) COIL_PATH.forEach(([x, y], index) => (paintRows[y][x] = mod(index - paced(frame, pct(state)), 4) < 2 ? "m" : "f"));
  return section(COIL, paintRows.map((row) => row.join("")), "─┬──┬─");
}

const SPIN = ["◐", "◓", "◑", "◒"];
const BARREL = "░▒▓▒";
const EIGHTHS = " ▁▂▃▄▅▆▇█";

// ---- The symbols ----------------------------------------------------------------------------------

export const SYMBOLS: SymbolDef[] = [
  // Air handling: sections that join side by side into one casing.
  {
    id: "airflow", title: "Airflow", group: "Air handling", note: "An open stretch of duct. The marks move with the air, in either direction.",
    uses: ["on", "flow", "medium"], sample: { on: true, flow: 1 },
    draw: (s, f) => {
      const air = airstream(Math.max(1, s.width ?? 8), f, s);
      return section(air.rows, air.paint);
    }
  },
  {
    id: "louver", title: "Louver", group: "Air handling", note: "Intake or relief slats at the end of a casing.",
    uses: [], sample: {},
    draw: () => section(["≡≡ ", "≡≡ ", "≡≡ "], ["dd ", "dd ", "dd "])
  },
  {
    id: "damper", title: "Damper", group: "Air handling", note: "Blades turn with the position: shut, modulating, open.", value: "position, 0 shut to 100 open",
    uses: ["value"], sample: { value: 45 },
    draw: (s) => {
      const v = pct(s, 50);
      const blades = v < 8 ? "  │  " : v < 85 ? "  ╱  " : " ─── ";
      return section([blades, blades, blades], [blades, blades, blades].map((row) => row.replace(/\S/g, "s")));
    }
  },
  {
    id: "filter", title: "Filter", group: "Air handling", note: "Filter media. It changes colour as it loads up, and again when it alarms.", value: "loading, 0 clean to 100 due",
    uses: ["value"], sample: { value: 30 },
    draw: (s) => {
      const letter = s.status === "alarm" ? "b" : pct(s) >= 80 ? "w" : "d";
      return section([" ╳╳╳ ", " ╳╳╳ ", " ╳╳╳ "], Array(3).fill(` ${rep(letter, 3)} `));
    }
  },
  {
    id: "cooling-coil", title: "Cooling coil", group: "Air handling", note: "A water coil with supply and return stubs below. Colour pulses along the tubes while the valve is open.", value: "valve position",
    uses: ["on", "value", "medium"], sample: { value: 60, medium: "chw" }, ports: { supply: [1, 5], return: [4, 5] },
    draw: (s, f) => coil({ medium: "chw", ...s }, f)
  },
  {
    id: "heating-coil", title: "Heating coil", group: "Air handling", note: "The same coil on hot water.", value: "valve position",
    uses: ["on", "value", "medium"], sample: { value: 40, medium: "hw" }, ports: { supply: [1, 5], return: [4, 5] },
    draw: (s, f) => coil({ medium: "hw", ...s }, f)
  },
  {
    id: "electric-heater", title: "Electric heater", group: "Air handling", note: "Resistance elements that glow while energised.", value: "output",
    uses: ["on", "value"], sample: { value: 70 },
    draw: (s, f) => {
      const glowing = moving(s) && pct(s) > 0;
      const row = " ╱╲╱╲ ";
      return section([row, row, row], [0, 1, 2].map((y) => [...row].map((ch, x) => (ch === " " ? " " : !glowing ? "d" : mod(x + y + Math.floor(f / 2), 2) ? "h" : "w")).join("")));
    }
  },
  {
    id: "fan", title: "Fan", group: "Air handling", note: "Four blades turning clockwise, faster with speed. It stops when off, faulted or unreachable.", value: "speed",
    uses: ["on", "value"], sample: { on: true, value: 75 },
    draw: (s, f) => {
      const blades = fanBlades(f, s);
      return section(blades.rows.map((row) => `  ${row}  `), blades.paint.map((row) => `  ${row}  `));
    }
  },
  {
    id: "humidifier", title: "Humidifier", group: "Air handling", note: "Steam rises from the manifold while it runs.", value: "output",
    uses: ["on", "value"], sample: { on: true, value: 50 },
    draw: (s, f) => {
      const steaming = moving(s) && pct(s, 50) > 0;
      const puff = ["°", "·", " ", " "];
      const steam = (y: number) => ` ${[0, 1, 2].map((x) => (steaming ? puff[mod(Math.floor(f / 2) + x * 2 + y, 4)] : " ")).join("")} `;
      return section([steam(0), steam(1), " ┷┷┷ "], [" ttt ", " ddd ", ` ${rep(steaming ? "m" : "d", 3)} `].map((row, y) => (y < 2 ? row : row)));
    }
  },
  {
    id: "sensor", title: "Duct sensor", group: "Air handling", note: "A probe in the airstream. The letter says what it measures; the bulb takes the point's status.",
    uses: ["text"], sample: { text: "T" },
    draw: (s) => section([` ${[...(s.text ?? "T")][0] ?? "T"} `, " │ ", " ● "], [" T ", "   ", " s "])
  },
  {
    id: "vav", title: "VAV box", group: "Air handling", note: "A zone damper and a reheat coil in one box.", value: "damper position", aux: "reheat valve position",
    uses: ["value", "aux", "on"], sample: { value: 55, aux: 30 },
    draw: (s, f) => {
      const v = pct(s, 50);
      const blade = v < 8 ? "│" : v < 85 ? "╱" : "─";
      const reheat = moving(s) && (s.aux ?? 0) > 0;
      const tube = (index: number) => (reheat ? (mod(index - Math.floor(f / 2), 3) === 0 ? "f" : "r") : "d");
      return {
        rows: ["╭────────╮", `│ ${blade}  ╭╮  │`, `│ ${blade}  ││  │`, `│ ${blade}  ╰╯  │`, "╰────────╯"],
        paint: ["          ", `  s  ${tube(0)}${tube(1)}   `, `  s  ${tube(5)}${tube(2)}   `, `  s  ${tube(4)}${tube(3)}   `, "          "]
      };
    },
    ports: { in: [-1, 2], out: [10, 2] }
  },

  // Water and plant.
  {
    id: "pump", title: "Pump", group: "Water and plant", note: "The impeller turns while it runs.", value: "speed",
    uses: ["on", "value"], sample: { on: true, value: 65 }, ports: { in: [-1, 1], out: [3, 1] },
    draw: (s, f) => ({ rows: ["╭─╮", `┤${moving(s) ? SPIN[mod(paced(f, pct(s, 60)), 4)] : "○"}├`, "╰─╯"], paint: ["   ", " s ", "   "] })
  },
  {
    id: "valve", title: "Valve", group: "Water and plant", note: "Solid when shut, open outline in the fluid's colour when it passes flow.", value: "position",
    uses: ["value", "medium"], sample: { value: 60, medium: "chw" }, ports: { in: [-1, 0], out: [2, 0] },
    draw: (s) => {
      const shut = pct(s) < 5;
      const letter = shut ? (s.status === "alarm" || s.status === "fault" ? "s" : "d") : s.status && s.status !== "ok" ? "s" : "m";
      // On a pipe that runs up and down the two halves stack.
      if (s.vertical) return { rows: shut ? ["▼", "▲"] : ["▽", "△"], paint: [letter, letter] };
      return { rows: [shut ? "▶◀" : "▷◁"], paint: [letter + letter] };
    }
  },
  {
    id: "chiller", title: "Chiller", group: "Water and plant", note: "Condenser and evaporator barrels with fluid moving through them, a compressor that turns, and a load bar.", value: "load",
    uses: ["on", "value"], sample: { on: true, value: 70 },
    ports: { cwOut: [14, 1], cwIn: [-1, 1], chwOut: [14, 3], chwIn: [-1, 3] },
    draw: (s, f) => {
      const run = moving(s);
      const barrel = (direction: number) => Array.from({ length: 6 }, (_v, i) => BARREL[mod(i + (run ? direction * Math.floor(f / 2) : 0), 4)]).join("");
      const filled = Math.round((pct(s) / 100) * 8);
      return {
        rows: ["╭────────────╮", `┤ ${run ? SPIN[mod(f, 4)] : "○"} (${barrel(-1)}) ├`, `│   ${rep("━", filled)}${rep("─", 8 - filled)} │`, `┤ * (${barrel(1)}) ├`, "╰────────────╯"],
        paint: ["              ", `  s ${run ? "wwwwwwww" : "dddddddd"}  `, `    ${rep("s", filled)}${rep("f", 8 - filled)}  `, `  ${run && mod(f, 6) < 3 ? "T" : "c"} ${run ? "cccccccc" : "dddddddd"}  `, "              "]
      };
    }
  },
  {
    id: "boiler", title: "Boiler", group: "Water and plant", note: "Flames flicker under the water while it fires.", value: "firing rate",
    uses: ["on", "value"], sample: { on: true, value: 60 }, ports: { supply: [2, 5], return: [6, 5] },
    draw: (s, f) => {
      const firing = moving(s);
      const flame = Array.from({ length: 5 }, (_v, x) => (firing ? (mod(x + f, 2) ? "▲" : "▴") : "·")).join("");
      const water = Array.from({ length: 5 }, (_v, x) => (firing && mod(x + Math.floor(f / 3), 2) ? "~" : "≈")).join("");
      return {
        rows: ["╭───────╮", `│ ${water} │`, "│ ━━━━━ │", `│ ${flame} │`, "╰─┬───┬─╯"],
        paint: ["         ", `  ${rep(firing ? "r" : "d", 5)}  `, "         ", `  ${Array.from({ length: 5 }, (_v, x) => (firing ? (mod(x + f, 2) ? "h" : "w") : "f")).join("")}  `, "         "]
      };
    }
  },
  {
    id: "cooling-tower", title: "Cooling tower", group: "Water and plant", note: "A fan on top and water falling through the fill into the basin.", value: "fan speed",
    uses: ["on", "value"], sample: { on: true, value: 60 }, ports: { in: [0, 4], out: [8, 4] },
    draw: (s, f) => {
      const run = moving(s);
      const spinner = run ? ["│", "╱", "─", "╲"][mod(paced(f, pct(s, 60)), 4)] : "┼";
      const drops = (y: number) => Array.from({ length: 5 }, (_v, x) => (mod(x * 2 + y - (run ? Math.floor(f / 2) : 0), 3) === 0 ? "▾" : " ")).join("");
      return {
        rows: [`  ╭─${spinner}─╮  `, ` │${drops(0)}│ `, ` │${drops(1)}│ `, ` │${drops(2)}│ `, " ┤≈≈≈≈≈├ ", " ╰─────╯ "],
        paint: ["    s    ", `  ${rep(run ? "m" : "f", 5)}  `, `  ${rep(run ? "m" : "f", 5)}  `, `  ${rep(run ? "m" : "f", 5)}  `, `  ${rep("m", 5)}  `, "         "]
      };
    }
  },
  {
    id: "heat-exchanger", title: "Heat exchanger", group: "Water and plant", note: "Plates alternating between the hot side and the cold side.",
    uses: ["on"], sample: { on: true }, ports: { hotIn: [-1, 1], hotOut: [-1, 2], coldOut: [7, 1], coldIn: [7, 2] },
    draw: (s, f) => {
      const run = moving(s);
      const plates = (y: number) => Array.from({ length: 5 }, (_v, x) => (!run ? "d" : mod(x, 2) ? (mod(Math.floor(f / 2) + y, 3) ? "c" : "f") : mod(Math.floor(f / 2) + y, 3) ? "r" : "f")).join("");
      return { rows: ["╭─────╮", "┤║║║║║├", "┤║║║║║├", "╰─────╯"], paint: ["       ", ` ${plates(0)} `, ` ${plates(1)} `, "       "] };
    }
  },
  {
    id: "tank", title: "Tank", group: "Water and plant", note: "Fills to its level, to an eighth of a row.", value: "level",
    uses: ["value", "medium"], sample: { value: 62, medium: "chw" }, ports: { in: [-1, 3], out: [7, 3] },
    draw: (s) => {
      const eighths = Math.round((pct(s, 50) / 100) * 24);
      const row = (fromBottom: number) => rep(EIGHTHS[Math.max(0, Math.min(8, eighths - fromBottom * 8))], 5);
      return { rows: ["╭─────╮", `│${row(2)}│`, `│${row(1)}│`, `┤${row(0)}├`, "╰─────╯"], paint: ["       ", " mmmmm ", " mmmmm ", " mmmmm ", "       "] };
    }
  },

  // Refrigeration and critical rooms.
  {
    id: "compressor", title: "Compressor", group: "Refrigeration and critical rooms", note: "Pistons rise and fall while it runs (on).",
    uses: ["on"], sample: { on: true }, ports: { suction: [-1, 1], discharge: [5, 1] },
    draw: (s, f) => ({ rows: ["╭───╮", `┤${moving(s) && mod(Math.floor(f / 2), 2) ? "▀▄▀" : "▄▀▄"}├`, "╰───╯"], paint: ["     ", " sss ", "     "] })
  },
  {
    id: "cold-room", title: "Cold room", group: "Refrigeration and critical rooms", note: "A freezer or cooler box: its reading (the box temperature) inside, frost that twinkles while it runs (on), and a door that shows open (open).",
    uses: ["on", "text", "open"], sample: { on: true, text: "-9.4 °F" },
    draw: (s, f) => {
      const twinkle = moving(s) && mod(Math.floor(f / 3), 2);
      const frost = twinkle ? " *  ·  * " : " ·  *  · ";
      const alarmed = s.status === "alarm";
      return {
        rows: ["╭─────────╮", `│${frost}│`, `│${fit(s.text ?? "", 9)}│`, "│ ▒▒▒ ▒▒▒ │", s.open ? "╰──╱   ───╯" : "╰──━━━━───╯"],
        paint: ["           ", ` ${rep("c", 9)} `, ` ${rep(alarmed ? "b" : "T", 9)} `, " fff fff   ".slice(0, 11), s.open ? "   w       " : "   ssss    "]
      };
    }
  },
  {
    id: "crac", title: "CRAC unit", group: "Refrigeration and critical rooms", note: "Warm air drawn in at the top, across the coil, cold air out at the bottom.", value: "fan speed",
    uses: ["on", "value"], sample: { on: true, value: 70 },
    draw: (s, f) => {
      const run = moving(s);
      const air = (offset: number) => (run && mod(paced(f, pct(s, 60)) + offset, 2) ? " ▾ ▾ ▾ " : "▾ ▾ ▾ ▾").slice(0, 7);
      return {
        rows: ["╭───────╮", `│${air(0)}│`, "│ ≋≋≋≋≋ │", `│${air(1)}│`, "╰───────╯"],
        paint: ["         ", ` ${rep(run ? "h" : "f", 7)} `, ` ${rep(run ? "c" : "d", 7)} `, ` ${rep(run ? "c" : "f", 7)} `, "         "]
      };
    }
  },
  {
    id: "rack", title: "Server rack", group: "Refrigeration and critical rooms", note: "Activity lights that flicker. They all turn red when the rack alarms.",
    uses: ["on"], sample: { on: true },
    draw: (s, f) => {
      const light = (x: number, y: number) => {
        if (s.status === "alarm") return mod(Math.floor(f / 2), 2) ? "b" : "f";
        if (!moving(s)) return "f";
        const n = mod(x * 7 + y * 13 + Math.floor(f / 2) * (x + y + 1), 11);
        return n < 6 ? "g" : n < 8 ? "w" : "f";
      };
      return { rows: ["╭───╮", "│▪▪▪│", "│▪▪▪│", "│▪▪▪│", "╰───╯"], paint: ["     ", ...[0, 1, 2].map((y) => ` ${[0, 1, 2].map((x) => light(x, y)).join("")} `), "     "] };
    }
  },

  // Power.
  {
    id: "ups", title: "UPS battery", group: "Power", note: "Cells fill with the charge and change colour as it drops. It flashes while on battery (status overridden).", value: "charge",
    uses: ["value"], sample: { value: 80 },
    draw: (s, f) => {
      const cells = Math.round((pct(s, 100) / 100) * 7);
      const level = pct(s, 100) > 50 ? "g" : pct(s, 100) > 20 ? "w" : "b";
      const flash = s.status === "overridden" && mod(Math.floor(f / 2), 2) === 0;
      return { rows: ["╭───────╮", `│${rep("▮", cells)}${rep("▯", 7 - cells)}│`, "╰───────╯"], paint: [rep(flash ? "w" : " ", 9), ` ${rep(level, cells)}${rep("f", 7 - cells)} `, rep(flash ? "w" : " ", 9)] };
    }
  },
  {
    id: "generator", title: "Generator", group: "Power", note: "The output wave moves while it runs.",
    uses: ["on"], sample: { on: true },
    draw: (s, f) => ({ rows: ["╭─────╮", `│ G ${moving(s) ? (mod(Math.floor(f / 2), 2) ? "≈" : "~") : "─"} │`, "╰─────╯"], paint: ["       ", `  T ${moving(s) ? "w" : "f"}  `, "       "] })
  },

  // Indicators.
  {
    id: "plate", title: "Value plate", group: "Indicators", note: "A named reading with a status light. The frame flashes while it is in alarm.",
    uses: ["title", "text"], sample: { title: "Zone 105", text: "78.6 °F" },
    draw: (s, f) => {
      const title = s.title ?? "";
      const text = s.text ?? "";
      const width = Math.max(12, [...title].length + 6, [...text].length + 6);
      const flash = s.status === "alarm" && mod(Math.floor(f / 3), 2) === 0 ? "b" : s.status === "alarm" ? "r" : " ";
      return {
        rows: [`╭─ ${title} ${rep("─", width - 5 - [...title].length)}╮`, `│ ● ${text}${rep(" ", width - 6 - [...text].length)} │`, `╰${rep("─", width - 2)}╯`],
        paint: [`${rep(flash, 3)}${rep("d", [...title].length)}${rep(flash, width - 3 - [...title].length)}`, `${flash} s ${rep("T", width - 6)} ${flash}`, rep(flash, width)]
      };
    }
  },
  {
    id: "gauge", title: "Bar gauge", group: "Indicators", note: "A bar that fills with the value, in the status colour.", value: "0 to 100",
    uses: ["value"], sample: { value: 65 },
    draw: (s) => {
      const filled = Math.round((pct(s) / 100) * 10);
      return { rows: [`▕${rep("█", filled)}${rep("░", 10 - filled)}▏`], paint: [`f${rep("s", filled)}${rep("f", 10 - filled)}f`] };
    }
  },
  {
    id: "thermometer", title: "Thermometer", group: "Indicators", note: "A column that rises with the value, warm at the top of its range and cool at the bottom.", value: "0 to 100 of the range",
    uses: ["value"], sample: { value: 70 },
    draw: (s) => {
      const level = Math.round((pct(s, 50) / 100) * 4);
      const tone = s.status === "alarm" ? "b" : pct(s, 50) >= 66 ? "h" : pct(s, 50) >= 33 ? "g" : "c";
      const cell = (fromTop: number) => (4 - fromTop <= level ? "┃" : "│");
      return { rows: [...[0, 1, 2, 3].map(cell), "●"], paint: [...[0, 1, 2, 3].map((y) => (4 - y <= level ? tone : "f")), tone] };
    }
  },
  {
    id: "lamp", title: "Status light", group: "Indicators", note: "One light in the point's status colour. It blinks in alarm.",
    uses: [], sample: { status: "ok" },
    draw: (s, f) => ({ rows: [s.status === "alarm" && mod(Math.floor(f / 3), 2) ? "○" : "●"], paint: ["s"] })
  },
  {
    id: "alarm", title: "Alarm marker", group: "Indicators", note: "A warning triangle that blinks, with a short note beside it.",
    uses: ["text"], sample: { text: "HIGH", status: "alarm" },
    draw: (s, f) => {
      const text = s.text ? ` ${s.text}` : "";
      const lit = mod(Math.floor(f / 3), 2) === 0;
      return { rows: [`▲${text}`], paint: [`${lit ? "b" : "f"}${rep(lit ? "b" : "r", [...text].length)}`] };
    }
  }
];

export const SYMBOL = new Map(SYMBOLS.map((s) => [s.id, s]));

/** The sprite for a symbol id in a state, and its size. */
export function drawSymbol(id: string, state: SymbolState = {}, frame = 0): Sprite {
  const def = SYMBOL.get(id);
  if (!def) throw new Error(`No symbol "${id}". Known: ${SYMBOLS.map((s) => s.id).join(", ")}`);
  return def.draw({ ...state }, frame);
}

export const sizeOf = (sprite: Sprite): [number, number] => [Math.max(...sprite.rows.map((row) => [...row].length)), sprite.rows.length];
