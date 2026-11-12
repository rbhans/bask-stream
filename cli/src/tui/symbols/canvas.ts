// A grid of character cells to draw on: symbols, text, and pipes or ducts that join up where they
// meet and carry moving flow marks. It turns into runs of same-styled text for the screen.

export interface Style {
  color?: string;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

/** A stretch of text in one style. */
export interface Run {
  text: string;
  style: Style;
}

/** Text art with a letter per character saying how to colour it (see `paint` in library.ts). */
export interface Sprite {
  rows: string[];
  paint: string[];
}

// Which sides of a cell a line leaves by.
const N = 1;
const E = 2;
const S = 4;
const W = 8;
const LIGHT: Record<number, string> = {
  [E | W]: "─", [N | S]: "│", [E | S]: "╭", [W | S]: "╮", [E | N]: "╰", [W | N]: "╯",
  [N | S | E]: "├", [N | S | W]: "┤", [E | W | S]: "┬", [E | W | N]: "┴", [N | E | S | W]: "┼",
  // The end of a route is drawn as plain line, so it meets whatever it runs up to.
  [E]: "─", [W]: "─", [N]: "│", [S]: "│"
};
const DOUBLE: Record<number, string> = {
  [E | W]: "═", [N | S]: "║", [E | S]: "╔", [W | S]: "╗", [E | N]: "╚", [W | N]: "╝",
  [N | S | E]: "╠", [N | S | W]: "╣", [E | W | S]: "╦", [E | W | N]: "╩", [N | E | S | W]: "╬",
  [E]: "═", [W]: "═", [N]: "║", [S]: "║"
};
/** A flow mark for each direction of travel. */
const MARK: Record<number, string> = { [E]: "▸", [W]: "◂", [N]: "▴", [S]: "▾" };

export interface RouteOptions {
  /** A pipe is a single line, a duct a double one. */
  kind?: "pipe" | "duct";
  /** Colour of the line itself. */
  color?: string;
  /** Moving marks along the line: which way, how far along (a rising number), how far apart, and their colour. */
  flow?: { direction: 1 | -1; frame: number; spacing?: number; color?: string };
}

export class Canvas {
  private readonly cells: ({ ch: string; style: Style } | undefined)[][];
  private readonly lines: { bits: number; double: boolean; style: Style }[][];

  constructor(readonly width: number, readonly height: number) {
    this.cells = Array.from({ length: height }, () => new Array(width).fill(undefined));
    this.lines = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ bits: 0, double: false, style: {} })));
  }

  private inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** One character. */
  set(x: number, y: number, ch: string, style: Style = {}): void {
    if (this.inside(x, y)) this.cells[y][x] = { ch, style };
  }

  /** Text starting at a cell; it is cut off at the right edge. */
  text(x: number, y: number, text: string, style: Style = {}): void {
    [...text].forEach((ch, i) => this.set(x + i, y, ch, style));
  }

  /** Text centred on a column. */
  center(x: number, y: number, text: string, style: Style = {}): void {
    this.text(x - Math.floor([...text].length / 2), y, text, style);
  }

  /** A sprite with its top-left corner at a cell. Blank characters with blank paint leave what is underneath. */
  sprite(x: number, y: number, sprite: Sprite, styleOf: (letter: string) => Style): void {
    sprite.rows.forEach((row, dy) => {
      const paint = [...(sprite.paint[dy] ?? "")];
      [...row].forEach((ch, dx) => {
        const letter = paint[dx] ?? " ";
        if (ch === " " && letter === " ") return;
        this.set(x + dx, y + dy, ch, styleOf(letter));
      });
    });
  }

  /**
   * A pipe or duct through the given points (each leg straight across or straight up and down).
   * Where routes meet they join into tees and crosses. Flow marks travel along it.
   */
  route(points: [number, number][], options: RouteOptions = {}): void {
    const style: Style = { color: options.color };
    const path: { x: number; y: number; heading: number }[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[i + 1];
      const dx = Math.sign(x1 - x0);
      const dy = Math.sign(y1 - y0);
      if (dx !== 0 && dy !== 0) throw new Error("A route leg must be horizontal or vertical.");
      const out = dx > 0 ? E : dx < 0 ? W : dy > 0 ? S : N;
      const back = dx > 0 ? W : dx < 0 ? E : dy > 0 ? N : S;
      for (let x = x0, y = y0; x !== x1 || y !== y1; x += dx, y += dy) {
        this.join(x, y, out, options.kind === "duct", style);
        this.join(x + dx, y + dy, back, options.kind === "duct", style);
        path.push({ x, y, heading: out });
      }
    }
    const last = points[points.length - 1];
    if (path.length) path.push({ x: last[0], y: last[1], heading: path[path.length - 1].heading });
    const flow = options.flow;
    if (!flow) return;
    const spacing = flow.spacing ?? 4;
    path.forEach((cell) => {
      // Marks ride forward along the path, or backward when the flow is reversed. Where they sit
      // comes from the cell itself, so two routes sharing a stretch carry the same marks there.
      const heading = flow.direction > 0 ? cell.heading : cell.heading === E ? W : cell.heading === W ? E : cell.heading === N ? S : N;
      const at = heading === E ? cell.x - flow.frame : heading === W ? cell.x + flow.frame : heading === S ? cell.y - flow.frame : cell.y + flow.frame;
      if (((at % spacing) + spacing) % spacing !== 0) return;
      // Corners keep their bend; marks only sit on straight cells.
      const bits = this.lines[cell.y]?.[cell.x]?.bits ?? 0;
      if (bits !== (E | W) && bits !== (N | S)) return;
      this.set(cell.x, cell.y, MARK[heading], { color: flow.color ?? options.color, bold: true });
    });
  }

  private join(x: number, y: number, bit: number, double: boolean, style: Style): void {
    if (!this.inside(x, y)) return;
    const line = this.lines[y][x];
    line.bits |= bit;
    line.double = line.double || double;
    line.style = style;
  }

  /** The drawing as rows of runs, each row exactly `width` characters. */
  render(): Run[][] {
    return this.cells.map((row, y) => {
      const runs: Run[] = [];
      row.forEach((cell, x) => {
        const line = this.lines[y][x];
        const drawn = cell ?? (line.bits ? { ch: (line.double ? DOUBLE : LIGHT)[line.bits] ?? "·", style: line.style } : { ch: " ", style: {} });
        const last = runs[runs.length - 1];
        if (last && same(last.style, drawn.style)) last.text += drawn.ch;
        else runs.push({ text: drawn.ch, style: drawn.style });
      });
      return runs;
    });
  }

  /** The drawing as plain text, for tests and for printing. */
  toString(): string {
    return this.render().map((runs) => runs.map((run) => run.text).join("").trimEnd()).join("\n");
  }
}

const same = (a: Style, b: Style) => a.color === b.color && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.inverse === !!b.inverse;
