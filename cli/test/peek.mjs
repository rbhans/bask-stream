// Prints a frame of the dashboard (not part of npm test), on the demo station or a saved profile's station:
//   node test/peek.mjs [--view explorer] [--size 120x36] [--keys "down,right,w"] [--pane] [--writes] [--live] [--color] [--profile <name>]
import { mount, settle, startStation } from "./harness.mjs";
import { connect } from "../dist/session.js";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const [columns, rows] = option("size", "120x36").split("x").map(Number);
if (args.includes("--fleet")) {
  const { mountFleet, startFleet } = await import("./harness.mjs");
  const fleet = await startFleet(undefined, { live: args.includes("--live") });
  const view = mountFleet(fleet.entries, { mouse: true }, { columns, rows });
  await settle(Number(option("wait", "1500")));
  for (const key of option("keys", "").split(",").filter(Boolean)) {
    if (/^wait\d+$/.test(key)) await settle(Number(key.slice(4)));
    else await view.press(key);
    await settle(150);
  }
  await settle(Number(option("after", "600")));
  console.log(args.includes("--color") ? view.raw() : view.frame());
  view.unmount();
  await fleet.close();
  process.exit(0);
}
const live = args.includes("--profile") ? await connect(option("profile")) : undefined;
const { client, close } = live ? { client: live.client, close: async () => live.client.close() } : await startStation({ live: args.includes("--live"), site: option("site", "northgate") });
const base = "slot:/Drivers/BacnetNetwork";
const points = args.includes("--watch") && !live && option("site", "northgate") === "northgate" ? ["AHU_01/points/SupplyAirTemp", "AHU_01/points/SupplyFanSpeed", "AHU_02/points/SupplyFanSpeed", "VAV_101/points/ZoneTemp", "VAV_105/points/ZoneTemp", "VAV_107/points/ZoneTemp", "CHW_Plant/points/Chiller2Status", "VAV_106/points/OccupancyMode"].map((p) => `${base}/${p}`) : [];
const view = mount(client, { view: option("view", "home"), pane: args.includes("--pane"), allowWrites: args.includes("--writes"), mouse: true, points }, { columns, rows });
await settle(Number(option("wait", "900")));
for (const key of option("keys", "").split(",").filter(Boolean)) {
  if (/^wait\d+$/.test(key)) await settle(Number(key.slice(4)));
  else if (/^click\d+:\d+$/.test(key)) await view.mouse("down", ...key.slice(5).split(":").map(Number));
  else await view.press(key);
  await settle(120);
}
await settle(Number(option("after", "500")));
console.log(args.includes("--color") ? view.raw() : view.frame());
view.unmount();
await close();
process.exit(0);
