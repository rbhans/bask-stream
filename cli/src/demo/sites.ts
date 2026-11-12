// The buildings the demo station can be: each one fills in the tree, the alarms, a day of AI agent
// history, some files, and what keeps happening while it runs. The station itself (protocol, values,
// plans, jobs) is the same for all of them and lives in station.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type SiteName = "northgate" | "riverside" | "harbor" | "summit";

type Extra = Record<string, any>;

/** What a site gets to build with. The station fills it in as it starts. */
export interface SiteContext {
  add(parent: string, name: string, typeSpec: string, kind: "container" | "component" | "point" | "schedule", extra?: Extra): string;
  num(parent: string, name: string, units: string, sim: (t: number) => number, extra?: Extra): string;
  numW(parent: string, name: string, units: string, value: number, extra?: Extra): string;
  bool(parent: string, name: string, texts: [string, string], value: boolean, extra?: Extra): string;
  enumW(parent: string, name: string, options: string[], value: string, extra?: Extra): string;
  /** A device under a network (the BACnet one unless given); returns its points folder. */
  device(name: string, instance: number, address: string, extra?: Extra, network?: string): string;
  /** Another driver network under Drivers. */
  network(name: string, typeSpec: string): string;
  /** "AHU_01/SupplyAirTemp" as a point ORD on a network (the BACnet one unless given). */
  point(path: string, network?: string): string;
  /** The BACnet network's ORD. */
  net: string;
  nodes: Map<string, any>;
  schedules: string;
  weekdays(entries: any[], weekend?: any[]): Record<string, any[]>;
  wave(base: number, amp: number, periodMin: number, seed: number): (t: number) => number;
  outdoor(t: number): number;
  raise(source: string, message: string, o?: { cls?: string; priority?: number; state?: string; ago?: number; acked?: boolean }): any;
  propose(ord: string, action: string, value: unknown, reason: string, at?: number, minutes?: number): any;
  decide(proposal: any, status: string, by: string, at?: number, note?: string | null): void;
  agentRecord(at: number, user: string, target: string, action: string, fields: Record<string, unknown>): any;
  auditAdd(at: number, user: string, operation: string, target: string, slotName?: string, oldValue?: string, value?: string): void;
  file(path: string, text: string, hoursAgo?: number): void;
  who: Record<string, unknown>;
  agentUser: string;
  snapshot(ord: string): any;
  pushProposal(proposal: any): void;
  pushAlarm(alarm: any): void;
  pendingCount(): number;
  alarms: Map<string, any>;
  /** A time this many minutes ago. */
  past(minutesAgo: number): number;
}

export interface Site {
  key: SiteName;
  /** The station's name, as Niagara reports it. */
  station: string;
  /** What kind of place it is, for people choosing a demo. */
  title: string;
  port: number;
  /** The bask profile `bask demo` saves for it. */
  profile: string;
  /** Value limits the station applies to agents. */
  bounds: string[];
  /** Points to start the watch list with, as "Device/Point" on the BACnet network. */
  watch: string[];
  tree(c: SiteContext): void;
  alarms(c: SiteContext): void;
  /** A day of agent activity before the first live event. */
  history(c: SiteContext): void;
  files(c: SiteContext): void;
  /** What the agent does next, in turn, while the station runs. */
  agentMoves(c: SiteContext): (() => void)[];
  /** Alarms that come and go, in turn, while the station runs. */
  alarmMoves(c: SiteContext): (() => void)[];
}

const MIN = 60000;
const HOUR = 3600000;
const px = (title: string, ords: string[] = []) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<px version="1.0" media="workbench:WbPxMedia">\n<import>\n  <module name="bajaui"/>\n  <module name="kitPx"/>\n</import>\n<content>\n<CanvasPane name="content" viewSize="1280.0,720.0">\n  <Label layout="40,30,400,40" text="${title}"/>\n${ords.map((ord, i) => `  <BoundLabel layout="40,${90 + i * 40},220,30">\n    <BoundLabelBinding ord="station:|${ord}"/>\n  </BoundLabel>\n`).join("")}</CanvasPane>\n</content>\n</px>\n`;
const nav = (pages: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<nav version='1.0'>\n<node name='Home' ord='file:^px/Home.px' icon='module://icons/x16/home.png'>\n${pages.map((p) => `  <node name='${p.replace(/_/g, " ")}' ord='file:^px/${p}.px'/>\n`).join("")}</node>\n</nav>\n`;
/** An alarm raised on one turn and returned to normal on the next. */
const comesAndGoes = (c: SiteContext, source: string, message: string, normal: string, o: Parameters<SiteContext["raise"]>[2] = {}): (() => void)[] => [
  () => {
    // The same alarm goes off again rather than a second copy piling up beside the first.
    const again = [...c.alarms.values()].find((x) => x.sources[0] === source && x.message === normal);
    if (!again) return c.pushAlarm(c.raise(source, message, o));
    Object.assign(again, { sourceState: o.state ?? "offnormal", ackState: "unacked", timestamp: Date.now(), message, data: { ...again.data, msgText: message } });
    c.pushAlarm(again);
  },
  () => {
    const a = [...c.alarms.values()].find((x) => x.message === message);
    if (!a) return;
    Object.assign(a, { sourceState: "normal", message: normal, data: { ...a.data, msgText: normal } });
    c.pushAlarm(a);
  }
];

// ---- Northgate: an office building ----------------------------------------------------------------

const northgate: Site = {
  key: "northgate",
  station: "Northgate",
  title: "Northgate Office: two air handlers, eight VAV boxes, a chilled water plant",
  port: 47899,
  profile: "demo",
  bounds: ["*/ZoneSetpoint 65..78", "*/SupplyAirSetpoint 50..62"],
  watch: ["AHU_01/SupplyAirTemp", "AHU_01/SupplyFanSpeed", "AHU_01/OutdoorAirTemp", "VAV_101/ZoneTemp", "VAV_105/ZoneTemp", "VAV_105/ZoneSetpoint", "CHW_Plant/ChwSupplyTemp", "CHW_Plant/ChwFlow"],
  tree(c) {
    const { add, num, numW, bool, enumW, device, wave, outdoor, point, nodes, schedules, weekdays } = c;
    let seed = 1;
    for (const [i, ahu] of ["AHU_01", "AHU_02"].entries()) {
      const p = device(ahu, 1001 + i, `192.168.10.${11 + i}`, { tags: ["hs:ahu", "hs:equip"] });
      num(p, "SupplyAirTemp", "°F", wave(55, 1.4, 22 + i * 5, seed++));
      num(p, "ReturnAirTemp", "°F", wave(74, 0.9, 45, seed++));
      num(p, "MixedAirTemp", "°F", wave(63, 2.6, 35, seed++));
      num(p, "OutdoorAirTemp", "°F", outdoor);
      numW(p, "SupplyAirSetpoint", "°F", 55);
      numW(p, "SupplyFanSpeed", "%", 70, { sim: wave(72 - i * 6, 7, 28, seed++) });
      bool(p, "SupplyFanStatus", ["On", "Off"], true);
      num(p, "DuctStaticPressure", "inH₂O", wave(1.5, 0.14, 12, seed++), { precision: 2 });
      numW(p, "CoolingValve", "%", 35, { sim: wave(38 + i * 9, 18, 40, seed++) });
      num(p, "FilterDP", "inH₂O", wave(0.82 + i * 0.5, 0.04, 90, seed++), { precision: 2 });
      bool(p, "OccupiedCmd", ["Occupied", "Unoccupied"], true, { writable: true });
    }
    for (let i = 1; i <= 8; i += 1) {
      const hot = i === 5;
      const p = device(`VAV_10${i}`, 2000 + i, `MSTP 2:${10 + i}`, { down: i === 7, tags: ["hs:vav", "hs:equip"] });
      num(p, "ZoneTemp", "°F", wave(hot ? 78.6 : 72 + (i % 3) * 0.6, hot ? 0.5 : 1.1, 30 + i * 3, seed++), { alarm: hot });
      numW(p, "ZoneSetpoint", "°F", 72);
      num(p, "Airflow", "cfm", wave(420 + i * 25, 130, 18 + i, seed++), { precision: 0 });
      numW(p, "DamperPosition", "%", 45, { sim: wave(48, 20, 18 + i, seed++), precision: 0 });
      numW(p, "ReheatValve", "%", 0, { sim: (t: number) => Math.max(0, wave(4, 14, 50, 40 + i)(t)), precision: 0 });
      enumW(p, "OccupancyMode", ["occupied", "unoccupied", "standby"], i === 6 ? "standby" : "occupied");
    }
    {
      const p = device("CHW_Plant", 3001, "192.168.10.30", { tags: ["hs:chilledWaterPlant", "hs:equip"] });
      num(p, "ChwSupplyTemp", "°F", wave(44, 0.5, 26, seed++));
      num(p, "ChwReturnTemp", "°F", wave(54.5, 1.1, 38, seed++));
      num(p, "ChwFlow", "gpm", wave(410, 55, 33, seed++), { precision: 0 });
      numW(p, "ChwSupplySetpoint", "°F", 44);
      numW(p, "ChwPump1Speed", "%", 65, { sim: wave(64, 9, 33, seed++), precision: 0 });
      bool(p, "Chiller1Status", ["Running", "Off"], true);
      bool(p, "Chiller2Status", ["Running", "Off"], false, { fault: true });
      bool(p, "PlantEnable", ["Enabled", "Disabled"], true, { writable: true });
    }
    nodes.get(point("AHU_02/SupplyFanSpeed"))!.override = { value: 85 };

    add(schedules, "OfficeHours", "schedule:BooleanSchedule", "schedule", {
      defaultOutput: { value: false, text: "Unoccupied" },
      week: weekdays([{ start: "06:30", finish: "18:00", value: true, text: "Occupied" }], [{ start: "08:00", finish: "13:00", value: true, text: "Occupied" }])
    });
    add(schedules, "ZoneSetback", "schedule:NumericSchedule", "schedule", {
      defaultOutput: { value: 78, text: "78.0 °F" },
      week: weekdays([{ start: "06:00", finish: "08:00", value: 74, text: "74.0 °F" }, { start: "08:00", finish: "18:00", value: 72, text: "72.0 °F" }, { start: "18:00", finish: "21:00", value: 75, text: "75.0 °F" }])
    });
    add(schedules, "LobbyLighting", "schedule:EnumSchedule", "schedule", {
      defaultOutput: { value: "off", text: "Off" },
      week: weekdays([{ start: "05:30", finish: "07:00", value: "dim", text: "Dim" }, { start: "07:00", finish: "19:00", value: "on", text: "On" }, { start: "19:00", finish: "23:00", value: "dim", text: "Dim" }], [{ start: "08:00", finish: "20:00", value: "dim", text: "Dim" }])
    });
  },
  alarms({ raise, point, net }) {
    raise(point("VAV_105/ZoneTemp"), "Zone temperature high: 78.6 °F (limit 76.0 °F)", { cls: "critical", priority: 40, ago: 14 * MIN });
    raise(`${net}/VAV_107`, "Device down: no response to ping", { cls: "critical", priority: 30, state: "fault", ago: 23 * MIN });
    raise(point("CHW_Plant/Chiller2Status"), "Chiller 2 failed to start", { cls: "critical", priority: 20, state: "fault", ago: 2 * HOUR, acked: true });
    raise(point("AHU_02/FilterDP"), "Filter differential pressure high: change filters", { cls: "maintenance", priority: 180, ago: 5 * HOUR });
    raise(point("AHU_01/DuctStaticPressure"), "Duct static pressure returned to normal", { priority: 120, state: "normal", ago: 49 * MIN });
    raise(point("VAV_103/Airflow"), "Airflow below minimum for 10 minutes", { priority: 110, ago: 3 * HOUR, acked: true });
    raise(point("AHU_02/SupplyFanSpeed"), "Point overridden for more than 8 hours", { cls: "maintenance", priority: 200, state: "alert", ago: 8 * HOUR });
  },
  history({ propose, decide, auditAdd, agentRecord, point, who, agentUser, past }) {
    let p = propose(point("VAV_102/ZoneSetpoint"), "override", 71, "Room 102 has read 74.9 °F for 40 minutes against a 72 °F setpoint; lowering 1 °F while the afternoon load passes.", past(1310), 60);
    decide(p, "approved", "admin", past(1306));
    auditAdd(past(1306), "admin", "Invoked", "/Drivers/BacnetNetwork/VAV_102/points/ZoneSetpoint", "override", "", "71.0 °F, 60 min");
    agentRecord(past(1190), agentUser, "slot:/Drivers/BacnetNetwork/AHU_01", "write_tags", { outcome: "completed", ...who, change: "add hs:ahu, hs:equip, hs:siteRef", reason: "Tagging AHU-01 so the Air Systems hierarchy picks it up, as asked." });
    auditAdd(past(1190), agentUser, "Added", "/Drivers/BacnetNetwork/AHU_01", "hs$3aahu", "", "M");
    p = propose(point("AHU_01/SupplyAirSetpoint"), "override", 58, "Outdoor air is 52 °F and all zones are satisfied; raising supply air 3 °F saves cooling energy.", past(960), 120);
    decide(p, "rejected", "admin", past(951), "Leave SAT alone until the economizer is fixed.");
    agentRecord(past(700), agentUser, point("VAV_104/ZoneSetpoint"), "override", { outcome: "refused", code: "agent_value_out_of_bounds", ...who, change: "override 82.0 °F", reason: "Occupant asked for a much warmer room." });
    agentRecord(past(420), agentUser, "slot:/Drivers/BacnetNetwork/VAV_108", "apply_model_changes", { outcome: "completed", ...who, change: "rename point ZnTmp → ZoneTemp", reason: "Point name did not match the other VAV boxes; renamed to keep queries and graphics consistent." });
    auditAdd(past(420), agentUser, "Renamed", "/Drivers/BacnetNetwork/VAV_108/points", "ZnTmp", "ZnTmp", "ZoneTemp");
    p = propose(point("CHW_Plant/ChwSupplySetpoint"), "override", 45, "Plant load is under 40%; a 1 °F reset on chilled water supply reduces chiller lift.", past(250), 180);
    decide(p, "approved", "admin", past(247));
    auditAdd(past(247), "admin", "Invoked", "/Drivers/BacnetNetwork/CHW_Plant/points/ChwSupplySetpoint", "override", "", "45.0 °F, 180 min");
    agentRecord(past(95), agentUser, "file:^notes/commissioning.md", "write_file", { outcome: "completed", ...who, change: "write 1.4 KB", reason: "Saved today's commissioning notes for VAV 105 and 107." });
    auditAdd(past(95), agentUser, "file_write", "file:^notes/commissioning.md", "", "", "1432 bytes");
    p = propose(point("VAV_106/OccupancyMode"), "set", "occupied", "Room 106 is booked 3 to 5 pm today but the box is in standby.", past(61));
    decide(p, "expired", "", past(46));
    agentRecord(past(18), agentUser, point("AHU_02/SupplyFanSpeed"), "override", { outcome: "refused", code: "agent_rate_limited", ...who, change: "override 60.0 %", reason: "Trimming fan speed after hours." });
    propose(point("VAV_105/ZoneSetpoint"), "override", 70, "Room 105 is in high-temperature alarm at 78.6 °F; lowering the setpoint 2 °F for 30 minutes to drive more air.", past(3), 30);
    auditAdd(past(380), "admin", "Changed", "/Services/AlarmService/critical", "priority", "40", "30");
    auditAdd(past(140), "admin", "Login", "/Services/WebService", "", "", "192.168.0.125");
  },
  files({ file }) {
    file("^px/Home.px", '<?xml version="1.0" encoding="UTF-8"?>\n<px version="1.0" media="workbench:WbPxMedia">\n<import>\n  <module name="bajaui"/>\n  <module name="kitPx"/>\n</import>\n<content>\n<CanvasPane name="content" viewSize="1280.0,720.0">\n  <Label layout="40,30,400,40" text="Northgate Office"/>\n  <BoundLabel layout="40,90,220,30">\n    <BoundLabelBinding ord="station:|slot:/Drivers/BacnetNetwork/AHU_01/points/SupplyAirTemp"/>\n  </BoundLabel>\n</CanvasPane>\n</content>\n</px>\n', 200);
    file("^px/AHU_01.px", '<?xml version="1.0" encoding="UTF-8"?>\n<px version="1.0" media="workbench:WbPxMedia">\n<content>\n<CanvasPane name="content" viewSize="1280.0,720.0"/>\n</content>\n</px>\n', 96);
    file("^px/VAV_Template.px", '<?xml version="1.0" encoding="UTF-8"?>\n<px version="1.0" media="workbench:WbPxMedia">\n<content>\n<CanvasPane name="content" viewSize="800.0,600.0"/>\n</content>\n</px>\n', 400);
    file("^nav/NavFile.nav", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<nav version='1.0'>\n<node name='Home' ord='file:^px/Home.px' icon='module://icons/x16/home.png'>\n  <node name='AHU 01' ord='file:^px/AHU_01.px'/>\n</node>\n</nav>\n", 96);
    file("^notes/commissioning.md", "# Commissioning notes\n\n## VAV 105\n- Zone temp 78.6 °F against a 72 °F setpoint, damper at 100%.\n- Airflow reads 310 cfm against a 620 cfm maximum: check the flow ring and the box inlet.\n\n## VAV 107\n- Device down since 1:41 pm. MS/TP trunk 2, address 17.\n- Controller power LED is off; ticket opened with the electrician.\n", 1.6);
    file("^config/points.csv", "equipment,point,type,units\nAHU_01,SupplyAirTemp,AI,degF\nAHU_01,SupplyFanSpeed,AO,%\nVAV_101,ZoneTemp,AI,degF\nVAV_101,ZoneSetpoint,AV,degF\n", 700);
    file("^images/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#7aa2f7"/></svg>\n', 900);
  },
  agentMoves(c) {
    const { pendingCount, snapshot, point, pushProposal, propose, net, agentRecord, agentUser, who, auditAdd } = c;
    const zone = (i: number) => point(`VAV_10${i}/ZoneSetpoint`);
    return [
      () => {
        if (pendingCount() >= 2) return;
        const i = 1 + Math.floor(Math.random() * 4);
        const temp = snapshot(point(`VAV_10${i}/ZoneTemp`)).displayValue;
        pushProposal(propose(zone(i), "override", 71, `Room 10${i} reads ${temp} and has been above setpoint for 20 minutes; lowering 1 °F for 30 minutes.`, Date.now(), 30));
      },
      () => {
        const ord = `${net}/VAV_10${1 + Math.floor(Math.random() * 6)}`;
        agentRecord(Date.now(), agentUser, ord, "write_tags", { outcome: "completed", ...who, change: "add hs:vav, hs:airRef", reason: "Linking the box to its air handler so the Air Systems hierarchy groups it." });
        auditAdd(Date.now(), agentUser, "Added", ord.replace(/^slot:/, ""), "hs$3aairRef", "", "h:2c45e");
      },
      () => agentRecord(Date.now(), agentUser, zone(3), "override", { outcome: "refused", code: "agent_value_out_of_bounds", ...who, change: "override 80.0 °F", reason: "Occupant asked for 80 °F; outside the 65 to 78 °F limit set for agents." }),
      () => {
        if (pendingCount() >= 2) return;
        pushProposal(propose(point("AHU_01/SupplyAirSetpoint"), "override", 56, "Outdoor air has cooled and every zone damper is under 60% open; a 1 °F supply air reset trims cooling.", Date.now(), 60));
      },
      () => {
        agentRecord(Date.now(), agentUser, "file:^notes/commissioning.md", "write_file", { outcome: "completed", ...who, change: "write 1.6 KB", reason: "Added the latest VAV 105 airflow readings to the commissioning notes." });
        auditAdd(Date.now(), agentUser, "file_write", "file:^notes/commissioning.md", "", "", "1611 bytes");
      }
    ];
  },
  alarmMoves(c) {
    const { raise, point, pushAlarm } = c;
    return [
      ...comesAndGoes(c, point("VAV_102/ZoneTemp"), "Zone temperature high: 76.4 °F (limit 76.0 °F)", "Zone temperature returned to normal", { priority: 100 }),
      () => pushAlarm(raise(point("CHW_Plant/ChwFlow"), "Chilled water flow low: 352 gpm", { cls: "maintenance", priority: 150, state: "alert" })),
      () => pushAlarm(raise(point("AHU_01/MixedAirTemp"), "Mixed air temperature low: freeze protection warning", { cls: "critical", priority: 25 }))
    ];
  }
};

// ---- Riverside: a surgery center ------------------------------------------------------------------

const riverside: Site = {
  key: "riverside",
  station: "Riverside",
  title: "Riverside Surgery Center: operating rooms, isolation rooms, a boiler plant, medical gas",
  port: 47900,
  profile: "demo-riverside",
  bounds: ["*/RoomTempSetpoint 62..72", "*/HwSupplySetpoint 140..180", "ISO_*/* locked"],
  watch: ["OR_1/RoomTemp", "OR_2/RoomHumidity", "OR_1/RoomPressure", "ISO_201/RoomPressure", "ISO_202/RoomPressure", "AHU_OR/SupplyAirHumidity", "HW_Plant/HwSupplyTemp", "MedGas/OxygenPressure"],
  tree(c) {
    const { add, num, numW, bool, device, wave, schedules, weekdays } = c;
    let seed = 11;
    for (const [i, ahu] of ["AHU_OR", "AHU_Patient"].entries()) {
      const p = device(ahu, 1101 + i, `10.20.1.${21 + i}`, { tags: ["hs:ahu", "hs:equip"] });
      num(p, "SupplyAirTemp", "°F", wave(i ? 56 : 62, 0.8, 24, seed++));
      num(p, "SupplyAirHumidity", "%RH", wave(i ? 50 : 46, 3.5, 40, seed++));
      num(p, "ReturnAirTemp", "°F", wave(70, 0.7, 45, seed++));
      numW(p, "SupplyAirSetpoint", "°F", i ? 56 : 62);
      numW(p, "SupplyFanSpeed", "%", 80, { sim: wave(82 - i * 12, 4, 30, seed++) });
      numW(p, "HumidifierValve", "%", 20, { sim: (t: number) => Math.max(0, wave(22, 16, 36, 60 + i)(t)), precision: 0 });
      num(p, "HepaFilterDP", "inH₂O", wave(i ? 0.9 : 1.62, 0.05, 90, seed++), { precision: 2, alarm: !i });
      bool(p, "SupplyFanStatus", ["On", "Off"], true);
    }
    for (let i = 1; i <= 3; i += 1) {
      const humid = i === 2;
      const p = device(`OR_${i}`, 2100 + i, `MSTP 1:${20 + i}`, { tags: ["hs:room", "hs:equip"] });
      num(p, "RoomTemp", "°F", wave(66 + i * 0.3, 0.6, 28 + i * 4, seed++));
      num(p, "RoomHumidity", "%RH", wave(humid ? 63 : 47, humid ? 1.5 : 4, 33, seed++), { alarm: humid });
      num(p, "RoomPressure", "inH₂O", wave(0.031, 0.004, 14, seed++), { precision: 3 });
      num(p, "AirChanges", "ACH", wave(22, 1.2, 20, seed++));
      numW(p, "RoomTempSetpoint", "°F", 66);
      bool(p, "InUse", ["In use", "Idle"], i !== 3);
    }
    for (let i = 1; i <= 2; i += 1) {
      const weak = i === 2;
      const p = device(`ISO_20${i}`, 2200 + i, `MSTP 1:${40 + i}`, { tags: ["hs:room", "hs:equip"] });
      num(p, "RoomPressure", "inH₂O", wave(weak ? -0.002 : -0.012, weak ? 0.001 : 0.002, 12, seed++), { precision: 3, alarm: weak });
      num(p, "ExhaustFlow", "cfm", wave(weak ? 210 : 340, 14, 18, seed++), { precision: 0 });
      bool(p, "DoorStatus", ["Open", "Closed"], false);
      bool(p, "Occupied", ["Patient", "Empty"], true);
    }
    {
      const p = device("Pharmacy_Fridge", 2301, "MSTP 1:50", { tags: ["hs:equip"] });
      num(p, "BoxTemp", "°F", wave(38, 0.9, 16, seed++));
      bool(p, "DoorStatus", ["Open", "Closed"], false);
    }
    {
      const p = device("HW_Plant", 3101, "10.20.1.40", { tags: ["hs:hotWaterPlant", "hs:equip"] });
      num(p, "HwSupplyTemp", "°F", wave(160, 2.5, 30, seed++));
      num(p, "HwReturnTemp", "°F", wave(141, 3, 42, seed++));
      numW(p, "HwSupplySetpoint", "°F", 160);
      numW(p, "HwPump1Speed", "%", 60, { sim: wave(58, 8, 33, seed++), precision: 0 });
      bool(p, "Boiler1Status", ["Firing", "Off"], true);
      bool(p, "Boiler2Status", ["Firing", "Off"], false, { fault: true });
      bool(p, "PlantEnable", ["Enabled", "Disabled"], true, { writable: true });
    }
    {
      const p = device("MedGas", 3201, "10.20.1.60", { tags: ["hs:equip"] });
      num(p, "OxygenPressure", "psi", wave(52, 0.8, 22, seed++));
      num(p, "MedAirPressure", "psi", wave(55, 0.9, 26, seed++));
      num(p, "VacuumLevel", "inHg", wave(19.2, 0.4, 31, seed++));
      bool(p, "MasterAlarm", ["Alarm", "Normal"], false);
    }
    add(schedules, "SurgeryHours", "schedule:BooleanSchedule", "schedule", {
      defaultOutput: { value: false, text: "Setback" },
      week: weekdays([{ start: "05:30", finish: "19:00", value: true, text: "Surgery" }], [{ start: "07:00", finish: "12:00", value: true, text: "Surgery" }])
    });
    add(schedules, "PatientWingSetpoint", "schedule:NumericSchedule", "schedule", {
      defaultOutput: { value: 72, text: "72.0 °F" },
      week: weekdays([{ start: "06:00", finish: "21:00", value: 71, text: "71.0 °F" }], [{ start: "07:00", finish: "21:00", value: 71, text: "71.0 °F" }])
    });
  },
  alarms({ raise, point }) {
    raise(point("ISO_202/RoomPressure"), "Isolation room pressure low: -0.002 inH₂O (limit -0.008)", { cls: "lifeSafety", priority: 10, ago: 6 * MIN });
    raise(point("OR_2/RoomHumidity"), "Operating room humidity high: 63 %RH (limit 60)", { cls: "critical", priority: 30, ago: 31 * MIN });
    raise(point("HW_Plant/Boiler2Status"), "Boiler 2 lockout: flame failure", { cls: "critical", priority: 25, state: "fault", ago: 4 * HOUR, acked: true });
    raise(point("AHU_OR/HepaFilterDP"), "HEPA filter pressure drop high: schedule a change", { cls: "maintenance", priority: 170, ago: 9 * HOUR });
    raise(point("Pharmacy_Fridge/DoorStatus"), "Pharmacy refrigerator door closed", { priority: 90, state: "normal", ago: 52 * MIN });
    raise(point("ISO_201/DoorStatus"), "Isolation room door held open over 60 s", { cls: "critical", priority: 60, state: "alert", ago: 2 * HOUR, acked: true });
  },
  history({ propose, decide, auditAdd, agentRecord, point, who, agentUser, past }) {
    let p = propose(point("AHU_OR/HumidifierValve"), "override", 10, "OR 2 humidity has been above 60 %RH for 20 minutes; cutting the humidifier to 10% for an hour.", past(1280), 60);
    decide(p, "approved", "admin", past(1277));
    auditAdd(past(1277), "admin", "Invoked", "/Drivers/BacnetNetwork/AHU_OR/points/HumidifierValve", "override", "", "10 %, 60 min");
    agentRecord(past(1100), agentUser, point("ISO_201/RoomPressure"), "override", { outcome: "refused", code: "agent_value_out_of_bounds", ...who, change: "override -0.004 inH₂O", reason: "Tried to relax the isolation pressure setpoint to quiet a nuisance alarm." });
    agentRecord(past(840), agentUser, "slot:/Drivers/BacnetNetwork/OR_3", "write_tags", { outcome: "completed", ...who, change: "add hs:room, hs:spaceRef", reason: "Tagging OR 3 so the Surgery hierarchy lists all three operating rooms." });
    auditAdd(past(840), agentUser, "Added", "/Drivers/BacnetNetwork/OR_3", "hs$3aspaceRef", "", "h:31a0c");
    p = propose(point("HW_Plant/HwSupplySetpoint"), "override", 150, "Outdoor air is mild and reheat valves average 12% open; a 10 °F hot water reset saves gas.", past(610), 240);
    decide(p, "rejected", "charge.nurse", past(600), "Keep 160 °F while Boiler 2 is locked out.");
    p = propose(point("OR_1/RoomTempSetpoint"), "override", 64, "Surgeon asked for a cooler room for the 2 pm orthopedic case.", past(300), 180);
    decide(p, "approved", "admin", past(298));
    auditAdd(past(298), "admin", "Invoked", "/Drivers/BacnetNetwork/OR_1/points/RoomTempSetpoint", "override", "", "64.0 °F, 180 min");
    agentRecord(past(120), agentUser, "file:^notes/iso-202.md", "write_file", { outcome: "completed", ...who, change: "write 0.9 KB", reason: "Logged the isolation room 202 pressure readings for infection control." });
    auditAdd(past(120), agentUser, "file_write", "file:^notes/iso-202.md", "", "", "934 bytes");
    propose(point("AHU_OR/SupplyFanSpeed"), "override", 88, "Isolation room 202 is losing negative pressure; more supply and exhaust air restores the offset while the exhaust fan is checked.", past(4), 30);
    auditAdd(past(200), "charge.nurse", "Login", "/Services/WebService", "", "", "10.20.4.18");
  },
  files({ file }) {
    file("^px/Home.px", px("Riverside Surgery Center", ["slot:/Drivers/BacnetNetwork/OR_1/points/RoomTemp"]), 300);
    file("^px/OR_Suite.px", px("Operating rooms", ["slot:/Drivers/BacnetNetwork/OR_1/points/RoomPressure", "slot:/Drivers/BacnetNetwork/OR_2/points/RoomHumidity"]), 120);
    file("^px/Isolation.px", px("Isolation rooms", ["slot:/Drivers/BacnetNetwork/ISO_202/points/RoomPressure"]), 60);
    file("^nav/NavFile.nav", nav(["OR_Suite", "Isolation"]), 60);
    file("^notes/iso-202.md", "# Isolation room 202\n\n- 1:52 pm: pressure -0.002 inH₂O, door closed. Limit is -0.008.\n- Exhaust flow 210 cfm against 340 cfm design: exhaust fan belt suspected.\n- Infection control notified at 1:55 pm.\n", 2);
    file("^config/pressure-limits.csv", "room,type,limit_inH2O\nOR_1,positive,0.020\nOR_2,positive,0.020\nISO_201,negative,-0.008\nISO_202,negative,-0.008\n", 800);
  },
  agentMoves(c) {
    const { pendingCount, snapshot, point, pushProposal, propose, net, agentRecord, agentUser, who, auditAdd } = c;
    return [
      () => {
        if (pendingCount() >= 2) return;
        pushProposal(propose(point("AHU_OR/HumidifierValve"), "override", 8, `OR 2 reads ${snapshot(point("OR_2/RoomHumidity")).displayValue}; holding the humidifier at 8% for 30 minutes.`, Date.now(), 30));
      },
      () => {
        agentRecord(Date.now(), agentUser, `${net}/OR_2`, "write_tags", { outcome: "completed", ...who, change: "add hs:humidity limit note", reason: "Recording the 60 %RH limit on OR 2 so reports can flag it." });
        auditAdd(Date.now(), agentUser, "Added", "/Drivers/BacnetNetwork/OR_2", "limitNote", "", "60 %RH");
      },
      () => agentRecord(Date.now(), agentUser, point("ISO_202/ExhaustFlow"), "override", { outcome: "refused", code: "agent_value_out_of_bounds", ...who, change: "override 400 cfm", reason: "Isolation room points are locked to agents; asking a person instead." }),
      () => {
        if (pendingCount() >= 2) return;
        pushProposal(propose(point("OR_3/RoomTempSetpoint"), "override", 68, "OR 3 is idle until tomorrow; raising its setpoint 2 °F saves reheat.", Date.now(), 240));
      }
    ];
  },
  alarmMoves(c) {
    const { raise, point, pushAlarm } = c;
    return [
      ...comesAndGoes(c, point("Pharmacy_Fridge/BoxTemp"), "Pharmacy refrigerator warm: 42.6 °F (limit 41)", "Pharmacy refrigerator back in range", { cls: "critical", priority: 45 }),
      () => pushAlarm(raise(point("MedGas/VacuumLevel"), "Medical vacuum low: 17.8 inHg", { cls: "lifeSafety", priority: 15, state: "alert" })),
      ...comesAndGoes(c, point("OR_1/RoomPressure"), "Operating room pressure low: door open", "Operating room pressure restored", { cls: "critical", priority: 35 })
    ];
  }
};

// ---- Harbor: a cold storage warehouse -------------------------------------------------------------

const harbor: Site = {
  key: "harbor",
  station: "Harbor",
  title: "Harbor Cold Storage: freezers, coolers, a compressor rack, dock doors, power meters",
  port: 47901,
  profile: "demo-harbor",
  bounds: ["Freezer_*/BoxSetpoint -20..0", "Cooler_*/BoxSetpoint 33..40"],
  watch: ["Freezer_1/BoxTemp", "Freezer_2/BoxTemp", "Freezer_3/BoxTemp", "Cooler_1/BoxTemp", "Rack_A/SuctionPressure", "Rack_A/DischargePressure", "Dock/AmmoniaLevel", "Dock/DockTemp"],
  tree(c) {
    const { add, num, numW, bool, enumW, device, network, wave, outdoor, schedules, weekdays } = c;
    let seed = 21;
    for (let i = 1; i <= 4; i += 1) {
      const warm = i === 2;
      const p = device(`Freezer_${i}`, 5000 + i, `10.40.2.${10 + i}`, { tags: ["hs:freezer", "hs:equip"] });
      num(p, "BoxTemp", "°F", wave(warm ? 4.2 : -10 + i * 0.4, warm ? 0.6 : 1.3, 26 + i * 3, seed++), { alarm: warm });
      numW(p, "BoxSetpoint", "°F", -10);
      num(p, "CoilTemp", "°F", wave(-22, 2.5, 22, seed++));
      bool(p, "DefrostActive", ["Defrost", "Cooling"], i === 4);
      bool(p, "EvapFanStatus", ["On", "Off"], i !== 4);
      bool(p, "DoorStatus", ["Open", "Closed"], false);
    }
    for (let i = 1; i <= 2; i += 1) {
      const p = device(`Cooler_${i}`, 5100 + i, `10.40.2.${30 + i}`, { tags: ["hs:cooler", "hs:equip"] });
      num(p, "BoxTemp", "°F", wave(36 + (i === 1 ? 2.4 : 0), 0.9, 24 + i * 5, seed++));
      numW(p, "BoxSetpoint", "°F", 36);
      num(p, "Humidity", "%RH", wave(84, 4, 38, seed++));
      bool(p, "DoorStatus", ["Open", "Closed"], i === 1);
    }
    {
      const p = device("Rack_A", 5201, "10.40.2.50", { tags: ["hs:compressor", "hs:equip"] });
      num(p, "SuctionPressure", "psi", wave(18, 1.8, 16, seed++));
      num(p, "DischargePressure", "psi", wave(188, 9, 21, seed++), { precision: 0 });
      num(p, "OilPressure", "psi", wave(46, 2, 28, seed++));
      bool(p, "Compressor1Status", ["Running", "Off"], true);
      bool(p, "Compressor2Status", ["Running", "Off"], true);
      bool(p, "Compressor3Status", ["Running", "Off"], false, { fault: true });
      numW(p, "CondenserFanSpeed", "%", 70, { sim: wave(72, 12, 30, seed++), precision: 0 });
      enumW(p, "RackMode", ["auto", "manual", "pumpDown"], "auto");
    }
    {
      const p = device("Dock", 5301, "10.40.2.60", { tags: ["hs:equip"] });
      num(p, "DockTemp", "°F", (t: number) => 0.35 * outdoor(t) + 24);
      const ammonia = wave(2.2, 1.4, 19, seed++);
      num(p, "AmmoniaLevel", "ppm", (t: number) => Math.max(0, ammonia(t)));
      for (let d = 1; d <= 3; d += 1) bool(p, `Door${d}Status`, ["Open", "Closed"], d === 2);
    }
    const modbus = network("ModbusNetwork", "modbusTcp:ModbusTcpNetwork");
    {
      const p = device("Meter_Main", 1, "10.40.2.200:502", { typeSpec: "modbusTcp:ModbusTcpDevice", tags: ["hs:meter", "hs:equip"] }, modbus);
      num(p, "Power", "kW", wave(312, 38, 34, seed++), { precision: 0 });
      num(p, "Current", "A", wave(430, 50, 34, seed++), { precision: 0 });
      num(p, "PowerFactor", "", wave(0.93, 0.02, 50, seed++), { precision: 2 });
      num(p, "EnergyToday", "kWh", (t: number) => {
        const d = new Date(t);
        return (d.getHours() + d.getMinutes() / 60) * 305;
      }, { precision: 0 });
    }
    add(schedules, "DefrostCycle", "schedule:BooleanSchedule", "schedule", {
      defaultOutput: { value: false, text: "Cooling" },
      week: weekdays([{ start: "02:00", finish: "02:25", value: true, text: "Defrost" }, { start: "08:00", finish: "08:25", value: true, text: "Defrost" }, { start: "14:00", finish: "14:25", value: true, text: "Defrost" }, { start: "20:00", finish: "20:25", value: true, text: "Defrost" }], [{ start: "02:00", finish: "02:25", value: true, text: "Defrost" }, { start: "14:00", finish: "14:25", value: true, text: "Defrost" }])
    });
    add(schedules, "DockHours", "schedule:BooleanSchedule", "schedule", {
      defaultOutput: { value: false, text: "Closed" },
      week: weekdays([{ start: "04:00", finish: "20:00", value: true, text: "Receiving" }], [{ start: "06:00", finish: "12:00", value: true, text: "Receiving" }])
    });
  },
  alarms({ raise, point }) {
    raise(point("Freezer_2/BoxTemp"), "Freezer 2 box temperature high: 4.2 °F (limit 0.0 °F)", { cls: "critical", priority: 20, ago: 9 * MIN });
    raise(point("Rack_A/Compressor3Status"), "Compressor 3 tripped on oil pressure", { cls: "critical", priority: 25, state: "fault", ago: 38 * MIN });
    raise(point("Cooler_1/DoorStatus"), "Cooler 1 door open for 14 minutes", { priority: 80, state: "alert", ago: 14 * MIN });
    raise(point("Dock/AmmoniaLevel"), "Ammonia level returned to normal", { cls: "lifeSafety", priority: 10, state: "normal", ago: 3 * HOUR });
    raise(point("Rack_A/DischargePressure"), "Discharge pressure high: 214 psi", { cls: "critical", priority: 40, ago: 6 * HOUR, acked: true });
    raise(point("Freezer_4/DefrostActive"), "Defrost running longer than 30 minutes", { cls: "maintenance", priority: 150, state: "alert", ago: 41 * MIN });
  },
  history({ propose, decide, auditAdd, agentRecord, point, who, agentUser, past }) {
    let p = propose(point("Rack_A/CondenserFanSpeed"), "override", 90, "Discharge pressure is at 214 psi with 88 °F outdoor air; running the condenser fans at 90% brings it down.", past(365), 120);
    decide(p, "approved", "night.shift", past(362));
    auditAdd(past(362), "night.shift", "Invoked", "/Drivers/BacnetNetwork/Rack_A/points/CondenserFanSpeed", "override", "", "90 %, 120 min");
    agentRecord(past(900), agentUser, point("Freezer_1/BoxSetpoint"), "override", { outcome: "refused", code: "agent_value_out_of_bounds", ...who, change: "override 10.0 °F", reason: "A picker asked for a warmer freezer while restocking." });
    agentRecord(past(760), agentUser, "slot:/Drivers/ModbusNetwork/Meter_Main", "write_tags", { outcome: "completed", ...who, change: "add hs:meter, hs:elec, hs:siteMeter", reason: "Tagging the main meter so energy reports find it." });
    auditAdd(past(760), agentUser, "Added", "/Drivers/ModbusNetwork/Meter_Main", "hs$3asiteMeter", "", "M");
    p = propose(point("Freezer_3/BoxSetpoint"), "override", -14, "Freezer 3 gets a full ice cream delivery at 6 am; pre-cooling 4 °F overnight uses cheaper power.", past(520), 360);
    decide(p, "approved", "admin", past(515));
    auditAdd(past(515), "admin", "Invoked", "/Drivers/BacnetNetwork/Freezer_3/points/BoxSetpoint", "override", "", "-14.0 °F, 360 min");
    p = propose(point("Rack_A/RackMode"), "set", "pumpDown", "Compressor 3 tripped; pumping the rack down before the technician opens it.", past(36));
    decide(p, "rejected", "admin", past(33), "Not while Freezer 2 is warm. Leave it in auto.");
    agentRecord(past(75), agentUser, "file:^notes/freezer-2.md", "write_file", { outcome: "completed", ...who, change: "write 0.7 KB", reason: "Started a temperature log for Freezer 2 for the food safety record." });
    auditAdd(past(75), agentUser, "file_write", "file:^notes/freezer-2.md", "", "", "702 bytes");
    propose(point("Freezer_2/BoxSetpoint"), "override", -14, "Freezer 2 is at 4.2 °F and rising; a lower setpoint keeps both remaining compressors on it until the door seal is checked.", past(5), 60);
    auditAdd(past(160), "night.shift", "Login", "/Services/WebService", "", "", "10.40.9.31");
  },
  files({ file }) {
    file("^px/Home.px", px("Harbor Cold Storage", ["slot:/Drivers/BacnetNetwork/Freezer_1/points/BoxTemp"]), 500);
    file("^px/Freezers.px", px("Freezers", [1, 2, 3, 4].map((i) => `slot:/Drivers/BacnetNetwork/Freezer_${i}/points/BoxTemp`)), 90);
    file("^px/Rack_A.px", px("Compressor rack A", ["slot:/Drivers/BacnetNetwork/Rack_A/points/SuctionPressure", "slot:/Drivers/BacnetNetwork/Rack_A/points/DischargePressure"]), 90);
    file("^nav/NavFile.nav", nav(["Freezers", "Rack_A"]), 90);
    file("^notes/freezer-2.md", "# Freezer 2 temperature log\n\n| time | box °F | note |\n|---|---|---|\n| 1:40 pm | -8.9 | normal |\n| 1:55 pm | -2.1 | rising; door 2 cycled 9 times |\n| 2:05 pm | 4.2 | alarm; product probe -3 °F |\n", 1);
    file("^config/haccp-limits.csv", "room,limit_F,minutes\nFreezer,0,20\nCooler,41,30\nDock,50,60\n", 900);
  },
  agentMoves(c) {
    const { pendingCount, snapshot, point, pushProposal, propose, agentRecord, agentUser, who, auditAdd } = c;
    return [
      () => {
        if (pendingCount() >= 2) return;
        pushProposal(propose(point("Rack_A/CondenserFanSpeed"), "override", 85, `Discharge pressure is ${snapshot(point("Rack_A/DischargePressure")).displayValue}; holding the condenser fans at 85% for 30 minutes.`, Date.now(), 30));
      },
      () => {
        agentRecord(Date.now(), agentUser, "file:^notes/freezer-2.md", "write_file", { outcome: "completed", ...who, change: "write 0.8 KB", reason: "Added the latest Freezer 2 reading to the food safety log." });
        auditAdd(Date.now(), agentUser, "file_write", "file:^notes/freezer-2.md", "", "", "811 bytes");
      },
      () => agentRecord(Date.now(), agentUser, point("Cooler_1/BoxSetpoint"), "override", { outcome: "refused", code: "agent_value_out_of_bounds", ...who, change: "override 45.0 °F", reason: "Dock staff asked for a warmer cooler; outside the 33 to 40 °F limit set for agents." }),
      () => {
        if (pendingCount() >= 2) return;
        pushProposal(propose(point("Freezer_4/BoxSetpoint"), "override", -12, "Freezer 4 just finished a long defrost; a 2 °F lower setpoint for an hour pulls the box back down faster.", Date.now(), 60));
      }
    ];
  },
  alarmMoves(c) {
    const { raise, point, pushAlarm } = c;
    return [
      ...comesAndGoes(c, point("Dock/Door1Status"), "Dock door 1 open for 10 minutes", "Dock door 1 closed", { priority: 90, state: "alert" }),
      () => pushAlarm(raise(point("Freezer_1/BoxTemp"), "Freezer 1 box temperature rising: -4.8 °F", { cls: "critical", priority: 35 })),
      ...comesAndGoes(c, point("Dock/AmmoniaLevel"), "Ammonia level high: 27 ppm (limit 25)", "Ammonia level returned to normal", { cls: "lifeSafety", priority: 5 })
    ];
  }
};

// ---- Summit: a data hall --------------------------------------------------------------------------

const summit: Site = {
  key: "summit",
  station: "Summit",
  title: "Summit Data Hall: CRAC units, hot and cold aisles, chillers, UPS and power distribution",
  port: 47902,
  profile: "demo-summit",
  bounds: ["CRAC_*/SupplyAirSetpoint 60..72", "CRAC_*/FanSpeed 40..100"],
  watch: ["Hall_A/ColdAisleTemp", "Hall_A/HotAisleTemp", "CRAC_1/SupplyAirTemp", "CRAC_2/FanSpeed", "Chiller_1/Load", "Hall_A/Humidity", "CRAC_4/ReturnAirTemp", "Chiller_1/ChwSupplyTemp"],
  tree(c) {
    const { add, num, numW, bool, enumW, device, network, wave, schedules, weekdays } = c;
    let seed = 31;
    for (let i = 1; i <= 4; i += 1) {
      const dead = i === 3;
      const p = device(`CRAC_${i}`, 7000 + i, `10.60.0.${10 + i}`, { down: dead, tags: ["hs:crac", "hs:equip"] });
      num(p, "SupplyAirTemp", "°F", wave(64 + (i === 2 ? 1.2 : 0), 0.7, 18 + i * 3, seed++));
      num(p, "ReturnAirTemp", "°F", wave(86 + (i === 2 ? 3 : 0), 1.6, 24 + i * 2, seed++));
      numW(p, "SupplyAirSetpoint", "°F", 64);
      numW(p, "FanSpeed", "%", 70, { sim: wave(i === 2 ? 91 : 72, 4, 20, seed++), precision: 0 });
      num(p, "CoolingOutput", "%", wave(i === 2 ? 88 : 58, 9, 26, seed++), { precision: 0 });
      bool(p, "UnitStatus", ["Running", "Off"], !dead);
    }
    {
      const p = device("Hall_A", 7101, "10.60.0.40", { tags: ["hs:room", "hs:equip"] });
      num(p, "ColdAisleTemp", "°F", wave(69, 0.8, 16, seed++));
      num(p, "HotAisleTemp", "°F", wave(101.4, 1.1, 14, seed++), { alarm: true });
      num(p, "Humidity", "%RH", wave(43, 2.5, 40, seed++));
      num(p, "DewPoint", "°F", wave(46, 1, 44, seed++));
      num(p, "RaisedFloorPressure", "inH₂O", wave(0.045, 0.004, 12, seed++), { precision: 3 });
      bool(p, "LeakDetected", ["Leak", "Dry"], false);
    }
    for (let i = 1; i <= 2; i += 1) {
      const p = device(`Chiller_${i}`, 7200 + i, `10.60.0.${50 + i}`, { tags: ["hs:chiller", "hs:equip"] });
      num(p, "ChwSupplyTemp", "°F", wave(45, 0.5, 22, seed++));
      num(p, "ChwReturnTemp", "°F", wave(57, 1.2, 30, seed++));
      num(p, "Load", "%", wave(i === 1 ? 74 : 61, 6, 28, seed++), { precision: 0 });
      numW(p, "ChwSupplySetpoint", "°F", 45);
      bool(p, "ChillerStatus", ["Running", "Off"], true);
    }
    const snmp = network("SnmpNetwork", "snmp:SnmpNetwork");
    {
      const p = device("UPS_A", 1, "10.60.1.10", { typeSpec: "snmp:SnmpDevice", tags: ["hs:ups", "hs:equip"] }, snmp);
      num(p, "LoadPercent", "%", wave(61, 3, 26, seed++), { precision: 0 });
      num(p, "BatteryCharge", "%", () => 100, { precision: 0 });
      num(p, "RuntimeRemaining", "min", wave(22, 1.2, 26, seed++), { precision: 0 });
      num(p, "OutputPower", "kW", wave(183, 9, 26, seed++), { precision: 0 });
      bool(p, "OnBattery", ["On battery", "On utility"], false);
    }
    for (let i = 1; i <= 2; i += 1) {
      const p = device(`PDU_A${i}`, 10 + i, `10.60.1.${20 + i}`, { typeSpec: "snmp:SnmpDevice", tags: ["hs:pdu", "hs:equip"] }, snmp);
      num(p, "Power", "kW", wave(i === 2 ? 46 : 38, 3, 22, seed++));
      num(p, "Current", "A", wave(i === 2 ? 64 : 53, 4, 22, seed++), { precision: 0 });
      num(p, "LoadPercent", "%", wave(i === 2 ? 83 : 68, 3, 22, seed++), { precision: 0, alarm: i === 2 });
    }
    {
      const p = device("Generator", 30, "10.60.1.40", { typeSpec: "snmp:SnmpDevice", tags: ["hs:generator", "hs:equip"] }, snmp);
      enumW(p, "Mode", ["standby", "running", "test", "fault"], "standby");
      num(p, "FuelLevel", "%", () => 87, { precision: 0 });
      num(p, "BatteryVolts", "V", wave(26.4, 0.2, 60, seed++));
    }
    add(schedules, "GeneratorTest", "schedule:BooleanSchedule", "schedule", {
      defaultOutput: { value: false, text: "Standby" },
      week: { sunday: [], monday: [], tuesday: [{ start: "10:00", finish: "10:30", value: true, text: "Test run" }], wednesday: [], thursday: [], friday: [], saturday: [] }
    });
    add(schedules, "SupplyAirProfile", "schedule:NumericSchedule", "schedule", {
      defaultOutput: { value: 64, text: "64.0 °F" },
      week: weekdays([{ start: "00:00", finish: "06:00", value: 66, text: "66.0 °F" }, { start: "06:00", finish: "22:00", value: 64, text: "64.0 °F" }], [{ start: "00:00", finish: "24:00", value: 66, text: "66.0 °F" }])
    });
  },
  alarms({ raise, point, net }) {
    raise(point("Hall_A/HotAisleTemp"), "Hot aisle temperature high: 101.4 °F (limit 100.0 °F)", { cls: "critical", priority: 20, ago: 4 * MIN });
    raise(`${net}/CRAC_3`, "CRAC 3 down: no response to ping", { cls: "critical", priority: 15, state: "fault", ago: 17 * MIN });
    raise(point("PDU_A2/LoadPercent", "slot:/Drivers/SnmpNetwork"), "PDU A2 load above 80%", { priority: 70, state: "alert", ago: 90 * MIN, acked: true });
    raise(point("UPS_A/BatteryCharge", "slot:/Drivers/SnmpNetwork"), "UPS A battery test is 12 days overdue", { cls: "maintenance", priority: 190, state: "alert", ago: 7 * HOUR });
    raise(point("Hall_A/LeakDetected"), "Leak sensor under row 4 returned to dry", { cls: "critical", priority: 30, state: "normal", ago: 5 * HOUR });
  },
  history({ propose, decide, auditAdd, agentRecord, point, who, agentUser, past }) {
    let p = propose(point("CRAC_2/FanSpeed"), "override", 90, "CRAC 3 stopped answering; CRAC 2 covers the same rows, so running its fan at 90% holds the cold aisle.", past(16), 60);
    decide(p, "approved", "noc.operator", past(14));
    auditAdd(past(14), "noc.operator", "Invoked", "/Drivers/BacnetNetwork/CRAC_2/points/FanSpeed", "override", "", "90 %, 60 min");
    agentRecord(past(1350), agentUser, "slot:/Drivers/SnmpNetwork/PDU_A2", "write_tags", { outcome: "completed", ...who, change: "add hs:pdu, hs:elec, row=4", reason: "Tagging PDUs by row so load reports group them." });
    auditAdd(past(1350), agentUser, "Added", "/Drivers/SnmpNetwork/PDU_A2", "row", "", "4");
    agentRecord(past(1020), agentUser, point("CRAC_1/SupplyAirSetpoint"), "override", { outcome: "refused", code: "agent_value_out_of_bounds", ...who, change: "override 58.0 °F", reason: "Tried a colder supply to recover the hot aisle faster." });
    p = propose(point("Chiller_2/ChwSupplySetpoint"), "override", 47, "IT load is 61% overnight; a 2 °F warmer chilled water supply saves compressor energy and still holds 64 °F supply air.", past(700), 300);
    decide(p, "approved", "admin", past(694));
    auditAdd(past(694), "admin", "Invoked", "/Drivers/BacnetNetwork/Chiller_2/points/ChwSupplySetpoint", "override", "", "47.0 °F, 300 min");
    p = propose(point("Generator/Mode", "slot:/Drivers/SnmpNetwork"), "set", "test", "The weekly generator test was skipped on Tuesday; running it now while load is low.", past(410));
    decide(p, "rejected", "noc.operator", past(402), "Not without facilities on site.");
    agentRecord(past(150), agentUser, "file:^notes/crac-3.md", "write_file", { outcome: "completed", ...who, change: "write 0.6 KB", reason: "Wrote up the CRAC 3 outage timeline for the incident ticket." });
    auditAdd(past(150), agentUser, "file_write", "file:^notes/crac-3.md", "", "", "618 bytes");
    propose(point("CRAC_4/FanSpeed"), "override", 85, "Hot aisle is at 101.4 °F with CRAC 3 down; CRAC 4 has headroom, so 85% fan for 30 minutes pulls the aisle back under 100 °F.", past(2), 30);
    auditAdd(past(30), "noc.operator", "Login", "/Services/WebService", "", "", "10.60.9.4");
  },
  files({ file }) {
    file("^px/Home.px", px("Summit Data Hall", ["slot:/Drivers/BacnetNetwork/Hall_A/points/ColdAisleTemp", "slot:/Drivers/BacnetNetwork/Hall_A/points/HotAisleTemp"]), 400);
    file("^px/Cooling.px", px("Cooling", [1, 2, 3, 4].map((i) => `slot:/Drivers/BacnetNetwork/CRAC_${i}/points/SupplyAirTemp`)), 70);
    file("^px/Power.px", px("Power", ["slot:/Drivers/SnmpNetwork/UPS_A/points/LoadPercent"]), 70);
    file("^nav/NavFile.nav", nav(["Cooling", "Power"]), 70);
    file("^notes/crac-3.md", "# CRAC 3 outage\n\n- 1:47 pm: CRAC 3 stops answering on BACnet. Unit status last read Running.\n- 1:50 pm: CRAC 2 fan raised to 90% (approved by NOC).\n- 2:00 pm: hot aisle 101.4 °F, cold aisle steady at 69 °F.\n- Mechanical contractor dispatched, ETA 40 minutes.\n", 0.5);
    file("^config/thresholds.csv", "point,warn,alarm\nColdAisleTemp,75,80\nHotAisleTemp,97,100\nHumidity,55,60\nPDU_LoadPercent,75,80\n", 600);
  },
  agentMoves(c) {
    const { pendingCount, snapshot, point, pushProposal, propose, agentRecord, agentUser, who, auditAdd } = c;
    return [
      () => {
        if (pendingCount() >= 2) return;
        pushProposal(propose(point("CRAC_1/FanSpeed"), "override", 82, `Hot aisle reads ${snapshot(point("Hall_A/HotAisleTemp")).displayValue}; CRAC 1 at 82% for 30 minutes shares the load with CRAC 2.`, Date.now(), 30));
      },
      () => {
        agentRecord(Date.now(), agentUser, "file:^notes/crac-3.md", "write_file", { outcome: "completed", ...who, change: "write 0.7 KB", reason: "Added the latest aisle temperatures to the CRAC 3 incident notes." });
        auditAdd(Date.now(), agentUser, "file_write", "file:^notes/crac-3.md", "", "", "702 bytes");
      },
      () => agentRecord(Date.now(), agentUser, point("CRAC_2/FanSpeed"), "emergency_override", { outcome: "refused", code: "agent_priority_blocked", ...who, change: "emergency override 100 %", reason: "Emergency overrides are not allowed for agents on this station." }),
      () => {
        if (pendingCount() >= 2) return;
        pushProposal(propose(point("Chiller_1/ChwSupplySetpoint"), "override", 44, "Chiller 1 is at 74% load with one CRAC down; 1 °F colder water gives the remaining units more capacity.", Date.now(), 120));
      }
    ];
  },
  alarmMoves(c) {
    const { raise, point, pushAlarm } = c;
    return [
      ...comesAndGoes(c, point("Hall_A/ColdAisleTemp"), "Cold aisle temperature high: 76.2 °F (limit 75.0 °F)", "Cold aisle temperature back in range", { cls: "critical", priority: 30 }),
      () => pushAlarm(raise(point("Hall_A/Humidity"), "Hall humidity low: 31 %RH", { priority: 120, state: "alert" })),
      ...comesAndGoes(c, point("UPS_A/OnBattery", "slot:/Drivers/SnmpNetwork"), "UPS A on battery: utility sag", "UPS A back on utility power", { cls: "critical", priority: 10 })
    ];
  }
};

export const DEMO_SITES: Record<SiteName, Site> = { northgate, riverside, harbor, summit };
export const SITE_NAMES = Object.keys(DEMO_SITES) as SiteName[];
