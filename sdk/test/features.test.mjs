// The engines are part of the SDK: another program gets them from the package, with no CLI.
import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "../dist/index.js";

test("the engines are exported from the package", () => {
  for (const name of ["explain", "whyText", "readLog", "logText", "valuesAt", "parseAt", "parseCheckout", "rehearseCheckout", "runCheckout", "checkoutReport",
    "readEvidence", "inferModel", "inferServes", "buildReview", "readSite", "buildSite", "loadSheet", "traceOf", "namedLinks", "fmtPoint", "shortOrd"]) {
    assert.equal(typeof sdk[name], "function", `${name} is exported`);
  }
});

test("a checkout document parses without a station", () => {
  assert.throws(() => sdk.parseCheckout("nothing a checkout could be", "x.md"), sdk.CheckoutParseError);
});

test("the map: a station tagged with Haystack 4 is read like one tagged with the older set, and places come with it", async () => {
  const { readEvidence, inferModel, inferServes, buildReview } = await import("../dist/model.js");
  const { buildSite, ARRANGE_KEY } = await import("../dist/site.js");
  const P = "slot:/Drivers/Net/points";
  const point = (ord, name) => ({ ord, name, kind: "point", typeSpec: "control:NumericPoint", parent: ord.slice(0, ord.lastIndexOf("/")) });
  const tree = {
    "slot:/": [{ ord: "slot:/Drivers", name: "Drivers", kind: "folder", typeSpec: "baja:Folder" }],
    "slot:/Drivers": [{ ord: "slot:/Drivers/Net", name: "Net", kind: "folder", typeSpec: "baja:Folder" }],
    "slot:/Drivers/Net": [{ ord: P, name: "points", kind: "folder", typeSpec: "baja:Folder" }],
    [P]: ["Unit_A", "Unit_B", "Unit_C"].map((name) => ({ ord: `${P}/${name}`, name, kind: "folder", typeSpec: "baja:Folder" })),
    [`${P}/Unit_A`]: [point(`${P}/Unit_A/T1`, "T1")], [`${P}/Unit_B`]: [point(`${P}/Unit_B/T1`, "T1")], [`${P}/Unit_C`]: [point(`${P}/Unit_C/T1`, "T1")]
  };
  const marker = (name) => ({ id: `h4:${name}`, name, marker: true, source: "direct" });
  const rel = (name, to) => ({ id: `h4:${name}`, name, direction: "out", endpointOrd: to });
  const B = "slot:/Building/HQ";
  const h4 = {
    [`${P}/Unit_A`]: { tags: [marker("ahu"), marker("equip")], relations: [rel("siteRef", B), rel("spaceRef", `${B}/Roof`)] },
    [`${P}/Unit_B`]: { tags: [marker("vav"), marker("equip")], relations: [rel("airRef", `${P}/Unit_A`), rel("siteRef", B), rel("spaceRef", `${B}/L2/R201`)] },
    [`${P}/Unit_C`]: { tags: [marker("vav"), marker("equip")], relations: [] },
    [`${P}/Unit_A/T1`]: { tags: [marker("discharge"), marker("air"), marker("temp"), marker("sensor"), marker("point")], relations: [] },
    [`${P}/Unit_B/T1`]: { tags: [marker("zone"), marker("air"), marker("temp"), marker("sensor"), marker("point")], relations: [] },
    [`${P}/Unit_C/T1`]: { tags: [marker("zone"), marker("air"), marker("temp"), marker("sensor"), marker("point")], relations: [] },
    [B]: { tags: [marker("site"), { name: "dis", value: "Headquarters", marker: false }], relations: [] },
    [`${B}/Roof`]: { tags: [marker("space")], relations: [rel("siteRef", B)] },
    [`${B}/L2`]: { tags: [marker("space"), marker("floor"), { name: "dis", value: "Level 2", marker: false }], relations: [rel("siteRef", B)] },
    [`${B}/L2/R201`]: { tags: [marker("space"), marker("room"), { name: "dis", value: "201 Office", marker: false }], relations: [rel("siteRef", B), rel("spaceRef", `${B}/L2`)] }
  };
  const client = {
    capabilities: { limits: {} },
    async browse(ord) { return { children: tree[ord] ?? [] }; },
    async read(ords) { return ords.map((ord) => ({ point: ord, ok: true, value: 70, facets: { units: "°F" }, valueType: "numeric" })); },
    async call(op, body) {
      if (op === "read_tags") return { targets: body.dictionary === "h4" ? body.ords.map((ord) => ({ ord, display: ord.split("/").pop(), ...(h4[ord] ?? { tags: [], relations: [] }) })) : body.ords.map((ord) => ({ ord, tags: [], relations: [] })) };
      if (op === "browse") return { node: { ord: body.ord, children: tree[body.ord] ?? [] }, children: tree[body.ord] ?? [] };
      return {};
    }
  };
  let read;
  try {
    read = await readEvidence(client, "slot:/");
  } catch (error) {
    // The tree walk needs more of a station than this stand-in has: the reading of tags is what is under test.
    read = undefined;
  }
  const evidence = read?.evidence?.length ? read.evidence : ["Unit_A", "Unit_B", "Unit_C"].map((name) => ({
    ord: `${P}/${name}`, name, typeSpec: "baja:Folder", tags: h4[`${P}/${name}`].tags.map((t) => t.name), relations: h4[`${P}/${name}`].relations.map((r) => ({ name: r.name, to: r.endpointOrd })),
    points: [{ ord: `${P}/${name}/T1`, name: "T1", typeSpec: "control:NumericPoint", writable: false, units: "°F", valueType: "numeric", tags: h4[`${P}/${name}/T1`].tags.map((t) => t.name) }]
  }));
  const places = read?.evidence?.length ? read.places : {
    [B]: { ord: B, name: "Headquarters", kind: "site" }, [`${B}/Roof`]: { ord: `${B}/Roof`, name: "Roof", kind: "space", site: B },
    [`${B}/L2`]: { ord: `${B}/L2`, name: "Level 2", kind: "floor", site: B }, [`${B}/L2/R201`]: { ord: `${B}/L2/R201`, name: "201 Office", kind: "room", parent: `${B}/L2`, site: B }
  };
  const equipment = inferModel(evidence);
  // What it is comes from the tags, and a point with a name that says nothing gets its role from them too.
  assert.deepEqual(equipment.map((e) => [e.name, e.kind, e.confirmed, e.points[0].role]), [["Unit_A", "ahu", true, "supplyAirTemp"], ["Unit_B", "vav", true, "zoneTemp"], ["Unit_C", "vav", true, "zoneTemp"]]);
  const serves = inferServes(equipment, [], evidence);
  assert.deepEqual(serves.filter((s) => !s.inferred).map((s) => [s.fromName, s.toName, s.medium]), [["Unit_A", "Unit_B", "air"]]);
  const review = buildReview("T", "slot:/", equipment, undefined, serves, places);
  // By what feeds what: the fed box under its air handler; the box nothing feeds, with others of its type, not by its folder.
  const fed = buildSite(review);
  assert.equal(fed.arrange, "feeds");
  assert.deepEqual(fed.groups.map((g) => [g.title, g.by, g.members.map((m) => m.name)]), [["Unit_A", "serves", ["Unit_B"]], ["VAV boxes", "kind", ["Unit_C"]]]);
  assert.equal(fed.units.find((u) => u.name === "Unit_B").place.path, "Headquarters › Level 2 › 201 Office");
  assert.equal(fed.units.find((u) => u.name === "Unit_A").place.path, "Headquarters › Roof");
  // By place: floor by floor, and what has no place falls back to its type.
  const byPlace = buildSite(review, false, { [ARRANGE_KEY]: "place" });
  assert.deepEqual(byPlace.groups.map((g) => [g.title, g.by, g.members.map((m) => m.name)]), [["Level 2", "place", ["Unit_B"]], ["Roof", "place", ["Unit_A"]], ["VAV boxes", "kind", ["Unit_C"]]]);
});

test("the map: a plant holds its own equipment on the water side, air handlers are the air side, and a zone between two setpoints has a band", async () => {
  const { buildSite } = await import("../dist/site.js");
  const P = "slot:/Drivers/Net/points";
  const pt = (unit, name, role) => ({ ord: `${P}/${unit}/${name}`, name, role, label: role, unit: "°F", tags: [] });
  const eq = (name, kind, label, points, more = {}) => ({ ord: `${P}/${name}`, name, kind, label, tags: [kind, "equip"], confidence: 1, reason: "tagged", confirmed: true, points, ...more });
  const review = {
    station: "T", under: "slot:/", generatedAt: "", serves: [
      { from: `${P}/AHU_1`, fromName: "AHU_1", to: `${P}/VAV_1`, toName: "VAV_1", medium: "air", inferred: false, confirmed: true, confidence: 1, reason: "the station relates them (airRef)" },
      { from: `${P}/CHW_Plant`, fromName: "CHW_Plant", to: `${P}/AHU_1`, toName: "AHU_1", medium: "chilledWater", inferred: false, confirmed: true, confidence: 1, reason: "the station relates them (chilledWaterRef)" },
      { from: `${P}/HW_Plant`, fromName: "HW_Plant", to: `${P}/AHU_1`, toName: "AHU_1", medium: "hotWater", inferred: true, confirmed: false, confidence: 0.9, reason: "the only one" },
      { from: `${P}/HW_Plant`, fromName: "HW_Plant", to: `${P}/VAV_1`, toName: "VAV_1", medium: "hotWater", inferred: true, confirmed: true, confidence: 1, reason: "a person said so" }
    ],
    equipment: [
      eq("AHU_1", "ahu", "air handler", [pt("AHU_1", "SAT", "supplyAirTemp")]),
      eq("VAV_1", "vav", "VAV box", [pt("VAV_1", "ZT", "zoneTemp"), pt("VAV_1", "Heat", "zoneHeatingSp"), pt("VAV_1", "Cool", "zoneCoolingSp")]),
      eq("CHW_Plant", "chilledWaterPlant", "chilled water plant", [pt("CHW_Plant", "CHWS", "chwSupplyTemp")]),
      eq("CH_1", "chiller", "chiller", [pt("CH_1", "LWT", "leavingWaterTemp")], { partOf: `${P}/CHW_Plant` }),
      eq("CHWP_1", "pump", "pump", [pt("CHWP_1", "Speed", "pumpSpeed")], { partOf: `${P}/CHW_Plant` }),
      eq("HW_Plant", "hotWaterPlant", "hot water plant", [pt("HW_Plant", "HWS", "hwSupplyTemp")]),
      eq("B_9", "boiler", "boiler", [pt("B_9", "LWT", "leavingWaterTemp")])
    ]
  };
  const site = buildSite(review);
  assert.deepEqual(site.groups.map((g) => [g.title, g.by, g.side, g.members.map((m) => m.name)]), [["AHU_1", "serves", "air", ["VAV_1"]], ["CHW_Plant", "part", "water", ["CH_1", "CHWP_1"]], ["HW_Plant", "part", "water", []], ["boilers", "kind", "water", ["B_9"]]]);
  // A plant with no equipment of its own still gets a group, and each plant says what it sends water to:
  // those units keep their place under the air handler, and a guess is marked as one.
  const sent = (name) => site.groups.find((g) => g.title === name).water.map((w) => [w.medium, w.units.map((u) => u.name), w.guessed]);
  assert.deepEqual(sent("CHW_Plant"), [["chilledWater", ["AHU_1"], false]]);
  assert.deepEqual(sent("HW_Plant"), [["hotWater", ["AHU_1", "VAV_1"], true]]);
  // A boiler that belongs to no plant sits with others of its kind, and nothing is left in a strip above the map.
  assert.deepEqual(site.plant, []);
  const vav = site.units.find((u) => u.name === "VAV_1");
  assert.deepEqual([vav.band.low.name, vav.band.high.name, vav.setpoint?.name], ["Heat", "Cool", "Cool"]);
});

test("behaviour: what looks wrong in how the equipment runs, and nothing where it runs well", async () => {
  const { behaviourOf, reversals } = await import("../dist/behaviour.js");
  const pt = (unit, name, role, extra = {}) => ({ ord: `slot:/${unit}/${name}`, name, role, label: role, writable: false, ...extra });
  const unit = (name, kind, points, extra = {}) => ({ ord: `slot:/${name}`, name, kind, label: kind, points, zone: kind === "vav", wiring: "Net", wiringOrd: "slot:/Net", tagged: true, ...extra });
  const flat = (v, n = 24) => Array(n).fill(v);
  const wave = (mid, swing, n = 24) => Array.from({ length: n }, (_v, i) => mid + swing * Math.sin(i / 3));
  const zig = (low, high, n = 24) => Array.from({ length: n }, (_v, i) => (Math.floor(i / 2) % 2 ? high : low));

  // AHU_1: heating and cooling together, a hunting damper, and a fan commanded on that is not running.
  const a = { cool: pt("AHU_1", "ClgValve", "coolingValve", { writable: true }), heat: pt("AHU_1", "HtgValve", "heatingValve", { writable: true }), damper: pt("AHU_1", "OaDamper", "outsideDamper", { writable: true }),
    speed: pt("AHU_1", "SfSpeed", "supplyFanSpeed", { writable: true }), status: pt("AHU_1", "SfStatus", "supplyFanStatus"), sat: pt("AHU_1", "Sat", "supplyAirTemp", { unit: "°F" }) };
  // VAV_1: three degrees and more above its cooling setpoint for two hours, with a zone sensor that never moves.
  const v = { temp: pt("VAV_1", "ZoneTemp", "zoneTemp", { unit: "°F" }), low: pt("VAV_1", "HtgSp", "zoneHeatingSp"), high: pt("VAV_1", "ClgSp", "zoneCoolingSp"), rh: pt("VAV_1", "ZoneRh", "zoneHumidity") };
  // VAV_2 and AHU_2 run as they should.
  const w = { temp: pt("VAV_2", "ZoneTemp", "zoneTemp", { unit: "°F" }), sp: pt("VAV_2", "ZoneSp", "zoneTempSp"), damper: pt("VAV_2", "Damper", "damper", { writable: true }) };
  const b = { cool: pt("AHU_2", "ClgValve", "coolingValve", { writable: true }), heat: pt("AHU_2", "HtgValve", "heatingValve", { writable: true }), speed: pt("AHU_2", "SfSpeed", "supplyFanSpeed", { writable: true }), status: pt("AHU_2", "SfStatus", "supplyFanStatus") };
  const units = [
    unit("AHU_1", "ahu", Object.values(a), { headline: a.sat }),
    unit("VAV_1", "vav", Object.values(v), { headline: v.temp, band: { low: v.low, high: v.high } }),
    unit("VAV_2", "vav", Object.values(w), { headline: w.temp, setpoint: w.sp }),
    unit("AHU_2", "ahu", Object.values(b)),
    unit("Mystery", "unknown", [pt("Mystery", "X", "zoneTemp")])
  ];
  const now = { [a.cool.ord]: 62, [a.heat.ord]: 40, [a.damper.ord]: 50, [a.speed.ord]: 80, [a.status.ord]: false, [a.sat.ord]: 55, [v.temp.ord]: 78.1, [v.low.ord]: 70, [v.high.ord]: 74, [v.rh.ord]: 45,
    [w.temp.ord]: 72.4, [w.sp.ord]: 72, [w.damper.ord]: 40, [b.cool.ord]: 55, [b.heat.ord]: 0, [b.speed.ord]: 70, [b.status.ord]: true };
  const past = { [a.cool.ord]: flat(60), [a.heat.ord]: flat(38), [a.damper.ord]: zig(20, 70), [a.status.ord]: flat(0), [a.sat.ord]: wave(55, 2), [a.speed.ord]: flat(80),
    [v.temp.ord]: flat(78).map((x, i) => x + i * 0.01), [v.rh.ord]: flat(45), [w.temp.ord]: wave(72, 1), [w.damper.ord]: wave(40, 12), [b.cool.ord]: wave(55, 5), [b.heat.ord]: flat(0), [b.status.ord]: flat(1), [b.speed.ord]: wave(70, 3) };
  const result = await behaviourOf(units.filter((u) => u.kind !== "unknown"), { now: (ord) => now[ord], past: async (ord, _hours, buckets) => past[ord]?.slice(0, buckets) });
  const said = (kind) => result.findings.filter((f) => f.kind === kind).map((f) => `${f.where.slice(6)}: ${f.message}`);
  assert.deepEqual(said("heatAndCool"), ["AHU_1: heating and cooling together over the last hour: heatingValve 38%, coolingValve 60%"]);
  assert.deepEqual(said("hunting"), ["AHU_1: outsideDamper turned round 10 times in 2 hours, between 20% and 70%"]);
  assert.deepEqual(said("notFollowing"), ["AHU_1: supplyFanSpeed is 80% and supplyFanStatus is off"]);
  assert.equal(said("offSetpoint").length, 1);
  assert.match(said("offSetpoint")[0], /^VAV_1: zoneTemp 78\.\d has been 4\.\d above its setpoint \(74\) for most of the last 2 hours$/);
  assert.deepEqual(said("flatline"), ["VAV_1: zoneHumidity has read exactly 45 for the last 24 hours"]);
  assert.equal(result.findings.length, 5, "nothing is said about the units that run well");
  assert.deepEqual(result.looked, { heatAndCool: 2, offSetpoint: 2, hunting: 8, flatline: 4, notFollowing: 2 });

  // Points with no history are judged on what they read now, and only where that is enough.
  const blind = await behaviourOf(units.slice(0, 2), { now: (ord) => now[ord], past: async () => undefined });
  assert.deepEqual(blind.findings.map((f) => f.kind).sort(), ["heatAndCool", "notFollowing"]);
  assert.match(blind.findings.find((f) => f.kind === "heatAndCool").message, /together now/);

  assert.equal(reversals([0, 50, 0, 50, 0], 8), 3);
  assert.equal(reversals([40, 42, 41, 43, 42, 44], 8), 0, "small wobble is not hunting");
  assert.equal(reversals([0, 20, 40, 60, 80], 8), 0, "a steady ramp is not hunting");
});

test("check: the behaviour rules are part of the starter set, and a rule file can turn one off", async () => {
  const { STARTER_RULES } = await import("../dist/check-rules.js");
  assert.deepEqual(STARTER_RULES.filter((r) => r.group === "Behaviour").map((r) => [r.id, r.severity]), [["behaviour.heatAndCool", "warning"], ["behaviour.offSetpoint", "warning"], ["behaviour.hunting", "warning"], ["behaviour.notFollowing", "warning"], ["behaviour.flatline", "review"]]);
});

test("energy: kW points are found, the site meter comes first, and energy is worked out from the power history", async () => {
  const { energyOf, energyText, isKilowatts, readEnergy } = await import("../dist/energy.js");
  assert.ok(isKilowatts("units=kW|precision=0"));
  assert.ok(isKilowatts("units=u:kilowatt;kW;(m2)(kg)(s-3);*1000.0;|precision=i:1"));
  for (const not of ["units=kWh|precision=0", "units=kVA", "units=°F", "units=u:kilowatt hour;kWh", ""]) assert.ok(!isKilowatts(not), not);
  assert.equal(energyOf([{ at: 0, value: 100 }, { at: 1, value: 200 }], 15 * 60_000), 75);
  const now = new Date(2026, 5, 10, 12, 0, 0).getTime();
  const midnight = new Date(2026, 5, 10).getTime();
  const client = {
    capabilities: { station: "Test" },
    query: async () => ({ rows: [
      ["slot:/Drivers/Net/CH_1/points/Power", 190, "units=kW"], ["slot:/Drivers/Modbus/Meter_Main/points/Power", 300, "units=kW"],
      ["slot:/Drivers/Modbus/Meter_Main/points/EnergyToday", 4000, "units=kWh"], ["slot:/Drivers/Net/AHU_1/points/Sat", 55, "units=°F"], ["slot:/Drivers/Net/Fan/points/Power", 4.2, "units=kW"] ] }),
    historyRollup: async (ord, { start, end, interval }) => {
      if (/Fan/.test(ord)) throw Object.assign(new Error("no history"), { code: "history_failed" });
      const buckets = [];
      for (let t = start; t < end; t += interval) buckets.push({ start: t, count: 3, avg: (/Meter/.test(ord) ? 300 : 190) + (start < midnight ? -20 : 0) + (t === midnight + 9 * 3600_000 ? 60 : 0) });
      return { histories: [{ buckets }] };
    }
  };
  const result = await readEnergy(client, { now });
  assert.deepEqual(result.points.map((p) => [p.on, p.main]), [["Meter_Main", true], ["CH_1", false], ["Fan", false]]);
  const main = result.points[0];
  assert.equal(main.peak, 360);
  assert.equal(new Date(main.peakAt).getHours(), 9);
  assert.equal(Math.round(main.usedKwh), 300 * 12 + 15);
  assert.equal(Math.round(main.yesterdayKwh), 280 * 12);
  assert.equal(result.points[2].peak, undefined);
  const text = energyText(result).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /Meter_Main  site meter\s+Power\s+300 kW\s+360 kW at 9:0\d/);
  assert.match(text, /Fan\s+Power\s+4\.2 kW\s+no history/);
  assert.match(energyText({ station: "x", at: now, points: [], more: 0, notes: [] }), /No point on this station reads in kilowatts/);
});
