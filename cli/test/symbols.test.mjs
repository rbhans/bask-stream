// The terminal symbol library: every symbol in every state, the canvas that joins them, the
// example assemblies, and the gallery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Canvas } from "../dist/tui/symbols/canvas.js";
import { EXAMPLES } from "../dist/tui/symbols/examples.js";
import { GROUPS, STATUSES, SYMBOLS, drawSymbol, moving, sizeOf } from "../dist/tui/symbols/library.js";
import { mountGallery, settle } from "./harness.mjs";

const len = (text) => [...text].length;
const LETTERS = new Set([..." fsmahrwcgbtTd"]);
const art = (id, state, frame = 0) => drawSymbol(id, state, frame).rows.join("\n");

test("every symbol keeps its size and paints every character, in every state and frame", () => {
  assert.ok(SYMBOLS.length >= 29);
  assert.equal(new Set(SYMBOLS.map((s) => s.id)).size, SYMBOLS.length);
  for (const def of SYMBOLS) {
    assert.ok(GROUPS.includes(def.group), `${def.id}: group`);
    assert.ok(def.note.length > 10, `${def.id}: note`);
    const sizes = new Set();
    for (const status of STATUSES) for (const value of [0, 30, 60, 100]) for (const on of [true, false]) for (let frame = 0; frame < 16; frame += 1) {
      const sprite = def.draw({ ...def.sample, status, value, aux: value, on, open: frame % 2 === 0, flow: frame % 3 ? 1 : -1 }, frame);
      const width = len(sprite.rows[0]);
      sizes.add(`${width}x${sprite.rows.length}`);
      assert.equal(sprite.paint.length, sprite.rows.length, `${def.id}: a paint row per row`);
      sprite.rows.forEach((row, y) => {
        assert.equal(len(row), width, `${def.id} frame ${frame} row ${y}: "${row}"`);
        assert.equal(len(sprite.paint[y]), width, `${def.id} frame ${frame} paint ${y}: "${sprite.paint[y]}" for "${row}"`);
        for (const letter of sprite.paint[y]) assert.ok(LETTERS.has(letter), `${def.id}: paint letter "${letter}"`);
      });
    }
    assert.equal(sizes.size, 1, `${def.id} changes size: ${[...sizes].join(" ")}`);
    for (const [name, [x, y]] of Object.entries(def.ports ?? {})) {
      const [w, h] = sizeOf(def.draw(def.sample, 0));
      assert.ok(x >= -1 && x <= w && y >= -1 && y <= h, `${def.id}: port ${name} at ${x},${y} is next to the ${w}x${h} symbol`);
    }
  }
});

test("moving parts move while running and stand still when off, faulted or unreachable", () => {
  for (const id of ["fan", "pump", "airflow", "chiller", "boiler", "cooling-tower", "compressor", "crac", "humidifier"]) {
    const def = SYMBOLS.find((s) => s.id === id);
    const running = new Set(Array.from({ length: 12 }, (_v, frame) => JSON.stringify(def.draw({ ...def.sample, on: true, status: "ok", value: 80 }, frame))));
    assert.ok(running.size > 1, `${id} animates`);
    for (const state of [{ on: false }, { status: "off" }, { status: "fault" }, { status: "down" }]) {
      const still = new Set(Array.from({ length: 12 }, (_v, frame) => JSON.stringify(def.draw({ ...def.sample, value: 80, ...state }, frame))));
      assert.equal(still.size, 1, `${id} stands still when ${JSON.stringify(state)}`);
    }
  }
  assert.equal(moving({ status: "alarm" }), true, "an alarm alone does not stop a machine");
  // A faster fan takes fewer frames per step.
  const steps = (value) => new Set(Array.from({ length: 6 }, (_v, frame) => JSON.stringify(drawSymbol("fan", { value }, frame)))).size;
  assert.ok(steps(90) > steps(20));
});

test("positions, levels and loads follow the value", () => {
  assert.match(art("damper", { value: 0 }), /│/);
  assert.match(art("damper", { value: 50 }), /╱/);
  assert.match(art("damper", { value: 100 }), /───/);
  assert.equal(art("valve", { value: 0 }), "▶◀");
  assert.equal(art("valve", { value: 60 }), "▷◁");
  assert.equal(art("valve", { value: 60, vertical: true }), "▽\n△");
  assert.equal(art("tank", { value: 0 }).match(/[▁▂▃▄▅▆▇█]/g), null);
  assert.equal(art("tank", { value: 100 }).match(/█/g).length, 15);
  assert.equal(art("chiller", { value: 50 }).match(/━/g).length, 4);
  assert.equal(art("ups", { value: 100 }).match(/▮/g).length, 7);
  assert.equal(art("gauge", { value: 30 }).match(/█/g).length, 3);
  assert.match(art("cold-room", { text: "-9.4 °F" }), /│ -9\.4 °F │/);
  assert.match(art("cold-room", { open: true }), /╱/);
  assert.equal(sizeOf(drawSymbol("airflow", { width: 3 }))[0], 3);
  assert.match(art("plate", { title: "Zone 105", text: "78.6 °F" }), /╭─ Zone 105 ─+╮\n│ ● 78\.6 °F +│/);
  assert.throws(() => drawSymbol("nope"), /No symbol "nope"/);
});

test("routes turn corners, join where they meet and carry marks that move", () => {
  const canvas = new Canvas(12, 5);
  canvas.route([[0, 0], [6, 0], [6, 4], [11, 4]]);
  canvas.route([[6, 2], [11, 2]]);
  assert.equal(canvas.toString(), ["──────╮", "      │", "      ├─────", "      │", "      ╰─────"].join("\n"));

  const duct = new Canvas(6, 1);
  duct.route([[0, 0], [5, 0]], { kind: "duct" });
  assert.equal(duct.toString(), "══════");

  const at = (frame, direction = 1) => {
    const flowing = new Canvas(9, 1);
    flowing.route([[0, 0], [8, 0]], { flow: { direction, frame, spacing: 4 } });
    return flowing.toString();
  };
  // Marks sit on the run of the line, not on its two ends.
  assert.equal(at(0), "────▸────");
  assert.equal(at(1), "─▸───▸───");
  assert.equal(at(1, -1), "───◂───◂─");
  // Sprites sit on top of lines, and blank sprite cells leave the line showing.
  const mixed = new Canvas(7, 3);
  mixed.route([[0, 1], [6, 1]]);
  mixed.sprite(2, 0, drawSymbol("pump", { on: false }), () => ({}));
  assert.equal(mixed.toString(), "  ╭─╮\n──┤○├──\n  ╰─╯");
  assert.throws(() => new Canvas(4, 4).route([[0, 0], [3, 3]]), /horizontal or vertical/);
});

test("the example assemblies draw inside their declared size, and move", () => {
  for (const example of EXAMPLES) {
    const first = example.draw(0);
    const rows = first.render();
    assert.equal(rows.length, example.height, example.id);
    for (const runs of rows) assert.equal(len(runs.map((run) => run.text).join("")), example.width, example.id);
    assert.notEqual(example.draw(3).toString(), first.toString(), `${example.id} animates`);
  }
  const ahu = EXAMPLES.find((e) => e.id === "air-handler").draw(0).toString();
  assert.match(ahu, /╭─+╮/);
  assert.match(ahu, /Damper\s+Filter\s+Cooling\s+Heating\s+Humid\.\s+Fan\s+Supply/);
  assert.match(ahu, /CHW\s+HW/);
  const plant = EXAMPLES.find((e) => e.id === "chilled-water-plant").draw(0).toString();
  // Pipes reach the equipment they join.
  assert.match(plant, /─┤ . \([░▒▓]{6}\) ├─/);
  assert.match(plant, /─┤.├─/);
});

test("the gallery shows the library, tries states with keys, and has the examples", async () => {
  const app = mountGallery({ mouse: true }, { columns: 150, rows: 50 });
  try {
    const frame = await app.until(/Symbols 29/);
    for (const title of ["Air handling", "Water and plant", "Cooling coil", "Chiller", "Server rack"]) assert.match(frame, new RegExp(title));
    assert.match(frame, /╭─ Airflow ─+ airflow · 8 x 5 ╮/);
    await app.press("right", "right");
    await app.until(/╭─ Damper ─+ damper · 5 x 5 ╮/);
    assert.match(app.frame(), /now: running · value 45/);
    await app.press("]", "]", "]", "]", "]");
    await app.until(/value 95/);
    await app.press("s", "s");
    await app.until(/now: alarm/);
    await app.press("r");
    await app.until(/now: running · value 45/);
    // Down a row lands on the nearest symbol below.
    await app.press("down");
    await app.until(/╭─ (Duct sensor|VAV box|Humidifier) /);
    await app.press("space");
    await app.until(/paused/);
    const paused = app.frame();
    await settle(400);
    assert.equal(app.frame(), paused);
    await app.press("tab");
    const examples = await app.until(/Air handler: one casing of sections/);
    assert.match(examples, /Chilled water plant/);
  } finally {
    app.unmount();
  }
});

test("the gallery fits small windows and says when the examples need more room", async () => {
  for (const [columns, rows] of [[80, 24], [60, 16], [200, 60]]) {
    const app = mountGallery({}, { columns, rows });
    try {
      await app.until(/Airflow/);
      for (const page of ["symbols", "examples"]) {
        await settle(200);
        const lines = app.frame().split("\n");
        assert.ok(lines.length <= rows, `${page} at ${columns}x${rows}: ${lines.length} lines`);
        for (const line of lines) assert.ok(len(line) <= columns, `${page} at ${columns}x${rows}: "${line}"`);
        if (page === "symbols") await app.press("tab");
      }
      if (columns < 100) assert.match(app.frame(), /examples need a window at least/);
    } finally {
      app.unmount();
    }
  }
});
