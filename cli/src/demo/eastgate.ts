// Eastgate: a station that has just been started. Its BACnet network is empty, and the building's
// controllers are on the wire waiting to be discovered. The equipment and the point names are the
// ones the BACnet HVAC simulator serves (four air handlers, 32 VAV boxes, a chilled water and a
// heating water plant: 614 objects), here as one controller per piece of equipment.
import type { FieldDevice, FieldObject, Site, SiteContext } from "./sites.js";

const ON_OFF: [string, string] = ["On", "Off"];
const ENABLED: [string, string] = ["Enabled", "Disabled"];
const RUNNING: [string, string] = ["Running", "Off"];
const ALARM: [string, string] = ["Alarm", "Normal"];
const OCCUPIED: [string, string] = ["Occupied", "Unoccupied"];
const ENABLE: [string, string] = ["Enable", "Disable"];

/** What each air handler serves, and the rooms its eight VAV boxes are in. */
const WINGS = ["West / Administration", "North / Workspaces", "East / Workspaces", "South / Shared facilities"];
const two = (n: number) => String(n).padStart(2, "0");

function controllers(c: SiteContext): FieldDevice[] {
  let seed = 41;
  const moving = (value: number, amp: number) => c.wave(value, amp, 18 + (seed % 9) * 3, seed++);
  const ai = (name: string, value: number, units: string, description: string, amp: number, precision = 1): FieldObject =>
    ({ name, type: "analogInput", description, units, precision, value, sim: amp ? moving(value, amp) : undefined });
  const ao = (name: string, value: number, units: string, description: string, amp = 0, precision = 1): FieldObject =>
    ({ name, type: "analogOutput", description, units, precision, value, sim: amp ? moving(value, amp) : undefined });
  const bi = (name: string, value: boolean, description: string, texts: [string, string]): FieldObject => ({ name, type: "binaryInput", description, value, texts });
  const bo = (name: string, value: boolean, description: string, texts: [string, string]): FieldObject => ({ name, type: "binaryOutput", description, value, texts });

  const plant = (fluid: "CHW" | "HW", word: string, supply: number, back: number, flow: number, pressure: number, dp: number, load: number): FieldObject[] => [
    bi("Plant_Enable_Status", true, "Plant enable status", ENABLED),
    bi("Plant_Alarm_Status", false, "Plant alarm status", ALARM),
    ai(`${fluid}_Supply_Temp`, supply, "°F", `${word} supply temperature`, 0.5),
    ai(`${fluid}_Return_Temp`, back, "°F", `${word} return temperature`, 1.1),
    ai(`${fluid}_Header_Flow`, flow, "gpm", `${word} header flow`, flow * 0.1, 0),
    ai(`${fluid}_Header_Pressure`, pressure, "psi", `${word} header pressure`, 1.4),
    ao(`${fluid}_Supply_Temp_Setpoint`, supply, "°F", `${word} supply temperature setpoint`),
    ao(`${fluid}_Differential_Pressure_Setpoint`, dp, "psi", `${word} differential pressure setpoint`),
    bo(`${fluid}_Plant_Enable`, true, `${word} plant enable command`, ENABLE),
    ai(`${fluid}_Total_Load`, load, "kW", `Estimated ${word.toLowerCase()} plant load`, load * 0.12, 0)
  ];
  const chiller = (lead: boolean): FieldObject[] => [
    bi("Enable_Status", lead, "Chiller enable status", ENABLED),
    bi("Run_Status", lead, "Chiller run status", RUNNING),
    bi("Alarm_Status", false, "Chiller alarm status", ALARM),
    ai("Leaving_Water_Temp", lead ? 44 : 55.2, "°F", "Leaving chilled water temperature", lead ? 0.5 : 0.2),
    ai("Entering_Water_Temp", lead ? 54.8 : 55.4, "°F", "Entering chilled water temperature", lead ? 1.1 : 0.2),
    ai("Evaporator_Flow", lead ? 470 : 0, "gpm", "Evaporator water flow", lead ? 45 : 0, 0),
    ai("Condenser_Water_Temp", lead ? 82 : 76, "°F", "Condenser water temperature", lead ? 1.4 : 0.3),
    ai("Cooling_Load", lead ? 62 : 0, "%", "Chiller cooling load", lead ? 9 : 0, 0),
    ai("Power", lead ? 196 : 0, "kW", "Chiller electrical power", lead ? 26 : 0, 0),
    ao("Leaving_Water_Temp_Setpoint", 44, "°F", "Chiller leaving water setpoint"),
    bo("Enable_Command", lead, "Chiller enable command", ENABLE)
  ];
  const pump = (lead: boolean, flow: number, pressure: number): FieldObject[] => [
    bi("Enable_Status", lead, "Pump enable status", ENABLED),
    bi("Run_Status", lead, "Pump run status", RUNNING),
    bi("Alarm_Status", false, "Pump alarm status", ALARM),
    ai("Speed_Feedback", lead ? 68 : 0, "%", "Pump speed feedback", lead ? 7 : 0, 0),
    ai("Flow", lead ? flow : 0, "gpm", "Pump flow", lead ? flow * 0.1 : 0, 0),
    ai("Discharge_Pressure", lead ? pressure : 0, "psi", "Pump discharge pressure", lead ? 1.4 : 0),
    ao("Speed_Command", lead ? 68 : 0, "%", "Pump speed command", lead ? 7 : 0, 0),
    bo("Enable_Command", lead, "Pump enable command", ENABLE)
  ];
  const boiler = (lead: boolean): FieldObject[] => [
    bi("Enable_Status", lead, "Boiler enable status", ENABLED),
    bi("Run_Status", lead, "Boiler run status", ["Firing", "Off"]),
    bi("Alarm_Status", false, "Boiler alarm status", ALARM),
    ai("Leaving_Water_Temp", lead ? 120 : 96, "°F", "Leaving heating water temperature", lead ? 1.6 : 0.3),
    ai("Entering_Water_Temp", lead ? 95 : 95.4, "°F", "Entering heating water temperature", lead ? 2 : 0.3),
    ai("Heating_Load", lead ? 38 : 0, "%", "Boiler heating load", lead ? 9 : 0, 0),
    ai("Gas_Flow", lead ? 16 : 0, "cfm", "Boiler gas flow", lead ? 2.2 : 0),
    ai("Power", lead ? 12 : 0.4, "kW", "Boiler electrical power", lead ? 0.8 : 0),
    ao("Leaving_Water_Temp_Setpoint", 120, "°F", "Boiler leaving water setpoint"),
    bo("Enable_Command", lead, "Boiler enable command", ENABLE)
  ];
  const ahu = (i: number): FieldObject[] => [
    bi("Enable_Status", true, "AHU enable status", ENABLED),
    bi("Supply_Fan_Status", true, "Supply fan status", ON_OFF),
    bi("Return_Fan_Status", true, "Return fan status", ON_OFF),
    bi("Alarm_Status", false, "AHU alarm status", ALARM),
    { name: "Outdoor_Air_Temp", type: "analogInput", description: "Outdoor air temperature", units: "°F", precision: 1, value: 78, sim: c.outdoor },
    ai("Mixed_Air_Temp", 66 + i * 0.6, "°F", "Mixed air temperature", 2.4),
    ai("Return_Air_Temp", 73.6 + i * 0.2, "°F", "Return air temperature", 0.8),
    ai("Supply_Air_Temp", 55 + (i === 3 ? 1.1 : 0), "°F", "Supply air temperature", 1.2),
    ai("Supply_Air_Humidity", 50, "%RH", "Supply air relative humidity", 3.5),
    ai("Supply_Air_Static_Pressure", 1.5, "inH₂O", "Supply air static pressure", 0.13, 2),
    ai("Supply_Airflow", 17200 + i * 450, "cfm", "Supply airflow", 1500, 0),
    ao("Supply_Air_Temp_Setpoint", 55, "°F", "Supply air temperature setpoint"),
    ao("Supply_Static_Pressure_Setpoint", 1.5, "inH₂O", "Supply static pressure setpoint", 0, 2),
    ao("Cooling_Valve_Command", 34 + i * 5, "%", "Cooling coil valve command", 16, 0),
    ao("Heating_Valve_Command", 0, "%", "Heating coil valve command", 0, 0),
    ao("Outdoor_Air_Damper_Command", 22 + i * 3, "%", "Outdoor air damper command", 9, 0),
    ao("Supply_Fan_Speed_Command", 74 - i * 3, "%", "Supply fan speed command", 7, 0),
    bo("Enable_Command", true, "AHU enable command", ENABLE)
  ];
  const vav = (n: number): FieldObject[] => {
    const hot = n === 12;
    const empty = n % 11 === 0;
    const reheat = moving(3, 13);
    return [
      bi("Occupancy_Status", !empty, "Zone occupancy status", OCCUPIED),
      bi("Fan_Status", false, "VAV series fan status", ON_OFF),
      bi("Alarm_Status", hot, "VAV alarm status", ALARM),
      ai("Space_Temp", hot ? 77.9 : 72 + ((n % 3) - 1) * 0.4, "°F", "Zone space temperature", hot ? 0.4 : 1),
      ai("Space_Humidity", 48 - (n % 4), "%RH", "Zone relative humidity", 3),
      ai("Discharge_Air_Temp", hot ? 57.2 : 61, "°F", "VAV discharge air temperature", 1.6),
      ai("Airflow", hot ? 905 : 560 + (n % 5) * 45, "cfm", "VAV airflow", hot ? 30 : 110, 0),
      ai("Airflow_Setpoint", hot ? 920 : 580 + (n % 5) * 45, "cfm", "VAV airflow setpoint", hot ? 0 : 90, 0),
      ao("Occupied_Cooling_Setpoint", 74, "°F", "Occupied cooling setpoint"),
      ao("Occupied_Heating_Setpoint", 70, "°F", "Occupied heating setpoint"),
      ao("Damper_Command", hot ? 100 : 44 + (n % 4) * 6, "%", "VAV damper command", hot ? 0 : 18, 0),
      { name: "Reheat_Valve_Command", type: "analogOutput", description: "VAV reheat valve command", units: "%", precision: 0, value: 0, sim: hot ? undefined : (t) => Math.max(0, reheat(t)) },
      bo("Occupancy_Command", !empty, "VAV occupancy command", OCCUPIED),
      bo("Enable_Command", true, "VAV enable command", ENABLE)
    ];
  };

  const ip = (host: number) => `10.80.1.${host}`;
  return [
    { name: "CHW_Plant", instance: 410010, address: ip(10), model: "Plant controller", tags: ["hs:chilledWaterPlant", "hs:equip"], objects: plant("CHW", "Chilled water", 44, 54.6, 470, 52, 18, 310) },
    { name: "HW_Plant", instance: 410011, address: ip(11), model: "Plant controller", tags: ["hs:hotWaterPlant", "hs:equip"], objects: plant("HW", "Heating water", 120, 95, 215, 42, 15, 140) },
    ...[1, 2].map((i): FieldDevice => ({ name: `CH_${two(i)}`, instance: 410020 + i, address: ip(20 + i), model: "Chiller panel", tags: ["hs:chiller", "hs:equip"], objects: chiller(i === 1) })),
    ...[1, 2].map((i): FieldDevice => ({ name: `CHWP_${two(i)}`, instance: 410030 + i, address: ip(30 + i), model: "Pump drive", tags: ["hs:pump", "hs:equip"], objects: pump(i === 1, 470, 52) })),
    ...[1, 2].map((i): FieldDevice => ({ name: `B_${two(i)}`, instance: 410040 + i, address: ip(40 + i), model: "Boiler panel", tags: ["hs:boiler", "hs:equip"], objects: boiler(i === 1) })),
    ...[1, 2].map((i): FieldDevice => ({ name: `HWP_${two(i)}`, instance: 410050 + i, address: ip(50 + i), model: "Pump drive", tags: ["hs:pump", "hs:equip"], objects: pump(i === 1, 215, 42) })),
    ...[1, 2, 3, 4].map((i): FieldDevice => ({ name: `AHU_${two(i)}`, instance: 410100 + i, address: ip(100 + i), model: "Air handler controller", tags: ["hs:ahu", "hs:equip"], objects: ahu(i) })),
    ...Array.from({ length: 32 }, (_v, k): FieldDevice => {
      const n = k + 1;
      return { name: `VAV_${two(n)}`, instance: 410200 + n, address: `MSTP ${Math.ceil(n / 8)}:${10 + ((n - 1) % 8)}`, model: "VAV controller", tags: ["hs:vav", "hs:equip"], objects: vav(n) };
    })
  ];
}

/** The mechanical schedule a contractor hands over: which controller is which, and what it serves. */
const schedule = () =>
  [
    "tag,controller,type,serves,location",
    "CHW Plant,CHW_Plant,chilled water plant,AHU-01 to AHU-04,Mechanical room 140",
    "CH-01,CH_01,chiller (lead),CHW Plant,Mechanical room 140",
    "CH-02,CH_02,chiller (lag),CHW Plant,Mechanical room 140",
    "CHWP-01,CHWP_01,chilled water pump (lead),CHW Plant,Mechanical room 140",
    "CHWP-02,CHWP_02,chilled water pump (standby),CHW Plant,Mechanical room 140",
    "HW Plant,HW_Plant,heating water plant,AHU-01 to AHU-04 and VAV reheat,Mechanical room 140",
    "B-01,B_01,boiler (lead),HW Plant,Mechanical room 140",
    "B-02,B_02,boiler (lag),HW Plant,Mechanical room 140",
    "HWP-01,HWP_01,heating water pump (lead),HW Plant,Mechanical room 140",
    "HWP-02,HWP_02,heating water pump (standby),HW Plant,Mechanical room 140",
    ...WINGS.map((wing, i) => `AHU-${two(i + 1)},AHU_${two(i + 1)},air handler,${wing},Roof`),
    ...Array.from({ length: 32 }, (_v, k) => `VAV-${two(k + 1)},VAV_${two(k + 1)},VAV box with reheat,AHU-${two(Math.ceil((k + 1) / 8))},Room ${101 + k}`)
  ].join("\n") + "\n";

export const eastgate: Site = {
  key: "eastgate",
  station: "Eastgate",
  title: "Eastgate Office: four air handlers, 32 VAV boxes, a chilled water and a heating water plant",
  shows: "New station, nothing added: have the agent discover the BACnet network, add it and draw it",
  port: 47903,
  profile: "demo-eastgate",
  bounds: ["*/Occupied_Cooling_Setpoint 70..78", "*/Occupied_Heating_Setpoint 64..72", "*/Supply_Air_Temp_Setpoint 50..62"],
  watch: [],
  tree({ add, schedules, weekdays }) {
    add(schedules, "OfficeHours", "schedule:BooleanSchedule", "schedule", {
      defaultOutput: { value: false, text: "Unoccupied" },
      week: weekdays([{ start: "06:30", finish: "18:00", value: true, text: "Occupied" }])
    });
  },
  alarms() {},
  history({ auditAdd, past }) {
    auditAdd(past(96), "admin", "Login", "/Services/WebService", "", "", "10.80.9.12");
    auditAdd(past(94), "admin", "Added", "/Drivers", "BacnetNetwork", "", "bacnet:BacnetNetwork");
    auditAdd(past(93), "admin", "Changed", "/Drivers/BacnetNetwork/localDevice", "objectId", "device:-1", "device:410000");
    auditAdd(past(91), "admin", "Added", "/Schedules", "OfficeHours", "", "schedule:BooleanSchedule");
    auditAdd(past(90), "admin", "Invoked", "/", "save");
  },
  files({ file }) {
    file("^px/Home.px", '<?xml version="1.0" encoding="UTF-8"?>\n<px version="1.0" media="workbench:WbPxMedia">\n<content>\n<CanvasPane name="content" viewSize="1280.0,720.0">\n  <Label layout="40,30,400,40" text="Eastgate Office"/>\n</CanvasPane>\n</content>\n</px>\n', 1.5);
    file("^config/equipment-schedule.csv", schedule(), 1.6);
    file("^notes/startup.md", "# Eastgate startup\n\n- [x] Station licensed and started\n- [x] BACnet network added (IP port 47808, MS/TP trunks 1 to 4)\n- [ ] Discover and add the controllers (46 on the mechanical schedule: `^config/equipment-schedule.csv`)\n- [ ] Add their points\n- [ ] Graphics: plants, four air handlers with their zones\n- [ ] Check every zone against its setpoint\n", 1.5);
  },
  agentMoves: () => [],
  alarmMoves: () => [],
  field: controllers
};
