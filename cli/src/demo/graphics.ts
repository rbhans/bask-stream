// The graphics each demo building starts with: ordinary graphic documents, bound to that
// building's simulated points, saved in its station files like ones a person or an agent would add.
import type { GraphicDoc, PartDoc } from "../tui/symbols/graphic.js";
import type { SiteName } from "./sites.js";

const BACNET = "slot:/Drivers/BacnetNetwork";
const SNMP = "slot:/Drivers/SnmpNetwork";

const vav = (n: number): PartDoc => ({ id: `vav${n}`, symbol: "vav", label: `VAV ${n}`, value: `VAV_${n}/points/DamperPosition`, aux: `VAV_${n}/points/ReheatValve`, reading: `VAV_${n}/points/ZoneTemp` });
const coldRoom = (kind: "Freezer" | "Cooler", n: number): PartDoc => ({ symbol: "cold-room", label: `${kind} ${n}`, reading: `${kind}_${n}/points/BoxTemp`, open: `${kind}_${n}/points/DoorStatus`, ...(kind === "Freezer" ? { on: `Freezer_${n}/points/EvapFanStatus` } : {}) });
const crac = (n: number): PartDoc => ({ symbol: "crac", label: `CRAC ${n}`, value: `CRAC_${n}/points/FanSpeed`, on: `CRAC_${n}/points/UnitStatus`, reading: `CRAC_${n}/points/SupplyAirTemp` });

export const DEMO_GRAPHICS: Record<SiteName, Record<string, GraphicDoc>> = {
  northgate: {
    "ahu-01": {
      title: "AHU-1 and its zones",
      base: BACNET,
      rows: [
        {
          id: "ahu",
          air: [
            { symbol: "louver" },
            { symbol: "filter", label: "Filter", value: { point: "AHU_01/points/FilterDP", min: 0.3, max: 1.5 }, reading: "AHU_01/points/FilterDP" },
            { symbol: "sensor", label: "Mixed air", text: "T", reading: "AHU_01/points/MixedAirTemp" },
            { symbol: "cooling-coil", label: "Cooling", value: "AHU_01/points/CoolingValve" },
            { symbol: "fan", label: "Supply fan", value: "AHU_01/points/SupplyFanSpeed", on: "AHU_01/points/SupplyFanStatus" },
            { symbol: "sensor", label: "Supply air", text: "T", reading: "AHU_01/points/SupplyAirTemp" },
            { symbol: "sensor", label: "Static", text: "P", reading: "AHU_01/points/DuctStaticPressure" }
          ],
          from: { label: "OA", reading: "AHU_01/points/OutdoorAirTemp" },
          to: "SA"
        },
        { parts: [vav(101), vav(103), vav(105), vav(107)] }
      ],
      pipes: [101, 103, 105, 107].map((n) => ({ from: "ahu.out", to: `vav${n}.in`, kind: "duct" as const }))
    },
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

  harbor: {
    "cold-rooms": {
      title: "Cold rooms",
      base: BACNET,
      rows: [
        { parts: [1, 2, 3, 4].map((n) => coldRoom("Freezer", n)) },
        {
          parts: [
            coldRoom("Cooler", 1),
            coldRoom("Cooler", 2),
            { symbol: "plate", label: "Dock", reading: "Dock/points/DockTemp" },
            { symbol: "plate", label: "Ammonia", reading: "Dock/points/AmmoniaLevel" }
          ]
        }
      ]
    },
    "rack-a": {
      title: "Compressor rack A",
      base: `${BACNET}/Rack_A/points`,
      rows: [
        {
          parts: [
            { id: "suction", label: "Suction", reading: "SuctionPressure", medium: "refrigerant" },
            [1, 2, 3].map((n): PartDoc => ({ id: `c${n}`, symbol: "compressor", label: `Compressor ${n}`, on: `Compressor${n}Status` })),
            { id: "discharge", label: "Discharge", reading: "DischargePressure", medium: "refrigerant" },
            [
              { symbol: "plate", label: "Oil", reading: "OilPressure" },
              { symbol: "gauge", label: "Condenser fans", value: "CondenserFanSpeed" }
            ]
          ]
        }
      ],
      pipes: [
        ...[1, 2, 3].map((n) => ({ from: "suction", to: `c${n}.suction`, medium: "refrigerant" as const })),
        ...[1, 2, 3].map((n) => ({ from: `c${n}.discharge`, to: "discharge", medium: "refrigerant" as const }))
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
