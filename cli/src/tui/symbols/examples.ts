// Two assemblies built from the library, to show how the pieces go together: an air handler as one
// casing of sections with its coil piping, and a chilled water plant joined by pipes. The numbers
// are made up and drift with the frame; nothing here reads a station.
import { theme } from "../theme.js";
import { Canvas } from "./canvas.js";
import { drawSymbol, mediumColor, paint, sizeOf, type SymbolState } from "./library.js";

export interface Example {
  id: string;
  title: string;
  width: number;
  height: number;
  draw(frame: number): Canvas;
}

const swing = (frame: number, base: number, amount: number, period: number, phase = 0) => base + amount * Math.sin((frame / period) * 2 * Math.PI + phase);
const place = (canvas: Canvas, x: number, y: number, id: string, state: SymbolState, frame: number): [number, number] => {
  const sprite = drawSymbol(id, state, frame);
  canvas.sprite(x, y, sprite, (letter) => paint(letter, state));
  return sizeOf(sprite);
};

const airHandler: Example = {
  id: "air-handler",
  title: "Air handler: one casing of sections, with coil piping",
  width: 98,
  height: 14,
  draw(frame) {
    const canvas = new Canvas(this.width, this.height);
    const top = 3;
    const damper = Math.round(swing(frame, 50, 45, 260));
    const cooling = Math.round(Math.max(0, swing(frame, 45, 40, 190, 1)));
    const heating = Math.max(0, Math.round(swing(frame, -10, 40, 310, 2)));
    const fanSpeed = Math.round(swing(frame, 72, 14, 230, 3));
    const muted = { color: theme.muted };
    const bold = { bold: true };

    // Outside air in from the left, supply air out to the right.
    canvas.text(0, top + 1, "OA", bold);
    canvas.text(0, top + 3, "78.9 °F", muted);
    canvas.route([[3, top + 2], [8, top + 2]], { kind: "duct", color: theme.faint, flow: { direction: 1, frame, spacing: 3, color: mediumColor("air") } });
    let x = 9;
    canvas.sprite(x - 1, top, { rows: ["╭", "│", " ", "│", "╰"], paint: ["f", "f", " ", "f", "f"] }, (letter) => paint(letter, {}));

    const sections: { id: string; state: SymbolState; name?: string; reading?: string }[] = [
      { id: "louver", state: {} },
      { id: "damper", state: { value: damper }, name: "Damper", reading: `${damper} %` },
      { id: "airflow", state: { width: 4 } },
      { id: "filter", state: { value: 35 }, name: "Filter", reading: "0.82 in" },
      { id: "airflow", state: { width: 4 } },
      { id: "cooling-coil", state: { value: cooling }, name: "Cooling", reading: `${cooling} %` },
      { id: "airflow", state: { width: 3 } },
      { id: "heating-coil", state: { value: heating }, name: "Heating", reading: `${heating} %` },
      { id: "airflow", state: { width: 3 } },
      { id: "humidifier", state: { value: 40 }, name: "Humid.", reading: "40 %" },
      { id: "airflow", state: { width: 3 } },
      { id: "fan", state: { value: fanSpeed }, name: "Fan", reading: `${fanSpeed} %` },
      { id: "airflow", state: { width: 3 } },
      { id: "sensor", state: { text: "T" }, name: "Supply", reading: "55.4 °F" },
      { id: "airflow", state: { width: 5 } }
    ];
    const coils: { x: number; medium: "chw" | "hw"; value: number }[] = [];
    for (const section of sections) {
      const [width] = place(canvas, x, top, section.id, section.state, frame);
      if (section.name) {
        canvas.center(x + Math.floor(width / 2), top - 3, section.name, muted);
        canvas.center(x + Math.floor(width / 2), top - 2, section.reading ?? "", bold);
      }
      if (section.id === "cooling-coil") coils.push({ x, medium: "chw", value: cooling });
      if (section.id === "heating-coil") coils.push({ x, medium: "hw", value: heating });
      x += width;
    }
    canvas.sprite(x, top, { rows: ["╮", "│", " ", "│", "╯"], paint: ["f", "f", " ", "f", "f"] }, (letter) => paint(letter, {}));
    canvas.route([[x + 1, top + 2], [x + 7, top + 2]], { kind: "duct", color: theme.faint, flow: { direction: 1, frame, spacing: 3, color: mediumColor("air") } });
    canvas.text(x + 9, top + 1, "SA", bold);
    canvas.text(x + 9, top + 3, "to zones", muted);

    // Each coil: supply up one leg, return down the other through a valve.
    for (const coilAt of coils) {
      const color = mediumColor(coilAt.medium);
      const flowing = coilAt.value > 0;
      const supply = coilAt.x + 1;
      const back = coilAt.x + 4;
      canvas.route([[supply, top + 9], [supply, top + 4]], { color: theme.faint, flow: flowing ? { direction: 1, frame: Math.floor(frame / 2), spacing: 3, color } : undefined });
      canvas.route([[back, top + 4], [back, top + 9]], { color: theme.faint, flow: flowing ? { direction: 1, frame: Math.floor(frame / 2), spacing: 3, color } : undefined });
      const valve = drawSymbol("valve", { value: coilAt.value, medium: coilAt.medium, vertical: true }, frame);
      canvas.sprite(back, top + 6, valve, (letter) => paint(letter, { value: coilAt.value, medium: coilAt.medium }));
      canvas.center(supply + 1, top + 10, coilAt.medium === "chw" ? "CHW" : "HW", { color });
    }
    return canvas;
  }
};

const plant: Example = {
  id: "chilled-water-plant",
  title: "Chilled water plant: tower, chiller and pump joined by pipes",
  width: 76,
  height: 12,
  draw(frame) {
    const canvas = new Canvas(this.width, this.height);
    const load = Math.round(swing(frame, 62, 24, 280));
    const muted = { color: theme.muted };
    const bold = { bold: true };
    const cw = mediumColor("cw");
    const chw = mediumColor("chw");
    const flow = (color: string, direction: 1 | -1 = 1) => ({ direction, frame: Math.floor(frame / 2), spacing: 4, color });

    place(canvas, 2, 2, "cooling-tower", { value: 60 }, frame);
    place(canvas, 22, 3, "chiller", { value: load }, frame);
    place(canvas, 44, 5, "pump", { value: 65 }, frame);

    // Condenser water: tower basin to the chiller and back over the top.
    canvas.route([[10, 6], [17, 6], [17, 4], [21, 4]], { color: theme.faint, flow: flow(cw) });
    canvas.route([[36, 4], [39, 4], [39, 1], [0, 1], [0, 6], [2, 6]], { color: theme.faint, flow: flow(cw) });
    // Chilled water: out through the pump to the building, and back to the evaporator.
    canvas.route([[36, 6], [43, 6]], { color: theme.faint, flow: flow(chw) });
    canvas.route([[47, 6], [62, 6]], { color: theme.faint, flow: flow(chw) });
    canvas.route([[62, 9], [19, 9], [19, 6], [21, 6]], { color: theme.faint, flow: flow(chw) });

    canvas.text(64, 5, "CHW supply", bold);
    canvas.text(64, 6, "44.1 °F", { color: chw });
    canvas.text(64, 8, "CHW return", bold);
    canvas.text(64, 9, "54.6 °F", { color: chw });
    canvas.center(6, 9, "Tower", muted);
    canvas.center(6, 10, "60 %", bold);
    canvas.text(24, 10, "Chiller 1", muted);
    canvas.text(34, 10, `${load} %`, bold);
    canvas.text(41, 10, "CHW pump", muted);
    canvas.text(50, 10, "65 %", bold);
    return canvas;
  }
};

export const EXAMPLES: Example[] = [airHandler, plant];
