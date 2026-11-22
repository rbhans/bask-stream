// A screen of cells to draw on. Every cell has a character, a colour and a ground, so a frame is
// painted whole, the same on any terminal theme, and nothing depends on what was there before.
import chalk from "chalk";

export interface Style {
  fg?: string;
  /** Leave out to keep the ground already under the text. */
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  italic?: boolean;
}

interface Cell {
  ch: string;
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  underline: boolean;
  italic: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const painters = new Map<string, (text: string) => string>();
function painter(cell: Cell): (text: string) => string {
  const key = `${cell.fg}|${cell.bg}|${cell.bold ? 1 : 0}${cell.dim ? 1 : 0}${cell.underline ? 1 : 0}${cell.italic ? 1 : 0}`;
  let paint = painters.get(key);
  if (!paint) {
    let c = chalk.hex(cell.fg).bgHex(cell.bg);
    if (cell.bold) c = c.bold;
    if (cell.dim) c = c.dim;
    if (cell.underline) c = c.underline;
    if (cell.italic) c = c.italic;
    paint = c;
    painters.set(key, paint);
  }
  return paint;
}

export class Surface {
  readonly cells: Cell[];

  constructor(readonly width: number, readonly height: number, readonly fg: string, readonly bg: string) {
    this.cells = Array.from({ length: width * height }, () => ({ ch: " ", fg, bg, bold: false, dim: false, underline: false, italic: false }));
  }

  private at(x: number, y: number): Cell | undefined {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.cells[y * this.width + x] : undefined;
  }

  /** The ground at a cell, for drawing something that should sit on whatever is there. */
  bgAt(x: number, y: number): string {
    return this.at(x, y)?.bg ?? this.bg;
  }

  /** Writes text from (x, y) to the right, one cell a character, cut off at `maxWidth` and the edge. Returns the cells used. */
  put(x: number, y: number, text: string, style: Style = {}, maxWidth = Infinity): number {
    let used = 0;
    for (const ch of text) {
      if (used >= maxWidth) break;
      const cell = this.at(x + used, y);
      if (cell) {
        cell.ch = ch;
        cell.fg = style.fg ?? this.fg;
        if (style.bg) cell.bg = style.bg;
        cell.bold = !!style.bold;
        cell.dim = !!style.dim;
        cell.underline = !!style.underline;
        cell.italic = !!style.italic;
      }
      used += 1;
    }
    return used;
  }

  /** Like `put`, for a sentence: when it does not fit in `width`, it is cut with an ellipsis. */
  putClipped(x: number, y: number, text: string, style: Style, width: number): number {
    const chars = [...text];
    if (width <= 0) return 0;
    return this.put(x, y, chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("").trimEnd()}…`, style, width);
  }

  /** Text ending at column `right` (exclusive). */
  putRight(right: number, y: number, text: string, style: Style = {}): number {
    const length = [...text].length;
    this.put(right - length, y, text, style);
    return length;
  }

  /** Text centred in `width` cells starting at x. */
  putCentre(x: number, y: number, width: number, text: string, style: Style = {}): void {
    const chars = [...text];
    const shown = chars.length > width ? chars.slice(0, width) : chars;
    this.put(x + Math.floor((width - shown.length) / 2), y, shown.join(""), style);
  }

  /** Paints a ground over a rectangle, clearing what was written there. */
  fill(rect: Rect, bg: string, fg?: string): void {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const cell = this.at(x, y);
        if (!cell) continue;
        cell.ch = " ";
        cell.bg = bg;
        cell.fg = fg ?? this.fg;
        cell.bold = cell.dim = cell.underline = cell.italic = false;
      }
    }
  }

  /** Changes the ground of a rectangle and keeps what is written on it. */
  tint(rect: Rect, bg: string): void {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const cell = this.at(x, y);
        if (cell) cell.bg = bg;
      }
    }
  }

  /** Recolours text in a rectangle (and keeps the characters). */
  ink(rect: Rect, fg: string): void {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const cell = this.at(x, y);
        if (cell) cell.fg = fg;
      }
    }
  }

  /** Square pixels, two to a cell high: `colour(x, y)` for each pixel of a `w` by `h` picture, undefined to show the ground. */
  pixels(x: number, y: number, w: number, h: number, colour: (px: number, py: number) => string | undefined): void {
    for (let row = 0; row < Math.ceil(h / 2); row += 1) {
      for (let col = 0; col < w; col += 1) {
        const cell = this.at(x + col, y + row);
        if (!cell) continue;
        const top = colour(col, row * 2);
        const bottom = row * 2 + 1 < h ? colour(col, row * 2 + 1) : undefined;
        if (!top && !bottom) continue;
        cell.bold = cell.dim = cell.underline = cell.italic = false;
        if (top && bottom) {
          if (top === bottom) {
            cell.ch = " ";
            cell.bg = top;
          } else {
            cell.ch = "▀";
            cell.fg = top;
            cell.bg = bottom;
          }
        } else if (top) {
          cell.ch = "▀";
          cell.fg = top;
        } else {
          cell.ch = "▄";
          cell.fg = bottom!;
        }
      }
    }
  }

  /**
   * Fine horizontal edges: each cell is eight slices high, and `colour(col, slice)` gives each slice's
   * colour (undefined shows the ground). A cell can hold one edge, between whatever is above it and
   * whatever is below; where a column asks for more, the closest single edge is drawn.
   */
  eighths(x: number, y: number, cols: number, rows: number, colour: (col: number, slice: number) => string | undefined): void {
    const LOWER = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cell = this.at(x + col, y + row);
        if (!cell) continue;
        const slices = Array.from({ length: 8 }, (_v, i) => colour(col, row * 8 + i));
        if (slices.every((c) => c === undefined)) continue;
        // The best single edge: `n` slices of one colour above, the rest another below.
        let best = { n: 0, misses: 9, above: slices[0], below: slices[0] };
        const commonest = (part: (string | undefined)[]) => {
          const counts = new Map<string | undefined, number>();
          for (const c of part) counts.set(c, (counts.get(c) ?? 0) + 1);
          return [...counts].sort((p, q) => q[1] - p[1])[0];
        };
        for (let n = 0; n <= 8; n += 1) {
          const [above, aboveCount] = n ? commonest(slices.slice(0, n)) : [undefined, 0];
          const [below, belowCount] = n < 8 ? commonest(slices.slice(n)) : [undefined, 0];
          const misses = 8 - aboveCount - belowCount;
          if (misses < best.misses) best = { n, misses, above: n ? above : below, below: n < 8 ? below : above };
        }
        cell.bold = cell.dim = cell.underline = cell.italic = false;
        const above = best.above ?? cell.bg;
        const below = best.below ?? cell.bg;
        if (best.n === 0 || best.n === 8 || above === below) {
          cell.ch = " ";
          cell.bg = best.n === 0 ? below : above;
        } else {
          cell.ch = LOWER[8 - best.n];
          cell.fg = below;
          cell.bg = above;
        }
      }
    }
  }

  /** Copies another surface onto this one at (x, y). */
  blit(other: Surface, x: number, y: number): void {
    for (let row = 0; row < other.height; row += 1) {
      for (let col = 0; col < other.width; col += 1) {
        const to = this.at(x + col, y + row);
        if (to) Object.assign(to, other.cells[row * other.width + col]);
      }
    }
  }

  /** The frame as lines of coloured text. */
  lines(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let line = "";
      let run = "";
      let first = this.cells[y * this.width];
      const same = (a: Cell, b: Cell) => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.underline === b.underline && a.italic === b.italic;
      for (let x = 0; x < this.width; x += 1) {
        const cell = this.cells[y * this.width + x];
        // A space shows only its ground, so it can join a run of any text colour on that ground.
        if (run && !(same(cell, first) || (cell.ch === " " && cell.bg === first.bg && !first.underline && !cell.underline))) {
          line += painter(first)(run);
          run = "";
        }
        if (!run) first = cell;
        run += cell.ch;
      }
      if (run) line += painter(first)(run);
      out.push(line);
    }
    return out;
  }

  /** The frame as plain text, for tests. */
  text(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.height; y += 1) out.push(this.cells.slice(y * this.width, (y + 1) * this.width).map((c) => c.ch).join(""));
    return out;
  }
}
