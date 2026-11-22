// The BASidekick mark and its effects, drawn in terminal cells: the wordmark ("BA", the trace S on a
// hi-vis chip, "idekick"), the tear that splits the S with a red and a blue ghost, the S in box-drawing
// characters with a signal running along it, ordered dither in place of gradients, and readings that
// decode from dashes. Timings and steps follow the brand's own.
import { GHOST_BLUE, GHOST_RED, P } from "./brand.js";
import type { Surface } from "./surface.js";

// ---- The wordmark ---------------------------------------------------------------------------------
// Square pixels, twelve high: the chip fills all twelve, capitals sit on rows 2 to 9, ascenders start
// at row 1, lowercase bodies on rows 4 to 9. Strokes are two pixels, as heavy as the brand's display face.

const GLYPHS: Record<string, string[]> = {
  B: [
    "        ",
    "        ",
    "XXXXXXX ",
    "XXXXXXXX",
    "XX    XX",
    "XXXXXXX ",
    "XXXXXXX ",
    "XX    XX",
    "XXXXXXXX",
    "XXXXXXX ",
    "        ",
    "        "
  ],
  A: [
    "          ",
    "          ",
    "   XXXX   ",
    "   XXXX   ",
    "  XX  XX  ",
    "  XX  XX  ",
    " XXXXXXXX ",
    " XXXXXXXX ",
    "XX      XX",
    "XX      XX",
    "          ",
    "          "
  ],
  i: [
    "  ",
    "XX",
    "XX",
    "  ",
    "XX",
    "XX",
    "XX",
    "XX",
    "XX",
    "XX",
    "  ",
    "  "
  ],
  d: [
    "       ",
    "     XX",
    "     XX",
    "     XX",
    " XXXXXX",
    "XXXXXXX",
    "XX   XX",
    "XX   XX",
    "XXXXXXX",
    " XXXXXX",
    "       ",
    "       "
  ],
  e: [
    "       ",
    "       ",
    "       ",
    "       ",
    " XXXXX ",
    "XXXXXXX",
    "XX   XX",
    "XXXXXXX",
    "XX     ",
    " XXXXXX",
    "       ",
    "       "
  ],
  k: [
    "       ",
    "XX     ",
    "XX     ",
    "XX     ",
    "XX  XXX",
    "XX XXX ",
    "XXXXX  ",
    "XXXXX  ",
    "XX XXX ",
    "XX  XXX",
    "       ",
    "       "
  ],
  c: [
    "      ",
    "      ",
    "      ",
    "      ",
    " XXXXX",
    "XXXXXX",
    "XX    ",
    "XX    ",
    "XXXXXX",
    " XXXXX",
    "      ",
    "      "
  ]
};

// The trace S on its chip, ten cells wide and six high, drawn in slices an eighth of a cell tall so the
// strokes, the gaps between them and the margins keep the brand's proportions (about 15, 12.5 and 15
// percent of the chip's height). From the top, in slices: margin, top bar, gap, middle bar, gap, bottom
// bar, margin.
const CHIP_WIDTH = 10;
const CHIP_SLICES = 48;
/** Where the chip is cut for the tear: just above the S's middle bar. */
const CHIP_CUT = 20;
const BARS = { top: [7, 14], middle: [20, 28], bottom: [34, 41] };

/** What is at a column and slice of the chip: the S, the chip around it, or nothing (outside its rounded corners). */
function chipAt(col: number, slice: number): "S" | "chip" | undefined {
  if (col < 0 || col >= CHIP_WIDTH || slice < 0 || slice >= CHIP_SLICES) return undefined;
  // Rounded corners: the outer columns start a little lower and end a little higher.
  const inset = col === 0 || col === CHIP_WIDTH - 1 ? 4 : col === 1 || col === CHIP_WIDTH - 2 ? 1 : 0;
  if (slice < inset || slice >= CHIP_SLICES - inset) return undefined;
  const within = (from: number, to: number) => slice >= from && slice < to;
  const s =
    // the top bar, from its free end on the right to the elbow on the left
    (col >= 2 && col <= 7 && within(BARS.top[0], BARS.top[1])) || (col === 8 && within(8, 13)) || (col === 1 && within(10, 14)) ||
    // down the left
    (col >= 1 && col <= 2 && within(14, 20)) ||
    // the middle bar
    (col >= 2 && col <= 7 && within(BARS.middle[0], BARS.middle[1])) || (col === 1 && within(20, 24)) || (col === 8 && within(24, 28)) ||
    // down the right
    (col >= 7 && col <= 8 && within(28, 34)) ||
    // the bottom bar, to its free end on the left
    (col >= 2 && col <= 7 && within(BARS.bottom[0], BARS.bottom[1])) || (col === 8 && within(34, 38)) || (col === 1 && within(35, 40));
  return s ? "S" : "chip";
}

export const WORDMARK_HEIGHT = 12;
const WORD = ["B", "A", "S", "i", "d", "e", "k", "i", "c", "k"];
const widthOf = (letter: string) => (letter === "S" ? CHIP_WIDTH : GLYPHS[letter][0].length);
export const WORDMARK_WIDTH = WORD.reduce((n, letter) => n + widthOf(letter), 0) + WORD.length - 1;
/** Rows of the wordmark in terminal cells. */
export const WORDMARK_ROWS = WORDMARK_HEIGHT / 2;

/**
 * The tear's steps (the brand's `s-tear`, 420 ms in steps): how far each half of the chip sits to
 * one side, in pixels, and whether its red and blue ghosts show. After the last step the halves hold
 * a little apart for as long as the tear is on.
 */
const TEAR_TOP: [number, number, boolean][] = [[0, -2, true], [0.14, 1, false], [0.28, -1, true], [0.42, 0, false], [0.56, -1, false]];
const TEAR_BOTTOM: [number, number, boolean][] = [[0, 1, true], [0.14, -1, false], [0.28, 1, true], [0.42, 0, false], [0.56, 1, false]];
export const TEAR_MS = 420;

function tearAt(keys: [number, number, boolean][], d: number): { shift: number; ghost: boolean } {
  let out = { shift: keys[0][1], ghost: keys[0][2] };
  for (const [t, shift, ghost] of keys) if (d >= t) out = { shift, ghost };
  return out;
}

/**
 * Draws the wordmark with its top-left pixel at cell (x, y). `tear` is how long the tear has been
 * on, in ms: undefined draws the S whole.
 */
export function drawWordmark(s: Surface, x: number, y: number, options: { tear?: number; ink?: string } = {}): void {
  const ink = options.ink ?? P.ink;
  const d = options.tear === undefined ? undefined : Math.min(1, options.tear / TEAR_MS);
  const top = d === undefined ? { shift: 0, ghost: false } : tearAt(TEAR_TOP, d);
  const bottom = d === undefined ? { shift: 0, ghost: false } : tearAt(TEAR_BOTTOM, d);
  let column = 0;
  for (const letter of WORD) {
    const w = widthOf(letter);
    if (letter !== "S") {
      const glyph = GLYPHS[letter];
      s.pixels(x + column, y, w, WORDMARK_HEIGHT, (px, py) => (glyph[py][px] === "X" ? ink : undefined));
    } else {
      // The chip is two halves, cut just above the S's middle bar. Each half shifts on its own, and
      // while its ghosts show, a red copy sits a cell to its left and a blue one a cell to its right.
      const half = (slice: number) => (slice < CHIP_CUT ? top : bottom);
      s.eighths(x + column - 3, y, w + 6, WORDMARK_ROWS, (qx, slice) => {
        const col = qx - 3;
        const { shift, ghost } = half(slice);
        const here = chipAt(col - shift, slice);
        if (here === "S") return P.accentInk;
        if (here === "chip") return P.accent;
        if (!ghost) return undefined;
        if (chipAt(col - shift + 1, slice)) return GHOST_RED;
        if (chipAt(col - shift - 1, slice)) return GHOST_BLUE;
        return undefined;
      });
    }
    column += w + 1;
  }
}

/** The mark on one line, for a header: "BA", the S on its chip, "idekick". Returns the cells used. */
export function drawMark(s: Surface, x: number, y: number, options: { short?: boolean; glitch?: boolean } = {}): number {
  let at = x;
  if (!options.short) at += s.put(at, y, "BA", { fg: P.ink, bold: true });
  if (options.glitch) s.put(at - 1, y, "▐", { fg: GHOST_RED });
  at += s.put(at, y, " S ", { fg: P.accentInk, bg: P.accent, bold: true });
  if (options.glitch) s.put(at, y, "▌", { fg: GHOST_BLUE });
  if (!options.short) at += s.put(at, y, "idekick", { fg: P.ink, bold: true });
  return at - x;
}

// ---- The S in box-drawing characters, and the signal that runs along it ---------------------------

export const ASCII_S = ["╭─────────────●", "│", "│", "╰─────────────╮", "              │", "              │", "●─────────────╯"];

/** How far along the trace each character sits, walking from the top dot to the bottom one: a column is 0.6, a row 1.05. */
const TRACE = (() => {
  const at = (r: number, c: number) => ASCII_S[r]?.[c] ?? " ";
  const dist = new Map<string, number>();
  let r = 0;
  let c = ASCII_S[0].indexOf("●");
  let d = 0;
  for (;;) {
    dist.set(`${r},${c}`, d);
    const next = [[r, c - 1], [r, c + 1], [r + 1, c], [r - 1, c]].find(([nr, nc]) => at(nr, nc) !== " " && !dist.has(`${nr},${nc}`));
    if (!next) return { dist, end: `${r},${c}`, length: d };
    d += next[0] !== r ? 1.05 : 0.6;
    [r, c] = next;
  }
})();

/** How long one run of the signal takes, start to the far dot letting go of the light. */
export const SIGNAL_MS = TRACE.length * 44 + 900;

/**
 * Draws the ASCII S at (x, y). `signal` is ms since a run of the signal started (undefined: at rest):
 * each character lights as the signal reaches it and fades back in 200 ms; the far dot holds it 900 ms.
 */
export function drawAsciiS(s: Surface, x: number, y: number, options: { signal?: number; tone?: string; run?: string } = {}): void {
  const tone = options.tone ?? P.line2;
  const run = options.run ?? P.accentMark;
  ASCII_S.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      if (ch === " ") return;
      let fg = tone;
      let bold = false;
      if (options.signal !== undefined) {
        const key = `${r},${c}`;
        const since = options.signal - (TRACE.dist.get(key) ?? 0) * 44;
        const lasts = key === TRACE.end ? 900 : 200;
        if (since >= 0 && since < lasts) {
          // Steps, not a fade: full, then two steps down.
          const k = since / lasts;
          fg = k < 0.34 ? run : k < 0.67 ? blend(run, tone, 0.45) : blend(run, tone, 0.75);
          bold = k < 0.34;
        }
      }
      s.put(x + c, y + r, ch, { fg, bold });
    });
  });
}

function blend(a: string, b: string, t: number): string {
  const n = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const part = (i: number) => Math.round(n(a, i) + (n(b, i) - n(a, i)) * t).toString(16).padStart(2, "0");
  return `#${part(0)}${part(1)}${part(2)}`;
}

// ---- Ordered dither ---------------------------------------------------------------------------------
// Bayer 4 by 4, the brand's replacement for gradients and fades. In a terminal the dots are braille:
// one character is two dots wide and four high, so the 4 by 4 cell is two characters.

const ORDER: [number, number][] = [[0, 0], [2, 2], [2, 0], [0, 2], [1, 1], [3, 3], [3, 1], [1, 3], [1, 0], [3, 2], [3, 0], [1, 2], [0, 1], [2, 3], [2, 1], [0, 3]];
const BRAILLE_BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
/** The densities a band steps through, in sixteenths. */
export const DITHER_LEVELS = [2, 4, 6, 8, 10, 12, 14];

/** The two characters that tile a row at density k/16. */
function ditherPair(k: number): [string, string] {
  let left = 0;
  let right = 0;
  for (const [dx, dy] of ORDER.slice(0, Math.max(0, Math.min(16, Math.round(k))))) {
    if (dx < 2) left |= BRAILLE_BIT[dy][dx];
    else right |= BRAILLE_BIT[dy][dx - 2];
  }
  return [String.fromCharCode(0x2800 + left), String.fromCharCode(0x2800 + right)];
}

/** One row of dither at density k/16 (0 to 16), in `fg` on the ground already there. */
export function ditherRow(s: Surface, x: number, y: number, width: number, k: number, fg: string): void {
  if (k <= 0) return;
  const [a, b] = ditherPair(k);
  for (let i = 0; i < width; i += 1) s.put(x + i, y, (x + i) % 2 === 0 ? a : b, { fg });
}

/** A band where one ground meets another: sparse dots at the top to dense at the bottom, over `rows` rows. */
export function ditherBand(s: Surface, x: number, y: number, width: number, rows: number, fg: string, options: { up?: boolean } = {}): void {
  for (let row = 0; row < rows; row += 1) {
    const step = rows === 1 ? 3 : Math.round((row * (DITHER_LEVELS.length - 1)) / (rows - 1));
    const k = DITHER_LEVELS[options.up ? DITHER_LEVELS.length - 1 - step : step];
    ditherRow(s, x, y + row, width, k, fg);
  }
}

// ---- Readings ---------------------------------------------------------------------------------------

/**
 * A value mid-decode, like a controller answering a poll: dashes before its turn, then digits
 * settling left to right. `t` is 0 to 1 over the whole decode; `delay` staggers one value after another.
 */
export function decodeAt(value: string, t: number, delay = 0, random: () => number = Math.random): string {
  const p = Math.max(0, Math.min(1, (t - delay) / 0.6));
  if (p >= 1) return value;
  if (p <= 0) return value.replace(/[0-9]/g, "-");
  return [...value].map((ch, i) => (/[0-9]/.test(ch) && i / value.length >= p ? String(Math.floor(random() * 10)) : ch)).join("");
}

/**
 * A reading that disagrees with reality: two frames of offset every 4.2 s, with the red and blue
 * ghosts. Reserved for faults. Given the time in ms, returns what to draw this frame.
 */
export function glitchFrame(ms: number): { shift: number; ghosts: boolean } {
  const k = (ms % 4200) / 4200;
  if (k >= 0.9 && k < 0.92) return { shift: -1, ghosts: true };
  if (k >= 0.92 && k < 0.95) return { shift: 1, ghosts: true };
  return { shift: 0, ghosts: false };
}

/** Writes text that may be glitching: the text itself, shifted, with a red copy to its left and a blue one to its right. */
export function putGlitch(s: Surface, x: number, y: number, text: string, style: { fg?: string; bg?: string; bold?: boolean }, ms: number | undefined): void {
  const frame = ms === undefined ? { shift: 0, ghosts: false } : glitchFrame(ms);
  if (frame.ghosts) {
    s.put(x + frame.shift - 1, y, text, { ...style, fg: GHOST_RED });
    s.put(x + frame.shift + 1, y, text, { ...style, fg: GHOST_BLUE });
  }
  s.put(x + frame.shift, y, text, style);
}

// ---- Big figures --------------------------------------------------------------------------------------
// Readings as an instrument shows them: figures three pixels wide and five high, two pixels to a cell.

const FIGURES: Record<string, string[]> = {
  "0": ["XXX", "X X", "X X", "X X", "XXX"], "1": [" X ", "XX ", " X ", " X ", "XXX"], "2": ["XXX", "  X", "XXX", "X  ", "XXX"], "3": ["XXX", "  X", "XXX", "  X", "XXX"],
  "4": ["X X", "X X", "XXX", "  X", "  X"], "5": ["XXX", "X  ", "XXX", "  X", "XXX"], "6": ["XXX", "X  ", "XXX", "X X", "XXX"], "7": ["XXX", "  X", "  X", "  X", "  X"],
  "8": ["XXX", "X X", "XXX", "X X", "XXX"], "9": ["XXX", "X X", "XXX", "  X", "XXX"], ".": [" ", " ", " ", " ", "X"], "-": ["  ", "  ", "XX", "  ", "  "], "°": ["XX", "XX", "  ", "  ", "  "],
  "%": ["X X", "  X", " X ", "X  ", "X X"], " ": [" ", " ", " ", " ", " "]
};
export const FIGURE_ROWS = 3;

/** How many cells a reading takes in big figures, or undefined when it holds something they cannot show. */
export function figuresWidth(text: string): number | undefined {
  let width = 0;
  for (const ch of text) {
    const glyph = FIGURES[ch];
    if (!glyph) return undefined;
    width += glyph[0].length + 1;
  }
  return Math.max(0, width - 1);
}

/** Draws a reading in big figures with its top-left at (x, y). Three rows of cells. */
export function drawFigures(s: Surface, x: number, y: number, text: string, colour: string): void {
  let at = x;
  for (const ch of text) {
    const glyph = FIGURES[ch];
    if (!glyph) continue;
    s.pixels(at, y, glyph[0].length, 5, (px, py) => (glyph[py][px] === "X" ? colour : undefined));
    at += glyph[0].length + 1;
  }
}
