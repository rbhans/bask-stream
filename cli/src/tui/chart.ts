// Braille line charts: each character cell is a 2 x 4 grid of dots, so a chart `cols` wide and `rows`
// tall plots cols*2 by rows*4 points.

const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80]
];

/** Stretches or squeezes a series to `count` samples, keeping gaps (undefined) as gaps. */
export function resample(values: (number | undefined)[], count: number): (number | undefined)[] {
  if (values.length === 0) return new Array(count).fill(undefined);
  if (values.length === 1) return new Array(count).fill(values[0]);
  const out: (number | undefined)[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = (i * (values.length - 1)) / Math.max(1, count - 1);
    const lo = Math.floor(at);
    const hi = Math.min(values.length - 1, lo + 1);
    const a = values[lo];
    const b = values[hi];
    out.push(a === undefined || b === undefined ? (at - lo < 0.5 ? a : b) : a + (b - a) * (at - lo));
  }
  return out;
}

/** A line through `values` (one per dot column, left to right) scaled between `min` and `max`. */
export function brailleLine(values: (number | undefined)[], cols: number, rows: number, min: number, max: number): string[] {
  const width = cols * 2;
  const height = rows * 4;
  const cells = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const span = max - min || 1;
  const yOf = (v: number) => Math.max(0, Math.min(height - 1, Math.round((1 - (v - min) / span) * (height - 1))));
  const dot = (x: number, y: number) => {
    cells[Math.floor(y / 4)][Math.floor(x / 2)] |= DOT[y % 4][x % 2];
  };
  const data = values.length === width ? values : resample(values, width);
  let previous: number | undefined;
  for (let x = 0; x < width; x += 1) {
    const v = data[x];
    if (v === undefined) {
      previous = undefined;
      continue;
    }
    const y = yOf(v);
    // Fill the vertical gap to the last point so steep changes stay one connected line.
    const from = previous === undefined ? y : previous < y ? previous + 1 : previous > y ? previous - 1 : y;
    for (let at = Math.min(from, y); at <= Math.max(from, y); at += 1) dot(x, at);
    previous = y;
  }
  return cells.map((row) => row.map((bits) => String.fromCharCode(0x2800 + bits)).join(""));
}

/** Axis bounds with a little headroom, so a flat series is not drawn on the frame. */
export function bounds(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
}
