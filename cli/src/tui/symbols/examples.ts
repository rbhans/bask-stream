// Two assemblies built from the library, to show how the pieces go together: an air handler as one
// casing of sections with its coil piping, and a chilled water plant joined by pipes. They are
// ordinary graphic documents (the same thing `bask graphic` draws from a station's points), fed
// made-up numbers that drift with the frame.
import type { Canvas } from "./canvas.js";
import { drawGraphic, planGraphic, type GraphicDoc, type PointValue } from "./graphic.js";

export interface Example {
  id: string;
  title: string;
  width: number;
  height: number;
  doc: GraphicDoc;
  draw(frame: number): Canvas;
}

const BASE = "slot:/Example";
const swing = (frame: number, base: number, amount: number, period: number, phase = 0) => base + amount * Math.sin((frame / period) * 2 * Math.PI + phase);
const percent = (n: number): PointValue => ({ ok: true, value: Math.round(n), displayValue: `${Math.round(n)} %`, state: "ok" });

function example(id: string, title: string, doc: GraphicDoc, sim: Record<string, (frame: number) => PointValue>): Example {
  const plan = planGraphic(doc);
  return { id, title, doc, width: plan.width, height: plan.height, draw: (frame) => drawGraphic(plan, (ord) => sim[ord.slice(BASE.length + 1)]?.(frame), frame) };
}

const airHandler = example(
  "air-handler",
  "Air handler: one casing of sections, with coil piping",
  {
    title: "Air handler",
    base: BASE,
    rows: [
      {
        air: [
          { symbol: "louver" },
          { symbol: "damper", label: "Damper", value: "Damper" },
          { symbol: "filter", label: "Filter", value: 35, note: "0.82 in" },
          { symbol: "cooling-coil", label: "Cooling", value: "Cooling" },
          { symbol: "heating-coil", label: "Heating", value: "Heating" },
          { symbol: "humidifier", label: "Humid.", value: 40 },
          { symbol: "fan", label: "Fan", value: "Fan" },
          { symbol: "sensor", label: "Supply", text: "T", note: "55.4 °F" }
        ],
        from: { label: "OA", note: "78.9 °F" },
        to: { label: "SA", note: "to zones" }
      }
    ]
  },
  {
    Damper: (f) => percent(swing(f, 50, 45, 260)),
    Cooling: (f) => percent(Math.max(0, swing(f, 45, 40, 190, 1))),
    Heating: (f) => percent(Math.max(0, swing(f, -10, 40, 310, 2))),
    Fan: (f) => percent(swing(f, 72, 14, 230, 3))
  }
);

const plant = example(
  "chilled-water-plant",
  "Chilled water plant: tower, chiller and pump joined by pipes",
  {
    title: "Chilled water plant",
    base: BASE,
    rows: [
      {
        parts: [
          { id: "tower", symbol: "cooling-tower", label: "Tower", value: 60 },
          { id: "ch1", symbol: "chiller", label: "Chiller 1", value: "Load" },
          { id: "p1", symbol: "pump", label: "CHW pump", value: 65 },
          [
            { id: "supply", label: "CHW supply", note: "44.1 °F", medium: "chw" },
            { id: "return", label: "CHW return", note: "54.6 °F", medium: "chw" }
          ]
        ]
      }
    ],
    pipes: [
      { from: "tower.out", to: "ch1.cwIn", medium: "cw" },
      { from: "ch1.cwOut", to: "tower.in", medium: "cw" },
      { from: "ch1.chwOut", to: "p1.in", medium: "chw" },
      { from: "p1.out", to: "supply", medium: "chw" },
      { from: "return", to: "ch1.chwIn", medium: "chw" }
    ]
  },
  { Load: (f) => percent(swing(f, 62, 24, 280)) }
);

export const EXAMPLES: Example[] = [airHandler, plant];
