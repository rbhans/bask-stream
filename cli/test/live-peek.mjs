// Manual check against the saved profile's station (not part of npm test).
import React from "react";
import { render } from "ink-testing-library";
import { connect } from "../dist/session.js";
import { App } from "../dist/tui/App.js";
const conn = await connect();
conn.stopPrompting();
const view = render(React.createElement(App, { client: conn.client, profileName: conn.profileName, allowWrites: false }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1500);
for (const key of (process.argv[2] ?? "").split(",").filter(Boolean)) {
  view.stdin.write({ down: "\u001B[B", up: "\u001B[A", right: "\u001B[C", enter: "\r" }[key] ?? key);
  await wait(key === "right" || key === "enter" || key.length > 1 ? 2500 : 150);
}
await wait(1000);
console.log(view.lastFrame().split("\n").filter((l) => !/^│ *││ *│$|^│ *│$/.test(l)).join("\n"));
view.unmount();
conn.client.close();
process.exit(0);
