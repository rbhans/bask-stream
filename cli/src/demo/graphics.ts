// The graphics the demo buildings start with: ordinary graphic documents, bound to that building's
// simulated points, saved in its station files like ones a person or an agent would add. Northgate
// has one for every piece of equipment; Riverside and Summit have two each; Harbor and Eastgate have
// none, so there is something left to draw.
import type { GraphicDoc, PartDoc } from "../tui/symbols/graphic.js";

const BACNET = "slot:/Drivers/BacnetNetwork";
const SNMP = "slot:/Drivers/SnmpNetwork";

const vav = (n: number): PartDoc => ({ id: `vav${n}`, symbol: "vav", label: `VAV ${n}`, value: `VAV_${n}/points/DamperPosition`, aux: `VAV_${n}/points/ReheatValve`, reading: `VAV_${n}/points/ZoneTemp` });
const crac = (n: number): PartDoc => ({ symbol: "crac", label: `CRAC ${n}`, value: `CRAC_${n}/points/FanSpeed`, on: `CRAC_${n}/points/UnitStatus`, reading: `CRAC_${n}/points/SupplyAirTemp` });

/** An air handler with the four VAV boxes it feeds. */
const airHandler = (n: number, zones: number[]): GraphicDoc => {
  const ahu = `AHU_0${n}/points`;
  return {
    title: `AHU-${n} and its zones`,
    base: BACNET,
    rows: [
      {
        id: "ahu",
        air: [
          { symbol: "louver" },
          { symbol: "filter", label: "Filter", value: { point: `${ahu}/FilterDP`, min: 0.3, max: 1.5 }, reading: `${ahu}/FilterDP` },
          { symbol: "sensor", label: "Mixed air", text: "T", reading: `${ahu}/MixedAirTemp` },
          { symbol: "cooling-coil", label: "Cooling", value: `${ahu}/CoolingValve` },
          { symbol: "fan", label: "Supply fan", value: `${ahu}/SupplyFanSpeed`, on: `${ahu}/SupplyFanStatus` },
          { symbol: "sensor", label: "Supply air", text: "T", reading: `${ahu}/SupplyAirTemp` },
          { symbol: "sensor", label: "Static", text: "P", reading: `${ahu}/DuctStaticPressure` }
        ],
        from: { label: "OA", reading: `${ahu}/OutdoorAirTemp` },
        to: "SA"
      },
      { parts: zones.map(vav) }
    ],
    pipes: zones.map((zone) => ({ from: "ahu.out", to: `vav${zone}.in`, kind: "duct" as const }))
  };
};

/** One VAV box: its damper, airflow and reheat, and the room it serves. */
const zoneBox = (n: number, ahu: number): GraphicDoc => ({
  title: `VAV ${n} · room ${n}`,
  base: `${BACNET}/VAV_${n}/points`,
  rows: [
    {
      air: [
        { symbol: "damper", label: "Damper", value: "DamperPosition" },
        { symbol: "sensor", label: "Airflow", text: "F", reading: "Airflow" },
        { symbol: "heating-coil", label: "Reheat", value: "ReheatValve" }
      ],
      from: { label: `AHU-${ahu}`, reading: `${BACNET}/AHU_0${ahu}/points/SupplyAirTemp` },
      to: { label: `Room ${n}`, reading: "ZoneTemp" }
    },
    {
      parts: [
        { symbol: "plate", label: "Zone temp", reading: "ZoneTemp" },
        { symbol: "plate", label: "Setpoint", reading: "ZoneSetpoint" },
        { symbol: "plate", label: "Occupancy", reading: "OccupancyMode" }
      ]
    }
  ]
});

export const DEMO_GRAPHICS: Record<"northgate" | "riverside" | "summit", Record<string, GraphicDoc>> = {
  northgate: {
    building: {
      title: "Northgate Office",
      base: BACNET,
      rows: [
        {
          parts: [
            [
              { symbol: "plate", label: "AHU-1 supply", reading: "AHU_01/points/SupplyAirTemp" },
              { symbol: "gauge", label: "AHU-1 fan", value: "AHU_01/points/SupplyFanSpeed" }
            ],
            [
              { symbol: "plate", label: "AHU-2 supply", reading: "AHU_02/points/SupplyAirTemp" },
              { symbol: "gauge", label: "AHU-2 fan", value: "AHU_02/points/SupplyFanSpeed" }
            ],
            [
              { symbol: "plate", label: "CHW supply", reading: "CHW_Plant/points/ChwSupplyTemp" },
              { symbol: "gauge", label: "CHW pump 1", value: "CHW_Plant/points/ChwPump1Speed" }
            ],
            [
              { symbol: "plate", label: "Outdoor air", reading: "AHU_01/points/OutdoorAirTemp" },
              { symbol: "gauge", label: "CHW flow", value: { point: "CHW_Plant/points/ChwFlow", min: 0, max: 600 }, reading: "CHW_Plant/points/ChwFlow" }
            ]
          ]
        },
        {
          parts: [1, 2, 3, 4].map((i): PartDoc[] => [
            { symbol: "plate", label: `Room 10${i}`, reading: `VAV_10${i}/points/ZoneTemp` },
            { symbol: "plate", label: `Room 10${i + 4}`, reading: `VAV_10${i + 4}/points/ZoneTemp` }
          ])
        }
      ]
    },
    "ahu-01": airHandler(1, [101, 102, 103, 104]),
    "ahu-02": airHandler(2, [105, 106, 107, 108]),
    ...Object.fromEntries([101, 102, 103, 104, 105, 106, 107, 108].map((n) => [`vav-${n}`, zoneBox(n, n <= 104 ? 1 : 2)])),
    "chw-plant": {
      title: "Chilled water plant",
      base: `${BACNET}/CHW_Plant/points`,
      rows: [
        {
          parts: [
            [
              { id: "ch1", symbol: "chiller", label: "Chiller 1", on: "Chiller1Status", value: 70 },
              { id: "ch2", symbol: "chiller", label: "Chiller 2", on: "Chiller2Status", value: 0 }
            ],
            [
              { symbol: "plate", label: "Flow", reading: "ChwFlow" },
              { id: "p1", symbol: "pump", label: "CHW pump 1", value: "ChwPump1Speed" }
            ],
            [
              { id: "supply", label: "CHW supply", reading: "ChwSupplyTemp", medium: "chw" },
              { id: "return", label: "CHW return", reading: "ChwReturnTemp", medium: "chw" }
            ]
          ]
        }
      ],
      pipes: [
        { from: "ch1.chwOut", to: "p1.in", medium: "chw" },
        { from: "ch2.chwOut", to: "p1.in", medium: "chw" },
        { from: "p1.out", to: "supply", medium: "chw" },
        { from: "return", to: "ch1.chwIn", medium: "chw" },
        { from: "return", to: "ch2.chwIn", medium: "chw" }
      ]
    }
  },

  riverside: {
    "ahu-or": {
      title: "Operating room air handler",
      base: BACNET,
      rows: [
        {
          air: [
            { symbol: "louver" },
            { symbol: "filter", label: "HEPA", value: { point: "AHU_OR/points/HepaFilterDP", min: 0.5, max: 1.8 }, reading: "AHU_OR/points/HepaFilterDP" },
            { symbol: "humidifier", label: "Humidifier", value: "AHU_OR/points/HumidifierValve" },
            { symbol: "fan", label: "Supply fan", value: "AHU_OR/points/SupplyFanSpeed", on: "AHU_OR/points/SupplyFanStatus" },
            { symbol: "sensor", label: "Supply air", text: "T", reading: "AHU_OR/points/SupplyAirTemp" },
            { symbol: "sensor", label: "Humidity", text: "H", reading: "AHU_OR/points/SupplyAirHumidity" }
          ],
          from: "OA",
          to: { label: "SA", note: "to the ORs" }
        },
        {
          parts: [1, 2, 3].map((n): PartDoc[] => [
            { symbol: "plate", label: `OR ${n} temp`, reading: `OR_${n}/points/RoomTemp` },
            { symbol: "plate", label: `OR ${n} humidity`, reading: `OR_${n}/points/RoomHumidity` }
          ])
        }
      ]
    },
    "hw-plant": {
      title: "Hot water plant",
      base: `${BACNET}/HW_Plant/points`,
      rows: [
        {
          parts: [
            { id: "b1", symbol: "boiler", label: "Boiler 1", on: "Boiler1Status", value: 60 },
            { id: "b2", symbol: "boiler", label: "Boiler 2", on: "Boiler2Status", value: 0 },
            { id: "p1", symbol: "pump", label: "HW pump 1", value: "HwPump1Speed" },
            [
              { id: "supply", label: "HW supply", reading: "HwSupplyTemp", medium: "hw" },
              { id: "return", label: "HW return", reading: "HwReturnTemp", medium: "hw" }
            ]
          ]
        }
      ],
      pipes: [
        { from: "b1.supply", to: "p1.in", medium: "hw" },
        { from: "b2.supply", to: "p1.in", medium: "hw" },
        { from: "p1.out", to: "supply", medium: "hw" },
        { from: "return", to: "b1.return", medium: "hw" },
        { from: "return", to: "b2.return", medium: "hw" }
      ]
    }
  },

  summit: {
    "hall-a": {
      title: "Hall A cooling",
      base: BACNET,
      rows: [
        { parts: [1, 2, 3, 4].map(crac) },
        {
          parts: [
            { symbol: "plate", label: "Cold aisle", reading: "Hall_A/points/ColdAisleTemp" },
            { symbol: "plate", label: "Hot aisle", reading: "Hall_A/points/HotAisleTemp" },
            { symbol: "plate", label: "Humidity", reading: "Hall_A/points/Humidity" },
            { symbol: "rack", label: "Racks" }
          ]
        }
      ]
    },
    power: {
      title: "Power",
      base: SNMP,
      rows: [
        {
          parts: [
            { id: "gen", symbol: "generator", label: "Generator", on: "Generator/points/Mode", reading: "Generator/points/FuelLevel" },
            { id: "ups", symbol: "ups", label: "UPS A", value: "UPS_A/points/BatteryCharge", reading: "UPS_A/points/RuntimeRemaining" },
            [
              { id: "pdu1", symbol: "gauge", label: "PDU A1", value: "PDU_A1/points/LoadPercent" },
              { id: "pdu2", symbol: "gauge", label: "PDU A2", value: "PDU_A2/points/LoadPercent" }
            ]
          ]
        }
      ],
      pipes: [
        { from: "gen.right", to: "ups.left", medium: "power", flow: "Generator/points/Mode" },
        { from: "ups.right", to: "pdu1.left", medium: "power" },
        { from: "ups.right", to: "pdu2.left", medium: "power" }
      ]
    }
  }
};
